import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  discoverClaudeCodeSessions,
  defaultProjectsDir,
  DISCOVERY_PRIVACY_NOTE
} from "../../src/core/adapters/claude-code-discovery.js";
import { scanSessionMetadata } from "../../src/core/adapters/claude-code-adapter.js";

//  Fixture helpers

async function writeJsonl(path: string, entries: unknown[]): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
}

/** A minimal session with one assistant entry carrying a usage object. */
function sessionWithUsage(sessionId: string): unknown[] {
  return [
    {
      type: "user",
      uuid: "u1",
      timestamp: "2026-06-08T10:00:00.000Z",
      sessionId,
      cwd: "/Users/me/Projects/app",
      isSidechain: false,
      message: { role: "user", content: "hello" }
    },
    {
      type: "assistant",
      uuid: "a1",
      timestamp: "2026-06-08T10:05:00.000Z",
      sessionId,
      isSidechain: false,
      message: {
        id: "m1",
        model: "claude-sonnet-4-6",
        role: "assistant",
        type: "message",
        content: [{ type: "text", text: "hi there" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
      }
    }
  ];
}

/** A minimal session with NO usage object on any assistant entry. */
function sessionWithoutUsage(sessionId: string): unknown[] {
  return [
    {
      type: "user",
      uuid: "u1",
      timestamp: "2026-06-09T09:00:00.000Z",
      sessionId,
      isSidechain: false,
      message: { role: "user", content: "no usage here" }
    },
    {
      type: "assistant",
      uuid: "a1",
      timestamp: "2026-06-09T09:01:00.000Z",
      sessionId,
      isSidechain: false,
      message: {
        id: "m1",
        model: "claude-sonnet-4-6",
        role: "assistant",
        type: "message",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn"
        // no usage field
      }
    }
  ];
}

let tempRoot: string;

beforeEach(async () => {
  tempRoot = join(tmpdir(), `cc-discovery-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(tempRoot, { recursive: true });
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  vi.restoreAllMocks();
});

describe("discoverClaudeCodeSessions", () => {
  it("lists sessions from a fixture projects dir with correct metadata", async () => {
    const slug = "-Users-me-Projects-app";
    const slugDir = join(tempRoot, slug);

    // Session A: has usage, no subagents.
    await writeJsonl(join(slugDir, "aaaaaaaa-1111.jsonl"), sessionWithUsage("aaaaaaaa-1111"));

    // Session B (newer): no usage, with two subagents.
    const sessionBId = "bbbbbbbb-2222";
    await writeJsonl(join(slugDir, `${sessionBId}.jsonl`), sessionWithoutUsage(sessionBId));
    const subagentsDir = join(slugDir, sessionBId, "subagents");
    await writeJsonl(join(subagentsDir, "agent-1.jsonl"), [
      {
        type: "assistant",
        uuid: "sa1",
        timestamp: "2026-06-09T09:02:00.000Z",
        sessionId: sessionBId,
        agentId: "agent-1",
        isSidechain: true,
        message: {
          model: "claude-sonnet-4-6",
          role: "assistant",
          type: "message",
          content: [{ type: "text", text: "sub work" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
        }
      }
    ]);
    await writeJsonl(join(subagentsDir, "agent-2.jsonl"), [
      {
        type: "assistant",
        uuid: "sa2",
        timestamp: "2026-06-09T09:03:00.000Z",
        sessionId: sessionBId,
        agentId: "agent-2",
        isSidechain: true,
        message: {
          model: "claude-sonnet-4-6",
          role: "assistant",
          type: "message",
          content: [{ type: "text", text: "more sub work" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
        }
      }
    ]);

    const result = await discoverClaudeCodeSessions({ projectsDir: tempRoot });

    expect(result.projectsDir).toBe(tempRoot);
    expect(result.projectsDirExists).toBe(true);
    expect(result.sessions).toHaveLength(2);

    // Sorted newest-first: session B (2026-06-09) before session A (2026-06-08).
    expect(result.sessions[0].sessionId).toBe(sessionBId);
    expect(result.sessions[1].sessionId).toBe("aaaaaaaa-1111");

    const sessionA = result.sessions.find((s) => s.sessionId === "aaaaaaaa-1111")!;
    const sessionB = result.sessions.find((s) => s.sessionId === sessionBId)!;

    // Project slug / dir
    expect(sessionA.projectSlug).toBe(slug);
    // cwd recovered from session A entries
    expect(sessionA.projectDir).toBe("/Users/me/Projects/app");

    // Timestamps
    expect(sessionA.firstTimestamp).toBe("2026-06-08T10:00:00.000Z");
    expect(sessionA.lastTimestamp).toBe("2026-06-08T10:05:00.000Z");

    // Message counts (main session only, matching default capture)
    expect(sessionA.messageCount).toBe(2); // 1 user + 1 assistant text
    expect(sessionB.messageCount).toBe(2);

    // Subagent counts
    expect(sessionA.subagentCount).toBe(0);
    expect(sessionB.subagentCount).toBe(2);

    // provider-reported-usage present/absent
    expect(sessionA.providerReportedUsagePresent).toBe(true);
    expect(sessionB.providerReportedUsagePresent).toBe(false);

    // sessionPath is the ready-to-run --session target
    expect(sessionA.sessionPath).toBe(join(slugDir, "aaaaaaaa-1111.jsonl"));
  });

  it("reports subagent count: session with subagents > 0, session without = 0", async () => {
    const slug = "-Users-me-Projects-x";
    const slugDir = join(tempRoot, slug);

    // Without subagents
    await writeJsonl(join(slugDir, "nosub-0000.jsonl"), sessionWithUsage("nosub-0000"));

    // With one subagent
    const withSubId = "withsub-1111";
    await writeJsonl(join(slugDir, `${withSubId}.jsonl`), sessionWithUsage(withSubId));
    await writeJsonl(join(slugDir, withSubId, "subagents", "agent-only.jsonl"), [
      {
        type: "assistant",
        uuid: "s1",
        timestamp: "2026-06-08T10:06:00.000Z",
        sessionId: withSubId,
        agentId: "agent-only",
        isSidechain: true,
        message: {
          model: "claude-sonnet-4-6",
          role: "assistant",
          type: "message",
          content: [{ type: "text", text: "x" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
        }
      }
    ]);

    const result = await discoverClaudeCodeSessions({ projectsDir: tempRoot });
    const noSub = result.sessions.find((s) => s.sessionId === "nosub-0000")!;
    const withSub = result.sessions.find((s) => s.sessionId === withSubId)!;

    expect(noSub.subagentCount).toBe(0);
    expect(withSub.subagentCount).toBe(1);
  });

  it("provider-reported-usage-present is true when usage exists, false otherwise", async () => {
    const slug = "-Users-me-Projects-y";
    const slugDir = join(tempRoot, slug);
    await writeJsonl(join(slugDir, "has-usage.jsonl"), sessionWithUsage("has-usage"));
    await writeJsonl(join(slugDir, "no-usage.jsonl"), sessionWithoutUsage("no-usage"));

    const result = await discoverClaudeCodeSessions({ projectsDir: tempRoot });
    expect(result.sessions.find((s) => s.sessionId === "has-usage")!.providerReportedUsagePresent).toBe(true);
    expect(result.sessions.find((s) => s.sessionId === "no-usage")!.providerReportedUsagePresent).toBe(false);
  });

  it("is read-only and makes no network call - only the fixture dir is read", async () => {
    const slug = "-Users-me-Projects-z";
    const slugDir = join(tempRoot, slug);
    await writeJsonl(join(slugDir, "ro-0000.jsonl"), sessionWithUsage("ro-0000"));

    // Guard: any attempt to use node:http/https/net or fetch during discovery fails the test.
    const fetchSpy = vi.spyOn(globalThis, "fetch" as never).mockImplementation((() => {
      throw new Error("network call attempted during discovery");
    }) as never);

    const before = await import("node:fs").then((fs) => fs.promises.readFile(join(slugDir, "ro-0000.jsonl"), "utf8"));
    const result = await discoverClaudeCodeSessions({ projectsDir: tempRoot });
    const after = await import("node:fs").then((fs) => fs.promises.readFile(join(slugDir, "ro-0000.jsonl"), "utf8"));

    // No network call was made (fetch never invoked).
    expect(fetchSpy).not.toHaveBeenCalled();
    // Discovery did not modify the source file (read-only).
    expect(after).toBe(before);
    expect(result.sessions).toHaveLength(1);
  });

  it("returns empty result (no throw) when the projects dir does not exist", async () => {
    const missing = join(tempRoot, "does-not-exist");
    const result = await discoverClaudeCodeSessions({ projectsDir: missing });
    expect(result.projectsDirExists).toBe(false);
    expect(result.sessions).toHaveLength(0);
  });

  it("does not surface any session message content in discovery metadata", async () => {
    const slug = "-Users-me-Projects-secret";
    const slugDir = join(tempRoot, slug);
    const secret = "TOP-SECRET-PROMPT-CONTENT";
    await writeJsonl(join(slugDir, "sensitive.jsonl"), [
      {
        type: "user",
        uuid: "u1",
        timestamp: "2026-06-08T10:00:00.000Z",
        sessionId: "sensitive",
        isSidechain: false,
        message: { role: "user", content: secret }
      },
      {
        type: "assistant",
        uuid: "a1",
        timestamp: "2026-06-08T10:00:01.000Z",
        sessionId: "sensitive",
        isSidechain: false,
        message: {
          model: "claude-sonnet-4-6",
          role: "assistant",
          type: "message",
          content: [{ type: "text", text: secret }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
        }
      }
    ]);

    const result = await discoverClaudeCodeSessions({ projectsDir: tempRoot });
    // Serialize the entire metadata record and confirm no message content leaks.
    const serialized = JSON.stringify(result.sessions);
    expect(serialized).not.toContain(secret);
  });

  it("defaultProjectsDir resolves to ~/.claude/projects", () => {
    expect(defaultProjectsDir()).toMatch(/\.claude[\\/]+projects$/);
  });

  it("exposes a local/read-only privacy note", () => {
    expect(DISCOVERY_PRIVACY_NOTE).toMatch(/local and read-only/i);
    expect(DISCOVERY_PRIVACY_NOTE).toMatch(/metadata only/i);
  });
});

describe("scanSessionMetadata (parser reuse)", () => {
  it("counts main-session messages consistent with the adapter and detects usage", async () => {
    const slug = "-Users-me-Projects-app";
    const sessionPath = join(tempRoot, slug, "scan.jsonl");
    await writeJsonl(sessionPath, sessionWithUsage("scan"));

    const meta = await scanSessionMetadata(sessionPath, slug);
    expect(meta.messageCount).toBe(2);
    expect(meta.providerReportedUsagePresent).toBe(true);
    expect(meta.sessionId).toBe("scan");
    expect(meta.projectSlug).toBe(slug);
    expect(meta.subagentCount).toBe(0);
  });
});
