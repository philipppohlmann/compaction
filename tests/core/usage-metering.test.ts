import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { provisionValidLease } from "../helpers/lease-fixture.js";
import { meterConfirmedApply } from "../../src/core/usage/usage-metering.js";
import { readUsageJournal, verifyEntrySignature, verifyUsageChain } from "../../src/core/usage/usage-journal.js";
import {
  USAGE_METER_VERSION,
  USAGE_METER_VERSION_FALLBACK
} from "../../src/core/usage/usage-event.js";
import { readStoredCredentials } from "../../src/core/auth/credentials.js";

const FIXED = new Date("2026-07-20T12:00:00.000Z");

function ctx(overrides: Partial<Parameters<typeof meterConfirmedApply>[0]> = {}) {
  return {
    routeType: "api-key",
    workflow: "codex",
    provider: "openai",
    periodId: "2026-07",
    allowanceTokens: 2_000_000,
    receiptId: "rec-x",
    meterVersion: USAGE_METER_VERSION,
    meteredOptimizedInputTokens: 320,
    estimatedInputTokensAfter: 120,
    engineEventId: "engine-evt-1",
    preMutationBody: "x".repeat(1000),
    ...overrides
  };
}

describe("meterConfirmedApply", () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

  function leaseEnv(overrides = {}): NodeJS.ProcessEnv {
    const dir = mkdtempSync(join(tmpdir(), "usage-meter-"));
    dirs.push(dir);
    return provisionValidLease(dir, overrides) as NodeJS.ProcessEnv;
  }

  it("api-key: mints a client event, device-signs it, and commits ONE chained journal entry", async () => {
    const env = leaseEnv();
    const result = await meterConfirmedApply(ctx(), env, FIXED);
    expect(result.metered).toBe(true);
    if (!result.metered) return;
    expect(result.optimizedInputTokens).toBe(320);
    expect(result.meterVersion).toBe(USAGE_METER_VERSION);

    const { entries } = await readUsageJournal(env);
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry.route_type).toBe("api-key");
    expect(entry.optimized_input_tokens).toBe(320);
    expect(entry.estimated_input_tokens_after).toBe(120);
    expect(entry.occurred_at).toBe(FIXED.toISOString()); // injected clock
    expect(entry.engine_event_id).toBe("engine-evt-1"); // reconciliation id recorded
    expect(entry.lease_id).toBe("00000000-0000-0000-0000-0000000000aa"); // from the lease file
    expect(verifyUsageChain(entries).valid).toBe(true);

    const creds = readStoredCredentials(env)!;
    expect(verifyEntrySignature(entry, creds.device_public_key)).toBe(true);
  });

  it("subscription route is REFUSED (never metered/debited); nothing is written", async () => {
    const env = leaseEnv();
    const result = await meterConfirmedApply(ctx({ routeType: "subscription" }), env, FIXED);
    expect(result.metered).toBe(false);
    if (result.metered) return;
    expect(result.reason).toContain("route-not-metered");
    const { entries } = await readUsageJournal(env);
    expect(entries).toHaveLength(0);
  });

  it("falls back to a DISTINCT meter_version + chars/4 when the engine omits its count", async () => {
    const env = leaseEnv();
    const result = await meterConfirmedApply(
      ctx({ meteredOptimizedInputTokens: undefined, meterVersion: undefined, preMutationBody: "y".repeat(1000) }),
      env,
      FIXED
    );
    expect(result.metered).toBe(true);
    if (!result.metered) return;
    expect(result.meterVersion).toBe(USAGE_METER_VERSION_FALLBACK);
    expect(result.optimizedInputTokens).toBe(250); // ceil(1000/4)
    const { entries } = await readUsageJournal(env);
    expect(entries[0].meter_version).toBe(USAGE_METER_VERSION_FALLBACK);
  });

  it("carries the ceiling INTO the debit: refuses when the journal's fresh tally no longer covers it", async () => {
    // Simulates the racing case at the meter boundary: a debit the caller's stale snapshot approved,
    // committed after another apply already consumed the allowance. The meter re-checks against the
    // journal under the append lock and writes nothing.
    const env = leaseEnv();
    const first = await meterConfirmedApply(ctx({ allowanceTokens: 400, meteredOptimizedInputTokens: 320 }), env, FIXED);
    expect(first.metered).toBe(true);

    const second = await meterConfirmedApply(
      ctx({ allowanceTokens: 400, meteredOptimizedInputTokens: 320, receiptId: "rec-y" }),
      env,
      FIXED
    );
    expect(second.metered).toBe(false);
    if (second.metered) return;
    expect(second.reason).toContain("allowance-ceiling-exceeded");

    const { entries } = await readUsageJournal(env);
    expect(entries).toHaveLength(1); // the refused debit wrote nothing
    expect(verifyUsageChain(entries).valid).toBe(true);
  });

  /**
   * THE CEILING GENUINELY REFUSES — IT DOES NOT MERELY RELABEL.
   *
   * Loosening the TIER's meaning (so a spent allowance no longer clamps `full → observe`) must not
   * move enforcement into the tier. It never lived there: the binding test is the under-lock
   * remaining-allowance check inside `appendUsageEvent`, evaluated against a fresh journal read and
   * entirely independent of any tier or route label the caller carries. This pins the exact boundary
   * case — an allowance spent to the token, then one more apply at the ceiling.
   */
  it("an allowance spent EXACTLY to zero refuses the next apply and writes nothing", async () => {
    const env = leaseEnv({ allowance_tokens: 100 });
    const first = await meterConfirmedApply(
      ctx({ allowanceTokens: 100, meteredOptimizedInputTokens: 100, receiptId: "rec-exact-1" }),
      env,
      FIXED
    );
    expect(first.metered, "an exactly-fitting request is allowed, never clamped").toBe(true);

    const second = await meterConfirmedApply(
      ctx({ allowanceTokens: 100, meteredOptimizedInputTokens: 1, receiptId: "rec-exact-2" }),
      env,
      FIXED
    );
    expect(second.metered).toBe(false);
    if (second.metered) return;
    expect(second.reason).toContain("allowance-ceiling-exceeded");

    const { entries } = await readUsageJournal(env);
    expect(entries).toHaveLength(1); // refused, not merely labelled: nothing was written
    expect(verifyUsageChain(entries).valid).toBe(true);
  });

  it("declines (metered:false) when credentials are absent (no unsigned debit)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "usage-meter-nocreds-"));
    dirs.push(dir);
    const env = { COMPACTION_CONFIG_DIR: dir } as NodeJS.ProcessEnv; // no credentials/lease
    const result = await meterConfirmedApply(ctx(), env, FIXED);
    expect(result.metered).toBe(false);
    const { entries } = await readUsageJournal(env);
    expect(entries).toHaveLength(0);
  });
});
