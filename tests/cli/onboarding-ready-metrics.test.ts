import { describe, expect, it } from "vitest";
import {
  deriveReadyMetric,
  READY_METRIC_NO_DATA_LINE,
  type ReadyMetric
} from "../../src/cli/onboarding/ready-metrics.js";
import { buildActivityRows } from "../../src/core/activity-view.js";
import type { ActivityEvent } from "../../src/core/activity-event.js";

// The honest ready-screen metric: real measured receipts OR "unavailable until measured".
// It must NEVER fabricate a number (no `out -45%`-style figure) and must default to no-data.
describe("deriveReadyMetric - honest first-run metric (no simulated numbers)", () => {
  it("with NO receipts, reports the honest no-data / unavailable-until-measured state", () => {
    const metric = deriveReadyMetric([]);
    expect(metric.state).toBe("no-data");
    expect(metric.line).toBe(READY_METRIC_NO_DATA_LINE);
    expect(metric.line).toContain("unavailable until measured");
    expect(metric.recordedRuns).toBe(0);
    // No savings/percentage/cost figure ever appears in the no-data line.
    expect(metric.line).not.toMatch(/-?\d+%/);
    expect(metric.line).not.toMatch(/saved|savings|\$/i);
  });

  it("with receipts that carry no usable token axis, still reports no-data (never invents a count)", () => {
    const event: ActivityEvent = {
      surface: "claude_code",
      provider: "anthropic",
      activity_event_id: "e-unavailable",
      token_source: { input: { source: "unavailable" }, output: { source: "unavailable" } }
    } as unknown as ActivityEvent;
    const rows = buildActivityRows([event]);
    const metric = deriveReadyMetric(rows);
    expect(metric.state).toBe("no-data");
    expect(metric.line).toBe(READY_METRIC_NO_DATA_LINE);
  });

  it("with a measured output receipt, reports a MEASURED count (never a savings figure)", () => {
    const event: ActivityEvent = {
      surface: "claude_code",
      provider: "anthropic",
      activity_event_id: "e-measured",
      output_after: 408,
      token_source: { input: { source: "unavailable" }, output: { source: "provider-reported" } }
    } as unknown as ActivityEvent;
    const rows = buildActivityRows([event]);
    const metric = deriveReadyMetric(rows);
    expect(metric.state).toBe("measured");
    expect(metric.line).toContain("output 408 measured (provider-reported)");
    // A measured COUNT, never a % savings or a cost/dollar figure.
    expect(metric.line).not.toMatch(/-?\d+%/);
    expect(metric.line).not.toMatch(/saved|savings|\$/i);
    expect(metric.tokenSource).toBe("provider-reported");
  });

  it("shows an input before→after delta only when a real reshaping recorded both counts", () => {
    const event: ActivityEvent = {
      surface: "codex",
      provider: "openai",
      activity_event_id: "e-reshape",
      input_before: 1000,
      input_after: 720,
      token_source: { input: { source: "provider-reported" }, output: { source: "unavailable" } }
    } as unknown as ActivityEvent;
    const rows = buildActivityRows([event]);
    const metric = deriveReadyMetric(rows);
    expect(metric.state).toBe("measured");
    expect(metric.line).toContain("input 1000→720 (provider-reported)");
  });

  it("picks the newest usable receipt (rows are newest-first) and counts recorded runs", () => {
    const events: ActivityEvent[] = [
      {
        surface: "claude_code",
        provider: "anthropic",
        activity_event_id: "older",
        output_after: 999,
        token_source: { output: { source: "local-estimate" } }
      },
      {
        surface: "claude_code",
        provider: "anthropic",
        activity_event_id: "newer",
        output_after: 100,
        token_source: { output: { source: "provider-reported" } }
      }
    ] as unknown as ActivityEvent[];
    // buildActivityRows reverses to newest-first; "newer" is the newest.
    const rows = buildActivityRows(events);
    const metric: ReadyMetric = deriveReadyMetric(rows);
    expect(metric.line).toContain("output 100 measured (provider-reported)");
    expect(metric.recordedRuns).toBe(2);
  });
});
