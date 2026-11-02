import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { pinClaudeOwnedCommands, type ClaudeSettings } from "../claude-code-hooks.js";
import { claudeSettingsHome, claudeSettingsPathForScope } from "../claude-code-connect.js";
import { isWritableLauncher } from "../compaction-command.js";
import { pinSubscriptionOwnedCommands, subscriptionHookConfigPath, type SubscriptionHookTool } from "../subscription-hooks-install.js";
import { managedLauncherOwnership } from "./launcher-ownership.js";
import { atomicWrite } from "./state.js";

export type PinnedTool = "claude-code" | "codex" | "cursor";

export interface NativeHookPinOutcome {
  tool: PinnedTool;
  file: string;
  rewritten: number;
}

export interface NativeHookPinOptions {
  /**
   * Codex trusts hooks per command hash, so a rewritten Codex hook needs one review inside Codex before
   * it runs again. Only a path that can tell the user (explicit update, connect) may pin Codex.
   */
  codex: boolean;
}

type Pin = (config: Record<string, unknown>) => { config: unknown; rewritten: number };

/**
 * Rewrite one user-level config file's owned entries. A missing, unreadable, non-JSON or non-object file
 * is left untouched. A symlinked config (dotfiles) is written through to its target so the link survives.
 * The write is refused when the file changed after it was read.
 */
function pinFile(tool: PinnedTool, file: string, pin: Pin): NativeHookPinOutcome | undefined {
  try {
    if (!existsSync(file)) return undefined;
    const target = lstatSync(file).isSymbolicLink() ? realpathSync(file) : file;
    const raw = readFileSync(target, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const result = pin(parsed as Record<string, unknown>);
    if (result.rewritten === 0) return undefined;
    if (readFileSync(target, "utf8") !== raw) return undefined;
    atomicWrite(target, `${JSON.stringify(result.config, null, 2)}\n`, statSync(target).mode & 0o777);
    return { tool, file, rewritten: result.rewritten };
  } catch { return undefined; }
}

/**
 * Point Compaction-owned native integration commands in the user-level Claude Code settings and
 * Cursor (and, when `options.codex`, Codex) hook configs at `launcher`. Only the bare form and
 * launcher-form entries this installation owns change (see `managedLauncherOwnership`).
 * Local file IO only; never throws. Project-scope Claude settings and repo-local Codex configs are not
 * scanned.
 */
export function pinOwnedNativeHookCommands(
  launcher: string,
  options: NativeHookPinOptions,
  env: NodeJS.ProcessEnv = process.env
): NativeHookPinOutcome[] {
  if (!isWritableLauncher(launcher)) return [];
  const home = claudeSettingsHome(env);
  const owns = managedLauncherOwnership(env);
  const tools: SubscriptionHookTool[] = options.codex ? ["codex", "cursor"] : ["cursor"];
  const outcomes: Array<NativeHookPinOutcome | undefined> = [
    pinFile("claude-code", claudeSettingsPathForScope("user", { env }),
      (config) => pinClaudeOwnedCommands(config as ClaudeSettings, launcher, owns)),
    ...tools.map((tool) => pinFile(tool, subscriptionHookConfigPath(tool, { home }),
      (config) => pinSubscriptionOwnedCommands(tool, config, launcher, owns)))
  ];
  return outcomes.filter((outcome): outcome is NativeHookPinOutcome => outcome !== undefined);
}
