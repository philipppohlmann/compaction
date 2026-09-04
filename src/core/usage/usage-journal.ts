/**
 * Client hash-chained usage journal (PUBLIC client) — the append-only, content-free,
 * device-signed record of metered optimized-input full-applies, and the LOCAL consumed-so-far
 * tally that enforces the allowance ceiling WITHIN the life of one lease.
 *
 * It is no longer the only ceiling: the SERVER subtracts the consumption it has recorded
 * before signing the next lease, so the outer bound arrives in `allowance_tokens` and deleting this
 * file no longer restores headroom. This journal remains the authority for spend between renewals.
 *
 * `<configDir>/usage-journal.jsonl` (0600), one entry per line. Mirrors `activity-store.ts`'s
 * append + read + dedupe-by-id shape and ADDS a hash chain: each entry hashes {chain domain, the
 * previous entry_hash, the event's canonical signing bytes, the device signature}, so tampering with
 * ANY field (including the signature) breaks the chain from that entry forward.
 *
 * SERIALIZED TRANSACTION (load-bearing): the read→ceiling-check→dedupe→chain→append sequence is ONE
 * transaction. The gateway calls it from a concurrent HTTP handler, and separate workflow-scoped
 * gateway processes share one config dir, so it is serialized twice: an in-process promise-chain
 * mutex AND a cross-process `O_EXCL` lockfile. Without both, overlapping applies read the same tail
 * and fork the chain — which would make an untampered journal report "integrity broken" forever and
 * destroy the tamper-evidence signal.
 *
 * The ALLOWANCE DECISION is inside that same transaction, not merely the write: a remaining-allowance
 * test evaluated against a snapshot taken before the transaction is a check-then-act race, and N
 * overlapping applies would each pass it and each commit, exceeding the period ceiling.
 *
 * PURITY (load-bearing): imports ONLY `node:fs/promises` + `node:crypto` (via sibling pure helpers)
 * + `config-dir` + `usage-event` + `crypto/ed25519`. It imports NOTHING from `auth/` or `api-client/`
 * — so `compaction usage` (a pure local read + integrity verify) stays network-free and
 * account-import-free. The metering path (`usage-metering.ts`) supplies the device signature; this
 * module never touches a private key.
 *
 * CONTENT-FREE: fixed fields only (ids, counts, labels, timestamps). The ids kept here
 * (`event_id`/`recovery_id` — `receipt_id` on legacy schema v1 —/`lease_id`/`device_id`) are
 * journal-only; they are NEVER rendered in the content-free gateway receipt.
 * `optimized_input_tokens` is a PRODUCT ALLOWANCE unit, never a bill.
 *
 * THREE SIGNED SHAPES, ONE CHAIN. Schema v1 names the recovery id `receipt_id`; v2 names it
 * `recovery_id`; v3 additionally signs the before/after input-only meter basis. Nothing here
 * branches on that: the serializer this module hashes and verifies through does, so one journal may
 * hold all three as one unbroken chain. A mixed SCHEMA version is normal and must never fail closed.
 */
import { appendFile, mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { compactionConfigDir, type ConfigDirEnv } from "../config-dir.js";
import { publicKeyFromSpkiB64u, verifyDetachedSignature } from "../crypto/ed25519.js";
import {
  canonicalUsageEventBytes,
  parseUsageEvent,
  ACTIVE_USAGE_METER_VERSION,
  KNOWN_USAGE_METER_VERSIONS,
  type UsageEvent
} from "./usage-event.js";
import { readReconciliationWatermark, watermarkForPeriod } from "./reconciliation-watermark.js";

/** The single append-only journal file name. */
export const USAGE_JOURNAL_FILENAME = "usage-journal.jsonl";

/** Chain domain tag mixed into every entry hash (distinct from the event signing domain). */
export const USAGE_CHAIN_DOMAIN = "compaction-usage-chain-v1";

/** The fixed genesis `prev_hash` for the first entry in a journal. */
export const USAGE_CHAIN_GENESIS = "0".repeat(64);

/** The per-line fields the journal adds on top of the signed event payload. */
export interface UsageJournalChainFields {
  /** Base64url Ed25519 signature over `canonicalUsageEventBytes(event)` with the DEVICE private key. */
  device_event_signature: string;
  /** The previous entry's `entry_hash` (or the genesis constant for the first entry). */
  prev_hash: string;
  /** SHA-256 hex over {chain domain, prev_hash, canonical event bytes, signature}. */
  entry_hash: string;
  /** OPTIONAL: the engine-reported debit event id, recorded for reconciliation (client id is authoritative). */
  engine_event_id?: string;
}

/**
 * A stored journal line: the signed event + its device signature + the hash-chain links. An
 * INTERSECTION rather than an `extends`, because `UsageEvent` is a discriminated union — this
 * distributes over all schema versions and keeps `schema_version` narrowing an entry to its shape.
 */
export type UsageJournalEntry = UsageEvent & UsageJournalChainFields;

/** Absolute path of the usage journal (`<configDir>/usage-journal.jsonl`). */
export function usageJournalPath(env: ConfigDirEnv = process.env): string {
  return join(compactionConfigDir(env), USAGE_JOURNAL_FILENAME);
}

/** Compute the hash-chain `entry_hash` for one event linked onto `prevHash`. */
export function computeEntryHash(event: UsageEvent, signature: string, prevHash: string): string {
  return createHash("sha256")
    .update(USAGE_CHAIN_DOMAIN, "utf8")
    .update("\n", "utf8")
    .update(prevHash, "utf8")
    .update("\n", "utf8")
    .update(canonicalUsageEventBytes(event))
    .update("\n", "utf8")
    .update(signature, "utf8")
    .digest("hex");
}

/** Parse+validate a stored journal line into a full entry, or `undefined` (never throws). */
export function parseUsageJournalEntry(raw: unknown): UsageJournalEntry | undefined {
  const event = parseUsageEvent(raw);
  if (!event) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.device_event_signature !== "string" || r.device_event_signature.trim() === "") return undefined;
  if (typeof r.prev_hash !== "string" || !/^[0-9a-f]{64}$/.test(r.prev_hash)) return undefined;
  if (typeof r.entry_hash !== "string" || !/^[0-9a-f]{64}$/.test(r.entry_hash)) return undefined;
  return {
    ...event,
    device_event_signature: r.device_event_signature,
    prev_hash: r.prev_hash,
    entry_hash: r.entry_hash,
    ...(typeof r.engine_event_id === "string" && r.engine_event_id.trim() !== ""
      ? { engine_event_id: r.engine_event_id }
      : {})
  };
}

export interface SkippedUsageLine {
  /** 1-based line number in the JSONL log. */
  line: number;
  reason: string;
}

/**
 * Read all entries from the journal. A missing file means "no usage yet" (empty, not an error).
 * Invalid lines are SKIPPED with a reason; a duplicate `event_id` keeps the FIRST occurrence.
 */
export async function readUsageJournal(
  env: ConfigDirEnv = process.env
): Promise<{ entries: UsageJournalEntry[]; skipped: SkippedUsageLine[] }> {
  let raw: string;
  try {
    raw = await readFile(usageJournalPath(env), "utf8");
  } catch (error: unknown) {
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "unknown";
    if (code === "ENOENT") return { entries: [], skipped: [] };
    throw error;
  }
  const entries: UsageJournalEntry[] = [];
  const skipped: SkippedUsageLine[] = [];
  const seen = new Set<string>();
  raw.split("\n").forEach((line, index) => {
    if (line.trim() === "") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      skipped.push({ line: index + 1, reason: "invalid JSON" });
      return;
    }
    const entry = parseUsageJournalEntry(parsed);
    if (!entry) {
      skipped.push({ line: index + 1, reason: "invalid usage journal entry" });
      return;
    }
    if (seen.has(entry.event_id)) {
      skipped.push({ line: index + 1, reason: `duplicate event_id ${entry.event_id} - first occurrence kept` });
      return;
    }
    seen.add(entry.event_id);
    entries.push(entry);
  });
  return { entries, skipped };
}

/* ------------------------------------------------------------------------------------------------
 * Append serialization: in-process mutex + cross-process O_EXCL lockfile.
 * ---------------------------------------------------------------------------------------------- */

/** In-process serialization, per journal path: each append awaits the previous one's completion. */
const inProcessLocks = new Map<string, Promise<unknown>>();

/** Max time to wait for the cross-process lock before giving up (the caller then fails closed). */
const LOCK_ACQUIRE_TIMEOUT_MS = 5_000;
/** A lockfile older than this is treated as abandoned by a crashed process and broken. */
const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 15;

/** Absolute path of the cross-process append lockfile. */
export function usageJournalLockPath(env: ConfigDirEnv = process.env): string {
  return `${usageJournalPath(env)}.lock`;
}

/**
 * Acquire the cross-process lock (`O_EXCL` create). Retries until the timeout; breaks a lock whose
 * mtime is older than `LOCK_STALE_MS` (a crashed holder must not wedge metering forever). Returns
 * false when the lock could not be taken — the caller then FAILS CLOSED (no append, apply declines).
 *
 * BOUNDED ON EVERY PATH (load-bearing): the retry has exactly ONE exit-or-sleep point, and every
 * contended path falls through to it. No branch may `continue` past the deadline check or the
 * backoff — an unbounded, non-yielding spin here would not merely fail metering: the caller is
 * awaited inside the gateway's HTTP handler, so the user's request would never complete and the
 * in-process mutex would queue every later apply behind it. A path that cannot `stat` the lock
 * (holder released it mid-check, or a dangling symlink sits at the lock path) simply has nothing to
 * break and MUST still be counted against the deadline.
 *
 * `timeoutMs` is injectable so the bound itself can be regression-tested quickly.
 */
export async function acquireFileLock(
  lockPath: string,
  now: () => number,
  timeoutMs: number = LOCK_ACQUIRE_TIMEOUT_MS
): Promise<boolean> {
  const deadline = now() + timeoutMs;
  for (;;) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await handle.close();
      return true;
    } catch (error: unknown) {
      const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
      if (code !== "EEXIST") return false; // a real I/O failure — fail closed
    }

    // Contended. Best-effort break of an ABANDONED lock, then fall through — unconditionally — to the
    // single deadline check + backoff below.
    try {
      const st = await stat(lockPath);
      if (now() - st.mtimeMs > LOCK_STALE_MS) await rm(lockPath, { force: true });
    } catch {
      // Not stat-able: released between EEXIST and stat, or a dangling symlink occupies the path.
      // There is nothing safe to break here; the deadline below bounds the wait either way.
    }

    if (now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
  }
}

/**
 * Run `fn` with the journal append transaction serialized both in-process (promise chain) and
 * cross-process (`O_EXCL` lockfile). `onLockFailure` supplies the fail-closed result when the
 * cross-process lock cannot be acquired.
 */
async function withJournalLock<T>(env: ConfigDirEnv, onLockFailure: () => T, fn: () => Promise<T>): Promise<T> {
  const key = usageJournalPath(env);
  const previous = inProcessLocks.get(key) ?? Promise.resolve();
  const run = previous.then(async () => {
    const dir = compactionConfigDir(env);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const lockPath = usageJournalLockPath(env);
    const locked = await acquireFileLock(lockPath, () => Date.now());
    if (!locked) return onLockFailure();
    try {
      return await fn();
    } finally {
      await rm(lockPath, { force: true });
    }
  });
  // Keep the chain alive regardless of outcome; drop the entry when this is the last waiter.
  const settled = run.then(
    () => undefined,
    () => undefined
  );
  inProcessLocks.set(key, settled);
  void settled.then(() => {
    if (inProcessLocks.get(key) === settled) inProcessLocks.delete(key);
  });
  return run;
}

export type AppendUsageEventResult =
  | {
      appended: true;
      path: string;
      event_id: string;
      entry_hash: string;
      /**
       * Allowance left for the period AFTER this debit — the AUTHORITATIVE figure, because it is the
       * fresh under-lock tally minus the entry that was just written, not the caller's pre-dispatch
       * snapshot. Concurrent applies all observe the same stale snapshot before dispatch, so a
       * countdown derived from it would show headroom that a sibling request has already spent.
       * Never negative: the ceiling check above refuses the whole request before reaching here.
       */
      remaining_tokens: number;
    }
  | { appended: false; reason: string };

/**
 * The allowance ceiling this debit must fit inside, re-validated against the journal state read
 * INSIDE the append lock. REQUIRED on every append (see `appendUsageEvent`).
 *
 * ONE FIELD BY DESIGN: the period this debit counts against and the token count it commits are
 * facts OF THE EVENT (`period_id`, `optimized_input_tokens`), so the check reads them from the
 * event rather than accepting them again from the caller. A caller that could pass them separately
 * could pass a different period or a smaller count than the entry records, and the number refused
 * on would no longer be the number committed. The allowance is the only input the event does not
 * carry — it comes from the verified lease.
 */
export interface AppendCeiling {
  /** The period's total allowance, from the verified lease. */
  allowanceTokens: number;
}

/**
 * Append ONE metered usage event to the journal, chaining it onto the last entry. The whole
 * read→ceiling re-check→dedupe→chain→append sequence runs under the in-process mutex AND the
 * cross-process lockfile, so concurrent applies produce a strictly LINEAR chain (never a fork).
 * Dedupe: an `event_id` already present is a reported no-op. Local file I/O only, never a network
 * call. The caller (the metering path) has already signed `event` with the device key.
 *
 * ATOMIC CHECK-AND-DEBIT (load-bearing): the remaining-allowance test is evaluated against the
 * journal contents read INSIDE this lock and the append happens under the SAME lock — so check and
 * debit are one transaction. Validating against a snapshot taken before the (awaited,
 * concurrent-safe) engine dispatch would let N overlapping applies each observe the same remainder,
 * each pass, and each commit — total usage exceeding the period ceiling even though every individual
 * check passed. Serializing only the APPEND fixes chain forking, not this: the DECISION has to be
 * inside the lock too. A failed re-check writes nothing and reports why; the caller then declines
 * the apply (original forwarded unchanged).
 *
 * `ceiling` IS REQUIRED, and `options` with it: every entry this function writes is a metered debit
 * against a period allowance (a turn that compacts no input writes nothing at all — output shaping
 * alone is never a debit, on any route), so there is no append for which the re-check is optional. It was optional when introduced, which left the
 * invariant compiler-enforced on the metering context and convention-enforced here — the same
 * asymmetry that allowed the original check-then-debit race. If a genuinely non-metered append is
 * ever needed, it belongs in its own function with its own type, not behind an optional field here.
 *
 * The critical section stays short and purely local — no engine call and no network I/O ever runs
 * under this lock, so a slow upstream can never wedge the gateway's HTTP handler behind it.
 */
export async function appendUsageEvent(
  event: UsageEvent,
  signature: string,
  options: { ceiling: AppendCeiling; engineEventId?: string },
  env: ConfigDirEnv = process.env
): Promise<AppendUsageEventResult> {
  return withJournalLock<AppendUsageEventResult>(
    env,
    () => ({ appended: false, reason: "usage-journal lock unavailable - nothing written (fail-closed)" }),
    async () => {
      let read: { entries: UsageJournalEntry[]; skipped: SkippedUsageLine[] };
      try {
        read = await readUsageJournal(env);
      } catch {
        return { appended: false, reason: "usage-journal-unreadable - nothing written (fail-closed)" };
      }
      const { entries } = read;

      // DEDUPE FIRST: an event already in the journal writes nothing whatever the allowance says, so
      // reporting it as "already recorded" is both accurate and unable to overshoot anything.
      // Checking the ceiling first would mislabel a re-submitted debit as a ceiling refusal.
      if (entries.some((existing) => existing.event_id === event.event_id)) {
        return { appended: false, reason: `duplicate event_id ${event.event_id} - already recorded (dedupe; nothing written)` };
      }

      // THE ENTRY MUST BE DENOMINATED IN THE UNIT THE TALLY COUNTS. The ceiling below compares this
      // event's count against a tally of ACTIVE-unit entries only, so an event stamped with any other
      // unit would be checked against a balance it will never join: it passes the ceiling, is written,
      // and is then skipped by every subsequent read — an unbounded run of applies that consume
      // nothing. That is not a hypothetical shape. `resolveMeteredOptimizedInput` still returns the
      // documented `chars/4` fallback stamped `optimized-input-v1-fallback-chars4` when the engine
      // omits its count, and that estimate measures the PRE-MUTATION body — a v1 throughput quantity.
      // It cannot be charged to a balance denominated in tokens REMOVED, and it must not be charged
      // at zero cost either.
      //
      // So refuse it. The reason is deliberately NOT an allowance-ceiling reason: the caller's
      // fail-closed path forwards the original unchanged rather than degrading, because this is an
      // integrity condition (a debit that cannot be expressed) and not a user out of allowance.
      if (event.meter_version !== ACTIVE_USAGE_METER_VERSION) {
        return {
          appended: false,
          reason: "meter-version-not-active - this debit is denominated in a superseded unit and cannot be charged to the active allowance (nothing written; fail-closed)"
        };
      }

      // FRESH tally under the lock, integrity-gated exactly as `readPeriodConsumption` is (a
      // malformed line or a broken chain must not be summed over and silently replenish the
      // allowance). Same `>` boundary as the pre-commit check: an exactly-fitting request is
      // allowed, one token over refuses the WHOLE request — never a clamp, never a partial debit.
      // The period and the token count come from the ENTRY ABOUT TO BE WRITTEN, so what is refused
      // on and what would be committed are the same numbers by construction.
      // The watermark is read INSIDE the lock alongside the journal, so the authoritative re-check
      // sees the freshest reconciled position. A local file read only — no network ever runs under
      // this lock (that would wedge the gateway's HTTP handler behind a slow upstream).
      const watermark = await readReconciliationWatermark(env);
      const consumption = consumptionFromJournalRead(
        read,
        options.ceiling.allowanceTokens,
        event.period_id,
        watermarkForPeriod(watermark, event.period_id)?.reconciled_through_entry_hash
      );
      if (!consumption.ok) {
        return { appended: false, reason: `${consumption.reason} - nothing written (fail-closed)` };
      }
      if (event.optimized_input_tokens > consumption.remaining) {
        return {
          appended: false,
          reason: "allowance-ceiling-exceeded - remaining allowance for this period does not cover this request (nothing written; whole request refused, no auto-purchase)"
        };
      }

      const prevHash = entries.length === 0 ? USAGE_CHAIN_GENESIS : entries[entries.length - 1].entry_hash;
      const entryHash = computeEntryHash(event, signature, prevHash);
      const entry: UsageJournalEntry = {
        ...event,
        device_event_signature: signature,
        prev_hash: prevHash,
        entry_hash: entryHash,
        ...(options.engineEventId ? { engine_event_id: options.engineEventId } : {})
      };
      const path = usageJournalPath(env);
      await appendFile(path, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
      return {
        appended: true,
        path,
        event_id: event.event_id,
        entry_hash: entryHash,
        // Both terms come from inside the lock: `consumption.remaining` is the fresh integrity-gated
        // tally, and the token count is the one the entry just written actually commits.
        remaining_tokens: consumption.remaining - event.optimized_input_tokens
      };
    }
  );
}

/**
 * Sum `optimized_input_tokens` across the entries for one `period_id` (the consumed-so-far tally),
 * IN ONE UNIT.
 *
 * The unit parameter is not decoration. Across a migration boundary a period holds entries in two
 * incomparable quantities — v1 counted tokens INSPECTED, v2 counts tokens REMOVED, and v1 runs ~19x
 * v2 on real data. A meter-blind sum here is a number with no meaning, and `compaction usage` printed
 * exactly that: a two-unit total presented as "metered this period", with the difference against the
 * unreconciled tally then rendered as a reconciliation that never happened. Both figures are on the
 * one surface whose entire job is not overstating what is known.
 */
export function sumOptimizedInputTokensForPeriod(
  entries: UsageJournalEntry[],
  periodId: string,
  meterVersion: string = ACTIVE_USAGE_METER_VERSION
): number {
  return entries
    .filter((entry) => entry.period_id === periodId && entry.meter_version === meterVersion)
    .reduce((sum, entry) => sum + entry.optimized_input_tokens, 0);
}

/**
 * Sum only the entries for `periodId` that the SERVER has NOT yet recorded — the tally the local
 * ceiling must use.
 *
 * WHY THIS EXISTS: the lease's `allowance_tokens` is already `limit − (what the server recorded)`.
 * Subtracting the FULL period total from it charges the reconciled tokens twice — `(limit − x) − x`
 * — so reconciling half an allowance left the renewed device instantly exhausted. Only the entries
 * the server has not seen may be subtracted from the signed allowance.
 *
 * FAIL-SAFE: `reconciledThroughEntryHash` is believed ONLY if it names an entry actually present in
 * this period's entries. Absent, unknown, or naming an entry from another period ⇒ NOTHING is
 * treated as reconciled and the whole period total is returned — the conservative direction, which
 * under-states remaining headroom rather than granting more than the signed lease allows.
 *
 * The position is resolved against the entries as READ (file order), so the hash-chain integrity
 * gate that runs before this still governs whether the numbers may be trusted at all.
 */
export function sumUnreconciledOptimizedInputTokensForPeriod(
  entries: UsageJournalEntry[],
  periodId: string,
  reconciledThroughEntryHash?: string,
  /**
   * THE UNIT THIS BALANCE IS DENOMINATED IN. `optimized-input-v1` counts tokens INSPECTED;
   * `optimized-input-v2` counts tokens actually REMOVED. They are different quantities and summing
   * them produces a number that means nothing.
   *
   * So the tally counts ONLY entries stamped with the meter the allowance is denominated in. A period
   * containing both (only possible across a migration boundary) charges the active meter's entries and
   * leaves the other unit's history for audit, where it stays labelled and is never reinterpreted.
   *
   * DEFAULTS TO THE ACTIVE UNIT, never to a superseded one. A default naming the old meter is the
   * ceiling-bypass shape wearing a friendly name: it looks like backwards compatibility and it makes
   * every caller that forgets the argument sum to ZERO. `compaction usage` was exactly that caller —
   * it reported a full untouched allowance to a device that had spent, on a user-facing surface.
   */
  meterVersion: string = ACTIVE_USAGE_METER_VERSION
): number {
  const inPeriod = entries.filter((entry) => entry.period_id === periodId && entry.meter_version === meterVersion);
  const cut =
    reconciledThroughEntryHash === undefined
      ? -1
      : inPeriod.findIndex((entry) => entry.entry_hash === reconciledThroughEntryHash);
  // `-1` covers both "no watermark" and "watermark not found in this period" — both mean count all.
  return inPeriod.slice(cut + 1).reduce((sum, entry) => sum + entry.optimized_input_tokens, 0);
}

/**
 * The contiguous journal SUFFIX a reconciliation upload should carry. PURE — no fs, no
 * network, no new import. `src/core/usage/**` stays network-free by construction: `compaction usage`
 * claims no network call and package-smoke asserts an offline, side-effect-free module load, so the
 * uploader lives in `src/core/auth/` and this only decides WHICH entries it would send.
 *
 * CONTIGUOUS SUFFIX, not a filter: the chain links entries in file order, so the server can only
 * walk what is contiguous. This scans BACKWARD from the tail while entries match and returns that
 * run in order — a filter that skipped an entry in the middle would present a broken chain and be
 * reported as a discontinuity that never happened.
 *
 * `deviceId` matching drops entries signed by a PREVIOUS device key (a legitimate logout/login
 * rotation registers a NEW device). The server could only reject those — it holds the current
 * device's key alone — so sending them would produce a pile of honest-but-pointless rejections.
 *
 * `periodIds` is normally {current, previous}: the server-side ceiling sums only the CURRENT period,
 * and the previous one covers the boundary race for entries recorded just before a rollover.
 *
 * `reconciledThrough` maps a period to the entry the service has already CONFIRMED for it, and the
 * confirmed prefix is dropped. Re-sending it is harmless (the service dedupes by `event_id`), but
 * "harmless" is not "free": before this, every call re-uploaded the whole window and reported work
 * done, so a caller that reacts to a successful reconciliation — as the automatic entitlement repair
 * does, by re-acquiring the lease — did a round trip on every invocation instead of only when
 * something had actually changed. Trimming here is also what makes the SAME watermark decide both
 * halves of the disjoint tally: `sumUnreconciledOptimizedInputTokensForPeriod` already counts only
 * what lies beyond it, so the window uploaded and the window charged locally now agree by
 * construction rather than by coincidence.
 *
 * FAIL-SAFE, in the direction that cannot lose consumption: an absent or unrecognised hash drops
 * NOTHING and the full window is sent, which is exactly the previous behaviour. Contiguity survives
 * because a suffix of a contiguous suffix is still contiguous.
 */
export function entriesToReconcile(
  entries: UsageJournalEntry[],
  options: {
    deviceId: string;
    periodIds: readonly string[];
    reconciledThrough?: Readonly<Record<string, string | undefined>>;
  }
): UsageJournalEntry[] {
  const periods = new Set(options.periodIds);
  let start = entries.length;
  while (start > 0) {
    const entry = entries[start - 1];
    if (entry.device_id !== options.deviceId || !periods.has(entry.period_id)) break;
    start -= 1;
  }
  const window = entries.slice(start);
  const confirmed = options.reconciledThrough;
  if (!confirmed) return window;
  // The LAST position the service has confirmed, across the periods in the window. Scanning forward
  // and keeping the last match handles the {previous, current} boundary without assuming which
  // period a given entry belongs to.
  let cut = -1;
  for (let i = 0; i < window.length; i += 1) {
    const hash = confirmed[window[i].period_id];
    if (hash !== undefined && window[i].entry_hash === hash) cut = i;
  }
  return window.slice(cut + 1);
}

/**
 * Split entries into ordered chunks. Chunks are uploaded SEQUENTIALLY and in order — the
 * server's chain walk is order-dependent and advances its anchor per batch, so a concurrent or
 * out-of-order upload would report discontinuities that are artefacts of the transport.
 */
export function chunkEntries(entries: UsageJournalEntry[], size: number): UsageJournalEntry[][] {
  if (size < 1) return entries.length > 0 ? [entries] : [];
  const chunks: UsageJournalEntry[][] = [];
  for (let i = 0; i < entries.length; i += size) chunks.push(entries.slice(i, i + size));
  return chunks;
}

export type PeriodConsumption =
  | { ok: true; consumed: number; remaining: number }
  | { ok: false; reason: string };

/**
 * The LOCAL consumed/remaining tally for one period — the allowance ceiling WITHIN the life of one
 * lease. INTEGRITY-GATED and FAIL-CLOSED. `allowanceTokens` comes from the verified lease, and that
 * number is already net of the consumption the SERVER has recorded, so this subtracts
 * within-lease spend from a server-set bound rather than being the only ceiling there is.
 *
 * The tally is only meaningful if the journal it sums is intact, so this VERIFIES before it counts:
 * any unreadable/malformed line, or a hash chain that does not verify, returns `ok:false` and the
 * caller REFUSES the apply (degrade to forward-original). Counting only the surviving parsed entries
 * would let a hand-edited or truncated file silently LOWER the tally and replenish the allowance.
 *
 * A missing journal ⇒ `consumed: 0` (an honest empty tally, not an integrity failure). `remaining`
 * may go negative when a prior period boundary or a lowered allowance leaves the device over the
 * ceiling; the gate refuses at `<= 0` and never auto-purchases.
 *
 * NOTE (honest limitation): the chain proves nothing was edited, reordered, or
 * removed from the MIDDLE/HEAD, but a whole-file deletion or a TAIL truncation still reads as a
 * shorter valid chain — the device owner also holds the signing key, so local integrity is ADVISORY.
 * Reconciling entries to the server does NOT upgrade that: the server verifies the entries it
 * RECEIVED, which is not proof that this file is complete. What the server-side anchor adds is
 * DETECTION of a discontinuity, and what actually removes the incentive to truncate is the
 * server-authoritative ceiling — recorded debits are never deleted, so the sum only grows.
 */
export async function readPeriodConsumption(
  allowanceTokens: number,
  periodId: string,
  env: ConfigDirEnv = process.env
): Promise<PeriodConsumption> {
  let read: { entries: UsageJournalEntry[]; skipped: SkippedUsageLine[] };
  try {
    read = await readUsageJournal(env);
  } catch {
    return { ok: false, reason: "usage-journal-unreadable" };
  }
  const watermark = await readReconciliationWatermark(env);
  return consumptionFromJournalRead(
    read,
    allowanceTokens,
    periodId,
    watermarkForPeriod(watermark, periodId)?.reconciled_through_entry_hash
  );
}

/**
 * The integrity gate + tally, over journal contents ALREADY read. Pure and total.
 *
 * Shared deliberately: the pre-dispatch snapshot (`readPeriodConsumption`) and the under-the-lock
 * re-validation inside `appendUsageEvent` must apply the SAME integrity rules and the SAME
 * arithmetic, so the two can never disagree about what "remaining" means. Splitting it out is what
 * lets the authoritative check run on a read taken inside the append lock.
 *
 * `consumed` is the UNRECONCILED total: `allowanceTokens` already has the server-recorded
 * consumption subtracted out of it (the lease carries `limit − recorded`), so subtracting the full
 * period total here would charge those tokens twice. `reconciledThroughEntryHash` is the position
 * the server has confirmed; absent or unrecognised, every entry counts (fail-safe).
 */
function consumptionFromJournalRead(
  read: { entries: UsageJournalEntry[]; skipped: SkippedUsageLine[] },
  allowanceTokens: number,
  periodId: string,
  reconciledThroughEntryHash?: string
): PeriodConsumption {
  if (read.skipped.length > 0) return { ok: false, reason: "usage-journal-malformed-line" };
  const chain = verifyUsageChain(read.entries);
  if (!chain.valid) return { ok: false, reason: "usage-journal-chain-invalid" };
  // THE UNIT COMES FROM THE ONE CONSTANT THE WRITER ALSO STAMPS, and a unit this client cannot place
  // fails CLOSED.
  //
  // Two failure modes pull in opposite directions here and both are real.
  //
  // FAIL-OPEN: if the version this reader filters on ever differs from the version the writer stamps,
  // every check computes `consumed = 0` and the allowance stops existing while still looking
  // enforced. `ACTIVE_USAGE_METER_VERSION` keeps the reader
  // and `resolveMeteredOptimizedInput` name the SAME constant, so they cannot drift.
  //
  // FAIL-CLOSED-TOO-HARD: an earlier attempt derived the unit from the period's own entries and
  // refused any period carrying more than one. That bricks a device on the day the meter changes —
  // the current period already holds v1 entries, the first v2 debit makes the period mixed, and every
  // subsequent apply declines for the rest of the period. Our own migration is not the user's fault
  // and must not cost them the capability.
  //
  // So: a KNOWN superseded unit (v1, and the v1 chars/4 fallback) is audit history. It is skipped —
  // never summed into the active tally, never reinterpreted as active-unit tokens — because it was
  // charged against a different allowance in a different quantity (v1 throughput runs ~19x v2 on real
  // data, so a mixed sum means nothing). An UNRECOGNISED unit is a quantity this client cannot place
  // at all, most likely because it is behind the writer, and skipping it would silently drop real
  // consumption. That one refuses the tally.
  const unplaceable = read.entries.some(
    (entry) => entry.period_id === periodId && !KNOWN_USAGE_METER_VERSIONS.has(entry.meter_version)
  );
  if (unplaceable) return { ok: false, reason: "usage-journal-unknown-meter-version" };
  const consumed = sumUnreconciledOptimizedInputTokensForPeriod(
    read.entries,
    periodId,
    reconciledThroughEntryHash,
    ACTIVE_USAGE_METER_VERSION
  );
  return { ok: true, consumed, remaining: allowanceTokens - consumed };
}

export type UsageChainVerdict =
  | { valid: true; count: number }
  | { valid: false; count: number; brokenAtIndex: number; reason: string };

/**
 * Verify the hash chain over a list of entries (as read, in file order): each `prev_hash` links to
 * the prior `entry_hash` (genesis for the first) and each `entry_hash` recomputes from
 * {domain, prev_hash, canonical event bytes, signature}. Returns the first break, if any.
 */
export function verifyUsageChain(entries: UsageJournalEntry[]): UsageChainVerdict {
  let expectedPrev = USAGE_CHAIN_GENESIS;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.prev_hash !== expectedPrev) {
      return { valid: false, count: entries.length, brokenAtIndex: i, reason: "prev_hash does not link to the previous entry" };
    }
    const recomputed = computeEntryHash(entry, entry.device_event_signature, entry.prev_hash);
    if (recomputed !== entry.entry_hash) {
      return { valid: false, count: entries.length, brokenAtIndex: i, reason: "entry_hash does not match the entry contents" };
    }
    expectedPrev = entry.entry_hash;
  }
  return { valid: true, count: entries.length };
}

/**
 * Verify ONE entry's device signature against a base64url SPKI DER device public key. Total (never
 * throws): a malformed key or signature returns false. Used by `compaction usage` for the integrity
 * read (the public key is read from the credentials FILE by the caller — no private key involved).
 */
export function verifyEntrySignature(entry: UsageJournalEntry, devicePublicKeySpkiB64u: string): boolean {
  const key = publicKeyFromSpkiB64u(devicePublicKeySpkiB64u);
  if (!key) return false;
  return verifyDetachedSignature(canonicalUsageEventBytes(entry), entry.device_event_signature, key);
}

/**
 * Per-entry signature verdict against the CURRENT device key.
 *  - `verified`     — signed by this device key and the signature checks out.
 *  - `device-rotated` — signed by a DIFFERENT device key (`device_key_hash` mismatch). A legitimate
 *    `logout` + fresh `login` rotates the key; those entries are unverifiable with the current key
 *    but are NOT tampering (they remain hash-chain protected), and their consumption still counts.
 *  - `failed`       — claims this device key but the signature does not verify (a real anomaly).
 */
export type EntrySignatureVerdict = "verified" | "device-rotated" | "failed";

/** Classify one entry's signature against the current device public key + its hash. */
export function classifyEntrySignature(
  entry: UsageJournalEntry,
  currentDevicePublicKeySpkiB64u: string,
  currentDeviceKeyHash: string
): EntrySignatureVerdict {
  if (entry.device_key_hash !== currentDeviceKeyHash) return "device-rotated";
  return verifyEntrySignature(entry, currentDevicePublicKeySpkiB64u) ? "verified" : "failed";
}
