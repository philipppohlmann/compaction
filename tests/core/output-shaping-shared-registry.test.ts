import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  calibrationStorePath,
  outputCalibrationQuery,
  updateCalibrationFromConfirmation,
  validateOutputShapingFamilyCalibration
} from "../../src/core/output-shaping-calibration-store.js";
import {
  activateSharedOutputCalibration,
  loadOutputCalibrationResolver
} from "../../src/core/output-shaping-savings.js";
import {
  SHARED_OUTPUT_CALIBRATION_CONFIRMATIONS,
  SHARED_OUTPUT_FAMILY_CALIBRATIONS
} from "../../src/core/output-shaping-shared-calibration-registry.js";
import { buildHookOutputShapingTreatment, buildOutputShapingPolicy } from "../../src/core/output-shaping.js";
import {
  TEST_OUTPUT_POLICY_VERSION,
  confirmedOutputCalibration
} from "../helpers/output-calibration-fixture.js";

const HISTORICAL_EXACT = {
  policyVersion: "output-shaping.v1.sha256.d326ef20760ad30142e0b4bc37fcb55a4a8fade7c9964f90158fdbafb49e0f83",
  provider: "openai",
  model: "gpt-5.6-sol",
  regime: "default-shapeable" as const
};

const CURRENT_EXACT = {
  ...HISTORICAL_EXACT,
  policyVersion: TEST_OUTPUT_POLICY_VERSION
};

const HOOK_EXACT = {
  ...HISTORICAL_EXACT,
  policyVersion: buildHookOutputShapingTreatment().policyVersion
};

describe("package-shipped shared output calibration registry", () => {
  it("ships only the genuine closed aggregate confirmation", () => {
    expect(SHARED_OUTPUT_CALIBRATION_CONFIRMATIONS).toHaveLength(1);
    expect(SHARED_OUTPUT_CALIBRATION_CONFIRMATIONS[0]).toMatchObject({
      confirmationId: "a1afd6e947d584507a1b0dd0a3f1f1ef825f2481b83ca7f55c3049baf05f2aa2",
      ...HISTORICAL_EXACT,
      nControl: 3,
      nTreatment: 3,
      totalControlOutputTokens: 288,
      totalTreatmentOutputTokens: 216,
      providerReported: true,
      controlFullContentSufficiency: "pass",
      treatmentFullContentSufficiency: "pass"
    });
    const serialized = JSON.stringify(SHARED_OUTPUT_CALIBRATION_CONFIRMATIONS);
    expect(serialized).not.toContain("0.47");
    expect(serialized).not.toMatch(/prompt|response|transcript|credential|\/Users\//i);
    expect(SHARED_OUTPUT_FAMILY_CALIBRATIONS).toHaveLength(1);
    expect(validateOutputShapingFamilyCalibration(SHARED_OUTPUT_FAMILY_CALIBRATIONS[0])).toEqual(
      SHARED_OUTPUT_FAMILY_CALIBRATIONS[0]
    );
    expect(validateOutputShapingFamilyCalibration({
      ...SHARED_OUTPUT_FAMILY_CALIBRATIONS[0],
      prompt: "must not survive the closed projection"
    })).toEqual(SHARED_OUTPUT_FAMILY_CALIBRATIONS[0]);
    expect(SHARED_OUTPUT_FAMILY_CALIBRATIONS[0]).toMatchObject({
      rate: 0.1833079692514799,
      validPairCount: 8,
      sourceEvidencePolicyVersion: buildHookOutputShapingTreatment().policyVersion,
      provenance: "hierarchical-family-calibration"
    });
    expect(JSON.stringify(SHARED_OUTPUT_FAMILY_CALIBRATIONS)).not.toMatch(
      /prompt|response|transcript|credential|\/Users\//i
    );
    expect(JSON.stringify(SHARED_OUTPUT_FAMILY_CALIBRATIONS)).not.toMatch(/run-specific|run-conditioned/i);
  });

  it("resolves exact evidence first and the compatible hook family on Run 1 without writing local state", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shared-output-calibration-"));
    const env = { COMPACTION_CONFIG_DIR: dir } as NodeJS.ProcessEnv;
    try {
      const cold = await loadOutputCalibrationResolver(env);
      expect(buildOutputShapingPolicy().policyVersion).toBe(
        "output-shaping.v1.sha256.d326ef20760ad30142e0b4bc37fcb55a4a8fade7c9964f90158fdbafb49e0f83"
      );
      expect(CURRENT_EXACT.policyVersion).toBe(HISTORICAL_EXACT.policyVersion);
      expect(cold(CURRENT_EXACT)).toMatchObject({
        availability: "measured",
        reductionPct: 25,
        basis: "measured",
        state: "calibrated"
      });
      expect(cold(HOOK_EXACT)).toMatchObject({
        availability: "family-calibrated",
        reductionPct: 18.33079692514799,
        basis: "family-calibrated",
        state: "calibrated",
        sampleCount: 8,
        sourceEvidencePolicyVersion: buildHookOutputShapingTreatment().policyVersion
      });
      expect(cold(HOOK_EXACT)).toEqual(cold(HOOK_EXACT));
      expect(existsSync(calibrationStorePath(env))).toBe(false);

      expect(await activateSharedOutputCalibration(HOOK_EXACT, env)).toEqual({ activated: 0 });
      expect(await activateSharedOutputCalibration({ ...HISTORICAL_EXACT, model: "gpt-5.6" }, env))
        .toEqual({ activated: 0 });
      expect(existsSync(calibrationStorePath(env))).toBe(false);

      expect(await activateSharedOutputCalibration(HISTORICAL_EXACT, env)).toEqual({ activated: 1 });
      const resolver = await loadOutputCalibrationResolver(env);
      expect(resolver(HISTORICAL_EXACT)).toMatchObject({
        availability: "measured",
        reductionPct: 25,
        basis: "measured",
        state: "calibrated"
      });
      expect(resolver(CURRENT_EXACT)).toMatchObject({ availability: "measured", reductionPct: 25 });
      expect(resolver(HOOK_EXACT)).toMatchObject({
        availability: "family-calibrated",
        reductionPct: 18.33079692514799,
        basis: "family-calibrated"
      });
      // A DIFFERENT PROVIDER/MODEL ON THE SAME TREATMENT FAMILY now resolves the family's cross-model
      // posterior instead of `unavailable`. That is the point: the shaping carrier applied to these runs
      // is byte-identical to the calibrated one, so requiring a per-model campaign before showing any
      // number left every newly supported model rendering `N/A` forever. The estimate must announce that
      // it was NOT measured on this model — `modelMatched: false` is what carries that to every surface,
      // and asserting it here is what stops a regression from silently claiming model-specific evidence.
      for (const crossModel of [
        { ...HISTORICAL_EXACT, provider: "anthropic" },
        { ...HISTORICAL_EXACT, model: "gpt-5.6" }
      ]) {
        const query = outputCalibrationQuery(crossModel);
        expect(query).toBeDefined();
        expect(resolver(query!)).toMatchObject({
          availability: "family-calibrated",
          basis: "family-calibrated",
          state: "calibrated",
          reductionPct: 18.33079692514799,
          sampleCount: 8,
          modelMatched: false
        });
      }
      // STILL NOTHING, and for two different reasons that both matter.
      //  - absent regime: the posterior is regime-scoped, so a run whose regime we cannot name is not a
      //    run we can place inside it.
      //  - an explicitly unknown model: refused one layer earlier, by `outputCalibrationQuery` itself, so
      //    no cross-model tier is ever consulted for it. The cross-model fallback widens which MODELS get
      //    an estimate; it must not widen that to models we cannot even identify.
      for (const refused of [
        { ...HISTORICAL_EXACT, regime: undefined },
        { ...HISTORICAL_EXACT, model: "codex-unknown-model" }
      ]) {
        const query = outputCalibrationQuery(refused);
        expect(query ? resolver(query).availability : "unavailable").toBe("unavailable");
      }
      const changedTreatment = buildOutputShapingPolicy({ verbosityBudgetTokens: 300 });
      const changedQuery = outputCalibrationQuery({
        policyVersion: changedTreatment.policyVersion,
        provider: "openai",
        model: "gpt-5.6-sol",
        regime: "default-shapeable"
      });
      expect(changedQuery ? resolver(changedQuery) : undefined).toMatchObject({
        availability: "unavailable",
        state: "unseeded"
      });
      expect(outputCalibrationQuery({
        ...HOOK_EXACT,
        treatmentFamilyVersion: changedTreatment.treatmentFamilyVersion
      })).toBeUndefined();
      expect(await activateSharedOutputCalibration(HISTORICAL_EXACT, env)).toEqual({ activated: 0 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects invalid shipped evidence without creating local state", async () => {
    const dir = mkdtempSync(join(tmpdir(), "invalid-shared-output-calibration-"));
    const env = { COMPACTION_CONFIG_DIR: dir } as NodeJS.ProcessEnv;
    const invalid = { ...confirmedOutputCalibration(CURRENT_EXACT), providerReported: false };
    try {
      expect(await activateSharedOutputCalibration(CURRENT_EXACT, env, [invalid])).toEqual({ activated: 0 });
      expect(existsSync(calibrationStorePath(env))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("pools later local evidence for the restored exact core treatment", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shared-plus-local-output-calibration-"));
    const env = { COMPACTION_CONFIG_DIR: dir } as NodeJS.ProcessEnv;
    const local = confirmedOutputCalibration({
      ...CURRENT_EXACT,
      control: [192, 192, 192],
      treatment: [96, 96, 96],
      confirmedAt: "2026-09-05T09:00:00.000Z"
    });
    try {
      await activateSharedOutputCalibration(HISTORICAL_EXACT, env);
      await updateCalibrationFromConfirmation(local, env);
      const resolver = await loadOutputCalibrationResolver(env);
      const pooled = resolver(CURRENT_EXACT);
      expect(pooled.availability).toBe("measured");
      if (pooled.availability === "measured") {
        expect(pooled.reductionPct).toBeCloseTo(((144 - 84) / 144) * 100);
        expect(pooled.sampleCount).toBe(2);
      }
      // POOLING IS EXACT-KEYED: a sibling model does not inherit this model's pooled exact rate. It now
      // resolves the family's cross-model posterior instead of nothing — but it must NOT resolve the
      // pooled exact figure above, which is what `basis`/`modelMatched` are asserted for here.
      const sibling = resolver({ ...CURRENT_EXACT, model: "gpt-5.6" });
      expect(sibling).toMatchObject({
        availability: "family-calibrated",
        basis: "family-calibrated",
        modelMatched: false
      });
      if (sibling.availability === "family-calibrated") {
        expect(sibling.reductionPct).toBe(18.33079692514799);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
