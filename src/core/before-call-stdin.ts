/**
 * BEFORE-CALL STDIN-BOUNDARY apply PLANNER (PUBLIC CLI/SDK code, engine-free, ships in the npm
 * package). The argv route is blocked (Codex + Cursor take bare positional prompts; no value-taking
 * prompt flag to rewrite), so the mediated boundary is stdin: Codex `exec` documents a first-class stdin
 * prompt path ("if not provided as an argument (or if `-` is used), instructions are read from stdin"),
 * so when the invocation is `codex exec [flags]` with NO positional prompt (or a lone `-`), the WHOLE
 * stdin stream IS the prompt, an explicit, unambiguous boundary.
 *
 * This module is a PURE decision planner: given the argv, the buffered stdin content, whether a terminal
 * is available to ask on, and an injectable `decide` callback (the `[y/n/v]` approval), it returns what
 * the shim should feed the real tool (`compacted` or the `original` stdin) plus the honest activity
 * outcome. It performs NO terminal I/O, NO file I/O, and NO retention, the command wraps those so the
 * fail-closed retention rule ("if the original cannot be retained, do NOT apply") stays enforced in one
 * place and this planner stays trivially testable.
 *
 * FAIL-CLOSED (binding): the plan emits `compacted` ONLY when the stdin boundary is provably safe (Codex
 * `exec`, stdin is the sole prompt), there is avoidable context, a terminal is available, AND `decide`
 * returns `"apply"`. Every other path emits the ORIGINAL stdin unchanged. No auto-apply, no default yes.
 */
import {
  analyzeBeforeCall,
  resolveStdinPromptBoundary,
  type BeforeCallRecommendation,
  type BeforeCallTool,
  type StdinPromptBoundary
} from "./before-call.js";
import type { ActivityApprovalStatus } from "./activity-event.js";

/** The approval decision the planner asks for (kept local to avoid a cycle with the precall command). */
export type StdinApplyChoice = "apply" | "decline";

export interface StdinApplyPlan {
  /** The stdin-boundary safety result (Codex `exec`, stdin is the sole prompt → safe). */
  boundary: StdinPromptBoundary;
  /** The content-free recommendation, present ONLY when the boundary was safe (so stdin was analyzed). */
  recommendation?: BeforeCallRecommendation;
  /** What the shim should feed the real tool. `compacted` ONLY after an explicit approval. */
  emit: "compacted" | "original";
  /** The compacted stdin, present ONLY when `emit === "compacted"`. Never persisted to activity. */
  compacted?: string;
  /** Honest approval outcome for the activity event. */
  approvalStatus: ActivityApprovalStatus;
  /** True ONLY for an operator-approved compaction that will be applied to this call. */
  applied: boolean;
  /** Content-free reason apply was not offered/available (for the honest not-asked arm). */
  notAvailableReason?: string;
  /** Whether the caller should record ONE activity event (true only when there is something honest to log). */
  record: boolean;
}

/**
 * Plan the stdin-boundary before-call apply decision. Pure + fully injectable:
 * - `interactive` is TRUE only when a terminal is available to ask on (the shim passes `[ -t 1 ]`;
 *   stdin is intentionally piped here, so interactivity is about the terminal, not stdin).
 * - `decide(rec)` runs the `[y/n/v]` approval (the command drives it over `/dev/tty`; tests inject it).
 *
 * The planner NEVER applies without a safe boundary + avoidable context + a terminal + an explicit
 * `"apply"`. Retention of the original is the COMMAND's responsibility (fail-closed if it fails).
 */
export function planStdinApply(params: {
  tool: BeforeCallTool;
  argv: string[];
  stdinContent: string;
  interactive: boolean;
  decide: (rec: BeforeCallRecommendation) => StdinApplyChoice;
}): StdinApplyPlan {
  const { tool, argv, stdinContent, interactive, decide } = params;

  const boundary = resolveStdinPromptBoundary(tool, argv);
  if (!boundary.safe) {
    // stdin is NOT provably the whole prompt → recommendation-only for this invocation; feed the ORIGINAL
    // stdin unchanged. We do NOT analyze stdin (it may not be the prompt) → nothing honest to log.
    return {
      boundary,
      emit: "original",
      approvalStatus: "not-asked",
      applied: false,
      notAvailableReason: boundary.reason,
      record: false
    };
  }

  const recommendation = analyzeBeforeCall(tool, stdinContent);
  if (!recommendation.has_avoidable_context) {
    // Honest no-op: stdin carries no avoidable duplicated context. Feed the original; no activity noise.
    return { boundary, recommendation, emit: "original", approvalStatus: "not-required", applied: false, record: false };
  }

  if (!interactive) {
    // Avoidable context exists, but there is no terminal to ask on → NEVER apply without approval.
    return {
      boundary,
      recommendation,
      emit: "original",
      approvalStatus: "not-asked",
      applied: false,
      notAvailableReason: "no interactive terminal to ask on - apply not offered (fail-closed to the original stdin)",
      record: true
    };
  }

  const choice = decide(recommendation);
  if (choice === "apply") {
    return {
      boundary,
      recommendation,
      emit: "compacted",
      compacted: recommendation.compacted_input,
      approvalStatus: "asked-approved",
      applied: true,
      record: true
    };
  }
  return { boundary, recommendation, emit: "original", approvalStatus: "asked-declined", applied: false, record: true };
}
