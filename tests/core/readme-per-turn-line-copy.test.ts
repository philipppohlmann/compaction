import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { communityFullApplyReceiptLine, receiptLineFromGatewayReceipt } from "../../src/core/gateway/receipt-line.js";
import { buildApplyReceipt } from "../../src/core/gateway/apply-receipt.js";
import type { GatewayReceipt } from "../../src/core/gateway/receipt.js";
import type { OpenAiUsageBreakdown } from "../../src/core/gateway/openai-usage.js";
import type { ApplyActivation } from "../../src/core/gateway/apply-activation.js";
import type { DedupePlan } from "../../src/core/gateway/request-shape.js";
import { LCM_APPLY_POLICY } from "../../src/core/gateway/lcm-apply-policy-name.js";

/**
 * THE README'S PER-TURN EXAMPLES ARE PINNED TO THE RENDERER THAT PRODUCES THEM.
 *
 * The per-turn line is the product's single most-read claim surface, and its copy lives on four of
 * them at once (README, onboarding, `watch`, the status line). Every previous drift was the same
 * shape: a sentence was corrected on one surface while the runtime — or another surface — went on
 * saying the old thing, and nothing asked whether the printed example was still something the code
 * could emit. A README example is not documentation of the format; it is a CLAIM about what a user
 * will see. So it is asserted here character-for-character against the real builders, from receipts
 * carrying the token counts the README prints.
 *
 * The three examples encode two INDEPENDENT axes, and the independence is the point:
 *
 *   CAPABILITY decides which axes exist. Open never compacts input, so it renders `observed input N`
 *   (a plain count) and can never show an input reduction. Community's apply makes the input axis a
 *   real before→after and adds the `full apply` label and the allowance countdown.
 *
 *   ROUTE decides whether a reduction can be PRICED. `−$X (list price)` requires
 *   `upstream_route_type === "api-key"`, because a subscription is billed no per-token amount and
 *   pricing its reduction at a published rate would be a number with no basis.
 *
 * Conflating the two is the specific error these tests exist to catch: Open is not "the subscription
 * tier", Community is not "the API-key tier", and the dollar clause is not a Community feature. The
 * subscription/API-key pair below therefore differ in the ROUTE ALONE — same tier, same model, same
 * counts — so a regression that re-couples price to tier cannot pass.
 */

const README = readFileSync(join(process.cwd(), "README.md"), "utf8");

/** The real turn the README prints: 91,472 → 74,769 model-visible input tokens, 463 output. */
const INPUT_BEFORE = 91472;
const INPUT_AFTER = 74769;
const OUTPUT_TOKENS = 463;
/** The device-calibrated output saving for that turn; renders the `857→463 (−46%, est.)` arrow. */
const OUTPUT_TOKENS_SAVED = 394;
const RECEIPT_ID = "5f539978-76a7-48df-bb90-b67082a83dff";
/** A priced model, so the subscription line's MISSING dollar clause is provably route-driven. */
const MODEL = "claude-sonnet-4-6";

const activation: ApplyActivation = {
  mode: "apply",
  requested: true,
  activation: "stored-authorization",
  policy: LCM_APPLY_POLICY
};

const plan: DedupePlan = {
  policy: "deterministic-dedupe",
  shape: "chat-messages",
  supported: true,
  changed: true,
  removedBlocks: 1,
  charsBefore: INPUT_BEFORE * 4,
  charsAfter: INPUT_AFTER * 4,
  estTokensBefore: INPUT_BEFORE,
  estTokensAfter: INPUT_AFTER,
  reductionPercent: 18.3
};

/**
 * The denominator is the SHIPPED Community grant (2,000,000 tokens per UTC period —
 * `COMMUNITY_OPTIMIZED_INPUT_TOKENS_PER_PERIOD`), not whatever a dev lease happens to hold. A README
 * example prints a real number to a real reader, so a larger denominator borrowed from a local lease
 * would advertise an allowance no Community account is granted.
 *
 * The METER the grant is denominated in moved to `optimized-input-v2` (tokens removed, not tokens
 * inspected); the GRANT NUMBER did not, and re-denominating it is a product pricing decision, not a
 * units edit (`docs/product/commercial-boundary-v1.md` §1.2, amended 2026-09-02). This example stays
 * pinned to what the runtime actually grants today.
 */
const allowanceSnapshot: GatewayReceipt["allowance_snapshot"] = {
  remaining_tokens: 1928455,
  period_total_tokens: 2000000,
  period_id: "2026-08"
};

const estimatedSaved = { calibrated: true, tokensSaved: OUTPUT_TOKENS_SAVED, basis: "measured" as const };

function applyReceipt(route: "api-key" | "subscription"): GatewayReceipt {
  const usage: OpenAiUsageBreakdown = {
    present: true,
    promptInputTokens: INPUT_AFTER,
    outputTokens: OUTPUT_TOKENS,
    model: MODEL
  };
  return buildApplyReceipt({
    provider: "anthropic",
    endpoint: "/v1/messages",
    upstreamStatus: 200,
    usage,
    activation,
    plan,
    applied: true,
    appliedComponents: ["lcm-compaction"],
    composedInputEstimate: { before: INPUT_BEFORE, after: INPUT_AFTER },
    upstreamRouteType: route,
    allowanceSnapshot,
    authorizationId: "pref-1234567890abcdef12345678",
    id: () => RECEIPT_ID,
    now: () => "2026-08-31T00:00:00.000Z"
  });
}

/** The same turn as an OPEN turn: nothing was applied, so the input axis is a plain observed count. */
function openReceipt(): GatewayReceipt {
  const receipt = applyReceipt("subscription");
  const open: GatewayReceipt = {
    ...receipt,
    request_mutated: false,
    model_visible_bytes_changed: false,
    tokens: { ...receipt.tokens, prompt_input: INPUT_BEFORE, output: OUTPUT_TOKENS }
  };
  delete open.estimated_input_tokens_before;
  delete open.estimated_input_tokens_after;
  delete open.allowance_snapshot;
  return open;
}

/** Every fenced ``` block in the README that contains a rendered per-turn line. */
function readmePerTurnLines(): string[] {
  return (README.match(/^compaction · .*$/gm) ?? []).map((l) => l.trim());
}

describe("README per-turn examples are exactly what the renderer emits", () => {
  it("the OPEN example is the real Open rendering: observed input, output arrow, basic shaping", () => {
    const rendered = receiptLineFromGatewayReceipt(openReceipt(), "basic", undefined, estimatedSaved);
    expect(rendered).toBe(
      "compaction · observed input 91,472 · output 857→463 (−46%, est.) · basic shaping · id 5f539978"
    );
    expect(readmePerTurnLines()).toContain(rendered);
  });

  /**
   * THE FRESH-INSTALL EXAMPLE, which is a claim about what a user sees BEFORE they have any evidence —
   * the single most-read line in the product, and the one that was wrong. The three examples above all
   * come from a device that folded an A/B; this one is the same turn on a device that has not, and it
   * must show no reduction FIGURE at all.
   *
   * The README used to print `857→463 (−46%, est. · default prior)` here. The provenance suffix was
   * accurate and the number beside it was still a specific per-run figure nothing on that device had
   * counted, so the figure is withheld rather than relabelled.
   *
   * WHAT THIS PINS, EXACTLY: a caller that supplies a prior WITHOUT the device's calibration state. No
   * figure is drawn, which is the invariant the README paragraph is about. This is NOT the cold-start
   * path a real fresh install takes — that one carries `state: "unseeded"`. The README shows the real
   * path, so this case is pinned on the RENDERER ALONE and deliberately makes no README assertion.
   */
  it("a prior WITHOUT a calibration state draws no figure", () => {
    const rendered = receiptLineFromGatewayReceipt(openReceipt(), "basic", undefined, {
      calibrated: true,
      tokensSaved: OUTPUT_TOKENS_SAVED,
      basis: "default-prior"
    });
    expect(rendered).toBe("compaction · observed input 91,472 · output 463 · basic shaping · id 5f539978");
  });

  /**
   * THE REAL FRESH-INSTALL PATH, and the line the README now shows.
   *
   * `loadCalibrationReduction` on a device with no store returns `state: "unseeded"`, and
   * `estimatePerTurnOutputSaved` forwards it, so the line an actual fresh install prints for this turn
   * is the unknown-axis form. The README example was updated to match it, so the divergence this test
   * used to record is CLOSED and the pin is folded back onto the real path.
   *
   * The `not.toContain` assertions come FIRST on purpose: behind the exact-string pin they would never
   * execute on a regression that reintroduced a reconstructed before, which is the pin-masks-property
   * failure mode this repo has hit before.
   */
  it("the README example is the REAL cold-start line, and carries no reconstructed before", () => {
    const rendered = receiptLineFromGatewayReceipt(openReceipt(), "basic", undefined, {
      calibrated: false,
      state: "unseeded"
    });
    // No reconstructed before reaches the line on this path — the withdrawal still holds.
    expect(rendered).not.toContain("857");
    expect(rendered).not.toContain("−46%");
    expect(rendered).toBe(
      "compaction · observed input 91,472 · output N/A→463 (N/A%, est.) · basic shaping · id 5f539978"
    );
    expect(readmePerTurnLines()).toContain(rendered);
    // The superseded plain-count form must not linger anywhere in the README.
    expect(readmePerTurnLines()).not.toContain(
      "compaction · observed input 91,472 · output 463 · basic shaping · id 5f539978"
    );
  });

  /**
   * The PROPERTY behind the pin above, split out so the exact-string assertion cannot leave it dead:
   * the README must not carry a rendered per-turn line with a `default prior` label anywhere, on any
   * surface, in any example.
   */
  it("no README per-turn example labels itself a default prior", () => {
    for (const line of readmePerTurnLines()) expect(line).not.toContain("default prior");
  });

  it("the COMMUNITY SUBSCRIPTION example carries input reduction, full apply and the allowance — and no dollars", () => {
    const rendered = communityFullApplyReceiptLine(applyReceipt("subscription"), estimatedSaved);
    expect(rendered).toBe(
      "compaction · input 91,472→74,769 (−18%) · output 857→463 (−46%, est.) · full apply · 1.92M/2M left · id 5f539978"
    );
    expect(readmePerTurnLines()).toContain(rendered);
  });

  it("the COMMUNITY API-KEY example adds the priced clause and nothing else", () => {
    const rendered = communityFullApplyReceiptLine(applyReceipt("api-key"), estimatedSaved);
    expect(rendered).toBe(
      "compaction · input 91,472→74,769 (−18%) · output 857→463 (−46%, est.) · −$0.05 (list price) · full apply · 1.92M/2M left · id 5f539978"
    );
    expect(readmePerTurnLines()).toContain(rendered);
  });
});

describe("the README's two axes are the runtime's two axes", () => {
  it("ROUTE alone decides the dollar clause: same tier, same model, same counts", () => {
    const sub = communityFullApplyReceiptLine(applyReceipt("subscription"), estimatedSaved) ?? "";
    const key = communityFullApplyReceiptLine(applyReceipt("api-key"), estimatedSaved) ?? "";
    expect(sub).not.toContain("$");
    expect(key).toContain("−$0.05 (list price)");
    // Removing the priced clause from the API-key line must reproduce the subscription line exactly.
    expect(key.replace(" · −$0.05 (list price)", "")).toBe(sub);
  });

  it("CAPABILITY alone decides the input axis: Open can never render a reduction", () => {
    const open = receiptLineFromGatewayReceipt(openReceipt(), "basic", undefined, estimatedSaved) ?? "";
    expect(open).toContain("observed input 91,472");
    expect(open).not.toContain("91,472→74,769");
    expect(open).not.toContain("full apply");
    // The allowance countdown is a Community artifact and must not leak onto an Open line.
    expect(open).not.toContain("left");
  });

  it("the README does not equate a tier with a route", () => {
    // A subscription line with a PRICED model still omits the clause — so the omission cannot be
    // explained away as "the model had no price", which is the misreading this pins shut.
    const sub = communityFullApplyReceiptLine(applyReceipt("subscription"), estimatedSaved) ?? "";
    expect(applyReceipt("subscription").model).toBe(MODEL);
    expect(sub).toContain("full apply");
    expect(sub).not.toContain("list price");
  });
});
