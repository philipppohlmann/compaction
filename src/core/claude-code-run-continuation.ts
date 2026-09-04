import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import type { ConfigDirEnv } from "./config-dir.js";
import { claudePromptCorrelationId, validCorrelationId } from "./gateway/session-correlation.js";

const TRANSCRIPT_TAIL_BYTES = 256 * 1024;
const TRANSCRIPT_TAIL_LINES = 200;

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

interface HookTranscriptIdentity {
  sessionId: string;
  transcriptPath: string;
}

function hookTranscriptIdentity(stdinText: string): HookTranscriptIdentity | undefined {
  try {
    const payload = objectRecord(JSON.parse(stdinText));
    if (!payload) return undefined;
    if (
      payload.hook_event_name !== undefined &&
      payload.hook_event_name !== "UserPromptSubmit" &&
      payload.hook_event_name !== "Stop"
    ) return undefined;
    if (
      typeof payload.session_id !== "string" ||
      payload.session_id.length === 0 ||
      payload.session_id.length > 512 ||
      typeof payload.transcript_path !== "string" ||
      payload.transcript_path.trim() === ""
    ) return undefined;
    return { sessionId: payload.session_id, transcriptPath: payload.transcript_path };
  } catch {
    return undefined;
  }
}

async function transcriptTail(path: string): Promise<string[] | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink()) return undefined;
    const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
    handle = await open(path, constants.O_RDONLY | noFollow | constants.O_NONBLOCK);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) return undefined;

    const length = Math.min(opened.size, TRANSCRIPT_TAIL_BYTES);
    if (length === 0) return [];
    const start = opened.size - length;
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    let text = buffer.subarray(0, bytesRead).toString("utf8");
    if (start > 0) {
      const firstNewline = text.indexOf("\n");
      if (firstNewline < 0) return [];
      text = text.slice(firstNewline + 1);
    }
    const complete = text.endsWith("\n") ? text : text.slice(0, text.lastIndexOf("\n") + 1);
    return complete.split("\n").filter((line) => line.trim() !== "").slice(-TRANSCRIPT_TAIL_LINES);
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Positive-only proof for an already-persisted provisional identity. The hook payload supplies only
 * an in-memory session/path; the store supplies only a keyed digest. Text, timing, and agent fields
 * are deliberately irrelevant.
 */
export async function hasClaudeTaskNotificationEvidence(
  stdinText: string,
  expectedPromptCorrelationId: string,
  env: ConfigDirEnv = process.env
): Promise<boolean> {
  if (!validCorrelationId(expectedPromptCorrelationId)) return false;
  const hook = hookTranscriptIdentity(stdinText);
  if (!hook) return false;
  const lines = await transcriptTail(hook.transcriptPath);
  if (!lines) return false;

  let matches = 0;
  for (const line of lines) {
    let row: Record<string, unknown> | undefined;
    try {
      row = objectRecord(JSON.parse(line));
    } catch {
      return false;
    }
    if (!row) return false;
    if (typeof row.sessionId !== "string" || typeof row.promptId !== "string") continue;
    if (row.sessionId !== hook.sessionId) continue;
    const correlation = claudePromptCorrelationId(row.sessionId, row.promptId, env);
    if (correlation !== expectedPromptCorrelationId) continue;
    const origin = objectRecord(row.origin);
    if (
      row.type === "user" &&
      row.isSidechain === false &&
      origin !== undefined &&
      Object.keys(origin).length === 1 &&
      origin.kind === "task-notification"
    ) matches += 1;
  }
  return matches === 1;
}
