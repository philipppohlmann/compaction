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
import { calibratedRate, loadCalibration, type CalibrationBasis } from "./output-shaping-calibration-store.js";

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
   * How many distinct A/B experiments back this rate when it came from the LEARNING calibration store (so a
   * reader never over-trusts a 1-sample rate). Absent when the reduction came directly from a single A/B
   * summary (`measuredPerTurnReduction`), which is inherently one experiment.
   */
  sampleCount?: number;
  /**
   * PROVENANCE of the reduction RATE, carried so the per-turn line can label the output arrow honestly
   * (G7, 2026-08-04). `"measured"` ⇒ this device's OWN A/B (single summary or folded store); `"default-prior"`
   * ⇒ the shipped 0.47 starting rate no experiment on this device backs yet. A default prior must NEVER
   * render as measured evidence, so this rides all the way to the receipt-line formatter — the magnitude is
   * unchanged, only the label differs. Absent ⇒ treated as a generic estimate (`est.`), never as a prior.
   */
  basis?: CalibrationBasis;
}

export interface UnavailableReduction {
  availability: "unavailable";
  reason: string;
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
    // A single real provider-reported A/B is this device's OWN measurement (never the shipped prior).
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
   * PROVENANCE of the rate behind `tokensSaved`, forwarded to the receipt-line formatter so the output
   * arrow's label distinguishes a device measurement from the shipped default prior (G7). Present only when
   * `calibrated`; it copies the reduction's `basis`. Never changes the magnitude — only the label.
   */
  basis?: CalibrationBasis;
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
  if (reduction.availability !== "measured") return { calibrated: false };
  if (typeof observedOutputTokens !== "number" || !Number.isFinite(observedOutputTokens) || observedOutputTokens <= 0) {
    return { calibrated: false };
  }
  const r = reduction.reductionPct / 100;
  // A reduction fraction must be a real fraction strictly inside (0,1); r ≥ 1 would imply the control was
  // entirely removed (nonsensical for output shaping) and r ≤ 0 is not a saving.
  if (!Number.isFinite(r) || r <= 0 || r >= 1) return { calibrated: false };
  const tokensSaved = Math.round((observedOutputTokens * r) / (1 - r));
  if (tokensSaved <= 0) return { calibrated: false };
  // Carry the rate's provenance so the receipt line can label the arrow (`est.` vs `est. · default prior`).
  // The magnitude is identical either way; only the label differs.
  return { calibrated: true, tokensSaved, ...(reduction.basis ? { basis: reduction.basis } : {}) };
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
  // overstate it (a 40-turn real extension would read as 67), so the honest divisor is the control mean.
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
 * Load the current MEASURED per-turn reduction from the LEARNING calibration store, for the receipt line's
 * estimated-output-saved clause. The store (`output-shaping-calibration-store.ts`) accumulates real,
 * provider-reported A/B measurements fed in by `compaction savings`; its running sample-weighted rate is
 * what this returns. Total and fail-open: an absent / unreadable / uncalibrated store yields an
 * `unavailable` reduction (⇒ the line degrades to a plain `output N`), NEVER a thrown error and NEVER a
 * fabricated rate. The `sampleCount` rides on the measured result so a reader never over-trusts a 1-sample
 * rate. Content-free: the store holds only aggregate counts + rates (no request bytes).
 */
export async function loadCalibrationReduction(env: NodeJS.ProcessEnv = process.env): Promise<PerTurnReduction> {
  try {
    const calibration = await loadCalibration(env);
    const rate = calibratedRate(calibration);
    if (!rate.calibrated || rate.rate === undefined) {
      return { availability: "unavailable", reason: "no measured output-shaping A/B sample in the calibration store yet." };
    }
    // THE DEFAULT PRIOR (no fold yet). The rate is real and shipped, but the aggregate behind it is
    // empty — so the accumulated totals are genuinely zero and must not be dressed up as this device's
    // means. Only `reductionPct` reaches the per-turn line (`estimatePerTurnOutputSaved` uses nothing
    // else), so the honest shape here is the rate plus zeroed denominators and a confidence that says
    // no experiment backs it yet. The first real A/B replaces this wholesale.
    if (rate.basis === "default-prior") {
      return {
        availability: "measured",
        meanControlOutputTokens: 0,
        meanTreatmentOutputTokens: 0,
        meanOutputTokenReduction: 0,
        reductionPct: rate.rate * 100,
        nControl: 0,
        nTreatment: 0,
        confidence: "unavailable",
        sampleCount: 0,
        // The rate is the shipped starting prior, not this device's measurement — the label must say so.
        basis: "default-prior"
      };
    }
    return {
      availability: "measured",
      // The store carries aggregate control/treatment totals, not per-arm means; the receipt line's estimate
      // needs only the reduction FRACTION, so surface it as the reductionPct and the accumulated totals as
      // the means (weighted). Denominators are the cumulative provider-reported turns behind the rate.
      meanControlOutputTokens: calibration.totalControlOutputTokens,
      meanTreatmentOutputTokens: calibration.totalTreatmentOutputTokens,
      meanOutputTokenReduction: calibration.totalControlOutputTokens - calibration.totalTreatmentOutputTokens,
      reductionPct: rate.rate * 100,
      nControl: rate.totalTurns,
      nTreatment: rate.totalTurns,
      confidence: rate.sampleCount >= 1 ? "observed_not_confirmed" : "unavailable",
      sampleCount: rate.sampleCount,
      // This device's own folded A/B measurement (the prior has been displaced) — a calibrated `est.`.
      basis: "measured"
    };
  } catch {
    return { availability: "unavailable", reason: "no local shaping calibration store yet." };
  }
}
