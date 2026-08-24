/**
 * READ-ONLY activity view rendering tests for `compaction activity`.
 *
 * Proven here (pure functions, no I/O, no dist):
 * - populated render: newest-first ordering, honest per-axis token labels (local-estimate vs
 *   provider-reported vs unavailable), a measured output COUNT (never a savings), append-recency
 *   note (no fabricated wall-clock time);
 * - empty render: the friendly "no activity" message (and the surface-scoped empty variant);
 * - `--surface` filter: only the matching surface's rows;
 * - `--json`: machine shape with honest meta labels;
 * - `--limit`: caps the rows;
 * - NO-SAVINGS-LANGUAGE invariant: after stripping honest negations, neither the table nor the
 *   JSON carries any positive savings / billing-confirmed / cost / monthly-projection claim.
 */
import { describe, expect, it } from "vitest";
import { buildMeasureOnlyActivityEvent, type ActivityEvent } from "../../src/core/activity-event.js";
import {
  NO_ACTIVITY_MESSAGE,
  buildActivityJson,
  buildActivityRows,
  formatActivityTable
} from "../../src/core/activity-view.js";
import type { StandardCrossSurfaceEvent } from "../../src/core/cross-surface-event.js";

function cursorEvent(): ActivityEvent {
  const base: StandardCrossSurfaceEvent = {
    surface: "cursor",
    provider: "cursor",
    model_label: "unknown",
    run_id: "cursor-1",
    token_source: {
      input: { source: "local-estimate" },
      output: { source: "unavailable", unavailable_reason: "Cursor emits no usage" }
    },
    input_before: 820,
    cost_source: "unavailable",
    cost_unavailable_reason: "no cost",
    claim_scope: "run-scoped"
  };
  return buildMeasureOnlyActivityEvent(base, { original_retained: true, location: ".compaction/runs/cursor-1/t.json" });
}

function codexEvent(): ActivityEvent {
  const base: StandardCrossSurfaceEvent = {
    surface: "codex",
    provider: "openai",
    model_label: "gpt-5-codex",
    run_id: "codex-1",
    token_source: { input: { source: "provider-reported" }, output: { source: "provider-reported" } },
    input_before: 1500,
    output_before: 420,
    policy_used: "stale_tool_output_to_state_capsule",
    claim_scope: "run-scoped"
  };
  return buildMeasureOnlyActivityEvent(base, { original_retained: true, location: ".compaction/runs/codex-1/t.json" });
}

/** Strip the honest negations ("not a savings figure") before flagging any POSITIVE claim. */
function stripHonestNegations(text: string): string {
  return text
    .replace(/\bnot\s+a\s+savings\s+figure\b/gi, "")
    .replace(/\bnever\s+a\s+savings\s+figure\b/gi, "")
    .replace(/\bno\s+cost\s+or\s+billing\s+figure\s+is\s+shown\b/gi, "");
}

describe("activity view - populated render", () => {
  it("renders newest-first with honest per-axis token labels and a measured output count", () => {
    const rows = buildActivityRows([cursorEvent(), codexEvent()]);
    // codex was appended last → position 1 (most recent).
    expect(rows[0].surface).toBe("codex");
    expect(rows[0].position).toBe(1);
    expect(rows[1].surface).toBe("cursor");

    const table = formatActivityTable(rows, { totalEvents: 2, limit: 20 });
    expect(table).toContain("#1 = most recent");
    expect(table).toContain("append recency");
    // codex output measured, provider-reported tier.
    expect(table).toContain("420 measured (provider-reported)");
    // cursor input local-estimate tier; output unavailable (never a fabricated count).
    expect(table).toContain("820 measured (local-estimate)");
    expect(table).toContain("unavailable (unavailable)");
    // No fabricated wall-clock: the honesty note explicitly says events carry no wall-clock time.
    expect(table).toContain("no wall-clock time");
  });

  it("shows an input before→after delta ONLY when both counts are present (no implied reduction)", () => {
    const reshaped = codexEvent();
    reshaped.input_after = 900;
    const rows = buildActivityRows([reshaped]);
    const table = formatActivityTable(rows, { totalEvents: 1, limit: 20 });
    expect(table).toContain("1500→900 (provider-reported)");
    // A measure-only event (no input_after) must NOT show a before→after DATA cell (only the
    // measured count). The header cell legitimately contains the arrow, so assert on the data.
    const measured = formatActivityTable(buildActivityRows([codexEvent()]), { totalEvents: 1, limit: 20 });
    expect(measured).not.toMatch(/1500\s*→/);
    expect(measured).toContain("1500 measured (provider-reported)");
  });
});

describe("activity view - empty render", () => {
  it("returns the friendly no-activity message and the surface-scoped variant", () => {
    expect(formatActivityTable([], { totalEvents: 0, limit: 20 })).toBe(NO_ACTIVITY_MESSAGE);
    expect(formatActivityTable([], { totalEvents: 0, limit: 20, surface: "codex" })).toContain('surface "codex"');
  });
});

describe("activity view - filters and limit", () => {
  it("filters to one surface", () => {
    const rows = buildActivityRows([cursorEvent(), codexEvent()], { surface: "codex" });
    expect(rows).toHaveLength(1);
    expect(rows[0].surface).toBe("codex");
  });

  it("caps rows at the limit (most recent first)", () => {
    const rows = buildActivityRows([cursorEvent(), codexEvent()], { limit: 1 });
    expect(rows).toHaveLength(1);
    expect(rows[0].surface).toBe("codex");
  });
});

describe("activity view - --json", () => {
  it("produces a machine shape with honest meta labels", () => {
    const rows = buildActivityRows([cursorEvent(), codexEvent()]);
    const json = buildActivityJson(rows, { totalEvents: 2, limit: 20 });
    expect(json.activity).toHaveLength(2);
    expect(json.meta.total_events).toBe(2);
    expect(json.meta.surface_filter).toBeNull();
    expect(json.meta.ordering).toContain("no wall-clock");
    expect(json.activity[1].output_source).toBe("unavailable");
    expect(json.activity[1].output_tokens).toBeNull();
  });
});

describe("activity view - NO savings/cost/billing language", () => {
  it("carries no positive savings / billing-confirmed / cost / monthly claim (after stripping honest negations)", () => {
    const rows = buildActivityRows([cursorEvent(), codexEvent()]);
    const table = stripHonestNegations(formatActivityTable(rows, { totalEvents: 2, limit: 20 }));
    const json = stripHonestNegations(JSON.stringify(buildActivityJson(rows, { totalEvents: 2, limit: 20 })));
    for (const surface of [table, json]) {
      expect(surface).not.toMatch(/\bsavings\b/i);
      expect(surface).not.toMatch(/\bsaved\b/i);
      expect(surface).not.toMatch(/billing-confirmed/i);
      expect(surface).not.toMatch(/per month|monthly|projected/i);
      expect(surface).not.toMatch(/\$\d/);
    }
  });
});
