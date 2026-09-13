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

async function run(args: string[], opts: { env?: NodeJS.ProcessEnv; input?: string; cwd?: string } = {}) {
  const child = execFileAsync("node", [CLI, ...args], {
    env: { ...process.env, HOME: home, ...opts.env },
    ...(opts.cwd ? { cwd: opts.cwd } : {})
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

  it("--dry-run writes nothing and describes the Stop line only when settled evidence is recorded", async () => {
    const settings = join(home, "custom-codex-hooks.json");
    const { stdout } = await run(["hooks", "install", "--tool", "codex", "--dry-run", "--settings", settings]);
    expect(stdout).toContain("--dry-run");
    expect(stdout).toContain("Stop line:       compaction hooks line codex  (settled evidence only when recorded; otherwise no message)");
    expect(stdout).not.toMatch(/per-turn line:.*after each turn/);
    expect(await exists(codexConfig())).toBe(false);
    expect(await exists(settings)).toBe(false);
  });

  it("the compiled line-command help makes the empty-evidence outcome explicit", async () => {
    const { stdout } = await run(["hooks", "line", "--help"]);
    const normalized = stdout.replace(/\s+/g, " ");
    expect(normalized).toContain("returns settled content-free receipt evidence as `systemMessage` when recorded");
    expect(normalized).toContain("otherwise returns no message");
    expect(normalized).not.toContain("returns the content-free per-turn receipt line");
    expect(normalized).not.toContain("this is how Codex gets the line");
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
  // Codex 0.153 supplies exact lifecycle identity on UserPromptSubmit. The hook now validates that
  // identity before opening a run or persisting a shaping decision; prompt-only stdin is not a real
  // Codex hook artifact and must fail closed.
  const codexPrompt = (prompt = "fix the failing test in utils.ts") => JSON.stringify({
    session_id: "11111111-1111-4111-8111-111111111111",
    turn_id: "22222222-2222-4222-8222-222222222222",
    cwd: home,
    hook_event_name: "UserPromptSubmit",
    prompt
  });
  // Kill-switch env for the disabled case.
  const OFF = { COMPACTION_SHAPING_HOOKS: "0" } as NodeJS.ProcessEnv;
  // Default-ON: explicitly clear the flag so a set env var in the runner does not contaminate the assertion.
  const DEFAULT = { COMPACTION_SHAPING_HOOKS: "" } as NodeJS.ProcessEnv;

  it("Codex emits NOTHING when the kill-switch is thrown (COMPACTION_SHAPING_HOOKS=0)", async () => {
    const { stdout } = await run(["hooks", "shape", "codex"], { env: OFF, input: codexPrompt() });
    expect(stdout).toBe("");
  });

  it("Codex emits the additionalContext JSON by default (auto-apply)", async () => {
    const { stdout } = await run(["hooks", "shape", "codex"], { env: DEFAULT, input: codexPrompt() });
    const parsed = JSON.parse(stdout);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("Output-shaping policy");
  });

  it("Codex UserPromptSubmit → Stop emits one settled full-turn line that watch replays byte-identically", async () => {
    const sessionId = "33333333-3333-4333-8333-333333333333";
    const turnId = "44444444-4444-4444-8444-444444444444";
    const configDir = join(home, "config");
    const rollout = join(home, "rollout.jsonl");
    const usage = {
      input_tokens: 427,
      cached_input_tokens: 200,
      cache_write_input_tokens: 0,
      output_tokens: 41,
      reasoning_output_tokens: 10,
      total_tokens: 468
    };
    await writeFile(rollout, `${JSON.stringify({
      ordinal: 9,
      timestamp: "2026-09-04T07:39:18.350Z",
      type: "token_usage_record",
      payload: {
        thread_id: sessionId,
        session_id: sessionId,
        turn_id: turnId,
        root_turn_id: turnId,
        response_id: "fixture-response",
        usage: { ...usage, input_tokens: 9_999, output_tokens: 9_999 },
        turn_token_usage: usage,
        thread_token_usage: { ...usage, input_tokens: 8_888, output_tokens: 8_888 }
      }
    })}\n`, "utf8");
    const env = { ...DEFAULT, COMPACTION_CONFIG_DIR: configDir };
    const prompt = JSON.stringify({
      session_id: sessionId,
      turn_id: turnId,
      cwd: home,
      hook_event_name: "UserPromptSubmit",
      prompt: "fix the failing test"
    });
    const shaped = await run(["hooks", "shape", "codex"], { env, input: prompt });
    expect(JSON.parse(shaped.stdout).hookSpecificOutput.additionalContext).toContain("Output-shaping policy");

    const stop = JSON.stringify({
      session_id: sessionId,
      turn_id: turnId,
      transcript_path: rollout,
      cwd: home,
      hook_event_name: "Stop",
      model: "gpt-5.6-sol",
      last_assistant_message: "SECRET assistant fixture"
    });
    const stopped = await run(["hooks", "line", "codex"], { env, input: stop });
    const systemMessage = JSON.parse(stopped.stdout).systemMessage as string;
    expect(systemMessage).toBe("compaction · observed input 427 · output N/A→41 (N/A%, est.) · basic shaping");
    expect(systemMessage).not.toMatch(/recording|reporting|47%/);

    const watched = await run(["watch", "--once"], { env, cwd: home });
    expect(watched.stdout.split("\n")).toContain(systemMessage);
  });

  it("Codex HOLDS a planning turn even when active-by-default (critical safety property)", async () => {
    const { stdout } = await run(["hooks", "shape", "codex"], {
      env: DEFAULT,
      input: codexPrompt("help me decide the architecture and weigh the trade-offs")
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
      input: codexPrompt(`refactor with token ${secret}`)
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
