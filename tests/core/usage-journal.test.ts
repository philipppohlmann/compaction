import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  USAGE_EVENT_SCHEMA_VERSION,
  USAGE_METER_VERSION,
  USAGE_SIGNING_DOMAIN,
  canonicalUsageEventBytes,
  fallbackOptimizedInputTokens,
  parseUsageEvent,
  type UsageEvent
} from "../../src/core/usage/usage-event.js";
import {
  USAGE_CHAIN_DOMAIN,
  USAGE_CHAIN_GENESIS,
  acquireFileLock,
  appendUsageEvent,
  classifyEntrySignature,
  usageJournalLockPath,
  computeEntryHash,
  readPeriodConsumption,
  readUsageJournal,
  sumOptimizedInputTokensForPeriod,
  usageJournalPath,
  verifyEntrySignature,
  verifyUsageChain
} from "../../src/core/usage/usage-journal.js";
import { LEASE_SIGNING_DOMAIN } from "../../src/core/entitlement/lease.js";
import { signDetached } from "../../src/core/crypto/ed25519.js";
import { publicKeyHash } from "../../src/core/crypto/key-hash.js";
import { generateDeviceKeyPair } from "../../src/core/auth/device-flow.js";

/**
 * The ceiling for appends whose subject is NOT the allowance (chaining, dedupe, signatures): an
 * allowance far above anything these events debit, so the required re-check passes and the test
 * observes the behaviour it is actually about. There is no ceiling-free append — `ceiling` is
 * required by the type, which is the point of making it required.
 */
const HEADROOM = { ceiling: { allowanceTokens: 1_000_000 } };

function baseEvent(overrides: Partial<UsageEvent> = {}): UsageEvent {
  return {
    schema_version: USAGE_EVENT_SCHEMA_VERSION,
    event_id: "11111111-1111-1111-1111-111111111111",
    receipt_id: "rec-1",
    lease_id: "lease-1",
    lease_sequence: 1,
    device_id: "dev-1",
    device_key_hash: "f".repeat(64),
    period_id: "2026-07",
    occurred_at: "2026-07-15T00:00:00.000Z",
    route_type: "api-key",
    workflow: "codex",
    provider: "openai",
    meter_version: USAGE_METER_VERSION,
    optimized_input_tokens: 100,
    estimated_input_tokens_after: 60,
    ...overrides
  };
}

/**
 * DOMAIN-TAG PINS — the drift guard that has to run in `npm test`.
 *
 * These literals are written out BY HAND on purpose. A test that interpolates the constant it is
 * checking (`` `${USAGE_SIGNING_DOMAIN}\n` ``) cannot detect a RENAME of that constant: both sides
 * of the assertion move together and it stays green. The literal pins for these tags live
 * server-side too (`apps/control-plane/test/**`), but the root vitest config EXCLUDES `apps/**`
 * (vitest.config.ts), so those pins do not run in `npm test` — a rename passed the entire root
 * suite and was caught only by the separate CI jobs.
 *
 * WHY IT MATTERS: the client SIGNS with these tags and the control plane VERIFIES with its own
 * re-implementation of them. If the two diverge, every signature fails to verify and NOTHING
 * throws — the usage ledger just silently stays empty. That is precisely the drift class this
 * machinery exists to prevent, so a rename must go red in a test that actually runs here.
 *
 * The DISJOINTNESS of these byte-spaces is itself a security property: domain separation is what
 * makes it impossible to replay a usage-event signature as a lease signature, or an entry-chain
 * preimage as either. Collapsing any two of them must fail loudly.
 */
const PINNED_USAGE_SIGNING_DOMAIN = "compaction-usage-v1";
const PINNED_USAGE_CHAIN_DOMAIN = "compaction-usage-chain-v1";
const PINNED_LEASE_SIGNING_DOMAIN = "compaction-lease-v1";

describe("frozen domain tags (rename guard — literals, never interpolated)", () => {
  it("the usage-event signing domain is exactly `compaction-usage-v1`", () => {
    expect(USAGE_SIGNING_DOMAIN).toBe(PINNED_USAGE_SIGNING_DOMAIN);
  });

  it("the usage-chain domain is exactly `compaction-usage-chain-v1`", () => {
    expect(USAGE_CHAIN_DOMAIN).toBe(PINNED_USAGE_CHAIN_DOMAIN);
  });

  it("the lease signing domain is exactly `compaction-lease-v1`", () => {
    expect(LEASE_SIGNING_DOMAIN).toBe(PINNED_LEASE_SIGNING_DOMAIN);
  });

  it("the three signing byte-spaces stay DISJOINT (domain separation is the security property)", () => {
    const domains = [USAGE_SIGNING_DOMAIN, USAGE_CHAIN_DOMAIN, LEASE_SIGNING_DOMAIN];
    expect(new Set(domains).size).toBe(3);
    // Not merely distinct: no tag may be a PREFIX of another, or the domain-tag-plus-newline
    // framing could be made ambiguous by a future tag rename (e.g. adding a `compaction-usage-v1x`).
    for (const a of domains) {
      for (const b of domains) {
        if (a !== b) expect(a.startsWith(b)).toBe(false);
      }
    }
  });
});

describe("usage-event canonical bytes", () => {
  it("pins the frozen domain-tagged byte order (drift guard)", () => {
    const bytes = canonicalUsageEventBytes(baseEvent()).toString("utf8");
    // The domain tag is a LITERAL here, not `${USAGE_SIGNING_DOMAIN}` — see the pins above.
    expect(bytes).toBe(
      "compaction-usage-v1\n" +
        '{"schema_version":1,"event_id":"11111111-1111-1111-1111-111111111111","receipt_id":"rec-1",' +
        '"lease_id":"lease-1","lease_sequence":1,"device_id":"dev-1",' +
        `"device_key_hash":"${"f".repeat(64)}","period_id":"2026-07",` +
        '"occurred_at":"2026-07-15T00:00:00.000Z","route_type":"api-key","workflow":"codex",' +
        '"provider":"openai","meter_version":"optimized-input-v1","optimized_input_tokens":100,' +
        '"estimated_input_tokens_after":60}'
    );
  });

  it("parseUsageEvent round-trips and rejects malformed", () => {
    expect(parseUsageEvent(baseEvent())).toEqual(baseEvent());
    expect(parseUsageEvent({ ...baseEvent(), period_id: "2026-7" })).toBeUndefined();
    expect(parseUsageEvent({ ...baseEvent(), optimized_input_tokens: -1 })).toBeUndefined();
    expect(parseUsageEvent({ ...baseEvent(), device_key_hash: "not-a-hash" })).toBeUndefined();
    expect(parseUsageEvent(null)).toBeUndefined();
  });

  it("fallback estimate is ceil(chars/4), min 1", () => {
    expect(fallbackOptimizedInputTokens("")).toBe(1);
    expect(fallbackOptimizedInputTokens("abcd")).toBe(1);
    expect(fallbackOptimizedInputTokens("a".repeat(9))).toBe(3);
  });
});

describe("usage-journal append + hash chain", () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

  function tmp(): { COMPACTION_CONFIG_DIR: string } {
    const dir = mkdtempSync(join(tmpdir(), "usage-journal-"));
    dirs.push(dir);
    return { COMPACTION_CONFIG_DIR: dir };
  }

  it("appends a chained entry, dedupes by event_id, and links prev_hash across entries", async () => {
    const env = tmp();
    const e1 = baseEvent({ event_id: "aaaaaaaa-0000-0000-0000-000000000001" });
    const e2 = baseEvent({ event_id: "aaaaaaaa-0000-0000-0000-000000000002", optimized_input_tokens: 250 });

    const r1 = await appendUsageEvent(e1, "sig1", HEADROOM, env);
    expect(r1.appended).toBe(true);
    const r2 = await appendUsageEvent(e2, "sig2", HEADROOM, env);
    expect(r2.appended).toBe(true);
    // Dedupe: same event_id → no-op.
    const dup = await appendUsageEvent(e1, "sig1", HEADROOM, env);
    expect(dup.appended).toBe(false);

    const { entries, skipped } = await readUsageJournal(env);
    expect(skipped).toEqual([]);
    expect(entries).toHaveLength(2);
    expect(entries[0].prev_hash).toBe(USAGE_CHAIN_GENESIS);
    expect(entries[1].prev_hash).toBe(entries[0].entry_hash); // chained
    expect(verifyUsageChain(entries)).toEqual({ valid: true, count: 2 });
    expect(sumOptimizedInputTokensForPeriod(entries, "2026-07")).toBe(350);
    expect(sumOptimizedInputTokensForPeriod(entries, "2026-08")).toBe(0);

    // mode 0600 on the journal file.
    const mode = (await import("node:fs")).statSync(usageJournalPath(env)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("detects tampering: editing any field breaks the chain", async () => {
    const env = tmp();
    await appendUsageEvent(baseEvent({ event_id: "bbbbbbbb-0000-0000-0000-000000000001" }), "sigA", HEADROOM, env);
    await appendUsageEvent(baseEvent({ event_id: "bbbbbbbb-0000-0000-0000-000000000002" }), "sigB", HEADROOM, env);

    // Tamper with the token count on line 1 (raw file edit), keep its stored entry_hash.
    const path = usageJournalPath(env);
    const lines = readFileSync(path, "utf8").trimEnd().split("\n");
    const tampered = JSON.parse(lines[0]);
    tampered.optimized_input_tokens = 999999;
    lines[0] = JSON.stringify(tampered);
    writeFileSync(path, `${lines.join("\n")}\n`, "utf8");

    const { entries } = await readUsageJournal(env);
    const verdict = verifyUsageChain(entries);
    expect(verdict.valid).toBe(false);
    if (!verdict.valid) expect(verdict.brokenAtIndex).toBe(0);
  });

  it("pins the frozen chain-hash vector (the chain domain rename guard)", () => {
    // Determinism and sig-sensitivity below cannot catch a RENAME of USAGE_CHAIN_DOMAIN — both
    // sides of those assertions move together. Only a hash pinned to a literal can, because the
    // domain tag is mixed into the digest. Same vector shape the control plane re-implements.
    expect(computeEntryHash(baseEvent(), "sig-fixture", USAGE_CHAIN_GENESIS)).toBe(
      "2625086c19efe8b04e3cd9201a89cd918e9a4ba64e2bfef284456b4ea47fc14b"
    );
  });

  it("computeEntryHash is deterministic and sig-sensitive", () => {
    const e = baseEvent();
    const h1 = computeEntryHash(e, "sig", USAGE_CHAIN_GENESIS);
    expect(computeEntryHash(e, "sig", USAGE_CHAIN_GENESIS)).toBe(h1);
    expect(computeEntryHash(e, "different-sig", USAGE_CHAIN_GENESIS)).not.toBe(h1);
  });

  it("verifyEntrySignature verifies a real device signature and rejects a wrong key", async () => {
    const env = tmp();
    const keys = generateDeviceKeyPair();
    const e = baseEvent({ event_id: "cccccccc-0000-0000-0000-000000000001" });
    const sig = signDetached(canonicalUsageEventBytes(e), keys.privateKeyPem);
    await appendUsageEvent(e, sig, HEADROOM, env);
    const { entries } = await readUsageJournal(env);
    expect(verifyEntrySignature(entries[0], keys.publicKey)).toBe(true);
    expect(verifyEntrySignature(entries[0], generateDeviceKeyPair().publicKey)).toBe(false);
  });

  it("readPeriodConsumption reports consumed + remaining (can go negative over the ceiling)", async () => {
    const env = tmp();
    await appendUsageEvent(baseEvent({ event_id: "dddddddd-0000-0000-0000-000000000001", optimized_input_tokens: 40 }), "s1", HEADROOM, env);
    await appendUsageEvent(baseEvent({ event_id: "dddddddd-0000-0000-0000-000000000002", optimized_input_tokens: 40 }), "s2", HEADROOM, env);
    expect(await readPeriodConsumption(100, "2026-07", env)).toEqual({ ok: true, consumed: 80, remaining: 20 });
    expect(await readPeriodConsumption(50, "2026-07", env)).toEqual({ ok: true, consumed: 80, remaining: -30 });
  });

  it("FAIL-CLOSED: a hand-edited entry makes the tally refuse instead of replenishing the allowance", async () => {
    const env = tmp();
    await appendUsageEvent(baseEvent({ event_id: "eeeeeeee-0000-0000-0000-000000000001", optimized_input_tokens: 200 }), "s1", HEADROOM, env);
    await appendUsageEvent(baseEvent({ event_id: "eeeeeeee-0000-0000-0000-000000000002", optimized_input_tokens: 100 }), "s2", HEADROOM, env);
    expect(await readPeriodConsumption(400, "2026-07", env)).toEqual({ ok: true, consumed: 300, remaining: 100 });

    // Lower the first entry's count by hand (no key needed). Naively summing would report 101
    // consumed and "replenish" ~299 tokens of allowance; the integrity gate must refuse instead.
    const path = usageJournalPath(env);
    const lines = readFileSync(path, "utf8").trimEnd().split("\n");
    const edited = JSON.parse(lines[0]);
    edited.optimized_input_tokens = 1;
    lines[0] = JSON.stringify(edited);
    writeFileSync(path, `${lines.join("\n")}\n`, "utf8");

    const after = await readPeriodConsumption(400, "2026-07", env);
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.reason).toBe("usage-journal-chain-invalid");
  });

  it("FAIL-CLOSED: a malformed/unparseable line refuses the tally (skipped lines are never ignored)", async () => {
    const env = tmp();
    await appendUsageEvent(baseEvent({ event_id: "ffffffff-0000-0000-0000-000000000001", optimized_input_tokens: 200 }), "s1", HEADROOM, env);
    const path = usageJournalPath(env);
    writeFileSync(path, `${readFileSync(path, "utf8")}{not json\n`, "utf8");
    const after = await readPeriodConsumption(400, "2026-07", env);
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.reason).toBe("usage-journal-malformed-line");
  });

  it("CONCURRENCY: simultaneous appends produce a strictly LINEAR chain (never a fork)", async () => {
    // The regression guard for the read-then-append race: every other test awaits sequentially, so
    // only a genuinely parallel append can catch a forked chain.
    const env = tmp();
    const events = Array.from({ length: 8 }, (_, i) =>
      baseEvent({ event_id: `abcd0000-0000-0000-0000-0000000000${(i + 10).toString(16)}`, optimized_input_tokens: 10 })
    );
    const results = await Promise.all(events.map((e, i) => appendUsageEvent(e, `sig-${i}`, HEADROOM, env)));
    expect(results.every((r) => r.appended)).toBe(true);

    const { entries, skipped } = await readUsageJournal(env);
    expect(skipped).toEqual([]);
    expect(entries).toHaveLength(8);
    expect(verifyUsageChain(entries)).toEqual({ valid: true, count: 8 });
    // Every prev_hash is distinct and links the previous entry — a fork would repeat one.
    expect(new Set(entries.map((e) => e.prev_hash)).size).toBe(8);
    expect(sumOptimizedInputTokensForPeriod(entries, "2026-07")).toBe(80);
    const consumption = await readPeriodConsumption(1000, "2026-07", env);
    expect(consumption).toEqual({ ok: true, consumed: 80, remaining: 920 });
  });

  it("CEILING: 8 simultaneous debits against an allowance that fits 3 commit exactly 3, never more", async () => {
    // The atomicity regression guard. Each of these 8 appends is handed the SAME allowance and the
    // same period — exactly the shape of N concurrent gateway applies. If the ceiling were evaluated
    // outside the append lock, all 8 would observe `consumed: 0` and all 8 would commit 240 tokens
    // against a 75-token allowance. Under the lock, each sees its predecessors' debits.
    const env = tmp();
    const events = Array.from({ length: 8 }, (_, i) =>
      baseEvent({ event_id: `bcde0000-0000-0000-0000-0000000000${(i + 10).toString(16)}`, optimized_input_tokens: 25 })
    );
    const results = await Promise.all(
      events.map((e, i) =>
        appendUsageEvent(e, `sig-${i}`, { ceiling: { allowanceTokens: 75 } }, env)
      )
    );
    expect(results.filter((r) => r.appended)).toHaveLength(3);
    results
      .filter((r) => !r.appended)
      .forEach((r) => {
        if (!r.appended) expect(r.reason).toContain("allowance-ceiling-exceeded");
      });

    const { entries, skipped } = await readUsageJournal(env);
    expect(skipped).toEqual([]);
    expect(sumOptimizedInputTokensForPeriod(entries, "2026-07")).toBe(75); // never above the allowance
    expect(verifyUsageChain(entries)).toEqual({ valid: true, count: 3 }); // still strictly linear
  });

  it("CEILING: the refusal reason is content-free (no counts, ids, or remaining figures)", async () => {
    const env = tmp();
    await appendUsageEvent(
      baseEvent({ event_id: "cdef0000-0000-0000-0000-000000000001", optimized_input_tokens: 90 }),
      "s1",
      { ceiling: { allowanceTokens: 100 } },
      env
    );
    const refused = await appendUsageEvent(
      baseEvent({ event_id: "cdef0000-0000-0000-0000-000000000002", optimized_input_tokens: 90 }),
      "s2",
      { ceiling: { allowanceTokens: 100 } },
      env
    );
    expect(refused.appended).toBe(false);
    if (refused.appended) return;
    expect(refused.reason).toContain("allowance-ceiling-exceeded");
    expect(refused.reason).not.toMatch(/[0-9]/); // no allowance / remaining / token figures leak
    expect((await readUsageJournal(env)).entries).toHaveLength(1); // nothing written
  });

  it("CEILING: an EXACTLY fitting debit is committed (the boundary refuses only what does not fit)", async () => {
    const env = tmp();
    await appendUsageEvent(
      baseEvent({ event_id: "def00000-0000-0000-0000-000000000001", optimized_input_tokens: 60 }),
      "s1",
      { ceiling: { allowanceTokens: 100 } },
      env
    );
    // Remaining is exactly 40 and this debit is exactly 40 — it fits.
    const exact = await appendUsageEvent(
      baseEvent({ event_id: "def00000-0000-0000-0000-000000000002", optimized_input_tokens: 40 }),
      "s2",
      { ceiling: { allowanceTokens: 100 } },
      env
    );
    expect(exact.appended).toBe(true);
    // …and one token more does not.
    const over = await appendUsageEvent(
      baseEvent({ event_id: "def00000-0000-0000-0000-000000000003", optimized_input_tokens: 1 }),
      "s3",
      { ceiling: { allowanceTokens: 100 } },
      env
    );
    expect(over.appended).toBe(false);
    const { entries } = await readUsageJournal(env);
    expect(sumOptimizedInputTokensForPeriod(entries, "2026-07")).toBe(100);
  });

  it("CEILING: a debit for ANOTHER period is not blocked by this period's consumption", async () => {
    const env = tmp();
    await appendUsageEvent(
      baseEvent({ event_id: "ef000000-0000-0000-0000-000000000001", optimized_input_tokens: 100 }),
      "s1",
      { ceiling: { allowanceTokens: 100 } },
      env
    );
    const nextPeriod = await appendUsageEvent(
      baseEvent({ event_id: "ef000000-0000-0000-0000-000000000002", period_id: "2026-08", optimized_input_tokens: 100 }),
      "s2",
      { ceiling: { allowanceTokens: 100 } },
      env
    );
    expect(nextPeriod.appended).toBe(true);
  });

  it("CEILING: an unverifiable journal FAILS CLOSED under the lock (no debit written)", async () => {
    // The under-lock re-check applies the SAME integrity gate as the pre-dispatch tally: a broken
    // chain must not be summed over and silently replenish the allowance at commit time either.
    const env = tmp();
    await appendUsageEvent(
      baseEvent({ event_id: "f0000000-0000-0000-0000-000000000001", optimized_input_tokens: 10 }),
      "s1",
      HEADROOM,
      env
    );
    const path = usageJournalPath(env);
    const edited = JSON.parse(readFileSync(path, "utf8").trimEnd());
    edited.optimized_input_tokens = 1;
    writeFileSync(path, `${JSON.stringify(edited)}\n`, "utf8");

    const result = await appendUsageEvent(
      baseEvent({ event_id: "f0000000-0000-0000-0000-000000000002", optimized_input_tokens: 5 }),
      "s2",
      { ceiling: { allowanceTokens: 1000 } },
      env
    );
    expect(result.appended).toBe(false);
    if (!result.appended) expect(result.reason).toContain("usage-journal-chain-invalid");
    expect(readFileSync(path, "utf8").trimEnd().split("\n")).toHaveLength(1); // nothing appended
  });

  it("device rotation reads as `device-rotated`, NOT as a signature failure, and keeps its history", async () => {
    const env = tmp();
    const oldKeys = generateDeviceKeyPair();
    const newKeys = generateDeviceKeyPair();
    const oldHash = publicKeyHash(oldKeys.publicKey);
    const newHash = publicKeyHash(newKeys.publicKey);

    // An entry signed by the PREVIOUS device key (before a logout/login rotation)…
    const older = baseEvent({ event_id: "11110000-0000-0000-0000-000000000001", device_key_hash: oldHash, optimized_input_tokens: 30 });
    await appendUsageEvent(older, signDetached(canonicalUsageEventBytes(older), oldKeys.privateKeyPem), HEADROOM, env);
    // …and one signed by the CURRENT key after it.
    const newer = baseEvent({ event_id: "11110000-0000-0000-0000-000000000002", device_key_hash: newHash, optimized_input_tokens: 20 });
    await appendUsageEvent(newer, signDetached(canonicalUsageEventBytes(newer), newKeys.privateKeyPem), HEADROOM, env);

    const { entries } = await readUsageJournal(env);
    expect(classifyEntrySignature(entries[0], newKeys.publicKey, newHash)).toBe("device-rotated");
    expect(classifyEntrySignature(entries[1], newKeys.publicKey, newHash)).toBe("verified");
    // The rotation neither breaks the chain nor loses the consumption history.
    expect(verifyUsageChain(entries).valid).toBe(true);
    expect(await readPeriodConsumption(100, "2026-07", env)).toEqual({ ok: true, consumed: 50, remaining: 50 });
  });

  it("BOUNDED LOCK: an un-stat-able lock path (dangling symlink) still returns within the deadline", async () => {
    // Regression for the busy-loop: `open(wx)` returns EEXIST forever on a dangling symlink while
    // `stat` (which follows the link) throws ENOENT. A retry path that skipped the deadline+backoff
    // would spin without yielding and never return — wedging the gateway's HTTP handler, not just
    // metering. The bound must hold on EVERY path.
    const env = tmp();
    const lockPath = usageJournalLockPath(env);
    mkdirSync(dirname(lockPath), { recursive: true });
    symlinkSync(join(dirname(lockPath), "does-not-exist-target"), lockPath);

    const started = Date.now();
    const acquired = await acquireFileLock(lockPath, () => Date.now(), 300);
    const elapsed = Date.now() - started;
    expect(acquired).toBe(false); // fail-closed, never a false acquire
    expect(elapsed).toBeGreaterThanOrEqual(250); // it actually waited (backoff honored, not a spin)
    expect(elapsed).toBeLessThan(5_000); // and it RETURNED, bounded by the deadline
  });

  it("BOUNDED LOCK: appendUsageEvent over an un-stat-able lock FAILS CLOSED (nothing written) and returns", async () => {
    const env = tmp();
    const lockPath = usageJournalLockPath(env);
    mkdirSync(dirname(lockPath), { recursive: true });
    symlinkSync(join(dirname(lockPath), "does-not-exist-target"), lockPath);

    const started = Date.now();
    const result = await appendUsageEvent(baseEvent({ event_id: "33330000-0000-0000-0000-000000000001" }), "sig", HEADROOM, env);
    const elapsed = Date.now() - started;
    expect(result.appended).toBe(false);
    if (!result.appended) expect(result.reason).toContain("lock unavailable");
    // The real 5s bound plus scheduling slack — the point is that it TERMINATES.
    expect(elapsed).toBeLessThan(20_000);
    rmSync(lockPath, { force: true });
    expect((await readUsageJournal(env)).entries).toHaveLength(0); // nothing written
  }, 30_000);

  it("an entry claiming THIS device key with a bad signature is `failed` (not excused as rotation)", async () => {
    const env = tmp();
    const keys = generateDeviceKeyPair();
    const hash = publicKeyHash(keys.publicKey);
    const e = baseEvent({ event_id: "22220000-0000-0000-0000-000000000001", device_key_hash: hash });
    const wrongSig = signDetached(canonicalUsageEventBytes(e), generateDeviceKeyPair().privateKeyPem);
    await appendUsageEvent(e, wrongSig, HEADROOM, env);
    const { entries } = await readUsageJournal(env);
    expect(classifyEntrySignature(entries[0], keys.publicKey, hash)).toBe("failed");
  });
});
