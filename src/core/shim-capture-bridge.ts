/**
 * Shim → metrics-only activity bridge (public CLI/SDK code, engine-free, ships in the npm package).
 *
 * Same shape as the from-hook → activity bridge (`appendClaudeCodeHookActivity` in
 * `src/cli/commands/capture-claude-code.ts`), for the Codex/Cursor PATH shims: parse content-free
 * usage → build the honest per-field token report → build the cross-surface event → wrap as a
 * measure-only activity event → append one line to the local activity store. This is what makes a
 * `codex exec --json` / `cursor-agent … --output-format json` run appear in `compaction activity`
 * with no manual import.
 *
 * Invariants (same rails as the reused parsers/validators):
 * - Codex: provider-reported tokens from `turn.completed.usage` when present, else
 *   unavailable-with-reason, never invented, never a silent zero.
 * - Cursor: local-estimate only (chars/4); never provider-reported; output unavailable-with-reason
 *   when the `result` field is not separable. The cross-surface tier table structurally rejects a
 *   provider-reported label on the `cursor` surface.
 * - Content-free: only token counts + honest source labels + opaque ids ride on the event. No
 *   prompt/response/message text is ever read into the event (the raw output is parsed for usage
 *   fields only, and for Cursor the prompt is counted, never stored).
 * - Measurement only: approval "not-required", auto-apply off (not eligible, ask-each-time,
 *   applied_automatically false), recovery original_retained=false, sync "local-only".
 * - Deterministic id → the store dedupes a re-parse of the same run (same state = one event).
 */
import { createHash } from "node:crypto";
import path from "node:path";
import { normalizeCodexExecEvents, CODEX_UNKNOWN_MODEL } from "./codex-capture.js";
import { normalizeCursorAgentOutput } from "./cursor-capture.js";
import { buildRunFlowTokenReport } from "./run-flow-report.js";
import { buildRunCrossSurfaceEvent } from "./cross-surface-event.js";
import { buildMeasureOnlyActivityEvent } from "./activity-event.js";
import { appendActivityEvent, DEFAULT_ACTIVITY_DIRECTORY, type AppendActivityEventResult } from "./activity-store.js";

/** A content-free, deterministic run id from opaque ids + token counts (never any content). */
function contentFreeRunId(prefix: string, parts: Array<string | number | undefined>): string {
  const digest = createHash("sha256").update(parts.map((p) => String(p ?? "")).join("|")).digest("hex");
  return `${prefix}-${digest.slice(0, 16)}`;
}

/** The activity directory under a given cwd (mirrors the from-hook bridge: cwd-scoped). */
function activityDirFor(cwd?: string): string {
  return cwd ? path.join(cwd, ".compaction", "activity") : DEFAULT_ACTIVITY_DIRECTORY;
}

const CODEX_MISSING_USAGE_REASON =
  "the captured codex exec output carried no turn.completed.usage block (provider usage unavailable - not invented)";

export interface CodexShimBridgeResult {
  result: AppendActivityEventResult;
  /** "present" when a turn.completed.usage block was found (provider-reported), else "missing". */
  tokenMetadataStatus: "present" | "missing";
}

/**
 * Bridge a captured `codex exec --json` output copy into ONE metrics-only activity event.
 * `surface: "codex"`, `provider: "openai"`; provider-reported tokens where usage existed, else
 * unavailable-with-reason. Content-free + best-effort: a local failure is returned as an unappended
 * result, never thrown, so it can never break the transparent shim.
 */
export async function bridgeCodexShimActivity(input: { rawOutput: string; cwd?: string }): Promise<CodexShimBridgeResult> {
  const norm = normalizeCodexExecEvents({ captureId: "shim", rawOutput: input.rawOutput });
  const usage = norm.usageMetadata;
  const present = norm.tokenMetadataStatus === "present";
  const tokenReport = buildRunFlowTokenReport({ tool: "codex", usage, outputStatus: present ? "present" : "unavailable" });
  const threadId = norm.trace.id && !norm.trace.id.startsWith("trace_codex_") ? norm.trace.id : undefined;
  const runId = contentFreeRunId("codex-shim", [threadId, usage.input_tokens, usage.output_tokens, usage.cache_read_input_tokens]);
  const event = buildRunCrossSurfaceEvent("codex", {
    runId,
    tokenReport,
    reasons: present ? {} : { input: CODEX_MISSING_USAGE_REASON, output: CODEX_MISSING_USAGE_REASON },
    ...(usage.model && usage.model !== CODEX_UNKNOWN_MODEL ? { modelLabel: usage.model } : {})
  });
  const eventWithSession = threadId ? { ...event, session_id: threadId } : event;
  const activityEvent = buildMeasureOnlyActivityEvent(eventWithSession, { original_retained: false });
  const result = await appendActivityEvent(activityEvent, activityDirFor(input.cwd));
  return { result, tokenMetadataStatus: norm.tokenMetadataStatus };
}

export interface CursorShimBridgeResult {
  result: AppendActivityEventResult;
  inputStatus: "present" | "unavailable";
  outputStatus: "present" | "unavailable";
}

/**
 * Bridge a captured Cursor headless output copy into ONE metrics-only activity event.
 * `surface: "cursor"`, `provider: "cursor"`; LOCAL-ESTIMATE only (NEVER provider-reported), output
 * unavailable-with-reason when the result is not separable. `commandParts` (the ORIGINAL invocation)
 * lets input be locally estimated from the prompt (counted, never stored). Content-free, best-effort.
 */
export async function bridgeCursorShimActivity(input: {
  rawOutput: string;
  commandParts?: string[];
  cwd?: string;
}): Promise<CursorShimBridgeResult> {
  const norm = normalizeCursorAgentOutput({ captureId: "shim", rawOutput: input.rawOutput, commandParts: input.commandParts });
  const usage = norm.usageMetadata;
  const tokenReport = buildRunFlowTokenReport({ tool: "cursor", usage, outputStatus: norm.outputStatus });
  const sessionId = norm.trace.id && !norm.trace.id.startsWith("trace_cursor_") ? norm.trace.id : undefined;
  const runId = contentFreeRunId("cursor-shim", [sessionId, usage.input_tokens, usage.output_tokens]);
  const event = buildRunCrossSurfaceEvent("cursor", {
    runId,
    tokenReport,
    reasons: { input: norm.inputUnavailableReason, output: norm.outputUnavailableReason }
  });
  const eventWithSession = sessionId ? { ...event, session_id: sessionId } : event;
  const activityEvent = buildMeasureOnlyActivityEvent(eventWithSession, { original_retained: false });
  const result = await appendActivityEvent(activityEvent, activityDirFor(input.cwd));
  return { result, inputStatus: norm.inputStatus, outputStatus: norm.outputStatus };
}
