/**
 * CLI e2e: `compaction savings` must LEARN from an unfavourable A/B, not discard it.
 *
 * This exists because of a defect that a unit test could not catch.
 * `foldAbSummary` was fixed to accept non-favourable measurements, and unit tests proved it did — but the
 * only production caller returned BEFORE the fold whenever `measuredPerTurnReduction` reported
 * `unavailable`, and one of its `unavailable` reasons is "delta <= 0". So the survivorship filter simply
 * moved up one layer and the calibrated rate a real user's receipt line depends on stayed a mean over wins.
 *
 * The lesson generalises: a fold gate and a display gate look independent and are not. These tests drive
 * the REAL command end-to-end so the two cannot silently diverge again.
 *
 * Every experiment here is built through the real `output-shaping-ab` API rather than hand-written JSON —
 * a hand-rolled fixture with a wrong field shape passes vacuously against any implementation.
 */
import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  addOutputShapingAbRun,
  initOutputShapingAbExperiment,
  type OutputShapingAbExperiment,
  type OutputShapingAbRun
} from "../../src/core/output-shaping-ab.js";
import {
  calibratedRate,
  calibrationStorePath,
  type OutputShapingCalibration
} from "../../src/core/output-shaping-calibration-store.js";

const CLI = resolve("dist/cli/index.js");

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

/** A clean, provider-reported experiment with 3 runs per arm (enough to clear the per-arm N floor). */
function experimentFile(dir: string, id: string, control: number, treatment: number): string {
  let exp: OutputShapingAbExperiment = initOutputShapingAbExperiment({ experimentId: id, taskShape: "code" });
  for (let i = 0; i < 3; i++) exp = addOutputShapingAbRun(exp, providerRun("control", control));
  for (let i = 0; i < 3; i++) exp = addOutputShapingAbRun(exp, providerRun("treatment", treatment));
  const file = join(dir, `${id}.json`);
  writeFileSync(file, JSON.stringify(exp), "utf8");
  return file;
}

/** Run the REAL built CLI with an isolated config dir. Async spawn: spawnSync deadlocks this harness. */
function runCli(args: string[], configDir: string): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, COMPACTION_CONFIG_DIR: configDir },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stdout += d.toString()));
    child.on("close", (code) => resolvePromise({ stdout, code }));
  });
}

function readCalibration(configDir: string): OutputShapingCalibration | undefined {
  const path = calibrationStorePath({ COMPACTION_CONFIG_DIR: configDir } as NodeJS.ProcessEnv);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as OutputShapingCalibration;
}

describe("compaction savings — the calibration learning loop folds ALL clean measurements", () => {
  it("folds an UNFAVOURABLE A/B into the store, and still reports no rate", async () => {
    const dir = mkdtempSync(join(tmpdir(), "savings-learn-bad-"));
    try {
      // Shaping made output WORSE (1000 → 1200). A real, clean, provider-reported measurement.
      const file = experimentFile(dir, "e-worse", 1000, 1200);
      const { stdout } = await runCli(["savings", "--experiment", file], dir);

      // It reached the store — this is the assertion the pre-fix code failed.
      const cal = readCalibration(dir);
      expect(cal, "an unfavourable A/B must still be recorded, not silently dropped").toBeDefined();
      expect(cal?.sampleCount).toBe(1);
      expect(cal?.experimentIds).toEqual(["e-worse"]);

      // And the derived rate is still refused — the guard is downstream, not an upstream filter.
      expect(calibratedRate(cal as OutputShapingCalibration).calibrated).toBe(false);

      // The display gate is unchanged: no saving is reported, because there is none.
      expect(stdout).toContain("unavailable-until-measured");
      expect(stdout).not.toMatch(/−\d+(\.\d+)?%/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an unfavourable A/B DRAGS DOWN a rate an earlier favourable one established", async () => {
    const dir = mkdtempSync(join(tmpdir(), "savings-learn-drag-"));
    try {
      // A 40% win first.
      await runCli(["savings", "--experiment", experimentFile(dir, "e-win", 1000, 600)], dir);
      const afterWin = readCalibration(dir);
      const rateAfterWin = calibratedRate(afterWin as OutputShapingCalibration);
      expect(rateAfterWin.calibrated).toBe(true);
      expect(rateAfterWin.rate).toBeCloseTo(0.4, 5);

      // Then a null result. Under the pre-fix code this never reached the store and the rate stayed 0.4.
      await runCli(["savings", "--experiment", experimentFile(dir, "e-null", 1000, 1000)], dir);
      const afterNull = readCalibration(dir);
      const rateAfterNull = calibratedRate(afterNull as OutputShapingCalibration);

      expect(afterNull?.sampleCount).toBe(2);
      expect(rateAfterNull.calibrated).toBe(true);
      expect(rateAfterNull.rate as number).toBeLessThan(rateAfterWin.rate as number);
      // totals control = 1000*6 + 1000*6 = 12000, treatment = 600*6 + 1000*6 = 9600 → 2400/12000 = 0.2
      expect(rateAfterNull.rate).toBeCloseTo(0.2, 5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a favourable A/B still calibrates and is still reported (no regression)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "savings-learn-good-"));
    try {
      const { stdout } = await runCli(["savings", "--experiment", experimentFile(dir, "e-good", 1000, 600)], dir);
      const cal = readCalibration(dir);
      expect(cal?.sampleCount).toBe(1);
      expect(calibratedRate(cal as OutputShapingCalibration).rate).toBeCloseTo(0.4, 5);
      expect(stdout).toContain("Calibration updated");
      expect(stdout).toContain("Measured per-turn output-token reduction");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
