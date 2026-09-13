import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const execFileAsync = promisify(execFile);
const TSX = path.resolve("node_modules/.bin/tsx");
const CLI_ENTRY = path.resolve("src/cli/index.ts");
const NODE_DIR = path.dirname(process.execPath);

let root: string;
let realBinDir: string;
let home: string;
let compactionHome: string;
let shimDir: string;

function baseEnv(pathValue: string): NodeJS.ProcessEnv {
  return { HOME: home, COMPACTION_HOME: compactionHome, PATH: pathValue, NO_COLOR: "1" };
}

async function runInit(args: string[], pathValue: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(TSX, [CLI_ENTRY, ...args], { env: baseEnv(pathValue) });
    return stdout;
  } catch (error) {
    // init exits non-zero only on verify-failed; still capture stdout for assertions.
    return (error as { stdout?: string }).stdout ?? "";
  }
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "init-connect-"));
  realBinDir = path.join(root, "realbin");
  home = path.join(root, "home");
  compactionHome = path.join(home, ".compaction");
  shimDir = path.join(compactionHome, "shims");
  mkdirSync(realBinDir, { recursive: true });
  mkdirSync(home, { recursive: true });
  const codex = path.join(realBinDir, "codex");
  writeFileSync(codex, "#!/usr/bin/env bash\necho real\n", "utf8");
  chmodSync(codex, 0o755);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("init --connect 2 (Codex shim) claims-honesty at the CLI surface", () => {
  it("with the shim dir NOT on PATH: installs the shim AND sets up PATH by default (no second command left to run)", async () => {
    const runPath = `${realBinDir}${path.delimiter}${NODE_DIR}${path.delimiter}/usr/bin${path.delimiter}/bin`;
    const out = await runInit(["init", "--connect", "2", "--static"], runPath);
    // PROPERTIES FIRST (a string pin that fails ahead of these would leave them untested): the enable
    // both installed the shim and wrote the PATH line that activates it. On a genuinely fresh machine
    // this is the only status a first install can reach, so it has to be a completed set-up.
    expect(existsSync(path.join(shimDir, "codex"))).toBe(true);
    const rcPath = path.join(home, ".bashrc"); // SHELL unset in baseEnv → bashrc
    expect(existsSync(rcPath)).toBe(true);
    expect(readFileSync(rcPath, "utf8")).toContain(".compaction/shims");
    // Nothing further for the user to RUN. A `compaction …` command in the output here would be a
    // hidden second set-up step; opening a new shell is the only thing left, and it is not a command.
    expect(out).not.toContain("compaction init --connect 2\n");
  });

  it("PATH-pending Codex still never claims this shell is active or connected", async () => {
    const runPath = `${realBinDir}${path.delimiter}${NODE_DIR}${path.delimiter}/usr/bin${path.delimiter}/bin`;
    const out = await runInit(["init", "--connect", "2", "--static"], runPath);
    // The success sentences stay reserved for a resolve-verified shim.
    expect(out).not.toContain("is now active for Codex");
    expect(out).not.toContain("- connected");
    expect(out).toContain("installed; active in new shells");
    expect(out).toContain('export PATH="$HOME/.compaction/shims:$PATH"');
  });

  it("--no-write-shell-config leaves the shell config untouched and prints the one manual line", async () => {
    const runPath = `${realBinDir}${path.delimiter}${NODE_DIR}${path.delimiter}/usr/bin${path.delimiter}/bin`;
    const out = await runInit(["init", "--connect", "2", "--static", "--no-write-shell-config"], runPath);
    expect(existsSync(path.join(shimDir, "codex"))).toBe(true);
    expect(existsSync(path.join(home, ".bashrc"))).toBe(false);
    expect(existsSync(path.join(home, ".zshrc"))).toBe(false);
    expect(out).toContain("NOT yet active");
    expect(out).toContain('export PATH="$HOME/.compaction/shims:$PATH"');
  });

  it("--no-write-shell-config does NOT claim the workflow is ready or runnable", async () => {
    // The user kept the PATH edit for themselves, so a real step is outstanding and NOTHING is set up
    // to make a readiness claim true. The per-tool block on this same screen says "NOT yet active";
    // a Ready summary would contradict it.
    const runPath = `${realBinDir}${path.delimiter}${NODE_DIR}${path.delimiter}/usr/bin${path.delimiter}/bin`;
    const out = await runInit(["init", "--connect", "2", "--static", "--no-write-shell-config"], runPath);
    expect(out).not.toContain("Compaction is ready.");
    expect(out).not.toContain("✓ Codex");
    expect(out).not.toContain("Run your workflows normally:");
  });

  it("re-running the default enable does not duplicate the shim or the rc PATH line", async () => {
    const runPath = `${realBinDir}${path.delimiter}${NODE_DIR}${path.delimiter}/usr/bin${path.delimiter}/bin`;
    await runInit(["init", "--connect", "2", "--static"], runPath);
    const rcPath = path.join(home, ".bashrc");
    const first = readFileSync(rcPath, "utf8");
    await runInit(["init", "--connect", "2", "--static"], runPath);
    const second = readFileSync(rcPath, "utf8");
    expect(second).toBe(first);
    expect(second.split(".compaction/shims").length - 1).toBe(1);
    expect(existsSync(path.join(shimDir, "codex"))).toBe(true);
  });

  it("with the shim dir on PATH ahead of the real binary: claims 'connected' (resolve-verified)", async () => {
    // First install (dir not yet on PATH).
    const installPath = `${realBinDir}${path.delimiter}${NODE_DIR}${path.delimiter}/usr/bin${path.delimiter}/bin`;
    await runInit(["init", "--connect", "2", "--static"], installPath);
    // Re-run with the shim dir first on PATH → verified active.
    const activePath = `${shimDir}${path.delimiter}${realBinDir}${path.delimiter}${NODE_DIR}${path.delimiter}/usr/bin${path.delimiter}/bin`;
    const out = await runInit(["init", "--connect", "2", "--static"], activePath);
    expect(out).toContain("- connected");
    expect(out).toContain("codex exec --json");
    // HONEST SCOPE, MATCHING RUNTIME (`kind: "gateway-route"` in `core/tool-shim.ts`): every normal
    // codex invocation - interactive included - routes through the local Gateway. Evidence is claimed
    // only for a settled artifact, never merely from routing.
    expect(out).toContain("interactive included - also routes through the local Gateway");
    expect(out).not.toMatch(/produces a receipt|receipt is produced|IS measured/);
    expect(out).not.toMatch(/Interactive \/ other codex invocations pass through untouched and are NOT measured \(never faked\)\./);
    // Sweep the whole uninterrupted connect screen, not just the primary consent line. These were
    // live contradictions after Codex changed from a capture shim to a normal-invocation Gateway shim.
    expect(out).not.toContain("interactive sessions are not measured");
    expect(out).not.toContain("No Gateway route from this setup.");
    expect(out).toContain("Routed automatically through the local Gateway");
    expect(out).toContain(
      "`compaction watch` shows settled Gateway evidence when recorded, including interactive Codex sessions."
    );
    expect(out).not.toContain(
      "`compaction watch` shows Gateway-routed Codex turns, interactive sessions included."
    );
  });

  /**
   * The shell-rc PATH line is SHARED by every Compaction shim, so removing it is a decision about all
   * of them. Disconnecting one tool used to strip it unconditionally, deactivating any sibling shim
   * that was still installed — harmless while the line was rarely written, load-bearing now that it is
   * written by default. Claude Code's `--disconnect 1` has always guarded this; these pin the same
   * promise for the capture shims.
   */
  it("disconnecting one shim tool leaves the shared rc PATH line for the shim that remains", async () => {
    const cursor = path.join(realBinDir, "cursor-agent");
    writeFileSync(cursor, "#!/usr/bin/env bash\necho real\n", "utf8");
    chmodSync(cursor, 0o755);
    const runPath = `${realBinDir}${path.delimiter}${NODE_DIR}${path.delimiter}/usr/bin${path.delimiter}/bin`;
    await runInit(["init", "--connect", "codex,cursor", "--static"], runPath);
    const rcPath = path.join(home, ".bashrc");
    expect(readFileSync(rcPath, "utf8")).toContain(".compaction/shims");

    await runInit(["init", "--disconnect", "2", "--static"], runPath);
    // Codex is gone; Cursor is NOT, so its capture must not be silently broken in every new shell.
    expect(existsSync(path.join(shimDir, "codex"))).toBe(false);
    expect(existsSync(path.join(shimDir, "cursor-agent"))).toBe(true);
    expect(readFileSync(rcPath, "utf8")).toContain(".compaction/shims");
  });

  it("the LAST shim out does take the shared rc PATH line with it", async () => {
    const runPath = `${realBinDir}${path.delimiter}${NODE_DIR}${path.delimiter}/usr/bin${path.delimiter}/bin`;
    await runInit(["init", "--connect", "2", "--static"], runPath);
    const rcPath = path.join(home, ".bashrc");
    expect(readFileSync(rcPath, "utf8")).toContain(".compaction/shims");
    await runInit(["init", "--disconnect", "2", "--static"], runPath);
    expect(existsSync(path.join(shimDir, "codex"))).toBe(false);
    expect(readFileSync(rcPath, "utf8")).not.toContain(".compaction/shims");
  });

  it("--disconnect 2 reversibly removes the shim (real binary untouched)", async () => {
    const installPath = `${realBinDir}${path.delimiter}${NODE_DIR}${path.delimiter}/usr/bin${path.delimiter}/bin`;
    await runInit(["init", "--connect", "2", "--static"], installPath);
    expect(existsSync(path.join(shimDir, "codex"))).toBe(true);
    const out = await runInit(["init", "--disconnect", "2", "--static"], installPath);
    expect(out).toContain("disconnected");
    expect(existsSync(path.join(shimDir, "codex"))).toBe(false);
    expect(existsSync(path.join(realBinDir, "codex"))).toBe(true);
  });
});

/**
 * THE FRESH-MACHINE CONTRACT.
 *
 * On a machine that has never run Compaction, `~/.compaction/shims` cannot be on PATH, so every first
 * install of a Codex/Cursor shim necessarily lands `installed-not-on-path`. That status used to be
 * excluded from the connected set, and the result was a closed loop: the flow wrote the tool's hooks,
 * the shim and the preferences file, then reported "No workflow was enabled" and "nothing was written",
 * and re-running produced byte-identically the same failure because the rc line that would have made
 * the precondition true was the one thing it never wrote.
 *
 * These cases run the REAL CLI with an isolated HOME and a PATH sanitized of the shim dir, so they
 * reproduce that machine rather than describing it.
 */
describe("a fresh machine: enabling Codex/Cursor is a completed set-up, not a dead end", () => {
  const freshPath = (): string =>
    `${realBinDir}${path.delimiter}${NODE_DIR}${path.delimiter}/usr/bin${path.delimiter}/bin`;

  it("Codex is reported as an enabled workflow even though the shim is not on PATH yet", async () => {
    const out = await runInit(["init", "--connect", "2", "--static"], freshPath());
    // The ready summary only renders its Enabled list when the connected set is NON-EMPTY
    // (`buildReadySummaryLines` returns nothing for an empty set), so this is an end-to-end proof
    // that a fresh install now reaches `connected` — the same value the TUI feeds to both the ready
    // screen and the "did anything get enabled?" guard.
    expect(out).toContain("Compaction is ready.");
    expect(out).toContain("✓ Codex");
  });

  it("Cursor is reported as an enabled workflow even though the shim is not on PATH yet", async () => {
    const cursor = path.join(realBinDir, "cursor-agent");
    writeFileSync(cursor, "#!/usr/bin/env bash\necho real\n", "utf8");
    chmodSync(cursor, 0o755);
    const out = await runInit(["init", "--connect", "3", "--static"], freshPath());
    expect(out).toContain("Compaction is ready.");
    expect(out).toContain("✓ Cursor");
  });

  it("never tells a user nothing was written while its own writes are on disk", async () => {
    const out = await runInit(["init", "--connect", "2", "--static"], freshPath());
    // The writes this run actually made.
    expect(existsSync(path.join(shimDir, "codex"))).toBe(true);
    expect(existsSync(path.join(home, ".codex", "hooks.json"))).toBe(true);
    expect(existsSync(path.join(home, ".bashrc"))).toBe(true);
    // So neither "nothing was written" phrasing may appear.
    expect(out).not.toContain("nothing was written");
    expect(out).not.toContain("No workflow was enabled");
  });

  /**
   * The ready screen's PATH-pending copy has existed all along and was unreachable for Codex/Cursor:
   * nothing ever put them in `enabled`, so the headline fell through to "No workflow was enabled".
   * Driven here against the REAL on-disk state a REAL CLI run just produced, with the shim dir absent
   * from PATH — the same in-process question the TUI asks after an enable.
   */
  it("the ready screen renders the waiting-for-a-new-shell state (not 'No workflow was enabled')", async () => {
    await runInit(["init", "--connect", "2", "--static"], freshPath());
    const saved = { ...process.env };
    try {
      process.env.HOME = home;
      process.env.COMPACTION_HOME = compactionHome;
      process.env.PATH = freshPath(); // deliberately WITHOUT the shim dir
      const { computeOnboardingReadyStatus } = await import("../../src/cli/commands/init.js");
      const status = await computeOnboardingReadyStatus(["codex"], "cache");
      expect(status.healthy).toBe(false); // never claimed active without a resolve check
      expect(status.launcher).toContain("waiting for a new shell");
      expect(status.headline).toContain("not active in this shell yet");
      expect(status.nextAction).toContain("Open a new terminal");
      // The one thing left is opening a shell — not running another Compaction command.
      expect(status.nextAction).not.toContain("compaction ");
    } finally {
      process.env = saved;
    }
  });
});
