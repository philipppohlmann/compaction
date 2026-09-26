/** Build one immutable, content-free, whole-run Claude Stop activity event from exact receipts. */
import { computeActivityEventId, type ActivityEvent } from "./activity-event.js";
import { claudeLogicalRunIdentity } from "./claude-logical-run-id.js";
import { buildHookOutputShapingTreatment } from "./output-shaping.js";
import { outputCalibrationQuery, type OutputShapingCalibrationQuery } from "./output-shaping-calibration-store.js";
import { estimatePerTurnOutputSaved, type OutputCalibrationResolver } from "./output-shaping-savings.js";
import type { ShapingDecisionOutcome } from "./subscription-shaping-runtime.js";
import type { GatewayReceipt, GatewayReceiptTailWindow } from "./gateway/receipt.js";
import { aggregateRun } from "./gateway/run-aggregate.js";
import { isRealApply, receiptCompactedInput } from "./gateway/receipt-line.js";
import { receiptBelongsToRun, type UserRun } from "./gateway/run-boundary.js";
import { buildRunFlowTokenReport } from "./run-flow-report.js";
import { settledRunApplyPosture, settledRunOutputEstimate } from "./settled-stop-activity.js";
import type { UsageMetadata } from "./usage-metadata.js";

export interface ClaudeTranscriptUsageBaseline {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadInputTokens: number | null;
  cacheCreationInputTokens: number | null;
  tokenSource: "provider-reported" | "local-estimate";
}

function compatibleInputPair(receipt: GatewayReceipt): boolean {
  return isRealApply(receipt) && receiptCompactedInput(receipt);
}

function exactWindowIsIncomplete(
  window: GatewayReceiptTailWindow,
  run: UserRun
): boolean {
  if (!window.truncated) return false;
  const oldestCapturedAt = window.receipts[0]?.captured_at;
  const capturedAtMs = typeof oldestCapturedAt === "string" ? Date.parse(oldestCapturedAt) : Number.NaN;
  const runStartedAtMs = Date.parse(run.started_at);
  if (
    !Number.isFinite(capturedAtMs) ||
    !Number.isFinite(runStartedAtMs) ||
    new Date(capturedAtMs).toISOString() !== oldestCapturedAt ||
    new Date(runStartedAtMs).toISOString() !== run.started_at
  ) return true;
  return capturedAtMs > runStartedAtMs;
}

function singleValue<T extends string>(values: Array<T | undefined>): T | undefined {
  const present = [...new Set(values.filter((value): value is T => typeof value === "string" && value.length > 0))];
  return present.length === 1 ? present[0] : undefined;
}

/** Exact shaped receipt cohort for a complete Claude run; incomplete or mixed metadata fails closed. */
export function claudeStopOutputCalibrationQuery(input: {
  run: UserRun;
  window: GatewayReceiptTailWindow;
}): OutputShapingCalibrationQuery | undefined {
  const receipts = input.window.receipts.filter((receipt) => receiptBelongsToRun(receipt, input.run));
  if (receipts.length === 0 || exactWindowIsIncomplete(input.window, input.run)) return undefined;
  const shaped = receipts.filter((receipt) =>
    receipt.output_shaping_state === "attached-this-pass" ||
    receipt.output_shaping_state === "already-active"
  );
  const queries = shaped.map((receipt) =>
    receipt.token_source === "provider-reported" && typeof receipt.tokens?.output === "number"
      ? outputCalibrationQuery({
          policyVersion: receipt.output_shaping_policy_version,
          provider: receipt.provider,
          model: receipt.model,
          regime: receipt.output_shaping_regime
        })
      : undefined
  );
  if (queries.length === 0 || queries.some((query) => query === undefined)) return undefined;
  const first = JSON.stringify(queries[0]);
  return queries.every((query) => JSON.stringify(query) === first) ? queries[0] : undefined;
}

export type PositiveShapingOutcome = Extract<ShapingDecisionOutcome, "shape" | "shape-basic">;

/** Exact transcript cohort; `shape-basic` deliberately has no task-aware regime. */
export function claudeTranscriptOutputCalibrationQuery(input: {
  usage: UsageMetadata;
  shapingOutcome?: PositiveShapingOutcome;
}): OutputShapingCalibrationQuery | undefined {
  if (
    !input.shapingOutcome ||
    input.usage.provider_reported_tokens !== true ||
    input.usage.provider !== "anthropic"
  ) return undefined;
  return outputCalibrationQuery({
    policyVersion: buildHookOutputShapingTreatment().policyVersion,
    provider: input.usage.provider,
    model: input.usage.model,
    ...(input.shapingOutcome === "shape" ? { regime: "default-shapeable" } : {})
  });
}

export function buildClaudeStopActivityEvent(input: {
  run: UserRun;
  window: GatewayReceiptTailWindow;
  calibrationResolver: OutputCalibrationResolver;
}): ActivityEvent | undefined {
  if (!input.run.ended_at) return undefined;
  const identity = claudeLogicalRunIdentity(input.run);
  if (!identity) return undefined;
  const receipts = input.window.receipts.filter((receipt) => receiptBelongsToRun(receipt, input.run));
  if (receipts.length === 0 || exactWindowIsIncomplete(input.window, input.run)) return undefined;

  const aggregate = aggregateRun(receipts, { outputCalibrationResolver: input.calibrationResolver });
  if (!aggregate.input && !aggregate.output) return undefined;
  const estimate = aggregate.shapedCallCount > 0
    ? settledRunOutputEstimate(aggregate, receipts, input.calibrationResolver)
    : undefined;
  const posture = settledRunApplyPosture(receipts, aggregate);
  const inputReduced = aggregate.input !== undefined && aggregate.input.after < aggregate.input.before;
  const inputUsesEstimate = receipts.some(compatibleInputPair);
  const model = singleValue(receipts.map((receipt) => receipt.model));
  const policy = aggregate.shapedCallCount > 0
    ? singleValue(receipts
        .filter((receipt) =>
          receipt.output_shaping_state === "attached-this-pass" ||
          receipt.output_shaping_state === "already-active"
        )
        .map((receipt) => receipt.output_shaping_policy_version))
    : undefined;

  const eventBase: ActivityEvent = {
    surface: "claude_code",
    provider: "anthropic",
    ...(model ? { model_label: model } : {}),
    workflow_id: "claude-stop",
    session_id: identity.sessionId,
    run_id: identity.runId,
    ...(aggregate.input ? { input_before: aggregate.input.before } : {}),
    ...(inputReduced && aggregate.input ? { input_after: aggregate.input.after } : {}),
    ...(aggregate.output ? { output_after: aggregate.output.after } : {}),
    token_source: {
      input: { source: inputUsesEstimate ? "local-estimate" : "provider-reported" },
      output: { source: "provider-reported" }
    },
    ...(policy ? { policy_used: policy } : {}),
    claim_scope: "run-scoped",
    evidence_level: "exact correlated gateway run",
    approval_status: "not-required",
    recovery: { original_retained: false },
    sync_status: "local-only",
    activity_kind: "claude-stop",
    recorded_at: input.run.ended_at,
    run_started_at: input.run.started_at,
    measurement_source: "gateway-run",
    ...(aggregate.shapedCallCount > 0 ? { output_shaping_state: "active" } : {}),
    ...(estimate?.calibrated === true && estimate.tokensSaved && estimate.basis === "measured"
      ? {
          estimated_output_tokens_saved: estimate.tokensSaved,
          output_estimate_basis: "measured",
          output_estimate_state: "calibrated"
        }
      : estimate?.state
        ? { output_estimate_state: estimate.state }
        : {}),
    ...(posture ? { apply_posture: posture } : {})
  };
  return { ...eventBase, activity_event_id: computeActivityEventId(eventBase) };
}

/**
 * Build the bounded hook-only fallback for an exact positively reconciled Claude run. The normalized
 * transcript reports cumulative session usage, not a gateway before/after basis, so this event records
 * only observed axes and labels the weaker source explicitly. It never invents input reduction or an
 * output counterfactual. Positive same-session hook evidence may prove basic shaping; a hold proves no
 * negative posture and therefore leaves the event unlabelled.
 */
export function buildClaudeTranscriptStopActivityEvent(input: {
  run: UserRun;
  usage: UsageMetadata;
  shapingOutcome?: PositiveShapingOutcome;
  calibrationResolver: OutputCalibrationResolver;
  baseline?: ClaudeTranscriptUsageBaseline;
}): ActivityEvent | undefined {
  if (!input.run.ended_at) return undefined;
  const identity = claudeLogicalRunIdentity(input.run);
  if (!identity) return undefined;

  const report = buildRunFlowTokenReport({
    tool: "claude-code",
    usage: input.usage,
    outputStatus: "present"
  });
  const currentInput = report.input_token_source !== "unavailable" ? report.input_tokens : undefined;
  const currentOutput = report.output_token_source !== "unavailable" ? report.output_tokens : undefined;
  const baselineInput = input.baseline?.inputTokens === null
    ? undefined
    : input.baseline
      ? input.baseline.inputTokens +
        (input.baseline.cacheReadInputTokens ?? 0) +
        (input.baseline.cacheCreationInputTokens ?? 0)
      : undefined;
  const baselineOutput = input.baseline?.outputTokens ?? undefined;
  const baselineSource = input.baseline?.tokenSource;
  const observedInput = input.baseline
    ? baselineSource === report.input_token_source &&
      currentInput !== undefined &&
      baselineInput !== undefined &&
      currentInput >= baselineInput
      ? currentInput - baselineInput
      : undefined
    : currentInput;
  const observedOutput = input.baseline
    ? baselineSource === report.output_token_source &&
      currentOutput !== undefined &&
      baselineOutput !== undefined &&
      currentOutput >= baselineOutput
      ? currentOutput - baselineOutput
      : undefined
    : currentOutput;
  if (observedInput === undefined && observedOutput === undefined) return undefined;
  // An output-shaping claim needs an actual observed output axis beside it. Without that axis the
  // transcript is insufficient evidence for the settled shaped result, so fail closed altogether.
  const shaped = input.shapingOutcome !== undefined;
  if (shaped && observedOutput === undefined) return undefined;
  const query = claudeTranscriptOutputCalibrationQuery(input);
  const estimate = shaped && query
    ? estimatePerTurnOutputSaved(input.calibrationResolver(query), observedOutput)
    : undefined;

  const inputAxis = observedInput === undefined
    ? {
        source: "unavailable" as const,
        unavailable_reason: "the final Claude transcript did not report cumulative input tokens"
      }
    : { source: report.input_token_source };
  const outputAxis = observedOutput === undefined
    ? {
        source: "unavailable" as const,
        unavailable_reason: "the final Claude transcript did not report cumulative output tokens"
      }
    : { source: report.output_token_source };
  const eventBase: ActivityEvent = {
    surface: "claude_code",
    provider: "anthropic",
    ...(input.usage.model ? { model_label: input.usage.model } : {}),
    workflow_id: "claude-stop",
    session_id: identity.sessionId,
    run_id: identity.runId,
    ...(observedInput !== undefined ? { input_before: observedInput } : {}),
    ...(observedOutput !== undefined ? { output_after: observedOutput } : {}),
    token_source: { input: inputAxis, output: outputAxis },
    claim_scope: input.baseline ? "run-scoped" : "workflow-scoped",
    evidence_level: input.baseline
      ? "monotonic delta from exact prior Claude session transcript usage"
      : "final normalized Claude transcript cumulative session usage",
    approval_status: "not-required",
    recovery: { original_retained: false },
    sync_status: "local-only",
    activity_kind: "claude-stop",
    recorded_at: input.run.ended_at,
    run_started_at: input.run.started_at,
    measurement_source: "claude-transcript",
    ...(shaped
      ? {
          output_shaping_state: "active" as const,
          ...(estimate?.calibrated === true && estimate.tokensSaved && estimate.basis === "measured"
            ? {
                estimated_output_tokens_saved: estimate.tokensSaved,
                output_estimate_basis: "measured" as const,
                output_estimate_state: "calibrated" as const
              }
            : { output_estimate_state: estimate?.state ?? "unseeded" as const }),
          apply_posture: "basic" as const
        }
      : {})
  };
  return { ...eventBase, activity_event_id: computeActivityEventId(eventBase) };
}
