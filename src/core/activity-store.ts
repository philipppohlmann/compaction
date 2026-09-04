/**
 * Local metrics-only activity store: an append-only JSONL file under `.compaction/activity/`
 * (gitignored via `.compaction/`), one `ActivityEvent` per line. Local file I/O only, no
 * network, no new dependencies.
 *
 * Write-time invariants (fail-closed, a rejected event writes nothing):
 * 1. Content-free: every key must be on the metrics-only allowlist (unknown keys rejected;
 *    content-shaped names like `prompt`/`response` get an explicit message) and every string is
 *    length-bounded (an oversized "label" is content wearing a label's clothes).
 * 2. Full contract: `validateActivityEvent` (which runs the cross-surface validator) must return
 *    zero problems, including the auto-apply off-by-default rules.
 * 3. Dedupe by `activity_event_id`: appending an id already in the log is a reported no-op.
 *
 * `sync_status` defaults to `"local-only"` and `activity_event_id` is computed when absent -
 * the store never invents any other field.
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DEFAULT_ACTIVITY_SYNC_STATUS,
  computeActivityEventId,
  validateActivityEvent,
  type ActivityEvent
} from "./activity-event.js";
import {
  validClaudeLogicalRunId,
  validClaudeLogicalSessionId
} from "./claude-logical-run-id.js";

/** Default local activity directory (sibling of `.compaction/run-records`; gitignored via `.compaction/`). */
export const DEFAULT_ACTIVITY_DIRECTORY = ".compaction/activity";
/** The single append-only JSONL log inside it. */
export const ACTIVITY_LOG_FILENAME = "activity.jsonl";

/* ------------------------------------------------------------------------------------------------
 * Metrics-only (content-free) key allowlist, the write-time invariant of rule 1.
 * ---------------------------------------------------------------------------------------------- */

/** Top-level keys an activity event may carry: the cross-surface contract fields + the activity fields. */
export const ACTIVITY_EVENT_ALLOWED_KEYS: readonly string[] = [
  // cross-surface event (src/core/cross-surface-event.ts)
  "user_id",
  "team_id",
  "surface",
  "provider",
  "model_label",
  "workflow_id",
  "session_id",
  "run_id",
  "input_before",
  "input_after",
  "output_before",
  "output_after",
  "output_estimate",
  "token_source",
  "cost_source",
  "cost_unavailable_reason",
  "billing_model",
  "policy_used",
  "acceptance",
  "recoverability",
  "eval_status",
  "evidence_level",
  "claim_scope",
  "caveats",
  "plan_efficiency",
  // activity extension (src/core/activity-event.ts)
  "activity_event_id",
  "approval_status",
  "auto_apply",
  "recovery",
  "sync_status",
  "activity_kind",
  "recorded_at",
  "run_started_at",
  "output_shaping_state",
  "estimated_output_tokens_saved",
  "output_estimate_basis",
  "output_estimate_state",
  "apply_posture",
  "measurement_source"
];

/** Nested-object key allowlists (content can hide one level down just as easily). */
const NESTED_ALLOWED_KEYS: Readonly<Record<string, readonly string[]>> = {
  token_source: ["input", "output"],
  "token_source.input": ["source", "unavailable_reason"],
  "token_source.output": ["source", "unavailable_reason"],
  auto_apply: ["eligible", "preference", "applied_automatically", "gates_passed", "gates_failed"],
  recovery: ["original_retained", "location"],
  plan_efficiency: [
    "evidence_type",
    "billing_confirmed",
    "quota_window_id",
    "tasks_completed_in_window",
    "cap_events_in_window",
    "visible_tokens_per_task_estimate",
    "successful_tasks_before_reset"
  ]
};

/** Classic content-shaped key names, rejected with the explicit content message (case-insensitive). */
const CONTENT_SHAPED_KEY_NAMES: readonly string[] = [
  "prompt",
  "response",
  "content",
  "text",
  "message",
  "messages",
  "transcript",
  "stdout",
  "stderr",
  "body",
  "completion",
  "diff",
  "code"
];

/**
 * Longest string a metrics-only event may carry per field. The longest honest values today are
 * unavailability reasons / caveats (~120 chars); 600 leaves headroom while making prompt/response
 * smuggling in a "label" field impossible.
 */
export const ACTIVITY_MAX_STRING_LENGTH = 600;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function looksContentShaped(key: string): boolean {
  return CONTENT_SHAPED_KEY_NAMES.includes(key.toLowerCase());
}

function checkStrings(path: string, value: unknown, problems: string[]): void {
  if (typeof value === "string") {
    if (value.length > ACTIVITY_MAX_STRING_LENGTH) {
      problems.push(
        `${path}: string exceeds the metrics-only bound (${value.length} > ${ACTIVITY_MAX_STRING_LENGTH} chars) - that is content-sized, not a count/source/id/label`
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => checkStrings(`${path}[${index}]`, entry, problems));
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, entry] of Object.entries(value)) checkStrings(`${path}.${key}`, entry, problems);
  }
}

function checkAllowedKeys(path: string, value: Record<string, unknown>, allowed: readonly string[], problems: string[]): void {
  for (const key of Object.keys(value)) {
    if (allowed.includes(key)) continue;
    problems.push(
      looksContentShaped(key)
        ? `${path === "" ? key : `${path}.${key}`}: content-shaped field - activity events are metrics-only (counts, sources, ids, labels); prompt/response/output content is never stored`
        : `${path === "" ? key : `${path}.${key}`}: not on the metrics-only activity-event allowlist - unknown fields are rejected at write time (fail-closed content-free invariant)`
    );
  }
}

/**
 * The write-time invariant: the FULL contract validator + the metrics-only allowlist + string
 * bounds + store requirements (`activity_event_id` and `sync_status` present, the store's dedupe
 * key and sync default are always materialized before this runs). Report-only: returns problems.
 */
export function validateActivityEventForStore(value: unknown): { problems: string[] } {
  const problems = [...validateActivityEvent(value).problems];
  if (!isPlainObject(value)) return { problems };
  checkAllowedKeys("", value, ACTIVITY_EVENT_ALLOWED_KEYS, problems);
  for (const [path, allowed] of Object.entries(NESTED_ALLOWED_KEYS)) {
    const segments = path.split(".");
    let cursor: unknown = value;
    for (const segment of segments) {
      cursor = isPlainObject(cursor) ? cursor[segment] : undefined;
    }
    if (isPlainObject(cursor)) checkAllowedKeys(path, cursor, allowed, problems);
  }
  checkStrings("event", value, problems);
  if (typeof value.activity_event_id !== "string" || value.activity_event_id === "") {
    problems.push("activity_event_id: required by the activity store (the dedupe key)");
  }
  if (value.sync_status === undefined) {
    problems.push('sync_status: required by the activity store (default "local-only" is applied before validation)');
  }
  return { problems };
}

/* ------------------------------------------------------------------------------------------------
 * Write / read / list.
 * ---------------------------------------------------------------------------------------------- */

export type AppendActivityEventResult =
  | { appended: true; path: string; activity_event_id: string }
  | { appended: false; reason: string; problems?: string[] };

/**
 * Append ONE metrics-only event to the local JSONL log. Fail-closed: a rejected event writes
 * NOTHING (and the rejection carries the exact problems). Dedupe: an id already in the log is a
 * reported no-op. Local file I/O only, never a network call.
 */
export async function appendActivityEvent(
  event: ActivityEvent,
  directory: string = DEFAULT_ACTIVITY_DIRECTORY
): Promise<AppendActivityEventResult> {
  const withDefaults: ActivityEvent = {
    ...event,
    sync_status: event.sync_status ?? DEFAULT_ACTIVITY_SYNC_STATUS
  };
  const materialized: ActivityEvent = {
    ...withDefaults,
    activity_event_id: withDefaults.activity_event_id ?? computeActivityEventId(withDefaults)
  };
  const { problems } = validateActivityEventForStore(materialized);
  if (problems.length > 0) {
    return { appended: false, reason: "metrics-only invariant rejected the event - nothing was written", problems };
  }
  const id = materialized.activity_event_id as string;
  // Physical append idempotency is deliberately checked against the raw validated log. The public
  // reader coalesces cumulative Claude snapshots by logical run, but an older hidden snapshot must
  // still prevent its exact physical event id from being appended again.
  const { events } = await readPhysicalActivityEvents(directory);
  if (events.some((existing) => existing.activity_event_id === id)) {
    return { appended: false, reason: `duplicate activity_event_id ${id} - already recorded (dedupe; nothing written)` };
  }
  await mkdir(directory, { recursive: true });
  const path = join(directory, ACTIVITY_LOG_FILENAME);
  await appendFile(path, `${JSON.stringify(materialized)}\n`, "utf8");
  return { appended: true, path, activity_event_id: id };
}

export interface SkippedActivityLine {
  /** 1-based line number in the JSONL log. */
  line: number;
  reason: string;
}

/**
 * Read all events from the local log. A missing directory/file means "no activity yet" (empty,
 * not an error). Invalid lines are SKIPPED with a reason - never guessed at; a duplicate id keeps
 * the FIRST occurrence (defensive read-side dedupe; the write side already prevents this).
 */
async function readPhysicalActivityEvents(
  directory: string = DEFAULT_ACTIVITY_DIRECTORY
): Promise<{ events: ActivityEvent[]; skipped: SkippedActivityLine[] }> {
  let raw: string;
  try {
    raw = await readFile(join(directory, ACTIVITY_LOG_FILENAME), "utf8");
  } catch (error: unknown) {
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "unknown";
    if (code === "ENOENT") return { events: [], skipped: [] };
    throw error;
  }
  const events: ActivityEvent[] = [];
  const skipped: SkippedActivityLine[] = [];
  const seen = new Set<string>();
  raw.split("\n").forEach((line, index) => {
    if (line.trim() === "") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      skipped.push({ line: index + 1, reason: "invalid JSON" });
      return;
    }
    const { problems } = validateActivityEventForStore(parsed);
    if (problems.length > 0) {
      skipped.push({ line: index + 1, reason: `invalid activity event: ${problems[0]}` });
      return;
    }
    const event = parsed as ActivityEvent;
    const id = event.activity_event_id as string;
    if (seen.has(id)) {
      skipped.push({ line: index + 1, reason: `duplicate activity_event_id ${id} - first occurrence kept` });
      return;
    }
    seen.add(id);
    events.push(event);
  });
  return { events, skipped };
}

const CLAUDE_MONOTONIC_COUNT_FIELDS = [
  "input_before",
  "input_after",
  "output_after"
] as const;

const CLAUDE_IMMUTABLE_RUN_FIELDS = [
  "surface",
  "provider",
  "workflow_id",
  "session_id",
  "run_id",
  "claim_scope",
  "evidence_level",
  "activity_kind",
  "run_started_at",
  "measurement_source"
] as const;

function claudeLogicalPair(event: ActivityEvent): string | undefined {
  return event.surface === "claude_code" &&
    validClaudeLogicalSessionId(event.session_id) &&
    validClaudeLogicalRunId(event.run_id)
    ? `${event.session_id}\0${event.run_id}`
    : undefined;
}

function canonicalRecordedAt(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function orderedCompatibleClaudeSnapshots(events: ActivityEvent[], indices: number[]): boolean {
  const snapshots = indices.map((index) => events[index]);
  const first = snapshots[0];
  if (
    first.activity_kind !== "claude-stop" ||
    first.workflow_id !== "claude-stop" ||
    !canonicalRecordedAt(first.run_started_at) ||
    !canonicalRecordedAt(first.recorded_at) ||
    first.recorded_at < first.run_started_at
  ) return false;
  if (snapshots.some((event) =>
    CLAUDE_IMMUTABLE_RUN_FIELDS.some((field) => event[field] !== first[field])
  )) return false;
  for (let index = 1; index < snapshots.length; index += 1) {
    const older = snapshots[index - 1];
    const newer = snapshots[index];
    if (
      !canonicalRecordedAt(older.recorded_at) ||
      !canonicalRecordedAt(newer.recorded_at) ||
      newer.recorded_at < first.run_started_at ||
      newer.recorded_at <= older.recorded_at
    ) return false;
    for (const field of CLAUDE_MONOTONIC_COUNT_FIELDS) {
      const before = older[field];
      const after = newer[field];
      if (typeof before === "number" && (typeof after !== "number" || after < before)) return false;
    }
  }
  return true;
}

function finalClaudeStopCoversLegacySnapshots(events: ActivityEvent[], indices: number[]): boolean {
  const snapshots = indices.map((index) => events[index]);
  const final = snapshots[snapshots.length - 1];
  if (
    final.activity_kind !== "claude-stop" ||
    final.workflow_id !== "claude-stop" ||
    !canonicalRecordedAt(final.run_started_at) ||
    !canonicalRecordedAt(final.recorded_at) ||
    final.recorded_at < final.run_started_at ||
    snapshots.slice(0, -1).some((event) => event.activity_kind !== undefined)
  ) return false;
  // A transcript-backed final may be a task-scoped monotonic delta from the immediately preceding
  // session snapshot. Its earlier legacy parent is still cumulative, so their counts are deliberately
  // not comparable. The exact hashed session/run pair is the authority; it is derived from the run's
  // session correlation, sequence, and start identity rather than from a timestamp/content heuristic.
  if (final.measurement_source === "claude-transcript" && final.claim_scope === "run-scoped") return true;
  return snapshots.slice(0, -1).every((event) =>
    CLAUDE_MONOTONIC_COUNT_FIELDS.every((field) => {
      const before = event[field];
      const after = final[field];
      return typeof before !== "number" || (typeof after === "number" && after >= before);
    })
  );
}

/**
 * Collapse only unambiguous cumulative Claude snapshots for the exact hashed session/logical-run
 * pair. The physical JSONL remains append-only. Exact run identity/window and comparable cumulative
 * counts must remain compatible; a validated task-scoped transcript delta supersedes its exact legacy
 * cumulative parent by identity instead. Derived metadata (model, shaping posture, token-source mix,
 * policy/calibration result) may legitimately evolve as later calls join the same run; the latest
 * validated snapshot is authoritative. Missing/legacy/malformed/foreign identity, immutable-identity
 * conflicts, timestamp ties/inversions, and count regressions remain separate events. One earlier
 * hook-only legacy snapshot may also be superseded when the later validated Claude Stop carries the
 * exact same hashed logical identity and nondecreasing cumulative axes; the physical row stays intact.
 */
export function coalesceClaudeLogicalRuns(events: ActivityEvent[]): ActivityEvent[] {
  const groups = new Map<string, number[]>();
  events.forEach((event, index) => {
    const pair = claudeLogicalPair(event);
    if (!pair) return;
    const group = groups.get(pair) ?? [];
    group.push(index);
    groups.set(pair, group);
  });
  const suppressed = new Set<number>();
  for (const indices of groups.values()) {
    if (
      indices.length < 2 ||
      (!orderedCompatibleClaudeSnapshots(events, indices) &&
        !finalClaudeStopCoversLegacySnapshots(events, indices))
    ) continue;
    for (const index of indices.slice(0, -1)) suppressed.add(index);
  }
  return events.filter((_, index) => !suppressed.has(index));
}

/**
 * Public logical activity reader. Physical ids are validated/deduped first; then exact Claude
 * cumulative snapshots coalesce to the latest final snapshot for every ordinary activity consumer.
 */
export async function readActivityEvents(
  directory: string = DEFAULT_ACTIVITY_DIRECTORY
): Promise<{ events: ActivityEvent[]; skipped: SkippedActivityLine[] }> {
  const physical = await readPhysicalActivityEvents(directory);
  return { events: coalesceClaudeLogicalRuns(physical.events), skipped: physical.skipped };
}

/** A content-free one-line summary per event - ids, surface, statuses; never counts recomputed. */
export interface ActivityEventSummary {
  activity_event_id: string;
  surface: string;
  run_id?: string;
  approval_status?: string;
  sync_status?: string;
}

/** List the stored events as content-free summaries (the future `compaction activity` command's data). */
export async function listActivityEvents(
  directory: string = DEFAULT_ACTIVITY_DIRECTORY
): Promise<{ summaries: ActivityEventSummary[]; skipped: SkippedActivityLine[] }> {
  const { events, skipped } = await readActivityEvents(directory);
  const summaries = events.map((event) => ({
    activity_event_id: event.activity_event_id as string,
    surface: event.surface,
    ...(event.run_id !== undefined ? { run_id: event.run_id } : {}),
    ...(event.approval_status !== undefined ? { approval_status: event.approval_status } : {}),
    ...(event.sync_status !== undefined ? { sync_status: event.sync_status } : {})
  }));
  return { summaries, skipped };
}
