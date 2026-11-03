/**
 * THE RUN-SPECIFIC OUTPUT ESTIMATE, end to end through the real seams.
 *
 * Two behaviours are pinned here and nowhere else:
 *   1. A supported shaped run on a provider/model with NO calibration row of its own still receives a
 *      number, from the substantive treatment family's cross-model posterior. Before this, every newly
 *      supported model rendered `N/A` until it had its own calibration campaign.
 *   2. That number is a property of the RUN. It is deterministic, it moves when the run's structure
 *      moves, it is bounded by the empirical corpus, and it falls back to the calibrated anchor rather
 *      than to `N/A` when a run carries no usable structure.
 *
 * Provider-free by construction: receipts are fixtures, the resolver reads the package-shipped registry,
 * and nothing here performs I/O or consults a clock.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { GatewayReceipt } from "../../src/core/gateway/receipt.js";
import { aggregateRun } from "../../src/core/gateway/run-aggregate.js";
import {
  calibrationStorePath,
  emptyCalibration,
  foldCalibrationConfirmation,
  outputCalibrationQuery,
  updateCalibrationFromConfirmation
} from "../../src/core/output-shaping-calibration-store.js";
import {
  OUTPUT_MORPHOLOGY_RAIL_HIGH_PCT,
  OUTPUT_MORPHOLOGY_RAIL_LOW_PCT,
  OUTPUT_MORPHOLOGY_REFERENCE_ANCHOR_PCT,
  OUTPUT_SHAPING_PAIRED_CORPUS_PCT,
  estimatePerTurnOutputSaved,
  loadOutputCalibrationResolver,
  outputCalibrationResolver,
  refineOutputRateForRun
} from "../../src/core/output-shaping-savings.js";
import { SHARED_OUTPUT_FAMILY_CALIBRATIONS } from "../../src/core/output-shaping-shared-calibration-registry.js";
import { buildHookOutputShapingTreatment, buildOutputShapingPolicy } from "../../src/core/output-shaping.js";
import { confirmedOutputCalibration } from "../helpers/output-calibration-fixture.js";

const CARRIER = buildOutputShapingPolicy().policyVersion;

/** One shaped provider call. `provider`/`model` are what the cross-model tier turns on. */
function shapedCall(input: {
  id: string;
  provider: string;
  model: string;
  output: number;
  /** `false` ⇒ a held/unshaped call: provenance says the policy was absent and no regime was named. */
  shaped?: boolean;
  /** The shaping carrier on the request; defaults to the core carrier. */
  carrier?: string;
}): GatewayReceipt {
  const shaped = input.shaped ?? true;
  return {
    receipt_id: input.id,
    captured_at: "2026-10-05T00:00:00.000Z",
    provider: input.provider,
    model: input.model,
    endpoint: "/v1/messages",
    mode: "record",
    upstream_status: 200,
    model_visible_bytes_changed: false,
    tokens: { output: input.output },
    fresh_billed_input_reduction: { available: false, note: "none" },
    token_source: "provider-reported",
    cache_source: "unavailable",
    cost_source: "unavailable",
    reasons: { cost: "unavailable" },
    claim_scope: "run-scoped",
    approval_status: "not-required",
    sync_status: "local-only",
    content_uploaded: false,
    label: "test",
    output_shaping_state: shaped ? "already-active" : "absent",
    output_shaping_policy_version: input.carrier ?? CARRIER,
    ...(shaped ? { output_shaping_regime: "default-shapeable" as const } : {})
  };
}

/** A run of `calls` shaped turns on Anthropic — a provider with NO shipped calibration row. */
function anthropicRun(calls: number, outputPerCall: number): GatewayReceipt[] {
  return Array.from({ length: calls }, (_, i) =>
    shapedCall({ id: `r${i}`, provider: "anthropic", model: "claude-opus-5-5", output: outputPerCall })
  );
}

function pct(aggregate: ReturnType<typeof aggregateRun>): number {
  const o = aggregate.output!;
  return Math.round(((o.before - o.after) / o.before) * 1000) / 10;
}

describe("the output estimate is run-specific, model-independent, and bounded", () => {
  const resolver = outputCalibrationResolver(emptyCalibration());

  it("a model with NO calibration row of its own still gets a number, not N/A", () => {
    const aggregate = aggregateRun(anthropicRun(8, 400), { outputCalibrationResolver: resolver });
    expect(aggregate.output?.counterfactualAvailable).toBe(true);
    expect(aggregate.output!.before).toBeGreaterThan(aggregate.output!.after);
    // This is the regression that matters: the whole point is that it is NOT the N/A axis.
    expect(pct(aggregate)).toBeGreaterThan(0);
  });

  it("is deterministic: the same run data produces a byte-identical estimate", () => {
    const receipts = anthropicRun(8, 400);
    const runs = Array.from({ length: 12 }, () =>
      JSON.stringify(aggregateRun(receipts, { outputCalibrationResolver: resolver }))
    );
    expect(new Set(runs).size).toBe(1);
    // A fresh resolver instance must agree too — no state accumulates between resolutions.
    expect(JSON.stringify(aggregateRun(receipts, {
      outputCalibrationResolver: outputCalibrationResolver(emptyCalibration())
    }))).toBe(runs[0]);
  });

  it("moves because the RUN differs: a terse tool-heavy run estimates lower than a verbose one", () => {
    const terse = pct(aggregateRun(anthropicRun(10, 60), { outputCalibrationResolver: resolver }));
    const normal = pct(aggregateRun(anthropicRun(10, 400), { outputCalibrationResolver: resolver }));
    const verbose = pct(aggregateRun(anthropicRun(10, 2_000), { outputCalibrationResolver: resolver }));
    expect(terse).toBeLessThan(normal);
    expect(normal).toBeLessThan(verbose);
    // Materially different, not a rounding artefact.
    expect(verbose - terse).toBeGreaterThan(5);
  });

  it("with the shipped anchor, never extrapolates outside the corpus hinges, however extreme the structure", () => {
    for (const perCall of [1, 5, 50, 500, 5_000, 500_000]) {
      for (const calls of [1, 3, 40, 400]) {
        const r = refineOutputRateForRun(OUTPUT_MORPHOLOGY_REFERENCE_ANCHOR_PCT, {
          shapedCallCount: calls,
          shapedOutputTokens: perCall * calls
        });
        expect(r.ratePct).toBeGreaterThanOrEqual(OUTPUT_MORPHOLOGY_RAIL_LOW_PCT - 1e-9);
        expect(r.ratePct).toBeLessThanOrEqual(OUTPUT_MORPHOLOGY_RAIL_HIGH_PCT + 1e-9);
      }
    }
    // The corpus outlier is deliberately OUTSIDE the renderable interval: no run structure may reach it.
    expect(Math.max(...OUTPUT_SHAPING_PAIRED_CORPUS_PCT)).toBeGreaterThan(OUTPUT_MORPHOLOGY_RAIL_HIGH_PCT);
    // Nor may any structure render one of the corpus's negative observations as a saving.
    expect(Math.min(...OUTPUT_SHAPING_PAIRED_CORPUS_PCT)).toBeLessThan(0);
    expect(OUTPUT_MORPHOLOGY_RAIL_LOW_PCT).toBeGreaterThan(0);
  });

  it("falls back to the calibrated anchor — never to N/A — when a run carries no usable structure", () => {
    for (const morphology of [
      { shapedCallCount: 0, shapedOutputTokens: 0 },
      { shapedCallCount: 0, shapedOutputTokens: 0 },
      { shapedCallCount: 3, shapedOutputTokens: 0 }
    ]) {
      const r = refineOutputRateForRun(18.33, morphology);
      expect(r.ratePct).toBe(18.33);
      expect(r.confidence).toBe(0);
      expect(r.basis).not.toBe("morphology-refined");
    }
  });

  it("shrinks a short run toward the anchor instead of letting one turn swing it", () => {
    const short = refineOutputRateForRun(18.33, { shapedCallCount: 1, shapedOutputTokens: 4_000 });
    const long = refineOutputRateForRun(18.33, { shapedCallCount: 20, shapedOutputTokens: 80_000 });
    expect(Math.abs(short.ratePct - 18.33)).toBeLessThan(Math.abs(long.ratePct - 18.33));
    expect(short.confidence).toBeLessThan(long.confidence);
  });

  it("exact measured evidence for a model OVERRIDES the family posterior and is never reshaped", () => {
    const store = foldCalibrationConfirmation(emptyCalibration(), confirmedOutputCalibration({
      provider: "anthropic",
      model: "claude-opus-5-5",
      policyVersion: CARRIER,
      // The receipts carry a regime, so the stored record must too or the exact key cannot match.
      regime: "default-shapeable",
      control: [1_000, 1_000, 1_000],
      treatment: [600, 600, 600]
    }));
    const exact = outputCalibrationResolver(store);
    // A measured 40% must render as 40%, not be pulled toward the corpus by run structure — the rails
    // bound what morphology may assert, they are not a ceiling on this device's own measurement.
    const terse = pct(aggregateRun(anthropicRun(10, 60), { outputCalibrationResolver: exact }));
    const verbose = pct(aggregateRun(anthropicRun(10, 2_000), { outputCalibrationResolver: exact }));
    expect(terse).toBeCloseTo(40, 0);
    expect(verbose).toBeCloseTo(40, 0);
    expect(terse).toBeGreaterThan(OUTPUT_MORPHOLOGY_RAIL_HIGH_PCT);
  });
});

describe("the rails are derived from the corpus, not transcribed beside it", () => {
  it("equal the corpus's own Tukey hinges, so editing the corpus cannot leave them stale", () => {
    const sorted = [...OUTPUT_SHAPING_PAIRED_CORPUS_PCT].sort((a, b) => a - b);
    const half = Math.floor(sorted.length / 2);
    const median = (values: readonly number[]): number => {
      const mid = Math.floor(values.length / 2);
      const m = values.length % 2 === 0 ? (values[mid - 1]! + values[mid]!) / 2 : values[mid]!;
      return Math.round(m * 100) / 100;
    };
    expect(OUTPUT_MORPHOLOGY_RAIL_LOW_PCT).toBe(median(sorted.slice(0, half)));
    expect(OUTPUT_MORPHOLOGY_RAIL_HIGH_PCT).toBe(median(sorted.slice(sorted.length - half)));
    // The values the shipped corpus currently yields, pinned so a corpus edit is a visible decision.
    expect(OUTPUT_MORPHOLOGY_RAIL_LOW_PCT).toBe(3.73);
    expect(OUTPUT_MORPHOLOGY_RAIL_HIGH_PCT).toBe(24.82);
  });
});

describe("evidence precedence: exact → same-model family → cross-model family → N/A", () => {
  const shippedFamily = SHARED_OUTPUT_FAMILY_CALIBRATIONS[0];
  const digest = "c".repeat(64);
  /** A family row measured on Anthropic, as a future labelled experiment would add. */
  const anthropicFamily = {
    ...shippedFamily,
    provider: "anthropic",
    model: "claude-opus-5-5",
    rate: 0.3,
    validPairCount: 3,
    evidenceDigest: digest,
    evidenceId: `output-shaping.evidence.v1.sha256.${digest}`
  };
  const query = (provider: string, model: string) =>
    outputCalibrationQuery({ policyVersion: CARRIER, provider, model, regime: "default-shapeable" });

  it("prefers a same-model family row over the cross-model one, and marks which it used", () => {
    const resolver = outputCalibrationResolver(emptyCalibration(), [shippedFamily, anthropicFamily]);
    expect(resolver(query("anthropic", "claude-opus-5-5")!)).toMatchObject({
      availability: "family-calibrated",
      reductionPct: 30,
      modelMatched: true
    });
    // Another Anthropic model has no row of its own: cross-model tier, never N/A.
    expect(resolver(query("anthropic", "claude-sonnet-5")!)).toMatchObject({
      availability: "family-calibrated",
      modelMatched: false
    });
  });

  it("a higher or lower family row moves 10- and 12-call runs in its own direction", () => {
    const withRow = (rate: number) => outputCalibrationResolver(emptyCalibration(), [
      shippedFamily,
      { ...anthropicFamily, rate }
    ]);
    for (const receipts of [anthropicRun(10, 400), anthropicRun(12, 90), anthropicRun(12, 2_000)]) {
      const shipped = pct(aggregateRun(receipts, { outputCalibrationResolver: outputCalibrationResolver(emptyCalibration()) }));
      const lower = pct(aggregateRun(receipts, { outputCalibrationResolver: withRow(0.1) }));
      const higher = pct(aggregateRun(receipts, { outputCalibrationResolver: withRow(0.35) }));
      expect(lower).toBeLessThan(shipped);
      expect(higher).toBeGreaterThan(shipped);
    }
  });

  it("morphology alone never lifts a rate above max(anchor, upper hinge)", () => {
    for (const anchor of [10, 18.33079692514799, 35, 60]) {
      const verbose = refineOutputRateForRun(anchor, { shapedCallCount: 50, shapedOutputTokens: 50 * 10_000 });
      const terse = refineOutputRateForRun(anchor, { shapedCallCount: 50, shapedOutputTokens: 50 * 10 });
      expect(verbose.ratePct).toBeLessThanOrEqual(Math.max(anchor, OUTPUT_MORPHOLOGY_RAIL_HIGH_PCT) + 1e-9);
      expect(terse.ratePct).toBeGreaterThan(0);
      expect(terse.ratePct).toBeLessThan(anchor);
    }
  });

  it("a high family row still moves at every run size, downward from its own evidence", () => {
    const resolver = outputCalibrationResolver(emptyCalibration(), [shippedFamily, { ...anthropicFamily, rate: 0.35 }]);
    const rates = [anthropicRun(12, 90), anthropicRun(10, 400), anthropicRun(10, 2_000)]
      .map((receipts) => pct(aggregateRun(receipts, { outputCalibrationResolver: resolver })));
    expect(rates).toEqual([7.1, 28.2, 35.0]);
  });

  it("the reference anchor is the shipped family row the corpus was calibrated into", () => {
    expect(shippedFamily.rate * 100).toBe(OUTPUT_MORPHOLOGY_REFERENCE_ANCHOR_PCT);
  });

  it("exact measured evidence outranks both family tiers", () => {
    const store = foldCalibrationConfirmation(emptyCalibration(), confirmedOutputCalibration({
      provider: "anthropic",
      model: "claude-opus-5-5",
      policyVersion: CARRIER,
      regime: "default-shapeable",
      control: [1_000, 1_000, 1_000],
      treatment: [900, 900, 900]
    }));
    const resolver = outputCalibrationResolver(store, [shippedFamily, anthropicFamily]);
    const resolved = resolver(query("anthropic", "claude-opus-5-5")!);
    expect(resolved.availability).toBe("measured");
    if (resolved.availability === "measured") expect(resolved.reductionPct).toBeCloseTo(10, 6);
  });

  it("keeps N/A only where the treatment cannot be established", () => {
    const resolver = outputCalibrationResolver(emptyCalibration());
    // Unknown carrier ⇒ no treatment family.
    const foreign = outputCalibrationQuery({
      policyVersion: buildOutputShapingPolicy({ verbosityBudgetTokens: 300 }).policyVersion,
      provider: "anthropic",
      model: "claude-opus-5-5",
      regime: "default-shapeable"
    });
    expect(foreign ? resolver(foreign).availability : "unavailable").toBe("unavailable");
    // Unknown model metadata is refused before any tier is consulted.
    expect(query("openai", "codex-unknown-model")).toBeUndefined();
    // No regime ⇒ the task gate never classified the turn shapeable (held/planning turn).
    const unregimed = outputCalibrationQuery({ policyVersion: CARRIER, provider: "anthropic", model: "claude-opus-5-5" });
    expect(unregimed).toBeDefined();
    expect(unregimed ? resolver(unregimed).availability : "unavailable").toBe("unavailable");
  });
});

describe("shaped share is accounted by arithmetic, not by the rate", () => {
  it("a run's saving is independent of how many unshaped calls surround its shaped ones", () => {
    const resolver = outputCalibrationResolver(emptyCalibration());
    const shapedOnly = anthropicRun(10, 400);
    const held = Array.from({ length: 10 }, (_, i) =>
      shapedCall({ id: `h${i}`, provider: "anthropic", model: "claude-opus-5-5", output: 400, shaped: false })
    );
    const pure = aggregateRun(shapedOnly, { outputCalibrationResolver: resolver }).output!;
    const mixed = aggregateRun([...shapedOnly, ...held], { outputCalibrationResolver: resolver }).output!;
    // Unshaped calls neither lower the rate nor gain a counterfactual; they only add actual output.
    expect(mixed.before - mixed.after).toBe(pure.before - pure.after);
    expect(mixed.after).toBe(pure.after + 4_000);
  });
});

describe("learning seam: labelled evidence enters only through validated ingestion", () => {
  it("production runs never write calibration evidence", () => {
    const dir = mkdtempSync(join(tmpdir(), "morphology-no-self-train-"));
    try {
      const env = { COMPACTION_CONFIG_DIR: dir } as NodeJS.ProcessEnv;
      for (const perCall of [60, 400, 2_000]) {
        aggregateRun(anthropicRun(10, perCall), {
          outputCalibrationResolver: outputCalibrationResolver(emptyCalibration())
        });
      }
      expect(existsSync(calibrationStorePath(env))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a future genuine OFF/ON experiment ingests as exact evidence without changing the estimator", async () => {
    const dir = mkdtempSync(join(tmpdir(), "morphology-ingest-"));
    try {
      const env = { COMPACTION_CONFIG_DIR: dir } as NodeJS.ProcessEnv;
      const runs = [anthropicRun(10, 60), anthropicRun(10, 2_000)];
      const before = await loadOutputCalibrationResolver(env);
      const cold = runs.map((r) => pct(aggregateRun(r, { outputCalibrationResolver: before })));
      expect(cold[0]).toBeLessThan(cold[1]!);

      const ingested = await updateCalibrationFromConfirmation(confirmedOutputCalibration({
        provider: "anthropic",
        model: "claude-opus-5-5",
        policyVersion: CARRIER,
        regime: "default-shapeable",
        control: [800, 820, 780],
        treatment: [680, 700, 660]
      }), env);
      expect(ingested.updated).toBe(true);

      const after = await loadOutputCalibrationResolver(env);
      const warm = runs.map((r) => pct(aggregateRun(r, { outputCalibrationResolver: after })));
      // Measured 15%: rendered as measured on every run, not reshaped by morphology.
      expect(warm[0]).toBeCloseTo(15, 0);
      expect(warm[1]).toBeCloseTo(15, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("provider-free replay of materially different run morphologies (real resolver, shipped evidence)", () => {
  const HOOK = buildHookOutputShapingTreatment().policyVersion;
  const run = (carrier: string, provider: string, model: string, shaped: number, perCall: number, held: number) => [
    ...Array.from({ length: shaped }, (_, i) =>
      shapedCall({ id: `s${i}`, provider, model, output: perCall, carrier })
    ),
    ...Array.from({ length: held }, (_, i) =>
      shapedCall({ id: `h${i}`, provider, model, output: perCall, shaped: false, carrier })
    )
  ];
  it.each([
    ["terse tool-heavy, hook carrier, Anthropic (cross-provider family)", "hook", "anthropic", "claude-opus-5-5", 12, 90, 0, 3.7],
    ["normal, hook carrier, calibrated model (same-model family)", "hook", "openai", "gpt-5.6-sol", 10, 400, 0, 14.7],
    ["normal, core carrier, calibrated model (exact measured, untouched)", "core", "openai", "gpt-5.6-sol", 10, 400, 0, 25.0],
    ["verbose explanatory, hook carrier, sibling model (cross-model family)", "hook", "openai", "gpt-5.6", 8, 1_500, 0, 24.8],
    ["sparse verbose, hook carrier, Anthropic (shrunk toward anchor)", "hook", "anthropic", "claude-sonnet-5", 2, 2_000, 0, 20.5],
    ["normal with half the calls held, hook carrier, Anthropic", "hook", "anthropic", "claude-opus-5-5", 10, 400, 10, 8.0]
  ] as const)("%s", async (_label, carrier, provider, model, shaped, perCall, held, expected) => {
    const dir = mkdtempSync(join(tmpdir(), "morphology-replay-"));
    try {
      const resolver = await loadOutputCalibrationResolver({ COMPACTION_CONFIG_DIR: dir } as NodeJS.ProcessEnv);
      const receipts = run(carrier === "hook" ? HOOK : CARRIER, provider, model, shaped, perCall, held);
      expect(pct(aggregateRun(receipts, { outputCalibrationResolver: resolver }))).toBe(expected);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the per-call rung (no run boundary) refines a family rate as a one-call run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "morphology-per-call-"));
    try {
      const resolver = await loadOutputCalibrationResolver({ COMPACTION_CONFIG_DIR: dir } as NodeJS.ProcessEnv);
      const reduction = resolver(outputCalibrationQuery({
        policyVersion: HOOK, provider: "openai", model: "gpt-5.6-sol", regime: "default-shapeable"
      })!);
      const rate = (out: number) => {
        const e = estimatePerTurnOutputSaved(reduction, out);
        return e.calibrated ? Math.round((1000 * e.tokensSaved!) / (out + e.tokensSaved!)) / 10 : undefined;
      };
      expect([rate(90), rate(400), rate(1_500)]).toEqual([15.9, 17.7, 19.4]);
      // Single-call figures equal the run path for the same one-call run.
      expect(rate(90)).toBe(pct(aggregateRun(run(HOOK, "openai", "gpt-5.6-sol", 1, 90, 0), { outputCalibrationResolver: resolver })));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
