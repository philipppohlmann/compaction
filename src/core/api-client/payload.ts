/**
 * Compaction API client, payload builders + preview (PUBLIC CLI/SDK code).
 *
 * Pure functions: artifact + options → a typed request body. NO network, NO engine import.
 * Builders fail CLOSED: a content-bearing payload class requires explicit upload consent, and
 * inline raw (non-redacted) content requires consent too, mirroring the server's
 * `enforceConsent`. The preview shows EXACTLY what would be sent (API key redacted), so the
 * user never sends blind.
 */
import {
  CONTENT_BEARING_PAYLOAD_CLASSES,
  type EvaluateRequest,
  type OptimizeRequest,
  type PayloadClass,
  type ProviderMetadata,
  type ReportsRequest,
  type ToolName,
  type Trace
} from "./types.js";

/** True when a class carries raw-or-sanitized message CONTENT (requires explicit consent). */
export function isContentBearing(payloadClass: PayloadClass | undefined): boolean {
  return payloadClass !== undefined && CONTENT_BEARING_PAYLOAD_CLASSES.has(payloadClass);
}

/** Thrown by a builder when consent rules are violated. The client must fail closed. */
export class ConsentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConsentError";
  }
}

/** True when an inline-content field is present and NON-empty (i.e. actually carries content). */
function hasInlineContent(content: unknown): boolean {
  return (
    typeof content === "object" &&
    content !== null &&
    !Array.isArray(content) &&
    Object.keys(content as Record<string, unknown>).length > 0
  );
}

/**
 * Inspect a built/hand-built request body and report whether it ACTUALLY carries inline raw
 * (non-redacted) content in ANY content-bearing field, independent of the declared
 * `payload_class`. This is the source of truth the client uses to fail closed: the consent gate
 * must be driven by what the body CONTAINS, not by its label. Content is considered "raw" (and
 * therefore consent-requiring) unless it is explicitly marked redacted on its own trace.
 *
 * Content-bearing fields across the v0 contract:
 *  - `trace.content`            (optimize)
 *  - `original_trace.content`   (evaluate)
 *  - `compacted_context.content`(evaluate, trace-derived)
 */
export function bodyContainsInlineContent(body: Record<string, unknown>): boolean {
  const trace = body.trace as { content?: unknown; redacted?: boolean } | undefined;
  if (trace && hasInlineContent(trace.content) && trace.redacted !== true) return true;

  const originalTrace = body.original_trace as
    | { content?: unknown; redacted?: boolean }
    | undefined;
  if (originalTrace && hasInlineContent(originalTrace.content) && originalTrace.redacted !== true) {
    return true;
  }

  // Compacted context is trace-derived; it carries no independent `redacted` flag, so any inline
  // content here counts as raw trace-derived content for consent purposes.
  const compacted = body.compacted_context as { content?: unknown } | undefined;
  if (compacted && hasInlineContent(compacted.content)) return true;

  return false;
}

/**
 * Shared consent enforcement (client-side mirror of `apps/api` `enforceConsent`). Fail closed:
 *  - a content-bearing `payload_class` requires `consent.upload_permitted === true`;
 *  - inline raw (non-redacted) `trace.content` requires consent too.
 * Content-free classes / redacted inline content / reference-only payloads need no consent.
 */
function assertConsent(
  consent: { upload_permitted: boolean },
  payloadClass: PayloadClass | undefined,
  trace: Pick<Trace, "redacted" | "content"> | undefined
): void {
  const uploadPermitted = consent.upload_permitted === true;

  if (isContentBearing(payloadClass) && !uploadPermitted) {
    throw new ConsentError(
      `consent_required: payload_class "${payloadClass}" carries content and may not be ` +
        "sent unless upload is explicitly permitted. Use a metrics_only/redacted_structure " +
        "payload, or pass the upload-permitted flag."
    );
  }

  if (trace && trace.content !== undefined && trace.redacted !== true && !uploadPermitted) {
    throw new ConsentError(
      "consent_required: inline raw trace.content may not be sent unless upload is explicitly " +
        "permitted (or the trace is redacted). Send a redacted trace or a reference instead."
    );
  }
}

export interface OptimizeBuildOptions {
  trace: Trace;
  uploadPermitted?: boolean;
  payloadClass?: PayloadClass;
  tokenSource?: OptimizeRequest["token_usage"]["source"];
  inputTokens?: number;
  outputTokens?: number;
  provider?: string;
  runtime?: string;
  /** Content-free coding-tool identity (which tool produced the captured session). */
  tool?: ToolName;
  /** Content-free model identifier (e.g. "claude-sonnet-4-6"); never request content. */
  model?: string;
  labels?: { project?: string; session?: string };
  optimizationMode?: OptimizeRequest["optimization_mode"];
}

/** Build a `POST /v0/optimize` body. Fails closed on a content-bearing class without consent. */
export function buildOptimizeRequest(opts: OptimizeBuildOptions): OptimizeRequest {
  const payloadClass = opts.payloadClass ?? "metrics_only";
  const consent = {
    upload_permitted: opts.uploadPermitted === true,
    redacted: opts.trace.redacted === true
  };
  // For content-free classes, NEVER attach inline content even if the caller passed it.
  const trace: Trace = isContentBearing(payloadClass)
    ? opts.trace
    : { redacted: opts.trace.redacted, reference: opts.trace.reference };

  assertConsent(consent, payloadClass, trace);

  const req: OptimizeRequest = {
    trace,
    consent,
    payload_class: payloadClass,
    token_usage: {
      source: opts.tokenSource ?? "local-estimate",
      ...(opts.inputTokens !== undefined ? { input_tokens: opts.inputTokens } : {}),
      ...(opts.outputTokens !== undefined ? { output_tokens: opts.outputTokens } : {})
    },
    optimization_mode: opts.optimizationMode ?? "recommend"
  };
  const providerMetadata: ProviderMetadata = {
    ...(opts.provider ? { provider: opts.provider } : {}),
    ...(opts.runtime ? { runtime: opts.runtime } : {}),
    ...(opts.tool ? { tool: opts.tool } : {}),
    ...(opts.model ? { model: opts.model } : {})
  };
  if (Object.keys(providerMetadata).length > 0) req.provider_metadata = providerMetadata;
  if (opts.labels) req.labels = opts.labels;
  return req;
}

export interface EvaluateBuildOptions {
  originalTrace: Trace;
  compactedContext: { content?: Record<string, unknown>; reference?: string };
  uploadPermitted?: boolean;
  payloadClass?: PayloadClass;
  evidenceRequirements?: EvaluateRequest["evidence_requirements"];
}

/** Build a `POST /v0/evaluate` body. Fails closed on a content-bearing class without consent. */
export function buildEvaluateRequest(opts: EvaluateBuildOptions): EvaluateRequest {
  const payloadClass = opts.payloadClass ?? "metrics_only";
  const consent = {
    upload_permitted: opts.uploadPermitted === true,
    redacted: opts.originalTrace.redacted === true
  };
  const contentBearing = isContentBearing(payloadClass);
  // For content-free classes, NEVER attach inline content from ANY source, not the original
  // trace AND not the compacted context (which is trace-derived). A content-free class must
  // carry zero inline content regardless of which field the caller populated. Strip everything
  // except references, so the declared class is TRUE to the actual body.
  const originalTrace: Trace = contentBearing
    ? opts.originalTrace
    : { redacted: opts.originalTrace.redacted, reference: opts.originalTrace.reference };
  const compactedContext: EvaluateRequest["compacted_context"] = contentBearing
    ? opts.compactedContext
    : { reference: opts.compactedContext.reference };

  assertConsent(consent, payloadClass, originalTrace);

  const req: EvaluateRequest = {
    original_trace: originalTrace,
    compacted_context: compactedContext,
    consent,
    payload_class: payloadClass
  };
  if (opts.evidenceRequirements) req.evidence_requirements = opts.evidenceRequirements;
  return req;
}

export interface ReportsBuildOptions {
  reportBundle: ReportsRequest["report_bundle"];
  uploadPermitted?: boolean;
  payloadClass?: PayloadClass;
  labels?: { team?: string; project?: string };
}

/** Build a `POST /v0/reports` body. A report bundle is metrics/structure; consent still applies if a content-bearing class is declared. */
export function buildReportsRequest(opts: ReportsBuildOptions): ReportsRequest {
  const payloadClass = opts.payloadClass ?? "metrics_only";
  const consent = {
    upload_permitted: opts.uploadPermitted === true,
    redacted: opts.reportBundle.redacted === true
  };
  assertConsent(consent, payloadClass, undefined);

  const req: ReportsRequest = {
    report_bundle: opts.reportBundle,
    consent,
    payload_class: payloadClass
  };
  if (opts.labels) req.labels = opts.labels;
  return req;
}

export interface PayloadPreview {
  /** The HTTP method + path that would be hit. */
  endpoint: string;
  /** The resolved base URL the request would go to. */
  url: string;
  /** The declared payload class. */
  payloadClass: PayloadClass;
  /** Whether the body carries message content. */
  contentIncluded: boolean;
  /** A short human-readable description of what is / is NOT included. */
  summary: string;
  /** The EXACT JSON body that would be sent, with any API key redacted. */
  body: Record<string, unknown>;
  /** On-wire byte size of the serialized body. */
  byteSize: number;
}

/** Display only the endpoint origin and path; query strings/userinfo may contain secrets. */
export function sanitizePreviewUrl(value: string): string {
  try {
    const parsed = new URL(value);
    return `${parsed.origin}${parsed.pathname || "/"}`;
  } catch {
    return "[invalid-url]";
  }
}

/** Fail-closed backstop for the content-free dashboard ingest document. */
export function validateContentFreeDocument(value: unknown): { ok: true } | { ok: false; path: string } {
  const forbidden = new Set(["prompt", "response", "messages", "content", "choices", "apikey", "authorization"]);
  const visit = (node: unknown, path: string, depth: number): { ok: true } | { ok: false; path: string } => {
    if (depth > 64) return { ok: false, path: `${path} (too deep)` };
    if (typeof node === "string" && /(^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}/.test(node)) return { ok: false, path };
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i += 1) {
        const result = visit(node[i], `${path}[${i}]`, depth + 1);
        if (!result.ok) return result;
      }
    } else if (node !== null && typeof node === "object") {
      for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
        const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
        const childPath = `${path}.${key}`;
        if (forbidden.has(normalized) || (normalized === "input" && typeof child === "string")) return { ok: false, path: childPath };
        const result = visit(child, childPath, depth + 1);
        if (!result.ok) return result;
      }
    }
    return { ok: true };
  };
  return visit(value, "$", 0);
}

const CONTENT_SUMMARY: Record<PayloadClass, string> = {
  metrics_only: "metrics only - NO message content",
  redacted_structure: "structure/roles/ids - message content REMOVED",
  sanitized_snippets: "sanitized snippets - partial message CONTENT included",
  full_trace: "FULL message content included"
};

/**
 * Produce a payload preview: exactly what would be sent (the API key is NOT part of the body
 * and never appears here), plus a plain-language summary and byte size. This is the contract
 * the user sees before any send and is identical to the real body.
 */
export function previewPayload(
  method: string,
  path: string,
  url: string,
  body: { payload_class?: PayloadClass } & Record<string, unknown>
): PayloadPreview {
  const payloadClass = (body.payload_class ?? "metrics_only") as PayloadClass;
  const serialized = JSON.stringify(body);
  return {
    endpoint: `${method} ${path}`,
    url: sanitizePreviewUrl(url),
    payloadClass,
    // Report what the body ACTUALLY carries, not just its declared class - a
    // mislabeled content-free body that still contains inline content must preview
    // as content-included (and will be rejected by sendRequest before any fetch).
    contentIncluded: isContentBearing(payloadClass) || bodyContainsInlineContent(body),
    summary: CONTENT_SUMMARY[payloadClass],
    body,
    byteSize: Buffer.byteLength(serialized, "utf8")
  };
}
