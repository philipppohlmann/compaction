export interface ModelPricing {
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
  // Cache pricing (optional). When absent, cache rates are derived from inputPerMillionUsd.
  // Anthropic cache_read ≈ 10% of input; cache_creation ≈ 125% of input.
  cacheReadPerMillionUsd?: number;
  cacheCreationPerMillionUsd?: number;
}

export const DEFAULT_MODEL = "placeholder-agent-model";

/**
 * The explicit VERSION of this price table. A cost figure derived from `MODEL_PRICING` pins this
 * string so its price basis is honest and auditable, it says WHICH published-price snapshot the
 * figure was computed against. This is an ESTIMATE basis (published list prices), NOT a billed or
 * invoice-confirmed figure. Bump `PRICING_VERSION` and `PRICED_AS_OF` together whenever a number
 * changes (cite the official provider pricing source in a comment when correcting a value).
 */
export const PRICING_VERSION = "2026-06-01";
/** The as-of date the published list prices in `MODEL_PRICING` were captured (estimate basis). */
export const PRICED_AS_OF = "2026-06-01";

// Approximate list prices as of PRICED_AS_OF (2026-06). Prices change, treat as estimates only.
// Add a new entry when a trace carries a model name not listed here.
export const MODEL_PRICING: Record<string, ModelPricing> = {
  [DEFAULT_MODEL]: {
    inputPerMillionUsd: 1,
    outputPerMillionUsd: 3
    // No cache pricing for placeholder model, cache rates derived from inputPerMillionUsd if needed.
  },
  // Anthropic Claude, cache_read ≈ $0.30/M (10% of input), cache_creation ≈ 125% of input
  "claude-opus-4-8": { inputPerMillionUsd: 15, outputPerMillionUsd: 75, cacheReadPerMillionUsd: 1.5, cacheCreationPerMillionUsd: 18.75 },
  "claude-opus-4": { inputPerMillionUsd: 15, outputPerMillionUsd: 75, cacheReadPerMillionUsd: 1.5, cacheCreationPerMillionUsd: 18.75 },
  "claude-sonnet-4-6": { inputPerMillionUsd: 3, outputPerMillionUsd: 15, cacheReadPerMillionUsd: 0.30, cacheCreationPerMillionUsd: 3.75 },
  "claude-sonnet-4-5": { inputPerMillionUsd: 3, outputPerMillionUsd: 15, cacheReadPerMillionUsd: 0.30, cacheCreationPerMillionUsd: 3.75 },
  "claude-sonnet-3-7": { inputPerMillionUsd: 3, outputPerMillionUsd: 15, cacheReadPerMillionUsd: 0.30, cacheCreationPerMillionUsd: 3.75 },
  "claude-haiku-4-5": { inputPerMillionUsd: 0.25, outputPerMillionUsd: 1.25, cacheReadPerMillionUsd: 0.025, cacheCreationPerMillionUsd: 0.3125 },
  "claude-haiku-3-5": { inputPerMillionUsd: 0.8, outputPerMillionUsd: 4, cacheReadPerMillionUsd: 0.08, cacheCreationPerMillionUsd: 1.0 },
  // OpenAI, no cache pricing entries; cache rates derived from input rate when needed
  "gpt-4o": { inputPerMillionUsd: 2.5, outputPerMillionUsd: 10 },
  "gpt-4o-mini": { inputPerMillionUsd: 0.15, outputPerMillionUsd: 0.6 },
  "o1": { inputPerMillionUsd: 15, outputPerMillionUsd: 60 },
  "o3": { inputPerMillionUsd: 10, outputPerMillionUsd: 40 },
  "o3-mini": { inputPerMillionUsd: 1.1, outputPerMillionUsd: 4.4 },
  "o4-mini": { inputPerMillionUsd: 1.1, outputPerMillionUsd: 4.4 }
};

export function hasModelPricing(model: string): boolean {
  return Object.prototype.hasOwnProperty.call(MODEL_PRICING, model);
}

// Returns true only when the model is in the price table with real-world pricing,
// not the placeholder fallback. Use this to label estimates that may be inaccurate.
export function isKnownModel(model: string): boolean {
  return hasModelPricing(model) && model !== DEFAULT_MODEL;
}

export function getModelPricing(model: string): ModelPricing {
  return MODEL_PRICING[model] ?? MODEL_PRICING[DEFAULT_MODEL];
}

/**
 * Returns the effective cache read price per million tokens for a model.
 * Uses the explicit cacheReadPerMillionUsd when present; otherwise derives it
 * as 10% of inputPerMillionUsd (Anthropic convention).
 */
export function getCacheReadPricePerMillion(model: string): number {
  const pricing = getModelPricing(model);
  return pricing.cacheReadPerMillionUsd ?? pricing.inputPerMillionUsd * 0.1;
}

/**
 * Returns the effective cache creation price per million tokens for a model.
 * Uses the explicit cacheCreationPerMillionUsd when present; otherwise derives it
 * as 125% of inputPerMillionUsd (Anthropic convention).
 */
export function getCacheCreationPricePerMillion(model: string): number {
  const pricing = getModelPricing(model);
  return pricing.cacheCreationPerMillionUsd ?? pricing.inputPerMillionUsd * 1.25;
}
