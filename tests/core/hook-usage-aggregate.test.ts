import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  aggregateHookUsageRecords,
  exactPriorClaudeHookRecord,
  loadHookUsageRecords,
  HOOK_USAGE_AGGREGATE_SCHEMA
} from "../../src/core/hook-usage-aggregate.js";
import { CLAUDE_CODE_HOOK_RECORD_SCHEMA, type ClaudeCodeHookRecord } from "../../src/core/claude-code-hook-record.js";
import { computeActivityEventId, type ActivityEvent } from "../../src/core/activity-event.js";
import { TEST_OUTPUT_POLICY_VERSION } from "../helpers/output-calibration-fixture.js";

/**
 * Hook usage aggregate (public). Invariants: aggregation by tool from records; missing usage stays
 * null (never 0); dedup by dedupKey; provider-reported vs unavailable distinguished; content-free output.
 */
function rec(over: Partial<ClaudeCodeHookRecord> = {}): ClaudeCodeHookRecord {
  return {
    schema: CLAUDE_CODE_HOOK_RECORD_SCHEMA,
    tool: "claude-code",
    sessionId: "s1",
    dedupKey: "k1",
    inputTokens: 1000,
    outputTokens: 200,
    cacheReadInputTokens: null,
    cacheCreationInputTokens: null,
    totalTokens: 1200,
    providerReported: true,
    tokenSource: "provider-reported",
    provider: "anthropic",
    model: "claude-x",
    messageCount: 8,
    recordedAt: "2026-06-29T10:00:00.000Z",
    ...over
  };
}

function settledSnapshot(input: {
  runId: string;
  session?: string;
  startedAt?: string;
  recordedAt: string;
  input: number;
  output: number;
  model?: string;
  tokenSource?: "provider-reported" | "local-estimate";
  policy?: string;
  posture?: "basic" | "full";
}): ActivityEvent {
  const base: ActivityEvent = {
    surface: "claude_code",
    provider: "anthropic",
    ...(input.model ? { model_label: input.model } : {}),
    workflow_id: "claude-stop",
    session_id: input.session ?? `claude-session-${"1".repeat(32)}`,
    run_id: input.runId,
    input_before: input.input,
    output_after: input.output,
    token_source: {
      input: { source: input.tokenSource ?? "provider-reported" },
      output: { source: "provider-reported" }
    },
    ...(input.policy ? { policy_used: input.policy } : {}),
    claim_scope: "run-scoped",
    evidence_level: "exact correlated gateway run",
    approval_status: "not-required",
    recovery: { original_retained: false },
    sync_status: "local-only",
    activity_kind: "claude-stop",
    recorded_at: input.recordedAt,
    run_started_at: input.startedAt ?? "2026-06-29T09:59:00.000Z",
    measurement_source: "gateway-run",
    output_shaping_state: "active",
    output_estimate_state: "unseeded",
    ...(input.posture ? { apply_posture: input.posture } : {})
  };
  return { ...base, activity_event_id: computeActivityEventId(base) };
}

function transcriptDeltaSnapshot(input: {
  runId: string;
  input: number;
  output: number;
  startedAt: string;
  recordedAt: string;
}): ActivityEvent {
  const event: ActivityEvent = {
    ...settledSnapshot(input),
    claim_scope: "run-scoped",
    evidence_level: "monotonic delta from exact prior Claude session transcript usage",
    measurement_source: "claude-transcript"
  };
  return { ...event, activity_event_id: computeActivityEventId(event) };
}

describe("aggregateHookUsageRecords", () => {
  it("aggregates by tool: sums tokens, counts events, distinct sessions/sources/providers/models, time window", () => {
    const agg = aggregateHookUsageRecords([
      rec({ dedupKey: "a", sessionId: "s1", inputTokens: 1000, outputTokens: 200, recordedAt: "2026-06-29T10:00:00.000Z" }),
      rec({ dedupKey: "b", sessionId: "s2", inputTokens: 500, outputTokens: 100, recordedAt: "2026-06-29T12:00:00.000Z" })
    ]);
    expect(agg.schema).toBe(HOOK_USAGE_AGGREGATE_SCHEMA);
    expect(agg.tools).toHaveLength(1);
    const t = agg.tools[0];
    expect(t.tool).toBe("claude-code");
    expect(t.events).toBe(2);
    expect(t.sessions).toBe(2);
    expect(t.inputTokens).toBe(1500);
    expect(t.outputTokens).toBe(300);
    expect(t.tokenSources).toEqual(["provider-reported"]);
    expect(t.providers).toEqual(["anthropic"]);
    expect(t.providerReportedEvents).toBe(2);
    expect(t.firstRecordedAt).toBe("2026-06-29T10:00:00.000Z");
    expect(t.lastRecordedAt).toBe("2026-06-29T12:00:00.000Z");
  });

  it("dedups by dedupKey - the same Stop/session state is counted once", () => {
    const agg = aggregateHookUsageRecords([rec({ dedupKey: "same" }), rec({ dedupKey: "same" }), rec({ dedupKey: "other", sessionId: "s2" })]);
    expect(agg.totalRecords).toBe(3);
    expect(agg.dedupedRecords).toBe(2);
    expect(agg.tools[0].events).toBe(2);
  });

  it("coalesces valid cumulative logical-run records to the latest canonical snapshot", () => {
    const logicalRunId = `claude-stop-${"a".repeat(32)}`;
    const agg = aggregateHookUsageRecords([
      rec({
        dedupKey: "parent", logicalRunId, inputTokens: 100, outputTokens: 20, totalTokens: 120,
        messageCount: 4, recordedAt: "2026-06-29T10:00:00.000Z",
        settledActivityEvent: settledSnapshot({
          runId: logicalRunId, input: 100, output: 20, recordedAt: "2026-06-29T10:00:00.000Z"
        })
      }),
      rec({
        dedupKey: "final", logicalRunId, inputTokens: 180, outputTokens: 35, totalTokens: 215,
        messageCount: 7, recordedAt: "2026-06-29T10:01:00.000Z",
        settledActivityEvent: settledSnapshot({
          runId: logicalRunId, input: 180, output: 35, recordedAt: "2026-06-29T10:01:00.000Z"
        })
      })
    ]);
    expect(agg.totalRecords).toBe(2);
    expect(agg.dedupedRecords).toBe(1);
    expect(agg.tools[0]).toMatchObject({ events: 1, inputTokens: 180, outputTokens: 35 });
  });

  it("coalesces an exact hook-only parent record into its validated final transcript settlement", () => {
    const logicalRunId = `claude-stop-${"f".repeat(32)}`;
    const transcript = settledSnapshot({
      runId: logicalRunId,
      input: 180,
      output: 35,
      recordedAt: "2026-06-29T10:01:00.000Z"
    });
    const settledActivityEvent: ActivityEvent = {
      ...transcript,
      claim_scope: "workflow-scoped",
      evidence_level: "final normalized Claude transcript cumulative session usage",
      measurement_source: "claude-transcript"
    };
    settledActivityEvent.activity_event_id = computeActivityEventId(settledActivityEvent);
    const agg = aggregateHookUsageRecords([
      rec({
        dedupKey: "hook-parent",
        logicalRunId,
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        messageCount: 4,
        recordedAt: "2026-06-29T10:00:00.000Z"
      }),
      rec({
        dedupKey: "hook-final",
        logicalRunId,
        inputTokens: 180,
        outputTokens: 35,
        totalTokens: 215,
        messageCount: 7,
        recordedAt: "2026-06-29T10:01:00.000Z",
        settledActivityEvent
      })
    ]);
    expect(agg.totalRecords).toBe(2);
    expect(agg.dedupedRecords).toBe(1);
    expect(agg.tools[0]).toMatchObject({ events: 1, inputTokens: 180, outputTokens: 35 });
  });

  it("coalesces exact cumulative records when derived model, source, policy, and posture evolve", () => {
    const logicalRunId = `claude-stop-${"e".repeat(32)}`;
    const agg = aggregateHookUsageRecords([
      rec({
        dedupKey: "parent", logicalRunId, inputTokens: 100, outputTokens: 20, totalTokens: 120,
        messageCount: 4, model: "claude-opus-5", tokenSource: "provider-reported",
        recordedAt: "2026-06-29T10:00:00.000Z",
        settledActivityEvent: settledSnapshot({
          runId: logicalRunId, input: 100, output: 20, model: "claude-opus-5",
          tokenSource: "provider-reported", policy: TEST_OUTPUT_POLICY_VERSION, posture: "basic",
          recordedAt: "2026-06-29T10:00:00.000Z"
        })
      }),
      rec({
        dedupKey: "final", logicalRunId, inputTokens: 180, outputTokens: 35, totalTokens: 215,
        messageCount: 7, model: "claude-sonnet-5", tokenSource: "local-estimate", providerReported: false,
        recordedAt: "2026-06-29T10:01:00.000Z",
        settledActivityEvent: settledSnapshot({
          runId: logicalRunId, input: 180, output: 35, model: "claude-sonnet-5",
          tokenSource: "local-estimate", posture: "full",
          recordedAt: "2026-06-29T10:01:00.000Z"
        })
      })
    ]);
    expect(agg.dedupedRecords).toBe(1);
    expect(agg.tools[0]).toMatchObject({
      events: 1,
      inputTokens: 180,
      outputTokens: 35,
      tokenSources: ["local-estimate"],
      models: ["claude-sonnet-5"]
    });
  });

  it("subtracts a proven task-scoped transcript snapshot from its exact prior cumulative record", () => {
    const firstRun = `claude-stop-${"6".repeat(32)}`;
    const secondRun = `claude-stop-${"7".repeat(32)}`;
    const deltaBase = settledSnapshot({
      runId: secondRun,
      input: 900,
      output: 80,
      startedAt: "2026-06-29T10:05:00.000Z",
      recordedAt: "2026-06-29T10:10:00.000Z"
    });
    const delta: ActivityEvent = {
      ...deltaBase,
      claim_scope: "run-scoped",
      evidence_level: "monotonic delta from exact prior Claude session transcript usage",
      measurement_source: "claude-transcript"
    };
    delta.activity_event_id = computeActivityEventId(delta);
    const agg = aggregateHookUsageRecords([
      rec({
        dedupKey: "task-1",
        logicalRunId: firstRun,
        inputTokens: 1_000,
        outputTokens: 100,
        totalTokens: 1_100,
        recordedAt: "2026-06-29T10:00:00.000Z"
      }),
      rec({
        dedupKey: "task-2",
        logicalRunId: secondRun,
        inputTokens: 1_900,
        outputTokens: 180,
        totalTokens: 2_080,
        recordedAt: "2026-06-29T10:10:00.000Z",
        settledActivityEvent: delta
      })
    ]);
    expect(agg.dedupedRecords).toBe(2);
    expect(agg.tools[0]).toMatchObject({ events: 2, inputTokens: 1_900, outputTokens: 180 });
  });

  it("fails closed on regressing, source-conflicting, or timestamp-ambiguous cumulative snapshots", () => {
    const firstRun = `claude-stop-${"8".repeat(32)}`;
    const secondRun = `claude-stop-${"9".repeat(32)}`;
    const regressing = aggregateHookUsageRecords([
      rec({ dedupKey: "r1", logicalRunId: firstRun, inputTokens: 1_000, outputTokens: 100 }),
      rec({
        dedupKey: "r2",
        logicalRunId: secondRun,
        inputTokens: 900,
        outputTokens: 90,
        recordedAt: "2026-06-29T10:01:00.000Z"
      })
    ]);
    expect(regressing.tools[0]).toMatchObject({ inputTokens: 1_000, outputTokens: 100 });

    const conflicting = aggregateHookUsageRecords([
      rec({ dedupKey: "s1", logicalRunId: firstRun, inputTokens: 1_000, outputTokens: 100 }),
      rec({
        dedupKey: "s2",
        logicalRunId: secondRun,
        inputTokens: 1_900,
        outputTokens: 180,
        tokenSource: "local-estimate",
        providerReported: false,
        recordedAt: "2026-06-29T10:01:00.000Z"
      })
    ]);
    expect(conflicting.tools[0]).toMatchObject({ inputTokens: 1_000, outputTokens: 100 });

    const ambiguous = aggregateHookUsageRecords([
      rec({ dedupKey: "a1", logicalRunId: firstRun }),
      rec({ dedupKey: "a2", logicalRunId: secondRun, inputTokens: 1_900, outputTokens: 180 })
    ]);
    expect(ambiguous.tools[0]).toMatchObject({ inputTokens: null, outputTokens: null });
  });

  it("keeps a regressed session chain tainted instead of recovering a later task delta", () => {
    const firstRun = `claude-stop-${"1".repeat(32)}`;
    const regressedRun = `claude-stop-${"2".repeat(32)}`;
    const attemptedRecovery = `claude-stop-${"3".repeat(32)}`;
    const records = [
      rec({ dedupKey: "t1", logicalRunId: firstRun, inputTokens: 1_000, outputTokens: 100 }),
      rec({
        dedupKey: "t2",
        logicalRunId: regressedRun,
        inputTokens: 900,
        outputTokens: 90,
        recordedAt: "2026-06-29T10:01:00.000Z"
      }),
      rec({
        dedupKey: "t3",
        logicalRunId: attemptedRecovery,
        inputTokens: 1_100,
        outputTokens: 110,
        recordedAt: "2026-06-29T10:02:00.000Z",
        settledActivityEvent: transcriptDeltaSnapshot({
          runId: attemptedRecovery,
          input: 200,
          output: 20,
          startedAt: "2026-06-29T10:01:30.000Z",
          recordedAt: "2026-06-29T10:02:00.000Z"
        })
      })
    ];
    expect(aggregateHookUsageRecords(records).tools[0]).toMatchObject({
      events: 3,
      inputTokens: 1_000,
      outputTokens: 100
    });
    expect(aggregateHookUsageRecords(records, {
      since: "2026-06-29T10:01:30.000Z"
    }).tools[0]).toMatchObject({ inputTokens: null, outputTokens: null });
    expect(exactPriorClaudeHookRecord(records.slice(0, 2), {
      sessionId: "s1",
      logicalRunId: regressedRun,
      before: "2026-06-29T10:01:30.000Z"
    })).toBeUndefined();
  });

  it("keeps a source-switched session chain tainted across a later apparent recovery", () => {
    const firstRun = `claude-stop-${"a".repeat(32)}`;
    const switchedRun = `claude-stop-${"b".repeat(32)}`;
    const attemptedRecovery = `claude-stop-${"c".repeat(32)}`;
    const records = [
      rec({ dedupKey: "p1", logicalRunId: firstRun, inputTokens: 1_000, outputTokens: 100 }),
      rec({
        dedupKey: "p2",
        logicalRunId: switchedRun,
        inputTokens: 1_050,
        outputTokens: 105,
        tokenSource: "local-estimate",
        providerReported: false,
        recordedAt: "2026-06-29T10:01:00.000Z"
      }),
      rec({
        dedupKey: "p3",
        logicalRunId: attemptedRecovery,
        inputTokens: 1_200,
        outputTokens: 120,
        recordedAt: "2026-06-29T10:02:00.000Z",
        settledActivityEvent: transcriptDeltaSnapshot({
          runId: attemptedRecovery,
          input: 150,
          output: 15,
          startedAt: "2026-06-29T10:01:30.000Z",
          recordedAt: "2026-06-29T10:02:00.000Z"
        })
      })
    ];
    expect(aggregateHookUsageRecords(records).tools[0]).toMatchObject({
      inputTokens: 1_000,
      outputTokens: 100
    });
    expect(aggregateHookUsageRecords(records, {
      since: "2026-06-29T10:01:30.000Z"
    }).tools[0]).toMatchObject({ inputTokens: null, outputTokens: null });
    expect(exactPriorClaudeHookRecord(records.slice(0, 2), {
      sessionId: "s1",
      logicalRunId: switchedRun,
      before: "2026-06-29T10:01:30.000Z"
    })).toBeUndefined();
  });

  it("selects only a strict-before monotonic exact prior Claude record", () => {
    const logicalRunId = `claude-stop-${"d".repeat(32)}`;
    const records = [
      rec({
        dedupKey: "early",
        logicalRunId,
        inputTokens: 1_000,
        outputTokens: 100,
        recordedAt: "2026-06-29T10:00:00.000Z"
      }),
      rec({
        dedupKey: "latest",
        logicalRunId,
        inputTokens: 1_200,
        outputTokens: 120,
        recordedAt: "2026-06-29T10:01:00.000Z"
      })
    ];
    expect(exactPriorClaudeHookRecord(records, {
      sessionId: "s1",
      logicalRunId,
      before: "2026-06-29T10:02:00.000Z"
    })?.dedupKey).toBe("latest");
    expect(exactPriorClaudeHookRecord(records, {
      sessionId: "s1",
      logicalRunId,
      before: "2026-06-29T10:01:00.000Z"
    })).toBeUndefined();
    expect(exactPriorClaudeHookRecord(records, {
      sessionId: "foreign",
      logicalRunId,
      before: "2026-06-29T10:02:00.000Z"
    })).toBeUndefined();
  });

  it("keeps ties, decreasing/conflicting snapshots, foreign sessions, and malformed/legacy identities separate", () => {
    const tied = `claude-stop-${"b".repeat(32)}`;
    const decreasing = `claude-stop-${"c".repeat(32)}`;
    const records = [
      rec({ dedupKey: "t1", logicalRunId: tied, recordedAt: "2026-06-29T10:00:00.000Z", settledActivityEvent: settledSnapshot({ runId: tied, input: 1000, output: 200, recordedAt: "2026-06-29T10:00:00.000Z" }) }),
      rec({ dedupKey: "t2", logicalRunId: tied, inputTokens: 1200, recordedAt: "2026-06-29T10:00:00.000Z", settledActivityEvent: settledSnapshot({ runId: tied, input: 1200, output: 220, recordedAt: "2026-06-29T10:00:00.000Z" }) }),
      rec({ dedupKey: "d1", logicalRunId: decreasing, inputTokens: 1200, recordedAt: "2026-06-29T11:00:00.000Z", settledActivityEvent: settledSnapshot({ runId: decreasing, input: 1200, output: 200, recordedAt: "2026-06-29T11:00:00.000Z" }) }),
      rec({ dedupKey: "d2", logicalRunId: decreasing, inputTokens: 900, recordedAt: "2026-06-29T11:01:00.000Z", settledActivityEvent: settledSnapshot({ runId: decreasing, input: 900, output: 190, recordedAt: "2026-06-29T11:01:00.000Z" }) }),
      rec({ dedupKey: "foreign", sessionId: "s2", logicalRunId: decreasing, inputTokens: 1300, recordedAt: "2026-06-29T11:02:00.000Z", settledActivityEvent: settledSnapshot({ runId: decreasing, session: `claude-session-${"2".repeat(32)}`, input: 1300, output: 230, recordedAt: "2026-06-29T11:02:00.000Z" }) }),
      rec({ dedupKey: "bad1", logicalRunId: "claude-stop-malformed" }),
      rec({ dedupKey: "legacy" })
    ];
    const agg = aggregateHookUsageRecords(records);
    expect(agg.totalRecords).toBe(7);
    expect(agg.dedupedRecords).toBe(7);
    expect(agg.tools[0].events).toBe(7);
  });

  it("missing usage stays null (never 0) and is counted as unavailable", () => {
    const agg = aggregateHookUsageRecords([
      rec({ dedupKey: "x", inputTokens: null, outputTokens: null, totalTokens: null, providerReported: false, tokenSource: "unknown" })
    ]);
    const t = agg.tools[0];
    expect(t.inputTokens).toBeNull();
    expect(t.outputTokens).toBeNull();
    expect(t.unavailableEvents).toBe(1);
    expect(t.providerReportedEvents).toBe(0);
  });

  it("mixed present + missing: sums only present, counts missing as unavailable, output partial", () => {
    const agg = aggregateHookUsageRecords([
      rec({ dedupKey: "a", inputTokens: 1000, outputTokens: 200 }),
      rec({ dedupKey: "b", sessionId: "s2", inputTokens: null, outputTokens: null, providerReported: false, tokenSource: "unknown" })
    ]);
    const t = agg.tools[0];
    expect(t.inputTokens).toBe(1000); // not 1000+0; missing contributes nothing
    expect(t.outputRecorded).toBe(1);
    expect(t.unavailableEvents).toBe(1);
    expect(t.providerReportedEvents).toBe(1);
  });

  it("distinguishes provider-reported from local-estimate (sources preserved exactly)", () => {
    const agg = aggregateHookUsageRecords([
      rec({ dedupKey: "a", tokenSource: "provider-reported", providerReported: true }),
      rec({ dedupKey: "b", sessionId: "s2", tokenSource: "local-estimate", providerReported: false })
    ]);
    expect(agg.tools[0].tokenSources).toEqual(["local-estimate", "provider-reported"]);
  });

  it("since filter excludes older records", () => {
    const agg = aggregateHookUsageRecords(
      [rec({ dedupKey: "old", recordedAt: "2026-06-01T00:00:00.000Z" }), rec({ dedupKey: "new", sessionId: "s2", recordedAt: "2026-06-29T00:00:00.000Z" })],
      { since: "2026-06-15T00:00:00.000Z" }
    );
    expect(agg.dedupedRecords).toBe(1);
    expect(agg.tools[0].events).toBe(1);
  });

  it("derives an in-window Claude task from its exact pre-window cumulative baseline", () => {
    const firstRun = `claude-stop-${"4".repeat(32)}`;
    const secondRun = `claude-stop-${"5".repeat(32)}`;
    const deltaBase = settledSnapshot({
      runId: secondRun,
      input: 900,
      output: 80,
      startedAt: "2026-06-20T00:00:00.000Z",
      recordedAt: "2026-06-29T00:00:00.000Z"
    });
    const delta: ActivityEvent = {
      ...deltaBase,
      evidence_level: "monotonic delta from exact prior Claude session transcript usage",
      measurement_source: "claude-transcript"
    };
    delta.activity_event_id = computeActivityEventId(delta);
    const agg = aggregateHookUsageRecords([
      rec({
        dedupKey: "before-window",
        logicalRunId: firstRun,
        inputTokens: 1_000,
        outputTokens: 100,
        recordedAt: "2026-06-01T00:00:00.000Z"
      }),
      rec({
        dedupKey: "inside-window",
        logicalRunId: secondRun,
        inputTokens: 1_900,
        outputTokens: 180,
        recordedAt: "2026-06-29T00:00:00.000Z",
        settledActivityEvent: delta
      })
    ], { since: "2026-06-15T00:00:00.000Z" });
    expect(agg.totalRecords).toBe(1);
    expect(agg.dedupedRecords).toBe(1);
    expect(agg.tools[0]).toMatchObject({ events: 1, inputTokens: 900, outputTokens: 80 });
  });

  it("since filter excludes records with a missing/non-string recordedAt (cannot prove in-window)", () => {
    const agg = aggregateHookUsageRecords(
      [rec({ dedupKey: "notime", recordedAt: undefined as unknown as string })],
      { since: "2026-06-01T00:00:00.000Z" }
    );
    expect(agg.totalRecords).toBe(0);
    expect(agg.dedupedRecords).toBe(0);
    expect(agg.tools).toHaveLength(0);
  });

  it("totalRecords reflects the in-window count so 'deduped from N' reads accurately under --since", () => {
    const agg = aggregateHookUsageRecords(
      [rec({ dedupKey: "old", recordedAt: "2026-06-01T00:00:00.000Z" }), rec({ dedupKey: "new", sessionId: "s2", recordedAt: "2026-06-29T00:00:00.000Z" })],
      { since: "2026-06-15T00:00:00.000Z" }
    );
    expect(agg.totalRecords).toBe(1); // only the in-window record is counted
    expect(agg.dedupedRecords).toBe(1);
  });

  it("reasoning is always null (Claude Code session usage does not report it separately)", () => {
    expect(aggregateHookUsageRecords([rec()]).tools[0].reasoningTokens).toBeNull();
  });

  it("content-free: aggregate JSON carries no content fields", () => {
    const json = JSON.stringify(aggregateHookUsageRecords([rec()]));
    expect(json).not.toMatch(/last_assistant_message|prompt|completion|transcript/i);
  });
});

describe("loadHookUsageRecords", () => {
  it("loads valid records from records/ dirs and skips invalid files; missing dir → empty", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "hook-agg-"));
    const recDir = path.join(base, "claude-code", "records");
    await mkdir(recDir, { recursive: true });
    await writeFile(path.join(recDir, "a.json"), JSON.stringify(rec({ dedupKey: "a" })), "utf8");
    await writeFile(path.join(recDir, "bad.json"), "not json", "utf8");
    await writeFile(path.join(recDir, "wrong.json"), JSON.stringify({ schema: "something-else" }), "utf8");

    const loaded = await loadHookUsageRecords(base);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].dedupKey).toBe("a");

    const none = await loadHookUsageRecords(path.join(base, "does-not-exist"));
    expect(none).toEqual([]);
  });
});
