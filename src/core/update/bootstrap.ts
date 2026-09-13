import { existsSync, lstatSync, readFileSync, realpathSync, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readUpdatePreferences, writeUpdatePreferences } from "../onboarding-preferences.js";
import { stagePair } from "./activation.js";
import { selectCandidateEngine } from "./engine-pair.js";
import { migrateOwnedIntegrations } from "./migrations.js";
import { bootstrapManagedInstall, defaultManagedRoot, loadManagedInstallation } from "./ownership.js";
import { stageLocalArtifact, stageRegistryPackage } from "./package-stage.js";
import { createPair } from "./pair.js";
import { discoverVersion, registryRelease, type UpdateChannel } from "./registry.js";
import { readState } from "./state.js";
import { hasUntrackedToolProcessesForLauncher } from "./process-identity.js";

export interface BootstrapOptions {
  env?: NodeJS.ProcessEnv;
  prefix?: string;
  channel?: UpdateChannel;
  exactVersion?: string;
  localArtifact?: { artifactPath: string; expectedSha256: string; expectedVersion: string };
  /** Only an explicit official-installer rerun may replace its selected npm-prefix launcher. */
  adoptSelectedNpmPrefix?: boolean;
  automaticUpdates?: boolean;
}

export function isDirectBootstrapInvocation(moduleUrl: string, entryPath: string | undefined): boolean {
  if (!entryPath) return false;
  try { return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(entryPath); }
  catch { return false; }
}

export async function bootstrapManaged(options: BootstrapOptions = {}): Promise<{ launcherPath: string; version: string; staged: boolean; backup?: string }> {
  const env = options.env ?? process.env;
  const root = defaultManagedRoot(env);
  const launcher = path.resolve(options.prefix ?? path.join(env.HOME ?? homedir(), ".local"), "bin", "compaction");
  let existing: ReturnType<typeof loadManagedInstallation> | undefined;
  if (existsSync(path.join(root, "install.json"))) existing = loadManagedInstallation(root);
  if (existing && existing.receipt.launcherPath !== launcher) throw new Error("Existing managed installation uses a different launcher prefix.");
  if (!existing && existsSync(path.join(root, "bootstrap.json"))) {
    const prepared = readState(root);
    if ((options.exactVersion && prepared.current.cli.version !== options.exactVersion) ||
        (options.localArtifact && (prepared.current.cli.version !== options.localArtifact.expectedVersion ||
          prepared.current.cli.integrity !== `sha256-${Buffer.from(options.localArtifact.expectedSha256, "hex").toString("base64")}`))) {
      throw new Error("A different release has a prepared bootstrap; resume that exact release before staging another.");
    }
    await bootstrapManagedInstall(root, prepared.current, { launcherPath: launcher });
    writeUpdatePreferences({ channel: options.channel ?? "stable", autoUpdates: options.exactVersion || options.localArtifact || env.COMPACTION_AUTO_UPDATE === "0"
      ? false : options.automaticUpdates ?? readUpdatePreferences(env).autoUpdates }, env);
    await migrateOwnedIntegrations(root, env);
    return { launcherPath: launcher, version: prepared.current.cli.version, staged: false };
  }
  let adopt = false;
  if (!existing && existsSync(launcher)) {
    const packageRoot = path.resolve(path.dirname(launcher), "..", "lib", "node_modules", "@compaction", "cli");
    if (!options.adoptSelectedNpmPrefix || !lstatSync(launcher).isSymbolicLink() ||
        realpathSync(launcher) !== realpathSync(path.join(packageRoot, "dist", "cli", "index.js"))) {
      throw new Error("Refusing to replace an unknown launcher; choose an empty user-writable prefix.");
    }
    const pkg = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));
    if (pkg.name !== "@compaction/cli" || pkg.bin?.compaction !== "dist/cli/index.js") throw new Error("Existing prefix is not owned by this npm package.");
    if (hasUntrackedToolProcessesForLauncher(launcher, new Set(), env)) throw new Error("Legacy integration sessions may still be active; close them before migrating this launcher.");
    adopt = true;
  }
  const cli = options.localArtifact
    ? await stageLocalArtifact({ managedRoot: root, ...options.localArtifact })
    : await stageRegistryPackage(root, registryRelease(await discoverVersion(options.channel ?? "stable", options.exactVersion)));
  const selected = await selectCandidateEngine(cli, existing?.state.current.engine, { env });
  const pair = createPair(cli, selected.engine);
  let backup: string | undefined;
  if (existing) await stagePair(root, pair, "explicit", existing.state.revision);
  else {
    if (adopt) {
      if (hasUntrackedToolProcessesForLauncher(launcher, new Set(), env)) throw new Error("Legacy integration sessions may still be active; close them before migrating this launcher.");
      backup = `${launcher}.before-managed-${randomUUID()}`; renameSync(launcher, backup);
    }
    try { await bootstrapManagedInstall(root, pair, { launcherPath: launcher }); }
    catch (error) {
      if (backup && !existsSync(launcher)) renameSync(backup, launcher);
      throw error;
    }
  }
  // Explicit version/local artifacts are pinned until the operator chooses otherwise.
  writeUpdatePreferences({ channel: options.channel ?? "stable",
    autoUpdates: options.exactVersion || options.localArtifact || env.COMPACTION_AUTO_UPDATE === "0" ? false :
      options.automaticUpdates ?? readUpdatePreferences(env).autoUpdates }, env);
  await migrateOwnedIntegrations(root, env);
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
