import { describe, expect, it } from "vitest";
import { buildGatewayReceipt } from "../../src/core/gateway/receipt.js";
import { compareGatewayProof, formatGatewayProof, proofSummaryFromReceipt } from "../../src/core/gateway/proof.js";
import { usageFromResponseBody } from "../../src/core/gateway/openai-usage.js";

const fixed = { now: () => "1970-01-01T00:00:00.000Z", id: () => "rid" };
const SECRET = "prompt completion message content must not leak";

function receipt(input: number | undefined, cached: number | undefined, proofRunId = "p1", variant: "baseline" | "compacted" = "baseline") {
  const body = JSON.stringify({
    model: "gpt-4o-mini",
    output: [{ content: [{ text: SECRET }] }],
    ...(input === undefined
      ? {}
      : { usage: { input_tokens: input, output_tokens: 10, ...(cached === undefined ? {} : { input_tokens_details: { cached_tokens: cached } }) } })
  });
  return buildGatewayReceipt({
    provider: "openai",
    endpoint: "/v1/responses",
    mode: "record",
    upstreamStatus: 200,
    usage: usageFromResponseBody(body),
    proofRunId,
    proofVariant: variant,
    ...fixed
  });
}

function delta(before = receipt(1000, 0), after = receipt(700, 70, "p1", "compacted"), proofRunId = "p1") {
  return compareGatewayProof({ proofRunId, baseline: proofSummaryFromReceipt(before), compacted: proofSummaryFromReceipt(after) });
}

describe("gateway proof comparison", () => {
  it("reports a positive provider-reported fresh input reduction", () => {
    const d = delta();
    expect(d.available).toBe(true);
    expect(d.beforeFreshInputTokens).toBe(1000);
    expect(d.afterFreshInputTokens).toBe(630);
    expect(d.freshInputReductionAbsolute).toBe(370);
    expect(d.freshInputReductionPercent).toBe(37);
    expect(formatGatewayProof(d)).toContain("provider-reported fresh input reduced by 37%");
  });

  it("allows zero reduction when provider reported cached_tokens on both sides", () => {
    const d = delta(receipt(100, 0), receipt(100, 0, "p1", "compacted"));
    expect(d.available).toBe(true);
    expect(d.freshInputReductionPercent).toBe(0);
    expect(formatGatewayProof(d)).toContain("provider-reported fresh input unchanged (0% reduction)");
  });

  it("allows a negative reduction when compacted is worse", () => {
    const d = delta(receipt(100, 0), receipt(150, 0, "p1", "compacted"));
    expect(d.available).toBe(true);
    expect(d.freshInputReductionAbsolute).toBe(-50);
    expect(d.freshInputReductionPercent).toBe(-50);
    expect(formatGatewayProof(d)).toContain("provider-reported fresh input increased by 50% (no reduction)");
    expect(formatGatewayProof(d)).not.toContain("reduced by -50%");
  });

  it("is unavailable when cached_tokens are missing and never converts them to zero", () => {
    const d = delta(receipt(100, undefined), receipt(80, undefined, "p1", "compacted"));
    expect(d.available).toBe(false);
    expect(d.reasons.join(" ")).toMatch(/cached_tokens/);
    expect(formatGatewayProof(d)).toContain("reduction unavailable");
  });

  it("is unavailable when provider usage is missing", () => {
    const d = delta(receipt(undefined, undefined), receipt(80, 0, "p1", "compacted"));
    expect(d.available).toBe(false);
    expect(d.reasons.join(" ")).toMatch(/usage\/input tokens/);
  });

  it("is unavailable with only one side present", () => {
    const d = compareGatewayProof({ proofRunId: "p1", baseline: proofSummaryFromReceipt(receipt(100, 0)) });
    expect(d.available).toBe(false);
    expect(d.baselineFound).toBe(true);
    expect(d.compactedFound).toBe(false);
  });

  it("is unavailable on proofRunId mismatch", () => {
    const d = delta(receipt(100, 0, "other"), receipt(80, 0, "p1", "compacted"));
    expect(d.available).toBe(false);
    expect(d.reasons.join(" ")).toMatch(/mismatch/);
  });

  it("proof output remains content-free", () => {
    const out = formatGatewayProof(delta());
    expect(out).not.toContain(SECRET);
    expect(out).not.toMatch(/prompt|completion|message|content/i);
  });

  // A positive fresh-input reduction with DIFFERENT total input (1000 -> 700 total) is a
  // reduced-input scenario: the model saw fewer bytes, so it is NOT "same context".
  it("reduced-input scenario: model-visible change is disclosed and approval is required", () => {
    const out = formatGatewayProof(delta()); // baseline total=1000, compacted total=700
    expect(out).not.toContain("Same context");
    expect(out).toContain("Model-visible input changed: yes (fewer input tokens sent)");
    expect(out).toContain("Approval required: yes (model-visible context change)");
    expect(out).toContain("compacted input tokens:");
    expect(out).not.toContain("cache-optimized:");
    expect(out).not.toContain("Model-visible bytes changed: no");
    // Honest reduction line and negative billing disclaimer are present.
    expect(out).toContain("provider-reported fresh input reduced by 37%");
    expect(out).toContain("Claim: fresh-input reduction, not billing-confirmed invoice savings.");
  });

  // Same TOTAL input on both sides but a higher cached share (fresh input drops) is the pure
  // provider-cache scenario: the model saw the SAME bytes; only the billed fresh split moved.
  it("provider-cache scenario (same total input, fresh drops): same context, no approval", () => {
    // baseline total=1000 (cached 0, fresh 1000); compacted total=1000 (cached 300, fresh 700).
    const d = delta(receipt(1000, 0), receipt(1000, 300, "p1", "compacted"));
    expect(d.available).toBe(true);
    expect(d.beforeInputTokens).toBe(1000);
    expect(d.afterInputTokens).toBe(1000);
    expect(d.freshInputReductionAbsolute).toBe(300);
    const out = formatGatewayProof(d);
    expect(out).toContain("Same context. Less fresh input.");
    expect(out).toContain("cache-optimized input tokens:");
    expect(out).toContain("Model-visible bytes changed: no");
    expect(out).toContain("Approval required: no");
    expect(out).not.toContain("Model-visible input changed: yes");
    expect(out).not.toContain("Approval required: yes");
    expect(out).not.toContain("compacted input tokens:");
    expect(out).toContain("provider-reported fresh input reduced by 30%");
    expect(out).toContain("Claim: fresh-input reduction, not billing-confirmed invoice savings.");
  });

  // 0% reduction with same total input: honest "unchanged" line, no false "Less fresh input"
  // header and no fresh-input-reduction claim, but model-visible=no is still true.
  it("zero-reduction (same total, no fresh drop) makes no reduction claim and no 'Same context. Less fresh input.'", () => {
    const d = delta(receipt(100, 0), receipt(100, 0, "p1", "compacted"));
    const out = formatGatewayProof(d);
    expect(out).toContain("provider-reported fresh input unchanged (0% reduction)");
    expect(out).not.toContain("Same context. Less fresh input.");
    expect(out).not.toContain("Claim: fresh-input reduction");
    // Same total input -> still an honest no-model-visible-change statement.
    expect(out).toContain("Model-visible bytes changed: no");
  });

  // Increased fresh input: no reduction claim, no "Same context", no billing claim line.
  it("increased-fresh-input case makes no reduction/claim line", () => {
    const d = delta(receipt(100, 0), receipt(150, 0, "p1", "compacted"));
    const out = formatGatewayProof(d);
    expect(out).toContain("provider-reported fresh input increased by 50% (no reduction)");
    expect(out).not.toContain("Same context");
    expect(out).not.toContain("Claim: fresh-input reduction");
  });

  // Unavailable: neutral phrasing only, never a guessed "Same context" or scenario claim.
  it("unavailable output stays neutral: no 'Same context', no model-visible/approval/claim lines", () => {
    const d = delta(receipt(100, undefined), receipt(80, undefined, "p1", "compacted"));
    const out = formatGatewayProof(d);
    expect(out).toContain("reduction unavailable");
    expect(out).not.toContain("Same context");
    expect(out).not.toContain("Model-visible bytes changed");
    expect(out).not.toContain("Model-visible input changed");
    expect(out).not.toContain("Approval required");
    expect(out).not.toContain("Claim: fresh-input reduction");
  });

  // Forbidden-positive-claim guard over the rendered output across scenarios.
  it("never emits a positive savings/cost/output-token/invoice claim (only the negative disclaimer)", () => {
    const outs = [
      formatGatewayProof(delta()), // reduced-input
      formatGatewayProof(delta(receipt(1000, 0), receipt(1000, 300, "p1", "compacted"))), // provider-cache
      formatGatewayProof(delta(receipt(100, 0), receipt(100, 0, "p1", "compacted"))) // zero
    ];
    for (const out of outs) {
      expect(out).not.toMatch(/cost\s+saved|cost\s+reduction|\$/i);
      expect(out).not.toMatch(/output\s+tokens?\s+(reduced|saved)/i);
      // "invoice"/"billing-confirmed" may appear ONLY inside the honest negative disclaimer.
      const stripped = out.replace(/\bnot\s+billing-confirmed\s+invoice\s+savings\b/gi, "");
      expect(stripped).not.toMatch(/billing-confirmed|invoice/i);
      // No positive savings phrasing.
      expect(out).not.toMatch(/you\s+saved|savings\s+of|money\s+saved/i);
    }
  });
});
