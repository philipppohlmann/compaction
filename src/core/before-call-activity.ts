/**
 * BEFORE-CALL → metrics-only activity BRIDGE (PUBLIC CLI/SDK code, engine-free, ships in the npm
 * package). Turns a before-call recommendation + approval outcome into ONE content-free activity event,
 * reusing the shared event model (`buildRunCrossSurfaceEvent`) and the local activity store, no new
 * store, no new schema.
 *
 * Invariants:
 * - Input is a LOCAL-ESTIMATE pre-call (chars/4); output is unavailable-with-reason pre-call for BOTH
 *   tools (provider usage does not exist until after the call). The tier table structurally rejects a
 *   provider-reported label here.
 * - CONTENT-FREE: only token COUNTS (before/after), the policy id, honest labels, and opaque ids ride
 *   on the event. No prompt/response/message text is ever read into the event.
 * - Recommendation-only default: `applied_automatically` is always the literal `false`, auto-apply is
 *   OFF (`ask-each-time`), recovery `original_retained: true`, sync `local-only`.
 */
import { createHash } from "node:crypto";
import { createUsageMetadata } from "./usage-metadata.js";
import { buildRunFlowTokenReport } from "./run-flow-report.js";
import { buildRunCrossSurfaceEvent } from "./cross-surface-event.js";
import { computeActivityEventId, type ActivityApprovalStatus, type ActivityEvent } from "./activity-event.js";
import { BEFORE_CALL_REDUCTION_LABEL, type BeforeCallRecommendation, type BeforeCallTool } from "./before-call.js";

/** The honest per-tool reason the OUTPUT axis is unavailable at pre-call time. */
const OUTPUT_UNAVAILABLE_REASON: Record<BeforeCallTool, string> = {
  codex: "no output tokens exist before the call; provider usage (turn.completed.usage) is only reported after codex runs",
  cursor: "Cursor emits no provider usage, and no output exists before the call"
};

/** A content-free, deterministic run id from the tool + local-estimate counts (never any content). */
function contentFreeRunId(tool: BeforeCallTool, before: number, after: number): string {
  const digest = createHash("sha256").update(`before-call|${tool}|${before}|${after}`).digest("hex");
  return `before-call-${tool}-${digest.slice(0, 16)}`;
}

/**
 * Build ONE content-free before-call activity event. `approvalStatus` records the approval OUTCOME
 * honestly:
 * - `"not-required"` - recommendation-only path (nothing was applied, so nothing needed approval).
 * - `"asked-approved"` (with `applied: true`) - the operator approved a whitelist-safe mutation and the
 *   compacted input was applied to this call; the original was retained locally (pass `recoveryPointer`).
 * - `"asked-declined"` - the operator was asked and declined; the original ran unchanged.
 * - `"not-asked"` (with `notAvailableReason`) - apply was NOT available (ambiguous/unsupported argv, or
 *   no interactive TTY), so we did not ask; the original ran unchanged.
 *
 * Content-free in EVERY arm: only counts, policy id, honest labels, and (when applied) a CONTENT-SAFE
 * recovery pointer (id/path, NEVER the prompt text) ride on the event. `applied_automatically` is the
 * literal `false` in every arm - an approved mutation is a MANUAL per-invocation approval, never an
 * auto-apply.
 */
export function buildBeforeCallActivityEvent(params: {
  tool: BeforeCallTool;
  recommendation: BeforeCallRecommendation;
  approvalStatus: ActivityApprovalStatus;
  /** True only for an operator-approved mutation that WAS applied to this call. */
  applied?: boolean;
  /** Content-safe recovery pointer (id/path) for an applied mutation - NEVER the prompt text. */
  recoveryPointer?: string;
  /** Content-free reason apply was not available (for the `not-asked` arm). */
  notAvailableReason?: string;
  /**
   * Which input boundary was mediated (content-free label, for the honest applied caveat):
   * - `"prompt-flag"` (default): the value of a whitelisted value-taking prompt flag (dormant for the
   *   real tools - no such flag exists).
   * - `"stdin"`: the whole stdin prompt STREAM for `codex exec`.
   */
  boundary?: "prompt-flag" | "stdin";
}): ActivityEvent {
  const { tool, recommendation, approvalStatus, applied, recoveryPointer, notAvailableReason } = params;
  const boundary = params.boundary ?? "prompt-flag";
  const usage = createUsageMetadata({
    inputTokens: recommendation.input_tokens_before,
    providerReportedTokens: false,
    estimatedTokens: true,
    limitations: [BEFORE_CALL_REDUCTION_LABEL]
  });
  const tokenReport = buildRunFlowTokenReport({ tool, usage, outputStatus: "unavailable" });
  const base = buildRunCrossSurfaceEvent(tool, {
    runId: contentFreeRunId(tool, recommendation.input_tokens_before, recommendation.input_tokens_after_estimate),
    tokenReport,
    reasons: { output: OUTPUT_UNAVAILABLE_REASON[tool] }
  });

  // Honest, content-free per-arm caveats. base.caveats already carries the reduction label.
  const appliedWhat =
    boundary === "stdin"
      ? "the compacted input replaced the stdin prompt STREAM only; every command-line argument ran unchanged"
      : "the compacted input replaced ONLY the whitelisted prompt argument - every other argument ran unchanged";
  const armCaveats: string[] = applied
    ? [
        `before-call compaction APPLIED to this call (operator-approved, per-invocation); ${appliedWhat}`,
        "the ORIGINAL input was retained LOCAL-ONLY (gitignored, never uploaded) and is recoverable via the " +
          "content-safe recovery pointer below"
      ]
    : notAvailableReason
      ? [
          `before-call apply not-available: ${notAvailableReason}`,
          "the original input ran UNCHANGED (fail-closed); this is recommendation-only for this invocation"
        ]
      : [
          "before-call recommendation-only: nothing was applied to this call; the original input ran unchanged",
          "to apply a before-call compaction, use the explicit `compaction apply-context` path"
        ];

  const activity: ActivityEvent = {
    ...base,
    // The compacted local-estimate is the pre-call INPUT AFTER figure. Realized (applied) or recommended
    // (un-applied) - either way a LOCAL-ESTIMATE delta, never a saving, never provider-reported.
    input_after: recommendation.input_tokens_after_estimate,
    policy_used: recommendation.policy,
    evidence_level: recommendation.evidence_label,
    caveats: [...(base.caveats ?? []), ...armCaveats],
    approval_status: approvalStatus,
    auto_apply: {
      // Eligible reflects whether there was avoidable context - but auto-apply stays OFF regardless.
      // Even an approved mutation is applied_automatically:false (a manual per-invocation approval).
      eligible: recommendation.has_avoidable_context,
      preference: "ask-each-time",
      applied_automatically: false
    },
    recovery: recoveryPointer ? { original_retained: true, location: recoveryPointer } : { original_retained: true },
    sync_status: "local-only"
  };
  return { ...activity, activity_event_id: computeActivityEventId(activity) };
}
