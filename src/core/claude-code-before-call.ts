/**
 * Claude Code before-call recommendation core (public CLI/SDK core; engine-free, ships in the npm package).
 *
 * The before-call surface uses the **UserPromptSubmit** hook, which fires when the user submits a prompt,
 * BEFORE Claude processes it (payload carries `prompt`, `transcript_path`, `cwd`, `session_id`; exit 2
 * blocks the prompt before any model call). This is distinct from the Stop hook, which fires at session
 * END and cannot observe a call before it happens.
 *
 * RECOMMENDATION-ONLY, apply is impossible on this surface:
 * - No Claude Code hook can make the model receive a REDUCED/compacted context. `UserPromptSubmit` can
 *   only ADD context (`additionalContext`) or BLOCK (exit 2); there is no `updatedPrompt`/context-reduce
 *   field on any hook (`PreToolUse` rewrites TOOL input only, not the conversation; `PreCompact` can only
 *   block). Compaction cannot safely mutate what the model receives, apply is fail-closed.
 * - Hooks are NON-INTERACTIVE (stdin carries the JSON payload; there is no TTY), so ask-before-apply is
 *   impossible. There is nothing to approve because nothing can be applied.
 *
 * This module therefore only OBSERVES the pending prompt (in-process, content-free), runs the same
 * deterministic duplicate-context detector, and, when avoidable context is present, records ONE
 * metrics-only `claude_code` activity event surfacing the recommendation. The original prompt ALWAYS runs
 * UNCHANGED. This is not the Stop-hook path and makes NO before-call claim on the Stop hook.
 */
import { createHash } from "node:crypto";
import { createUsageMetadata } from "./usage-metadata.js";
import { buildRunFlowTokenReport } from "./run-flow-report.js";
import { buildRunCrossSurfaceEvent } from "./cross-surface-event.js";
import { computeActivityEventId, type ActivityEvent } from "./activity-event.js";
import { BEFORE_CALL_REDUCTION_LABEL, type AvoidableContextResult } from "./before-call.js";

/**
 * Why apply is impossible on the Claude Code before-call surface (recommendation-only). Recorded verbatim
 * on every recommendation event's caveats so no reader upgrades a recommendation into an apply claim.
 */
export const CLAUDE_CODE_BEFORE_CALL_APPLY_BLOCKER =
  "before-call APPLY is UNAVAILABLE on Claude Code hooks: no hook can make the model receive reduced " +
  "context (UserPromptSubmit can only ADD context or BLOCK - there is no updatedPrompt/context-reduce " +
  "field; PreToolUse rewrites TOOL input only; PreCompact can only block), and hooks are non-interactive " +
  "so ask-before-apply is impossible. This is RECOMMENDATION-ONLY; the original prompt runs UNCHANGED.";

/** The honest reason the OUTPUT axis is unavailable at pre-call time on the Claude Code surface. */
const OUTPUT_UNAVAILABLE_REASON =
  "no output tokens exist before the call; Claude Code reports usage only after the model responds";

/** The parsed, content-free-by-caller fields of a UserPromptSubmit hook payload. */
export interface ClaudeCodePromptHookPayload {
  /** The submitted user prompt text (analyzed IN-PROCESS; NEVER persisted). */
  prompt: string;
  /** The project working directory the hook ran in (activity is scoped under `<cwd>/.compaction`). */
  cwd?: string;
  /** The Claude Code session id (content-free identity), when present. */
  sessionId?: string;
}

/**
 * Parse the UserPromptSubmit hook JSON (from stdin). FAIL-CLOSED: returns `null` on any problem (not
 * JSON, not an object, wrong `hook_event_name`, or no string `prompt`) so a malformed payload records
 * nothing and can never break the fail-open hook. Only the fields we need are read; unknown keys ignored.
 */
export function parseUserPromptSubmitPayload(raw: string): ClaudeCodePromptHookPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const p = parsed as Record<string, unknown>;
  // If a hook_event_name is present it MUST be UserPromptSubmit (defensive against a mis-wired hook).
  if (p.hook_event_name !== undefined && p.hook_event_name !== "UserPromptSubmit") return null;
  if (typeof p.prompt !== "string") return null;
  return {
    prompt: p.prompt,
    ...(typeof p.cwd === "string" ? { cwd: p.cwd } : {}),
    ...(typeof p.session_id === "string" ? { sessionId: p.session_id } : {})
  };
}

/** A content-free, deterministic run id from the local-estimate counts (never any content). */
function contentFreeRunId(before: number, after: number): string {
  const digest = createHash("sha256").update(`before-call|claude_code|${before}|${after}`).digest("hex");
  return `before-call-claude_code-${digest.slice(0, 16)}`;
}

/**
 * Build ONE content-free `claude_code` BEFORE-CALL RECOMMENDATION activity event from the tool-agnostic
 * analysis `result`. RECOMMENDATION-ONLY in every field:
 * - input is a LOCAL-ESTIMATE (chars/4) pre-call figure; output is unavailable-with-reason (no output
 *   exists before the call). Never provider-reported, never billing-confirmed, never a saving.
 * - `approval_status: "not-required"` - nothing was applied, so nothing needed approval (and nothing
 *   COULD be approved: apply is a proven blocker on this surface).
 * - `auto_apply.applied_automatically: false` (auto-apply is OFF, structurally).
 * - `recovery.original_retained: true` - the original prompt ran UNCHANGED (never mutated).
 * - `sync_status: "local-only"`.
 * The apply blocker rides verbatim on the caveats. CONTENT-FREE: only counts/policy/labels/opaque ids.
 */
export function buildClaudeCodeBeforeCallEvent(
  result: AvoidableContextResult,
  opts: { sessionId?: string } = {}
): ActivityEvent {
  const usage = createUsageMetadata({
    inputTokens: result.input_tokens_before,
    providerReportedTokens: false,
    estimatedTokens: true,
    limitations: [BEFORE_CALL_REDUCTION_LABEL]
  });
  const tokenReport = buildRunFlowTokenReport({ tool: "claude-code", usage, outputStatus: "unavailable" });
  const base = buildRunCrossSurfaceEvent("claude_code", {
    runId: contentFreeRunId(result.input_tokens_before, result.input_tokens_after_estimate),
    tokenReport,
    reasons: { output: OUTPUT_UNAVAILABLE_REASON }
  });
  const withSession = opts.sessionId ? { ...base, session_id: opts.sessionId } : base;

  const activity: ActivityEvent = {
    ...withSession,
    // The compacted local-estimate is the pre-call INPUT AFTER figure - a recommended (un-applied)
    // local-estimate delta, never a saving, never provider-reported.
    input_after: result.input_tokens_after_estimate,
    policy_used: result.policy,
    evidence_level: result.evidence_label,
    caveats: [
      ...(base.caveats ?? []),
      "before-call RECOMMENDATION-ONLY (Claude Code UserPromptSubmit hook, a genuine PRE-call event - " +
        "NOT the post-session Stop hook): the original prompt runs UNCHANGED; nothing was applied",
      CLAUDE_CODE_BEFORE_CALL_APPLY_BLOCKER,
      "local-estimate pre-call delta (chars/4), NOT a saving / NOT provider-reported / NOT billing-confirmed"
    ],
    approval_status: "not-required",
    auto_apply: { eligible: result.has_avoidable_context, preference: "ask-each-time", applied_automatically: false },
    recovery: { original_retained: true },
    sync_status: "local-only"
  };
  return { ...activity, activity_event_id: computeActivityEventId(activity) };
}
