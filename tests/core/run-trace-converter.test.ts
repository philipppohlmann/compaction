import { describe, expect, it } from "vitest";
import { localCommandRunToAgentTrace } from "../../src/core/run-trace-converter.js";
import { agentTraceSchema } from "../../src/core/trace-parser.js";
import type { LocalCommandRun } from "../../src/core/command-runner.js";

const run: LocalCommandRun = {
  runId: "run_test",
  command: {
    executable: "echo",
    args: ["hello"]
  },
  stdout: "hello\n",
  stderr: "",
  rawOutput: "hello\n",
  exitCode: 0,
  signal: null,
  pid: 123,
  startedAt: "2026-01-01T00:00:00.000Z",
  endedAt: "2026-01-01T00:00:01.000Z",
  durationMs: 1000
};

describe("run-trace-converter", () => {
  it("converts a captured local command run into an AgentTrace", () => {
    const trace = localCommandRunToAgentTrace(run);

    expect(() => agentTraceSchema.parse(trace)).not.toThrow();
    expect(trace).toMatchObject({
      id: "trace_run_test",
      title: "Local command run: echo",
      artifactVersion: "agent-trace-v1",
      source: "local_command",
      createdAt: "2026-01-01T00:00:00.000Z",
      generatedAt: "2026-01-01T00:00:01.000Z",
      model: "local-command-runner",
      command: {
        command: "echo",
        args: ["hello"]
      },
      durationMs: 1000,
      exitCode: 0,
      messages: [
        {
          id: "msg_001",
          role: "system"
        },
        {
          id: "msg_002",
          role: "user",
          content: "Run local command: echo hello"
        },
        {
          id: "msg_003",
          role: "tool",
          toolName: "stdout.line",
          content: "hello",
          metadata: {
            stream: "stdout",
            lineNumber: 1,
            byteLength: 5
          }
        },
        {
          id: "msg_004",
          role: "assistant",
          metadata: {
            exitCode: 0,
            signal: null,
            startedAt: "2026-01-01T00:00:00.000Z",
            endedAt: "2026-01-01T00:00:01.000Z",
            durationMs: 1000,
            pid: 123,
            stdoutBytes: 6,
            stderrBytes: 0,
            rawOutputBytes: 6
          }
        }
      ]
    });
  });

  it("includes stderr as tool messages when present", () => {
    const trace = localCommandRunToAgentTrace({ ...run, stdout: "", stderr: "warning\n", rawOutput: "warning\n", exitCode: 1 });

    expect(trace.messages).toContainEqual(
      expect.objectContaining({
        id: "msg_003",
        role: "tool",
        toolName: "stderr.line",
        content: "warning"
      })
    );
    expect(trace.messages.at(-1)).toMatchObject({
      role: "assistant",
      metadata: {
        exitCode: 1
      }
    });
  });

  it("emits repeated stdout lines as separate compactable tool messages", () => {
    const trace = localCommandRunToAgentTrace({ ...run, stdout: "same\nsame\n", rawOutput: "same\nsame\n" });

    expect(trace.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "msg_003", toolName: "stdout.line", content: "same" }),
        expect.objectContaining({ id: "msg_004", toolName: "stdout.line", content: "same" })
      ])
    );
  });
});
