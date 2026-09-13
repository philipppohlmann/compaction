import { describe, expect, it } from "vitest";
import {
  latestConsistentClaudeStopEvent,
  settledStopLineFromActivityEvent
} from "../../src/core/settled-stop-activity.js";
import { buildClaudeTranscriptStopActivityEvent } from "../../src/core/claude-stop-activity.js";
import { outputCalibrationResolver } from "../../src/core/output-shaping-savings.js";
import { emptyCalibration } from "../../src/core/output-shaping-calibration-store.js";
import { createUsageMetadata } from "../../src/core/usage-metadata.js";
import type { ActivityEvent } from "../../src/core/activity-event.js";
import type { UserRun } from "../../src/core/gateway/run-boundary.js";

/**
 * `latestConsistentClaudeStopEvent` selection tests.
 *
 * The fixtures below are the EXACT 15 real snapshots that reproduced the defect (0.6.8 release-acceptance
 * hard gate #5): one long real Claude Code session, one logical run (`claude-stop-916144e84eb71f2103e
 * 542085fa654c6`), settled 15 separate times as the run continued, each carrying strictly larger
 * cumulative `input_before` / `output_after` and the writer's own
 * `"monotonic delta from exact prior Claude session transcript usage"` evidence level. Deriving the
 * fixtures from the real shape (not a minimal stub) is deliberate: a stub that omits a field the guard
 * reads makes the guard untestable.
 */

const CORRELATION = "de0d1b916befcc57d335dcc57915c3d2";
const RUN_STARTED_AT = "2026-09-08T10:57:58.459Z";
const RUN: UserRun = {
  session_correlation_id: CORRELATION,
  run_seq: 1,
  started_at: RUN_STARTED_AT,
  ended_at: RUN_STARTED_AT
};
const resolver = outputCalibrationResolver(emptyCalibration());

/** The 15 real (recorded_at, cumulative input_before, cumulative output_after) snapshots, in order. */
const REAL_SNAPSHOTS: ReadonlyArray<{ recordedAt: string; inputBefore: number; outputAfter: number }> = [
  { recordedAt: "2026-09-08T11:14:49.549Z", inputBefore: 5_092_087, outputAfter: 22_649 },
  { recordedAt: "2026-09-08T11:25:38.875Z", inputBefore: 6_752_136, outputAfter: 30_933 },
  { recordedAt: "2026-09-08T11:29:55.361Z", inputBefore: 8_133_227, outputAfter: 36_751 },
  { recordedAt: "2026-09-08T11:32:18.135Z", inputBefore: 9_562_875, outputAfter: 42_526 },
  { recordedAt: "2026-09-08T11:40:28.735Z", inputBefore: 11_020_840, outputAfter: 47_322 },
  { recordedAt: "2026-09-08T11:45:19.292Z", inputBefore: 12_139_195, outputAfter: 51_966 },
  { recordedAt: "2026-09-08T11:51:50.276Z", inputBefore: 14_416_030, outputAfter: 54_362 },
  { recordedAt: "2026-09-08T11:53:13.055Z", inputBefore: 15_571_840, outputAfter: 57_028 },
  { recordedAt: "2026-09-08T11:58:04.322Z", inputBefore: 17_519_493, outputAfter: 61_230 },
  { recordedAt: "2026-09-08T12:12:00.341Z", inputBefore: 22_284_099, outputAfter: 66_254 },
  { recordedAt: "2026-09-08T12:34:55.947Z", inputBefore: 24_752_023, outputAfter: 73_612 },
  { recordedAt: "2026-09-08T12:51:21.761Z", inputBefore: 27_714_560, outputAfter: 80_641 },
  { recordedAt: "2026-09-08T13:03:13.190Z", inputBefore: 30_728_339, outputAfter: 83_748 },
  { recordedAt: "2026-09-08T13:16:16.078Z", inputBefore: 34_220_848, outputAfter: 87_690 },
  { recordedAt: "2026-09-08T14:13:51.876Z", inputBefore: 38_220_556, outputAfter: 92_743 }
];

/** Build one real-shaped claude-stop snapshot: `measurement_source: "claude-transcript"`, `claim_scope:
 * "run-scoped"`, `evidence_level: "monotonic delta from exact prior Claude session transcript usage"`,
 * `apply_posture: "basic"` - via the same builder production uses, with a zeroed baseline so the
 * cumulative counters land on the exact target values above. */
function realSnapshot(overrides: { recordedAt: string; inputBefore: number; outputAfter: number }): ActivityEvent {
  return buildClaudeTranscriptStopActivityEvent({
    run: { ...RUN, ended_at: overrides.recordedAt },
    usage: createUsageMetadata({
      inputTokens: overrides.inputBefore,
      outputTokens: overrides.outputAfter,
      providerReportedTokens: true,
      estimatedTokens: false,
      provider: "anthropic",
      model: "claude-opus-5"
    }),
    baseline: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      tokenSource: "provider-reported"
    },
    shapingOutcome: "shape-basic",
    calibrationResolver: resolver
  })!;
}

const realSeries = REAL_SNAPSHOTS.map(realSnapshot);

describe("latestConsistentClaudeStopEvent", () => {
  it("N=1: passes the single event through unchanged (byte-identical to today's rendering)", () => {
    const only = realSeries[0];
    expect(latestConsistentClaudeStopEvent([only])).toBe(only);
    expect(settledStopLineFromActivityEvent(latestConsistentClaudeStopEvent([only])!)).toBe(
      settledStopLineFromActivityEvent(only)
    );
  });

  it("N=15 real monotonic snapshots sharing one run_started_at: selects the LATEST, not the first", () => {
    // Shuffle the input order to prove selection sorts by recorded_at rather than trusting array order.
    const shuffled = [...realSeries].reverse();
    const selected = latestConsistentClaudeStopEvent(shuffled);
    expect(selected).toBe(realSeries[realSeries.length - 1]);
    expect(selected?.input_before).toBe(38_220_556);
    expect(selected?.output_after).toBe(92_743);

    const line = settledStopLineFromActivityEvent(selected!)!;
    expect(line).toContain("38,220,556");
    expect(line).toContain("92,743");
    // The regression this fixes: the FIRST/smallest snapshot must never be what renders.
    expect(line).not.toContain("5,092,087");
    expect(line).not.toContain("22,649");
  });

  it("a counter going backwards mid-series keeps failing closed (undefined)", () => {
    const regressed = realSeries.map((event, index) =>
      index === 10 ? { ...event, output_after: 1_000 } : event
    );
    expect(latestConsistentClaudeStopEvent(regressed)).toBeUndefined();
  });

  it("a disagreeing run_started_at keeps failing closed (undefined)", () => {
    const diverged = realSeries.map((event, index) =>
      index === 7 ? { ...event, run_started_at: "2026-09-08T09:00:00.000Z" } : event
    );
    expect(latestConsistentClaudeStopEvent(diverged)).toBeUndefined();
  });

  it("two events tying on recorded_at with different counters keeps failing closed (undefined)", () => {
    const tied = [
      realSeries[0],
      { ...realSeries[1], recorded_at: realSeries[0].recorded_at }
    ];
    expect(latestConsistentClaudeStopEvent(tied)).toBeUndefined();
  });

  it("N=0: nothing to select", () => {
    expect(latestConsistentClaudeStopEvent([])).toBeUndefined();
  });
});
