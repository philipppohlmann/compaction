/**
 * CLI e2e: `compaction savings` remains an observed A/B VIEW, never a calibration producer.
 *
 * Public experiment artifacts can contain a legacy marker or hand-authored directives, but they cannot
 * prove the private control-first full-content evaluation gate passed. The command may display their
 * observed provider-reported measurements; it must never auto-fold them into shared calibration.
 */
import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  addOutputShapingAbRun,
  initOutputShapingAbExperiment,
  type OutputShapingAbExperiment,
  type OutputShapingAbRun
} from "../../src/core/output-shaping-ab.js";
import { calibrationStorePath } from "../../src/core/output-shaping-calibration-store.js";

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

function calibrationExists(configDir: string): boolean {
  return existsSync(calibrationStorePath({ COMPACTION_CONFIG_DIR: configDir } as NodeJS.ProcessEnv));
}

describe("compaction savings — observed public A/B artifacts never enter shared calibration", () => {
  it("reports an UNFAVOURABLE A/B without creating a calibration store", async () => {
    const dir = mkdtempSync(join(tmpdir(), "savings-learn-bad-"));
    try {
      // Shaping made output WORSE (1000 → 1200). A real, clean, provider-reported measurement.
      const file = experimentFile(dir, "e-worse", 1000, 1200);
      const { stdout } = await runCli(["savings", "--experiment", file], dir);

      expect(calibrationExists(dir)).toBe(false);
      expect(stdout).toContain("unavailable-until-measured");
      expect(stdout).not.toMatch(/−\d+(\.\d+)?%/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a second public A/B cannot mutate or create calibration either", async () => {
    const dir = mkdtempSync(join(tmpdir(), "savings-learn-drag-"));
    try {
      // A 40% win first.
      await runCli(["savings", "--experiment", experimentFile(dir, "e-win", 1000, 600)], dir);
      expect(calibrationExists(dir)).toBe(false);

      // Then a null result. Under the pre-fix code this never reached the store and the rate stayed 0.4.
      await runCli(["savings", "--experiment", experimentFile(dir, "e-null", 1000, 1000)], dir);
      expect(calibrationExists(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a favourable A/B remains visible as an observed measurement without calibrating", async () => {
    const dir = mkdtempSync(join(tmpdir(), "savings-learn-good-"));
    try {
      const { stdout } = await runCli(["savings", "--experiment", experimentFile(dir, "e-good", 1000, 600)], dir);
      expect(calibrationExists(dir)).toBe(false);
      expect(stdout).toContain("Measured per-turn output-token reduction");
      expect(stdout).toContain("1,000 → 600");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
