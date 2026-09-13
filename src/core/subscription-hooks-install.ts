/**
 * THE ONE install path for the Codex/Cursor native hooks (PUBLIC CLI/SDK core, engine-free, content-free).
 *
 * `compaction hooks install --tool codex|cursor` and `compaction init`'s enable step must wire EXACTLY the
 * same entries into EXACTLY the same file with the same posture. They used to be able to diverge: only the
 * `hooks` command knew that a connected Codex needs BOTH the `UserPromptSubmit` shaping hook and the `Stop`
 * per-turn-line hook, so a workflow "enabled" through onboarding got a PATH shim and nothing that shapes.
 * Both callers now route through `installSubscriptionHooks`, so there is one place where that pairing lives.
 *
 * Posture (identical for both callers):
 *  - MERGE, never replace: the pure mergers in `subscription-shaping-hooks.ts` / `codex-turn-line-hook.ts`
 *    preserve every other key, event, and entry, and refuse (throw) rather than clobber a malformed config.
 *  - IDEMPOTENT: a config that already carries our entries is reported `already-present` and not rewritten.
 *  - BACKED UP: an existing file is copied to `<file>.compaction.bak` before the write.
 *  - VERIFIED BY RE-READ: the write is confirmed by parsing the file back off disk and re-checking for our
 *    entries. A write that cannot be confirmed is `verify-failed` and is NEVER reported as installed.
 *  - NEVER THROWS: every failure comes back as a status, so a caller can stay fail-open (an onboarding
 *    hook-install failure must not un-connect the shim that already succeeded).
 *
 * This module does not decide WHETHER to install. The activation gate (`isShapingHooksActivated`, i.e. the
 * `COMPACTION_SHAPING_HOOKS` kill switch and the persisted `compaction stop` state) is the caller's, so a
 * user who turned shaping off never gets a shaping hook wired behind their back.
 */
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  installCodexShapingHook,
  installCursorShapingHook,
  uninstallCodexShapingHook,
  uninstallCursorShapingHook,
  hasCodexShapingHook,
  hasCursorShapingHook,
  shapingHookCommand,
  type SubscriptionHookTool,
  type CodexHooksConfig,
  type CursorHooksConfig
} from "./subscription-shaping-hooks.js";
import {
  codexTurnLineCommand,
  hasCodexTurnLineHook,
  installCodexTurnLineHook,
  uninstallCodexTurnLineHook
} from "./codex-turn-line-hook.js";

export type { SubscriptionHookTool };

/** The parsed shape both tools' configs are read as (each merger only touches the keys it owns). */
type SubscriptionConfig = CodexHooksConfig & CursorHooksConfig;

/**
 * ONE hook entry this install is responsible for, described content-free so a consent surface can name
 * exactly what it is about to write BEFORE it writes it. `effect` states what the entry does to a turn —
 * a shaping entry changes what the model sees, and a review screen that does not say so is not consent.
 */
export interface SubscriptionHookEntry {
  /** The tool's hook event the entry is attached to (e.g. `UserPromptSubmit`, `Stop`, `sessionStart`). */
  event: string;
  /** The exact command the entry runs. */
  command: string;
  /** What that entry does, in the honest per-tool terms (never a savings claim). */
  effect: string;
}

/**
 * The entries `installSubscriptionHooks` writes for a tool, in write order. Exported so the review /
 * disclosure surfaces render the SAME list the installer writes rather than a hand-maintained copy.
 *
 * Cursor is SESSION-LEVEL — once per session, not per turn (`subscription-shaping-hooks.ts` is the
 * authority on why `sessionStart` is the load-bearing mechanism there). Codex's `Stop` line is described
 * as what it is: a `systemMessage` this build asks Codex to display; only a live run proves it renders.
 */
export function subscriptionHookEntries(tool: SubscriptionHookTool): SubscriptionHookEntry[] {
  if (tool === "codex") {
    return [
      {
        event: "UserPromptSubmit",
        command: shapingHookCommand("codex"),
        effect: "attaches a concise-response instruction to what the model sees, before generation"
      },
      {
        event: "Stop",
        command: codexTurnLineCommand(),
        effect: "returns settled content-free receipt evidence as `systemMessage` when recorded"
      }
    ];
  }
  return [
    {
      event: "sessionStart",
      command: shapingHookCommand("cursor"),
      effect: "attaches one concise-response instruction per session (session-level, not per turn)"
    }
  ];
}

export interface SubscriptionHookPathOptions {
  /** Explicit config file, overriding the tool default (used by `hooks install --settings`). */
  file?: string;
  /** Codex only: target the repo-local `.codex/hooks.json` instead of the user-level one. */
  local?: boolean;
  /** Base directory for the user-level config (defaults to the real home directory). */
  home?: string;
  /** Working directory for the repo-local Codex config (defaults to `process.cwd()`). */
  cwd?: string;
}

/** Resolve the on-disk config path for a tool's hooks (the SAME rule `hooks install` has always used). */
export function subscriptionHookConfigPath(tool: SubscriptionHookTool, options: SubscriptionHookPathOptions = {}): string {
  if (options.file) return options.file;
  if (tool === "codex") {
    // Codex reads both the user config (`~/.codex/hooks.json`) and a repo-local `.codex/hooks.json`.
    return options.local
      ? path.join(options.cwd ?? process.cwd(), ".codex", "hooks.json")
      : path.join(options.home ?? homedir(), ".codex", "hooks.json");
  }
  // Cursor: user-level `~/.cursor/hooks.json` (no documented repo-local variant we write).
  return path.join(options.home ?? homedir(), ".cursor", "hooks.json");
}

/**
 * Merge every entry this tool needs into `config` (pure). Codex gets BOTH hooks in ONE transform, so a
 * connected Codex can never be half-wired: either both land in the same write or neither does.
 */
export function mergeSubscriptionHooks(
  tool: SubscriptionHookTool,
  config: SubscriptionConfig
): { config: SubscriptionConfig; changed: boolean } {
  if (tool === "cursor") {
    const cursor = installCursorShapingHook(config);
    return { config: cursor.config, changed: cursor.changed };
  }
  const shaping = installCodexShapingHook(config);
  const line = installCodexTurnLineHook(shaping.config);
  return { config: line.config, changed: shaping.changed || line.changed };
}

/** True when `config` already carries EVERY entry this tool's install is responsible for (pure). */
export function hasAllSubscriptionHooks(tool: SubscriptionHookTool, config: SubscriptionConfig): boolean {
  if (tool === "cursor") return hasCursorShapingHook(config);
  return hasCodexShapingHook(config) && hasCodexTurnLineHook(config);
}

/**
 * True when `config` carries the entry that MUTATES WHAT THE MODEL SEES — and nothing else is required
 * (pure).
 *
 * Deliberately narrower than `hasAllSubscriptionHooks`, and the two must not be swapped. Codex's install
 * writes two entries: the shaping hook (attaches an instruction before generation) and the `Stop`
 * turn-line hook (displays a receipt afterwards, model-invisible). Asking the ALL-hooks question of a
 * record-only claim inverts its safety: a config carrying the shaping hook but not the turn line answers
 * `false`, and the surface then tells a user nothing is attached to what the model sees while an
 * instruction is being attached on every turn. For a claim about model-visible mutation, only the shaping
 * entry is load-bearing — this predicate is what a record-only determination must ask.
 */
export function hasSubscriptionShapingHook(tool: SubscriptionHookTool, config: SubscriptionConfig): boolean {
  return tool === "cursor" ? hasCursorShapingHook(config) : hasCodexShapingHook(config);
}

/**
 * Whether a tool's MODEL-VISIBLE shaping hook is confirmed present on disk right now, read from the file
 * the tool itself reads. The probe a record-only claim must use; see `hasSubscriptionShapingHook` for why
 * `areSubscriptionHooksInstalled` is the wrong question there. Never throws; unreadable answers `false`.
 */
export async function isSubscriptionShapingHookInstalled(
  tool: SubscriptionHookTool,
  options: SubscriptionHookPathOptions = {}
): Promise<boolean> {
  const read = await readConfig(subscriptionHookConfigPath(tool, options));
  return read.ok && read.existed && hasSubscriptionShapingHook(tool, read.config);
}

export type SubscriptionHookInstallStatus =
  | "installed"
  | "already-present"
  | "dry-run"
  | "verify-failed"
  | "error";

export interface SubscriptionHookInstallOutcome {
  tool: SubscriptionHookTool;
  /** The exact file the install targeted (named on every surface, written or not). */
  file: string;
  status: SubscriptionHookInstallStatus;
  /** Whether the config file already existed (drives the backup + the "will be created" note). */
  existed: boolean;
  /** The backup written before an existing file was modified. */
  backupPath?: string;
  /** The entries this install is responsible for (content-free; safe to print anywhere). */
  entries: SubscriptionHookEntry[];
  /** The merged config a `--dry-run` WOULD have written (never written). */
  wouldWrite?: unknown;
  /** The honest failure message for `error` (never a stack, never file content). */
  error?: string;
}

/**
 * The result of reading a tool's config. The `ok: false` arm is LOAD-BEARING, not defensive plumbing.
 *
 * This function used to answer every failure with `existed: false`, which is a lie in every case except
 * "the file is not there" — and an expensive one, because `existed` is exactly what decides whether the
 * install takes a backup. A hand-written `~/.codex/hooks.json` with a trailing comma, a `//` comment,
 * or any other JSON the parser rejects was therefore reported as absent, skipped the backup, and got
 * OVERWRITTEN with Compaction's two entries while the CLI printed a green "Output shaping: on". The
 * user's own hooks were destroyed with no copy anywhere on disk, by a command run for another purpose.
 *
 * So the three outcomes are kept apart: ENOENT is genuinely "no file yet"; anything else — a read
 * failure, invalid JSON, or a non-object top level — is a REFUSAL. `mergeSubscriptionHooks` already
 * refuses rather than clobber a malformed `hooks` key; this extends the same rule to the file itself.
 */
type ReadConfigResult =
  | { ok: true; config: SubscriptionConfig; existed: boolean }
  | { ok: false; reason: string };

async function readConfig(file: string): Promise<ReadConfigResult> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // ONLY "there is no file here" may be treated as a fresh install. ENOTDIR is the same statement
    // about a parent path component. Everything else (EACCES, EISDIR, EIO, …) is a real read failure:
    // treating it as absence would take the no-backup path over a file that is very much there.
    if (code === "ENOENT" || code === "ENOTDIR") return { ok: true, config: {} as SubscriptionConfig, existed: false };
    return { ok: false, reason: `could not read ${file} (${code ?? (error instanceof Error ? error.message : String(error))}) - refusing to modify it.` };
  }
  // An EMPTY file is a fresh start, not a refusal: it carries no configuration to lose. It is still
  // reported as existing, so the backup is taken anyway.
  if (raw.trim() === "") return { ok: true, config: {} as SubscriptionConfig, existed: true };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: `${file} is not valid JSON - refusing to modify it; fix the config file manually (or move it aside).` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: `${file} is not a JSON object - refusing to modify it; fix the config file manually.` };
  }
  return { ok: true, config: parsed as SubscriptionConfig, existed: true };
}

/**
 * Install a tool's native hooks. Merge-not-replace, idempotent, backed up, verified by re-read, and
 * NEVER throwing — the outcome carries the honest status instead, so a caller can report a failure
 * additively without un-doing whatever else it already installed.
 */
export async function installSubscriptionHooks(
  tool: SubscriptionHookTool,
  options: SubscriptionHookPathOptions & { dryRun?: boolean } = {}
): Promise<SubscriptionHookInstallOutcome> {
  const file = subscriptionHookConfigPath(tool, options);
  const entries = subscriptionHookEntries(tool);
  const base = { tool, file, entries };

  const read = await readConfig(file);
  // A file we could not read or parse is NEVER treated as absent: that path skips the backup and
  // overwrites. Both callers handle `error` fail-open, so refusing here costs the user a hook install
  // and costs them nothing else — where guessing cost them their own config, unrecoverably.
  if (!read.ok) return { ...base, existed: true, status: "error", error: read.reason };
  const { config, existed } = read;
  let merged: { config: SubscriptionConfig; changed: boolean };
  try {
    merged = mergeSubscriptionHooks(tool, config);
  } catch (error) {
    return { ...base, existed, status: "error", error: error instanceof Error ? error.message : String(error) };
  }

  if (!merged.changed) return { ...base, existed, status: "already-present" };
  if (options.dryRun === true) return { ...base, existed, status: "dry-run", wouldWrite: merged.config };

  let backupPath: string | undefined;
  try {
    await mkdir(path.dirname(file), { recursive: true });
    if (existed) {
      backupPath = `${file}.compaction.bak`;
      await copyFile(file, backupPath);
    }
    await writeFile(file, `${JSON.stringify(merged.config, null, 2)}\n`, "utf8");
  } catch (error) {
    return {
      ...base,
      existed,
      ...(backupPath ? { backupPath } : {}),
      status: "error",
      error: error instanceof Error ? error.message : String(error)
    };
  }

  // VERIFY BY RE-READ: parse what actually landed on disk. A write that cannot be confirmed is never
  // reported as installed, so no surface can claim a hook the tool will not find.
  const after = await readConfig(file);
  if (!after.ok || !after.existed || !hasAllSubscriptionHooks(tool, after.config)) {
    return { ...base, existed, ...(backupPath ? { backupPath } : {}), status: "verify-failed" };
  }
  return { ...base, existed, ...(backupPath ? { backupPath } : {}), status: "installed" };
}

/**
 * Whether a tool's hooks are CONFIRMED present on disk right now. This is the honest answer to "is
 * output shaping actually active for this workflow?", because it reads the file the tool itself will
 * read — not what an install attempt reported, and not what a preference says. Never throws; an
 * unreadable or malformed config answers `false`, which understates rather than overstates.
 */
export async function areSubscriptionHooksInstalled(
  tool: SubscriptionHookTool,
  options: SubscriptionHookPathOptions = {}
): Promise<boolean> {
  const read = await readConfig(subscriptionHookConfigPath(tool, options));
  return read.ok && read.existed && hasAllSubscriptionHooks(tool, read.config);
}

export type SubscriptionHookUninstallStatus = "removed" | "not-present" | "no-config" | "dry-run" | "error";

export interface SubscriptionHookUninstallOutcome {
  tool: SubscriptionHookTool;
  file: string;
  status: SubscriptionHookUninstallStatus;
  /** How many of OUR entries were removed (never counts anyone else's). */
  removedCount: number;
  backupPath?: string;
  /** The config a `--dry-run` WOULD have written (never written). */
  wouldWrite?: unknown;
  error?: string;
}

/**
 * Remove ONLY Compaction's own entries for a tool, preserving every other key, event, and entry.
 *
 * This exists because the named Codex/Cursor disconnect path printed "disconnected" while the shaping hook
 * it had installed kept firing on every turn — the PATH shim came out, the model-visible lever stayed
 * in. Claude Code's `--disconnect 1` already removed its own shaping hook; this is the same promise for
 * the other two. Never throws, so a disconnect can report the outcome and still complete.
 */
export async function uninstallSubscriptionHooks(
  tool: SubscriptionHookTool,
  options: SubscriptionHookPathOptions & { dryRun?: boolean } = {}
): Promise<SubscriptionHookUninstallOutcome> {
  const file = subscriptionHookConfigPath(tool, options);
  const base = { tool, file };
  const read = await readConfig(file);
  if (!read.ok) return { ...base, status: "error", removedCount: 0, error: read.reason };
  if (!read.existed) return { ...base, status: "no-config", removedCount: 0 };

  const shaping = tool === "codex" ? uninstallCodexShapingHook(read.config) : uninstallCursorShapingHook(read.config);
  const result =
    tool === "codex"
      ? (() => {
          const line = uninstallCodexTurnLineHook(shaping.config);
          return { config: line.config, removedCount: shaping.removedCount + line.removedCount };
        })()
      : { config: shaping.config, removedCount: shaping.removedCount };

  if (result.removedCount === 0) return { ...base, status: "not-present", removedCount: 0 };
  if (options.dryRun === true) {
    return { ...base, status: "dry-run", removedCount: result.removedCount, wouldWrite: result.config };
  }
  try {
    const backupPath = `${file}.compaction.bak`;
    await copyFile(file, backupPath);
    await writeFile(file, `${JSON.stringify(result.config, null, 2)}\n`, "utf8");
    return { ...base, status: "removed", removedCount: result.removedCount, backupPath };
  } catch (error) {
    return { ...base, status: "error", removedCount: 0, error: error instanceof Error ? error.message : String(error) };
  }
}
