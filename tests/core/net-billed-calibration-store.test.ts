import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  emptyNetBilledCalibration,
  foldNetBilledDelta,
  netBilledRate,
  loadNetBilledCalibration,
  saveNetBilledCalibration,
  updateNetBilledCalibrationFromDelta,
  netBilledCalibrationStorePath,
  NET_BILLED_CALIBRATION_SCHEMA
} from "../../src/core/gateway/net-billed-calibration-store.js";
import type { GatewayProofDelta } from "../../src/core/gateway/proof.js";

/** A minimal available proof delta with the given baseline/compacted fresh-billed input totals. */
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

const NOW = () => "1970-01-01T00:00:00.000Z";

describe("net-billed calibration store (pure fold + derive)", () => {
  it("empty aggregate → net-billed figure is unavailable (never fabricated)", () => {
    const rate = netBilledRate(emptyNetBilledCalibration(NOW));
    expect(rate.measured).toBe(false);
    expect(rate.rate).toBeUndefined();
    expect(rate.sampleCount).toBe(0);
  });

  it("folds a POSITIVE A/B and derives a positive signed rate", () => {
    const cal = foldNetBilledDelta(emptyNetBilledCalibration(NOW), { proofRunId: "p1", delta: delta(1000, 400) }, NOW);
    expect(cal.sampleCount).toBe(1);
    expect(cal.totalBaselineFreshInputTokens).toBe(1000);
    expect(cal.totalCompactedFreshInputTokens).toBe(400);
    const rate = netBilledRate(cal);
    expect(rate.measured).toBe(true);
    expect(rate.rate).toBeCloseTo(0.6, 5);
    expect(rate.absoluteTokens).toBe(600);
    expect(rate.sampleCount).toBe(1);
  });

  it("represents a NEGATIVE (cache-bust) A/B honestly — signed rate stays negative, never floored to 0", () => {
    // compacted arm LARGER than baseline: apply raised net-billed input (busted the cache).
    const cal = foldNetBilledDelta(emptyNetBilledCalibration(NOW), { proofRunId: "p1", delta: delta(300, 800) }, NOW);
    expect(cal.totalCompactedFreshInputTokens).toBe(800); // NOT clamped to <= baseline
    const rate = netBilledRate(cal);
    expect(rate.measured).toBe(true);
    expect(rate.rate).toBeLessThan(0);
    expect(rate.rate).toBeCloseTo((300 - 800) / 300, 5);
    expect(rate.absoluteTokens).toBe(-500);
  });

  it("represents a ZERO (no-help) A/B honestly", () => {
    const cal = foldNetBilledDelta(emptyNetBilledCalibration(NOW), { proofRunId: "p1", delta: delta(500, 500) }, NOW);
    const rate = netBilledRate(cal);
    expect(rate.measured).toBe(true);
    expect(rate.rate).toBe(0);
    expect(rate.absoluteTokens).toBe(0);
  });

  it("ACCUMULATES multiple A/Bs (sample-weighted by fresh-billed totals) and tightens as samples grow", () => {
    let cal = emptyNetBilledCalibration(NOW);
    cal = foldNetBilledDelta(cal, { proofRunId: "p1", delta: delta(1000, 400) }, NOW); // +600
    cal = foldNetBilledDelta(cal, { proofRunId: "p2", delta: delta(2000, 1000) }, NOW); // +1000
    expect(cal.sampleCount).toBe(2);
    expect(cal.totalBaselineFreshInputTokens).toBe(3000);
    expect(cal.totalCompactedFreshInputTokens).toBe(1400);
    const rate = netBilledRate(cal);
    expect(rate.rate).toBeCloseTo(1600 / 3000, 5);
    expect(rate.sampleCount).toBe(2);
  });

  it("a positive and a negative A/B can NET to a non-positive aggregate (honest)", () => {
    let cal = emptyNetBilledCalibration(NOW);
    cal = foldNetBilledDelta(cal, { proofRunId: "p1", delta: delta(1000, 900) }, NOW); // +100
    cal = foldNetBilledDelta(cal, { proofRunId: "p2", delta: delta(200, 700) }, NOW); // −500 (cache-bust)
    // totals: baseline 1200, compacted 1600 → net negative overall.
    const rate = netBilledRate(cal);
    expect(rate.absoluteTokens).toBe(-400);
    expect(rate.rate).toBeLessThan(0);
  });

  it("is idempotent by proof-run id: re-adding the same A/B is a no-op (no double-count)", () => {
    const one = foldNetBilledDelta(emptyNetBilledCalibration(NOW), { proofRunId: "p1", delta: delta(1000, 400) }, NOW);
    const two = foldNetBilledDelta(one, { proofRunId: "p1", delta: delta(1000, 400) }, NOW);
    expect(two).toBe(one); // unchanged reference
    expect(two.sampleCount).toBe(1);
  });

  it("ignores a NON-measured A/B (unavailable delta) — never moves the figure", () => {
    const unavailable: GatewayProofDelta = { available: false, baselineFound: true, compactedFound: false, reasons: ["compacted receipt not found"] };
    const cal = foldNetBilledDelta(emptyNetBilledCalibration(NOW), { proofRunId: "p1", delta: unavailable }, NOW);
    expect(cal.sampleCount).toBe(0);
    expect(netBilledRate(cal).measured).toBe(false);
  });

  it("ignores an A/B missing a fresh-billed total on either arm", () => {
    const noAfter: GatewayProofDelta = { available: true, baselineFound: true, compactedFound: true, beforeFreshInputTokens: 1000, reasons: [] };
    const cal = foldNetBilledDelta(emptyNetBilledCalibration(NOW), { proofRunId: "p1", delta: noAfter }, NOW);
    expect(cal.sampleCount).toBe(0);
  });

  it("baseline fresh-billed of 0 has no honest denominator → not measured", () => {
    const cal = foldNetBilledDelta(emptyNetBilledCalibration(NOW), { proofRunId: "p1", delta: delta(0, 0) }, NOW);
    expect(cal.sampleCount).toBe(0); // baseline <= 0 is not folded
    expect(netBilledRate(cal).measured).toBe(false);
  });
});

describe("net-billed calibration store (IO, content-free)", () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "net-billed-cal-"));
    env = { COMPACTION_CONFIG_DIR: dir };
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

  it("absent store loads as empty (fail-open)", async () => {
    const cal = await loadNetBilledCalibration(env);
    expect(cal.sampleCount).toBe(0);
    expect(existsSync(netBilledCalibrationStorePath(env))).toBe(false);
  });

  it("update → persists a content-free aggregate and round-trips", async () => {
    const { updated } = await updateNetBilledCalibrationFromDelta({ proofRunId: "p1", delta: delta(1000, 400) }, env, NOW);
    expect(updated).toBe(true);
    const raw = readFileSync(netBilledCalibrationStorePath(env), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.schema).toBe(NET_BILLED_CALIBRATION_SCHEMA);
    // Content-free: only counts/totals/opaque ids/timestamps — no content-carrying field.
    const allowed = new Set([
      "schema",
      "sampleCount",
      "totalBaselineFreshInputTokens",
      "totalCompactedFreshInputTokens",
      "proofRunIds",
      "updatedAt"
    ]);
    for (const k of Object.keys(parsed)) expect(allowed.has(k), k).toBe(true);
    const reloaded = await loadNetBilledCalibration(env);
    expect(reloaded.sampleCount).toBe(1);
    expect(netBilledRate(reloaded).rate).toBeCloseTo(0.6, 5);
  });

  it("re-running the same proof-run id does not double-count on disk", async () => {
    await updateNetBilledCalibrationFromDelta({ proofRunId: "p1", delta: delta(1000, 400) }, env, NOW);
    const second = await updateNetBilledCalibrationFromDelta({ proofRunId: "p1", delta: delta(1000, 400) }, env, NOW);
    expect(second.updated).toBe(false);
    expect((await loadNetBilledCalibration(env)).sampleCount).toBe(1);
  });

  it("malformed / wrong-schema file loads as empty (never throws)", async () => {
    await saveNetBilledCalibration({ ...emptyNetBilledCalibration(NOW), schema: "other" as never }, env);
    expect((await loadNetBilledCalibration(env)).sampleCount).toBe(0);
  });
});
