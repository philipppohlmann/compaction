/**
 * Three regressions the rc-write default flip introduced, each
 * asserted against the REAL built CLI on a hermetic fresh-machine layout (tmp HOME / COMPACTION_HOME /
 * COMPACTION_CONFIG_DIR, stub `codex` binary, controlled PATH). Nothing here touches a real shell
 * config, a real ~/.compaction, or a real Codex install.
 *
 * 1. CONSENT CARRIED TO ACTIVATION. `--connect codex --mode cache-plus-context` on a fresh machine took
 *    the Cache + context consent, told the user no further command was needed, and then skipped storing
 *    the authorization because the shim was not yet resolvable in that shell — permanently, since
 *    nothing reruns it. The authorization must land by itself once the shim is genuinely active, and
 *    must NOT exist before that.
 * 2. `--dry-run` MUST WRITE NOTHING. The flip made `--connect 2 --dry-run` edit ~/.bashrc or ~/.zshrc.
 * 3. AN UNSUPPORTED SHELL MUST NOT BE CALLED ACTIVATED. Under fish the rc resolver falls back to
 *    ~/.bashrc, which fish never loads and could not parse, and the new copy called that activation.
 *
 * String pins and property assertions are kept in SEPARATE `it` blocks throughout: a failing pin
 * reports first and would leave a property in the same block untested.
 */
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const CLI = resolve("dist/cli/index.js");
const NODE_DIR = dirname(process.execPath);

let dir: string;
let realBinDir: string;
let compactionHome: string;

interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** PATH WITHOUT the shim dir — every genuinely fresh machine, and the shell that runs onboarding. */
function pathShimInactive(): string {
  return `${realBinDir}${delimiter}${NODE_DIR}${delimiter}/usr/bin${delimiter}/bin`;
}

/** PATH WITH the shim dir first — what the user's NEXT shell looks like once the rc line is loaded. */
function pathShimActive(): string {
  return `${join(compactionHome, "shims")}${delimiter}${pathShimInactive()}`;
}

async function runCli(args: string[], pathValue: string, extraEnv: NodeJS.ProcessEnv = {}): Promise<RunResult> {
  const env: NodeJS.ProcessEnv = {
    HOME: dir,
    COMPACTION_HOME: compactionHome,
    COMPACTION_CONFIG_DIR: compactionHome,
    PATH: pathValue,
    NO_COLOR: "1",
    ...extraEnv
  };
  try {
    const res = await execFileAsync("node", [CLI, ...args], { cwd: dir, env });
    return { stdout: res.stdout, stderr: res.stderr, code: 0 };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", code: e.code ?? 1 };
  }
}

function runInit(args: string[], pathValue = pathShimInactive(), extraEnv: NodeJS.ProcessEnv = {}): Promise<RunResult> {
  return runCli(["init", ...args, "--projects-dir", join(dir, "none")], pathValue, extraEnv);
}

const policyPrefsPath = (): string => join(compactionHome, "policy-preferences.json");
const pendingPath = (): string => join(compactionHome, "pending-authorizations.json");
const shimPath = (name: string): string => join(compactionHome, "shims", name);

function authorizedTools(): string[] {
  if (!existsSync(policyPrefsPath())) return [];
  const store = JSON.parse(readFileSync(policyPrefsPath(), "utf8")) as {
    preferences?: Array<{ scope: { tool: string }; enabled: boolean }>;
  };
  return (store.preferences ?? []).filter((p) => p.enabled).map((p) => p.scope.tool);
}

/**
 * EXACTLY what the installed capture shim runs after the real binary exits (see `captureSnippet` in
 * src/core/tool-shim.ts) — the user typed `codex`, not a Compaction command. Used to prove the carried
 * consent is redeemed with no second user command.
 */
async function runShimCaptureBridge(): Promise<RunResult> {
  const teeFile = join(dir, "shim-stdout.jsonl");
  writeFileSync(teeFile, "", "utf8");
  return runCli(["capture", "codex", "--from-shim", teeFile], pathShimActive());
}

/** Every file under `root` (relative path → contents), for byte-for-byte "nothing changed" proofs. */
function snapshotTree(root: string, skip: readonly string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      const rel = relative(root, full);
      if (skip.some((s) => rel === s || rel.startsWith(`${s}/`))) continue;
      if (statSync(full).isDirectory()) walk(full);
      else out[rel] = readFileSync(full, "utf8");
    }
  };
  walk(root);
  return out;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "init-carry-forward-"));
  realBinDir = join(dir, "realbin");
  compactionHome = join(dir, ".compaction");
  mkdirSync(realBinDir, { recursive: true });
  const codex = join(realBinDir, "codex");
  writeFileSync(codex, "#!/usr/bin/env bash\necho real\n", "utf8");
  chmodSync(codex, 0o755);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("Finding 1 - the Cache + context consent is carried to activation, never dropped", () => {
  it("stores NOTHING while the shim is installed but not yet resolvable in this shell", async () => {
    const { code } = await runInit(["--connect", "codex", "--mode", "cache-plus-context"]);
    expect(code).toBe(0);
    // The bar is unchanged: no verified-active shim, no authorization. Not "later" - not at all, yet.
    expect(authorizedTools()).toEqual([]);
    expect(existsSync(policyPrefsPath())).toBe(false);
  });

  it("keeps the consent instead of discarding it, as an enum-only record beside the authorization store", async () => {
    await runInit(["--connect", "codex", "--mode", "cache-plus-context"]);
    expect(existsSync(pendingPath())).toBe(true);
    expect(JSON.parse(readFileSync(pendingPath(), "utf8"))).toEqual({ pending_auto_apply_consent: ["codex"] });
  });

  it("stores the authorization once the shim is genuinely active, with NO second user command", async () => {
    await runInit(["--connect", "codex", "--mode", "cache-plus-context"]);
    expect(authorizedTools()).toEqual([]); // precondition: still nothing.
    // The user opens a new shell (shim dir now on PATH) and runs `codex`. The shim's OWN capture bridge
    // is the only thing that runs - the user issues no Compaction command anywhere in this step.
    const bridge = await runShimCaptureBridge();
    expect(bridge.code).toBe(0);
    expect(authorizedTools()).toEqual(["codex"]);
    // The consent is spent, not re-applied on every later run.
    expect(existsSync(pendingPath())).toBe(false);
  });

  it("stores exactly the authorization the immediate path would have stored", async () => {
    await runInit(["--connect", "codex", "--mode", "cache-plus-context"]);
    await runShimCaptureBridge();
    const carried = JSON.parse(readFileSync(policyPrefsPath(), "utf8")) as {
      preferences: Array<Record<string, unknown>>;
    };
    // Same run, same flags, but in a shell that already resolves the shim: the immediate path.
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    mkdirSync(realBinDir, { recursive: true });
    const codex = join(realBinDir, "codex");
    writeFileSync(codex, "#!/usr/bin/env bash\necho real\n", "utf8");
    chmodSync(codex, 0o755);
    await runInit(["--connect", "codex"], pathShimInactive()); // install the shim first...
    await runInit(["--connect", "codex", "--mode", "cache-plus-context"], pathShimActive()); // ...now active.
    const immediate = JSON.parse(readFileSync(policyPrefsPath(), "utf8")) as {
      preferences: Array<Record<string, unknown>>;
    };
    expect(carried.preferences).toEqual(immediate.preferences);
  });

  it("never redeems a consent whose shim is still inactive, however many times Compaction runs", async () => {
    await runInit(["--connect", "codex", "--mode", "cache-plus-context"]);
    // Three more Compaction processes, all in the ORIGINAL shell where the shim does not resolve.
    await runCli(["activity"], pathShimInactive());
    await runCli(["status"], pathShimInactive());
    await runCli(["activity"], pathShimInactive());
    expect(authorizedTools()).toEqual([]);
    expect(existsSync(pendingPath())).toBe(true);
  });

  it("--disconnect 2 drops an unredeemed consent, so it cannot land after the user backed out", async () => {
    await runInit(["--connect", "codex", "--mode", "cache-plus-context"]);
    expect(existsSync(pendingPath())).toBe(true);
    await runInit(["--disconnect", "2"]);
    expect(existsSync(pendingPath())).toBe(false);
    // Even with the shim dir back on PATH, there is nothing left to redeem.
    await runCli(["activity"], pathShimActive());
    expect(authorizedTools()).toEqual([]);
  });

  it("a recorded default moved back to Cache withdraws the consent unstored", async () => {
    await runInit(["--connect", "codex", "--mode", "cache-plus-context"]);
    await runInit(["--mode", "cache"]);
    await runCli(["activity"], pathShimActive());
    expect(authorizedTools()).toEqual([]);
    expect(existsSync(pendingPath())).toBe(false);
  });

  it("does not claim the authorization is stored, and names no command to run", async () => {
    const { stdout } = await runInit(["--connect", "codex", "--mode", "cache-plus-context"]);
    expect(stdout).toContain("Full optimization authorization for codex: confirmed, not stored yet.");
    expect(stdout).not.toContain("Full optimization authorization saved for codex");
    expect(stdout).toContain("There is no command to run");
    // The withdrawal is the ONLY command this block offers - a set-up command here would be the hidden
    // second step the enable screen exists to avoid.
    expect(stdout).toContain("compaction init --disconnect 2");
  });
});

describe("Finding 2 - --connect 2 --dry-run writes nothing", () => {
  it("leaves the machine byte-for-byte unchanged (no shim, no shell startup file, no config)", async () => {
    const before = snapshotTree(dir, ["realbin"]);
    const { code } = await runInit(["--connect", "2", "--dry-run"]);
    expect(code).toBe(0);
    expect(snapshotTree(dir, ["realbin"])).toEqual(before);
    // Named individually so a failure says WHICH promise broke.
    expect(existsSync(shimPath("codex"))).toBe(false);
    expect(existsSync(join(dir, ".bashrc"))).toBe(false);
    expect(existsSync(join(dir, ".zshrc"))).toBe(false);
  });

  it("does not touch an EXISTING shell startup file", async () => {
    const rc = join(dir, ".zshrc");
    const original = "# my own zshrc\nexport EDITOR=vi\n";
    writeFileSync(rc, original, "utf8");
    await runInit(["--connect", "2", "--dry-run"], pathShimInactive(), { SHELL: "/bin/zsh" });
    expect(readFileSync(rc, "utf8")).toBe(original);
    expect(existsSync(`${rc}.compaction.bak`)).toBe(false);
  });

  it("says nothing was written and names the writes it skipped", async () => {
    const { stdout } = await runInit(["--connect", "2", "--dry-run"]);
    expect(stdout).toContain("--dry-run: nothing was written.");
    expect(stdout).toContain("Codex - dry run");
    expect(stdout).not.toContain("installed; active in new shells");
  });
});

describe("Finding 3 - an unsupported shell is never reported as activated", () => {
  const FISH = { SHELL: "/usr/bin/fish" };

  it("writes no shell startup file it knows the shell will not load", async () => {
    const { code } = await runInit(["--connect", "2"], pathShimInactive(), FISH);
    expect(code).toBe(0);
    expect(existsSync(shimPath("codex"))).toBe(true); // the shim itself is still installed
    expect(existsSync(join(dir, ".bashrc"))).toBe(false);
    expect(existsSync(join(dir, ".zshrc"))).toBe(false);
  });

  it("does not count the workflow as configured, so no Ready summary claims it", async () => {
    const { stdout } = await runInit(["--connect", "2"], pathShimInactive(), FISH);
    expect(stdout).not.toContain("Compaction is ready.");
    expect(stdout).not.toContain("✓ Codex");
  });

  it("does not claim activation in a new shell", async () => {
    const { stdout } = await runInit(["--connect", "2"], pathShimInactive(), FISH);
    expect(stdout).not.toContain("active in new shells");
    expect(stdout).toContain("installed, NOT yet active");
  });

  it("names the shell and hands over the manual PATH instruction instead", async () => {
    const { stdout } = await runInit(["--connect", "2"], pathShimInactive(), FISH);
    expect(stdout).toContain("Compaction only edits zsh and bash startup files, and your shell is /usr/bin/fish");
    expect(stdout).toContain('export PATH="$HOME/.compaction/shims:$PATH"');
  });

  it("still writes the shell startup file for zsh and bash (the supported shells are unaffected)", async () => {
    await runInit(["--connect", "2"], pathShimInactive(), { SHELL: "/bin/zsh" });
    expect(existsSync(join(dir, ".zshrc"))).toBe(true);
    expect(readFileSync(join(dir, ".zshrc"), "utf8")).toContain(".compaction/shims");
  });
});
