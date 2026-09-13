import type http from "node:http";

export const CODEX_SUBSCRIPTION_UPSTREAM = "https://chatgpt.com";

export type CodexSubscriptionRoute = "models" | "responses";

export interface CodexSubscriptionEnvelope {
  /** Fresh, per-invocation bearer-like route capability. Never persist or log this value. */
  capability: string;
}

const CAPABILITY_RE = /^[A-Za-z0-9_-]{32,128}$/;
const CLIENT_VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const AMBIGUOUS_ESCAPE_RE = /%(?:2f|5c|2e)/i;

/** Validate the raw request-target before any header or body is inspected. */
export function classifyCodexSubscriptionTarget(
  rawTarget: string | undefined,
  method: string | undefined,
  capability: string
): { route: CodexSubscriptionRoute; upstreamTarget: string } | null {
  if (!CAPABILITY_RE.test(capability)) return null;
  const target = rawTarget ?? "";
  if (!target.startsWith("/") || target.startsWith("//") || target.includes("\\") || AMBIGUOUS_ESCAPE_RE.test(target)) return null;
  const question = target.indexOf("?");
  const pathname = question === -1 ? target : target.slice(0, question);
  const search = question === -1 ? "" : target.slice(question);
  if (pathname.split("/").some((segment) => segment === "." || segment === "..")) return null;

  const prefix = `/__compaction/codex/${capability}/backend-api/codex`;
  if (method === "POST" && pathname === `${prefix}/responses` && search === "") {
    return { route: "responses", upstreamTarget: "/backend-api/codex/responses" };
  }
  if (method !== "GET" || pathname !== `${prefix}/models`) return null;
  const match = /^\?client_version=([^&=]+)$/.exec(search);
  if (!match || !CLIENT_VERSION_RE.test(match[1])) return null;
  return { route: "models", upstreamTarget: `/backend-api/codex/models?client_version=${match[1]}` };
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

function connectionNominations(rawHeaders: string[]): Set<string> {
  const nominated = new Set<string>();
  for (let i = 0; i < rawHeaders.length; i += 2) {
    if (rawHeaders[i].toLowerCase() !== "connection") continue;
    for (const token of rawHeaders[i + 1].split(",")) {
      const normalized = token.trim().toLowerCase();
      if (normalized) nominated.add(normalized);
    }
  }
  return nominated;
}

function isCodexForwardHeader(lower: string): boolean {
  return lower === "accept" ||
    lower === "authorization" ||
    lower === "chatgpt-account-id" ||
    lower === "content-type" ||
    lower === "originator" ||
    lower === "session-id" ||
    lower === "thread-id" ||
    lower === "user-agent" ||
    lower === "x-client-request-id" ||
    lower === "x-codex-beta-features" ||
    lower === "x-codex-turn-metadata" ||
    lower === "x-codex-window-id" ||
    lower === "x-openai-internal-codex-responses-lite";
}

/** Preserve reviewed raw spelling/order/duplicates while excluding cookies, proxy fields, and unknowns. */
export function forwardedCodexRawRequestHeaders(
  req: Pick<http.IncomingMessage, "rawHeaders">,
  host: string,
  contentLength?: number
): string[] {
  const result: string[] = [];
  const nominated = connectionNominations(req.rawHeaders);
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i];
    const value = req.rawHeaders[i + 1];
    const lower = name.toLowerCase();
    if (lower === "host" || lower === "content-length" || lower === "cookie" ||
        lower.startsWith("proxy-") || lower.startsWith("x-compaction-") ||
        HOP_BY_HOP.has(lower) || nominated.has(lower) || !isCodexForwardHeader(lower)) continue;
    result.push(name, value);
  }
  result.push("Host", host);
  if (contentLength !== undefined && contentLength > 0) result.push("Content-Length", String(contentLength));
  return result;
}

function isCodexResponseHeader(lower: string): boolean {
  return lower === "cache-control" ||
    lower === "content-encoding" ||
    lower === "content-length" ||
    lower === "content-type" ||
    lower === "date" ||
    lower === "etag" ||
    lower === "expires" ||
    lower === "last-modified" ||
    lower === "request-id" ||
    lower === "retry-after" ||
    lower === "vary" ||
    lower === "x-accel-buffering" ||
    lower === "x-request-id" ||
    lower === "x-should-retry" ||
    lower.startsWith("x-ratelimit-");
}

/** Subscription responses never relay redirects or credential-bearing/unknown response fields. */
export function safeCodexSubscriptionResponseHeaders(status: number, rawHeaders: string[]): string[] | null {
  if (status >= 300 && status < 400) return null;
  const result: string[] = [];
  const nominated = connectionNominations(rawHeaders);
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const lower = rawHeaders[i].toLowerCase();
    if (HOP_BY_HOP.has(lower) || nominated.has(lower) || !isCodexResponseHeader(lower)) continue;
    result.push(rawHeaders[i], rawHeaders[i + 1]);
  }
  return result;
}
