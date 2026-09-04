/**
 * Output-shaping A/B experiment record + summary (PUBLIC CLI/SDK code, engine-free, ships in the npm CLI).
 * Increment 4 of the output-shaping policy family: the
 * smallest reliable OPERATOR-RUN path to produce + ingest a real provider-reported A/B comparison between
 * a control arm (Codex live wrapper without output-shaping) and a treatment arm (with `--output-shaping`).
 *
 * Boundary / honesty (binding):
 *  - This PUBLIC module links the two arms and computes the **observed** measurement (means, delta,
 *    reduction %, N per arm) for operator visibility. It is **descriptive, NOT a savings claim.**
 *  - It NEVER produces a CONFIRMED output-savings number. `confirmedSavingsEligible` is the literal `false`
 *    here; a confirmed number can only ever be produced by the PRIVATE engine gate
 *    (`src/engine/output-shaping-verification.ts`, provider-reported A/B meeting the billing-delta
 *    criterion AND short-but-sufficient eval AND a reduction).
 *  - Output tokens that are not provider-reported (e.g. Cursor, local-estimate only) yield
 *    `confidence: "unavailable"` and can never be eligible. Missing output tokens stay unavailable, not 0.
 *  - The record is content-free: it stores token counts, the honest source, policy NAMES, operator eval
 *    outcome, and truncation/refusal flags, no prompt/response/trace content. Local artifact paths are
 *    operator-side references only.
 */
import type { TokenSource, ToolName } from "./api-client/index.js";

export const OUTPUT_SHAPING_AB_SCHEMA = "output-shaping.ab-experiment.v1" as const;
export const CAPTURE_USAGE_SIDECAR_SCHEMA = "compaction.capture-usage.v1" as const;

export const OUTPUT_SHAPING_POLICY_FAMILY = "output_shaping" as const;

/* ---------------- capture-usage sidecar (operator-side evidence, content-free) ---------------- */

/**
 * Written next to a capture artifact so a later A/B `add` can ingest the **provider-reported** tokens +
 * (treatment) policy attribution without re-running anything. Content-free: counts + source + policy names.
 */
export interface CaptureUsageSidecar {
  schema: typeof CAPTURE_USAGE_SIDECAR_SCHEMA;
  tool: ToolName;
  provider?: string;
  model?: string;
  inputTokens: number | null;
  outputTokens: number | null;
  /** True ONLY when the counts are provider-reported (never local-estimate / unavailable). */
  providerReported: boolean;
  tokenSource: TokenSource;
  /** "present" when the provider emitted a usage block; "missing" when usage was absent (never invented). */
  tokenMetadataStatus: "present" | "missing";
  /** Present on the treatment arm when an output-shaping policy was attached BEFORE generation. */
  outputShaping?: {
    policyFamily: typeof OUTPUT_SHAPING_POLICY_FAMILY;
    policyNames: string[];
    /** Exact identity of the attached model-visible policy bytes. */
    policyVersion: string;
  };
  generatedAt: string;
}

export interface BuildCaptureUsageSidecarInput {
  tool: ToolName;
  provider?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  providerReported: boolean;
  tokenSource: TokenSource;
  tokenMetadataStatus: "present" | "missing";
  policyNames?: string[];
  policyVersion?: string;
  generatedAt?: string;
}

export function buildCaptureUsageSidecar(input: BuildCaptureUsageSidecarInput): CaptureUsageSidecar {
  return {
    schema: CAPTURE_USAGE_SIDECAR_SCHEMA,
    tool: input.tool,
    ...(input.provider ? { provider: input.provider } : {}),
    ...(input.model ? { model: input.model } : {}),
    inputTokens: typeof input.inputTokens === "number" ? input.inputTokens : null,
    outputTokens: typeof input.outputTokens === "number" ? input.outputTokens : null,
    providerReported: input.providerReported,
    tokenSource: input.tokenSource,
    tokenMetadataStatus: input.tokenMetadataStatus,
    ...(input.policyNames && input.policyNames.length > 0 && input.policyVersion
      ? { outputShaping: { policyFamily: OUTPUT_SHAPING_POLICY_FAMILY, policyNames: input.policyNames, policyVersion: input.policyVersion } }
      : {}),
    generatedAt: input.generatedAt ?? new Date().toISOString()
  };
}

/* ---------------- experiment record ---------------- */

export type OutputShapingAbArm = "control" | "treatment";

export interface OutputShapingAbRun {
  arm: OutputShapingAbArm;
  /** Provider-reported output tokens; null when unavailable (never invented as 0). */
  outputTokens: number | null;
  inputTokens: number | null;
  /** True ONLY when the output tokens are provider-reported. */
  providerReported: boolean;
  tokenSource: TokenSource;
  provider?: string;
  model?: string;
  /** Treatment arm: the output-shaping policy family/names attached BEFORE generation. */
  policyFamily?: typeof OUTPUT_SHAPING_POLICY_FAMILY;
  policyNames?: string[];
  policyVersion?: string;
  /**
   * Operator/eval-recorded short-but-sufficient outcome for a TREATMENT run: did the shaped (shorter)
   * output preserve all required task-outcome markers? `null`/absent ⇒ not yet evaluated (review required).
   * The rigorous marker check is the engine eval; this is the recorded outcome.
   */
  evalMarkersPreserved?: boolean | null;
  /** Observed truncation of the answer (an incomplete answer is not a saving). */
  truncated?: boolean;
  /** Observed refusal (a refusal is not a saving). */
  refused?: boolean;
  /** Local artifact path, operator-side evidence only, never content. */
  reference?: string;
}

export interface OutputShapingAbExperiment {
  schema: typeof OUTPUT_SHAPING_AB_SCHEMA;
  experimentId: string;
  /** A short generic label of the shared task/prompt SHAPE (operator-supplied; not prompt content). */
  taskShape: string;
  createdAt: string;
  runs: OutputShapingAbRun[];
}

export interface InitOutputShapingAbInput {
  experimentId: string;
  taskShape: string;
  createdAt?: string;
}

export function initOutputShapingAbExperiment(input: InitOutputShapingAbInput): OutputShapingAbExperiment {
  return {
    schema: OUTPUT_SHAPING_AB_SCHEMA,
    experimentId: input.experimentId,
    taskShape: input.taskShape,
    createdAt: input.createdAt ?? new Date().toISOString(),
    runs: []
  };
}

export function addOutputShapingAbRun(
  experiment: OutputShapingAbExperiment,
  run: OutputShapingAbRun
): OutputShapingAbExperiment {
  return { ...experiment, runs: [...experiment.runs, run] };
}

/* ---------------- observed summary + conservative confidence ---------------- */

/**
 * Public confidence ladder. NONE of these is a confirmed savings claim.
 *  - `unavailable`                      , an arm's output tokens are not provider-reported / are missing.
 *  - `review_required`                  , truncation/refusal observed, or treatment sufficiency not a clean pass.
 *  - `observed_not_confirmed`           , provider-reported both arms, sufficiency passed, but N < 3 per arm.
 *  - `eligible_for_engine_confirmation` , all public preconditions met; the CONFIRMED verdict is an engine step.
 */
export type OutputShapingAbConfidence =
  | "unavailable"
  | "review_required"
  | "observed_not_confirmed"
  | "eligible_for_engine_confirmation";

export type OutputShapingAbEvalStatus = "pass" | "fail" | "not_evaluated" | "mixed";

export interface OutputShapingAbSummary {
  experimentId: string;
  nControl: number;
  nTreatment: number;
  /** Mean control (no-shaping) output tokens, provider-reported; null when unavailable. */
  outputTokensBefore: number | null;
  /** Mean treatment (shaped) output tokens, provider-reported; null when unavailable. */
  outputTokensAfter: number | null;
  /** before − after: positive ⇒ treatment used FEWER output tokens. OBSERVED, not a confirmed saving. */
  outputTokenDelta: number | null;
  outputTokenReductionPct: number | null;
  tokenSource: "provider-reported" | "mixed" | "local-estimate" | "unavailable";
  policyFamily: string | null;
  policyNames: string[];
  evalStatus: OutputShapingAbEvalStatus;
  confidence: OutputShapingAbConfidence;
  /** ALWAYS false in the public CLI, a confirmed savings number is produced only by the engine gate. */
  confirmedSavingsEligible: false;
  reasons: string[];
}

const MIN_RUNS_PER_ARM = 3;

function mean(xs: number[]): number {
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

function summarizeArmSource(runs: OutputShapingAbRun[]): "provider-reported" | "mixed" | "local-estimate" | "unavailable" {
  if (runs.length === 0) return "unavailable";
  const allProvider = runs.every((r) => r.providerReported && typeof r.outputTokens === "number");
  if (allProvider) return "provider-reported";
  const anyProvider = runs.some((r) => r.providerReported && typeof r.outputTokens === "number");
  if (anyProvider) return "mixed";
  const anyEstimate = runs.some((r) => r.tokenSource === "local-estimate");
  return anyEstimate ? "local-estimate" : "unavailable";
}

function treatmentEvalStatus(treatment: OutputShapingAbRun[]): OutputShapingAbEvalStatus {
  if (treatment.length === 0) return "not_evaluated";
  const outcomes = treatment.map((r) => r.evalMarkersPreserved);
  if (outcomes.some((o) => o === undefined || o === null)) {
    return outcomes.some((o) => o === true || o === false) ? "mixed" : "not_evaluated";
  }
  if (outcomes.every((o) => o === true)) return "pass";
  if (outcomes.every((o) => o === false)) return "fail";
  return "mixed";
}

/**
 * Compute the OBSERVED A/B measurement + a conservative confidence. Never confirms a saving (that is the
 * engine gate). The decision order is fail-safe: unavailable → review_required → observed_not_confirmed →
 * eligible_for_engine_confirmation. Means/delta/pct are computed only from provider-reported output tokens.
 */
export function summarizeOutputShapingAb(experiment: OutputShapingAbExperiment): OutputShapingAbSummary {
  const control = experiment.runs.filter((r) => r.arm === "control");
  const treatment = experiment.runs.filter((r) => r.arm === "treatment");
  const reasons: string[] = [];

  const controlOut = control.filter((r) => r.providerReported && typeof r.outputTokens === "number").map((r) => r.outputTokens as number);
  const treatmentOut = treatment.filter((r) => r.providerReported && typeof r.outputTokens === "number").map((r) => r.outputTokens as number);

  const bothProviderReported =
    control.length > 0 &&
    treatment.length > 0 &&
    control.every((r) => r.providerReported && typeof r.outputTokens === "number") &&
    treatment.every((r) => r.providerReported && typeof r.outputTokens === "number");

  const outputTokensBefore = controlOut.length > 0 ? mean(controlOut) : null;
  const outputTokensAfter = treatmentOut.length > 0 ? mean(treatmentOut) : null;
  const outputTokenDelta = outputTokensBefore !== null && outputTokensAfter !== null ? outputTokensBefore - outputTokensAfter : null;
  const outputTokenReductionPct =
    outputTokenDelta !== null && outputTokensBefore !== null && outputTokensBefore > 0
      ? (outputTokenDelta / outputTokensBefore) * 100
      : null;

  const controlSource = summarizeArmSource(control);
  const treatmentSource = summarizeArmSource(treatment);
  const tokenSource: OutputShapingAbSummary["tokenSource"] = bothProviderReported
    ? "provider-reported"
    : controlSource === "local-estimate" || treatmentSource === "local-estimate"
      ? "local-estimate"
      : controlSource === "mixed" || treatmentSource === "mixed"
        ? "mixed"
        : "unavailable";

  const policyNames = Array.from(new Set(treatment.flatMap((r) => r.policyNames ?? []))).sort();
  const policyFamily = treatment.some((r) => r.policyFamily) ? OUTPUT_SHAPING_POLICY_FAMILY : null;
  const evalStatus = treatmentEvalStatus(treatment);
  const anyTruncatedOrRefused = treatment.some((r) => r.truncated || r.refused) || control.some((r) => r.truncated || r.refused);

  let confidence: OutputShapingAbConfidence;
  if (!bothProviderReported) {
    confidence = "unavailable";
    reasons.push(
      "output savings unavailable: both arms must have provider-reported output tokens (local-estimate / missing output can never produce an output-savings number)."
    );
  } else if (anyTruncatedOrRefused) {
    confidence = "review_required";
    reasons.push("review required: a run was marked truncated or refused - an incomplete answer is not a saving.");
  } else if (evalStatus !== "pass") {
    confidence = "review_required";
    reasons.push(
      `review required: treatment short-but-sufficient eval status is "${evalStatus}" (a shorter-but-lossy output is not a saving; record --eval-pass/--eval-fail per treatment run).`
    );
  } else if (control.length < MIN_RUNS_PER_ARM || treatment.length < MIN_RUNS_PER_ARM) {
    confidence = "observed_not_confirmed";
    reasons.push(
      `observed, not confirmed: N ≥ ${MIN_RUNS_PER_ARM} per arm is required (have control=${control.length}, treatment=${treatment.length}). A single A/B pair is an anecdote.`
    );
  } else {
    confidence = "eligible_for_engine_confirmation";
    reasons.push(
      "eligible for engine confirmation: provider-reported both arms, N ≥ 3 per arm, sufficiency passed, no truncation/refusal. The CONFIRMED verdict is the engine gate (measured ±2·SE criterion + reduction)."
    );
  }

  return {
    experimentId: experiment.experimentId,
    nControl: control.length,
    nTreatment: treatment.length,
    outputTokensBefore,
    outputTokensAfter,
    outputTokenDelta,
    outputTokenReductionPct,
    tokenSource,
    policyFamily,
    policyNames,
    evalStatus,
    confidence,
    confirmedSavingsEligible: false,
    reasons
  };
}

/** Provider-reported output-token arrays per arm - the only honest input to the engine confirmation gate. */
export function providerReportedOutputArms(experiment: OutputShapingAbExperiment): {
  controlOutputTokens: number[];
  treatmentOutputTokens: number[];
  bothProviderReported: boolean;
} {
  const control = experiment.runs.filter((r) => r.arm === "control");
  const treatment = experiment.runs.filter((r) => r.arm === "treatment");
  const controlOutputTokens = control.filter((r) => r.providerReported && typeof r.outputTokens === "number").map((r) => r.outputTokens as number);
  const treatmentOutputTokens = treatment.filter((r) => r.providerReported && typeof r.outputTokens === "number").map((r) => r.outputTokens as number);
  const bothProviderReported =
    control.length > 0 &&
    treatment.length > 0 &&
    controlOutputTokens.length === control.length &&
    treatmentOutputTokens.length === treatment.length;
  return { controlOutputTokens, treatmentOutputTokens, bothProviderReported };
}
