/**
 * Cursor live-wrapper capture (PUBLIC CLI/SDK code, engine-free, ships in the npm package).
 *
 * Wraps a real Cursor **headless CLI agent** run (e.g. `cursor agent -p "<prompt>" --output-format
 * json`) and normalizes its output to an `AgentTrace`.
 *
 * HONESTY (the defining rails of this module):
 * - **NO provider-reported tokens.** Cursor's CLI emits no usage; tokens here are **LOCAL-ESTIMATE
 *   only** (chars/4), never provider-reported, never billing-confirmed.
 * - **Input** is locally estimated from the prompt extracted from the wrapped invocation (where
 *   available). **Output** is locally estimated from the headless **`result`** field when the output
 *   can be safely separated (`--output-format json`); when it cannot, output is **UNAVAILABLE** (left
 *   absent, with a stated reason), never silently zero, never fabricated.
 * - **NO output-token savings** (that is gated on the output-shaping policy family + eval).
 * - **NO SQLite / private-storage reverse engineering.** Only the wrapped CLI's own stdout is read.
 *
 * Evidence tier: `source: "local_command"` (the same `imported_local` tier as the import path; below
 * `real_captured`). The cross-tool record attributes `tool: "cursor"`, `token_source: local-estimate`.
 */
import { CURRENT_AGENT_TRACE_ARTIFACT_VERSION } from "./trace-parser.js";
import { createUsageMetadata, type UsageMetadata } from "./usage-metadata.js";
import { estimateTextTokens } from "./token-estimator.js";
import type { AgentTrace, TraceMessage } from "./types.js";
import { executeLocalCommand, parseRunCommand, type LocalCommandRun } from "./command-runner.js";

function toRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/**
 * Extract the assistant `result` text + session id from Cursor headless output. Supports the single
 * JSON object (`--output-format json`) and a stream-json stream (scans lines for a `result` object).
 * Returns `outputSeparable: false` when no `result` field can be safely isolated.
 */
export function parseCursorAgentOutput(rawOutput: string): {
  resultText?: string;
  sessionId?: string;
  outputSeparable: boolean;
} {
  // A saved export may carry a UTF-8 BOM (e.g. written on Windows). Strip it so a real, parseable
  // `result` object is not silently mislabeled "unavailable", the label must match the evidence.
  const trimmed = rawOutput.replace(/^\uFEFF/, "").trim();
  // Case 1: a single JSON result object.
  const whole = (() => {
    try {
      return toRecord(JSON.parse(trimmed));
    } catch {
      return null;
    }
  })();
  if (whole) {
    const resultText = stringValue(whole.result);
    return { resultText, sessionId: stringValue(whole.session_id), outputSeparable: resultText !== undefined };
  }
  // Case 2: stream-json, scan lines for a `result` object (last one wins) + a session id.
  let resultText: string | undefined;
  let sessionId: string | undefined;
  for (const line of trimmed.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith("{") || !t.endsWith("}")) continue;
    let rec: Record<string, unknown> | null;
    try {
      rec = toRecord(JSON.parse(t));
    } catch {
      continue;
    }
    if (!rec) continue;
    sessionId = sessionId ?? stringValue(rec.session_id);
    const r = stringValue(rec.result);
    if (r !== undefined) resultText = r;
  }
  return { resultText, sessionId, outputSeparable: resultText !== undefined };
}

/**
 * Best-effort prompt extraction from the wrapped Cursor invocation: the non-flag positional args,
 * excluding the executable + known subcommand keywords. Used ONLY for a local-estimate of input tokens
 * (content-free count of text WE passed). Returns undefined when no prompt can be identified.
 */
export function extractCursorPrompt(commandParts: string[]): string | undefined {
  const KEYWORDS = new Set(["cursor", "cursor-agent", "agent", "chat", "exec", "run"]);
  // Boolean flags take no value, so the token after them is still a positional (e.g. the prompt).
  // (Cursor selects machine output via `--output-format json`, a value-taking flag, handled below -
  // so a bare `--json` boolean is intentionally NOT assumed here.)
  const BOOLEAN_FLAGS = new Set(["-p", "--print", "--force"]);
  const positionals: string[] = [];
  let skipNext = false;
  for (let i = 1; i < commandParts.length; i++) {
    const part = commandParts[i];
    if (skipNext) {
      skipNext = false; // the value of a preceding value-taking flag (e.g. `--output-format json`)
      continue;
    }
    if (part.startsWith("-")) {
      if (!BOOLEAN_FLAGS.has(part) && !part.includes("=")) skipNext = true;
      continue;
    }
    if (KEYWORDS.has(part)) continue;
    positionals.push(part);
  }
  const prompt = positionals.join(" ").trim();
  return prompt === "" ? undefined : prompt;
}

export interface CursorNormalizationResult {
  trace: AgentTrace;
  usageMetadata: UsageMetadata;
  /** "present" when a prompt was identified (input locally estimated from it), else "unavailable". */
  inputStatus: "present" | "unavailable";
  /**
   * The TRUE reason input is unavailable (set iff `inputStatus === "unavailable"`). Export-only runs
   * (no invocation declared) get a DIFFERENT reason from declared-but-unidentifiable invocations, so the
   * operator is never told "no prompt in the wrapped invocation" when there was no wrapped invocation.
   */
  inputUnavailableReason?: string;
  /** "present" when the result field was separable (output estimated), else "unavailable". */
  outputStatus: "present" | "unavailable";
  /**
   * The TRUE reason output is unavailable (set iff `outputStatus === "unavailable"`), so callers print
   * the honest reason (e.g. "the captured output is empty"), never a hardcoded, possibly-wrong one.
   */
  outputUnavailableReason?: string;
  warnings: string[];
}

function addMessage(messages: TraceMessage[], role: TraceMessage["role"], content: string, timestamp: string, metadata: Record<string, unknown>): void {
  messages.push({ id: `cursor_msg_${messages.length + 1}`, role, content, timestamp, metadata });
}

const CURSOR_LOCAL_ESTIMATE_NOTE =
  "Cursor CLI emits no provider usage; tokens are LOCAL-ESTIMATE only (chars/4) - never provider-reported, never billing-confirmed.";

/** Build an `AgentTrace` + LOCAL-ESTIMATE usage from captured Cursor headless output. */
export function normalizeCursorAgentOutput(params: {
  captureId: string;
  rawOutput: string;
  commandParts?: string[];
  commandRun?: LocalCommandRun;
  generatedAt?: string;
}): CursorNormalizationResult {
  const generatedAt = params.generatedAt ?? new Date().toISOString();
  const startedAt = params.commandRun?.startedAt ?? generatedAt;
  const { resultText, sessionId, outputSeparable } = parseCursorAgentOutput(params.rawOutput);
  const prompt = params.commandParts ? extractCursorPrompt(params.commandParts) : undefined;
  const warnings: string[] = [];
  const messages: TraceMessage[] = [];

  addMessage(messages, "system", "Cursor headless CLI capture (command wrapper).", startedAt, {
    integration: "cursor",
    captureMode: "command wrapper"
  });
  if (prompt) addMessage(messages, "user", prompt, startedAt, { eventType: "prompt", tokenSource: "local-estimate" });
  if (resultText) addMessage(messages, "assistant", resultText, generatedAt, { eventType: "result", tokenSource: "local-estimate" });

  // Input: local-estimate from the prompt where available. Output: local-estimate from the separable
  // result field, else UNAVAILABLE (absent + a stated reason). Never provider-reported, never fabricated.
  const inputTokens = prompt ? estimateTextTokens(prompt) : undefined;
  const outputTokens = resultText ? estimateTextTokens(resultText) : undefined;

  // The TRUE per-run unavailability reason: an EMPTY export/captured output is a different failure from
  // present-but-not-separable output, and the guidance differs (`--output-format json` cannot fix an
  // empty file). Stated exactly so the operator is never sent down the wrong path.
  const outputUnavailableReason = outputSeparable
    ? undefined
    : params.rawOutput.trim() === ""
      ? "the Cursor headless output is empty (no output was captured/saved - nothing to count)"
      : "no separable `result` field in the Cursor headless output (use `--output-format json`)";

  // The TRUE per-run reason input is unavailable. Export-only (no invocation declared at all) is a
  // DIFFERENT situation from a declared invocation in which no prompt could be identified - the reason
  // and the fix differ, so both are stated precisely (never a bare "unknown", never a fabricated count).
  // The documented Cursor headless output (json / stream-json) carries result/session_id/duration -
  // NOT the prompt - so input can never be derived from the export itself without format-guessing.
  const inputUnavailableReason = prompt
    ? undefined
    : params.commandParts === undefined
      ? "a saved Cursor export does not contain the prompt (the documented headless output carries the result, not the user input), and no invocation was declared after --"
      : "no prompt could be identified in the wrapped invocation";

  if (inputUnavailableReason) {
    warnings.push(
      `Input tokens UNAVAILABLE: ${inputUnavailableReason}.`,
      params.commandParts === undefined
        ? 'To get a LOCAL-ESTIMATE input count (chars/4 of the prompt YOU declare - never provider-reported), re-declare the original invocation after --: compaction run cursor --out <dir> --export <file> -- cursor agent -p "<your prompt>" --output-format json (same for capture cursor).'
        : 'To get a LOCAL-ESTIMATE input count, pass the prompt in the invocation (e.g. cursor agent -p "<your prompt>" --output-format json).'
    );
  }
  if (outputUnavailableReason) {
    warnings.push(
      `Output tokens UNAVAILABLE: ${outputUnavailableReason}. ` +
        "Provider-reported output is unavailable (Cursor emits no usage)."
    );
  }

  const limitations = [CURSOR_LOCAL_ESTIMATE_NOTE];
  // Both per-axis unavailability reasons ride in limitations so the SAME reason reaches every surface
  // that renders this capture (CLI stdout notes, the local run record's notes, the summary rollup).
  if (inputUnavailableReason) limitations.push(`Input tokens are unavailable for this run (${inputUnavailableReason}).`);
  if (outputUnavailableReason) limitations.push(`Output tokens are unavailable for this run (${outputUnavailableReason}).`);

  const usageMetadata = createUsageMetadata({
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    providerReportedTokens: false,
    estimatedTokens: true,
    provider: "cursor",
    limitations
  });

  const trace: AgentTrace = {
    id: sessionId ?? `trace_cursor_${params.captureId}`,
    title: "Cursor headless captured trace",
    artifactVersion: CURRENT_AGENT_TRACE_ARTIFACT_VERSION,
    source: "local_command",
    createdAt: startedAt,
    generatedAt,
    model: "cursor-unknown-model",
    command: params.commandRun
      ? { command: params.commandRun.command.executable, args: params.commandRun.command.args, cwd: process.cwd() }
      : { command: "cursor-export", args: [], cwd: process.cwd() },
    durationMs: params.commandRun?.durationMs ?? 0,
    exitCode: params.commandRun?.exitCode ?? 0,
    messages
  };

  return {
    trace,
    usageMetadata,
    inputStatus: prompt ? "present" : "unavailable",
    ...(inputUnavailableReason !== undefined ? { inputUnavailableReason } : {}),
    outputStatus: outputSeparable ? "present" : "unavailable",
    ...(outputUnavailableReason !== undefined ? { outputUnavailableReason } : {}),
    warnings
  };
}

export interface CursorCaptureResult extends CursorNormalizationResult {
  commandRun?: LocalCommandRun;
}

/** Live wrapper: spawn the Cursor headless CLI (no manual export), capture stdout, normalize. */
export async function captureCursorCommand(commandParts: string[], generatedAt?: string): Promise<CursorCaptureResult> {
  const parsed = parseRunCommand(commandParts);
  const commandRun = await executeLocalCommand(parsed);
  const result = normalizeCursorAgentOutput({
    captureId: `${parsed.executable}-${commandRun.startedAt}`,
    rawOutput: commandRun.rawOutput,
    commandParts,
    commandRun,
    generatedAt
  });
  return { ...result, commandRun };
}

/** Offline/fallback: normalize a saved Cursor headless output (json / stream-json) string. */
export function captureCursorExport(rawOutput: string, commandParts?: string[], generatedAt?: string): CursorCaptureResult {
  return normalizeCursorAgentOutput({ captureId: "cursor-export", rawOutput, commandParts, generatedAt });
}
