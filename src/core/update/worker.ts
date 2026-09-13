import { pathToFileURL } from "node:url";
import { readUpdatePreferences } from "../onboarding-preferences.js";
import { stagePair } from "./activation.js";
import { compareReleaseVersions } from "./compatibility.js";
import { selectCandidateEngine } from "./engine-pair.js";
import { loadManagedInstallation } from "./ownership.js";
import { stageRegistryPackage } from "./package-stage.js";
import { createPair } from "./pair.js";
import { discoverVersion, registryRelease, type UpdateChannel } from "./registry.js";
import { automaticUpdatesEnabled, rememberUpdateCandidate } from "./scheduler.js";

/** Shared explicit/background staging workflow; active selection belongs only to the coordinator. */
export async function stageLatestUpdate(root: string, channel: UpdateChannel, env: NodeJS.ProcessEnv = process.env, automatic = false): Promise<{
  status: "unchanged" | "staged" | "already-staged"; version: string; engineMode?: "basic" | "signed"; reason?: string; requiredEulaVersion?: string;
}> {
  const { state } = loadManagedInstallation(root);
  const release = registryRelease(await discoverVersion(channel));
  const base = state.staged ?? state.current;
  const newerCli = (compareReleaseVersions(release.version, base.cli.version) ?? -1) > 0;
  if (newerCli) await rememberUpdateCandidate(root, release.version);
  const stillRequested = () => !automatic || (automaticUpdatesEnabled(env) && readUpdatePreferences(env).channel === channel);
  if (!stillRequested()) throw new Error("Update preferences changed before acquisition.");
  const cli = newerCli ? await stageRegistryPackage(root, release) : base.cli;
  if (!stillRequested()) throw new Error("Update preferences changed during acquisition.");
  const selected = await selectCandidateEngine(cli, base.engine, { env, refresh: true,
    ...(automatic ? { onNetwork: () => { if (!stillRequested()) throw new Error("Update preferences changed before engine acquisition."); } } : {}) });
  const consent = selected.requiredEulaVersion ? { requiredEulaVersion: selected.requiredEulaVersion } : {};
  const pair = createPair(cli, selected.engine);
  if (pair.id === createPair(base.cli, base.engine).id) {
    if (state.staged) await stagePair(root, pair, automatic ? "automatic" : "explicit", state.revision, automatic ? stillRequested : undefined);
    return { status: state.staged ? "already-staged" : "unchanged", version: base.cli.version,
      engineMode: selected.engine.mode, ...(selected.reason ? { reason: selected.reason } : {}), ...consent };
  }
  await stagePair(root, pair, automatic ? "automatic" : "explicit", state.revision,
    automatic ? stillRequested : undefined);
  await rememberUpdateCandidate(root, cli.version, pair.id);
  return { status: "staged", version: cli.version, engineMode: selected.engine.mode, ...(selected.reason ? { reason: selected.reason } : {}), ...consent };
}

export async function runUpdateWorker(root: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (!automaticUpdatesEnabled(env)) return;
  try { await stageLatestUpdate(root, readUpdatePreferences(env).channel, env, true); }
  catch { /* Offline, bad releases, and changed ownership leave the current pair selected. */ }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && process.env.COMPACTION_UPDATE_WORKER === "1") {
  // The scheduler gives this worker its own process group. Its bounded lifetime includes npm
  // descendants; no daemon or abandoned package installer survives the deadline.
  const deadline = setTimeout(() => { try { process.kill(-process.pid, "SIGTERM"); } catch { process.exit(1); } }, 240_000);
  runUpdateWorker(process.argv[2]).finally(() => clearTimeout(deadline));
}
