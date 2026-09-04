import { describe, it, expect } from "vitest";
import {
  formatReceiptLine,
  receiptLineFromGatewayReceipt,
  receiptLineOutputOnly,
  communityFullApplyReceiptLine,
  isReceiptLineEnabled,
  RECEIPT_LINE_ENV,
  CALIBRATED_ESTIMATE_MARKER
} from "../../src/core/gateway/receipt-line.js";
import { buildGatewayReceipt } from "../../src/core/gateway/receipt.js";
import { buildApplyReceipt } from "../../src/core/gateway/apply-receipt.js";
import type { OpenAiUsageBreakdown } from "../../src/core/gateway/openai-usage.js";
import type { ApplyActivation } from "../../src/core/gateway/apply-activation.js";
import type { DedupePlan } from "../../src/core/gateway/request-shape.js";

const fixedId = () => "8f4c2f6e-0000-0000-0000-000000000000";
const fixedNow = () => "2026-07-29T00:00:00.000Z";

/**
 * The content-free SHAPE assertion: the line may contain ONLY the prefix, ` · ` separators, digits,
 * thousands separators, the percent/arrow/parens/$ punctuation, the known labels, and `id <hex>`. Any
 * other token (a word, a path, quoted text) fails, this is the design-doc content-free guarantee.
 */
function assertContentFreeShape(line: string): void {
  // Allowed characters only: letters (labels), digits, comma/period, the arrow, %, parens, dashes, the $,
  // the tilde + colon of the out-saved clause, spaces, and the middot separator. No slashes, quotes, etc.
  expect(line).toMatch(/^[A-Za-z0-9,.→%()~:$−\-\s·]+$/);
  // Every non-prefix segment must be a KNOWN clause shape. A plain split on the separator is enough
  // again: the one label that embedded a ` · ` of its own (`est. · default prior`) is gone, and the
  // rejoining hack it needed went with it. No clause may reintroduce the separator inside itself.
  const segments = line.split(" · ");
  expect(segments[0]).toBe("compaction");
  const known =
    /^(observed input [\d,]+|input [\d,]+(→[\d,]+ \(−\d+%\))?|output [\d,]+(→[\d,]+ \(−\d+%, est\.\))?|−\$[\d,]+\.\d{2} \(list price\)|apply off|basic shaping|full apply|id [0-9a-f]{8})$/;
  for (const seg of segments.slice(1)) {
    expect(seg, `segment "${seg}" is not a known content-free clause`).toMatch(known);
  }
}

/**
 * The U+2212 MINUS SIGN (the reduction glyph) may appear ONLY in the input before→after (apply) clause or
 * the apply `−$` cost clause. This asserts no minus glyph leaks anywhere else on a record line. (ASCII
 * hyphens inside label words are not minus signs and are intentionally not flagged.)
 */
function assertMinusOnlyInApplyClauses(line: string): void {
  const segments = line.split(" · ").slice(1);
  for (const seg of segments) {
    const isApplyInput = /^input [\d,]+→[\d,]+ \(−\d+%\)$/.test(seg);
    const isCostClause = /^−\$[\d,]+\.\d{2} \(list price\)$/.test(seg);
    if (!isApplyInput && !isCostClause) {
      expect(seg, `segment "${seg}" must not contain a U+2212 minus sign`).not.toContain("−");
    }
  }
}

describe("formatReceiptLine - canonical per-turn line (new grammar)", () => {
  it("apply mode with a priced model: input before→after (−PP%), output count, −$ cost value clause, id", () => {
    const line = formatReceiptLine({
      inputBefore: 41210,
      inputAfter: 21876,
      outputTokens: 412,
      costReductionUsd: 0.14,
      shortReceiptId: "8f4c2f6e"
    });
    expect(line).toBe(
      "compaction · input 41,210→21,876 (−47%) · output 412 · −$0.14 (list price) · id 8f4c2f6e"
    );
    // The input reduction carries no `compaction` word now; the value clause is the priced cost delta.
    expect(line).toContain("(−47%)");
    expect(line).not.toContain("% compaction");
    expect(line.split(" · ")[1]).toBe("input 41,210→21,876 (−47%)");
    assertContentFreeShape(line);
    assertMinusOnlyInApplyClauses(line);
  });

  it("apply mode, UNPRICED model (no costReductionUsd): input before→after + output, NO value clause", () => {
    const line = formatReceiptLine({
      inputBefore: 41210,
      inputAfter: 21876,
      outputTokens: 412,
      shortReceiptId: "8f4c2f6e"
    });
    expect(line).toBe("compaction · input 41,210→21,876 (−47%) · output 412 · id 8f4c2f6e");
    expect(line).not.toContain("$");
    assertContentFreeShape(line);
  });

  it("record mode: plain input count + output count, NO value clause, no mode/source/cache", () => {
    const line = formatReceiptLine({
      inputTokens: 22012,
      outputTokens: 412,
      shortReceiptId: "8f4c2f6e"
    });
    expect(line).toBe("compaction · input 22,012 · output 412 · id 8f4c2f6e");
    expect(line).not.toContain("−");
    expect(line).not.toContain("record");
    expect(line).not.toContain("provider-reported");
    expect(line).not.toContain("provider-cached");
    assertContentFreeShape(line);
  });

  it("hook-only: output count only, NO input clause, NO reduction %, NO mode/source", () => {
    const line = formatReceiptLine({ outputTokens: 412 });
    expect(line).toBe("compaction · output 412");
    expect(line).not.toContain("input");
    expect(line).not.toContain("%");
    expect(line).not.toContain("shaping on");
    assertContentFreeShape(line);
  });

  it("never renders a `−$0` cost clause (non-positive cost is omitted)", () => {
    const line = formatReceiptLine({
      inputBefore: 100,
      inputAfter: 100,
      outputTokens: 10,
      costReductionUsd: 0,
      shortReceiptId: "8f4c2f6e"
    });
    expect(line).not.toContain("$");
  });

  it("missing fields: omits (never fabricates) an unavailable axis", () => {
    const line = formatReceiptLine({ inputTokens: 100 });
    expect(line).toBe("compaction · input 100");
    assertContentFreeShape(line);
  });

  it("never prints a reduction % on output (output is always a bare count)", () => {
    const line = formatReceiptLine({ outputTokens: 999999 });
    expect(line).toBe("compaction · output 999,999");
    expect(line).not.toMatch(/output[^·]*%/);
  });
});

describe("receiptLineFromGatewayReceipt - from a real record receipt", () => {
  const usageCached: OpenAiUsageBreakdown = {
    present: true,
    promptInputTokens: 100,
    cachedInputTokens: 5,
    billedFreshInputTokens: 95,
    outputTokens: 412,
    model: "gpt-4o"
  };

  it("record → plain input + output only (no provider-cache clause, no mode, no source)", () => {
    const receipt = buildGatewayReceipt({
      provider: "openai",
      endpoint: "/v1/chat/completions",
      mode: "record",
      upstreamStatus: 200,
      usage: usageCached,
      id: fixedId,
      now: fixedNow
    });
    const line = receiptLineFromGatewayReceipt(receipt);
    expect(line).toBe("compaction · input 100 · output 412 · id 8f4c2f6e");
    expect(line).not.toContain("−");
    expect(line).not.toContain("provider-cached");
    expect(line).not.toContain("record");
    assertContentFreeShape(line!);
    assertMinusOnlyInApplyClauses(line!);
  });

  it("record, no cache → plain input + output, no reduction %", () => {
    const usage: OpenAiUsageBreakdown = { present: true, promptInputTokens: 100, outputTokens: 7, model: "gpt-4o" };
    const receipt = buildGatewayReceipt({
      provider: "openai",
      endpoint: "/v1/chat/completions",
      mode: "record",
      upstreamStatus: 200,
      usage,
      id: fixedId,
      now: fixedNow
    });
    const line = receiptLineFromGatewayReceipt(receipt);
    expect(line).toBe("compaction · input 100 · output 7 · id 8f4c2f6e");
    expect(line).not.toContain("%");
    expect(line).not.toContain("−");
  });

  it("no usage at all → undefined (nothing honest to print)", () => {
    const usage: OpenAiUsageBreakdown = { present: false, unavailableReason: "no usage" };
    const receipt = buildGatewayReceipt({
      provider: "openai",
      endpoint: "/v1/models",
      mode: "record",
      upstreamStatus: 200,
      usage,
      id: fixedId,
      now: fixedNow
    });
    expect(receiptLineFromGatewayReceipt(receipt)).toBeUndefined();
  });
});

describe("receiptLineFromGatewayReceipt - from a real apply receipt", () => {
  const applyActivation: ApplyActivation = {
    mode: "apply",
    requested: true,
    activation: "explicit-mode",
    policy: "deterministic-dedupe"
  };
  const plan: DedupePlan = {
    policy: "deterministic-dedupe",
    shape: "chat-messages",
    supported: true,
    changed: true,
    removedBlocks: 1,
    charsBefore: 164840,
    charsAfter: 87504,
    estTokensBefore: 41210,
    estTokensAfter: 21876,
    reductionPercent: 47
  };

  /**
   * A REAL but tiny reduction must not render `−$0.00 (est)` — a value clause announcing no value is the
   * same defect as the fabricated zero this path already avoids. `formatUsd`
   * rounds to two decimals, so anything under half a cent is dropped instead of displayed.
   */
  it("omits a SUB-CENT cost clause rather than rendering −$0.00", () => {
    // gpt-4o-mini input price is $0.15/M. delta = 1000 tokens → 1000/1e6*0.15 = $0.00015 → would render −$0.00.
    const usage: OpenAiUsageBreakdown = { present: true, promptInputTokens: 50, outputTokens: 20, model: "gpt-4o-mini" };
    const tinyPlan: DedupePlan = { ...plan, estTokensBefore: 1_100, estTokensAfter: 100, reductionPercent: 91 };
    const receipt = buildApplyReceipt({
      provider: "openai",
      endpoint: "/v1/chat/completions",
      upstreamStatus: 200,
      usage,
      activation: applyActivation,
      plan: tinyPlan,
      applied: true,
      id: fixedId,
      now: fixedNow
    });
    const line = receiptLineFromGatewayReceipt(receipt);
    expect(line, "a sub-cent reduction must not print a dollar clause").not.toContain("$");
    // Anti-vacuity: the line still exists and still carries the real before→after it DID achieve.
    expect(line).toContain("1,100→100");
  });

  it("apply that actually mutated (priced model) → before→after + the COMPUTED −$ cost value clause", () => {
    // gpt-4o input price is $2.5/M. delta = 41210−21876 = 19334 tokens → 19334/1e6*2.5 = $0.0483 → $0.05.
    const usage: OpenAiUsageBreakdown = { present: true, promptInputTokens: 50, outputTokens: 20, model: "gpt-4o" };
    const receipt = buildApplyReceipt({
      provider: "openai",
      endpoint: "/v1/chat/completions",
      upstreamStatus: 200,
      usage,
      activation: applyActivation,
      plan,
      applied: true,
      // The BILLED route. The cost clause is route-gated: see the route-gate suite in
      // tests/core/receipt-line-cost-clause.test.ts.
      upstreamRouteType: "api-key",
      id: fixedId,
      now: fixedNow
    });
    const line = receiptLineFromGatewayReceipt(receipt);
    expect(line).toBe(
      "compaction · input 41,210→21,876 (−47%) · output 20 · −$0.05 (list price) · id 8f4c2f6e"
    );
    expect(line).toContain("(−47%)");
    assertContentFreeShape(line!);
    assertMinusOnlyInApplyClauses(line!);
  });

  it("apply mutated but UNPRICED model → before→after + output, cost clause OMITTED (never −$0)", () => {
    const usage: OpenAiUsageBreakdown = { present: true, promptInputTokens: 50, outputTokens: 20, model: "some-unlisted-model" };
    const receipt = buildApplyReceipt({
      provider: "openai",
      endpoint: "/v1/chat/completions",
      upstreamStatus: 200,
      usage,
      activation: applyActivation,
      plan,
      applied: true,
      id: fixedId,
      now: fixedNow
    });
    const line = receiptLineFromGatewayReceipt(receipt);
    expect(line).toBe("compaction · input 41,210→21,876 (−47%) · output 20 · id 8f4c2f6e");
    expect(line).not.toContain("$");
  });

  it("apply requested but NOT applied (no-op) → no before→after, no cost, plain provider input", () => {
    const usage: OpenAiUsageBreakdown = { present: true, promptInputTokens: 50, outputTokens: 20, model: "gpt-4o" };
    const receipt = buildApplyReceipt({
      provider: "openai",
      endpoint: "/v1/chat/completions",
      upstreamStatus: 200,
      usage,
      activation: applyActivation,
      applied: false,
      id: fixedId,
      now: fixedNow
    });
    const line = receiptLineFromGatewayReceipt(receipt);
    expect(line).toBe("compaction · input 50 · output 20 · id 8f4c2f6e");
    expect(line).not.toContain("→");
    expect(line).not.toContain("$");
    expect(line).not.toContain("−");
  });

  /**
   * NET-VS-GROSS claim boundary (guards the input claim). The apply `−PP%` and the `−$` it prices
   * are computed from the receipt's `estimated_input_tokens_before/after`, which the apply-receipt builder
   * fills from the plan's MODEL-VISIBLE token estimates (local-estimate). So today they are GROSS
   * model-visible, NOT net-of-provider-cache fresh-billed. This test PINS that so a future flip to net
   * semantics is a deliberate, reviewed edit — not an accidental relabel.
   */
  it("the apply `−PP%`/`−$` are GROSS model-visible today (net-of-cache is a documented TODO)", () => {
    const usage: OpenAiUsageBreakdown = { present: true, promptInputTokens: 50, outputTokens: 20, model: "gpt-4o" };
    const receipt = buildApplyReceipt({
      provider: "openai",
      endpoint: "/v1/chat/completions",
      upstreamStatus: 200,
      usage,
      activation: applyActivation,
      plan,
      applied: true,
      id: fixedId,
      now: fixedNow
    });
    expect(receipt.estimated_input_tokens_before).toBe(41210);
    expect(receipt.estimated_input_tokens_after).toBe(21876);
    expect(receipt.token_source_before).toBe("local-estimate");
    expect(receipt.token_source_after).toBe("local-estimate");
    const line = receiptLineFromGatewayReceipt(receipt);
    expect(line).toContain("input 41,210→21,876 (−47%)");
    expect((receipt as Record<string, unknown>).fresh_billed_input_tokens_before).toBeUndefined();
    expect((receipt as Record<string, unknown>).fresh_billed_input_tokens_after).toBeUndefined();
  });
});

describe("receiptLineOutputOnly - hook-only path", () => {
  it("provider-reported output → plain output-only line (no source label rendered)", () => {
    expect(receiptLineOutputOnly({ outputTokens: 412, providerReported: true, shapingActive: true })).toBe(
      "compaction · output 412"
    );
  });

  it("estimated output → plain output-only line (no source label rendered)", () => {
    expect(receiptLineOutputOnly({ outputTokens: 412, providerReported: false, shapingActive: true })).toBe(
      "compaction · output 412"
    );
  });

  it("shaping NOT active → est-saved clause suppressed even if passed", () => {
    const line = receiptLineOutputOnly({
      outputTokens: 512,
      providerReported: false,
      shapingActive: false,
      estimatedSaved: { calibrated: true, tokensSaved: 140 }
    });
    expect(line).toBe("compaction · output 512");
    expect(line).not.toContain("saved");
  });

  it("no output count → undefined (nothing honest to print)", () => {
    expect(receiptLineOutputOnly({ providerReported: false, shapingActive: true })).toBeUndefined();
  });
});

describe("receiptLineOutputOnly - out-saved clause (labeled est, never a per-turn %)", () => {
  it("calibrated → the output clause becomes before→after (est), content-free", () => {
    const line = receiptLineOutputOnly({
      outputTokens: 512,
      providerReported: false,
      shapingActive: true,
      estimatedSaved: { calibrated: true, tokensSaved: 140 }
    });
    // 512 real output + 140 estimated saved = a 652 derived before. The arrow is on OUTPUT now.
    expect(line).toBe("compaction · output 652→512 (−21%, est.)");
    assertContentFreeShape(line as string);
    expect(line, "an output percent must always carry `est`").not.toMatch(/−\d+%(?!, est)/);
  });

  it("requested but uncalibrated → a plain count, never a fabricated before", () => {
    const line = receiptLineOutputOnly({
      outputTokens: 512,
      providerReported: true,
      shapingActive: true,
      estimatedSaved: { calibrated: false }
    });
    expect(line).toBe("compaction · output 512");
    assertContentFreeShape(line as string);
    expect(line).not.toMatch(/~\d/);
  });

  it("calibrated:false ignores any stray tokensSaved (no fabricated number leaks through)", () => {
    const line = receiptLineOutputOnly({
      outputTokens: 512,
      providerReported: false,
      shapingActive: true,
      estimatedSaved: { calibrated: false, tokensSaved: 999 }
    });
    expect(line).toBe("compaction · output 512");
    expect(line).not.toContain("999");
  });

  it("calibrated with a non-positive count degrades to a plain count (never a 0-token arrow)", () => {
    const line = receiptLineOutputOnly({
      outputTokens: 512,
      providerReported: false,
      shapingActive: true,
      estimatedSaved: { calibrated: true, tokensSaved: 0 }
    });
    expect(line).toBe("compaction · output 512");
    expect(line).not.toContain("→");
  });

  it("no estimatedSaved param → plain output-only line (gateway/record/apply lines never carry the clause)", () => {
    const line = receiptLineOutputOnly({ outputTokens: 512, providerReported: false, shapingActive: true });
    expect(line).toBe("compaction · output 512");
    expect(line).not.toContain("saved");
  });
});

describe("output-arrow PROVENANCE: a default prior renders no per-run figure at all", () => {
  /**
   * E8 — the shipped estimate marker is the real user-facing text, never a placeholder.
   *
   * The second marker this block used to pin (`est. · default prior`) is GONE. It was an accurate
   * disclosure printed beside a fully specific `777→412 (−47%)` on turn one of a fresh install, and a
   * specific pair reads as counted whatever the words next to it say. The rule "a default prior must
   * never read as measured evidence" is now carried by the ARROW's absence rather than by a label.
   */
  it("the shipped estimate marker is the real label, not a `TBD-` placeholder", () => {
    expect(CALIBRATED_ESTIMATE_MARKER).toBe("est.");
    expect(CALIBRATED_ESTIMATE_MARKER).not.toMatch(/TBD/i);
  });

  /** The defect this branch fixes: a default-prior basis yields a plain count, no arrow, no percent. */
  it("basis `default-prior` → a plain `output N`, no arrow and no percent", () => {
    const line = receiptLineOutputOnly({
      outputTokens: 512,
      providerReported: false,
      shapingActive: true,
      estimatedSaved: { calibrated: true, tokensSaved: 140, basis: "default-prior" }
    });
    expect(line).toBe("compaction · output 512");
    assertContentFreeShape(line as string);
  });

  /**
   * Separate from the exact-string pin above so it cannot go silently dead behind it: NOTHING that
   * reads as a counted reduction survives on a default-prior line — no arrow glyph, no percent, and
   * no leftover provenance wording either.
   */
  it("a default-prior line carries no reduction glyph, percent, or prior wording", () => {
    const line = receiptLineOutputOnly({
      outputTokens: 512,
      providerReported: false,
      shapingActive: true,
      estimatedSaved: { calibrated: true, tokensSaved: 140, basis: "default-prior" }
    }) as string;
    expect(line).not.toContain("→");
    expect(line).not.toMatch(/−\d+%/);
    expect(line).not.toContain("default prior");
    expect(line).not.toContain("est.");
  });

  /** A DEVICE-MEASURED turn is UNCHANGED: it keeps the arrow it earned. */
  it("basis `measured` → `output B→A (−PP%, est.)`", () => {
    const line = receiptLineOutputOnly({
      outputTokens: 512,
      providerReported: false,
      shapingActive: true,
      estimatedSaved: { calibrated: true, tokensSaved: 140, basis: "measured" }
    });
    expect(line).toBe("compaction · output 652→512 (−21%, est.)");
    assertContentFreeShape(line as string);
  });

  /**
   * The founder rule, stated as a comparison: with the SAME magnitude handed in, a measured device
   * shows a figure and an unmeasured one shows none. It is the EVIDENCE that decides, not the number.
   */
  it("same magnitude, different evidence: measured renders a figure, the prior renders none", () => {
    const common = { outputTokens: 512, providerReported: false, shapingActive: true } as const;
    const prior = receiptLineOutputOnly({ ...common, estimatedSaved: { calibrated: true, tokensSaved: 140, basis: "default-prior" } });
    const measured = receiptLineOutputOnly({ ...common, estimatedSaved: { calibrated: true, tokensSaved: 140, basis: "measured" } });
    expect(prior).not.toBe(measured);
    expect(measured).toContain("652→512 (−21%");
    expect(prior).not.toContain("652");
    expect(prior).not.toContain("−21%");
  });

  /**
   * Absent basis still renders the arrow. Every producer of a prior sets `"default-prior"` explicitly
   * (shared exact resolver → `loadCalibrationReduction` → `estimatePerTurnOutputSaved`), so absence means a
   * caller passing its own measurement, not a prior arriving unlabelled.
   */
  it("absent basis → the arrow renders with the generic `est.`", () => {
    const line = receiptLineOutputOnly({
      outputTokens: 512,
      providerReported: false,
      shapingActive: true,
      estimatedSaved: { calibrated: true, tokensSaved: 140 }
    });
    expect(line).toBe("compaction · output 652→512 (−21%, est.)");
  });
});

describe("formatReceiptLine - out-saved clause is opt-in and never a % ", () => {
  it("estimatedOutputSavedRequested is required: unset ⇒ no saved clause even with a count present", () => {
    const line = formatReceiptLine({
      outputTokens: 512,
      estimatedOutputTokensSaved: 140,
      estimatedOutputSavedCalibrated: true
    });
    expect(line).not.toContain("saved");
  });

  /**
   * The output % is DERIVED FROM THE PAIR SHOWN, so the arrow and the percentage can never disagree —
   * and `est` is the only thing separating it from the input clause's MEASURED `−PP%`.
   */
  it("the output percent is computed from the rendered pair, and always carries `est`", () => {
    const line = formatReceiptLine({
      outputTokens: 512,
      estimatedOutputSavedRequested: true,
      estimatedOutputSavedCalibrated: true,
      estimatedOutputTokensSaved: 140
    });
    // 140 saved out of a 652 derived before = 21%.
    expect(line).toContain("652→512 (−21%, est.)");
    expect(line, "an output percent must never appear unlabeled").not.toMatch(/−\d+%(?!, est)/);
  });

  it("the cost clause takes precedence over an out-saved clause if both are somehow present", () => {
    const line = formatReceiptLine({
      outputTokens: 512,
      costReductionUsd: 0.22,
      estimatedOutputSavedRequested: true,
      estimatedOutputSavedCalibrated: true,
      estimatedOutputTokensSaved: 140
    });
    expect(line).toContain("−$0.22 (list price)");
  });
});

describe("open-core tier labels (observe → apply off, basic → basic shaping, full → full apply)", () => {
  it("observe: `observed input N · output N · apply off · id` (no reduction glyph, no compaction of input)", () => {
    const line = formatReceiptLine({
      observedInput: 41210,
      outputTokens: 512,
      tier: "observe",
      shortReceiptId: "a1b2c3d4"
    });
    expect(line).toBe("compaction · observed input 41,210 · output 512 · apply off · id a1b2c3d4");
    expect(line).not.toContain("−");
    expect(line).not.toContain("→");
    assertContentFreeShape(line);
    assertMinusOnlyInApplyClauses(line);
  });

  it("basic: `observed input N · output N · basic shaping · id` (deterministic shaping, still no input reduction)", () => {
    const line = formatReceiptLine({
      observedInput: 41210,
      outputTokens: 372,
      tier: "basic",
      shortReceiptId: "a1b2c3d4"
    });
    expect(line).toBe("compaction · observed input 41,210 · output 372 · basic shaping · id a1b2c3d4");
    expect(line).not.toContain("−");
    assertContentFreeShape(line);
  });

  it("basic with a CALIBRATED saving: output before→after (est) · basic shaping · id", () => {
    const line = formatReceiptLine({
      observedInput: 41210,
      outputTokens: 372,
      estimatedOutputSavedRequested: true,
      estimatedOutputSavedCalibrated: true,
      estimatedOutputTokensSaved: 140,
      tier: "basic",
      shortReceiptId: "a1b2c3d4"
    });
    expect(line).toBe(
      "compaction · observed input 41,210 · output 512→372 (−27%, est.) · basic shaping · id a1b2c3d4"
    );
    assertContentFreeShape(line);
    expect(line, "an output percent must always carry `est`").not.toMatch(/−\d+%(?!, est)/);
  });

  it("basic with an UNCALIBRATED request omits the arrow entirely", () => {
    const line = formatReceiptLine({
      observedInput: 41210,
      outputTokens: 372,
      estimatedOutputSavedRequested: true,
      estimatedOutputSavedCalibrated: false,
      tier: "basic",
      shortReceiptId: "a1b2c3d4"
    });
    expect(line).not.toContain("→");
    expect(line).toContain("basic shaping");
    expect(line).not.toMatch(/~\d/);
  });

  it("the `full apply` label is DEFINED for the Community full-apply line (apply before→after + full apply)", () => {
    const line = formatReceiptLine({
      inputBefore: 41210,
      inputAfter: 21876,
      outputTokens: 286,
      tier: "full",
      shortReceiptId: "a1b2c3d4"
    });
    expect(line).toBe("compaction · input 41,210→21,876 (−47%) · output 286 · full apply · id a1b2c3d4");
    assertContentFreeShape(line);
  });
});

describe("receiptLineFromGatewayReceipt - Open tier (observed input, never a reduction)", () => {
  const usage: OpenAiUsageBreakdown = { present: true, promptInputTokens: 41210, outputTokens: 512, model: "gpt-4o" };
  const openReceipt = () =>
    buildGatewayReceipt({
      provider: "openai",
      endpoint: "/v1/chat/completions",
      mode: "record",
      upstreamStatus: 200,
      usage,
      id: fixedId,
      now: fixedNow
    });

  it("observe → `observed input N · output N · apply off · id`", () => {
    const line = receiptLineFromGatewayReceipt(openReceipt(), "observe");
    expect(line).toBe("compaction · observed input 41,210 · output 512 · apply off · id 8f4c2f6e");
    expect(line).not.toContain("→");
    expect(line).not.toContain("−");
  });

  it("basic → `observed input N · output N · basic shaping · id`", () => {
    const line = receiptLineFromGatewayReceipt(openReceipt(), "basic");
    expect(line).toBe("compaction · observed input 41,210 · output 512 · basic shaping · id 8f4c2f6e");
  });

  it("no tier → the legacy plain `input N` line (no label), unchanged", () => {
    const line = receiptLineFromGatewayReceipt(openReceipt());
    expect(line).toBe("compaction · input 41,210 · output 512 · id 8f4c2f6e");
    expect(line).not.toContain("apply off");
    expect(line).not.toContain("basic shaping");
  });
});

describe("communityFullApplyReceiptLine - DEFINED but emitted ONLY on a real full-apply receipt", () => {
  const applyActivation: ApplyActivation = {
    mode: "apply",
    requested: true,
    activation: "explicit-mode",
    policy: "deterministic-dedupe"
  };
  const plan: DedupePlan = {
    policy: "deterministic-dedupe",
    shape: "chat-messages",
    supported: true,
    changed: true,
    removedBlocks: 1,
    charsBefore: 164840,
    charsAfter: 87504,
    estTokensBefore: 41210,
    estTokensAfter: 21876,
    reductionPercent: 47
  };

  it("a REAL apply receipt → `input B→A (−PP%) · output N · full apply · id`", () => {
    const usage: OpenAiUsageBreakdown = { present: true, promptInputTokens: 50, outputTokens: 286, model: "gpt-4o" };
    const receipt = buildApplyReceipt({
      provider: "openai",
      endpoint: "/v1/chat/completions",
      upstreamStatus: 200,
      usage,
      activation: applyActivation,
      plan,
      applied: true,
      id: fixedId,
      now: fixedNow
    });
    const line = communityFullApplyReceiptLine(receipt);
    expect(line).toContain("input 41,210→21,876 (−47%)");
    expect(line).toContain("output 286");
    expect(line).toContain("full apply");
    expect(line).toContain("id 8f4c2f6e");
  });

  it("a RECORD receipt (no real apply) → undefined (full apply is never synthesized on an Open/record line)", () => {
    const usage: OpenAiUsageBreakdown = { present: true, promptInputTokens: 100, outputTokens: 412, model: "gpt-4o" };
    const receipt = buildGatewayReceipt({
      provider: "openai",
      endpoint: "/v1/chat/completions",
      mode: "record",
      upstreamStatus: 200,
      usage,
      id: fixedId,
      now: fixedNow
    });
    expect(communityFullApplyReceiptLine(receipt)).toBeUndefined();
  });

  it("an apply that did NOT mutate (no-op) → undefined (never a fabricated full-apply line)", () => {
    const usage: OpenAiUsageBreakdown = { present: true, promptInputTokens: 50, outputTokens: 20, model: "gpt-4o" };
    const receipt = buildApplyReceipt({
      provider: "openai",
      endpoint: "/v1/chat/completions",
      upstreamStatus: 200,
      usage,
      activation: applyActivation,
      applied: false,
      id: fixedId,
      now: fixedNow
    });
    expect(communityFullApplyReceiptLine(receipt)).toBeUndefined();
  });
});

/**
 * THE HEALTHY-TURN ALLOWANCE COUNTDOWN. Before this, a Community device learned the state of its
 * allowance exactly once — the turn it ran out, in a clause that also asked it to upgrade. The
 * countdown reports the same allowance on every healthy metered turn, as `REMAINING/TOTAL left`.
 *
 * TWO RULES THE SHAPE ENCODES:
 *  - Both figures are read OFF THE RECEIPT, never from current device state, so a replayed receipt
 *    renders the balance of the turn it describes and the statusline render loop performs no file
 *    read and no network call.
 *  - The denominator is the period TOTAL. The lease's `allowance_tokens` is already net of
 *    server-recorded consumption, so dividing by it would render a full tank on a half-spent period.
 */
describe("communityFullApplyReceiptLine - healthy allowance countdown", () => {
  const applyActivation: ApplyActivation = {
    mode: "apply",
    requested: true,
    activation: "explicit-mode",
    policy: "deterministic-dedupe"
  };
  const plan: DedupePlan = {
    policy: "deterministic-dedupe",
    shape: "chat-messages",
    supported: true,
    changed: true,
    removedBlocks: 1,
    charsBefore: 164840,
    charsAfter: 87504,
    estTokensBefore: 41210,
    estTokensAfter: 21876,
    reductionPercent: 47
  };
  const usage: OpenAiUsageBreakdown = { present: true, promptInputTokens: 50, outputTokens: 286, model: "gpt-4o" };

  function applyLine(
    allowanceSnapshot?: Parameters<typeof buildApplyReceipt>[0]["allowanceSnapshot"],
    extra: Partial<Parameters<typeof buildApplyReceipt>[0]> = {}
  ): string | undefined {
    const receipt = buildApplyReceipt({
      provider: "openai",
      endpoint: "/v1/chat/completions",
      upstreamStatus: 200,
      usage,
      activation: applyActivation,
      plan,
      applied: true,
      id: fixedId,
      now: fixedNow,
      ...(allowanceSnapshot ? { allowanceSnapshot } : {}),
      ...extra
    });
    return communityFullApplyReceiptLine(receipt);
  }

  it("renders `REMAINING/TOTAL left` on a healthy metered turn", () => {
    const line = applyLine({ remaining_tokens: 1_823_400, period_total_tokens: 2_000_000, period_id: "2026-08" });
    // A REPORT, not a pitch. Pinned as a WHOLE CLAUSE rather than a substring, so the countdown cannot
    // acquire a CTA, a price, or an adjective without this failing. (The line's own cost clause is a
    // separate axis and is asserted elsewhere.)
    const clauses = (line ?? "").split(" \u00b7 ");
    expect(clauses).toContain("1.82M/2M left");
    // Its position is between the entitlement label and the id — the ceiling clause's slot on a paused turn.
    expect(clauses.indexOf("1.82M/2M left")).toBeGreaterThan(clauses.indexOf("full apply"));
    expect(line).not.toContain("Upgrade");
    expect(line).not.toContain("paused");
  });

  it("TRUNCATES rather than rounds up — a remainder is never shown as more headroom than the device has", () => {
    // 1,899,999 rounds to 1.9M but truncates to 1.89M. Rounding up would overstate the balance.
    expect(applyLine({ remaining_tokens: 1_899_999, period_total_tokens: 2_000_000 })).toContain("1.89M/2M left");
    expect(applyLine({ remaining_tokens: 949_999, period_total_tokens: 2_000_000 })).toContain("949.9K/2M left");
    expect(applyLine({ remaining_tokens: 730, period_total_tokens: 2_000_000 })).toContain("730/2M left");
    // Exhausted-but-not-yet-paused still reports honestly rather than hiding the zero.
    expect(applyLine({ remaining_tokens: 0, period_total_tokens: 2_000_000 })).toContain("0/2M left");
  });

  it("NO snapshot (a v1 lease carries no total) → no countdown clause, and the rest of the line is unchanged", () => {
    const line = applyLine();
    expect(line).not.toContain("left");
    // The absence is a MISSING CLAUSE, not a degraded line: the evidence axes still render.
    expect(line).toContain("input 41,210→21,876 (−47%)");
    expect(line).toContain("full apply");
  });

  it("an INCOHERENT pair renders nothing rather than a clamped number that still looks authoritative", () => {
    // A remainder above the total, or a zero total, is a lease the server should never have signed.
    // `2.1M/2M left` would be worse than silence, and so would a silently clamped `2M/2M left`.
    expect(applyLine({ remaining_tokens: 2_100_000, period_total_tokens: 2_000_000 })).not.toContain("left");
    expect(applyLine({ remaining_tokens: 0, period_total_tokens: 0 })).not.toContain("left");
    expect(applyLine({ remaining_tokens: -1, period_total_tokens: 2_000_000 })).not.toContain("left");
  });

  it("a PAUSE on the same receipt supersedes the countdown — one line never both counts down and pauses", () => {
    // Defence in depth. The gateway declines to record a snapshot on a paused turn, and a paused turn
    // compacts no input so this builder would decline anyway; this pins the RENDERER's own rule, so the
    // invariant survives a future caller that assembles a receipt some other way.
    const line = applyLine(
      { remaining_tokens: 1_823_400, period_total_tokens: 2_000_000 },
      { allowancePause: { reason: "metered-balance-exhausted", period_id: "2026-08" } }
    );
    expect(line).not.toContain("1.82M/2M left");
  });
});

describe("receiptLineOutputOnly - Open tier label on the hook-only path", () => {
  it("basic tier → `output N · basic shaping` on the hook-only path", () => {
    const line = receiptLineOutputOnly({
      outputTokens: 372,
      providerReported: false,
      shapingActive: true,
      tier: "basic"
    });
    expect(line).toBe("compaction · output 372 · basic shaping");
  });

  it("basic tier + calibrated saving → `output B→A (est) · basic shaping`", () => {
    const line = receiptLineOutputOnly({
      outputTokens: 512,
      providerReported: false,
      shapingActive: true,
      tier: "basic",
      estimatedSaved: { calibrated: true, tokensSaved: 140 }
    });
    expect(line).toBe("compaction · output 652→512 (−21%, est.) · basic shaping");
  });

  it("observe tier → `output N · apply off`", () => {
    const line = receiptLineOutputOnly({
      outputTokens: 512,
      providerReported: false,
      shapingActive: false,
      tier: "observe"
    });
    expect(line).toBe("compaction · output 512 · apply off");
  });
});

describe("isReceiptLineEnabled - kill switch", () => {
  it("enabled by default (env unset)", () => {
    expect(isReceiptLineEnabled({})).toBe(true);
  });
  it("silenced by 0/false/off/no (case-insensitive)", () => {
    for (const v of ["0", "false", "off", "no", "FALSE", "Off"]) {
      expect(isReceiptLineEnabled({ [RECEIPT_LINE_ENV]: v })).toBe(false);
    }
  });
  it("any other value keeps it enabled", () => {
    expect(isReceiptLineEnabled({ [RECEIPT_LINE_ENV]: "1" })).toBe(true);
    expect(isReceiptLineEnabled({ [RECEIPT_LINE_ENV]: "yes" })).toBe(true);
  });
});

/**
 * THE INPUT AXIS DESCRIBES A CAPABILITY THAT ACTUALLY RAN.
 *
 * `request_mutated: true` plus a before/after pair is NOT evidence of input compaction: output shaping
 * mutates the request too, and writes that same pair — for a body it made BIGGER. Reading it as an input
 * apply can turn shaping-only growth into a false input-savings axis. The axis follows
 * `applied_components`, which is the engine's own statement
 * of what it did.
 *
 * Both renderers are asserted on every case: they are separate builders and a rule enforced in only one
 * of them is a rule the other surface can still break.
 */
describe("input savings axis: only when an input-compaction component actually ran", () => {
  const BASE = {
    receipt_id: "aa11bb22-0000-0000-0000-000000000000",
    captured_at: fixedNow(),
    provider: "anthropic",
    model: "claude-haiku-4-5-20251001",
    endpoint: "/v1/messages",
    mode: "apply",
    policy: "deterministic-dedupe",
    tokens: { prompt_input: 1001, output: 47 }
  };
  function receipt(over: Record<string, unknown>) {
    return { ...BASE, ...over } as unknown as Parameters<typeof communityFullApplyReceiptLine>[0];
  }
  /** Every line that could carry the axis, so neither builder can diverge from the rule. */
  function bothLines(r: Parameters<typeof communityFullApplyReceiptLine>[0]): string[] {
    return [communityFullApplyReceiptLine(r) ?? "", receiptLineFromGatewayReceipt(r) ?? ""];
  }
  /** The before→after reduction form, in any of its renderings. */
  function hasInputAxis(line: string): boolean {
    return /input [\d,]+→[\d,]+ \(−-?\d+%\)/.test(line);
  }

  it("SHAPING ONLY → no input axis (the shipped defect)", () => {
    // The exact shape of the defect: the shaped body is LARGER, so the pair the shaper left behind
    // describes growth, and rendering it claimed a reduction of zero on a turn that optimized no input.
    const r = receipt({
      request_mutated: true,
      applied_components: ["output-shaping"],
      estimated_input_tokens_before: 1_500,
      estimated_input_tokens_after: 1_600
    });
    for (const line of bothLines(r)) {
      expect(hasInputAxis(line), line).toBe(false);
      expect(line).not.toContain("1,500");
      expect(line).not.toContain("1,600");
      // The turn is still described: the plain provider-reported count survives, and so does its output.
      expect(line).toContain("input 1,001");
      expect(line).toContain("output 47");
    }
  });

  it("INPUT COMPACTION + SHAPING → input axis, with the real reduction", () => {
    const r = receipt({
      request_mutated: true,
      applied_components: ["lcm-compaction", "output-shaping"],
      estimated_input_tokens_before: 1_500,
      estimated_input_tokens_after: 1_000
    });
    for (const line of bothLines(r)) {
      expect(line).toContain("input 1,500→1,000 (−33%)");
    }
  });

  it("INPUT COMPACTION ALONE → input axis", () => {
    const r = receipt({
      request_mutated: true,
      applied_components: ["deterministic-compaction"],
      estimated_input_tokens_before: 41_210,
      estimated_input_tokens_after: 21_876
    });
    for (const line of bothLines(r)) {
      expect(line).toContain("input 41,210→21,876 (−47%)");
    }
  });

  it("NO MUTATION → no input axis at all", () => {
    const r = receipt({
      request_mutated: false,
      applied_components: [],
      estimated_input_tokens_before: 41_210,
      estimated_input_tokens_after: 21_876
    });
    // The community builder refuses the line outright (`full apply` is never synthesized); the Open/gateway
    // builder renders the turn without an axis.
    expect(communityFullApplyReceiptLine(r)).toBeUndefined();
    const line = receiptLineFromGatewayReceipt(r) ?? "";
    expect(hasInputAxis(line), line).toBe(false);
    expect(line).not.toContain("21,876");
  });

  it("A REAL INPUT APPLY THAT REDUCED NOTHING KEEPS ITS AXIS — a truthful zero is not the defect", () => {
    // The rule is component-based rather than arithmetic precisely so this survives: a compaction pass
    // that ran and legitimately found nothing to remove measured −0%, and that is a real measurement of a
    // real apply. Suppressing it would hide a capability that ran, which is the opposite failure.
    const r = receipt({
      request_mutated: true,
      applied_components: ["deterministic-compaction"],
      estimated_input_tokens_before: 41_210,
      estimated_input_tokens_after: 41_210
    });
    for (const line of bothLines(r)) {
      expect(line).toContain("input 41,210→41,210 (−0%)");
    }
  });

  it("A PAUSED TURN STILL SAYS `input paused`, though it now carries no axis to replace", () => {
    // The pause clause used to be keyed on the presence of the (fabricated) axis it was replacing. With the
    // axis correctly absent, the one word that explains the CTA beneath it must not vanish with it.
    const r = receipt({
      request_mutated: true,
      applied_components: ["output-shaping"],
      estimated_input_tokens_before: 75_777,
      estimated_input_tokens_after: 75_883,
      allowance_pause: { reason: "insufficient", resets_on: "2026-09-01", scope: "all-routes" }
    });
    for (const line of [
      communityFullApplyReceiptLine(r, undefined, { reason: "insufficient", resetsOn: "2026-09-01", scope: "all-routes" }) ?? "",
      receiptLineFromGatewayReceipt(r, undefined, undefined, undefined, {
        reason: "insufficient",
        resetsOn: "2026-09-01",
        scope: "all-routes"
      }) ?? ""
    ]) {
      expect(line).toContain("input paused");
      expect(hasInputAxis(line), line).toBe(false);
      expect(line).toContain("Community limit resets 2026-09-01");
    }
  });
});
