import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  calibrationStorePath,
  outputCalibrationQuery,
  updateCalibrationFromConfirmation
} from "../../src/core/output-shaping-calibration-store.js";
import {
  activateSharedOutputCalibration,
  loadOutputCalibrationResolver
} from "../../src/core/output-shaping-savings.js";
import { SHARED_OUTPUT_CALIBRATION_CONFIRMATIONS } from "../../src/core/output-shaping-shared-calibration-registry.js";
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
  });

  it("restores the confirmed core treatment while leaving hook bytes unseeded", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shared-output-calibration-"));
    const env = { COMPACTION_CONFIG_DIR: dir } as NodeJS.ProcessEnv;
    try {
      const cold = await loadOutputCalibrationResolver(env);
      expect(buildOutputShapingPolicy().policyVersion).toBe(
        "output-shaping.v1.sha256.d326ef20760ad30142e0b4bc37fcb55a4a8fade7c9964f90158fdbafb49e0f83"
      );
      expect(CURRENT_EXACT.policyVersion).toBe(HISTORICAL_EXACT.policyVersion);
      expect(cold(CURRENT_EXACT)).toMatchObject({ availability: "unavailable", state: "unseeded" });
      expect(cold(HOOK_EXACT)).toMatchObject({ availability: "unavailable", state: "unseeded" });
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
      expect(resolver(HOOK_EXACT)).toMatchObject({ availability: "unavailable", state: "unseeded" });
      for (const mismatch of [
        { ...HISTORICAL_EXACT, provider: "anthropic" },
        { ...HISTORICAL_EXACT, model: "gpt-5.6" },
        { ...HISTORICAL_EXACT, regime: undefined },
        { ...HISTORICAL_EXACT, model: "codex-unknown-model" }
      ]) {
        const query = outputCalibrationQuery(mismatch);
        expect(query ? resolver(query).availability : "unavailable").toBe("unavailable");
      }
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
      expect(resolver({ ...CURRENT_EXACT, model: "gpt-5.6" }).availability).toBe("unavailable");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
