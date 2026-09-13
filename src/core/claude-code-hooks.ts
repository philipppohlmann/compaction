/**
 * Claude Code hook install/uninstall, PURE settings merge (PUBLIC CLI/SDK code, engine-free).
 * Used by `compaction hooks install|uninstall` and the connect flow. All IO (read/write the settings
 * file, stdin, dry-run printing) lives in the CLI; this module only transforms a parsed settings object
 * so it is trivially testable: merge-not-replace, idempotent, and removal that touches ONLY Compaction's
 * own hook entries.
 *
 * Two hooks, two events, two purposes:
 * - **Stop** (`--from-hook`): MEASUREMENT. Fires at session END; parses the session JSONL via the Stop
 *   payload's `transcript_path` and records CONTENT-FREE usage.
 * - **UserPromptSubmit** (`--from-prompt-hook`): the BEFORE-CALL surface. Fires before Claude processes
 *   the prompt; records a CONTENT-FREE before-call RECOMMENDATION (apply is impossible on this surface -
 *   hooks cannot reduce the model's context and are non-interactive).
 *
 * Both hooks are fail-open by contract (they must never break Claude Code if Compaction fails).
 */

/** The command the **Stop** (measurement) hook runs. Session JSONL found via the Stop payload's transcript_path. */
export const CLAUDE_CODE_HOOK_COMMAND = "compaction capture claude-code --from-hook";

/**
 * The command the **before-call RECOMMENDATION** hook runs. Installed on the **UserPromptSubmit** event, a
 * genuine PRE-call hook (fires before Claude processes the prompt), NOT the post-session Stop hook. This
 * hook OBSERVES the pending prompt and records a content-free recommendation; it emits nothing to the model.
 * NOTE: it differs from the Stop hook only in this trailing flag, and identity is an exact match, so the
 * two hooks are never confused.
 */
export const CLAUDE_CODE_BEFORE_CALL_HOOK_COMMAND = "compaction capture claude-code --from-prompt-hook";

/**
 * The command the **before-call SHAPING** hook runs. Installed on the **UserPromptSubmit** event (the
 * SUBSCRIPTION output-shaping surface): it injects a content-free output-shaping instruction via the
 * hook's `hookSpecificOutput.additionalContext` (which Claude Code adds to the model's context for that
 * turn) BEFORE generation, holding planning/reasoning/extended-thinking turns. It is a genuine PRE-call
 * event, distinct from the Stop (measurement) hook and from the recommendation hook above.
 * NOTE: `--shape-prompt-hook` is a distinct trailing flag, and identity is an exact match, so uninstall
 * removes ONLY this hook.
 */
export const CLAUDE_CODE_SHAPING_HOOK_COMMAND = "compaction capture claude-code --shape-prompt-hook";

/** The Claude Code hook event a Compaction hook installs on. */
export type ClaudeHookEvent = "Stop" | "UserPromptSubmit";

type HookGroup = { matcher?: string; hooks?: Array<{ type?: string; command?: string }> };

/** The command a Claude Code `statusLine` entry runs each turn (single slot, NOT an array). */
export interface ClaudeStatusLine {
  type?: string;
  command?: string;
  [key: string]: unknown;
}

/** A Claude Code settings object (only the shape we touch is typed; unknown keys are preserved as-is). */
export interface ClaudeSettings {
  hooks?: {
    Stop?: HookGroup[];
    UserPromptSubmit?: HookGroup[];
    [event: string]: unknown;
  };
  /** The per-turn status line command Claude Code renders at the bottom of the UI (a single slot). */
  statusLine?: ClaudeStatusLine;
  [key: string]: unknown;
}

/**
 * IDENTITY IS AN EXACT MATCH, NOT A SET OF TOKENS — the rule `isCompactionShapingHookCommand`
 * (`subscription-shaping-hooks.ts`) and `isCompactionTurnLineHookCommand` (`codex-turn-line-hook.ts`)
 * already use, so no matcher in the repo can disagree about what "ours" means.
 *
 * These four predicates used to test SUBSTRINGS ("compaction" + "capture claude-code" + the flag).
 * Every one of those is satisfied by a FOREIGN command that merely wraps or contains ours — e.g.
 * `echo compaction capture claude-code --from-hook >> /tmp/mylog` or
 * `my-wrapper compaction capture claude-code --from-hook`. That breaks the module's promise in both
 * directions: install/connect would SKIP (believing ours is already present, so measurement never
 * starts), and uninstall — the path `compaction hooks uninstall` and `init --disconnect claude-code` run —
 * would DELETE the user's own entry while claiming to remove only Compaction's.
 *
 * Install writes only the canonical constant below — callers cannot supply a command of their own —
 * so an exact comparison is both sufficient and the only safe rule. Surrounding whitespace is
 * tolerated because a hand-edited settings file often carries it.
 *
 * Exactness also keeps the three hook commands mutually exclusive for free: they differ only in
 * their trailing flag, and `--from-hook` is a substring of neither `--from-prompt-hook` nor
 * `--shape-prompt-hook` under an equality test.
 */

/** True when a hook command is Compaction's own Claude Code **Stop** (measurement) hook. */
export function isCompactionHookCommand(command: string | undefined): boolean {
  if (typeof command !== "string") return false;
  return command.trim() === CLAUDE_CODE_HOOK_COMMAND;
}

/** True when a hook command is Compaction's own Claude Code **before-call RECOMMENDATION** (UserPromptSubmit) hook. */
export function isCompactionBeforeCallHookCommand(command: string | undefined): boolean {
  if (typeof command !== "string") return false;
  return command.trim() === CLAUDE_CODE_BEFORE_CALL_HOOK_COMMAND;
}

/**
 * True when a hook command is Compaction's own Claude Code **before-call SHAPING** (UserPromptSubmit) hook.
 * Distinct from the measurement hook (`--from-hook`) and the recommendation hook (`--from-prompt-hook`)
 * by its own trailing flag, so uninstall removes ONLY this hook.
 */
export function isCompactionShapingHookCommand(command: string | undefined): boolean {
  if (typeof command !== "string") return false;
  return command.trim() === CLAUDE_CODE_SHAPING_HOOK_COMMAND;
}

type HookIdentity = (command: string | undefined) => boolean;

/**
 * A hook's three inseparable facts: the event it lives on, the EXACT command install writes, and the
 * rule that recognizes it. They are bound together here, once per hook, because install, detection,
 * idempotency, and removal must agree on what "ours" means. When the command and the identity rule can
 * be supplied independently, install can write an entry no matcher recognizes — every install then adds
 * a duplicate and uninstall removes none of them.
 */
interface HookSpec {
  event: ClaudeHookEvent;
  command: string;
  isOurs: HookIdentity;
}

const STOP_HOOK: HookSpec = {
  event: "Stop",
  command: CLAUDE_CODE_HOOK_COMMAND,
  isOurs: isCompactionHookCommand
};

const BEFORE_CALL_HOOK: HookSpec = {
  event: "UserPromptSubmit",
  command: CLAUDE_CODE_BEFORE_CALL_HOOK_COMMAND,
  isOurs: isCompactionBeforeCallHookCommand
};

const SHAPING_HOOK: HookSpec = {
  event: "UserPromptSubmit",
  command: CLAUDE_CODE_SHAPING_HOOK_COMMAND,
  isOurs: isCompactionShapingHookCommand
};

/** True when `settings` already contains the Compaction hook described by `spec`. Pure read. */
function hasCompactionHookOnEvent(settings: ClaudeSettings, spec: HookSpec): boolean {
  const groups = settings.hooks?.[spec.event];
  if (!Array.isArray(groups)) return false;
  return groups.some((group) => (group.hooks ?? []).some((h) => spec.isOurs(h.command)));
}

/** True when the settings object already contains Compaction's own **Stop** hook. */
export function hasCompactionStopHook(settings: ClaudeSettings): boolean {
  return hasCompactionHookOnEvent(settings, STOP_HOOK);
}

/** True when the settings object already contains Compaction's own **before-call RECOMMENDATION** hook. */
export function hasCompactionBeforeCallHook(settings: ClaudeSettings): boolean {
  return hasCompactionHookOnEvent(settings, BEFORE_CALL_HOOK);
}

/** True when the settings object already contains Compaction's own **before-call SHAPING** hook. */
export function hasCompactionShapingHook(settings: ClaudeSettings): boolean {
  return hasCompactionHookOnEvent(settings, SHAPING_HOOK);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export interface InstallResult {
  settings: ClaudeSettings;
  /** True when the settings changed (the hook was newly added). */
  changed: boolean;
  /** True when Compaction's hook was already present (idempotent no-op). */
  alreadyPresent: boolean;
}

/**
 * MERGE (never replace) the Compaction hook described by `spec` onto its event. Preserves all existing
 * keys, hooks, and other entries. Idempotent: if our hook is already present, returns the settings
 * unchanged. Refuses (throws) rather than clobber a malformed `hooks` / `hooks[event]`.
 *
 * The command written and the rule that finds it come from the SAME spec, so what install writes is by
 * construction what detection, idempotency, and uninstall recognize.
 */
function installHookOnEvent(input: ClaudeSettings, spec: HookSpec): InstallResult {
  const settings = clone(input);
  if (settings.hooks !== undefined && (typeof settings.hooks !== "object" || settings.hooks === null || Array.isArray(settings.hooks))) {
    throw new Error("existing settings.hooks is malformed (not an object) - refusing to modify; fix the settings file manually.");
  }
  const hooks = (settings.hooks ??= {});
  if (hooks[spec.event] !== undefined && !Array.isArray(hooks[spec.event])) {
    throw new Error(`existing settings.hooks.${spec.event} is malformed (not an array) - refusing to modify; fix the settings file manually.`);
  }
  const groups = (hooks[spec.event] ??= []) as HookGroup[];

  const alreadyPresent = groups.some((group) => (group.hooks ?? []).some((h) => spec.isOurs(h.command)));
  if (alreadyPresent) {
    return { settings: input, changed: false, alreadyPresent: true };
  }

  groups.push({ hooks: [{ type: "command", command: spec.command }] });
  return { settings, changed: true, alreadyPresent: false };
}

/**
 * MERGE Compaction's **Stop** (measurement) hook into the settings. Preserves everything; idempotent.
 */
export function installStopHook(input: ClaudeSettings): InstallResult {
  return installHookOnEvent(input, STOP_HOOK);
}

/**
 * MERGE Compaction's **before-call** hook onto the UserPromptSubmit event. Preserves everything;
 * idempotent. This is a genuine PRE-call hook - it never touches the Stop (measurement) hook.
 */
export function installBeforeCallHook(input: ClaudeSettings): InstallResult {
  return installHookOnEvent(input, BEFORE_CALL_HOOK);
}

/**
 * MERGE Compaction's **before-call SHAPING** hook onto the UserPromptSubmit event. Preserves everything;
 * idempotent. This is the SUBSCRIPTION output-shaping activation surface (a genuine PRE-call event that
 * injects a content-free shaping instruction via `additionalContext`); it is a distinct entry from the
 * Stop (measurement) hook and the before-call recommendation hook, matched by its own command identity.
 */
export function installShapingHook(input: ClaudeSettings): InstallResult {
  return installHookOnEvent(input, SHAPING_HOOK);
}

export interface UninstallResult {
  settings: ClaudeSettings;
  changed: boolean;
  /** Number of Compaction hook entries removed. */
  removedCount: number;
}

/**
 * Remove ONLY Compaction's own hook entries (the ones `spec` recognizes) from its event; preserve all
 * other hooks and settings. Cleans up empty containers (an emptied group, an empty event array, an empty
 * hooks object) so nothing dangling is left, but never touches another tool's hooks.
 */
function uninstallHookFromEvent(input: ClaudeSettings, spec: HookSpec): UninstallResult {
  const { event, isOurs } = spec;
  const settings = clone(input);
  const groups = settings.hooks?.[event];
  if (!Array.isArray(groups)) {
    return { settings: input, changed: false, removedCount: 0 };
  }

  let removedCount = 0;
  const next = groups
    .map((group: HookGroup) => {
      const inner = group.hooks ?? [];
      const kept = inner.filter((h) => {
        const drop = isOurs(h.command);
        if (drop) removedCount += 1;
        return !drop;
      });
      return { group, kept };
    })
    // drop groups that became empty ONLY because we removed our hook (preserve groups that were already empty/other)
    .filter(({ group, kept }) => kept.length > 0 || (group.hooks ?? []).length === 0)
    .map(({ group, kept }) => (group.hooks ? { ...group, hooks: kept } : group));

  if (removedCount === 0) {
    return { settings: input, changed: false, removedCount: 0 };
  }

  if (next.length === 0) {
    delete settings.hooks![event];
  } else {
    settings.hooks![event] = next;
  }
  if (settings.hooks && Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
  }
  return { settings, changed: true, removedCount };
}

/** Remove ONLY Compaction's **Stop** hook entries; preserve all other hooks and settings. */
export function uninstallStopHook(input: ClaudeSettings): UninstallResult {
  return uninstallHookFromEvent(input, STOP_HOOK);
}

/** Remove ONLY Compaction's **before-call RECOMMENDATION** (UserPromptSubmit) hook entries; preserve everything else. */
export function uninstallBeforeCallHook(input: ClaudeSettings): UninstallResult {
  return uninstallHookFromEvent(input, BEFORE_CALL_HOOK);
}

/** Remove ONLY Compaction's **before-call SHAPING** (UserPromptSubmit) hook entries; preserve everything else. */
export function uninstallShapingHook(input: ClaudeSettings): UninstallResult {
  return uninstallHookFromEvent(input, SHAPING_HOOK);
}

/* ------------------------------------- Status line (per-turn visible surface) ------------------------------------- */

/**
 * The command Claude Code's `statusLine` runs each turn. Unlike the hooks (whose stdout Claude Code
 * swallows), the status-line command's stdout is RENDERED at the bottom of the UI - the ONLY per-turn
 * VISIBLE surface. This prints the single content-free per-turn receipt line.
 */
export const CLAUDE_CODE_STATUS_LINE_COMMAND = "compaction statusline";

/**
 * True when a `statusLine` command is Compaction's own (so uninstall removes only ours).
 *
 * EXACT match on the trimmed command, for the same reason as the three hook matchers above — and the
 * stake is higher here, because `statusLine` is a SINGLE slot. Under the old substring test
 * ("compaction" + "statusline") a user's own line that merely calls ours, e.g.
 * `my-status && compaction statusline`, counted as OURS: connect reported `already-present` instead of
 * the honest `user-owned`, and disconnect DELETED the whole line — the user's only per-turn surface,
 * with nothing of theirs left behind. Exactness routes a wrapper to `user-owned`, where the existing
 * discipline already leaves it untouched and prints guidance instead.
 */
export function isCompactionStatusLineCommand(command: string | undefined): boolean {
  if (typeof command !== "string") return false;
  return command.trim() === CLAUDE_CODE_STATUS_LINE_COMMAND;
}

/** True when the settings object already has Compaction's own status line installed. */
export function hasCompactionStatusLine(settings: ClaudeSettings): boolean {
  const sl = settings.statusLine;
  return !!sl && typeof sl === "object" && !Array.isArray(sl) && isCompactionStatusLineCommand(sl.command);
}

export type StatusLineInstallStatus =
  | "installed" // no statusLine existed → ours was added
  | "already-present" // Compaction's status line was already there (idempotent no-op)
  | "user-owned"; // a DIFFERENT statusLine exists → we do NOT overwrite it (guidance instead)

export interface StatusLineInstallResult {
  settings: ClaudeSettings;
  /** True when the settings changed (ours was newly added). */
  changed: boolean;
  status: StatusLineInstallStatus;
}

/**
 * MERGE (never replace) Compaction's per-turn status line into the settings. Claude Code's `statusLine`
 * is a SINGLE slot (not an array/mergeable list), so the discipline is:
 *  - no `statusLine` at all → add ours.
 *  - ours already present → idempotent no-op.
 *  - a DIFFERENT (user-owned) `statusLine` present → leave it UNTOUCHED and report `user-owned` so the
 *    caller can print honest guidance ("add `compaction statusline` to your existing status line").
 * Preserves every other key. Never throws.
 */
export function installStatusLine(input: ClaudeSettings): StatusLineInstallResult {
  if (hasCompactionStatusLine(input)) {
    return { settings: input, changed: false, status: "already-present" };
  }
  const existing = input.statusLine;
  if (existing !== undefined && existing !== null) {
    // A user's own status line occupies the single slot - never clobber it.
    return { settings: input, changed: false, status: "user-owned" };
  }
  const settings = clone(input);
  settings.statusLine = { type: "command", command: CLAUDE_CODE_STATUS_LINE_COMMAND };
  return { settings, changed: true, status: "installed" };
}

export interface StatusLineUninstallResult {
  settings: ClaudeSettings;
  changed: boolean;
  /** True when a Compaction status line was found and removed. */
  removed: boolean;
}

/**
 * Remove ONLY Compaction's own `statusLine` (matched by command identity); leave a user's own status
 * line untouched. Never throws.
 */
export function uninstallStatusLine(input: ClaudeSettings): StatusLineUninstallResult {
  if (!hasCompactionStatusLine(input)) {
    return { settings: input, changed: false, removed: false };
  }
  const settings = clone(input);
  delete settings.statusLine;
  return { settings, changed: true, removed: true };
}
