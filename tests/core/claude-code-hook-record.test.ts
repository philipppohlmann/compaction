import { describe, expect, it } from "vitest";
import {
  buildClaudeCodeHookRecord,
  computeDedupKey,
  emptyLedger,
  isAlreadyRecorded,
  parseStopPayload,
  resolveTranscriptPath
} from "../../src/core/claude-code-hook-record.js";
import { createUsageMetadata, missingUsageMetadata } from "../../src/core/usage-metadata.js";

/**
 * Claude Code hook record + dedup (public). Invariants: missing transcript_path → no path; dedup key is
 * deterministic + state-sensitive; the record is CONTENT-FREE; missing usage stays null (not 0) and
 * provider-reported source is preserved where usage exists.
 */
describe("parseStopPayload / resolveTranscriptPath", () => {
  it("missing transcript_path → null (hook becomes a no-op)", () => {
    expect(resolveTranscriptPath(parseStopPayload('{"session_id":"s1","hook_event_name":"Stop"}'))).toBeNull();
  });
  it("present transcript_path → returned", () => {
    expect(resolveTranscriptPath(parseStopPayload('{"transcript_path":"/x/y.jsonl"}'))).toBe("/x/y.jsonl");
  });
  it("unparseable payload → null (fail-open)", () => {
    expect(parseStopPayload("not json")).toBeNull();
    expect(resolveTranscriptPath(null)).toBeNull();
  });
});

describe("computeDedupKey - deterministic + state-sensitive", () => {
  const base = { sessionId: "s1", fingerprint: "abc123", messageCount: 10, inputTokens: 100, outputTokens: 50 };
  it("is stable for the same session state", () => {
    expect(computeDedupKey(base)).toBe(computeDedupKey({ ...base }));
  });
  it("changes when the fingerprint (session state) changes", () => {
    expect(computeDedupKey(base)).not.toBe(computeDedupKey({ ...base, fingerprint: "def456" }));
  });
  it("falls back to message-count + tokens when no fingerprint, and differs by state", () => {
    const noFp = { ...base, fingerprint: undefined };
    expect(computeDedupKey(noFp)).not.toBe(computeDedupKey({ ...noFp, messageCount: 11 }));
  });
});

describe("isAlreadyRecorded", () => {
  it("dedup: a key already in the ledger is not re-recorded", () => {
    const ledger = emptyLedger();
    const key = computeDedupKey({ sessionId: "s1", fingerprint: "abc", messageCount: 3, inputTokens: 1, outputTokens: 1 });
    expect(isAlreadyRecorded(ledger, key)).toBe(false);
    ledger.entries.push({ dedupKey: key, recordedAt: "2026-06-29T00:00:00.000Z" });
    expect(isAlreadyRecorded(ledger, key)).toBe(true);
  });
});

describe("buildClaudeCodeHookRecord - content-free + honest tokens", () => {
  it("provider-reported usage → providerReported true, source preserved, no content fields", () => {
    const usage = createUsageMetadata({
      inputTokens: 1000,
      outputTokens: 200,
      totalTokens: 1200,
      cacheReadInputTokens: 50,
      providerReportedTokens: true,
      estimatedTokens: false,
      model: "claude-x",
      provider: "anthropic"
    });
    const r = buildClaudeCodeHookRecord({ usage, sessionId: "s1", messageCount: 8, dedupKey: "k1", recordedAt: "2026-06-29T00:00:00.000Z" });
    expect(r.providerReported).toBe(true);
    expect(r.tokenSource).toBe("provider-reported");
    expect(r.inputTokens).toBe(1000);
    expect(r.outputTokens).toBe(200);
    // content-free: never the ignored content field, and ONLY the whitelisted metric/id keys appear.
    const json = JSON.stringify(r);
    expect(json).not.toMatch(/last_assistant_message/);
    const allowed = new Set([
      "schema", "tool", "sessionId", "dedupKey", "inputTokens", "outputTokens",
      "cacheReadInputTokens", "cacheCreationInputTokens", "totalTokens",
      "providerReported", "tokenSource", "provider", "model", "messageCount", "recordedAt"
    ]);
    for (const k of Object.keys(r)) expect(allowed.has(k)).toBe(true);
  });

  it("missing usage → token counts null (NOT 0), providerReported false", () => {
    const usage = missingUsageMetadata({ model: "claude-x", provider: "anthropic", limitations: [] });
    const r = buildClaudeCodeHookRecord({ usage, messageCount: 0, dedupKey: "k2", recordedAt: "2026-06-29T00:00:00.000Z" });
    expect(r.providerReported).toBe(false);
    expect(r.inputTokens).toBeNull();
    expect(r.outputTokens).toBeNull();
    expect(r.totalTokens).toBeNull();
    expect(r.tokenSource).not.toBe("provider-reported");
  });
});
