import type { EnvLike } from "../api-client/config.js";
import { readStoredCredentials } from "../auth/credentials.js";
import { EngineInstallError, stageEngineRelease } from "../engine-install/installer.js";
import { readLeaseVerdict } from "../entitlement/lease-store.js";
import { resolveVerifiedInstalledArtifact } from "../gateway/engine-ipc/supervisor.js";
import type { PairDescriptor, StagedIntent } from "./types.js";
import { stagePair } from "./activation.js";
import { loadManagedInstallation } from "./ownership.js";
import { createPair } from "./pair.js";
import { automaticUpdatesEnabled } from "./scheduler.js";

export interface SelectCandidateEngineOptions {
  refresh?: boolean;
  env?: EnvLike;
  signal?: AbortSignal;
  /** Called immediately before release acquisition starts, never during a local reuse. */
  onNetwork?: () => void;
}

/** Keep an already staged CLI candidate; recheck revision under the coordinator lock after I/O. */
export async function stageManagedEngine(root: string, options: SelectCandidateEngineOptions & { intent: StagedIntent }): Promise<{
  pair: PairDescriptor; staged: boolean; reason?: string; requiredEulaVersion?: string;
}> {
  const { state } = loadManagedInstallation(root);
  const base = state.staged ?? state.current;
  if (options.intent !== "automatic" && options.intent !== "explicit") throw new Error("Invalid engine update intent");
  if (state.staged && state.stagedIntent !== "automatic" && state.stagedIntent !== "explicit") {
    return { pair: base, staged: true, reason: "staged-intent-unknown" };
  }
  const intent = options.intent === "explicit" && (!state.staged || state.stagedIntent === "explicit") ? "explicit" : "automatic";
  const requested = () => intent === "explicit" || automaticUpdatesEnabled(options.env ?? process.env);
  let automaticBlocked = false;
  const selected = await selectCandidateEngine(base.cli, base.engine, {
    ...options,
    onNetwork: () => {
      if (!requested()) { automaticBlocked = true; throw new Error("Automatic engine updates disabled"); }
      options.onNetwork?.();
    }
  });
  if (automaticBlocked) return { pair: base, staged: !!state.staged, reason: "automatic-updates-disabled" };
  const pair = createPair(base.cli, selected.engine);
  if (pair.id !== base.id) await stagePair(root, pair, intent, state.revision, requested);
  return { pair, staged: pair.id !== state.current.id, ...(selected.reason ? { reason: selected.reason } : {}),
    ...(selected.requiredEulaVersion ? { requiredEulaVersion: selected.requiredEulaVersion } : {}) };
}

/** Resolve a coherent managed engine selection; acquisition never promotes the legacy pointer. */
export async function selectCandidateEngine(
  cli: PairDescriptor["cli"],
  currentEngine?: PairDescriptor["engine"],
  options: SelectCandidateEngineOptions = {}
): Promise<{ engine: PairDescriptor["engine"]; reason?: string; requiredEulaVersion?: string }> {
  const env = options.env ?? process.env;
  const basic = (reason: string) => ({ engine: { mode: "basic" as const }, reason });
  if (!readStoredCredentials(env)) return basic("no-account");
  if (readLeaseVerdict(env).label !== "lease-valid") return basic("lease-unavailable");
  let previous: PairDescriptor["engine"] = { mode: "basic" };
  if (currentEngine?.mode === "signed") {
    const candidate = { ...currentEngine, compatibility: cli.compatibility };
    if (resolveVerifiedInstalledArtifact(candidate, env).path !== null) previous = candidate;
  }
  if (previous.mode === "signed" && !options.refresh) return { engine: previous };
  if (options.signal?.aborted) return { engine: previous, reason: "cancelled" };
  try {
    options.onNetwork?.();
    const result = await stageEngineRelease({ channel: "stable", env, compatibility: cli.compatibility,
      ...(options.signal ? { signal: options.signal } : {}) });
    const engine: PairDescriptor["engine"] = { mode: "signed", artifactPath: result.artifactPath,
      manifest: result.manifest, compatibility: cli.compatibility, trust: "pinned-root" };
    // Re-read on disk; an acquisition result alone cannot establish runtime trust.
    if (result.trust !== "pinned-root" || resolveVerifiedInstalledArtifact(engine, env).path === null) {
      return { engine: previous, reason: "engine-unverifiable" };
    }
    return { engine };
  } catch (error) {
    return { engine: previous, reason: error instanceof EngineInstallError ? error.code : "engine-unavailable",
      ...(error instanceof EngineInstallError && error.requiredEulaVersion ? { requiredEulaVersion: error.requiredEulaVersion } : {}) };
  }
}
