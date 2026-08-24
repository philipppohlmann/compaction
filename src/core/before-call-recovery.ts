/**
 * LOCAL-ONLY original-prompt retention for an APPROVED before-call mutation (PUBLIC CLI/SDK code -
 * engine-free).
 *
 * When, and ONLY when, the operator explicitly approves a whitelist-safe before-call compaction, the
 * ORIGINAL prompt must remain recoverable. This module writes the original to a LOCAL-ONLY artifact
 * under `<cwd>/.compaction/before-call-recovery/<id>` and returns a CONTENT-SAFE pointer (the id + the
 * path). The rails (binding):
 * - `.compaction/` is gitignored → the artifact is NEVER committed, NEVER uploaded, NEVER synced.
 * - The recovery id is CONTENT-FREE (random, never derived from the prompt) so the pointer that rides
 *   on the activity event leaks nothing about the content.
 * - ONLY this file holds the prompt text. The caller puts the POINTER (not the text) on the activity
 *   event. The prompt text is never logged.
 * - If retention cannot be completed for ANY reason, the caller MUST NOT apply the mutation (it runs
 *   the original command unchanged), an un-recoverable mutation is never performed.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

/** The gitignored subtree that holds retained originals (local-only). */
export const BEFORE_CALL_RECOVERY_DIRNAME = "before-call-recovery";

export interface RetainedOriginal {
  /** Content-free recovery id (random; never derived from content). */
  recoveryId: string;
  /** Absolute path to the local-only artifact holding the original prompt. */
  recoveryPath: string;
  /** A content-safe pointer suitable for the activity event (id + path, NEVER the prompt text). */
  pointer: string;
}

function recoveryDir(cwd: string): string {
  return path.join(cwd, ".compaction", BEFORE_CALL_RECOVERY_DIRNAME);
}

/**
 * Retain `original` locally and return a content-safe pointer. Throws if the artifact cannot be
 * written, the caller treats a throw as "retention failed → do NOT apply, run the original unchanged".
 * `idFactory` is injectable for deterministic tests; production uses a random UUID.
 */
export function retainOriginalPrompt(
  original: string,
  opts: { cwd?: string; idFactory?: () => string } = {}
): RetainedOriginal {
  const cwd = opts.cwd ?? process.cwd();
  const recoveryId = (opts.idFactory ?? randomUUID)();
  const dir = recoveryDir(cwd);
  mkdirSync(dir, { recursive: true });
  const recoveryPath = path.join(dir, `${recoveryId}.txt`);
  // The ORIGINAL prompt text lives ONLY here (local-only, gitignored). Never logged, never uploaded.
  writeFileSync(recoveryPath, original, "utf8");
  return {
    recoveryId,
    recoveryPath,
    // Content-safe: id + path only. This is what may ride on the (content-free) activity event.
    pointer: `before-call-recovery:${recoveryId}`
  };
}
