import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  USAGE_CHAIN_GENESIS,
  computeEntryHash,
  readPeriodConsumption,
  sumOptimizedInputTokensForPeriod,
  sumUnreconciledOptimizedInputTokensForPeriod,
  usageJournalPath
} from "../../src/core/usage/usage-journal.js";
import {
  ACTIVE_USAGE_METER_VERSION,
  KNOWN_USAGE_METER_VERSIONS,
  USAGE_EVENT_SCHEMA_VERSION,
  USAGE_METER_VERSION,
  USAGE_METER_VERSION_FALLBACK,
  USAGE_METER_VERSION_UNDECLARED,
  USAGE_METER_VERSION_V2,
  resolveMeteredOptimizedInput,
  type UsageEvent
} from "../../src/core/usage/usage-event.js";

describe("the balance is never denominated in two units at once", () => {
  const entry = (meter: string, tokens: number, hash: string) =>
    ({ period_id: "2026-09", meter_version: meter, optimized_input_tokens: tokens, entry_hash: hash }) as never;

  it("a v2 balance does not subtract v1 throughput history", () => {
    const entries = [entry(USAGE_METER_VERSION, 800, "a"), entry(USAGE_METER_VERSION_V2, 30, "b")];
    expect(sumUnreconciledOptimizedInputTokensForPeriod(entries, "2026-09", undefined, USAGE_METER_VERSION_V2)).toBe(30);
    expect(sumUnreconciledOptimizedInputTokensForPeriod(entries, "2026-09", undefined, USAGE_METER_VERSION)).toBe(800);
  });

  /** A default naming a superseded unit would hide active-unit consumption from callers. */
  it("defaults to the ACTIVE unit, so a caller that omits the argument still sees real consumption", () => {
    const entries = [entry(ACTIVE_USAGE_METER_VERSION, 100, "a")];
    expect(sumUnreconciledOptimizedInputTokensForPeriod(entries, "2026-09")).toBe(100);
  });

  it("and superseded history is not what that default counts", () => {
    const entries = [entry(USAGE_METER_VERSION, 100, "a")];
    expect(sumUnreconciledOptimizedInputTokensForPeriod(entries, "2026-09")).toBe(0);
  });
});

describe("THE CEILING MUST NEVER FAIL OPEN ON A UNIT MISMATCH", () => {
  /** A reader filtering on a different meter than the writer would compute a false zero. */
  const entry = (meter: string, tokens: number, hash: string) =>
    ({ period_id: "2026-09", meter_version: meter, optimized_input_tokens: tokens, entry_hash: hash }) as never;

  it("a filter that does not match the written unit yields ZERO — which is why the unit is not hardcoded", () => {
    const written = [entry("optimized-input-v1", 80, "a"), entry("optimized-input-v1", 80, "b")];
    // This is the bypass shape: ask for a unit nothing was written in.
    expect(sumUnreconciledOptimizedInputTokensForPeriod(written, "2026-09", undefined, USAGE_METER_VERSION_V2)).toBe(0);
    // And the real consumption, in the unit actually written, is not zero.
    expect(sumUnreconciledOptimizedInputTokensForPeriod(written, "2026-09", undefined, USAGE_METER_VERSION)).toBe(160);
  });

  it("the unit is taken from the entries, so a v1-only period is charged in v1", () => {
    const written = [entry(USAGE_METER_VERSION, 80, "a")];
    const meters = new Set(written.map((e) => (e as unknown as { meter_version: string }).meter_version));
    expect([...meters]).toEqual([USAGE_METER_VERSION]);
    expect(sumUnreconciledOptimizedInputTokensForPeriod(written, "2026-09", undefined, [...meters][0])).toBe(80);
  });
});

describe("meter version stamping", () => {
  it("the unit comes from whoever produced the count — a declared v2 count stays v2", () => {
    // `engine-main.ts` stamps `meter_version` on every applied response, because THAT process is
    // what computed the quantity and is the only party that knows what it measured.
    expect(
      resolveMeteredOptimizedInput({
        meterVersion: USAGE_METER_VERSION_V2,
        meteredOptimizedInputTokens: 1_533,
        preMutationBody: "x"
      }).meterVersion
    ).toBe(USAGE_METER_VERSION_V2);
  });

  /** An undeclared unit is unplaceable; the client never guesses a unit for an engine-provided count. */
  it("an UNDECLARED unit is never defaulted to the active one — a legacy engine's throughput is not a v2 debit", () => {
    const resolved = resolveMeteredOptimizedInput({ meteredOptimizedInputTokens: 800, preMutationBody: "x" });
    expect(resolved.meterVersion).toBe(USAGE_METER_VERSION_UNDECLARED);
    expect(resolved.meterVersion).not.toBe(ACTIVE_USAGE_METER_VERSION);
    // The count itself is preserved verbatim — the quantity is not in doubt, only its unit.
    expect(resolved.tokens).toBe(800);
  });

  it("and UNPLACEABLE is not FREE: the undeclared label is outside the known set, so the journal refuses it", () => {
    // The opposite failure is just as bad: a label the tally skips is an apply that consumes nothing
    // and can run unbounded. `KNOWN_USAGE_METER_VERSIONS` is what `appendUsageEvent` and
    // `consumptionFromJournalRead` place a unit against, and the undeclared label is deliberately
    // absent from it, so the debit is refused (nothing written) rather than written for zero.
    expect(KNOWN_USAGE_METER_VERSIONS.has(USAGE_METER_VERSION_UNDECLARED)).toBe(false);
    // The chars/4 fallback IS known — it is a v1-basis throughput estimate, so it is placeable as
    // superseded history and simply never joins a v2 balance.
    expect(KNOWN_USAGE_METER_VERSIONS.has(USAGE_METER_VERSION_FALLBACK)).toBe(true);
    expect(KNOWN_USAGE_METER_VERSIONS.has(ACTIVE_USAGE_METER_VERSION)).toBe(true);
  });

  it("an omitted COUNT still falls back to the documented chars/4 estimate under its own distinct label", () => {
    // Undeclared UNIT and absent COUNT are different conditions and must not collapse into one: the
    // fallback measures the pre-mutation body, which is a v1 throughput quantity, and it says so.
    const resolved = resolveMeteredOptimizedInput({ preMutationBody: "x".repeat(40) });
    expect(resolved.meterVersion).toBe(USAGE_METER_VERSION_FALLBACK);
    expect(resolved.tokens).toBe(10);
  });

  it("v1 is NOT redefined", () => {
    expect(USAGE_METER_VERSION).toBe("optimized-input-v1");
    expect(USAGE_METER_VERSION_V2).toBe("optimized-input-v2");
  });
});

describe("mixed-version periods", () => {
  /** A period may contain immutable history from v1 followed by active v2 debits. */
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

  const PERIOD = "2026-09";

  function event(meter: string, tokens: number, id: string): UsageEvent {
    return {
      schema_version: USAGE_EVENT_SCHEMA_VERSION,
      event_id: id,
      receipt_id: `rec-${id}`,
      lease_id: "lease-1",
      lease_sequence: 1,
      device_id: "dev-1",
      device_key_hash: "f".repeat(64),
      period_id: PERIOD,
      occurred_at: "2026-09-02T00:00:00.000Z",
      route_type: "api-key",
      workflow: "claude-code",
      provider: "anthropic",
      meter_version: meter,
      optimized_input_tokens: tokens,
      estimated_input_tokens_after: 1
    };
  }

  /**
   * Writes a VALID hash chain directly. The store now refuses a superseded-unit append, which is
   * exactly right and also means the mixed period this test is about cannot be produced through
   * `appendUsageEvent` — only by having lived through the migration. So the file is built by hand,
   * with real chain hashes, so the integrity gate passes and the test observes the UNIT rule rather
   * than a chain failure standing in for it.
   */
  function journalWith(...events: UsageEvent[]): NodeJS.ProcessEnv {
    const dir = mkdtempSync(join(tmpdir(), "v2-migration-"));
    dirs.push(dir);
    const env = { HOME: dir, COMPACTION_CONFIG_DIR: join(dir, ".compaction") } as NodeJS.ProcessEnv;
    let prev = USAGE_CHAIN_GENESIS;
    const lines = events.map((e) => {
      const entryHash = computeEntryHash(e, "sig", prev);
      const entry = { ...e, device_event_signature: "sig", prev_hash: prev, entry_hash: entryHash };
      prev = entryHash;
      return JSON.stringify(entry);
    });
    const path = usageJournalPath(env);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${lines.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
    return env;
  }

  it("a period holding BOTH units still reads: the device is not bricked at activation", async () => {
    const env = journalWith(
      event(USAGE_METER_VERSION, 800, "aaaaaaaa-0000-4000-8000-000000000001"),
      event(ACTIVE_USAGE_METER_VERSION, 30, "aaaaaaaa-0000-4000-8000-000000000002")
    );
    const consumption = await readPeriodConsumption(100_000, PERIOD, env);
    expect(consumption.ok).toBe(true);
  });

  it("and it charges ONLY the active unit — v1 history is neither summed in nor reinterpreted", async () => {
    const env = journalWith(
      event(USAGE_METER_VERSION, 800, "bbbbbbbb-0000-4000-8000-000000000001"),
      event(ACTIVE_USAGE_METER_VERSION, 30, "bbbbbbbb-0000-4000-8000-000000000002")
    );
    const consumption = await readPeriodConsumption(100, PERIOD, env);
    if (!consumption.ok) throw new Error(consumption.reason);
    expect(consumption.consumed).toBe(30);
    expect(consumption.remaining).toBe(70);
  });

  it("the period TOTAL a surface renders is one unit too, so nothing prints a two-unit number", () => {
    const entries = [
      { period_id: PERIOD, meter_version: USAGE_METER_VERSION, optimized_input_tokens: 800, entry_hash: "a" },
      { period_id: PERIOD, meter_version: ACTIVE_USAGE_METER_VERSION, optimized_input_tokens: 30, entry_hash: "b" }
    ] as never[];
    expect(sumOptimizedInputTokensForPeriod(entries, PERIOD)).toBe(30);
  });

  it("an UNPLACEABLE unit still fails closed: a tally this client cannot interpret is refused", async () => {
    // The fail-OPEN direction is the dangerous one. A client BEHIND the writer would silently skip
    // real consumption it does not recognise and report an allowance that has stopped existing.
    const env = journalWith(event("optimized-input-v9", 40, "cccccccc-0000-4000-8000-000000000001"));
    const consumption = await readPeriodConsumption(100, PERIOD, env);
    expect(consumption.ok).toBe(false);
  });

  it("the reader's unit IS the unit the writer stamps — they cannot drift apart", () => {
    // The unit the WRITER stamps is the one the engine declared (`USAGE_METER_VERSION_V2`, set in
    // `engine-main.ts` on every applied response); the unit the READER counts is
    // `ACTIVE_USAGE_METER_VERSION`. Naming both in one assertion is what makes a drift a failure.
    expect(
      resolveMeteredOptimizedInput({
        meterVersion: USAGE_METER_VERSION_V2,
        meteredOptimizedInputTokens: 30,
        preMutationBody: "x"
      }).meterVersion
    ).toBe(ACTIVE_USAGE_METER_VERSION);
    expect(sumUnreconciledOptimizedInputTokensForPeriod(
      [{ period_id: PERIOD, meter_version: ACTIVE_USAGE_METER_VERSION, optimized_input_tokens: 7, entry_hash: "h" } as never],
      PERIOD,
      undefined,
      ACTIVE_USAGE_METER_VERSION
    )).toBe(7);
  });

  it("and the active unit is v2, not v1", () => {
    expect(ACTIVE_USAGE_METER_VERSION).toBe(USAGE_METER_VERSION_V2);
  });
});
