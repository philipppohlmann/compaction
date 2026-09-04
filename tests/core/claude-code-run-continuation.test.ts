import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hasClaudeTaskNotificationEvidence } from "../../src/core/claude-code-run-continuation.js";
import { claudePromptCorrelationId } from "../../src/core/gateway/session-correlation.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture(lines: unknown[], trailingNewline = true): Promise<{
  dir: string;
  env: NodeJS.ProcessEnv;
  transcript: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), "claude-provisional-evidence-"));
  dirs.push(dir);
  const transcript = join(dir, "session.jsonl");
  await writeFile(
    transcript,
    `${lines.map((line) => typeof line === "string" ? line : JSON.stringify(line)).join("\n")}${trailingNewline ? "\n" : ""}`,
    "utf8"
  );
  return { dir, transcript, env: { COMPACTION_CONFIG_DIR: join(dir, "config") } };
}

const SESSION = "parent-session";
const PROMPT = "prompt-task-1";

function payload(transcript: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    hook_event_name: "Stop",
    session_id: SESSION,
    transcript_path: transcript,
    ...overrides
  });
}

function notification(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "user",
    sessionId: SESSION,
    // Claude Code 2.1.259 emits both fields on the structured row. The hook payload's `prompt_id`
    // matches this camelCase promptId exactly; `uuid` is a distinct transcript-row identity.
    promptId: PROMPT,
    uuid: "task-notification-row-uuid",
    isSidechain: false,
    origin: { kind: "task-notification" },
    message: { role: "user", content: "sensitive bytes are never returned or persisted" },
    ...overrides
  };
}

function toolResult(uuid: string): Record<string, unknown> {
  return {
    type: "user",
    sessionId: SESSION,
    promptId: PROMPT,
    uuid,
    isSidechain: false,
    origin: null,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "synthetic", content: "not inspected" }]
    }
  };
}

describe("Claude Code provisional transcript evidence", () => {
  it("accepts exactly one structured main-thread task-notification row", async () => {
    const f = await fixture([{ type: "assistant" }, notification()]);
    const digest = claudePromptCorrelationId(SESSION, PROMPT, f.env)!;
    expect(await hasClaudeTaskNotificationEvidence(payload(f.transcript), digest, f.env)).toBe(true);
  });

  it("accepts one positive row beside later same-identity tool-result rows from the real vendor shape", async () => {
    const f = await fixture([
      notification(),
      toolResult("later-tool-result-1"),
      toolResult("later-tool-result-2")
    ]);
    const digest = claudePromptCorrelationId(SESSION, PROMPT, f.env)!;
    expect(await hasClaudeTaskNotificationEvidence(payload(f.transcript), digest, f.env)).toBe(true);
  });

  it("does not inspect or infer from agent_id", async () => {
    const f = await fixture([notification()]);
    const digest = claudePromptCorrelationId(SESSION, PROMPT, f.env)!;
    expect(await hasClaudeTaskNotificationEvidence(
      payload(f.transcript, { hook_event_name: "UserPromptSubmit", agent_id: "arbitrary" }),
      digest,
      f.env
    )).toBe(true);
  });

  it("binds hook prompt_id to transcript promptId, never the distinct row uuid", async () => {
    const actualShape = await fixture([notification()]);
    const promptDigest = claudePromptCorrelationId(SESSION, PROMPT, actualShape.env)!;
    expect(await hasClaudeTaskNotificationEvidence(payload(actualShape.transcript), promptDigest, actualShape.env)).toBe(true);

    const uuidOnly = await fixture([notification({ promptId: undefined, uuid: PROMPT })]);
    const uuidDigest = claudePromptCorrelationId(SESSION, PROMPT, uuidOnly.env)!;
    expect(await hasClaudeTaskNotificationEvidence(payload(uuidOnly.transcript), uuidDigest, uuidOnly.env)).toBe(false);

    const conflicting = await fixture([notification({ promptId: "foreign-prompt", uuid: PROMPT })]);
    const conflictingDigest = claudePromptCorrelationId(SESSION, PROMPT, conflicting.env)!;
    expect(await hasClaudeTaskNotificationEvidence(payload(conflicting.transcript), conflictingDigest, conflicting.env)).toBe(false);
  });

  it.each([
    ["wrong type", { type: "assistant" }],
    ["missing sidechain marker", { isSidechain: undefined }],
    ["sidechain", { isSidechain: true }],
    ["wrong session", { sessionId: "foreign-session" }],
    ["wrong prompt", { promptId: "other-prompt" }],
    ["origin scalar", { origin: "task-notification" }],
    ["origin null", { origin: null }],
    ["wrong origin", { origin: { kind: "human" } }],
    ["non-exact origin", { origin: { kind: "task-notification", extra: true } }],
    ["text heuristic only", { origin: undefined, message: { content: "<task-notification>done</task-notification>" } }]
  ])("rejects %s", async (_label, overrides) => {
    const f = await fixture([notification(overrides)]);
    const digest = claudePromptCorrelationId(SESSION, PROMPT, f.env)!;
    expect(await hasClaudeTaskNotificationEvidence(payload(f.transcript), digest, f.env)).toBe(false);
  });

  it("rejects absent and duplicate matching rows", async () => {
    const absent = await fixture([{ type: "assistant" }]);
    const absentDigest = claudePromptCorrelationId(SESSION, PROMPT, absent.env)!;
    expect(await hasClaudeTaskNotificationEvidence(payload(absent.transcript), absentDigest, absent.env)).toBe(false);

    const duplicate = await fixture([notification(), notification()]);
    const duplicateDigest = claudePromptCorrelationId(SESSION, PROMPT, duplicate.env)!;
    expect(await hasClaudeTaskNotificationEvidence(payload(duplicate.transcript), duplicateDigest, duplicate.env)).toBe(false);
  });

  it("rejects malformed, unreadable, non-regular, symlink, and truncated evidence", async () => {
    const malformed = await fixture([notification(), "{not-json"]);
    const digest = claudePromptCorrelationId(SESSION, PROMPT, malformed.env)!;
    expect(await hasClaudeTaskNotificationEvidence(payload(malformed.transcript), digest, malformed.env)).toBe(false);

    const missing = join(malformed.dir, "missing.jsonl");
    expect(await hasClaudeTaskNotificationEvidence(payload(missing), digest, malformed.env)).toBe(false);

    const directory = join(malformed.dir, "directory");
    await mkdir(directory);
    expect(await hasClaudeTaskNotificationEvidence(payload(directory), digest, malformed.env)).toBe(false);

    const link = join(malformed.dir, "linked.jsonl");
    await symlink(malformed.transcript, link);
    expect(await hasClaudeTaskNotificationEvidence(payload(link), digest, malformed.env)).toBe(false);

    const unreadable = join(malformed.dir, "unreadable.jsonl");
    await writeFile(unreadable, "{not-json\n", "utf8");
    await chmod(unreadable, 0o000);
    expect(await hasClaudeTaskNotificationEvidence(payload(unreadable), digest, malformed.env)).toBe(false);

    const truncated = await fixture([notification(), "{\"type\":\"user\""], false);
    const truncatedDigest = claudePromptCorrelationId(SESSION, PROMPT, truncated.env)!;
    expect(await hasClaudeTaskNotificationEvidence(payload(truncated.transcript), truncatedDigest, truncated.env)).toBe(true);
  });

  it("does not scan beyond the bounded tail", async () => {
    const f = await fixture([notification(), { type: "assistant", padding: "x".repeat(300 * 1024) }]);
    const digest = claudePromptCorrelationId(SESSION, PROMPT, f.env)!;
    expect(await hasClaudeTaskNotificationEvidence(payload(f.transcript), digest, f.env)).toBe(false);
  });

  it("binds exact session and prompt bytes with a domain-separated device-local digest", async () => {
    const f = await fixture([notification()]);
    const digest = claudePromptCorrelationId(SESSION, PROMPT, f.env)!;
    expect(digest).toMatch(/^[0-9a-f]{32}$/);
    expect(claudePromptCorrelationId(` ${SESSION}`, PROMPT, f.env)).not.toBe(digest);
    expect(claudePromptCorrelationId(SESSION, `${PROMPT} `, f.env)).not.toBe(digest);
    expect(await hasClaudeTaskNotificationEvidence(payload(f.transcript, { session_id: ` ${SESSION}` }), digest, f.env)).toBe(false);
  });
});
