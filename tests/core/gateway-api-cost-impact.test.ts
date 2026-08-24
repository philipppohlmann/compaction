import { describe, it, expect } from "vitest";
import { computeApiCostImpact } from "../../src/core/gateway/api-cost-impact.js";
import { buildGatewayReceipt, type GatewayReceipt } from "../../src/core/gateway/receipt.js";
import { PRICING_VERSION } from "../../src/core/pricing.js";
import type { OpenAiUsageBreakdown } from "../../src/core/gateway/openai-usage.js";

/**
 * Unit tests for the PROVIDER-PRICED API cost-impact model (Route B / api-billing).
 * Content-free fixtures, no keys, no prompt/response content. Verifies:
 *  - a priced model + provider-reported receipts → a correct provider-priced cost impact (estimate basis);
 *  - missing cache / unpriced model / non-provider-reported → UNAVAILABLE + reason (never a fabricated zero);
 *  - the ANTI-COLLAPSE boundaries: the result is api-billing ONLY, carries no plan-lifetime/plan-quota field, and
 *    `invoice_confirmed` is ALWAYS "unavailable" (provider-priced ≠ invoice-confirmed).
 */

const PROOF_RUN = "proof-run-fixture-1";

function usage(over: Partial<OpenAiUsageBreakdown> = {}): OpenAiUsageBreakdown {
  return {
    present: true,
    promptInputTokens: 1200,
    cachedInputTokens: 0,
    billedFreshInputTokens: 1200,
    outputTokens: 40,
    ...over
  } as OpenAiUsageBreakdown;
}

function receipt(variant: "baseline" | "compacted", u: OpenAiUsageBreakdown, model = "gpt-4o-mini"): GatewayReceipt {
  return buildGatewayReceipt({
    provider: "openai",
    endpoint: "/v1/chat/completions",
    mode: "record",
    upstreamStatus: 200,
    usage: { ...u, model },
    requestModel: model,
    proofRunId: PROOF_RUN,
    proofVariant: variant,
    now: () => "2026-07-09T00:00:00.000Z",
    id: () => `${variant}-id`
  });
}

describe("computeApiCostImpact - provider-priced API cost impact (Route B / api-billing)", () => {
  it("priced model + provider-reported receipts with cache → correct impact, labels, invoice always unavailable", () => {
    // Cold: 0 cached, 1200 fresh input. Warm: 900 cached, 300 fresh input → less fresh input billed → cheaper.
    const baseline = receipt("baseline", usage({ cachedInputTokens: 0, billedFreshInputTokens: 1200 }));
    const warm = receipt("compacted", usage({ cachedInputTokens: 900, billedFreshInputTokens: 300 }));

    const r = computeApiCostImpact({ baseline, warm, requestModel: "gpt-4o-mini" });

    expect(r.economic_route).toBe("api-billing");
    expect(r.auth_mode).toBe("api-key-gateway");
    expect(r.traffic_path).toBe("compaction-gateway");
    expect(r.token_source).toBe("provider-reported");
    expect(r.cache_source).toBe("provider-reported");
    expect(r.cost_basis).toBe("provider-usage-and-published-price");
    expect(r.proof_level).toBe("provider-priced-api");
    expect(r.billing_source).toBe("provider-priced-api");
    expect(r.pricing_version).toBe(PRICING_VERSION);
    expect(r.reason).toBeUndefined();

    // gpt-4o-mini: input $0.15/M, cache-read = 10% of input = $0.015/M, output $0.6/M.
    // baseline = 1200/1e6*0.15 + 0*... + 40/1e6*0.6 = 0.00018 + 0.000024 = 0.000204
    // warm     = 300/1e6*0.15 + 900/1e6*0.015 + 40/1e6*0.6 = 0.000045 + 0.0000135 + 0.000024 = 0.0000825
    expect(r.baseline_cost_usd).toBeCloseTo(0.000204, 9);
    expect(r.warm_cost_usd).toBeCloseTo(0.0000825, 9);
    expect(r.provider_priced_api_cost_impact_usd).toBeCloseTo(0.0001215, 9);
    expect(r.provider_priced_api_cost_impact_pct).toBeGreaterThan(0);
    expect(r.input_tokens).toBe(300);
    expect(r.cached_input_tokens).toBe(900);
    expect(r.output_tokens).toBe(40);

    // ANTI-COLLAPSE: invoice is ALWAYS unavailable; no plan-lifetime / plan-quota field exists on the result.
    expect(r.invoice_confirmed).toBe("unavailable");
    const keys = Object.keys(r);
    for (const forbidden of ["plan_lifetime", "planLifetime", "plan_quota", "planQuota", "plan-lifetime"]) {
      expect(keys).not.toContain(forbidden);
    }
    expect(JSON.stringify(r)).not.toContain("plan-lifetime");
    expect(JSON.stringify(r)).not.toContain("plan-quota");
  });

  it("provider-priced does NOT imply invoice-confirmed - invoice_confirmed is a frozen 'unavailable'", () => {
    const baseline = receipt("baseline", usage({ cachedInputTokens: 0, billedFreshInputTokens: 1200 }));
    const warm = receipt("compacted", usage({ cachedInputTokens: 900, billedFreshInputTokens: 300 }));
    const r = computeApiCostImpact({ baseline, warm, requestModel: "gpt-4o-mini" });
    // Even on a fully-computed provider-priced result, invoice is never confirmed.
    expect(r.proof_level).toBe("provider-priced-api");
    expect(r.invoice_confirmed).toBe("unavailable");
    expect(r.billing_source).not.toBe("invoice-confirmed");
    expect(r.cost_basis).not.toBe("invoice-reconciled");
  });

  it("missing cache axis (cache_source unavailable) → unavailable + reason, NOT a fabricated zero", () => {
    // A usage with cachedInputTokens undefined → receipt.cache_source = "unavailable".
    const noCache = usage({ cachedInputTokens: undefined as unknown as number });
    const baseline = receipt("baseline", noCache);
    const warm = receipt("compacted", noCache);
    const r = computeApiCostImpact({ baseline, warm, requestModel: "gpt-4o-mini" });
    expect(r.cost_basis).toBe("unavailable");
    expect(r.proof_level).toBe("unavailable");
    expect(r.provider_priced_api_cost_impact_usd).toBeUndefined(); // never a fabricated zero
    expect(r.reason).toMatch(/provider-reported token\/cache/i);
    expect(r.invoice_confirmed).toBe("unavailable");
    expect(r.economic_route).toBe("api-billing");
  });

  it("unpriced model → unavailable + reason (no published-price basis), never fabricated cost", () => {
    const baseline = receipt("baseline", usage({ cachedInputTokens: 0 }), "some-unlisted-model-xyz");
    const warm = receipt("compacted", usage({ cachedInputTokens: 900, billedFreshInputTokens: 300 }), "some-unlisted-model-xyz");
    const r = computeApiCostImpact({ baseline, warm, requestModel: "some-unlisted-model-xyz" });
    expect(r.cost_basis).toBe("unavailable");
    expect(r.proof_level).toBe("unavailable");
    expect(r.provider_priced_api_cost_impact_usd).toBeUndefined();
    expect(r.reason).toMatch(/not in the explicit price table/i);
    expect(r.reason).toContain(PRICING_VERSION);
    expect(r.invoice_confirmed).toBe("unavailable");
  });

  it("non-provider-reported receipt (no usage) → unavailable + reason", () => {
    const absent = { present: false, unavailableReason: "no usage reported by the provider" } as OpenAiUsageBreakdown;
    const baseline = receipt("baseline", absent);
    const warm = receipt("compacted", absent);
    const r = computeApiCostImpact({ baseline, warm, requestModel: "gpt-4o-mini" });
    expect(r.token_source).toBe("unavailable");
    expect(r.proof_level).toBe("unavailable");
    expect(r.provider_priced_api_cost_impact_usd).toBeUndefined();
    expect(r.reason).toBeTruthy();
    expect(r.invoice_confirmed).toBe("unavailable");
  });

  it("receipts not paired by a single proof-run id → unavailable + reason", () => {
    const baseline = receipt("baseline", usage({ cachedInputTokens: 0 }));
    const warmMismatch = buildGatewayReceipt({
      provider: "openai",
      endpoint: "/v1/chat/completions",
      mode: "record",
      upstreamStatus: 200,
      usage: { ...usage({ cachedInputTokens: 900, billedFreshInputTokens: 300 }), model: "gpt-4o-mini" },
      requestModel: "gpt-4o-mini",
      proofRunId: "a-different-run",
      proofVariant: "compacted",
      now: () => "2026-07-09T00:00:00.000Z",
      id: () => "warm-id"
    });
    const r = computeApiCostImpact({ baseline, warm: warmMismatch, requestModel: "gpt-4o-mini" });
    expect(r.proof_level).toBe("unavailable");
    expect(r.reason).toMatch(/not paired by a single proof-run id/i);
    expect(r.invoice_confirmed).toBe("unavailable");
  });

  it("the result serializes content-free (numbers + labels + version string only)", () => {
    const baseline = receipt("baseline", usage({ cachedInputTokens: 0 }));
    const warm = receipt("compacted", usage({ cachedInputTokens: 900, billedFreshInputTokens: 300 }));
    const r = computeApiCostImpact({ baseline, warm, requestModel: "gpt-4o-mini" });
    const s = JSON.stringify(r);
    // No credential / content markers.
    expect(s).not.toContain("Bearer");
    expect(s).not.toContain("sk-");
    expect(s.toLowerCase()).not.toContain("system");
    // Only the api-billing route is ever asserted.
    expect(s).toContain("api-billing");
  });
});
