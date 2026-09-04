import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addOutputShapingAbRun,
  initOutputShapingAbExperiment,
  summarizeOutputShapingAb,
  type OutputShapingAbExperiment,
  type OutputShapingAbRun
} from "../../src/core/output-shaping-ab.js";
import {
  ROUTE_A_INFERENCE_LABEL,
  measuredPerTurnReduction,
  planLifetimeProjection,
  estimatePerTurnOutputSaved,
  loadCalibrationReduction,
  type PerTurnReduction
} from "../../src/core/output-shaping-savings.js";
import {
  DEFAULT_OUTPUT_SHAPING_RATE,
  calibrationStorePath,
} from "../../src/core/output-shaping-calibration-store.js";
import {
  TEST_OUTPUT_POLICY_VERSION,
  seedOutputCalibration
} from "../helpers/output-calibration-fixture.js";

const QUERY = {
  policyVersion: TEST_OUTPUT_POLICY_VERSION,
  provider: "anthropic",
  model: "claude-opus-5"
} as const;

function providerRun(arm: "control" | "treatment", outputTokens: number, evalPass = true): OutputShapingAbRun {
  return {
    arm,
    outputTokens,
    inputTokens: 1000,
    providerReported: true,
    tokenSource: "provider-reported",
    ...(arm === "treatment"
      ? { policyFamily: "output_shaping" as const, policyNames: ["concise_response"], evalMarkersPreserved: evalPass }
      : {})
  };
}

function experimentWith(runs: OutputShapingAbRun[]): OutputShapingAbExperiment {
  let exp = initOutputShapingAbExperiment({ experimentId: "e1", taskShape: "code" });
  for (const r of runs) exp = addOutputShapingAbRun(exp, r);
  return exp;
}

describe("measuredPerTurnReduction - only from a real provider-reported sample", () => {
  it("is unavailable when there is no sample (never a fabricated %)", () => {
    const summary = summarizeOutputShapingAb(experimentWith([]));
    const r = measuredPerTurnReduction(summary);
    expect(r.availability).toBe("unavailable");
  });

  it("is unavailable when only ONE arm has data (both arms required)", () => {
    const summary = summarizeOutputShapingAb(experimentWith([providerRun("control", 1000)]));
    expect(measuredPerTurnReduction(summary).availability).toBe("unavailable");
  });

  it("reports the OBSERVED reduction with denominators when both arms are provider-reported + sufficiency passed", () => {
    const summary = summarizeOutputShapingAb(
      experimentWith([
        providerRun("control", 1000),
        providerRun("control", 1200),
        providerRun("treatment", 500),
        providerRun("treatment", 700)
      ])
    );
    const r = measuredPerTurnReduction(summary);
    expect(r.availability).toBe("measured");
    if (r.availability !== "measured") return;
    expect(r.meanControlOutputTokens).toBe(1100);
    expect(r.meanTreatmentOutputTokens).toBe(600);
    expect(r.meanOutputTokenReduction).toBe(500);
    expect(r.reductionPct).toBeCloseTo((500 / 1100) * 100, 5);
    expect(r.nControl).toBe(2);
    expect(r.nTreatment).toBe(2);
  });

  it("is unavailable when a treatment run failed sufficiency (review_required - a lossy output is not a saving)", () => {
    const summary = summarizeOutputShapingAb(
      experimentWith([providerRun("control", 1000), providerRun("treatment", 500, false)])
    );
    expect(measuredPerTurnReduction(summary).availability).toBe("unavailable");
  });

  it("is unavailable when shaping did NOT reduce output (delta <= 0)", () => {
    const summary = summarizeOutputShapingAb(
      experimentWith([providerRun("control", 500), providerRun("treatment", 700)])
    );
    const r = measuredPerTurnReduction(summary);
    expect(r.availability).toBe("unavailable");
  });
});

describe("planLifetimeProjection - Route A inference, never invented", () => {
  const measured = measuredPerTurnReduction(
    summarizeOutputShapingAb(
      experimentWith([
        providerRun("control", 1000),
        providerRun("treatment", 600)
      ])
    )
  );

  it("is unavailable without a user-supplied plan budget (never guesses a budget)", () => {
    expect(planLifetimeProjection(measured, undefined).availability).toBe("unavailable");
  });

  it("is unavailable for a non-positive budget", () => {
    expect(planLifetimeProjection(measured, 0).availability).toBe("unavailable");
    expect(planLifetimeProjection(measured, -5).availability).toBe("unavailable");
  });

  it("projects extended tokens/turns and carries the Route-A INFERENCE label", () => {
    const p = planLifetimeProjection(measured, 60000);
    expect(p.availability).toBe("measured");
    if (p.availability !== "measured") return;
    expect(p.planOutputBudgetTokens).toBe(60000);
    // shapedTurns = 60000 / 600 = 100; extendedByTokens = 400 * 100 = 40000.
    expect(p.extendedByTokens).toBe(40000);
    // extendedByTurns is the extension vs the UNSHAPED baseline: budget/treatment − budget/control =
    // 60000/600 − 60000/1000 = 100 − 60 = 40 (equivalently 40000 / control mean 1000). It must NOT be
    // 40000/600 = 67, which double-counts the benefit against the already-shaped rate and overstates it.
    expect(p.extendedByTurns).toBe(40);
    expect(p.label).toBe(ROUTE_A_INFERENCE_LABEL);
    expect(p.label).toMatch(/inference/i);
    expect(p.label).toMatch(/NOT billing-confirmed/i);
  });

  it("is unavailable when there is no measured reduction to project from", () => {
    const unavailable = measuredPerTurnReduction(summarizeOutputShapingAb(experimentWith([])));
    expect(planLifetimeProjection(unavailable, 60000).availability).toBe("unavailable");
  });
});

describe("estimatePerTurnOutputSaved - labeled local estimate for the per-turn line (never a %)", () => {
  const measured: PerTurnReduction = measuredPerTurnReduction(
    summarizeOutputShapingAb(
      experimentWith([providerRun("control", 1000), providerRun("treatment", 600)])
    )
  );
  // reductionPct = (400/1000)*100 = 40 → r = 0.4.

  it("calibrated: saved = round(A · r/(1−r)) from the measured rate × this turn's output", () => {
    const est = estimatePerTurnOutputSaved(measured, 600);
    expect(est.calibrated).toBe(true);
    // 600 * 0.4 / 0.6 = 400.
    expect(est.tokensSaved).toBe(400);
  });

  it("uncalibrated when there is NO measured reduction (no A/B sample) - never a fabricated number", () => {
    const unavailable = measuredPerTurnReduction(summarizeOutputShapingAb(experimentWith([])));
    const est = estimatePerTurnOutputSaved(unavailable, 600);
    expect(est.calibrated).toBe(false);
    expect(est.tokensSaved).toBeUndefined();
  });

  it("uncalibrated when this turn has no positive output count", () => {
    expect(estimatePerTurnOutputSaved(measured, undefined).calibrated).toBe(false);
    expect(estimatePerTurnOutputSaved(measured, 0).calibrated).toBe(false);
    expect(estimatePerTurnOutputSaved(measured, -10).calibrated).toBe(false);
  });

  it("never returns a percentage - only an absolute token count or nothing", () => {
    const est = estimatePerTurnOutputSaved(measured, 1234);
    expect(typeof est.tokensSaved === "number" || est.tokensSaved === undefined).toBe(true);
    // The estimate is an absolute count; there is no pct field on the result at all.
    expect((est as Record<string, unknown>).reductionPct).toBeUndefined();
    expect((est as Record<string, unknown>).pct).toBeUndefined();
  });
});

describe("loadCalibrationReduction - fail-open read from the LEARNING calibration store", () => {
  it("a MISSING store is UNAVAILABLE - the shipped prior is not this device's measurement", async () => {
    // A device with no folded experiment has measured nothing, and `measured` is the strongest evidence
    // label this type carries. It used to return the shipped prior under that label with zeroed
    // denominators, which put a 47% rate one hop away from a rendered `777→412 (−47%)` on turn one of a
    // fresh install. The reason string is the honest replacement, and it names the prior rather than
    // pretending no rate exists anywhere.
    const dir = mkdtempSync(join(tmpdir(), "cal-missing-"));
    try {
      const r = await loadCalibrationReduction({ COMPACTION_CONFIG_DIR: dir } as NodeJS.ProcessEnv);
      expect(r.availability).toBe("unavailable");
      if (r.availability !== "unavailable") return;
      expect(r.reason).toMatch(/applicability metadata/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a MISSING store yields NO per-turn saving to render (fail-open, no fabricated arrow)", async () => {
    // The property the reason string above only describes: nothing downstream can draw an arrow.
    // Split from the reason assertion deliberately - a string pin failing first would leave this
    // silently unexercised.
    const dir = mkdtempSync(join(tmpdir(), "cal-missing-est-"));
    try {
      const r = await loadCalibrationReduction({ COMPACTION_CONFIG_DIR: dir } as NodeJS.ProcessEnv);
      const est = estimatePerTurnOutputSaved(r, 512);
      expect(est.calibrated).toBe(false);
      expect(est.tokensSaved).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a MALFORMED store is unavailable too (fail-open, never throws)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cal-bad-"));
    try {
      writeFileSync(calibrationStorePath({ COMPACTION_CONFIG_DIR: dir } as NodeJS.ProcessEnv), "{not json");
      const r = await loadCalibrationReduction({ COMPACTION_CONFIG_DIR: dir } as NodeJS.ProcessEnv);
      expect(r.availability, "a corrupt file is not a measurement").toBe("unavailable");
      expect(estimatePerTurnOutputSaved(r, 512).calibrated).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the generic prior internal and outside exact calibration resolution", async () => {
    expect(DEFAULT_OUTPUT_SHAPING_RATE).toBe(0.47);
    const dir = mkdtempSync(join(tmpdir(), "cal-prior-kept-"));
    try {
      const r = await loadCalibrationReduction({ COMPACTION_CONFIG_DIR: dir } as NodeJS.ProcessEnv, QUERY);
      expect(r.availability).toBe("unavailable");
      expect(estimatePerTurnOutputSaved(r, 512).tokensSaved).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("threads BASIS: a folded A/B carries `measured`, and the prior never reaches the line at all", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cal-basis-"));
    const env = { COMPACTION_CONFIG_DIR: dir } as NodeJS.ProcessEnv;
    try {
      // Fresh install: no measurement, so no reduction and nothing to label.
      const prior = await loadCalibrationReduction(env, QUERY);
      expect(prior.availability).toBe("unavailable");
      expect(estimatePerTurnOutputSaved(prior, 512).calibrated).toBe(false);

      // Fold a real device A/B: the device now HAS a measurement, and the basis says so (→ `est.`).
      await seedOutputCalibration(env);
      const measured = await loadCalibrationReduction(env, QUERY);
      expect(measured.availability).toBe("measured");
      if (measured.availability !== "measured") return;
      expect(measured.basis).toBe("measured");
      expect(estimatePerTurnOutputSaved(measured, 512).basis).toBe("measured");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a DEFAULT-PRIOR reduction handed in directly still yields no saving", async () => {
    // Defence in depth for callers that build a reduction themselves rather than reading the store.
    // The shipped constant must be unreachable as a per-turn figure through EVERY path, not only the
    // one that was traced.
    const handMade = {
      availability: "measured",
      meanControlOutputTokens: 1000,
      meanTreatmentOutputTokens: 530,
      meanOutputTokenReduction: 470,
      reductionPct: DEFAULT_OUTPUT_SHAPING_RATE * 100,
      nControl: 0,
      nTreatment: 0,
      confidence: "unavailable",
      sampleCount: 0,
      basis: "default-prior"
    } as const;
    const est = estimatePerTurnOutputSaved(handMade, 512);
    expect(est.calibrated).toBe(false);
    expect(est.tokensSaved).toBeUndefined();
  });

  it("measured once a real provider-reported A/B has been folded into the store", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cal-ok-"));
    const env = { COMPACTION_CONFIG_DIR: dir } as NodeJS.ProcessEnv;
    try {
      // Before any A/B is folded in: nothing measured, nothing to report.
      const before = await loadCalibrationReduction(env, QUERY);
      expect(before.availability).toBe("unavailable");
      // Fold a real A/B (control 1000 → treatment 600 = 40% reduction) into the store.
      await seedOutputCalibration(env);
      const r = await loadCalibrationReduction(env, QUERY);
      expect(r.availability).toBe("measured");
      if (r.availability !== "measured") return;
      // The device's OWN measurement, which replaces the prior entirely.
      expect(r.reductionPct).toBeCloseTo(40, 5);
      expect(r.reductionPct).not.toBeCloseTo(DEFAULT_OUTPUT_SHAPING_RATE * 100, 1);
      expect(r.sampleCount).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
