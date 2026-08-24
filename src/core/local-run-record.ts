/**
 * Local per-run token_source records for the unified `compaction run` flow (public CLI/SDK -
 * engine-free). Each record is an additive local JSON file
 * embedding the existing `RunFlowTokenReport` shape unchanged. No network, no hosted config.
 *
 * Content-free invariant: counts + sources only, no prompt/output text, no filenames from the
 * wrapped command, no cost figures, and never a savings figure for output (observed output tokens
 * are tokens, not savings; output-token savings stay gated on measured + eval-confirmed
 * output-shaping).
 *
 * The per-tool rollup mirrors the `/app` source-status contract tiers exactly: live
 * (provider-reported) / estimated
 * (local-estimate) / unavailable, <reason> / no records yet. `output_savings` is the literal
 * string "unavailable".
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonArtifact } from "./artifact-writer.js";
import type { CrossSurfaceEvent } from "./cross-surface-event.js";
import type { RunFlowTokenReport, RunFlowTokenSource } from "./run-flow-report.js";

/** Default local accumulation directory (sibling of `.compaction/runs`; flat, one file per run). */
export const DEFAULT_RUN_RECORDS_DIRECTORY = ".compaction/run-records";

/** File name of the per-run copy written next to the run's other artifacts. */
export const RUN_TOKEN_RECORD_FILENAME = "run-token-record.json";

/** Source-status contract copy, tier labels, verbatim. */
export const TIER_LIVE_LABEL = "live (provider-reported)";
export const TIER_ESTIMATED_LABEL = "estimated (local-estimate)";
/** Contract copy, the literal output-savings line every tool renders in v1 (no tool has passed the gate). */
export const OUTPUT_SAVINGS_UNAVAILABLE_LINE =
  "output-token savings: unavailable - needs a provider-reported A/B that passes the measured criterion + the short-but-sufficient eval.";

/**
 * One persisted local run record. `token_report` is the EXISTING `RunFlowTokenReport` shape, embedded
 * unchanged (no schema migration, additive file, reused record shape).
 */
export interface LocalRunTokenRecord {
  record_version: 1;
  run_id: string;
  recorded_at: string;
  token_report: RunFlowTokenReport;
  /**
   * Additive, optional cross-surface event (typed in `src/core/cross-surface-event.ts`). When present it rides through write/read/rollup
   * untouched; its validation is the report-only `validateCrossSurfaceEvent`, so an imperfect
   * event never causes the record to be skipped.
   */
  cross_surface_event?: CrossSurfaceEvent;
}

export function buildLocalRunTokenRecord(params: {
  runId: string;
  tokenReport: RunFlowTokenReport;
  recordedAt?: string;
  /** Optional additive cross-surface event (see `LocalRunTokenRecord.cross_surface_event`). */
  crossSurfaceEvent?: CrossSurfaceEvent;
}): LocalRunTokenRecord {
  return {
    record_version: 1,
    run_id: params.runId,
    recorded_at: params.recordedAt ?? new Date().toISOString(),
    token_report: params.tokenReport,
    ...(params.crossSurfaceEvent !== undefined ? { cross_surface_event: params.crossSurfaceEvent } : {})
  };
}

const TOKEN_SOURCES: readonly RunFlowTokenSource[] = ["provider-reported", "local-estimate", "unavailable"];

function isTokenSource(value: unknown): value is RunFlowTokenSource {
  return typeof value === "string" && (TOKEN_SOURCES as readonly string[]).includes(value);
}

function isOptionalCount(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}

/** Validate a parsed record. Invalid records are SKIPPED with a reason, never guessed at. */
export function validateLocalRunTokenRecord(value: unknown): { record?: LocalRunTokenRecord; reason?: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { reason: "record is not a JSON object" };
  }
  const record = value as Record<string, unknown>;
  if (record.record_version !== 1) return { reason: "unsupported record_version" };
  if (typeof record.run_id !== "string" || record.run_id.trim() === "") return { reason: "missing or invalid run_id" };
  if (typeof record.recorded_at !== "string" || record.recorded_at.trim() === "") {
    return { reason: "missing or invalid recorded_at" };
  }
  const report = record.token_report as Record<string, unknown> | undefined;
  if (typeof report !== "object" || report === null || Array.isArray(report)) {
    return { reason: "missing or invalid token_report" };
  }
  if (typeof report.tool !== "string" || report.tool.trim() === "") return { reason: "missing or invalid token_report.tool" };
  if (!isTokenSource(report.input_token_source)) return { reason: "invalid token_report.input_token_source" };
  if (!isTokenSource(report.output_token_source)) return { reason: "invalid token_report.output_token_source" };
  if (!isOptionalCount(report.input_tokens)) return { reason: "invalid token_report.input_tokens" };
  if (!isOptionalCount(report.output_tokens)) return { reason: "invalid token_report.output_tokens" };
  if (report.input_reduction_label !== "measured" && report.input_reduction_label !== "estimated") {
    return { reason: "invalid token_report.input_reduction_label" };
  }
  if (!Array.isArray(report.notes) || report.notes.some((note) => typeof note !== "string")) {
    return { reason: "invalid token_report.notes" };
  }
  return { record: record as unknown as LocalRunTokenRecord };
}

export interface WrittenRunRecordPaths {
  /** The copy next to the run's other artifacts (self-contained artifact set). */
  artifactPath: string;
  /** The accumulated copy `compaction summary` rolls up. */
  accumulatedPath: string;
}

function accumulationFileName(runId: string): string {
  return `${runId.replace(/[^A-Za-z0-9._-]/g, "-")}.json`;
}

/**
 * Persist the record LOCALLY, twice: once next to the run's artifacts (`run-token-record.json` in the
 * run's output directory) and once in the flat accumulation directory so `summary` can roll runs up
 * without scanning arbitrary --out locations. Local file writes only - never a network call.
 */
export async function writeLocalRunTokenRecord(
  record: LocalRunTokenRecord,
  artifactDirectory: string,
  recordsDirectory: string = DEFAULT_RUN_RECORDS_DIRECTORY
): Promise<WrittenRunRecordPaths> {
  const artifactPath = await writeJsonArtifact(artifactDirectory, RUN_TOKEN_RECORD_FILENAME, record);
  const accumulatedPath = await writeJsonArtifact(recordsDirectory, accumulationFileName(record.run_id), record);
  return { artifactPath, accumulatedPath };
}

export interface SkippedRunRecordFile {
  path: string;
  reason: string;
}

export interface LoadedRunRecord {
  path: string;
  record: LocalRunTokenRecord;
}

/** Read all accumulated records. A missing directory means "no records yet" (empty, not an error). */
export async function readLocalRunTokenRecords(
  recordsDirectory: string = DEFAULT_RUN_RECORDS_DIRECTORY
): Promise<{ records: LoadedRunRecord[]; skipped: SkippedRunRecordFile[] }> {
  let fileNames: string[];
  try {
    const entries = await readdir(recordsDirectory, { withFileTypes: true });
    fileNames = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name)
      .sort();
  } catch (error: unknown) {
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "unknown";
    if (code === "ENOENT") return { records: [], skipped: [] };
    throw error;
  }

  const records: LoadedRunRecord[] = [];
  const skipped: SkippedRunRecordFile[] = [];
  for (const fileName of fileNames) {
    const path = join(recordsDirectory, fileName);
    try {
      const validation = validateLocalRunTokenRecord(JSON.parse(await readFile(path, "utf8")) as unknown);
      if (validation.record === undefined) {
        skipped.push({ path, reason: validation.reason ?? "invalid record" });
        continue;
      }
      records.push({ path, record: validation.record });
    } catch (error: unknown) {
      skipped.push({ path, reason: error instanceof SyntaxError ? "invalid JSON" : "could not read record" });
    }
  }
  return { records, skipped };
}

/** Per-axis tier buckets (mirrors the contract tiers). Tokens are summed ONLY within their own tier. */
export interface PerToolAxisRollup {
  provider_reported: { runs: number; tokens: number };
  local_estimate: { runs: number; tokens: number };
  /** Runs where this axis could not be counted honestly - with the honest reasons (never a 0). */
  unavailable: { runs: number; reasons: string[] };
}

export interface PerToolRunRecordRollup {
  tool: string;
  runs: number;
  input: PerToolAxisRollup;
  output: PerToolAxisRollup;
  /** LITERAL contract value: no tool has passed the measured + eval-confirmed output-shaping gate. */
  output_savings: "unavailable";
  /** Distinct honest notes carried from the runs' capture limitations (content-free, capped). */
  notes: string[];
}

const MAX_ROLLUP_NOTES = 8;
const AXIS_UNAVAILABLE_FALLBACK_REASON = "not safely separable / not reported";

function emptyAxis(): PerToolAxisRollup {
  return {
    provider_reported: { runs: 0, tokens: 0 },
    local_estimate: { runs: 0, tokens: 0 },
    unavailable: { runs: 0, reasons: [] }
  };
}

function addDistinctCapped(list: string[], value: string, cap: number): void {
  if (list.length < cap && !list.includes(value)) list.push(value);
}

function addToAxis(
  axis: PerToolAxisRollup,
  axisName: "input" | "output",
  source: RunFlowTokenSource,
  tokens: number | undefined,
  notes: string[]
): void {
  // A count lands in a tier only when the source is that tier AND a real count exists.
  // A missing count - whatever the claimed source - is `unavailable`, never a silent zero.
  if (source === "provider-reported" && tokens !== undefined) {
    axis.provider_reported.runs += 1;
    axis.provider_reported.tokens += tokens;
    return;
  }
  if (source === "local-estimate" && tokens !== undefined) {
    axis.local_estimate.runs += 1;
    axis.local_estimate.tokens += tokens;
    return;
  }
  axis.unavailable.runs += 1;
  // Prefer the notes that actually talk about THIS axis (e.g. the output-unavailable reason for the
  // output axis) so the displayed reason is the honest one; fall back to all notes, then the generic.
  const axisNotes = notes.filter((note) => note.toLowerCase().includes(axisName));
  const reasons = axisNotes.length > 0 ? axisNotes : notes.length > 0 ? notes : [AXIS_UNAVAILABLE_FALLBACK_REASON];
  for (const reason of reasons) addDistinctCapped(axis.unavailable.reasons, reason, MAX_ROLLUP_NOTES);
}

/**
 * Roll accumulated records up per tool (pure). Counts + sources only - no cost, no savings math,
 * no content. Tools are sorted for deterministic output. `output_savings` is always the literal
 * "unavailable" (no tool has measured + eval-confirmed output-shaping evidence).
 */
export function summarizePerToolRunRecords(records: LocalRunTokenRecord[]): PerToolRunRecordRollup[] {
  const byTool = new Map<string, PerToolRunRecordRollup>();
  for (const record of records) {
    const report = record.token_report;
    let rollup = byTool.get(report.tool);
    if (rollup === undefined) {
      rollup = { tool: report.tool, runs: 0, input: emptyAxis(), output: emptyAxis(), output_savings: "unavailable", notes: [] };
      byTool.set(report.tool, rollup);
    }
    rollup.runs += 1;
    addToAxis(rollup.input, "input", report.input_token_source, report.input_tokens, report.notes);
    addToAxis(rollup.output, "output", report.output_token_source, report.output_tokens, report.notes);
    for (const note of report.notes) addDistinctCapped(rollup.notes, note, MAX_ROLLUP_NOTES);
  }
  return [...byTool.values()].sort((a, b) => a.tool.localeCompare(b.tool));
}

function axisParts(axis: PerToolAxisRollup): string[] {
  const parts: string[] = [];
  if (axis.provider_reported.runs > 0) {
    parts.push(`${axis.provider_reported.tokens} tokens ${TIER_LIVE_LABEL} across ${axis.provider_reported.runs} run(s)`);
  }
  if (axis.local_estimate.runs > 0) {
    parts.push(`${axis.local_estimate.tokens} tokens ${TIER_ESTIMATED_LABEL} across ${axis.local_estimate.runs} run(s)`);
  }
  if (axis.unavailable.runs > 0) {
    const reason = axis.unavailable.reasons[0] ?? AXIS_UNAVAILABLE_FALLBACK_REASON;
    parts.push(`unavailable for ${axis.unavailable.runs} run(s) - ${reason}`);
  }
  return parts.length > 0 ? parts : [`unavailable - ${AXIS_UNAVAILABLE_FALLBACK_REASON}`];
}

/** Header stating exactly what this section is (and is not) - printed above the per-tool lines. */
export const PER_TOOL_RECORDS_HEADER =
  "Per-tool run records (local, content-free): observed token counts + their token_source per axis; " +
  "input and output separate; output shown as tokens, never as a savings figure.";

/** The honest empty state - never fabricated rows for tools that have no records. */
export const PER_TOOL_RECORDS_EMPTY_LINE =
  "- none yet - `compaction run …` / `run codex` / `run cursor` accumulate per-run token_source records locally";

/**
 * Render the per-tool rollup as indented list lines (shared by the console summary and summary.md).
 * Copy mirrors the `/app` source-status contract: live (provider-reported) / estimated (local-estimate) /
 * unavailable - <reason>; plus the literal output-savings unavailable line for EVERY tool.
 */
export function formatPerToolRunRecordLines(rollups: PerToolRunRecordRollup[]): string[] {
  if (rollups.length === 0) return [PER_TOOL_RECORDS_EMPTY_LINE];
  const lines: string[] = [];
  for (const rollup of rollups) {
    lines.push(`- ${rollup.tool}: ${rollup.runs} run(s)`);
    lines.push(`  - input: ${axisParts(rollup.input).join("; ")}`);
    lines.push(`  - output: ${axisParts(rollup.output).join("; ")}`);
    lines.push(`  - ${OUTPUT_SAVINGS_UNAVAILABLE_LINE}`);
    for (const note of rollup.notes) lines.push(`  - note: ${note}`);
  }
  return lines;
}
