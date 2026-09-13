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
import {
  TEST_OUTPUT_POLICY_VERSION,
  confirmedOutputCalibration
} from "../helpers/output-calibration-fixture.js";

const EXACT = {
  policyVersion: TEST_OUTPUT_POLICY_VERSION,
  provider: "openai",
  model: "gpt-5.6-sol",
  regime: "default-shapeable" as const
};

describe("package-shipped shared output calibration registry", () => {
  it("ships only the genuine closed aggregate confirmation", () => {
    expect(SHARED_OUTPUT_CALIBRATION_CONFIRMATIONS).toHaveLength(1);
    expect(SHARED_OUTPUT_CALIBRATION_CONFIRMATIONS[0]).toMatchObject({
      confirmationId: "a1afd6e947d584507a1b0dd0a3f1f1ef825f2481b83ca7f55c3049baf05f2aa2",
      ...EXACT,
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

  it("keeps shipped evidence inert until an exact post-settlement activation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shared-output-calibration-"));
    const env = { COMPACTION_CONFIG_DIR: dir } as NodeJS.ProcessEnv;
    try {
      const cold = await loadOutputCalibrationResolver(env);
      expect(cold(EXACT)).toMatchObject({ availability: "unavailable", state: "unseeded" });
      expect(existsSync(calibrationStorePath(env))).toBe(false);

      expect(await activateSharedOutputCalibration({ ...EXACT, model: "gpt-5.6" }, env))
        .toEqual({ activated: 0 });
      expect(existsSync(calibrationStorePath(env))).toBe(false);

      expect(await activateSharedOutputCalibration(EXACT, env)).toEqual({ activated: 1 });
      const resolver = await loadOutputCalibrationResolver(env);
      expect(resolver(EXACT)).toMatchObject({
        availability: "measured",
        reductionPct: 25,
        basis: "measured",
        state: "calibrated"
      });
      for (const mismatch of [
        { ...EXACT, provider: "anthropic" },
        { ...EXACT, model: "gpt-5.6" },
        { ...EXACT, regime: undefined },
        { ...EXACT, model: "codex-unknown-model" }
      ]) {
        const query = outputCalibrationQuery(mismatch);
        expect(query ? resolver(query).availability : "unavailable").toBe("unavailable");
      }
      expect(await activateSharedOutputCalibration(EXACT, env)).toEqual({ activated: 0 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects invalid shipped evidence without creating local state", async () => {
    const dir = mkdtempSync(join(tmpdir(), "invalid-shared-output-calibration-"));
    const env = { COMPACTION_CONFIG_DIR: dir } as NodeJS.ProcessEnv;
    const invalid = { ...confirmedOutputCalibration(EXACT), providerReported: false };
    try {
      expect(await activateSharedOutputCalibration(EXACT, env, [invalid])).toEqual({ activated: 0 });
      expect(existsSync(calibrationStorePath(env))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("adds later local confirmed evidence without weakening exactness", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shared-plus-local-output-calibration-"));
    const env = { COMPACTION_CONFIG_DIR: dir } as NodeJS.ProcessEnv;
    const local = confirmedOutputCalibration({
      ...EXACT,
      control: [192, 192, 192],
      treatment: [96, 96, 96],
      confirmedAt: "2026-09-05T09:00:00.000Z"
    });
    try {
      await activateSharedOutputCalibration(EXACT, env);
      await updateCalibrationFromConfirmation(local, env);
      const resolver = await loadOutputCalibrationResolver(env);
      const pooled = resolver(EXACT);
      expect(pooled.availability).toBe("measured");
      if (pooled.availability === "measured") {
        expect(pooled.reductionPct).toBeCloseTo(((144 - 84) / 144) * 100);
        expect(pooled.sampleCount).toBe(2);
      }
      expect(resolver({ ...EXACT, model: "gpt-5.6" }).availability).toBe("unavailable");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
