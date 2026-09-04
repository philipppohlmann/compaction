/**
 * Settled Codex Stop receipts. The host rollout is read locally and only through a bounded tail;
 * prompt, assistant, and tool content are discarded in memory and never enter Compaction storage.
 */
import { constants as fsConstants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import type { ActivityEvent } from "./activity-event.js";
import { computeActivityEventId } from "./activity-event.js";
import {
  appendActivityEvent,
  DEFAULT_ACTIVITY_DIRECTORY,
  readActivityEvents
} from "./activity-store.js";
import { buildOutputShapingPolicy } from "./output-shaping.js";
import {
  invalidateShapingTurnRecord,
  lastTurnShapingOutcome,
  type ShapingTurnScope
} from "./output-shaping-turn-state.js";
import {
  estimatePerTurnOutputSaved,
  loadOutputCalibrationResolver,
  type OutputCalibrationResolver
} from "./output-shaping-savings.js";
import { outputCalibrationQuery, type CalibrationState } from "./output-shaping-calibration-store.js";
import { readGatewayReceiptTailWindow, type GatewayReceipt, type GatewayReceiptTailWindow } from "./gateway/receipt.js";
import { aggregateRun } from "./gateway/run-aggregate.js";
import {
  clearCodexSettlementPending,
  codexSettlementPending,
  endUserRun,
  receiptBelongsToRun,
  seedCodexSettlementPending,
  startUserRun,
  type UserRun
} from "./gateway/run-boundary.js";
import {
  codexSessionCorrelationId,
  codexTurnCorrelationId,
  validCodexIdentity
} from "./gateway/session-correlation.js";
import { isReceiptLineEnabled } from "./gateway/receipt-line.js";
import {
  settledRunApplyPosture,
  settledRunOutputEstimate,
  settledStopLineFromActivityEvent
} from "./settled-stop-activity.js";

export const CODEX_ROLLOUT_TAIL_MAX_BYTES = 4 * 1024 * 1024;

interface CodexHookPayload {
  sessionId: string;
  turnId: string;
  cwd: string;
  transcriptPath?: string;
  model?: string;
}

export interface CodexTurnUsage {
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
}

function safePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 && !value.includes("\0");
}

function safeModel(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 160 && !/[\r\n]/.test(value);
}

/** Parse only the identity/location metadata common to Codex 0.153 prompt and Stop payloads. */
export function parseCodexHookPayload(raw: string): CodexHookPayload | undefined {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (!value || typeof value !== "object") return undefined;
    if (!validCodexIdentity(value.session_id) || !validCodexIdentity(value.turn_id) || !safePath(value.cwd)) {
      return undefined;
    }
    const transcriptPath = value.transcript_path;
    if (transcriptPath !== undefined && transcriptPath !== null && !safePath(transcriptPath)) return undefined;
    if (value.model !== undefined && !safeModel(value.model)) return undefined;
    return {
      sessionId: value.session_id,
      turnId: value.turn_id,
      cwd: value.cwd,
      ...(typeof transcriptPath === "string" ? { transcriptPath } : {}),
      ...(typeof value.model === "string" ? { model: value.model } : {})
    };
  } catch {
    return undefined;
  }
}

/** Validate and open the exact Codex UserPromptSubmit boundary. */
export function beginCodexTurn(
  rawPayload: string,
  env: NodeJS.ProcessEnv = process.env,
  now: () => Date = () => new Date()
): ShapingTurnScope | undefined {
  const payload = parseCodexHookPayload(rawPayload);
  if (!payload) return undefined;
  const sessionCorrelation = codexSessionCorrelationId(payload.sessionId, env);
  const turnCorrelation = codexTurnCorrelationId(payload.sessionId, payload.turnId, env);
  if (!sessionCorrelation || !turnCorrelation) return undefined;
  const run = startUserRun(sessionCorrelation, now().toISOString(), env, turnCorrelation);
  return run
    ? { tool: "codex", sessionId: payload.sessionId, turnId: payload.turnId }
    : undefined;
}

function parseUsage(value: unknown): CodexTurnUsage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const keys = [
    "input_tokens",
    "cached_input_tokens",
    "cache_write_input_tokens",
    "output_tokens",
    "reasoning_output_tokens",
    "total_tokens"
  ] as const;
  if (!keys.every((key) => Number.isSafeInteger(input[key]) && (input[key] as number) >= 0)) return undefined;
  return Object.fromEntries(keys.map((key) => [key, input[key]])) as unknown as CodexTurnUsage;
}

function sameUsage(a: CodexTurnUsage, b: CodexTurnUsage): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function cumulativeAfter(previous: CodexTurnUsage, next: CodexTurnUsage): boolean {
  return (
    next.input_tokens >= previous.input_tokens &&
    next.cached_input_tokens >= previous.cached_input_tokens &&
    next.cache_write_input_tokens >= previous.cache_write_input_tokens &&
    next.output_tokens >= previous.output_tokens &&
    next.reasoning_output_tokens >= previous.reasoning_output_tokens &&
    next.total_tokens >= previous.total_tokens
  );
}

/**
 * Read the final cumulative `turn_token_usage` for the exact Stop session+turn. The reader refuses
 * symlinks and non-regular files, never follows a replaced path, reads at most 4 MiB, and requires a
 * complete newline-terminated JSONL tail. `usage` and `thread_token_usage` are intentionally ignored.
 */
export async function readCodexTurnUsage(
  transcriptPath: string | undefined,
  sessionId: string,
  turnId: string,
  maxBytes: number = CODEX_ROLLOUT_TAIL_MAX_BYTES
): Promise<CodexTurnUsage | undefined> {
  if (!safePath(transcriptPath) || !validCodexIdentity(sessionId) || !validCodexIdentity(turnId)) return undefined;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const before = await lstat(transcriptPath);
    if (!before.isFile() || before.isSymbolicLink()) return undefined;
    const noFollow = "O_NOFOLLOW" in fsConstants ? fsConstants.O_NOFOLLOW : 0;
    handle = await open(transcriptPath, fsConstants.O_RDONLY | noFollow);
    const info = await handle.stat();
    if (!info.isFile() || info.dev !== before.dev || info.ino !== before.ino) return undefined;
    const bounded = Math.max(1, Math.min(CODEX_ROLLOUT_TAIL_MAX_BYTES, Math.trunc(maxBytes)));
    const length = Math.min(info.size, bounded);
    const start = info.size - length;
    const buffer = Buffer.alloc(length);
    if (length > 0) await handle.read(buffer, 0, length, start);
    let text = buffer.toString("utf8");
    if (text.length === 0 || !text.endsWith("\n")) return undefined;
    if (start > 0) {
      const firstNewline = text.indexOf("\n");
      if (firstNewline < 0) return undefined;
      text = text.slice(firstNewline + 1);
    }

    let selected: { ordinal: number; usage: CodexTurnUsage } | undefined;
    for (const line of text.split("\n")) {
      if (line === "") continue;
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return undefined;
      }
      if (!record || typeof record !== "object" || record.type !== "token_usage_record") continue;
      const payload = record.payload;
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) continue;
      const p = payload as Record<string, unknown>;
      if (p.session_id !== sessionId || p.turn_id !== turnId) continue;
      const ordinal = record.ordinal;
      const usage = parseUsage(p.turn_token_usage);
      if (!Number.isSafeInteger(ordinal) || (ordinal as number) < 0 || !usage) return undefined;
      if (selected) {
        if ((ordinal as number) < selected.ordinal || !cumulativeAfter(selected.usage, usage)) return undefined;
        if ((ordinal as number) === selected.ordinal && !sameUsage(selected.usage, usage)) return undefined;
      }
      selected = { ordinal: ordinal as number, usage };
    }
    return selected?.usage;
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function incompleteWindow(
  window: GatewayReceiptTailWindow,
  run: UserRun,
  exactReceipts: readonly GatewayReceipt[]
): boolean {
  if (!window.truncated) return false;
  // Only an exact correlated run candidate may prove that a truncated tail reaches the run start.
  // A request from another session may have started hours earlier but completed/appended after this
  // run began; its request_started_at proves nothing about exact-run receipts cut off by the byte tail.
  const firstExactStart = exactReceipts.reduce<string | undefined>((earliest, receipt) => {
    const at = receipt.request_started_at ?? receipt.captured_at;
    return typeof at === "string" && (earliest === undefined || at < earliest) ? at : earliest;
  }, undefined);
  if (firstExactStart === undefined) return true;
  const firstExactMs = Date.parse(firstExactStart);
  const runStartedMs = Date.parse(run.started_at);
  return !Number.isFinite(firstExactMs) || !Number.isFinite(runStartedMs) || firstExactMs > runStartedMs;
}

function receiptHasCompatibleInputPair(receipt: GatewayReceipt): boolean {
  const before = receipt.estimated_input_tokens_before;
  const after = receipt.estimated_input_tokens_after;
  const claimsCompaction = receipt.applied_components?.some(
    (component) => component === "lcm-compaction" || component === "deterministic-compaction"
  ) === true;
  return (
    typeof before === "number" &&
    typeof after === "number" &&
    !(claimsCompaction && before === after)
  );
}

function receiptHasInputEvidence(receipt: GatewayReceipt): boolean {
  return receiptHasCompatibleInputPair(receipt) || typeof receipt.tokens?.prompt_input === "number";
}

/** The one renderer used by Codex Stop and `watch` for a persisted settled event. */
export function codexStopLineFromActivityEvent(event: ActivityEvent): string | undefined {
  return event.activity_kind === "codex-stop" ? settledStopLineFromActivityEvent(event) : undefined;
}

export interface SettleCodexStopDeps {
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  endRun?: typeof endUserRun;
  appendEvent?: typeof appendActivityEvent;
  readEvents?: typeof readActivityEvents;
  clearPending?: typeof clearCodexSettlementPending;
  readReceipts?: (cwd: string) => Promise<GatewayReceiptTailWindow>;
  readTurnUsage?: typeof readCodexTurnUsage;
  calibrationResolver?: OutputCalibrationResolver;
}

export interface SettledCodexStop {
  event: ActivityEvent;
  line?: string;
}

function exactReceiptQuery(receipts: GatewayReceipt[]): ReturnType<typeof outputCalibrationQuery> {
  const queries = receipts
    .filter((receipt) => receipt.output_shaping_state === "attached-this-pass" || receipt.output_shaping_state === "already-active")
    .map((receipt) => outputCalibrationQuery({
      policyVersion: receipt.output_shaping_policy_version,
      provider: receipt.provider,
      model: receipt.model,
      regime: receipt.output_shaping_regime
    }));
  if (queries.length === 0 || queries.some((query) => query === undefined)) return undefined;
  const first = JSON.stringify(queries[0]);
  return queries.every((query) => JSON.stringify(query) === first) ? queries[0] : undefined;
}

/** Close, settle, persist, and render one exact Codex turn. Total and local-only. */
export async function settleCodexStop(
  rawPayload: string,
  deps: SettleCodexStopDeps = {}
): Promise<SettledCodexStop | undefined> {
  const payload = parseCodexHookPayload(rawPayload);
  if (!payload) return undefined;
  const env = deps.env ?? process.env;
  const sessionCorrelation = codexSessionCorrelationId(payload.sessionId, env);
  const turnCorrelation = codexTurnCorrelationId(payload.sessionId, payload.turnId, env);
  if (!sessionCorrelation || !turnCorrelation) return undefined;
  const scope: ShapingTurnScope = { tool: "codex", sessionId: payload.sessionId, turnId: payload.turnId };
  const directory = join(payload.cwd, DEFAULT_ACTIVITY_DIRECTORY);
  const runId = `codex-stop-${turnCorrelation}`;
  const readEvents = deps.readEvents ?? readActivityEvents;
  const appendEvent = deps.appendEvent ?? appendActivityEvent;
  const clearPending = deps.clearPending ?? clearCodexSettlementPending;
  const durableEvent = async (): Promise<{ readable: true; event?: ActivityEvent } | { readable: false }> => {
    try {
      return {
        readable: true,
        event: (await readEvents(directory)).events.find(
          (event) => event.activity_kind === "codex-stop" && event.run_id === runId
        )
      };
    } catch {
      return { readable: false };
    }
  };
  const settledFromDurable = async (event: ActivityEvent): Promise<SettledCodexStop> => {
    try {
      clearPending(sessionCorrelation, turnCorrelation, env, event.activity_event_id);
    } catch {
      // The event is authoritative; replay will retry bounded-store cleanup.
    }
    await invalidateShapingTurnRecord(scope, env);
    return { event, ...(isReceiptLineEnabled(env) ? { line: settledStopLineFromActivityEvent(event) } : {}) };
  };
  const persistFrozen = async (event: ActivityEvent): Promise<SettledCodexStop | undefined> => {
    try {
      const append = await appendEvent(event, directory);
      if (append.appended) return settledFromDurable(event);
      const raced = await durableEvent();
      return raced.readable && raced.event ? settledFromDurable(raced.event) : undefined;
    } catch {
      return undefined;
    }
  };

  const existing = await durableEvent();
  if (existing.readable && existing.event) {
    return settledFromDurable(existing.event);
  }

  // Once a run is closed, this immutable record is the sole retry authority. Sources, receipts,
  // calibration, and shaping state are never consulted again, so a retry cannot change the result.
  const pending = codexSettlementPending(sessionCorrelation, turnCorrelation, env);
  if (pending) {
    await invalidateShapingTurnRecord(scope, env);
    if (!existing.readable) return undefined;
    return persistFrozen(pending.event);
  }

  let stoppedAt: string;
  try {
    stoppedAt = (deps.now ?? (() => new Date()))().toISOString();
  } catch {
    await invalidateShapingTurnRecord(scope, env);
    return undefined;
  }
  // Read exact provenance before closing. A concurrent replay that observes the closed run cannot
  // delete the only copy before this first writer has frozen it into the pending event.
  const shapingOutcome = await lastTurnShapingOutcome(scope, env);
  let run: UserRun | undefined;
  try {
    run = (deps.endRun ?? endUserRun)(sessionCorrelation, stoppedAt, env, turnCorrelation);
  } catch {
    try {
      clearPending(sessionCorrelation, turnCorrelation, env);
    } catch {
      // Malformed/unavailable bounded state remains non-authoritative.
    }
    await invalidateShapingTurnRecord(scope, env);
    return undefined;
  }
  if (!run) {
    try {
      clearPending(sessionCorrelation, turnCorrelation, env);
    } catch {
      // A closed run without a valid pending event is terminal and never resurrected.
    }
    await invalidateShapingTurnRecord(scope, env);
    return undefined;
  }

  try {
    const readReceipts = deps.readReceipts ?? ((cwd: string) => readGatewayReceiptTailWindow(cwd));
    const window = await readReceipts(payload.cwd);
    const exactReceipts = window.receipts.filter((receipt) => receiptBelongsToRun(receipt, run));
    const resolver = deps.calibrationResolver ?? await loadOutputCalibrationResolver(env);
    const aggregate = exactReceipts.length > 0 && !incompleteWindow(window, run, exactReceipts)
      ? aggregateRun(exactReceipts, { outputCalibrationResolver: resolver })
      : undefined;
    const gatewayUsable =
      aggregate?.input !== undefined &&
      aggregate.output !== undefined &&
      exactReceipts.every(receiptHasInputEvidence);
    const rolloutUsage = gatewayUsable
      ? undefined
      : await (deps.readTurnUsage ?? readCodexTurnUsage)(
          payload.transcriptPath,
          payload.sessionId,
          payload.turnId
        );
    if (!gatewayUsable && !rolloutUsage) return undefined;

    const outputAfter = gatewayUsable ? aggregate.output?.after : rolloutUsage?.output_tokens;
    const inputBefore = gatewayUsable ? aggregate.input?.before : rolloutUsage?.input_tokens;
    const inputAfter = gatewayUsable ? aggregate.input?.after : undefined;
    const hookShaped = shapingOutcome === "shape" || shapingOutcome === "shape-basic";
    const gatewayShaped = (aggregate?.shapedCallCount ?? 0) > 0;
    const shapingActive = hookShaped || gatewayShaped;
    const hookPolicy = hookShaped ? buildOutputShapingPolicy().policyVersion : undefined;
    const hookQuery = hookShaped
      ? outputCalibrationQuery({
          policyVersion: hookPolicy,
          provider: "openai",
          model: payload.model,
          ...(shapingOutcome === "shape" ? { regime: "default-shapeable" } : {})
        })
      : undefined;
    const gatewayQuery = exactReceiptQuery(exactReceipts);
    const query = gatewayShaped ? gatewayQuery : hookQuery;
    const estimate = gatewayShaped && aggregate
      ? settledRunOutputEstimate(aggregate, exactReceipts, resolver)
      : hookShaped
        ? estimatePerTurnOutputSaved(
            hookQuery
              ? resolver(hookQuery)
              : { availability: "unavailable", reason: "no exact calibration key", state: "unseeded" },
            outputAfter
          )
        : undefined;
    const estimateState: CalibrationState | undefined = estimate?.state;
    const inputReduced =
      typeof inputBefore === "number" && typeof inputAfter === "number" && inputAfter < inputBefore;
    const gatewayInputUsesEstimate = exactReceipts.some(
      receiptHasCompatibleInputPair
    );
    const receiptPosture = aggregate ? settledRunApplyPosture(exactReceipts, aggregate) : undefined;
    const eventBase: ActivityEvent = {
      surface: "codex",
      provider: "openai",
      ...(payload.model ? { model_label: payload.model } : {}),
      workflow_id: "codex-stop",
      session_id: `codex-session-${sessionCorrelation}`,
      run_id: runId,
      ...(typeof inputBefore === "number" ? { input_before: inputBefore } : {}),
      ...(inputReduced ? { input_after: inputAfter } : {}),
      ...(typeof outputAfter === "number" ? { output_after: outputAfter } : {}),
      token_source: {
        input: { source: gatewayUsable && gatewayInputUsesEstimate ? "local-estimate" : "provider-reported" },
        output: { source: "provider-reported" }
      },
      ...(shapingActive && (query?.policyVersion ?? hookPolicy)
        ? { policy_used: query?.policyVersion ?? hookPolicy }
        : {}),
      claim_scope: "run-scoped",
      evidence_level: gatewayUsable
        ? "exact correlated gateway run"
        : "provider-reported cumulative Codex turn usage",
      approval_status: "not-required",
      recovery: { original_retained: false },
      sync_status: "local-only",
      activity_kind: "codex-stop",
      recorded_at: stoppedAt,
      run_started_at: run.started_at,
      measurement_source: gatewayUsable ? "gateway-run" : "codex-rollout",
      ...(shapingActive ? { output_shaping_state: "active" } : {}),
      ...(estimate?.calibrated === true && estimate.tokensSaved && estimate.basis === "measured"
        ? {
            estimated_output_tokens_saved: estimate.tokensSaved,
            output_estimate_basis: "measured",
            output_estimate_state: "calibrated"
          }
        : estimateState
          ? { output_estimate_state: estimateState }
          : {}),
      ...(receiptPosture
        ? { apply_posture: receiptPosture }
        : hookShaped && !inputReduced
          ? { apply_posture: "basic" }
          : {})
    };
    const event: ActivityEvent = { ...eventBase, activity_event_id: computeActivityEventId(eventBase) };
    const frozen = seedCodexSettlementPending(run, event, env);
    if (!frozen) return undefined;
    // The immutable pending event now carries all shaping provenance needed for retry.
    await invalidateShapingTurnRecord(scope, env);
    if (!existing.readable) return undefined;
    return persistFrozen(frozen.event);
  } catch {
    return undefined;
  } finally {
    // A newly closed run without a pending event cannot be recovered and must not retain per-turn
    // shaping state. When seeding succeeded, the same cleanup is safe because provenance is frozen.
    await invalidateShapingTurnRecord(scope, env);
  }
}
