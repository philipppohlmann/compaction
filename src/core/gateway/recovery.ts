/**
 * Compaction Gateway APPLY recovery store (PUBLIC CLI/SDK core, engine-free).
 *
 * When apply mode changes a request body, the ORIGINAL body is retained LOCALLY here so the exact
 * pre-mutation request is always recoverable. This is the ONE place gateway request content is persisted
 *, deliberately, for recovery, and it is:
 *   - local-only under `<cwd>/.compaction/gateway/recovery/` (gitignored; NEVER uploaded),
 *   - written with restrictive `0600` permissions where the OS supports it,
 *   - referenced from receipts by `recovery_id` ONLY (the content-free receipt never carries the body).
 *
 * `compaction gateway recover <recovery_id>` reads it back. Nothing here ever leaves the machine.
 *
 * THE `gitignored` CLAIM IS NOW SELF-ENFORCING. It used to rest entirely on
 * line 3 of THIS repository's `.gitignore` — a user's own repository has no such entry, and nothing in
 * `src/` or `scripts/` ever wrote one. That was tolerable only while the store was effectively cold on a
 * published install: the sole writers were an explicit per-invocation `--mode apply` and the
 * lease-gated stored-authorization path, which no shipped build could reach because no production trust
 * root had been minted for it. (That root is pinned now, so the argument no longer holds even in the
 * form it was made — which is the point: the fix below does not rest on it.) Wiring
 * Open `basic` gateway shaping made it HOT — one file per shaped POST, automatically, in the user's
 * project directory, each containing that turn's full request body (their prompt, and for an agent tool
 * the source files embedded in it). A store like that must not depend on the user having guessed to
 * ignore it. `ensureRecoveryDirIgnored` writes `.compaction/.gitignore` containing `*` the first time
 * the directory is created; git honours a nested `.gitignore`, so the whole Compaction state directory
 * stays out of `git status` and out of commits.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync } from "node:fs";
import path from "node:path";

export const GATEWAY_RECOVERY_DIR = ".compaction/gateway/recovery";

export interface RecoveryRecord {
  recovery_id: string;
  captured_at: string;
  endpoint: string;
  policy: string;
  /** The EXACT original request body (pre-mutation). Local-only; the receipt never carries this. */
  original_body: string;
}

function recoveryDir(cwd: string): string {
  return path.join(cwd, GATEWAY_RECOVERY_DIR);
}

/**
 * Make `<cwd>/.compaction/` self-ignoring, so the retained request bodies below can never be staged or
 * committed from a user's project.
 *
 * Written at the `.compaction` root rather than inside `gateway/recovery/`, because everything under it
 * is local machine state and none of it belongs in a user's history. `*` ignores the directory's whole
 * contents including this file. Never overwrites an existing one — a user who has deliberately written
 * their own rules there keeps them.
 *
 * BEST-EFFORT BY DESIGN: a failure here must not block a retention that is itself the precondition for
 * a safe mutation. The caller's contract is "no saved original ⇒ do not mutate"; adding "and no ignore
 * file ⇒ do not mutate" would turn a read-only filesystem quirk into a workflow outage for no safety
 * gain, since the body is written with `0600` either way.
 */
function ensureRecoveryDirIgnored(cwd: string): void {
  try {
    const stateDir = path.join(cwd, ".compaction");
    const ignoreFile = path.join(stateDir, ".gitignore");
    if (existsSync(ignoreFile)) return;
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      ignoreFile,
      "# Written by Compaction. Local machine state only - never commit it.\n" +
        "# `gateway/recovery/` holds the byte-exact ORIGINAL request bodies that apply/shaping replaced,\n" +
        "# so that `compaction gateway recover <id>` can return them. They contain your prompts.\n" +
        "*\n",
      { encoding: "utf8", mode: 0o600 }
    );
  } catch {
    /* best-effort - see the docblock; never blocks retention */
  }
}

function recoveryPath(cwd: string, recoveryId: string): string {
  return path.join(recoveryDir(cwd), `${recoveryId}.json`);
}

/**
 * Persist the original request body for recovery and return a fresh `recovery_id`. Best-effort restrictive
 * permissions (0700 dir, 0600 file). Synchronous + fail-safe: throws only if the write genuinely fails
 * (the caller treats a failure as "do NOT mutate" - apply must never proceed without a saved original).
 */
export function saveOriginalForRecovery(
  cwd: string,
  params: { endpoint: string; policy: string; originalBody: string; now?: () => string; id?: () => string }
): string {
  const recoveryId = (params.id ?? (() => randomUUID()))();
  const dir = recoveryDir(cwd);
  // BEFORE the body is written, not after: the window between creating the file and ignoring it is when
  // an unlucky `git add -A` would pick it up.
  ensureRecoveryDirIgnored(cwd);
  mkdirSync(dir, { recursive: true });
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* best-effort - some filesystems (e.g. Windows) ignore POSIX modes */
  }
  const record: RecoveryRecord = {
    recovery_id: recoveryId,
    captured_at: (params.now ?? (() => new Date().toISOString()))(),
    endpoint: params.endpoint,
    policy: params.policy,
    original_body: params.originalBody
  };
  const file = recoveryPath(cwd, recoveryId);
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* best-effort */
  }
  return recoveryId;
}

/**
 * Delete a retained original that its own request ABANDONED — the apply was declined after
 * retention, so no mutation was forwarded and no receipt, activity record, or usage entry will ever
 * carry this `recovery_id`. Such a record is unreachable content on disk: `compaction gateway
 * recover` takes an id, and the only surfaces that publish ids are the ones written for an APPLIED
 * mutation. Keeping it would accumulate original request bodies nobody can find or remove.
 *
 * ONLY the abandoning request may call this, and only for the id IT created in THIS call: a record
 * referenced by an applied mutation must never be removed (recovery of a real mutation is the whole
 * point of the store).
 *
 * BEST-EFFORT + TOTAL: returns whether the file is gone, never throws. The caller has already
 * decided to forward the original unchanged, and cleanup must not alter that outcome.
 */
export function discardRecoveryRecord(cwd: string, recoveryId: string): boolean {
  try {
    rmSync(recoveryPath(cwd, recoveryId), { force: true });
    return !existsSync(recoveryPath(cwd, recoveryId));
  } catch {
    return false;
  }
}

/** Read a recovery record back by id, or null when it does not exist / cannot be parsed. */
export function readRecovery(cwd: string, recoveryId: string): RecoveryRecord | null {
  const file = recoveryPath(cwd, recoveryId);
  if (!existsSync(file)) return null;
  try {
    const rec = JSON.parse(readFileSync(file, "utf8")) as RecoveryRecord;
    return rec && typeof rec.original_body === "string" ? rec : null;
  } catch {
    return null;
  }
}
