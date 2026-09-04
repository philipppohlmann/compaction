import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  outputCalibrationQuery,
  updateCalibrationFromConfirmation
} from "../../src/core/output-shaping-calibration-store.js";
import {
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
  model: "gpt-5.6-codex",
  regime: "default-shapeable" as const
};

describe("package-shipped shared output calibration registry", () => {
  it("ships empty until genuine evidence is registered", () => {
    expect(SHARED_OUTPUT_CALIBRATION_CONFIRMATIONS).toEqual([]);
    expect(JSON.stringify(SHARED_OUTPUT_CALIBRATION_CONFIRMATIONS)).not.toContain("0.47");
  });

  it("resolves injected shipped evidence on a fresh config and keeps all keys exact", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shared-output-calibration-"));
    const env = { COMPACTION_CONFIG_DIR: dir } as NodeJS.ProcessEnv;
    const shared = confirmedOutputCalibration({
      provider: EXACT.provider,
      model: EXACT.model,
      regime: EXACT.regime
    });
    try {
      const resolver = await loadOutputCalibrationResolver(env, [shared]);
      expect(resolver(EXACT)).toMatchObject({
        availability: "measured",
        reductionPct: 40,
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
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("adds local confirmed evidence to a shipped exact cohort without weakening exactness", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shared-plus-local-output-calibration-"));
    const env = { COMPACTION_CONFIG_DIR: dir } as NodeJS.ProcessEnv;
    const shared = confirmedOutputCalibration({
      provider: EXACT.provider,
      model: EXACT.model,
      regime: EXACT.regime
    });
    const local = confirmedOutputCalibration({
      provider: EXACT.provider,
      model: EXACT.model,
      regime: EXACT.regime,
      control: [2000, 2000, 2000],
      treatment: [1000, 1000, 1000],
      confirmedAt: "2026-09-04T00:00:00.000Z"
    });
    try {
      await updateCalibrationFromConfirmation(local, env);
      const resolver = await loadOutputCalibrationResolver(env, [shared]);
      const pooled = resolver(EXACT);
      expect(pooled.availability).toBe("measured");
      if (pooled.availability === "measured") {
        // Equal experiment weights: pooled control=1500, treatment=800. Percentages are never averaged.
        expect(pooled.reductionPct).toBeCloseTo(((1500 - 800) / 1500) * 100);
        expect(pooled.sampleCount).toBe(2);
      }
      expect(resolver({ ...EXACT, model: "gpt-5.6" }).availability).toBe("unavailable");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
