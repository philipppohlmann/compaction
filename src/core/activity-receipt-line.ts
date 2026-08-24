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
 * recorded (`local-estimate` | `provider-reported` | …) taken VERBATIM. Cursor is local-estimate only
 * (chars/4 — the vendor emits no usage), and nothing here may upgrade that label. An event whose axes
 * are all unavailable prints as unavailable, never as a zero: a fabricated `output 0` is a measurement
 * claim, and there is no measurement.
 *
 * Content-free by construction: only counts, the fixed surface name, the recorded source labels, and a
 * short slice of the event's own opaque, content-derived-free id ever reach the line.
 */
import type { ActivityEvent } from "./activity-event.js";
import { buildActivityRows, type ActivityRow } from "./activity-view.js";
import { RECEIPT_LINE_PREFIX } from "./gateway/receipt-line.js";

/**
 * The activity surfaces `watch` renders from the local store: CURSOR ONLY.
 *
 * The rule is one line per turn. A surface that can produce BOTH an activity event and a gateway
 * receipt for the same run would print twice, and a doubled feed is a worse lie than a missing one.
 *
 * `claude_code` is excluded for that reason: its Stop hook writes activity events for turns that also
 * produce gateway receipts.
 *
 * `codex` is excluded for the SAME reason, which an earlier version of this comment got wrong. It
 * claimed the Codex capture shim had "no gateway receipt to collide with"; it does. The documented
 * routed command is `compaction gateway run -- codex …`, the child inherits PATH, and PATH is exactly
 * where the capture shim lives — so one routed Codex run appends an activity event AND writes a
 * gateway receipt. Codex still has two per-turn surfaces that work: its `Stop` hook line, and its
 * gateway receipts in this feed.
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
  if (!WATCH_ACTIVITY_SURFACES.includes(row.surface)) return undefined;
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
 * `recordedAt` is deliberately OPTIONAL and deliberately absent for every activity record: the
 * metrics-only activity contract stores no wall-clock at all (`ACTIVITY_EVENT_ALLOWED_KEYS` has no
 * time field, and `activity-view.ts` states the consequence — "runs are ordered by append recency").
 * A gateway receipt DOES carry one (`captured_at`). Modelling the difference instead of papering over
 * it is what lets a merged feed sort by real time where real time exists, and refuse to invent it
 * where it does not.
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
 * which for this store is ALWAYS "none recorded" (see `OrderedTurnLine`). Pure, never throws.
 */
export function activityTurnLinesFromJsonl(rawChunk: string): OrderedTurnLine[] {
  // No `recordedAt`: the metrics-only activity event has no wall-clock field to read. This is stated
  // once, here, rather than each caller guessing at a substitute (a file mtime or a read order would
  // both be orderings this record does not have).
  return activityLinesFromJsonl(rawChunk).map((line) => ({ line }));
}

/**
 * Render the canonical lines for a batch of raw activity JSONL (only the lines that parse to an event
 * on a covered surface). Pure, never throws: a malformed or foreign line is skipped, exactly as the
 * gateway-receipt renderer skips one.
 */
export function activityLinesFromJsonl(rawChunk: string): string[] {
  const events: ActivityEvent[] = [];
  for (const line of rawChunk.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as ActivityEvent;
      if (parsed && typeof parsed === "object" && typeof parsed.surface === "string") events.push(parsed);
    } catch {
      continue;
    }
  }
  if (events.length === 0) return [];
  // `buildActivityRows` is the ONE place that decides which count is reportable at which tier, so the
  // line can never disagree with `compaction activity` about the same event. It returns newest-first;
  // a live feed reads chronologically, so the order is restored here.
  const rows = buildActivityRows(events, { limit: events.length });
  const out: string[] = [];
  for (const row of [...rows].reverse()) {
    const line = activityReceiptLine(row);
    if (line) out.push(line);
  }
  return out;
}
