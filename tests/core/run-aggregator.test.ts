import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  aggregateCompactionReports,
  computeMeasuredEstimateDelta,
  createRunSummary,
  formatRunSummary,
  formatRunSummaryMarkdown,
  MIN_RUNS_FOR_MEASURED_DELTA
} from "../../src/core/run-aggregator.js";
import type { CompactionReport } from "../../src/core/types.js";

const temporaryDirectories: string[] = [];

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "run-aggregator-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })));
});

function createReport(overrides: Partial<CompactionReport> = {}): CompactionReport {
  return {
    run_id: "run-a",
    trace_title: "Trace A",
    model: "placeholder-agent-model",
    original_input_tokens: 100,
    compacted_input_tokens: 60,
    tokens_saved: 40,
    percent_reduction: 40,
    cost_before_per_run: 0.0001,
    cost_after_per_run: 0.00006,
    saving_per_run: 0.00004,
    policy_name: "stale_tool_output_to_state_capsule",
    waste_pattern: "repeated_tool_output",
    source_message_id: "msg_001",
    repeated_count: 2,
    compacted_message_ids: ["msg_002"],
    artifact_version: "trace-compactor-v0",
    created_at: "2026-01-01T00:00:00.000Z",
    generated_at: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

describe("run aggregator", () => {
  it("aggregates valid compaction reports by policy, waste pattern, and top savings runs", () => {
    const summary = aggregateCompactionReports(
      [
        { path: ".compaction/runs/run-a/report.json", report: createReport() },
        {
          path: ".compaction/runs/run-b/report.json",
          report: createReport({
            run_id: "run-b",
            trace_title: "Trace B",
            original_input_tokens: 300,
            compacted_input_tokens: 120,
            tokens_saved: 180,
            percent_reduction: 60,
            cost_before_per_run: 0.0003,
            cost_after_per_run: 0.00012,
            saving_per_run: 0.00018,
            policy_name: "custom_policy",
            waste_pattern: null
          })
        }
      ],
      [{ path: ".compaction/runs/bad/report.json", reason: "invalid JSON" }],
      "2026-01-02T00:00:00.000Z"
    );

    expect(summary.total_runs).toBe(2);
    expect(summary.total_original_input_tokens).toBe(400);
    expect(summary.total_compacted_input_tokens).toBe(180);
    expect(summary.total_tokens_saved).toBe(220);
    expect(summary.average_percent_reduction).toBe(50);
    expect(summary.total_cost_before_per_run).toBeCloseTo(0.0004);
    expect(summary.total_cost_after_per_run).toBeCloseTo(0.00018);
    expect(summary.total_saving_per_run).toBeCloseTo(0.00022);
    expect(summary).not.toHaveProperty("total_projected_monthly_savings");
    expect(summary.skipped_files).toEqual([{ path: ".compaction/runs/bad/report.json", reason: "invalid JSON" }]);
    expect(summary.savings_by_policy.stale_tool_output_to_state_capsule?.total_runs).toBe(1);
    expect(summary.savings_by_policy.custom_policy?.total_tokens_saved).toBe(180);
    expect(summary.savings_by_waste_pattern.repeated_tool_output?.total_tokens_saved).toBe(40);
    expect(summary.savings_by_waste_pattern.none?.total_tokens_saved).toBe(180);
    expect(summary.top_savings_runs.map((run) => run.run_id)).toEqual(["run-b", "run-a"]);
  });

  it("reads report.json files from run directories and skips invalid or incomplete reports", async () => {
    const rootDirectory = await makeTemporaryDirectory();
    const runsDirectory = join(rootDirectory, "runs");
    await mkdir(join(runsDirectory, "valid"), { recursive: true });
    await mkdir(join(runsDirectory, "invalid-json"), { recursive: true });
    await mkdir(join(runsDirectory, "incomplete"), { recursive: true });
    await mkdir(join(runsDirectory, "missing-report"), { recursive: true });

    await writeFile(join(runsDirectory, "valid", "report.json"), `${JSON.stringify(createReport({ run_id: "valid" }))}\n`, "utf8");
    await writeFile(join(runsDirectory, "invalid-json", "report.json"), "{ nope", "utf8");
    await writeFile(join(runsDirectory, "incomplete", "report.json"), JSON.stringify({ run_id: "incomplete" }), "utf8");

    // Explicit (empty) records directory so this test never reads the repo's real .compaction/run-records.
    const summary = await createRunSummary(runsDirectory, join(rootDirectory, "run-records"));

    expect(summary.total_runs).toBe(1);
    expect(summary.total_tokens_saved).toBe(40);
    expect(summary.skipped_files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: join(runsDirectory, "invalid-json", "report.json"), reason: "invalid JSON" }),
        expect.objectContaining({ path: join(runsDirectory, "incomplete", "report.json"), reason: "missing or invalid trace_title" }),
        expect.objectContaining({ path: join(runsDirectory, "missing-report", "report.json"), reason: "report.json not found" })
      ])
    );
  });

  it("formats terminal and markdown summaries with totals and skipped files", () => {
    const summary = aggregateCompactionReports(
      [{ path: ".compaction/runs/run-a/report.json", report: createReport() }],
      [{ path: ".compaction/runs/bad/report.json", reason: "invalid JSON" }],
      "2026-01-02T00:00:00.000Z"
    );

    const terminal = formatRunSummary(summary);
    const markdown = formatRunSummaryMarkdown(summary);

    expect(terminal).toContain("compaction summary");
    expect(terminal).toContain("- tokens saved: 40");
    expect(terminal).toContain("1. run-a (Trace A)");
    expect(terminal).toContain(".compaction/runs/bad/report.json: invalid JSON");
    expect(markdown).toContain("# Compaction Run Summary");
    expect(markdown).toContain("- Total runs: 1");
    expect(markdown).toContain("| stale_tool_output_to_state_capsule | 1 | 40 | $0.000040 |");
    expect(markdown).not.toContain("Projected monthly savings");
  });

  function fingerprint(digest: string): CompactionReport["trace_fingerprint"] {
    return { algorithm: "sha256-canonical-content-v1", content_sha256: digest, message_count: 3 };
  }

  it("(b) detects two same-fingerprint runs as 1 distinct + 1 duplicate and does NOT double-count savings", () => {
    const sameFp = "a".repeat(64);
    const summary = aggregateCompactionReports([
      { path: ".compaction/runs/run-a/report.json", report: createReport({ run_id: "run-a", trace_fingerprint: fingerprint(sameFp) }) },
      { path: ".compaction/runs/run-a-recapture/report.json", report: createReport({ run_id: "run-a-recapture", trace_fingerprint: fingerprint(sameFp) }) }
    ]);

    // Distinctness: 1 distinct of 2 total, 1 duplicate detected.
    expect(summary.distinctness).toEqual({
      total_runs: 2,
      distinct_runs: 1,
      duplicate_runs: 1,
      runs_with_fingerprint: 2,
      runs_without_fingerprint: 0
    });
    // Headline is duplicate-safe: tokens saved counts the run ONCE (40, not 80); saving once.
    expect(summary.total_runs).toBe(1);
    expect(summary.total_tokens_saved).toBe(40);
    expect(summary.total_saving_per_run).toBeCloseTo(0.00004, 9);
    // The duplicate does not appear twice in the top-savings list.
    expect(summary.top_savings_runs).toHaveLength(1);

    const terminal = formatRunSummary(summary);
    expect(terminal).toContain("distinct runs 1 of 2 (1 duplicate(s) detected by content fingerprint");
  });

  it("counts two DIFFERENT-fingerprint runs as 2 distinct and sums both savings", () => {
    const summary = aggregateCompactionReports([
      { path: ".compaction/runs/run-a/report.json", report: createReport({ run_id: "run-a", trace_fingerprint: fingerprint("a".repeat(64)) }) },
      { path: ".compaction/runs/run-b/report.json", report: createReport({ run_id: "run-b", trace_fingerprint: fingerprint("b".repeat(64)) }) }
    ]);
    expect(summary.distinctness.distinct_runs).toBe(2);
    expect(summary.distinctness.duplicate_runs).toBe(0);
    expect(summary.total_tokens_saved).toBe(80);
  });

  it("(c) treats runs WITHOUT a fingerprint as distinct and notes them honestly", () => {
    const summary = aggregateCompactionReports([
      { path: ".compaction/runs/old-1/report.json", report: createReport({ run_id: "old-1" }) },
      { path: ".compaction/runs/old-2/report.json", report: createReport({ run_id: "old-2" }) }
    ]);
    // No fingerprint → cannot dedup → both distinct; savings summed over both (never collapsed).
    expect(summary.distinctness).toEqual({
      total_runs: 2,
      distinct_runs: 2,
      duplicate_runs: 0,
      runs_with_fingerprint: 0,
      runs_without_fingerprint: 2
    });
    expect(summary.total_tokens_saved).toBe(80);
    const terminal = formatRunSummary(summary);
    expect(terminal).toContain("distinct runs 2 of 2 (0 duplicate(s)");
    expect(terminal).toContain("2 run(s) without a fingerprint counted as distinct");
  });
});

describe("computeMeasuredEstimateDelta (V0.2 increment 2 - the measured rung)", () => {
  it("stays rung 1 (single-run/anecdote) below the distinct-run minimum", () => {
    for (const n of [0, 1, 2]) {
      const d = computeMeasuredEstimateDelta(Array.from({ length: n }, () => 40));
      expect(d.qualifies, `N=${n}`).toBe(false);
      expect(d.evidence_rung).toBe("local_estimate_single_run");
    }
    expect(MIN_RUNS_FOR_MEASURED_DELTA).toBe(3);
  });

  it("earns the measured rung only when N>=3 AND the mean ±2·SE excludes zero", () => {
    const tight = computeMeasuredEstimateDelta([40, 42, 41]); // low dispersion → excludes zero
    expect(tight.qualifies).toBe(true);
    expect(tight.evidence_rung).toBe("measured_caveated_estimate_delta");
    expect(tight.excludes_zero).toBe(true);
    expect(tight.ci_low).toBeGreaterThan(0);
    expect(tight.distinct_run_count).toBe(3);
  });

  it("does NOT qualify when dispersion is too wide (the ±2·SE interval includes zero)", () => {
    const wide = computeMeasuredEstimateDelta([2, 40, -30]); // high dispersion → interval crosses 0
    expect(wide.qualifies).toBe(false);
    expect(wide.excludes_zero).toBe(false);
    expect(wide.ci_low).toBeLessThanOrEqual(0);
    expect(wide.evidence_rung).toBe("local_estimate_single_run");
  });

  it("is honest: the label is estimate-class and NEVER claims billing-confirmed or eval-backed", () => {
    for (const input of [[40], [40, 42, 41], [2, 40, -30]]) {
      const label = computeMeasuredEstimateDelta(input).label.toLowerCase();
      expect(label).toContain("not billing-confirmed");
      expect(label).not.toContain("provider-reported");
      expect(label).not.toContain("per month");
      // The qualifying label explicitly says estimate + not eval-backed.
      if (input.length >= 3) {
        // no positive eval-backed/realized claim
        expect(label).not.toMatch(/\brealized savings\b(?!.*not)/);
      }
    }
  });
});

describe("aggregateCompactionReports - measured_estimate_delta surfacing", () => {
  it("qualifies for the measured rung across >=3 distinct runs with consistent reductions", () => {
    const summary = aggregateCompactionReports([
      { path: "a/report.json", report: createReport({ run_id: "a", percent_reduction: 40 }) },
      { path: "b/report.json", report: createReport({ run_id: "b", percent_reduction: 42 }) },
      { path: "c/report.json", report: createReport({ run_id: "c", percent_reduction: 41 }) }
    ]);
    expect(summary.measured_estimate_delta.distinct_run_count).toBe(3);
    expect(summary.measured_estimate_delta.qualifies).toBe(true);
    expect(summary.measured_estimate_delta.evidence_rung).toBe("measured_caveated_estimate_delta");
    // It surfaces in the rendered summary, honestly labeled.
    expect(formatRunSummary(summary)).toContain("measured_caveated_estimate_delta");
    expect(formatRunSummaryMarkdown(summary)).toContain("## Measured Estimate Delta");
    expect(formatRunSummaryMarkdown(summary)).toContain("NOT billing-confirmed");
  });

  it("stays rung 1 for a single run (anecdote, not a measured delta)", () => {
    const summary = aggregateCompactionReports([
      { path: "a/report.json", report: createReport({ run_id: "a", percent_reduction: 40 }) }
    ]);
    expect(summary.measured_estimate_delta.qualifies).toBe(false);
    expect(summary.measured_estimate_delta.evidence_rung).toBe("local_estimate_single_run");
  });
});
