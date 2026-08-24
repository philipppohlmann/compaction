import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  emptyNetBilledCalibration,
  foldNetBilledDelta,
  netBilledCalibrationStorePath
} from "../../src/core/gateway/net-billed-calibration-store.js";
import type { GatewayProofDelta } from "../../src/core/gateway/proof.js";

/**
 * CLI e2e for the `compaction savings` NET-BILLED section. Seeds a content-free net-billed calibration store
 * (as the key-gated operator A/B path would) under a temp COMPACTION_CONFIG_DIR, then runs the REAL command
 * and asserts the honest surfacing: measured provider-reported net-of-cache figure (NOT billing-confirmed),
 * honest negative/zero rendering, and unavailable-until-measured when no A/B exists — never a fabricated %.
 */
const CLI = resolve("dist/cli/index.js");

function delta(before: number, after: number): GatewayProofDelta {
  return {
    available: true,
    baselineFound: true,
    compactedFound: true,
    beforeFreshInputTokens: before,
    afterFreshInputTokens: after,
    freshInputReductionAbsolute: before - after,
    reasons: []
  };
}

function seedStore(dir: string, ...ds: Array<{ id: string; before: number; after: number }>): void {
  mkdirSync(dir, { recursive: true });
  let cal = emptyNetBilledCalibration(() => "1970-01-01T00:00:00.000Z");
  for (const d of ds) cal = foldNetBilledDelta(cal, { proofRunId: d.id, delta: delta(d.before, d.after) }, () => "1970-01-01T00:00:00.000Z");
  writeFileSync(netBilledCalibrationStorePath({ COMPACTION_CONFIG_DIR: dir }), `${JSON.stringify(cal, null, 2)}\n`, "utf8");
}

function runSavings(dir: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("node", [CLI, "savings"], {
      env: { ...process.env, COMPACTION_CONFIG_DIR: dir },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("exit", (code) => resolvePromise({ code: code ?? 0, stdout, stderr }));
    setTimeout(() => reject(new Error(`savings CLI did not exit in time. stdout=${stdout}`)), 20000);
  });
}

describe("compaction savings — net-billed section (CLI e2e)", () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "savings-net-billed-"))));
  afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

  it("no A/B recorded → net-billed is unavailable-until-measured (never a fabricated %)", async () => {
    const res = await runSavings(dir);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("Net-billed input reduction");
    expect(res.stdout).toContain("unavailable-until-measured");
    expect(res.stdout).toContain("verify-cache --provider anthropic");
    // No fabricated reduction percentage anywhere in the net-billed line.
    expect(res.stdout).not.toMatch(/net-billed[^]*?−\d+(\.\d+)?%/i);
  });

  it("a positive A/B → provider-reported net-of-cache reduction, explicitly NOT billing-confirmed", async () => {
    seedStore(dir, { id: "p1", before: 1000, after: 400 });
    const res = await runSavings(dir);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("−60%");
    expect(res.stdout).toContain("1,000 → 400 fresh-billed input tokens");
    expect(res.stdout).toContain("1 A/B proof run");
    expect(res.stdout).toContain("NOT billing-confirmed");
    // Never claims a billing/invoice-confirmed figure.
    expect(res.stdout.toLowerCase()).not.toContain("invoice-confirmed");
    expect(res.stdout).not.toContain("billing-confirmed savings");
  });

  it("a cache-busting A/B → surfaces the NEGATIVE net-billed outcome honestly (never floored to a positive)", async () => {
    seedStore(dir, { id: "p1", before: 300, after: 800 });
    const res = await runSavings(dir);
    expect(res.code).toBe(0);
    // Apply RAISED net-billed input: a "+PP% MORE" honest outcome, not a fabricated reduction.
    expect(res.stdout).toContain("MORE");
    expect(res.stdout).toContain("busted the provider cache");
    expect(res.stdout).not.toContain("−166"); // never a fake positive reduction from a negative delta
  });

  it("a zero A/B → apply did NOT change net-billed input (honest 0%)", async () => {
    seedStore(dir, { id: "p1", before: 500, after: 500 });
    const res = await runSavings(dir);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("did NOT change net-billed input");
  });
});
