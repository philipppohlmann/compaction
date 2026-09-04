/**
 * Codex + Cursor native output-shaping hook install/uninstall, PURE config merge (PUBLIC CLI/SDK code,
 * engine-free, content-free). Used by `compaction hooks install --tool codex|cursor`. All IO (read/write
 * the config file, dry-run printing, backup) lives in the CLI; this module only transforms a parsed
 * config object so it is trivially testable: merge-not-replace, idempotent, and removal that touches
 * ONLY Compaction's own hook entries. It mirrors `claude-code-hooks.ts`.
 *
 * These hooks inject a content-free output-shaping instruction BEFORE generation on SUBSCRIPTION sessions
 * (which cannot route through the API-key gateway). They are AUTO-APPLY (default-ON) once installed: the
 * installed hook runs `compaction hooks shape <tool>`, which shapes by default and holds
 * planning/reasoning/extended-thinking turns via the classifier. Set `COMPACTION_SHAPING_HOOKS=0` to
 * disable (kill-switch), see `output-shaping-hook-activation.ts`.
 *
 * Two tools, two config shapes, two events (both verified external schemas):
 * - **Codex** (`~/.codex/hooks.json` or repo `.codex/hooks.json`): a PER-PROMPT `UserPromptSubmit` hook.
 *   Shape: `{ hooks: { UserPromptSubmit: [ { hooks: [ { type: "command", command, timeout } ] } ] } }` -
 *   the SAME nested group/hooks shape as Claude Code.
 * - **Cursor** (`~/.cursor/hooks.json`): Compaction's supported floor is a SESSION-LEVEL `sessionStart`
 *   hook (fires once per session). Cursor also exposes `beforeSubmitPrompt`; see the release-acceptance
 *   distinction on `installCursorShapingHook`. Shape: `{ version: 1, hooks: { sessionStart:
 *   [ { command } ] } }` - FLAT entries (no inner `hooks` array, no `type`).
 */

/** The runtime command each installed shaping hook runs. `<tool>` distinguishes the stdin/stdout schema. */
export function shapingHookCommand(tool: SubscriptionHookTool): string {
  return `compaction hooks shape ${tool}`;
}

export type SubscriptionHookTool = "codex" | "cursor";

/** Codex hook timeout (seconds) - the fast, content-free shaping decision runs well under this. */
export const CODEX_SHAPING_HOOK_TIMEOUT_SECONDS = 10;

/**
 * True when a hook command is Compaction's own shaping hook for `tool` (uninstall removes ONLY ours).
 *
 * EXACT match, not tokens — the same rule `isCompactionTurnLineHookCommand` (`codex-turn-line-hook.ts`)
 * uses, so the two matchers in this pair cannot disagree about what "ours" means. A substring test
 * ("compaction" + "hooks shape" + the tool) claims every foreign command that WRAPS ours, e.g.
 * `echo compaction hooks shape cursor`: install would then skip (believing ours is present) and
 * uninstall — the path `init --disconnect 2|3` runs — would DELETE the user's own entry, against this
 * module's promise that every foreign entry survives. Install writes only a command it produced
 * itself, so an exact comparison is both sufficient and the only safe rule. Surrounding whitespace is
 * tolerated because a hand-edited config often carries it.
 */
export function isCompactionShapingHookCommand(command: string | undefined, tool: SubscriptionHookTool): boolean {
  if (typeof command !== "string") return false;
  return command.trim() === shapingHookCommand(tool);
}

/* ------------------------------------------------------------------------------------------------
 * Codex config (nested group/hooks shape, like Claude Code).
 * ---------------------------------------------------------------------------------------------- */

export type CodexHookGroup = { hooks?: Array<{ type?: string; command?: string; timeout?: number }> };

/** A Codex hooks config (only the shape we touch is typed; unknown keys are preserved as-is). */
export interface CodexHooksConfig {
  hooks?: {
    UserPromptSubmit?: CodexHookGroup[];
    [event: string]: unknown;
  };
  [key: string]: unknown;
}

/* ------------------------------------------------------------------------------------------------
 * Cursor config (flat entries under sessionStart, plus a required top-level `version`).
 * ---------------------------------------------------------------------------------------------- */

type CursorHookEntry = { command?: string };

/** A Cursor hooks config (only the shape we touch is typed; unknown keys are preserved as-is). */
export interface CursorHooksConfig {
  version?: number;
  hooks?: {
    sessionStart?: CursorHookEntry[];
    [event: string]: unknown;
  };
  [key: string]: unknown;
}

export type SubscriptionHooksConfig = CodexHooksConfig | CursorHooksConfig;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export interface SubscriptionInstallResult<C> {
  config: C;
  /** True when the config changed (the hook was newly added). */
  changed: boolean;
  /** True when Compaction's hook was already present (idempotent no-op). */
  alreadyPresent: boolean;
}

export interface SubscriptionUninstallResult<C> {
  config: C;
  changed: boolean;
  /** Number of Compaction hook entries removed. */
  removedCount: number;
}

/* ------------------------------------ Codex install/uninstall ------------------------------------ */

/**
 * MERGE (never replace) Compaction's Codex shaping hook onto `UserPromptSubmit`. Preserves all existing
 * keys, hooks, and other entries. Idempotent: if our hook is already present, returns the config
 * unchanged. Refuses (throws) rather than clobber a malformed `hooks` / `hooks.UserPromptSubmit`.
 */
export function installCodexShapingHook(input: CodexHooksConfig): SubscriptionInstallResult<CodexHooksConfig> {
  const config = clone(input);
  if (config.hooks !== undefined && (typeof config.hooks !== "object" || config.hooks === null || Array.isArray(config.hooks))) {
    throw new Error("existing hooks is malformed (not an object) - refusing to modify; fix the config file manually.");
  }
  const hooks = (config.hooks ??= {});
  if (hooks.UserPromptSubmit !== undefined && !Array.isArray(hooks.UserPromptSubmit)) {
    throw new Error("existing hooks.UserPromptSubmit is malformed (not an array) - refusing to modify; fix the config file manually.");
  }
  const groups = (hooks.UserPromptSubmit ??= []) as CodexHookGroup[];

  const alreadyPresent = groups.some((g) => (g.hooks ?? []).some((h) => isCompactionShapingHookCommand(h.command, "codex")));
  if (alreadyPresent) {
    return { config: input, changed: false, alreadyPresent: true };
  }

  groups.push({ hooks: [{ type: "command", command: shapingHookCommand("codex"), timeout: CODEX_SHAPING_HOOK_TIMEOUT_SECONDS }] });
  return { config, changed: true, alreadyPresent: false };
}

/** Remove ONLY Compaction's Codex shaping hook from `UserPromptSubmit`; preserve everything else. */
export function uninstallCodexShapingHook(input: CodexHooksConfig): SubscriptionUninstallResult<CodexHooksConfig> {
  const config = clone(input);
  const groups = config.hooks?.UserPromptSubmit;
  if (!Array.isArray(groups)) {
    return { config: input, changed: false, removedCount: 0 };
  }

  let removedCount = 0;
  const next = groups
    .map((group: CodexHookGroup) => {
      const inner = group.hooks ?? [];
      const kept = inner.filter((h) => {
        const drop = isCompactionShapingHookCommand(h.command, "codex");
        if (drop) removedCount += 1;
        return !drop;
      });
      return { group, kept };
    })
    // drop groups emptied ONLY because we removed our hook (preserve groups already empty/other)
    .filter(({ group, kept }) => kept.length > 0 || (group.hooks ?? []).length === 0)
    .map(({ group, kept }) => (group.hooks ? { ...group, hooks: kept } : group));

  if (removedCount === 0) {
    return { config: input, changed: false, removedCount: 0 };
  }

  if (next.length === 0) {
    delete config.hooks!.UserPromptSubmit;
  } else {
    config.hooks!.UserPromptSubmit = next;
  }
  if (config.hooks && Object.keys(config.hooks).length === 0) {
    delete config.hooks;
  }
  return { config, changed: true, removedCount };
}

/** True when the Codex config already contains Compaction's own shaping hook. Pure read. */
export function hasCodexShapingHook(config: CodexHooksConfig): boolean {
  const groups = config.hooks?.UserPromptSubmit;
  if (!Array.isArray(groups)) return false;
  return groups.some((g) => (g.hooks ?? []).some((h) => isCompactionShapingHookCommand(h.command, "codex")));
}

/* ------------------------------------ Cursor install/uninstall ------------------------------------ */

/** Cursor requires a top-level schema `version`. We set 1 when creating; never downgrade an existing one. */
export const CURSOR_HOOKS_SCHEMA_VERSION = 1;

/**
 * MERGE (never replace) Compaction's Cursor shaping hook onto `sessionStart` (SESSION-LEVEL).
 * Preserves all existing keys and hooks; sets the required top-level `version` only when absent (never
 * overwrites the user's). Idempotent. Refuses (throws) rather than clobber a malformed
 * `hooks` / `hooks.sessionStart`.
 *
 * WHY `sessionStart` REMAINS THE SUPPORTED FLOOR — verified against installed Cursor vendor artifacts.
 * Cursor exposes `beforeSubmitPrompt`; `BeforeSubmitPromptRequestResponse` includes
 * `additional_context`, hook output validation accepts the field, and the bridge transports it as
 * `additionalContext`. That proves the vendor capability surface. It does not, by itself, prove or
 * disprove downstream model application across every supported IDE/CLI path.
 *
 * Reliable live behavior across those paths has not yet passed release acceptance, and IDE delivery
 * remains behind the `enable_hook_additional_context` experiment gate. Compaction 0.6.8 therefore
 * conservatively installs `sessionStart`: the already-supported coarse session instruction, with no
 * per-turn task-aware hold in this shipped Cursor path. A per-prompt refinement requires separate
 * end-to-end acceptance; it is not blocked by an absent vendor hook.
 */
export function installCursorShapingHook(input: CursorHooksConfig): SubscriptionInstallResult<CursorHooksConfig> {
  const config = clone(input);
  if (config.hooks !== undefined && (typeof config.hooks !== "object" || config.hooks === null || Array.isArray(config.hooks))) {
    throw new Error("existing hooks is malformed (not an object) - refusing to modify; fix the config file manually.");
  }
  const hooks = (config.hooks ??= {});
  if (hooks.sessionStart !== undefined && !Array.isArray(hooks.sessionStart)) {
    throw new Error("existing hooks.sessionStart is malformed (not an array) - refusing to modify; fix the config file manually.");
  }
  const entries = (hooks.sessionStart ??= []) as CursorHookEntry[];

  const alreadyPresent = entries.some((e) => isCompactionShapingHookCommand(e.command, "cursor"));
  if (alreadyPresent) {
    return { config: input, changed: false, alreadyPresent: true };
  }

  if (config.version === undefined) config.version = CURSOR_HOOKS_SCHEMA_VERSION;
  entries.push({ command: shapingHookCommand("cursor") });
  return { config, changed: true, alreadyPresent: false };
}

/** Remove ONLY Compaction's Cursor shaping hook from `sessionStart`; preserve everything else. */
export function uninstallCursorShapingHook(input: CursorHooksConfig): SubscriptionUninstallResult<CursorHooksConfig> {
  const config = clone(input);
  const entries = config.hooks?.sessionStart;
  if (!Array.isArray(entries)) {
    return { config: input, changed: false, removedCount: 0 };
  }

  let removedCount = 0;
  const kept = entries.filter((e) => {
    const drop = isCompactionShapingHookCommand(e.command, "cursor");
    if (drop) removedCount += 1;
    return !drop;
  });

  if (removedCount === 0) {
    return { config: input, changed: false, removedCount: 0 };
  }

  if (kept.length === 0) {
    delete config.hooks!.sessionStart;
  } else {
    config.hooks!.sessionStart = kept;
  }
  if (config.hooks && Object.keys(config.hooks).length === 0) {
    delete config.hooks;
  }
  return { config, changed: true, removedCount };
}

/** True when the Cursor config already contains Compaction's own shaping hook. Pure read. */
export function hasCursorShapingHook(config: CursorHooksConfig): boolean {
  const entries = config.hooks?.sessionStart;
  if (!Array.isArray(entries)) return false;
  return entries.some((e) => isCompactionShapingHookCommand(e.command, "cursor"));
}
