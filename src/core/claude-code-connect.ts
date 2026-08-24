/**
 * Connect-once installer for the Claude Code Stop hook (PUBLIC CLI/SDK code, engine-free).
 *
 * `compaction init --connect 1` uses this to ACTUALLY install the consented Stop hook (reusing the
 * same pure `installStopHook` merge that `compaction hooks install` uses) and then VERIFY the write
 * landed by RE-READING the settings file and confirming Compaction's hook entry is present. The
 * connect flow may only claim "connected" when `verified` is true, a failed or unverified install
 * is reported honestly with the one exact command to run manually, never as success.
 *
 * Consent + safety (identical posture to `hooks install`): running the connect command IS the
 * consent; the merge NEVER replaces existing settings and is idempotent; `--dry-run` writes nothing;
 * a malformed settings file is refused (left untouched), not clobbered. Local file I/O only, no
 * network, no new dependency.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  CLAUDE_CODE_HOOK_COMMAND,
  CLAUDE_CODE_SHAPING_HOOK_COMMAND,
  CLAUDE_CODE_STATUS_LINE_COMMAND,
  hasCompactionShapingHook,
  hasCompactionStatusLine,
  hasCompactionStopHook,
  installShapingHook,
  installStatusLine,
  installStopHook,
  uninstallShapingHook,
  uninstallStatusLine,
  type ClaudeSettings
} from "./claude-code-hooks.js";

/** The outcome of a connect attempt. `verified` is the ONLY thing a "connected" claim may rest on. */
export type ConnectClaudeCodeStatus =
  | "installed" // newly written AND a re-read confirmed the hook is present
  | "already-present" // Compaction's hook was already there (idempotent) AND re-read confirmed it
  | "dry-run" // --dry-run: nothing written; shows what WOULD be written
  | "verify-failed" // a write happened but the re-read did NOT find the hook (never claim connected)
  | "error"; // could not install safely (e.g. malformed settings), nothing written

export interface ConnectClaudeCodeResult {
  status: ConnectClaudeCodeStatus;
  /** The settings file targeted (project `.claude/settings.json` by default, or `~/.claude/...`). */
  settingsPath: string;
  /** Whether the settings file already existed before this attempt. */
  existed: boolean;
  /** TRUE only when a re-read of the file confirms Compaction's Stop hook is present. */
  verified: boolean;
  /** The exact hook command that was (or would be) installed. */
  hookCommand: string;
  /** Present on `error`: the honest reason the install was refused (nothing was written). */
  error?: string;
  /** Present on `dry-run`: the settings that WOULD be written (nothing was written). */
  wouldWrite?: ClaudeSettings;
}

async function readSettings(file: string): Promise<{ settings: ClaudeSettings; existed: boolean }> {
  try {
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw) as ClaudeSettings;
    return { settings: parsed && typeof parsed === "object" ? parsed : {}, existed: true };
  } catch {
    return { settings: {}, existed: false };
  }
}

async function writeSettings(file: string, settings: ClaudeSettings): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

/**
 * READ-ONLY discovery check: is Compaction's Claude Code Stop hook already installed
 * AND present in `settingsPath`? This reuses the EXACT verification the connect flow
 * runs after an install (re-read the settings file, then `hasCompactionStopHook`) - but
 * it writes NOTHING and installs nothing. Returns false when the file is missing, is
 * malformed, or does not contain our Stop hook. Never throws.
 *
 * Onboarding discovery must be strictly read-only; this is the safe half of
 * `connectClaudeCodeHook`'s verify step, factored out so discovery can tell `found`
 * (sessions exist) apart from `ready` (the hook is actually installed + verified).
 */
export async function isStopHookInstalled(settingsPath: string): Promise<boolean> {
  const { settings, existed } = await readSettings(settingsPath);
  return existed && hasCompactionStopHook(settings);
}

export interface ConnectClaudeCodeOptions {
  /** The settings file to install into. */
  settingsPath: string;
  /** Preview only: compute + report the merge, write NOTHING. */
  dryRun?: boolean;
}

/**
 * Install (or confirm) Compaction's Claude Code Stop hook in `settingsPath`, then VERIFY by
 * re-reading the file. Returns a structured result; NEVER throws for the malformed-settings case
 * (that is reported as `status: "error"` with nothing written) so the connect UX stays a clean
 * one-liner. The only status the caller may present as "connected" is one with `verified: true`.
 */
export async function connectClaudeCodeHook(options: ConnectClaudeCodeOptions): Promise<ConnectClaudeCodeResult> {
  const { settingsPath, dryRun = false } = options;
  const { settings, existed } = await readSettings(settingsPath);

  let merged;
  try {
    merged = installStopHook(settings);
  } catch (error) {
    return {
      status: "error",
      settingsPath,
      existed,
      verified: false,
      hookCommand: CLAUDE_CODE_HOOK_COMMAND,
      error: error instanceof Error ? error.message : String(error)
    };
  }

  if (merged.alreadyPresent) {
    return {
      status: "already-present",
      settingsPath,
      existed,
      verified: true, // the hook is present in the file we just read
      hookCommand: CLAUDE_CODE_HOOK_COMMAND
    };
  }

  if (dryRun) {
    return {
      status: "dry-run",
      settingsPath,
      existed,
      verified: false,
      hookCommand: CLAUDE_CODE_HOOK_COMMAND,
      wouldWrite: merged.settings
    };
  }

  await writeSettings(settingsPath, merged.settings);
  // VERIFY: re-read from disk and confirm the entry actually landed. A write that did not take
  // (odd filesystem, permissions, a racing writer) must NOT be reported as connected.
  const reread = await readSettings(settingsPath);
  const verified = reread.existed && hasCompactionStopHook(reread.settings);
  return {
    status: verified ? "installed" : "verify-failed",
    settingsPath,
    existed,
    verified,
    hookCommand: CLAUDE_CODE_HOOK_COMMAND
  };
}

/* ---------------------------- Before-call SHAPING hook (subscription apply lever) ---------------------------- */

/** The outcome of a before-call SHAPING hook connect. Mirrors `ConnectClaudeCodeStatus`. */
export type ConnectShapingHookStatus =
  | "installed" // newly written AND a re-read confirmed the shaping hook is present
  | "already-present" // Compaction's shaping hook was already there (idempotent) AND re-read confirmed it
  | "dry-run" // --dry-run: nothing written; shows what WOULD be written
  | "verify-failed" // a write happened but the re-read did NOT find the shaping hook (never claim connected)
  | "error"; // could not install safely (e.g. malformed settings), nothing written

export interface ConnectShapingHookResult {
  status: ConnectShapingHookStatus;
  settingsPath: string;
  existed: boolean;
  /** TRUE only when a re-read of the file confirms Compaction's before-call SHAPING hook is present. */
  verified: boolean;
  /** The exact shaping-hook command that was (or would be) installed. */
  hookCommand: string;
  /** Present on `error`: the honest reason the install was refused (nothing was written). */
  error?: string;
  /** Present on `dry-run`: the settings that WOULD be written (nothing was written). */
  wouldWrite?: ClaudeSettings;
}

/**
 * READ-ONLY: is Compaction's Claude Code before-call SHAPING hook already installed AND present in
 * `settingsPath`? Reuses the exact verify the connect flow runs after an install (re-read + `has…`), but
 * writes nothing. Returns false when the file is missing/malformed or lacks our shaping hook. Never throws.
 */
export async function isShapingHookInstalled(settingsPath: string): Promise<boolean> {
  const { settings, existed } = await readSettings(settingsPath);
  return existed && hasCompactionShapingHook(settings);
}

/**
 * Install (or confirm) Compaction's Claude Code before-call SHAPING hook in `settingsPath`, then VERIFY by
 * re-reading. This is the SUBSCRIPTION output-shaping activation surface (the one apply lever on a
 * subscription): a genuine UserPromptSubmit pre-call hook that injects a content-free shaping instruction.
 * Same discipline as the Stop hook: merge-not-replace, idempotent, verify-by-reread, NEVER throws for the
 * malformed-settings case (reported as `status: "error"`, nothing written). The only status the caller may
 * present as connected is one with `verified: true`. Whether shaping actually runs on a turn is further
 * gated at RUNTIME (kill-switch env + `compaction stop` + the planning-hold classifier) - install is not activation.
 */
export async function connectClaudeCodeShapingHook(options: ConnectClaudeCodeOptions): Promise<ConnectShapingHookResult> {
  const { settingsPath, dryRun = false } = options;
  const { settings, existed } = await readSettings(settingsPath);

  let merged;
  try {
    merged = installShapingHook(settings);
  } catch (error) {
    return {
      status: "error",
      settingsPath,
      existed,
      verified: false,
      hookCommand: CLAUDE_CODE_SHAPING_HOOK_COMMAND,
      error: error instanceof Error ? error.message : String(error)
    };
  }

  if (merged.alreadyPresent) {
    return { status: "already-present", settingsPath, existed, verified: true, hookCommand: CLAUDE_CODE_SHAPING_HOOK_COMMAND };
  }

  if (dryRun) {
    return { status: "dry-run", settingsPath, existed, verified: false, hookCommand: CLAUDE_CODE_SHAPING_HOOK_COMMAND, wouldWrite: merged.settings };
  }

  await writeSettings(settingsPath, merged.settings);
  const reread = await readSettings(settingsPath);
  const verified = reread.existed && hasCompactionShapingHook(reread.settings);
  return {
    status: verified ? "installed" : "verify-failed",
    settingsPath,
    existed,
    verified,
    hookCommand: CLAUDE_CODE_SHAPING_HOOK_COMMAND
  };
}

export interface DisconnectShapingHookResult {
  settingsPath: string;
  /** True when Compaction's own before-call SHAPING hook was found and removed (other hooks are never touched). */
  removed: boolean;
}

/**
 * Remove ONLY Compaction's own before-call SHAPING hook from `settingsPath`; leave the Stop hook, the
 * recommendation hook, a user's own hooks, and the status line untouched. Never throws (a missing/malformed
 * file resolves to `removed: false`).
 */
export async function disconnectClaudeCodeShapingHook(settingsPath: string): Promise<DisconnectShapingHookResult> {
  const { settings, existed } = await readSettings(settingsPath);
  if (!existed) return { settingsPath, removed: false };
  const result = uninstallShapingHook(settings);
  if (!result.changed) return { settingsPath, removed: false };
  await writeSettings(settingsPath, result.settings);
  return { settingsPath, removed: true };
}

/* ------------------------------- Status line (per-turn VISIBLE surface) ------------------------------- */

/**
 * The outcome of a status-line connect. The Stop hook records the content-free receipts but its stdout
 * is invisible in Claude Code; the `statusLine` command is the ONLY per-turn VISIBLE surface. This adds
 * it, but Claude Code's `statusLine` is a SINGLE slot, so a user's own status line is never clobbered.
 */
export type ConnectStatusLineStatus =
  | "installed" // no statusLine existed → ours was added AND a re-read confirmed it
  | "already-present" // Compaction's status line was already there (idempotent) AND re-read confirmed it
  | "user-owned" // a DIFFERENT statusLine exists → we did NOT overwrite it (guidance, not a failure)
  | "dry-run" // --dry-run: nothing written
  | "verify-failed"; // a write happened but the re-read did NOT find our status line

export interface ConnectStatusLineResult {
  status: ConnectStatusLineStatus;
  settingsPath: string;
  /** TRUE only when a re-read confirms Compaction's status line is present (installed / already-present). */
  verified: boolean;
  /** The status-line command that was (or would be) installed. */
  statusLineCommand: string;
  /** On `dry-run`: the settings that WOULD be written. */
  wouldWrite?: ClaudeSettings;
}

/**
 * READ-ONLY: is Compaction's status line already installed in `settingsPath`? Never throws.
 */
export async function isStatusLineInstalled(settingsPath: string): Promise<boolean> {
  const { settings, existed } = await readSettings(settingsPath);
  return existed && hasCompactionStatusLine(settings);
}

/**
 * Install (or confirm) Compaction's Claude Code status line in `settingsPath`, then VERIFY by re-reading.
 * MERGE-not-replace and single-slot-safe: a user's own status line is left UNTOUCHED and reported as
 * `user-owned` (the caller prints honest guidance to add `compaction statusline` to their own line).
 * Never throws; a status-line install failure never fails the connect (the caller treats it as additive).
 */
export async function connectClaudeCodeStatusLine(options: ConnectClaudeCodeOptions): Promise<ConnectStatusLineResult> {
  const { settingsPath, dryRun = false } = options;
  const { settings } = await readSettings(settingsPath);
  const merged = installStatusLine(settings);

  if (merged.status === "already-present") {
    return { status: "already-present", settingsPath, verified: true, statusLineCommand: CLAUDE_CODE_STATUS_LINE_COMMAND };
  }
  if (merged.status === "user-owned") {
    return { status: "user-owned", settingsPath, verified: false, statusLineCommand: CLAUDE_CODE_STATUS_LINE_COMMAND };
  }
  if (dryRun) {
    return {
      status: "dry-run",
      settingsPath,
      verified: false,
      statusLineCommand: CLAUDE_CODE_STATUS_LINE_COMMAND,
      wouldWrite: merged.settings
    };
  }

  await writeSettings(settingsPath, merged.settings);
  const reread = await readSettings(settingsPath);
  const verified = reread.existed && hasCompactionStatusLine(reread.settings);
  return {
    status: verified ? "installed" : "verify-failed",
    settingsPath,
    verified,
    statusLineCommand: CLAUDE_CODE_STATUS_LINE_COMMAND
  };
}

export interface DisconnectStatusLineResult {
  settingsPath: string;
  /** True when Compaction's own status line was found and removed (a user's own is never touched). */
  removed: boolean;
}

/**
 * Remove ONLY Compaction's own status line from `settingsPath`; leave a user's own untouched. Never
 * throws (a missing/malformed file resolves to `removed: false`).
 */
export async function disconnectClaudeCodeStatusLine(settingsPath: string): Promise<DisconnectStatusLineResult> {
  const { settings, existed } = await readSettings(settingsPath);
  if (!existed) return { settingsPath, removed: false };
  const result = uninstallStatusLine(settings);
  if (!result.changed) return { settingsPath, removed: false };
  await writeSettings(settingsPath, result.settings);
  return { settingsPath, removed: true };
}
