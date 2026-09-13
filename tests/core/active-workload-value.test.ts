import { describe, expect, it } from "vitest";
import { estimateEquivalentActiveMinutes } from "../../src/core/active-workload-value.js";
import { runAggregateLine } from "../../src/core/gateway/receipt-line.js";

describe("equivalent active-workload minutes", () => {
  it("uses avoided input plus calibrated avoided output over the same run's observed consumption rate", () => {
    expect(estimateEquivalentActiveMinutes({
      inputBefore: 5_094_469,
      inputAfter: 4_703_745,
      outputAfter: 12_042,
      estimatedOutputTokensAvoided: 4_014,
      runStartedAt: "2026-09-12T15:12:31.000Z",
      runEndedAt: "2026-09-12T15:24:31.000Z"
    })).toBe(1);
  });

  it("uses input avoidance alone when no calibrated output counterfactual exists", () => {
    expect(estimateEquivalentActiveMinutes({
      inputBefore: 2_000,
      inputAfter: 1_000,
      outputAfter: 100,
      runStartedAt: "2026-09-12T15:00:00.000Z",
      runEndedAt: "2026-09-12T15:02:00.000Z"
    })).toBe(1.82);
  });

  it("omits invalid and zero-saving estimates while retaining evidenced fractional minutes", () => {
    expect(estimateEquivalentActiveMinutes({
      inputBefore: 1_000,
      inputAfter: 1_000,
      outputAfter: 100,
      runStartedAt: "2026-09-12T15:00:00.000Z",
      runEndedAt: "2026-09-12T15:02:00.000Z"
    })).toBeUndefined();
    expect(estimateEquivalentActiveMinutes({
      inputBefore: 1_010,
      inputAfter: 1_000,
      outputAfter: 100,
      runStartedAt: "2026-09-12T15:00:00.000Z",
      runEndedAt: "2026-09-12T15:02:00.000Z"
    })).toBe(0.02);
    expect(estimateEquivalentActiveMinutes({
      inputBefore: 1_500,
      inputAfter: 1_000,
      outputAfter: 0,
      runStartedAt: "2026-09-12T15:00:00.000Z",
      runEndedAt: "2026-09-12T15:01:00.000Z"
    })).toBe(0.5);
    expect(estimateEquivalentActiveMinutes({
      inputBefore: 1_999,
      inputAfter: 1_000,
      outputAfter: 0,
      runStartedAt: "2026-09-12T15:00:00.000Z",
      runEndedAt: "2026-09-12T15:01:00.000Z"
    })).toBe(1);
    expect(estimateEquivalentActiveMinutes({
      inputBefore: 2_000,
      inputAfter: 1_000,
      outputAfter: 0,
      runStartedAt: "2026-09-12T15:00:00.000Z",
      runEndedAt: "2026-09-12T15:01:00.000Z"
    })).toBe(1);
    expect(estimateEquivalentActiveMinutes({
      inputBefore: 2_000,
      inputAfter: 1_000,
      outputAfter: 100,
      runStartedAt: "not-a-time",
      runEndedAt: "2026-09-12T15:02:00.000Z"
    })).toBeUndefined();
  });

  it("renders the estimate only on a completed Full run, after the evidence axes", () => {
    const aggregate = {
      callCount: 39,
      input: { before: 5_094_469, after: 4_703_745 },
      output: { before: 16_056, after: 12_042, counterfactualAvailable: true },
      shapedCallCount: 1
    };
    const activeWindow = {
      startedAt: "2026-09-12T15:12:31.000Z",
      endedAt: "2026-09-12T15:24:31.000Z"
    };
    expect(runAggregateLine({ aggregate, tier: "full", outputBasis: "measured", activeWindow })).toBe(
      "compaction · input 5,094,469→4,703,745 (−8%) · output 16,056→12,042 (−25%, est.) · +~1m · full apply"
    );
    expect(runAggregateLine({ aggregate, tier: "basic", outputBasis: "measured", activeWindow })).not.toContain("+~");
    expect(runAggregateLine({ aggregate, tier: "full", outputBasis: "measured" })).not.toContain("+~");
  });

  it("renders a small but evidenced real-run estimate instead of suppressing it", () => {
    const line = runAggregateLine({
      aggregate: {
        callCount: 5,
        input: { before: 332_983, after: 332_521 },
        output: { before: 4_161, after: 3_121, counterfactualAvailable: true },
        shapedCallCount: 1
      },
      tier: "full",
      outputBasis: "measured",
      activeWindow: {
        startedAt: "2026-09-12T19:45:00.000Z",
        endedAt: "2026-09-12T19:47:15.000Z"
      }
    });
    expect(line).toBe(
      "compaction · input 332,983→332,521 (−0%) · output 4,161→3,121 (−25%, est.) · +~0.01m · full apply"
    );

    expect(runAggregateLine({
      aggregate: {
        callCount: 1,
        input: { before: 220_021, after: 219_714 },
        output: { before: 880, after: 660, counterfactualAvailable: true },
        shapedCallCount: 1
      },
      tier: "full",
      outputBasis: "measured",
      activeWindow: {
        startedAt: "2026-09-12T21:58:00.000Z",
        endedAt: "2026-09-12T21:58:21.000Z"
      }
    })).toBe(
      "compaction · input 220,021→219,714 (−0%) · output 880→660 (−25%, est.) · +~0.001m · full apply"
    );
  });
});
