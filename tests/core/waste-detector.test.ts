import { describe, expect, it } from "vitest";
import {
  detectWaste,
  detectSupersededSameSourceReads,
  getCompactedMessageIds
} from "../../src/core/waste-detector.js";
import type { AgentTrace, TraceMessage } from "../../src/core/types.js";

const trace: AgentTrace = {
  id: "trace_repeated_tool",
  title: "Repeated tool output",
  artifactVersion: "agent-trace-v1",
  source: "manual",
  createdAt: "2026-01-01T00:00:00.000Z",
  generatedAt: "2026-01-01T00:00:00.000Z",
  model: "placeholder-agent-model",
  messages: [
    {
      id: "msg_001",
      role: "tool",
      toolName: "read_file",
      timestamp: "2026-01-01T00:00:00.000Z",
      content: "same file contents"
    },
    {
      id: "msg_002",
      role: "assistant",
      timestamp: "2026-01-01T00:00:01.000Z",
      content: "I saw the file."
    },
    {
      id: "msg_003",
      role: "tool",
      toolName: "read_file",
      timestamp: "2026-01-01T00:00:02.000Z",
      content: "same   file\ncontents"
    }
  ]
};

describe("waste-detector", () => {
  it("detects repeated tool output with normalized whitespace", () => {
    expect(detectWaste(trace)).toEqual([
      {
        category: "repeated_tool_output",
        messageIds: ["msg_001", "msg_003"],
        summary: "Repeated read_file tool output. Keep msg_001 and compact msg_003.",
        estimatedTokens: 5
      }
    ]);
  });

  it("honors duplicate token and character thresholds when requested", () => {
    expect(
      detectWaste(trace, {
        minDuplicateTokens: 100,
        minDuplicateCharacters: 100
      })
    ).toEqual([]);
  });

  it("returns only duplicate message ids for compaction", () => {
    expect([...getCompactedMessageIds(detectWaste(trace))]).toEqual(["msg_003"]);
  });

  it("leaves the existing repeated_tool_output behavior unchanged when only identical repeats exist", () => {
    // No category-1 finding should appear: the two reads are identical-up-to-whitespace, so they are
    // the repeated_tool_output case, not a genuine supersession.
    const findings = detectWaste(trace);
    expect(findings).toHaveLength(1);
    expect(findings[0].category).toBe("repeated_tool_output");
    expect(detectSupersededSameSourceReads(trace)).toEqual([]);
  });
});

const ts = "2026-06-30T00:00:00.000Z";
const message = (
  id: string,
  role: TraceMessage["role"],
  content: string,
  toolName?: string
): TraceMessage => ({ id, role, content, timestamp: ts, ...(toolName ? { toolName } : {}) });

// A same-source read pair (Read of the same file) where the LATER read content DIFFERS from the
// earlier (genuine supersession). Each output is preceded by a parseable same-tool CALL (JSON args).
function supersededTrace(): AgentTrace {
  return {
    id: "trace_superseded",
    title: "superseded same-source read",
    artifactVersion: "agent-trace-v1",
    source: "manual",
    createdAt: ts,
    generatedAt: ts,
    model: "test-model",
    messages: [
      message("u1", "user", "Read config and confirm the update.", undefined),
      message("c1", "assistant", JSON.stringify({ file_path: "/repo/config.yaml" }), "Read"),
      message("o1", "tool", "config: retries=1 timeout=1000", "Read"),
      message("a1", "assistant", "Now I edited it; re-reading.", undefined),
      message("c2", "assistant", JSON.stringify({ file_path: "/repo/config.yaml" }), "Read"),
      message("o2", "tool", "config: retries=5 timeout=5000", "Read")
    ]
  };
}

describe("detectSupersededSameSourceReads (input-compaction category 1)", () => {
  it("fires on superseded same-source reads with differing content, keeping the latest as messageIds[0]", () => {
    const findings = detectSupersededSameSourceReads(supersededTrace());
    expect(findings).toHaveLength(1);
    expect(findings[0].category).toBe("superseded_same_source_read");
    // Convention: messageIds[0] = KEPT latest authoritative read; messageIds[1..] = earlier superseded.
    expect(findings[0].messageIds[0]).toBe("o2");
    expect(findings[0].messageIds.slice(1)).toEqual(["o1"]);
    expect(findings[0].estimatedTokens).toBeGreaterThan(0);
  });

  it("getCompactedMessageIds compacts the earlier superseded read and KEEPS the latest", () => {
    const findings = detectSupersededSameSourceReads(supersededTrace());
    const compacted = getCompactedMessageIds(findings);
    expect(compacted.has("o1")).toBe(true); // earlier superseded -> compacted
    expect(compacted.has("o2")).toBe(false); // latest authoritative -> kept
  });

  it("does NOT compact when source identity is unknown/ambiguous (no preceding parseable same-tool call)", () => {
    const trace = supersededTrace();
    // Remove the preceding parseable Read CALLS so the outputs have no provable source identity.
    trace.messages = trace.messages.filter((m) => m.id !== "c1" && m.id !== "c2");
    expect(detectSupersededSameSourceReads(trace)).toEqual([]);
  });

  it("does NOT compact when the preceding same-tool assistant message is not a parseable call", () => {
    const trace = supersededTrace();
    // Make the calls same-tool but unparseable (neither JSON object nor "Tool call: ..." form).
    for (const m of trace.messages) {
      if (m.id === "c1" || m.id === "c2") {
        m.content = "looking at the file now";
      }
    }
    expect(detectSupersededSameSourceReads(trace)).toEqual([]);
  });

  it("leaves identical-content same-source reads to repeated_tool_output (no category-1 finding)", () => {
    const trace = supersededTrace();
    // Make both reads identical-up-to-whitespace: this is the repeated_tool_output case, NOT cat 1.
    for (const m of trace.messages) {
      if (m.id === "o1") m.content = "config: retries=1 timeout=1000";
      if (m.id === "o2") m.content = "config:   retries=1\ttimeout=1000";
    }
    expect(detectSupersededSameSourceReads(trace)).toEqual([]);
    // And detectWaste should report it as repeated_tool_output (additive policy did not steal it).
    const all = detectWaste(trace);
    expect(all.some((f) => f.category === "repeated_tool_output")).toBe(true);
    expect(all.some((f) => f.category === "superseded_same_source_read")).toBe(false);
  });

  it("normalizes JSON call-arg key order (identity is key-order-independent)", () => {
    const trace = supersededTrace();
    // Same args, different key order on the two calls -> still the same source identity.
    for (const m of trace.messages) {
      if (m.id === "c1") m.content = JSON.stringify({ file_path: "/repo/config.yaml", offset: 0 });
      if (m.id === "c2") m.content = JSON.stringify({ offset: 0, file_path: "/repo/config.yaml" });
    }
    const findings = detectSupersededSameSourceReads(trace);
    expect(findings).toHaveLength(1);
    expect(findings[0].messageIds).toEqual(["o2", "o1"]);
  });

  it("supports the \"Tool call: <cmd>\" call form (Bash same-command supersession)", () => {
    const trace: AgentTrace = {
      ...supersededTrace(),
      messages: [
        message("u1", "user", "Run the status command twice.", undefined),
        message("c1", "assistant", "Tool call: git status --short", "Bash"),
        message("o1", "tool", "M file-a.ts\nM file-b.ts", "Bash"),
        message("a1", "assistant", "I made a change; re-running.", undefined),
        message("c2", "assistant", "Tool call:   git   status   --short ", "Bash"),
        message("o2", "tool", "M file-a.ts\nM file-b.ts\nM file-c.ts", "Bash")
      ]
    };
    const findings = detectSupersededSameSourceReads(trace);
    expect(findings).toHaveLength(1);
    expect(findings[0].messageIds).toEqual(["o2", "o1"]);
  });

  it("does NOT cross source identity: different files are not grouped", () => {
    const trace: AgentTrace = {
      ...supersededTrace(),
      messages: [
        message("u1", "user", "Read two different files.", undefined),
        message("c1", "assistant", JSON.stringify({ file_path: "/repo/a.yaml" }), "Read"),
        message("o1", "tool", "a content x", "Read"),
        message("c2", "assistant", JSON.stringify({ file_path: "/repo/b.yaml" }), "Read"),
        message("o2", "tool", "b content y", "Read")
      ]
    };
    expect(detectSupersededSameSourceReads(trace)).toEqual([]);
  });

  it("respects min-token/char thresholds on the compacted earlier read", () => {
    const trace = supersededTrace();
    // The differing earlier read is short; with high thresholds it must NOT be compacted.
    expect(
      detectSupersededSameSourceReads(trace, { minDuplicateTokens: 1000, minDuplicateCharacters: 5000 })
    ).toEqual([]);
  });
});
