import path from "node:path";
import { realpathSync } from "node:fs";
import { verifyInstalledArtifact } from "../engine-install/verify.js";
import { readEngineEulaAcceptance } from "../legal/engine-eula.js";
import { compatibleFull } from "./compatibility.js";
import { containedPath, loadManagedInstallation, validatePair } from "./ownership.js";
import { hasUntrackedToolProcesses } from "./process-identity.js";
import { activeSessions } from "./sessions.js";
import { withManagedLock, writeState } from "./state.js";
import { automaticUpdatesEnabled } from "./scheduler.js";
import type { ManagedState, PairDescriptor, StagedIntent } from "./types.js";

export interface ActivationOptions {
  env?: NodeJS.ProcessEnv;
  gatewayBarrier: (root: string, currentPairId: string) => Promise<{ ok: boolean; reason?: string }>;
}
export type ActivationResult = { status: "active" | "rolled-back" | "unchanged" | "deferred"; reason?: string; state: ManagedState };

export function validateCompatiblePair(root: string, pair: PairDescriptor): void {
  validatePair(root, pair);
  if (pair.engine.mode === "basic") return;
  const home = path.dirname(realpathSync(root));
  const artifact = realpathSync(pair.engine.artifactPath);
  const engineRoot = realpathSync(path.join(home, "engine"));
  if (!containedPath(engineRoot, artifact)) throw new Error("Managed engine is outside verified engine storage");
  const env = { COMPACTION_CONFIG_DIR: home };
  const verified = verifyInstalledArtifact(artifact, env);
  const manifest = pair.engine.manifest;
  const accepted = manifest.schema_version === 2 ? readEngineEulaAcceptance(env, manifest.eula_version)?.version : undefined;
  if (!verified.verified || verified.trust !== "pinned-root"
    || JSON.stringify(verified.manifest) !== JSON.stringify(manifest)
    || JSON.stringify(pair.engine.compatibility) !== JSON.stringify(pair.cli.compatibility)
    || !compatibleFull(pair.cli.compatibility, verified, accepted)) throw new Error("Managed CLI/engine compatibility or trust cannot be verified");
}

export async function stagePair(root: string, pair: PairDescriptor, intent: StagedIntent, expectedRevision?: number, precondition?: () => boolean): Promise<ManagedState> {
  return withManagedLock(root, () => {
    if (intent !== "automatic" && intent !== "explicit") throw new Error("Invalid staged update intent");
    const { state } = loadManagedInstallation(root);
    if (expectedRevision !== undefined && state.revision !== expectedRevision) throw new Error("Managed release state changed during acquisition; retry staging");
    validateCompatiblePair(root, pair);
    if (state.rejectedPairIds.includes(pair.id)) throw new Error("Candidate was rolled back; select a different release");
    if (pair.id === state.current.id) return state;
    if (precondition && !precondition()) throw new Error("Update preferences changed during acquisition; candidate was not staged");
    const stagedIntent = state.staged?.id === pair.id && state.stagedIntent === "explicit" ? "explicit" : intent;
    if (state.staged?.id === pair.id && state.stagedIntent === stagedIntent) return state;
    const next = { ...state, revision: state.revision + 1, staged: pair, stagedIntent };
    writeState(root, next, "stage");
    return next;
  });
}

async function transition(root: string, rollback: boolean, options: ActivationOptions): Promise<ActivationResult> {
  return withManagedLock(root, async () => {
    const { state } = loadManagedInstallation(root);
    const candidate = rollback ? state.previous : state.staged;
    if (!candidate) return { status: "unchanged", state };
    const env = { ...(options.env ?? process.env), COMPACTION_CONFIG_DIR: path.dirname(realpathSync(root)) };
    const intentBlocker = (): string | undefined => {
      if (rollback) return;
      if (state.stagedIntent !== "automatic" && state.stagedIntent !== "explicit") return "staged-intent-unknown";
      if (state.stagedIntent === "automatic" && !automaticUpdatesEnabled(env)) return "automatic-updates-disabled";
    };
    const blocked = intentBlocker();
    if (blocked) return { status: "deferred", reason: blocked, state };
    if (!rollback && state.rejectedPairIds.includes(candidate.id)) return { status: "deferred", reason: "candidate-previously-rolled-back", state };
    const sessions = activeSessions(root);
    if (sessions.length) return { status: "deferred", reason: "active-sessions", state };
    if (hasUntrackedToolProcesses(root, new Set())) return { status: "deferred", reason: "untracked-tool-process", state };
    validateCompatiblePair(root, candidate);
    const barrier = await options.gatewayBarrier(root, state.current.id);
    if (!barrier.ok) return { status: "deferred", reason: barrier.reason ?? "gateway-busy-or-unverified", state };
    const next: ManagedState = { ...state, revision: state.revision + 1, current: candidate, previous: state.current,
      rejectedPairIds: rollback ? [...new Set([...state.rejectedPairIds, state.current.id])] : state.rejectedPairIds };
    delete next.staged;
    delete next.stagedIntent;
    const changed = intentBlocker();
    if (changed) return { status: "deferred", reason: changed, state };
    writeState(root, next, rollback ? "rollback" : "activate");
    return { status: rollback ? "rolled-back" : "active", state: next };
  });
}

export function tryActivate(root: string, options: ActivationOptions): Promise<ActivationResult> { return transition(root, false, options); }
export const trySafeActivate = tryActivate;
export function rollbackPair(root: string, options: ActivationOptions): Promise<ActivationResult> { return transition(root, true, options); }
