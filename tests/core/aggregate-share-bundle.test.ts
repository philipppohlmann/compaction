import { describe, expect, it } from "vitest";
import { buildAggregateReport, type RunRecord } from "../../src/core/session-aggregate.js";
import {
  buildAggregateShareBundle,
  formatShareBundleMarkdown
} from "../../src/core/aggregate-format.js";

/**
 * The redacted aggregate share bundle must carry rolled-up numbers + labels + evidence tiers and
 * nothing that could leak trace content, run identifiers, or filesystem paths. These tests lock
 * that content-free guarantee shut.
 */

function record(overrides: Partial<RunRecord> & { run_id: string }): RunRecord {
  return {
    run_directory: `.compaction/runs/${overrides.run_id}`,
    report_path: `.compaction/runs/${overrides.run_id}/report.json`,
    model: "gpt-4o",
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

const RUNS: RunRecord[] = [
  record({
    run_id: "secret-run-id-aaa",
    run_directory: "/home/alice/secret-project/.compaction/runs/secret-run-id-aaa",
    report_path: "/home/alice/secret-project/.compaction/runs/secret-run-id-aaa/report.json",
    labels: { project: "p1", workflow: "coding", provider: "openai-agents", session: "sessZ", user_label: "alice-note" },
    input_tokens_saved: 400
  }),
  record({ run_id: "secret-run-id-bbb", labels: { project: "p1", session: "sessZ" }, input_tokens_saved: 300 }),
  record({ run_id: "secret-run-id-ccc", labels: { project: "p2" }, strong_eval_present: false, readiness: "not_evaluated", recoverability: "not_evaluated", commitment_preservation: "not_evaluated", task_check: "not_evaluated", output_tokens_before: "unknown", output_tokens_after: "unknown" })
];

describe("aggregate share bundle - content-free", () => {
  const report = buildAggregateReport(RUNS, {
    generatedAt: "2026-06-16T00:00:00.000Z",
    skippedRunDirectories: [{ run_directory: "/home/alice/secret-project/.compaction/runs/broken", reason: "report.json missing required fields" }]
  });
  const bundle = buildAggregateShareBundle(report, "2026-06-16T00:00:00.000Z");
  const json = JSON.stringify(bundle);
  const md = formatShareBundleMarkdown(bundle);

  it("carries the aggregate numbers, evidence tiers, and verification counts", () => {
    expect(bundle.totals.compactions).toBe(3);
    expect(bundle.totals.total_input_tokens_saved).toBe(1100);
    expect(bundle.totals.runs_provider_reported).toBe(0);
    expect(bundle.totals.runs_local_estimate).toBe(3);
    expect(bundle.verification.ready + bundle.verification.conditional + bundle.verification.not_ready + bundle.verification.not_evaluated).toBe(3);
    // Breakdowns keep their short label keys + numbers.
    expect(bundle.by_project.map((b) => b.key).sort()).toEqual(["p1", "p2"]);
    expect(bundle.by_provider.some((b) => b.key === "openai-agents")).toBe(true);
  });

  it("contains NO actual run ids, report paths, run directories, or filesystem paths", () => {
    // These are the real leak vectors - concrete per-run identifiers and paths from the input
    // records. (The static privacy/limitations PROSE legitimately mentions phrases like "report
    // paths"; that is policy text, not a content leak, so we assert on concrete values only.)
    for (const surface of [json, md]) {
      expect(surface).not.toContain("secret-run-id-aaa");
      expect(surface).not.toContain("secret-run-id-bbb");
      expect(surface).not.toContain("secret-run-id-ccc");
      expect(surface).not.toContain("/home/alice");
      expect(surface).not.toContain("secret-project");
      // The skipped-directory path (and its basename) must not appear.
      expect(surface).not.toContain("broken");
      // No serialized field carrying per-run identifiers/paths.
      expect(surface).not.toContain('"run_id"');
      expect(surface).not.toContain('"report_path"');
      expect(surface).not.toContain('"run_directory"');
      expect(surface).not.toContain('"run_ids"');
    }
  });

  it("exposes ONLY the whitelisted top-level keys (no sessions[].run_ids, no skipped paths)", () => {
    const keys = Object.keys(bundle).sort();
    expect(keys).toEqual(
      [
        "applied_filters",
        "by_project",
        "by_provider",
        "by_workflow",
        "distinctness",
        "evidence_labels",
        "generated_at",
        "limitations",
        "privacy",
        "rollup_labels",
        "session_count",
        "share_bundle_version",
        "totals",
        "verification"
      ].sort()
    );
    // Critically, there is no `sessions` array (which would carry run ids) and no
    // `skipped_run_directories` (which would carry filesystem paths).
    expect(keys).not.toContain("sessions");
    expect(keys).not.toContain("skipped_run_directories");
  });

  it("states it is local-only / no-upload and labels savings as estimated-not-billing-confirmed", () => {
    expect(bundle.privacy.upload.toLowerCase()).toContain("no network");
    expect(bundle.privacy.upload.toLowerCase()).toContain("no upload");
    expect(md.toLowerCase()).toContain("not billing-confirmed");
    expect(md.toLowerCase()).toContain("not extrapolated");
    // Free-form user label is NOT a leak vector - it is an operator-typed short tag, and is
    // deliberately NOT copied into the breakdowns (only project/workflow/provider keys are).
    expect(bundle.by_workflow.map((b) => b.key)).not.toContain("alice-note");
  });
});
