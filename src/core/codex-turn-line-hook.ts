import type { CodexHookGroup, CodexHooksConfig } from "./subscription-shaping-hooks.js";

/**
 * CODEX PER-TURN LINE HOOK (PUBLIC CLI/SDK core, engine-free, content-free, fail-open).
 *
 * Gives Codex the per-turn receipt line Claude Code gets from its `statusLine`.
 *
 * WHY A HOOK AND NOT A STATUS LINE — verified against codex-cli 0.144.1, not assumed. Codex DOES have
 * a status line, but `[tui] status_line` is an ARRAY OF STRINGS selecting Codex's own built-in
 * segments (`StatusLineGitSummary`, `StatusLineBranchUpdated`, `StatusLinePullRequest`,
 * `StatusLineWorkspaceHeadline`). Every command-shaped form fails to load; only an array of strings
 * parses. There is no external-command seam there, so a status line is not available to us.
 *
 * The HOOK protocol is. Codex's hook events are `PreToolUse`, `PreCompact`, `PostCompact`,
 * `SessionStart`, `UserPromptSubmit`, `SubagentStart`, `SubagentStop`, and `Stop` — and the embedded
 * output schemas carry `systemMessage` (a string, default null) beside `continue`, `stopReason` and
 * `suppressOutput`. That is the same shape Claude Code uses for a USER-FACING message, as distinct
 * from `additionalContext`, which injects into the model. `Stop` fires after the turn, which is when
 * the counts exist.
 *
 * UNVALIDATED, DELIBERATELY. The schema proves Codex ACCEPTS `systemMessage`; only a live run proves
 * it RENDERS it. That is a dogfooding question, and this ships to answer it. If Codex ignores the
 * field the hook is inert — it prints valid JSON, changes nothing, and `compaction watch` remains the
 * guaranteed Codex surface. Nothing about the turn depends on the answer.
 *
 * CONTENT-FREE + FAIL-OPEN, exactly like the shaping hook: the emitted string is the same canonical
 * receipt line every other surface renders (counts, fixed labels, a short receipt id), and any error
 * yields empty output rather than a broken turn.
 */

/** The command a Codex `Stop` hook entry runs each turn. */
export function codexTurnLineCommand(): string {
  return "compaction hooks line codex";
}

/** Codex `Stop` hook timeout (seconds). Reading a local receipt is fast; this is generous headroom. */
export const CODEX_TURN_LINE_HOOK_TIMEOUT_SECONDS = 5;

/**
 * Recognise OUR Stop-hook entry — by EXACT match, not by tokens.
 *
 * A substring test claims any foreign command that happens to contain the words, e.g.
 * `echo compaction hooks line codex`. That breaks the contract in both directions: install would skip
 * (believing ours is present) and uninstall would DELETE the user's hook. The install/uninstall path
 * writes and removes only a command it produced itself, so an exact comparison is both sufficient and
 * the only safe rule. Surrounding whitespace is tolerated because a hand-edited config often has it.
 */
export function isCompactionTurnLineHookCommand(command: string | undefined): boolean {
  if (typeof command !== "string") return false;
  return command.trim() === codexTurnLineCommand();
}

/**
 * The Codex hook stdout for a turn: `{"systemMessage": "<line>"}`, or `{}` when there is no honest
 * line to show. `suppressOutput` is deliberately NOT set — we are asking Codex to display this.
 */
export function codexTurnLineStdout(line: string | undefined): string {
  if (typeof line !== "string" || line.trim() === "") return "{}\n";
  return `${JSON.stringify({ systemMessage: line })}\n`;
}

/**
 * MERGE (never replace) Compaction's Stop hook onto `hooks.Stop`. Preserves every other key, event and
 * entry; idempotent; refuses rather than clobber a malformed `hooks` / `hooks.Stop`. Mirrors
 * `installCodexShapingHook` so both Codex hooks behave identically on a hand-edited config.
 */
export function installCodexTurnLineHook(input: CodexHooksConfig): {
  config: CodexHooksConfig;
  changed: boolean;
  alreadyPresent: boolean;
} {
  const config = JSON.parse(JSON.stringify(input)) as CodexHooksConfig;
  if (config.hooks !== undefined && (typeof config.hooks !== "object" || config.hooks === null || Array.isArray(config.hooks))) {
    throw new Error("existing hooks is malformed (not an object) - refusing to modify; fix the config file manually.");
  }
  const hooks = (config.hooks ??= {});
  if (hooks.Stop !== undefined && !Array.isArray(hooks.Stop)) {
    throw new Error("existing hooks.Stop is malformed (not an array) - refusing to modify; fix the config file manually.");
  }
  const groups = (hooks.Stop ??= []) as CodexHookGroup[];

  if (groups.some((g) => (g.hooks ?? []).some((h) => isCompactionTurnLineHookCommand(h.command)))) {
    return { config: input, changed: false, alreadyPresent: true };
  }

  groups.push({
    hooks: [{ type: "command", command: codexTurnLineCommand(), timeout: CODEX_TURN_LINE_HOOK_TIMEOUT_SECONDS }]
  });
  return { config, changed: true, alreadyPresent: false };
}

/** True when the Codex config already contains Compaction's own `Stop` per-turn-line hook. Pure read. */
export function hasCodexTurnLineHook(config: CodexHooksConfig): boolean {
  const groups = config.hooks?.Stop;
  if (!Array.isArray(groups)) return false;
  return (groups as CodexHookGroup[]).some((g) => (g.hooks ?? []).some((h) => isCompactionTurnLineHookCommand(h.command)));
}

/** Remove ONLY Compaction's Stop hook; preserve every other entry and event. */
export function uninstallCodexTurnLineHook(input: CodexHooksConfig): {
  config: CodexHooksConfig;
  changed: boolean;
  removedCount: number;
} {
  const config = JSON.parse(JSON.stringify(input)) as CodexHooksConfig;
  const groups = config.hooks?.Stop;
  if (!Array.isArray(groups)) return { config: input, changed: false, removedCount: 0 };

  let removedCount = 0;
  const next = (groups as CodexHookGroup[])
    .map((group) => {
      // Whether the group had anything in it BEFORE we filtered. A group the user left empty (or with
      // no `hooks` key at all) is their configuration, not our leftover, and must survive: an earlier
      // filter dropped every zero-length group, including those.
      const wasEmpty = (group.hooks ?? []).length === 0;
      const kept = (group.hooks ?? []).filter((h) => {
        const ours = isCompactionTurnLineHookCommand(h.command);
        if (ours) removedCount += 1;
        return !ours;
      });
      return { group: { ...group, hooks: kept }, wasEmpty };
    })
    // Drop a group only if WE emptied it.
    .filter(({ group, wasEmpty }) => wasEmpty || (group.hooks ?? []).length > 0)
    .map(({ group }) => group);

  if (removedCount === 0) return { config: input, changed: false, removedCount: 0 };
  if (next.length > 0) (config.hooks as Record<string, unknown>).Stop = next;
  else delete (config.hooks as Record<string, unknown>).Stop;
  return { config, changed: true, removedCount };
}
