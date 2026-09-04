/** Build one immutable, content-free, whole-run Claude Stop activity event from exact receipts. */
import { computeActivityEventId, type ActivityEvent } from "./activity-event.js";
import { claudeLogicalRunIdentity } from "./claude-logical-run-id.js";
import type { OutputCalibrationResolver } from "./output-shaping-savings.js";
import type { GatewayReceipt, GatewayReceiptTailWindow } from "./gateway/receipt.js";
import { aggregateRun } from "./gateway/run-aggregate.js";
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
  const before = receipt.estimated_input_tokens_before;
  const after = receipt.estimated_input_tokens_after;
  if (typeof before !== "number" || typeof after !== "number") return false;
  const compacted = receipt.applied_components?.some(
    (component) => component === "lcm-compaction" || component === "deterministic-compaction"
  ) === true;
  return !(compacted && before === after);
}

function exactWindowIsIncomplete(
  window: GatewayReceiptTailWindow,
  run: UserRun,
  receipts: readonly GatewayReceipt[]
): boolean {
  if (!window.truncated) return false;
  const earliest = receipts.reduce<string | undefined>((value, receipt) => {
    const at = receipt.request_started_at ?? receipt.captured_at;
    return typeof at === "string" && (value === undefined || at < value) ? at : value;
  }, undefined);
  return earliest === undefined || earliest > run.started_at;
}

function singleValue<T extends string>(values: Array<T | undefined>): T | undefined {
  const present = [...new Set(values.filter((value): value is T => typeof value === "string" && value.length > 0))];
  return present.length === 1 ? present[0] : undefined;
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
  if (receipts.length === 0 || exactWindowIsIncomplete(input.window, input.run, receipts)) return undefined;

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
  shaped: boolean;
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
  if (input.shaped && observedOutput === undefined) return undefined;

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
    ...(input.shaped
      ? {
          output_shaping_state: "active" as const,
          output_estimate_state: "unseeded" as const,
          apply_posture: "basic" as const
        }
      : {})
  };
  return { ...eventBase, activity_event_id: computeActivityEventId(eventBase) };
}
