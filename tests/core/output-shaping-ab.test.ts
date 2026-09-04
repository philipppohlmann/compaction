import { describe, expect, it } from "vitest";
import { TEST_OUTPUT_POLICY_VERSION } from "../helpers/output-calibration-fixture.js";
import {
  addOutputShapingAbRun,
  buildCaptureUsageSidecar,
  initOutputShapingAbExperiment,
  providerReportedOutputArms,
  summarizeOutputShapingAb,
  type OutputShapingAbExperiment,
  type OutputShapingAbRun
} from "../../src/core/output-shaping-ab.js";

/**
 * Public output-shaping A/B harness (increment 4). Core honesty invariant: the public summary NEVER
 * confirms a savings (confirmedSavingsEligible is always false), and the confidence ladder is fail-safe -
 * unavailable (not provider-reported) → review_required (lossy/truncated) → observed_not_confirmed (N<3) →
 * eligible_for_engine_confirmation (preconditions met; engine still does the confirming).
 */
function exp(runs: OutputShapingAbRun[]): OutputShapingAbExperiment {
  let e = initOutputShapingAbExperiment({ experimentId: "exp-1", taskShape: "refactor-summary", createdAt: "2026-06-29T00:00:00.000Z" });
  for (const r of runs) e = addOutputShapingAbRun(e, r);
  return e;
}

function pr(arm: "control" | "treatment", outputTokens: number, extra: Partial<OutputShapingAbRun> = {}): OutputShapingAbRun {
  return {
    arm,
    outputTokens,
    inputTokens: 100,
    providerReported: true,
    tokenSource: "provider-reported",
    ...(arm === "treatment" ? { policyFamily: "output_shaping", policyNames: ["concise_response"], evalMarkersPreserved: true } : {}),
    ...extra
  };
}

describe("summarizeOutputShapingAb - confirmed savings can never appear in the public CLI", () => {
  it("confirmedSavingsEligible is the literal false on every path", () => {
    const cases = [
      exp([]),
      exp([pr("control", 500), pr("treatment", 300)]),
      exp([pr("control", 500), pr("control", 510), pr("control", 490), pr("treatment", 300), pr("treatment", 310), pr("treatment", 290)])
    ];
    for (const e of cases) expect(summarizeOutputShapingAb(e).confirmedSavingsEligible).toBe(false);
  });

  it("local-estimate output on an arm → unavailable (never a savings number)", () => {
    const e = exp([
      pr("control", 500),
      pr("control", 510),
      pr("control", 490),
      { arm: "treatment", outputTokens: 300, inputTokens: 90, providerReported: false, tokenSource: "local-estimate", policyFamily: "output_shaping", policyNames: ["concise_response"], evalMarkersPreserved: true },
      pr("treatment", 310),
      pr("treatment", 290)
    ]);
    const s = summarizeOutputShapingAb(e);
    expect(s.confidence).toBe("unavailable");
    expect(s.reasons.join(" ")).toMatch(/provider-reported/);
  });

  it("missing output tokens stay unavailable, not zero", () => {
    const e = exp([
      { arm: "control", outputTokens: null, inputTokens: 100, providerReported: false, tokenSource: "unknown" },
      pr("treatment", 300)
    ]);
    const s = summarizeOutputShapingAb(e);
    expect(s.confidence).toBe("unavailable");
    expect(s.outputTokensBefore).toBeNull();
  });

  it("eval not recorded → review_required (shorter could be lossy)", () => {
    const e = exp([
      pr("control", 500),
      pr("control", 510),
      pr("control", 490),
      { ...pr("treatment", 300), evalMarkersPreserved: null },
      { ...pr("treatment", 310), evalMarkersPreserved: null },
      { ...pr("treatment", 290), evalMarkersPreserved: null }
    ]);
    expect(summarizeOutputShapingAb(e).confidence).toBe("review_required");
  });

  it("eval fail → review_required", () => {
    const e = exp([
      pr("control", 500),
      pr("control", 510),
      pr("control", 490),
      { ...pr("treatment", 300), evalMarkersPreserved: false },
      pr("treatment", 310),
      pr("treatment", 290)
    ]);
    expect(summarizeOutputShapingAb(e).confidence).toBe("review_required");
  });

  it("truncation/refusal → review_required even with eval pass", () => {
    const e = exp([
      pr("control", 500),
      pr("control", 510),
      pr("control", 490),
      { ...pr("treatment", 300), truncated: true },
      pr("treatment", 310),
      pr("treatment", 290)
    ]);
    expect(summarizeOutputShapingAb(e).confidence).toBe("review_required");
  });

  it("provider-reported + eval pass but N<3 → observed_not_confirmed", () => {
    const e = exp([pr("control", 500), pr("treatment", 300)]);
    const s = summarizeOutputShapingAb(e);
    expect(s.confidence).toBe("observed_not_confirmed");
    expect(s.outputTokenDelta).toBe(200); // observed delta is descriptive, still not confirmed
  });

  it("all preconditions met → eligible_for_engine_confirmation (still not confirmed)", () => {
    const e = exp([
      pr("control", 500),
      pr("control", 510),
      pr("control", 490),
      pr("treatment", 300),
      pr("treatment", 310),
      pr("treatment", 290)
    ]);
    const s = summarizeOutputShapingAb(e);
    expect(s.confidence).toBe("eligible_for_engine_confirmation");
    expect(s.confirmedSavingsEligible).toBe(false);
    expect(s.tokenSource).toBe("provider-reported");
    expect(s.outputTokensBefore).toBe(500);
    expect(s.outputTokensAfter).toBe(300);
    expect(s.outputTokenReductionPct).toBeCloseTo(40, 5);
    expect(s.policyNames).toEqual(["concise_response"]);
    expect(s.evalStatus).toBe("pass");
  });
});

describe("providerReportedOutputArms - engine confirmation input", () => {
  it("returns per-arm provider-reported arrays only when ALL runs are provider-reported", () => {
    const e = exp([
      pr("control", 500),
      pr("control", 510),
      pr("control", 490),
      pr("treatment", 300),
      pr("treatment", 310),
      pr("treatment", 290)
    ]);
    const arms = providerReportedOutputArms(e);
    expect(arms.bothProviderReported).toBe(true);
    expect(arms.controlOutputTokens).toEqual([500, 510, 490]);
    expect(arms.treatmentOutputTokens).toEqual([300, 310, 290]);
  });

  it("bothProviderReported false when an arm has a non-provider-reported run", () => {
    const e = exp([
      pr("control", 500),
      { arm: "treatment", outputTokens: 300, inputTokens: 90, providerReported: false, tokenSource: "local-estimate" }
    ]);
    expect(providerReportedOutputArms(e).bothProviderReported).toBe(false);
  });
});

describe("buildCaptureUsageSidecar", () => {
  it("provider-reported codex usage → providerReported true, present", () => {
    const s = buildCaptureUsageSidecar({
      tool: "codex",
      provider: "openai",
      model: "gpt-x",
      inputTokens: 100,
      outputTokens: 300,
      providerReported: true,
      tokenSource: "provider-reported",
      tokenMetadataStatus: "present",
      policyNames: ["concise_response"],
      policyVersion: TEST_OUTPUT_POLICY_VERSION,
      generatedAt: "2026-06-29T00:00:00.000Z"
    });
    expect(s.providerReported).toBe(true);
    expect(s.outputTokens).toBe(300);
    expect(s.outputShaping).toEqual({
      policyFamily: "output_shaping",
      policyNames: ["concise_response"],
      policyVersion: TEST_OUTPUT_POLICY_VERSION
    });
  });

  it("missing output tokens become null, not zero; no policy attribution when no policies", () => {
    const s = buildCaptureUsageSidecar({
      tool: "cursor",
      providerReported: false,
      tokenSource: "local-estimate",
      tokenMetadataStatus: "missing",
      generatedAt: "2026-06-29T00:00:00.000Z"
    });
    expect(s.outputTokens).toBeNull();
    expect(s.providerReported).toBe(false);
    expect(s.outputShaping).toBeUndefined();
  });
});
