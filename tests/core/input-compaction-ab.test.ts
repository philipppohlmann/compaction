import { describe, expect, it } from "vitest";
import {
  addInputCompactionAbRun,
  initInputCompactionAbExperiment,
  providerReportedInputArms,
  runFromSidecar,
  summarizeInputCompactionAb,
  type InputCompactionAbExperiment,
  type InputCompactionAbRun
} from "../../src/core/input-compaction-ab.js";
import type { CaptureUsageSidecar } from "../../src/core/output-shaping-ab.js";

/**
 * Public input-compaction A/B harness. Invariants: the public summary NEVER confirms
 * (confirmedSavingsEligible always false); input delta is computed from INPUT tokens (output is secondary);
 * missing input usage → unavailable (null, never 0); context-preservation status (NOT short-but-sufficient)
 * gates the confidence; failed/unevaluated preservation or task-solved → review_required.
 */
function exp(runs: InputCompactionAbRun[]): InputCompactionAbExperiment {
  let e = initInputCompactionAbExperiment({ experimentId: "exp-in-1", taskShape: "ctx-compaction", createdAt: "2026-06-30T00:00:00.000Z" });
  for (const r of runs) e = addInputCompactionAbRun(e, r);
  return e;
}

function control(inputTokens: number, outputTokens = 100): InputCompactionAbRun {
  return { arm: "control", inputTokens, outputTokens, providerReported: true, tokenSource: "provider-reported", semanticEval: "not_evaluated" };
}
function treatment(inputTokens: number, allPass = true, outputTokens = 100): InputCompactionAbRun {
  const o = allPass ? true : false;
  return {
    arm: "treatment",
    inputTokens,
    outputTokens,
    providerReported: true,
    tokenSource: "provider-reported",
    contextPreserved: o,
    taskSolved: o,
    sourceRecoverability: o,
    commitmentPreservation: o,
    noMaterialLoss: o,
    semanticEval: "not_evaluated"
  };
}

describe("summarizeInputCompactionAb - confirmed savings can never appear in the public CLI", () => {
  it("confirmedSavingsEligible is the literal false on every path", () => {
    for (const e of [exp([]), exp([control(5000), treatment(3000)]), exp([control(5000), control(5100), control(4900), treatment(3000), treatment(3100), treatment(2900)])]) {
      expect(summarizeInputCompactionAb(e).confirmedSavingsEligible).toBe(false);
    }
  });

  it("computes the INPUT delta from input tokens (output is observed-only/secondary)", () => {
    const e = exp([control(5000, 100), control(5100, 110), control(4900, 90), treatment(3000, true, 120), treatment(3100, true, 115), treatment(2900, true, 125)]);
    const s = summarizeInputCompactionAb(e);
    expect(s.inputTokensBefore).toBe(5000);
    expect(s.inputTokensAfter).toBe(3000);
    expect(s.inputTokenDelta).toBe(2000);
    expect(s.inputTokenReductionPct).toBeCloseTo(40, 5);
    // output delta is computed but secondary (control mean 100 - treatment mean 120 = -20)
    expect(s.outputTokenDelta).toBe(-20);
    expect(s.confidence).toBe("eligible_for_engine_confirmation");
    expect(s.contextPreservation).toBe("pass");
    expect(s.semanticEval).toBe("not_evaluated");
  });

  it("local-estimate / missing input on an arm → unavailable (null, never 0)", () => {
    const e = exp([
      { arm: "control", inputTokens: null, outputTokens: 100, providerReported: false, tokenSource: "unknown", semanticEval: "not_evaluated" },
      treatment(3000)
    ]);
    const s = summarizeInputCompactionAb(e);
    expect(s.confidence).toBe("unavailable");
    expect(s.inputTokensBefore).toBeNull();
  });

  it("context-preservation FAIL → review_required (even with provider-reported + N≥3)", () => {
    const e = exp([control(5000), control(5100), control(4900), treatment(3000, false), treatment(3100, true), treatment(2900, true)]);
    expect(summarizeInputCompactionAb(e).confidence).toBe("review_required");
  });

  it("task-solved not recorded (null) → review_required", () => {
    const t = { ...treatment(3000), taskSolved: null };
    const e = exp([control(5000), control(5100), control(4900), t, treatment(3100), treatment(2900)]);
    const s = summarizeInputCompactionAb(e);
    expect(s.contextPreservation).toBe("mixed");
    expect(s.confidence).toBe("review_required");
  });

  it("provider-reported + preservation pass but N<3 → observed_not_confirmed", () => {
    const e = exp([control(5000), treatment(3000)]);
    const s = summarizeInputCompactionAb(e);
    expect(s.confidence).toBe("observed_not_confirmed");
    expect(s.inputTokenDelta).toBe(2000);
  });
});

describe("providerReportedInputArms", () => {
  it("returns per-arm provider-reported INPUT arrays only when ALL runs are provider-reported", () => {
    const e = exp([control(5000), control(5100), control(4900), treatment(3000), treatment(3100), treatment(2900)]);
    const arms = providerReportedInputArms(e);
    expect(arms.bothProviderReported).toBe(true);
    expect(arms.controlInputTokens).toEqual([5000, 5100, 4900]);
    expect(arms.treatmentInputTokens).toEqual([3000, 3100, 2900]);
  });
  it("bothProviderReported false when an arm has a non-provider-reported run", () => {
    const e = exp([control(5000), { arm: "treatment", inputTokens: 3000, outputTokens: 100, providerReported: false, tokenSource: "local-estimate", semanticEval: "not_evaluated" }]);
    expect(providerReportedInputArms(e).bothProviderReported).toBe(false);
  });
});

describe("runFromSidecar", () => {
  const sidecar: CaptureUsageSidecar = {
    schema: "compaction.capture-usage.v1",
    tool: "codex",
    provider: "openai",
    model: "gpt-x",
    inputTokens: 4200,
    outputTokens: 180,
    providerReported: true,
    tokenSource: "provider-reported",
    tokenMetadataStatus: "present",
    generatedAt: "2026-06-30T00:00:00.000Z"
  };
  it("control run carries no preservation fields", () => {
    const r = runFromSidecar("control", sidecar);
    expect(r.inputTokens).toBe(4200);
    expect(r.contextPreserved).toBeUndefined();
  });
  it("treatment run records the preservation outcome (defaults to null when not provided)", () => {
    const r = runFromSidecar("treatment", sidecar, { contextPreserved: true, taskSolved: true });
    expect(r.contextPreserved).toBe(true);
    expect(r.taskSolved).toBe(true);
    expect(r.sourceRecoverability).toBeNull();
    expect(r.semanticEval).toBe("not_evaluated");
  });
  it("missing input token in sidecar stays null, not 0", () => {
    const r = runFromSidecar("control", { ...sidecar, inputTokens: null, providerReported: false, tokenSource: "unknown" });
    expect(r.inputTokens).toBeNull();
    expect(r.providerReported).toBe(false);
  });
});
