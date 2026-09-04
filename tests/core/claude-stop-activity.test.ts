import { describe, expect, it } from "vitest";
import {
  buildClaudeStopActivityEvent,
  buildClaudeTranscriptStopActivityEvent
} from "../../src/core/claude-stop-activity.js";
import { claudeLogicalRunIdentity } from "../../src/core/claude-logical-run-id.js";
import { validateActivityEventForStore } from "../../src/core/activity-store.js";
import { settledStopLineFromActivityEvent } from "../../src/core/settled-stop-activity.js";
import { outputCalibrationResolver } from "../../src/core/output-shaping-savings.js";
import { emptyCalibration } from "../../src/core/output-shaping-calibration-store.js";
import type { GatewayReceipt } from "../../src/core/gateway/receipt.js";
import type { UserRun } from "../../src/core/gateway/run-boundary.js";
import { createUsageMetadata, missingUsageMetadata } from "../../src/core/usage-metadata.js";

const CORRELATION = "1".repeat(32);
const RUN: UserRun = {
  session_correlation_id: CORRELATION,
  run_seq: 4,
  started_at: "2026-09-04T10:00:00.000Z",
  ended_at: "2026-09-04T10:10:00.000Z"
};

function receipt(overrides: Partial<GatewayReceipt> = {}): GatewayReceipt {
  return {
    receipt_id: "receipt-default",
    captured_at: "2026-09-04T10:02:01.000Z",
    request_started_at: "2026-09-04T10:02:00.000Z",
    provider: "anthropic",
    model: "claude-opus-5",
    endpoint: "/v1/messages",
    mode: "record",
    upstream_status: 200,
    model_visible_bytes_changed: false,
    tokens: { prompt_input: 100, output: 20 },
    fresh_billed_input_reduction: { available: false, note: "none" },
    token_source: "provider-reported",
    cache_source: "unavailable",
    cost_source: "unavailable",
    reasons: { cost: "unavailable" },
    claim_scope: "run-scoped",
    approval_status: "not-required",
    sync_status: "local-only",
    content_uploaded: false,
    label: "test",
    session_correlation_id: CORRELATION,
    ...overrides
  };
}

const resolver = outputCalibrationResolver(emptyCalibration());

describe("Claude logical run identity", () => {
  it("is stable across an extended end, but differs by session, sequence, or start", () => {
    const first = claudeLogicalRunIdentity(RUN)!;
    expect(first).toEqual(claudeLogicalRunIdentity({ ...RUN, ended_at: "2026-09-04T10:20:00.000Z" }));
    expect(first.runId).toMatch(/^claude-stop-[0-9a-f]{32}$/);
    expect(first.sessionId).toBe(`claude-session-${CORRELATION}`);
    expect(claudeLogicalRunIdentity({ ...RUN, run_seq: 5 })?.runId).not.toBe(first.runId);
    expect(claudeLogicalRunIdentity({ ...RUN, session_correlation_id: "2".repeat(32) })?.runId).not.toBe(first.runId);
    expect(claudeLogicalRunIdentity({ ...RUN, started_at: "2026-09-04T10:00:01.000Z" })?.runId).not.toBe(first.runId);
    expect(claudeLogicalRunIdentity({ ...RUN, session_correlation_id: "raw-session" })).toBeUndefined();
  });
});

describe("Claude whole-run Stop event", () => {
  it("freezes exact shaped receipts as one valid basic/N-A event with no generic prior", () => {
    const event = buildClaudeStopActivityEvent({
      run: RUN,
      window: {
        receipts: [
          receipt({
            receipt_id: "a",
            output_shaping_state: "already-active",
            output_shaping_policy_version: "output-shaping-v1"
          }),
          receipt({
            receipt_id: "b",
            request_started_at: "2026-09-04T10:03:00.000Z",
            captured_at: "2026-09-04T10:03:01.000Z",
            tokens: { prompt_input: 200, output: 30 },
            output_shaping_state: "already-active",
            output_shaping_policy_version: "output-shaping-v1"
          })
        ],
        truncated: false
      },
      calibrationResolver: resolver
    })!;
    expect(validateActivityEventForStore(event).problems).toEqual([]);
    expect(event.activity_kind).toBe("claude-stop");
    expect(event.apply_posture).toBe("basic");
    expect(event.output_after).toBe(50);
    const line = settledStopLineFromActivityEvent(event)!;
    expect(line).toContain("observed input 300");
    expect(line).toContain("output N/A→50 (N/A%, est.)");
    expect(line).toContain("basic shaping");
    expect(line).not.toContain("47%");
  });

  it("labels only stored-authorized input reduction full", () => {
    const event = buildClaudeStopActivityEvent({
      run: RUN,
      window: {
        receipts: [receipt({
          mode: "apply",
          request_mutated: true,
          model_visible_bytes_changed: true,
          estimated_input_tokens_before: 100,
          estimated_input_tokens_after: 60,
          applied_components: ["lcm-compaction"],
          approval_status: "auto-applied-by-policy"
        })],
        truncated: false
      },
      calibrationResolver: resolver
    })!;
    expect(event.apply_posture).toBe("full");
    expect(settledStopLineFromActivityEvent(event)).toContain("input 100→60 (−40%)");
    expect(settledStopLineFromActivityEvent(event)).toContain("full apply");
  });

  it("keeps public explicit deterministic input apply exact and unlabelled", () => {
    const event = buildClaudeStopActivityEvent({
      run: RUN,
      window: {
        receipts: [receipt({
          mode: "apply",
          request_mutated: true,
          model_visible_bytes_changed: true,
          estimated_input_tokens_before: 100,
          estimated_input_tokens_after: 60,
          applied_components: ["deterministic-compaction"]
        })],
        truncated: false
      },
      calibrationResolver: resolver
    })!;
    expect(event.apply_posture).toBeUndefined();
    const line = settledStopLineFromActivityEvent(event)!;
    expect(line).toContain("input 100→60 (−40%)");
    expect(line).not.toMatch(/apply off|basic shaping|full apply/);
  });

  it("keeps an input reduction with ambiguous provenance exact but unlabelled", () => {
    const event = buildClaudeStopActivityEvent({
      run: RUN,
      window: {
        receipts: [receipt({
          mode: "apply",
          request_mutated: true,
          model_visible_bytes_changed: true,
          estimated_input_tokens_before: 100,
          estimated_input_tokens_after: 60,
          output_shaping_state: "already-active",
          output_shaping_policy_version: "output-shaping-v1"
        })],
        truncated: false
      },
      calibrationResolver: resolver
    })!;
    expect(event.apply_posture).toBeUndefined();
    const line = settledStopLineFromActivityEvent(event)!;
    expect(line).toContain("input 100→60 (−40%)");
    expect(line).toContain("output N/A→20 (N/A%, est.)");
    expect(line).not.toMatch(/apply off|basic shaping|full apply/);
  });

  it("fails closed without an exact complete gateway run", () => {
    expect(buildClaudeStopActivityEvent({
      run: RUN,
      window: { receipts: [], truncated: false },
      calibrationResolver: resolver
    })).toBeUndefined();
    expect(buildClaudeStopActivityEvent({
      run: RUN,
      window: {
        receipts: [receipt({ request_started_at: "2026-09-04T10:05:00.000Z" })],
        truncated: true
      },
      calibrationResolver: resolver
    })).toBeUndefined();
  });
});

describe("Claude transcript Stop fallback", () => {
  it("records cumulative observed axes and only a positively proven basic shaping state", () => {
    const event = buildClaudeTranscriptStopActivityEvent({
      run: RUN,
      usage: createUsageMetadata({
        inputTokens: 1_900,
        outputTokens: 180,
        cacheReadInputTokens: 100,
        providerReportedTokens: true,
        estimatedTokens: false,
        provider: "anthropic",
        model: "claude-opus-5"
      }),
      shaped: true
    })!;
    expect(validateActivityEventForStore(event).problems).toEqual([]);
    expect(event).toMatchObject({
      input_before: 2_000,
      output_after: 180,
      measurement_source: "claude-transcript",
      claim_scope: "workflow-scoped",
      output_shaping_state: "active",
      output_estimate_state: "unseeded",
      apply_posture: "basic",
      token_source: {
        input: { source: "provider-reported" },
        output: { source: "provider-reported" }
      }
    });
    expect(event.input_after).toBeUndefined();
    expect(event.output_before).toBeUndefined();
    expect(event.estimated_output_tokens_saved).toBeUndefined();
    const line = settledStopLineFromActivityEvent(event)!;
    expect(line).toContain("compaction · session cumulative ·");
    expect(line).toContain("observed input 2,000");
    expect(line).toContain("output N/A→180 (N/A%, est.)");
    expect(line).toContain("basic shaping");
    expect(line).not.toContain("47%");
  });

  it("keeps held/local-estimate usage observed and unlabelled", () => {
    const event = buildClaudeTranscriptStopActivityEvent({
      run: RUN,
      usage: createUsageMetadata({
        inputTokens: 900,
        outputTokens: 80,
        providerReportedTokens: false,
        estimatedTokens: true,
        provider: "anthropic"
      }),
      shaped: false
    })!;
    expect(validateActivityEventForStore(event).problems).toEqual([]);
    expect(event.token_source).toEqual({
      input: { source: "local-estimate" },
      output: { source: "local-estimate" }
    });
    expect(event.output_shaping_state).toBeUndefined();
    expect(event.apply_posture).toBeUndefined();
    const line = settledStopLineFromActivityEvent(event)!;
    expect(line).toContain("compaction · session cumulative ·");
    expect(line).toContain("input 900");
    expect(line).toContain("output 80");
    expect(line).not.toMatch(/apply off|basic shaping|full apply|N\/A|47%/);
  });

  it("derives task-scoped axes only from a compatible monotonic exact-session baseline", () => {
    const event = buildClaudeTranscriptStopActivityEvent({
      run: RUN,
      usage: createUsageMetadata({
        inputTokens: 1_900,
        outputTokens: 180,
        cacheReadInputTokens: 100,
        providerReportedTokens: true,
        estimatedTokens: false,
        provider: "anthropic"
      }),
      baseline: {
        inputTokens: 1_000,
        outputTokens: 100,
        cacheReadInputTokens: 50,
        cacheCreationInputTokens: null,
        tokenSource: "provider-reported"
      },
      shaped: true
    })!;
    expect(event).toMatchObject({
      input_before: 950,
      output_after: 80,
      measurement_source: "claude-transcript",
      claim_scope: "run-scoped",
      evidence_level: "monotonic delta from exact prior Claude session transcript usage",
      apply_posture: "basic"
    });
    const line = settledStopLineFromActivityEvent(event)!;
    expect(line).not.toContain("session cumulative");
    expect(line).toContain("observed input 950");
    expect(line).toContain("output N/A→80 (N/A%, est.)");
  });

  it("omits a regressing or source-conflicting baseline axis instead of relabelling cumulative usage", () => {
    expect(buildClaudeTranscriptStopActivityEvent({
      run: RUN,
      usage: createUsageMetadata({
        inputTokens: 100,
        outputTokens: 20,
        providerReportedTokens: true,
        estimatedTokens: false,
        provider: "anthropic"
      }),
      baseline: {
        inputTokens: 200,
        outputTokens: 30,
        cacheReadInputTokens: null,
        cacheCreationInputTokens: null,
        tokenSource: "provider-reported"
      },
      shaped: false
    })).toBeUndefined();
    expect(buildClaudeTranscriptStopActivityEvent({
      run: RUN,
      usage: createUsageMetadata({
        inputTokens: 100,
        outputTokens: 20,
        providerReportedTokens: true,
        estimatedTokens: false,
        provider: "anthropic"
      }),
      baseline: {
        inputTokens: 50,
        outputTokens: 10,
        cacheReadInputTokens: null,
        cacheCreationInputTokens: null,
        tokenSource: "local-estimate"
      },
      shaped: false
    })).toBeUndefined();
  });

  it("fails closed without a usable observed axis or shaped output", () => {
    expect(buildClaudeTranscriptStopActivityEvent({
      run: RUN,
      usage: missingUsageMetadata({ provider: "anthropic" }),
      shaped: false
    })).toBeUndefined();
    expect(buildClaudeTranscriptStopActivityEvent({
      run: RUN,
      usage: createUsageMetadata({
        inputTokens: 50,
        providerReportedTokens: true,
        estimatedTokens: false,
        provider: "anthropic"
      }),
      shaped: true
    })).toBeUndefined();
  });

  it("rejects reduction, counterfactual, and full-posture claims on transcript evidence", () => {
    const event = buildClaudeTranscriptStopActivityEvent({
      run: RUN,
      usage: createUsageMetadata({
        inputTokens: 100,
        outputTokens: 20,
        providerReportedTokens: true,
        estimatedTokens: false,
        provider: "anthropic"
      }),
      shaped: true
    })!;
    expect(validateActivityEventForStore({ ...event, input_after: 80 }).problems)
      .toContain("activity_kind claude-stop: transcript usage cannot claim post-compaction input");
    expect(validateActivityEventForStore({ ...event, output_before: 40 }).problems)
      .toContain("activity_kind claude-stop: transcript usage cannot claim a numerical output counterfactual");
    expect(validateActivityEventForStore({ ...event, apply_posture: "full" }).problems)
      .toContain("activity_kind claude-stop: full posture requires exact gateway-run evidence");
  });
});
