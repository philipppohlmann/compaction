import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * End-to-end via the built CLI: the SUBSCRIPTION output-shaping loop for Claude Code.
 *  - `capture claude-code --shape-prompt-hook` injects additionalContext on a shapeable turn, holds a
 *    planning turn, holds when stopped / kill-switched, and is fail-open (exit 0 always).
 *  - `compaction stop` / `compaction start` toggle the persisted state the hook honors.
 *  - `compaction savings` is honest: unavailable-until-measured without an artifact, never a fabricated %.
 *  - `compaction init --connect claude-code` installs the before-call SHAPING hook alongside the Stop hook.
 * Uses a tmp HOME + COMPACTION_CONFIG_DIR so it never touches real settings/state.
 */
const execFileAsync = promisify(execFile);
const CLI = resolve("dist/cli/index.js");

let home: string;
let configDir: string;

async function run(args: string[], opts: { env?: NodeJS.ProcessEnv; input?: string } = {}) {
  const child = execFileAsync("node", [CLI, ...args], {
    env: { ...process.env, HOME: home, COMPACTION_CONFIG_DIR: configDir, ...opts.env }
  });
  child.child.stdin?.end(opts.input ?? "");
  return child;
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "cc-shape-home-"));
  configDir = join(home, ".compaction");
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const shapeablePrompt = JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "fix the failing test in utils.ts", cwd: "/x" });
const planningPrompt = JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "help me decide the architecture and weigh the trade-offs", cwd: "/x" });

describe("capture claude-code --shape-prompt-hook", () => {
  it("injects hookSpecificOutput.additionalContext on a shapeable turn (exit 0)", async () => {
    const { stdout } = await run(["capture", "claude-code", "--shape-prompt-hook"], { input: shapeablePrompt });
    const parsed = JSON.parse(stdout);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("Output-shaping policy");
  });

  it("HOLDS (no stdout) on a planning turn", async () => {
    const { stdout } = await run(["capture", "claude-code", "--shape-prompt-hook"], { input: planningPrompt });
    expect(stdout.trim()).toBe("");
  });

  it("HOLDS (no stdout) when the env kill-switch is thrown", async () => {
    const { stdout } = await run(["capture", "claude-code", "--shape-prompt-hook"], {
      input: shapeablePrompt,
      env: { COMPACTION_SHAPING_HOOKS: "0" }
    });
    expect(stdout.trim()).toBe("");
  });

  it("fail-open: malformed stdin → no stdout, exit 0", async () => {
    const { stdout } = await run(["capture", "claude-code", "--shape-prompt-hook"], { input: "not json {{{" });
    expect(stdout.trim()).toBe("");
  });
});

describe("compaction stop / start toggle the persisted state the hook honors", () => {
  it("stop → the shaping hook holds; start → it shapes again", async () => {
    const stop = await run(["stop"]);
    expect(stop.stdout).toMatch(/output shaping[\s\S]*(is|are) now off/i);

    const heldWhenStopped = await run(["capture", "claude-code", "--shape-prompt-hook"], { input: shapeablePrompt });
    expect(heldWhenStopped.stdout.trim()).toBe(""); // stopped → holds

    const start = await run(["start"]);
    expect(start.stdout).toMatch(/output shaping[\s\S]*(is|are) now on/i);

    const shapedAgain = await run(["capture", "claude-code", "--shape-prompt-hook"], { input: shapeablePrompt });
    expect(JSON.parse(shapedAgain.stdout).hookSpecificOutput.additionalContext).toContain("Output-shaping policy");
  });

  it("stop is idempotent (second stop reports no change)", async () => {
    await run(["stop"]);
    const again = await run(["stop"]);
    expect(again.stdout).toMatch(/already off/i);
  });

  it("stop/start name BOTH levers when the API-key path is present (shaping + apply routing)", async () => {
    const stop = await run(["stop"], { env: { ANTHROPIC_API_KEY: "sk-ant-fake-test-key" } });
    expect(stop.stdout).toMatch(/apply routing/i); // both levers named
    expect(stop.stdout).toMatch(/nothing is applied/i);
    const start = await run(["start"], { env: { ANTHROPIC_API_KEY: "sk-ant-fake-test-key" } });
    expect(start.stdout).toMatch(/apply routing/i);
  });

  it("on a subscription (no API key) stop names OUTPUT SHAPING ONLY and says so honestly", async () => {
    // Pin the key OFF so the copy honestly reports the subscription-only lever set.
    const stop = await run(["stop"], { env: { ANTHROPIC_API_KEY: "" } });
    expect(stop.stdout).toMatch(/only the output-shaping lever/i);
    expect(stop.stdout).not.toMatch(/AND Claude Code apply routing are now OFF/i);
  });
});

describe("compaction savings - honest, no fabricated %", () => {
  it("without an artifact: unavailable-until-measured (never a %)", async () => {
    const { stdout } = await run(["savings"]);
    expect(stdout).toMatch(/unavailable-until-measured/i);
    expect(stdout).not.toMatch(/\d+(\.\d+)?%/); // no percentage is invented
  });
});

describe("compaction init --connect claude-code installs the before-call SHAPING hook", () => {
  it("wires the shaping hook alongside the Stop hook in project .claude/settings.json", async () => {
    // Run in a fresh tmp cwd so the project settings land under it, not the repo.
    const projectCwd = await mkdtemp(join(tmpdir(), "cc-shape-proj-"));
    try {
      await execFileAsync("node", [CLI, "init", "--connect", "claude-code", "--static"], {
        env: { ...process.env, HOME: home, COMPACTION_CONFIG_DIR: configDir },
        cwd: projectCwd
      });
      const settings = JSON.parse(await readFile(join(projectCwd, ".claude", "settings.json"), "utf8"));
      const upsCmds = (settings.hooks.UserPromptSubmit ?? []).flatMap((g: { hooks: { command: string }[] }) =>
        g.hooks.map((h) => h.command)
      );
      expect(upsCmds.some((c: string) => c.includes("--shape-prompt-hook"))).toBe(true);
      // The Stop measurement hook is still there too.
      const stopCmds = (settings.hooks.Stop ?? []).flatMap((g: { hooks: { command: string }[] }) => g.hooks.map((h) => h.command));
      expect(stopCmds.some((c: string) => c.includes("--from-hook"))).toBe(true);
    } finally {
      await rm(projectCwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
});
