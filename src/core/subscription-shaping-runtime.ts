/**
 * Native output-shaping hook RUNTIME, the PURE decision the `compaction hooks shape <tool>` command
 * makes from the tool's hook stdin JSON (PUBLIC CLI/SDK core, engine-free, content-free, fail-open).
 *
 * This module decides WHAT to print to stdout so the tool injects a content-free output-shaping
 * instruction BEFORE generation on a SUBSCRIPTION session. The CLI only reads stdin, calls
 * `decideShaping`, and prints `stdout`, no other logic lives there.
 *
 * INVARIANTS (all load-bearing):
 * - KILL-SWITCH: shaping-via-hook is AUTO-APPLY (default-ON). It HOLDS, emits nothing, leaves the prompt
 *   unchanged, ONLY when the kill-switch is thrown (`COMPACTION_SHAPING_HOOKS=0|false|off|no`).
 * - CLASSIFIER-HOLD (Codex, non-negotiable) WHEREVER THE GATE IS PRESENT: with the task classifier in the
 *   build, a planning/reasoning/extended-thinking turn HOLDS via `classifyOutputShapingTask`. Task-aware
 *   auto-apply never shapes a thinking turn.
 * - PUBLIC-BASIC FALLBACK when the gate is ABSENT: the classifier is PUBLIC as of the 2026-08-03
 *   shaping-parity amendment and SHIPS, so a normal install HAS the gate and holds planning turns.
 *   The fallback stays as the honest degrade for a build without it (a partial mirror, a future split).
 *   Holding there would make `compaction hooks install` a no-op for every Open user on Claude Code and
 *   Codex, contradicting the Open guarantee (Open MAY apply one public deterministic output-shaping
 *   method) and the
 *   README. So an absent gate degrades to the PUBLIC BLANKET method — exactly what the gateway route
 *   would do with no `taskGate`, and what Cursor already does per-session. (Since 2026-08-04 the
 *   gateway's public-basic path is wired too, so shaping can reach a turn from EITHER surface. They do
 *   not double-attach: the gateway checks the body for the policy marker this hook already injected —
 *   see `bodyAlreadyCarriesOutputShaping`.)
 *   Blanket shaping is the public method; the per-turn HOLD is the private enhancement over it.
 * - CONTENT-FREE: the tool's prompt bytes are read ONLY to classify (Codex) and are NEVER returned,
 *   logged, embedded, or persisted. The emitted `additionalContext`/`additional_context` is a FIXED,
 *   generic instruction block from `buildOutputShapingPolicy()`, it carries no request content.
 * - FAIL-OPEN: any parse/shape error → HOLD (emit nothing). A broken hook must never break the tool.
 * - NO SAVINGS CLAIM: this injects an instruction; it makes no claim that output was reduced. Whether
 *   injected shaping reduces output on Codex/Cursor is UNMEASURED (a separate E2E step).
 *
 * Per-tool behavior (verified external schemas):
 * - **Claude Code**, PER-PROMPT `UserPromptSubmit`. Same nested shape and same injecting field as Codex:
 *   Claude Code wraps a UserPromptSubmit hook's `hookSpecificOutput.additionalContext` in a system
 *   reminder the model reads on the next request (exit 0). With the measured `classifyOutputShapingTask`
 *   present, planning/reasoning/extended-thinking turns HOLD and code/answer turns SHAPE; without it,
 *   every turn gets the public blanket block.
 * - **Codex**, PER-PROMPT `UserPromptSubmit`. Same gate: with the classifier present, planning/reasoning
 *   turns HOLD (prose is plausibly load-bearing) and code/answer turns SHAPE; without it, blanket. On
 *   either shape outcome, emit `{ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext } }`.
 * - **Cursor**, reliable shipped floor: SESSION-LEVEL `sessionStart`. Cursor's vendor artifacts also
 *   expose `beforeSubmitPrompt`: its response schema accepts `additional_context`, hook output
 *   validation permits the field, and the bridge transports it as `additionalContext`. Those
 *   artifacts prove the capability surface, not downstream model application on every supported
 *   IDE/CLI path. IDE delivery remains behind `enable_hook_additional_context`, and the cross-path
 *   live behavior has not passed release acceptance. Compaction 0.6.8 therefore conservatively keeps
 *   the session hook: one coarse "prefer concise" instruction, with no per-turn HOLD on planning
 *   turns in the shipped path. Emit `{ additional_context }`.
 */
import { buildOutputShapingPolicy } from "./output-shaping.js";
import { classifyShapingTask } from "./gateway/task-awareness-seam.js";
import { isShapingHooksActivated } from "./output-shaping-hook-activation.js";
import type { SubscriptionHookTool } from "./subscription-shaping-hooks.js";

/**
 * The tools `decideShaping` can produce a decision for. `claude-code` and `codex` are the two PER-PROMPT
 * `UserPromptSubmit` surfaces (identical injecting shape); `cursor` is the session-level surface. Claude
 * Code is NOT a `SubscriptionHookTool` (that type is scoped to the Codex/Cursor config-file installers);
 * the Claude Code hook is installed via `claude-code-hooks.ts`, but its RUNTIME injection shape is the
 * same per-prompt `hookSpecificOutput.additionalContext` as Codex, so it shares this runtime.
 */
export type ShapingRuntimeTool = SubscriptionHookTool | "claude-code";

/**
 * The content-free instruction block injected via the hook. This is exactly the deterministic public
 * policy payload, so hook, gateway, and wrapper provenance all identify the same model-visible bytes.
 * The user-facing honesty note remains CLI output and is not part of the model-visible treatment.
 */
export function shapingInstructionBlock(): string {
  return buildOutputShapingPolicy().instructions;
}

export type ShapingDecisionOutcome =
  | "hold-dormant" // kill-switch thrown (`COMPACTION_SHAPING_HOOKS=0|false|off|no`) → emit nothing
  | "hold-planning" // Codex: the turn reads as planning/reasoning → hold (measured-safe bias)
  | "hold-error" // stdin was unparseable/wrong shape → fail-open hold
  | "shape-basic" // the task gate is not part of this build → the PUBLIC blanket method (Open)
  | "shape"; // task-aware: the gate classified this turn shapeable → emit the injection JSON

export interface ShapingDecision {
  /** Exactly what the CLI should print to stdout (empty string = print nothing). */
  stdout: string;
  /** Content-free outcome label (never contains request bytes) - for tests/telemetry-free reasoning. */
  outcome: ShapingDecisionOutcome;
}

const HOLD_DORMANT: ShapingDecision = { stdout: "", outcome: "hold-dormant" };
const HOLD_ERROR: ShapingDecision = { stdout: "", outcome: "hold-error" };
const HOLD_PLANNING: ShapingDecision = { stdout: "", outcome: "hold-planning" };
/**
 * The per-prompt injection both Claude Code and Codex accept: a `UserPromptSubmit` hook's
 * `hookSpecificOutput.additionalContext` is added to the model's context for THIS turn only. The
 * block is the fixed, generic policy text — it never contains request bytes.
 */
function injectPerPrompt(outcome: "shape" | "shape-basic"): ShapingDecision {
  const output = {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: shapingInstructionBlock()
    }
  };
  return { stdout: `${JSON.stringify(output)}\n`, outcome };
}

/** Per-prompt: pull the prompt string out of the hook payload (best-effort; any shape issue → ""). */
function promptFrom(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const prompt = (payload as Record<string, unknown>).prompt;
  return typeof prompt === "string" ? prompt : "";
}

/**
 * Decide what the shaping hook should print, given the tool, the raw stdin text, and the environment.
 * Total: never returns request content. When the kill-switch is thrown OR the user has run
 * `compaction stop` (both funnel through `isShapingHooksActivated`), always HOLD; a malformed payload
 * always HOLDs; and where the task gate is present, a planning turn always HOLDs.
 *
 * Async because the task gate is reached through a lazy seam, so a build without it degrades to the
 * public blanket method instead of failing to load.
 */
export async function decideShaping(
  tool: ShapingRuntimeTool,
  stdinText: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<ShapingDecision> {
  // DORMANT-FIRST - before parsing anything. Env kill-switch OR persisted `stopped` → emit nothing,
  // unconditionally. This is the versioned-activation gate; nothing below runs while shaping is off.
  if (!isShapingHooksActivated(env)) return HOLD_DORMANT;

  if (tool === "cursor") {
    // Reliable sessionStart floor: this shipped path performs no per-turn classification. When
    // activated, always emit the coarse session instruction. The stdin payload is not required and
    // is never echoed.
    return { stdout: `${JSON.stringify({ additional_context: shapingInstructionBlock() })}\n`, outcome: "shape" };
  }

  // claude-code + codex: per-prompt UserPromptSubmit. Parse the payload; any failure → fail-open HOLD.
  let payload: unknown;
  try {
    payload = JSON.parse(stdinText);
  } catch {
    return HOLD_ERROR;
  }
  const prompt = promptFrom(payload);
  if (prompt === "") return HOLD_ERROR; // no prompt to classify → fail-open

  // Reuse the MEASURED task classifier through its lazy seam. It reads request bytes locally and
  // returns ONLY a decision + fixed signal label - no request content. Wrap the prompt as a minimal
  // chat body so it classifies.
  const classification = await classifyShapingTask("hooks", JSON.stringify({ messages: [{ role: "user", content: prompt }] }));

  // ABSENT gate → the PUBLIC BLANKET method, the one method Open is granted, applied here.
  //
  // ABSENT IS NOT "OPEN TIER". This branch used to be annotated "an Open install: the classifier is
  // private and excluded from the package", and that is false in both halves:
  // `output-shaping-task-classifier.ts` is classified `public-basic-optimizer` / `visibility: public`,
  // it ships in the npm tarball, and
  // `mirror-export.test.ts` asserts it is NOT excluded. The hold is therefore not a paid capability
  // and never was on this route — this path consults no entitlement and no engine IPC. What actually
  // reaches it is a build in which the lazy seam cannot resolve the module at all. (The gateway's
  // public-basic path is wired as of 2026-08-04 and degrades the same way, so the two surfaces agree;
  // whichever sees the turn first attaches, and the other detects the marker and skips.) It is still
  // the one deliberate widening — without the gate a planning turn is shaped too — which is why the
  // kill switch stays one env var away.
  if (!classification) return injectPerPrompt("shape-basic");

  // PRESENT gate → the task-aware HOLD stands, unchanged: a planning/reasoning/extended-thinking turn
  // is never shaped.
  if (classification.decision === "hold") return HOLD_PLANNING;
  return injectPerPrompt("shape");
}
