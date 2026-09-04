/**
 * USER-RUN BOUNDARIES — one external user task inside one tool session.
 *
 * TWO SEPARATE CONCEPTS, deliberately not merged:
 *  - SESSION CORRELATION (`session-correlation.ts`) — a stable device-local hash of the tool session
 *    id, recorded on every receipt. It says WHICH SESSION a call came from.
 *  - RUN IDENTITY (this module) — the `run_seq`-th task inside that session, with its own start and
 *    end timestamps. It says WHICH TASK. A structured Claude task notification may provisionally
 *    open another interval and later collapse into its exact predecessor.
 * A session contains many runs, so the session hash alone cannot identify one; using it as a run id
 * would merge every prompt in a session into one aggregate.
 *
 * MEMBERSHIP IS BOTH, NEVER CWD. A receipt belongs to a run iff its `session_correlation_id` equals
 * the run's AND the instant its REQUEST ARRIVED (`request_started_at`) falls inside the run's interval.
 * Two concurrent Claude Code sessions in one directory therefore never mix: they carry different
 * session ids, so different correlation ids, and MEMBERSHIP consults no path. (The SET of candidate
 * receipts a caller tests is another matter: the status line reads a bounded tail of one working
 * directory's ledger, so a run whose calls were written to another directory's ledger, or further back
 * than the window, is under-counted there — never mis-attributed.)
 *
 * WHY THE REQUEST INSTANT AND NOT `captured_at`. The receipt is appended only after the response has
 * fully streamed and the usage window has been assembled — on a compressed response, after an
 * asynchronous decompressor flush — while the client already holds the response and its `Stop` hook
 * may already have closed the run. Judged by `captured_at`, the run's FINAL call landed after
 * `ended_at` and was permanently excluded from the completed aggregate. The request instant is
 * provably before the response and so before any `Stop` the response triggers. It is equally the
 * right instant at the START of a run: a call the previous prompt issued cannot cross into this one
 * merely by finishing late. No grace window is involved, so a later run's call can never bleed in.
 * Receipts written before the field existed fall back to `captured_at`.
 *
 * WORK THAT OUTLIVES `Stop` IS LEFT UNATTRIBUTED unless exact later vendor evidence proves an internal
 * Claude task-notification continuation. A backgrounded subagent without that evidence can still be
 * issuing provider calls after the main turn ends; those calls remain outside the closed interval.
 * Misattributing another prompt's cost is worse than declining to attribute, and the unattributed call
 * remains on the receipt ledger.
 */
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { dirname, resolve } from "node:path";
import { compactionConfigDir, type ConfigDirEnv } from "../config-dir.js";
import { computeActivityEventId, type ActivityEvent } from "../activity-event.js";
import { validateActivityEventForStore } from "../activity-store.js";
import { claudeLogicalRunIdentity } from "../claude-logical-run-id.js";
import { invalidateCodexShapingTurnRecordByCorrelation } from "../output-shaping-turn-state.js";
import { validCorrelationId } from "./session-correlation.js";

/** Schema tag: a store written by an older/newer shape is ignored rather than misread. */
export const RUN_BOUNDARY_SCHEMA = "compaction.run-boundary.v1";

/** How many completed runs to retain per session. Bounded so the file cannot grow without limit. */
const RETAINED_RUNS = 20;

export const CODEX_SETTLEMENT_PENDING_SCHEMA = "compaction.codex-settlement-pending.v1";

export const CLAUDE_PROVISIONAL_PENDING_SCHEMA = "compaction.claude-provisional-pending.v2";

/** Immutable, content-free retry authority for one already-closed Codex run. */
export interface CodexSettlementPending {
  schema: typeof CODEX_SETTLEMENT_PENDING_SCHEMA;
  session_correlation_id: string;
  turn_correlation_id: string;
  run_seq: number;
  run_started_at: string;
  run_ended_at: string;
  event: ActivityEvent;
}

const CODEX_SETTLEMENT_PENDING_KEYS = [
  "schema",
  "session_correlation_id",
  "turn_correlation_id",
  "run_seq",
  "run_started_at",
  "run_ended_at",
  "event"
] as const;

export interface UserRun {
  /** Device-local hash of the tool session id. NOT a run id — see the module note. */
  session_correlation_id: string;
  /** 1-based ordinal of this prompt within the session. With the session hash, identifies the run. */
  run_seq: number;
  /** UTC ISO timestamp of `UserPromptSubmit`. */
  started_at: string;
  /** Optional device-local hash of a host turn id. Raw host ids never enter the store. */
  turn_correlation_id?: string;
  /** UTC ISO timestamp of `Stop`. Absent while the run is still in flight. */
  ended_at?: string;
  /** Optional frozen local-only event retained only until its activity append is confirmed durable. */
  codex_settlement_pending?: CodexSettlementPending;
}

/** The sole bounded identity awaiting post-hook Claude transcript evidence. */
export interface ClaudeOpenProvisionalPending {
  schema: typeof CLAUDE_PROVISIONAL_PENDING_SCHEMA;
  phase: "open";
  session_correlation_id: string;
  prompt_correlation_id: string;
  predecessor_run_seq: number;
  provisional_run_seq: number;
}

/** The same one bounded pending object after an exact positive collapse, until publication is durable. */
export interface ClaudeSettledProvisionalPending {
  schema: typeof CLAUDE_PROVISIONAL_PENDING_SCHEMA;
  phase: "settled";
  session_correlation_id: string;
  prompt_correlation_id: string;
  predecessor_run_seq: number;
  provisional_run_seq: number;
  dedup_key: string;
  run_started_at: string;
  run_ended_at: string;
  event: ActivityEvent;
}

export type ClaudeProvisionalPending = ClaudeOpenProvisionalPending | ClaudeSettledProvisionalPending;

const CLAUDE_OPEN_PENDING_KEYS = [
  "schema",
  "phase",
  "session_correlation_id",
  "prompt_correlation_id",
  "predecessor_run_seq",
  "provisional_run_seq"
] as const;

const CLAUDE_SETTLED_PENDING_KEYS = [
  "schema",
  "phase",
  "session_correlation_id",
  "prompt_correlation_id",
  "predecessor_run_seq",
  "provisional_run_seq",
  "dedup_key",
  "run_started_at",
  "run_ended_at",
  "event"
] as const;

interface RunStore {
  schema: string;
  runs: UserRun[];
  claude_provisional_pending?: ClaudeProvisionalPending;
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
  } catch {
    return false;
  }
}

function storePath(correlationId: string, env: ConfigDirEnv): string | undefined {
  if (!validCorrelationId(correlationId)) return undefined;
  const directory = resolve(compactionConfigDir(env), "runs");
  const candidate = resolve(directory, `${correlationId}.json`);
  return dirname(candidate) === directory ? candidate : undefined;
}

function validRunCore(value: unknown, correlationId: string): value is UserRun {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const run = value as Record<string, unknown>;
  if (run.session_correlation_id !== correlationId || !validCorrelationId(run.session_correlation_id)) return false;
  if (!Number.isSafeInteger(run.run_seq) || (run.run_seq as number) < 1) return false;
  if (!canonicalTimestamp(run.started_at)) return false;
  if (run.turn_correlation_id !== undefined && !validCorrelationId(run.turn_correlation_id)) return false;
  if (run.ended_at !== undefined) {
    if (!canonicalTimestamp(run.ended_at) || run.ended_at < run.started_at) return false;
  }
  return true;
}

function validPending(value: unknown, run: UserRun): value is CodexSettlementPending {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (!run.ended_at || !run.turn_correlation_id) return false;
  const pending = value as Record<string, unknown>;
  const event = pending.event;
  if (
    Object.keys(pending).length !== CODEX_SETTLEMENT_PENDING_KEYS.length ||
    !CODEX_SETTLEMENT_PENDING_KEYS.every((key) => Object.hasOwn(pending, key)) ||
    pending.schema !== CODEX_SETTLEMENT_PENDING_SCHEMA ||
    pending.session_correlation_id !== run.session_correlation_id ||
    pending.turn_correlation_id !== run.turn_correlation_id ||
    pending.run_seq !== run.run_seq ||
    pending.run_started_at !== run.started_at ||
    pending.run_ended_at !== run.ended_at ||
    validateActivityEventForStore(event).problems.length > 0
  ) return false;
  const activity = event as ActivityEvent;
  return (
    activity.activity_kind === "codex-stop" &&
    activity.surface === "codex" &&
    activity.session_id === `codex-session-${run.session_correlation_id}` &&
    activity.run_id === `codex-stop-${run.turn_correlation_id}` &&
    activity.run_started_at === run.started_at &&
    activity.recorded_at === run.ended_at &&
    activity.activity_event_id === computeActivityEventId(activity)
  );
}

function projectRun(value: unknown, correlationId: string): UserRun | undefined {
  if (!validRunCore(value, correlationId)) return undefined;
  const candidate = value as UserRun;
  const run: UserRun = {
    session_correlation_id: candidate.session_correlation_id,
    run_seq: candidate.run_seq,
    started_at: candidate.started_at,
    ...(candidate.turn_correlation_id ? { turn_correlation_id: candidate.turn_correlation_id } : {}),
    ...(candidate.ended_at ? { ended_at: candidate.ended_at } : {})
  };
  const rawPending = (value as unknown as Record<string, unknown>).codex_settlement_pending;
  return validPending(rawPending, run)
    ? { ...run, codex_settlement_pending: rawPending }
    : run;
}

function validClaudeOpenPending(
  value: unknown,
  runs: UserRun[],
  correlationId: string
): value is ClaudeOpenProvisionalPending {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const pending = value as Record<string, unknown>;
  if (
    Object.keys(pending).length !== CLAUDE_OPEN_PENDING_KEYS.length ||
    !CLAUDE_OPEN_PENDING_KEYS.every((key) => Object.hasOwn(pending, key)) ||
    pending.schema !== CLAUDE_PROVISIONAL_PENDING_SCHEMA ||
    pending.phase !== "open" ||
    pending.session_correlation_id !== correlationId ||
    !validCorrelationId(pending.session_correlation_id) ||
    !validCorrelationId(pending.prompt_correlation_id) ||
    !Number.isSafeInteger(pending.predecessor_run_seq) ||
    !Number.isSafeInteger(pending.provisional_run_seq)
  ) return false;
  const predecessor = runs[runs.length - 2];
  const provisional = runs[runs.length - 1];
  return (
    predecessor !== undefined &&
    provisional !== undefined &&
    predecessor.session_correlation_id === correlationId &&
    provisional.session_correlation_id === correlationId &&
    predecessor.turn_correlation_id === undefined &&
    provisional.turn_correlation_id === undefined &&
    predecessor.ended_at !== undefined &&
    provisional.ended_at === undefined &&
    predecessor.run_seq === pending.predecessor_run_seq &&
    provisional.run_seq === pending.provisional_run_seq &&
    provisional.run_seq === predecessor.run_seq + 1
  );
}

function validClaudeSettledPending(
  value: unknown,
  runs: UserRun[],
  correlationId: string
): value is ClaudeSettledProvisionalPending {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const pending = value as Record<string, unknown>;
  if (
    Object.keys(pending).length !== CLAUDE_SETTLED_PENDING_KEYS.length ||
    !CLAUDE_SETTLED_PENDING_KEYS.every((key) => Object.hasOwn(pending, key)) ||
    pending.schema !== CLAUDE_PROVISIONAL_PENDING_SCHEMA ||
    pending.phase !== "settled" ||
    pending.session_correlation_id !== correlationId ||
    !validCorrelationId(pending.session_correlation_id) ||
    !validCorrelationId(pending.prompt_correlation_id) ||
    !Number.isSafeInteger(pending.predecessor_run_seq) ||
    !Number.isSafeInteger(pending.provisional_run_seq) ||
    pending.provisional_run_seq !== (pending.predecessor_run_seq as number) + 1 ||
    typeof pending.dedup_key !== "string" ||
    !/^[0-9a-f]{32}$/.test(pending.dedup_key) ||
    !canonicalTimestamp(pending.run_started_at) ||
    !canonicalTimestamp(pending.run_ended_at) ||
    validateActivityEventForStore(pending.event).problems.length > 0
  ) return false;
  const run = runs[runs.length - 1];
  const event = pending.event as ActivityEvent;
  const identity = run ? claudeLogicalRunIdentity(run) : undefined;
  return run !== undefined &&
    runs.every((candidate) => candidate.ended_at !== undefined) &&
    run.session_correlation_id === correlationId &&
    run.turn_correlation_id === undefined &&
    run.run_seq === pending.predecessor_run_seq &&
    run.started_at === pending.run_started_at &&
    run.ended_at === pending.run_ended_at &&
    identity !== undefined &&
    event.activity_kind === "claude-stop" &&
    event.surface === "claude_code" &&
    event.session_id === identity.sessionId &&
    event.run_id === identity.runId &&
    event.run_started_at === run.started_at &&
    event.recorded_at === run.ended_at &&
    event.activity_event_id === computeActivityEventId(event);
}

function validClaudePending(
  value: unknown,
  runs: UserRun[],
  correlationId: string
): value is ClaudeProvisionalPending {
  return validClaudeOpenPending(value, runs, correlationId) ||
    validClaudeSettledPending(value, runs, correlationId);
}

function readStore(correlationId: string, env: ConfigDirEnv): RunStore {
  const path = storePath(correlationId, env);
  if (!path) return { schema: RUN_BOUNDARY_SCHEMA, runs: [] };
  let descriptor: number | undefined;
  try {
    const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink()) return { schema: RUN_BOUNDARY_SCHEMA, runs: [] };
    const noFollow = "O_NOFOLLOW" in fsConstants ? fsConstants.O_NOFOLLOW : 0;
    descriptor = openSync(path, fsConstants.O_RDONLY | noFollow);
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      return { schema: RUN_BOUNDARY_SCHEMA, runs: [] };
    }
    const parsed = JSON.parse(readFileSync(descriptor, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { schema: RUN_BOUNDARY_SCHEMA, runs: [] };
    }
    const candidate = parsed as Record<string, unknown>;
    if (candidate.schema !== RUN_BOUNDARY_SCHEMA || !Array.isArray(candidate.runs)) {
      return { schema: RUN_BOUNDARY_SCHEMA, runs: [] };
    }
    const runs = candidate.runs
      .map((run) => projectRun(run, correlationId))
      .filter((run): run is UserRun => run !== undefined);
    const pending = candidate.claude_provisional_pending;
    return {
      schema: RUN_BOUNDARY_SCHEMA,
      runs,
      ...(validClaudePending(pending, runs, correlationId)
        ? { claude_provisional_pending: pending }
        : {})
    };
  } catch {
    return { schema: RUN_BOUNDARY_SCHEMA, runs: [] };
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // A failed close cannot make malformed/untrusted state authoritative.
      }
    }
  }
}

function writeStore(correlationId: string, store: RunStore, env: ConfigDirEnv): boolean {
  const path = storePath(correlationId, env);
  if (!path) return false;
  let descriptor: number | undefined;
  try {
    mkdirSync(dirname(path), { recursive: true });
    try {
      const existing = lstatSync(path);
      if (!existing.isFile() || existing.isSymbolicLink()) return false;
    } catch (error: unknown) {
      const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "unknown";
      if (code !== "ENOENT") return false;
    }
    const noFollow = "O_NOFOLLOW" in fsConstants ? fsConstants.O_NOFOLLOW : 0;
    descriptor = openSync(
      path,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | noFollow,
      0o600
    );
    const opened = fstatSync(descriptor);
    if (!opened.isFile()) return false;
    const retained = store.runs.slice(-RETAINED_RUNS);
    const pending = validClaudePending(store.claude_provisional_pending, retained, correlationId)
      ? store.claude_provisional_pending
      : undefined;
    writeFileSync(descriptor, JSON.stringify({
      schema: RUN_BOUNDARY_SCHEMA,
      runs: retained,
      ...(pending ? { claude_provisional_pending: pending } : {})
    }), "utf8");
    const retainedSet = new Set(retained);
    for (const evicted of store.runs) {
      if (!retainedSet.has(evicted) && evicted.codex_settlement_pending?.turn_correlation_id) {
        invalidateCodexShapingTurnRecordByCorrelation(
          evicted.codex_settlement_pending.turn_correlation_id,
          env
        );
      }
    }
    return true;
  } catch {
    return false;
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // A close error makes no additional state authoritative.
      }
    }
  }
}

/**
 * Open a new run for this session (`UserPromptSubmit`). Any still-open previous run is closed at this
 * instant first: a missing `Stop` (crash, interrupt, `--continue`) must not leave a run accumulating
 * forever and swallowing the next prompt's calls.
 */
export function startUserRun(
  correlationId: string,
  at: string,
  env: ConfigDirEnv = process.env,
  turnCorrelationId?: string
): UserRun | undefined {
  if (!validCorrelationId(correlationId) || !canonicalTimestamp(at)) return undefined;
  if (turnCorrelationId !== undefined && !validCorrelationId(turnCorrelationId)) return undefined;
  const store = readStore(correlationId, env);
  for (const run of store.runs) if (run.ended_at === undefined) run.ended_at = at;
  const run: UserRun = {
    session_correlation_id: correlationId,
    run_seq: (store.runs[store.runs.length - 1]?.run_seq ?? 0) + 1,
    started_at: at,
    ...(turnCorrelationId ? { turn_correlation_id: turnCorrelationId } : {})
  };
  store.runs.push(run);
  return writeStore(correlationId, store, env) ? run : undefined;
}

/** Close the open run for this session (`Stop`). No open run → nothing to close, and no run invented. */
export function endUserRun(
  correlationId: string,
  at: string,
  env: ConfigDirEnv = process.env,
  turnCorrelationId?: string
): UserRun | undefined {
  if (!validCorrelationId(correlationId) || !canonicalTimestamp(at)) return undefined;
  if (turnCorrelationId !== undefined && !validCorrelationId(turnCorrelationId)) return undefined;
  const store = readStore(correlationId, env);
  const open = [...store.runs].reverse().find(
    (r) =>
      r.ended_at === undefined &&
      (turnCorrelationId === undefined || r.turn_correlation_id === turnCorrelationId)
  );
  if (!open) return undefined;
  open.ended_at = at;
  return writeStore(correlationId, store, env) ? open : undefined;
}

function sameClaudeOpenPending(left: ClaudeOpenProvisionalPending, right: ClaudeOpenProvisionalPending): boolean {
  return CLAUDE_OPEN_PENDING_KEYS.every((key) => left[key] === right[key]);
}

/** Read-only snapshot of the one valid Claude provisional identity for this session. */
export function claudeProvisionalPending(
  correlationId: string,
  env: ConfigDirEnv = process.env
): ClaudeProvisionalPending | undefined {
  if (!validCorrelationId(correlationId)) return undefined;
  const pending = readStore(correlationId, env).claude_provisional_pending;
  return pending
    ? pending.phase === "settled"
      ? { ...pending, event: { ...pending.event } }
      : { ...pending }
    : undefined;
}

export interface ClaudeProvisionalResolution {
  expected: ClaudeOpenProvisionalPending;
  taskNotification: boolean;
}

function resolveClaudePending(
  store: RunStore,
  correlationId: string,
  at: string,
  resolution?: ClaudeProvisionalResolution
): UserRun | undefined {
  const pending = store.claude_provisional_pending;
  if (
    pending?.phase === "open" &&
    resolution &&
    sameClaudeOpenPending(pending, resolution.expected) &&
    validClaudeOpenPending(pending, store.runs, correlationId)
  ) {
    const predecessor = store.runs[store.runs.length - 2];
    const provisional = store.runs[store.runs.length - 1];
    if (at < provisional.started_at) return undefined;
    delete store.claude_provisional_pending;
    if (resolution.taskNotification) {
      predecessor.ended_at = at;
      store.runs.pop();
      return predecessor;
    }
    provisional.ended_at = at;
    return provisional;
  }

  // Missing, changed, malformed, foreign, or stale evidence may close a run but may never collapse it.
  delete store.claude_provisional_pending;
  let closed: UserRun | undefined;
  for (const run of store.runs) {
    if (run.ended_at === undefined) {
      if (at < run.started_at) return undefined;
      run.ended_at = at;
      closed = run;
    }
  }
  return closed;
}

/**
 * Settle any older provisional identity and open the current Claude prompt in one store write. The
 * current prompt becomes provisional only beside its immediate completed predecessor.
 */
export function startClaudeUserRun(
  correlationId: string,
  promptCorrelationId: string | undefined,
  at: string,
  resolution: ClaudeProvisionalResolution | undefined,
  env: ConfigDirEnv = process.env
): UserRun | undefined {
  if (!validCorrelationId(correlationId) || !canonicalTimestamp(at)) return undefined;
  if (promptCorrelationId !== undefined && !validCorrelationId(promptCorrelationId)) return undefined;
  const store = readStore(correlationId, env);
  resolveClaudePending(store, correlationId, at, resolution);
  for (const run of store.runs) {
    if (run.ended_at === undefined) {
      if (at < run.started_at) return undefined;
      run.ended_at = at;
    }
  }
  const predecessor = store.runs[store.runs.length - 1];
  const run: UserRun = {
    session_correlation_id: correlationId,
    run_seq: (predecessor?.run_seq ?? 0) + 1,
    started_at: at
  };
  store.runs.push(run);
  if (
    promptCorrelationId &&
    predecessor?.ended_at !== undefined &&
    predecessor.turn_correlation_id === undefined &&
    run.run_seq === predecessor.run_seq + 1
  ) {
    store.claude_provisional_pending = {
      schema: CLAUDE_PROVISIONAL_PENDING_SCHEMA,
      phase: "open",
      session_correlation_id: correlationId,
      prompt_correlation_id: promptCorrelationId,
      predecessor_run_seq: predecessor.run_seq,
      provisional_run_seq: run.run_seq
    };
  }
  return writeStore(correlationId, store, env) ? run : undefined;
}

/** Settle one Claude provisional run at Stop; positive evidence alone collapses it into its predecessor. */
export function endClaudeUserRun(
  correlationId: string,
  at: string,
  resolution: ClaudeProvisionalResolution | undefined,
  env: ConfigDirEnv = process.env
): UserRun | undefined {
  if (!validCorrelationId(correlationId) || !canonicalTimestamp(at)) return undefined;
  const store = readStore(correlationId, env);
  const settled = resolveClaudePending(store, correlationId, at, resolution);
  if (!settled) return undefined;
  return writeStore(correlationId, store, env) ? settled : undefined;
}

/** Read-only exact positive-collapse projection. It never creates authority or writes the store. */
export function projectClaudePositiveSettlement(
  correlationId: string,
  at: string,
  expected: ClaudeOpenProvisionalPending,
  env: ConfigDirEnv = process.env
): UserRun | undefined {
  if (!validCorrelationId(correlationId) || !canonicalTimestamp(at)) return undefined;
  const store = readStore(correlationId, env);
  const pending = store.claude_provisional_pending;
  if (
    pending?.phase !== "open" ||
    !sameClaudeOpenPending(pending, expected) ||
    !validClaudeOpenPending(pending, store.runs, correlationId)
  ) return undefined;
  const predecessor = store.runs[store.runs.length - 2];
  const provisional = store.runs[store.runs.length - 1];
  return at >= provisional.started_at ? { ...predecessor, ended_at: at } : undefined;
}

/**
 * Atomically collapse the exact positive pair and transition the SAME bounded pending object to its
 * frozen settlement phase. The first valid frozen writer wins; conflicting retries write nothing.
 */
export function commitClaudePositiveSettlement(
  correlationId: string,
  at: string,
  expected: ClaudeOpenProvisionalPending,
  dedupKey: string,
  event: ActivityEvent,
  env: ConfigDirEnv = process.env
): ClaudeSettledProvisionalPending | undefined {
  if (!validCorrelationId(correlationId) || !canonicalTimestamp(at) || !/^[0-9a-f]{32}$/.test(dedupKey)) {
    return undefined;
  }
  const store = readStore(correlationId, env);
  const pending = store.claude_provisional_pending;
  if (
    pending?.phase !== "open" ||
    !sameClaudeOpenPending(pending, expected) ||
    !validClaudeOpenPending(pending, store.runs, correlationId)
  ) return undefined;
  const predecessor = store.runs[store.runs.length - 2];
  const provisional = store.runs[store.runs.length - 1];
  if (at < provisional.started_at) return undefined;
  const settledRun: UserRun = { ...predecessor, ended_at: at };
  const identity = claudeLogicalRunIdentity(settledRun);
  if (
    !identity ||
    validateActivityEventForStore(event).problems.length > 0 ||
    event.activity_kind !== "claude-stop" ||
    event.surface !== "claude_code" ||
    event.session_id !== identity.sessionId ||
    event.run_id !== identity.runId ||
    event.run_started_at !== settledRun.started_at ||
    event.recorded_at !== at ||
    event.activity_event_id !== computeActivityEventId(event)
  ) return undefined;
  const frozen: ClaudeSettledProvisionalPending = {
    schema: CLAUDE_PROVISIONAL_PENDING_SCHEMA,
    phase: "settled",
    session_correlation_id: correlationId,
    prompt_correlation_id: pending.prompt_correlation_id,
    predecessor_run_seq: predecessor.run_seq,
    provisional_run_seq: provisional.run_seq,
    dedup_key: dedupKey,
    run_started_at: settledRun.started_at,
    run_ended_at: at,
    event
  };
  store.runs[store.runs.length - 2] = settledRun;
  store.runs.pop();
  store.claude_provisional_pending = frozen;
  return writeStore(correlationId, store, env) ? frozen : undefined;
}

/** Clear only the unchanged valid frozen settlement after record, ledger, and activity durability. */
export function completeClaudePositiveSettlement(
  correlationId: string,
  expected: ClaudeSettledProvisionalPending,
  env: ConfigDirEnv = process.env
): boolean {
  if (!validCorrelationId(correlationId)) return false;
  const store = readStore(correlationId, env);
  const pending = store.claude_provisional_pending;
  if (
    pending?.phase !== "settled" ||
    !validClaudeSettledPending(pending, store.runs, correlationId) ||
    pending.dedup_key !== expected.dedup_key ||
    pending.event.activity_event_id !== expected.event.activity_event_id ||
    pending.prompt_correlation_id !== expected.prompt_correlation_id ||
    pending.predecessor_run_seq !== expected.predecessor_run_seq ||
    pending.provisional_run_seq !== expected.provisional_run_seq
  ) return false;
  delete store.claude_provisional_pending;
  return writeStore(correlationId, store, env);
}

function exactTurnRuns(store: RunStore, correlationId: string, turnCorrelationId: string): UserRun[] {
  return store.runs.filter(
    (run) =>
      run.session_correlation_id === correlationId &&
      run.turn_correlation_id === turnCorrelationId
  );
}

function sameRunIdentity(left: UserRun, right: UserRun): boolean {
  return (
    left.session_correlation_id === right.session_correlation_id &&
    left.turn_correlation_id === right.turn_correlation_id &&
    left.run_seq === right.run_seq &&
    left.started_at === right.started_at &&
    left.ended_at === right.ended_at
  );
}

/** Read the one strictly bound immutable retry record for an exact closed Codex turn. */
export function codexSettlementPending(
  correlationId: string,
  turnCorrelationId: string,
  env: ConfigDirEnv = process.env
): CodexSettlementPending | undefined {
  if (!validCorrelationId(correlationId) || !validCorrelationId(turnCorrelationId)) return undefined;
  const matches = exactTurnRuns(readStore(correlationId, env), correlationId, turnCorrelationId);
  if (matches.length !== 1 || !matches[0]?.ended_at) return undefined;
  return matches[0].codex_settlement_pending;
}

/**
 * Freeze the authoritative event before activity append. An already-valid record wins unchanged;
 * malformed, missing, ambiguous, open, or mismatched state cannot become retry authority.
 */
export function seedCodexSettlementPending(
  closedRun: UserRun,
  event: ActivityEvent,
  env: ConfigDirEnv = process.env
): CodexSettlementPending | undefined {
  const correlationId = closedRun.session_correlation_id;
  const turnCorrelationId = closedRun.turn_correlation_id;
  if (
    !validCorrelationId(correlationId) ||
    !validCorrelationId(turnCorrelationId) ||
    !closedRun.ended_at ||
    !validRunCore(closedRun, correlationId)
  ) return undefined;
  const store = readStore(correlationId, env);
  const matches = exactTurnRuns(store, correlationId, turnCorrelationId);
  if (matches.length !== 1 || !sameRunIdentity(matches[0], closedRun)) return undefined;
  const target = matches[0];
  if (target.codex_settlement_pending) return target.codex_settlement_pending;
  const pending: CodexSettlementPending = {
    schema: CODEX_SETTLEMENT_PENDING_SCHEMA,
    session_correlation_id: correlationId,
    turn_correlation_id: turnCorrelationId,
    run_seq: target.run_seq,
    run_started_at: target.started_at,
    run_ended_at: target.ended_at as string,
    event
  };
  if (!validPending(pending, target)) return undefined;
  target.codex_settlement_pending = pending;
  if (!writeStore(correlationId, store, env)) return undefined;
  return codexSettlementPending(correlationId, turnCorrelationId, env);
}

/** Clear only the exact turn's retry record after its matching event is known durable. */
export function clearCodexSettlementPending(
  correlationId: string,
  turnCorrelationId: string,
  env: ConfigDirEnv = process.env,
  expectedActivityEventId?: string
): boolean {
  if (!validCorrelationId(correlationId) || !validCorrelationId(turnCorrelationId)) return false;
  const store = readStore(correlationId, env);
  const matches = exactTurnRuns(store, correlationId, turnCorrelationId);
  if (matches.length !== 1) return false;
  const target = matches[0];
  if (
    expectedActivityEventId !== undefined &&
    target.codex_settlement_pending !== undefined &&
    target.codex_settlement_pending.event.activity_event_id !== expectedActivityEventId
  ) return false;
  delete target.codex_settlement_pending;
  return writeStore(correlationId, store, env);
}

/**
 * The run the status line should describe: the open run if the user's turn is still in flight, else
 * the most recently completed one, so the line SETTLES on the finished aggregate instead of reverting
 * to a per-call rendering the moment `Stop` fires.
 */
export function currentUserRun(correlationId: string, env: ConfigDirEnv = process.env): UserRun | undefined {
  if (!validCorrelationId(correlationId)) return undefined;
  const runs = readStore(correlationId, env).runs;
  return [...runs].reverse().find((r) => r.ended_at === undefined) ?? runs[runs.length - 1];
}

/**
 * The session's COMPLETED runs, newest first. The store retains only the last `RETAINED_RUNS`, so this
 * is bounded by construction; callers still take the first candidate they can use rather than walking
 * the history.
 *
 * WHY THIS EXISTS ALONGSIDE `currentUserRun`. Between `UserPromptSubmit` and the new run's first
 * receipt, the current run is open and EMPTY. `currentUserRun` names it correctly — it is the run now
 * accumulating — but it is not yet a run anything can describe, and a reader needs the previous
 * SETTLED run to hold a line steady across that gap instead of reverting to a per-call rendering.
 */
export function completedUserRuns(correlationId: string, env: ConfigDirEnv = process.env): UserRun[] {
  if (!validCorrelationId(correlationId)) return [];
  return readStore(correlationId, env)
    .runs.filter((r) => r.ended_at !== undefined)
    .reverse();
}

/**
 * The bounded, exact Codex run that owns one receipt, when known. Only Codex writes the optional
 * hashed turn identity; Claude and unscoped gateway traffic therefore remain outside this hold gate.
 * Used by live watch to withhold a micro-call until the later codex-stop aggregate is durable.
 */
export function codexUserRunForReceipt(
  receipt: { session_correlation_id?: string; captured_at?: string; request_started_at?: string },
  env: ConfigDirEnv = process.env
): UserRun | undefined {
  const correlationId = receipt.session_correlation_id;
  if (!validCorrelationId(correlationId)) return undefined;
  return [...readStore(correlationId, env).runs]
    .reverse()
    .find((run) => run.turn_correlation_id !== undefined && receiptBelongsToRun(receipt, run));
}

/** Does this receipt belong to this run? Both conjuncts required; no path is consulted. */
export function receiptBelongsToRun(
  receipt: { session_correlation_id?: string; captured_at?: string; request_started_at?: string },
  run: UserRun
): boolean {
  if (!validCorrelationId(receipt.session_correlation_id)) return false;
  const runCorrelation = (run as UserRun | null | undefined)?.session_correlation_id;
  if (!validCorrelationId(runCorrelation) || !validRunCore(run, runCorrelation)) return false;
  if (receipt.session_correlation_id !== run.session_correlation_id) return false;
  const at = receipt.request_started_at ?? receipt.captured_at;
  if (!canonicalTimestamp(at)) return false;
  if (at < run.started_at) return false;
  // An open run has no end: everything from `started_at` onward belongs to it. A closed run stops
  // accumulating, so a late background call is UNATTRIBUTED rather than folded into the next prompt.
  return run.ended_at === undefined || at <= run.ended_at;
}
