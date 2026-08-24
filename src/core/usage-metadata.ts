import { calculateCost } from "./cost-calculator.js";
import { hasModelPricing } from "./pricing.js";
import { estimateTraceTokens } from "./token-estimator.js";
import type { AgentTrace } from "./types.js";

export type CostSource = "provider_reported" | "price_table_estimate" | "local_estimate" | "missing" | "unknown";
export type CostConfidence = "high" | "medium" | "low" | "unknown";

export interface UsageMetadata {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  /** Cache read tokens (priced at ~10% of standard input rate, estimated, not billing-confirmed). */
  cache_read_input_tokens?: number;
  /** Cache creation tokens (priced at ~125% of standard input rate, estimated, not billing-confirmed). */
  cache_creation_input_tokens?: number;
  provider_reported_tokens: boolean;
  estimated_tokens: boolean;
  synthetic_demo?: boolean;
  cost_source: CostSource;
  cost_confidence: CostConfidence;
  currency?: string;
  model?: string;
  provider?: string;
  pricing_assumption?: string;
  limitations: string[];
}

interface UsageMetadataInput {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  /** Cache read tokens from the provider API response. Priced at reduced rate in cost estimates. */
  cacheReadInputTokens?: number;
  /** Cache creation tokens from the provider API response. Priced at elevated rate in cost estimates. */
  cacheCreationInputTokens?: number;
  providerReportedTokens: boolean;
  estimatedTokens: boolean;
  syntheticDemo?: boolean;
  providerReportedCost?: boolean;
  currency?: string;
  model?: string;
  provider?: string;
  pricingAssumption?: string;
  limitations?: string[];
}

function cleanNumber(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function costSourceFor(input: UsageMetadataInput): CostSource {
  if (input.providerReportedCost) return "provider_reported";
  if (input.providerReportedTokens && input.model && hasModelPricing(input.model)) return "price_table_estimate";
  if (input.estimatedTokens) return "local_estimate";
  if (!input.providerReportedTokens && !input.estimatedTokens) return "missing";
  return "unknown";
}

function costConfidenceFor(source: CostSource, providerReportedTokens: boolean): CostConfidence {
  if (source === "provider_reported") return "high";
  if (source === "price_table_estimate") return providerReportedTokens ? "medium" : "low";
  if (source === "local_estimate") return "low";
  return "unknown";
}

export function createUsageMetadata(input: UsageMetadataInput): UsageMetadata {
  const inputTokens = cleanNumber(input.inputTokens);
  const outputTokens = cleanNumber(input.outputTokens);
  const cacheReadInputTokens = cleanNumber(input.cacheReadInputTokens);
  const cacheCreationInputTokens = cleanNumber(input.cacheCreationInputTokens);
  const totalTokens = cleanNumber(input.totalTokens) ?? (inputTokens !== undefined || outputTokens !== undefined ? (inputTokens ?? 0) + (outputTokens ?? 0) : undefined);
  const costSource = costSourceFor(input);
  const pricingAssumption =
    input.pricingAssumption ??
    (costSource === "price_table_estimate" && input.model ? `price table estimate for ${input.model}` : costSource === "local_estimate" && input.model ? `local token estimate priced with fallback table for ${input.model}` : undefined);

  return {
    ...(inputTokens !== undefined ? { input_tokens: inputTokens } : {}),
    ...(outputTokens !== undefined ? { output_tokens: outputTokens } : {}),
    ...(totalTokens !== undefined ? { total_tokens: totalTokens } : {}),
    ...(cacheReadInputTokens !== undefined && cacheReadInputTokens > 0 ? { cache_read_input_tokens: cacheReadInputTokens } : {}),
    ...(cacheCreationInputTokens !== undefined && cacheCreationInputTokens > 0 ? { cache_creation_input_tokens: cacheCreationInputTokens } : {}),
    provider_reported_tokens: input.providerReportedTokens,
    estimated_tokens: input.estimatedTokens,
    ...(input.syntheticDemo ? { synthetic_demo: true } : {}),
    cost_source: costSource,
    cost_confidence: costConfidenceFor(costSource, input.providerReportedTokens),
    ...(input.currency ? { currency: input.currency } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.provider ? { provider: input.provider } : {}),
    ...(pricingAssumption ? { pricing_assumption: pricingAssumption } : {}),
    limitations: [...(input.limitations ?? [])]
  };
}

export function missingUsageMetadata(input: { model?: string; provider?: string; limitations?: string[] } = {}): UsageMetadata {
  return createUsageMetadata({
    providerReportedTokens: false,
    estimatedTokens: false,
    model: input.model,
    provider: input.provider,
    limitations: input.limitations ?? ["Token metadata is missing/unknown and was not invented.", "Cost metadata is missing/unknown."]
  });
}

export function localEstimateUsageMetadata(trace: AgentTrace, limitations: string[] = []): UsageMetadata {
  const estimate = estimateTraceTokens(trace);
  return createUsageMetadata({
    inputTokens: estimate.inputTokens,
    outputTokens: estimate.outputTokens,
    totalTokens: estimate.totalTokens,
    providerReportedTokens: false,
    estimatedTokens: true,
    model: trace.model,
    pricingAssumption: `local token estimate priced with fallback table for ${trace.model}`,
    limitations: ["Tokens are estimated locally from trace text; provider billing accuracy is not implied.", ...limitations]
  });
}

export function priceTableEstimateForUsage(metadata: UsageMetadata): number | null {
  if (metadata.input_tokens === undefined && metadata.output_tokens === undefined) return null;
  if (!metadata.model) return null;
  const cost = calculateCost(
    metadata.model,
    {
      inputTokens: metadata.input_tokens ?? 0,
      outputTokens: metadata.output_tokens ?? 0,
      totalTokens: metadata.total_tokens ?? (metadata.input_tokens ?? 0) + (metadata.output_tokens ?? 0)
    },
    {
      cacheReadTokens: metadata.cache_read_input_tokens,
      cacheCreationTokens: metadata.cache_creation_input_tokens
    }
  );
  return Number(cost.totalCostUsd.toFixed(6));
}

export function describeTokenMetadata(metadata: UsageMetadata): string[] {
  if (metadata.provider_reported_tokens) {
    const prefix = metadata.synthetic_demo ? "synthetic-demo provider-reported" : "provider-reported";
    const label = metadata.synthetic_demo ? " (not production billing data)" : "";
    return [
      `${prefix} input tokens: ${metadata.input_tokens ?? "unknown"}${label}`,
      `${prefix} output tokens: ${metadata.output_tokens ?? "unknown"}${label}`,
      `${prefix} total tokens: ${metadata.total_tokens ?? "unknown"}${label}`
    ];
  }

  if (metadata.estimated_tokens) {
    return [
      `estimated input tokens: ${metadata.input_tokens ?? "unknown"}`,
      `estimated output tokens: ${metadata.output_tokens ?? "unknown"}`,
      `estimated total tokens: ${metadata.total_tokens ?? "unknown"}`
    ];
  }

  return ["Token metadata: missing / unknown"];
}

export function describeCostMetadata(metadata: UsageMetadata): string[] {
  const missingCostLine = metadata.cost_source === "missing" || metadata.cost_source === "unknown" ? "Cost metadata: missing / unknown" : null;
  const syntheticLine = metadata.synthetic_demo ? "usage metadata label: synthetic-demo (not production billing data)" : null;
  return [
    ...(syntheticLine ? [syntheticLine] : []),
    ...(missingCostLine ? [missingCostLine] : []),
    `cost source: ${metadata.cost_source}`,
    `cost confidence: ${metadata.cost_confidence}`,
    ...(metadata.currency ? [`currency: ${metadata.currency}`] : []),
    ...(metadata.pricing_assumption ? [`pricing assumption: ${metadata.pricing_assumption}`] : [])
  ];
}
