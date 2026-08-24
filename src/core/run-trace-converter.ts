import type { AgentTrace, TraceMessage } from "./types.js";
import type { LocalCommandRun } from "./command-runner.js";
import { CURRENT_AGENT_TRACE_ARTIFACT_VERSION } from "./trace-parser.js";

const LOCAL_RUN_MODEL = "local-command-runner";

interface OutputLine {
  content: string;
  lineNumber: number;
}

function compactPreview(value: string): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized;
}

function createMessage(id: string, role: TraceMessage["role"], timestamp: string, content: string): TraceMessage {
  return { id, role, timestamp, content };
}

function outputLines(value: string): OutputLine[] {
  return value
    .split(/\r?\n/)
    .map((content, index) => ({ content, lineNumber: index + 1 }))
    .filter((line) => line.content.length > 0);
}

function nextMessageId(index: number): string {
  return `msg_${index.toString().padStart(3, "0")}`;
}

export function localCommandRunToAgentTrace(run: LocalCommandRun): AgentTrace {
  const commandLine = [run.command.executable, ...run.command.args].join(" ");
  const messages: TraceMessage[] = [
    createMessage(
      "msg_001",
      "system",
      run.startedAt,
      "Local compaction.dev command run. Environment variables are not captured, output is stored locally, and no upload is performed."
    ),
    createMessage("msg_002", "user", run.startedAt, `Run local command: ${commandLine}`)
  ];
  let nextIndex = 3;

  for (const line of outputLines(run.stdout)) {
    messages.push({
      id: nextMessageId(nextIndex),
      role: "tool",
      toolName: "stdout.line",
      timestamp: run.endedAt,
      content: line.content,
      metadata: {
        stream: "stdout",
        lineNumber: line.lineNumber,
        byteLength: Buffer.byteLength(line.content, "utf8")
      }
    });
    nextIndex += 1;
  }

  for (const line of outputLines(run.stderr)) {
    messages.push({
      id: nextMessageId(nextIndex),
      role: "tool",
      toolName: "stderr.line",
      timestamp: run.endedAt,
      content: line.content,
      metadata: {
        stream: "stderr",
        lineNumber: line.lineNumber,
        byteLength: Buffer.byteLength(line.content, "utf8")
      }
    });
    nextIndex += 1;
  }

  const status = run.exitCode === 0 ? "succeeded" : "finished with a non-zero exit status";
  const stdoutSummary = run.stdout.length === 0 ? "stdout was empty" : `stdout preview: ${compactPreview(run.stdout)}`;
  const stderrSummary = run.stderr.length === 0 ? "stderr was empty" : `stderr preview: ${compactPreview(run.stderr)}`;

  messages.push({
    id: nextMessageId(nextIndex),
    role: "assistant",
    timestamp: run.endedAt,
    content: `Command ${status}. Exit code: ${run.exitCode ?? "none"}. Signal: ${run.signal ?? "none"}. Duration: ${run.durationMs} ms. ${stdoutSummary}. ${stderrSummary}.`,
    metadata: {
      exitCode: run.exitCode,
      signal: run.signal,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      durationMs: run.durationMs,
      pid: run.pid,
      stdoutBytes: Buffer.byteLength(run.stdout, "utf8"),
      stderrBytes: Buffer.byteLength(run.stderr, "utf8"),
      rawOutputBytes: Buffer.byteLength(run.rawOutput, "utf8")
    }
  });

  return {
    id: `trace_${run.runId}`,
    title: `Local command run: ${run.command.executable}`,
    artifactVersion: CURRENT_AGENT_TRACE_ARTIFACT_VERSION,
    source: "local_command",
    createdAt: run.startedAt,
    generatedAt: run.endedAt,
    model: LOCAL_RUN_MODEL,
    command: {
      command: run.command.executable,
      args: run.command.args,
      cwd: process.cwd()
    },
    durationMs: run.durationMs,
    exitCode: run.exitCode,
    messages
  };
}
