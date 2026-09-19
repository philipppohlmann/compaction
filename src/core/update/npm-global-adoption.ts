import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { readUpdatePreferences } from "../onboarding-preferences.js";
import { bootstrapManaged } from "./bootstrap.js";
import { defaultManagedRoot, loadManagedInstallation } from "./ownership.js";
import { classifyOfficialNpmGlobalEntry, type OfficialNpmGlobalInstallation } from "./npm-global-ownership.js";

export interface AdoptionExecution {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface AdoptionResult {
  handled: boolean;
  code?: number;
  signal?: NodeJS.Signals;
  adopted?: boolean;
}

export interface AdoptionDependencies {
  bootstrap?: typeof bootstrapManaged;
  execute?: (launcher: string, args: string[], env: NodeJS.ProcessEnv) => AdoptionExecution;
  notice?: (message: string) => void;
  managedLauncher?: (owner: OfficialNpmGlobalInstallation, env: NodeJS.ProcessEnv) => string | undefined;
}

const MACHINE_COMMANDS = new Set(["hooks", "statusline", "precall"]);
const CAPTURE_MACHINE_FLAGS = new Set(["--from-hook", "--from-shim", "--from-prompt-hook", "--shape-prompt-hook"]);

export function shouldAttemptNpmGlobalAdoption(args: string[], env: NodeJS.ProcessEnv): boolean {
  const ci = env.CI?.trim().toLowerCase();
  if (ci && !["0", "false", "no", "off"].includes(ci)) return false;
  if (env.COMPACTION_PACKAGE_SMOKE === "1" || env.COMPACTION_SESSION_PIN || env.COMPACTION_UPDATE_WORKER === "1"
    || env.COMPACTION_ENGINE_IPC === "1" || args[0] === "--managed-session-shim") return false;
  if (args.some((arg) => ["--help", "-h", "--version", "-V"].includes(arg))) return false;
  if (MACHINE_COMMANDS.has(args[0] ?? "")) return false;
  if (args[0] === "capture" && args.some((arg) => CAPTURE_MACHINE_FLAGS.has(arg))) return false;
  return true;
}

function executeManaged(launcher: string, args: string[], env: NodeJS.ProcessEnv): AdoptionExecution {
  const result = spawnSync(launcher, args, { env, stdio: "inherit" });
  if (result.error) throw result.error;
  return { code: result.status, signal: result.signal };
}

function adoptionFailureNotice(error: unknown): string {
  const reason = error instanceof Error ? error.message : "";
  const action = /sessions may still be active/i.test(reason)
    ? " Close active Compaction sessions and retry."
    : /runtime is busy/i.test(reason)
      ? " Retry after the current Compaction command finishes."
      : "";
  return `Automatic updates could not be enabled. Continuing with this npm installation.${action}`;
}

function verifiedLauncher(owner: OfficialNpmGlobalInstallation, env: NodeJS.ProcessEnv): string | undefined {
  try {
    const { receipt } = loadManagedInstallation(defaultManagedRoot(env));
    return receipt.launcherPath === owner.launcherPath ? receipt.launcherPath : undefined;
  } catch { return undefined; }
}

/** Converge one eligible npm-global invocation before Commander dispatch, then run it once via the managed launcher. */
export async function convergeOfficialNpmGlobalInvocation(
  entry: string | undefined,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  dependencies: AdoptionDependencies = {}
): Promise<AdoptionResult> {
  const managedShimRecovery = args[0] === "--managed-session-shim";
  if (!managedShimRecovery && !shouldAttemptNpmGlobalAdoption(args, env)) return { handled: false };
  if (managedShimRecovery && !existsSync(path.join(defaultManagedRoot(env), "install.json"))) return { handled: false };
  const owner = classifyOfficialNpmGlobalEntry(entry);
  if (owner.kind !== "official-npm-global") {
    if (managedShimRecovery) return { handled: true, code: 125, adopted: false };
    if (owner.officialLayoutCandidate && dependencies.notice) {
      dependencies.notice(`Automatic updates were not enabled: ${owner.reason}. Reinstall @compaction/cli globally with npm, then retry.`);
    }
    return { handled: false };
  }
  const bootstrap = dependencies.bootstrap ?? bootstrapManaged;
  let adoptionError: unknown;
  try {
    const preferences = readUpdatePreferences(env);
    await bootstrap({ env, prefix: owner.prefix, channel: preferences.channel, exactVersion: owner.version,
      adoptSelectedNpmPrefix: true, automaticUpdates: preferences.autoUpdates,
      ...(managedShimRecovery ? { requireExistingManaged: true } : {}) });
  } catch (error) { adoptionError = error; }

  const launcher = (dependencies.managedLauncher ?? verifiedLauncher)(owner, env);
  if (!launcher) {
    if (managedShimRecovery) return { handled: true, code: 125, adopted: false };
    if (dependencies.notice) dependencies.notice(adoptionFailureNotice(adoptionError));
    return { handled: false };
  }
  if (adoptionError && dependencies.notice) {
    const reason = adoptionError instanceof Error ? adoptionError.message : "remaining setup did not finish";
    dependencies.notice(`Automatic updates are enabled, but setup is incomplete: ${reason} Run \`compaction init\` to verify and repair setup.`);
  }
  try {
    const executed = (dependencies.execute ?? executeManaged)(launcher, args, env);
    if (executed.signal) return { handled: true, signal: executed.signal, adopted: adoptionError === undefined };
    return { handled: true, code: executed.code ?? 1, adopted: adoptionError === undefined };
  } catch (error) {
    if (dependencies.notice) dependencies.notice("Compaction could not start after enabling automatic updates. Retry this command.");
    return { handled: true, code: 1, adopted: adoptionError === undefined };
  }
}
