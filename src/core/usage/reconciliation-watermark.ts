/**
 * Reconciliation watermark (PUBLIC client) — which journal entries the SERVER has
 * already recorded, so the client does not charge the same tokens twice.
 *
 * THE BUG THIS FIXES. The server issues `allowance_tokens = limit − (debits it has recorded for the
 * period)`. The client then computed `remaining = allowance_tokens − (its FULL period journal
 * total)`. Once entries were reconciled, both sides subtracted the same tokens: `(limit − x) − x`.
 * Reconciling half an allowance left the renewed device immediately exhausted. The local tally must
 * therefore subtract only the entries the server has NOT yet recorded.
 *
 * A POSITION, NOT A NUMBER (load-bearing). This file stores the `entry_hash` of the last entry known
 * to be recorded server-side — never a token total. The amount is always re-derived from the signed,
 * hash-chained journal itself, so a hand-edited watermark cannot assert an arbitrary figure; it can
 * only point somewhere in the real chain. A position that does not appear in the journal is not
 * believed at all.
 *
 * FAIL-SAFE DIRECTION (load-bearing). Every failure — file missing, unreadable, malformed, or naming
 * an entry that is not in the journal — resolves to "nothing is reconciled", which makes the client
 * subtract the FULL period total. That is the conservative direction: it under-states remaining
 * headroom (the pre-fix behaviour) and can never grant more than the signed lease allows.
 *
 * TRUST BOUNDARY, STATED HONESTLY. A user who edits this file to claim everything is reconciled gets
 * at most the allowance the SERVER already signed — the lease is still the hard outer bound, so this
 * introduces no capability beyond deleting the journal, which local-integrity-is-advisory already
 * concedes (see `usage-journal.ts`). It is an accounting refinement inside a server-set ceiling, not
 * a security control, and it is not presented as one.
 *
 * PURITY: `node:fs/promises` + `config-dir` only. No network, no engine, no account import — the
 * `src/core/usage/**` rail stays network-free and `compaction usage` keeps its no-network claim.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { compactionConfigDir, type ConfigDirEnv } from "../config-dir.js";

/** The watermark file name (`<configDir>/usage-reconciled.json`, 0600). */
export const RECONCILIATION_WATERMARK_FILENAME = "usage-reconciled.json";

/** Frozen schema version of the watermark file. */
export const RECONCILIATION_WATERMARK_SCHEMA_VERSION = 1 as const;

/** What the server is known to have recorded for ONE period. */
export interface PeriodWatermark {
  /** `entry_hash` of the last entry confirmed recorded server-side. A POSITION, never an amount. */
  reconciled_through_entry_hash: string;
  /** How many entries that position represents. Advisory/diagnostic; never used as an amount. */
  reconciled_count: number;
}

export interface ReconciliationWatermark {
  schema_version: typeof RECONCILIATION_WATERMARK_SCHEMA_VERSION;
  /** Keyed by `period_id` (`YYYY-MM`). */
  periods: Record<string, PeriodWatermark>;
}

/** Absolute path of the watermark file. */
export function reconciliationWatermarkPath(env: ConfigDirEnv = process.env): string {
  return join(compactionConfigDir(env), RECONCILIATION_WATERMARK_FILENAME);
}

function parseWatermark(raw: unknown): ReconciliationWatermark | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (r.schema_version !== RECONCILIATION_WATERMARK_SCHEMA_VERSION) return undefined;
  if (!r.periods || typeof r.periods !== "object") return undefined;
  const periods: Record<string, PeriodWatermark> = {};
  for (const [periodId, value] of Object.entries(r.periods as Record<string, unknown>)) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(periodId)) continue;
    if (!value || typeof value !== "object") continue;
    const v = value as Record<string, unknown>;
    if (typeof v.reconciled_through_entry_hash !== "string") continue;
    if (!/^[0-9a-f]{64}$/.test(v.reconciled_through_entry_hash)) continue;
    const count = typeof v.reconciled_count === "number" && Number.isInteger(v.reconciled_count) && v.reconciled_count >= 0
      ? v.reconciled_count
      : 0;
    periods[periodId] = { reconciled_through_entry_hash: v.reconciled_through_entry_hash, reconciled_count: count };
  }
  return { schema_version: RECONCILIATION_WATERMARK_SCHEMA_VERSION, periods };
}

/**
 * Read the whole watermark. NEVER throws: any failure resolves to "nothing reconciled" (an empty
 * map), which is the fail-safe direction — the caller then counts every entry locally.
 */
export async function readReconciliationWatermark(
  env: ConfigDirEnv = process.env
): Promise<ReconciliationWatermark> {
  const empty: ReconciliationWatermark = { schema_version: RECONCILIATION_WATERMARK_SCHEMA_VERSION, periods: {} };
  let raw: string;
  try {
    raw = await readFile(reconciliationWatermarkPath(env), "utf8");
  } catch {
    return empty; // missing (the common case) or unreadable — both mean "assume nothing reconciled"
  }
  try {
    return parseWatermark(JSON.parse(raw)) ?? empty;
  } catch {
    return empty;
  }
}

/** The reconciled position for one period, or undefined when nothing is known to be reconciled. */
export function watermarkForPeriod(
  watermark: ReconciliationWatermark,
  periodId: string
): PeriodWatermark | undefined {
  return watermark.periods[periodId];
}

/**
 * Record that the server has confirmed entries through `entryHash` for `periodId`.
 *
 * MONOTONE WITHIN A PERIOD: the position only advances when the new `reconciled_count` is at least
 * the stored one, so a late/out-of-order write cannot rewind it and start double-counting again.
 * (Rewinding would only be conservative, but flapping between two positions is not something a
 * caller should have to reason about.)
 *
 * Best-effort by design: this runs AFTER a successful upload, and a write failure must not turn a
 * completed reconcile into an error the user sees. Losing it costs accuracy (the entries get counted
 * locally again) but never correctness.
 */
export async function advanceReconciliationWatermark(
  input: { periodId: string; entryHash: string; count: number },
  env: ConfigDirEnv = process.env
): Promise<void> {
  if (!/^[0-9a-f]{64}$/.test(input.entryHash)) return;
  try {
    const current = await readReconciliationWatermark(env);
    const existing = current.periods[input.periodId];
    if (existing && existing.reconciled_count > input.count) return; // never rewind
    const next: ReconciliationWatermark = {
      schema_version: RECONCILIATION_WATERMARK_SCHEMA_VERSION,
      periods: {
        ...current.periods,
        [input.periodId]: { reconciled_through_entry_hash: input.entryHash, reconciled_count: input.count }
      }
    };
    const dir = compactionConfigDir(env);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(reconciliationWatermarkPath(env), `${JSON.stringify(next, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
  } catch {
    // Best-effort: accuracy, not correctness. The fail-safe direction is to count entries locally.
  }
}
