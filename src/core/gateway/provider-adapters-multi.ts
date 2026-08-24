/**
 * Concrete non-OpenAI provider adapters for the Compaction Gateway (public CLI/SDK core; engine-free, ships
 * in the npm package).
 *
 * Three concrete `ProviderAdapter`s, Anthropic, Gemini, Mistral, that plug into the abstraction in
 * `provider-adapter.ts`. Each parses the provider's own usage object out of a (bounded) response body and
 * maps it into the provider-neutral `NormalizedUsage`. This is "usage/cache fields NORMALIZED + fixture
 * UNIT-TESTED", NOT live-verified readiness. Nothing here claims a provider is "ready" / "supported live".
 * No cost / billing / output-token / savings claim is made anywhere.
 *
 * CONTENT-FREE BY CONSTRUCTION (identical discipline to `openai-usage.ts`): every adapter reads ONLY numeric
 * token COUNTS + the provider-echoed model label (metadata, not message content). It never returns, stores,
 * or logs any prompt / completion / tool text. `NormalizedUsage` has no field that can carry content.
 *
 * HONESTY: a missing usage object → `source: "unavailable"` WITH a reason, NEVER a silent zero. A present
 * usage object that exposes NO cache field → `cacheUnavailableReason`, NEVER a fabricated
 * `cachedInputTokens: 0`. Mistral is the important honest-boundary case: it exposes NO documented
 * prompt-cache field, so `cachedInputTokens` / `freshInputTokens` are ALWAYS undefined and
 * `cacheUnavailableReason` is ALWAYS set, cache proof is structurally UNAVAILABLE for Mistral.
 */
import type { NormalizedUsage, ProviderAdapter } from "./provider-adapter.js";

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function obj_(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function bodyToString(responseBody: Buffer | string): string {
  return typeof responseBody === "string" ? responseBody : responseBody.toString("utf8");
}

/**
 * Parse a bounded response body into the list of JSON objects it carries: exactly one for a non-streaming
 * JSON body, or every parseable `data:` payload for an SSE stream (usage may be split across events, e.g.
 * Anthropic's `message_start` + `message_delta`). NEVER throws and NEVER reads message content, callers
 * only pull numeric usage fields + the model label out of the returned objects. The `[DONE]` sentinel and
 * any truncated/partial line are skipped, so the proxy stays byte-safe.
 */
function jsonObjectsFromBody(body: string): Record<string, unknown>[] {
  const trimmed = body.trim();
  if (trimmed === "") return [];
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      return parsed && typeof parsed === "object" ? [parsed as Record<string, unknown>] : [];
    } catch {
      return [];
    }
  }
  const out: Record<string, unknown>[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const s = line.trim();
    if (!s.startsWith("data:")) continue;
    const payload = s.slice("data:".length).trim();
    if (payload === "" || payload === "[DONE]") continue;
    try {
      const parsed = JSON.parse(payload);
      if (parsed && typeof parsed === "object") out.push(parsed as Record<string, unknown>);
    } catch {
      // a partial / truncated SSE line, skip it (defensive; never throw)
    }
  }
  return out;
}

function originMatcher(hosts: (host: string) => boolean): (upstreamOrigin: string) => boolean {
  return (upstreamOrigin: string): boolean => {
    try {
      return hosts(new URL(upstreamOrigin).hostname.toLowerCase());
    } catch {
      return false;
    }
  };
}

function originOnly(configuredUpstream: string): string {
  // The client's request PATH stays authoritative (exactly as the server does today); only the ORIGIN of
  // the configured upstream is used.
  return new URL(configuredUpstream).origin;
}

/**
 * Anthropic Messages API usage. Non-streaming responses carry `usage` on the top-level message; streaming
 * splits it across events, `message_start.message.usage` (input + cache fields) and the final
 * `message_delta.usage` (output_tokens). We scan every event and take each field where present, so a bounded
 * tail that only shows part of the usage still emits what it can (the rest stays unavailable-with-reason,
 * never zero). `cache_read_input_tokens` is the cache-HIT portion → `cachedInputTokens`.
 * `cache_creation_input_tokens` is a cache-WRITE (NOT a hit) and is deliberately NOT read here, it must
 * never be mislabeled as a cache hit, and carrying it is out of scope here.
 *
 * CACHE ACCOUNTING (matches the provider's own field truth): Anthropic reports `usage.input_tokens` as the
 * FRESH (non-cached) input count and `cache_read_input_tokens` as the cached portion SEPARATELY - they do
 * NOT overlap. So the TOTAL prompt input = input_tokens + cache_read_input_tokens, and the fresh input =
 * input_tokens. We normalize to the gateway's provider-neutral convention "inputTokens = TOTAL prompt input,
 * cachedInputTokens ⊆ inputTokens": `inputTokens` = input_tokens + cache_read (when a cache hit is present,
 * else just input_tokens), `freshInputTokens` = input_tokens (Anthropic's own fresh count), and
 * `cachedInputTokens` = cache_read_input_tokens. (OpenAI already reports prompt_tokens as the TOTAL, so its
 * fresh = prompt - cached; the normalized shape is identical for both.)
 */
function anthropicExtract(body: string): NormalizedUsage {
  const objs = jsonObjectsFromBody(body);
  if (objs.length === 0) {
    return {
      source: "unavailable",
      unavailableReason: "the Anthropic response body was empty or not parseable JSON/SSE (may be truncated)"
    };
  }
  // `freshInputRaw` holds Anthropic's own `input_tokens` (the FRESH, non-cached count); `cachedInputTokens`
  // holds `cache_read_input_tokens` (the cached portion, reported SEPARATELY). The normalized TOTAL is
  // derived from the two below.
  let freshInputRaw: number | undefined;
  let outputTokens: number | undefined;
  let cachedInputTokens: number | undefined;
  let model: string | undefined;
  let sawUsage = false;
  for (const o of objs) {
    const message = obj_(o.message);
    const m = typeof o.model === "string" ? o.model : typeof message?.model === "string" ? (message.model as string) : undefined;
    if (m) model = m;
    // Usage sits directly on a non-streaming message, or under `message.usage` on a `message_start` event.
    const usage = obj_(o.usage) ?? obj_(message?.usage);
    if (!usage) continue;
    sawUsage = true;
    const i = num(usage.input_tokens);
    if (i !== undefined) freshInputRaw = i;
    const out = num(usage.output_tokens);
    if (out !== undefined) outputTokens = out;
    const cacheRead = num(usage.cache_read_input_tokens);
    if (cacheRead !== undefined) cachedInputTokens = cacheRead;
  }
  if (!sawUsage || (freshInputRaw === undefined && outputTokens === undefined)) {
    return {
      source: "unavailable",
      ...(model ? { model } : {}),
      unavailableReason:
        "the Anthropic response carried no usage object with numeric input/output tokens (e.g. a streamed tail without message_start/message_delta usage)"
    };
  }
  // Normalize to "inputTokens = TOTAL prompt input, cachedInputTokens ⊆ inputTokens". Anthropic's
  // `input_tokens` is the FRESH count, `cache_read_input_tokens` is the cached portion reported separately,
  // so TOTAL = fresh + cached. `freshInputTokens` is Anthropic's own fresh count (`input_tokens`).
  const inputTokens =
    freshInputRaw !== undefined ? freshInputRaw + (cachedInputTokens ?? 0) : undefined;
  const freshInputTokens = freshInputRaw !== undefined && cachedInputTokens !== undefined ? freshInputRaw : undefined;
  const cacheUnavailableReason =
    cachedInputTokens === undefined
      ? "the Anthropic usage object reported no cache_read_input_tokens for this request (no prompt-cache hit, or prompt caching not enabled)"
      : undefined;
  return {
    source: "provider-reported",
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(freshInputTokens !== undefined ? { freshInputTokens } : {}),
    ...(model ? { model } : {}),
    ...(cacheUnavailableReason ? { cacheUnavailableReason } : {})
  };
}

/**
 * Gemini `generateContent` usage (`usageMetadata`), for both AI Studio (generativelanguage) and Vertex.
 * `promptTokenCount` → input, `candidatesTokenCount` → output, `cachedContentTokenCount` → the context-cache
 * HIT portion → `cachedInputTokens`. Streaming emits SSE `data:` chunks whose final chunk carries the full
 * `usageMetadata`, so we take the last-present value of each field. Missing `usageMetadata` → unavailable
 * with a reason; missing `cachedContentTokenCount` → cacheUnavailableReason (never a fabricated 0).
 */
function geminiExtract(body: string): NormalizedUsage {
  const objs = jsonObjectsFromBody(body);
  if (objs.length === 0) {
    return {
      source: "unavailable",
      unavailableReason: "the Gemini response body was empty or not parseable JSON/SSE (may be truncated)"
    };
  }
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let cachedInputTokens: number | undefined;
  let model: string | undefined;
  let sawMeta = false;
  for (const o of objs) {
    if (typeof o.modelVersion === "string") model = o.modelVersion;
    const meta = obj_(o.usageMetadata);
    if (!meta) continue;
    sawMeta = true;
    const i = num(meta.promptTokenCount);
    if (i !== undefined) inputTokens = i;
    const out = num(meta.candidatesTokenCount);
    if (out !== undefined) outputTokens = out;
    const cached = num(meta.cachedContentTokenCount);
    if (cached !== undefined) cachedInputTokens = cached;
  }
  if (!sawMeta || (inputTokens === undefined && outputTokens === undefined)) {
    return {
      source: "unavailable",
      ...(model ? { model } : {}),
      unavailableReason: "the Gemini response carried no usageMetadata with numeric prompt/candidates tokens"
    };
  }
  const freshInputTokens =
    inputTokens !== undefined && cachedInputTokens !== undefined ? Math.max(0, inputTokens - cachedInputTokens) : undefined;
  const cacheUnavailableReason =
    cachedInputTokens === undefined
      ? "the Gemini usageMetadata reported no cachedContentTokenCount for this request (no context-cache hit)"
      : undefined;
  return {
    source: "provider-reported",
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(freshInputTokens !== undefined ? { freshInputTokens } : {}),
    ...(model ? { model } : {}),
    ...(cacheUnavailableReason ? { cacheUnavailableReason } : {})
  };
}

/**
 * Mistral usage (`usage.prompt_tokens` / `usage.completion_tokens`). Mistral exposes NO documented
 * prompt-cache field, so this adapter NEVER emits `cachedInputTokens` or `freshInputTokens` and ALWAYS sets
 * `cacheUnavailableReason`, cache proof is structurally UNAVAILABLE for Mistral (an honest boundary, not a
 * bug). Missing usage → unavailable with a reason (never zeros).
 */
function mistralExtract(body: string): NormalizedUsage {
  const objs = jsonObjectsFromBody(body);
  if (objs.length === 0) {
    return {
      source: "unavailable",
      unavailableReason: "the Mistral response body was empty or not parseable JSON/SSE (may be truncated)"
    };
  }
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let model: string | undefined;
  let sawUsage = false;
  for (const o of objs) {
    if (typeof o.model === "string") model = o.model;
    const usage = obj_(o.usage);
    if (!usage) continue;
    sawUsage = true;
    const i = num(usage.prompt_tokens);
    if (i !== undefined) inputTokens = i;
    const out = num(usage.completion_tokens);
    if (out !== undefined) outputTokens = out;
  }
  if (!sawUsage || (inputTokens === undefined && outputTokens === undefined)) {
    return {
      source: "unavailable",
      ...(model ? { model } : {}),
      unavailableReason: "the Mistral response carried no usage object with numeric prompt/completion tokens"
    };
  }
  // Structurally honest: Mistral reports no cache field, so cachedInputTokens / freshInputTokens stay
  // undefined and the cache axis is ALWAYS unavailable-with-reason, cache proof is not supported here.
  return {
    source: "provider-reported",
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(model ? { model } : {}),
    cacheUnavailableReason:
      "Mistral does not report cached input tokens (its usage object has no prompt-cache field); cache proof is unavailable for this provider"
  };
}

/** Anthropic adapter, usage/cache fields normalized + fixture-tested (NOT live-verified readiness). */
export const anthropicAdapter: ProviderAdapter = {
  providerId: "anthropic",
  displayName: "Anthropic (Claude Messages API)",
  // Anthropic normalizes usage.cache_read_input_tokens (a provider cache-HIT field) when present.
  capabilities: { reportsCacheHitField: true },
  matchesUpstream: originMatcher((host) => host === "api.anthropic.com" || host.endsWith(".anthropic.com")),
  upstreamOrigin: originOnly,
  extractUsage(responseBody: Buffer | string): NormalizedUsage {
    return anthropicExtract(bodyToString(responseBody));
  }
};

/** Gemini adapter (AI Studio + Vertex), usage/cache fields normalized + fixture-tested (NOT readiness). */
export const geminiAdapter: ProviderAdapter = {
  providerId: "gemini",
  displayName: "Google Gemini (generateContent)",
  // Gemini normalizes usageMetadata.cachedContentTokenCount (a context-cache HIT field) when present.
  capabilities: { reportsCacheHitField: true },
  matchesUpstream: originMatcher(
    (host) => host === "generativelanguage.googleapis.com" || host.endsWith("-aiplatform.googleapis.com")
  ),
  upstreamOrigin: originOnly,
  extractUsage(responseBody: Buffer | string): NormalizedUsage {
    return geminiExtract(bodyToString(responseBody));
  }
};

/** Mistral adapter, input/output normalized + fixture-tested; cache proof structurally UNAVAILABLE. */
export const mistralAdapter: ProviderAdapter = {
  providerId: "mistral",
  displayName: "Mistral AI",
  // Mistral exposes NO prompt-cache field, so no cache-HIT field can be normalized, cache proof is
  // structurally unavailable for this provider (an honest boundary, not a bug).
  capabilities: { reportsCacheHitField: false },
  matchesUpstream: originMatcher((host) => host === "api.mistral.ai" || host.endsWith(".mistral.ai")),
  upstreamOrigin: originOnly,
  extractUsage(responseBody: Buffer | string): NormalizedUsage {
    return mistralExtract(bodyToString(responseBody));
  }
};
