import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { executeLocalCommand, parseRunCommand, type LocalCommandRun, type ParsedRunCommand } from "./command-runner.js";
import { CURRENT_AGENT_TRACE_ARTIFACT_VERSION } from "./trace-parser.js";
import { createUsageMetadata, describeCostMetadata, describeTokenMetadata, missingUsageMetadata, type UsageMetadata } from "./usage-metadata.js";
import type { AgentTrace, TraceMessage } from "./types.js";

export type OpenAIAgentsCaptureMode = "command wrapper" | "local export" | "fixture";
export type CaptureStatus = "pass" | "warn" | "fail";
export type MetadataStatus = "present" | "partial" | "synthetic-demo" | "missing" | "unknown";

export interface OpenAIAgentsCaptureReport {
  capture_id: string;
  generated_at: string;
  integration: "openai-agents";
  capture_mode: OpenAIAgentsCaptureMode;
  status: CaptureStatus;
  command_run?: {
    command: string;
    args: string[];
    exit_code: number;
    duration_ms: number;
  };
  output_trace_id: string | null;
  events_captured: number;
  messages_captured: number;
  tool_outputs_captured: number;
  token_metadata_status: MetadataStatus;
  cost_metadata_status: MetadataStatus;
  usage_metadata: UsageMetadata;
  spend_confidence: UsageMetadata["cost_confidence"];
  pricing_assumptions: string[];
  warnings: string[];
  failures: string[];
  limitations: string[];
  recommended_next_command: string | null;
}

export interface OpenAIAgentsCaptureArtifacts {
  report: OpenAIAgentsCaptureReport;
  trace: AgentTrace | null;
  outputDirectory: string;
  paths: {
    capturedTracePath: string;
    captureReportJsonPath: string;
    captureReportMarkdownPath: string;
  };
  terminalSummary: string;
}

interface NormalizationResult {
  trace: AgentTrace;
  eventsCaptured: number;
  messagesCaptured: number;
  toolOutputsCaptured: number;
  tokenMetadataStatus: MetadataStatus;
  costMetadataStatus: MetadataStatus;
  usageMetadata: UsageMetadata;
  spendConfidence: UsageMetadata["cost_confidence"];
  pricingAssumptions: string[];
  warnings: string[];
  limitations: string[];
}

interface ParsedEvent {
  value: Record<string, unknown>;
  lineNumber: number;
}

const integrationLimitations = [
  "This spike is local-first and captures only local command output that exposes OpenAI Agents SDK-style trace/span JSON events.",
  "It does not scrape ChatGPT app traces and does not use undocumented APIs.",
  "It does not install an OpenAI Agents SDK tracing processor into arbitrary user processes; native SDK processors/export files are future work.",
  "Token and cost metadata are reported only when present in captured events; missing values are not estimated or invented.",
  "No hosted service, dashboard, database, auth, billing, model routing, provider switching, or auto-optimization mode is included."
];

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

export function createOpenAIAgentsCaptureId(now: Date = new Date()): string {
  return `capture-${now.toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function objectText(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  const record = toRecord(value);
  if (!record) {
    return null;
  }
  const content = record.content;
  if (typeof content === "string") {
    return content;
  }
  const text = record.text;
  return typeof text === "string" ? text : null;
}

function eventTimestamp(event: Record<string, unknown>, fallback: string): string {
  const timestamp = stringValue(event.timestamp) ?? stringValue(event.started_at) ?? stringValue(event.startedAt) ?? stringValue(event.created_at);
  if (!timestamp) {
    return fallback;
  }
  const parsed = new Date(timestamp);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed.toISOString();
}

function parseJsonEvents(rawOutput: string): ParsedEvent[] {
  return rawOutput
    .split(/\r?\n/)
    .map((line, index) => ({ line: line.trim(), lineNumber: index + 1 }))
    .filter(({ line }) => line.startsWith("{") && line.endsWith("}"))
    .flatMap(({ line, lineNumber }) => {
      try {
        const parsed = JSON.parse(line) as unknown;
        const record = toRecord(parsed);
        return record ? [{ value: record, lineNumber }] : [];
      } catch {
        return [];
      }
    });
}

function spanData(event: Record<string, unknown>): Record<string, unknown> {
  return toRecord(event.span_data) ?? toRecord(event.spanData) ?? event;
}

function eventKind(event: Record<string, unknown>): string {
  const data = spanData(event);
  return stringValue(data.type) ?? stringValue(event.type) ?? stringValue(event.object) ?? "event";
}

function extractTraceId(events: ParsedEvent[], captureId: string): string {
  for (const { value } of events) {
    const id = stringValue(value.trace_id) ?? stringValue(value.traceId);
    if (id) return id;
    const type = stringValue(value.type) ?? stringValue(value.object);
    const ownId = stringValue(value.id);
    if (ownId && type?.includes("trace")) return ownId;
  }
  return `trace_openai_agents_${stableHash(captureId)}`;
}

function extractModel(events: ParsedEvent[]): string {
  for (const { value } of events) {
    const data = spanData(value);
    const model = stringValue(data.model) ?? stringValue(value.model);
    if (model) return model;
  }
  return "openai-agents-sdk-unknown-model";
}


function numericValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function usageRecord(event: Record<string, unknown>): Record<string, unknown> | null {
  const data = spanData(event);
  return toRecord(data.usage) ?? toRecord(event.usage);
}

function usageNumber(event: Record<string, unknown>, keys: string[]): number | undefined {
  const data = spanData(event);
  const usage = usageRecord(event);
  for (const source of [usage, data, event]) {
    if (!source) continue;
    for (const key of keys) {
      const value = numericValue(source[key]);
      if (value !== undefined) return value;
    }
  }
  return undefined;
}

function eventCostIsProviderReported(event: Record<string, unknown>): boolean {
  const data = spanData(event);
  const usage = usageRecord(event);
  return [usage, data, event].some((source) =>
    source ? ["cost_usd", "costUsd", "total_cost_usd", "totalCostUsd", "cost"].some((key) => numericValue(source[key]) !== undefined) : false
  );
}

function stringMetadataValue(event: Record<string, unknown>, keys: string[]): string | undefined {
  const data = spanData(event);
  const usage = usageRecord(event);
  for (const source of [usage, data, event]) {
    if (!source) continue;
    for (const key of keys) {
      const value = stringValue(source[key]);
      if (value) return value;
    }
  }
  return undefined;
}

function aggregateUsageMetadata(events: ParsedEvent[], fallbackModel: string): UsageMetadata {
  if (events.length === 0) {
    return missingUsageMetadata({ model: fallbackModel, provider: "openai-agents", limitations: ["No provider events were captured, so token metadata is unknown."] });
  }

  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let hasInput = false;
  let hasOutput = false;
  let hasTotal = false;
  let providerReportedCost = false;
  let syntheticDemo = false;
  let model: string | undefined;
  let provider: string | undefined;
  let currency: string | undefined;

  for (const { value } of events) {
    const input = usageNumber(value, ["input_tokens", "inputTokens", "prompt_tokens", "promptTokens"]);
    const output = usageNumber(value, ["output_tokens", "outputTokens", "completion_tokens", "completionTokens"]);
    const total = usageNumber(value, ["total_tokens", "totalTokens"]);
    if (input !== undefined) {
      inputTokens += input;
      hasInput = true;
    }
    if (output !== undefined) {
      outputTokens += output;
      hasOutput = true;
    }
    if (total !== undefined) {
      totalTokens += total;
      hasTotal = true;
    }
    providerReportedCost = providerReportedCost || eventCostIsProviderReported(value);
    syntheticDemo = syntheticDemo || eventUsageIsSyntheticDemo(value);
    model = model ?? stringMetadataValue(value, ["model"]);
    provider = provider ?? stringMetadataValue(value, ["provider"]);
    currency = currency ?? stringMetadataValue(value, ["currency"]);
  }

  const hasAnyTokens = hasInput || hasOutput || hasTotal;
  if (!hasAnyTokens) {
    return missingUsageMetadata({ model: model ?? fallbackModel, provider: provider ?? "openai-agents", limitations: ["Captured events did not include provider token usage; values were not invented."] });
  }

  return createUsageMetadata({
    inputTokens: hasInput ? inputTokens : undefined,
    outputTokens: hasOutput ? outputTokens : undefined,
    totalTokens: hasTotal ? totalTokens : undefined,
    providerReportedTokens: true,
    estimatedTokens: false,
    syntheticDemo,
    providerReportedCost,
    currency,
    model: model ?? fallbackModel,
    provider: provider ?? "openai-agents",
    limitations: [
      syntheticDemo
        ? "Synthetic-demo token usage was emitted by the safe local demo workflow and is not production billing data."
        : providerReportedCost
          ? "Provider-reported token and cost metadata were captured from local events."
          : "Provider-reported tokens were captured; cost remains an estimate unless provider billing data is present."
    ]
  });
}

function eventUsageIsSyntheticDemo(event: Record<string, unknown>): boolean {
  const data = spanData(event);
  const usage = toRecord(data.usage) ?? toRecord(event.usage);
  return [usage, data, event].some((source) =>
    source
      ? source.synthetic_demo === true ||
        source.syntheticDemo === true ||
        source.demo === true ||
        source.metadata_status === "synthetic-demo" ||
        source.metadataStatus === "synthetic-demo" ||
        source.source === "synthetic-demo"
      : false
  );
}

function hasTokenMetadata(event: Record<string, unknown>): boolean {
  const data = spanData(event);
  const usage = toRecord(data.usage) ?? toRecord(event.usage);
  return Boolean(usage) || data.input_tokens !== undefined || data.output_tokens !== undefined || data.total_tokens !== undefined;
}

function hasCostMetadata(event: Record<string, unknown>): boolean {
  const data = spanData(event);
  return eventUsageIsSyntheticDemo(event) || data.cost_usd !== undefined || data.costUsd !== undefined || data.cost !== undefined || event.cost_usd !== undefined;
}

function metadataStatus(events: ParsedEvent[], predicate: (event: Record<string, unknown>) => boolean): MetadataStatus {
  if (events.length === 0) return "unknown";
  const matchingEvents = events.filter(({ value }) => predicate(value));
  const count = matchingEvents.length;
  if (count === 0) return "missing";
  if (matchingEvents.every(({ value }) => eventUsageIsSyntheticDemo(value))) return "synthetic-demo";
  return count === events.length ? "present" : "partial";
}

function addMessage(messages: TraceMessage[], role: TraceMessage["role"], content: string, timestamp: string, metadata?: Record<string, unknown>, toolName?: string): void {
  messages.push({
    id: `msg_${(messages.length + 1).toString().padStart(3, "0")}`,
    role,
    content,
    timestamp,
    ...(toolName ? { toolName } : {}),
    ...(metadata ? { metadata } : {})
  });
}

function appendGenerationMessages(messages: TraceMessage[], event: Record<string, unknown>, timestamp: string, lineNumber: number): void {
  const data = spanData(event);
  const inputs = Array.isArray(data.input) ? data.input : Array.isArray(data.inputs) ? data.inputs : [];
  const outputs = Array.isArray(data.output) ? data.output : Array.isArray(data.outputs) ? data.outputs : [];

  for (const input of inputs) {
    const text = objectText(input);
    const role = toRecord(input)?.role === "system" ? "system" : "user";
    if (text) addMessage(messages, role, text, timestamp, { sourceLine: lineNumber, eventType: "generation_input" });
  }

  for (const output of outputs) {
    const text = objectText(output);
    if (text) addMessage(messages, "assistant", text, timestamp, { sourceLine: lineNumber, eventType: "generation_output" });
  }
}

function appendFunctionMessages(messages: TraceMessage[], event: Record<string, unknown>, timestamp: string, lineNumber: number): number {
  const data = spanData(event);
  const name = stringValue(data.name) ?? stringValue(data.tool_name) ?? stringValue(data.toolName) ?? "openai_agents_tool";
  const input = objectText(data.input) ?? objectText(data.arguments);
  const output = objectText(data.output) ?? objectText(data.result);
  if (input) {
    addMessage(messages, "assistant", `Tool call ${name}: ${input}`, timestamp, { sourceLine: lineNumber, eventType: "tool_call" });
  }
  if (output) {
    addMessage(messages, "tool", output, timestamp, { sourceLine: lineNumber, eventType: "tool_output" }, name);
    return 1;
  }
  return 0;
}

export function normalizeOpenAIAgentsEvents(params: {
  captureId: string;
  commandRun?: LocalCommandRun;
  rawOutput: string;
  generatedAt?: string;
}): NormalizationResult {
  const generatedAt = params.generatedAt ?? new Date().toISOString();
  const events = parseJsonEvents(params.rawOutput);
  const warnings: string[] = [];
  const messages: TraceMessage[] = [];
  let toolOutputsCaptured = 0;

  if (events.length === 0) {
    warnings.push("No OpenAI Agents SDK-style JSON trace/span events were found in command output.");
  }

  addMessage(
    messages,
    "system",
    "OpenAI Agents SDK capture spike normalized local SDK-style trace/span events. ChatGPT app traces are not captured or scraped.",
    params.commandRun?.startedAt ?? generatedAt,
    { integration: "openai-agents", captureMode: "command wrapper" }
  );

  for (const event of events) {
    const timestamp = eventTimestamp(event.value, params.commandRun?.startedAt ?? generatedAt);
    const kind = eventKind(event.value);
    if (kind === "generation" || kind === "response" || kind === "llm") {
      appendGenerationMessages(messages, event.value, timestamp, event.lineNumber);
    } else if (kind === "function" || kind === "tool" || kind === "tool_call" || kind === "function_call") {
      toolOutputsCaptured += appendFunctionMessages(messages, event.value, timestamp, event.lineNumber);
    } else if (kind.includes("trace")) {
      const workflow = stringValue(event.value.workflow_name) ?? stringValue(event.value.name) ?? "OpenAI Agents SDK workflow";
      const sourceProvenance = toRecord(event.value.source_provenance) ?? toRecord(event.value.sourceProvenance);
      addMessage(messages, "system", `Trace started: ${workflow}`, timestamp, {
        sourceLine: event.lineNumber,
        eventType: kind,
        ...(sourceProvenance ? { sourceProvenance } : {})
      });
    }
  }

  if (messages.length === 1 && params.commandRun) {
    addMessage(messages, "tool", params.commandRun.rawOutput, params.commandRun.endedAt, { eventType: "raw_command_output" }, "command.output");
    toolOutputsCaptured += params.commandRun.rawOutput.length > 0 ? 1 : 0;
  }

  const tokenMetadataStatus = metadataStatus(events, hasTokenMetadata);
  const costMetadataStatus = metadataStatus(events, hasCostMetadata);
  const model = extractModel(events);
  const usageMetadata = aggregateUsageMetadata(events, model);
  const pricingAssumptions = usageMetadata.pricing_assumption ? [usageMetadata.pricing_assumption] : [];
  if (tokenMetadataStatus === "missing") warnings.push("Token metadata was missing from captured events and was not invented.");
  if (costMetadataStatus === "missing") warnings.push("Cost metadata was missing from captured events and was not invented.");

  return {
    trace: {
      id: extractTraceId(events, params.captureId),
      title: "OpenAI Agents SDK captured trace",
      artifactVersion: CURRENT_AGENT_TRACE_ARTIFACT_VERSION,
      source: "local_command",
      createdAt: params.commandRun?.startedAt ?? generatedAt,
      generatedAt,
      model,
      command: params.commandRun
        ? { command: params.commandRun.command.executable, args: params.commandRun.command.args, cwd: process.cwd() }
        : { command: "local-export", args: [], cwd: process.cwd() },
      durationMs: params.commandRun?.durationMs ?? 0,
      exitCode: params.commandRun?.exitCode ?? 0,
      messages
    },
    eventsCaptured: events.length,
    messagesCaptured: messages.filter((message) => ["system", "user", "assistant"].includes(message.role)).length,
    toolOutputsCaptured,
    tokenMetadataStatus,
    costMetadataStatus,
    usageMetadata,
    spendConfidence: usageMetadata.cost_confidence,
    pricingAssumptions,
    warnings,
    limitations: integrationLimitations
  };
}

function formatReportMarkdown(report: OpenAIAgentsCaptureReport): string {
  const list = (values: string[], empty: string) => (values.length === 0 ? `- ${empty}` : values.map((value) => `- ${value}`).join("\n"));
  return [
    "# OpenAI Agents SDK Capture Report",
    "",
    "## Summary",
    "",
    `- Status: ${report.status}`,
    `- Capture ID: ${report.capture_id}`,
    `- Integration: OpenAI Agents SDK`,
    `- Output trace ID: ${report.output_trace_id ?? "none"}`,
    "",
    "## Capture Mode",
    "",
    `- ${report.capture_mode}`,
    report.command_run ? `- Command: ${[report.command_run.command, ...report.command_run.args].join(" ")}` : "- Command: none",
    "",
    "## Trace Coverage",
    "",
    `- Events captured: ${report.events_captured}`,
    `- Messages captured: ${report.messages_captured}`,
    `- Tool outputs captured: ${report.tool_outputs_captured}`,
    "",
    "## Token and Cost Metadata",
    "",
    `- Token metadata: ${report.token_metadata_status}`,
    `- Cost metadata: ${report.cost_metadata_status}`,
    `- Spend confidence: ${report.spend_confidence}`,
    ...describeTokenMetadata(report.usage_metadata).map((line) => `- ${line}`),
    ...describeCostMetadata(report.usage_metadata).map((line) => `- ${line}`),
    "",
    "## Warnings",
    "",
    list(report.warnings, "No warnings."),
    "",
    "## Failures",
    "",
    list(report.failures, "No failures."),
    "",
    "## Recommended Next Command",
    "",
    report.recommended_next_command ? `\`${report.recommended_next_command}\`` : "No next command is recommended until capture succeeds.",
    "",
    "## Limitations",
    "",
    list(report.limitations, "No limitations recorded."),
    ""
  ].join("\n");
}

function terminalSummary(report: OpenAIAgentsCaptureReport, tracePath: string): string {
  return [
    "integration: OpenAI Agents SDK",
    `capture mode: ${report.capture_mode}`,
    `status: ${report.status}`,
    `events captured: ${report.events_captured}`,
    `messages captured: ${report.messages_captured}`,
    `tool outputs captured: ${report.tool_outputs_captured}`,
    `token metadata: ${report.token_metadata_status}`,
    `cost metadata: ${report.cost_metadata_status}`,
    `spend confidence: ${report.spend_confidence}`,
    ...describeTokenMetadata(report.usage_metadata),
    ...describeCostMetadata(report.usage_metadata),
    `normalized trace path: ${tracePath}`,
    `recommended next command: ${report.recommended_next_command ?? "none"}`,
    `limitations: ${report.limitations.join("; ")}`
  ].join("\n");
}

async function writeArtifacts(outputDirectory: string, trace: AgentTrace, report: OpenAIAgentsCaptureReport): Promise<OpenAIAgentsCaptureArtifacts> {
  await mkdir(outputDirectory, { recursive: true });
  const capturedTracePath = path.join(outputDirectory, "captured-trace.json");
  const captureReportJsonPath = path.join(outputDirectory, "capture-report.json");
  const captureReportMarkdownPath = path.join(outputDirectory, "capture-report.md");
  await writeFile(capturedTracePath, `${JSON.stringify(trace, null, 2)}\n`, "utf8");
  await writeFile(captureReportJsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(captureReportMarkdownPath, formatReportMarkdown(report), "utf8");
  return { report, trace, outputDirectory, paths: { capturedTracePath, captureReportJsonPath, captureReportMarkdownPath }, terminalSummary: terminalSummary(report, capturedTracePath) };
}

export async function captureOpenAIAgentsCommand(commandParts: string[], outRoot: string): Promise<OpenAIAgentsCaptureArtifacts> {
  const command: ParsedRunCommand = parseRunCommand(commandParts);
  const captureId = createOpenAIAgentsCaptureId();
  const run = await executeLocalCommand(command, captureId);
  const normalized = normalizeOpenAIAgentsEvents({ captureId, commandRun: run, rawOutput: run.rawOutput, generatedAt: run.endedAt });
  const outputDirectory = path.join(outRoot, captureId);
  const capturedTracePath = path.join(outputDirectory, "captured-trace.json");
  const failures = run.exitCode === 0 ? [] : [`Source command exited with code ${run.exitCode}.`];
  const status: CaptureStatus = failures.length > 0 ? "fail" : normalized.warnings.length > 0 ? "warn" : "pass";
  const report: OpenAIAgentsCaptureReport = {
    capture_id: captureId,
    generated_at: run.endedAt,
    integration: "openai-agents",
    capture_mode: "command wrapper",
    status,
    command_run: { command: run.command.executable, args: run.command.args, exit_code: run.exitCode, duration_ms: run.durationMs },
    output_trace_id: normalized.trace.id,
    events_captured: normalized.eventsCaptured,
    messages_captured: normalized.messagesCaptured,
    tool_outputs_captured: normalized.toolOutputsCaptured,
    token_metadata_status: normalized.tokenMetadataStatus,
    cost_metadata_status: normalized.costMetadataStatus,
    usage_metadata: normalized.usageMetadata,
    spend_confidence: normalized.spendConfidence,
    pricing_assumptions: normalized.pricingAssumptions,
    warnings: normalized.warnings,
    failures,
    limitations: normalized.limitations,
    recommended_next_command: `compaction analyze ${capturedTracePath}`
  };
  return writeArtifacts(outputDirectory, normalized.trace, report);
}

export async function captureOpenAIAgentsExport(inputPath: string, outRoot: string): Promise<OpenAIAgentsCaptureArtifacts> {
  const captureId = createOpenAIAgentsCaptureId();
  const rawOutput = await readFile(inputPath, "utf8");
  const generatedAt = new Date().toISOString();
  const normalized = normalizeOpenAIAgentsEvents({ captureId, rawOutput, generatedAt });
  const outputDirectory = path.join(outRoot, captureId);
  const capturedTracePath = path.join(outputDirectory, "captured-trace.json");
  const status: CaptureStatus = normalized.warnings.length > 0 ? "warn" : "pass";
  const report: OpenAIAgentsCaptureReport = {
    capture_id: captureId,
    generated_at: generatedAt,
    integration: "openai-agents",
    capture_mode: "local export",
    status,
    output_trace_id: normalized.trace.id,
    events_captured: normalized.eventsCaptured,
    messages_captured: normalized.messagesCaptured,
    tool_outputs_captured: normalized.toolOutputsCaptured,
    token_metadata_status: normalized.tokenMetadataStatus,
    cost_metadata_status: normalized.costMetadataStatus,
    usage_metadata: normalized.usageMetadata,
    spend_confidence: normalized.spendConfidence,
    pricing_assumptions: normalized.pricingAssumptions,
    warnings: normalized.warnings,
    failures: [],
    limitations: normalized.limitations,
    recommended_next_command: `compaction analyze ${capturedTracePath}`
  };
  return writeArtifacts(outputDirectory, normalized.trace, report);
}
