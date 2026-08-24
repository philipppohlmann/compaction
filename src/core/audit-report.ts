import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonArtifact, writeTextArtifact } from "./artifact-writer.js";
import { createRunSummary } from "./run-aggregator.js";
import type { RunSummary, RunSummaryBucket, SkippedReportFile, TopSavingsRun } from "./run-aggregator.js";
// The report vocabulary/shapes come from the PUBLIC seam, not `../engine/…`: the engine is excluded
// from the published package, and an `../engine/…` type import here would emit an unresolvable
// `.d.ts` import for TypeScript consumers of the shipped package. This module only READS the
// artifacts; the builders stay in the engine.
import type {
  ApplyReport,
  ApplySafetyStatus,
  RecommendationMode,
  RecommendationReport
} from "./report-types.js";
import type { SafetyRiskLevel, SafetyStatus } from "./safety-report.js";

export const AUDIT_ARTIFACT_DIRECTORY = ".compaction/audits";
export const AUDIT_ARTIFACT_NAMES = ["audit-report.json", "audit-report.md"] as const;

export interface AuditInputDirectories {
  runs: string;
  recommendations: string;
  apply: string;
  audits: string;
}

export interface AuditSourceSummary {
  source_directory: string;
  artifact_name: string;
  total_artifacts: number;
  skipped_files: SkippedReportFile[];
  missing: boolean;
  note: string | null;
}

export interface PolicyAuditSummary extends RunSummaryBucket {
  policy_name: string;
}

export interface WastePatternAuditSummary extends RunSummaryBucket {
  waste_pattern: string;
}

export interface SafetyAuditSummary {
  source: AuditSourceSummary;
  total_reports: number;
  status_counts: Record<SafetyStatus, number>;
  risk_level_counts: Record<SafetyRiskLevel, number>;
  total_tokens_saved_with_safety_reports: number;
  warnings: string[];
  failures: string[];
  note: string | null;
}

export interface RecommendationAuditSummary {
  source: AuditSourceSummary;
  total_recommendations: number;
  mode_counts: Record<RecommendationMode, number>;
  total_tokens_saved: number;
  recommended_next_steps: string[];
  note: string | null;
}

export interface ApplyAuditSummary {
  source: AuditSourceSummary;
  total_apply_reports: number;
  applied_count: number;
  refused_count: number;
  safety_status_counts: Record<ApplySafetyStatus, number>;
  total_tokens_saved_from_applied_reports: number;
  total_saving_per_run_from_applied_reports: number;
  refusal_reasons: string[];
  note: string | null;
}

export interface AuditReport {
  audit_id: string;
  generated_at: string;
  total_runs: number;
  total_original_input_tokens: number;
  total_compacted_input_tokens: number;
  total_tokens_saved: number;
  average_percent_reduction: number;
  total_cost_before_per_run: number;
  total_cost_after_per_run: number;
  total_saving_per_run: number;
  policies_detected: PolicyAuditSummary[];
  top_waste_patterns: WastePatternAuditSummary[];
  safety_summary: SafetyAuditSummary;
  recommendation_summary: RecommendationAuditSummary;
  apply_summary?: ApplyAuditSummary;
  top_savings_runs: TopSavingsRun[];
  suggested_next_steps: string[];
  limitations: string[];
  sources: {
    runs: AuditSourceSummary;
    recommendations: AuditSourceSummary;
    apply: AuditSourceSummary;
  };
}

export interface AuditArtifactResult {
  audit: AuditReport;
  markdown: string;
  paths: {
    auditJsonPath: string;
    auditMarkdownPath: string;
  };
}

interface LoadedJsonArtifact<T> {
  path: string;
  value: T;
}

function roundCurrency(value: number): number {
  return Number(value.toFixed(6));
}

function roundPercent(value: number): number {
  return Number(value.toFixed(2));
}

function emptySourceSummary(sourceDirectory: string, artifactName: string, missing: boolean): AuditSourceSummary {
  return {
    source_directory: sourceDirectory,
    artifact_name: artifactName,
    total_artifacts: 0,
    skipped_files: [],
    missing,
    note: missing ? `${sourceDirectory} does not exist; no ${artifactName} artifacts were summarized.` : null
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function requiredString(record: Record<string, unknown>, field: string): string | null {
  return typeof record[field] === "string" && record[field].trim() !== "" ? record[field] : null;
}

function validateSafetyReport(value: unknown): { report?: SafetyReportShape; reason?: string } {
  if (!isRecord(value)) {
    return { reason: "safety report is not a JSON object" };
  }

  const runId = requiredString(value, "run_id");
  const status = value.status;
  const riskLevel = value.risk_level;
  if (runId === null) return { reason: "missing or invalid run_id" };
  if (status !== "pass" && status !== "warn" && status !== "fail") return { reason: "missing or invalid status" };
  if (riskLevel !== "low" && riskLevel !== "medium" && riskLevel !== "high") return { reason: "missing or invalid risk_level" };
  if (!isFiniteNumber(value.tokens_saved)) return { reason: "missing or invalid tokens_saved" };

  return {
    report: {
      run_id: runId,
      status,
      risk_level: riskLevel,
      tokens_saved: value.tokens_saved,
      warnings: Array.isArray(value.warnings) ? value.warnings.filter((item): item is string => typeof item === "string") : [],
      failures: Array.isArray(value.failures) ? value.failures.filter((item): item is string => typeof item === "string") : []
    }
  };
}

function validateRecommendationReport(value: unknown): { report?: RecommendationReport; reason?: string } {
  if (!isRecord(value)) return { reason: "recommendation is not a JSON object" };
  const traceId = requiredString(value, "trace_id");
  if (traceId === null) return { reason: "missing or invalid trace_id" };
  if (value.recommended_mode !== "observe" && value.recommended_mode !== "recommend" && value.recommended_mode !== "apply_with_approval" && value.recommended_mode !== "auto_eligible") {
    return { reason: "missing or invalid recommended_mode" };
  }
  for (const field of ["tokens_saved"] as const) {
    if (!isFiniteNumber(value[field])) return { reason: `missing or invalid ${field}` };
  }
  return { report: value as unknown as RecommendationReport };
}

function validateApplyReport(value: unknown): { report?: ApplyReport; reason?: string } {
  if (!isRecord(value)) return { reason: "apply report is not a JSON object" };
  const traceId = requiredString(value, "trace_id");
  if (traceId === null) return { reason: "missing or invalid trace_id" };
  if (typeof value.applied !== "boolean") return { reason: "missing or invalid applied" };
  if (value.safety_status !== "pass" && value.safety_status !== "warn" && value.safety_status !== "fail" && value.safety_status !== "missing") {
    return { reason: "missing or invalid safety_status" };
  }
  for (const field of ["tokens_saved", "saving_per_run"] as const) {
    if (!isFiniteNumber(value[field])) return { reason: `missing or invalid ${field}` };
  }
  return { report: value as unknown as ApplyReport };
}

interface SafetyReportShape {
  run_id: string;
  status: SafetyStatus;
  risk_level: SafetyRiskLevel;
  tokens_saved: number;
  warnings: string[];
  failures: string[];
}

async function findChildArtifactPaths(directory: string, artifactName: string): Promise<{ paths: string[]; missing: boolean }> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return {
      paths: entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(directory, entry.name, artifactName))
        .sort(),
      missing: false
    };
  } catch (error: unknown) {
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "unknown";
    if (code === "ENOENT") {
      return { paths: [], missing: true };
    }
    throw error;
  }
}

async function readChildJsonArtifacts<T>(
  directory: string,
  artifactName: string,
  validate: (value: unknown) => { report?: T; reason?: string }
): Promise<{ artifacts: LoadedJsonArtifact<T>[]; source: AuditSourceSummary }> {
  const { paths, missing } = await findChildArtifactPaths(directory, artifactName);
  const source = emptySourceSummary(directory, artifactName, missing);
  const artifacts: LoadedJsonArtifact<T>[] = [];

  for (const path of paths) {
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
      const validation = validate(parsed);
      if (validation.report === undefined) {
        source.skipped_files.push({ path, reason: validation.reason ?? "invalid artifact" });
        continue;
      }
      artifacts.push({ path, value: validation.report });
    } catch (error: unknown) {
      const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : null;
      const reason = code === "ENOENT" ? `${artifactName} not found` : error instanceof SyntaxError ? "invalid JSON" : `could not read ${artifactName}`;
      source.skipped_files.push({ path, reason });
    }
  }

  source.total_artifacts = artifacts.length;
  if (!missing && artifacts.length === 0 && source.skipped_files.length === 0) {
    source.note = `${directory} exists but no ${artifactName} artifacts were found.`;
  }

  return { artifacts, source };
}

function policySummaries(summary: RunSummary): PolicyAuditSummary[] {
  return Object.entries(summary.savings_by_policy)
    .map(([policyName, bucket]) => ({ policy_name: policyName, ...bucket }))
    .sort((left, right) => right.total_tokens_saved - left.total_tokens_saved || left.policy_name.localeCompare(right.policy_name));
}

function wastePatternSummaries(summary: RunSummary): WastePatternAuditSummary[] {
  return Object.entries(summary.savings_by_waste_pattern)
    .map(([wastePattern, bucket]) => ({ waste_pattern: wastePattern, ...bucket }))
    .sort((left, right) => right.total_tokens_saved - left.total_tokens_saved || left.waste_pattern.localeCompare(right.waste_pattern));
}

function createSafetySummary(source: AuditSourceSummary, reports: LoadedJsonArtifact<SafetyReportShape>[]): SafetyAuditSummary {
  const statusCounts: Record<SafetyStatus, number> = { pass: 0, warn: 0, fail: 0 };
  const riskLevelCounts: Record<SafetyRiskLevel, number> = { low: 0, medium: 0, high: 0 };
  const warnings = new Set<string>();
  const failures = new Set<string>();
  let totalTokensSaved = 0;

  for (const { value } of reports) {
    statusCounts[value.status] += 1;
    riskLevelCounts[value.risk_level] += 1;
    totalTokensSaved += value.tokens_saved;
    value.warnings.forEach((warning) => warnings.add(warning));
    value.failures.forEach((failure) => failures.add(failure));
  }

  return {
    source,
    total_reports: reports.length,
    status_counts: statusCounts,
    risk_level_counts: riskLevelCounts,
    total_tokens_saved_with_safety_reports: totalTokensSaved,
    warnings: [...warnings].sort(),
    failures: [...failures].sort(),
    note: reports.length === 0 ? "No safety-report.json artifacts were available to summarize." : null
  };
}

function createRecommendationSummary(source: AuditSourceSummary, reports: LoadedJsonArtifact<RecommendationReport>[]): RecommendationAuditSummary {
  const modeCounts: Record<RecommendationMode, number> = { observe: 0, recommend: 0, apply_with_approval: 0, auto_eligible: 0 };
  const nextSteps = new Set<string>();
  let totalTokensSaved = 0;

  for (const { value } of reports) {
    modeCounts[value.recommended_mode] += 1;
    totalTokensSaved += value.tokens_saved;
    nextSteps.add(value.required_next_step);
  }

  return {
    source,
    total_recommendations: reports.length,
    mode_counts: modeCounts,
    total_tokens_saved: totalTokensSaved,
    recommended_next_steps: [...nextSteps].sort(),
    note: reports.length === 0 ? "No recommendation.json artifacts were available to summarize." : null
  };
}

function createApplySummary(source: AuditSourceSummary, reports: LoadedJsonArtifact<ApplyReport>[]): ApplyAuditSummary | undefined {
  if (source.missing && reports.length === 0) {
    return undefined;
  }

  const safetyStatusCounts: Record<ApplySafetyStatus, number> = { pass: 0, warn: 0, fail: 0, missing: 0 };
  const refusalReasons = new Set<string>();
  let appliedCount = 0;
  let totalTokensSaved = 0;
  let totalSavingPerRun = 0;

  for (const { value } of reports) {
    safetyStatusCounts[value.safety_status] += 1;
    if (value.applied) {
      appliedCount += 1;
      totalTokensSaved += value.tokens_saved;
      totalSavingPerRun += value.saving_per_run;
    } else if (value.refusal_reason) {
      refusalReasons.add(value.refusal_reason);
    }
  }

  return {
    source,
    total_apply_reports: reports.length,
    applied_count: appliedCount,
    refused_count: reports.length - appliedCount,
    safety_status_counts: safetyStatusCounts,
    total_tokens_saved_from_applied_reports: totalTokensSaved,
    total_saving_per_run_from_applied_reports: roundCurrency(totalSavingPerRun),
    refusal_reasons: [...refusalReasons].sort(),
    note: reports.length === 0 ? "No apply-report.json artifacts were available to summarize." : null
  };
}

function auditIdFromGeneratedAt(generatedAt: string): string {
  return `audit-${generatedAt.replace(/[^0-9]/g, "").slice(0, 14)}`;
}

function runSourceSummary(summary: RunSummary, runsDirectory: string): AuditSourceSummary {
  return {
    source_directory: runsDirectory,
    artifact_name: "report.json",
    total_artifacts: summary.total_runs,
    skipped_files: summary.skipped_files,
    missing: false,
    note: summary.total_runs === 0 ? "No valid .compaction/runs/*/report.json artifacts were available to summarize." : null
  };
}

function createSuggestedNextSteps(input: {
  summary: RunSummary;
  recommendations: RecommendationAuditSummary;
  safety: SafetyAuditSummary;
  apply?: ApplyAuditSummary;
}): string[] {
  const nextSteps: string[] = [];

  if (input.summary.total_runs === 0) {
    nextSteps.push("Run local compaction commands to generate .compaction/runs/*/report.json before using this audit for savings review.");
  } else {
    nextSteps.push("Review the top savings runs and confirm the underlying local reports match the workflow being audited.");
  }

  if (input.recommendations.total_recommendations === 0) {
    nextSteps.push("Run compaction recommend on relevant local traces if recommendation artifacts are needed for the audit package.");
  } else {
    nextSteps.push("Review recommendation modes and required next steps before applying any optimization.");
  }

  if (input.safety.total_reports === 0) {
    nextSteps.push("Generate or inspect safety-report.json artifacts before using this package for approval decisions.");
  } else if (input.safety.status_counts.fail > 0 || input.safety.status_counts.warn > 0) {
    nextSteps.push("Resolve warning or failing safety checks before applying optimizations.");
  }

  if (input.apply === undefined) {
    nextSteps.push("Apply artifacts were not present; keep this audit as advisory until an explicit local apply run is generated.");
  } else if (input.apply.total_apply_reports === 0) {
    nextSteps.push("The apply artifact folder exists but contains no valid apply reports; inspect skipped files or rerun apply mode if needed.");
  } else {
    nextSteps.push("Inspect applied-trace artifacts before reusing any applied optimization output.");
  }

  return nextSteps;
}

function createLimitations(input: { summary: RunSummary; recommendations: RecommendationAuditSummary; apply?: ApplyAuditSummary }): string[] {
  return [
    "This audit package is generated from local artifacts only and makes no provider calls.",
    "Savings are deterministic local estimates copied or aggregated from existing reports, not provider billing records.",
    "Saving totals are estimated and summed only over the compaction run reports actually present locally; no run volume is assumed or extrapolated.",
    "Missing recommendation, safety, or apply artifacts are reported as missing rather than inferred.",
    "Agent Cost Audit v0 does not include a hosted service, dashboard, database, auth, billing, model routing, or provider integration.",
    ...(input.summary.total_runs === 0 ? ["No valid compaction run reports were found, so savings totals are zero."] : []),
    ...(input.recommendations.total_recommendations === 0 ? ["No valid recommendation artifacts were found, so recommendation summary is limited."] : []),
    ...(input.apply === undefined ? ["No apply artifact directory was found, so applied optimization results are not included."] : [])
  ];
}

export async function createAuditReport(
  directories: Partial<AuditInputDirectories> = {},
  generatedAt = new Date().toISOString()
): Promise<AuditReport> {
  const resolvedDirectories: AuditInputDirectories = {
    runs: directories.runs ?? ".compaction/runs",
    recommendations: directories.recommendations ?? ".compaction/recommendations",
    apply: directories.apply ?? ".compaction/apply",
    audits: directories.audits ?? AUDIT_ARTIFACT_DIRECTORY
  };

  const runSummary = await createRunSummary(resolvedDirectories.runs);
  const runsSource = runSourceSummary(runSummary, resolvedDirectories.runs);
  const { artifacts: safetyReports, source: safetySource } = await readChildJsonArtifacts(
    resolvedDirectories.runs,
    "safety-report.json",
    validateSafetyReport
  );
  const { artifacts: recommendationReports, source: recommendationSource } = await readChildJsonArtifacts(
    resolvedDirectories.recommendations,
    "recommendation.json",
    validateRecommendationReport
  );
  const { artifacts: applyReports, source: applySource } = await readChildJsonArtifacts(resolvedDirectories.apply, "apply-report.json", validateApplyReport);

  const safetySummary = createSafetySummary(safetySource, safetyReports);
  const recommendationSummary = createRecommendationSummary(recommendationSource, recommendationReports);
  const applySummary = createApplySummary(applySource, applyReports);
  const suggestedNextSteps = createSuggestedNextSteps({ summary: runSummary, recommendations: recommendationSummary, safety: safetySummary, apply: applySummary });
  const limitations = createLimitations({ summary: runSummary, recommendations: recommendationSummary, apply: applySummary });

  return {
    audit_id: auditIdFromGeneratedAt(generatedAt),
    generated_at: generatedAt,
    total_runs: runSummary.total_runs,
    total_original_input_tokens: runSummary.total_original_input_tokens,
    total_compacted_input_tokens: runSummary.total_compacted_input_tokens,
    total_tokens_saved: runSummary.total_tokens_saved,
    average_percent_reduction: roundPercent(runSummary.average_percent_reduction),
    total_cost_before_per_run: roundCurrency(runSummary.total_cost_before_per_run),
    total_cost_after_per_run: roundCurrency(runSummary.total_cost_after_per_run),
    total_saving_per_run: roundCurrency(runSummary.total_saving_per_run),
    policies_detected: policySummaries(runSummary),
    top_waste_patterns: wastePatternSummaries(runSummary),
    safety_summary: safetySummary,
    recommendation_summary: recommendationSummary,
    ...(applySummary ? { apply_summary: applySummary } : {}),
    top_savings_runs: runSummary.top_savings_runs,
    suggested_next_steps: suggestedNextSteps,
    limitations,
    sources: {
      runs: runsSource,
      recommendations: recommendationSource,
      apply: applySource
    }
  };
}

function formatCurrency(value: number): string {
  return `$${value.toFixed(6)}`;
}

function formatPolicyRows(policies: PolicyAuditSummary[]): string[] {
  return policies.map(
    (policy) =>
      `| ${policy.policy_name} | ${policy.total_runs} | ${policy.total_tokens_saved} | ${formatCurrency(policy.total_saving_per_run)} |`
  );
}

function formatWasteRows(patterns: WastePatternAuditSummary[]): string[] {
  return patterns.map(
    (pattern) =>
      `| ${pattern.waste_pattern} | ${pattern.total_runs} | ${pattern.total_tokens_saved} | ${formatCurrency(pattern.total_saving_per_run)} |`
  );
}

function formatTopRunRows(runs: TopSavingsRun[]): string[] {
  return runs.map(
    (run) =>
      `| ${run.run_id} | ${run.trace_title} | ${run.tokens_saved} | ${run.percent_reduction.toFixed(2)}% | ${formatCurrency(run.saving_per_run)} |`
  );
}

export function formatAuditMarkdown(report: AuditReport): string {
  return [
    "# Agent Cost Audit",
    "",
    "## Summary",
    "",
    `- Audit id: ${report.audit_id}`,
    `- Generated at: ${report.generated_at}`,
    `- Total runs: ${report.total_runs}`,
    `- Local-only package: yes; this audit summarizes existing local artifacts only.`,
    `- Missing recommendation data: ${report.recommendation_summary.total_recommendations === 0 ? "yes" : "no"}`,
    `- Missing apply data: ${report.apply_summary === undefined || report.apply_summary.total_apply_reports === 0 ? "yes" : "no"}`,
    "",
    "## Savings",
    "",
    `- Total original input tokens: ${report.total_original_input_tokens}`,
    `- Total compacted input tokens: ${report.total_compacted_input_tokens}`,
    `- Total tokens saved: ${report.total_tokens_saved}`,
    `- Average percent reduction: ${report.average_percent_reduction.toFixed(2)}%`,
    `- Total cost before per run: ${formatCurrency(report.total_cost_before_per_run)}`,
    `- Total cost after per run: ${formatCurrency(report.total_cost_after_per_run)}`,
    `- Total saving per run: ${formatCurrency(report.total_saving_per_run)}`,
    `- Saving figures are estimated and summed over the ${report.total_runs} recorded run${report.total_runs === 1 ? "" : "s"} only; no run volume is assumed or extrapolated.`,
    "",
    "## Waste Patterns",
    "",
    "| Waste pattern | Runs | Tokens saved | Saving per run |",
    "| --- | ---: | ---: | ---: |",
    ...(report.top_waste_patterns.length === 0 ? ["| none | 0 | 0 | $0.000000 |"] : formatWasteRows(report.top_waste_patterns)),
    "",
    "## Policies",
    "",
    "| Policy | Runs | Tokens saved | Saving per run |",
    "| --- | ---: | ---: | ---: |",
    ...(report.policies_detected.length === 0 ? ["| none | 0 | 0 | $0.000000 |"] : formatPolicyRows(report.policies_detected)),
    "",
    "## Safety",
    "",
    `- Safety reports: ${report.safety_summary.total_reports}`,
    `- Status counts: pass ${report.safety_summary.status_counts.pass}, warn ${report.safety_summary.status_counts.warn}, fail ${report.safety_summary.status_counts.fail}`,
    `- Risk counts: low ${report.safety_summary.risk_level_counts.low}, medium ${report.safety_summary.risk_level_counts.medium}, high ${report.safety_summary.risk_level_counts.high}`,
    ...(report.safety_summary.note ? [`- Note: ${report.safety_summary.note}`] : []),
    "",
    "## Recommendations",
    "",
    `- Recommendation reports: ${report.recommendation_summary.total_recommendations}`,
    `- Mode counts: observe ${report.recommendation_summary.mode_counts.observe}, recommend ${report.recommendation_summary.mode_counts.recommend}, apply_with_approval ${report.recommendation_summary.mode_counts.apply_with_approval}, auto_eligible ${report.recommendation_summary.mode_counts.auto_eligible}`,
    ...(report.recommendation_summary.note ? [`- Note: ${report.recommendation_summary.note}`] : []),
    "",
    ...(report.apply_summary
      ? [
          "## Applied Optimizations",
          "",
          `- Apply reports: ${report.apply_summary.total_apply_reports}`,
          `- Applied: ${report.apply_summary.applied_count}`,
          `- Refused: ${report.apply_summary.refused_count}`,
          `- Tokens saved from applied reports: ${report.apply_summary.total_tokens_saved_from_applied_reports}`,
          `- Saving per run from applied reports: ${formatCurrency(report.apply_summary.total_saving_per_run_from_applied_reports)}`,
          ...(report.apply_summary.note ? [`- Note: ${report.apply_summary.note}`] : []),
          ""
        ]
      : []),
    "## Top Runs",
    "",
    "| Run ID | Trace title | Tokens saved | Percent reduction | Saving per run |",
    "| --- | --- | ---: | ---: | ---: |",
    ...(report.top_savings_runs.length === 0 ? ["| none | none | 0 | 0.00% | $0.000000 |"] : formatTopRunRows(report.top_savings_runs)),
    "",
    "## Suggested Next Steps",
    "",
    ...report.suggested_next_steps.map((step) => `- ${step}`),
    "",
    "## Limitations",
    "",
    ...report.limitations.map((limitation) => `- ${limitation}`)
  ].join("\n");
}

export async function writeAuditArtifacts(
  directories: Partial<AuditInputDirectories> = {},
  generatedAt = new Date().toISOString()
): Promise<AuditArtifactResult> {
  const audit = await createAuditReport(directories, generatedAt);
  const markdown = formatAuditMarkdown(audit);
  const auditDirectory = `${directories.audits ?? AUDIT_ARTIFACT_DIRECTORY}/${audit.audit_id}`;
  const auditJsonPath = await writeJsonArtifact(auditDirectory, "audit-report.json", audit);
  const auditMarkdownPath = await writeTextArtifact(auditDirectory, "audit-report.md", markdown);

  return {
    audit,
    markdown,
    paths: {
      auditJsonPath,
      auditMarkdownPath
    }
  };
}
