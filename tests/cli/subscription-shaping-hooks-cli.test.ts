import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile, mkdir, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * `compaction hooks install/uninstall --tool codex|cursor` + `hooks shape <tool>` end-to-end via the built
 * CLI. Uses a tmp HOME so it NEVER touches a real ~/.codex or ~/.cursor. Asserts: merge-not-replace,
 * idempotent, dry-run writes nothing, uninstall removes only ours + backs up, and the runtime shape command
 * is AUTO-APPLY (default-ON) with a kill-switch (COMPACTION_SHAPING_HOOKS=0), holds planning turns, and is
 * content-free/fail-open.
 */
const execFileAsync = promisify(execFile);
const CLI = resolve("dist/cli/index.js");

let home: string;

async function run(args: string[], opts: { env?: NodeJS.ProcessEnv; input?: string } = {}) {
  const child = execFileAsync("node", [CLI, ...args], {
    env: { ...process.env, HOME: home, ...opts.env }
  });
  if (opts.input !== undefined) {
    child.child.stdin?.end(opts.input);
  } else {
    child.child.stdin?.end();
  }
  return child;
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "shaping-hooks-home-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("hooks install --tool codex", () => {
  const codexConfig = () => join(home, ".codex", "hooks.json");

  it("creates the config with the verified UserPromptSubmit nested shape", async () => {
    await run(["hooks", "install", "--tool", "codex"]);
    const cfg = JSON.parse(await readFile(codexConfig(), "utf8"));
    const entry = cfg.hooks.UserPromptSubmit[0].hooks[0];
    expect(entry.type).toBe("command");
    expect(entry.command).toBe("compaction hooks shape codex");
    expect(entry.timeout).toBe(10);
  });

  it("merges (preserves) a pre-existing unrelated hook and is idempotent", async () => {
    await mkdir(join(home, ".codex"), { recursive: true });
    await writeFile(
      codexConfig(),
      JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "other-tool --x" }] }] } })
    );
    await run(["hooks", "install", "--tool", "codex"]);
    let cfg = JSON.parse(await readFile(codexConfig(), "utf8"));
    expect(cfg.hooks.UserPromptSubmit).toHaveLength(2);
    expect(cfg.hooks.UserPromptSubmit[0].hooks[0].command).toBe("other-tool --x");
    // idempotent: a second install does not add a duplicate
    await run(["hooks", "install", "--tool", "codex"]);
    cfg = JSON.parse(await readFile(codexConfig(), "utf8"));
    expect(cfg.hooks.UserPromptSubmit).toHaveLength(2);
  });

  it("--dry-run writes nothing", async () => {
    const { stdout } = await run(["hooks", "install", "--tool", "codex", "--dry-run"]);
    expect(stdout).toContain("--dry-run");
    expect(await exists(codexConfig())).toBe(false);
  });

  it("uninstall removes only ours, backs up, preserves the other tool's hook", async () => {
    await mkdir(join(home, ".codex"), { recursive: true });
    await writeFile(
      codexConfig(),
      JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "other-tool --x" }] }] } })
    );
    await run(["hooks", "install", "--tool", "codex"]);
    await run(["hooks", "uninstall", "--tool", "codex"]);
    const cfg = JSON.parse(await readFile(codexConfig(), "utf8"));
    const commands = cfg.hooks.UserPromptSubmit.flatMap((g: { hooks: { command: string }[] }) => g.hooks.map((h) => h.command));
    expect(commands).toContain("other-tool --x");
    expect(commands).not.toContain("compaction hooks shape codex");
    expect(await exists(`${codexConfig()}.compaction.bak`)).toBe(true);
  });
});

describe("hooks install --tool cursor", () => {
  const cursorConfig = () => join(home, ".cursor", "hooks.json");

  it("creates the config with the session-level flat sessionStart shape + version", async () => {
    await run(["hooks", "install", "--tool", "cursor"]);
    const cfg = JSON.parse(await readFile(cursorConfig(), "utf8"));
    expect(cfg.version).toBe(1);
    expect(cfg.hooks.sessionStart[0].command).toBe("compaction hooks shape cursor");
    expect(cfg.hooks.sessionStart[0].hooks).toBeUndefined(); // FLAT entry
  });

  it("prints the honest session-level-only limit", async () => {
    const { stdout } = await run(["hooks", "install", "--tool", "cursor"]);
    expect(stdout.toLowerCase()).toContain("session-level only");
  });
});

describe("hooks shape <tool> runtime - auto-apply (default-ON), kill-switch, holds planning, content-free, fail-open", () => {
  const codexPrompt = JSON.stringify({ prompt: "fix the failing test in utils.ts" });
  // Kill-switch env for the disabled case.
  const OFF = { COMPACTION_SHAPING_HOOKS: "0" } as NodeJS.ProcessEnv;
  // Default-ON: explicitly clear the flag so a set env var in the runner does not contaminate the assertion.
  const DEFAULT = { COMPACTION_SHAPING_HOOKS: "" } as NodeJS.ProcessEnv;

  it("Codex emits NOTHING when the kill-switch is thrown (COMPACTION_SHAPING_HOOKS=0)", async () => {
    const { stdout } = await run(["hooks", "shape", "codex"], { env: OFF, input: codexPrompt });
    expect(stdout).toBe("");
  });

  it("Codex emits the additionalContext JSON by default (auto-apply)", async () => {
    const { stdout } = await run(["hooks", "shape", "codex"], { env: DEFAULT, input: codexPrompt });
    const parsed = JSON.parse(stdout);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("Output-shaping policy");
  });

  it("Codex HOLDS a planning turn even when active-by-default (critical safety property)", async () => {
    const { stdout } = await run(["hooks", "shape", "codex"], {
      env: DEFAULT,
      input: JSON.stringify({ prompt: "help me decide the architecture and weigh the trade-offs" })
    });
    expect(stdout).toBe("");
  });

  it("Cursor emits additional_context by default (auto-apply)", async () => {
    const { stdout } = await run(["hooks", "shape", "cursor"], {
      env: DEFAULT,
      input: JSON.stringify({ session_id: "s" })
    });
    const parsed = JSON.parse(stdout);
    expect(parsed.additional_context).toContain("Output-shaping policy");
  });

  it("content-free: a secret in the prompt never appears in the output (default-on)", async () => {
    const secret = "sk-fake-SECRET-cli-0xCAFE";
    const { stdout } = await run(["hooks", "shape", "codex"], {
      env: DEFAULT,
      input: JSON.stringify({ prompt: `refactor with token ${secret}` })
    });
    expect(stdout).not.toContain(secret);
  });

  it("fail-open: malformed stdin → emits nothing, exit 0 (default-on)", async () => {
    const { stdout } = await run(["hooks", "shape", "codex"], {
      env: DEFAULT,
      input: "not json {{{"
    });
    expect(stdout).toBe("");
  });
});
