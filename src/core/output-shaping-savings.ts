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
  loadCalibration,
  outputCalibrationQuery,
  updateCalibrationFromConfirmation,
  validateOutputCalibrationConfirmation,
  type OutputShapingCalibration,
  type OutputShapingCalibrationQuery,
  type CalibrationBasis,
  type CalibrationState
} from "./output-shaping-calibration-store.js";
import { SHARED_OUTPUT_CALIBRATION_CONFIRMATIONS } from "./output-shaping-shared-calibration-registry.js";

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
   * PROVENANCE of the reduction RATE. `"measured"` ⇒ confirmed exact-key empirical evidence (a
   * direct A/B summary, the package-shipped registry, or the local additive store); `"default-prior"`
   * ⇒ the internal generic starting rate, which no user-facing calibration path may consume.
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

export type PerTurnReduction = MeasuredPerTurnReduction | UnavailableReduction;

/**
 * Extract the MEASURED per-turn reduction from an A/B summary, or `unavailable` with a reason. Measured
 * requires: both means present, a positive reduction, and a confidence of at least `observed_not_confirmed`
 * (i.e. provider-reported both arms + sufficiency passed). A `review_required`/`unavailable` A/B, or a
 * non-positive delta (shaping did not reduce output on this sample), yields `unavailable` - never a made-up number.
 */
export function measuredPerTurnReduction(summary: OutputShapingAbSummary): PerTurnReduction {
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
 * and NEVER a per-turn %. `calibrated` says whether a real A/B reduction rate backs the number:
 *  - calibrated: `tokensSaved` is a positive integer derived from the measured rate × this turn's output.
 *  - uncalibrated: no A/B sample (or a non-positive/undefined rate) → `tokensSaved` is undefined and the
 *    receipt line must degrade to a plain `output N`, never a fabricated count or before.
 */
export interface PerTurnEstimatedSaved {
  calibrated: boolean;
  tokensSaved?: number;
  /**
   * PROVENANCE of the rate behind `tokensSaved`, forwarded to the receipt-line formatter. Present only when
   * `calibrated`; it copies the reduction's `basis`, and on this type that is always `"measured"` — a
   * default-prior reduction returns `calibrated: false` above rather than a saving to label.
   */
  basis?: CalibrationBasis;
  /**
   * The calibration LIFECYCLE, forwarded to the receipt-line formatter WHETHER OR NOT a saving exists.
   * It is the only field that survives an uncalibrated estimate, and it is what lets the line say
   * "shaping ran, the size of what it removed is unmeasured" instead of dropping the axis entirely on a
   * exact key that has no confirmed evidence. Absent ⇒ the formatter renders a plain count (fail closed).
   */
  state?: CalibrationState;
}

/**
 * Estimate the OUTPUT tokens saved on a single shaped turn from the MEASURED A/B per-turn reduction and
 * this turn's OBSERVED (post-shaping) output token count. Pure, content-free, and honest:
 *
 *  - We observe only the SHAPED output `A` for this turn. The A/B gives a mean reduction fraction
 *    `r = reductionPct / 100` = (control − treatment) / control. The implied unshaped size of a turn that
 *    shaped to `A` is `A / (1 − r)`, so the estimated saving is `A · r / (1 − r)`. This is the defensible
 *    per-turn estimate from the calibration rate — a LOCAL ESTIMATE, not an observation of this turn's
 *    counterfactual (which does not exist), and NEVER expressed as a per-turn %.
 *  - `calibrated: false` (⇒ the line renders a plain `output N`) whenever there is no measured reduction,
 *    the rate is not a usable fraction in (0,1), or the observed output is not a positive number. No
 *    fabricated number is ever produced in that case.
 */
export function estimatePerTurnOutputSaved(
  reduction: PerTurnReduction,
  observedOutputTokens: number | undefined
): PerTurnEstimatedSaved {
  // THE LIFECYCLE SURVIVES EVERY REFUSAL BELOW. Each `calibrated: false` return means "no defensible
  // saving for this turn", and each carries the reason ONE level up: whether the exact cohort has yet to
  // measure, or has measured and found nothing. Dropping it here is what previously forced the
  // formatter to treat those two as one, and it is the only thing the formatter can use to keep the
  // output axis visible without inventing a figure for it.
  const state = reduction.state !== undefined ? { state: reduction.state } : {};
  if (reduction.availability !== "measured") return { calibrated: false, ...state };
  // A DEFAULT PRIOR NEVER PRODUCES A PER-RUN FIGURE, whoever hands it in. `loadCalibrationReduction` no
  // longer labels the prior `measured`, so the store path cannot reach this line at all — the gate is
  // here for every OTHER caller that builds a reduction directly, so the shipped constant is
  // unreachable as a per-turn saving through EVERY path and not only through the one that was traced.
  if (reduction.basis === "default-prior") return { calibrated: false, ...state };
  if (typeof observedOutputTokens !== "number" || !Number.isFinite(observedOutputTokens) || observedOutputTokens <= 0) {
    return { calibrated: false, ...state };
  }
  const r = reduction.reductionPct / 100;
  // A reduction fraction must be a real fraction strictly inside (0,1); r ≥ 1 would imply the control was
  // entirely removed (nonsensical for output shaping) and r ≤ 0 is not a saving.
  if (!Number.isFinite(r) || r <= 0 || r >= 1) return { calibrated: false, ...state };
  const tokensSaved = Math.round((observedOutputTokens * r) / (1 - r));
  if (tokensSaved <= 0) return { calibrated: false, ...state };
  // Carry the rate's provenance to the receipt line. Reaching here it is always confirmed measurement —
  // a prior was refused above — but it is forwarded rather than assumed, so the formatter's own guard
  // has something to check and the two layers cannot drift into disagreeing about the same turn.
  return { calibrated: true, tokensSaved, ...(reduction.basis ? { basis: reduction.basis } : {}), ...state };
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
  if (reduction.availability !== "measured") {
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
 * Load the current MEASURED per-turn reduction from the activated local calibration store, for the receipt line's
 * estimated-output-saved clause. MEASURED is meant literally: an exact key with no confirmed experiment gets
 * `unavailable`, not the generic starting prior dressed as evidence. Package-shipped confirmations stay
 * inert until a matching positively shaped run crosses its authoritative durable-settlement barrier and
 * activates them into the content-free local store. The store contains only engine-confirmed,
 * provider-reported A/B measurements admitted by the private confirmation gate; its running
 * experiment-weighted rate is what this returns. Total and fail-open: an absent / unreadable /
 * uncalibrated store yields an
 * `unavailable` reduction (⇒ the line degrades to a plain `output N`), NEVER a thrown error and NEVER a
 * fabricated rate. The `sampleCount` rides on the measured result so a reader never over-trusts a 1-sample
 * rate. Content-free: the store holds only aggregate counts + rates (no request bytes).
 */
export type OutputCalibrationResolver = (query: OutputShapingCalibrationQuery) => PerTurnReduction;

/** Build the one exact-match resolver shared by inline, statusline, watch, and run aggregation. */
export function outputCalibrationResolver(calibration: OutputShapingCalibration): OutputCalibrationResolver {
  return (query) => {
    const match = bestApplicableOutputCalibration(calibration, query);
    if (!match) {
      return {
        availability: "unavailable",
        reason: "no confirmed output-shaping calibration exactly matches this policy, provider, model, and regime.",
        state: "unseeded"
      };
    }
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
      state: "calibrated"
    };
  };
}

export async function loadOutputCalibrationResolver(
  env: NodeJS.ProcessEnv = process.env
): Promise<OutputCalibrationResolver> {
  return outputCalibrationResolver(await loadCalibration(env));
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
