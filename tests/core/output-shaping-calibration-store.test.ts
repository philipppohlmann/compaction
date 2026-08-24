import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addOutputShapingAbRun,
  initOutputShapingAbExperiment,
  summarizeOutputShapingAb,
  type OutputShapingAbExperiment,
  type OutputShapingAbRun,
  type OutputShapingAbSummary
} from "../../src/core/output-shaping-ab.js";
import {
  DEFAULT_OUTPUT_SHAPING_RATE,
  calibratedRate,
  calibrationStorePath,
  emptyCalibration,
  foldAbSummary,
  loadCalibration,
  updateCalibrationFromAbSummary
} from "../../src/core/output-shaping-calibration-store.js";

function providerRun(arm: "control" | "treatment", outputTokens: number): OutputShapingAbRun {
  return {
    arm,
    outputTokens,
    inputTokens: 1000,
    providerReported: true,
    tokenSource: "provider-reported",
    ...(arm === "treatment"
      ? { policyFamily: "output_shaping" as const, policyNames: ["concise_response"], evalMarkersPreserved: true }
      : {})
  };
}

/** Build a provider-reported A/B summary with the given experiment id and per-arm output means. */
function summaryFor(id: string, control: number, treatment: number): OutputShapingAbSummary {
  let exp: OutputShapingAbExperiment = initOutputShapingAbExperiment({ experimentId: id, taskShape: "code" });
  exp = addOutputShapingAbRun(exp, providerRun("control", control));
  exp = addOutputShapingAbRun(exp, providerRun("treatment", treatment));
  return summarizeOutputShapingAb(exp);
}

describe("output-shaping calibration store - LEARNING (rate tightens as samples accumulate)", () => {
  it("empty store returns the SHIPPED DEFAULT PRIOR, not silence", () => {
    // Changed contract. An empty store used to be `calibrated: false`, which meant the per-turn line
    // degraded to a bare `output N` on EVERY fresh install -- the designed line was unreachable until
    // a user ran a manual A/B. The prior is a conservative floor from the two coding-task A/Bs in the
    // evidence matrix (47.5% Codex, 53.3% Claude), taken at the lower end and rounded down.
    const rate = calibratedRate(emptyCalibration());
    expect(rate.calibrated).toBe(true);
    expect(rate.rate).toBe(DEFAULT_OUTPUT_SHAPING_RATE);
    expect(rate.basis, "provenance is explicit, not inferred from the count").toBe("default-prior");
    expect(rate.sampleCount, "no experiment backs it, and it says so").toBe(0);
  });

  it("the prior sits at or below BOTH measurements it is drawn from", () => {
    // The guard against the number drifting upward over time: it is a floor, not a midpoint, and
    // certainly not the headline 88.6% from the verbose-prose family.
    expect(DEFAULT_OUTPUT_SHAPING_RATE).toBeLessThanOrEqual(0.475); // exp-cc-output-006, Codex coding
    expect(DEFAULT_OUTPUT_SHAPING_RATE).toBeLessThanOrEqual(0.533); // exp-cc-output-004, Claude coding
    expect(DEFAULT_OUTPUT_SHAPING_RATE).toBeGreaterThan(0);
  });

  it("ONE real A/B replaces the prior outright — never blended with it", () => {
    // The user's own traffic beats a general figure from ours. If this ever averaged the two, a device
    // that measured 10% would still be shown something closer to 47%.
    const cal = foldAbSummary(emptyCalibration(), summaryFor("e1", 1000, 900)); // a measured 10%
    const rate = calibratedRate(cal);
    expect(rate.basis).toBe("measured");
    expect(rate.rate).toBeCloseTo(0.1, 5);
    expect(rate.rate).not.toBeCloseTo(DEFAULT_OUTPUT_SHAPING_RATE, 2);
  });

  it("a device that MEASURED no benefit is not overwritten by the prior", () => {
    // The sharpest case. An unfavourable A/B leaves the derived rate outside (0,1), so the line falls
    // back to a bare count -- it must NOT fall back to our default, which would silently overrule the
    // device's own finding that shaping does not help here.
    const worse = foldAbSummary(emptyCalibration(), summaryFor("e1", 600, 1000));
    const rate = calibratedRate(worse);
    expect(rate.calibrated).toBe(false);
    expect(rate.rate).toBeUndefined();
  });

  it("one real A/B → calibrated rate = the measured reduction fraction; sampleCount = 1", () => {
    const cal = foldAbSummary(emptyCalibration(), summaryFor("e1", 1000, 600));
    const rate = calibratedRate(cal);
    expect(rate.calibrated).toBe(true);
    expect(rate.rate).toBeCloseTo(0.4, 5); // (1000-600)/1000
    expect(rate.sampleCount).toBe(1);
    expect(rate.totalTurns).toBe(2);
  });

  it("adding more A/B experiments UPDATES the rate (the learning claim) and grows the sample count", () => {
    // First experiment: 40% reduction (1000→600). Rate = 0.4.
    const cal1 = foldAbSummary(emptyCalibration(), summaryFor("e1", 1000, 600));
    expect(calibratedRate(cal1).rate).toBeCloseTo(0.4, 5);

    // Second experiment with a DIFFERENT reduction (1000→900 = 10%). The sample-weighted rate must MOVE
    // toward the combined evidence. Each experiment has one turn per arm, so w=2 for both:
    // totals control = 1000*2 + 1000*2 = 4000, treatment = 600*2 + 900*2 = 3000 → rate = 1000/4000 = 0.25.
    const cal2 = foldAbSummary(cal1, summaryFor("e2", 1000, 900));
    const rate2 = calibratedRate(cal2);
    expect(rate2.sampleCount).toBe(2);
    expect(rate2.rate).toBeCloseTo(0.25, 5);
    // It genuinely CHANGED from the 1-sample estimate — this is the learning behavior.
    expect(rate2.rate).not.toBeCloseTo(0.4, 3);
  });

  it("turn-weighting: an experiment with more turns pulls the estimate more", () => {
    // e1 is a single control/treatment pair (n=1 each): 1000→600.
    const cal1 = foldAbSummary(emptyCalibration(), summaryFor("e1", 1000, 600));
    // e2 has three control + three treatment runs (n=3 each) at 1000→900. Its mean outputs are 1000/900,
    // but its weight is its total turns (w=6 vs e1's w=2), so it dominates:
    // totals control = 1000*2 + 1000*6 = 8000, treatment = 600*2 + 900*6 = 6600 → rate = 1400/8000 = 0.175.
    // This case is BALANCED (3 vs 3), which is exactly why it passed under v1's broken weighting too.
    let e2: OutputShapingAbExperiment = initOutputShapingAbExperiment({ experimentId: "e2", taskShape: "code" });
    for (let i = 0; i < 3; i++) e2 = addOutputShapingAbRun(e2, providerRun("control", 1000));
    for (let i = 0; i < 3; i++) e2 = addOutputShapingAbRun(e2, providerRun("treatment", 900));
    const cal2 = foldAbSummary(cal1, summarizeOutputShapingAb(e2));
    expect(calibratedRate(cal2).rate).toBeCloseTo(0.175, 5);
  });

  it("re-adding the same experiment id is idempotent (no double-count)", () => {
    const first = foldAbSummary(emptyCalibration(), summaryFor("e1", 1000, 600));
    const again = foldAbSummary(first, summaryFor("e1", 1000, 600));
    expect(again).toBe(first); // unchanged reference: the fold was a no-op
    expect(calibratedRate(again).sampleCount).toBe(1);
  });

  it("an INCOMPLETE A/B (missing arm / no provider pair) never moves the rate", () => {
    // Only a control arm: no treatment turns, so there is no pair to compare and nothing to fold.
    const controlOnly = initOutputShapingAbExperiment({ experimentId: "e-partial", taskShape: "code" });
    const oneArm = foldAbSummary(emptyCalibration(), summarizeOutputShapingAb(addOutputShapingAbRun(controlOnly, providerRun("control", 1000))));
    expect(oneArm.sampleCount).toBe(0);
    // Still zero folds, so the device is still on the shipped prior -- an incomplete experiment must
    // not be able to masquerade as this device's own measurement.
    expect(calibratedRate(oneArm).basis).toBe("default-prior");
  });

  it("an UNFAVOURABLE A/B is folded in as evidence — it is not discarded (survivorship bias, v1)", () => {
    // v1 dropped every experiment where `before <= after`, so the running rate was a mean over WINS only
    // and could never be dragged down by a real result showing shaping did not help. It is real evidence.
    const worse = foldAbSummary(emptyCalibration(), summaryFor("e1", 600, 1000));
    expect(worse.sampleCount, "the experiment was recorded, not silently dropped").toBe(1);
    expect(worse.experimentIds).toEqual(["e1"]);
    // It is folded in, and the derived rate is correctly refused: the guard is downstream, in
    // `calibratedRate`, not an upstream filter that hides the evidence.
    expect(calibratedRate(worse).calibrated).toBe(false);
  });

  it("an unfavourable result DRAGS THE RATE DOWN instead of vanishing", () => {
    // A 40% win alone.
    const win = foldAbSummary(emptyCalibration(), summaryFor("e1", 1000, 600));
    expect(calibratedRate(win).rate).toBeCloseTo(0.4, 5);
    // Now a genuine null result (shaping changed nothing: 1000→1000). Under v1 this vanished and the rate
    // stayed 0.4 — overstating the saving. It must now pull the aggregate toward zero:
    // totals control = 1000*2 + 1000*2 = 4000, treatment = 600*2 + 1000*2 = 3200 → rate = 800/4000 = 0.2.
    const withNull = foldAbSummary(win, summaryFor("e2", 1000, 1000));
    expect(withNull.sampleCount).toBe(2);
    expect(calibratedRate(withNull).rate).toBeCloseTo(0.2, 5);
    expect(calibratedRate(withNull).rate).toBeLessThan(calibratedRate(win).rate as number);
  });

  it("UNBALANCED arms keep the measured sign: a 40% reduction can never fold in as an increase", () => {
    // The v1 defect: control was weighted by nControl and treatment by nTreatment, then the two sums were
    // divided. With 3 control turns and 6 treatment turns that yielded totals 3000/3600 — a 20% INCREASE
    // from an experiment that measured a 40% REDUCTION. Balanced arms cancelled the error, which is exactly
    // why every pre-existing test missed it.
    let exp: OutputShapingAbExperiment = initOutputShapingAbExperiment({ experimentId: "e-unbalanced", taskShape: "code" });
    for (let i = 0; i < 3; i++) exp = addOutputShapingAbRun(exp, providerRun("control", 1000));
    for (let i = 0; i < 6; i++) exp = addOutputShapingAbRun(exp, providerRun("treatment", 600));
    const cal = foldAbSummary(emptyCalibration(), summarizeOutputShapingAb(exp));
    const rate = calibratedRate(cal);
    expect(rate.calibrated).toBe(true);
    // The single experiment's own reduction fraction, unchanged by its arm sizes.
    expect(rate.rate).toBeCloseTo(0.4, 5);
    expect(rate.totalTurns).toBe(9);
  });

  it("the aggregate never exceeds the BEST measured per-experiment reduction (convexity)", () => {
    // The rate is a convex combination of the per-experiment fractions with non-negative weights, so it can
    // never claim more reduction than the best experiment actually measured. Fuzzed, because this is the
    // invariant that would catch a future weighting change silently inflating the estimate.
    let cal = emptyCalibration();
    let best = -Infinity;
    // Deterministic pseudo-random (no Math.random: reproducible failures).
    let seed = 12345;
    const next = (): number => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let i = 0; i < 300; i++) {
      const control = Math.floor(next() * 2000) + 50;
      const treatment = Math.floor(next() * 2000) + 1;
      cal = foldAbSummary(cal, summaryFor(`e${i}`, control, treatment));
      best = Math.max(best, (control - treatment) / control);
      const rate = calibratedRate(cal);
      if (rate.calibrated && rate.rate !== undefined) {
        expect(rate.rate).toBeLessThanOrEqual(best + 1e-12);
      }
    }
  });

  it("is CONTENT-FREE: the persisted store holds only counts/rates/ids, no prompt or response bytes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cal-content-"));
    const env = { COMPACTION_CONFIG_DIR: dir } as NodeJS.ProcessEnv;
    try {
      await updateCalibrationFromAbSummary(summaryFor("exp-alpha", 1000, 600), env);
      const raw = readFileSync(calibrationStorePath(env), "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      expect(Object.keys(parsed).sort()).toEqual(
        [
          "experimentIds",
          "sampleCount",
          "schema",
          "totalControlOutputTokens",
          "totalTreatmentOutputTokens",
          "totalTurns",
          "updatedAt"
        ].sort()
      );
      // Every value is a primitive number/string or an array of opaque id strings — never nested content.
      expect(parsed.experimentIds).toEqual(["exp-alpha"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("updateCalibrationFromAbSummary persists and accumulates across calls (round-trip learning)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cal-persist-"));
    const env = { COMPACTION_CONFIG_DIR: dir } as NodeJS.ProcessEnv;
    try {
      const first = await updateCalibrationFromAbSummary(summaryFor("e1", 1000, 600), env);
      expect(first.updated).toBe(true);
      expect(calibratedRate(first.calibration).rate).toBeCloseTo(0.4, 5);

      const second = await updateCalibrationFromAbSummary(summaryFor("e2", 1000, 900), env);
      expect(second.updated).toBe(true);
      expect(calibratedRate(second.calibration).rate).toBeCloseTo(0.25, 5);

      // Re-loading from disk reflects the accumulated state (persistence, not just in-memory).
      const reloaded = await loadCalibration(env);
      expect(reloaded.sampleCount).toBe(2);
      expect(calibratedRate(reloaded).rate).toBeCloseTo(0.25, 5);

      // A repeated fold of e1 is a no-op on disk too.
      const repeat = await updateCalibrationFromAbSummary(summaryFor("e1", 1000, 600), env);
      expect(repeat.updated).toBe(false);
      expect((await loadCalibration(env)).sampleCount).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
