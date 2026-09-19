import { existsSync, lstatSync, readFileSync, realpathSync, renameSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readUpdatePreferences, writeUpdatePreferences } from "../onboarding-preferences.js";
import { stagePair } from "./activation.js";
import { selectCandidateEngine } from "./engine-pair.js";
import { migrateOwnedIntegrations } from "./migrations.js";
import { bootstrapManagedInstall, defaultManagedRoot, loadManagedInstallation, reclaimManagedLauncherAfterNpmReplacement, sha256 } from "./ownership.js";
import { stageLocalArtifact, stageRegistryPackage } from "./package-stage.js";
import { createPair } from "./pair.js";
import { discoverVersion, registryRelease, type UpdateChannel } from "./registry.js";
import { readState } from "./state.js";
import { hasUntrackedToolProcessesForLauncher } from "./process-identity.js";
import { classifyOfficialNpmGlobalEntry, type OfficialNpmGlobalInstallation } from "./npm-global-ownership.js";

export interface BootstrapOptions {
  env?: NodeJS.ProcessEnv;
  prefix?: string;
  channel?: UpdateChannel;
  exactVersion?: string;
  localArtifact?: { artifactPath: string; expectedSha256: string; expectedVersion: string };
  /** Only an explicit official-installer rerun may replace its selected npm-prefix launcher. */
  adoptSelectedNpmPrefix?: boolean;
  /** Machine recovery may reclaim a replaced launcher only when a managed receipt already exists. */
  requireExistingManaged?: boolean;
  automaticUpdates?: boolean;
}

export interface BootstrapDependencies {
  install?: typeof bootstrapManagedInstall;
  migrate?: typeof migrateOwnedIntegrations;
}

export function isDirectBootstrapInvocation(moduleUrl: string, entryPath: string | undefined): boolean {
  if (!entryPath) return false;
  try { return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(entryPath); }
  catch { return false; }
}

function automaticUpdatesAfterBootstrap(options: BootstrapOptions, env: NodeJS.ProcessEnv): boolean {
  if (env.COMPACTION_AUTO_UPDATE === "0") return false;
  if (options.exactVersion || options.localArtifact) return options.automaticUpdates ?? false;
  return options.automaticUpdates ?? readUpdatePreferences(env).autoUpdates;
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : "unknown error"; }

async function finishBootstrapSetup(root: string, options: BootstrapOptions, env: NodeJS.ProcessEnv, dependencies: BootstrapDependencies): Promise<void> {
  try {
    writeUpdatePreferences({ channel: options.channel ?? "stable", autoUpdates: automaticUpdatesAfterBootstrap(options, env) }, env);
  } catch (error) {
    throw new Error(`Automatic update preferences were not saved (${errorMessage(error)}).`);
  }
  try { await (dependencies.migrate ?? migrateOwnedIntegrations)(root, env); }
  catch (error) { throw new Error(`Tool integration migration did not finish (${errorMessage(error)}).`); }
}

function restoreAdoptedLauncher(root: string, launcher: string, backup: string, adoption: OfficialNpmGlobalInstallation): void {
  if (!lstatSync(backup).isSymbolicLink() || realpathSync(backup) !== adoption.entryPath) {
    throw new Error("Original npm launcher backup could not be verified.");
  }
  if (!existsSync(launcher)) { renameSync(backup, launcher); return; }
  const prepared = JSON.parse(readFileSync(path.join(root, "bootstrap.json"), "utf8"));
  const receipt = prepared?.receipt;
  if (!receipt || receipt.schema !== 1 || receipt.kind !== "compaction-managed" || receipt.launcherPath !== launcher
    || lstatSync(launcher).isSymbolicLink() || !lstatSync(launcher).isFile()
    || sha256(readFileSync(launcher)) !== receipt.launcherSha256) {
    throw new Error("Partially published Compaction launcher could not be verified for rollback.");
  }
  unlinkSync(launcher);
  renameSync(backup, launcher);
}

export async function bootstrapManaged(options: BootstrapOptions = {}, dependencies: BootstrapDependencies = {}): Promise<{ launcherPath: string; version: string; staged: boolean; backup?: string }> {
  const env = options.env ?? process.env;
  const root = defaultManagedRoot(env);
  const launcher = path.resolve(options.prefix ?? path.join(env.HOME ?? homedir(), ".local"), "bin", "compaction");
  let existing: ReturnType<typeof loadManagedInstallation> | undefined;
  let adoption: OfficialNpmGlobalInstallation | undefined;
  if (existsSync(path.join(root, "install.json"))) {
    try { existing = loadManagedInstallation(root); }
    catch (error) {
      const packageEntry = path.join(path.resolve(path.dirname(launcher), ".."), "lib", "node_modules", "@compaction", "cli", "dist", "cli", "index.js");
      const classified = classifyOfficialNpmGlobalEntry(packageEntry);
      if (!options.adoptSelectedNpmPrefix || classified.kind !== "official-npm-global"
        || classified.prefix !== path.resolve(options.prefix ?? "") || classified.launcherPath !== launcher) throw error;
      adoption = classified;
      existing = await reclaimManagedLauncherAfterNpmReplacement(root, adoption);
    }
  }
  if (options.requireExistingManaged && !existing) throw new Error("Existing managed installation was not found; machine recovery did not run.");
  if (existing && existing.receipt.launcherPath !== launcher) throw new Error("Existing managed installation uses a different launcher prefix.");
  if (!existing && existsSync(path.join(root, "bootstrap.json"))) {
    const prepared = readState(root);
    if ((options.exactVersion && prepared.current.cli.version !== options.exactVersion) ||
        (options.localArtifact && (prepared.current.cli.version !== options.localArtifact.expectedVersion ||
          prepared.current.cli.integrity !== `sha256-${Buffer.from(options.localArtifact.expectedSha256, "hex").toString("base64")}`))) {
      throw new Error("A different release has a prepared bootstrap; resume that exact release before staging another.");
    }
    await (dependencies.install ?? bootstrapManagedInstall)(root, prepared.current, { launcherPath: launcher });
    await finishBootstrapSetup(root, options, env, dependencies);
    return { launcherPath: launcher, version: prepared.current.cli.version, staged: false };
  }
  if (!existing && existsSync(launcher)) {
    const packageEntry = path.join(path.resolve(path.dirname(launcher), ".."), "lib", "node_modules", "@compaction", "cli", "dist", "cli", "index.js");
    const classified = classifyOfficialNpmGlobalEntry(packageEntry);
    if (!options.adoptSelectedNpmPrefix || classified.kind !== "official-npm-global"
      || classified.prefix !== path.resolve(options.prefix ?? "") || classified.launcherPath !== launcher) {
      throw new Error("Refusing to replace an unknown launcher; choose an empty user-writable prefix.");
    }
    if (hasUntrackedToolProcessesForLauncher(launcher, new Set(), env)) throw new Error("Legacy integration sessions may still be active; close them before migrating this launcher.");
    adoption = classified;
  }
  const cli = options.localArtifact
    ? await stageLocalArtifact({ managedRoot: root, ...options.localArtifact })
    : await stageRegistryPackage(root, registryRelease(await discoverVersion(options.channel ?? "stable", options.exactVersion)));
  const selected = await selectCandidateEngine(cli, existing?.state.current.engine, { env });
  const pair = createPair(cli, selected.engine);
  let backup: string | undefined;
  if (existing) await stagePair(root, pair, "explicit", existing.state.revision);
  else {
    try { await (dependencies.install ?? bootstrapManagedInstall)(root, pair, { launcherPath: launcher,
      ...(adoption ? { beforeLauncherClaim: () => {
        const current = classifyOfficialNpmGlobalEntry(adoption.entryPath);
        if (current.kind !== "official-npm-global" || current.prefix !== adoption.prefix
          || current.launcherPath !== launcher) throw new Error("npm-global launcher ownership changed during adoption.");
        if (hasUntrackedToolProcessesForLauncher(launcher, new Set(), env)) throw new Error("Legacy integration sessions may still be active; close them before migrating this launcher.");
        backup = `${launcher}.before-managed-${randomUUID()}`; renameSync(launcher, backup);
      } } : {}) }); }
    catch (error) {
      if (backup && adoption) restoreAdoptedLauncher(root, launcher, backup, adoption);
      throw error;
    }
  }
  // Explicit version/local artifacts are pinned until the operator chooses otherwise.
  await finishBootstrapSetup(root, options, env, dependencies);
  return { launcherPath: launcher, version: cli.version, staged: !!existing, ...(backup ? { backup } : {}) };
}

if (isDirectBootstrapInvocation(import.meta.url, process.argv[1])) {
  const version = process.env.COMPACTION_VERSION;
  const channel = version === "next" ? "preview" : "stable";
  const local = process.env.COMPACTION_LOCAL_ARTIFACT;
  bootstrapManaged({
    prefix: process.env.COMPACTION_PREFIX, channel, adoptSelectedNpmPrefix: true,
    ...(version && version !== "latest" && version !== "next" ? { exactVersion: version } : {}),
    ...(local ? { localArtifact: { artifactPath: local, expectedSha256: process.env.COMPACTION_LOCAL_SHA256 ?? "", expectedVersion: version ?? "" } } : {})
  }).then(result => {
    console.log(`${result.staged ? "Staged" : "Installed"} Compaction ${result.version}: ${result.launcherPath}`);
    if (result.backup) console.log(`Previous npm launcher preserved at ${result.backup}`);
  }).catch(error => { console.error(`Managed install did not complete: ${error instanceof Error ? error.message : "unknown failure"}`); process.exitCode = 1; });
}
