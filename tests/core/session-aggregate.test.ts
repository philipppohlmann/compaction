import { describe, expect, it } from "vitest";
import {
  assembleRunRecord,
  buildAggregateReport,
  runMatchesFilters,
  type RunRecord
} from "../../src/core/session-aggregate.js";
import { formatAggregateReport } from "../../src/core/aggregate-format.js";
import type { CompactionReport } from "../../src/core/types.js";
import type { RunLabels } from "../../src/core/run-labels.js";

function baseReport(overrides: Partial<CompactionReport> = {}): CompactionReport {
  return {
    run_id: "run-x",
    trace_title: "trace x",
    model: "gpt-4o",
    original_input_tokens: 1000,
    compacted_input_tokens: 600,
    tokens_saved: 400,
    percent_reduction: 40,
    cost_before_per_run: 0.01,
    cost_after_per_run: 0.006,
    saving_per_run: 0.004,
    policy_name: "stale_tool_output_to_state_capsule",
    waste_pattern: "repeated_tool_output",
    source_message_id: "m1",
    repeated_count: 2,
    compacted_message_ids: ["m1"],
    artifact_version: "1",
    created_at: "2026-06-16T00:00:00.000Z",
    generated_at: "2026-06-16T00:00:00.000Z",
    approval_readiness_status: "conditional",
    approval_readiness_reason: "fixture",
    ...overrides
  };
}

/** A strong-eval shaped object that exercises every verification axis + token accounting. */
function strongEval(opts: {
  measured?: boolean;
  inputBefore?: number;
  inputAfter?: number;
  outputBefore?: number;
  outputAfter?: number;
  costBefore?: number;
  costAfter?: number;
  saving?: number;
  readiness?: string;
  recoverability?: string;
  commitment?: string;
  task?: string;
}): unknown {
  return {
    recoverability_eval: { recoverability: opts.recoverability ?? "passed" },
    commitment_preservation: { status: opts.commitment ?? "passed" },
    task_check: { status: opts.task ?? "passed" },
    token_accounting: {
      model: "gpt-4o",
      measured: opts.measured ?? false,
      input_tokens_before: { value: opts.inputBefore ?? 1000, source: opts.measured ? "provider_reported" : "local_estimate" },
      input_tokens_after: { value: opts.inputAfter ?? 600, source: opts.measured ? "provider_reported" : "local_estimate" },
      output_tokens_before: { value: opts.outputBefore ?? 120, source: "local_estimate" },
      output_tokens_after: { value: opts.outputAfter ?? 120, source: "local_estimate" },
      input_tokens_saved: (opts.inputBefore ?? 1000) - (opts.inputAfter ?? 600),
      estimated_cost_before_usd: opts.costBefore ?? 0.01,
      estimated_cost_after_usd: opts.costAfter ?? 0.006,
      estimated_saving_per_run_usd: opts.saving ?? 0.004
    },
    readiness: { readiness: opts.readiness ?? "conditional" }
  };
}

function record(overrides: Partial<RunRecord> & { run_id: string }): RunRecord {
  return {
    run_directory: `.compaction/runs/${overrides.run_id}`,
    report_path: `.compaction/runs/${overrides.run_id}/report.json`,
    model: "gpt-4o",
    trace_fingerprint: null,
    token_evidence: "local_estimate",
    input_tokens_before: 1000,
    input_tokens_after: 600,
    input_tokens_saved: 400,
    output_tokens_before: 120,
    output_tokens_after: 120,
    estimated_cost_before_usd: 0.01,
    estimated_cost_after_usd: 0.006,
    estimated_saving_usd: 0.004,
    readiness: "conditional",
    recoverability: "pass",
    commitment_preservation: "pass",
    task_check: "pass",
    strong_eval_present: true,
    labels: {},
    notes: [],
    ...overrides
  };
}

describe("assembleRunRecord", () => {
  it("reads token/cost/output + verification outcomes from strong-eval when present", () => {
    const r = assembleRunRecord({
      runId: "run-x",
      runDirectory: ".compaction/runs/run-x",
      reportPath: ".compaction/runs/run-x/report.json",
      report: baseReport(),
      strongEval: strongEval({ measured: true, outputBefore: 200, outputAfter: 200 }),
      labels: {}
    });
    expect(r.strong_eval_present).toBe(true);
    expect(r.token_evidence).toBe("provider_reported");
    expect(r.output_tokens_before).toBe(200);
    expect(r.readiness).toBe("conditional");
    expect(r.recoverability).toBe("pass");
    expect(r.commitment_preservation).toBe("pass");
    expect(r.task_check).toBe("pass");
  });

  it("fails closed when no strong-eval: not_evaluated verification + unknown output tokens", () => {
    const r = assembleRunRecord({
      runId: "run-y",
      runDirectory: ".compaction/runs/run-y",
      reportPath: ".compaction/runs/run-y/report.json",
      report: baseReport({ run_id: "run-y" }),
      strongEval: undefined,
      labels: {}
    });
    expect(r.strong_eval_present).toBe(false);
    expect(r.readiness).toBe("not_evaluated");
    expect(r.recoverability).toBe("not_evaluated");
    expect(r.commitment_preservation).toBe("not_evaluated");
    expect(r.task_check).toBe("not_evaluated");
    expect(r.output_tokens_before).toBe("unknown");
    expect(r.output_tokens_after).toBe("unknown");
    // Falls back to report.json token/cost figures.
    expect(r.input_tokens_saved).toBe(400);
    expect(r.estimated_saving_usd).toBe(0.004);
  });

  it("maps a failed/unsupported task-check honestly", () => {
    const r = assembleRunRecord({
      runId: "run-z",
      runDirectory: ".compaction/runs/run-z",
      reportPath: ".compaction/runs/run-z/report.json",
      report: baseReport({ run_id: "run-z" }),
      strongEval: strongEval({ readiness: "not_ready", recoverability: "failed", task: "unsupported", commitment: "failed" }),
      labels: {}
    });
    expect(r.readiness).toBe("not_ready");
    expect(r.recoverability).toBe("fail");
    expect(r.task_check).toBe("unsupported");
    expect(r.commitment_preservation).toBe("fail");
  });
});

describe("buildAggregateReport - rollup math", () => {
  it("sums tokens, cost, savings, compaction count and the token-evidence split across runs", () => {
    const runs = [
      record({ run_id: "r1", token_evidence: "provider_reported", input_tokens_saved: 400, estimated_saving_usd: 0.004 }),
      record({ run_id: "r2", token_evidence: "local_estimate", input_tokens_before: 800, input_tokens_after: 500, input_tokens_saved: 300, estimated_cost_before_usd: 0.008, estimated_cost_after_usd: 0.005, estimated_saving_usd: 0.003 }),
      record({ run_id: "r3", token_evidence: "local_estimate", output_tokens_before: "unknown", output_tokens_after: "unknown", strong_eval_present: false, readiness: "not_evaluated", recoverability: "not_evaluated", commitment_preservation: "not_evaluated", task_check: "not_evaluated" })
    ];
    const report = buildAggregateReport(runs, { generatedAt: "2026-06-16T00:00:00.000Z" });

    expect(report.totals.compactions).toBe(3);
    expect(report.totals.run_count).toBe(3);
    expect(report.totals.runs_provider_reported).toBe(1);
    expect(report.totals.runs_local_estimate).toBe(2);
    expect(report.totals.total_input_tokens_saved).toBe(400 + 300 + 400);
    expect(report.totals.total_input_tokens_before).toBe(1000 + 800 + 1000);
    expect(report.totals.total_estimated_savings_usd).toBeCloseTo(0.004 + 0.003 + 0.004, 6);

    // Output tokens summed only over runs that recorded them; the unknown one counted separately.
    expect(report.totals.runs_with_output_tokens).toBe(2);
    expect(report.totals.runs_without_output_tokens).toBe(1);
    expect(report.totals.total_output_tokens_before).toBe(120 + 120);
  });

  it("counts verification outcomes (readiness + per-axis pass/fail/unsupported/not_evaluated)", () => {
    const runs = [
      record({ run_id: "r1", readiness: "ready", recoverability: "pass", commitment_preservation: "pass", task_check: "pass" }),
      record({ run_id: "r2", readiness: "conditional", recoverability: "pass", commitment_preservation: "pass", task_check: "unsupported" }),
      record({ run_id: "r3", readiness: "not_ready", recoverability: "fail", commitment_preservation: "fail", task_check: "fail" }),
      record({ run_id: "r4", readiness: "not_evaluated", recoverability: "not_evaluated", commitment_preservation: "not_evaluated", task_check: "not_evaluated", strong_eval_present: false })
    ];
    const v = buildAggregateReport(runs, { generatedAt: "2026-06-16T00:00:00.000Z" }).verification;
    expect(v.ready).toBe(1);
    expect(v.conditional).toBe(1);
    expect(v.not_ready).toBe(1);
    expect(v.not_evaluated).toBe(1);
    expect(v.recoverability_pass).toBe(2);
    expect(v.recoverability_fail).toBe(1);
    expect(v.recoverability_not_evaluated).toBe(1);
    expect(v.commitment_pass).toBe(2);
    expect(v.commitment_fail).toBe(1);
    expect(v.task_check_pass).toBe(1);
    expect(v.task_check_unsupported).toBe(1);
    expect(v.task_check_fail).toBe(1);
    expect(v.task_check_not_evaluated).toBe(1);
  });

  it("groups runs into sessions by explicit session label, and falls back to run id otherwise", () => {
    const runs = [
      record({ run_id: "r1", labels: { session: "sessA" }, input_tokens_saved: 100 }),
      record({ run_id: "r2", labels: { session: "sessA" }, input_tokens_saved: 200 }),
      record({ run_id: "r3", labels: {}, input_tokens_saved: 50 })
    ];
    const report = buildAggregateReport(runs, { generatedAt: "2026-06-16T00:00:00.000Z" });
    expect(report.session_count).toBe(2);
    const sessA = report.sessions.find((s) => s.session_id === "sessA")!;
    expect(sessA.explicit_session_label).toBe(true);
    expect(sessA.run_ids).toEqual(["r1", "r2"]);
    expect(sessA.totals.total_input_tokens_saved).toBe(300);
    const fallback = report.sessions.find((s) => s.session_id === "r3")!;
    expect(fallback.explicit_session_label).toBe(false);
  });

  it("builds provider/workflow/project breakdowns with 'unlabeled' for absent labels", () => {
    const runs = [
      record({ run_id: "r1", labels: { provider: "openai-agents", project: "p1", workflow: "coding" }, input_tokens_saved: 100 }),
      record({ run_id: "r2", labels: {}, input_tokens_saved: 50 })
    ];
    const report = buildAggregateReport(runs, { generatedAt: "2026-06-16T00:00:00.000Z" });
    const providerKeys = report.by_provider.map((b) => b.key).sort();
    expect(providerKeys).toEqual(["openai-agents", "unlabeled"]);
    const labeled = report.by_provider.find((b) => b.key === "openai-agents")!;
    expect(labeled.totals.total_input_tokens_saved).toBe(100);
  });
});

describe("duplicate-safety by content fingerprint (attribution/integrity)", () => {
  it("(a) assembleRunRecord reads the OPTIONAL trace_fingerprint digest from report.json", () => {
    const withFp = assembleRunRecord({
      runId: "run-fp",
      runDirectory: ".compaction/runs/run-fp",
      reportPath: ".compaction/runs/run-fp/report.json",
      report: baseReport({ trace_fingerprint: { algorithm: "sha256-canonical-content-v1", content_sha256: "f".repeat(64), message_count: 3 } }),
      strongEval: undefined,
      labels: {}
    });
    expect(withFp.trace_fingerprint).toBe("f".repeat(64));

    const noFp = assembleRunRecord({
      runId: "run-old",
      runDirectory: ".compaction/runs/run-old",
      reportPath: ".compaction/runs/run-old/report.json",
      report: baseReport({ run_id: "run-old" }),
      strongEval: undefined,
      labels: {}
    });
    expect(noFp.trace_fingerprint).toBeNull();
    expect(noFp.notes.some((n) => n.includes("treated as distinct"))).toBe(true);
  });

  it("(b) two same-fingerprint runs → 1 distinct + 1 duplicate; headline savings NOT double-counted", () => {
    const sameFp = "a".repeat(64);
    const runs = [
      record({ run_id: "r1", trace_fingerprint: sameFp, input_tokens_saved: 400, estimated_saving_usd: 0.004 }),
      record({ run_id: "r1-recapture", trace_fingerprint: sameFp, input_tokens_saved: 400, estimated_saving_usd: 0.004 })
    ];
    const report = buildAggregateReport(runs, { generatedAt: "2026-06-16T00:00:00.000Z" });

    expect(report.distinctness).toEqual({
      total_runs: 2,
      distinct_runs: 1,
      duplicate_runs: 1,
      runs_with_fingerprint: 2,
      runs_without_fingerprint: 0
    });
    // Headline duplicate-safe: tokens saved counted ONCE (400, not 800); savings once.
    expect(report.totals.total_input_tokens_saved).toBe(400);
    expect(report.totals.total_estimated_savings_usd).toBeCloseTo(0.004, 6);
    expect(report.totals.compactions).toBe(1);

    const stdout = formatAggregateReport(report);
    expect(stdout).toContain("distinct runs 1 of 2 (1 duplicate(s) detected by content fingerprint");
  });

  it("two DIFFERENT-fingerprint runs → 2 distinct; both savings summed", () => {
    const runs = [
      record({ run_id: "r1", trace_fingerprint: "a".repeat(64), input_tokens_saved: 400, estimated_saving_usd: 0.004 }),
      record({ run_id: "r2", trace_fingerprint: "b".repeat(64), input_tokens_saved: 300, estimated_saving_usd: 0.003 })
    ];
    const report = buildAggregateReport(runs, { generatedAt: "2026-06-16T00:00:00.000Z" });
    expect(report.distinctness.distinct_runs).toBe(2);
    expect(report.distinctness.duplicate_runs).toBe(0);
    expect(report.totals.total_input_tokens_saved).toBe(700);
  });

  it("(c) runs WITHOUT a fingerprint are each distinct and noted (cannot dedup what you cannot identify)", () => {
    const runs = [
      record({ run_id: "old-1", trace_fingerprint: null, input_tokens_saved: 400, estimated_saving_usd: 0.004 }),
      record({ run_id: "old-2", trace_fingerprint: null, input_tokens_saved: 400, estimated_saving_usd: 0.004 })
    ];
    const report = buildAggregateReport(runs, { generatedAt: "2026-06-16T00:00:00.000Z" });
    expect(report.distinctness).toEqual({
      total_runs: 2,
      distinct_runs: 2,
      duplicate_runs: 0,
      runs_with_fingerprint: 0,
      runs_without_fingerprint: 2
    });
    // Both summed (never collapsed): 800 saved.
    expect(report.totals.total_input_tokens_saved).toBe(800);
    const stdout = formatAggregateReport(report);
    expect(stdout).toContain("2 run(s) without a fingerprint counted as distinct");
  });

  it("per-session distinctness is duplicate-safe too (re-capture within a session counted once)", () => {
    const sameFp = "c".repeat(64);
    const runs = [
      record({ run_id: "r1", labels: { session: "sessA" }, trace_fingerprint: sameFp, input_tokens_saved: 400 }),
      record({ run_id: "r2", labels: { session: "sessA" }, trace_fingerprint: sameFp, input_tokens_saved: 400 })
    ];
    const report = buildAggregateReport(runs, { generatedAt: "2026-06-16T00:00:00.000Z" });
    const sessA = report.sessions.find((s) => s.session_id === "sessA")!;
    expect(sessA.run_ids).toEqual(["r1", "r2"]); // both runs still listed
    expect(sessA.distinctness.distinct_runs).toBe(1); // but counted once
    expect(sessA.totals.total_input_tokens_saved).toBe(400); // savings not double-counted
  });
});

describe("label tagging + filtering", () => {
  const runs: RunRecord[] = [
    record({ run_id: "r1", labels: { project: "p1", workflow: "coding", provider: "openai-agents", user_label: "alice", session: "s1" } }),
    record({ run_id: "r2", labels: { project: "p1", workflow: "login" } }),
    record({ run_id: "r3", labels: { project: "p2" } })
  ];

  it("runMatchesFilters requires ALL supplied fields to match", () => {
    expect(runMatchesFilters(runs[0], { project: "p1", workflow: "coding" })).toBe(true);
    expect(runMatchesFilters(runs[0], { project: "p1", workflow: "login" })).toBe(false);
    expect(runMatchesFilters(runs[1], { provider: "openai-agents" })).toBe(false);
    expect(runMatchesFilters(runs[2], {})).toBe(true);
  });

  it("buildAggregateReport applies the filter and records it as applied_filters", () => {
    const filters: RunLabels = { project: "p1" };
    const report = buildAggregateReport(runs, { generatedAt: "2026-06-16T00:00:00.000Z", filters });
    expect(report.applied_filters).toEqual(filters);
    expect(report.totals.compactions).toBe(2);
    expect(report.sessions.flatMap((s) => s.run_ids).sort()).toEqual(["r1", "r2"]);
  });
});

describe("evidence honesty (labels carried on every figure)", () => {
  it("never labels a local-estimate run as provider-reported and never claims billing-confirmed", () => {
    const runs = [record({ run_id: "r1", token_evidence: "local_estimate" })];
    const report = buildAggregateReport(runs, { generatedAt: "2026-06-16T00:00:00.000Z" });
    expect(report.totals.runs_provider_reported).toBe(0);
    expect(report.totals.runs_local_estimate).toBe(1);
    const labelText = Object.values(report.evidence_labels).join(" ").toLowerCase();
    expect(labelText).toContain("never billing-confirmed");
    expect(labelText).toContain("not extrapolated to any time period");
  });
});

// DATA LOSS: aggregate_id becomes the output DIRECTORY name (aggregate.ts). Two rollups
// generated in the same second (or even the same millisecond - a reused explicit generatedAt) must
// NOT collide, or the second silently overwrites the first.
describe("aggregate_id sub-second uniqueness (no back-to-back collision)", () => {
  it("two rollups with the SAME generatedAt get distinct aggregate_ids", () => {
    const runs = [record({ run_id: "r1" })];
    const sameInstant = "2026-06-16T12:34:56.000Z";

    // Simulate the filtered + unfiltered back-to-back case sharing a generatedAt.
    const first = buildAggregateReport(runs, { generatedAt: sameInstant });
    const second = buildAggregateReport(runs, { generatedAt: sameInstant });

    expect(first.aggregate_id).not.toBe(second.aggregate_id);
    // Both still encode the timestamp (stable time-sortable prefix), differing only by entropy.
    expect(first.aggregate_id).toMatch(/^aggregate-20260616123456000-[0-9a-f]+$/);
    expect(second.aggregate_id).toMatch(/^aggregate-20260616123456000-[0-9a-f]+$/);
  });

  it("rollups one millisecond apart also get distinct ids", () => {
    const runs = [record({ run_id: "r1" })];
    const a = buildAggregateReport(runs, { generatedAt: "2026-06-16T12:34:56.001Z" });
    const b = buildAggregateReport(runs, { generatedAt: "2026-06-16T12:34:56.002Z" });
    expect(a.aggregate_id).not.toBe(b.aggregate_id);
  });
});
