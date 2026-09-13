import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWrite, withManagedLock } from "./state.js";
import { loadManagedInstallation, validatePair } from "./ownership.js";
import { identifyProcess, processGroupStatus, processIdentityStatus } from "./process-identity.js";
import type { PairDescriptor, ProcessIdentity, SessionLease } from "./types.js";

export const SESSION_PIN_ENV = "COMPACTION_SESSION_PIN";
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function sessionFile(root: string, id: string): string {
  if (!SESSION_ID.test(id)) throw new Error("Invalid session reference");
  return path.join(root, "sessions", `${id}.json`);
}

export function readSession(root: string, id: string): SessionLease {
  const lease = JSON.parse(readFileSync(sessionFile(root, id), "utf8")) as SessionLease;
  if (lease.schema !== 1 || lease.id !== id || !Array.isArray(lease.owners) || lease.owners.length === 0
    || lease.owners.some((owner) => !Number.isSafeInteger(owner.pid) || owner.pid <= 0
      || typeof owner.birth !== "string" || !SESSION_ID.test(owner.nonce))) throw new Error("Invalid session lease");
  return lease;
}

export function sessionIsLive(lease: SessionLease): boolean {
  return lease.owners.some((owner) => processIdentityStatus(owner) !== "dead")
    || (lease.processGroups ?? []).some((group) => processGroupStatus(group) !== "dead");
}

/** Unknown/corrupt records block activation. Cleanup requires OS proof, never an age cutoff. */
export function activeSessions(root: string): SessionLease[] {
  const directory = path.join(root, "sessions");
  if (!existsSync(directory)) return [];
  const live: SessionLease[] = [];
  for (const name of readdirSync(directory)) {
    if (!name.endsWith(".json")) continue;
    const lease = readSession(root, name.slice(0, -5));
    if (sessionIsLive(lease)) live.push(lease);
    else unlinkSync(sessionFile(root, lease.id));
  }
  return live;
}

/** Hooks use this bounded local lookup; they never check releases or mutate pair selection. */
export function resolveSessionPin(root: string, token: string): PairDescriptor | undefined {
  try {
    const { state } = loadManagedInstallation(root, false);
    const lease = readSession(root, token);
    if (!sessionIsLive(lease)) return undefined;
    const pair = [state.current, state.previous].find((entry) => entry?.id === lease.pair.id);
    if (!pair || JSON.stringify(pair) !== JSON.stringify(lease.pair)) return undefined;
    validatePair(root, pair, false);
    return pair;
  } catch { return undefined; }
}

export async function addSessionOwner(root: string, id: string, owner: ProcessIdentity, processGroup?: number): Promise<void> {
  await withManagedLock(root, () => {
    const lease = readSession(root, id);
    if (processIdentityStatus(owner) !== "alive") throw new Error("Child process identity changed before admission");
    lease.owners.push(owner);
    if (processGroup !== undefined) lease.processGroups = [...(lease.processGroups ?? []), processGroup];
    atomicWrite(sessionFile(root, id), JSON.stringify(lease) + "\n");
  });
}

export async function removeSession(root: string, id: string): Promise<void> {
  await withManagedLock(root, () => {
    try {
      const lease = readSession(root, id);
      if (lease.owners.some((owner) => owner.pid !== process.pid && processIdentityStatus(owner) !== "dead")
        || (lease.processGroups ?? []).some((group) => processGroupStatus(group) !== "dead")) return;
      unlinkSync(sessionFile(root, id));
    } catch { /* Incomplete cleanup keeps the lease conservative. */ }
  });
}

/** Owns the complete inherited-stdio command lifetime, including shim capture/settlement postludes. */
export async function runManagedSession(root: string, command: string, args: string[], options: {
  env?: NodeJS.ProcessEnv;
  commandForPair?: (pair: PairDescriptor) => { command: string; args: string[] } | Promise<{ command: string; args: string[] }>;
} = {}): Promise<number> {
  const env = options.env ?? process.env;
  const inherited = env[SESSION_PIN_ENV];
  let lease: SessionLease;
  let ownsLease = false;
  await withManagedLock(root, async () => {
    const { state } = loadManagedInstallation(root);
    if (inherited) {
      if (!resolveSessionPin(root, inherited)) throw new Error("Managed session reference is expired or invalid");
      lease = readSession(root, inherited);
      lease.owners.push(identifyProcess());
    } else {
      ownsLease = true;
      lease = { schema: 1, id: randomUUID(), pair: state.current, owners: [identifyProcess()] };
    }
    if (options.commandForPair) {
      const selected = await options.commandForPair(lease.pair);
      command = selected.command;
      args = selected.args;
    }
    atomicWrite(sessionFile(root, lease.id), JSON.stringify(lease) + "\n");
  });
  const admitted = lease!;
  const childModule = fileURLToPath(new URL("./session-child.js", import.meta.url));
  const child = fork(childModule, [], { stdio: ["inherit", "inherit", "inherit", "ipc"],
    env: { ...env, COMPACTION_HOME: path.dirname(root), COMPACTION_CONFIG_DIR: path.dirname(root), [SESSION_PIN_ENV]: admitted.id }, execArgv: [] });
  const forward = (signal: NodeJS.Signals) => { try { child.kill(signal); } catch { /* Already exited. */ } };
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  const handlers = signals.map((signal) => () => forward(signal));
  signals.forEach((signal, index) => process.on(signal, handlers[index]));
  try {
    return await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve(code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1)));
      child.once("message", async (message) => {
        try {
          if (!message || typeof message !== "object" || !("ready" in message) || !child.pid) throw new Error("Invalid child admission handshake");
          await addSessionOwner(root, admitted.id, identifyProcess(child.pid));
          child.send({ root, id: admitted.id, command, args });
        } catch (error) { child.kill(); reject(error); }
      });
    });
  } finally {
    signals.forEach((signal, index) => process.off(signal, handlers[index]));
    if (ownsLease) await removeSession(root, admitted.id);
  }
}

/** A hook without a pin establishes a conservative owner lease for the invoking process. */
export async function registerUntrackedHook(root: string): Promise<SessionLease> {
  return withManagedLock(root, () => {
    const { state } = loadManagedInstallation(root, false);
    const owner = identifyProcess(process.ppid);
    const existing = activeSessions(root).find((lease) => lease.pair.id === state.current.id
      && lease.owners.some((candidate) => candidate.pid === owner.pid && candidate.birth === owner.birth));
    if (existing) return existing;
    const lease: SessionLease = { schema: 1, id: randomUUID(), pair: state.current, owners: [owner] };
    atomicWrite(sessionFile(root, lease.id), JSON.stringify(lease) + "\n");
    return lease;
  });
}
