import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { provisionValidLease } from "../helpers/lease-fixture.js";
import { meterConfirmedApply } from "../../src/core/usage/usage-metering.js";
import { readUsageJournal, verifyEntrySignature, verifyUsageChain } from "../../src/core/usage/usage-journal.js";
import {
  ACTIVE_USAGE_METER_VERSION,
  USAGE_METER_VERSION_FALLBACK,
  resolveMeteredOptimizedInput
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
    recoveryId: "rec-x",
    meterVersion: ACTIVE_USAGE_METER_VERSION,
    meteredOptimizedInputTokens: 320,
    estimatedInputTokensBefore: 440,
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
    expect(result.meterVersion).toBe(ACTIVE_USAGE_METER_VERSION);

    const { entries } = await readUsageJournal(env);
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry.route_type).toBe("api-key");
    expect(entry.schema_version).toBe(3);
    expect(entry.optimized_input_tokens).toBe(320);
    expect(entry.estimated_input_tokens_before).toBe(440);
    expect(entry.estimated_input_tokens_after).toBe(120);
    expect(entry.occurred_at).toBe(FIXED.toISOString()); // injected clock
    expect(entry.engine_event_id).toBe("engine-evt-1"); // reconciliation id recorded
    expect(entry.lease_id).toBe("00000000-0000-0000-0000-0000000000aa"); // from the lease file
    expect(verifyUsageChain(entries).valid).toBe(true);

    const creds = readStoredCredentials(env)!;
    expect(verifyEntrySignature(entry, creds.device_public_key)).toBe(true);
  });

  /**
   * THE ALLOWANCE PAYS FOR THE ENGINE, NOT FOR THE BILLING ROUTE.
   *
   * A confirmed Hybrid INPUT apply consumed the Compaction Engine whichever upstream route carried the
   * turn, so it debits `optimized-input-v1` on that route too. The route is RECORDED on the event, not
   * consulted as a gate. The meter definition is untouched: the basis is still pre-mutation
   * model-visible input tokens, and output shaping is still never metered on any route.
   */
  it("subscription: debits the SAME meter and records the route it rode", async () => {
    const env = leaseEnv();
    const result = await meterConfirmedApply(ctx({ routeType: "subscription" }), env, FIXED);
    expect(result.metered).toBe(true);
    if (!result.metered) return;
    expect(result.optimizedInputTokens).toBe(320); // identical basis, identical figure
    expect(result.meterVersion).toBe(ACTIVE_USAGE_METER_VERSION);

    const { entries } = await readUsageJournal(env);
    expect(entries).toHaveLength(1);
    expect(entries[0].route_type).toBe("subscription"); // recorded, so reconciliation can attribute it
    expect(entries[0].optimized_input_tokens).toBe(320);
    expect(verifyUsageChain(entries).valid).toBe(true);

    const creds = readStoredCredentials(env)!;
    expect(verifyEntrySignature(entries[0], creds.device_public_key)).toBe(true);
  });

  /**
   * BOTH ROUTES SPEND THE ONE ALLOWANCE — they are not two independent budgets. If subscription applies
   * were journalled under a route the ceiling ignored, the same device could spend the allowance twice.
   */
  it("the two routes share ONE ceiling: a subscription apply consumes what api-key can still spend", async () => {
    const env = leaseEnv({ allowance_tokens: 400 });
    const first = await meterConfirmedApply(
      ctx({ routeType: "subscription", allowanceTokens: 400, meteredOptimizedInputTokens: 320 }),
      env,
      FIXED
    );
    expect(first.metered).toBe(true);

    const second = await meterConfirmedApply(
      ctx({ routeType: "api-key", allowanceTokens: 400, meteredOptimizedInputTokens: 320, recoveryId: "rec-y" }),
      env,
      FIXED
    );
    expect(second.metered).toBe(false);
    if (second.metered) return;
    expect(second.reason).toContain("allowance-ceiling-exceeded");

    const { entries } = await readUsageJournal(env);
    expect(entries).toHaveLength(1);
  });

  /**
   * AN UNRECOGNISED ROUTE IS STILL REFUSED. Opening the meter to both supported routes is not the same
   * as opening it to any label: an unknown one means the route that produced the apply is unknown, and
   * the server's `usage_debit.route_type` CHECK would reject the entry at reconciliation anyway — which
   * would silently lose a debit the client had already spent locally.
   */
  it("an UNRECOGNISED route is refused; nothing is written", async () => {
    const env = leaseEnv();
    const result = await meterConfirmedApply(ctx({ routeType: "carrier-pigeon" }), env, FIXED);
    expect(result.metered).toBe(false);
    if (result.metered) return;
    expect(result.reason).toContain("route-not-debitable");
    const { entries } = await readUsageJournal(env);
    expect(entries).toHaveLength(0);
  });

  /**
   * The `chars/4` fallback measures the PRE-MUTATION body — a v1 THROUGHPUT quantity. The active
   * allowance is denominated in tokens REMOVED, and the client has no way to estimate a removal
   * without the engine that performed it. So the fallback remains what it always was, an honest
   * estimate stamped with its own distinct label, and the STORE refuses to charge that label to a
   * balance it does not belong to. Charging it would spend a v2 allowance ~19x too fast; writing it
   * uncharged would be an unbounded run of applies that consume nothing.
   */
  it("still resolves to the DISTINCT fallback meter_version + chars/4 when the engine omits its count", () => {
    const resolved = resolveMeteredOptimizedInput({ preMutationBody: "y".repeat(1000) });
    expect(resolved.meterVersion).toBe(USAGE_METER_VERSION_FALLBACK);
    expect(resolved.tokens).toBe(250); // ceil(1000/4)
  });

  it("but a fallback-unit debit is refused by the store, so it can neither overcharge nor ride free", async () => {
    const result = await meterConfirmedApply(
      ctx({ meteredOptimizedInputTokens: undefined, meterVersion: undefined, preMutationBody: "y".repeat(1000) }),
      leaseEnv(),
      FIXED
    );
    expect(result.metered).toBe(false);
    if (result.metered) return;
    expect(result.reason).toBe("meter-basis-invalid");
  });

  it("and nothing at all is written for it", async () => {
    const env = leaseEnv();
    const result = await meterConfirmedApply(
      ctx({ meteredOptimizedInputTokens: undefined, meterVersion: undefined, preMutationBody: "y".repeat(1000) }),
      env,
      FIXED
    );
    expect(result.metered).toBe(false);
    const { entries } = await readUsageJournal(env);
    expect(entries).toHaveLength(0);
  });

  it("carries the ceiling INTO the debit: refuses when the journal's fresh tally no longer covers it", async () => {
    // Simulates the racing case at the meter boundary: a debit the caller's stale snapshot approved,
    // committed after another apply already consumed the allowance. The meter re-checks against the
    // journal under the append lock and writes nothing.
    const env = leaseEnv();
    const first = await meterConfirmedApply(ctx({ allowanceTokens: 400, meteredOptimizedInputTokens: 320 }), env, FIXED);
    expect(first.metered).toBe(true);

    const second = await meterConfirmedApply(
      ctx({ allowanceTokens: 400, meteredOptimizedInputTokens: 320, recoveryId: "rec-y" }),
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
      ctx({
        allowanceTokens: 100,
        meteredOptimizedInputTokens: 100,
        estimatedInputTokensBefore: 220,
        recoveryId: "rec-exact-1"
      }),
      env,
      FIXED
    );
    expect(first.metered, "an exactly-fitting request is allowed, never clamped").toBe(true);

    const second = await meterConfirmedApply(
      ctx({
        allowanceTokens: 100,
        meteredOptimizedInputTokens: 1,
        estimatedInputTokensBefore: 121,
        recoveryId: "rec-exact-2"
      }),
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

  it("fails closed when the current debit lacks or disagrees with its recomputation basis", async () => {
    const env = leaseEnv();
    expect((await meterConfirmedApply(ctx({ estimatedInputTokensBefore: undefined }), env, FIXED))).toEqual({
      metered: false,
      reason: "meter-basis-invalid"
    });
    expect((await meterConfirmedApply(ctx({ meteredOptimizedInputTokens: 319 }), env, FIXED))).toEqual({
      metered: false,
      reason: "meter-basis-invalid"
    });
    expect((await readUsageJournal(env)).entries).toHaveLength(0);
  });
});
