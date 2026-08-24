import { describe, expect, it } from "vitest";
import { createUsageMetadata, describeCostMetadata, describeTokenMetadata, localEstimateUsageMetadata, missingUsageMetadata, priceTableEstimateForUsage } from "../../src/core/usage-metadata.js";
import type { AgentTrace } from "../../src/core/types.js";

function trace(): AgentTrace {
  return {
    id: "trace_usage_metadata",
    title: "Usage metadata fixture",
    artifactVersion: "agent-trace-v1",
    source: "demo",
    createdAt: "2026-01-01T00:00:00.000Z",
    generatedAt: "2026-01-01T00:00:00.000Z",
    model: "placeholder-agent-model",
    messages: [
      { id: "msg_001", role: "user", content: "hello world", timestamp: "2026-01-01T00:00:00.000Z" },
      { id: "msg_002", role: "assistant", content: "safe response", timestamp: "2026-01-01T00:00:01.000Z" }
    ]
  };
}

describe("usage metadata", () => {
  it("represents estimated token metadata from local trace text", () => {
    const metadata = localEstimateUsageMetadata(trace());

    expect(metadata.provider_reported_tokens).toBe(false);
    expect(metadata.estimated_tokens).toBe(true);
    expect(metadata.input_tokens).toBeGreaterThan(0);
    expect(metadata.output_tokens).toBeGreaterThan(0);
    expect(metadata.total_tokens).toBe((metadata.input_tokens ?? 0) + (metadata.output_tokens ?? 0));
    expect(metadata.cost_source).toBe("local_estimate");
    expect(metadata.cost_confidence).toBe("low");
    expect(describeTokenMetadata(metadata).join("\n")).toContain("estimated input tokens");
  });

  it("marks missing token and cost metadata without inventing token counts", () => {
    const metadata = missingUsageMetadata({ model: "unknown-model" });

    expect(metadata.provider_reported_tokens).toBe(false);
    expect(metadata.estimated_tokens).toBe(false);
    expect(metadata.input_tokens).toBeUndefined();
    expect(metadata.output_tokens).toBeUndefined();
    expect(metadata.total_tokens).toBeUndefined();
    expect(metadata.cost_source).toBe("missing");
    expect(metadata.cost_confidence).toBe("unknown");
    expect(describeTokenMetadata(metadata)).toEqual(["Token metadata: missing / unknown"]);
    expect(describeCostMetadata(metadata)).toContain("Cost metadata: missing / unknown");
  });

  it("stores cache_read_input_tokens and cache_creation_input_tokens as structured fields when non-zero", () => {
    const metadata = createUsageMetadata({
      inputTokens: 1000,
      outputTokens: 200,
      totalTokens: 101200,
      cacheReadInputTokens: 100000,
      cacheCreationInputTokens: 5000,
      providerReportedTokens: true,
      estimatedTokens: false,
      model: "claude-sonnet-4-6",
      provider: "anthropic"
    });

    expect(metadata.input_tokens).toBe(1000);
    expect(metadata.output_tokens).toBe(200);
    expect(metadata.cache_read_input_tokens).toBe(100000);
    expect(metadata.cache_creation_input_tokens).toBe(5000);
    expect(metadata.provider_reported_tokens).toBe(true);
    expect(metadata.cost_source).toBe("price_table_estimate");
  });

  it("omits cache fields from UsageMetadata when tokens are zero", () => {
    const metadata = createUsageMetadata({
      inputTokens: 500,
      outputTokens: 100,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      providerReportedTokens: true,
      estimatedTokens: false,
      model: "claude-sonnet-4-6"
    });

    // Zero cache counts should not add fields to the metadata object
    expect(metadata.cache_read_input_tokens).toBeUndefined();
    expect(metadata.cache_creation_input_tokens).toBeUndefined();
  });

  it("omits cache fields from UsageMetadata when not provided", () => {
    const metadata = createUsageMetadata({
      inputTokens: 500,
      outputTokens: 100,
      providerReportedTokens: true,
      estimatedTokens: false,
      model: "claude-sonnet-4-6"
    });

    expect(metadata.cache_read_input_tokens).toBeUndefined();
    expect(metadata.cache_creation_input_tokens).toBeUndefined();
  });

  it("priceTableEstimateForUsage produces lower cost with cache tokens than without", () => {
    const inputTokens = 1000;
    const outputTokens = 200;
    const cacheReadInputTokens = 100_000;
    const model = "claude-sonnet-4-6";

    // Without cache tokens, all input priced at standard rate
    const withoutCache = createUsageMetadata({
      // Treat all tokens (including the 100k that are actually cache_read) as standard input
      inputTokens: inputTokens + cacheReadInputTokens,
      outputTokens,
      providerReportedTokens: true,
      estimatedTokens: false,
      model
    });

    // With cache tokens, 100k priced at 10% of standard input rate
    const withCache = createUsageMetadata({
      inputTokens,
      outputTokens,
      cacheReadInputTokens,
      providerReportedTokens: true,
      estimatedTokens: false,
      model
    });

    const costWithout = priceTableEstimateForUsage(withoutCache);
    const costWith = priceTableEstimateForUsage(withCache);

    expect(costWithout).not.toBeNull();
    expect(costWith).not.toBeNull();

    // Cache read tokens at 10% rate should produce substantially lower total cost
    expect(costWith!).toBeLessThan(costWithout!);

    // The cache read saving should be ~90% of the input cost for those tokens
    // 100k tokens at $3/M = $0.30 standard vs $0.30/M = $0.03 cache_read
    // Saving = $0.27
    const saving = costWithout! - costWith!;
    expect(saving).toBeCloseTo(0.27, 3);
  });

  it("priceTableEstimateForUsage includes cache creation cost at ~125% of input rate", () => {
    const model = "claude-sonnet-4-6";

    // Standard input only: 10k tokens at $3/M = $0.03
    const standardOnly = createUsageMetadata({
      inputTokens: 10_000,
      outputTokens: 0,
      providerReportedTokens: true,
      estimatedTokens: false,
      model
    });

    // Cache creation: 10k tokens at $3.75/M = $0.0375
    const withCacheCreation = createUsageMetadata({
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 10_000,
      providerReportedTokens: true,
      estimatedTokens: false,
      model
    });

    const standardCost = priceTableEstimateForUsage(standardOnly);
    const cacheCost = priceTableEstimateForUsage(withCacheCreation);

    expect(standardCost).not.toBeNull();
    expect(cacheCost).not.toBeNull();

    // Cache creation is 25% more expensive than standard input
    expect(cacheCost!).toBeGreaterThan(standardCost!);
    expect(cacheCost!).toBeCloseTo(0.0375, 4);
  });

  it("priceTableEstimateForUsage returns null when no token counts are present", () => {
    const metadata = missingUsageMetadata({ model: "claude-sonnet-4-6" });
    expect(priceTableEstimateForUsage(metadata)).toBeNull();
  });
});
