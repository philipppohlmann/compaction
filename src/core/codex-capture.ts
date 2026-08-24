/**
 * Codex live-wrapper capture (PUBLIC CLI/SDK code, engine-free, ships in the npm package).
 *
 * Wraps a real `codex exec --json` run (near-live, no manual export) and normalizes its JSONL event
 * stream to an `AgentTrace`.
 *
 * Token honesty: `codex exec --json` emits a `turn.completed` event carrying a provider `usage` block
 * ({input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens}). When present, those are
 * recorded as **provider-reported** (NOT estimates). When absent, usage is left missing, never invented.
 *
 * Content-free posture: this reads the captured stdout to build the trace LOCALLY; only counts +
 * estimate/provider labels flow into any downstream record. The captured stream may contain code/output,
 * so the produced artifact carries the same "review before sharing" caution as other captures.
 *
 * Evidence tier: a wrapped command is `source: "local_command"`, the same `imported_local` tier as the
 * import path (below `real_captured`); the hosted record attributes `tool: "codex"` / `provider: "openai"`.
 */
import { CURRENT_AGENT_TRACE_ARTIFACT_VERSION } from "./trace-parser.js";
import { createUsageMetadata, missingUsageMetadata, type UsageMetadata } from "./usage-metadata.js";
import type { AgentTrace, TraceMessage } from "./types.js";
import { executeLocalCommand, parseRunCommand, type LocalCommandRun } from "./command-runner.js";

const CODEX_PROVIDER = "openai";

/**
 * Placeholder used when the captured event stream carried NO model field, an honest unknown
 * marker, never a real model id. Exported so downstream writers (e.g. the cross-surface event on
 * the local run record) can map it to their canonical "unknown" instead of presenting a
 * placeholder as if it were a reported model.
 */
export const CODEX_UNKNOWN_MODEL = "codex-unknown-model";

/* ---------------- small local helpers (no engine import) ---------------- */
function toRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}
function numericValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

interface ParsedEvent {
  value: Record<string, unknown>;
  lineNumber: number;
}

/** Parse a `codex exec --json` JSONL stream into event records (one object per line). */
export function parseCodexEvents(rawOutput: string): ParsedEvent[] {
  return rawOutput
    .split(/\r?\n/)
    .map((line, index) => ({ line: line.trim(), lineNumber: index + 1 }))
    .filter(({ line }) => line.startsWith("{") && line.endsWith("}"))
    .flatMap(({ line, lineNumber }) => {
      try {
        const record = toRecord(JSON.parse(line));
        return record ? [{ value: record, lineNumber }] : [];
      } catch {
        return [];
      }
    });
}

export interface CodexNormalizationResult {
  trace: AgentTrace;
  usageMetadata: UsageMetadata;
  eventsCaptured: number;
  messagesCaptured: number;
  toolOutputsCaptured: number;
  /** "present" when a turn.completed.usage block was found, else "missing" (never invented). */
  tokenMetadataStatus: "present" | "missing";
  warnings: string[];
}

function addMessage(
  messages: TraceMessage[],
  role: TraceMessage["role"],
  content: string,
  timestamp: string,
  metadata: Record<string, unknown>,
  name?: string
): void {
  messages.push({
    id: `codex_msg_${messages.length + 1}`,
    role,
    content,
    timestamp,
    ...(name ? { toolName: name } : {}),
    metadata
  });
}

/** Build an `AgentTrace` + provider-reported usage from a captured `codex exec --json` stream. */
export function normalizeCodexExecEvents(params: {
  captureId: string;
  rawOutput: string;
  commandRun?: LocalCommandRun;
  generatedAt?: string;
}): CodexNormalizationResult {
  const generatedAt = params.generatedAt ?? new Date().toISOString();
  const startedAt = params.commandRun?.startedAt ?? generatedAt;
  const events = parseCodexEvents(params.rawOutput);
  const warnings: string[] = [];
  const messages: TraceMessage[] = [];
  let toolOutputsCaptured = 0;
  let threadId: string | undefined;
  let model: string | undefined;

  addMessage(messages, "system", "Codex exec capture (live command wrapper).", startedAt, {
    integration: "codex",
    captureMode: "command wrapper"
  });

  // Provider-reported usage is summed across turn.completed events; never invented.
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let reasoningOutputTokens = 0;
  let sawUsage = false;

  for (const { value, lineNumber } of events) {
    const type = stringValue(value.type) ?? "event";
    threadId = threadId ?? stringValue(value.thread_id);
    model = model ?? stringValue(value.model) ?? stringValue(toRecord(value.item)?.model);

    if (type === "item.completed" || type === "item.started") {
      const item = toRecord(value.item);
      if (!item) continue;
      const itemType = stringValue(item.type);
      const ts = stringValue(value.timestamp) ?? startedAt;
      if (itemType === "agent_message" && type === "item.completed") {
        // Primary key is the vendor field (`text`); `content` is a fallback so the committed
        // SYNTHETIC demo fixture (src/examples/codex-exec-demo.jsonl) is consumable too. Real
        // `codex exec --json` exports carry `text`, so the fallback never changes their parsing.
        const text = stringValue(item.text) ?? stringValue(item.content);
        if (text) addMessage(messages, "assistant", text, ts, { sourceLine: lineNumber, eventType: itemType });
      } else if (itemType === "command_execution") {
        const command = stringValue(item.command);
        if (command && type === "item.started") {
          addMessage(messages, "assistant", `Tool call: ${command}`, ts, { sourceLine: lineNumber, eventType: "tool_call" });
        }
        // `aggregated_output` is the vendor field; `stdout` is a fixture-compat fallback (same
        // rationale as above - never consulted when the vendor field is present).
        const output = stringValue(item.aggregated_output) ?? stringValue(item.output) ?? stringValue(item.stdout);
        if (output && type === "item.completed") {
          addMessage(messages, "tool", output, ts, { sourceLine: lineNumber, eventType: "tool_output" }, command ?? "codex.command");
          toolOutputsCaptured += 1;
        }
      }
    } else if (type === "turn.completed") {
      const usage = toRecord(value.usage);
      if (usage) {
        const i = numericValue(usage.input_tokens);
        const o = numericValue(usage.output_tokens);
        const c = numericValue(usage.cached_input_tokens);
        const r = numericValue(usage.reasoning_output_tokens);
        if (i !== undefined || o !== undefined) sawUsage = true;
        inputTokens += i ?? 0;
        outputTokens += o ?? 0;
        cachedInputTokens += c ?? 0;
        reasoningOutputTokens += r ?? 0;
      }
    }
  }

  if (events.length === 0) warnings.push("No codex exec --json events were found in the captured output.");
  if (!sawUsage) warnings.push("No turn.completed.usage block was found; provider token usage is missing and was not invented.");

  const resolvedModel = model ?? CODEX_UNKNOWN_MODEL;
  const usageMetadata: UsageMetadata = sawUsage
    ? createUsageMetadata({
        inputTokens,
        outputTokens,
        // reasoning tokens are part of the output charge; surface in total, not double-counted as output.
        totalTokens: inputTokens + outputTokens + reasoningOutputTokens,
        cacheReadInputTokens: cachedInputTokens,
        providerReportedTokens: true,
        estimatedTokens: false,
        model: resolvedModel,
        provider: CODEX_PROVIDER,
        limitations: [
          "Provider-reported token usage from codex exec --json turn.completed.usage - NOT billing-confirmed.",
          ...(reasoningOutputTokens > 0 ? ["Reasoning output tokens are included in the total; they are part of the output charge."] : [])
        ]
      })
    : missingUsageMetadata({
        model: resolvedModel,
        provider: CODEX_PROVIDER,
        limitations: ["Captured codex exec events carried no usage block; token usage is missing and was not invented."]
      });

  const trace: AgentTrace = {
    id: threadId ?? `trace_codex_${params.captureId}`,
    title: "Codex exec captured trace",
    artifactVersion: CURRENT_AGENT_TRACE_ARTIFACT_VERSION,
    source: "local_command",
    createdAt: startedAt,
    generatedAt,
    model: resolvedModel,
    command: params.commandRun
      ? { command: params.commandRun.command.executable, args: params.commandRun.command.args, cwd: process.cwd() }
      : { command: "codex-export", args: [], cwd: process.cwd() },
    durationMs: params.commandRun?.durationMs ?? 0,
    exitCode: params.commandRun?.exitCode ?? 0,
    messages
  };

  return {
    trace,
    usageMetadata,
    eventsCaptured: events.length,
    messagesCaptured: messages.filter((m) => ["system", "user", "assistant"].includes(m.role)).length,
    toolOutputsCaptured,
    tokenMetadataStatus: sawUsage ? "present" : "missing",
    warnings
  };
}

export interface CodexCaptureResult extends CodexNormalizationResult {
  commandRun?: LocalCommandRun;
}

/**
 * Live wrapper: spawn `codex exec --json …` (no manual export), capture its stdout, normalize.
 * The command parts are the FULL command (e.g. ["codex","exec","--json","do the thing"]). No engine,
 * no upload. A non-zero Codex exit is preserved on the trace; capture still returns what was produced.
 */
export async function captureCodexCommand(commandParts: string[], generatedAt?: string): Promise<CodexCaptureResult> {
  const parsed = parseRunCommand(commandParts);
  const commandRun = await executeLocalCommand(parsed);
  const result = normalizeCodexExecEvents({
    captureId: `${parsed.executable}-${commandRun.startedAt}`,
    rawOutput: commandRun.rawOutput,
    commandRun,
    generatedAt
  });
  return { ...result, commandRun };
}

/** Offline/fallback: normalize a previously-saved `codex exec --json` JSONL export file's contents. */
export function captureCodexExport(rawOutput: string, generatedAt?: string): CodexCaptureResult {
  return normalizeCodexExecEvents({ captureId: "codex-export", rawOutput, generatedAt });
}
