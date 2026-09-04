import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ACTIVE_USAGE_METER_VERSION,
  USAGE_EVENT_SCHEMA_VERSION,
  USAGE_EVENT_SCHEMA_VERSION_V2,
  USAGE_EVENT_SCHEMA_VERSION_V3,
  USAGE_SIGNING_DOMAIN,
  canonicalUsageEventBytes,
  fallbackOptimizedInputTokens,
  parseUsageEvent,
  recoveryIdOf,
  type UsageEvent,
  type UsageEventV1,
  type UsageEventV2,
  type UsageEventV3
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

/**
 * A LEGACY (schema v1) event — the shape every historical journal line has. It is the backward-
 * compatibility subject of this file: its canonical bytes are pinned below and must never move.
 */
function baseEvent(overrides: Partial<UsageEventV1> = {}): UsageEventV1 {
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
    // THE ACTIVE UNIT, because that is the only unit the store accepts: a debit stamped with a
    // superseded meter is refused before the ceiling is even consulted, so a fixture pinned to the
    // old label would be testing a path the product can no longer take.
    meter_version: ACTIVE_USAGE_METER_VERSION,
    optimized_input_tokens: 100,
    estimated_input_tokens_after: 60,
    ...overrides
  };
}

/** The CURRENT (schema v2) event — the same fields with the recovery id under its true name. */
function baseEventV2(overrides: Partial<UsageEventV2> = {}): UsageEventV2 {
  const { receipt_id: legacyKey, schema_version: _v1, ...common } = baseEvent();
  return {
    schema_version: USAGE_EVENT_SCHEMA_VERSION_V2,
    recovery_id: legacyKey,
    ...common,
    ...overrides
  };
}

/** Current schema v3 adds the signed before side of the active meter basis. */
function baseEventV3(overrides: Partial<UsageEventV3> = {}): UsageEventV3 {
  const { schema_version: _v2, ...common } = baseEventV2();
  return {
    ...common,
    schema_version: USAGE_EVENT_SCHEMA_VERSION_V3,
    estimated_input_tokens_before: 160,
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
    // The vector is FROZEN, so it is built from a frozen event — including the `optimized-input-v1`
    // label written as a literal. `baseEvent`'s default meter tracks whatever unit is active today;
    // letting that default flow into a pinned wire vector would make the vector move with the
    // product, which is the one thing a pin must not do.
    const bytes = canonicalUsageEventBytes(baseEvent({ meter_version: "optimized-input-v1" })).toString("utf8");
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

/** A throwaway config dir for the schema-v2 describe below (the append tests keep their own). */
const v2Dirs: string[] = [];
afterEach(() => v2Dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
function tmp2(): { COMPACTION_CONFIG_DIR: string } {
  const dir = mkdtempSync(join(tmpdir(), "usage-journal-v2-"));
  v2Dirs.push(dir);
  return { COMPACTION_CONFIG_DIR: dir };
}

/**
 * THE RECOVERY-ID RENAME. Schema v1 named the recovery id `receipt_id`; schema v2 names it
 * `recovery_id`. The v1 bytes above are FROZEN — a rename in place would change the preimage of
 * every historical signature and every historical `entry_hash` at once. These pin the v2 layout as
 * data (a second literal), pin the two layouts as DIFFERENT, and pin the exactly-one-key rule.
 */
describe("usage-event schema v2: the recovery id under its true name", () => {
  it("pins the v2 canonical bytes — the v1 layout with `recovery_id` at byte position 3", () => {
    // FROZEN, exactly as the v1 pin above is, and for the same reason: `baseEvent`'s meter default
    // tracks whatever unit is active today, and a pinned wire vector that moves with the product is
    // not a pin. The label is passed as the literal the vector was minted with.
    const bytes = canonicalUsageEventBytes(baseEventV2({ meter_version: "optimized-input-v1" })).toString("utf8");
    // Written by hand, exactly as the v1 pin is: an interpolated expectation would move with a
    // serializer change instead of catching it.
    expect(bytes).toBe(
      "compaction-usage-v1\n" +
        '{"schema_version":2,"event_id":"11111111-1111-1111-1111-111111111111","recovery_id":"rec-1",' +
        '"lease_id":"lease-1","lease_sequence":1,"device_id":"dev-1",' +
        `"device_key_hash":"${"f".repeat(64)}","period_id":"2026-07",` +
        '"occurred_at":"2026-07-15T00:00:00.000Z","route_type":"api-key","workflow":"codex",' +
        '"provider":"openai","meter_version":"optimized-input-v1","optimized_input_tokens":100,' +
        '"estimated_input_tokens_after":60}'
    );
  });

  it("the two layouts are DIFFERENT bytes (a v1 signature can never be replayed onto a v2 entry)", () => {
    expect(canonicalUsageEventBytes(baseEventV2()).equals(canonicalUsageEventBytes(baseEvent()))).toBe(false);
  });

  it("EXACTLY ONE recovery-id key, matching the declared version — anything else is refused", () => {
    expect(parseUsageEvent(baseEventV2())).toEqual(baseEventV2());
    // Both keys present, under either version: ambiguous signed layout, so it does not parse.
    expect(parseUsageEvent({ ...baseEvent(), recovery_id: "rec-1" })).toBeUndefined();
    expect(parseUsageEvent({ ...baseEventV2(), receipt_id: "rec-1" })).toBeUndefined();
    // The wrong key for the declared version.
    expect(parseUsageEvent({ ...baseEvent(), receipt_id: undefined, recovery_id: "rec-1" })).toBeUndefined();
    expect(parseUsageEvent({ ...baseEventV2(), recovery_id: undefined, receipt_id: "rec-1" })).toBeUndefined();
    // An unknown schema version has no known layout at all.
    expect(parseUsageEvent({ ...baseEventV2(), schema_version: 4 })).toBeUndefined();
  });

  it("recoveryIdOf reads the SAME id out of both shapes and reports which one it came from", () => {
    expect(recoveryIdOf(baseEvent())).toEqual({ recoveryId: "rec-1", provenance: "legacy-receipt-id-field" });
    expect(recoveryIdOf(baseEventV2())).toEqual({ recoveryId: "rec-1", provenance: "recovery-id-field" });
  });

  it("the provenance label is DERIVED — it never reaches the signed bytes or the stored line", async () => {
    const env = tmp2();
    const event = baseEventV2({ event_id: "e2e2e2e2-0000-0000-0000-000000000001" });
    expect(recoveryIdOf(event).provenance).toBe("recovery-id-field");
    expect(canonicalUsageEventBytes(event).toString("utf8")).not.toContain("provenance");
    await appendUsageEvent(event, "sig-v2", HEADROOM, env);
    const line = readFileSync(usageJournalPath(env), "utf8").trim();
    expect(line).not.toContain("provenance");
    expect(line).not.toContain("legacy-receipt-id-field");
    expect(line).not.toContain("receipt_id");
    expect(JSON.parse(line).recovery_id).toBe("rec-1");
  });

  it("a v1 line's id is NEVER resolved against the receipt store — the usage modules have no edge to it", () => {
    // The structural half of "never reinterpreted as a receipt id": `src/core/usage/**` cannot look
    // anything up in `receipts.jsonl`, because it does not import the module that reads it. Asserted
    // against the SHIPPED source (comments stripped, so the prose describing the misnomer — which
    // necessarily names the receipt store — cannot make this test pass or fail).
    const usageDir = join(dirname(fileURLToPath(import.meta.url)), "../../src/core/usage");
    const modules = readdirSync(usageDir).filter((f) => f.endsWith(".ts"));
    expect(modules.length).toBeGreaterThan(0);
    for (const file of modules) {
      const code = readFileSync(join(usageDir, file), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      expect(code, file).not.toMatch(/from\s+"[^"]*receipt/);
      expect(code, file).not.toMatch(/readReceipts|receipts\.jsonl/);
    }
    // The behavioural half: the legacy value comes back labelled as legacy recovery-id data.
    expect(recoveryIdOf(baseEvent()).provenance).toBe("legacy-receipt-id-field");
  });
});

describe("usage-event schema v3: signed recomputation basis", () => {
  it("pins v3 canonical bytes without moving the frozen v1/v2 layouts", () => {
    expect(canonicalUsageEventBytes(baseEventV3({ meter_version: "optimized-input-v2" })).toString("utf8")).toBe(
      "compaction-usage-v1\n" +
        '{"schema_version":3,"event_id":"11111111-1111-1111-1111-111111111111","recovery_id":"rec-1",' +
        '"lease_id":"lease-1","lease_sequence":1,"device_id":"dev-1",' +
        `"device_key_hash":"${"f".repeat(64)}","period_id":"2026-07",` +
        '"occurred_at":"2026-07-15T00:00:00.000Z","route_type":"api-key","workflow":"codex",' +
        '"provider":"openai","meter_version":"optimized-input-v2","optimized_input_tokens":100,' +
        '"estimated_input_tokens_before":160,"estimated_input_tokens_after":60}'
    );
  });

  it("requires before only on v3 and resolves the recovery id through the shared accessor", () => {
    expect(parseUsageEvent(baseEventV3())).toEqual(baseEventV3());
    expect(parseUsageEvent({ ...baseEventV3(), estimated_input_tokens_before: undefined })).toBeUndefined();
    expect(parseUsageEvent({ ...baseEventV2(), estimated_input_tokens_before: 160 })).toBeUndefined();
    expect(recoveryIdOf(baseEventV3())).toEqual({ recoveryId: "rec-1", provenance: "recovery-id-field" });
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

  it("MIXED SCHEMA VERSIONS chain, verify, and sum as ONE journal (v1 history + v2 writes)", async () => {
    const env = tmp();
    const keys = generateDeviceKeyPair();
    // Two LEGACY entries, signed for real, then two CURRENT ones — the shape a device's journal
    // takes the moment it updates: history stays v1 forever, new debits are v2.
    const events: UsageEvent[] = [
      baseEvent({ event_id: "dddddddd-0000-0000-0000-000000000001" }),
      baseEvent({ event_id: "dddddddd-0000-0000-0000-000000000002", optimized_input_tokens: 50 }),
      baseEventV2({ event_id: "dddddddd-0000-0000-0000-000000000003", optimized_input_tokens: 25 }),
      baseEventV2({ event_id: "dddddddd-0000-0000-0000-000000000004", optimized_input_tokens: 25 })
    ];
    for (const event of events) {
      const appended = await appendUsageEvent(
        event,
        signDetached(canonicalUsageEventBytes(event), keys.privateKeyPem),
        HEADROOM,
        env
      );
      expect(appended.appended, event.event_id).toBe(true);
    }

    const { entries, skipped } = await readUsageJournal(env);
    expect(skipped).toEqual([]);
    expect(entries.map((e) => e.schema_version)).toEqual([1, 1, 2, 2]);
    // ONE unbroken chain across the version boundary: each v1 entry still hashes over its ORIGINAL
    // `receipt_id` bytes, each v2 entry over its `recovery_id` bytes.
    expect(verifyUsageChain(entries)).toEqual({ valid: true, count: 4 });
    entries.forEach((entry) => expect(verifyEntrySignature(entry, keys.publicKey), entry.event_id).toBe(true));
    // Both shapes surrender the same id through the one accessor.
    expect(entries.map((e) => recoveryIdOf(e).recoveryId)).toEqual(["rec-1", "rec-1", "rec-1", "rec-1"]);
    expect(entries.map((e) => recoveryIdOf(e).provenance)).toEqual([
      "legacy-receipt-id-field",
      "legacy-receipt-id-field",
      "recovery-id-field",
      "recovery-id-field"
    ]);

    // AND THE TALLY DOES NOT FAIL CLOSED. A mixed SCHEMA version is normal and sums normally — it is
    // not the mixed METER version that the allowance arithmetic fails closed on.
    const consumption = await readPeriodConsumption(1_000, "2026-07", env);
    expect(consumption).toEqual({ ok: true, consumed: 200, remaining: 800 });
    expect(sumOptimizedInputTokensForPeriod(entries, "2026-07")).toBe(200);
  });

  it("dedupe by event_id is identical for both shapes", async () => {
    const env = tmp();
    const v2 = baseEventV2({ event_id: "eeeeeeee-0000-0000-0000-000000000001" });
    expect((await appendUsageEvent(v2, "sig-a", HEADROOM, env)).appended).toBe(true);
    const again = await appendUsageEvent(v2, "sig-a", HEADROOM, env);
    expect(again.appended).toBe(false);
    if (!again.appended) expect(again.reason).toContain("already recorded");
    expect((await readUsageJournal(env)).entries).toHaveLength(1);
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
    // Same reason as the byte-order pin above: the vector's event is frozen, meter label included.
    expect(computeEntryHash(baseEvent({ meter_version: "optimized-input-v1" }), "sig-fixture", USAGE_CHAIN_GENESIS)).toBe(
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
