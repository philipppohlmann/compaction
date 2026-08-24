import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { provisionValidLease } from "../helpers/lease-fixture.js";
import { currentPeriodId } from "../../src/core/entitlement/lease.js";
import { meterConfirmedApply } from "../../src/core/usage/usage-metering.js";
import {
  readPeriodConsumption,
  readUsageJournal,
  sumOptimizedInputTokensForPeriod,
  sumUnreconciledOptimizedInputTokensForPeriod
} from "../../src/core/usage/usage-journal.js";
import {
  advanceReconciliationWatermark,
  readReconciliationWatermark,
  reconciliationWatermarkPath,
  watermarkForPeriod
} from "../../src/core/usage/reconciliation-watermark.js";

/**
 * THE DOUBLE-COUNT REGRESSION.
 *
 * The server issues `allowance_tokens = limit − (debits it recorded)`. The client then subtracted its
 * FULL period journal total from that, charging reconciled tokens twice: `(limit − x) − x`.
 * Reconciling half an allowance left the renewed device instantly EXHAUSTED.
 *
 * It survived the original review because the dogfood measured the SERVER-side number (2,000,000 →
 * 1,800,000) and the reviewer verified the delete-the-journal bypass, but nobody asserted what the
 * CLIENT computes as remaining after a normal renew with the journal deliberately intact. That
 * assertion is now permanent, and it is the first test in this file.
 */
describe("reconciled usage is NOT charged twice", () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

  /** A device with `count` metered applies of `tokens` each, under a lease of `allowance`. */
  async function deviceWithDebits(count: number, tokens: number, allowance = 2_000_000) {
    const dir = mkdtempSync(join(tmpdir(), "watermark-"));
    dirs.push(dir);
    const env = provisionValidLease(dir, { allowance_tokens: allowance }) as NodeJS.ProcessEnv;
    for (let i = 0; i < count; i++) {
      const result = await meterConfirmedApply(
        {
          routeType: "api-key",
          workflow: "codex",
          provider: "openai",
          periodId: currentPeriodId(),
          allowanceTokens: allowance,
          receiptId: `rec-${i}`,
          meterVersion: "optimized-input-v1",
          meteredOptimizedInputTokens: tokens,
          estimatedInputTokensAfter: tokens / 2,
          preMutationBody: "x"
        },
        env
      );
      expect(result.metered).toBe(true);
    }
    return { dir, env };
  }

  it("THE REGRESSION: after reconcile + renew, remaining is NOT double-reduced", async () => {
    // Codex's exact scenario: reconcile 1,000,000 of a 2,000,000 allowance. The renewed lease
    // carries 1,000,000. The client must report 1,000,000 remaining — NOT 0.
    const { env } = await deviceWithDebits(10, 100_000);
    const { entries } = await readUsageJournal(env);
    const period = currentPeriodId();
    expect(sumOptimizedInputTokensForPeriod(entries, period)).toBe(1_000_000);

    // The server recorded all ten and issued a renewed lease of limit − 1,000,000.
    await advanceReconciliationWatermark(
      { periodId: period, entryHash: entries[entries.length - 1].entry_hash, count: entries.length },
      env
    );
    const RENEWED_ALLOWANCE = 2_000_000 - 1_000_000;

    const consumption = await readPeriodConsumption(RENEWED_ALLOWANCE, period, env);
    expect(consumption.ok).toBe(true);
    if (!consumption.ok) throw new Error("expected ok");
    expect(consumption.consumed).toBe(0); // all reconciled — nothing left to charge locally
    expect(consumption.remaining).toBe(1_000_000); // NOT 0, which is what the bug produced
  });

  it("a partially-reconciled period charges ONLY the entries after the watermark", async () => {
    const { env } = await deviceWithDebits(10, 100_000);
    const { entries } = await readUsageJournal(env);
    const period = currentPeriodId();
    // The server recorded the first six; four are still unreconciled.
    await advanceReconciliationWatermark({ periodId: period, entryHash: entries[5].entry_hash, count: 6 }, env);

    const consumption = await readPeriodConsumption(2_000_000 - 600_000, period, env);
    if (!consumption.ok) throw new Error("expected ok");
    expect(consumption.consumed).toBe(400_000);
    expect(consumption.remaining).toBe(1_400_000 - 400_000);
    // Which equals limit − everything metered: the two sides account for the period exactly once.
    expect(consumption.remaining).toBe(2_000_000 - 1_000_000);
  });

  it("the APPEND-path ceiling uses the same unreconciled tally (no phantom exhaustion)", async () => {
    // Pre-fix, a fully-reconciled device would refuse the next apply as ceiling-exceeded even though
    // the signed lease had headroom. The re-check inside the append lock must agree with the read.
    const { env } = await deviceWithDebits(10, 100_000);
    const { entries } = await readUsageJournal(env);
    const period = currentPeriodId();
    await advanceReconciliationWatermark(
      { periodId: period, entryHash: entries[entries.length - 1].entry_hash, count: entries.length },
      env
    );
    const result = await meterConfirmedApply(
      {
        routeType: "api-key",
        workflow: "codex",
        provider: "openai",
        periodId: period,
        allowanceTokens: 1_000_000, // the renewed, already-net allowance
        receiptId: "rec-after",
        meterVersion: "optimized-input-v1",
        meteredOptimizedInputTokens: 900_000,
        estimatedInputTokensAfter: 100,
        preMutationBody: "x"
      },
      env
    );
    expect(result.metered).toBe(true);
  });

  it("the ceiling still REFUSES once the unreconciled tally exceeds the signed allowance", async () => {
    // The fix must not become a way past the ceiling: with nothing reconciled, the full total counts.
    const { env } = await deviceWithDebits(5, 100_000, 600_000);
    const result = await meterConfirmedApply(
      {
        routeType: "api-key",
        workflow: "codex",
        provider: "openai",
        periodId: currentPeriodId(),
        allowanceTokens: 600_000,
        receiptId: "rec-over",
        meterVersion: "optimized-input-v1",
        meteredOptimizedInputTokens: 200_000, // 500_000 already used; 200_000 does not fit
        estimatedInputTokensAfter: 100,
        preMutationBody: "x"
      },
      env
    );
    expect(result.metered).toBe(false);
    if (result.metered) throw new Error("expected refusal");
    expect(result.reason).toContain("allowance-ceiling-exceeded");
  });
});

describe("watermark fail-safe direction (never grants more than the signed lease)", () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

  async function seeded() {
    const dir = mkdtempSync(join(tmpdir(), "watermark-safe-"));
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
          receiptId: `rec-${i}`,
          meterVersion: "optimized-input-v1",
          meteredOptimizedInputTokens: 1000,
          estimatedInputTokensAfter: 500,
          preMutationBody: "x"
        },
        env
      );
    }
    return env;
  }

  it("a MISSING watermark counts every entry (the conservative direction)", async () => {
    const env = await seeded();
    const consumption = await readPeriodConsumption(2_000_000, currentPeriodId(), env);
    if (!consumption.ok) throw new Error("expected ok");
    expect(consumption.consumed).toBe(3000);
  });

  it("a CORRUPT or unparsable watermark counts every entry, and never throws", async () => {
    const env = await seeded();
    for (const junk of ["not json at all", '{"schema_version":99}', '{"schema_version":1,"periods":"nope"}', ""]) {
      writeFileSync(reconciliationWatermarkPath(env), junk);
      const consumption = await readPeriodConsumption(2_000_000, currentPeriodId(), env);
      if (!consumption.ok) throw new Error("expected ok");
      expect(consumption.consumed).toBe(3000);
    }
  });

  it("a watermark naming an entry NOT in this period is not believed", async () => {
    const env = await seeded();
    await advanceReconciliationWatermark(
      { periodId: currentPeriodId(), entryHash: "d".repeat(64), count: 99 },
      env
    );
    const consumption = await readPeriodConsumption(2_000_000, currentPeriodId(), env);
    if (!consumption.ok) throw new Error("expected ok");
    expect(consumption.consumed).toBe(3000); // unknown position ⇒ nothing reconciled
  });

  it("the watermark stores a POSITION, never a token amount", async () => {
    const env = await seeded();
    const { entries } = await readUsageJournal(env);
    await advanceReconciliationWatermark(
      { periodId: currentPeriodId(), entryHash: entries[0].entry_hash, count: 1 },
      env
    );
    const raw = JSON.parse(readFileSync(reconciliationWatermarkPath(env), "utf8")) as Record<string, unknown>;
    const period = (raw.periods as Record<string, Record<string, unknown>>)[currentPeriodId()];
    expect(Object.keys(period).sort()).toEqual(["reconciled_count", "reconciled_through_entry_hash"]);
    // No field anywhere carries a token figure the file could assert on its own.
    expect(JSON.stringify(raw)).not.toContain("token");
  });

  it("even a watermark claiming EVERYTHING is reconciled cannot exceed the signed allowance", async () => {
    // The honest trust boundary: this file is not a security control. The worst a forged watermark
    // buys is spending up to the allowance the SERVER already signed — the lease is still the bound.
    const env = await seeded();
    const { entries } = await readUsageJournal(env);
    await advanceReconciliationWatermark(
      { periodId: currentPeriodId(), entryHash: entries[entries.length - 1].entry_hash, count: 999 },
      env
    );
    const consumption = await readPeriodConsumption(5000, currentPeriodId(), env);
    if (!consumption.ok) throw new Error("expected ok");
    expect(consumption.consumed).toBe(0);
    expect(consumption.remaining).toBe(5000); // the signed allowance, never more
  });

  it("advancing never REWINDS a period's position", async () => {
    const env = await seeded();
    const { entries } = await readUsageJournal(env);
    const period = currentPeriodId();
    await advanceReconciliationWatermark({ periodId: period, entryHash: entries[2].entry_hash, count: 3 }, env);
    await advanceReconciliationWatermark({ periodId: period, entryHash: entries[0].entry_hash, count: 1 }, env);
    const mark = watermarkForPeriod(await readReconciliationWatermark(env), period);
    expect(mark?.reconciled_through_entry_hash).toBe(entries[2].entry_hash);
    expect(mark?.reconciled_count).toBe(3);
  });

  it("a malformed entry hash is refused rather than written", async () => {
    const env = await seeded();
    await advanceReconciliationWatermark({ periodId: currentPeriodId(), entryHash: "nope", count: 1 }, env);
    expect(watermarkForPeriod(await readReconciliationWatermark(env), currentPeriodId())).toBeUndefined();
  });
});

describe("sumUnreconciledOptimizedInputTokensForPeriod (pure)", () => {
  const entry = (id: string, period: string, tokens: number, hash: string) =>
    ({
      schema_version: 1,
      event_id: id,
      receipt_id: "r",
      lease_id: "l",
      lease_sequence: 1,
      device_id: "d",
      device_key_hash: "a".repeat(64),
      period_id: period,
      occurred_at: "2026-08-01T00:00:00.000Z",
      route_type: "api-key",
      workflow: "codex",
      provider: "openai",
      meter_version: "optimized-input-v1",
      optimized_input_tokens: tokens,
      estimated_input_tokens_after: 1,
      device_event_signature: "s",
      prev_hash: "0".repeat(64),
      entry_hash: hash
    }) as never;

  const entries = [
    entry("1", "2026-08", 10, "a".repeat(64)),
    entry("2", "2026-08", 20, "b".repeat(64)),
    entry("3", "2026-07", 40, "c".repeat(64)), // another period — never counted here
    entry("4", "2026-08", 30, "d".repeat(64))
  ];

  it("counts everything with no watermark", () => {
    expect(sumUnreconciledOptimizedInputTokensForPeriod(entries, "2026-08")).toBe(60);
  });

  it("counts only entries AFTER the watermark position", () => {
    expect(sumUnreconciledOptimizedInputTokensForPeriod(entries, "2026-08", "a".repeat(64))).toBe(50);
    expect(sumUnreconciledOptimizedInputTokensForPeriod(entries, "2026-08", "b".repeat(64))).toBe(30);
    expect(sumUnreconciledOptimizedInputTokensForPeriod(entries, "2026-08", "d".repeat(64))).toBe(0);
  });

  it("ignores a watermark that belongs to a DIFFERENT period (fail-safe: count all)", () => {
    expect(sumUnreconciledOptimizedInputTokensForPeriod(entries, "2026-08", "c".repeat(64))).toBe(60);
  });
});
