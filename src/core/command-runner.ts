import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export interface ParsedRunCommand {
  executable: string;
  args: string[];
}

export interface LocalCommandRun {
  runId: string;
  command: ParsedRunCommand;
  stdout: string;
  stderr: string;
  rawOutput: string;
  exitCode: number;
  signal: NodeJS.Signals | null;
  pid: number | null;
  startedAt: string;
  endedAt: string;
  durationMs: number;
}

export interface PersistedLocalCommandRun {
  run: LocalCommandRun;
  outputDirectory: string;
  stdoutPath: string;
  stderrPath: string;
  rawOutputPath: string;
  metadataPath: string;
}

export function parseRunCommand(commandParts: string[]): ParsedRunCommand {
  const [executable, ...args] = commandParts;

  if (!executable) {
    throw new Error("Usage: compaction run -- <command> [args...]");
  }

  return { executable, args };
}

export function createRunId(now: Date = new Date()): string {
  const timestamp = now.toISOString().replace(/[:.]/g, "-");
  return `run-${timestamp}-${randomUUID().slice(0, 8)}`;
}

export async function executeLocalCommand(command: ParsedRunCommand, runId = createRunId()): Promise<LocalCommandRun> {
  const startMs = Date.now();
  const startedAt = new Date(startMs).toISOString();
  let stdout = "";
  let stderr = "";
  let rawOutput = "";

  return new Promise((resolve) => {
    const child = spawn(command.executable, command.args, {
      shell: false,
      windowsHide: true,
      // Capture is non-interactive: give the child a closed (/dev/null) stdin so tools that probe stdin
      // (e.g. `codex exec`, which otherwise blocks "Reading additional input from stdin...") see EOF and
      // proceed with the prompt argument. stdout/stderr stay piped so we can read the event stream.
      stdio: ["ignore", "pipe", "pipe"]
    });

    const pid = child.pid ?? null;
    let spawnError: Error | undefined;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      rawOutput += chunk;
    });

    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      rawOutput += chunk;
    });

    child.on("error", (error) => {
      spawnError = error;
      const errorMessage = stderr.length === 0 ? error.message : `\n${error.message}`;
      stderr += errorMessage;
      rawOutput += errorMessage;
    });

    child.on("close", (exitCode, signal) => {
      const endMs = Date.now();
      const resolvedExitCode = spawnError ? 127 : exitCode ?? 1;

      resolve({
        runId,
        command,
        stdout,
        stderr,
        rawOutput,
        exitCode: resolvedExitCode,
        signal,
        pid,
        startedAt,
        endedAt: new Date(endMs).toISOString(),
        durationMs: Math.max(0, endMs - startMs)
      });
    });
  });
}

export async function persistLocalCommandRun(
  run: LocalCommandRun,
  runsRoot = path.join(".compaction", "runs")
): Promise<PersistedLocalCommandRun> {
  const outputDirectory = path.join(runsRoot, run.runId);
  const stdoutPath = path.join(outputDirectory, "stdout.txt");
  const stderrPath = path.join(outputDirectory, "stderr.txt");
  const rawOutputPath = path.join(outputDirectory, "raw-output.txt");
  const metadataPath = path.join(outputDirectory, "metadata.json");

  await mkdir(outputDirectory, { recursive: true });
  await writeFile(stdoutPath, run.stdout, "utf8");
  await writeFile(stderrPath, run.stderr, "utf8");
  await writeFile(rawOutputPath, run.rawOutput, "utf8");
  await writeFile(
    metadataPath,
    `${JSON.stringify(
      {
        runId: run.runId,
        command: run.command,
        exitCode: run.exitCode,
        signal: run.signal,
        pid: run.pid,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        durationMs: run.durationMs,
        stdoutBytes: Buffer.byteLength(run.stdout, "utf8"),
        stderrBytes: Buffer.byteLength(run.stderr, "utf8"),
        rawOutputBytes: Buffer.byteLength(run.rawOutput, "utf8")
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  return {
    run,
    outputDirectory,
    stdoutPath,
    stderrPath,
    rawOutputPath,
    metadataPath
  };
}
