import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { LauncherOwnership } from "../compaction-command.js";
import { defaultManagedRoot } from "./ownership.js";

/** The launcher the managed receipt names, read without verification (identity only). Never throws. */
export function receiptLauncherPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  try {
    const receipt = JSON.parse(readFileSync(path.join(defaultManagedRoot(env), "install.json"), "utf8")) as { launcherPath?: unknown };
    return typeof receipt?.launcherPath === "string" ? receipt.launcherPath : undefined;
  } catch { return undefined; }
}

/**
 * Compaction owns a launcher-form entry when it names this installation's receipt launcher, or a launcher
 * file that no longer exists (a stranded managed prefix). A present `compaction` anywhere else is the
 * user's own.
 */
export function managedLauncherOwnership(env: NodeJS.ProcessEnv = process.env): LauncherOwnership {
  const receipt = receiptLauncherPath(env);
  return (launcher) => launcher === receipt || !existsSync(launcher);
}

/** `managedLauncherOwnership` for the current process environment, evaluated at call time. */
export const ownsLauncher: LauncherOwnership = (launcher) => managedLauncherOwnership()(launcher);
