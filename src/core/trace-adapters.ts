import { createHash } from "node:crypto";
import { z } from "zod";
import { agentTraceSchema, CURRENT_AGENT_TRACE_ARTIFACT_VERSION } from "./trace-parser.js";
import type { AgentTrace, TraceMessage, TraceRole } from "./types.js";

export type TraceAdapterSource = "agent-trace" | "messages" | "codex-exec-jsonl" | "unknown";
export type TraceAdapterStatus = "pass" | "warn" | "fail";

export interface TraceAdapterOptions {
  rawContent: string;
  // Explicit operator assertion of real local provenance. Default (false/undefined)
  // keeps imported traces at the WEAKEST honest tier (a `manual` fixture). Only when
  // the operator explicitly asserts "this is my own real `codex exec --json` export"
  // does an import elevate to `codex_import` (evidence tier `imported_local`). This is
  // an opt-in operator gesture at the import boundary, never an automatic upgrade of
  // all Codex JSONL, synthetic/demo/example/test inputs default to `fixture`.
  operatorExport?: boolean;
}

export interface TraceAdapterResult {
  status: TraceAdapterStatus;
  trace: AgentTrace | null;
  warnings: string[];
  failures: string[];
  normalization_steps: string[];
  skipped_fields: string[];
  source_metadata: Record<string, unknown>;
}

export interface TraceAdapter {
  id: TraceAdapterSource;
  displayName: string;
  description: string;
  supportedSource: TraceAdapterSource;
  /**
   * Honest integration-readiness label for this source (readiness level +
   * validation status). All import sources are Level 1 (local export/import, no live
   * integration); this string also discloses how PROVEN the source is (e.g. validated
   * on a synthetic fixture vs real-artifact validation still open), so `--list-sources`
   * never reads as a stronger integration claim than the evidence supports.
   */
  readiness: string;
  limitations: string[];
  canHandle(input: unknown): boolean;
  normalize(input: unknown, options: TraceAdapterOptions): TraceAdapterResult;
}

export interface TraceAdapterDetectionResult {
  status: TraceAdapterStatus;
  requested_source: TraceAdapterSource;
  adapter_id: TraceAdapterSource | null;
  supported_format_detected: boolean;
  warnings: string[];
  failures: string[];
  normalization_steps: string[];
  skipped_fields: string[];
  source_metadata: Record<string, unknown>;
}

const baseGeneratedAt = "1970-01-01T00:00:00.000Z";
const supportedSources: TraceAdapterSource[] = ["agent-trace", "messages", "codex-exec-jsonl", "unknown"];

const roleSchema = z.enum(["system", "user", "assistant", "tool", "stdout", "stderr"]);

const looseMessageSchema = z
  .object({
    id: z.unknown().optional(),
    role: z.unknown().optional(),
    content: z.unknown().optional(),
    timestamp: z.unknown().optional(),
    createdAt: z.unknown().optional(),
    created_at: z.unknown().optional(),
    toolName: z.unknown().optional(),
    name: z.unknown().optional()
  })
  .passthrough();

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function stableTimestamp(index: number): string {
  return new Date(Date.UTC(1970, 0, 1, 0, 0, index)).toISOString();
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && z.string().datetime({ offset: true }).safeParse(value).success;
}

function looksLikeAgentTrace(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === "string" && Array.isArray(candidate.messages) && typeof candidate.model === "string";
}

function extractMessageCandidates(value: unknown): unknown[] | null {
  if (Array.isArray(value)) {
    return value;
  }

  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  return Array.isArray(candidate.messages) ? candidate.messages : null;
}

function looksLikeMessages(value: unknown): boolean {
  const messages = extractMessageCandidates(value);
  return Boolean(messages && messages.some((message) => looseMessageSchema.safeParse(message).success));
}

function formatZodIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const issuePath = issue.path.length > 0 ? issue.path.join(".") : "root";
    return `${issuePath}: ${issue.message}`;
  });
}

function resultStatus(warnings: string[], failures: string[]): TraceAdapterStatus {
  if (failures.length > 0) {
    return "fail";
  }

  return warnings.length > 0 ? "warn" : "pass";
}

function adapterSourceMetadata(adapter: TraceAdapter, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    adapter_id: adapter.id,
    adapter_display_name: adapter.displayName,
    supported_source: adapter.supportedSource,
    local_file_normalizer: true,
    live_provider_integration: false,
    ...extra
  };
}

interface JsonlEventWithLine {
  rawLineNumber: number;
  event: Record<string, unknown>;
}

const codexSupportedItemTypes = new Set([
  "agent_message",
  "assistant_message",
  "message",
  "command_execution",
  "command",
  "tool_call",
  "mcp_tool_call"
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function getNestedRecord(value: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const nested = value[key];
  return isRecord(nested) ? nested : null;
}

function getStringField(value: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate;
    }
  }

  return null;
}

function getStringArrayText(value: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const candidate = value[key];
    if (Array.isArray(candidate)) {
      const parts = candidate.filter((part): part is string => typeof part === "string" && part.trim().length > 0);
      if (parts.length > 0) {
        return parts.join("\n");
      }
    }
  }

  return null;
}

function getCodexEventType(event: Record<string, unknown>): string | null {
  return getStringField(event, ["type", "event", "event_type", "kind"]);
}

function getCodexItem(event: Record<string, unknown>): Record<string, unknown> | null {
  return getNestedRecord(event, "item") ?? getNestedRecord(event, "message") ?? getNestedRecord(event, "data");
}

function getCodexItemType(event: Record<string, unknown>, item: Record<string, unknown> | null): string | null {
  return item ? getStringField(item, ["type", "item_type", "kind"]) ?? getCodexEventType(event) : getCodexEventType(event);
}

function looksLikeCodexExecJsonl(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) {
    return false;
  }

  return value.some((candidate) => {
    if (!isRecord(candidate)) {
      return false;
    }

    const event = isRecord(candidate.event) ? candidate.event : candidate;
    const eventType = getCodexEventType(event);
    const item = getCodexItem(event);
    const itemType = getCodexItemType(event, item);
    return Boolean(
      eventType?.startsWith("thread.") ||
        eventType?.startsWith("turn.") ||
        eventType?.startsWith("item.") ||
        eventType === "error" ||
        (itemType && codexSupportedItemTypes.has(itemType))
    );
  });
}

function codexTextFrom(event: Record<string, unknown>, item: Record<string, unknown> | null): string | null {
  const candidates = item ? [item, event] : [event];
  for (const candidate of candidates) {
    const direct = getStringField(candidate, ["content", "text", "message", "output", "summary"]);
    if (direct) {
      return direct;
    }

    const joined = getStringArrayText(candidate, ["content", "text", "output"]);
    if (joined) {
      return joined;
    }
  }

  return null;
}

function codexCommandText(event: Record<string, unknown>, item: Record<string, unknown> | null): string | null {
  const source = item ?? event;
  const command = getStringField(source, ["command", "cmd"]);
  const args = Array.isArray(source.args) ? source.args.filter((arg): arg is string => typeof arg === "string") : [];
  const stdout = getStringField(source, ["stdout", "output"]);
  const stderr = getStringField(source, ["stderr", "error"]);
  const parts = [
    command ? `$ ${[command, ...args].join(" ")}` : null,
    stdout ? `stdout:\n${stdout}` : null,
    stderr ? `stderr:\n${stderr}` : null
  ].filter((part): part is string => Boolean(part));

  return parts.length > 0 ? parts.join("\n\n") : codexTextFrom(event, item);
}

function normalizeCodexExecJsonl(
  adapter: TraceAdapter,
  value: unknown,
  rawContent: string,
  operatorExport: boolean
): TraceAdapterResult {
  const warnings: string[] = [
    "Codex exec JSONL adapter v0 reads only local user-supplied JSONL artifacts and does not launch Codex or call provider APIs.",
    "Token counts, billing, complete prompt assembly, and interactive/IDE/desktop/web Codex exports are not supported by this adapter."
  ];
  const failures: string[] = [];
  const normalizationSteps: string[] = [
    "Detected a local Codex exec --json JSONL event stream.",
    "Mapped supported agent message and command/tool events into the internal AgentTrace format.",
    "Recorded raw line numbers and event hashes in message metadata when available."
  ];
  const skippedFields: string[] = [];

  if (!Array.isArray(value)) {
    failures.push("Codex exec JSONL input must be parsed as a non-empty JSONL event array.");
    return {
      status: "fail",
      trace: null,
      warnings,
      failures,
      normalization_steps: normalizationSteps,
      skipped_fields: skippedFields,
      source_metadata: adapterSourceMetadata(adapter, { detected_shape: "unsupported" })
    };
  }

  const messages: TraceMessage[] = [];
  let lifecycleEvents = 0;
  let unsupportedEvents = 0;

  value.forEach((entry, index) => {
    if (!isRecord(entry)) {
      unsupportedEvents += 1;
      skippedFields.push(`jsonl[${index}]`);
      warnings.push(`Skipped JSONL event at index ${index} because it is not a JSON object.`);
      return;
    }

    const rawLineNumber = typeof entry.rawLineNumber === "number" ? entry.rawLineNumber : index + 1;
    const event = isRecord(entry.event) ? entry.event : entry;
    const eventType = getCodexEventType(event) ?? "unknown";
    const item = getCodexItem(event);
    const itemType = getCodexItemType(event, item) ?? "unknown";
    const rawEventHash = stableHash(JSON.stringify(event));
    const metadata = { source_line: rawLineNumber, raw_event_hash: rawEventHash, event_type: eventType, item_type: itemType };

    if (eventType.startsWith("thread.") || eventType.startsWith("turn.")) {
      lifecycleEvents += 1;
      skippedFields.push(`jsonl[${index}].${eventType}`);
      return;
    }

    const lowerEventType = eventType.toLowerCase();
    const lowerItemType = itemType.toLowerCase();
    const messageId = `codex_${String(messages.length + 1).padStart(3, "0")}`;
    const timestampCandidate = getStringField(event, ["timestamp", "createdAt", "created_at"]);
    const timestamp = isIsoTimestamp(timestampCandidate) ? timestampCandidate : stableTimestamp(messages.length);

    if (!isIsoTimestamp(timestampCandidate)) {
      warnings.push(`Generated deterministic timestamp ${timestamp} for Codex JSONL event at line ${rawLineNumber}.`);
    }

    if (lowerItemType.includes("agent_message") || lowerItemType.includes("assistant_message") || lowerEventType.includes("agent_message")) {
      const content = codexTextFrom(event, item);
      if (!content) {
        warnings.push(`Skipped Codex agent message at line ${rawLineNumber} because it did not include string content.`);
        skippedFields.push(`jsonl[${index}].content`);
        return;
      }

      messages.push({ id: messageId, role: "assistant", content, timestamp, metadata });
      return;
    }

    if (lowerItemType.includes("user_message")) {
      const content = codexTextFrom(event, item);
      if (!content) {
        warnings.push(`Skipped Codex user message at line ${rawLineNumber} because it did not include string content.`);
        skippedFields.push(`jsonl[${index}].content`);
        return;
      }

      messages.push({ id: messageId, role: "user", content, timestamp, metadata });
      return;
    }

    if (lowerItemType.includes("command") || lowerEventType.includes("command")) {
      const content = codexCommandText(event, item);
      if (!content) {
        warnings.push(`Skipped Codex command event at line ${rawLineNumber} because it did not include command text, stdout, or stderr.`);
        skippedFields.push(`jsonl[${index}].command_output`);
        return;
      }

      messages.push({ id: messageId, role: "tool", content, timestamp, toolName: "codex_command_execution", metadata });
      return;
    }

    if (lowerItemType.includes("tool_call") || lowerItemType.includes("mcp_tool_call")) {
      const content = codexTextFrom(event, item);
      if (!content) {
        warnings.push(`Skipped Codex tool event at line ${rawLineNumber} because it did not include string output.`);
        skippedFields.push(`jsonl[${index}].tool_output`);
        return;
      }

      messages.push({ id: messageId, role: "tool", content, timestamp, toolName: "codex_tool_call", metadata });
      return;
    }

    unsupportedEvents += 1;
    skippedFields.push(`jsonl[${index}].${eventType}/${itemType}`);
    warnings.push(`Skipped unsupported Codex JSONL event at line ${rawLineNumber}: event type ${eventType}, item type ${itemType}.`);
  });

  if (messages.length === 0) {
    failures.push("No supported Codex agent message, command, or tool events with string content were found.");
    return {
      status: "fail",
      trace: null,
      warnings,
      failures,
      normalization_steps: normalizationSteps,
      skipped_fields: skippedFields,
      source_metadata: adapterSourceMetadata(adapter, {
        detected_shape: "codex-exec-jsonl",
        input_event_count: value.length,
        lifecycle_event_count: lifecycleEvents,
        unsupported_event_count: unsupportedEvents
      })
    };
  }

  const createdAt = messages[0]?.timestamp ?? baseGeneratedAt;
  // Evidence-tier at the operator-import boundary is opt-in (weakest-honest-default):
  //  - WITHOUT an explicit operator assertion, Codex JSONL imports default to the
  //    weakest honest tier - `manual` (evidence tier `fixture`). This is the
  //    synthetic-safe default: a hand-authored demo/example/test JSONL (e.g.
  //    src/examples/codex-exec-demo.jsonl) must NOT be labeled as a real local export.
  //  - WITH the explicit operator assertion (`compaction import --operator-export`,
  //    threaded here as `operatorExport`), the operator is attesting "this is my own
  //    real `codex exec --json` export", and the trace is elevated to `codex_import`
  //    (evidence tier `imported_local`). That tier stays STRICTLY below `real_captured`:
  //    it never unlocks the `ready` approval rung and caps at `conditional`, with
  //    `real_captured === false`, and carries no billing or semantic/commitment claim.
  // Either way the raw line numbers and event hashes recorded in each message's metadata
  // above preserve per-event provenance from the source artifact.
  const trace: AgentTrace = {
    id: `codex_exec_${stableHash(rawContent)}`,
    title: "Imported Codex exec JSONL trace",
    artifactVersion: CURRENT_AGENT_TRACE_ARTIFACT_VERSION,
    source: operatorExport ? "codex_import" : "manual",
    createdAt,
    generatedAt: createdAt,
    model: "codex-exec-jsonl-local-export",
    messages
  };

  if (lifecycleEvents > 0) {
    normalizationSteps.push(`Skipped ${lifecycleEvents} lifecycle event(s) after recording them as unsupported AgentTrace fields.`);
  }

  if (unsupportedEvents > 0) {
    normalizationSteps.push(`Skipped ${unsupportedEvents} unsupported Codex event(s) that do not map to AgentTrace messages in v0.`);
  }

  normalizationSteps.push(
    operatorExport
      ? "Operator asserted local provenance (--operator-export): evidence tier elevated to imported_local (codex_import); stays one rung below the captured-session tier and caps approval readiness at conditional."
      : "No operator provenance assertion: evidence tier defaults to the weakest honest tier (fixture/manual). Re-run with --operator-export only for your own real `codex exec --json` export."
  );

  return {
    status: resultStatus(warnings, failures),
    trace,
    warnings,
    failures,
    normalization_steps: normalizationSteps,
    skipped_fields: skippedFields,
    source_metadata: adapterSourceMetadata(adapter, {
      detected_shape: "codex-exec-jsonl",
      input_event_count: value.length,
      lifecycle_event_count: lifecycleEvents,
      unsupported_event_count: unsupportedEvents,
      normalized_message_count: messages.length,
      source_format: "jsonl",
      provider_api_calls: false,
      operator_export_asserted: operatorExport,
      evidence_tier: operatorExport ? "imported_local" : "fixture"
    })
  };
}

// Evidence tiers that the `agent-trace` import boundary CANNOT honestly confer.
//
// `real_captured` is reserved for a trace this tool itself captured from an agent
// runtime session under controlled conditions (see capture-adapter.ts and
// evidenceSourceTypeFromTrace in safety-report.ts: only `real_captured` can unlock
// `approval_readiness_status: "ready"`). The import/adapter path reads a local file the
// tool did NOT produce or attest, so it cannot verify that provenance - a hand-authored
// JSON file could simply TYPE `"source": "real_captured"` and otherwise inherit the
// strongest, approval-unlocking tier. `demo` is likewise a positioning label, not an
// import provenance the adapter should silently carry. Both are therefore stripped to
// the weakest honest tier (`manual` -> `fixture`) on import, with the downgrade recorded
// in the intake report. This closes the import-time provenance hole where a hand-authored
// JSON could declare source: real_captured and inherit the strongest tier without ever having
// been captured live. It does NOT touch the genuine capture path (capture-claude-code writes
// real_captured and is read via parseTraceFile, not this adapter), and it only ever moves
// a tier DOWN - it can never elevate a label.
const UNATTESTABLE_IMPORT_SOURCES: ReadonlySet<string> = new Set(["real_captured", "demo"]);

function normalizeAgentTrace(adapter: TraceAdapter, value: unknown): TraceAdapterResult {
  const parsed = agentTraceSchema.safeParse(value);
  if (!parsed.success) {
    return {
      status: "fail",
      trace: null,
      warnings: [],
      failures: formatZodIssues(parsed.error),
      normalization_steps: ["Attempted to validate input as the internal AgentTrace JSON shape."],
      skipped_fields: [],
      source_metadata: adapterSourceMetadata(adapter, { detected_shape: looksLikeAgentTrace(value) ? "agent-trace" : "unsupported" })
    };
  }

  const warnings: string[] = [];
  const normalizationSteps: string[] = [
    "Validated input as the internal AgentTrace JSON shape.",
    "Wrote a normalized AgentTrace copy without mutating the source file."
  ];

  const declaredSource = parsed.data.source;
  let trace = parsed.data;
  let provenanceGuardApplied = false;

  if (UNATTESTABLE_IMPORT_SOURCES.has(declaredSource)) {
    // Downgrade to the weakest honest tier. The import boundary cannot attest a
    // runtime capture, so an unverifiable self-declared `real_captured`/`demo` is
    // recorded as `manual` (-> `fixture`). This NEVER elevates a tier.
    trace = { ...parsed.data, source: "manual" };
    provenanceGuardApplied = true;
    const message =
      `Import provenance guard: declared source "${declaredSource}" is not attestable through the import boundary ` +
      `(only a tool-mediated capture can earn real_captured). Downgraded evidence tier to fixture (source: manual). ` +
      `To earn real_captured, capture the session with a capture command (e.g. compaction capture claude-code), not import.`;
    warnings.push(message);
    normalizationSteps.push(message);
  }

  return {
    status: provenanceGuardApplied ? "warn" : "pass",
    trace,
    warnings,
    failures: [],
    normalization_steps: normalizationSteps,
    skipped_fields: [],
    source_metadata: adapterSourceMetadata(adapter, {
      detected_shape: "agent-trace",
      message_count: trace.messages.length,
      declared_source: declaredSource,
      effective_source: trace.source,
      provenance_guard_applied: provenanceGuardApplied
    })
  };
}

function normalizeMessages(adapter: TraceAdapter, value: unknown, rawContent: string): TraceAdapterResult {
  const candidates = extractMessageCandidates(value);
  const warnings: string[] = [];
  const failures: string[] = [];
  const normalizationSteps: string[] = ["Detected a simple local messages shape."];
  const skippedFields: string[] = [];

  if (!candidates) {
    failures.push("Input is not an array of messages and does not contain a messages array.");
    return {
      status: "fail",
      trace: null,
      warnings,
      failures,
      normalization_steps: normalizationSteps,
      skipped_fields: skippedFields,
      source_metadata: adapterSourceMetadata(adapter, { detected_shape: "unsupported" })
    };
  }

  const messages: TraceMessage[] = [];
  candidates.forEach((candidate, index) => {
    const parsed = looseMessageSchema.safeParse(candidate);
    if (!parsed.success) {
      warnings.push(`Skipped message at index ${index} because it is not a JSON object.`);
      return;
    }

    const message = parsed.data;
    if (typeof message.content !== "string") {
      warnings.push(`Skipped message at index ${index} because content is missing or not a string.`);
      return;
    }

    const roleResult = roleSchema.safeParse(message.role);
    if (!roleResult.success) {
      warnings.push(`Skipped message at index ${index} because role is missing or unsupported.`);
      return;
    }

    const timestampCandidate = message.timestamp ?? message.createdAt ?? message.created_at;
    const timestamp = isIsoTimestamp(timestampCandidate) ? timestampCandidate : stableTimestamp(index);
    const id = typeof message.id === "string" && message.id.length > 0 ? message.id : `msg_${String(index + 1).padStart(3, "0")}`;

    if (typeof message.id !== "string" || message.id.length === 0) {
      warnings.push(`Generated deterministic message id ${id} for message at index ${index}.`);
      normalizationSteps.push(`Generated deterministic message id ${id} for message at index ${index}.`);
    }

    if (!isIsoTimestamp(timestampCandidate)) {
      warnings.push(`Generated deterministic timestamp ${timestamp} for message ${id}.`);
      normalizationSteps.push(`Generated deterministic timestamp ${timestamp} for message ${id}.`);
    }

    const allowedKeys = new Set(["id", "role", "content", "timestamp", "createdAt", "created_at", "toolName", "name"]);
    Object.keys(message).forEach((key) => {
      if (!allowedKeys.has(key)) {
        skippedFields.push(`messages[${index}].${key}`);
      }
    });

    const normalizedMessage: TraceMessage = {
      id,
      role: roleResult.data as TraceRole,
      content: message.content,
      timestamp
    };

    const toolName = typeof message.toolName === "string" && message.toolName.length > 0 ? message.toolName : message.name;
    if (typeof toolName === "string" && toolName.length > 0) {
      normalizedMessage.toolName = toolName;
    }

    messages.push(normalizedMessage);
  });

  if (messages.length === 0) {
    failures.push("No supported messages with string content and supported roles were found.");
    return {
      status: "fail",
      trace: null,
      warnings,
      failures,
      normalization_steps: normalizationSteps,
      skipped_fields: skippedFields,
      source_metadata: adapterSourceMetadata(adapter, { detected_shape: "messages", input_message_candidates: candidates.length })
    };
  }

  const traceId = `imported_${stableHash(rawContent)}`;
  const createdAt = messages[0]?.timestamp ?? baseGeneratedAt;
  const trace: AgentTrace = {
    id: traceId,
    title: "Imported local messages trace",
    artifactVersion: CURRENT_AGENT_TRACE_ARTIFACT_VERSION,
    source: "manual",
    createdAt,
    generatedAt: createdAt,
    model: "imported-local-trace",
    messages
  };

  normalizationSteps.push("Converted simple messages into the internal AgentTrace format with deterministic local defaults.");
  normalizationSteps.push("Set AgentTrace source to manual because no provider/runtime adapter is used in v0.");

  return {
    status: resultStatus(warnings, failures),
    trace,
    warnings,
    failures,
    normalization_steps: normalizationSteps,
    skipped_fields: skippedFields,
    source_metadata: adapterSourceMetadata(adapter, {
      detected_shape: "messages",
      input_message_candidates: candidates.length,
      normalized_message_count: messages.length
    })
  };
}

export const agentTraceAdapter: TraceAdapter = {
  id: "agent-trace",
  displayName: "Internal AgentTrace",
  description: "Validates a local file that already matches the internal AgentTrace JSON shape.",
  supportedSource: "agent-trace",
  readiness: "Level 1 (local import) · canonical internal format, schema-validated",
  limitations: [
    "Only local JSON files are supported.",
    "Live provider/runtime capture is future work.",
    "Input must validate against the current internal AgentTrace schema."
  ],
  canHandle: looksLikeAgentTrace,
  normalize(input: unknown): TraceAdapterResult {
    return normalizeAgentTrace(this, input);
  }
};

export const messagesAdapter: TraceAdapter = {
  id: "messages",
  displayName: "Simple messages",
  description: "Normalizes a local array of role/content messages, or an object with a messages array, into AgentTrace.",
  supportedSource: "messages",
  readiness: "Level 1 (local import) · generic role/content messages shape",
  limitations: [
    "Only local JSON files are supported.",
    "Messages need supported roles and string content.",
    "Missing ids and timestamps are filled with deterministic local defaults.",
    "Live provider/runtime capture is future work."
  ],
  canHandle: looksLikeMessages,
  normalize(input: unknown, options: TraceAdapterOptions): TraceAdapterResult {
    return normalizeMessages(this, input, options.rawContent);
  }
};

export const codexExecJsonlAdapter: TraceAdapter = {
  id: "codex-exec-jsonl",
  displayName: "Codex exec JSONL",
  description: "Normalizes a local JSONL stream produced by Codex exec --json into AgentTrace without launching Codex or calling provider APIs.",
  supportedSource: "codex-exec-jsonl",
  readiness:
    "Level 1 (local export import) · validated end-to-end on a synthetic fixture; real-artifact validation OPEN (a real `codex exec --json` export has not yet been walked)",
  limitations: [
    "Only local user-supplied JSONL files are supported.",
    "This adapter does not launch Codex, call OpenAI APIs, scrape private data, or upload artifacts.",
    "Only non-interactive Codex exec --json style event streams are in scope for v0.",
    "Interactive Codex, Codex IDE, Codex desktop, Codex web, complete prompt reconstruction, token accuracy, and billing accuracy are future work.",
    "Unsupported or unmapped event families are reported as skipped fields."
  ],
  canHandle: looksLikeCodexExecJsonl,
  normalize(input: unknown, options: TraceAdapterOptions): TraceAdapterResult {
    return normalizeCodexExecJsonl(this, input, options.rawContent, options.operatorExport === true);
  }
};

function detectConcreteAdapter(input: unknown): TraceAdapter | null {
  if (agentTraceAdapter.canHandle(input)) {
    return agentTraceAdapter;
  }

  if (codexExecJsonlAdapter.canHandle(input)) {
    return codexExecJsonlAdapter;
  }

  if (messagesAdapter.canHandle(input)) {
    return messagesAdapter;
  }

  return null;
}

export const unknownAdapter: TraceAdapter = {
  id: "unknown",
  displayName: "Unknown local trace source",
  description: "Detects supported local AgentTrace and simple messages shapes before normalizing with the matching adapter.",
  supportedSource: "unknown",
  readiness: "Level 1 (local import) · best-effort shape detection (AgentTrace / messages / Codex JSONL)",
  limitations: [
    "Detection is shape-based and local-file only.",
    "AgentTrace, simple messages, and Codex exec JSONL shapes are detected in v0.",
    "Live Claude Code, Codex, Cursor, and provider adapters are future work."
  ],
  canHandle(input: unknown): boolean {
    return detectConcreteAdapter(input) !== null;
  },
  normalize(input: unknown, options: TraceAdapterOptions): TraceAdapterResult {
    const detectedAdapter = detectConcreteAdapter(input);
    if (!detectedAdapter) {
      return {
        status: "fail",
        trace: null,
        warnings: [],
        failures: ["Unknown source input does not resemble AgentTrace, simple messages JSON, or Codex exec JSONL."],
        normalization_steps: ["Attempted to detect a supported local trace adapter for unknown source input."],
        skipped_fields: [],
        source_metadata: adapterSourceMetadata(this, {
          detected_adapter_id: null,
          detected_shape: "unsupported"
        })
      };
    }

    const result = detectedAdapter.normalize(input, options);
    return {
      ...result,
      normalization_steps: [`Detected ${detectedAdapter.id} input while source was unknown.`, ...result.normalization_steps],
      source_metadata: {
        ...result.source_metadata,
        adapter_id: this.id,
        adapter_display_name: this.displayName,
        delegated_adapter_id: detectedAdapter.id,
        requested_source: "unknown"
      }
    };
  }
};

export const traceAdapters: TraceAdapter[] = [agentTraceAdapter, messagesAdapter, codexExecJsonlAdapter, unknownAdapter];

export interface TraceAdapterRawParseResult {
  input: unknown | null;
  failures: string[];
  normalization_steps: string[];
  source_metadata: Record<string, unknown>;
}

function parseJsonlRawContent(rawContent: string): TraceAdapterRawParseResult {
  const events: JsonlEventWithLine[] = [];
  const failures: string[] = [];
  const lines = rawContent.split(/\r?\n/);

  lines.forEach((line, index) => {
    if (line.trim().length === 0) {
      return;
    }

    try {
      const parsed = JSON.parse(line) as unknown;
      if (!isRecord(parsed)) {
        failures.push(`JSONL line ${index + 1} is not a JSON object.`);
        return;
      }

      events.push({ rawLineNumber: index + 1, event: parsed });
    } catch (error) {
      failures.push(error instanceof Error ? `JSONL line ${index + 1} is not valid JSON: ${error.message}` : `JSONL line ${index + 1} is not valid JSON.`);
    }
  });

  if (events.length === 0 && failures.length === 0) {
    failures.push("Codex exec JSONL input did not contain any non-empty JSONL events.");
  }

  return {
    input: failures.length > 0 ? null : events,
    failures,
    normalization_steps: ["Parsed local Codex exec JSONL content line by line without mutating the source file."],
    source_metadata: {
      parsed_format: "jsonl",
      non_empty_line_count: events.length + failures.length,
      parsed_event_count: events.length
    }
  };
}

export function parseTraceAdapterRawContent(rawContent: string, source: TraceAdapterSource): TraceAdapterRawParseResult {
  if (source === "codex-exec-jsonl") {
    return parseJsonlRawContent(rawContent);
  }

  try {
    return {
      input: JSON.parse(rawContent) as unknown,
      failures: [],
      normalization_steps: ["Parsed local JSON content without mutating the source file."],
      source_metadata: { parsed_format: "json" }
    };
  } catch (error) {
    const jsonFailure = error instanceof Error ? `Input is not valid JSON: ${error.message}` : "Input is not valid JSON.";
    if (source === "unknown") {
      const jsonlResult = parseJsonlRawContent(rawContent);
      if (jsonlResult.failures.length === 0 && jsonlResult.input !== null && looksLikeCodexExecJsonl(jsonlResult.input)) {
        return jsonlResult;
      }
    }

    return {
      input: null,
      failures: [jsonFailure],
      normalization_steps: ["Read the local file without mutating it."],
      source_metadata: { parsed_format: "json" }
    };
  }
}

export function listTraceAdapters(): TraceAdapter[] {
  return [...traceAdapters];
}

export function listTraceAdapterSources(): TraceAdapterSource[] {
  return [...supportedSources];
}

export function assertTraceAdapterSource(source: string): asserts source is TraceAdapterSource {
  if (!supportedSources.includes(source as TraceAdapterSource)) {
    throw new Error(`Unsupported source "${source}". Supported sources: ${supportedSources.join(", ")}.`);
  }
}

export function getTraceAdapter(source: TraceAdapterSource): TraceAdapter {
  const adapter = traceAdapters.find((candidate) => candidate.id === source);
  if (!adapter) {
    throw new Error(`No trace adapter registered for source "${source}".`);
  }

  return adapter;
}

export function detectTraceAdapter(input: unknown, requestedSource: TraceAdapterSource = "unknown"): TraceAdapterDetectionResult {
  const adapter = requestedSource === "unknown" ? detectConcreteAdapter(input) : getTraceAdapter(requestedSource);

  if (!adapter) {
    return {
      status: "fail",
      requested_source: requestedSource,
      adapter_id: null,
      supported_format_detected: false,
      warnings: [],
      failures: ["No registered trace adapter can handle this input shape."],
      normalization_steps: ["Attempted to detect a supported local trace adapter."],
      skipped_fields: [],
      source_metadata: { requested_source: requestedSource, local_file_normalizer: true, live_provider_integration: false }
    };
  }

  const supported = requestedSource === "unknown" ? adapter.canHandle(input) : getTraceAdapter(requestedSource).canHandle(input);
  return {
    status: supported ? "pass" : "fail",
    requested_source: requestedSource,
    adapter_id: adapter.id,
    supported_format_detected: supported,
    warnings: [],
    failures: supported ? [] : [`Input does not match the ${adapter.id} adapter shape.`],
    normalization_steps: [`Selected ${adapter.id} trace adapter for local normalization.`],
    skipped_fields: [],
    source_metadata: adapterSourceMetadata(adapter, { requested_source: requestedSource })
  };
}
