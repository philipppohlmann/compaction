import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assertTraceAdapterSource,
  getTraceAdapter,
  parseTraceAdapterRawContent,
  type TraceAdapterSource,
  type TraceAdapterStatus
} from "./trace-adapters.js";
import type { AgentTrace } from "./types.js";

export type TraceIntakeSource = TraceAdapterSource;
export type TraceIntakeStatus = TraceAdapterStatus;

/**
 * Filename for the normalized AgentTrace written by `import`. This deliberately matches the
 * `captured-trace.json` produced by every `capture` command so the documented follow-up chain
 * (`compaction analyze ./my-trace/captured-trace.json`, etc., printed by `compaction init`)
 * resolves identically whether the trace came from capture or import. Keeping the import output
 * name distinct from the capture output name previously broke the copy-pasteable init chain.
 */
export const IMPORTED_TRACE_FILENAME = "captured-trace.json";

export interface TraceIntakeReport {
  input_path: string;
  source: TraceIntakeSource;
  adapter_id: TraceIntakeSource;
  status: TraceIntakeStatus;
  generated_at: string;
  output_trace_id: string | null;
  message_count: number;
  supported_format_detected: boolean;
  warnings: string[];
  failures: string[];
  normalization_steps: string[];
  skipped_fields: string[];
  source_metadata: Record<string, unknown>;
  recommended_next_command: string | null;
}

export interface TraceIntakeArtifacts {
  report: TraceIntakeReport;
  normalizedTrace: AgentTrace | null;
  paths: {
    normalizedTracePath: string;
    intakeReportJsonPath: string;
    intakeReportMarkdownPath: string;
  };
}

function markdownList(values: string[], emptyText: string): string {
  if (values.length === 0) {
    return `- ${emptyText}`;
  }

  return values.map((value) => `- ${value}`).join("\n");
}

function formatMetadata(metadata: Record<string, unknown>): string {
  const entries = Object.entries(metadata);
  if (entries.length === 0) {
    return "- No source metadata.";
  }

  return entries.map(([key, value]) => `- ${key}: ${String(value)}`).join("\n");
}

function formatIntakeReportMarkdown(report: TraceIntakeReport): string {
  return [
    "# Trace Intake Report",
    "",
    "## Summary",
    "",
    `- Status: ${report.status}`,
    `- Supported format detected: ${report.supported_format_detected ? "yes" : "no"}`,
    `- Output trace ID: ${report.output_trace_id ?? "none"}`,
    `- Message count: ${report.message_count}`,
    `- Generated at: ${report.generated_at}`,
    "",
    "## Source",
    "",
    `- Input path: ${report.input_path}`,
    `- Requested source: ${report.source}`,
    `- Adapter: ${report.adapter_id}`,
    "",
    "## Source Metadata",
    "",
    formatMetadata(report.source_metadata),
    "",
    "## Normalization",
    "",
    markdownList(report.normalization_steps, "No normalization steps were applied."),
    "",
    "## Warnings",
    "",
    markdownList(report.warnings, "No warnings."),
    "",
    "## Failures",
    "",
    markdownList(report.failures, "No failures."),
    "",
    "## Recommended Next Command",
    "",
    report.recommended_next_command ? `\`${report.recommended_next_command}\`` : "No next command is recommended until intake succeeds.",
    "",
    "## Limitations",
    "",
    "- External Trace Intake v0 is local and file-based only.",
    "- Trace adapters are local file normalizers, not live runtime/provider integrations.",
    "- It does not upload data or call model/provider APIs.",
    "- Live provider/runtime integrations are future work; source-backed adapters read only local export files.",
    "- Codex exec JSONL support is limited to local files and does not launch Codex or call provider APIs.",
    "- Unsupported fields are preserved only when they fit the internal AgentTrace message metadata shape.",
    ""
  ].join("\n");
}

function buildReport(params: {
  inputPath: string;
  source: TraceIntakeSource;
  adapterId: TraceIntakeSource;
  status: TraceIntakeStatus;
  generatedAt: string;
  outputTraceId: string | null;
  messageCount: number;
  supportedFormatDetected: boolean;
  warnings: string[];
  failures: string[];
  normalizationSteps: string[];
  skippedFields: string[];
  sourceMetadata: Record<string, unknown>;
  normalizedTracePath: string;
}): TraceIntakeReport {
  return {
    input_path: params.inputPath,
    source: params.source,
    adapter_id: params.adapterId,
    status: params.status,
    generated_at: params.generatedAt,
    output_trace_id: params.outputTraceId,
    message_count: params.messageCount,
    supported_format_detected: params.supportedFormatDetected,
    warnings: params.warnings,
    failures: params.failures,
    normalization_steps: params.normalizationSteps,
    skipped_fields: params.skippedFields,
    source_metadata: params.sourceMetadata,
    recommended_next_command: params.status === "fail" ? null : `compaction analyze ${params.normalizedTracePath}`
  };
}

async function writeIntakeArtifacts(
  outputDirectory: string,
  report: TraceIntakeReport,
  normalizedTrace: AgentTrace | null
): Promise<TraceIntakeArtifacts> {
  await mkdir(outputDirectory, { recursive: true });

  const normalizedTracePath = path.join(outputDirectory, IMPORTED_TRACE_FILENAME);
  const intakeReportJsonPath = path.join(outputDirectory, "intake-report.json");
  const intakeReportMarkdownPath = path.join(outputDirectory, "intake-report.md");

  if (normalizedTrace) {
    await writeFile(normalizedTracePath, `${JSON.stringify(normalizedTrace, null, 2)}\n`, "utf8");
  }

  await writeFile(intakeReportJsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(intakeReportMarkdownPath, formatIntakeReportMarkdown(report), "utf8");

  return {
    report,
    normalizedTrace,
    paths: {
      normalizedTracePath,
      intakeReportJsonPath,
      intakeReportMarkdownPath
    }
  };
}

export interface ImportTraceOptions {
  // Explicit operator assertion of real local provenance (the `--operator-export`
  // flag on `compaction import`). Default false keeps imports at the weakest honest
  // tier (`fixture`); true elevates a Codex JSONL import to `imported_local`.
  operatorExport?: boolean;
}

export async function importTraceFile(
  inputPath: string,
  source: string,
  outputDirectory: string,
  options: ImportTraceOptions = {}
): Promise<TraceIntakeArtifacts> {
  assertTraceAdapterSource(source);

  const rawContent = await readFile(inputPath, "utf8");
  const generatedAt = new Date().toISOString();
  const normalizedTracePath = path.join(outputDirectory, IMPORTED_TRACE_FILENAME);
  const adapter = getTraceAdapter(source);

  const parsedInput = parseTraceAdapterRawContent(rawContent, source);
  if (parsedInput.failures.length > 0 || parsedInput.input === null) {
    const report = buildReport({
      inputPath,
      source,
      adapterId: adapter.id,
      status: "fail",
      generatedAt,
      outputTraceId: null,
      messageCount: 0,
      supportedFormatDetected: false,
      warnings: [],
      failures: parsedInput.failures,
      normalizationSteps: parsedInput.normalization_steps,
      skippedFields: [],
      sourceMetadata: {
        adapter_id: adapter.id,
        supported_source: adapter.supportedSource,
        local_file_normalizer: true,
        live_provider_integration: false,
        ...parsedInput.source_metadata
      },
      normalizedTracePath
    });
    return writeIntakeArtifacts(outputDirectory, report, null);
  }

  const result = adapter.normalize(parsedInput.input, { rawContent, operatorExport: options.operatorExport === true });
  const normalizedTrace = result.trace;
  const report = buildReport({
    inputPath,
    source,
    adapterId: adapter.id,
    status: result.status,
    generatedAt,
    outputTraceId: normalizedTrace?.id ?? null,
    messageCount: normalizedTrace?.messages.length ?? 0,
    supportedFormatDetected: normalizedTrace !== null,
    warnings: result.warnings,
    failures: result.failures,
    normalizationSteps: [...parsedInput.normalization_steps, ...result.normalization_steps],
    skippedFields: result.skipped_fields,
    sourceMetadata: { ...parsedInput.source_metadata, ...result.source_metadata },
    normalizedTracePath
  });

  return writeIntakeArtifacts(outputDirectory, report, result.status === "fail" ? null : normalizedTrace);
}
