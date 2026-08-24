import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DEFAULT_RUN_RECORDS_DIRECTORY,
  formatPerToolRunRecordLines,
  PER_TOOL_RECORDS_HEADER,
  readLocalRunTokenRecords,
  summarizePerToolRunRecords,
  type PerToolRunRecordRollup
} from "./local-run-record.js";
import { classifyDistinctness, type DistinctnessRecord } from "./trace-fingerprint.js";
import type { CompactionReport, WasteFinding } from "./types.js";

/**
 * Duplicate-safety summary for the `summary` rollup, by content fingerprint. A count of DISTINCT
 * captured runs, NOT a billing/provider/semantic claim. A run captured/aggregated twice with the
 * SAME fingerprint is counted once in the headline so summed savings are never inflated; a run
 * WITHOUT a fingerprint cannot be de-duplicated and is counted as distinct.
 */
export interface RunDistinctnessSummary {
  total_runs: number;
  distinct_runs: number;
  duplicate_runs: number;
  runs_with_fingerprint: number;
  runs_without_fingerprint: number;
}

export interface RunSummaryBucket {
  total_runs: number;
  total_original_input_tokens: number;
  total_compacted_input_tokens: number;
  total_tokens_saved: number;
  total_cost_before_per_run: number;
  total_cost_after_per_run: number;
  total_saving_per_run: number;
}

export interface TopSavingsRun {
  run_id: string;
  trace_title: string;
  report_path: string;
  tokens_saved: number;
  percent_reduction: number;
  saving_per_run: number;
  policy_name: string;
  waste_pattern: WasteFinding["category"] | null;
}

export interface SkippedReportFile {
  path: string;
  reason: string;
}

/**
 * V0.2 Increment 2, the MEASURED-across-distinct-runs estimate delta. Aggregates the per-run
 * estimate reductions over N DISTINCT runs (dedup by content fingerprint) into a mean + dispersion,
 * and applies the accepted criterion: **N ≥ 3 distinct runs
 * AND the mean ±2·SE interval excludes zero**. When BOTH hold, the figure earns the
 * `measured_caveated_estimate_delta` rung (claims-and-evidence-ladder rung 1.5), a measured
 * estimate, NOT a single anecdote. Below the bar it stays rung 1 (`local_estimate_single_run`).
 *
 * It is STILL an estimate (chars/4 + price-table): explicitly NOT `provider-reported`, NOT
 * eval-backed (rung 3), and NEVER `billing-confirmed` (rung 5). No time-period extrapolation.
 */
export interface MeasuredEstimateDelta {
  /** N distinct runs used (≥3 required to qualify). */
  distinct_run_count: number;
  /** Mean per-run percent reduction across the distinct runs (estimate). */
  mean_percent_reduction: number;
  /** Standard error of the mean percent reduction (0 when N<2, no dispersion). */
  std_error: number;
  /** Lower / upper bound of the mean ±2·SE interval. */
  ci_low: number;
  ci_high: number;
  /** Does the ±2·SE interval exclude zero (lower bound > 0)? */
  excludes_zero: boolean;
  /** Criterion met: N≥3 AND the ±2·SE interval excludes zero. */
  qualifies: boolean;
  /** The claims-ladder rung this aggregate stands on. */
  evidence_rung: "measured_caveated_estimate_delta" | "local_estimate_single_run";
  /** One-line honest label, estimate-class, never billing-confirmed, never eval-backed. */
  label: string;
}

export interface RunSummary extends RunSummaryBucket {
  average_percent_reduction: number;
  /**
   * V0.2 measured-across-distinct-runs estimate delta (the "measured" rung). Mean ±2·SE over the
   * distinct runs' estimate reductions; `qualifies` only when N≥3 AND the interval excludes zero.
   * Estimate-class, never billing-confirmed, never eval-backed.
   */
  measured_estimate_delta: MeasuredEstimateDelta;
  savings_by_policy: Record<string, RunSummaryBucket>;
  savings_by_waste_pattern: Record<string, RunSummaryBucket>;
  top_savings_runs: TopSavingsRun[];
  skipped_files: SkippedReportFile[];
  /**
   * Duplicate-safety summary: the headline totals above are summed over DISTINCT runs only (a
   * run captured/aggregated twice with the same content fingerprint is counted once), so savings
   * are never inflated. Runs without a fingerprint are each counted as distinct.
   */
  distinctness: RunDistinctnessSummary;
  /**
   * ADDITIVE (unified-run-flow LOCAL layer, 2026-07-02): per-tool rollup of the locally accumulated
   * per-run token_source records (`.compaction/run-records/*.json`). Observed token COUNTS + their
   * honest per-axis `token_source` tiers ONLY -
   * no cost figures, and `output_savings` is the LITERAL "unavailable" for every tool (gated).
   */
  per_tool_token_records: PerToolRunRecordRollup[];
  run_records_source_glob: string;
  run_record_skipped_files: SkippedReportFile[];
  generated_at: string;
  source_glob: string;
}

interface LoadedReport {
  path: string;
  report: CompactionReport;
}

const REQUIRED_STRING_FIELDS = ["run_id", "trace_title", "policy_name"] as const;
const REQUIRED_NUMBER_FIELDS = [
  "original_input_tokens",
  "compacted_input_tokens",
  "tokens_saved",
  "percent_reduction",
  "cost_before_per_run",
  "cost_after_per_run",
  "saving_per_run"
] as const;

function emptyBucket(): RunSummaryBucket {
  return {
    total_runs: 0,
    total_original_input_tokens: 0,
    total_compacted_input_tokens: 0,
    total_tokens_saved: 0,
    total_cost_before_per_run: 0,
    total_cost_after_per_run: 0,
    total_saving_per_run: 0
  };
}

function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

/** Minimum DISTINCT runs for a measured (not single-anecdote) estimate delta. */
export const MIN_RUNS_FOR_MEASURED_DELTA = 3;

/**
 * Compute the measured-across-distinct-runs estimate delta over a set of per-run percent
 * reductions (PURE). Applies the accepted criterion: N ≥ 3 AND the mean ±2·SE interval excludes
 * zero. Estimate-class only, the result is NEVER billing-confirmed or eval-backed. Uses the
 * sample standard deviation (n−1); with n<2 there is no dispersion (SE 0) so it cannot qualify.
 */
export function computeMeasuredEstimateDelta(percentReductions: number[]): MeasuredEstimateDelta {
  const n = percentReductions.length;
  const mean = n === 0 ? 0 : percentReductions.reduce((sum, x) => sum + x, 0) / n;
  let se = 0;
  if (n >= 2) {
    const variance = percentReductions.reduce((sum, x) => sum + (x - mean) ** 2, 0) / (n - 1);
    se = Math.sqrt(variance) / Math.sqrt(n);
  }
  const ciLow = mean - 2 * se;
  const ciHigh = mean + 2 * se;
  const excludesZero = ciLow > 0;
  const qualifies = n >= MIN_RUNS_FOR_MEASURED_DELTA && excludesZero;
  const meanR = roundTo(mean, 2);
  const lowR = roundTo(ciLow, 2);
  const highR = roundTo(ciHigh, 2);

  let label: string;
  if (qualifies) {
    label =
      `Measured-caveated ESTIMATE delta across ${n} distinct runs: mean ${meanR}% reduction ` +
      `(±2·SE [${lowR}%, ${highR}%], excludes zero). Estimate (chars/4 + price-table) - ` +
      "NOT billing-confirmed, NOT eval-backed, NOT realized savings, NOT extrapolated.";
  } else if (n < MIN_RUNS_FOR_MEASURED_DELTA) {
    label =
      `Single-run/anecdote estimate (${n} distinct run(s); need ≥${MIN_RUNS_FOR_MEASURED_DELTA} ` +
      "for a measured delta). Local estimate - NOT billing-confirmed.";
  } else {
    label =
      `Estimate delta across ${n} distinct runs does NOT meet the measured bar ` +
      `(±2·SE [${lowR}%, ${highR}%] includes zero - dispersion too wide). Local estimate - NOT billing-confirmed.`;
  }

  return {
    distinct_run_count: n,
    mean_percent_reduction: meanR,
    std_error: roundTo(se, 4),
    ci_low: lowR,
    ci_high: highR,
    excludes_zero: excludesZero,
    qualifies,
    evidence_rung: qualifies ? "measured_caveated_estimate_delta" : "local_estimate_single_run",
    label
  };
}

/** Read the OPTIONAL content fingerprint digest from a report (older reports have none). */
function fingerprintDigestOf(report: CompactionReport): string | null {
  const fp = report.trace_fingerprint;
  return fp && typeof fp.content_sha256 === "string" && fp.content_sha256.length > 0 ? fp.content_sha256 : null;
}

/**
 * De-duplicate loaded reports by content fingerprint for a duplicate-safe headline.
 *
 * Keeps the FIRST report per distinct fingerprint; later same-fingerprint reports are duplicates
 * and are dropped from the totals so a re-captured run never double-counts its savings. Reports
 * without a fingerprint are each kept (cannot dedup what cannot be identified). PURE; never
 * inflates savings.
 */
function dedupeReportsByFingerprint(reports: LoadedReport[]): {
  distinctReports: LoadedReport[];
  distinctness: RunDistinctnessSummary;
} {
  const seen = new Set<string>();
  const distinctReports: LoadedReport[] = [];
  let withFingerprint = 0;
  let withoutFingerprint = 0;

  for (const loaded of reports) {
    const fp = fingerprintDigestOf(loaded.report);
    if (fp !== null) {
      withFingerprint += 1;
      if (seen.has(fp)) continue;
      seen.add(fp);
      distinctReports.push(loaded);
    } else {
      withoutFingerprint += 1;
      distinctReports.push(loaded);
    }
  }

  const classified = classifyDistinctness(
    reports.map((loaded): DistinctnessRecord => ({ runId: loaded.report.run_id, content_sha256: fingerprintDigestOf(loaded.report) }))
  );
  const distinctRunCount = classified.distinct_verified_count + withoutFingerprint;

  return {
    distinctReports,
    distinctness: {
      total_runs: reports.length,
      distinct_runs: distinctRunCount,
      duplicate_runs: reports.length - distinctRunCount,
      runs_with_fingerprint: withFingerprint,
      runs_without_fingerprint: withoutFingerprint
    }
  };
}

function addReportToBucket(bucket: RunSummaryBucket, report: CompactionReport): void {
  bucket.total_runs += 1;
  bucket.total_original_input_tokens += report.original_input_tokens;
  bucket.total_compacted_input_tokens += report.compacted_input_tokens;
  bucket.total_tokens_saved += report.tokens_saved;
  bucket.total_cost_before_per_run += report.cost_before_per_run;
  bucket.total_cost_after_per_run += report.cost_after_per_run;
  bucket.total_saving_per_run += report.saving_per_run;
}

function normalizeBucket(bucket: RunSummaryBucket): void {
  bucket.total_cost_before_per_run = roundTo(bucket.total_cost_before_per_run, 6);
  bucket.total_cost_after_per_run = roundTo(bucket.total_cost_after_per_run, 6);
  bucket.total_saving_per_run = roundTo(bucket.total_saving_per_run, 6);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function validateCompactionReport(value: unknown): { report?: CompactionReport; reason?: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { reason: "report is not a JSON object" };
  }

  const report = value as Record<string, unknown>;

  for (const field of REQUIRED_STRING_FIELDS) {
    if (typeof report[field] !== "string" || report[field].trim() === "") {
      return { reason: `missing or invalid ${field}` };
    }
  }

  for (const field of REQUIRED_NUMBER_FIELDS) {
    if (!isFiniteNumber(report[field])) {
      return { reason: `missing or invalid ${field}` };
    }
  }

  if (report.waste_pattern !== null && report.waste_pattern !== undefined && typeof report.waste_pattern !== "string") {
    return { reason: "missing or invalid waste_pattern" };
  }

  return { report: report as unknown as CompactionReport };
}

async function findReportPaths(runsDirectory: string): Promise<string[]> {
  try {
    const entries = await readdir(runsDirectory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(runsDirectory, entry.name, "report.json"))
      .sort();
  } catch (error: unknown) {
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "unknown";
    if (code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

export async function readCompactionRunReports(runsDirectory = ".compaction/runs"): Promise<{
  reports: LoadedReport[];
  skippedFiles: SkippedReportFile[];
}> {
  const reportPaths = await findReportPaths(runsDirectory);
  const reports: LoadedReport[] = [];
  const skippedFiles: SkippedReportFile[] = [];

  for (const reportPath of reportPaths) {
    try {
      const parsed = JSON.parse(await readFile(reportPath, "utf8")) as unknown;
      const validation = validateCompactionReport(parsed);

      if (validation.report === undefined) {
        skippedFiles.push({ path: reportPath, reason: validation.reason ?? "invalid report" });
        continue;
      }

      reports.push({ path: reportPath, report: validation.report });
    } catch (error: unknown) {
      const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : null;
      const reason = code === "ENOENT" ? "report.json not found" : error instanceof SyntaxError ? "invalid JSON" : "could not read report";
      skippedFiles.push({ path: reportPath, reason });
    }
  }

  return { reports, skippedFiles };
}

export function aggregateCompactionReports(
  reports: LoadedReport[],
  skippedFiles: SkippedReportFile[] = [],
  generatedAt = new Date().toISOString(),
  sourceGlob = ".compaction/runs/*/report.json"
): RunSummary {
  // Duplicate-safe headline: fold totals over DISTINCT reports only (a run captured/aggregated
  // twice with the same content fingerprint is counted once). Never inflates summed savings.
  const { distinctReports, distinctness } = dedupeReportsByFingerprint(reports);

  const summary: RunSummary = {
    ...emptyBucket(),
    average_percent_reduction: 0,
    measured_estimate_delta: computeMeasuredEstimateDelta([]),
    savings_by_policy: {},
    savings_by_waste_pattern: {},
    top_savings_runs: [],
    skipped_files: skippedFiles,
    distinctness,
    per_tool_token_records: [],
    run_records_source_glob: `${DEFAULT_RUN_RECORDS_DIRECTORY}/*.json`,
    run_record_skipped_files: [],
    generated_at: generatedAt,
    source_glob: sourceGlob
  };

  let percentReductionTotal = 0;

  for (const { path, report } of distinctReports) {
    addReportToBucket(summary, report);
    percentReductionTotal += report.percent_reduction;

    const policyBucket = (summary.savings_by_policy[report.policy_name] ??= emptyBucket());
    addReportToBucket(policyBucket, report);

    const wastePattern = report.waste_pattern ?? "none";
    const wasteBucket = (summary.savings_by_waste_pattern[wastePattern] ??= emptyBucket());
    addReportToBucket(wasteBucket, report);

    summary.top_savings_runs.push({
      run_id: report.run_id,
      trace_title: report.trace_title,
      report_path: path,
      tokens_saved: report.tokens_saved,
      percent_reduction: report.percent_reduction,
      saving_per_run: report.saving_per_run,
      policy_name: report.policy_name,
      waste_pattern: report.waste_pattern
    });
  }

  summary.average_percent_reduction =
    distinctReports.length === 0 ? 0 : roundTo(percentReductionTotal / distinctReports.length, 2);
  // V0.2 Increment 2: the measured-across-distinct-runs estimate delta over the DISTINCT runs'
  // per-run reductions. Qualifies for rung 1.5 only when N≥3 AND the mean ±2·SE excludes zero.
  summary.measured_estimate_delta = computeMeasuredEstimateDelta(
    summary.top_savings_runs.map((run) => run.percent_reduction)
  );
  normalizeBucket(summary);
  for (const bucket of Object.values(summary.savings_by_policy)) {
    normalizeBucket(bucket);
  }
  for (const bucket of Object.values(summary.savings_by_waste_pattern)) {
    normalizeBucket(bucket);
  }

  summary.top_savings_runs = summary.top_savings_runs
    .sort((left, right) => {
      if (right.tokens_saved !== left.tokens_saved) {
        return right.tokens_saved - left.tokens_saved;
      }

      return right.saving_per_run - left.saving_per_run;
    })
    .slice(0, 5);

  return summary;
}

export async function createRunSummary(
  runsDirectory = ".compaction/runs",
  recordsDirectory = DEFAULT_RUN_RECORDS_DIRECTORY
): Promise<RunSummary> {
  const { reports, skippedFiles } = await readCompactionRunReports(runsDirectory);
  const summary = aggregateCompactionReports(reports, skippedFiles, new Date().toISOString(), `${runsDirectory}/*/report.json`);
  // ADDITIVE per-tool token_source rollup from the locally accumulated run records (LOCAL layer of the
  // unified run flow). Counts + honest sources only - never content, never an output-savings figure.
  const { records, skipped } = await readLocalRunTokenRecords(recordsDirectory);
  summary.per_tool_token_records = summarizePerToolRunRecords(records.map((loaded) => loaded.record));
  summary.run_records_source_glob = `${recordsDirectory}/*.json`;
  summary.run_record_skipped_files = skipped;
  return summary;
}

function formatCurrency(value: number): string {
  return `$${value.toFixed(6)}`;
}

/**
 * "distinct runs N of M (K duplicates detected)", a count of distinct captured runs by content
 * fingerprint. The totals above are summed over the distinct set, so a re-captured run never
 * double-counts. NOT a billing/provider/semantic claim.
 */
function distinctnessLine(d: RunDistinctnessSummary): string {
  const noFp =
    d.runs_without_fingerprint > 0
      ? `; ${d.runs_without_fingerprint} run(s) without a fingerprint counted as distinct (cannot de-duplicate)`
      : "";
  return (
    `distinct runs ${d.distinct_runs} of ${d.total_runs} (${d.duplicate_runs} duplicate(s) detected by content fingerprint, ` +
    `excluded from the headline so savings are not double-counted)${noFp}`
  );
}

function formatBucketLines(bucket: RunSummaryBucket): string[] {
  return [
    `runs: ${bucket.total_runs}`,
    `original input tokens: ${bucket.total_original_input_tokens}`,
    `compacted input tokens: ${bucket.total_compacted_input_tokens}`,
    `tokens saved: ${bucket.total_tokens_saved}`,
    `cost before per run: ${formatCurrency(bucket.total_cost_before_per_run)}`,
    `cost after per run: ${formatCurrency(bucket.total_cost_after_per_run)}`,
    `saving per run: ${formatCurrency(bucket.total_saving_per_run)}`
  ];
}

export function formatRunSummary(summary: RunSummary): string {
  const policyLines = Object.entries(summary.savings_by_policy).flatMap(([policyName, bucket]) => [
    `- ${policyName}`,
    ...formatBucketLines(bucket).map((line) => `  - ${line}`)
  ]);
  const wastePatternLines = Object.entries(summary.savings_by_waste_pattern).flatMap(([wastePattern, bucket]) => [
    `- ${wastePattern}`,
    ...formatBucketLines(bucket).map((line) => `  - ${line}`)
  ]);
  const topRunLines = summary.top_savings_runs.map(
    (run, index) =>
      `${index + 1}. ${run.run_id} (${run.trace_title}) - ${run.tokens_saved} tokens saved, ${run.percent_reduction.toFixed(
        2
      )}% reduction, ${formatCurrency(run.saving_per_run)} estimated saving per run`
  );
  const skippedLines = summary.skipped_files.map((file) => `- ${file.path}: ${file.reason}`);

  return [
    "compaction summary",
    `Source: ${summary.source_glob}`,
    `Generated at: ${summary.generated_at}`,
    "",
    "Totals",
    `- ${distinctnessLine(summary.distinctness)}`,
    ...formatBucketLines(summary).map((line) => `- ${line}`),
    `- average percent reduction: ${summary.average_percent_reduction.toFixed(2)}%`,
    `- measured estimate delta [${summary.measured_estimate_delta.evidence_rung}]: ${summary.measured_estimate_delta.label}`,
    "",
    "Savings by policy",
    ...(policyLines.length === 0 ? ["- none"] : policyLines),
    "",
    "Savings by waste pattern",
    ...(wastePatternLines.length === 0 ? ["- none"] : wastePatternLines),
    "",
    "Top savings runs",
    ...(topRunLines.length === 0 ? ["- none"] : topRunLines),
    "",
    // LOCAL layer of the unified run flow: per-tool token_source rollup of the accumulated
    // run records. Counts + sources only - no cost/savings figures in this section.
    "Per-tool run records (token sources)",
    `Source: ${summary.run_records_source_glob}`,
    PER_TOOL_RECORDS_HEADER,
    ...formatPerToolRunRecordLines(summary.per_tool_token_records),
    ...summary.run_record_skipped_files.map((file) => `- skipped record ${file.path}: ${file.reason}`),
    "",
    "Skipped files",
    ...(skippedLines.length === 0 ? ["- none"] : skippedLines)
  ].join("\n");
}

export function formatRunSummaryMarkdown(summary: RunSummary): string {
  const policyRows = Object.entries(summary.savings_by_policy).map(
    ([policyName, bucket]) =>
      `| ${policyName} | ${bucket.total_runs} | ${bucket.total_tokens_saved} | ${formatCurrency(bucket.total_saving_per_run)} |`
  );
  const wastePatternRows = Object.entries(summary.savings_by_waste_pattern).map(
    ([wastePattern, bucket]) =>
      `| ${wastePattern} | ${bucket.total_runs} | ${bucket.total_tokens_saved} | ${formatCurrency(bucket.total_saving_per_run)} |`
  );
  const topRunRows = summary.top_savings_runs.map(
    (run) =>
      `| ${run.run_id} | ${run.trace_title} | ${run.tokens_saved} | ${run.percent_reduction.toFixed(2)}% | ${formatCurrency(
        run.saving_per_run
      )} |`
  );
  const skippedRows = summary.skipped_files.map((file) => `| ${file.path} | ${file.reason} |`);

  return [
    "# Compaction Run Summary",
    "",
    `- Source: ${summary.source_glob}`,
    `- Generated at: ${summary.generated_at}`,
    "",
    "## Totals",
    "",
    `- Distinct runs: ${distinctnessLine(summary.distinctness)}`,
    `- Total runs: ${summary.total_runs}`,
    `- Total original input tokens: ${summary.total_original_input_tokens}`,
    `- Total compacted input tokens: ${summary.total_compacted_input_tokens}`,
    `- Total tokens saved: ${summary.total_tokens_saved}`,
    `- Average percent reduction: ${summary.average_percent_reduction.toFixed(2)}%`,
    `- Total cost before per run: ${formatCurrency(summary.total_cost_before_per_run)}`,
    `- Total cost after per run: ${formatCurrency(summary.total_cost_after_per_run)}`,
    `- Total saving per run: ${formatCurrency(summary.total_saving_per_run)}`,
    `- Saving figures are estimated and summed over the ${summary.distinctness.distinct_runs} distinct recorded run${summary.distinctness.distinct_runs === 1 ? "" : "s"} (${summary.distinctness.duplicate_runs} duplicate(s) detected by content fingerprint and excluded).`,
    "",
    "## Measured Estimate Delta (across distinct runs)",
    "",
    `- Rung: ${summary.measured_estimate_delta.evidence_rung}`,
    `- Distinct runs: ${summary.measured_estimate_delta.distinct_run_count}`,
    `- Mean percent reduction: ${summary.measured_estimate_delta.mean_percent_reduction.toFixed(2)}% (±2·SE [${summary.measured_estimate_delta.ci_low.toFixed(2)}%, ${summary.measured_estimate_delta.ci_high.toFixed(2)}%])`,
    `- ${summary.measured_estimate_delta.label}`,
    "",
    "## Savings by policy",
    "",
    "| Policy | Runs | Tokens saved | Saving per run |",
    "| --- | ---: | ---: | ---: |",
    ...(policyRows.length === 0 ? ["| none | 0 | 0 | $0.000000 |"] : policyRows),
    "",
    "## Savings by waste pattern",
    "",
    "| Waste pattern | Runs | Tokens saved | Saving per run |",
    "| --- | ---: | ---: | ---: |",
    ...(wastePatternRows.length === 0 ? ["| none | 0 | 0 | $0.000000 |"] : wastePatternRows),
    "",
    "## Top savings runs",
    "",
    "| Run ID | Trace title | Tokens saved | Percent reduction | Saving per run |",
    "| --- | --- | ---: | ---: | ---: |",
    ...(topRunRows.length === 0 ? ["| none | none | 0 | 0.00% | $0.000000 |"] : topRunRows),
    "",
    "## Per-tool run records (token sources)",
    "",
    `- Source: ${summary.run_records_source_glob}`,
    `- ${PER_TOOL_RECORDS_HEADER}`,
    "",
    ...formatPerToolRunRecordLines(summary.per_tool_token_records),
    ...summary.run_record_skipped_files.map((file) => `- skipped record ${file.path}: ${file.reason}`),
    "",
    "## Skipped files",
    "",
    "| Path | Reason |",
    "| --- | --- |",
    ...(skippedRows.length === 0 ? ["| none | none |"] : skippedRows)
  ].join("\n");
}
