/**
 * Read-only rendering of the local activity store: stored `ActivityEvent`s → a content-free
 * table / JSON view of recent runs. Pure functions, the command reads the store and calls these.
 *
 * Rendering invariants:
 * - Events carry no timestamp, so no "time" column is fabricated: runs are ordered by append
 *   recency and numbered (#1 = most recent), with a note stating the ordering.
 * - Token counts render at the event's own axis tier verbatim; a tier is never upgraded.
 * - Output is a measured token count, never a savings; no cost, billing, or projection here.
 * - An input before→after delta is shown only when both counts are present (a real reshaping);
 *   a measure-only run shows the measured count, never an implied reduction.
 */
import type { ActivityEvent } from "./activity-event.js";

/** One rendered, content-free row. All labels are honest; nothing is inferred. */
export interface ActivityRow {
  /** 1 = most recent (append recency; events carry no wall-clock). */
  position: number;
  activity_event_id: string;
  surface: string;
  provider: string;
  model_label: string;
  /** Present only when a real before→after reshaping happened (both counts present). */
  input_before: number | null;
  input_after: number | null;
  input_source: string;
  input_unavailable_reason?: string;
  /** The measured output token COUNT (never a savings), or null when the axis is unavailable. */
  output_tokens: number | null;
  output_source: string;
  output_unavailable_reason?: string;
  policy_used: string;
  approval_status: string;
  auto_apply_status: string;
  sync_status: string;
}

export interface BuildActivityRowsOptions {
  /** Max rows to render (most recent first). Default 20. */
  limit?: number;
  /** Filter to one surface (exact match) before limiting. */
  surface?: string;
}

export const DEFAULT_ACTIVITY_LIMIT = 20;

export const NO_ACTIVITY_MESSAGE =
  "No activity recorded yet - run a supported workflow (e.g. `compaction run <tool> -- …`) and it will appear here.";

function axisSource(event: ActivityEvent, axis: "input" | "output"): { source: string; reason?: string } {
  const axisData = event.token_source?.[axis];
  if (!axisData) return { source: "unknown" };
  return { source: axisData.source, reason: axisData.unavailable_reason };
}

function autoApplyStatus(event: ActivityEvent): string {
  const auto = event.auto_apply;
  if (!auto) return "n/a";
  if (auto.applied_automatically === true) return "auto-applied (policy)";
  if (auto.preference === "auto-when-gates-pass") return "preference: auto-when-gates-pass (application pending)";
  return "ask each time";
}

/** Build the rendered rows: newest first, optional surface filter, then limit. */
export function buildActivityRows(events: ActivityEvent[], options: BuildActivityRowsOptions = {}): ActivityRow[] {
  const limit = options.limit ?? DEFAULT_ACTIVITY_LIMIT;
  // The store appends chronologically; most recent is the LAST line. Newest-first for display.
  const ordered = [...events].reverse();
  const filtered = options.surface ? ordered.filter((event) => event.surface === options.surface) : ordered;
  const shown = filtered.slice(0, Math.max(0, limit));
  return shown.map((event, index) => {
    const input = axisSource(event, "input");
    const output = axisSource(event, "output");
    const outputUnavailable = output.source === "unavailable" || output.source === "unknown";
    const outputCount =
      typeof event.output_after === "number"
        ? event.output_after
        : typeof event.output_before === "number"
          ? event.output_before
          : typeof event.output_estimate === "number"
            ? event.output_estimate
            : null;
    return {
      position: index + 1,
      activity_event_id: event.activity_event_id ?? "unknown",
      surface: event.surface,
      provider: event.provider ?? "unknown",
      model_label: event.model_label ?? "unknown",
      input_before: typeof event.input_before === "number" ? event.input_before : null,
      input_after: typeof event.input_after === "number" ? event.input_after : null,
      input_source: input.source,
      ...(input.reason ? { input_unavailable_reason: input.reason } : {}),
      output_tokens: outputUnavailable ? null : outputCount,
      output_source: output.source,
      ...(output.reason ? { output_unavailable_reason: output.reason } : {}),
      policy_used: event.policy_used ?? "none",
      approval_status: event.approval_status ?? "not-recorded",
      auto_apply_status: autoApplyStatus(event),
      sync_status: event.sync_status ?? "local-only"
    };
  });
}

function renderInputCell(row: ActivityRow): string {
  if (row.input_source === "unavailable") return `unavailable (${row.input_source})`;
  if (row.input_before === null) return `- (${row.input_source})`;
  // Only show before→after when a real reshaping happened (both present); else a measured count.
  if (row.input_after === null) return `${row.input_before} measured (${row.input_source})`;
  return `${row.input_before}→${row.input_after} (${row.input_source})`;
}

function renderOutputCell(row: ActivityRow): string {
  if (row.output_tokens === null) return `unavailable (${row.output_source})`;
  return `${row.output_tokens} measured (${row.output_source})`;
}

/** Machine output for `--json`: rows plus honest meta. Pure data (the command JSON-stringifies it). */
export interface ActivityJson {
  activity: ActivityRow[];
  meta: {
    total_events: number;
    shown: number;
    limit: number;
    surface_filter: string | null;
    ordering: "append-recency (events carry no wall-clock time); position 1 = most recent";
    labels: "token counts are shown at each event's own axis tier (local-estimate | provider-reported | unavailable); output is a measured token count, never a savings figure; no cost or billing figure is shown";
  };
  skipped_note?: string;
}

export function buildActivityJson(
  rows: ActivityRow[],
  meta: { totalEvents: number; limit: number; surface?: string; skippedCount?: number }
): ActivityJson {
  return {
    activity: rows,
    meta: {
      total_events: meta.totalEvents,
      shown: rows.length,
      limit: meta.limit,
      surface_filter: meta.surface ?? null,
      ordering: "append-recency (events carry no wall-clock time); position 1 = most recent",
      labels:
        "token counts are shown at each event's own axis tier (local-estimate | provider-reported | unavailable); output is a measured token count, never a savings figure; no cost or billing figure is shown"
    },
    ...(meta.skippedCount && meta.skippedCount > 0
      ? { skipped_note: `${meta.skippedCount} malformed line(s) were skipped (not shown)` }
      : {})
  };
}

/** Human table. Content-free; honest labels; a header note that ordering is append-recency. */
export function formatActivityTable(
  rows: ActivityRow[],
  meta: { totalEvents: number; limit: number; surface?: string; skippedCount?: number }
): string {
  if (rows.length === 0) {
    if (meta.surface) {
      return `No activity recorded for surface "${meta.surface}" yet. ${NO_ACTIVITY_MESSAGE}`;
    }
    return NO_ACTIVITY_MESSAGE;
  }
  const header = ["#", "surface", "provider/model", "input (before→after)", "output tokens", "policy", "approval", "auto-apply", "sync"];
  const table = rows.map((row) => [
    `${row.position}`,
    row.surface,
    `${row.provider}/${row.model_label}`,
    renderInputCell(row),
    renderOutputCell(row),
    row.policy_used,
    row.approval_status,
    row.auto_apply_status,
    row.sync_status
  ]);
  const widths = header.map((cell, col) => Math.max(cell.length, ...table.map((line) => line[col].length)));
  const pad = (cells: string[]): string => cells.map((cell, col) => cell.padEnd(widths[col])).join("  ");

  const surfaceNote = meta.surface ? ` (surface "${meta.surface}")` : "";
  const preamble = [
    `Recent activity${surfaceNote}: showing ${rows.length} of ${meta.totalEvents} recorded run(s).`,
    `Ordered by append recency (activity events carry no wall-clock time); #1 = most recent.`,
    `Token counts are local estimates unless labeled provider-reported; output is a measured count, not a savings figure.`
  ];
  const lines = [pad(header), pad(header.map((_, col) => "-".repeat(widths[col]))), ...table.map(pad)];
  const trailer = meta.skippedCount && meta.skippedCount > 0 ? [``, `(${meta.skippedCount} malformed line(s) skipped.)`] : [];
  return [...preamble, ``, ...lines, ...trailer].join("\n");
}
