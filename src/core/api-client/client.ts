/**
 * Compaction API client, transport (PUBLIC CLI/SDK code).
 *
 * Speaks ONLY the documented HTTP contract (`docs/api/compaction-api-v0.md`). NO engine import,
 * NO auto-upload, NO call at import time. A content-bearing send is gated TWICE: the request
 * body must carry `consent.upload_permitted === true` AND the caller must pass an explicit
 * `confirmed: true`, otherwise `sendRequest` throws BEFORE any network call. Timeout is
 * bounded; content-bearing requests are NEVER auto-retried (re-sending content must be a fresh,
 * explicitly-confirmed action).
 */
import { credentialedFetchInit } from "../net/credentialed-fetch.js";
import { buildHeaders, type ApiConfig } from "./config.js";
import { bodyContainsInlineContent, ConsentError, isContentBearing, validateContentFreeDocument } from "./payload.js";
import type { ApiErrorBody, ApiRequestBody, PayloadClass, StatusResponse } from "./types.js";

export class ApiNotConfirmedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApiNotConfirmedError";
  }
}

export class ApiTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApiTransportError";
  }
}

export interface ApiResponse<T> {
  ok: boolean;
  status: number;
  body: T | ApiErrorBody;
}

const TRANSIENT_RETRIES = 2;
const RETRY_BACKOFF_MS = 250;

function isTransientTransportError(err: unknown): boolean {
  // Node fetch wraps connection failures; a timeout is an AbortError (not transient-retryable
  // here because the caller asked for a bounded wait). We treat only connect/reset/DNS-style
  // failures as transient.
  const code = (err as { cause?: { code?: string } } | undefined)?.cause?.code;
  return (
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "ENOTFOUND" ||
    code === "EAI_AGAIN"
  );
}

/**
 * Every request from this client is credential-bearing whenever an API key is configured
 * (`buildHeaders` attaches it as a Bearer token), and the key belongs to the host the user
 * configured. The shared credentialed init refuses redirects for ALL of them rather than branching
 * on whether a key happened to be present — that branch would make the policy depend on runtime
 * configuration, and an un-keyed call has no reason to follow a redirect either.
 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, credentialedFetchInit({ ...init, signal: controller.signal }));
  } finally {
    clearTimeout(timer);
  }
}

async function parseBody<T>(res: Response): Promise<T | ApiErrorBody> {
  const text = await res.text();
  if (text.trim() === "") return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return { error: "invalid_response", details: "non-JSON response body" } as ApiErrorBody;
  }
}

/**
 * `GET /v0/status`. Content-free and idempotent → MAY retry on transient transport errors only.
 * Never retries on a non-2xx HTTP status (a coded error is not transient).
 */
export async function apiStatus(config: ApiConfig): Promise<ApiResponse<StatusResponse>> {
  const url = `${config.url}/v0/status`;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= TRANSIENT_RETRIES; attempt++) {
    try {
      const res = await fetchWithTimeout(url, { method: "GET", headers: buildHeaders(config) }, config.timeoutMs);
      const body = await parseBody<StatusResponse>(res);
      return { ok: res.ok, status: res.status, body };
    } catch (err) {
      lastErr = err;
      if (!isTransientTransportError(err) || attempt === TRANSIENT_RETRIES) break;
      await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS * (attempt + 1)));
    }
  }
  throw new ApiTransportError(
    `could not reach the Compaction API at ${config.url} (${String((lastErr as Error)?.message ?? lastErr)})`
  );
}

export interface SendOptions {
  /** Explicit caller confirmation. REQUIRED (in addition to body consent) for content-bearing sends. */
  confirmed?: boolean;
}

/**
 * Send a payload-bearing request to one of the engine-backed endpoints.
 *
 * NO AUTO-UPLOAD: when `payloadClass` is content-bearing, this throws `ApiNotConfirmedError`
 * BEFORE any network call unless BOTH (a) `body.consent.upload_permitted === true` and
 * (b) `options.confirmed === true`. A content-bearing request is NEVER auto-retried.
 *
 * Content-free requests are sent once (the boundary is preserved on the server too, which
 * fail-closes the same way). This function never persists or logs the body or the API key.
 */
export async function sendRequest<T>(
  config: ApiConfig,
  path: string,
  body: ApiRequestBody,
  options: SendOptions = {}
): Promise<ApiResponse<T>> {
  const payloadClass: PayloadClass | undefined = body.payload_class;
  const declaredContentBearing = isContentBearing(payloadClass);

  // DEFENSE-IN-DEPTH, FAIL-CLOSED: the gate is driven by what the body ACTUALLY contains, not by
  // its declared `payload_class`. Because the exported API accepts caller-built bodies, a body can
  // declare a content-free class (`metrics_only`/`redacted_structure`) while still carrying inline
  // raw content in `trace.content` / `original_trace.content` / `compacted_context.content`. We
  // inspect the real body BEFORE any fetch.
  const actuallyCarriesContent = bodyContainsInlineContent(body as unknown as Record<string, unknown>);

  // A content-free class that ACTUALLY carries inline content is itself an error - reject (the
  // safest option) rather than silently strip-and-send. The label lied about the body.
  if (!declaredContentBearing && actuallyCarriesContent) {
    throw new ConsentError(
      `consent_required: payload_class "${payloadClass ?? "metrics_only"}" is declared content-free ` +
        "but the body carries inline raw content (trace.content / original_trace.content / " +
        "compacted_context.content). A content-free class must carry zero inline content - refusing to send."
    );
  }

  // Any body that actually carries inline content (whatever its declared class) requires BOTH
  // explicit upload consent AND an explicit confirm before it may leave the machine.
  if (declaredContentBearing || actuallyCarriesContent) {
    const uploadPermitted = body.consent?.upload_permitted === true;
    if (!uploadPermitted) {
      throw new ApiNotConfirmedError(
        `refusing to send: body carries inline content but consent.upload_permitted is not true`
      );
    }
    if (options.confirmed !== true) {
      throw new ApiNotConfirmedError(
        `refusing to send: content-bearing payload requires an explicit confirm (preview then confirm) before upload`
      );
    }
  }

  const contentBearing = declaredContentBearing || actuallyCarriesContent;

  const url = `${config.url}${path}`;
  const init: RequestInit = {
    method: "POST",
    headers: buildHeaders(config),
    body: JSON.stringify(body)
  };

  // Content-bearing requests are NEVER auto-retried. Content-free requests may retry on
  // transient transport errors only.
  const maxAttempts = contentBearing ? 0 : TRANSIENT_RETRIES;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetchWithTimeout(url, init, config.timeoutMs);
      const parsed = await parseBody<T>(res);
      return { ok: res.ok, status: res.status, body: parsed };
    } catch (err) {
      lastErr = err;
      if (!isTransientTransportError(err) || attempt === maxAttempts) break;
      await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS * (attempt + 1)));
    }
  }
  throw new ApiTransportError(
    `could not reach the Compaction API at ${config.url} (${String((lastErr as Error)?.message ?? lastErr)})`
  );
}

/** Send one explicitly confirmed, validated content-free dashboard export. */
export async function sendIngestExport<T = Record<string, unknown>>(
  config: ApiConfig,
  body: Record<string, unknown>,
  options: { confirmed?: boolean } = {}
): Promise<ApiResponse<T>> {
  if (options.confirmed !== true) throw new ApiNotConfirmedError("refusing to send dashboard export without explicit --yes confirmation");
  const validation = validateContentFreeDocument(body);
  if (!validation.ok) throw new ConsentError(`refusing to send dashboard export: content-free validation failed at ${validation.path}`);
  if (!config.url.trim()) throw new ApiTransportError("refusing to send dashboard export: API endpoint is not configured");
  const response = await fetchWithTimeout(
    `${config.url}/v0/ingest/export`,
    { method: "POST", headers: buildHeaders(config), body: JSON.stringify(body) },
    config.timeoutMs
  );
  return { ok: response.ok, status: response.status, body: await parseBody<T>(response) };
}
