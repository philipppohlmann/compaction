import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  aggregateHookUsageRecords,
  loadHookUsageRecords,
  HOOK_USAGE_AGGREGATE_SCHEMA
} from "../../src/core/hook-usage-aggregate.js";
import { CLAUDE_CODE_HOOK_RECORD_SCHEMA, type ClaudeCodeHookRecord } from "../../src/core/claude-code-hook-record.js";

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
