/**
 * Input-compaction A/B experiment record + summary (PUBLIC CLI/SDK code, engine-free, ships in the npm CLI).
 * The INPUT-side twin of
 * `output-shaping-ab.ts`: links a control arm (full input context) and a treatment arm (Compaction-compacted
 * input context) of Codex runs and reports the **observed provider-reported INPUT-token delta**, gated for a
 * confirmed claim on a **context-preservation** eval, NOT the output short-but-sufficient eval.
 *
 * Boundary / honesty (binding):
 *  - This PUBLIC module computes the **observed** input-token measurement for operator visibility. It NEVER
 *    produces a CONFIRMED input-savings number, `confirmedSavingsEligible` is the literal `false`. A confirmed
 *    number is produced solely by the PRIVATE engine gate (`src/engine/input-compaction-verification.ts`).
 *  - **Input eval ≠ output eval.** Input requires context-preservation: task-critical context preserved,
 *    source recoverability, instruction/commitment preservation, no material loss, and the treatment output
 *    still solves the same task. Reusing the output short-but-sufficient eval here would be a bug.
 *  - Input tokens that are not provider-reported (e.g. Cursor) → `unavailable`; can never be eligible.
 *  - Missing usage stays null, never 0. Token source preserved exactly. Content-free (counts + flags + ids).
 *  - Output-token delta is kept **observable but secondary**, never the primary claim for this input gate.
 */
import type { TokenSource } from "./api-client/index.js";
import type { CaptureUsageSidecar } from "./output-shaping-ab.js";

export const INPUT_COMPACTION_AB_SCHEMA = "input-compaction.ab-experiment.v1" as const;

export type InputCompactionAbArm = "control" | "treatment";

/** Tri-state per-treatment outcome: true = passed, false = failed, null/undefined = not evaluated. */
export type EvalOutcome = boolean | null;

export interface InputCompactionAbRun {
  arm: InputCompactionAbArm;
  /** Provider-reported INPUT tokens; null when unavailable (never invented as 0). */
  inputTokens: number | null;
  /** Provider-reported OUTPUT tokens (observed, secondary, not the input claim). */
  outputTokens: number | null;
  providerReported: boolean;
  tokenSource: TokenSource;
  /* ---- treatment-only context-preservation outcome fields (control arm leaves these undefined) ---- */
  /** Task-critical context preserved (overall operator/eval judgment). */
  contextPreserved?: EvalOutcome;
  /** The treatment output still solves the same task. */
  taskSolved?: EvalOutcome;
  /** Source recoverability preserved (from `compact --eval` recoverability). */
  sourceRecoverability?: EvalOutcome;
  /** Instruction/commitment preservation (from `compact --eval` commitment-preservation). */
  commitmentPreservation?: EvalOutcome;
  /** No material context loss. */
  noMaterialLoss?: EvalOutcome;
  /** Semantic/meaning preservation is NOT scored in v1 (D4), always `not_evaluated`. */
  semanticEval: "not_evaluated";
  reference?: string;
}

export interface InputCompactionAbExperiment {
  schema: typeof INPUT_COMPACTION_AB_SCHEMA;
  experimentId: string;
  /** Short generic label of the shared task/context SHAPE (not prompt content). */
  taskShape: string;
  createdAt: string;
  runs: InputCompactionAbRun[];
}

export interface InitInputCompactionAbInput {
  experimentId: string;
  taskShape: string;
  createdAt?: string;
}

export function initInputCompactionAbExperiment(input: InitInputCompactionAbInput): InputCompactionAbExperiment {
  return {
    schema: INPUT_COMPACTION_AB_SCHEMA,
    experimentId: input.experimentId,
    taskShape: input.taskShape,
    createdAt: input.createdAt ?? new Date().toISOString(),
    runs: []
  };
}

export function addInputCompactionAbRun(
  experiment: InputCompactionAbExperiment,
  run: InputCompactionAbRun
): InputCompactionAbExperiment {
  return { ...experiment, runs: [...experiment.runs, run] };
}

/** Build a treatment run from a capture-usage sidecar + the recorded context-preservation outcome. */
export interface TreatmentOutcomeInput {
  contextPreserved?: EvalOutcome;
  taskSolved?: EvalOutcome;
  sourceRecoverability?: EvalOutcome;
  commitmentPreservation?: EvalOutcome;
  noMaterialLoss?: EvalOutcome;
}

export function runFromSidecar(
  arm: InputCompactionAbArm,
  sidecar: CaptureUsageSidecar,
  outcome: TreatmentOutcomeInput = {},
  reference?: string
): InputCompactionAbRun {
  const base: InputCompactionAbRun = {
    arm,
    inputTokens: sidecar.inputTokens,
    outputTokens: sidecar.outputTokens,
    providerReported: sidecar.providerReported === true,
    tokenSource: sidecar.tokenSource,
    semanticEval: "not_evaluated",
    ...(reference ? { reference } : {})
  };
  if (arm !== "treatment") return base;
  return {
    ...base,
    contextPreserved: outcome.contextPreserved ?? null,
    taskSolved: outcome.taskSolved ?? null,
    sourceRecoverability: outcome.sourceRecoverability ?? null,
    commitmentPreservation: outcome.commitmentPreservation ?? null,
    noMaterialLoss: outcome.noMaterialLoss ?? null
  };
}

/* ---------------- observed summary + conservative confidence ---------------- */

export type InputCompactionAbConfidence =
  | "unavailable"
  | "review_required"
  | "observed_not_confirmed"
  | "eligible_for_engine_confirmation";

/** Context-preservation rollup for the treatment arm. `pass` only if ALL required checks passed. */
export type ContextPreservationStatus = "pass" | "fail" | "not_evaluated" | "mixed";

export interface InputCompactionAbSummary {
  experimentId: string;
  nControl: number;
  nTreatment: number;
  /** Mean control (full-context) INPUT tokens, provider-reported; null when unavailable. */
  inputTokensBefore: number | null;
  /** Mean treatment (compacted-context) INPUT tokens, provider-reported; null when unavailable. */
  inputTokensAfter: number | null;
  /** before − after: positive ⇒ treatment used FEWER input tokens. OBSERVED, not confirmed. */
  inputTokenDelta: number | null;
  inputTokenReductionPct: number | null;
  /** OBSERVED output-token delta (secondary; never the input claim). */
  outputTokensBefore: number | null;
  outputTokensAfter: number | null;
  outputTokenDelta: number | null;
  tokenSource: "provider-reported" | "mixed" | "local-estimate" | "unavailable";
  /** Context-preservation rollup across treatment runs (the INPUT eval, NOT short-but-sufficient). */
  contextPreservation: ContextPreservationStatus;
  semanticEval: "not_evaluated";
  confidence: InputCompactionAbConfidence;
  /** ALWAYS false in the public CLI, a confirmed input-savings number is produced only by the engine gate. */
  confirmedSavingsEligible: false;
  reasons: string[];
}

const MIN_RUNS_PER_ARM = 3;
const REQUIRED_CHECKS: (keyof InputCompactionAbRun)[] = [
  "contextPreserved",
  "taskSolved",
  "sourceRecoverability",
  "commitmentPreservation",
  "noMaterialLoss"
];

function mean(xs: number[]): number {
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

function meanOrNull(xs: number[]): number | null {
  return xs.length > 0 ? mean(xs) : null;
}

function armSource(runs: InputCompactionAbRun[]): "provider-reported" | "mixed" | "local-estimate" | "unavailable" {
  if (runs.length === 0) return "unavailable";
  if (runs.every((r) => r.providerReported && typeof r.inputTokens === "number")) return "provider-reported";
  if (runs.some((r) => r.providerReported && typeof r.inputTokens === "number")) return "mixed";
  return runs.some((r) => r.tokenSource === "local-estimate") ? "local-estimate" : "unavailable";
}

/** Roll up the treatment arm's context-preservation checks. `pass` only if every required check is true. */
export function treatmentContextPreservation(treatment: InputCompactionAbRun[]): ContextPreservationStatus {
  if (treatment.length === 0) return "not_evaluated";
  const values: EvalOutcome[] = [];
  for (const r of treatment) for (const k of REQUIRED_CHECKS) values.push((r[k] as EvalOutcome) ?? null);
  if (values.some((v) => v === undefined || v === null)) {
    return values.some((v) => v === true || v === false) ? "mixed" : "not_evaluated";
  }
  if (values.every((v) => v === true)) return "pass";
  if (values.every((v) => v === false)) return "fail";
  return "mixed";
}

/**
 * Observed input-compaction A/B + a conservative confidence. NEVER confirms a saving (engine gate does).
 * Decision order is fail-safe: unavailable → review_required → observed_not_confirmed →
 * eligible_for_engine_confirmation. Input means/delta come ONLY from provider-reported input tokens.
 */
export function summarizeInputCompactionAb(experiment: InputCompactionAbExperiment): InputCompactionAbSummary {
  const control = experiment.runs.filter((r) => r.arm === "control");
  const treatment = experiment.runs.filter((r) => r.arm === "treatment");
  const reasons: string[] = [];

  const controlIn = control.filter((r) => r.providerReported && typeof r.inputTokens === "number").map((r) => r.inputTokens as number);
  const treatmentIn = treatment.filter((r) => r.providerReported && typeof r.inputTokens === "number").map((r) => r.inputTokens as number);
  const controlOut = control.filter((r) => typeof r.outputTokens === "number").map((r) => r.outputTokens as number);
  const treatmentOut = treatment.filter((r) => typeof r.outputTokens === "number").map((r) => r.outputTokens as number);

  const bothProviderReported =
    control.length > 0 &&
    treatment.length > 0 &&
    control.every((r) => r.providerReported && typeof r.inputTokens === "number") &&
    treatment.every((r) => r.providerReported && typeof r.inputTokens === "number");

  const inputTokensBefore = meanOrNull(controlIn);
  const inputTokensAfter = meanOrNull(treatmentIn);
  const inputTokenDelta = inputTokensBefore !== null && inputTokensAfter !== null ? inputTokensBefore - inputTokensAfter : null;
  const inputTokenReductionPct =
    inputTokenDelta !== null && inputTokensBefore !== null && inputTokensBefore > 0 ? (inputTokenDelta / inputTokensBefore) * 100 : null;

  const outputTokensBefore = meanOrNull(controlOut);
  const outputTokensAfter = meanOrNull(treatmentOut);
  const outputTokenDelta = outputTokensBefore !== null && outputTokensAfter !== null ? outputTokensBefore - outputTokensAfter : null;

  const cSrc = armSource(control);
  const tSrc = armSource(treatment);
  const tokenSource: InputCompactionAbSummary["tokenSource"] = bothProviderReported
    ? "provider-reported"
    : cSrc === "local-estimate" || tSrc === "local-estimate"
      ? "local-estimate"
      : cSrc === "mixed" || tSrc === "mixed"
        ? "mixed"
        : "unavailable";

  const contextPreservation = treatmentContextPreservation(treatment);

  let confidence: InputCompactionAbConfidence;
  if (!bothProviderReported) {
    confidence = "unavailable";
    reasons.push(
      "input savings unavailable: both arms must have provider-reported INPUT tokens (local-estimate / missing input can never produce an input-savings number)."
    );
  } else if (contextPreservation !== "pass") {
    confidence = "review_required";
    reasons.push(
      `review required: treatment context-preservation status is "${contextPreservation}" - confirmation requires task-critical context preserved + source recoverability + commitment preservation + no material loss + treatment-solves-task (record each per treatment run).`
    );
  } else if (control.length < MIN_RUNS_PER_ARM || treatment.length < MIN_RUNS_PER_ARM) {
    confidence = "observed_not_confirmed";
    reasons.push(
      `observed, not confirmed: N ≥ ${MIN_RUNS_PER_ARM} per arm is required (have control=${control.length}, treatment=${treatment.length}).`
    );
  } else {
    confidence = "eligible_for_engine_confirmation";
    reasons.push(
      "eligible for engine confirmation: provider-reported both arms, N ≥ 3 per arm, context-preservation passed (incl. task-solved). The CONFIRMED verdict is the engine gate (measured ±2·SE criterion + reduction)."
    );
  }
  reasons.push("note: semantic/meaning preservation is not_evaluated (v1); output-token delta is observed-only, not the input claim.");

  return {
    experimentId: experiment.experimentId,
    nControl: control.length,
    nTreatment: treatment.length,
    inputTokensBefore,
    inputTokensAfter,
    inputTokenDelta,
    inputTokenReductionPct,
    outputTokensBefore,
    outputTokensAfter,
    outputTokenDelta,
    tokenSource,
    contextPreservation,
    semanticEval: "not_evaluated",
    confidence,
    confirmedSavingsEligible: false,
    reasons
  };
}

/** Provider-reported INPUT-token arrays per arm - the only honest input to the engine confirmation gate. */
export function providerReportedInputArms(experiment: InputCompactionAbExperiment): {
  controlInputTokens: number[];
  treatmentInputTokens: number[];
  bothProviderReported: boolean;
} {
  const control = experiment.runs.filter((r) => r.arm === "control");
  const treatment = experiment.runs.filter((r) => r.arm === "treatment");
  const controlInputTokens = control.filter((r) => r.providerReported && typeof r.inputTokens === "number").map((r) => r.inputTokens as number);
  const treatmentInputTokens = treatment.filter((r) => r.providerReported && typeof r.inputTokens === "number").map((r) => r.inputTokens as number);
  const bothProviderReported =
    control.length > 0 &&
    treatment.length > 0 &&
    controlInputTokens.length === control.length &&
    treatmentInputTokens.length === treatment.length;
  return { controlInputTokens, treatmentInputTokens, bothProviderReported };
}
