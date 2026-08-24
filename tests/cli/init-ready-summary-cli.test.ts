/**
 * `compaction init --connect N` Page-4 "Ready" summary tests, via the real built CLI.
 *
 * Hermetic: tmp HOME/COMPACTION_HOME and a controlled PATH with stub `codex`/`cursor-agent`
 * binaries, never touches the real ~/.compaction, shell config, or binaries (same harness as
 * init-connect-cli.test.ts). Covers: summary appears only after a verified connect and lists
 * only verified-connected tools; default mode + run/activity/routing commands; dry-run and skip
 * show no summary; a forbidden-claim-substring guard over the connected output.
 */
import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  dir = await mkdtemp(join(tmpdir(), "init-ready-cli-"));
  realBinDir = join(dir, "realbin");
  compactionHome = join(dir, ".compaction");
  mkdirSync(realBinDir, { recursive: true });
  writeStub("codex");
  writeStub("cursor-agent");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function runInit(
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {}
): Promise<{ stdout: string; stderr: string; code: number }> {
  const env: NodeJS.ProcessEnv = {
    HOME: dir,
    COMPACTION_HOME: compactionHome,
    PATH: `${realBinDir}${delimiter}${NODE_DIR}${delimiter}/usr/bin${delimiter}/bin`,
    NO_COLOR: "1",
    ...extraEnv
  };
  try {
    const res = await execFileAsync("node", [CLI, "init", ...args, "--projects-dir", join(dir, "none")], { cwd: dir, env });
    return { stdout: res.stdout, stderr: res.stderr, code: 0 };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", code: e.code ?? 1 };
  }
}

describe("compaction init --connect: Page-4 Ready summary", () => {
  it("appears after a successful connect and lists every workflow this run configured", async () => {
    // --connect all on a machine whose shim dir is NOT on PATH — the fresh-machine state. Claude Code
    // verifies its hook into the project .claude/settings.json; the Codex/Cursor shims install and get
    // their rc PATH line written. All three were configured, so all three are Enabled; PATH-pending is
    // reported per workflow, not by omitting the workflow from the list.
    const { stdout, code } = await runInit(["--connect", "all"]);
    expect(code).toBe(0);

    // Header + Enabled list.
    expect(stdout).toContain("Compaction is ready.");
    expect(stdout).toContain("Enabled:");
    expect(stdout).toContain("✓ Claude Code");
    const readySection = stdout.slice(stdout.indexOf("Compaction is ready."));
    expect(readySection).toContain("✓ Codex");
    expect(readySection).toContain("✓ Cursor");

    // Default mode, labelled default.
    expect(stdout).toContain("Optimization: Output only (default)");

    // Run commands for the enabled tools.
    expect(readySection).toContain("Run your workflows normally:");
    expect(readySection).toMatch(/Run your workflows normally:\n\s+claude\n/);

    // Honest "Compaction will" bullets.
    expect(stdout).toContain("Compaction will:");
    expect(stdout).toContain("✓ record usage (content-free token/cache receipts)");
    expect(stdout).toContain(
      "✓ show provider-reported proof when the provider caches and fresh input drops (compaction gateway proof)"
    );
    expect(stdout).toContain(
      "○ ask before any context compaction - only if you start apply mode (compaction gateway start --mode apply)"
    );

    // Activity + real routing commands.
    expect(stdout).toContain("View activity:  compaction activity");
    expect(stdout).toContain("Explicit routing (when a workflow needs it):  compaction gateway run -- <your-command>");

    // Per-workflow section: CONCISE + tool-scoped. Only the enabled line + run command + the one
    // Record-only boundary; the advanced routing / cache-proof / apply detail moved to
    // `compaction status`, pointed to by a single line.
    expect(readySection).toContain("Per workflow - enabled on the plan-auth default (no API key):");
    expect(readySection).toContain("Claude Code → ✓ Enabled (plan-auth, default):  claude");
    // F65: this pinned "Record-only - nothing the model sees is mutated." on a REAL `--connect 1` run,
    // i.e. the exact run that writes the `--shape-prompt-hook` UserPromptSubmit entry. The suite was
    // therefore enforcing a sentence the same command's own settings file contradicted.
    expect(readySection).toContain(
      "Output shaping: on - a concise-response instruction is attached before each shapeable turn. " +
        "Your input is not compacted or edited."
    );
    expect(readySection).toContain("Advanced routing, cache proof, and per-workflow detail:  compaction status");
    // The advanced detail is NOT inlined on the enable screen (it lives in `compaction status`).
    expect(readySection).not.toContain("Optional (Advanced) - provider cache proof:");
    expect(readySection).not.toContain("verify-cache");
    expect(readySection).not.toContain("live-verified");
  });

  it("lists Codex run command when Codex actually connects (shim active on PATH)", async () => {
    // Put the shim dir on PATH so a --connect 2 install resolves to the shim (installed-active).
    const shimDir = join(compactionHome, "shims");
    const env: NodeJS.ProcessEnv = {
      HOME: dir,
      COMPACTION_HOME: compactionHome,
      PATH: `${shimDir}${delimiter}${realBinDir}${delimiter}${NODE_DIR}${delimiter}/usr/bin${delimiter}/bin`,
      NO_COLOR: "1"
    };
    const res = await execFileAsync(
      "node",
      [CLI, "init", "--connect", "2", "--projects-dir", join(dir, "none")],
      { cwd: dir, env }
    );
    const stdout = res.stdout;
    expect(stdout).toContain("Compaction is ready.");
    expect(stdout).toContain("✓ Codex");
    const readySection = stdout.slice(stdout.indexOf("Compaction is ready."));
    expect(readySection).toMatch(/Run your workflows normally:\n\s+codex\n/);
    // Codex concise enable line + run command + the HONEST per-tool boundary. The Record-only line is
    // deliberately absent: this connect installs a capture shim plus the tool's own hooks, so there is
    // no gateway route AND an instruction IS attached to what the model sees.
    expect(readySection).toContain("Codex → ✓ Enabled (plan-auth, default):  codex");
    // The instruction IS named (the whole point of the correction) and the absent Gateway route is
    // stated. The turn-scope clause is probe-driven (a build with the task classifier says "held", one
    // without says "every prompt"), so both honest forms are accepted here and pinned exactly, with
    // their conditions, in tests/cli/init-ready-routing.test.ts.
    expect(readySection).toContain("a concise-response instruction is attached before generation");
    expect(readySection).toContain("No Gateway route from this setup.");
    expect(readySection).not.toContain("Record-only - nothing the model sees is mutated.");
    expect(readySection).toContain("Advanced routing, cache proof, and per-workflow detail:  compaction status");
    expect(readySection).not.toContain("verify-cache");
    // Claude Code was not part of this connect -> not Enabled.
    expect(readySection).not.toContain("✓ Claude Code");
  });

  it("does NOT show the Ready summary when nothing connected (dry-run)", async () => {
    const { stdout, code } = await runInit(["--connect", "1", "--dry-run"]);
    expect(code).toBe(0);
    expect(stdout).toContain("dry run (nothing written)");
    expect(stdout).not.toContain("Compaction is ready.");
  });

  it("does NOT show the Ready summary on skip", async () => {
    const { stdout } = await runInit(["--connect", "5"]);
    expect(stdout).toContain("Skipped");
    expect(stdout).not.toContain("Compaction is ready.");
  });

  it("the Ready-connected output carries no forbidden savings/capability claim", async () => {
    const { stdout } = await runInit(["--connect", "all"]);
    const ready = stdout.slice(stdout.indexOf("Compaction is ready."));
    const forbidden = [
      "billing-confirmed",
      "invoice",
      "you saved",
      "we saved",
      "money saved",
      "output tokens reduced",
      "reduces your input",
      "compaction reduces",
      "auto-apply",
      "automatically applies",
      "no context lost",
      "semantic",
      "all providers",
      "guaranteed"
    ];
    for (const f of forbidden) {
      expect(ready.toLowerCase()).not.toContain(f.toLowerCase());
    }
  });
});

/**
 * F65, as a property rather than a string pin.
 *
 * The defect was never one bad sentence: it was ONE screen asserting a shaping instruction near the
 * top and denying any model-visible change forty lines later, with the settings file the same command
 * had just written agreeing with the top half. So the guard is stated against the artifact: whatever
 * `--connect 1` puts in `settings.json` is what the whole screen must say, everywhere it speaks.
 *
 * Deliberately separate from the exact-wording pins above. A pin and a property in one `it` report the
 * string failure first, which can leave the property silently dead.
 */
describe("compaction init --connect 1: the screen and the settings file it wrote agree", () => {
  it("shaping ON: the screen names the attached instruction and nowhere denies a model-visible change", async () => {
    const { stdout, code } = await runInit(["--connect", "1"]);
    expect(code).toBe(0);
    const settings = readFileSync(join(dir, ".claude", "settings.json"), "utf8");
    // Precondition: this really is the shaping-ON state, per the file Claude Code will read.
    expect(settings).toContain("--shape-prompt-hook");

    const ready = stdout.slice(stdout.indexOf("Compaction is ready."));
    expect(ready).toContain("Output shaping: on");
    expect(ready).toContain("Your input is not compacted or edited.");
    // The collapsed claim is absent from the ENTIRE run, not merely from the ready section.
    expect(stdout).not.toContain("nothing the model sees is mutated.");
    expect(stdout).not.toContain("Record-only - your input is not compacted or edited.");
    expect(stdout).not.toContain("Nothing is ever changed without your explicit authorization.");
  });

  /**
   * The state that separates "the hook is on disk" from "the hook attaches something": connect with
   * shaping ON (the entry is written), then re-run with the kill-switch thrown. The entry is still
   * there, so a detection that only read the settings file would keep claiming shaping after the user
   * had switched it off.
   */
  it("hook on disk but the kill-switch thrown: the ready screen drops back to record-only", async () => {
    await runInit(["--connect", "1"]);
    expect(readFileSync(join(dir, ".claude", "settings.json"), "utf8")).toContain("--shape-prompt-hook");

    const { stdout, code } = await runInit(["--connect", "1"], { COMPACTION_SHAPING_HOOKS: "0" });
    expect(code).toBe(0);
    // The entry survives - this is a runtime suppression, not an uninstall.
    expect(readFileSync(join(dir, ".claude", "settings.json"), "utf8")).toContain("--shape-prompt-hook");
    const ready = stdout.slice(stdout.indexOf("Compaction is ready."));
    expect(ready).toContain("Record-only - your input is not compacted or edited.");
    expect(ready).not.toContain("Output shaping: on");
  });

  it("shaping OFF: no hook is written, and no surface claims an instruction is attached", async () => {
    const { stdout, code } = await runInit(["--connect", "1"], { COMPACTION_SHAPING_HOOKS: "0" });
    expect(code).toBe(0);
    const settings = readFileSync(join(dir, ".claude", "settings.json"), "utf8");
    expect(settings).not.toContain("--shape-prompt-hook");

    const ready = stdout.slice(stdout.indexOf("Compaction is ready."));
    expect(ready).toContain("Record-only - your input is not compacted or edited.");
    expect(stdout).not.toContain("Output shaping: on");
    expect(stdout).not.toContain("is attached before each shapeable turn");
    expect(stdout).not.toContain("nothing the model sees is mutated.");
  });
});
