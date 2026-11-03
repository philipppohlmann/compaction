/**
 * Output-shaping SAVINGS projection (PUBLIC CLI/SDK core, engine-free, content-free).
 *
 * Turns a MEASURED output-shaping A/B summary (`summarizeOutputShapingAb`) into the two figures the
 * `compaction savings` command surfaces, under strict claim honesty:
 *
 *  1. The MEASURED per-turn output-token reduction (mean control − mean treatment, with the reduction %
 *     and the per-arm denominators). This is OBSERVED, provider-reported, NOT billing-confirmed. It is
 *     copied straight from the A/B summary; this module never invents it.
 *  2. A plan-lifetime "extended by ~X output tokens / ~Y turns" figure. This is an INFERENCE (Route A):
 *     it multiplies the measured mean per-turn saving by a user-supplied plan output budget. It is
 *     therefore labeled `route-a-inference` - NOT directly observed, NOT billing-confirmed. It is produced
 *     ONLY when (a) the A/B is at least `observed_not_confirmed` (both arms provider-reported, sufficiency
 *     passed) AND (b) the caller supplied a real plan output budget. Absent either, the projection is
 *     `unavailable` with an honest reason - never a fabricated number.
 *
 * No fabricated numbers: if the A/B has no provider-reported sample, everything is `unavailable`.
 */
import { summarizeOutputShapingAb, type OutputShapingAbSummary } from "./output-shaping-ab.js";
import {
  bestApplicableOutputCalibration,
  emptyCalibration,
  foldCalibrationConfirmation,
  loadCalibration,
  mergeOutputCalibrations,
  outputCalibrationQuery,
  updateCalibrationFromConfirmation,
  validateOutputCalibrationConfirmation,
  validateOutputShapingFamilyCalibration,
  type OutputShapingCalibration,
  type OutputShapingFamilyCalibrationRecord,
  type OutputShapingCalibrationQuery,
  type CalibrationBasis,
  type CalibrationState
} from "./output-shaping-calibration-store.js";
import {
  SHARED_OUTPUT_CALIBRATION_CONFIRMATIONS,
  SHARED_OUTPUT_FAMILY_CALIBRATIONS
} from "./output-shaping-shared-calibration-registry.js";

/** The honest label carried by the plan-lifetime projection. It is an inference, not an observation. */
export const ROUTE_A_INFERENCE_LABEL =
  "Route A inference (projected from the measured per-turn reduction × your plan output budget) - " +
  "NOT directly observed, NOT billing-confirmed";

export type SavingsAvailability = "measured" | "unavailable";

export interface MeasuredPerTurnReduction {
  availability: "measured";
  /** Mean control (unshaped) output tokens, provider-reported. */
  meanControlOutputTokens: number;
  /** Mean treatment (shaped) output tokens, provider-reported. */
  meanTreatmentOutputTokens: number;
  /** before − after (positive ⇒ shaped used fewer). OBSERVED, not billing-confirmed. */
  meanOutputTokenReduction: number;
  reductionPct: number;
  /** Per-arm denominators (N). A single pair is an anecdote; the confidence enum carries this too. */
  nControl: number;
  nTreatment: number;
  /** The A/B confidence enum verbatim (`observed_not_confirmed` / `eligible_for_engine_confirmation`). */
  confidence: OutputShapingAbSummary["confidence"];
  /**
   * How many distinct confirmed A/B experiments back this rate when it came from the shared/local calibration (so a
   * reader never over-trusts a 1-sample rate). Absent when the reduction came directly from a single A/B
   * summary (`measuredPerTurnReduction`), which is inherently one experiment.
   */
  sampleCount?: number;
  /**
   * PROVENANCE of the reduction RATE. `"measured"` ⇒ exact empirical evidence;
   * `"family-calibrated"` ⇒ the strict package family posterior; `"default-prior"` ⇒ the internal
   * generic starting rate, which no user-facing calibration path may consume.
   *
   * IT DECIDES WHETHER A PER-RUN FIGURE MAY BE DRAWN AT ALL — it is not a label selector. It used to pick
   * between two estimate markers on an arrow that rendered either way; a rendered before→after pair reads
   * as counted whatever it is labelled, so a `"default-prior"` basis now suppresses the arrow instead of
   * annotating it, both here (`estimatePerTurnOutputSaved`) and again at the formatter. Absent ⇒ treated as
   * a generic estimate, never as a prior.
   */
  basis?: CalibrationBasis;
  /**
   * The calibration LIFECYCLE behind the rate, forwarded verbatim from the resolver. On this type it is
   * always `"calibrated"` when it is present at all; it rides here so one field answers "what does this
   * device know?" on both halves of the union and a renderer never has to infer it from which variant
   * it received.
   */
  state?: CalibrationState;
  /** Substantive treatment family, when this build can derive it from the exact carrier. */
  treatmentFamilyVersion?: string;
  /** Deterministic identity of the exact confirmation set behind this resolved rate. */
  evidenceId?: string;
}

export interface FamilyCalibratedPerTurnReduction {
  availability: "family-calibrated";
  reductionPct: number;
  /** Number of valid paired tasks behind the hierarchical family posterior. */
  sampleCount: number;
  basis: "family-calibrated";
  state: "calibrated";
  treatmentFamilyVersion: string;
  evidenceId: string;
  sourceEvidencePolicyVersion: string;
  /**
   * Whether the family posterior behind this rate was measured on THIS run's provider+model.
   *
   * `true`  ⇒ a family row exists for this exact provider/model/regime (the pre-existing behaviour).
   * `false` ⇒ no row exists for this provider/model, so the SAME substantive treatment family's
   *           cross-model posterior was used instead. The shaping carrier is identical (that is what
   *           `treatmentFamilyVersion` pins); the model it was measured on is not.
   *
   * WHAT THIS DOES AND DOES NOT REACH TODAY, stated exactly because the weaker claim is the true one:
   * no rendered surface and no persisted activity event currently carries it. `activity-event.ts` has
   * only `"measured" | "family-calibrated"` for the basis, so a stored event for a cross-model estimate
   * is indistinguishable from one measured on the user's own model. What IS guaranteed: a cross-model
   * rate never claims the `measured` basis, and every rendered figure carries `est.` unconditionally.
   * Surfacing the distinction needs a field on the cross-surface event contract and is deliberately not
   * bundled here. Do not describe this as user-visible provenance until that lands.
   *
   * Absent on builds that predate the distinction, which callers must read as "unknown", never as true.
   */
  modelMatched?: boolean;
}

export interface UnavailableReduction {
  availability: "unavailable";
  /**
   * Human-readable prose. NOT a discriminant, and no consumer may parse it: it is the same field for an
   * unreadable evidence, an unmatched exact key, and a measured null, which is precisely why `state` exists.
   */
  reason: string;
  /**
   * WHICH KIND of unavailable this is (`unseeded` / `calibrating` / `measured-no-effect`), when the
   * store could be read at all. Absent ⇒ we do not even know that much, and every renderer must fail
   * closed to a plain count rather than guess between "not yet measured" and "measured, no effect".
   */
  state?: CalibrationState;
}

export type PerTurnReduction = MeasuredPerTurnReduction | FamilyCalibratedPerTurnReduction | UnavailableReduction;

/**
 * Extract the MEASURED per-turn reduction from an A/B summary, or `unavailable` with a reason. Measured
 * requires: both means present, a positive reduction, and a confidence of at least `observed_not_confirmed`
 * (i.e. provider-reported both arms + sufficiency passed). A `review_required`/`unavailable` A/B, or a
 * non-positive delta (shaping did not reduce output on this sample), yields `unavailable` - never a made-up number.
 */
export function measuredPerTurnReduction(
  summary: OutputShapingAbSummary
): MeasuredPerTurnReduction | UnavailableReduction {
  if (summary.confidence === "unavailable") {
    return { availability: "unavailable", reason: "no provider-reported A/B sample yet (both arms need provider-reported output tokens)." };
  }
  if (summary.confidence === "review_required") {
    return { availability: "unavailable", reason: "A/B needs review (a run was truncated/refused, or the shorter output did not pass short-but-sufficient) - not a saving." };
  }
  if (
    summary.outputTokensBefore === null ||
    summary.outputTokensAfter === null ||
    summary.outputTokenDelta === null ||
    summary.outputTokenReductionPct === null
  ) {
    return { availability: "unavailable", reason: "the A/B has no complete provider-reported before/after pair yet." };
  }
  if (summary.outputTokenDelta <= 0) {
    return { availability: "unavailable", reason: "on this sample shaping did not reduce mean output tokens (delta ≤ 0) - no saving to report." };
  }
  return {
    availability: "measured",
    meanControlOutputTokens: summary.outputTokensBefore,
    meanTreatmentOutputTokens: summary.outputTokensAfter,
    meanOutputTokenReduction: summary.outputTokenDelta,
    reductionPct: summary.outputTokenReductionPct,
    nControl: summary.nControl,
    nTreatment: summary.nTreatment,
    confidence: summary.confidence,
    // A single real provider-reported A/B is measured evidence (never the generic prior).
    basis: "measured"
  };
}

/**
 * A per-turn estimated-output-saved figure for the receipt line. A LOCAL ESTIMATE, NEVER billing-confirmed
 * and NEVER a per-turn %. `calibrated` says whether exact or strict family calibration backs the number:
 *  - calibrated: `tokensSaved` is a positive integer derived from the calibrated rate × this turn's output.
 *  - uncalibrated: no A/B sample (or a non-positive/undefined rate) → `tokensSaved` is undefined and the
 *    receipt line must degrade to a plain `output N`, never a fabricated count or before.
 */
export interface PerTurnEstimatedSaved {
  calibrated: boolean;
  tokensSaved?: number;
  /**
   * PROVENANCE of the rate behind `tokensSaved`, forwarded to the receipt-line formatter. Present only when
   * `calibrated`; it copies the reduction's exact or family basis. A default-prior reduction returns
   * `calibrated: false` rather than a saving to label.
   */
  basis?: CalibrationBasis;
  /**
   * The calibration LIFECYCLE, forwarded to the receipt-line formatter WHETHER OR NOT a saving exists.
   * It is the only field that survives an uncalibrated estimate, and it is what lets the line say
   * "shaping ran, the size of what it removed is unmeasured" instead of dropping the axis entirely on a
   * exact key that has no confirmed evidence. Absent ⇒ the formatter renders a plain count (fail closed).
   */
  state?: CalibrationState;
  treatmentFamilyVersion?: string;
  evidenceId?: string;
}

/**
 * Estimate the OUTPUT tokens saved on a shaped turn from an exact or family-calibrated reduction and
 * this turn's OBSERVED (post-shaping) output token count. Pure, content-free, and honest:
 *
 *  - We observe only the SHAPED output `A` for this turn. The A/B gives a mean reduction fraction
 *    `r = reductionPct / 100` = (control − treatment) / control. The implied unshaped size of a turn that
 *    shaped to `A` is `A / (1 − r)`, so the estimated saving is `A · r / (1 − r)`. This is the defensible
 *    per-turn estimate from the calibration rate — a LOCAL ESTIMATE, not an observation of this turn's
 *    counterfactual (which does not exist), and NEVER expressed as a per-turn %.
 *  - `calibrated: false` (⇒ the line renders a plain `output N`) whenever there is no compatible reduction,
 *    the rate is not a usable fraction in (0,1), or the observed output is not a positive number. No
 *    fabricated number is ever produced in that case.
 */
export function estimatePerTurnOutputSaved(
  reduction: PerTurnReduction,
  observedOutputTokens: number | undefined
): PerTurnEstimatedSaved {
  // THE LIFECYCLE SURVIVES EVERY REFUSAL BELOW. Each `calibrated: false` return means "no defensible
  // saving for this turn", and each carries the reason ONE level up: whether the compatible cohort has
  // evidence, or exact evidence measured no effect. Dropping it here is what previously forced the
  // formatter to treat those two as one, and it is the only thing the formatter can use to keep the
  // output axis visible without inventing a figure for it.
  const state = reduction.state !== undefined ? { state: reduction.state } : {};
  if (reduction.availability === "unavailable") return { calibrated: false, ...state };
  // A DEFAULT PRIOR NEVER PRODUCES A PER-RUN FIGURE, whoever hands it in. `loadCalibrationReduction` no
  // longer labels the prior `measured`, so the store path cannot reach this line at all — the gate is
  // here for every OTHER caller that builds a reduction directly, so the shipped constant is
  // unreachable as a per-turn saving through EVERY path and not only through the one that was traced.
  if (reduction.basis === "default-prior") return { calibrated: false, ...state };
  if (typeof observedOutputTokens !== "number" || !Number.isFinite(observedOutputTokens) || observedOutputTokens <= 0) {
    return { calibrated: false, ...state };
  }
  // A FAMILY rate on a single turn is a one-call run: refined by the same function a run uses, which
  // shrinks it toward the anchor at one call's weight. Exact measured rates pass through untouched.
  const ratePct = reduction.availability === "family-calibrated"
    ? refineOutputRateForRun(reduction.reductionPct, {
        shapedCallCount: 1,
        shapedOutputTokens: observedOutputTokens
      }).ratePct
    : reduction.reductionPct;
  const r = ratePct / 100;
  // A reduction fraction must be a real fraction strictly inside (0,1); r ≥ 1 would imply the control was
  // entirely removed (nonsensical for output shaping) and r ≤ 0 is not a saving.
  if (!Number.isFinite(r) || r <= 0 || r >= 1) return { calibrated: false, ...state };
  const tokensSaved = Math.round((observedOutputTokens * r) / (1 - r));
  if (tokensSaved <= 0) return { calibrated: false, ...state };
  // Carry exact-vs-family provenance to the receipt line. Reaching here it is calibrated evidence —
  // the generic prior was refused above — but it is forwarded rather than assumed, so the formatter's guard
  // has something to check and the two layers cannot drift into disagreeing about the same turn.
  return {
    calibrated: true,
    tokensSaved,
    ...(reduction.basis ? { basis: reduction.basis } : {}),
    ...(reduction.treatmentFamilyVersion
      ? { treatmentFamilyVersion: reduction.treatmentFamilyVersion }
      : {}),
    ...(reduction.evidenceId ? { evidenceId: reduction.evidenceId } : {}),
    ...state
  };
}

export interface PlanLifetimeProjection {
  availability: "measured";
  label: typeof ROUTE_A_INFERENCE_LABEL;
  /** The user-supplied plan output budget the projection is against (echoed, never invented). */
  planOutputBudgetTokens: number;
  /** Extra output tokens the plan effectively gains at the measured mean per-turn saving. */
  extendedByTokens: number;
  /** Extra turns the plan is EXTENDED BY vs the unshaped baseline: budget/treatment − budget/control. */
  extendedByTurns: number;
}

export interface UnavailableProjection {
  availability: "unavailable";
  reason: string;
}

export type PlanLifetime = PlanLifetimeProjection | UnavailableProjection;

/**
 * Project the plan-lifetime extension from a MEASURED per-turn reduction and a user-supplied plan output
 * budget. INFERENCE (Route A): `extendedByTokens = meanReduction × (budget / meanTreatmentOutput)` (the
 * number of shaped turns the budget buys, times the per-turn saving), and `extendedByTurns` is the extra
 * turns the plan is EXTENDED BY relative to the UNSHAPED baseline — `budget/treatment − budget/control`,
 * i.e. the saved tokens divided by the CONTROL mean (dividing by the treatment mean double-counts the
 * benefit and overstates the extension). Requires a positive budget and a measured reduction with a
 * positive shaped-output mean; otherwise `unavailable` (never a fabricated number).
 */
export function planLifetimeProjection(reduction: PerTurnReduction, planOutputBudgetTokens: number | undefined): PlanLifetime {
  if (planOutputBudgetTokens === undefined) {
    return { availability: "unavailable", reason: "supply your plan's output-token budget with --plan-output-budget <N> to project a plan-lifetime extension (Route A inference)." };
  }
  if (!Number.isFinite(planOutputBudgetTokens) || planOutputBudgetTokens <= 0) {
    return { availability: "unavailable", reason: "--plan-output-budget must be a positive number of output tokens." };
  }
  if (reduction.availability !== "measured" || reduction.basis === "family-calibrated") {
    return { availability: "unavailable", reason: "no measured per-turn reduction to project from (see the reduction status above)." };
  }
  if (reduction.meanTreatmentOutputTokens <= 0) {
    return { availability: "unavailable", reason: "measured shaped per-turn output is zero - cannot project turns." };
  }
  // Turns the budget buys at the SHAPED per-turn output, times the measured per-turn saving.
  const shapedTurns = planOutputBudgetTokens / reduction.meanTreatmentOutputTokens;
  const extendedByTokens = Math.round(reduction.meanOutputTokenReduction * shapedTurns);
  // Extra turns the plan is EXTENDED BY, measured against the unshaped baseline:
  // budget/treatment − budget/control (equivalently, the saved tokens divided by the CONTROL mean).
  // Dividing by the treatment mean would count the extension against the already-shaped rate and
  // overstate it, so the honest divisor is the control mean.
  const extendedByTurns = Math.round(extendedByTokens / reduction.meanControlOutputTokens);
  return {
    availability: "measured",
    label: ROUTE_A_INFERENCE_LABEL,
    planOutputBudgetTokens,
    extendedByTokens,
    extendedByTurns
  };
}

/**
 * Load the exact-first per-turn reduction for the receipt line. Precedence: (1) exact package/local
 * evidence for this carrier/provider/model/regime; (2) a package-shipped family posterior for the same
 * treatment family and regime measured on this provider+model; (3) the same family and regime measured
 * on another provider/model (`modelMatched: false`); (4) otherwise `unavailable`. Every tier requires the
 * same substantive treatment family and regime. The local store remains exact-only and activation
 * remains an exact, idempotent persistence path. Total and fail-open: absent, unreadable, or
 * incompatible evidence yields `unavailable`, never a thrown error or generic-prior figure.
 */
export type OutputCalibrationResolver = (query: OutputShapingCalibrationQuery) => PerTurnReduction;

/** Build the exact-first resolver shared by inline, statusline, watch, and run aggregation. */
export function outputCalibrationResolver(
  calibration: OutputShapingCalibration,
  familyRecords: readonly unknown[] = SHARED_OUTPUT_FAMILY_CALIBRATIONS
): OutputCalibrationResolver {
  const families = familyRecords
    .map(validateOutputShapingFamilyCalibration)
    .filter((record): record is OutputShapingFamilyCalibrationRecord => record !== undefined);
  return (query) => {
    const normalized = outputCalibrationQuery(query);
    if (!normalized) {
      return {
        availability: "unavailable",
        reason: "invalid output-shaping calibration applicability metadata.",
        state: "unseeded"
      };
    }
    const match = bestApplicableOutputCalibration(calibration, normalized);
    if (match) {
      return {
        availability: "measured",
        meanControlOutputTokens: match.meanControlOutputTokens,
        meanTreatmentOutputTokens: match.meanTreatmentOutputTokens,
        meanOutputTokenReduction: match.meanControlOutputTokens - match.meanTreatmentOutputTokens,
        reductionPct: match.rate * 100,
        nControl: match.nControl,
        nTreatment: match.nTreatment,
        confidence: "eligible_for_engine_confirmation",
        sampleCount: match.evidenceCount,
        basis: "measured",
        state: "calibrated",
        ...(match.treatmentFamilyVersion
          ? { treatmentFamilyVersion: match.treatmentFamilyVersion }
          : {}),
        evidenceId: match.evidenceId
      };
    }
    // FAMILY TIER, most specific first. Both arms require the SAME substantive treatment family — the
    // carrier bytes the evidence was produced under — so neither can borrow a rate from a different
    // shaping policy. They differ only in whether the posterior was measured on this provider+model.
    const familyCandidates = normalized.treatmentFamilyVersion
      ? families.filter((candidate) =>
          candidate.treatmentFamilyVersion === normalized.treatmentFamilyVersion &&
          candidate.regime === normalized.regime
        )
      : [];
    const modelFamily = familyCandidates.find((candidate) =>
      candidate.provider === normalized.provider && candidate.model === normalized.model
    );
    // CROSS-MODEL FALLBACK. Without this, a supported shaped run on any provider/model that has no
    // calibration row of its own resolved `unavailable` and rendered `N/A` — so every newly supported
    // frontier model needed its own calibration campaign before Compaction could show a number at all,
    // even though the shaping carrier applied to it is byte-identical to the calibrated one. The
    // posterior is the family's, not this model's, and `modelMatched: false` says so to every surface.
    // Deterministic selection: the largest-sample posterior, then the earliest evidence id, so the
    // chosen row never depends on registry ordering.
    const genericFamily = modelFamily
      ? undefined
      : [...familyCandidates]
          .sort((a, b) => b.validPairCount - a.validPairCount || a.evidenceId.localeCompare(b.evidenceId))
          .at(0);
    const family = modelFamily ?? genericFamily;
    if (family) {
      return {
        availability: "family-calibrated",
        reductionPct: family.rate * 100,
        sampleCount: family.validPairCount,
        basis: "family-calibrated",
        state: "calibrated",
        treatmentFamilyVersion: family.treatmentFamilyVersion,
        evidenceId: family.evidenceId,
        sourceEvidencePolicyVersion: family.sourceEvidencePolicyVersion,
        modelMatched: family === modelFamily
      };
    }
    return {
      availability: "unavailable",
      reason:
        "no confirmed exact calibration and no compatible treatment-family posterior matches this policy and regime.",
      state: "unseeded"
    };
  };
}

export async function loadOutputCalibrationResolver(
  env: NodeJS.ProcessEnv = process.env
): Promise<OutputCalibrationResolver> {
  const local = await loadCalibration(env);
  const localConfirmationIds = new Set(local.records.flatMap((record) => record.confirmationIds));
  let shipped = emptyCalibration(() => "1970-01-01T00:00:00.000Z");
  for (const value of SHARED_OUTPUT_CALIBRATION_CONFIRMATIONS) {
    const confirmation = validateOutputCalibrationConfirmation(value);
    if (!confirmation || localConfirmationIds.has(confirmation.confirmationId)) continue;
    shipped = foldCalibrationConfirmation(shipped, confirmation, () => confirmation.confirmedAt);
  }
  const exact = mergeOutputCalibrations(shipped, local, () => local.updatedAt);
  return outputCalibrationResolver(exact);
}

/**
 * Activate package-shipped evidence only after a caller has durably settled one positively shaped
 * run for the same exact cohort. The caller owns that settlement barrier; this helper only performs
 * exact-key validation and the existing content-free, idempotent local-store fold.
 */
export async function activateSharedOutputCalibration(
  query: OutputShapingCalibrationQuery,
  env: NodeJS.ProcessEnv = process.env,
  sharedConfirmations: readonly unknown[] = SHARED_OUTPUT_CALIBRATION_CONFIRMATIONS
): Promise<{ activated: number }> {
  const exact = outputCalibrationQuery(query);
  if (!exact) return { activated: 0 };
  let activated = 0;
  for (const value of sharedConfirmations) {
    const confirmation = validateOutputCalibrationConfirmation(value);
    if (
      !confirmation ||
      confirmation.policyVersion !== exact.policyVersion ||
      confirmation.provider !== exact.provider ||
      confirmation.model !== exact.model ||
      confirmation.regime !== exact.regime
    ) continue;
    const result = await updateCalibrationFromConfirmation(confirmation, env);
    if (result.updated) activated += 1;
  }
  return { activated };
}

export async function loadCalibrationReduction(
  env: NodeJS.ProcessEnv = process.env,
  query?: OutputShapingCalibrationQuery
): Promise<PerTurnReduction> {
  try {
    if (!query) {
      return {
        availability: "unavailable",
        reason: "no output-shaping applicability metadata was available for exact calibration matching.",
        state: "unseeded"
      };
    }
    return (await loadOutputCalibrationResolver(env))(query);
  } catch {
    return {
      availability: "unavailable",
      reason: "no applicable confirmed shaping calibration is available.",
      state: "unseeded"
    };
  }
}

/* ------------------------------------------------------------------------------------------------
 * RUN-MORPHOLOGY REFINEMENT OF A CALIBRATED RATE
 *
 * WHAT THIS FIXES. A calibrated family posterior is ONE number. Rendering it unchanged on every run
 * made the per-run figure mechanical: the same percentage appeared whether the run was twelve terse
 * tool-call turns or three long explanatory answers, which are not equally shapeable. This refines
 * that single anchor using run structure Compaction already counts, so the figure moves because the
 * RUN differs — never because randomness was added.
 *
 * ONE INPUT, output tokens per shaped call, chosen because its DIRECTION is supported by every tier of
 * labelled evidence while its MAGNITUDE is identified by none of them:
 *   - output shaping removes prose; an already-terse answer has nothing to trim (a measured 0% floor
 *     on an already-terse control), and reduction tracks unshaped verbosity across task families;
 *   - on the current-treatment paired corpus, shaped-arm visible output scale ranks positively with
 *     the realised saving in every leave-one-out subset, but improves held-out error by well under one
 *     point. The slope is therefore NOT fitted; the rails below bound how far it may move the anchor.
 *
 * DELIBERATELY NOT AN INPUT. Shaped share of calls: the aggregator applies the rate to shaped calls
 * only, so a run with many unshaped calls is already diluted exactly by arithmetic; lowering the rate
 * for the same reason would count it twice. Reasoning share and model-visible input scale (trajectory
 * length): no stable direction on the paired corpus (input scale worsens held-out error). Tool-call
 * intensity, held-turn share, structured-output posture: no run-level labelled evidence exists. They
 * are absent rather than guessed.
 *
 * HONESTY. This is an ESTIMATE of a counterfactual that was never executed: no unshaped twin of the
 * run exists. It is therefore always surfaced as an estimate, never as a measurement, and it is
 * bounded by the empirical corpus below so weak structure can never produce an extraordinary number.
 * Nothing here is content-derived: every input is an integer counter.
 *
 * DETERMINISM AND NO SELF-TRAINING. Pure arithmetic over integer counters. No RNG, no clock, no
 * persistence, no I/O. The same run data yields a byte-identical result, which is what lets a settled
 * estimate stay immutable. Nothing here writes evidence: a production run changes only its own
 * estimate. New labelled evidence enters only as a validated confirmation or family record.
 * ---------------------------------------------------------------------------------------------- */

/**
 * The valid paired output-shaping savings observations behind the rails, in percent.
 *
 * Tier 1 — the current-treatment paired corpus (N=8) the shipped family posterior was calibrated from.
 * Negative entries are real: two pairs saw output GROW under shaping. They are retained because the
 * spread is the point — a floor derived only from the wins would be a floor the evidence does not support.
 */
export const OUTPUT_SHAPING_PAIRED_CORPUS_PCT: readonly number[] = Object.freeze([
  -9.13, -2.92, 10.38, 11.53, 18.81, 23.30, 26.33, 46.35
]);

/**
 * Inclusive rails for any morphology-derived rate, as percentages: the corpus quartiles.
 *
 * Q1/Q3 rather than min/max, deliberately. The corpus max (+46.35%) is a single outlier; letting it
 * set the ceiling would mean one strong-looking feature could render a 40-60% figure off a run that
 * merely looked verbose — exactly the unconstrained extrapolation this refinement must not produce.
 * The corpus min is negative; a floor there would let weak structure render one of the corpus's
 * negative observations, which no per-run structure is evidence of. Quartiles keep the renderable
 * interval inside the region where the corpus is actually dense. Historical output A/Bs under
 * stronger, different treatments reached far higher reductions; they are not current-treatment
 * magnitude evidence and do not widen these rails.
 */
function corpusQuartiles(corpus: readonly number[]): { low: number; high: number } {
  const sorted = [...corpus].sort((a, b) => a - b);
  const half = Math.floor(sorted.length / 2);
  const median = (values: readonly number[]): number => {
    const mid = Math.floor(values.length / 2);
    const m = values.length % 2 === 0 ? (values[mid - 1]! + values[mid]!) / 2 : values[mid]!;
    return Math.round(m * 100) / 100;
  };
  // Tukey hinges: the medians of the lower and upper halves (the upper half excludes a middle value on
  // an odd count, which is why `half` is used for both slices).
  return { low: median(sorted.slice(0, half)), high: median(sorted.slice(sorted.length - half)) };
}

/** Derived from the corpus, never transcribed beside it, so a corpus edit cannot leave them stale. */
const OUTPUT_MORPHOLOGY_RAILS = corpusQuartiles(OUTPUT_SHAPING_PAIRED_CORPUS_PCT);
export const OUTPUT_MORPHOLOGY_RAIL_LOW_PCT = OUTPUT_MORPHOLOGY_RAILS.low;
export const OUTPUT_MORPHOLOGY_RAIL_HIGH_PCT = OUTPUT_MORPHOLOGY_RAILS.high;

/**
 * Output tokens per shaped provider call that span the verbosity axis. DESIGN ANCHORS, not fitted
 * values: the paired corpus is measured per workflow, not per call, so it cannot place them. They
 * bracket the per-response range of single-response output A/Bs — already-terse answers of a few dozen
 * to ~120 tokens, long explanatory answers of many hundreds. Below the low anchor a run sits on the
 * lower rail; above the high anchor on the upper rail. Interpolation is on a LOG scale because per-call
 * output spans orders of magnitude and a linear map would put almost every real run at one end.
 */
const VERBOSITY_TERSE_TOKENS_PER_CALL = 120;
const VERBOSITY_VERBOSE_TOKENS_PER_CALL = 1200;

/**
 * Smallest shaped-call count at which run structure is trusted at full weight. Below it the structural
 * signal is a handful of turns, so the result is shrunk toward the calibrated anchor rather than being
 * allowed to swing on one unusual turn.
 */
const FULL_CONFIDENCE_SHAPED_CALLS = 6;

/** Content-free run structure consumed by the refinement. Every field is a count. */
export interface OutputRunMorphology {
  /** Calls on which output shaping was durably proven active. */
  shapedCallCount: number;
  /** Provider-reported output tokens summed over the shaped calls. */
  shapedOutputTokens: number;
}

/** Why a refinement did or did not move the anchor. Fixed vocabulary, content-free, for diagnostics. */
export type OutputMorphologyBasis =
  | "anchor-only-no-shaped-calls"
  | "anchor-only-no-output-evidence"
  | "morphology-refined";

export interface RefinedOutputRate {
  /** The rate a surface should present, in percent: the anchor plus a bounded morphology offset. */
  ratePct: number;
  /** The calibrated rate this started from, in percent. */
  anchorPct: number;
  basis: OutputMorphologyBasis;
  /**
   * How far the morphology position was trusted, 0..1. `0` ⇒ the anchor was returned unchanged. This
   * is the shrinkage weight, exposed so a test can assert sparse runs fall back rather than swing.
   */
  confidence: number;
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

/** Position on the 0..1 verbosity axis for a given output-tokens-per-shaped-call figure. */
function verbosityPosition(tokensPerCall: number): number {
  if (!(tokensPerCall > 0)) return 0;
  const low = Math.log(VERBOSITY_TERSE_TOKENS_PER_CALL);
  const high = Math.log(VERBOSITY_VERBOSE_TOKENS_PER_CALL);
  return clamp((Math.log(tokensPerCall) - low) / (high - low), 0, 1);
}

/**
 * The family posterior the corpus above was calibrated into (the shipped family row whose evidence id is
 * the corpus analysis digest). It is the point the rails are expressed RELATIVE to: morphology moves any
 * resolved anchor by the same relative factor that would move this one from itself to a hinge.
 */
export const OUTPUT_MORPHOLOGY_REFERENCE_ANCHOR_PCT = 18.33079692514799;


/**
 * Refine a calibrated anchor rate with this run's structure.
 *
 * MORPHOLOGY ADJUSTS AROUND THE ANCHOR; it never replaces it. The run's verbosity position maps to a
 * relative factor `f` in [Q1/R, Q3/R] (R = reference anchor), and the run's rate is
 * `anchor · (1 + w · (f − 1))` with shrinkage weight `w`. Consequences, each pinned by tests:
 *  - with the shipped anchor the result spans exactly the Q1..Q3 hinges;
 *  - better or different family evidence moves the estimate at EVERY run size, in its own direction;
 *  - the downward move is proportional, so a positive anchor never renders as zero or negative;
 *  - the upward move never takes the rate above max(anchor, Q3): structure alone may lift a low anchor
 *    no further than the upper hinge, and never lifts any anchor above its own evidence;
 *  - a sparse run shrinks toward the anchor.
 *
 * Returns the ANCHOR UNCHANGED — never `unavailable` — whenever the run carries no usable structure.
 * That fallback is why a sparse run still gets a number instead of `N/A`. Exact measured rates never
 * reach this function (the aggregator passes them through).
 */
export function refineOutputRateForRun(
  anchorPct: number,
  morphology: OutputRunMorphology
): RefinedOutputRate {
  const anchor = anchorPct;
  const { shapedCallCount, shapedOutputTokens } = morphology;
  if (!Number.isFinite(shapedCallCount) || shapedCallCount <= 0) {
    return { ratePct: anchor, anchorPct: anchor, basis: "anchor-only-no-shaped-calls", confidence: 0 };
  }
  if (!Number.isFinite(shapedOutputTokens) || shapedOutputTokens <= 0) {
    return { ratePct: anchor, anchorPct: anchor, basis: "anchor-only-no-output-evidence", confidence: 0 };
  }

  // Output per shaped call is the shapeable-prose proxy; see the section header for why it is the only one.
  const position = verbosityPosition(shapedOutputTokens / shapedCallCount);
  const referencePositionPct =
    OUTPUT_MORPHOLOGY_RAIL_LOW_PCT +
    position * (OUTPUT_MORPHOLOGY_RAIL_HIGH_PCT - OUTPUT_MORPHOLOGY_RAIL_LOW_PCT);
  const factor = referencePositionPct / OUTPUT_MORPHOLOGY_REFERENCE_ANCHOR_PCT;

  // SHRINKAGE — a short run does not get to move far from the calibrated centre.
  const confidence = clamp(shapedCallCount / FULL_CONFIDENCE_SHAPED_CALLS, 0, 1);
  const maxUplift = Math.max(0, OUTPUT_MORPHOLOGY_RAIL_HIGH_PCT - anchor);
  const offset = Math.min(anchor * confidence * (factor - 1), maxUplift);
  return {
    ratePct: anchor + offset,
    anchorPct: anchor,
    basis: "morphology-refined",
    confidence
  };
}
