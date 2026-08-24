import { describe, it, expect, afterEach } from "vitest";
import { applyInputCostReductionUsd } from "../../src/core/gateway/api-cost-impact.js";
import { receiptLineFromGatewayReceipt } from "../../src/core/gateway/receipt-line.js";
import { buildApplyReceipt } from "../../src/core/gateway/apply-receipt.js";
import { MODEL_PRICING, type ModelPricing } from "../../src/core/pricing.js";
import type { OpenAiUsageBreakdown } from "../../src/core/gateway/openai-usage.js";
import type { ApplyActivation } from "../../src/core/gateway/apply-activation.js";
import type { DedupePlan } from "../../src/core/gateway/request-shape.js";

/**
 * PROOF that the per-turn line's `−$X (list price)` clause is COMPUTED from the price table, not hardcoded.
 * We mutate `MODEL_PRICING` for a test-only model, compute the clause, and assert the dollar figure tracks
 * the price we set. Doubling the input price MUST double the figure — impossible for a hardcoded constant.
 */

const activation: ApplyActivation = {
  mode: "apply",
  requested: true,
  activation: "explicit-mode",
  policy: "deterministic-dedupe"
};

/** A plan with a 20,000-token model-visible input reduction (100,000 → 80,000). */
const plan: DedupePlan = {
  policy: "deterministic-dedupe",
  shape: "chat-messages",
  supported: true,
  changed: true,
  removedBlocks: 1,
  charsBefore: 400000,
  charsAfter: 320000,
  estTokensBefore: 100000,
  estTokensAfter: 80000,
  reductionPercent: 20
};

function applyReceiptFor(model: string) {
  const usage: OpenAiUsageBreakdown = { present: true, promptInputTokens: 500, outputTokens: 30, model };
  return buildApplyReceipt({
    provider: "openai",
    endpoint: "/v1/chat/completions",
    upstreamStatus: 200,
    usage,
    activation,
    plan,
    applied: true,
    id: () => "abcd1234-0000-0000-0000-000000000000",
    now: () => "2026-07-31T00:00:00.000Z"
  });
}

const TEST_MODEL = "test-priced-model-xyz";

afterEach(() => {
  delete (MODEL_PRICING as Record<string, ModelPricing>)[TEST_MODEL];
});

describe("applyInputCostReductionUsd - COMPUTED from pricing, provably not hardcoded", () => {
  it("the $ figure tracks the price table: change the price → the number changes", () => {
    // delta = 100000 − 80000 = 20000 input tokens.
    (MODEL_PRICING as Record<string, ModelPricing>)[TEST_MODEL] = { inputPerMillionUsd: 10, outputPerMillionUsd: 30 };
    const at10 = applyInputCostReductionUsd(applyReceiptFor(TEST_MODEL));
    // 20000/1e6 * 10 = $0.20.
    expect(at10).toBeCloseTo(0.2, 10);

    // DOUBLE the input price → the figure MUST double. A hardcoded constant could not do this.
    (MODEL_PRICING as Record<string, ModelPricing>)[TEST_MODEL] = { inputPerMillionUsd: 20, outputPerMillionUsd: 30 };
    const at20 = applyInputCostReductionUsd(applyReceiptFor(TEST_MODEL));
    expect(at20).toBeCloseTo(0.4, 10);
    expect(at20).toBeCloseTo((at10 as number) * 2, 10);
  });

  it("the rendered line's `−$X (list price)` moves with the price table too (end-to-end, not hardcoded)", () => {
    (MODEL_PRICING as Record<string, ModelPricing>)[TEST_MODEL] = { inputPerMillionUsd: 10, outputPerMillionUsd: 30 };
    const line10 = receiptLineFromGatewayReceipt(applyReceiptFor(TEST_MODEL));
    expect(line10).toContain("−$0.20 (list price)");

    (MODEL_PRICING as Record<string, ModelPricing>)[TEST_MODEL] = { inputPerMillionUsd: 20, outputPerMillionUsd: 30 };
    const line20 = receiptLineFromGatewayReceipt(applyReceiptFor(TEST_MODEL));
    expect(line20).toContain("−$0.40 (list price)");
    // The two rendered figures differ solely because the price changed.
    expect(line10).not.toEqual(line20);
  });

  it("OMITS the clause (never −$0) when the model has no price-table entry", () => {
    // TEST_MODEL is not in MODEL_PRICING here (afterEach removed it).
    expect(applyInputCostReductionUsd(applyReceiptFor(TEST_MODEL))).toBeUndefined();
    const line = receiptLineFromGatewayReceipt(applyReceiptFor(TEST_MODEL));
    expect(line).not.toContain("$");
  });

  it("OMITS the clause when the request was NOT mutated (dry-run / no-op apply)", () => {
    const usage: OpenAiUsageBreakdown = { present: true, promptInputTokens: 500, outputTokens: 30, model: "gpt-4o" };
    const noop = buildApplyReceipt({
      provider: "openai",
      endpoint: "/v1/chat/completions",
      upstreamStatus: 200,
      usage,
      activation,
      applied: false,
      id: () => "abcd1234-0000-0000-0000-000000000000",
      now: () => "2026-07-31T00:00:00.000Z"
    });
    expect(applyInputCostReductionUsd(noop)).toBeUndefined();
  });

  it("OMITS the clause when the before→after delta is non-positive (never a fabricated $0)", () => {
    (MODEL_PRICING as Record<string, ModelPricing>)[TEST_MODEL] = { inputPerMillionUsd: 10, outputPerMillionUsd: 30 };
    const zeroDeltaPlan: DedupePlan = { ...plan, estTokensBefore: 80000, estTokensAfter: 80000, reductionPercent: 0, changed: true };
    const usage: OpenAiUsageBreakdown = { present: true, promptInputTokens: 500, outputTokens: 30, model: TEST_MODEL };
    const receipt = buildApplyReceipt({
      provider: "openai",
      endpoint: "/v1/chat/completions",
      upstreamStatus: 200,
      usage,
      activation,
      plan: zeroDeltaPlan,
      applied: true,
      id: () => "abcd1234-0000-0000-0000-000000000000",
      now: () => "2026-07-31T00:00:00.000Z"
    });
    expect(applyInputCostReductionUsd(receipt)).toBeUndefined();
  });
});
