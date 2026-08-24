import { describe, expect, it } from "vitest";
import { formatAnalyzeReport, formatCompactionMarkdownReport, formatCompactionReport, formatPrCommentReport, withSavingsEvidence, withTraceFingerprint } from "../../src/core/report-generator.js";
import { computeTraceFingerprint, TRACE_FINGERPRINT_ALGORITHM } from "../../src/core/trace-fingerprint.js";
import type { AgentTrace, CompactionReport, CostEstimate, TokenEstimate } from "../../src/core/types.js";
import type { UsageMetadata } from "../../src/core/usage-metadata.js";

const trace: AgentTrace = {
  id: "trace_test",
  title: "Report test trace",
  artifactVersion: "agent-trace-v1",
  source: "manual",
  createdAt: "2026-01-01T00:00:00.000Z",
  generatedAt: "2026-01-01T00:00:00.000Z",
  model: "placeholder-agent-model",
  messages: [
    {
      id: "msg_001",
      role: "user",
      timestamp: "2026-01-01T00:00:00.000Z",
      content: "Please inspect this trace."
    }
  ]
};

const tokens: TokenEstimate = {
  inputTokens: 7,
  outputTokens: 3,
  totalTokens: 10
};

const cost: CostEstimate = {
  model: "placeholder-agent-model",
  inputCostUsd: 0.000007,
  outputCostUsd: 0.000009,
  totalCostUsd: 0.000016
};

describe("report-generator", () => {
  it("includes useful analyze details and conservative recommendations", () => {
    const report = formatAnalyzeReport(trace, tokens, cost, [
      {
        category: "repeated_tool_output",
        messageIds: ["msg_001", "msg_002"],
        summary: "Repeated read_file tool output. Keep msg_001 and compact msg_002.",
        estimatedTokens: 7
      }
    ]);

    expect(report).toContain("Source: manual");
    expect(report).toContain("Estimated tokens: 10 total (7 input, 3 output)");
    expect(report).toContain("Waste findings: 1");
    expect(report).toContain("Suggested compaction: remove duplicate tool outputs only");
  });

  function createCompactionReportFixture(): CompactionReport {
    return {
      run_id: "unit-run",
      trace_title: trace.title,
      model: "placeholder-agent-model",
      original_input_tokens: 7,
      compacted_input_tokens: 4,
      tokens_saved: 3,
      percent_reduction: 42.86,
      cost_before_per_run: 0.000016,
      cost_after_per_run: 0.000013,
      saving_per_run: 0.000003,
      policy_name: "stale_tool_output_to_state_capsule",
      waste_pattern: "repeated_tool_output",
      source_message_id: "msg_001",
      repeated_count: 2,
      compacted_message_ids: ["msg_002"],
      artifact_version: "trace-compactor-v0",
      created_at: "2026-01-01T00:00:00.000Z",
      generated_at: "2026-01-01T00:00:00.000Z"
    };
  }


  it("includes CLI wrapper command metadata in analyze output", () => {
    const report = formatAnalyzeReport(
      {
        ...trace,
        source: "cli_wrapper",
        command: { command: "npm", args: ["test"] },
        durationMs: 2000,
        exitCode: 1
      },
      tokens,
      cost
    );

    expect(report).toContain("Source: cli_wrapper");
    expect(report).toContain("Command: npm test");
    expect(report).toContain("Duration: 2000 ms");
    expect(report).toContain("Exit code: 1");
  });

  it("includes compaction savings and compacted message ids", () => {
    const report = createCompactionReportFixture();

    expect(formatCompactionReport(report)).toContain("Compacted input tokens: 4");
    expect(formatCompactionReport(report)).toContain("Compacted messages: msg_002");
    // Per-run estimated saving stays; the general monthly projection is removed
    // from first-value stdout (no general savings claim).
    expect(formatCompactionReport(report)).toContain("Savings per run: $0.000003 (estimated)");
    expect(formatCompactionReport(report)).not.toContain("Projected monthly savings");
    expect(formatCompactionReport(report)).not.toContain("runs/month");
    expect(formatCompactionReport(report)).not.toContain("per month");
  });


  const policyFixture = {
    policy_name: "duplicate-tool-output-v0",
    policy_version: "0.1.0",
    trigger: "Before sending a trace segment to a model, scan local tool outputs for repeats.",
    condition: "A later tool message repeats an earlier retained tool message.",
    action: "Keep the first copy and remove later duplicates.",
    safety_guarantees: ["Only duplicate tool outputs are removed by this v0 policy."],
    expected_savings: "3 input tokens per run.",
    risk_notes: ["Review compacted traces before higher-risk use."]
  };

  it("renders the four-tier value-proof section in markdown when value_proof is present", () => {
    const report: CompactionReport = {
      ...createCompactionReportFixture(),
      value_proof: {
        trace_token_reduction: {
          claim: "trace-token reduction (estimated, local heuristic)",
          tier: 1,
          estimated: true,
          tokens_saved: 3,
          percent_reduction: 42.86
        },
        estimated_provider_cost_reduction: {
          claim: "estimated provider cost reduction (price-table estimate, NOT billing-confirmed)",
          tier: 2,
          estimated: true,
          billing_confirmed: false,
          saving_per_run_usd: 0.000003
        },
        billing_confirmed_savings: {
          claim: "billing-confirmed savings (measured provider usage/billing delta)",
          tier: 3,
          claimed: false,
          billing_confirmed: false,
          note: "NOT claimed: no provider usage/billing delta is measured by this artifact."
        },
        fixed_plan_workflow_extension_value: {
          claim: "fixed-plan workflow-extension value",
          tier: 4,
          quantified: false,
          note: "NOT quantified here: this artifact does not measure additional work completed under a fixed-price cap."
        }
      }
    };

    const markdown = formatCompactionMarkdownReport(report, policyFixture);

    expect(markdown).toContain("## Value Proof (ROADMAP tiers - strongest last, not conflated)");
    // Tier labels + the load-bearing figures and NOT-billing-confirmed boundary.
    expect(markdown).toContain("Tier 1 - trace-token reduction");
    expect(markdown).toContain("3 tokens (42.86% reduction)");
    expect(markdown).toContain("Tier 2 - estimated provider cost reduction");
    expect(markdown).toContain("NOT billing-confirmed");
    expect(markdown).toContain("$0.000003/run (estimated)");
    // No first-value human surface may carry a monthly projection (no-general-savings-claim).
    expect(markdown).not.toContain("per month");
    expect(markdown).not.toContain("runs/month");
    expect(markdown).not.toContain("1,000 runs");
    expect(markdown).not.toContain("monthly savings");
    expect(markdown).not.toContain("Projected monthly");
    // Tier 3/4 carry their honest NOT-claimed / NOT-quantified boundaries, and the renderer no
    // longer double-prepends the disclaimer.
    expect(markdown).toContain("Tier 3 - billing-confirmed savings");
    expect(markdown).toContain("NOT claimed: no provider usage/billing delta is measured");
    expect(markdown).toContain("Tier 4 - fixed-plan workflow-extension value");
    expect(markdown).toContain("NOT quantified here: this artifact does not measure additional work");
    expect(markdown).not.toContain("NOT claimed. NOT claimed");
    expect(markdown).not.toContain("NOT quantified. NOT quantified");
  });

  it("omits the value-proof section in markdown when value_proof is absent (backward-compatible)", () => {
    const markdown = formatCompactionMarkdownReport(createCompactionReportFixture(), policyFixture);
    expect(markdown).not.toContain("## Value Proof");
    // Existing savings fields remain unchanged.
    expect(markdown).toContain("- Tokens saved: 3");
    // Per-run estimated saving stays in the report.md human summary; the general
    // monthly projection is removed (no general savings claim).
    expect(markdown).toContain("- Saving per run: $0.000003 (estimated)");
    expect(markdown).not.toContain("- Projected monthly savings");
    expect(markdown).not.toContain("runs/month");
  });

  it("renders the 'Where Spend Came From (estimated)' section when spend_by_source is present", () => {
    const report: CompactionReport = {
      ...createCompactionReportFixture(),
      spend_by_source: {
        estimated: true,
        billing_confirmed: false,
        estimate_label: "ESTIMATED: chars/4 trace-token heuristic and price-table cost - NOT billing-confirmed, NOT realized savings.",
        top_roles: [
          { name: "tool", estimated_tokens: 120, estimated_cost_usd: 0.00012 },
          { name: "user", estimated_tokens: 40, estimated_cost_usd: 0.00004 }
        ],
        top_tool_outputs: [{ tool_name: "read_file", estimated_tokens: 90, repeated_count: 3, estimated_cost_usd: 0.00009 }],
        top_policy_candidate: {
          policy_name: "stale_tool_output_to_state_capsule",
          estimated_tokens_saved: 3,
          estimated_saving_per_run_usd: 0.000003
        }
      }
    };

    const markdown = formatCompactionMarkdownReport(report, policyFixture);

    expect(markdown).toContain("## Where Spend Came From (estimated)");
    // Honest estimate label + its NOT-billing-confirmed / NOT-realized boundary.
    expect(markdown).toContain("ESTIMATED: chars/4 trace-token heuristic and price-table cost");
    expect(markdown).toContain("NOT billing-confirmed, NOT realized savings");
    expect(markdown).toContain("- tool: 120 est tokens ($0.000120 est)");
    expect(markdown).toContain("- read_file: 90 est tokens across 3 output(s) ($0.000090 est)");
    expect(markdown).toContain("Top policy candidate: stale_tool_output_to_state_capsule");
  });

  it("omits the spend-by-source section in markdown when spend_by_source is absent (backward-compatible)", () => {
    const markdown = formatCompactionMarkdownReport(createCompactionReportFixture(), policyFixture);
    expect(markdown).not.toContain("## Where Spend Came From");
  });

  it("includes consistent artifact timestamps in markdown compaction reports", () => {
    const markdown = formatCompactionMarkdownReport(createCompactionReportFixture(), {
      policy_name: "duplicate-tool-output-v0",
      policy_version: "0.1.0",
      trigger: "Before sending a trace segment to a model, scan local tool outputs for repeats.",
      condition: "A later tool message repeats an earlier retained tool message.",
      action: "Keep the first copy and remove later duplicates.",
      safety_guarantees: ["Only duplicate tool outputs are removed by this v0 policy."],
      expected_savings: "3 input tokens per run.",
      risk_notes: ["Review compacted traces before higher-risk use."]
    });

    expect(markdown).toContain("- Artifact version: trace-compactor-v0");
    expect(markdown).toContain("- Created at: 2026-01-01T00:00:00.000Z");
    expect(markdown).toContain("- Generated at: 2026-01-01T00:00:00.000Z");
    expect(markdown).toContain("- Repeated finding message count: 2");
  });

  it("shows standard cost line when no cache tokens are present in usage", () => {
    const report = formatAnalyzeReport(trace, tokens, cost);
    // Standard format with no cache breakdown
    expect(report).toContain("Estimated cost: $0.000016 ($0.000007 input, $0.000009 output)");
    // No cache-adjusted label
    expect(report).not.toContain("cache-adjusted estimate");
  });

  it("shows cache-adjusted cost breakdown when usage has cache_read_input_tokens", () => {
    const usageWithCache: UsageMetadata = {
      input_tokens: 1000,
      output_tokens: 200,
      cache_read_input_tokens: 100_000,
      provider_reported_tokens: true,
      estimated_tokens: false,
      cost_source: "price_table_estimate",
      cost_confidence: "medium",
      model: "claude-sonnet-4-6",
      limitations: []
    };

    const cacheAwareCost: CostEstimate = {
      model: "claude-sonnet-4-6",
      inputCostUsd: 0.003,     // 1000 tokens at $3/M
      outputCostUsd: 0.003,    // 200 tokens at $15/M
      cacheReadCostUsd: 0.03,  // 100k tokens at $0.30/M
      totalCostUsd: 0.036
    };

    const report = formatAnalyzeReport(
      { ...trace, model: "claude-sonnet-4-6", source: "real_captured" },
      tokens,
      cacheAwareCost,
      [],
      usageWithCache
    );

    // Cache-adjusted label present
    expect(report).toContain("cache-adjusted estimate");
    // Shows cache read line with estimated label
    expect(report).toContain("Cache read:");
    expect(report).toContain("~10% of input rate - estimated");
    // Standard cost line format NOT used
    expect(report).not.toMatch(/^Estimated cost: \$/m);
  });

  it("shows cache creation cost line when usage has cache_creation_input_tokens", () => {
    const usageWithCacheCreation: UsageMetadata = {
      input_tokens: 500,
      output_tokens: 100,
      cache_creation_input_tokens: 10_000,
      provider_reported_tokens: true,
      estimated_tokens: false,
      cost_source: "price_table_estimate",
      cost_confidence: "medium",
      model: "claude-sonnet-4-6",
      limitations: []
    };

    const cacheCreationCost: CostEstimate = {
      model: "claude-sonnet-4-6",
      inputCostUsd: 0.0015,
      outputCostUsd: 0.0015,
      cacheCreationCostUsd: 0.0375,
      totalCostUsd: 0.0405
    };

    const report = formatAnalyzeReport(
      { ...trace, model: "claude-sonnet-4-6" },
      tokens,
      cacheCreationCost,
      [],
      usageWithCacheCreation
    );

    expect(report).toContain("Cache creation:");
    expect(report).toContain("~125% of input rate - estimated");
  });

  it("does not show cache cost lines when usage has no cache tokens", () => {
    const usageNoCacheTokens: UsageMetadata = {
      input_tokens: 1000,
      output_tokens: 200,
      // No cache_read_input_tokens or cache_creation_input_tokens
      provider_reported_tokens: true,
      estimated_tokens: false,
      cost_source: "price_table_estimate",
      cost_confidence: "medium",
      model: "claude-sonnet-4-6",
      limitations: []
    };

    const report = formatAnalyzeReport(trace, tokens, cost, [], usageNoCacheTokens);
    // Standard cost format when no cache data
    expect(report).toContain("Estimated cost: $");
    expect(report).not.toContain("cache-adjusted estimate");
    expect(report).not.toContain("Cache read:");
    expect(report).not.toContain("Cache creation:");
  });

  // Post-compaction cost block tests

  it("shows post-compaction cost block when findings are present (no cache)", () => {
    // tokens: inputTokens=7 at $1/M => $0.000007 input; finding wastes 4 tokens
    // post-compaction input = 7 - 4 = 3 => $0.000003 input + $0.000009 output = $0.000012 total
    // saving = $0.000016 - $0.000012 = $0.000004
    const report = formatAnalyzeReport(
      trace,
      tokens,
      cost,
      [
        {
          category: "repeated_tool_output",
          messageIds: ["msg_001"],
          summary: "Repeated read_file output.",
          estimatedTokens: 4
        }
      ]
    );

    expect(report).toContain("Estimated cost after compaction: $0.000012 (estimated)");
    expect(report).toContain("  Saving per run: $0.000004 (estimated)");
  });

  it("omits post-compaction cost block when no findings are present", () => {
    const report = formatAnalyzeReport(trace, tokens, cost, []);

    expect(report).not.toContain("Estimated cost after compaction:");
    expect(report).not.toContain("Saving per run:");
  });

  it("passes cache token counts through unchanged to post-compaction cost when findings present", () => {
    // Using claude-sonnet-4-6: inputPerMillionUsd=3, cacheReadPerMillionUsd=0.30
    // tokens: inputTokens=1000, outputTokens=200; cache_read=100_000
    // cacheAwareCost.totalCostUsd computed externally (pre-compaction)
    // finding wastes 500 input tokens
    // post-compaction input = 1000 - 500 = 500 => inputCost = 500/1e6 * 3 = $0.0015
    // output = 200/1e6 * 15 = $0.003
    // cache read = 100_000/1e6 * 0.30 = $0.030 (same as before, passed through)
    // post total = 0.0015 + 0.003 + 0.030 = $0.0345
    // saving = $0.036 - $0.0345 = $0.0015
    const usageWithCache: UsageMetadata = {
      input_tokens: 1000,
      output_tokens: 200,
      cache_read_input_tokens: 100_000,
      provider_reported_tokens: true,
      estimated_tokens: false,
      cost_source: "price_table_estimate",
      cost_confidence: "medium",
      model: "claude-sonnet-4-6",
      limitations: []
    };

    const cacheAwareCost: CostEstimate = {
      model: "claude-sonnet-4-6",
      inputCostUsd: 0.003,
      outputCostUsd: 0.003,
      cacheReadCostUsd: 0.03,
      totalCostUsd: 0.036
    };

    const cacheTokens: TokenEstimate = {
      inputTokens: 1000,
      outputTokens: 200,
      totalTokens: 1200
    };

    const report = formatAnalyzeReport(
      { ...trace, model: "claude-sonnet-4-6" },
      cacheTokens,
      cacheAwareCost,
      [
        {
          category: "repeated_tool_output",
          messageIds: ["msg_001"],
          summary: "Repeated output.",
          estimatedTokens: 500
        }
      ],
      usageWithCache
    );

    expect(report).toContain("Estimated cost after compaction: $0.034500 (estimated)");
    expect(report).toContain("  Saving per run: $0.001500 (estimated)");
  });

  it("guards against negative token counts when all tokens are wasted (edge case)", () => {
    // tokens: inputTokens=7, finding wastes 100 (more than available)
    // post-compaction input = Math.max(0, 7 - 100) = 0 => inputCost = $0
    // post-compaction total = 0 + outputCost ($0.000009) = $0.000009
    // saving = $0.000016 - $0.000009 = $0.000007
    const report = formatAnalyzeReport(
      trace,
      tokens,
      cost,
      [
        {
          category: "repeated_tool_output",
          messageIds: ["msg_001"],
          summary: "Massive repeated output.",
          estimatedTokens: 100
        }
      ]
    );

    expect(report).toContain("Estimated cost after compaction: $0.000009 (estimated)");
    expect(report).toContain("  Saving per run: $0.000007 (estimated)");
    // Confirm no negative token counts in the cost lines
    expect(report).not.toMatch(/Estimated cost after compaction: \$-/);
  });

  it("formats a concise PR comment artifact with savings, policy, safety, and artifact names", () => {
    const comment = formatPrCommentReport(
      createCompactionReportFixture(),
      {
        policy_name: "duplicate-tool-output-v0",
        policy_version: "0.1.0",
        trigger: "Before sending a trace segment to a model, scan local tool outputs for repeats.",
        condition: "A later tool message repeats an earlier retained tool message.",
        action: "Keep the first copy and remove later duplicates.",
        safety_guarantees: ["Only duplicate tool outputs are removed by this v0 policy."],
        expected_savings: "3 input tokens per run.",
        risk_notes: ["Review the compacted trace before applying the policy to higher-risk workflows."]
      },
      ["report.json", "report.md", "policy.json", "state-capsule.json", "compacted-trace.json", "pr-comment.md"]
    );

    expect(comment).toContain("## compaction.dev summary");
    expect(comment).toContain("Trace title: Report test trace");
    expect(comment).toContain("Model: placeholder-agent-model");
    expect(comment).toContain("- Before input tokens: 7");
    expect(comment).toContain("- After input tokens: 4");
    expect(comment).toContain("- Tokens saved: 3");
    expect(comment).toContain("- Percent reduction: 42.86%");
    expect(comment).toContain("- Cost before per run: $0.000016");
    expect(comment).toContain("- Cost after per run: $0.000013");
    expect(comment).toContain("- Saving per run: $0.000003");
    // Per-run estimated cost stays; the general 1,000-runs/month projection is
    // removed from the PR-comment report (no general savings claim).
    expect(comment).not.toContain("Projected monthly savings");
    expect(comment).not.toContain("per month");
    expect(comment).not.toContain("runs/month");
    expect(comment).not.toContain("1,000 runs");
    expect(comment).not.toContain("monthly savings");
    expect(comment).toContain("- Policy applied: duplicate-tool-output-v0");
    expect(comment).toContain("- Waste pattern: repeated_tool_output");
    expect(comment).toContain("- Risk level or safety note: Review the compacted trace");
    expect(comment).toContain("- pr-comment.md");
  });

  describe("withTraceFingerprint (per-run trace identity persistence)", () => {
    function baseReport(): CompactionReport {
      return {
        run_id: "run-fp",
        trace_title: trace.title,
        model: trace.model,
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
        repeated_count: 1,
        compacted_message_ids: [],
        artifact_version: "trace-compactor-v0",
        created_at: trace.createdAt,
        generated_at: trace.generatedAt,
        approval_readiness_status: "conditional",
        approval_readiness_reason: "fixture"
      };
    }

    it("(a) persists the content-addressed fingerprint on the per-run report when a trace is available", () => {
      const report = baseReport();
      const withFp = withTraceFingerprint(report, trace);
      // The OPTIONAL field is now present and matches computeTraceFingerprint(trace) exactly.
      expect(withFp.trace_fingerprint).toEqual(computeTraceFingerprint(trace));
      expect(withFp.trace_fingerprint?.algorithm).toBe(TRACE_FINGERPRINT_ALGORITHM);
      expect(withFp.trace_fingerprint?.content_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(withFp.trace_fingerprint?.message_count).toBe(trace.messages.length);
    });

    it("does not mutate the input report and changes no existing field/label", () => {
      const report = baseReport();
      const snapshot = JSON.stringify(report);
      const withFp = withTraceFingerprint(report, trace);
      // Input untouched (no trace_fingerprint leaked onto it); the field is additive only.
      expect(JSON.stringify(report)).toBe(snapshot);
      expect(report.trace_fingerprint).toBeUndefined();
      // Every pre-existing field is identical; only trace_fingerprint was added.
      const { trace_fingerprint, ...rest } = withFp;
      expect(trace_fingerprint).toBeDefined();
      expect(rest).toEqual(report);
    });

    it("carries NO raw message content in the persisted fingerprint (digest-only)", () => {
      const withFp = withTraceFingerprint(baseReport(), trace);
      const serialized = JSON.stringify(withFp.trace_fingerprint);
      expect(serialized).not.toContain("Please inspect this trace.");
    });
  });

});

describe("withSavingsEvidence (V0.2 per-run evidence label)", () => {
  const baseReport: CompactionReport = {
    run_id: "se-run",
    trace_title: "se trace",
    model: "placeholder-agent-model",
    original_input_tokens: 7,
    compacted_input_tokens: 4,
    tokens_saved: 3,
    percent_reduction: 42.86,
    cost_before_per_run: 0.000016,
    cost_after_per_run: 0.000013,
    saving_per_run: 0.000003,
    policy_name: "stale_tool_output_to_state_capsule",
    waste_pattern: "repeated_tool_output",
    source_message_id: "msg_001",
    repeated_count: 2,
    compacted_message_ids: ["msg_002"],
    artifact_version: "trace-compactor-v0",
    created_at: "2026-01-01T00:00:00.000Z",
    generated_at: "2026-01-01T00:00:00.000Z"
  };

  it("composes the weakest honest rung by default and never overclaims", () => {
    const se = withSavingsEvidence(baseReport).savings_evidence;
    expect(se).toBeDefined();
    if (!se) throw new Error("expected savings_evidence");
    // Defaults are the weakest honest labels.
    expect(se.cost_source).toBe("local_estimate");
    expect(se.recoverability).toBe("not_evaluated");
    expect(se.evidence_rung).toBe("local_estimate_single_run");
    // Honesty invariants that can NEVER flip on a single run.
    expect(se.semantic_preservation).toBe("not_evaluated");
    expect(se.billing_confirmed).toBe(false);
    // No run is identifiable without a fingerprint.
    expect(se.trace_identity).toBe("unidentified");
    // The label asserts no stronger claim than the rung.
    const label = se.label.toLowerCase();
    expect(label).toContain("not billing-confirmed");
    expect(label).not.toContain("provider-reported");
    expect(label).not.toContain("per month");
    expect(label).not.toContain("measured_caveated"); // the measured rung is aggregate-only, never here
  });

  it("marks trace_identity fingerprinted once a fingerprint is present, and reflects a passed eval", () => {
    const withFp = withTraceFingerprint(baseReport, trace);
    const se = withSavingsEvidence(withFp, { recoverability: "passed" }).savings_evidence!;
    expect(se.trace_identity).toBe("fingerprinted");
    expect(se.recoverability).toBe("passed");
    // Even with a passed eval, semantic preservation stays not_evaluated and billing false.
    expect(se.semantic_preservation).toBe("not_evaluated");
    expect(se.billing_confirmed).toBe(false);
  });

  it("is additive: it never mutates the input report or its existing fields", () => {
    const before = JSON.stringify(baseReport);
    const out = withSavingsEvidence(baseReport);
    expect(JSON.stringify(baseReport)).toBe(before); // input untouched
    expect(out.tokens_saved).toBe(baseReport.tokens_saved); // existing fields unchanged
    expect(out.saving_per_run).toBe(baseReport.saving_per_run);
  });

  it("renders a labeled markdown section that carries no overclaim", () => {
    const md = formatCompactionMarkdownReport(
      withSavingsEvidence(baseReport),
      {
        policy_name: "p",
        policy_version: "v0",
        trigger: "t",
        condition: "c",
        action: "a",
        safety_guarantees: ["g"],
        expected_savings: "e",
        risk_notes: ["r"]
      }
    );
    expect(md).toContain("## Savings Evidence (per-run, labeled)");
    expect(md).toContain("Cost source: local_estimate");
    expect(md).toContain("Billing-confirmed: false");
    expect(md).not.toContain("per month");
    expect(md).not.toContain("provider-reported");
  });
});
