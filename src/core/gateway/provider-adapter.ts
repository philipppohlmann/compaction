/**
 * Compaction Gateway provider-adapter abstraction (public CLI/SDK core; engine-free, ships in the npm
 * package).
 *
 * Gives the byte-for-byte record-mode gateway a single, content-free seam for turning a provider response
 * body into normalized token USAGE. The OpenAI adapter (the default path) DELEGATES to the existing
 * `openai-usage.ts` parser (no reimplementation) and maps the result into the provider-neutral
 * `NormalizedUsage`. The Anthropic / Gemini / Mistral adapters (in `provider-adapters-multi.ts`) are
 * registered here too, their usage/cache fields are NORMALIZED and fixture UNIT-TESTED, which is NOT
 * live-verified readiness. This module claims NO provider is "ready" / "supported live".
 *
 * CONTENT-FREE BY CONSTRUCTION: `extractUsage` returns ONLY numeric token counts + honesty labels + the
 * provider-echoed model label (metadata, not message content). It never returns, stores, or logs any
 * prompt / completion / tool text. The `NormalizedUsage` type makes this structurally clear, there is no
 * field on it that can carry request/response content.
 *
 * HONESTY (same discipline as `openai-usage.ts` / `receipt.ts`): a missing usage object is
 * `source: "unavailable"` WITH a reason, NEVER a silent zero. A present usage object that exposes no
 * cache field sets `cacheUnavailableReason`, NEVER a fabricated `cachedInputTokens: 0`.
 */
import { usageFromResponseBody, type OpenAiUsageBreakdown } from "./openai-usage.js";
import { anthropicAdapter, geminiAdapter, mistralAdapter } from "./provider-adapters-multi.js";

/** Per-axis provenance label, mirrors the cross-surface `token_source` discipline. */
export type UsageSource = "provider-reported" | "local-estimate" | "unavailable";

/**
 * Provider-neutral, CONTENT-FREE usage breakdown. Every field is a token COUNT, an honesty LABEL, or the
 * provider-echoed model label (metadata). There is deliberately NO field that can carry message/tool
 * content, the type is the structural guarantee of the no-content-storage boundary.
 */
export interface NormalizedUsage {
  /** Total prompt/input tokens the provider reports, when present. */
  inputTokens?: number;
  /** Output/completion tokens, when present. */
  outputTokens?: number;
  /** Input tokens served from the provider cache, ONLY when the provider exposes it. */
  cachedInputTokens?: number;
  /** inputTokens − cachedInputTokens, ONLY when BOTH are present (never a silent 0). */
  freshInputTokens?: number;
  /** Reasoning/output-detail tokens (a content-free COUNT), when the provider reports them. */
  reasoningTokens?: number;
  /** The model label the provider echoed (metadata, NOT content), when present. */
  model?: string;
  /** `provider-reported` when the provider returned usage; `unavailable` otherwise (`local-estimate` reserved for estimators). */
  source: UsageSource;
  /** REQUIRED when `source === "unavailable"`, the honest reason (never a silent zero). */
  unavailableReason?: string;
  /** Set when usage is present but the provider exposes NO cache field (never a fabricated 0). */
  cacheUnavailableReason?: string;
}

/**
 * A content-free, HONEST descriptor of what an adapter can normalize, the structural truth the
 * capability matrix is GENERATED from (never a hardcoded per-provider optimism table). Holds ONLY
 * booleans; carries no content, keys, or numbers. Extend minimally: add a field here only when it is a
 * genuine, per-adapter normalization fact the matrix must read from adapter truth.
 */
export interface AdapterCapabilities {
  /**
   * Whether this adapter can normalize a PROVIDER cache-HIT field from the response body (the input tokens
   * served from the provider cache). OpenAI/Anthropic/Gemini = true (they expose a cache-hit field);
   * Mistral = false (its usage object has NO prompt-cache field, so cache proof is structurally
   * unavailable). This is "the field is normalized when present", NOT a live-verified readiness claim.
   */
  reportsCacheHitField: boolean;
}

/**
 * A provider adapter: the content-free seam between one provider's HTTP surface and the gateway's
 * normalized usage. Adapters read ONLY token counts / metadata, never request/response content.
 */
export interface ProviderAdapter {
  /** Stable provider id. OpenAI/Anthropic/Gemini/Mistral adapters are registered (usage normalized + tested); the union names them for typing. */
  providerId: "openai" | "anthropic" | "gemini" | "mistral" | string;
  /** Human-readable adapter name (metadata / logs only). */
  displayName: string;
  /**
   * Content-free capability descriptor, the per-adapter normalization truth the capability matrix reads
   * (so `cacheNormalized` is derived from the adapter itself, never hardcoded in the matrix).
   */
  capabilities: AdapterCapabilities;
  /** Does this adapter handle the given upstream origin? Metadata only, content-free. */
  matchesUpstream(upstreamOrigin: string): boolean;
  /** Build the upstream target origin (the client's request PATH stays authoritative, exactly as today). */
  upstreamOrigin(configuredUpstream: string): string;
  /** Extract content-free normalized usage from a (bounded) response body buffer/string. */
  extractUsage(responseBody: Buffer | string): NormalizedUsage;
}

function bodyToString(responseBody: Buffer | string): string {
  return typeof responseBody === "string" ? responseBody : responseBody.toString("utf8");
}

/**
 * Map an `OpenAiUsageBreakdown` (from the existing parser) → provider-neutral `NormalizedUsage`.
 * Present usage → `provider-reported`; absent → `unavailable` WITH the parser's reason (never a zero).
 * Present-but-no-cache → `cacheUnavailableReason` (never a fabricated `cachedInputTokens: 0`).
 * Exported so tests can assert the mapping directly.
 */
export function normalizedUsageFromOpenAiBreakdown(b: OpenAiUsageBreakdown): NormalizedUsage {
  if (!b.present) {
    return {
      source: "unavailable",
      unavailableReason: b.unavailableReason ?? "the provider returned no usage object",
      ...(b.model ? { model: b.model } : {})
    };
  }
  const cachePresent = b.cachedInputTokens !== undefined;
  return {
    source: "provider-reported",
    ...(b.promptInputTokens !== undefined ? { inputTokens: b.promptInputTokens } : {}),
    ...(b.outputTokens !== undefined ? { outputTokens: b.outputTokens } : {}),
    ...(b.cachedInputTokens !== undefined ? { cachedInputTokens: b.cachedInputTokens } : {}),
    ...(b.billedFreshInputTokens !== undefined ? { freshInputTokens: b.billedFreshInputTokens } : {}),
    ...(b.reasoningTokens !== undefined ? { reasoningTokens: b.reasoningTokens } : {}),
    ...(b.model ? { model: b.model } : {}),
    ...(cachePresent
      ? {}
      : {
          cacheUnavailableReason:
            "the provider reported usage but no cached input tokens (prompt_tokens_details.cached_tokens) for this request"
        })
  };
}

/**
 * Compatibility bridge: `NormalizedUsage` → `OpenAiUsageBreakdown`. The gateway receipt builder
 * (`receipt.ts` / `apply-receipt.ts`) still consumes the OpenAI breakdown shape today, so the server maps
 * the adapter's normalized result back through this bridge to keep OpenAI receipts BYTE-IDENTICAL. (When
 * the receipt builder becomes provider-neutral in a later cycle this bridge goes away.) Content-free.
 */
export function openAiBreakdownFromNormalizedUsage(n: NormalizedUsage): OpenAiUsageBreakdown {
  return {
    present: n.source === "provider-reported",
    ...(n.inputTokens !== undefined ? { promptInputTokens: n.inputTokens } : {}),
    ...(n.cachedInputTokens !== undefined ? { cachedInputTokens: n.cachedInputTokens } : {}),
    ...(n.freshInputTokens !== undefined ? { billedFreshInputTokens: n.freshInputTokens } : {}),
    ...(n.outputTokens !== undefined ? { outputTokens: n.outputTokens } : {}),
    ...(n.reasoningTokens !== undefined ? { reasoningTokens: n.reasoningTokens } : {}),
    ...(n.model ? { model: n.model } : {}),
    ...(n.source === "unavailable" && n.unavailableReason ? { unavailableReason: n.unavailableReason } : {})
  };
}

/**
 * The OpenAI adapter, the first concrete adapter and today's DEFAULT. It handles OpenAI's own API and
 * generic OpenAI-compatible origins. It does NOT reimplement OpenAI parsing: `extractUsage` delegates to
 * `usageFromResponseBody` (which already handles Chat Completions + Responses API, non-streaming + SSE)
 * and maps the breakdown into `NormalizedUsage`.
 */
export const openAiAdapter: ProviderAdapter = {
  providerId: "openai",
  displayName: "OpenAI / OpenAI-compatible",
  // OpenAI normalizes prompt_tokens_details.cached_tokens (a provider cache-HIT field) when present.
  capabilities: { reportsCacheHitField: true },
  matchesUpstream(upstreamOrigin: string): boolean {
    try {
      const host = new URL(upstreamOrigin).hostname.toLowerCase();
      return host === "api.openai.com" || host.endsWith(".openai.com");
    } catch {
      return false;
    }
  },
  upstreamOrigin(configuredUpstream: string): string {
    // The client's request path stays authoritative (exactly as the server does today); only the origin
    // of the configured upstream is used.
    return new URL(configuredUpstream).origin;
  },
  extractUsage(responseBody: Buffer | string): NormalizedUsage {
    return normalizedUsageFromOpenAiBreakdown(usageFromResponseBody(bodyToString(responseBody)));
  }
};

/**
 * The registry of implemented adapters. OpenAI is the DEFAULT (and delegates to the battle-tested
 * `openai-usage.ts` parser); Anthropic / Gemini / Mistral normalize their own usage/cache fields and are
 * fixture UNIT-TESTED (NOT live-verified readiness). Order matters only for `matchesUpstream` first-match -
 * the provider host matchers are mutually exclusive, so order is not significant in practice.
 */
export const ADAPTERS: ProviderAdapter[] = [openAiAdapter, anthropicAdapter, geminiAdapter, mistralAdapter];

/** The DEFAULT adapter used when no adapter recognizes an origin, today's behavior (OpenAI). */
export const DEFAULT_ADAPTER: ProviderAdapter = openAiAdapter;

/**
 * Resolve an adapter by provider id. OpenAI/Anthropic/Gemini/Mistral are registered (usage normalized +
 * fixture-tested); an UNKNOWN id falls back to the OpenAI DEFAULT (documented). Registration means the usage
 * fields are normalized, it does NOT claim any provider is live-verified / "ready".
 */
export function getProviderAdapter(providerId: string): ProviderAdapter {
  return ADAPTERS.find((a) => a.providerId === providerId) ?? DEFAULT_ADAPTER;
}

/**
 * Resolve an adapter for a concrete upstream origin. Returns the first adapter that recognizes the origin,
 * else the OpenAI DEFAULT (documented), so an unknown / OpenAI-compatible origin keeps today's behavior.
 */
export function adapterForUpstream(upstreamOrigin: string): ProviderAdapter {
  return ADAPTERS.find((a) => a.matchesUpstream(upstreamOrigin)) ?? DEFAULT_ADAPTER;
}
