/**
 * Stable, content-free identity for one exact Claude user run.
 *
 * The session correlation is already a device-local keyed digest. Hashing it together with the
 * validated run ordinal and start instant gives cumulative Claude Stop snapshots one stable key
 * without persisting the raw session id, prompt id, transcript path, or any transcript content.
 */
import { createHash } from "node:crypto";
import { validCorrelationId } from "./gateway/session-correlation.js";

export const CLAUDE_LOGICAL_RUN_ID_PATTERN = /^claude-stop-[0-9a-f]{32}$/;
export const CLAUDE_LOGICAL_SESSION_ID_PATTERN = /^claude-session-[0-9a-f]{32}$/;

export interface ClaudeLogicalRunSource {
  session_correlation_id: string;
  run_seq: number;
  started_at: string;
}

export interface ClaudeLogicalRunIdentity {
  runId: string;
  sessionId: string;
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

export function validClaudeLogicalRunId(value: unknown): value is string {
  return typeof value === "string" && CLAUDE_LOGICAL_RUN_ID_PATTERN.test(value);
}

export function validClaudeLogicalSessionId(value: unknown): value is string {
  return typeof value === "string" && CLAUDE_LOGICAL_SESSION_ID_PATTERN.test(value);
}

export function claudeLogicalSessionId(sessionCorrelationId: string): string | undefined {
  return validCorrelationId(sessionCorrelationId)
    ? `claude-session-${sessionCorrelationId}`
    : undefined;
}

/** Only an exact run returned by the run store should be passed here. Invalid input yields no id. */
export function claudeLogicalRunIdentity(run: ClaudeLogicalRunSource): ClaudeLogicalRunIdentity | undefined {
  if (
    !validCorrelationId(run.session_correlation_id) ||
    !Number.isSafeInteger(run.run_seq) ||
    run.run_seq < 1 ||
    !canonicalTimestamp(run.started_at)
  ) return undefined;

  const digest = createHash("sha256")
    .update("compaction|claude-logical-stop|v1\0")
    .update(`${run.session_correlation_id.length}:${run.session_correlation_id}\0`)
    .update(`${run.run_seq}\0`)
    .update(`${run.started_at.length}:${run.started_at}`)
    .digest("hex")
    .slice(0, 32);
  return {
    runId: `claude-stop-${digest}`,
    sessionId: `claude-session-${run.session_correlation_id}`
  };
}
