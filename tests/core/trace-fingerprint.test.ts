import { describe, expect, it } from "vitest";
import {
  computeTraceFingerprint,
  classifyDistinctness,
  TRACE_FINGERPRINT_ALGORITHM,
  type DistinctnessRecord
} from "../../src/core/trace-fingerprint.js";
import type { AgentTrace, TraceMessage } from "../../src/core/types.js";

function makeTrace(overrides: Partial<AgentTrace> = {}, messages?: TraceMessage[]): AgentTrace {
  return {
    id: "claude-code-session-a",
    title: "Session A",
    artifactVersion: "agent-trace-v1",
    source: "real_captured",
    createdAt: "2026-06-08T10:00:00.000Z",
    generatedAt: "2026-06-08T10:05:00.000Z",
    model: "claude-sonnet-4-6",
    durationMs: 1000,
    messages: messages ?? [
      { id: "m1", role: "user", content: "Fix the SECRET_TOKEN bug in policy.ts", timestamp: "2026-06-08T10:00:01.000Z" },
      { id: "m2", role: "assistant", content: "Reading the file now.", timestamp: "2026-06-08T10:00:05.000Z" },
      {
        id: "m3",
        role: "tool",
        content: "export const SECRET_TOKEN = 'sk-do-not-leak-123';",
        timestamp: "2026-06-08T10:00:06.000Z",
        toolName: "Read"
      }
    ],
    ...overrides
  };
}

describe("computeTraceFingerprint", () => {
  it("produces a stable sha256 hex digest with the versioned algorithm and message count", () => {
    const fp = computeTraceFingerprint(makeTrace());
    expect(fp.algorithm).toBe(TRACE_FINGERPRINT_ALGORITHM);
    expect(fp.content_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(fp.message_count).toBe(3);
  });

  it("is deterministic for identical content (same session → same fingerprint, de-dup)", () => {
    expect(computeTraceFingerprint(makeTrace()).content_sha256).toBe(
      computeTraceFingerprint(makeTrace()).content_sha256
    );
  });

  it("is INVARIANT to capture-time-varying fields (re-capture of the same session matches)", () => {
    // Same canonical content, but different capturedAt-style fields, id, title, durationMs.
    const a = computeTraceFingerprint(makeTrace());
    const b = computeTraceFingerprint(
      makeTrace({
        id: "claude-code-session-a-recapture",
        title: "Session A (recaptured)",
        createdAt: "2026-06-15T23:59:59.000Z",
        generatedAt: "2026-06-15T23:59:59.999Z",
        durationMs: 999_999
      })
    );
    expect(b.content_sha256).toBe(a.content_sha256);
  });

  it("changes when the message content differs (different session → different fingerprint)", () => {
    const a = computeTraceFingerprint(makeTrace());
    const b = computeTraceFingerprint(
      makeTrace({}, [
        { id: "m1", role: "user", content: "Completely different task: write a haiku", timestamp: "2026-06-08T10:00:01.000Z" }
      ])
    );
    expect(b.content_sha256).not.toBe(a.content_sha256);
  });
});

describe("trace fingerprint contains NO raw content (privacy gate)", () => {
  it("emits only a digest - no message/prompt/tool-output substrings", () => {
    const trace = makeTrace();
    const fp = computeTraceFingerprint(trace);
    const serialized = JSON.stringify(fp);

    // The exact secret-bearing strings fed into the hash must NOT appear in the output.
    expect(serialized).not.toContain("SECRET_TOKEN");
    expect(serialized).not.toContain("sk-do-not-leak-123");
    expect(serialized).not.toContain("Fix the");
    expect(serialized).not.toContain("Reading the file");
    expect(serialized).not.toContain("policy.ts");

    // No source-message content string is present verbatim.
    for (const m of trace.messages) {
      expect(serialized).not.toContain(m.content);
    }

    // The only string fields are the algorithm label and a 64-char hex digest.
    expect(Object.keys(fp).sort()).toEqual(["algorithm", "content_sha256", "message_count"]);
    expect(fp.content_sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("classifyDistinctness (de-dup / not_verified - never inflate N)", () => {
  it("same aggregate metrics but distinctness NOT proven (no fingerprint) → not_verified, NOT distinct", () => {
    // Two runs that might report identical aggregate metrics, but carry NO fingerprint.
    const records: DistinctnessRecord[] = [
      { runId: "run-1" }, // no content_sha256
      { runId: "run-2", content_sha256: null }, // explicitly unverified
      { runId: "run-3", content_sha256: "" } // empty == unverified
    ];
    const result = classifyDistinctness(records);
    expect(result.distinct_verified_count).toBe(0);
    expect(result.not_verified_run_ids).toEqual(["run-1", "run-2", "run-3"]);
    expect(result.total_runs).toBe(3);
  });

  it("same fingerprint → counted once (de-dup)", () => {
    const records: DistinctnessRecord[] = [
      { runId: "run-1", content_sha256: "aaaa" },
      { runId: "run-2", content_sha256: "aaaa" }, // re-capture of the same session
      { runId: "run-3", content_sha256: "aaaa" }
    ];
    const result = classifyDistinctness(records);
    expect(result.distinct_verified_count).toBe(1);
    expect(result.distinct_fingerprints).toEqual(["aaaa"]);
    expect(result.not_verified_run_ids).toEqual([]);
    expect(result.total_runs).toBe(3);
  });

  it("different fingerprints → counted as distinct", () => {
    const records: DistinctnessRecord[] = [
      { runId: "run-1", content_sha256: "aaaa" },
      { runId: "run-2", content_sha256: "bbbb" },
      { runId: "run-3", content_sha256: "cccc" }
    ];
    const result = classifyDistinctness(records);
    expect(result.distinct_verified_count).toBe(3);
    expect(result.distinct_fingerprints).toEqual(["aaaa", "bbbb", "cccc"]);
    expect(result.not_verified_run_ids).toEqual([]);
  });

  it("missing fingerprint does NOT inflate N (mixed verified + unverified)", () => {
    const records: DistinctnessRecord[] = [
      { runId: "run-1", content_sha256: "aaaa" }, // distinct
      { runId: "run-2", content_sha256: "aaaa" }, // re-capture → de-dup
      { runId: "run-3", content_sha256: "bbbb" }, // distinct
      { runId: "run-4" }, // not verified, must NOT add to N
      { runId: "run-5", content_sha256: null } // not verified, must NOT add to N
    ];
    const result = classifyDistinctness(records);
    // Only 2 genuinely-distinct verified sessions; the 2 unverified runs do not inflate N.
    expect(result.distinct_verified_count).toBe(2);
    expect(result.distinct_fingerprints).toEqual(["aaaa", "bbbb"]);
    expect(result.not_verified_run_ids).toEqual(["run-4", "run-5"]);
    expect(result.total_runs).toBe(5);
  });
});
