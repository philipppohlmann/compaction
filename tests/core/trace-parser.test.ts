import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { parseTraceFile } from "../../src/core/trace-parser.js";

function uniqueTracePath(prefix: string): string {
  const directory = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  return join(directory, "trace.json");
}

async function writeTraceFile(tracePath: string, value: unknown): Promise<void> {
  await mkdir(join(tracePath, ".."), { recursive: true });
  await writeFile(tracePath, JSON.stringify(value), "utf8");
}

describe("trace-parser", () => {
  it("parses a valid local JSON trace file and fills stable trace defaults", async () => {
    const tracePath = uniqueTracePath("compaction-trace-parser");

    await writeTraceFile(tracePath, {
      id: "trace_test",
      title: "Parser test trace",
      createdAt: "2026-01-01T00:00:00.000Z",
      model: "placeholder-agent-model",
      messages: [
        {
          id: "msg_001",
          role: "user",
          timestamp: "2026-01-01T00:00:00.000Z",
          content: "Please inspect this trace."
        }
      ]
    });

    await expect(parseTraceFile(tracePath)).resolves.toMatchObject({
      id: "trace_test",
      title: "Parser test trace",
      artifactVersion: "agent-trace-v1",
      source: "manual",
      createdAt: "2026-01-01T00:00:00.000Z",
      generatedAt: "2026-01-01T00:00:00.000Z",
      model: "placeholder-agent-model",
      messages: [
        {
          id: "msg_001",
          role: "user",
          content: "Please inspect this trace."
        }
      ]
    });
  });

  it("keeps existing demo trace fixtures compatible by applying defaults", async () => {
    const demoTracePaths = [
      "src/examples/demo-coding-trace.json",
      "src/examples/demo-support-trace.json",
      "src/examples/demo-rag-trace.json",
      "src/examples/demo-trace.json"
    ];

    for (const demoTracePath of demoTracePaths) {
      const trace = await parseTraceFile(demoTracePath);

      expect(trace.artifactVersion).toBe("agent-trace-v1");
      expect(trace.source).toBe("manual");
      expect(trace.generatedAt).toBe(trace.createdAt);
      expect(trace.messages.length).toBeGreaterThan(0);
    }
  });

  it("parses CLI wrapper trace metadata with stdout and stderr messages", async () => {
    const tracePath = uniqueTracePath("compaction-cli-wrapper-trace-parser");

    await writeTraceFile(tracePath, {
      id: "trace_cli_wrapper",
      title: "CLI wrapper trace",
      artifact_version: "agent-trace-v1",
      source: "cli_wrapper",
      created_at: "2026-01-01T00:00:00.000Z",
      generated_at: "2026-01-01T00:00:02.000Z",
      model: "local-cli-run",
      command: {
        command: "npm",
        args: ["test"],
        cwd: "/workspace/compaction-dev",
        shell: "bash"
      },
      duration_ms: 2000,
      exit_code: 1,
      messages: [
        {
          id: "msg_stdout",
          role: "stdout",
          timestamp: "2026-01-01T00:00:01.000Z",
          content: "tests/core/example.test.ts passed"
        },
        {
          id: "msg_stderr",
          role: "stderr",
          timestamp: "2026-01-01T00:00:02.000Z",
          content: "one assertion failed"
        }
      ]
    });

    await expect(parseTraceFile(tracePath)).resolves.toMatchObject({
      id: "trace_cli_wrapper",
      artifactVersion: "agent-trace-v1",
      source: "cli_wrapper",
      createdAt: "2026-01-01T00:00:00.000Z",
      generatedAt: "2026-01-01T00:00:02.000Z",
      command: {
        command: "npm",
        args: ["test"],
        cwd: "/workspace/compaction-dev",
        shell: "bash"
      },
      durationMs: 2000,
      exitCode: 1,
      messages: [
        { id: "msg_stdout", role: "stdout" },
        { id: "msg_stderr", role: "stderr" }
      ]
    });
  });

  it("parses a real_captured trace without requiring command metadata", async () => {
    const tracePath = uniqueTracePath("compaction-trace-parser-real-captured");

    await writeTraceFile(tracePath, {
      id: "trace_real_captured",
      title: "Real captured trace",
      source: "real_captured",
      createdAt: "2026-01-01T00:00:00.000Z",
      model: "claude-3-5-sonnet",
      messages: [
        {
          id: "msg_001",
          role: "user",
          timestamp: "2026-01-01T00:00:00.000Z",
          content: "Real agent task."
        }
      ]
    });

    await expect(parseTraceFile(tracePath)).resolves.toMatchObject({
      id: "trace_real_captured",
      source: "real_captured",
      model: "claude-3-5-sonnet"
    });
  });

  it("rejects traces with invalid message roles", async () => {
    const tracePath = uniqueTracePath("compaction-trace-parser-invalid");

    await writeTraceFile(tracePath, {
      id: "trace_invalid",
      title: "Invalid parser test trace",
      createdAt: "2026-01-01T00:00:00.000Z",
      model: "placeholder-agent-model",
      messages: [
        {
          id: "msg_001",
          role: "invalid-role",
          timestamp: "2026-01-01T00:00:00.000Z",
          content: "This role should fail validation."
        }
      ]
    });

    await expect(parseTraceFile(tracePath)).rejects.toThrow();
  });

  it("rejects CLI wrapper traces missing command metadata", async () => {
    const tracePath = uniqueTracePath("compaction-trace-parser-missing-command");

    await writeTraceFile(tracePath, {
      id: "trace_missing_command",
      title: "Missing command metadata",
      source: "cli_wrapper",
      createdAt: "2026-01-01T00:00:00.000Z",
      model: "local-cli-run",
      durationMs: 10,
      exitCode: 0,
      messages: []
    });

    await expect(parseTraceFile(tracePath)).rejects.toThrow(/command metadata/);
  });

  it("rejects inconsistent created_at and generated_at values", async () => {
    const tracePath = uniqueTracePath("compaction-trace-parser-inconsistent-times");

    await writeTraceFile(tracePath, {
      id: "trace_inconsistent_times",
      title: "Inconsistent timestamps",
      createdAt: "2026-01-01T00:00:02.000Z",
      generatedAt: "2026-01-01T00:00:01.000Z",
      model: "placeholder-agent-model",
      messages: []
    });

    await expect(parseTraceFile(tracePath)).rejects.toThrow(/generatedAt/);
  });

  it("rejects invalid command outcome metadata", async () => {
    const tracePath = uniqueTracePath("compaction-trace-parser-invalid-outcome");

    await writeTraceFile(tracePath, {
      id: "trace_invalid_outcome",
      title: "Invalid command outcome",
      source: "cli_wrapper",
      createdAt: "2026-01-01T00:00:00.000Z",
      model: "local-cli-run",
      command: { command: "npm", args: ["test"] },
      durationMs: -1,
      exitCode: 256,
      messages: []
    });

    await expect(parseTraceFile(tracePath)).rejects.toThrow();
  });
});
