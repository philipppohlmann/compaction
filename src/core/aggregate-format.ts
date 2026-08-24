/**
 * Human renderings (stdout + markdown) and the content-free redacted share bundle for the
 * multi-session aggregate.
 *
 * Share-bundle invariant: rolled-up aggregate numbers + local labels + evidence tiers, nothing
 * else. It is assembled by whitelist from already-aggregated numeric/enum/short-label fields -
 * there is no code path that copies raw trace text, prompts, completions, tool output, file
 * paths, run ids, or report paths into it. Local file only: no network, no upload.
 */

import type {
  AggregateReport,
  AggregateTotals,
  BreakdownBucket,
  DistinctnessSummary,
  VerificationCounts
} from "./session-aggregate.js";
import { AGGREGATE_EVIDENCE_LABELS } from "./session-aggregate.js";
import type { RunLabels } from "./run-labels.js";

export const SHARE_BUNDLE_VERSION = "1.0.0";

export const SHARE_NO_UPLOAD_NOTE =
  "This is a LOCAL share artifact only. It performs NO network call, NO upload, and NO telemetry. " +
  "It contains aggregate numbers, local labels, and evidence tiers - NOT raw traces, prompts, " +
  "completions, tool output, file contents, run ids, or report paths.";

export const SHARE_CONTENT_FREE_NOTE =
  "Content-free by construction: assembled by whitelist from already-aggregated numeric / enum / " +
  "short-label fields. No trace content has a field to land in.";

function usd(value: number): string {
  return `$${value.toFixed(6)}`;
}

function totalsLines(totals: AggregateTotals): string[] {
  return [
    `runs (compactions): ${totals.compactions}`,
    `token-evidence split: provider-reported ${totals.runs_provider_reported}, local-estimate ${totals.runs_local_estimate}, unknown ${totals.runs_unknown_token_evidence}`,
    `input tokens before: ${totals.total_input_tokens_before}`,
    `input tokens after:  ${totals.total_input_tokens_after}`,
    `input tokens saved:  ${totals.total_input_tokens_saved}`,
    `output tokens before: ${totals.total_output_tokens_before} (over ${totals.runs_with_output_tokens} run(s); ${totals.runs_without_output_tokens} unknown)`,
    `output tokens after:  ${totals.total_output_tokens_after} (over ${totals.runs_with_output_tokens} run(s); ${totals.runs_without_output_tokens} unknown)`,
    `estimated cost before: ${usd(totals.total_estimated_cost_before_usd)} (price-table estimate, NOT billed)`,
    `estimated cost after:  ${usd(totals.total_estimated_cost_after_usd)} (price-table estimate, NOT billed)`,
    `estimated savings:     ${usd(totals.total_estimated_savings_usd)} (estimated, summed over ${totals.compactions} recorded run(s); NOT billing-confirmed, NOT realized, NOT extrapolated)`
  ];
}

/**
 * One honest distinctness line: "distinct runs N of M (K duplicates detected)" plus the
 * fingerprint coverage. This is a count of distinct captured runs by content fingerprint - NOT a
 * billing/provider/semantic claim. The headline savings are computed over the distinct set.
 */
function distinctnessLine(d: DistinctnessSummary): string {
  const noFp =
    d.runs_without_fingerprint > 0
      ? `; ${d.runs_without_fingerprint} run(s) without a fingerprint counted as distinct (cannot de-duplicate)`
      : "";
  return (
    `distinct runs ${d.distinct_runs} of ${d.total_runs} (${d.duplicate_runs} duplicate(s) detected by content fingerprint, ` +
    `excluded from the headline so savings are not double-counted)${noFp}`
  );
}

function verificationLines(v: VerificationCounts): string[] {
  return [
    `readiness: ready ${v.ready}, conditional ${v.conditional}, not_ready ${v.not_ready}, not_evaluated ${v.not_evaluated}`,
    `recoverability: pass ${v.recoverability_pass}, fail ${v.recoverability_fail}, not_evaluated ${v.recoverability_not_evaluated}`,
    `commitment-preservation: pass ${v.commitment_pass}, fail ${v.commitment_fail}, not_evaluated ${v.commitment_not_evaluated}`,
    `task-check: pass ${v.task_check_pass}, fail ${v.task_check_fail}, unsupported ${v.task_check_unsupported}, not_evaluated ${v.task_check_not_evaluated}`
  ];
}

function filtersLine(filters: RunLabels): string {
  const parts = Object.entries(filters).map(([k, val]) => `${k}=${val}`);
  return parts.length === 0 ? "none" : parts.join(", ");
}

export function formatAggregateReport(report: AggregateReport): string {
  const lines: string[] = [];
  lines.push("compaction multi-session aggregate (LOCAL - no upload, no dashboard)");
  lines.push(`Source: ${report.source_glob}`);
  lines.push(`Generated at: ${report.generated_at}`);
  lines.push(`Applied label filters: ${filtersLine(report.applied_filters)}`);
  lines.push(`Rollup labels: ${filtersLine(report.rollup_labels)}`);
  lines.push(`Sessions: ${report.session_count}`);
  lines.push("");
  lines.push("Cross-session totals");
  lines.push(`- ${distinctnessLine(report.distinctness)}`);
  for (const line of totalsLines(report.totals)) lines.push(`- ${line}`);
  lines.push("");
  lines.push("Cross-session verification");
  for (const line of verificationLines(report.verification)) lines.push(`- ${line}`);
  lines.push("");
  lines.push("Per-session summary");
  if (report.sessions.length === 0) {
    lines.push("- none (no recorded runs to roll up)");
  } else {
    for (const session of report.sessions) {
      lines.push(
        `- session ${session.session_id}${session.explicit_session_label ? "" : " (run-id fallback)"} - ${session.run_ids.length} run(s)`
      );
      const labelBits: string[] = [];
      if (session.labels.projects.length) labelBits.push(`projects: ${session.labels.projects.join("/")}`);
      if (session.labels.workflows.length) labelBits.push(`workflows: ${session.labels.workflows.join("/")}`);
      if (session.labels.providers.length) labelBits.push(`providers: ${session.labels.providers.join("/")}`);
      if (session.labels.user_labels.length) labelBits.push(`labels: ${session.labels.user_labels.join("/")}`);
      if (labelBits.length) lines.push(`  - ${labelBits.join("; ")}`);
      lines.push(`  - ${distinctnessLine(session.distinctness)}`);
      for (const line of totalsLines(session.totals)) lines.push(`  - ${line}`);
      for (const line of verificationLines(session.verification)) lines.push(`  - ${line}`);
    }
  }
  lines.push("");
  lines.push("Provider/runtime breakdown (operator-asserted label; 'unlabeled' when absent)");
  appendBreakdownLines(lines, report.by_provider);
  lines.push("");
  lines.push("Project breakdown");
  appendBreakdownLines(lines, report.by_project);
  lines.push("");
  lines.push("Workflow breakdown");
  appendBreakdownLines(lines, report.by_workflow);
  lines.push("");
  lines.push("Evidence labels (every figure carries its label)");
  for (const [, label] of Object.entries(report.evidence_labels)) lines.push(`- ${label}`);
  lines.push("");
  lines.push("Skipped run directories");
  if (report.skipped_run_directories.length === 0) lines.push("- none");
  else for (const s of report.skipped_run_directories) lines.push(`- ${s.run_directory}: ${s.reason}`);
  lines.push("");
  lines.push("Limitations");
  for (const limitation of report.limitations) lines.push(`- ${limitation}`);
  return lines.join("\n");
}

function appendBreakdownLines(lines: string[], buckets: BreakdownBucket[]): void {
  if (buckets.length === 0) {
    lines.push("- none");
    return;
  }
  for (const bucket of buckets) {
    lines.push(
      `- ${bucket.key}: ${bucket.totals.compactions} run(s), ${bucket.totals.total_input_tokens_saved} input tokens saved, ${usd(
        bucket.totals.total_estimated_savings_usd
      )} estimated savings; readiness ready ${bucket.verification.ready}/conditional ${bucket.verification.conditional}/not_ready ${bucket.verification.not_ready}`
    );
  }
}

function breakdownRows(buckets: BreakdownBucket[]): string[] {
  if (buckets.length === 0) return ["| none | 0 | 0 | $0.000000 | 0 | 0 | 0 |"];
  return buckets.map(
    (b) =>
      `| ${b.key} | ${b.totals.compactions} | ${b.totals.total_input_tokens_saved} | ${usd(
        b.totals.total_estimated_savings_usd
      )} | ${b.verification.ready} | ${b.verification.conditional} | ${b.verification.not_ready} |`
  );
}

export function formatAggregateMarkdown(report: AggregateReport): string {
  const t = report.totals;
  const v = report.verification;
  const lines: string[] = [];
  lines.push("# Compaction Multi-Session Aggregate");
  lines.push("");
  lines.push("Local, file-based rollup across recorded sessions/runs. No hosted dashboard, no upload, no telemetry.");
  lines.push("");
  lines.push(`- Source: ${report.source_glob}`);
  lines.push(`- Generated at: ${report.generated_at}`);
  lines.push(`- Applied label filters: ${filtersLine(report.applied_filters)}`);
  lines.push(`- Rollup labels: ${filtersLine(report.rollup_labels)}`);
  lines.push(`- Sessions: ${report.session_count}`);
  lines.push("");
  lines.push("## Cross-session totals");
  lines.push("");
  lines.push(`- Distinct runs: ${distinctnessLine(report.distinctness)}`);
  lines.push(`- Runs (compactions): ${t.compactions}`);
  lines.push(`- Token-evidence split: provider-reported ${t.runs_provider_reported}, local-estimate ${t.runs_local_estimate}, unknown ${t.runs_unknown_token_evidence}`);
  lines.push(`- Total input tokens before: ${t.total_input_tokens_before}`);
  lines.push(`- Total input tokens after: ${t.total_input_tokens_after}`);
  lines.push(`- Total input tokens saved: ${t.total_input_tokens_saved}`);
  lines.push(`- Total output tokens before: ${t.total_output_tokens_before} (over ${t.runs_with_output_tokens} run(s); ${t.runs_without_output_tokens} unknown)`);
  lines.push(`- Total output tokens after: ${t.total_output_tokens_after} (over ${t.runs_with_output_tokens} run(s); ${t.runs_without_output_tokens} unknown)`);
  lines.push(`- Total estimated cost before: ${usd(t.total_estimated_cost_before_usd)} (price-table estimate, NOT billed)`);
  lines.push(`- Total estimated cost after: ${usd(t.total_estimated_cost_after_usd)} (price-table estimate, NOT billed)`);
  lines.push(`- Total estimated savings: ${usd(t.total_estimated_savings_usd)}`);
  lines.push(`- Savings are estimated and summed over the ${t.compactions} recorded run(s) only; NOT billing-confirmed, NOT realized, NOT extrapolated to any time period.`);
  lines.push("");
  lines.push("## Cross-session verification");
  lines.push("");
  lines.push(`- Readiness: ready ${v.ready}, conditional ${v.conditional}, not_ready ${v.not_ready}, not_evaluated ${v.not_evaluated}`);
  lines.push(`- Recoverability: pass ${v.recoverability_pass}, fail ${v.recoverability_fail}, not_evaluated ${v.recoverability_not_evaluated}`);
  lines.push(`- Commitment-preservation: pass ${v.commitment_pass}, fail ${v.commitment_fail}, not_evaluated ${v.commitment_not_evaluated}`);
  lines.push(`- Task-check: pass ${v.task_check_pass}, fail ${v.task_check_fail}, unsupported ${v.task_check_unsupported}, not_evaluated ${v.task_check_not_evaluated}`);
  lines.push("");
  lines.push("## Per-session summary");
  lines.push("");
  lines.push("| Session | Runs | Input tokens saved | Estimated savings | ready | conditional | not_ready |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
  if (report.sessions.length === 0) {
    lines.push("| none | 0 | 0 | $0.000000 | 0 | 0 | 0 |");
  } else {
    for (const s of report.sessions) {
      lines.push(
        `| ${s.session_id}${s.explicit_session_label ? "" : " (run-id)"} | ${s.run_ids.length} | ${s.totals.total_input_tokens_saved} | ${usd(
          s.totals.total_estimated_savings_usd
        )} | ${s.verification.ready} | ${s.verification.conditional} | ${s.verification.not_ready} |`
      );
    }
  }
  lines.push("");
  lines.push("## Provider/runtime breakdown");
  lines.push("");
  lines.push("Provider/runtime is an operator-asserted local label (never provider-verified); 'unlabeled' when absent.");
  lines.push("");
  lines.push("| Provider/runtime | Runs | Input tokens saved | Estimated savings | ready | conditional | not_ready |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const row of breakdownRows(report.by_provider)) lines.push(row);
  lines.push("");
  lines.push("## Project breakdown");
  lines.push("");
  lines.push("| Project | Runs | Input tokens saved | Estimated savings | ready | conditional | not_ready |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const row of breakdownRows(report.by_project)) lines.push(row);
  lines.push("");
  lines.push("## Workflow breakdown");
  lines.push("");
  lines.push("| Workflow | Runs | Input tokens saved | Estimated savings | ready | conditional | not_ready |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const row of breakdownRows(report.by_workflow)) lines.push(row);
  lines.push("");
  lines.push("## Evidence labels");
  lines.push("");
  for (const [, label] of Object.entries(report.evidence_labels)) lines.push(`- ${label}`);
  lines.push("");
  lines.push("## Skipped run directories");
  lines.push("");
  if (report.skipped_run_directories.length === 0) {
    lines.push("- none");
  } else {
    for (const s of report.skipped_run_directories) lines.push(`- ${s.run_directory}: ${s.reason}`);
  }
  lines.push("");
  lines.push("## Limitations");
  lines.push("");
  for (const limitation of report.limitations) lines.push(`- ${limitation}`);
  return lines.join("\n");
}

// ----------------------------------------------------------------------------------
// Redacted, content-free aggregate share bundle.
// ----------------------------------------------------------------------------------

export interface ShareBundleBreakdownEntry {
  key: string;
  runs: number;
  input_tokens_saved: number;
  estimated_savings_usd: number;
  ready: number;
  conditional: number;
  not_ready: number;
}

export interface AggregateShareBundle {
  share_bundle_version: string;
  generated_at: string;
  privacy: {
    content_free: string;
    upload: string;
    includes: string[];
    excludes: string[];
  };
  /** Local label filters that scoped this rollup (short strings only). */
  applied_filters: RunLabels;
  /** Operator provenance labels (short strings only). */
  rollup_labels: RunLabels;
  session_count: number;
  totals: AggregateTotals;
  verification: VerificationCounts;
  /** Duplicate-safety summary (distinct N of M by content fingerprint) - counts only, no run ids. */
  distinctness: DistinctnessSummary;
  /** Provider/runtime breakdown - short label keys + numbers only (no run ids). */
  by_provider: ShareBundleBreakdownEntry[];
  by_project: ShareBundleBreakdownEntry[];
  by_workflow: ShareBundleBreakdownEntry[];
  evidence_labels: AggregateReport["evidence_labels"];
  limitations: string[];
}

const SHARE_INCLUDES: string[] = [
  "aggregate token totals (input before/after/saved; output where recorded)",
  "distinct-run count (distinct N of M by content fingerprint; duplicate-run count) - counts only",
  "token-evidence split (provider-reported vs local-estimate run counts)",
  "estimated cost + estimated savings totals (price-table estimate; NOT billing-confirmed)",
  "compaction count + session count",
  "verification outcome counts (readiness; recoverability / commitment / task-check pass/fail)",
  "provider/runtime, project, and workflow breakdowns (short label keys + numbers only)",
  "the local label filters / rollup labels (short operator strings)",
  "the per-figure evidence labels and limitations"
];

const SHARE_EXCLUDES: string[] = [
  "raw trace messages, prompts, completions, tool outputs",
  "source code / file contents / file paths",
  "run ids, report paths, run directories",
  "per-session run id lists",
  "credentials / tokens / environment variables",
  "any free-form text from a run"
];

function breakdownEntries(buckets: BreakdownBucket[]): ShareBundleBreakdownEntry[] {
  // Whitelist: copy only the short label key + numeric aggregates. No run ids, no paths.
  return buckets.map((b) => ({
    key: b.key,
    runs: b.totals.compactions,
    input_tokens_saved: b.totals.total_input_tokens_saved,
    estimated_savings_usd: b.totals.total_estimated_savings_usd,
    ready: b.verification.ready,
    conditional: b.verification.conditional,
    not_ready: b.verification.not_ready
  }));
}

/**
 * Build the content-free share bundle from an already-aggregated report. Whitelist
 * construction: copies only numeric totals, enum verification counts, short label keys/filters,
 * and static evidence-label/limitation strings. Deliberately omits `sessions[].run_ids`,
 * `skipped_run_directories` (run directory paths), and every per-run identifier - no run id,
 * report path, or trace content can reach the shared artifact.
 */
export function buildAggregateShareBundle(
  report: AggregateReport,
  generatedAt = new Date().toISOString()
): AggregateShareBundle {
  return {
    share_bundle_version: SHARE_BUNDLE_VERSION,
    generated_at: generatedAt,
    privacy: {
      content_free: SHARE_CONTENT_FREE_NOTE,
      upload: SHARE_NO_UPLOAD_NOTE,
      includes: SHARE_INCLUDES,
      excludes: SHARE_EXCLUDES
    },
    applied_filters: report.applied_filters,
    rollup_labels: report.rollup_labels,
    session_count: report.session_count,
    totals: report.totals,
    verification: report.verification,
    distinctness: report.distinctness,
    by_provider: breakdownEntries(report.by_provider),
    by_project: breakdownEntries(report.by_project),
    by_workflow: breakdownEntries(report.by_workflow),
    evidence_labels: report.evidence_labels,
    limitations: report.limitations
  };
}

export function formatShareBundleMarkdown(bundle: AggregateShareBundle): string {
  const t = bundle.totals;
  const v = bundle.verification;
  const lines: string[] = [];
  lines.push("# Compaction Aggregate Share Summary (redacted, content-free)");
  lines.push("");
  lines.push("A privacy-safe AGGREGATE summary a developer can hand an admin. It shows value across");
  lines.push("sessions WITHOUT any raw trace text, prompts, completions, tool output, run ids, or paths.");
  lines.push("");
  lines.push(SHARE_CONTENT_FREE_NOTE);
  lines.push("");
  lines.push(SHARE_NO_UPLOAD_NOTE);
  lines.push("");
  lines.push(`- Bundle version: ${bundle.share_bundle_version}`);
  lines.push(`- Generated at: ${bundle.generated_at}`);
  lines.push(`- Applied label filters: ${filtersLine(bundle.applied_filters)}`);
  lines.push(`- Rollup labels: ${filtersLine(bundle.rollup_labels)}`);
  lines.push(`- Sessions: ${bundle.session_count}`);
  lines.push("");
  lines.push("## Aggregate value (estimated, summed over recorded runs)");
  lines.push("");
  lines.push(`- Distinct runs: ${distinctnessLine(bundle.distinctness)}`);
  lines.push(`- Compactions: ${t.compactions}`);
  lines.push(`- Token-evidence split: provider-reported ${t.runs_provider_reported}, local-estimate ${t.runs_local_estimate}, unknown ${t.runs_unknown_token_evidence}`);
  lines.push(`- Input tokens saved: ${t.total_input_tokens_saved}`);
  lines.push(`- Output tokens before/after: ${t.total_output_tokens_before}/${t.total_output_tokens_after} (over ${t.runs_with_output_tokens} run(s); ${t.runs_without_output_tokens} unknown)`);
  lines.push(`- Estimated cost before/after: ${usd(t.total_estimated_cost_before_usd)} / ${usd(t.total_estimated_cost_after_usd)} (price-table estimate, NOT billed)`);
  lines.push(`- Estimated savings: ${usd(t.total_estimated_savings_usd)} (estimated, summed over ${t.compactions} recorded run(s); NOT billing-confirmed, NOT realized, NOT extrapolated)`);
  lines.push("");
  lines.push("## Verification outcomes");
  lines.push("");
  lines.push(`- Readiness: ready ${v.ready}, conditional ${v.conditional}, not_ready ${v.not_ready}, not_evaluated ${v.not_evaluated}`);
  lines.push(`- Recoverability: pass ${v.recoverability_pass}, fail ${v.recoverability_fail}, not_evaluated ${v.recoverability_not_evaluated}`);
  lines.push(`- Commitment-preservation: pass ${v.commitment_pass}, fail ${v.commitment_fail}, not_evaluated ${v.commitment_not_evaluated}`);
  lines.push(`- Task-check: pass ${v.task_check_pass}, fail ${v.task_check_fail}, unsupported ${v.task_check_unsupported}, not_evaluated ${v.task_check_not_evaluated}`);
  lines.push("");
  lines.push("## Provider/runtime breakdown (operator-asserted label)");
  lines.push("");
  lines.push("| Provider/runtime | Runs | Input tokens saved | Estimated savings | ready | conditional | not_ready |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
  if (bundle.by_provider.length === 0) lines.push("| none | 0 | 0 | $0.000000 | 0 | 0 | 0 |");
  else for (const b of bundle.by_provider) {
    lines.push(`| ${b.key} | ${b.runs} | ${b.input_tokens_saved} | ${usd(b.estimated_savings_usd)} | ${b.ready} | ${b.conditional} | ${b.not_ready} |`);
  }
  lines.push("");
  lines.push("## What this share summary INCLUDES");
  lines.push("");
  for (const item of bundle.privacy.includes) lines.push(`- ${item}`);
  lines.push("");
  lines.push("## What it EXCLUDES (never written)");
  lines.push("");
  for (const item of bundle.privacy.excludes) lines.push(`- ${item}`);
  lines.push("");
  lines.push("## Evidence labels");
  lines.push("");
  for (const [, label] of Object.entries(bundle.evidence_labels)) lines.push(`- ${label}`);
  lines.push("");
  lines.push("## Limitations");
  lines.push("");
  for (const limitation of bundle.limitations) lines.push(`- ${limitation}`);
  return lines.join("\n");
}

export { AGGREGATE_EVIDENCE_LABELS };
