import type http from "node:http";

export const CLAUDE_SUBSCRIPTION_UPSTREAM = "https://api.anthropic.com";

export type ClaudeSubscriptionRoute = "head" | "messages" | "count-tokens";

export interface ClaudeSubscriptionEnvelope {
  /** Fresh, per-invocation bearer-like route capability. Never persist or log this value. */
  capability: string;
}

const CAPABILITY_RE = /^[A-Za-z0-9_-]{32,128}$/;
const AMBIGUOUS_ESCAPE_RE = /%(?:2f|5c|2e)/i;

/** Validate the raw request-target without decoding it or touching headers/body. */
export function classifyClaudeSubscriptionTarget(
  rawTarget: string | undefined,
  method: string | undefined,
  capability: string
): { route: ClaudeSubscriptionRoute; upstreamTarget: string } | null {
  if (!CAPABILITY_RE.test(capability)) return null;
  const target = rawTarget ?? "";
  if (!target.startsWith("/") || target.startsWith("//") || target.includes("\\") || AMBIGUOUS_ESCAPE_RE.test(target)) return null;
  const question = target.indexOf("?");
  const pathname = question === -1 ? target : target.slice(0, question);
  const search = question === -1 ? "" : target.slice(question);
  if (pathname.split("/").some((segment) => segment === "." || segment === "..")) return null;

  const prefix = `/__compaction/claude/${capability}`;
  if (method === "HEAD" && pathname === prefix && search === "") return { route: "head", upstreamTarget: "/" };
  if (method !== "POST") return null;
  if (pathname === `${prefix}/v1/messages` && (search === "" || search === "?beta=true")) {
    return { route: "messages", upstreamTarget: `/v1/messages${search}` };
  }
  if (pathname === `${prefix}/v1/messages/count_tokens` && search === "") {
    return { route: "count-tokens", upstreamTarget: "/v1/messages/count_tokens" };
  }
  return null;
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

function isClaudeForwardHeader(lower: string): boolean {
  return lower === "accept" ||
    lower === "accept-encoding" ||
    lower === "authorization" ||
    lower === "content-type" ||
    lower === "cookie" ||
    lower === "user-agent" ||
    lower === "x-api-key" ||
    lower === "x-app" ||
    lower === "x-claude-code-session-id" ||
    lower.startsWith("anthropic-") ||
    lower.startsWith("x-stainless-");
}

/** Preserve raw header spelling/order/duplicates while removing local and hop-by-hop fields. */
export function forwardedRawRequestHeaders(req: http.IncomingMessage, host: string, contentLength?: number): string[] {
  const result: string[] = [];
  const nominated = connectionNominations(req.rawHeaders);
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i];
    const value = req.rawHeaders[i + 1];
    const lower = name.toLowerCase();
    if (lower === "host" || lower === "content-length" || lower === "x-compaction-mode" || lower === "x-compaction-policy" || HOP_BY_HOP.has(lower) || nominated.has(lower) || !isClaudeForwardHeader(lower)) continue;
    result.push(name, value);
  }
  result.push("Host", host);
  if (contentLength !== undefined && contentLength > 0) result.push("Content-Length", String(contentLength));
  return result;
}

/** Preserve allowed raw response duplicates after stripping hop-by-hop, nominated, and unknown fields. */
export function forwardedRawResponseHeaders(rawHeaders: string[]): string[] {
  const result: string[] = [];
  const nominated = connectionNominations(rawHeaders);
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const lower = rawHeaders[i].toLowerCase();
    if (HOP_BY_HOP.has(lower) || nominated.has(lower) || !isClaudeResponseHeader(lower)) continue;
    result.push(rawHeaders[i], rawHeaders[i + 1]);
  }
  return result;
}

function isClaudeResponseHeader(lower: string): boolean {
  // `set-cookie` is the sole reviewed credential-bearing response family in this first cohort and
  // remains duplicate-preserving. No speculative token/refresh prefix is allowed without observation.
  return lower === "cache-control" ||
    lower === "content-encoding" ||
    lower === "content-length" ||
    lower === "content-type" ||
    lower === "date" ||
    lower === "etag" ||
    lower === "expires" ||
    lower === "last-modified" ||
    lower === "location" ||
    lower === "request-id" ||
    lower === "retry-after" ||
    lower === "set-cookie" ||
    lower === "vary" ||
    lower === "x-accel-buffering" ||
    lower === "x-request-id" ||
    lower === "x-should-retry" ||
    lower.startsWith("anthropic-ratelimit-") ||
    lower.startsWith("x-ratelimit-");
}

/** Relay only relative or exact pinned-origin redirects; malformed/cross-origin/downgrade is local failure. */
export function safeClaudeSubscriptionResponseHeaders(
  status: number,
  rawHeaders: string[],
  pinnedOrigin: string
): string[] | null {
  const forwarded = forwardedRawResponseHeaders(rawHeaders);
  if (status < 300 || status >= 400) return forwarded;
  const locations: string[] = [];
  for (let i = 0; i < forwarded.length; i += 2) {
    if (forwarded[i].toLowerCase() === "location") locations.push(forwarded[i + 1]);
  }
  if (locations.length === 0) return forwarded;
  if (locations.length !== 1 || locations[0].trim() === "") return null;
  try {
    const pinned = new URL(pinnedOrigin);
    const resolved = new URL(locations[0], pinned);
    if (resolved.username || resolved.password || resolved.origin !== pinned.origin) return null;
    return forwarded;
  } catch {
    return null;
  }
}
