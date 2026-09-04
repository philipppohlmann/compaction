import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ACTIVE_USAGE_METER_VERSION } from "../../src/core/usage/usage-event.js";
import { provisionValidLease } from "../helpers/lease-fixture.js";
import { currentPeriodId } from "../../src/core/entitlement/lease.js";
import { meterConfirmedApply } from "../../src/core/usage/usage-metering.js";
import {
  chunkEntries,
  entriesToReconcile,
  readUsageJournal,
  type UsageJournalEntry
} from "../../src/core/usage/usage-journal.js";
import {
  previousPeriodId,
  reconcileStoredUsage,
  reconcileUsage,
  UsageReconcileClientError,
  RECONCILE_BATCH_SIZE
} from "../../src/core/auth/usage-reconcile-client.js";
import {
  advanceReconciliationWatermark,
  readReconciliationWatermark,
  watermarkForPeriod
} from "../../src/core/usage/reconciliation-watermark.js";

/**
 * Client-side reconciliation. Two things are load-bearing here:
 *  - `src/core/usage/**` stays PURE: the selection readers do no I/O and never fetch. The network
 *    lives in `src/core/auth/` because that path is forbidden on the Open basic import graph.
 *  - Reconciliation NEVER gates the workflow. A failure is a thrown coded error the CALLER decides
 *    about; nothing here can block or decline an apply.
 *
 * NO SERVICE IS DEPLOYED — these talk to a throwaway loopback server started by the test.
 */

/** A stand-in service that records what it received. */
function startFakeService(handler: (body: unknown, req: http.IncomingMessage) => { status: number; body: unknown }) {
  const received: unknown[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      let parsed: unknown = {};
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        /* leave as {} */
      }
      received.push(parsed);
      const result = handler(parsed, req);
      const payload = JSON.stringify(result.body);
      res.writeHead(result.status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
      res.end(payload);
    });
  });
  return {
    received,
    server,
    async start(): Promise<string> {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    },
    async stop(): Promise<void> {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

function ok(accepted: number, extra: Record<string, unknown> = {}) {
  return {
    status: 200,
    body: {
      schema_version: 1,
      period_id: currentPeriodId(),
      accepted,
      duplicate: 0,
      rejected: [],
      chain_continuous: true,
      anchor: { entry_count: accepted },
      ...extra
    }
  };
}

/** A LEGACY (schema v1) stored line — the shape a journal written before the rename holds. */
function entry(overrides: Partial<UsageJournalEntry> = {}): UsageJournalEntry {
  return {
    schema_version: 1,
    event_id: "00000000-0000-0000-0000-000000000001",
    receipt_id: "r",
    lease_id: "00000000-0000-0000-0000-000000000002",
    lease_sequence: 1,
    device_id: "dev-a",
    device_key_hash: "a".repeat(64),
    period_id: "2026-08",
    occurred_at: "2026-08-01T00:00:00.000Z",
    route_type: "api-key",
    workflow: "codex",
    provider: "openai",
    meter_version: ACTIVE_USAGE_METER_VERSION,
    optimized_input_tokens: 10,
    estimated_input_tokens_after: 5,
    device_event_signature: "sig",
    prev_hash: "0".repeat(64),
    entry_hash: "1".repeat(64),
    ...overrides
  };
}

/** A CURRENT (schema v2) stored line — the same fields with the recovery id under its true name. */
function entryV2(overrides: Partial<UsageJournalEntry> = {}): UsageJournalEntry {
  const { receipt_id: legacyKey, schema_version: _v1, ...common } = entry();
  return { schema_version: 2, recovery_id: legacyKey as string, ...common, ...overrides };
}

describe("entriesToReconcile (pure selection — no I/O, no fetch)", () => {
  it("returns the CONTIGUOUS SUFFIX, not a filter", () => {
    // A filter would skip the middle entry and present a chain with a hole in it — the server would
    // report a discontinuity that never happened.
    const entries = [
      entry({ event_id: "e1", period_id: "2026-06" }),
      entry({ event_id: "e2", period_id: "2026-07" }),
      entry({ event_id: "e3", period_id: "2026-06" }), // out-of-order period, mid-journal
      entry({ event_id: "e4", period_id: "2026-07" }),
      entry({ event_id: "e5", period_id: "2026-08" })
    ];
    const picked = entriesToReconcile(entries, { deviceId: "dev-a", periodIds: ["2026-08", "2026-07"] });
    // The scan stops at e3 (a period outside the window), so the suffix is e4, e5 — contiguous.
    expect(picked.map((e) => e.event_id)).toEqual(["e4", "e5"]);
  });

  it("drops entries from a PREVIOUS device key rotation (the server could only reject them)", () => {
    const entries = [
      entry({ event_id: "old", device_id: "dev-previous" }),
      entry({ event_id: "new1", device_id: "dev-a" }),
      entry({ event_id: "new2", device_id: "dev-a" })
    ];
    const picked = entriesToReconcile(entries, { deviceId: "dev-a", periodIds: ["2026-08"] });
    expect(picked.map((e) => e.event_id)).toEqual(["new1", "new2"]);
  });

  it("returns nothing when the tail is outside the window", () => {
    expect(entriesToReconcile([entry({ period_id: "2026-01" })], { deviceId: "dev-a", periodIds: ["2026-08"] })).toEqual([]);
    expect(entriesToReconcile([], { deviceId: "dev-a", periodIds: ["2026-08"] })).toEqual([]);
  });
});

describe("previousPeriodId", () => {
  it("crosses a year boundary by the calendar, not by string arithmetic", () => {
    expect(previousPeriodId("2026-01")).toBe("2025-12");
    expect(previousPeriodId("2026-08")).toBe("2026-07");
    expect(previousPeriodId("2026-12")).toBe("2026-11");
  });
});

describe("chunkEntries", () => {
  it("splits in order and preserves every entry", () => {
    const entries = Array.from({ length: 7 }, (_, i) => entry({ event_id: `e${i}` }));
    const chunks = chunkEntries(entries, 3);
    expect(chunks.map((c) => c.length)).toEqual([3, 3, 1]);
    expect(chunks.flat().map((e) => e.event_id)).toEqual(entries.map((e) => e.event_id));
  });

  it("is total on empty input and a nonsense size", () => {
    expect(chunkEntries([], 10)).toEqual([]);
    expect(chunkEntries([entry()], 0)).toHaveLength(1);
  });
});

describe("reconcileUsage (upload)", () => {
  it("uploads chunks SEQUENTIALLY and in order, and totals the counts", async () => {
    const order: number[] = [];
    const fake = startFakeService((body) => {
      const entries = (body as { entries: unknown[] }).entries;
      order.push(entries.length);
      return ok(entries.length);
    });
    const url = await fake.start();
    try {
      const entries = Array.from({ length: RECONCILE_BATCH_SIZE + 3 }, (_, i) => entry({ event_id: `e${i}` }));
      const summary = await reconcileUsage(url, "cmpd_test_token", entries);
      expect(order).toEqual([RECONCILE_BATCH_SIZE, 3]);
      expect(summary.uploaded).toBe(RECONCILE_BATCH_SIZE + 3);
      expect(summary.accepted).toBe(RECONCILE_BATCH_SIZE + 3);
      expect(summary.chainContinuous).toBe(true);
    } finally {
      await fake.stop();
    }
  });

  it("sends ONLY the content-free entry fields and a Bearer device token", async () => {
    const fake = startFakeService(() => ok(1));
    const headers: Array<string | undefined> = [];
    fake.server.on("request", (req) => headers.push(req.headers.authorization));
    const url = await fake.start();
    try {
      await reconcileUsage(url, "cmpd_test_token", [entry()]);
      const sent = fake.received[0] as { schema_version: number; entries: Array<Record<string, unknown>> };
      expect(sent.schema_version).toBe(1);
      expect(Object.keys(sent.entries[0]).sort()).toEqual(
        [
          "device_event_signature",
          "device_id",
          "device_key_hash",
          "entry_hash",
          "estimated_input_tokens_after",
          "event_id",
          "lease_id",
          "lease_sequence",
          "meter_version",
          "occurred_at",
          "optimized_input_tokens",
          "period_id",
          "prev_hash",
          "provider",
          "receipt_id",
          "route_type",
          "schema_version",
          "workflow"
        ].sort()
      );
      expect(headers[0]).toBe("Bearer cmpd_test_token");
    } finally {
      await fake.stop();
    }
  });

  it("uploads each entry in ITS OWN shape — a v2 entry carries `recovery_id` and no `receipt_id`", async () => {
    const fake = startFakeService(() => ok(2));
    const url = await fake.start();
    try {
      // A MIXED batch is the normal case for a device whose journal spans the rename. Entries are
      // uploaded verbatim, so each one must present the key it was actually SIGNED over — rewriting
      // either into the other's shape would make its signature unverifiable server-side.
      await reconcileUsage(url, "cmpd_test_token", [
        entry(),
        entryV2({ event_id: "00000000-0000-0000-0000-00000000000b", entry_hash: "2".repeat(64) })
      ]);
      const sent = fake.received[0] as { entries: Array<Record<string, unknown>> };
      expect(sent.entries[0].schema_version).toBe(1);
      expect(sent.entries[0].receipt_id).toBe("r");
      expect(sent.entries[0]).not.toHaveProperty("recovery_id");
      expect(sent.entries[1].schema_version).toBe(2);
      expect(sent.entries[1].recovery_id).toBe("r");
      expect(sent.entries[1]).not.toHaveProperty("receipt_id");
    } finally {
      await fake.stop();
    }
  });

  it("a 400 from a server that predates the v2 shape LOSES NOTHING: no watermark, no dropped entry", async () => {
    // THE DEPLOY-ORDER CASE. The control-plane API is deployed; until the founder redeploys it, a
    // v2-shaped upload is refused wholesale (`.strict()` rejects the unknown key, and the route
    // parses the WHOLE body). That must be a retryable no-op, not a silent loss of consumption: the
    // entries stay in the journal, the watermark does not move, and they reconcile after redeploy.
    const fake = startFakeService(() => ({ status: 400, body: { error: "validation_error" } }));
    const url = await fake.start();
    try {
      await expect(reconcileUsage(url, "cmpd_test_token", [entryV2()])).rejects.toMatchObject({
        code: "http_error"
      });
      // Nothing was reported as confirmed, so `recordWatermark` has nothing to advance to.
      await expect(reconcileUsage(url, "cmpd_test_token", [entryV2()])).rejects.toMatchObject({
        partial: undefined
      });
    } finally {
      await fake.stop();
    }
  });

  it("surfaces coded errors rather than silently succeeding", async () => {
    const cases: Array<[number, unknown, string]> = [
      [401, { error: "unauthorized" }, "unauthorized"],
      [503, { error: "usage_reconcile_unavailable" }, "unavailable"],
      [409, { error: "device_inactive" }, "device_inactive"],
      [500, { error: "internal_error" }, "http_error"],
      [200, { nonsense: true }, "invalid_response"]
    ];
    for (const [status, body, code] of cases) {
      const fake = startFakeService(() => ({ status, body }));
      const url = await fake.start();
      try {
        await expect(reconcileUsage(url, "t", [entry()])).rejects.toMatchObject({ code });
      } finally {
        await fake.stop();
      }
    }
  });

  it("a REFUSED REDIRECT reports a readable reason, not an opaque runtime error", async () => {
    // `redirect: "error"` throws BEFORE any `HTTP ${status}` branch can run, which is why an
    // operator with a typo'd URL used to see only `fetch failed`.
    const fake = startFakeService(() => ({ status: 200, body: {} }));
    const url = await fake.start();
    fake.server.removeAllListeners("request");
    fake.server.on("request", (_req, res) => {
      res.writeHead(302, { location: "https://elsewhere.invalid/" });
      res.end();
    });
    try {
      await expect(reconcileUsage(url, "t", [entry()])).rejects.toMatchObject({ code: "network" });
      await reconcileUsage(url, "t", [entry()]).catch((error: UsageReconcileClientError) => {
        expect(error.message).toContain("redirect");
        expect(error.message).toContain("host you named");
      });
    } finally {
      await fake.stop();
    }
  });
});

describe("reconcileStoredUsage (the shared orchestration both triggers use)", () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

  it("reports not-logged-in without credentials, and nothing-to-reconcile on an empty journal", async () => {
    const empty = mkdtempSync(join(tmpdir(), "recon-empty-"));
    dirs.push(empty);
    expect(await reconcileStoredUsage("http://127.0.0.1:1", { COMPACTION_CONFIG_DIR: empty } as never)).toEqual({
      reconciled: false,
      reason: "not-logged-in"
    });

    const provisioned = mkdtempSync(join(tmpdir(), "recon-nojournal-"));
    dirs.push(provisioned);
    const env = provisionValidLease(provisioned) as NodeJS.ProcessEnv;
    expect(await reconcileStoredUsage("http://127.0.0.1:1", env)).toEqual({
      reconciled: false,
      reason: "nothing-to-reconcile"
    });
  });

  it("uploads REAL metered debits produced by the metering path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "recon-real-"));
    dirs.push(dir);
    const env = provisionValidLease(dir) as NodeJS.ProcessEnv;
    for (let i = 0; i < 2; i++) {
      const result = await meterConfirmedApply(
        {
          routeType: "api-key",
          workflow: "codex",
          provider: "openai",
          periodId: currentPeriodId(),
          allowanceTokens: 2_000_000,
          recoveryId: `rec-${i}`,
          meterVersion: ACTIVE_USAGE_METER_VERSION,
          meteredOptimizedInputTokens: 1000,
          estimatedInputTokensBefore: 1500,
          estimatedInputTokensAfter: 500,
          preMutationBody: "x".repeat(100)
        },
        env
      );
      expect(result.metered).toBe(true);
    }

    const fake = startFakeService((body) => ok((body as { entries: unknown[] }).entries.length));
    const url = await fake.start();
    try {
      const result = await reconcileStoredUsage(url, env);
      expect(result.reconciled).toBe(true);
      if (!result.reconciled) throw new Error("expected reconciled");
      expect(result.summary.uploaded).toBe(2);
      expect(result.summary.accepted).toBe(2);

      // The uploaded entries are exactly what the journal holds — the client invents nothing.
      const { entries } = await readUsageJournal(env);
      expect(entries.map((entry) => entry.schema_version)).toEqual([3, 3]);
      expect(entries.map((entry) => entry.estimated_input_tokens_before)).toEqual([1500, 1500]);
      const sent = (fake.received[0] as { entries: Array<{ event_id: string }> }).entries;
      expect(sent.map((e) => e.event_id)).toEqual(entries.map((e) => e.event_id));
    } finally {
      await fake.stop();
    }
  });

  it("reconciling does NOT mutate or truncate the local journal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "recon-immutable-"));
    dirs.push(dir);
    const env = provisionValidLease(dir) as NodeJS.ProcessEnv;
    await meterConfirmedApply(
      {
        routeType: "api-key",
        workflow: "codex",
        provider: "openai",
        periodId: currentPeriodId(),
        allowanceTokens: 2_000_000,
        recoveryId: "rec-immutable",
        meterVersion: ACTIVE_USAGE_METER_VERSION,
        meteredOptimizedInputTokens: 1000,
        estimatedInputTokensBefore: 1500,
        estimatedInputTokensAfter: 500,
        preMutationBody: "x"
      },
      env
    );
    const before = await readUsageJournal(env);
    const fake = startFakeService(() => ok(1));
    const url = await fake.start();
    try {
      await reconcileStoredUsage(url, env);
    } finally {
      await fake.stop();
    }
    const after = await readUsageJournal(env);
    expect(after.entries).toEqual(before.entries);
    expect(after.skipped).toEqual([]);
  });
});

describe("partial multi-chunk failure is reported HONESTLY (finding 4)", () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

  it("carries the COMMITTED count out with the failure instead of implying nothing was sent", async () => {
    // Chunks commit server-side one at a time, so a failure on a later chunk leaves earlier ones
    // recorded. Claiming "nothing was uploaded" there is false AND hides why the next lease is
    // already reduced.
    let call = 0;
    const fake = startFakeService((body) => {
      call += 1;
      const n = (body as { entries: unknown[] }).entries.length;
      return call === 1 ? ok(n) : { status: 500, body: { error: "internal_error" } };
    });
    const url = await fake.start();
    try {
      const entries = Array.from({ length: RECONCILE_BATCH_SIZE + 4 }, (_, i) => entry({ event_id: `e${i}` }));
      await expect(reconcileUsage(url, "t", entries)).rejects.toMatchObject({
        code: "http_error",
        partial: { uploaded: RECONCILE_BATCH_SIZE, accepted: RECONCILE_BATCH_SIZE }
      });
    } finally {
      await fake.stop();
    }
  });

  it("a failure on the FIRST chunk carries no partial (nothing really was uploaded)", async () => {
    const fake = startFakeService(() => ({ status: 500, body: { error: "internal_error" } }));
    const url = await fake.start();
    try {
      const error = await reconcileUsage(url, "t", [entry()]).catch((e: UsageReconcileClientError) => e);
      expect(error).toBeInstanceOf(UsageReconcileClientError);
      expect((error as UsageReconcileClientError).partial).toBeUndefined();
    } finally {
      await fake.stop();
    }
  });

  it("records the watermark for the chunks that DID commit before rethrowing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "recon-partial-"));
    dirs.push(dir);
    const env = provisionValidLease(dir) as NodeJS.ProcessEnv;
    for (let i = 0; i < 3; i++) {
      await meterConfirmedApply(
        {
          routeType: "api-key",
          workflow: "codex",
          provider: "openai",
          periodId: currentPeriodId(),
          allowanceTokens: 2_000_000,
          recoveryId: `rec-${i}`,
          meterVersion: ACTIVE_USAGE_METER_VERSION,
          meteredOptimizedInputTokens: 1000,
          estimatedInputTokensBefore: 1500,
          estimatedInputTokensAfter: 500,
          preMutationBody: "x"
        },
        env
      );
    }
    // One chunk (3 entries < batch size) that succeeds, then a second reconcile that fails outright.
    const fake = startFakeService((body) => ok((body as { entries: unknown[] }).entries.length));
    const url = await fake.start();
    try {
      await reconcileStoredUsage(url, env);
    } finally {
      await fake.stop();
    }
    const { entries } = await readUsageJournal(env);
    const mark = watermarkForPeriod(await readReconciliationWatermark(env), currentPeriodId());
    expect(mark?.reconciled_through_entry_hash).toBe(entries[entries.length - 1].entry_hash);
    expect(mark?.reconciled_count).toBe(3);
  });

  it("stops the confirmed prefix at the first REJECTED entry (conservative watermark)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "recon-rejected-"));
    dirs.push(dir);
    const env = provisionValidLease(dir) as NodeJS.ProcessEnv;
    for (let i = 0; i < 3; i++) {
      await meterConfirmedApply(
        {
          routeType: "api-key",
          workflow: "codex",
          provider: "openai",
          periodId: currentPeriodId(),
          allowanceTokens: 2_000_000,
          recoveryId: `rec-${i}`,
          meterVersion: ACTIVE_USAGE_METER_VERSION,
          meteredOptimizedInputTokens: 1000,
          estimatedInputTokensBefore: 1500,
          estimatedInputTokensAfter: 500,
          preMutationBody: "x"
        },
        env
      );
    }
    const { entries } = await readUsageJournal(env);
    // The service rejects the SECOND entry: the watermark may only advance to the first.
    const fake = startFakeService(() => ({
      status: 200,
      body: {
        schema_version: 1,
        period_id: currentPeriodId(),
        accepted: 2,
        duplicate: 0,
        rejected: [{ event_id: entries[1].event_id, reason: "signature-invalid" }],
        chain_continuous: true,
        anchor: { entry_count: 2 }
      }
    }));
    const url = await fake.start();
    try {
      await reconcileStoredUsage(url, env);
    } finally {
      await fake.stop();
    }
    const mark = watermarkForPeriod(await readReconciliationWatermark(env), currentPeriodId());
    expect(mark?.reconciled_through_entry_hash).toBe(entries[0].entry_hash);
    expect(mark?.reconciled_count).toBe(1);
  });
});

describe("the journal module stays network-free (the purity rail)", () => {
  const originalFetch = globalThis.fetch;
  beforeAll(() => {
    globalThis.fetch = (() => {
      throw new Error("the usage journal must never make a network call");
    }) as typeof fetch;
  });
  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  it("the PURE selection readers run with fetch detonating", () => {
    const entries = [entry({ event_id: "a" }), entry({ event_id: "b" })];
    expect(entriesToReconcile(entries, { deviceId: "dev-a", periodIds: ["2026-08"] })).toHaveLength(2);
    expect(chunkEntries(entries, 1)).toHaveLength(2);
  });

  it("reading the journal makes no network call", async () => {
    const dir = mkdtempSync(join(tmpdir(), "recon-pure-"));
    try {
      await expect(readUsageJournal({ COMPACTION_CONFIG_DIR: dir } as never)).resolves.toEqual({
        entries: [],
        skipped: []
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a SECOND reconcile advances the watermark", () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

  async function meter(env: NodeJS.ProcessEnv, recoveryId: string): Promise<void> {
    const result = await meterConfirmedApply(
      {
        routeType: "api-key",
        workflow: "codex",
        provider: "openai",
        periodId: currentPeriodId(),
        allowanceTokens: 2_000_000,
        recoveryId,
        meterVersion: ACTIVE_USAGE_METER_VERSION,
        meteredOptimizedInputTokens: 1000,
        estimatedInputTokensBefore: 1500,
        estimatedInputTokensAfter: 500,
        preMutationBody: "x"
      },
      env
    );
    expect(result.metered).toBe(true);
  }

  // The steady state, not an edge case: reconcile, use the tool some more, reconcile again. The
  // second batch is the entries since the first, so it is normally SMALLER than the first batch.
  // `reconciled_count` is the monotonicity guard for the stored position, so it has to mean "how
  // many entries the position stands for", not "how many were in the last upload" — otherwise the
  // second write looks like a rewind, is refused, and the position sticks at the first batch.
  //
  // The cost of it sticking is not cosmetic. Entries the server has already recorded stay behind
  // the watermark, so the local tally subtracts them a second time on top of the allowance the
  // lease already had them deducted from. The user is shown less headroom than they hold, and a
  // Community device can be told it is exhausted while the service still has allowance for it.
  it("moves the position to the newest confirmed entry instead of sticking at the first batch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "recon-second-"));
    dirs.push(dir);
    const env = provisionValidLease(dir) as NodeJS.ProcessEnv;

    for (let i = 0; i < 3; i++) await meter(env, `rec-first-${i}`);

    const fake = startFakeService((body) => ok((body as { entries: unknown[] }).entries.length));
    const url = await fake.start();
    try {
      expect((await reconcileStoredUsage(url, env)).reconciled).toBe(true);

      for (let i = 0; i < 2; i++) await meter(env, `rec-second-${i}`);
      expect((await reconcileStoredUsage(url, env)).reconciled).toBe(true);
    } finally {
      await fake.stop();
    }

    // The window did its job: the second upload carried only the two entries added since the first.
    const { entries } = await readUsageJournal(env);
    expect(entries).toHaveLength(5);
    const second = (fake.received[1] as { entries: Array<{ event_id: string }> }).entries;
    expect(second.map((e) => e.event_id)).toEqual(entries.slice(3).map((e) => e.event_id));

    const mark = watermarkForPeriod(await readReconciliationWatermark(env), currentPeriodId());
    expect(mark?.reconciled_through_entry_hash).toBe(entries[4].entry_hash);
    expect(mark?.reconciled_count).toBe(5);
  });

  // The same guard, doing the job it is actually there for: a stale write naming an EARLIER
  // position must not pull the watermark backwards.
  it("still refuses a write that names an earlier position", async () => {
    const dir = mkdtempSync(join(tmpdir(), "recon-rewind-"));
    dirs.push(dir);
    const env = provisionValidLease(dir) as NodeJS.ProcessEnv;
    for (let i = 0; i < 3; i++) await meter(env, `rec-${i}`);
    const { entries } = await readUsageJournal(env);

    const fake = startFakeService((body) => ok((body as { entries: unknown[] }).entries.length));
    const url = await fake.start();
    try {
      await reconcileStoredUsage(url, env);
    } finally {
      await fake.stop();
    }
    await advanceReconciliationWatermark(
      { periodId: currentPeriodId(), entryHash: entries[0].entry_hash, count: 1 },
      env
    );
    const mark = watermarkForPeriod(await readReconciliationWatermark(env), currentPeriodId());
    expect(mark?.reconciled_through_entry_hash).toBe(entries[2].entry_hash);
  });
});
