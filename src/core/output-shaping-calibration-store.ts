/**
 * LEARNING output-shaping calibration store (PUBLIC CLI/SDK core, engine-free, content-free, local-first).
 *
 * The per-turn receipt line's output before→after arrow (`output 652→512 (−21%, est)`) needs a reduction
 * RATE to reconstruct the before from this turn's real output. That rate must be MEASURED, and it should get
 * TIGHTER as more real A/B experiments are run. This store is that learning loop:
 *
 *  - It ACCUMULATES real, provider-reported output-shaping A/B measurements (each a mean-control vs
 *    mean-treatment output-token pair with its per-arm sample counts) into a single running aggregate —
 *    INCLUDING experiments where shaping did not help, since excluding those is what made v1 optimistic.
 *  - It maintains a running SAMPLE-WEIGHTED reduction rate: the rate is computed from accumulated
 *    control/treatment output-token TOTALS, so an experiment with more turns pulls the estimate more, and
 *    the estimate converges as samples accumulate. It also carries the cumulative sample count so a reader
 *    can refuse to over-trust a 1-sample rate.
 *  - It is CONTENT-FREE: only aggregate token totals, sample counts, an experiment-id set (opaque labels),
 *    and timestamps — never a prompt, response, or trace byte.
 *
 * A rate is produced ONLY from real measurements fed in via `updateCalibrationFromAbSummary` (the
 * `compaction savings` A/B path). Nothing here fabricates a counterfactual: a turn that was merely shaped
 * (with no control arm) can never update the rate — only a real A/B does.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { OutputShapingAbSummary } from "./output-shaping-ab.js";
import { compactionConfigDir } from "./config-dir.js";

/**
 * SCHEMA v2 (2026-08-04). v1 aggregates are treated as ABSENT (`loadCalibration` already returns an empty
 * aggregate on a schema mismatch), because v1 totals were accumulated with two defects that make them
 * incomparable with v2 contributions:
 *
 *  1. SURVIVORSHIP — v1 discarded every experiment where shaping did NOT reduce output (`before <= after`),
 *     so the rate was a mean over wins only and structurally optimistic.
 *  2. MISMATCHED ARM WEIGHTS — v1 weighted control by `nControl` and treatment by `nTreatment`, then divided
 *     the two sums. With unbalanced arms that is not a reduction fraction at all: a measured 40% reduction
 *     (before=1000×3 turns, after=600×6 turns) folded in as totals 3000/3600, i.e. a 20% INCREASE.
 *
 * Discarding is safe and cheap here: the file is a local, content-free, regenerable cache, and the only
 * consequence is that the rate returns to uncalibrated until the next `compaction savings` run folds in an
 * A/B under the corrected arithmetic. Blending v1 and v2 totals would silently carry the old error forward.
 */
export const OUTPUT_SHAPING_CALIBRATION_SCHEMA = "output-shaping.calibration.v2" as const;

/**
 * The accumulated, content-free calibration aggregate. Every field is a count, a total, an opaque id, or a
 * timestamp. `sampleCount` is the number of DISTINCT A/B experiments folded in (an experiment re-added by id
 * replaces its prior contribution — see `foldAbSummary` — so re-running the same experiment does not
 * double-count). The reduction rate is derived from the totals, never stored as an independent number that
 * could drift from them.
 */
export interface OutputShapingCalibration {
  schema: typeof OUTPUT_SHAPING_CALIBRATION_SCHEMA;
  /** Number of distinct A/B experiments folded into the aggregate. */
  sampleCount: number;
  /** Cumulative CONTROL (unshaped) mean-output tokens summed across folded experiments (weighted by turns). */
  totalControlOutputTokens: number;
  /** Cumulative TREATMENT (shaped) mean-output tokens summed across folded experiments (weighted by turns). */
  totalTreatmentOutputTokens: number;
  /** Cumulative provider-reported turns (control + treatment) behind the totals — the confidence denominator. */
  totalTurns: number;
  /** The opaque experiment ids folded in (content-free labels), so a re-add replaces not double-counts. */
  experimentIds: string[];
  updatedAt: string;
}

/** A fresh, empty aggregate (rate is `unavailable` until the first real A/B is folded in). */
export function emptyCalibration(now: () => string = () => new Date().toISOString()): OutputShapingCalibration {
  return {
    schema: OUTPUT_SHAPING_CALIBRATION_SCHEMA,
    sampleCount: 0,
    totalControlOutputTokens: 0,
    totalTreatmentOutputTokens: 0,
    totalTurns: 0,
    experimentIds: [],
    updatedAt: now()
  };
}

/**
 * The current calibrated reduction rate derived from the aggregate, with the confidence the reader needs.
 *  - `calibrated: false` (⇒ the per-turn line degrades to a plain `output N` — no arrow, no fabricated
 *    before) whenever there is no folded sample yet, the totals are non-positive, or the derived rate is not
 *    a usable fraction in (0,1). Since v2 folds in non-favourable experiments too, this is also the state
 *    reached when the accumulated evidence says shaping does NOT reduce output — which is the point.
 *  - `calibrated: true` carries a `rate` in (0,1) AND the `sampleCount` behind it, so a downstream reader
 *    can still treat a 1-sample rate cautiously.
 */
export interface CalibratedRate {
  calibrated: boolean;
  /** The sample-weighted reduction fraction (control − treatment)/control, in (0,1), when calibrated. */
  rate?: number;
  /**
   * Whether the rate is this device's OWN measurement or the shipped default prior. Present whenever
   * `calibrated` is true. `sampleCount` alone would imply it (0 ⇒ prior), but a surface explaining
   * itself should not have to infer provenance from a count.
   */
  basis?: CalibrationBasis;
  /** How many distinct A/B experiments back the rate. ZERO when the rate is the default prior. */
  sampleCount: number;
  /** Cumulative provider-reported turns behind the rate (the confidence denominator). */
  totalTurns: number;
}

/**
 * The STARTING rate, used until this device has measured its own.
 *
 * WHY A PRIOR AT ALL. The per-turn line reconstructs the unshaped `before` from a rate — the unshaped
 * turn was never generated, so there is nothing to measure directly. With no rate the output clause
 * degrades to a bare `output 286`, which is what EVERY install showed, because the only producer of a
 * rate was a manual `compaction savings` A/B that approximately nobody runs before seeing the product.
 * The designed line was therefore unreachable on a fresh machine.
 *
 * WHERE THE NUMBER COMES FROM. Two recorded CODING-TASK A/Bs — the family
 * that matches how these tools are actually used — both provider-reported and both gated by the
 * codified sufficiency eval:
 *   · `exp-cc-output-004` (Claude Code, coding): 107.7 → 50.3 output tokens, ≈53.3%, ±2·SE [19.5, 95.2]
 *   · `exp-cc-output-006` (Codex, coding):       ≈47.5%, sufficient 3/3 both arms
 * They agree closely across two providers. This takes the LOWER of the two and rounds down, so the
 * shipped default sits at or below both measurements rather than between them.
 *
 * WHAT IT IS NOT. Not a claim that any given turn saved 47%. The clause it feeds is labelled `est` and
 * renders a reconstruction, never a measurement. The matrix's binding position — "magnitude is
 * strongly model- AND prompt-dependent", "no single Claude Code output number" — is exactly why this is
 * a conservative floor from the nearest task family rather than the headline 88.6%, and exactly why a
 * device's own measurement REPLACES it outright on the first fold rather than being averaged with it.
 */
export const DEFAULT_OUTPUT_SHAPING_RATE = 0.47;

/**
 * Where a rate came from. Surfaces that explain themselves need to distinguish "our measurement, not
 * yours" from "yours" — the two deserve different words even though the clause renders identically.
 */
export type CalibrationBasis = "default-prior" | "measured";

/**
 * Derive the current rate from an aggregate. Pure.
 *
 * With NO folded experiment this returns the shipped default prior (`basis: "default-prior"`), so the
 * per-turn line shows a reduction from the first turn on a fresh install. With at least one folded
 * experiment the device's OWN measurement is used and the prior is discarded entirely — not blended,
 * not averaged. One real A/B on your traffic beats a general figure from ours, and every further
 * experiment tightens it through the turn-weighted accumulation in `foldAbSummary`.
 *
 * The honesty guard is unchanged and still applies to measured data: totals that imply a rate outside
 * (0,1) yield `calibrated: false`, and the line falls back to a bare count. That case does NOT fall
 * back to the prior — a device that measured "shaping does not help here" must not have that answer
 * overwritten by our default.
 */
export function calibratedRate(cal: OutputShapingCalibration): CalibratedRate {
  const base = { sampleCount: cal.sampleCount, totalTurns: cal.totalTurns };
  if (cal.sampleCount < 1) {
    return { calibrated: true, rate: DEFAULT_OUTPUT_SHAPING_RATE, basis: "default-prior", ...base };
  }
  if (cal.totalControlOutputTokens <= 0) return { calibrated: false, ...base };
  const rate = (cal.totalControlOutputTokens - cal.totalTreatmentOutputTokens) / cal.totalControlOutputTokens;
  if (!Number.isFinite(rate) || rate <= 0 || rate >= 1) return { calibrated: false, ...base };
  return { calibrated: true, rate, basis: "measured", ...base };
}

/**
 * Fold a MEASURED A/B summary into the aggregate, returning the NEW aggregate (pure; does no IO).
 *
 * WHAT QUALIFIES: a complete, provider-reported before/after pair with at least one turn in each arm. The
 * DIRECTION of the result is NOT a condition — a null or negative experiment is evidence too, and
 * excluding it is the survivorship bias described on `OUTPUT_SHAPING_CALIBRATION_SCHEMA`. The honesty
 * guard sits DOWNSTREAM in `calibratedRate`, which refuses any derived rate outside (0,1): if the
 * accumulated evidence says shaping does not reduce output, the store reports UNCALIBRATED rather than
 * quietly dropping the evidence that would have said so.
 *
 * WEIGHTING: both arms of one experiment carry the SAME weight (its total provider-reported turns), so a
 * larger experiment pulls the estimate more. Weighting each arm by its own N does not yield a reduction
 * fraction at all when the arms differ in size — the v1 defect described on the schema constant.
 *
 * What the aggregate IS, precisely (an earlier draft of this comment got it wrong): a POOLED TOKEN RATIO,
 * not a mean of per-experiment reduction fractions. With shared weight `wᵢ = nCᵢ + nTᵢ`,
 * `rate = Σwᵢcᵢ(1 − tᵢ/cᵢ) / Σwᵢcᵢ` — a weighted mean of the fractions `rᵢ` whose effective weights are
 * `wᵢ·cᵢ`, i.e. turns TIMES control magnitude. That is the right estimator for what the rate is used for,
 * reconstructing a plausible `before` from a real `after`: a turn that produced more tokens should count
 * for more when estimating tokens. It is a ratio of sums, not a mean of ratios, and the two differ — for
 * r₁=0.40 (1000→600) and r₂=0.10 (100→90) at one turn per arm it yields 0.373, where a turn-weighted mean
 * of the fractions would yield 0.250.
 *
 * The shared weight cancels within a single experiment; `wᵢ` only sets relative weight ACROSS experiments.
 * The aggregate can never exceed the best per-experiment reduction (`rate ≤ maxᵢ rᵢ`) — a convex
 * combination with non-negative weights, pinned by a fuzzed test.
 *
 * Re-adding an experiment whose id is already folded in is a NO-OP (idempotent by id; the first fold wins),
 * so re-running `compaction savings` on the same artifact does not double-count it.
 */
export function foldAbSummary(
  cal: OutputShapingCalibration,
  summary: OutputShapingAbSummary,
  now: () => string = () => new Date().toISOString()
): OutputShapingCalibration {
  const before = summary.outputTokensBefore;
  const after = summary.outputTokensAfter;
  const nControl = summary.nControl;
  const nTreatment = summary.nTreatment;
  // A complete, provider-reported pair with both arms populated. NOT conditioned on the sign of the result:
  // a non-favourable A/B is real evidence and must be able to move (or fail to move) the rate.
  if (
    before === null ||
    after === null ||
    !Number.isFinite(before) ||
    !Number.isFinite(after) ||
    before < 0 ||
    after < 0 ||
    nControl < 1 ||
    nTreatment < 1
  ) {
    return cal;
  }

  // If this experiment id was already folded in, its prior contribution must be removed before re-adding, so
  // the aggregate is idempotent by id. Prior per-experiment contributions are not retained individually, so
  // the honest, simple idempotency is: a re-add of an already-present id is a NO-OP (the first fold wins).
  // This keeps the store append-only-safe without retaining per-experiment content.
  if (cal.experimentIds.includes(summary.experimentId)) return cal;

  // ONE weight for BOTH arms: `before` and `after` are per-arm MEANS, already normalised for their own arm
  // sizes, so the only thing left to express is how much this experiment counts relative to others —
  // its total turns. Per-arm weights here would make the ratio something other than a reduction fraction.
  const experimentWeight = nControl + nTreatment;
  const controlContribution = before * experimentWeight;
  const treatmentContribution = after * experimentWeight;

  return {
    schema: OUTPUT_SHAPING_CALIBRATION_SCHEMA,
    sampleCount: cal.sampleCount + 1,
    totalControlOutputTokens: cal.totalControlOutputTokens + controlContribution,
    totalTreatmentOutputTokens: cal.totalTreatmentOutputTokens + treatmentContribution,
    totalTurns: cal.totalTurns + nControl + nTreatment,
    experimentIds: [...cal.experimentIds, summary.experimentId],
    updatedAt: now()
  };
}

/**
 * The conventional local calibration artifact path (`<config-dir>/shaping-calibration.json`), with
 * `COMPACTION_CONFIG_DIR` overriding `~/.compaction` so tests and sandboxes point elsewhere. This function
 * is the SINGLE definition of that path — every reader and writer goes through it.
 */
export function calibrationStorePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(compactionConfigDir(env), "shaping-calibration.json");
}

/**
 * Load the calibration aggregate from disk, or a fresh empty aggregate when the file is absent/unreadable/
 * malformed or is not the calibration schema. Total and fail-open: never throws.
 */
export async function loadCalibration(
  env: NodeJS.ProcessEnv = process.env,
  readFileImpl: (p: string) => Promise<string> = (p) => readFile(p, "utf8")
): Promise<OutputShapingCalibration> {
  try {
    const raw = await readFileImpl(calibrationStorePath(env));
    const parsed = JSON.parse(raw) as Partial<OutputShapingCalibration>;
    if (parsed?.schema !== OUTPUT_SHAPING_CALIBRATION_SCHEMA) return emptyCalibration();
    return {
      schema: OUTPUT_SHAPING_CALIBRATION_SCHEMA,
      sampleCount: numberOr(parsed.sampleCount, 0),
      totalControlOutputTokens: numberOr(parsed.totalControlOutputTokens, 0),
      totalTreatmentOutputTokens: numberOr(parsed.totalTreatmentOutputTokens, 0),
      totalTurns: numberOr(parsed.totalTurns, 0),
      experimentIds: Array.isArray(parsed.experimentIds) ? parsed.experimentIds.filter((s): s is string => typeof s === "string") : [],
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString()
    };
  } catch {
    return emptyCalibration();
  }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Persist the calibration aggregate to the conventional path (creating the dir). Content-free by shape. */
export async function saveCalibration(cal: OutputShapingCalibration, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const path = calibrationStorePath(env);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(cal, null, 2)}\n`, "utf8");
  return path;
}

/**
 * The `compaction savings` learning hook: load the aggregate, fold in a completed A/B summary, and persist
 * the updated aggregate — so running more experiments TIGHTENS the calibrated rate. Returns the new
 * aggregate and whether this fold actually changed it (a non-measured or already-folded A/B is a no-op).
 * Fail-open on IO is the caller's concern; this resolves normally.
 */
export async function updateCalibrationFromAbSummary(
  summary: OutputShapingAbSummary,
  env: NodeJS.ProcessEnv = process.env,
  now: () => string = () => new Date().toISOString()
): Promise<{ calibration: OutputShapingCalibration; updated: boolean }> {
  const current = await loadCalibration(env);
  const next = foldAbSummary(current, summary, now);
  const updated = next !== current;
  if (updated) await saveCalibration(next, env);
  return { calibration: next, updated };
}
