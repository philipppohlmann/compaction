/**
 * OUTPUT-SHAPING HOOK ACTIVATION (PUBLIC CLI/SDK core, engine-free, content-free).
 *
 * The versioned switch that governs whether the native Codex/Cursor output-shaping HOOKS emit anything.
 * Injecting an output-shaping instruction through a tool's native hook is a BEFORE-CALL injection of
 * model-visible context (it changes what the model sees before it generates). The shaping instruction
 * is content-free and its safe-to-shape scope was validated on a real Claude A/B (64-71% output cut with
 * quality held), so this activation posture is AUTO-APPLY (default-ON) with an explicit KILL-SWITCH.
 *
 * AUTO-APPLY DISCIPLINE: shaping-via-hook ships ON. It is active whenever the hook config is installed,
 * UNLESS the deployment sets the kill-switch `COMPACTION_SHAPING_HOOKS=0|false|off|no` OR the user has run
 * `compaction stop` (a persisted `stopped` run-state, see `subscription-shaping-state.ts`). EITHER of those
 * disables shaping; both must be clear for a turn to be shaped. The version label records WHICH activation
 * posture is live. Default-on does NOT weaken the two safety properties that keep this safe, they are
 * enforced downstream in the runtime, not here:
 *   1. The runtime still classifies each Codex turn and HOLDS (emits nothing) on planning/reasoning/
 *      extended-thinking turns via `classifyOutputShapingTask`. Auto-apply never shapes a thinking turn.
 *   2. The runtime is content-free and fail-open: malformed stdin or any error → HOLD (emit nothing).
 *
 * Claim boundary: turning this on injects a content-free shaping instruction; it makes NO claim that
 * output tokens were reduced on Codex/Cursor. The 64-71% figure is CLAUDE-measured; the Codex/Cursor-native
 * effect is UNMEASURED (a separate E2E fast-follow). Output tokens, not bill. Nothing here surfaces a
 * savings figure.
 */

import { isShapingStopped } from "./subscription-shaping-state.js";

/** The activation version label, records which activation posture is live. */
export const SHAPING_HOOKS_ACTIVATION_VERSION = "shaping-hooks-autoapply-2026-07-27";

/** Kill-switch env: set to `0`/`false`/`off`/`no` to DISABLE shaping-via-hook. Absent/anything else = active. */
export const SHAPING_HOOKS_ENV = "COMPACTION_SHAPING_HOOKS";

/** The values that disable auto-apply (the kill-switch). Case-insensitive. */
const KILL_SWITCH_VALUES = new Set(["0", "false", "off", "no"]);

/** Whether the env kill-switch alone is thrown (independent of the persisted stop-state). */
function isKillSwitchThrown(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[SHAPING_HOOKS_ENV];
  return typeof raw === "string" && KILL_SWITCH_VALUES.has(raw.toLowerCase());
}

/**
 * Whether native output-shaping hooks are active. AUTO-APPLY (DEFAULT-ON), active unless EITHER the
 * deployment has thrown the env kill-switch (`COMPACTION_SHAPING_HOOKS=0|false|off|no`, case-insensitive)
 * OR the user has run `compaction stop` (a persisted `stopped` run-state). Both must be clear to shape.
 * Read fresh (env + state file) so a change is honored on the very next hook invocation. Never throws (the
 * state read is fail-open). Being active here does NOT mean a given turn is shaped: the runtime still holds
 * planning/reasoning/extended-thinking turns and fails open.
 */
export function isShapingHooksActivated(env: NodeJS.ProcessEnv = process.env): boolean {
  if (isKillSwitchThrown(env)) return false;
  if (isShapingStopped(env as Record<string, string | undefined>)) return false;
  return true;
}
