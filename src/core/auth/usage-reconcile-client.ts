/**
 * Usage-reconciliation client (PUBLIC client) — the CLI network side of uploading this
 * device's CONTENT-FREE usage-journal entries.
 *
 * NO DEFAULT ENDPOINT. The host is always the one the user named (flag > env > the service this
 * device logged in to), exactly as `lease-client.ts` resolves it. This client never falls back to a
 * compiled-in hosted address.
 *
 * WHY IT LIVES HERE. `src/core/auth/` is a FORBIDDEN substring on the Open basic import graph
 * (`tests/security/open-basic-engine-free.test.ts`), which is exactly why the network half belongs
 * here and not next to the journal. `src/core/usage/**` stays network-free and pure — `compaction
 * usage` claims no network call and package-smoke asserts an offline, side-effect-free module load —
 * so this module imports the journal's PURE readers and does the I/O itself.
 *
 * RECONCILIATION NEVER GATES THE WORKFLOW. It is never an
 * implicit per-turn fetch and never enters the apply path (`resolveStoredAuthorizationApply`). A
 * device that cannot reach the service keeps working.
 *
 * WHERE IT IS REACHED FROM. The explicit `compaction usage reconcile` command, a best-effort attempt
 * in `compaction lease`, and — since the allowance ceiling has to be able to arrive without the user
 * knowing either of those exists — `ensureCommunityRuntime`, which runs on the surfaces that already
 * run by themselves during normal Community use. That is still ONCE PER INVOCATION of such a
 * surface, not once per request: the per-turn boundary is the line that does not move.
 *
 * CONTENT-FREE: the uploaded fields are exactly the journal's fixed fields (ids, counts, labels,
 * timestamps, hashes). `optimized_input_tokens` is a `chars/4` LOCAL-ESTIMATE PRODUCT ALLOWANCE
 * unit — never a bill, cost, or savings figure. The device token is a Bearer credential and is
 * never logged.
 */
import { credentialedFetchInit, describeCredentialedFetchFailure } from "../net/credentialed-fetch.js";
import { currentPeriodId } from "../entitlement/lease.js";
import { readStoredCredentials } from "./credentials.js";
import {
  chunkEntries,
  entriesToReconcile,
  readUsageJournal,
  type UsageJournalEntry
} from "../usage/usage-journal.js";
import {
  advanceReconciliationWatermark,
  readReconciliationWatermark,
  watermarkForPeriod
} from "../usage/reconciliation-watermark.js";
import type { ConfigDirEnv } from "../config-dir.js";
import { terminalSafeText } from "../terminal-hyperlink.js";

/** Max entries per request. Matches the server's strict schema ceiling (~350 KB vs its 1 MB limit). */
export const RECONCILE_BATCH_SIZE = 500;

/** Upload deadline per chunk. A hung service must never wedge `compaction lease` (which is not gated on this). */
export const RECONCILE_TIMEOUT_MS = 10_000;

export class UsageReconcileClientError extends Error {
  constructor(
    message: string,
    /** Coded reason for callers/tests; never contains a token. */
    readonly code:
      | "http_error"
      | "unauthorized"
      | "unavailable"
      | "device_inactive"
      | "invalid_response"
      | "network"
      /** The caller aborted the attempt (user pressed Esc / Ctrl-C). NOT a service failure. */
      | "cancelled",
    /**
     * What was ALREADY COMMITTED before this failure, when anything was. Chunks are uploaded
     * sequentially and each one commits server-side on its own, so a failure on chunk 3 leaves
     * chunks 1-2 recorded. Without this a caller could only say "nothing was uploaded", which is
     * FALSE in exactly that case — and it would obscure why the next lease is already reduced.
     */
    readonly partial?: UsageReconcileSummary
  ) {
    super(message);
    this.name = "UsageReconcileClientError";
  }
}

/** One chunk's server verdict. Counts and fixed labels only. */
export interface UsageReconcileResponse {
  period_id: string;
  accepted: number;
  duplicate: number;
  rejected: Array<{ event_id: string; reason: string }>;
  chain_continuous: boolean;
}

/** The totals across every uploaded chunk. */
export interface UsageReconcileSummary {
  uploaded: number;
  accepted: number;
  duplicate: number;
  rejected: Array<{ event_id: string; reason: string }>;
  /** False when ANY chunk reported a chain discontinuity (a recorded signal, never a refusal). */
  chainContinuous: boolean;
  periodId?: string;
  /**
   * The CONTIGUOUS PREFIX of uploaded entries the server confirmed (accepted or already-recorded),
   * in order, stopping at the first rejection. This is what the local reconciliation watermark
   * advances to, so the client stops charging those tokens a second time.
   *
   * Contiguous ON PURPOSE: the watermark is a POSITION in the hash chain, so it may only move to a
   * point with nothing unconfirmed behind it. Stopping at the first rejection keeps any rejected
   * entry — and everything after it — counted locally, which is the conservative direction.
   */
  confirmed: UsageJournalEntry[];
}

function parseResponse(body: Record<string, unknown>): UsageReconcileResponse | undefined {
  if (typeof body.period_id !== "string") return undefined;
  if (typeof body.accepted !== "number" || typeof body.duplicate !== "number") return undefined;
  if (!Array.isArray(body.rejected)) return undefined;
  const rejected: Array<{ event_id: string; reason: string }> = [];
  for (const raw of body.rejected) {
    if (!raw || typeof raw !== "object") return undefined;
    const r = raw as { event_id?: unknown; reason?: unknown };
    if (typeof r.event_id !== "string" || typeof r.reason !== "string") return undefined;
    rejected.push({ event_id: r.event_id, reason: r.reason });
  }
  return {
    period_id: body.period_id,
    accepted: body.accepted,
    duplicate: body.duplicate,
    rejected,
    chain_continuous: body.chain_continuous !== false
  };
}

/** Upload ONE chunk. Throws a coded error on any non-200; never returns a partial success. */
async function uploadChunk(
  apiUrl: string,
  deviceToken: string,
  entries: UsageJournalEntry[],
  signal?: AbortSignal
): Promise<UsageReconcileResponse> {
  let res: Response;
  try {
    // The device token is a credential: it goes to the host the user named and NOWHERE else. The
    // shared credentialed init refuses redirects, so no response can move the token to another host.
    res = await fetch(
      `${apiUrl.replace(/\/+$/, "")}/v0/usage/reconcile`,
      credentialedFetchInit({
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${deviceToken}` },
        body: JSON.stringify({ schema_version: 1, entries }),
        // BOTH deadlines, not one: the timeout still bounds a hung service, and the caller's signal
        // (onboarding's Esc / Ctrl-C) still cancels in flight. `AbortSignal.any` fires on whichever
        // comes first, so adding cancellation cannot lengthen the timeout or vice versa.
        signal:
          signal === undefined
            ? AbortSignal.timeout(RECONCILE_TIMEOUT_MS)
            : AbortSignal.any([signal, AbortSignal.timeout(RECONCILE_TIMEOUT_MS)])
      })
    );
  } catch (error) {
    // A caller ABORT lands here too. It is the user's decision, not a service fault, so it gets its
    // own code rather than being reported as an unreachable service.
    if (signal?.aborted === true) {
      throw new UsageReconcileClientError("usage reconciliation was cancelled", "cancelled");
    }
    // `redirect: "error"` THROWS before any status is available, so the refusal is decoded here into
    // an operator-readable reason instead of the runtime's opaque `fetch failed`.
    throw new UsageReconcileClientError(describeCredentialedFetchFailure(error), "network");
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    // Non-JSON body — the status carries the news.
  }
  if (res.status === 200) {
    const parsed = parseResponse(body);
    if (!parsed) throw new UsageReconcileClientError("reconcile response was malformed", "invalid_response");
    return parsed;
  }
  const error = typeof body.error === "string" ? body.error : "";
  if (res.status === 401) throw new UsageReconcileClientError("device token was not accepted", "unauthorized");
  if (error === "usage_reconcile_unavailable") {
    throw new UsageReconcileClientError("the service is not configured to accept usage reconciliation", "unavailable");
  }
  if (error === "device_inactive") {
    throw new UsageReconcileClientError("this device is no longer active", "device_inactive");
  }
  const detail = terminalSafeText(error);
  throw new UsageReconcileClientError(
    `usage reconcile failed (HTTP ${res.status}${detail ? `, ${detail}` : ""})`,
    "http_error"
  );
}

/**
 * Upload `entries` in ORDERED, SEQUENTIAL chunks. Order matters: the server's chain walk advances
 * its anchor per batch, so chunks sent concurrently or out of order would report discontinuities
 * that are artefacts of the transport rather than facts about the journal.
 *
 * Throws on the first chunk that fails — a partially uploaded batch is safe to retry because the
 * server's `event_id` uniqueness makes a replay a no-op for anything already recorded.
 */
export async function reconcileUsage(
  apiUrl: string,
  deviceToken: string,
  entries: UsageJournalEntry[],
  opts: { signal?: AbortSignal } = {}
): Promise<UsageReconcileSummary> {
  const summary: UsageReconcileSummary = {
    uploaded: 0,
    accepted: 0,
    duplicate: 0,
    rejected: [],
    chainContinuous: true,
    confirmed: []
  };
  // Once a rejection is seen, no LATER entry may join the confirmed prefix — the watermark is a
  // chain position and must have nothing unconfirmed behind it.
  let prefixIntact = true;
  for (const chunk of chunkEntries(entries, RECONCILE_BATCH_SIZE)) {
    let result: UsageReconcileResponse;
    try {
      result = await uploadChunk(apiUrl, deviceToken, chunk, opts.signal);
    } catch (error) {
      // Earlier chunks are ALREADY COMMITTED server-side. Carry them out with the failure so the
      // caller can record the watermark and report honestly instead of claiming nothing was sent.
      if (error instanceof UsageReconcileClientError && summary.uploaded > 0) {
        throw new UsageReconcileClientError(error.message, error.code, summary);
      }
      throw error;
    }
    summary.uploaded += chunk.length;
    summary.accepted += result.accepted;
    summary.duplicate += result.duplicate;
    summary.rejected.push(...result.rejected);
    if (!result.chain_continuous) summary.chainContinuous = false;
    summary.periodId = result.period_id;

    if (prefixIntact) {
      const rejectedIds = new Set(result.rejected.map((r) => r.event_id));
      for (const entry of chunk) {
        if (rejectedIds.has(entry.event_id)) {
          prefixIntact = false;
          break;
        }
        summary.confirmed.push(entry);
      }
    }
  }
  return summary;
}

/**
 * Advance the local watermark to the last confirmed entry OF EACH PERIOD in `confirmed`.
 *
 * Per period because the upload window spans the current and the immediately-preceding period, and
 * the local tally is computed per period. Best-effort: a write failure costs accuracy (those entries
 * get counted locally again — the conservative direction), never correctness.
 *
 * THE COUNT IS CUMULATIVE, NOT THIS BATCH. `reconciled_count` is how many entries the stored
 * position stands for, and the store refuses any write naming a smaller one. The upload window
 * already excludes everything behind the current position, so a batch count is the number of entries
 * SINCE the last reconcile — normally fewer than the last batch, and therefore refused as a rewind.
 * Adding to what is stored keeps the number meaning what the store reads it as; without it the
 * position sticks at the first reconcile forever and the entries behind it get charged locally on top
 * of the allowance the lease already deducted them from.
 *
 * THE ANTI-REWIND GUARANTEE IS SINGLE-WRITER. Because the count written is `read base + added`, it is
 * always at least the base it was read from, so the store's count comparison cannot tell a writer
 * holding a stale base from a current one — two overlapping reconciles can land the older position
 * last. Nothing is serialized here and no lock is taken. That is tolerable rather than correct: the
 * count is advisory (the amount is always re-derived from the journal, never from this field), the
 * position still names a genuinely server-confirmed entry, and a rewind only re-counts already-
 * confirmed entries locally until the next reconcile — the conservative direction, self-healing.
 */
async function recordWatermark(summary: UsageReconcileSummary, env: ConfigDirEnv): Promise<void> {
  const addedByPeriod = new Map<string, { entryHash: string; added: number }>();
  for (const entry of summary.confirmed) {
    const seen = addedByPeriod.get(entry.period_id);
    addedByPeriod.set(entry.period_id, {
      entryHash: entry.entry_hash,
      added: (seen?.added ?? 0) + 1
    });
  }
  if (addedByPeriod.size === 0) return;
  const stored = await readReconciliationWatermark(env);
  for (const [periodId, position] of addedByPeriod) {
    const count = (watermarkForPeriod(stored, periodId)?.reconciled_count ?? 0) + position.added;
    await advanceReconciliationWatermark({ periodId, entryHash: position.entryHash, count }, env);
  }
}

/**
 * The `YYYY-MM` period immediately before `periodId`. Computed on a UTC `Date` so a December→January
 * rollover is handled by the calendar rather than by string arithmetic.
 */
export function previousPeriodId(periodId: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(periodId);
  if (!match) return periodId;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1));
  date.setUTCMonth(date.getUTCMonth() - 1);
  return currentPeriodId(date);
}

/** Why a reconcile attempt did nothing. Fixed, content-free labels. */
export type ReconcileSkipReason = "not-logged-in" | "nothing-to-reconcile";

export type StoredUsageReconcileResult =
  | { reconciled: true; summary: UsageReconcileSummary }
  | { reconciled: false; reason: ReconcileSkipReason };

/**
 * Read this device's journal and upload the entries worth reconciling. The ONE orchestration both
 * triggers share (`compaction usage reconcile` and the best-effort attempt inside `compaction
 * lease`), so the two can never disagree about which entries are sent.
 *
 * WINDOW: the contiguous suffix for THIS device covering the current and immediately-preceding
 * server-clock period. The server-side ceiling sums only the current period, and the previous one
 * covers the boundary race for entries recorded just before a rollover. No cursor file is persisted:
 * replay is idempotent and cheap server-side (`event_id` is UNIQUE), and a cursor would be one more
 * corruptible local file whose failure mode is silently skipping entries.
 *
 * The journal's INTEGRITY is deliberately not a precondition. Every entry is verified independently
 * server-side (signature + its own hash), and chain continuity is judged there; refusing to upload
 * off a journal that does not verify locally would withhold real consumption from the ceiling, which
 * is the wrong direction. `compaction usage` remains the surface that reports local integrity.
 *
 * THROWS only `UsageReconcileClientError`. Callers on a non-blocking path must catch — reconciliation
 * must never gate the workflow.
 */
export async function reconcileStoredUsage(
  apiUrl: string,
  env: ConfigDirEnv & NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
  opts: { signal?: AbortSignal } = {}
): Promise<StoredUsageReconcileResult> {
  const credentials = readStoredCredentials(env);
  if (!credentials) return { reconciled: false, reason: "not-logged-in" };

  const period = currentPeriodId(now);
  const previous = previousPeriodId(period);
  const { entries } = await readUsageJournal(env);
  // The window EXCLUDES what the service has already confirmed. Without this, a device with a
  // settled journal re-uploaded its whole window on every attempt and got back a summary of pure
  // duplicates — a success, so far as the caller could tell. That was tolerable while the only
  // triggers were explicit commands; it is not, now that an automatic path calls this and treats a
  // successful reconciliation as a reason to re-acquire the lease.
  const watermark = await readReconciliationWatermark(env);
  const toSend = entriesToReconcile(entries, {
    deviceId: credentials.device_id,
    periodIds: [period, previous],
    reconciledThrough: {
      [period]: watermarkForPeriod(watermark, period)?.reconciled_through_entry_hash,
      [previous]: watermarkForPeriod(watermark, previous)?.reconciled_through_entry_hash
    }
  });
  if (toSend.length === 0) return { reconciled: false, reason: "nothing-to-reconcile" };

  let summary: UsageReconcileSummary;
  try {
    summary = await reconcileUsage(apiUrl, credentials.device_token, toSend, {
      ...(opts.signal === undefined ? {} : { signal: opts.signal })
    });
  } catch (error) {
    // A partial failure still COMMITTED its earlier chunks server-side, so their tokens are already
    // out of the next lease's allowance. Record the watermark for them before rethrowing, or the
    // client would charge those same tokens locally a second time.
    if (error instanceof UsageReconcileClientError && error.partial) {
      await recordWatermark(error.partial, env);
    }
    throw error;
  }
  await recordWatermark(summary, env);
  return { reconciled: true, summary };
}
