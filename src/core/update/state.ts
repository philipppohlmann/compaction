import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { identifyProcess, processIdentityStatus } from "./process-identity.js";
import type { ManagedState, ProcessIdentity } from "./types.js";
import { assertOwnedDirectory } from "./ownership.js";

export function syncDirectory(directory: string): void {
  const fd = openSync(directory, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export function atomicWrite(file: string, contents: string | Buffer, mode = 0o600): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", mode);
  try { writeFileSync(fd, contents); fsyncSync(fd); }
  finally { closeSync(fd); }
  try { renameSync(temporary, file); syncDirectory(path.dirname(file)); }
  finally { if (existsSync(temporary)) unlinkSync(temporary); }
}

export function readState(root: string): ManagedState {
  const state = JSON.parse(readFileSync(path.join(root, "state.json"), "utf8")) as ManagedState;
  if (state.schema !== 1 || !Number.isSafeInteger(state.revision) || state.revision < 0
    || state.integrationSchema !== 1 || !Array.isArray(state.rejectedPairIds) || !state.current) {
    throw new Error("Invalid managed pair state");
  }
  return state;
}

/** One durable rename selects the entire CLI/engine pair. Journal contains identifiers only. */
export function writeState(root: string, state: ManagedState, operation: "bootstrap" | "stage" | "activate" | "rollback"): void {
  const id = randomUUID();
  const journal = path.join(root, "transactions", `${id}.json`);
  const record = { schema: 1, id, operation, revision: state.revision, current: state.current.id,
    previous: state.previous?.id, staged: state.staged?.id, stagedIntent: state.stagedIntent };
  atomicWrite(journal, JSON.stringify({ ...record, status: "prepared" }) + "\n");
  atomicWrite(path.join(root, "state.json"), JSON.stringify(state) + "\n");
  atomicWrite(journal, JSON.stringify({ ...record, status: "committed" }) + "\n");
}

function removeOwnedLock(lock: string, nonce: string): void {
  try { unlinkSync(path.join(lock, nonce)); } catch { return; }
  // A competing admission can replace the empty directory. Its nonempty owner prevents removal.
  try { rmdirSync(lock); } catch { /* New owner or directory already removed. */ }
}

/** Prepared nonempty directories avoid both the owner-file creation gap and stale-reaper ABA. */
export async function withManagedLock<T>(root: string, body: () => T | Promise<T>, timeoutMs = 5_000): Promise<T> {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  assertOwnedDirectory(root);
  const owner = identifyProcess();
  const lock = path.join(root, "runtime.lock");
  const prepared = path.join(root, `.lock-${owner.nonce}`);
  mkdirSync(prepared, { mode: 0o700 });
  atomicWrite(path.join(prepared, owner.nonce), JSON.stringify(owner));
  const deadline = Date.now() + timeoutMs;
  let acquired = false;
  try {
    while (!acquired) {
      try { renameSync(prepared, lock); acquired = true; }
      catch (error) {
        if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        try {
          const names = readdirSync(lock);
          if (names.length === 1) {
            const old = JSON.parse(readFileSync(path.join(lock, names[0]), "utf8")) as ProcessIdentity;
            if (old.nonce === names[0] && processIdentityStatus(old) === "dead") removeOwnedLock(lock, old.nonce);
          }
        } catch { /* Contention, incomplete metadata, and unknown identity never justify a steal. */ }
        if (Date.now() >= deadline) throw new Error("Managed runtime is busy; retry at the next launch");
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
    }
    return await body();
  } finally {
    removeOwnedLock(acquired ? lock : prepared, owner.nonce);
  }
}
