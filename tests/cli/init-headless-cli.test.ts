/**
 * `compaction init` HEADLESS orchestration tests.
 *
 * HERMETIC + synthetic-only: a tmp HOME / COMPACTION_HOME / COMPACTION_CONFIG_DIR and a CONTROLLED PATH
 * (with stub `codex` / `cursor-agent` binaries), never touches the real ~/.compaction, real shell config,
 * or the real Codex/Cursor binaries. Same harness as init-connect-cli.test.ts, plus the preferences store
 * pinned at the tmp COMPACTION_CONFIG_DIR.
 *
 * Proven here (via the real built-from-source CLI, non-interactive, tmp-cwd scoped):
 * - (10) `--connect <comma-list>` enables exactly the named workflows and the Ready summary lists ONLY those;
 * - `--connect detected` enables found-but-not-ready workflows and counts already-ready ones;
 * - `--connect none` enables nothing but a `--mode` still persists;
 * - an invalid workflow name is a clear error + non-zero exit, and NOTHING is written;
 * - (9) the Ready summary shows only actually-enabled/ready workflows;
 * - (11) a plain no-flag `init` writes NOTHING (no preferences.json, no settings, no shim);
 * - `--mode` persists the recorded default (round-trips on disk) and prints the honest recorded-default copy;
 * - invalid `--mode` is a clear error + non-zero exit with nothing written;
 * - back-compat: `--connect 1` still installs + verifies the Claude Code hook.
 */
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
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
  dir = await mkdtemp(join(tmpdir(), "init-headless-cli-"));
  realBinDir = join(dir, "realbin");
  compactionHome = join(dir, ".compaction");
  mkdirSync(realBinDir, { recursive: true });
  writeStub("codex");
  writeStub("cursor-agent");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Run the CLI with the shim dir NOT on PATH (default: codex/cursor enable as not-yet-active). */
async function runInit(args: string[]): Promise<RunResult> {
  return runInitWithPath(`${realBinDir}${delimiter}${NODE_DIR}${delimiter}/usr/bin${delimiter}/bin`, args);
}

/** Run the CLI with the shim dir PREPENDED to PATH (so an installed shim resolves -> installed-active). */
async function runInitShimActive(args: string[]): Promise<RunResult> {
  const shimDir = join(compactionHome, "shims");
  return runInitWithPath(`${shimDir}${delimiter}${realBinDir}${delimiter}${NODE_DIR}${delimiter}/usr/bin${delimiter}/bin`, args);
}

async function runInitWithPath(pathValue: string, args: string[]): Promise<RunResult> {
  const env: NodeJS.ProcessEnv = {
    HOME: dir,
    COMPACTION_HOME: compactionHome,
    COMPACTION_CONFIG_DIR: compactionHome,
    PATH: pathValue,
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
const prefsPath = (): string => join(compactionHome, "preferences.json");
const readPrefs = (): Record<string, unknown> => JSON.parse(readFileSync(prefsPath(), "utf8"));

describe("compaction init - headless orchestration", () => {
  it("(10) --connect comma-list enables exactly the named workflows; Ready lists only those", async () => {
    // shim dir on PATH so an installed Codex shim verifies active this run.
    const { stdout, code } = await runInitShimActive(["--connect", "codex,claude-code"]);
    expect(code).toBe(0);
    // Both named workflows enabled + verified.
    expect(stdout).toContain("Compaction is now active for Claude Code");
    expect(stdout).toContain("Compaction is ready.");
    const ready = stdout.slice(stdout.indexOf("Compaction is ready."));
    expect(ready).toContain("✓ Claude Code");
    expect(ready).toContain("✓ Codex");
    // Cursor was NOT named -> never listed as Enabled and never installed.
    expect(ready).not.toContain("✓ Cursor");
    expect(existsSync(shimPath("cursor-agent"))).toBe(false);
    expect(existsSync(shimPath("codex"))).toBe(true);
  });

  it("--connect detected enables found-but-not-ready workflows (Codex/Cursor found on PATH)", async () => {
    // No claude sessions (projects-dir none) -> claude not-found. Codex/Cursor real binaries -> found.
    // Shim dir on PATH so enabling them verifies active this run.
    const { stdout, code } = await runInitShimActive(["--connect", "detected"]);
    expect(code).toBe(0);
    const ready = stdout.slice(stdout.indexOf("Compaction is ready."));
    expect(ready).toContain("✓ Codex");
    expect(ready).toContain("✓ Cursor");
    // Claude Code was not-found -> never enabled/listed.
    expect(ready).not.toContain("✓ Claude Code");
    expect(existsSync(shimPath("codex"))).toBe(true);
    expect(existsSync(shimPath("cursor-agent"))).toBe(true);
  });

  it("--connect detected counts an ALREADY-ready workflow without re-enabling it", async () => {
    // First: enable Codex so its shim is active on PATH (installed-active).
    await runInitShimActive(["--connect", "codex"]);
    expect(existsSync(shimPath("codex"))).toBe(true);
    // Now detected: Codex is already `ready` (counted), Cursor is `found` (enabled this run).
    const { stdout, code } = await runInitShimActive(["--connect", "detected"]);
    expect(code).toBe(0);
    const ready = stdout.slice(stdout.indexOf("Compaction is ready."));
    expect(ready).toContain("✓ Codex");
    expect(ready).toContain("✓ Cursor");
  });

  it("--connect none enables nothing but a --mode still persists (recorded default only)", async () => {
    const { stdout, code } = await runInit(["--connect", "none", "--mode", "cache-plus-context"]);
    expect(code).toBe(0);
    // Nothing enabled: no ready summary, no settings, no shim.
    expect(stdout).not.toContain("Compaction is ready.");
    expect(existsSync(settingsPath())).toBe(false);
    expect(existsSync(shimPath("codex"))).toBe(false);
    // But the recorded-default mode persisted (enum-only).
    expect(readPrefs()).toEqual({ optimization_mode: "cache-plus-context" });
    // Honest mode-only copy: without a selected workflow, no authorization is stored.
    expect(stdout).toContain("Optimization mode (recorded default)");
    expect(stdout).toContain("With selected routed workflows");
    expect(existsSync(join(dir, ".compaction", "policy-preferences.json"))).toBe(false);
  });

  it("one Cache + context confirmation stores narrow authorizations for routed selected workflows only", async () => {
    const { stdout, code } = await runInitShimActive(["--connect", "codex,cursor", "--mode", "cache-plus-context"]);
    expect(code).toBe(0);
    expect(stdout).toContain("Full optimization authorization saved for codex");
    expect(stdout).not.toContain("authorization saved for cursor");
    const store = JSON.parse(readFileSync(join(dir, ".compaction", "policy-preferences.json"), "utf8")) as {
      preferences: Array<{ scope: { tool: string }; enabled: boolean }>;
    };
    expect(store.preferences).toHaveLength(1);
    expect(store.preferences[0]).toMatchObject({ scope: { tool: "codex" }, enabled: true });
  });

  it("does not authorize auto-apply for a routed workflow whose shim is not yet active on PATH", async () => {
    // AUTO-APPLY KEEPS THE STRICTER BAR. A fresh Codex install is reported as configured (its shim and
    // hooks are written and its PATH line set up), but "configured, pending a new shell" is NOT the bar
    // for storing a narrow auto-apply authorization — that still needs a resolve-verified active shim.
    const { stdout, code } = await runInit(["--connect", "codex", "--mode", "cache-plus-context"]);
    expect(code).toBe(0);
    expect(existsSync(join(dir, ".compaction", "policy-preferences.json"))).toBe(false);
    expect(stdout).not.toContain("Full optimization authorization saved for codex");
  });

  it("an invalid --connect workflow name is a clear error + non-zero exit; nothing written", async () => {
    const { stderr, code } = await runInit(["--connect", "codex,foo", "--mode", "cache"]);
    expect(code).toBe(1);
    expect(stderr).toContain("unknown --connect workflow name(s): foo");
    expect(stderr).toContain("claude-code | codex | cursor");
    // Error is raised BEFORE any write: no preferences, no settings, no shim.
    expect(existsSync(prefsPath())).toBe(false);
    expect(existsSync(settingsPath())).toBe(false);
    expect(existsSync(shimPath("codex"))).toBe(false);
  });

  it("(9) Ready summary lists every workflow this run configured, including PATH-pending shims", async () => {
    // Shim dir NOT on PATH — the state of every genuinely fresh machine. All three were configured by
    // this run (shim + hooks + the rc PATH line), so all three are listed; the PATH-pending nuance is
    // carried by each workflow's own routing block, never by dropping it from the Enabled list.
    const { stdout, code } = await runInit(["--connect", "all"]);
    expect(code).toBe(0);
    const ready = stdout.slice(stdout.indexOf("Compaction is ready."));
    expect(ready).toContain("✓ Claude Code");
    expect(ready).toContain("✓ Codex");
    expect(ready).toContain("✓ Cursor");
  });

  it("(11) a plain no-flag init writes NOTHING (read-only): no preferences.json, no settings, no shim", async () => {
    const { stdout, code } = await runInit([]);
    expect(code).toBe(0);
    expect(stdout).toContain("Enable Compaction for:");
    expect(existsSync(prefsPath())).toBe(false);
    expect(existsSync(settingsPath())).toBe(false);
    expect(existsSync(shimPath("codex"))).toBe(false);
  });

  it("--mode cache persists the recorded default and round-trips on disk (enum-only)", async () => {
    const { stdout, code } = await runInit(["--mode", "cache"]);
    expect(code).toBe(0);
    expect(stdout).toContain("Saved default: Output only (cache).");
    expect(readPrefs()).toEqual({ optimization_mode: "cache" });
    // Overwrite with the other mode.
    await runInit(["--mode", "cache-plus-context"]);
    expect(readPrefs()).toEqual({ optimization_mode: "cache-plus-context" });
  });

  it("an invalid --mode value is a clear error + non-zero exit; nothing written", async () => {
    const { stderr, code } = await runInit(["--mode", "turbo"]);
    expect(code).toBe(1);
    expect(stderr).toContain("unknown --mode 'turbo'");
    expect(stderr).toContain("cache | cache-plus-context");
    expect(existsSync(prefsPath())).toBe(false);
  });

  it("back-compat: --connect 1 still installs + verifies the Claude Code hook", async () => {
    const { stdout, code } = await runInit(["--connect", "1"]);
    expect(code).toBe(0);
    expect(stdout).toContain("Compaction is now active for Claude Code");
    const onDisk = JSON.parse(readFileSync(settingsPath(), "utf8"));
    expect(onDisk.hooks.Stop[0].hooks[0].command).toBe("compaction capture claude-code --from-hook");
    // No mode flag -> no optimization_mode written. The verified connect DOES persist the content-free
    // connected-workflow enum (the gateway --workflow default source) - and nothing else.
    expect(readPrefs()).toEqual({ connected_workflows: ["claude-code"] });
  });
});
