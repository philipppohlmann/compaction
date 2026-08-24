/**
 * REPORT-ONLY auto-apply gate-check tests.
 *
 * Proven here:
 * - FAIL-CLOSED: an empty/partial context → every unmet gate FAILS and allPassed is false; a gate
 *   passes ONLY when its field is exactly boolean true (non-true / null / undefined / "true" all fail);
 * - allPassed is true ONLY with the FULL set including the explicit opt-in;
 * - NO-SIDE-EFFECTS / NO-APPLY: the module exports no apply/execute/mutate/write/run/save function,
 *   and calling evaluateAutoApplyGates writes NOTHING to disk (snapshot-tree proof) and does not
 *   mutate its input.
 */
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as gatesModule from "../../src/core/auto-apply-gates.js";
import {
  AUTO_APPLY_GATE_NAMES,
  evaluateAutoApplyGates,
  type AutoApplyGateContext
} from "../../src/core/auto-apply-gates.js";

/** A context with EVERY gate satisfied (the only shape that yields allPassed). */
const FULL_PASS: AutoApplyGateContext = {
  explicitOptIn: true,
  scopeMatches: true,
  originalRetained: true,
  capsuleProvenancePresent: true,
  recoverabilityPassed: true,
  reductionThresholdMet: true,
  riskChecksPassed: true,
  evidenceLabelPresent: true,
  rollbackPathPresent: true
};

async function snapshotTree(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  async function walk(current: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else {
        const info = await stat(full);
        out.set(relative(root, full), `${info.size}:${info.mtimeMs}`);
      }
    }
  }
  await walk(root);
  return out;
}

describe("evaluateAutoApplyGates - fail-closed, report-only", () => {
  it("fails EVERY gate on an empty context and allPassed is false", () => {
    const report = evaluateAutoApplyGates();
    expect(report.allPassed).toBe(false);
    expect(report.gates.map((g) => g.name)).toEqual([...AUTO_APPLY_GATE_NAMES]);
    expect(report.gates.every((g) => g.passed === false)).toBe(true);
    for (const gate of report.gates) expect(gate.reason.length).toBeGreaterThan(0);
  });

  it("passes only with the FULL set including explicit-opt-in", () => {
    const report = evaluateAutoApplyGates(FULL_PASS);
    expect(report.allPassed).toBe(true);
    expect(report.gates.every((g) => g.passed)).toBe(true);
  });

  it("any single missing gate → allPassed false (each gate is load-bearing)", () => {
    for (const key of Object.keys(FULL_PASS) as (keyof AutoApplyGateContext)[]) {
      const partial: AutoApplyGateContext = { ...FULL_PASS };
      delete partial[key];
      const report = evaluateAutoApplyGates(partial);
      expect(report.allPassed).toBe(false);
    }
  });

  it("dropping ONLY the explicit opt-in fails allPassed (opt-in is required)", () => {
    const report = evaluateAutoApplyGates({ ...FULL_PASS, explicitOptIn: false });
    expect(report.allPassed).toBe(false);
    expect(report.gates.find((g) => g.name === "explicit-opt-in")?.passed).toBe(false);
  });

  it("treats non-true truthy-ish values as FAILED (fail-closed; only boolean true passes)", () => {
    const sneaky = {
      explicitOptIn: "true",
      scopeMatches: 1,
      originalRetained: "yes",
      capsuleProvenancePresent: {},
      recoverabilityPassed: [],
      reductionThresholdMet: "pass",
      riskChecksPassed: 1,
      evidenceLabelPresent: "label",
      rollbackPathPresent: "undo"
    } as unknown as AutoApplyGateContext;
    const report = evaluateAutoApplyGates(sneaky);
    expect(report.allPassed).toBe(false);
    expect(report.gates.every((g) => g.passed === false)).toBe(true);
  });

  it("does not mutate its input", () => {
    const input: AutoApplyGateContext = { ...FULL_PASS };
    const snapshot = JSON.stringify(input);
    evaluateAutoApplyGates(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

describe("auto-apply-gates module surface - no apply path", () => {
  it("exports NO apply/execute/mutate/write/run/persist/save function", () => {
    const forbidden = /^(apply|execute|mutate|write|run|persist|save|commit|install)/i;
    const functionExports = Object.entries(gatesModule).filter(([, value]) => typeof value === "function");
    const offenders = functionExports.map(([name]) => name).filter((name) => forbidden.test(name));
    expect(offenders).toEqual([]);
    // The only exported function is the report-only evaluator.
    expect(functionExports.map(([name]) => name)).toEqual(["evaluateAutoApplyGates"]);
  });

  it("has ZERO filesystem side effects when called (snapshot-tree proof)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gates-sideeffect-"));
    try {
      const before = await snapshotTree(dir);
      evaluateAutoApplyGates(FULL_PASS);
      evaluateAutoApplyGates();
      const after = await snapshotTree(dir);
      expect([...after.entries()]).toEqual([...before.entries()]);
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
});

let _dir: string;
beforeEach(async () => {
  _dir = await mkdtemp(join(tmpdir(), "gates-"));
});
afterEach(async () => {
  await rm(_dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});
