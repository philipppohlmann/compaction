import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const pkgVersion: string = createRequire(import.meta.url)("../../package.json").version;

const exec = promisify(execFile);
const CLI = path.resolve("dist/cli/index.js");

/**
 * Bare `compaction` is the onboarding entry point: with no subcommand it runs the SAME
 * onboarding as `compaction init` (the Ink stepper on a real TTY; the byte-stable static
 * screen everywhere else, including here where stdio is piped). These tests pin the whole
 * top-level dispatch contract around that default:
 *
 *   - bare `compaction` (non-TTY) → the static onboarding screen, exit 0, no hang;
 *   - `--help` / `--version` stay commander surfaces (never onboarding);
 *   - real subcommands still dispatch normally;
 *   - a mistyped subcommand still fails as an unknown command (exit 1), the default-command
 *     mechanism must not swallow typos into an exit-0 onboarding screen;
 *   - explicit `compaction init <extra>` keeps ignoring stray operands;
 *   - top-level init flags (`compaction --static`) keep forwarding to init.
 *
 * All child processes are spawned async (promisified execFile, never spawnSync) with an
 * explicit timeout, so a regression that hangs waiting for a TTY fails fast instead of
 * deadlocking the runner. HOME and cwd are pinned to a tmpdir so detection is hermetic and
 * nothing leaks into the developer's real ~/.claude or repo.
 */

interface ExecFailure {
  code?: number;
  stdout?: string;
  stderr?: string;
}

let home: string;

beforeAll(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "bare-compaction-"));
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function run(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return exec("node", [CLI, ...args], {
    cwd: home,
    env: { ...process.env, HOME: home },
    timeout: 30_000
  });
}

/** Run expecting a non-zero exit; resolves with the failure, fails the test on success. */
async function runExpectingFailure(args: string[]): Promise<ExecFailure> {
  try {
    await run(args);
  } catch (error) {
    return error as ExecFailure;
  }
  throw new Error(`expected \`compaction ${args.join(" ")}\` to exit non-zero`);
}

describe("bare `compaction` - onboarding as the default command", () => {
  it("bare `compaction` in a non-TTY prints the static onboarding screen and exits 0", async () => {
    const { stdout } = await run([]);
    expect(stdout).toContain("C O M P A C T I O N");
    expect(stdout).toContain("Found on this machine:");
    expect(stdout).toContain("Enable Compaction for:");
    // Onboarding, not help.
    expect(stdout).not.toContain("Usage: compaction");
  });

  it("bare `compaction` output is byte-identical to `compaction init` in the same environment", async () => {
    const bare = await run([]);
    const explicit = await run(["init"]);
    expect(bare.stdout).toBe(explicit.stdout);
  });

  it("`compaction --help` still prints help (with the brand mark), never the onboarding screen", async () => {
    const { stdout } = await run(["--help"]);
    expect(stdout).toContain("Usage: compaction [options] [command]");
    expect(stdout).toContain("init");
    expect(stdout).not.toContain("Found on this machine:");
  });

  it("`compaction --version` still prints the version only", async () => {
    const { stdout } = await run(["--version"]);
    expect(stdout.trim()).toBe(pkgVersion);
  });

  it("a real subcommand still dispatches normally", async () => {
    const { stdout } = await run(["analyze", "--help"]);
    expect(stdout).toContain("Usage: compaction analyze");
    expect(stdout).not.toContain("Found on this machine:");
  });

  it("a mistyped subcommand errors as an unknown command (exit 1), never the onboarding screen", async () => {
    const failure = await runExpectingFailure(["definitely-not-a-command"]);
    expect(failure.code).toBe(1);
    expect(String(failure.stderr)).toContain("unknown command 'definitely-not-a-command'");
    expect(String(failure.stdout)).not.toContain("C O M P A C T I O N");
  });

  it("a near-miss typo keeps commander's suggestion", async () => {
    const failure = await runExpectingFailure(["statu"]);
    expect(failure.code).toBe(1);
    expect(String(failure.stderr)).toContain("unknown command 'statu'");
    expect(String(failure.stderr)).toContain("(Did you mean status?)");
  });

  it("explicit `compaction init <extra>` keeps ignoring stray operands (exit 0, onboarding)", async () => {
    const { stdout } = await run(["init", "leftover-operand"]);
    expect(stdout).toContain("C O M P A C T I O N");
    expect(stdout).toContain("Found on this machine:");
  });

  it("top-level init flags still forward to init (`compaction --static`)", async () => {
    const { stdout } = await run(["--static"]);
    expect(stdout).toContain("C O M P A C T I O N");
    expect(stdout).toContain("Found on this machine:");
  });
});
