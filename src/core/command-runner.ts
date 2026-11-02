import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from "node:child_process";
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
  /** Content-free spawn failure code when the OS could not create the child. */
  spawnErrorCode?: string;
}

export interface PersistedLocalCommandRun {
  run: LocalCommandRun;
  outputDirectory: string;
  stdoutPath: string;
  stderrPath: string;
  rawOutputPath: string;
  metadataPath: string;
}

export interface LocalCommandExecutionOptions {
  cwd?: string;
  /** Exact child environment. Omit to preserve the existing inherited default. */
  env?: NodeJS.ProcessEnv;
  /** Optional stdin bytes. Omit to preserve the existing closed-stdin default. */
  input?: string | Buffer;
  /** Injectable child seam for provider-free execution tests. */
  spawnChild?: (executable: string, args: string[], options: SpawnOptions) => ChildProcessWithoutNullStreams;
  /** Called after caller-side preparation and immediately before child creation. */
  beforeSpawn?: () => void | Promise<void>;
  /** Called synchronously after child creation; useful for a durable child-created marker. */
  onSpawn?: (details: { pid: number | null }) => void;
  /** Private streaming sinks; accumulated return values remain unchanged. */
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
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

export async function executeLocalCommand(
  command: ParsedRunCommand,
  runId = createRunId(),
  options: LocalCommandExecutionOptions = {}
): Promise<LocalCommandRun> {
  const startMs = Date.now();
  const startedAt = new Date(startMs).toISOString();
  let stdout = "";
  let stderr = "";
  let rawOutput = "";

  await options.beforeSpawn?.();

  return new Promise((resolve) => {
    const spawnChild = options.spawnChild ?? ((executable, args, childOptions) => spawn(executable, args, childOptions) as ChildProcessWithoutNullStreams);
    const child = spawnChild(command.executable, command.args, {
      shell: false,
      windowsHide: true,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.env ? { env: options.env } : {}),
      // Capture is non-interactive: give the child a closed (/dev/null) stdin so tools that probe stdin
      // (e.g. `codex exec`, which otherwise blocks "Reading additional input from stdin...") see EOF and
      // proceed with the prompt argument. stdout/stderr stay piped so we can read the event stream.
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"]
    });

    const pid = child.pid ?? null;
    let spawnError: Error | undefined;
    let spawnMarkerError: Error | undefined;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      rawOutput += chunk;
      options.onStdout?.(chunk);
    });

    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      rawOutput += chunk;
      options.onStderr?.(chunk);
    });

    child.on("error", (error) => {
      spawnError = error;
      const errorMessage = stderr.length === 0 ? error.message : `\n${error.message}`;
      stderr += errorMessage;
      rawOutput += errorMessage;
    });

    if (pid !== null) {
      try {
        options.onSpawn?.({ pid });
      } catch (error) {
        spawnMarkerError = error instanceof Error ? error : new Error("post-spawn callback failed");
        child.kill();
      }
    }

    if (options.input !== undefined && pid !== null && !spawnMarkerError) child.stdin.end(options.input);

    child.on("close", (exitCode, signal) => {
      const endMs = Date.now();
      const resolvedExitCode = spawnError || spawnMarkerError ? 127 : exitCode ?? 1;

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
        durationMs: Math.max(0, endMs - startMs),
        ...((spawnError || spawnMarkerError)
          ? { spawnErrorCode: spawnMarkerError ? "post_spawn_callback_failed" : ((spawnError as NodeJS.ErrnoException).code ?? "spawn_failed") }
          : {})
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
        ...(run.spawnErrorCode ? { spawnErrorCode: run.spawnErrorCode } : {}),
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
