/**
 * Session + multi-session LOCAL aggregate (Strong-MVP Track E).
 *
 * Rolls up the per-run artifacts a developer already produced -
 * `.compaction/runs/<run>/report.json` and (when present) `strong-eval.json` plus an
 * optional local `run-labels.json`, into:
 *   - a PER-SESSION summary (a session may contain multiple runs), and
 *   - a CROSS-SESSION aggregate (totals across every session/run).
 *
 * This is the future admin/buyer value WITHOUT a hosted dashboard: everything is LOCAL,
 * file-based, read-only over existing artifacts. NO network, NO upload, NO telemetry,
 * NO database, NO auth, NO server.
 *
 * EVIDENCE HONESTY (mvp-capability-matrix rows 2/3/10/13/21, README evidence ladder):
 *   - Token figures carry their per-figure source: provider-reported ONLY when the run's
 *     token accounting was `measured` (provider usage metadata present); otherwise
 *     local-estimate (chars/4). The aggregate states how many runs are in each tier and
 *     NEVER labels an estimate as provider-reported.
 *   - Cost / savings are ESTIMATED (price-table over the token figures). NEVER
 *     billing-confirmed, NEVER realized, NEVER extrapolated to a time period.
 *   - Output tokens are carried only where a run actually recorded them (from
 *     strong-eval token_accounting); runs without strong-eval contribute `unknown`
 *     output tokens and are counted separately, never inferred.
 *   - Verification outcome counts (ready/conditional/not_ready, recoverability /
 *     commitment / task-check pass/fail) are copied from strong-eval; runs without a
 *     strong-eval are counted as `not_evaluated`, never as a pass.
 *
 * The builders are PURE (no IO) so the rollup math, label tagging, and the content-free
 * share bundle are unit-testable; the reader (`collectRunRecords`) does the only IO and
 * touches nothing but local files.
 */

import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { NO_LABEL, parseRunLabels, type RunLabels } from "./run-labels.js";
import { classifyDistinctness, type DistinctnessRecord } from "./trace-fingerprint.js";
import type { CompactionReport } from "./types.js";

export const AGGREGATE_ARTIFACT_DIRECTORY = ".compaction/aggregates";

/** Evidence tier of a run's TOKEN figures (kept distinct from operator-asserted provider labels). */
export type RunTokenEvidence = "provider_reported" | "local_estimate" | "unknown";

/** Verification outcome of a run, copied from strong-eval (or not_evaluated when absent). */
export type VerificationReadiness = "ready" | "conditional" | "not_ready" | "not_evaluated";
export type CheckOutcome = "pass" | "fail" | "unsupported" | "not_evaluated";

/**
 * One normalized run record assembled from a run directory's local artifacts. The ONLY
 * fields carried are bounded numbers / enums / short label strings, never trace content.
 */
export interface RunRecord {
  run_id: string;
  run_directory: string;
  report_path: string;
  model: string;
  /**
   * Content-addressed distinctness fingerprint digest of the source trace, when the run's
   * report.json carried one (`trace_fingerprint.content_sha256`). Used to de-duplicate a
   * run captured/aggregated twice (same digest → counted once) so headline savings are never
   * inflated. `null` for older reports without a fingerprint, those are treated as distinct
   * (cannot dedup what cannot be identified) and noted honestly, never collapsed.
   */
  trace_fingerprint: string | null;
  /** Token evidence tier for this run (drives the provider-reported vs local-estimate split). */
  token_evidence: RunTokenEvidence;
  input_tokens_before: number;
  input_tokens_after: number;
  input_tokens_saved: number;
  /** Output tokens where the run recorded them (strong-eval token_accounting); else unknown. */
  output_tokens_before: number | "unknown";
  output_tokens_after: number | "unknown";
  estimated_cost_before_usd: number;
  estimated_cost_after_usd: number;
  estimated_saving_usd: number;
  /** Verification outcomes (not_evaluated when no strong-eval.json was present). */
  readiness: VerificationReadiness;
  recoverability: CheckOutcome;
  commitment_preservation: CheckOutcome;
  task_check: CheckOutcome;
  /** Whether a strong-eval.json was present for this run. */
  strong_eval_present: boolean;
  /** Local-only labels (project/workflow/provider/user_label/session). */
  labels: RunLabels;
  /** Notes about partial/missing artifacts for this run (honest provenance). */
  notes: string[];
}

export interface SkippedRunDirectory {
  run_directory: string;
  reason: string;
}

/**
 * Distinctness (duplicate-safety) summary over a set of runs, by content fingerprint.
 *
 * This is a count of DISTINCT captured runs by one-way content fingerprint, NOT a billing,
 * provider, or semantic claim. A run captured/aggregated twice with the SAME fingerprint is a
 * duplicate and is counted once; a run WITHOUT a fingerprint cannot be de-duplicated and is
 * treated as distinct (and reported in `runs_without_fingerprint`), never collapsed.
 *
 * The headline token/cost/savings totals in `AggregateTotals` are computed over the
 * duplicate-safe set (each distinct run once), so a re-captured run never double-counts.
 */
export interface DistinctnessSummary {
  /** Total runs considered before de-duplication (M in "distinct N of M"). */
  total_runs: number;
  /**
   * Distinct runs after de-duplication (N): distinct verified fingerprints + every run without
   * a fingerprint (each unidentifiable run is its own distinct contribution).
   */
  distinct_runs: number;
  /** Duplicate runs detected and excluded from the headline double-count (K = total - distinct). */
  duplicate_runs: number;
  /** Runs whose fingerprint was present and verifiable (contributed to `distinct_runs`, de-duplicated). */
  runs_with_fingerprint: number;
  /** Runs with NO fingerprint (older reports): each counted as distinct; cannot be de-duplicated. */
  runs_without_fingerprint: number;
}

/** Aggregated token/cost/savings totals over a set of runs, with the evidence split. */
export interface AggregateTotals {
  run_count: number;
  /** Token-evidence split: how many runs contributed provider-reported vs local-estimate figures. */
  runs_provider_reported: number;
  runs_local_estimate: number;
  runs_unknown_token_evidence: number;
  total_input_tokens_before: number;
  total_input_tokens_after: number;
  total_input_tokens_saved: number;
  /** Output tokens summed ONLY over runs that recorded them; unknown for the rest. */
  total_output_tokens_before: number;
  total_output_tokens_after: number;
  runs_with_output_tokens: number;
  runs_without_output_tokens: number;
  /** Estimated spend/savings (price-table; NOT billing-confirmed, NOT realized, NOT extrapolated). */
  total_estimated_cost_before_usd: number;
  total_estimated_cost_after_usd: number;
  total_estimated_savings_usd: number;
  /** Number of compactions = number of recorded runs rolled up (each run is one compaction). */
  compactions: number;
}

export interface VerificationCounts {
  /** Readiness verdict counts. */
  ready: number;
  conditional: number;
  not_ready: number;
  not_evaluated: number;
  /** Per-axis recoverability check counts. */
  recoverability_pass: number;
  recoverability_fail: number;
  recoverability_not_evaluated: number;
  /** Per-axis commitment-preservation check counts. */
  commitment_pass: number;
  commitment_fail: number;
  commitment_not_evaluated: number;
  /** Per-axis fixture task-check counts. */
  task_check_pass: number;
  task_check_fail: number;
  task_check_unsupported: number;
  task_check_not_evaluated: number;
}

export interface BreakdownBucket {
  key: string;
  totals: AggregateTotals;
  verification: VerificationCounts;
}

export interface SessionSummary {
  session_id: string;
  /** True when the session id came from an explicit local `session` label (vs run-id fallback). */
  explicit_session_label: boolean;
  run_ids: string[];
  /** Distinct local labels observed across the session's runs. */
  labels: {
    projects: string[];
    workflows: string[];
    providers: string[];
    user_labels: string[];
  };
  totals: AggregateTotals;
  verification: VerificationCounts;
  /** Duplicate-safety summary for this session's runs (distinct N of M by content fingerprint). */
  distinctness: DistinctnessSummary;
}

export interface AggregateReport {
  aggregate_id: string;
  generated_at: string;
  source_glob: string;
  /** Local-only label filters applied to this rollup (empty when none). */
  applied_filters: RunLabels;
  /** Operator-supplied provenance labels for THIS rollup (who/what produced it). Local only. */
  rollup_labels: RunLabels;
  session_count: number;
  totals: AggregateTotals;
  verification: VerificationCounts;
  /**
   * Cross-session duplicate-safety summary (distinct N of M captured runs by content fingerprint).
   * The headline `totals` above are computed over the duplicate-safe set, so a run captured/
   * aggregated twice with the same fingerprint is counted once and never inflates savings.
   */
  distinctness: DistinctnessSummary;
  sessions: SessionSummary[];
  /** Provider/runtime breakdown (operator-asserted provider label; unlabeled when absent). */
  by_provider: BreakdownBucket[];
  /** Project breakdown (local label). */
  by_project: BreakdownBucket[];
  /** Workflow breakdown (local label). */
  by_workflow: BreakdownBucket[];
  skipped_run_directories: SkippedRunDirectory[];
  evidence_labels: AggregateEvidenceLabels;
  limitations: string[];
}

/** The explicit per-field evidence labels, surfaced in the artifact so no figure is unlabeled. */
export interface AggregateEvidenceLabels {
  input_tokens: string;
  output_tokens: string;
  estimated_cost: string;
  estimated_savings: string;
  compactions: string;
  verification: string;
  provider_runtime: string;
  distinctness: string;
}

export const AGGREGATE_EVIDENCE_LABELS: AggregateEvidenceLabels = {
  input_tokens:
    "input tokens: provider-reported where the run's token accounting was measured (provider usage " +
    "metadata present), otherwise local estimate (chars/4); see the provider-reported / local-estimate " +
    "run split. Never billing-confirmed.",
  output_tokens:
    "output tokens: shown only for runs that recorded them (strong-eval token accounting); runs without " +
    "a strong-eval contribute unknown output tokens and are counted separately - never inferred.",
  estimated_cost:
    "estimated cost: price-table estimate over the token figures (token-estimated cost / local estimate). " +
    "NOT a billed figure, NOT billing-confirmed.",
  estimated_savings:
    "estimated savings: estimated, summed over the recorded runs only. NOT billing-confirmed, NOT " +
    "realized, and NOT extrapolated to any time period.",
  compactions:
    "compactions: count of recorded local runs rolled up (one compaction per recorded run). No run " +
    "volume is assumed or projected.",
  verification:
    "verification: readiness (ready/conditional/not_ready) and per-axis recoverability / commitment / " +
    "task-check outcomes copied from each run's strong-eval; runs without a strong-eval are not_evaluated, " +
    "never counted as a pass. These are DETERMINISTIC recoverability checks, NOT semantic guarantees.",
  provider_runtime:
    "provider/runtime: operator-ASSERTED local label (never provider-verified); runs without a provider " +
    "label are grouped under 'unlabeled'. This label is distinct from the token-evidence tier.",
  distinctness:
    "distinct runs: a count of DISTINCT captured runs by one-way content fingerprint (SHA-256 over the " +
    "normalized trace). A run captured/aggregated twice with the SAME fingerprint is a duplicate and is " +
    "counted once, so headline savings are never inflated; runs without a fingerprint cannot be " +
    "de-duplicated and are each counted as distinct. This is a local content-distinctness count - NOT a " +
    "billing, provider, or semantic claim."
};

const STANDARD_LIMITATIONS: string[] = [
  "Aggregated from LOCAL artifacts only (.compaction/runs/*/{report.json,strong-eval.json,run-labels.json}); no provider calls, no upload, no telemetry.",
  "Estimated cost and savings are price-table local estimates summed over the recorded runs only; never billing-confirmed, never realized, never extrapolated to a time period.",
  "Token figures are provider-reported only for runs whose token accounting was measured; all other runs contribute local estimates (chars/4). The split is reported, never hidden.",
  "Output tokens are summed only over runs that recorded them; runs without a strong-eval contribute unknown output tokens and are counted separately, never inferred.",
  "Verification outcomes are deterministic recoverability checks copied from each run's strong-eval; they are NOT semantic or meaning-preservation guarantees. Runs without a strong-eval are not_evaluated, never a pass.",
  "Labels (project/workflow/provider/user-label/session) are operator-supplied local tags with no evidence weight; provider here is operator-asserted, not provider-verified.",
  "Headline savings are duplicate-safe: runs sharing a content fingerprint (a re-captured/re-aggregated run) are counted once; runs without a fingerprint cannot be de-duplicated and are each counted as distinct. This is a local content-distinctness count, not a billing/provider/semantic claim.",
  "This is a LOCAL, file-based rollup. There is no hosted dashboard, database, auth, billing, model routing, or provider integration."
];

function round6(value: number): number {
  return Number((value + Number.EPSILON).toFixed(6));
}

/**
 * De-duplicate a set of runs by content fingerprint for duplicate-safe headline totals.
 *
 * Keeps the FIRST run per distinct verified fingerprint; later runs with the same fingerprint
 * are duplicates and are dropped from the headline (so a re-captured run never double-counts its
 * savings). Runs WITHOUT a fingerprint are kept as-is, each is its own distinct contribution,
 * because distinctness that cannot be verified is never collapsed (the anti-overcount contract in
 * `classifyDistinctness`). Returns the duplicate-safe run set plus an honest distinctness summary.
 *
 * PURE: order-stable for the kept runs; makes savings MORE conservative, never larger.
 */
function dedupeRunsByFingerprint(runs: RunRecord[]): {
  distinctRuns: RunRecord[];
  distinctness: DistinctnessSummary;
} {
  const seenFingerprints = new Set<string>();
  const distinctRuns: RunRecord[] = [];
  let runsWithFingerprint = 0;
  let runsWithoutFingerprint = 0;

  for (const run of runs) {
    const fp = run.trace_fingerprint;
    if (typeof fp === "string" && fp.length > 0) {
      runsWithFingerprint += 1;
      if (seenFingerprints.has(fp)) continue; // duplicate fingerprint: excluded from headline.
      seenFingerprints.add(fp);
      distinctRuns.push(run);
    } else {
      runsWithoutFingerprint += 1;
      distinctRuns.push(run); // unidentifiable: always its own distinct contribution.
    }
  }

  // classifyDistinctness gives the verified-distinct count over the SAME records; distinct_runs is
  // that verified-distinct count plus every unidentifiable run (each distinct by construction).
  const classified = classifyDistinctness(
    runs.map((run): DistinctnessRecord => ({ runId: run.run_id, content_sha256: run.trace_fingerprint }))
  );
  const distinctRunCount = classified.distinct_verified_count + runsWithoutFingerprint;

  return {
    distinctRuns,
    distinctness: {
      total_runs: runs.length,
      distinct_runs: distinctRunCount,
      duplicate_runs: runs.length - distinctRunCount,
      runs_with_fingerprint: runsWithFingerprint,
      runs_without_fingerprint: runsWithoutFingerprint
    }
  };
}

function emptyDistinctness(): DistinctnessSummary {
  return {
    total_runs: 0,
    distinct_runs: 0,
    duplicate_runs: 0,
    runs_with_fingerprint: 0,
    runs_without_fingerprint: 0
  };
}

function emptyTotals(): AggregateTotals {
  return {
    run_count: 0,
    runs_provider_reported: 0,
    runs_local_estimate: 0,
    runs_unknown_token_evidence: 0,
    total_input_tokens_before: 0,
    total_input_tokens_after: 0,
    total_input_tokens_saved: 0,
    total_output_tokens_before: 0,
    total_output_tokens_after: 0,
    runs_with_output_tokens: 0,
    runs_without_output_tokens: 0,
    total_estimated_cost_before_usd: 0,
    total_estimated_cost_after_usd: 0,
    total_estimated_savings_usd: 0,
    compactions: 0
  };
}

function emptyVerification(): VerificationCounts {
  return {
    ready: 0,
    conditional: 0,
    not_ready: 0,
    not_evaluated: 0,
    recoverability_pass: 0,
    recoverability_fail: 0,
    recoverability_not_evaluated: 0,
    commitment_pass: 0,
    commitment_fail: 0,
    commitment_not_evaluated: 0,
    task_check_pass: 0,
    task_check_fail: 0,
    task_check_unsupported: 0,
    task_check_not_evaluated: 0
  };
}

function addRunToTotals(totals: AggregateTotals, run: RunRecord): void {
  totals.run_count += 1;
  totals.compactions += 1;
  if (run.token_evidence === "provider_reported") totals.runs_provider_reported += 1;
  else if (run.token_evidence === "local_estimate") totals.runs_local_estimate += 1;
  else totals.runs_unknown_token_evidence += 1;

  totals.total_input_tokens_before += run.input_tokens_before;
  totals.total_input_tokens_after += run.input_tokens_after;
  totals.total_input_tokens_saved += run.input_tokens_saved;

  if (run.output_tokens_before !== "unknown" && run.output_tokens_after !== "unknown") {
    totals.total_output_tokens_before += run.output_tokens_before;
    totals.total_output_tokens_after += run.output_tokens_after;
    totals.runs_with_output_tokens += 1;
  } else {
    totals.runs_without_output_tokens += 1;
  }

  totals.total_estimated_cost_before_usd += run.estimated_cost_before_usd;
  totals.total_estimated_cost_after_usd += run.estimated_cost_after_usd;
  totals.total_estimated_savings_usd += run.estimated_saving_usd;
}

function normalizeTotals(totals: AggregateTotals): void {
  totals.total_estimated_cost_before_usd = round6(totals.total_estimated_cost_before_usd);
  totals.total_estimated_cost_after_usd = round6(totals.total_estimated_cost_after_usd);
  totals.total_estimated_savings_usd = round6(totals.total_estimated_savings_usd);
}

function addRunToVerification(v: VerificationCounts, run: RunRecord): void {
  v[run.readiness] += 1;

  if (run.recoverability === "pass") v.recoverability_pass += 1;
  else if (run.recoverability === "fail") v.recoverability_fail += 1;
  else v.recoverability_not_evaluated += 1;

  if (run.commitment_preservation === "pass") v.commitment_pass += 1;
  else if (run.commitment_preservation === "fail") v.commitment_fail += 1;
  else v.commitment_not_evaluated += 1;

  if (run.task_check === "pass") v.task_check_pass += 1;
  else if (run.task_check === "fail") v.task_check_fail += 1;
  else if (run.task_check === "unsupported") v.task_check_unsupported += 1;
  else v.task_check_not_evaluated += 1;
}

function distinct(values: (string | undefined)[]): string[] {
  return [...new Set(values.filter((v): v is string => typeof v === "string" && v.length > 0))].sort();
}

function sessionIdFor(run: RunRecord): { id: string; explicit: boolean } {
  if (run.labels.session !== undefined) return { id: run.labels.session, explicit: true };
  return { id: run.run_id, explicit: false };
}

/** True when a run passes every supplied local-label filter (case-sensitive exact match). */
export function runMatchesFilters(run: RunRecord, filters: RunLabels): boolean {
  if (filters.project !== undefined && run.labels.project !== filters.project) return false;
  if (filters.workflow !== undefined && run.labels.workflow !== filters.workflow) return false;
  if (filters.provider !== undefined && run.labels.provider !== filters.provider) return false;
  if (filters.user_label !== undefined && run.labels.user_label !== filters.user_label) return false;
  if (filters.session !== undefined && run.labels.session !== filters.session) return false;
  return true;
}

function buildBreakdown(runs: RunRecord[], keyOf: (run: RunRecord) => string): BreakdownBucket[] {
  const buckets = new Map<string, { totals: AggregateTotals; verification: VerificationCounts }>();
  for (const run of runs) {
    const key = keyOf(run);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { totals: emptyTotals(), verification: emptyVerification() };
      buckets.set(key, bucket);
    }
    addRunToTotals(bucket.totals, run);
    addRunToVerification(bucket.verification, run);
  }
  return [...buckets.entries()]
    .map(([key, bucket]) => {
      normalizeTotals(bucket.totals);
      return { key, totals: bucket.totals, verification: bucket.verification };
    })
    .sort((a, b) => b.totals.total_input_tokens_saved - a.totals.total_input_tokens_saved || a.key.localeCompare(b.key));
}

function buildSessions(runs: RunRecord[]): SessionSummary[] {
  const sessions = new Map<string, { explicit: boolean; runs: RunRecord[] }>();
  for (const run of runs) {
    const { id, explicit } = sessionIdFor(run);
    let session = sessions.get(id);
    if (!session) {
      session = { explicit, runs: [] };
      sessions.set(id, session);
    }
    // An explicit label anywhere marks the session explicit.
    session.explicit = session.explicit || explicit;
    session.runs.push(run);
  }

  return [...sessions.entries()]
    .map(([sessionId, { explicit, runs: sessionRuns }]) => {
      // Duplicate-safe: fold totals/verification over distinct runs only (re-captured runs with
      // the same fingerprint are excluded from the double-count). run_ids still lists every run.
      const { distinctRuns, distinctness } = dedupeRunsByFingerprint(sessionRuns);
      const totals = emptyTotals();
      const verification = emptyVerification();
      for (const run of distinctRuns) {
        addRunToTotals(totals, run);
        addRunToVerification(verification, run);
      }
      normalizeTotals(totals);
      return {
        session_id: sessionId,
        explicit_session_label: explicit,
        run_ids: sessionRuns.map((r) => r.run_id).sort(),
        labels: {
          projects: distinct(sessionRuns.map((r) => r.labels.project)),
          workflows: distinct(sessionRuns.map((r) => r.labels.workflow)),
          providers: distinct(sessionRuns.map((r) => r.labels.provider)),
          user_labels: distinct(sessionRuns.map((r) => r.labels.user_label))
        },
        totals,
        verification,
        distinctness
      };
    })
    .sort(
      (a, b) =>
        b.totals.total_input_tokens_saved - a.totals.total_input_tokens_saved ||
        a.session_id.localeCompare(b.session_id)
    );
}

/**
 * Build the aggregate id (which also becomes the output DIRECTORY name in `aggregate.ts`).
 *
 * Truncating `generatedAt` to second granularity (`YYYYMMDDHHMMSS`) made two rollups generated in
 * the SAME second, e.g. a filtered then an unfiltered run back-to-back, collide on the same id,
 * so the second silently OVERWROTE the first's directory (data loss). Include sub-second entropy so
 * concurrent / back-to-back rollups get DISTINCT ids and paths:
 *  - the FULL timestamp digits (keeps milliseconds), and
 *  - a short random suffix, so even two rollups in the same millisecond (a reused explicit
 *    `generatedAt`, or sub-millisecond synchronous calls) still differ.
 * The id stays stably sortable by time because the timestamp digits lead.
 */
function aggregateIdFromGeneratedAt(generatedAt: string): string {
  const timestampDigits = generatedAt.replace(/[^0-9]/g, "");
  const entropy = randomUUID().slice(0, 8);
  return `aggregate-${timestampDigits}-${entropy}`;
}

export interface BuildAggregateOptions {
  generatedAt?: string;
  sourceGlob?: string;
  /** Local-only label filters: only runs matching ALL supplied fields are rolled up. */
  filters?: RunLabels;
  /** Operator provenance labels for this rollup (who/what produced it). Local only. */
  rollupLabels?: RunLabels;
  skippedRunDirectories?: SkippedRunDirectory[];
}

/**
 * PURE rollup: fold a set of normalized run records into the per-session + cross-session
 * aggregate report. No IO. Applies the supplied local-label filters first.
 */
export function buildAggregateReport(runs: RunRecord[], options: BuildAggregateOptions = {}): AggregateReport {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const filters = options.filters ?? {};
  const matched = runs.filter((run) => runMatchesFilters(run, filters));

  // Duplicate-safe headline: fold cross-session totals/verification over the distinct run set only.
  // A run captured/aggregated twice with the same content fingerprint is counted once; runs without
  // a fingerprint are each distinct (cannot dedup what cannot be identified). Never inflates savings.
  const { distinctRuns, distinctness } = dedupeRunsByFingerprint(matched);
  const totals = emptyTotals();
  const verification = emptyVerification();
  for (const run of distinctRuns) {
    addRunToTotals(totals, run);
    addRunToVerification(verification, run);
  }
  normalizeTotals(totals);

  const sessions = buildSessions(matched);

  return {
    aggregate_id: aggregateIdFromGeneratedAt(generatedAt),
    generated_at: generatedAt,
    source_glob: options.sourceGlob ?? ".compaction/runs/*/report.json",
    applied_filters: filters,
    rollup_labels: options.rollupLabels ?? {},
    session_count: sessions.length,
    totals,
    verification,
    distinctness,
    sessions,
    // Breakdowns also fold over the duplicate-safe distinct run set so per-bucket savings match the
    // duplicate-safe headline (a re-captured run never double-counts inside its label bucket either).
    by_provider: buildBreakdown(distinctRuns, (run) => run.labels.provider ?? NO_LABEL),
    by_project: buildBreakdown(distinctRuns, (run) => run.labels.project ?? NO_LABEL),
    by_workflow: buildBreakdown(distinctRuns, (run) => run.labels.workflow ?? NO_LABEL),
    skipped_run_directories: options.skippedRunDirectories ?? [],
    evidence_labels: AGGREGATE_EVIDENCE_LABELS,
    limitations: STANDARD_LIMITATIONS
  };
}

// ----------------------------------------------------------------------------------
// IO: read run records from the local .compaction/runs tree. The ONLY IO in this file.
// ----------------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Map a strong-eval token-accounting "measured" flag to a token-evidence tier. */
function tokenEvidenceFrom(measured: unknown): RunTokenEvidence {
  return measured === true ? "provider_reported" : "local_estimate";
}

function checkOutcomeFromStatus(status: unknown, kind: "recoverability" | "commitment" | "task"): CheckOutcome {
  if (status === "passed") return "pass";
  if (status === "failed") return "fail";
  if (kind === "task" && status === "unsupported") return "unsupported";
  // recoverability "not_computed" / commitment "not_computed" / anything else → not_evaluated.
  return "not_evaluated";
}

function readinessFrom(status: unknown): VerificationReadiness {
  if (status === "ready" || status === "conditional" || status === "not_ready") return status;
  return "not_evaluated";
}

/**
 * Assemble a normalized RunRecord from a run directory's local artifacts. report.json is
 * REQUIRED (skipped otherwise). strong-eval.json and run-labels.json are OPTIONAL: absence
 * is recorded honestly (not_evaluated verification, unknown output tokens), never inferred.
 */
export function assembleRunRecord(input: {
  runId: string;
  runDirectory: string;
  reportPath: string;
  report: CompactionReport;
  strongEval: unknown;
  labels: RunLabels;
}): RunRecord {
  const { report, strongEval } = input;
  const notes: string[] = [];

  // Content-addressed run identity: read the OPTIONAL trace_fingerprint digest if the report
  // carried one. Older reports omit it; such a run cannot be de-duplicated and is treated as
  // distinct (noted), never collapsed. Read defensively (digest string only; no content).
  const fingerprintDigest =
    isRecord(report.trace_fingerprint) && typeof report.trace_fingerprint.content_sha256 === "string"
      ? report.trace_fingerprint.content_sha256
      : null;
  if (fingerprintDigest === null) {
    notes.push("No trace_fingerprint on report.json: this run is treated as distinct (cannot de-duplicate an unidentifiable run).");
  }

  let tokenEvidence: RunTokenEvidence = "local_estimate";
  let inputBefore = report.original_input_tokens;
  let inputAfter = report.compacted_input_tokens;
  let inputSaved = report.tokens_saved;
  let outputBefore: number | "unknown" = "unknown";
  let outputAfter: number | "unknown" = "unknown";
  let costBefore = report.cost_before_per_run;
  let costAfter = report.cost_after_per_run;
  let saving = report.saving_per_run;
  let readiness: VerificationReadiness = "not_evaluated";
  let recoverability: CheckOutcome = "not_evaluated";
  let commitment: CheckOutcome = "not_evaluated";
  let taskCheck: CheckOutcome = "not_evaluated";
  let strongEvalPresent = false;
  let model = report.model;

  if (isRecord(strongEval)) {
    strongEvalPresent = true;
    const tokenAccounting = isRecord(strongEval.token_accounting) ? strongEval.token_accounting : undefined;
    if (tokenAccounting) {
      tokenEvidence = tokenEvidenceFrom(tokenAccounting.measured);
      if (typeof tokenAccounting.model === "string" && tokenAccounting.model.length > 0) {
        model = tokenAccounting.model;
      }
      const ib = isRecord(tokenAccounting.input_tokens_before) ? num(tokenAccounting.input_tokens_before.value) : null;
      const ia = isRecord(tokenAccounting.input_tokens_after) ? num(tokenAccounting.input_tokens_after.value) : null;
      const ob = isRecord(tokenAccounting.output_tokens_before) ? num(tokenAccounting.output_tokens_before.value) : null;
      const oa = isRecord(tokenAccounting.output_tokens_after) ? num(tokenAccounting.output_tokens_after.value) : null;
      const cb = num(tokenAccounting.estimated_cost_before_usd);
      const ca = num(tokenAccounting.estimated_cost_after_usd);
      const sv = num(tokenAccounting.estimated_saving_per_run_usd);
      const saved = num(tokenAccounting.input_tokens_saved);
      if (ib !== null) inputBefore = ib;
      if (ia !== null) inputAfter = ia;
      if (saved !== null) inputSaved = saved;
      if (ob !== null) outputBefore = ob;
      if (oa !== null) outputAfter = oa;
      if (cb !== null) costBefore = cb;
      if (ca !== null) costAfter = ca;
      if (sv !== null) saving = sv;
    } else {
      notes.push("strong-eval.json present but token_accounting was missing; used report.json token/cost figures.");
    }

    const readinessBlock = isRecord(strongEval.readiness) ? strongEval.readiness : undefined;
    readiness = readinessFrom(readinessBlock?.readiness);

    const recovEval = isRecord(strongEval.recoverability_eval) ? strongEval.recoverability_eval : undefined;
    recoverability = checkOutcomeFromStatus(recovEval?.recoverability, "recoverability");

    const commitmentBlock = isRecord(strongEval.commitment_preservation) ? strongEval.commitment_preservation : undefined;
    commitment = checkOutcomeFromStatus(commitmentBlock?.status, "commitment");

    const taskBlock = isRecord(strongEval.task_check) ? strongEval.task_check : undefined;
    taskCheck = checkOutcomeFromStatus(taskBlock?.status, "task");
  } else {
    tokenEvidence = "local_estimate";
    notes.push("No strong-eval.json: verification outcomes are not_evaluated and output tokens are unknown for this run.");
  }

  return {
    run_id: input.runId,
    run_directory: input.runDirectory,
    report_path: input.reportPath,
    model,
    trace_fingerprint: fingerprintDigest,
    token_evidence: tokenEvidence,
    input_tokens_before: inputBefore,
    input_tokens_after: inputAfter,
    input_tokens_saved: inputSaved,
    output_tokens_before: outputBefore,
    output_tokens_after: outputAfter,
    estimated_cost_before_usd: costBefore,
    estimated_cost_after_usd: costAfter,
    estimated_saving_usd: saving,
    readiness,
    recoverability,
    commitment_preservation: commitment,
    task_check: taskCheck,
    strong_eval_present: strongEvalPresent,
    labels: input.labels,
    notes
  };
}

async function readJsonIfPresent(path: string): Promise<{ value?: unknown; reason?: string }> {
  try {
    return { value: JSON.parse(await readFile(path, "utf8")) as unknown };
  } catch (error: unknown) {
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : null;
    if (code === "ENOENT") return {};
    if (error instanceof SyntaxError) return { reason: "invalid JSON" };
    return { reason: "could not read file" };
  }
}

function validReport(value: unknown): value is CompactionReport {
  if (!isRecord(value)) return false;
  return (
    typeof value.run_id === "string" &&
    num(value.original_input_tokens) !== null &&
    num(value.compacted_input_tokens) !== null &&
    num(value.tokens_saved) !== null &&
    num(value.cost_before_per_run) !== null &&
    num(value.cost_after_per_run) !== null &&
    num(value.saving_per_run) !== null
  );
}

/**
 * Read every run directory under `runsDirectory`, assembling one RunRecord per directory that
 * carries a valid report.json. The ONLY IO path. Reads exclusively local files; makes NO
 * network call. Directories without a valid report.json are recorded as skipped, never dropped
 * silently.
 */
export async function collectRunRecords(runsDirectory = ".compaction/runs"): Promise<{
  runs: RunRecord[];
  skipped: SkippedRunDirectory[];
}> {
  let runDirs: string[];
  try {
    const entries = await readdir(runsDirectory, { withFileTypes: true });
    runDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch (error: unknown) {
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "unknown";
    if (code === "ENOENT") return { runs: [], skipped: [] };
    throw error;
  }
  const runs: RunRecord[] = [];
  const skipped: SkippedRunDirectory[] = [];

  for (const dirName of runDirs) {
    const runDirectory = join(runsDirectory, dirName);
    const reportPath = join(runDirectory, "report.json");
    const reportRead = await readJsonIfPresent(reportPath);
    if (reportRead.value === undefined) {
      skipped.push({ run_directory: runDirectory, reason: reportRead.reason ?? "report.json not found" });
      continue;
    }
    if (!validReport(reportRead.value)) {
      skipped.push({ run_directory: runDirectory, reason: "report.json missing required fields" });
      continue;
    }
    const report = reportRead.value;

    const strongRead = await readJsonIfPresent(join(runDirectory, "strong-eval.json"));
    const labelsRead = await readJsonIfPresent(join(runDirectory, "run-labels.json"));
    const labels = parseRunLabels(labelsRead.value);

    runs.push(
      assembleRunRecord({
        runId: report.run_id,
        runDirectory,
        reportPath,
        report,
        strongEval: strongRead.value,
        labels
      })
    );
  }

  return { runs, skipped };
}

/** Read records + build the report in one call (local IO + pure rollup). */
export async function createAggregateReport(
  runsDirectory = ".compaction/runs",
  options: Omit<BuildAggregateOptions, "skippedRunDirectories"> = {}
): Promise<AggregateReport> {
  const { runs, skipped } = await collectRunRecords(runsDirectory);
  return buildAggregateReport(runs, {
    ...options,
    sourceGlob: options.sourceGlob ?? `${runsDirectory}/*/report.json`,
    skippedRunDirectories: skipped
  });
}
