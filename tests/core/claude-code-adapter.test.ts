import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { ClaudeCodeAdapter, PRIVACY_WARNING } from "../../src/core/adapters/claude-code-adapter.js";
import { buildRunFlowTokenReport } from "../../src/core/run-flow-report.js";

const FIXTURE_PATH = new URL("../fixtures/claude-code-session-fixture.jsonl", import.meta.url).pathname;

function tempJsonlPath(prefix: string): string {
  const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  return join(dir, "session.jsonl");
}

async function writeJsonlFile(path: string, lines: unknown[]): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
}

describe("ClaudeCodeAdapter", () => {
  it("normalizes fixture session with correct source, message counts, role mapping, and UsageMetadata aggregation", async () => {
    const adapter = new ClaudeCodeAdapter();
    const result = await adapter.normalize({ sourcePath: FIXTURE_PATH });

    const { trace, usage, provenance } = result;

    // source must be real_captured
    expect(trace.source).toBe("real_captured");

    // adapter id
    expect(adapter.id).toBe("claude-code");

    // artifactVersion
    expect(trace.artifactVersion).toBe("agent-trace-v1");

    // model from first assistant entry
    expect(trace.model).toBe("claude-sonnet-4-6");

    // title from ai-title entry
    expect(trace.title).toBe("Fix compaction bug in policy middleware");

    // sessionId from entries
    expect(provenance.sessionId).toBe("test-session-id-1234");

    // Privacy warning is first warning
    expect(provenance.warnings[0]).toBe(PRIVACY_WARNING);

    // Subagent warning is last warning
    const lastWarning = provenance.warnings[provenance.warnings.length - 1];
    expect(lastWarning).toContain("--include-subagents");

    // Messages: fixture has
    // user-001: user text → role "user"
    // asst-001: text + tool_use → role "assistant" (text) + role "assistant" (tool_use)
    // user-002: tool_result → role "tool"
    // asst-002: thinking (excluded) + text → role "assistant" (text only; thinking excluded)
    // user-003: isSidechain=true → excluded
    // asst-003: text → role "assistant"
    // system entry: excluded
    const roles = trace.messages.map((m) => m.role);

    // user-001 text
    expect(roles).toContain("user");
    // tool result from user-002
    expect(roles).toContain("tool");
    // assistant entries
    const assistantMessages = trace.messages.filter((m) => m.role === "assistant");
    expect(assistantMessages.length).toBeGreaterThan(0);

    // Thinking block should be excluded - asst-002 thinking block
    const thinkingWarning = provenance.warnings.find((w) => w.includes("thinking block"));
    expect(thinkingWarning).toBeDefined();
    expect(thinkingWarning).toContain("1 thinking block");

    // No message should contain the thinking content
    const thinkingContent = "The bug is in the middleware";
    for (const msg of trace.messages) {
      expect(msg.content).not.toContain(thinkingContent);
    }

    // tool_result message (role "tool") must have toolName resolved to the tool type name,
    // NOT the raw tool_use_id UUID. The fixture has tool_use id="tu_001" name="Read"
    // matched by tool_result tool_use_id="tu_001".
    const toolMsg = trace.messages.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.toolName).toBe("Read");
    expect(toolMsg!.toolName).not.toMatch(/^toolu_/); // must not be a UUID-style id

    // UsageMetadata
    // input_tokens: 150 + 300 + 100 = 550
    // output_tokens: 80 + 120 + 40 = 240
    // cache_creation_input_tokens: 0 + 50 + 0 = 50
    // cache_read_input_tokens: 1200 + 2400 + 500 = 4100
    // total = 550 + 240 + 50 + 4100 = 4940
    expect(usage.input_tokens).toBe(550);
    expect(usage.output_tokens).toBe(240);
    expect(usage.total_tokens).toBe(4940);
    expect(usage.provider_reported_tokens).toBe(true);
    expect(usage.estimated_tokens).toBe(false);
    expect(usage.cost_source).toBe("price_table_estimate");
    expect(usage.provider).toBe("anthropic");

    // Cache token counts must be present as structured numeric fields (not only in limitations text).
    // cache_creation_input_tokens: 0 + 50 + 0 = 50
    // cache_read_input_tokens: 1200 + 2400 + 500 = 4100
    expect(usage.cache_read_input_tokens).toBe(4100);
    expect(usage.cache_creation_input_tokens).toBe(50);

    // provenance capturedAt is ISO 8601
    expect(provenance.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(provenance.captureAdapter).toBe("claude-code");
    expect(provenance.sourcePath).toBe(FIXTURE_PATH);
  });

  it("excludes thinking blocks and records warning with count", async () => {
    const sessionPath = tempJsonlPath("thinking-test");
    await writeJsonlFile(sessionPath, [
      {
        type: "user",
        uuid: "u1",
        timestamp: "2026-06-08T10:00:00.000Z",
        sessionId: "sess-thinking",
        isSidechain: false,
        message: { role: "user", content: "hello" }
      },
      {
        type: "assistant",
        uuid: "a1",
        timestamp: "2026-06-08T10:00:01.000Z",
        sessionId: "sess-thinking",
        isSidechain: false,
        message: {
          id: "msg1",
          model: "claude-sonnet-4-6",
          role: "assistant",
          type: "message",
          content: [
            { type: "thinking", thinking: "secret reasoning", signature: "sig" },
            { type: "thinking", thinking: "more secret reasoning", signature: "sig2" },
            { type: "text", text: "Here is my response." }
          ],
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
        }
      }
    ]);

    const adapter = new ClaudeCodeAdapter();
    const { trace, provenance } = await adapter.normalize({ sourcePath: sessionPath });

    // 2 thinking blocks excluded
    const thinkingWarning = provenance.warnings.find((w) => w.includes("thinking block"));
    expect(thinkingWarning).toBeDefined();
    expect(thinkingWarning).toContain("2 thinking block");

    // Thinking content not in messages
    for (const msg of trace.messages) {
      expect(msg.content).not.toContain("secret reasoning");
    }

    // The text message IS included
    const textMsg = trace.messages.find((m) => m.role === "assistant" && m.content.includes("Here is my response"));
    expect(textMsg).toBeDefined();
  });

  it("truncates tool result content exceeding maxToolResultChars", async () => {
    const sessionPath = tempJsonlPath("truncation-test");
    const longContent = "x".repeat(40_000);
    await writeJsonlFile(sessionPath, [
      {
        type: "user",
        uuid: "u1",
        timestamp: "2026-06-08T10:00:00.000Z",
        sessionId: "sess-trunc",
        isSidechain: false,
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tu1", content: longContent }
          ]
        }
      },
      {
        type: "assistant",
        uuid: "a1",
        timestamp: "2026-06-08T10:00:01.000Z",
        sessionId: "sess-trunc",
        isSidechain: false,
        message: {
          id: "msg1",
          model: "claude-sonnet-4-6",
          role: "assistant",
          type: "message",
          content: [{ type: "text", text: "Done." }],
          stop_reason: "end_turn",
          usage: { input_tokens: 5, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
        }
      }
    ]);

    const adapter = new ClaudeCodeAdapter();
    const { trace, provenance } = await adapter.normalize({ sourcePath: sessionPath });

    const toolMsg = trace.messages.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.content).toContain("[TRUNCATED - full content in source session JSONL]");
    expect(toolMsg!.content.length).toBeLessThan(40_000);

    // Truncation warning
    const truncWarning = provenance.warnings.find((w) => w.includes("truncated"));
    expect(truncWarning).toBeDefined();
  });

  it("uses fallback title when no ai-title entry is present", async () => {
    const sessionPath = tempJsonlPath("no-title-test");
    await writeJsonlFile(sessionPath, [
      {
        type: "user",
        uuid: "u1",
        timestamp: "2026-06-08T10:00:00.000Z",
        sessionId: "sess-aabbccdd",
        isSidechain: false,
        message: { role: "user", content: "hello" }
      },
      {
        type: "assistant",
        uuid: "a1",
        timestamp: "2026-06-08T10:00:01.000Z",
        sessionId: "sess-aabbccdd",
        isSidechain: false,
        message: {
          id: "msg1",
          model: "claude-sonnet-4-6",
          role: "assistant",
          type: "message",
          content: [{ type: "text", text: "hi" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 5, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
        }
      }
    ]);

    const adapter = new ClaudeCodeAdapter();
    const { trace } = await adapter.normalize({ sourcePath: sessionPath });

    // Fallback title uses truncated sessionId
    expect(trace.title).toContain("sess-aab");
  });

  it("uses unknown model fallback when no assistant entry has model field", async () => {
    const sessionPath = tempJsonlPath("no-model-test");
    await writeJsonlFile(sessionPath, [
      {
        type: "user",
        uuid: "u1",
        timestamp: "2026-06-08T10:00:00.000Z",
        sessionId: "sess-nomodel",
        isSidechain: false,
        message: { role: "user", content: "hello" }
      },
      {
        type: "assistant",
        uuid: "a1",
        timestamp: "2026-06-08T10:00:01.000Z",
        sessionId: "sess-nomodel",
        isSidechain: false,
        message: {
          id: "msg1",
          // no model field
          role: "assistant",
          type: "message",
          content: [{ type: "text", text: "hi" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 5, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
        }
      }
    ]);

    const adapter = new ClaudeCodeAdapter();
    const { trace } = await adapter.normalize({ sourcePath: sessionPath });

    expect(trace.model).toBe("unknown");
  });

  it("excludes entries with isSidechain: true in main session JSONL", async () => {
    const sessionPath = tempJsonlPath("sidechain-test");
    await writeJsonlFile(sessionPath, [
      {
        type: "user",
        uuid: "u1",
        timestamp: "2026-06-08T10:00:00.000Z",
        sessionId: "sess-sc",
        isSidechain: false,
        message: { role: "user", content: "primary message" }
      },
      {
        type: "user",
        uuid: "u2",
        timestamp: "2026-06-08T10:00:01.000Z",
        sessionId: "sess-sc",
        isSidechain: true,
        message: { role: "user", content: "sidechain message - must be excluded" }
      },
      {
        type: "assistant",
        uuid: "a1",
        timestamp: "2026-06-08T10:00:02.000Z",
        sessionId: "sess-sc",
        isSidechain: false,
        message: {
          id: "msg1",
          model: "claude-sonnet-4-6",
          role: "assistant",
          type: "message",
          content: [{ type: "text", text: "response" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 5, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
        }
      }
    ]);

    const adapter = new ClaudeCodeAdapter();
    const { trace } = await adapter.normalize({ sourcePath: sessionPath });

    // Sidechain message must not appear in trace
    for (const msg of trace.messages) {
      expect(msg.content).not.toContain("sidechain message - must be excluded");
    }

    // Primary message is present
    const primaryMsg = trace.messages.find((m) => m.content === "primary message");
    expect(primaryMsg).toBeDefined();
  });

  //  --include-subagents tests

  it("emits SUBAGENT_WARNING when --include-subagents is not passed", async () => {
    const adapter = new ClaudeCodeAdapter();
    const { provenance } = await adapter.normalize({ sourcePath: FIXTURE_PATH });

    const subagentWarning = provenance.warnings.find((w) => w.includes("--include-subagents"));
    expect(subagentWarning).toBeDefined();
    expect(subagentWarning).toContain("--include-subagents");

    // subagents field must be absent (flag not passed)
    expect(provenance.subagents).toBeUndefined();
  });

  it("omits SUBAGENT_WARNING when --include-subagents is passed and no subagents directory exists", async () => {
    // Fixture path has no adjacent <session-id>/subagents/ directory - graceful handling
    const adapter = new ClaudeCodeAdapter();
    const { provenance } = await adapter.normalize({
      sourcePath: FIXTURE_PATH,
      options: { includeSubagents: true }
    });

    // Subagent warning must be absent
    const subagentWarning = provenance.warnings.find((w) => w.includes("--include-subagents"));
    expect(subagentWarning).toBeUndefined();

    // subagents field must be present and empty (0 files found)
    expect(provenance.subagents).toBeDefined();
    expect(provenance.subagents).toHaveLength(0);

    // Limitation line present
    const subagentLimitation = provenance.limitations.find((l) => l.startsWith("Subagents included:"));
    expect(subagentLimitation).toBeDefined();
    expect(subagentLimitation).toContain("0 subagent JSONL file(s) processed");
  });

  it("merges subagent messages with agentId prefix, aggregates usage, and records provenance", async () => {
    // Set up a temporary session directory:
    // <tmpDir>/<sessionId>.jsonl  (main session)
    // <tmpDir>/<sessionId>/subagents/<agentId>.jsonl  (one subagent)
    const sessionId = `testsess-${Date.now()}`;
    const agentId = "agent1abc";

    const tmpDir = join(tmpdir(), `subagent-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const sessionFilePath = join(tmpDir, `${sessionId}.jsonl`);
    const subagentsDir = join(tmpDir, sessionId, "subagents");
    const subagentFilePath = join(subagentsDir, `${agentId}.jsonl`);

    await mkdir(tmpDir, { recursive: true });
    await mkdir(subagentsDir, { recursive: true });

    // Main session entries
    const mainEntries = [
      {
        type: "user",
        uuid: "main-u1",
        timestamp: "2026-06-08T10:00:00.000Z",
        sessionId,
        isSidechain: false,
        message: { role: "user", content: "main user message" }
      },
      {
        type: "assistant",
        uuid: "main-a1",
        timestamp: "2026-06-08T10:00:02.000Z",
        sessionId,
        isSidechain: false,
        message: {
          id: "msg-main-a1",
          model: "claude-sonnet-4-6",
          role: "assistant",
          type: "message",
          content: [{ type: "text", text: "main assistant response" }],
          stop_reason: "end_turn",
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_creation_input_tokens: 10,
            cache_read_input_tokens: 200
          }
        }
      }
    ];

    // Subagent entries - all have isSidechain: true (correct for subagent files)
    const subagentEntries = [
      {
        type: "user",
        uuid: "sub-u1",
        timestamp: "2026-06-08T10:00:01.000Z",
        sessionId,
        agentId,
        isSidechain: true,
        message: { role: "user", content: "subagent user message" }
      },
      {
        type: "assistant",
        uuid: "sub-a1",
        timestamp: "2026-06-08T10:00:03.000Z",
        sessionId,
        agentId,
        isSidechain: true,
        message: {
          id: "msg-sub-a1",
          model: "claude-sonnet-4-6",
          role: "assistant",
          type: "message",
          content: [{ type: "text", text: "subagent assistant response" }],
          stop_reason: "end_turn",
          usage: {
            input_tokens: 30,
            output_tokens: 20,
            cache_creation_input_tokens: 5,
            cache_read_input_tokens: 100
          }
        }
      }
    ];

    await writeFile(sessionFilePath, mainEntries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
    await writeFile(subagentFilePath, subagentEntries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");

    const adapter = new ClaudeCodeAdapter();
    const { trace, usage, provenance } = await adapter.normalize({
      sourcePath: sessionFilePath,
      options: { includeSubagents: true }
    });

    // Messages from both main and subagent are present
    const mainUserMsg = trace.messages.find((m) => m.content === "main user message");
    expect(mainUserMsg).toBeDefined();
    const subUserMsg = trace.messages.find((m) => m.content === "subagent user message");
    expect(subUserMsg).toBeDefined();
    const mainAsstMsg = trace.messages.find((m) => m.content === "main assistant response");
    expect(mainAsstMsg).toBeDefined();
    const subAsstMsg = trace.messages.find((m) => m.content === "subagent assistant response");
    expect(subAsstMsg).toBeDefined();

    // agentId prefix rule: subagent message ids should be prefixed with "<agentId>-"
    expect(subUserMsg!.id).toBe(`${agentId}-sub-u1`);
    expect(subAsstMsg!.id).toBe(`${agentId}-sub-a1`);

    // Main session message ids must NOT be prefixed
    expect(mainUserMsg!.id).toBe("main-u1");
    expect(mainAsstMsg!.id).toBe("main-a1");

    // Messages are sorted by timestamp ascending
    const timestamps = trace.messages.map((m) => m.timestamp ?? "");
    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i] >= timestamps[i - 1]).toBe(true);
    }

    // Usage aggregated: main (100+50+10+200=360) + subagent (30+20+5+100=155) = 515
    expect(usage.input_tokens).toBe(130);   // 100 + 30
    expect(usage.output_tokens).toBe(70);   // 50 + 20
    expect(usage.total_tokens).toBe(515);   // 360 + 155

    // Provenance subagents field
    expect(provenance.subagents).toBeDefined();
    expect(provenance.subagents).toHaveLength(1);
    expect(provenance.subagents![0].agentId).toBe(agentId);
    expect(provenance.subagents![0].entryCount).toBe(2); // 1 user + 1 assistant

    // Subagent warning must be absent
    const subagentWarning = provenance.warnings.find((w) => w.includes("--include-subagents"));
    expect(subagentWarning).toBeUndefined();

    // Limitation line must be present
    const subagentLimitation = provenance.limitations.find((l) => l.startsWith("Subagents included:"));
    expect(subagentLimitation).toBeDefined();
    expect(subagentLimitation).toContain("1 subagent JSONL file(s) processed");
  });

  it("reads optional meta.json fields into subagent provenance", async () => {
    const sessionId = `testsess-meta-${Date.now()}`;
    const agentId = "agentmeta1";

    const tmpDir = join(tmpdir(), `subagent-meta-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const sessionFilePath = join(tmpDir, `${sessionId}.jsonl`);
    const subagentsDir = join(tmpDir, sessionId, "subagents");
    const subagentFilePath = join(subagentsDir, `${agentId}.jsonl`);
    const metaDir = join(subagentsDir, agentId);
    const metaFilePath = join(metaDir, "meta.json");

    await mkdir(tmpDir, { recursive: true });
    await mkdir(metaDir, { recursive: true });

    const mainEntries = [
      {
        type: "user",
        uuid: "mu1",
        timestamp: "2026-06-08T10:00:00.000Z",
        sessionId,
        isSidechain: false,
        message: { role: "user", content: "hello" }
      },
      {
        type: "assistant",
        uuid: "ma1",
        timestamp: "2026-06-08T10:00:01.000Z",
        sessionId,
        isSidechain: false,
        message: {
          model: "claude-sonnet-4-6",
          role: "assistant",
          type: "message",
          content: [{ type: "text", text: "hi" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 5, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
        }
      }
    ];

    const subagentEntries = [
      {
        type: "assistant",
        uuid: "sa1",
        timestamp: "2026-06-08T10:00:02.000Z",
        sessionId,
        agentId,
        isSidechain: true,
        message: {
          model: "claude-sonnet-4-6",
          role: "assistant",
          type: "message",
          content: [{ type: "text", text: "subagent answer" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 3, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
        }
      }
    ];

    const metaContent = {
      agentType: "code-review",
      description: "Reviews code changes",
      toolUseId: "toolu_01XYZ"
    };

    await writeFile(sessionFilePath, mainEntries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
    await writeFile(subagentFilePath, subagentEntries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
    await writeFile(metaFilePath, JSON.stringify(metaContent), "utf8");

    const adapter = new ClaudeCodeAdapter();
    const { provenance } = await adapter.normalize({
      sourcePath: sessionFilePath,
      options: { includeSubagents: true }
    });

    expect(provenance.subagents).toHaveLength(1);
    const sub = provenance.subagents![0];
    expect(sub.agentId).toBe(agentId);
    expect(sub.agentType).toBe("code-review");
    expect(sub.description).toBe("Reviews code changes");
    expect(sub.toolUseId).toBe("toolu_01XYZ");
  });

  it("resolves tool_result toolName to tool type name from matching assistant tool_use entry", async () => {
    // This test verifies the core fix: tool_result messages must carry the tool TYPE name
    // (e.g. "Read", "Bash") resolved from the assistant tool_use entry, not the raw
    // tool_use_id UUID. Without this fix, waste detection is structurally impossible because
    // every UUID is globally unique and no two messages can ever share a toolName.
    const sessionPath = tempJsonlPath("toolname-resolution-test");
    await writeJsonlFile(sessionPath, [
      {
        type: "user",
        uuid: "u1",
        timestamp: "2026-06-08T10:00:00.000Z",
        sessionId: "sess-toolname",
        isSidechain: false,
        message: { role: "user", content: "read a file please" }
      },
      {
        type: "assistant",
        uuid: "a1",
        timestamp: "2026-06-08T10:00:01.000Z",
        sessionId: "sess-toolname",
        isSidechain: false,
        message: {
          id: "msg1",
          model: "claude-sonnet-4-6",
          role: "assistant",
          type: "message",
          content: [
            {
              type: "tool_use",
              id: "toolu_01ABCDEF12345",
              name: "Read",
              input: { file_path: "/some/file.ts" }
            }
          ],
          stop_reason: "tool_use",
          usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
        }
      },
      {
        type: "user",
        uuid: "u2",
        timestamp: "2026-06-08T10:00:02.000Z",
        sessionId: "sess-toolname",
        isSidechain: false,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_01ABCDEF12345",
              content: "file contents here"
            }
          ]
        }
      },
      {
        type: "user",
        uuid: "u3",
        timestamp: "2026-06-08T10:00:03.000Z",
        sessionId: "sess-toolname",
        isSidechain: false,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_UNMATCHED_UUID",
              content: "unmatched result"
            }
          ]
        }
      },
      {
        type: "assistant",
        uuid: "a2",
        timestamp: "2026-06-08T10:00:04.000Z",
        sessionId: "sess-toolname",
        isSidechain: false,
        message: {
          id: "msg2",
          model: "claude-sonnet-4-6",
          role: "assistant",
          type: "message",
          content: [{ type: "text", text: "Done." }],
          stop_reason: "end_turn",
          usage: { input_tokens: 20, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
        }
      }
    ]);

    const adapter = new ClaudeCodeAdapter();
    const { trace } = await adapter.normalize({ sourcePath: sessionPath });

    const toolMessages = trace.messages.filter((m) => m.role === "tool");
    expect(toolMessages).toHaveLength(2);

    // Matched tool_result: toolName must be the tool type name "Read", NOT the UUID
    const matchedMsg = toolMessages.find((m) => m.content === "file contents here");
    expect(matchedMsg).toBeDefined();
    expect(matchedMsg!.toolName).toBe("Read");
    expect(matchedMsg!.toolName).not.toBe("toolu_01ABCDEF12345");

    // Unmatched tool_result: falls back to the raw tool_use_id (backward compatibility)
    const unmatchedMsg = toolMessages.find((m) => m.content === "unmatched result");
    expect(unmatchedMsg).toBeDefined();
    expect(unmatchedMsg!.toolName).toBe("toolu_UNMATCHED_UUID");
  });

  it("passes cache_read_input_tokens and cache_creation_input_tokens as structured numeric fields in usage", async () => {
    const sessionPath = tempJsonlPath("cache-tokens-test");
    await writeJsonlFile(sessionPath, [
      {
        type: "user",
        uuid: "u1",
        timestamp: "2026-06-08T10:00:00.000Z",
        sessionId: "sess-cache-001",
        isSidechain: false,
        message: { role: "user", content: "hello" }
      },
      {
        type: "assistant",
        uuid: "a1",
        timestamp: "2026-06-08T10:00:01.000Z",
        sessionId: "sess-cache-001",
        isSidechain: false,
        message: {
          id: "msg1",
          model: "claude-sonnet-4-6",
          role: "assistant",
          type: "message",
          content: [{ type: "text", text: "response one" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 8000, cache_read_input_tokens: 200_000 }
        }
      },
      {
        type: "assistant",
        uuid: "a2",
        timestamp: "2026-06-08T10:00:02.000Z",
        sessionId: "sess-cache-001",
        isSidechain: false,
        message: {
          id: "msg2",
          model: "claude-sonnet-4-6",
          role: "assistant",
          type: "message",
          content: [{ type: "text", text: "response two" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 200, output_tokens: 80, cache_creation_input_tokens: 0, cache_read_input_tokens: 50_000 }
        }
      }
    ]);

    const adapter = new ClaudeCodeAdapter();
    const { usage } = await adapter.normalize({ sourcePath: sessionPath });

    // Structured numeric fields must be present and correctly aggregated
    expect(usage.cache_read_input_tokens).toBe(250_000); // 200_000 + 50_000
    expect(usage.cache_creation_input_tokens).toBe(8_000); // 8_000 + 0

    // Both fields must be numbers (not strings or undefined)
    expect(typeof usage.cache_read_input_tokens).toBe("number");
    expect(typeof usage.cache_creation_input_tokens).toBe("number");

    // Standard fields still correct
    expect(usage.input_tokens).toBe(300); // 100 + 200
    expect(usage.output_tokens).toBe(130); // 50 + 80
    expect(usage.provider_reported_tokens).toBe(true);
  });

  it("omits cache_read_input_tokens and cache_creation_input_tokens from usage when all are zero", async () => {
    const sessionPath = tempJsonlPath("no-cache-test");
    await writeJsonlFile(sessionPath, [
      {
        type: "user",
        uuid: "u1",
        timestamp: "2026-06-08T10:00:00.000Z",
        sessionId: "sess-nocache-001",
        isSidechain: false,
        message: { role: "user", content: "hello" }
      },
      {
        type: "assistant",
        uuid: "a1",
        timestamp: "2026-06-08T10:00:01.000Z",
        sessionId: "sess-nocache-001",
        isSidechain: false,
        message: {
          id: "msg1",
          model: "claude-sonnet-4-6",
          role: "assistant",
          type: "message",
          content: [{ type: "text", text: "no cache response" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 50, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
        }
      }
    ]);

    const adapter = new ClaudeCodeAdapter();
    const { usage } = await adapter.normalize({ sourcePath: sessionPath });

    // Zero cache counts → fields omitted from UsageMetadata
    expect(usage.cache_read_input_tokens).toBeUndefined();
    expect(usage.cache_creation_input_tokens).toBeUndefined();
    expect(usage.input_tokens).toBe(50);
    expect(usage.output_tokens).toBe(20);
  });

  it("gracefully handles empty subagents directory when --include-subagents is passed", async () => {
    const sessionId = `testsess-empty-${Date.now()}`;
    const tmpDir = join(tmpdir(), `subagent-empty-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const sessionFilePath = join(tmpDir, `${sessionId}.jsonl`);
    const subagentsDir = join(tmpDir, sessionId, "subagents");

    await mkdir(tmpDir, { recursive: true });
    await mkdir(subagentsDir, { recursive: true }); // empty directory

    const mainEntries = [
      {
        type: "user",
        uuid: "eu1",
        timestamp: "2026-06-08T10:00:00.000Z",
        sessionId,
        isSidechain: false,
        message: { role: "user", content: "hello" }
      }
    ];

    await writeFile(sessionFilePath, mainEntries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");

    const adapter = new ClaudeCodeAdapter();
    const { provenance } = await adapter.normalize({
      sourcePath: sessionFilePath,
      options: { includeSubagents: true }
    });

    expect(provenance.subagents).toBeDefined();
    expect(provenance.subagents).toHaveLength(0);

    // Limitation line
    const subagentLimitation = provenance.limitations.find((l) => l.startsWith("Subagents included:"));
    expect(subagentLimitation).toBeDefined();
    expect(subagentLimitation).toContain("0 subagent JSONL file(s) processed");
  });

  it("surfaces a non-sensitive trace fingerprint (digest only - no raw session content)", async () => {
    const adapter = new ClaudeCodeAdapter();
    const { trace, provenance } = await adapter.normalize({ sourcePath: FIXTURE_PATH });

    // Fingerprint is surfaced on provenance as a digest with the versioned algorithm.
    expect(provenance.traceFingerprint).toBeDefined();
    const fp = provenance.traceFingerprint!;
    expect(fp.content_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(fp.algorithm).toBe("sha256-canonical-content-v1");
    expect(fp.message_count).toBe(trace.messages.length);

    // No raw message content leaks into the emitted fingerprint object.
    const serialized = JSON.stringify(fp);
    for (const m of trace.messages) {
      if (m.content.length > 0) {
        expect(serialized).not.toContain(m.content);
      }
    }
  });

  it("yields the SAME fingerprint when the same session file is captured twice (re-capture de-dup signal)", async () => {
    const adapter = new ClaudeCodeAdapter();
    const a = await adapter.normalize({ sourcePath: FIXTURE_PATH });
    const b = await adapter.normalize({ sourcePath: FIXTURE_PATH });
    expect(b.provenance.traceFingerprint?.content_sha256).toBe(a.provenance.traceFingerprint?.content_sha256);
  });

  //  Token-accounting basis regression (measurement honesty)
  // Claude Code writes one "assistant" JSONL line PER CONTENT BLOCK of the same API request, and
  // every line repeats the request's usage object (same message.id). Summing per line double-counts
  // every token axis by the number of content blocks. These tests pin the honest contract: usage is
  // counted ONCE per request, and input/output are cumulative over the SAME request set.

  /** One request written as two JSONL lines (text block + tool_use block), usage repeated on both. */
  function requestLines(requestIndex: number, usage: Record<string, number>): unknown[] {
    const messageId = `msg_req_${requestIndex}`;
    const base = {
      type: "assistant",
      sessionId: "sess-dup-usage",
      isSidechain: false,
      timestamp: `2026-06-08T10:0${requestIndex}:00.000Z`
    };
    return [
      {
        ...base,
        uuid: `a${requestIndex}-1`,
        message: { id: messageId, model: "claude-sonnet-4-6", role: "assistant", type: "message", content: [{ type: "text", text: `answer ${requestIndex}` }], usage }
      },
      {
        ...base,
        uuid: `a${requestIndex}-2`,
        message: { id: messageId, model: "claude-sonnet-4-6", role: "assistant", type: "message", content: [{ type: "tool_use", id: `tu_${requestIndex}`, name: "Bash", input: { command: "true" } }], usage }
      }
    ];
  }

  it("counts provider usage ONCE per request when a request spans multiple JSONL lines (no per-line double count)", async () => {
    const sessionPath = tempJsonlPath("dup-usage-test");
    // 3 requests, each input 800k / output 5k, each written as 2 lines with identical usage.
    const perRequest = { input_tokens: 800_000, output_tokens: 5_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
    await writeJsonlFile(sessionPath, [
      ...requestLines(1, perRequest),
      ...requestLines(2, perRequest),
      ...requestLines(3, perRequest)
    ]);

    const adapter = new ClaudeCodeAdapter();
    const { usage } = await adapter.normalize({ sourcePath: sessionPath });

    // Both axes cumulative over the SAME 3 requests: 3 × 800k and 3 × 5k - NOT the per-line
    // double-counted 4.8M / 30k the old per-line sum produced.
    expect(usage.input_tokens).toBe(2_400_000);
    expect(usage.output_tokens).toBe(15_000);
    expect(usage.total_tokens).toBe(2_415_000);

    // Regression: for a context-heavy session, output must NOT exceed input on the reported basis.
    expect(usage.output_tokens!).toBeLessThanOrEqual(usage.input_tokens!);
  });

  it("keeps the LAST usage seen for a request (streamed partial counts resolve to the final ones)", async () => {
    const sessionPath = tempJsonlPath("last-usage-test");
    const partial = { input_tokens: 800_000, output_tokens: 1_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
    const final = { input_tokens: 800_000, output_tokens: 5_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
    const [line1, line2] = requestLines(1, partial);
    const lineFinal = { ...(line2 as Record<string, unknown>), message: { ...(line2 as { message: Record<string, unknown> }).message, usage: final } };
    await writeJsonlFile(sessionPath, [line1, lineFinal]);

    const adapter = new ClaudeCodeAdapter();
    const { usage } = await adapter.normalize({ sourcePath: sessionPath });

    expect(usage.input_tokens).toBe(800_000); // one request, counted once
    expect(usage.output_tokens).toBe(5_000); // the final count, not partial and not partial+final
  });

  it("cache token axes are also deduped per request (never per line)", async () => {
    const sessionPath = tempJsonlPath("dup-cache-test");
    const perRequest = { input_tokens: 800, output_tokens: 5_000, cache_creation_input_tokens: 11_000, cache_read_input_tokens: 799_200 };
    await writeJsonlFile(sessionPath, [...requestLines(1, perRequest), ...requestLines(2, perRequest)]);

    const adapter = new ClaudeCodeAdapter();
    const { usage } = await adapter.normalize({ sourcePath: sessionPath });

    expect(usage.input_tokens).toBe(1_600);
    expect(usage.output_tokens).toBe(10_000);
    expect(usage.cache_read_input_tokens).toBe(1_598_400);
    expect(usage.cache_creation_input_tokens).toBe(22_000);
  });

  it("end-to-end: run-flow token report puts input and output on the SAME basis - model-visible input ≥ output for a context-heavy session", async () => {
    const sessionPath = tempJsonlPath("basis-test");
    // Realistic caching shape: tiny FRESH input per request (the raw provider `input_tokens` field is
    // only the uncached remainder), huge cached context, moderate output. On the raw-fresh-input basis
    // output would misleadingly dwarf input; on the model-visible basis input ≫ output (context is the cost).
    const perRequest = { input_tokens: 800, output_tokens: 5_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 799_200 };
    await writeJsonlFile(sessionPath, [
      ...requestLines(1, perRequest),
      ...requestLines(2, perRequest),
      ...requestLines(3, perRequest)
    ]);

    const adapter = new ClaudeCodeAdapter();
    const { usage } = await adapter.normalize({ sourcePath: sessionPath });
    const report = buildRunFlowTokenReport({ tool: "claude-code", usage, outputStatus: "present" });

    // Input axis = model-visible input, cumulative over the same 3 requests as output:
    // 3 × (800 fresh + 799,200 cache read) = 2.4M vs 3 × 5k output.
    expect(report.input_tokens).toBe(2_400_000);
    expect(report.output_tokens).toBe(15_000);
    expect(report.input_token_source).toBe("provider-reported");
    expect(report.output_token_source).toBe("provider-reported");

    // The bases match: output is NOT larger than input for a context-heavy session.
    expect(report.output_tokens!).toBeLessThanOrEqual(report.input_tokens!);

    // The basis is stated honestly (model-visible input, not fresh/billed input alone).
    expect(report.notes.join("\n")).toContain("model-visible input");
  });
});
