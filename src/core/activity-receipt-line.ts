/**
 * PER-TURN LINES FOR THE NON-GATEWAY SURFACES (PUBLIC CLI/SDK core, engine-free, content-free).
 *
 * `compaction watch` tails the local Gateway receipts, which is the whole story for anything routed
 * through the Gateway — and NO story at all for Cursor. Cursor's shim is `kind: "capture"`; its turns
 * go through `core/shim-capture-bridge.ts` into the local ACTIVITY store (`.compaction/activity/`), and
 * never produce a gateway receipt. A Cursor user pointed at `compaction watch` therefore watched an
 * empty feed forever. This module renders those activity events as the same canonical line grammar, so
 * `watch` is a real surface for Cursor instead of a promise it could not keep.
 *
 * SCOPE, stated so it is not overread: the events this renders come from the CAPTURE SHIM, which
 * measures `cursor-agent … --output-format json` runs only (`core/tool-shim.ts`). A Cursor IDE session
 * is SHAPED by the `~/.cursor/hooks.json` sessionStart hook but produces no activity event and no
 * receipt, so it does not appear here and no surface may say it does.
 *
 * TIER HONESTY IS THE POINT, not a caveat. Every count is printed with the axis tier the event itself
 * recorded (`local-estimate` | `provider-reported` | …) taken VERBATIM. Compaction's current Cursor
 * capture parser records chars/4 local estimates rather than consuming the vendor's per-turn usage,
 * and nothing here may upgrade that label. An event whose axes are all unavailable prints as
 * unavailable, never as a zero: a fabricated `output 0` is a measurement claim.
 *
 * Content-free by construction: only counts, the fixed surface name, the recorded source labels, and a
 * short slice of the event's own opaque, content-derived-free id ever reach the line.
 */
import type { ActivityEvent } from "./activity-event.js";
import { coalesceClaudeLogicalRuns, validateActivityEventForStore } from "./activity-store.js";
import { buildActivityRows, type ActivityRow } from "./activity-view.js";
import { RECEIPT_LINE_PREFIX } from "./gateway/receipt-line.js";
import { settledStopLineFromActivityEvent } from "./settled-stop-activity.js";
import type { GatewayReceipt } from "./gateway/receipt.js";

/**
 * The legacy activity surfaces `watch` renders from the local store: CURSOR ONLY. Settled Codex Stop
 * events use their closed `activity_kind` and the shared Stop renderer below; they never enter this
 * legacy surface allowlist.
 *
 * The rule is one line per turn. A surface that can produce BOTH an activity event and a gateway
 * receipt for the same run would print twice, and a doubled feed is a worse lie than a missing one.
 *
 * `claude_code` is excluded for that reason: its Stop hook writes activity events for turns that also
 * produce gateway receipts.
 *
 * Legacy `codex-shim-*` capture events are excluded for the SAME reason. A routed Codex command can
 * append one of those and gateway receipts with no shared identity. In contrast, `codex-stop-*`
 * events carry the exact hashed session + run interval, so the renderer admits that settled aggregate
 * and suppresses only its positively correlated gateway micro-events.
 *
 * The deferred alternative is cross-store de-duplication rather than exclusion. It is not narrow: the
 * two stores have disjoint id spaces (a content-free `codex-shim-<digest>` run id vs a gateway
 * `receipt_id`) and no shared correlation key, so matching them would mean inventing one. Dropping the
 * duplicate source is the honest small move; correlating them is a separate piece of work.
 */
export const WATCH_ACTIVITY_SURFACES: readonly string[] = ["cursor"];

/** The short, opaque id shown on the line (the event id is already content-free; this only shortens it). */
function shortActivityId(id: string): string {
  const tail = id.slice(-8);
  return tail.length > 0 ? tail : id;
}

function group(n: number): string {
  return Math.trunc(n).toLocaleString("en-US");
}

/**
 * Render ONE activity row as the canonical content-free line, or undefined when the row is not one of
 * the surfaces this feed covers. A row with no usable token axis still renders — saying so is the
 * honest outcome; printing a zero would not be.
 */
export function activityReceiptLine(row: ActivityRow): string | undefined {
  if (row.surface !== "cursor") return undefined;
  const parts: string[] = [RECEIPT_LINE_PREFIX, row.surface];

  if (row.input_before !== null && row.input_after !== null) {
    // A local capture never compacts input, so this is only ever a recorded pair, shown as such.
    parts.push(`input ${group(row.input_before)}→${group(row.input_after)} (${row.input_source})`);
  } else if (row.input_before !== null) {
    parts.push(`observed input ${group(row.input_before)} (${row.input_source})`);
  }
  if (row.output_tokens !== null) {
    parts.push(`output ${group(row.output_tokens)} (${row.output_source})`);
  }
  if (row.input_before === null && row.output_tokens === null) {
    parts.push(`no token axis reported (input ${row.input_source}, output ${row.output_source})`);
  }
  parts.push(`id ${shortActivityId(row.activity_event_id)}`);
  return parts.join(" · ");
}

/**
 * A rendered per-turn line plus the ONLY ordering fact recorded about it.
 *
 * `recordedAt` is deliberately OPTIONAL. Settled Codex Stop events carry the host-recorded Stop time;
 * legacy and Cursor activity records do not. A gateway receipt carries `captured_at`. Modelling the
 * difference lets a merged feed sort by real time where it exists and refuse to invent it otherwise.
 */
export interface OrderedTurnLine {
  line: string;
  /** ms since epoch, from the record's OWN recorded timestamp. Undefined ⇒ the store records none. */
  recordedAt?: number;
}

/**
 * Merge rendered lines from several stores into ONE feed, oldest first.
 *
 * THE RULE, and why it is a tie-break rather than an invention: a record that carries a recorded
 * timestamp is ordered by it. A record that carries NONE cannot be placed against those from data —
 * so it is never allowed to occupy the NEWEST position, because "newest" is itself a recency claim
 * and there is no evidence for it. Undated records therefore sort before every dated one, keeping
 * their own append order among themselves (the sort is stable).
 *
 * The alternative the code used to have was not neutral: concatenating one store after the other
 * placed every undated record at the END, i.e. asserted they were the most recent. `watch --once -n 1`
 * then returned an old Cursor capture while a newer gateway receipt sat right there.
 *
 * Note this only ever matters on a machine with BOTH kinds of record. The Cursor case this feed exists
 * for has no gateway receipts at all, so its lines are the whole feed either way.
 */
export function mergeTurnLines(...groups: readonly (readonly OrderedTurnLine[])[]): string[] {
  const all = groups.flat();
  const undated = all.filter((t) => t.recordedAt === undefined);
  // `sort` is stable in Node, so records sharing a timestamp keep their append order.
  const dated = all.filter((t) => t.recordedAt !== undefined).sort((a, b) => (a.recordedAt as number) - (b.recordedAt as number));
  return [...undated, ...dated].map((t) => t.line);
}

/**
 * Render the canonical lines for a batch of raw activity JSONL, each carrying its ordering fact —
 * when present (settled Codex Stop) and no invented timestamp otherwise. Pure, never throws.
 */
export function activityTurnLinesFromJsonl(
  rawChunk: string,
  options: { coalesceClaude?: boolean } = {}
): OrderedTurnLine[] {
  const out: OrderedTurnLine[] = [];
  for (const event of activityEventsFromJsonl(rawChunk, options.coalesceClaude !== false)) {
    if (event.activity_kind === "codex-stop" || event.activity_kind === "claude-stop") {
      const line = settledStopLineFromActivityEvent(event);
      const recordedAt = Date.parse(event.recorded_at ?? "");
      if (line) out.push({ line, ...(Number.isFinite(recordedAt) ? { recordedAt } : {}) });
      continue;
    }
    if (event.surface !== "cursor") continue;
    const row = buildActivityRows([event], { limit: 1 })[0];
    const line = row ? activityReceiptLine(row) : undefined;
    if (line) out.push({ line });
  }
  return out;
}

/**
 * Render the canonical lines for a batch of raw activity JSONL (only the lines that parse to an event
 * on a covered surface). Pure, never throws: a malformed or foreign line is skipped, exactly as the
 * gateway-receipt renderer skips one.
 */
export function activityLinesFromJsonl(rawChunk: string): string[] {
  return activityTurnLinesFromJsonl(rawChunk).map((entry) => entry.line);
}

function activityEventsFromJsonl(rawChunk: string, coalesceClaude = true): ActivityEvent[] {
  const events: ActivityEvent[] = [];
  for (const line of rawChunk.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as ActivityEvent;
      if (validateActivityEventForStore(parsed).problems.length === 0) events.push(parsed);
    } catch {
      continue;
    }
  }
  return coalesceClaude ? coalesceClaudeLogicalRuns(events) : events;
}

export interface CodexStopRunWindow {
  sessionCorrelationId: string;
  startedAt: string;
  endedAt: string;
}

export type SettledStopRunWindow = CodexStopRunWindow;

/** Valid persisted Codex Stop windows, used to suppress their gateway micro-call lines in snapshots. */
export function codexStopRunWindowsFromJsonl(rawChunk: string): CodexStopRunWindow[] {
  return activityEventsFromJsonl(rawChunk).flatMap((event) => {
    if (
      event.activity_kind !== "codex-stop" ||
      typeof event.session_id !== "string" ||
      !event.session_id.startsWith("codex-session-") ||
      typeof event.run_started_at !== "string" ||
      typeof event.recorded_at !== "string"
    ) return [];
    return [{
      sessionCorrelationId: event.session_id.slice("codex-session-".length),
      startedAt: event.run_started_at,
      endedAt: event.recorded_at
    }];
  });
}

/** Valid persisted Codex and Claude Stop windows for default whole-run watch snapshots. */
export function settledStopRunWindowsFromJsonl(rawChunk: string): SettledStopRunWindow[] {
  return activityEventsFromJsonl(rawChunk).flatMap((event) => {
    const prefix = event.activity_kind === "codex-stop"
      ? "codex-session-"
      : event.activity_kind === "claude-stop"
        ? "claude-session-"
        : undefined;
    if (
      !prefix ||
      typeof event.session_id !== "string" ||
      !event.session_id.startsWith(prefix) ||
      typeof event.run_started_at !== "string" ||
      typeof event.recorded_at !== "string"
    ) return [];
    return [{
      sessionCorrelationId: event.session_id.slice(prefix.length),
      startedAt: event.run_started_at,
      endedAt: event.recorded_at
    }];
  });
}

/** Exact session hash + request-start interval only; cwd and append order are never attribution. */
export function gatewayReceiptCoveredByCodexStop(
  receipt: GatewayReceipt,
  windows: readonly CodexStopRunWindow[]
): boolean {
  const at = receipt.request_started_at ?? receipt.captured_at;
  if (typeof receipt.session_correlation_id !== "string" || typeof at !== "string") return false;
  return windows.some(
    (window) =>
      window.sessionCorrelationId === receipt.session_correlation_id &&
      at >= window.startedAt &&
      at <= window.endedAt
  );
}

export const gatewayReceiptCoveredBySettledStop = gatewayReceiptCoveredByCodexStop;
