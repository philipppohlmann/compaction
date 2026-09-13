/**
 * `compaction init --authorize-auto-apply <workflow>`, the ONE explicit, informed, SCOPED
 * onboarding authorization for automatic deterministic apply.
 *
 * Proven here (built CLI, tmpdir cwd, nothing leaks into the checkout):
 * - DEFAULT OFF: plain `init` and `init --mode …` write NO policy preference, choosing an
 *   optimization mode does NOT arm auto-apply (the authorization is a distinct explicit step);
 * - the explicit flag writes ONE enabled auto-when-gates-pass preference, scoped to exactly the
 *   named workflow + deterministic-dedupe, with the engine-evaluable gate list;
 * - the informed summary states what will auto-apply, the scope, retention + recovery, content-free
 *   recording, fail-open, and the exact disable command, and makes no savings/cost claim;
 * - cursor and global/unknown workflows are rejected with a clear error and NOTHING written;
 * - `init --disconnect 2` (codex) disables the stored authorization for that tool.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const CLI = resolve("dist/cli/index.js");

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "init-authorize-"));
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function run(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  // Hermetic env: HOME / COMPACTION_HOME / COMPACTION_CONFIG_DIR all point INSIDE the tmp cwd so
  // `--mode` (home preferences), shim paths, and hook detection never touch the real home dir.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: cwd,
    COMPACTION_HOME: join(cwd, "compaction-home"),
    COMPACTION_CONFIG_DIR: join(cwd, "config-home")
  };
  try {
    const { stdout, stderr } = await execFileAsync("node", [CLI, ...args], { cwd, env });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: err.stdout ?? "", stderr: err.stderr ?? "", code: err.code ?? 1 };
  }
}

/**
 * The authorization store is DEVICE-level: `COMPACTION_CONFIG_DIR` (here `<cwd>/config-home`), the same
 * directory the optimization mode, connected workflows and the entitlement lease live in. It used to be
 * the RELATIVE `.compaction`, i.e. whatever cwd the command ran in — which is why an authorization made
 * from `$HOME` was invisible to `claude` launched inside a project (0.6.6 release blocker). Asserting on
 * the device path is what makes that regression visible from the CLI surface.
 */
const prefsPath = (): string => join(cwd, "config-home", "policy-preferences.json");

/** The pre-fix project-local location. Nothing writes here any more; reads still honour it (legacy). */
const legacyProjectPrefsPath = (): string => join(cwd, ".compaction", "policy-preferences.json");

interface StoredPreference {
  id: string;
  scope: { tool: string; repo?: string; policy_type: string };
  preference: string;
  enabled: boolean;
  gates_required: string[];
}

async function readPrefs(): Promise<StoredPreference[]> {
  const raw = JSON.parse(await readFile(prefsPath(), "utf8")) as { preferences: StoredPreference[] };
  return raw.preferences;
}

describe("init --authorize-auto-apply - explicit scoped opt-in (default OFF)", () => {
  it("DEFAULT OFF: choosing an optimization mode does NOT write any policy preference", async () => {
    const result = await run(["init", "--mode", "cache-plus-context", "--projects-dir", "/tmp/none-here-nonexistent"]);
    expect(result.code).toBe(0);
    // Neither store: the mode is a recorded default only, never an authorization.
    expect(existsSync(prefsPath())).toBe(false);
    expect(existsSync(legacyProjectPrefsPath())).toBe(false);
    // Mode-only has no selected routed workflow, so it stores no authorization.
    expect(result.stdout).toContain("With selected routed workflows");
  });

  it("writes ONE enabled auto-when-gates-pass preference, narrowly scoped, with the evaluable gates", async () => {
    const result = await run(["init", "--authorize-auto-apply", "codex"]);
    expect(result.code).toBe(0);
    const prefs = await readPrefs();
    expect(prefs).toHaveLength(1);
    const pref = prefs[0];
    expect(pref.scope).toEqual({ tool: "codex", policy_type: "deterministic-dedupe" });
    expect(pref.preference).toBe("auto-when-gates-pass");
    expect(pref.enabled).toBe(true);
    expect(pref.gates_required).toEqual(["scope-match", "supported-shape", "deterministic-policy", "original-retainable", "change-produced"]);

    // The informed summary, every load-bearing fact, no savings/cost claim.
    expect(result.stdout).toMatch(/Auto-apply authorized \(explicit, scoped\)/);
    expect(result.stdout).toContain(pref.id);
    expect(result.stdout).toMatch(/no per-run ask/);
    expect(result.stdout).toMatch(/every safety gate passes/);
    expect(result.stdout).toMatch(/forwarded UNCHANGED/);
    expect(result.stdout).toMatch(/retained locally BEFORE any change/);
    expect(result.stdout).toContain("compaction gateway recover <recovery_id>");
    expect(result.stdout).toContain("compaction activity");
    expect(result.stdout).toMatch(/never blocks your workflow/);
    expect(result.stdout).toMatch(/never global, never another tool/);
    expect(result.stdout).toContain(`compaction policies disable ${pref.id}`);
    expect(result.stdout).toContain(`compaction gateway start --workflow codex`);
    expect(result.stdout).not.toMatch(/\bsavings\b|\$\d|billing-confirmed/i);

    // policies explain shows the ACTIVE semantics for this authorization.
    const explain = await run(["policies", "explain", pref.id]);
    expect(explain.code).toBe(0);
    expect(explain.stdout).toMatch(/ACTIVE while enabled/);
  });

  it("re-running upserts the SAME deterministic record (no duplicates)", async () => {
    await run(["init", "--authorize-auto-apply", "codex"]);
    await run(["init", "--authorize-auto-apply", "codex"]);
    expect(await readPrefs()).toHaveLength(1);
  });

  it("cursor is rejected with the honest vendor-gap reason; nothing written", async () => {
    const result = await run(["init", "--authorize-auto-apply", "cursor"]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("Compaction has no verified Cursor Gateway route");
    expect(existsSync(prefsPath())).toBe(false);
    expect(existsSync(legacyProjectPrefsPath())).toBe(false);
  });

  it("global/all/unknown workflows are rejected; nothing written", async () => {
    for (const bad of ["all", "global", "*", "everything"]) {
      const result = await run(["init", "--authorize-auto-apply", bad]);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toMatch(/never global|unknown --authorize-auto-apply/);
    }
    expect(existsSync(prefsPath())).toBe(false);
    expect(existsSync(legacyProjectPrefsPath())).toBe(false);
  });

  it("init --disconnect 2 disables the stored codex authorization (a disconnected tool keeps no live authorization)", async () => {
    await run(["init", "--authorize-auto-apply", "codex"]);
    const disconnect = await run(["init", "--disconnect", "2", "--projects-dir", "/tmp/none-here-nonexistent"]);
    expect(disconnect.code).toBe(0);
    expect(disconnect.stdout).toMatch(/Disabled the stored auto-apply authorization pref-[0-9a-f]{24}/);
    const prefs = await readPrefs();
    expect(prefs).toHaveLength(1);
    expect(prefs[0].enabled).toBe(false);
  });
});
