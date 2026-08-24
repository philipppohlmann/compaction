import { createHash } from "node:crypto";
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

export type AdapterValidationSource = TraceAdapterSource;
export type AdapterValidationStatus = TraceAdapterStatus;

export interface AdapterValidationReport {
  validation_id: string;
  generated_at: string;
  input_path: string;
  source: AdapterValidationSource;
  adapter_id: AdapterValidationSource;
  status: AdapterValidationStatus;
  output_trace_id: string | null;
  message_count: number;
  supported_format_detected: boolean;
  warnings: string[];
  failures: string[];
  normalization_steps: string[];
  skipped_fields: string[];
  limitations: string[];
  recommended_next_command: string | null;
}

export interface AdapterValidationArtifacts {
  report: AdapterValidationReport;
  normalizedTrace: AgentTrace | null;
  paths: {
    outputDirectory: string;
    normalizedTracePath: string;
    validationReportJsonPath: string;
    validationReportMarkdownPath: string;
  };
}

const adapterValidationRoot = path.join(".compaction", "adapter-validations");

const validationHarnessLimitations = [
  "Adapter Fixture Harness v0 is local and file-based only.",
  "It validates exported or synthetic fixture files through the existing adapter contract and registry.",
  "It does not mutate the source fixture file.",
  "It does not upload data or call model/provider APIs.",
  "It is not a live Claude Code, Codex, Cursor, OpenAI, Anthropic, LangChain, GitHub, or provider/runtime integration.",
  "Codex exec JSONL support validates local export files only; live provider/runtime integrations remain future work."
];

function markdownList(values: string[], emptyText: string): string {
  if (values.length === 0) {
    return `- ${emptyText}`;
  }

  return values.map((value) => `- ${value}`).join("\n");
}

function buildValidationId(inputPath: string, source: AdapterValidationSource, generatedAt: string, rawContent: string): string {
  const digest = createHash("sha256").update(`${inputPath}\n${source}\n${generatedAt}\n${rawContent}`).digest("hex").slice(0, 10);
  const timestamp = generatedAt.replace(/[-:.]/g, "").replace("T", "-").replace("Z", "");
  return `adapter-validation-${timestamp}-${digest}`;
}

function formatAdapterValidationMarkdown(report: AdapterValidationReport): string {
  return [
    "# Adapter Validation Report",
    "",
    "## Summary",
    "",
    `- Validation ID: ${report.validation_id}`,
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
    "",
    "## Adapter",
    "",
    `- Adapter ID: ${report.adapter_id}`,
    "- Adapter selected from the local trace adapter registry.",
    "- Live provider/runtime integration: no",
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
    report.recommended_next_command ? `\`${report.recommended_next_command}\`` : "No next command is recommended until validation succeeds.",
    "",
    "## Limitations",
    "",
    markdownList(report.limitations, "No limitations recorded."),
    ""
  ].join("\n");
}

function buildReport(params: {
  validationId: string;
  generatedAt: string;
  inputPath: string;
  source: AdapterValidationSource;
  adapterId: AdapterValidationSource;
  status: AdapterValidationStatus;
  outputTraceId: string | null;
  messageCount: number;
  supportedFormatDetected: boolean;
  warnings: string[];
  failures: string[];
  normalizationSteps: string[];
  skippedFields: string[];
  limitations: string[];
  normalizedTracePath: string;
}): AdapterValidationReport {
  return {
    validation_id: params.validationId,
    generated_at: params.generatedAt,
    input_path: params.inputPath,
    source: params.source,
    adapter_id: params.adapterId,
    status: params.status,
    output_trace_id: params.outputTraceId,
    message_count: params.messageCount,
    supported_format_detected: params.supportedFormatDetected,
    warnings: params.warnings,
    failures: params.failures,
    normalization_steps: params.normalizationSteps,
    skipped_fields: params.skippedFields,
    limitations: params.limitations,
    recommended_next_command: params.status === "fail" ? null : `compaction analyze ${params.normalizedTracePath}`
  };
}

async function writeAdapterValidationArtifacts(
  outputDirectory: string,
  report: AdapterValidationReport,
  normalizedTrace: AgentTrace | null
): Promise<AdapterValidationArtifacts> {
  await mkdir(outputDirectory, { recursive: true });

  const normalizedTracePath = path.join(outputDirectory, "normalized-trace.json");
  const validationReportJsonPath = path.join(outputDirectory, "adapter-validation.json");
  const validationReportMarkdownPath = path.join(outputDirectory, "adapter-validation.md");

  if (normalizedTrace) {
    await writeFile(normalizedTracePath, `${JSON.stringify(normalizedTrace, null, 2)}\n`, "utf8");
  }

  await writeFile(validationReportJsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(validationReportMarkdownPath, formatAdapterValidationMarkdown(report), "utf8");

  return {
    report,
    normalizedTrace,
    paths: {
      outputDirectory,
      normalizedTracePath,
      validationReportJsonPath,
      validationReportMarkdownPath
    }
  };
}

export async function validateAdapterFixtureFile(
  inputPath: string,
  source: string,
  outputRoot: string = adapterValidationRoot
): Promise<AdapterValidationArtifacts> {
  assertTraceAdapterSource(source);

  const rawContent = await readFile(inputPath, "utf8");
  const generatedAt = new Date().toISOString();
  const validationId = buildValidationId(inputPath, source, generatedAt, rawContent);
  const outputDirectory = path.join(outputRoot, validationId);
  const normalizedTracePath = path.join(outputDirectory, "normalized-trace.json");
  const adapter = getTraceAdapter(source);
  const limitations = [...validationHarnessLimitations, ...adapter.limitations];

  const parsedInput = parseTraceAdapterRawContent(rawContent, source);
  if (parsedInput.failures.length > 0 || parsedInput.input === null) {
    const report = buildReport({
      validationId,
      generatedAt,
      inputPath,
      source,
      adapterId: adapter.id,
      status: "fail",
      outputTraceId: null,
      messageCount: 0,
      supportedFormatDetected: false,
      warnings: [],
      failures: parsedInput.failures,
      normalizationSteps: [...parsedInput.normalization_steps, "Skipped adapter canHandle and normalize because the fixture could not be parsed."],
      skippedFields: [],
      limitations,
      normalizedTracePath
    });
    return writeAdapterValidationArtifacts(outputDirectory, report, null);
  }

  const normalizationSteps = [...parsedInput.normalization_steps, `Selected adapter ${adapter.id} from the local adapter registry.`];
  const canHandle = adapter.canHandle(parsedInput.input);
  normalizationSteps.push(`Ran adapter canHandle for source ${source}: ${canHandle ? "supported" : "unsupported"}.`);

  if (!canHandle) {
    const report = buildReport({
      validationId,
      generatedAt,
      inputPath,
      source,
      adapterId: adapter.id,
      status: "fail",
      outputTraceId: null,
      messageCount: 0,
      supportedFormatDetected: false,
      warnings: [],
      failures: [`Adapter ${adapter.id} cannot handle this fixture shape for source ${source}.`],
      normalizationSteps: [...normalizationSteps, "Skipped normalize because canHandle returned false."],
      skippedFields: [],
      limitations,
      normalizedTracePath
    });
    return writeAdapterValidationArtifacts(outputDirectory, report, null);
  }

  const result = adapter.normalize(parsedInput.input, { rawContent });
  const normalizedTrace = result.status === "fail" ? null : result.trace;
  const report = buildReport({
    validationId,
    generatedAt,
    inputPath,
    source,
    adapterId: adapter.id,
    status: result.status,
    outputTraceId: normalizedTrace?.id ?? null,
    messageCount: normalizedTrace?.messages.length ?? 0,
    supportedFormatDetected: result.trace !== null,
    warnings: result.warnings,
    failures: result.failures,
    normalizationSteps: [...normalizationSteps, "Ran adapter normalize for the local fixture.", ...result.normalization_steps],
    skippedFields: result.skipped_fields,
    limitations,
    normalizedTracePath
  });

  return writeAdapterValidationArtifacts(outputDirectory, report, normalizedTrace);
}
