import { getCacheCreationPricePerMillion, getCacheReadPricePerMillion, getModelPricing } from "./pricing.js";
import type { CostEstimate, TokenEstimate } from "./types.js";

const TOKENS_PER_MILLION = 1_000_000;

export interface CacheTokenCounts {
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

export function calculateCost(model: string, estimate: TokenEstimate, cache?: CacheTokenCounts): CostEstimate {
  const pricing = getModelPricing(model);
  const inputCostUsd = (estimate.inputTokens / TOKENS_PER_MILLION) * pricing.inputPerMillionUsd;
  const outputCostUsd = (estimate.outputTokens / TOKENS_PER_MILLION) * pricing.outputPerMillionUsd;

  const cacheReadTokens = cache?.cacheReadTokens ?? 0;
  const cacheCreationTokens = cache?.cacheCreationTokens ?? 0;
  const cacheReadCostUsd = (cacheReadTokens / TOKENS_PER_MILLION) * getCacheReadPricePerMillion(model);
  const cacheCreationCostUsd = (cacheCreationTokens / TOKENS_PER_MILLION) * getCacheCreationPricePerMillion(model);

  return {
    model,
    inputCostUsd,
    outputCostUsd,
    cacheReadCostUsd: cacheReadTokens > 0 ? cacheReadCostUsd : undefined,
    cacheCreationCostUsd: cacheCreationTokens > 0 ? cacheCreationCostUsd : undefined,
    totalCostUsd: inputCostUsd + outputCostUsd + cacheReadCostUsd + cacheCreationCostUsd
  };
}
