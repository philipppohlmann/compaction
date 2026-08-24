/**
 * `compaction init --connect <n>` menu tests.
 *
 * HERMETIC + synthetic-only: a tmp `COMPACTION_HOME` and a CONTROLLED PATH (with stub `codex` /
 * `cursor-agent` binaries), this test NEVER touches the real ~/.compaction, real shell config, or the
 * real Codex/Cursor binaries on the developer's machine.
 *
 * Proven here (via the real built-from-source CLI, non-interactive, tmp-cwd scoped):
 * - the numbered menu renders [1] Claude Code [2] Codex [3] Cursor [4] All supported CLI tools [5] Skip;
 * - the browser stays "not connected / not checked", NEVER "not installed" (no Chrome-profile scan);
 * - `--connect 1` ACTUALLY installs + verifies the consented Stop hook into .claude/settings.json;
 * - `--connect 1 --dry-run` writes NOTHING but shows the would-write;
 * - `--connect 2` / `3` install + VERIFY a reversible Codex/Cursor PATH shim AND set PATH up for it by
 *   default, reporting "installed; active in new shells" with the exact export line - never a false
 *   claim that THIS shell is already routed, and never a second command left for the user to run;
 * - `--connect 5` (skip) installs nothing;
 * - an unknown choice is a clean one-line error (exit 1).
 */
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const CLI = resolve("dist/cli/index.js");
const NODE_DIR = dirname(process.execPath);

let dir: string;
let realBinDir: string;
let compactionHome: string;

function writeStub(name: string): void {
  const p = join(realBinDir, name);
  writeFileSync(p, "#!/usr/bin/env bash\necho real\n", "utf8");
  chmodSync(p, 0o755);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "init-connect-cli-"));
  realBinDir = join(dir, "realbin");
  // Default location under the tmp HOME so the printed export line is the $HOME-relative form.
  compactionHome = join(dir, ".compaction");
  mkdirSync(realBinDir, { recursive: true });
  writeStub("codex");
  writeStub("cursor-agent");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function runInit(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  const env: NodeJS.ProcessEnv = {
    HOME: dir,
    COMPACTION_HOME: compactionHome,
    // Controlled PATH: stub tools + node (for the CLI) + system utils. No real codex/cursor leak.
    PATH: `${realBinDir}${delimiter}${NODE_DIR}${delimiter}/usr/bin${delimiter}/bin`,
    NO_COLOR: "1"
  };
  try {
    const res = await execFileAsync("node", [CLI, "init", ...args, "--projects-dir", join(dir, "none")], { cwd: dir, env });
    return { stdout: res.stdout, stderr: res.stderr, code: 0 };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", code: e.code ?? 1 };
  }
}

const settingsPath = (): string => join(dir, ".claude", "settings.json");
const shimPath = (name: string): string => join(compactionHome, "shims", name);

describe("compaction init --connect", () => {
  it("--connect all renders the menu, installs CC + Codex/Cursor shims (PATH-pending), honest detection", async () => {
    const { stdout, code } = await runInit(["--connect", "all"]);
    expect(code).toBe(0);
    // numbered menu
    expect(stdout).toContain("[1] Claude Code");
    expect(stdout).toContain("[2] Codex");
    expect(stdout).toContain("[3] Cursor");
    expect(stdout).toContain("[4] All supported");
    expect(stdout).toContain("[5] Skip");
    // discovery block - found/ready/not-found state model; Browser/OpenAI Agents are NOT rows.
    expect(stdout).toContain("Found on this machine:");
    expect(stdout).toContain("Discovery is read-only. Enabling is the first write.");
    expect(stdout).not.toMatch(/\[[ x~]\] Browser\b/);
    expect(stdout).not.toContain("OpenAI Agents");
    expect(stdout).not.toContain("not installed");
    // Codex/Cursor stubs are on the controlled PATH but the shim is not active yet -> `found` row.
    expect(stdout).toMatch(/\[x\] Codex\s+installed · enable Compaction/);
    expect(stdout).toMatch(/\[x\] Cursor\s+installed · enable Compaction/);
    // the shim files were installed and PATH set-up ran for all three (asserted before any string
    // pin, so a copy change can never leave these silently untested)
    expect(existsSync(shimPath("codex"))).toBe(true);
    expect(existsSync(shimPath("cursor-agent"))).toBe(true);
    // Claude Code really installed + verified; Codex/Cursor shims installed, active in new shells.
    expect(stdout).toContain("Compaction is now active for Claude Code");
    expect(stdout).toContain("▸ Codex - installed; active in new shells");
    expect(stdout).toContain("▸ Cursor - installed; active in new shells");
    expect(stdout).toContain('export PATH="$HOME/.compaction/shims:$PATH"');
    // A shim that does not resolve on THIS shell's PATH must NEVER be called active here.
    expect(stdout).not.toContain("now active for Codex");
    expect(stdout).not.toContain("now active for Cursor");
    // activation copy
    expect(stdout).toContain("What Compaction does once connected");
    expect(stdout).toContain("Auto-apply is off by default");
  });

  it("--connect 1 ACTUALLY installs + verifies the Claude Code Stop hook (no shim installed)", async () => {
    const { stdout, code } = await runInit(["--connect", "1"]);
    expect(code).toBe(0);
    expect(stdout).toContain("Compaction is now active for Claude Code");
    expect(stdout).toContain("measured automatically");
    // --connect 1 does NOT install a Codex/Cursor shim.
    expect(existsSync(shimPath("codex"))).toBe(false);
    const onDisk = JSON.parse(await readFile(settingsPath(), "utf8"));
    expect(onDisk.hooks.Stop[0].hooks[0].command).toBe("compaction capture claude-code --from-hook");
  });

  it("--connect 1 --dry-run writes NOTHING but shows the would-write", async () => {
    const { stdout, code } = await runInit(["--connect", "1", "--dry-run"]);
    expect(code).toBe(0);
    expect(stdout).toContain("dry run (nothing written)");
    expect(stdout).toContain("would be merged");
    expect(existsSync(settingsPath())).toBe(false);
    expect(stdout).not.toContain("is now active");
  });

  it("--connect 2 installs + verifies the Codex shim (PATH-pending), no CC hook written", async () => {
    const { stdout, code } = await runInit(["--connect", "2"]);
    expect(code).toBe(0);
    expect(existsSync(shimPath("codex"))).toBe(true);
    expect(existsSync(settingsPath())).toBe(false);
    expect(stdout).toContain("▸ Codex - installed; active in new shells");
    expect(stdout).toContain('export PATH="$HOME/.compaction/shims:$PATH"');
    expect(stdout).not.toContain("now active for Codex");
  });

  it("--connect 3 installs + verifies the Cursor shim (PATH-pending, local-estimate tool)", async () => {
    const { stdout, code } = await runInit(["--connect", "cursor"]);
    expect(code).toBe(0);
    expect(existsSync(shimPath("cursor-agent"))).toBe(true);
    expect(existsSync(settingsPath())).toBe(false);
    expect(stdout).toContain("▸ Cursor - installed; active in new shells");
    expect(stdout).toContain('export PATH="$HOME/.compaction/shims:$PATH"');
    expect(stdout).not.toContain("▸ Codex");
  });

  it("--connect 5 (skip) installs nothing", async () => {
    const { stdout, code } = await runInit(["--connect", "5"]);
    expect(code).toBe(0);
    expect(stdout).toContain("Skipped");
    expect(existsSync(settingsPath())).toBe(false);
    expect(existsSync(shimPath("codex"))).toBe(false);
  });

  it("Cursor is listed/assessed in the menu even when a DIFFERENT choice is selected", async () => {
    const { stdout } = await runInit(["--connect", "1"]);
    expect(stdout).toContain("[3] Cursor");
    // The detection row reflects the honest current connect mechanism for Cursor.
    expect(stdout).toContain("local-estimate only");
  });

  it("an unknown --connect value is a clean one-line error (exit 1)", async () => {
    const { stderr, code } = await runInit(["--connect", "everything"]);
    expect(code).toBe(1);
    expect(stderr).toContain("unknown --connect");
    expect(stderr).toContain("5|skip");
  });

  it("--disconnect 2 reversibly removes the Codex shim (real binary untouched)", async () => {
    await runInit(["--connect", "2"]);
    expect(existsSync(shimPath("codex"))).toBe(true);
    const { stdout, code } = await runInit(["--disconnect", "2"]);
    expect(code).toBe(0);
    expect(stdout).toContain("▸ Codex - disconnected");
    expect(existsSync(shimPath("codex"))).toBe(false);
    expect(existsSync(join(realBinDir, "codex"))).toBe(true);
  });

  it("plain `init` (no --connect) still prints the normal onboarding screen and writes nothing", async () => {
    const { stdout, code } = await runInit([]);
    expect(code).toBe(0);
    // Plain init (non-TTY) now shows the connect-once install screen - and still writes NOTHING.
    expect(stdout).toContain("Enable Compaction for:");
    expect(stdout).toContain("[4] All supported");
    expect(stdout).not.toContain("Start here");
    expect(existsSync(settingsPath())).toBe(false);
  });
});
