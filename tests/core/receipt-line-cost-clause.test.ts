import { describe, it, expect, afterEach } from "vitest";
import { applyInputCostReductionUsd } from "../../src/core/gateway/api-cost-impact.js";
import { receiptLineFromGatewayReceipt, communityFullApplyReceiptLine } from "../../src/core/gateway/receipt-line.js";
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

/**
 * A mutated apply receipt for `model`.
 *
 * `route` is the UPSTREAM BILLING ROUTE and defaults to the user's own API key — the route the clause
 * under test describes, and the one every assertion in the first suite was written against. Pass
 * `undefined` explicitly (`{ route: undefined }` is indistinguishable from the default, so the
 * legacy-receipt case builds its receipt inline instead) or `"subscription"` for the route gate.
 */
function applyReceiptFor(model: string, route: "api-key" | "subscription" = "api-key") {
  const usage: OpenAiUsageBreakdown = { present: true, promptInputTokens: 500, outputTokens: 30, model };
  return buildApplyReceipt({
    provider: "openai",
    endpoint: "/v1/chat/completions",
    upstreamStatus: 200,
    usage,
    activation,
    plan,
    applied: true,
    upstreamRouteType: route,
    id: () => "abcd1234-0000-0000-0000-000000000000",
    now: () => "2026-07-31T00:00:00.000Z"
  });
}

/** The same receipt with NO route recorded at all — every apply receipt written before the field existed. */
function legacyRoutelessApplyReceipt(model: string) {
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

/**
 * THE ROUTE GATE. `−$X (list price)` prices the model-visible input delta at the provider's PUBLISHED
 * per-token rate. That is a defensible estimate of money only where tokens are what gets billed. A
 * Claude Code SUBSCRIPTION session is a flat fee: the user is charged no per-token amount whatsoever,
 * so a list-price figure on such a turn is not a smaller bill — it is a number with no basis, and it
 * appears on the one clause a user reads as money.
 *
 * The module's docblock has claimed "ROUTE B ONLY" since it was written; nothing enforced it. These
 * tests are the enforcement. The other two axes — the input reduction and the output count — are
 * route-independent facts about the request and must SURVIVE the gate; a test that only checked the
 * dollar figure disappeared would pass just as well if the whole line had.
 */
describe("applyInputCostReductionUsd - the list-price clause is gated on the BILLED route", () => {
  it("subscription route: no dollar clause — but the measured input reduction still renders", () => {
    (MODEL_PRICING as Record<string, ModelPricing>)[TEST_MODEL] = { inputPerMillionUsd: 10, outputPerMillionUsd: 30 };

    // Same model, same 20,000-token delta, same price. ONLY the route differs.
    const billed = applyReceiptFor(TEST_MODEL, "api-key");
    const flatFee = applyReceiptFor(TEST_MODEL, "subscription");

    expect(applyInputCostReductionUsd(billed)).toBeCloseTo(0.2, 10);
    expect(applyInputCostReductionUsd(flatFee)).toBeUndefined();

    const billedLine = receiptLineFromGatewayReceipt(billed);
    const flatFeeLine = receiptLineFromGatewayReceipt(flatFee);
    expect(billedLine).toContain("−$0.20 (list price)");
    expect(flatFeeLine).not.toContain("list price");
    expect(flatFeeLine).not.toContain("$");

    // THE REST OF THE LINE IS UNTOUCHED. The compaction happened on both routes and the evidence for it
    // is route-independent; only the price of it was unsayable.
    expect(flatFeeLine).toContain("input 100,000→80,000 (−20%)");
    expect(flatFeeLine).toContain("output 30");
    expect(billedLine).toBe(flatFeeLine!.replace(" · id ", " · −$0.20 (list price) · id "));
  });

  it("FAIL-CLOSED: a receipt that records no route at all gets no dollar clause either", () => {
    (MODEL_PRICING as Record<string, ModelPricing>)[TEST_MODEL] = { inputPerMillionUsd: 10, outputPerMillionUsd: 30 };
    const legacy = legacyRoutelessApplyReceipt(TEST_MODEL);
    expect(legacy.upstream_route_type).toBeUndefined();

    // Nothing in a replay can recover the route of a receipt written before the field existed. Assuming
    // the billed route would keep showing an unverifiable figure for exactly the records whose route is
    // unknown, which is the defect and not the mitigation.
    expect(applyInputCostReductionUsd(legacy)).toBeUndefined();
    const line = receiptLineFromGatewayReceipt(legacy);
    expect(line).not.toContain("list price");
    expect(line).toContain("input 100,000→80,000 (−20%)");
  });

  it("the COMMUNITY full-apply builder is gated identically (it is the same clause, not a second one)", () => {
    (MODEL_PRICING as Record<string, ModelPricing>)[TEST_MODEL] = { inputPerMillionUsd: 10, outputPerMillionUsd: 30 };
    expect(communityFullApplyReceiptLine(applyReceiptFor(TEST_MODEL, "api-key"))).toContain("−$0.20 (list price)");
    expect(communityFullApplyReceiptLine(applyReceiptFor(TEST_MODEL, "subscription"))).not.toContain("list price");
    expect(communityFullApplyReceiptLine(legacyRoutelessApplyReceipt(TEST_MODEL))).not.toContain("list price");
  });
});

/**
 * THE SUB-CENT FLOOR, ON BOTH BUILDERS. `formatUsd` rounds to two decimals, so a real-but-tiny
 * reduction renders `−$0.00 (list price)`: a value clause announcing no value — the fabricated zero the
 * omit-when-unpriced rule exists to prevent, arriving through a different door.
 *
 * The floor used to be applied at ONE call site rather than in the shared clause renderer, so the
 * Community full-apply builder — which sets the same field, from the same function, and is the builder
 * a Community user actually sees every turn — printed the zero the other builder refused to. These two
 * assertions are the same rule stated for both builders; either alone would have missed it.
 */
describe("the list-price clause is omitted below a rendered cent, on EVERY builder", () => {
  it("a sub-cent reduction renders no −$0.00 on either the Open/gateway or the Community line", () => {
    // 20,000 tokens at $0.10/M = $0.002 — real money, below what two decimals can show.
    (MODEL_PRICING as Record<string, ModelPricing>)[TEST_MODEL] = { inputPerMillionUsd: 0.1, outputPerMillionUsd: 0.4 };
    const receipt = applyReceiptFor(TEST_MODEL, "api-key");

    // The COMPUTATION is honest and unchanged — the reduction is real. Only the RENDER declines.
    expect(applyInputCostReductionUsd(receipt)).toBeCloseTo(0.002, 10);

    for (const line of [receiptLineFromGatewayReceipt(receipt), communityFullApplyReceiptLine(receipt)]) {
      expect(line).not.toContain("$0.00");
      expect(line).not.toContain("list price");
      // The turn's real evidence survives: only the sub-cent price was dropped.
      expect(line).toContain("input 100,000→80,000 (−20%)");
    }
  });

  it("half a cent DOES render (the floor is a boundary, not a blanket suppression)", () => {
    // 20,000 tokens at $0.25/M = $0.005 exactly → rounds up to a displayable −$0.01.
    (MODEL_PRICING as Record<string, ModelPricing>)[TEST_MODEL] = { inputPerMillionUsd: 0.25, outputPerMillionUsd: 1 };
    const receipt = applyReceiptFor(TEST_MODEL, "api-key");
    expect(applyInputCostReductionUsd(receipt)).toBeCloseTo(0.005, 10);
    expect(receiptLineFromGatewayReceipt(receipt)).toContain("−$0.01 (list price)");
    expect(communityFullApplyReceiptLine(receipt)).toContain("−$0.01 (list price)");
  });
});
