/**
 * Claude Code BEFORE-CALL recommendation, end-to-end via the REAL built-from-source
 * CLI, entirely in a tmp cwd, on synthetic prompts (no real session content).
 *
 * The UserPromptSubmit hook runs `capture claude-code --from-prompt-hook` BEFORE the model call. This
 * asserts the honest contract: a content-free `claude_code` before-call RECOMMENDATION lands in
 * `compaction activity`; the hook is SILENT (writes nothing to stdout, on UserPromptSubmit a hook's
 * stdout would be injected into the model context); it is recommendation-only (apply is a proven blocker
 * on this surface) and NEVER the Stop-hook path; malformed/no-avoidable input records nothing (fail-open).
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const CLI = resolve("dist/cli/index.js");

const BLOCK = "SHARED CONTEXT BLOCK long enough to clear the duplicate size floor here for sure.";
const SECRET = "SECRET_CC_PROMPT_zeta_must_not_appear";
const dupPrompt = `${BLOCK}\n\ndo the task with ${SECRET}, concisely.\n\n${BLOCK}`;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cc-before-call-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function cli(args: string[], input?: string): { stdout: string; stderr: string; code: number } {
  const res = spawnSync("node", [CLI, ...args], {
    cwd: dir,
    encoding: "utf8",
    ...(input !== undefined ? { input } : {})
  });
  return { stdout: res.stdout ?? "", stderr: res.stderr ?? "", code: res.status ?? 0 };
}

function promptPayload(prompt: string): string {
  return JSON.stringify({ session_id: "cc-bc-1", cwd: dir, hook_event_name: "UserPromptSubmit", prompt });
}

function activityRaw(): string {
  const p = join(dir, ".compaction", "activity", "activity.jsonl");
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}

describe("capture claude-code --from-prompt-hook (before-call recommendation, e2e)", () => {
  it("avoidable context → ONE content-free claude_code before-call event; SILENT stdout; exit 0", async () => {
    const r = cli(["capture", "claude-code", "--from-prompt-hook"], promptPayload(dupPrompt));
    expect(r.code).toBe(0);
    // SILENT: nothing on stdout (UserPromptSubmit hook stdout would be injected into the model context).
    expect(r.stdout.trim()).toBe("");

    const raw = await readFile(join(dir, ".compaction", "activity", "activity.jsonl"), "utf8");
    const lines = raw.trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    const event = JSON.parse(lines[0]);
    expect(event.surface).toBe("claude_code");
    expect(event.token_source.input.source).toBe("local-estimate");
    expect(event.token_source.output.source).toBe("unavailable");
    expect(event.input_before).toBeGreaterThan(event.input_after);
    expect(event.approval_status).toBe("not-required");
    expect(event.auto_apply.applied_automatically).toBe(false);
    expect(event.session_id).toBe("cc-bc-1");

    // Genuine BEFORE-CALL surface (UserPromptSubmit), explicitly NOT a Stop-hook fake; apply is blocked.
    expect(raw).toContain("UserPromptSubmit");
    expect(raw).toContain("NOT the post-session Stop hook");
    expect(raw).toContain("before-call APPLY is UNAVAILABLE on Claude Code hooks");
    // honest labels + content-free
    expect(raw).toContain("NOT a saving");
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain("SHARED CONTEXT BLOCK");
  });

  it("no avoidable context → NO event, NO stdout, exit 0 (honest no-op)", () => {
    const r = cli(["capture", "claude-code", "--from-prompt-hook"], promptPayload("one small unique instruction, nothing repeated"));
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("");
    expect(activityRaw()).toBe("");
  });

  it("malformed payload → NO event, exit 0 (fail-open, never breaks Claude Code)", () => {
    const r = cli(["capture", "claude-code", "--from-prompt-hook"], "this is not json at all");
    expect(r.code).toBe(0);
    expect(activityRaw()).toBe("");
  });

  it("a Stop payload (no prompt) on the before-call path records NOTHING (fail-closed parse)", () => {
    const stop = JSON.stringify({ session_id: "s", transcript_path: "/x.jsonl", hook_event_name: "Stop" });
    const r = cli(["capture", "claude-code", "--from-prompt-hook"], stop);
    expect(r.code).toBe(0);
    expect(activityRaw()).toBe("");
  });
});

describe("hooks install --before-call / uninstall (settings merge)", () => {
  it("installs BOTH the Stop and UserPromptSubmit hooks; uninstall removes both, preserving other settings", async () => {
    const settingsPath = join(dir, ".claude", "settings.json");
    const install = cli(["hooks", "install", "--before-call", "--settings", settingsPath]);
    expect(install.code).toBe(0);
    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    const stopCmd = settings.hooks.Stop[0].hooks[0].command;
    const upsCmd = settings.hooks.UserPromptSubmit[0].hooks[0].command;
    expect(stopCmd).toContain("--from-hook");
    expect(upsCmd).toContain("--from-prompt-hook");

    const uninstall = cli(["hooks", "uninstall", "--settings", settingsPath]);
    expect(uninstall.code).toBe(0);
    const after = JSON.parse(await readFile(settingsPath, "utf8"));
    // both Compaction hooks gone; the hooks object is cleaned up (nothing of ours dangling)
    expect(after.hooks?.Stop).toBeUndefined();
    expect(after.hooks?.UserPromptSubmit).toBeUndefined();
  });

  it("plain `hooks install` (no flag) installs ONLY the Stop hook (before-call is opt-in)", async () => {
    const settingsPath = join(dir, ".claude", "settings.json");
    cli(["hooks", "install", "--settings", settingsPath]);
    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    expect(settings.hooks.Stop).toBeDefined();
    expect(settings.hooks.UserPromptSubmit).toBeUndefined();
  });
});

/**
 * `compaction hooks uninstall` IS THE REAL REMOVAL PATH for all four Compaction entries (Stop,
 * before-call, shaping, status line), and it promises to preserve everything else. Each matcher used
 * to identify "ours" by SUBSTRINGS, so a user's own entry that merely WRAPPED our command was
 * deleted by the command they ran to remove Compaction's — the Claude Code half of the defect #884
 * fixed for Codex/Cursor. These drive the real CLI end to end, not the matcher units.
 */
describe("hooks uninstall removes ONLY the entries Compaction itself wrote", () => {
  const OURS = {
    stop: "compaction capture claude-code --from-hook",
    beforeCall: "compaction capture claude-code --from-prompt-hook",
    shaping: "compaction capture claude-code --shape-prompt-hook",
    statusLine: "compaction statusline"
  };
  const FOREIGN = {
    stop: `echo ${OURS.stop} >> /tmp/mylog`,
    beforeCall: `my-wrapper ${OURS.beforeCall}`,
    shaping: `sh -c "${OURS.shaping}"`,
    statusLine: `my-status.sh && ${OURS.statusLine}`
  };

  function writeSettings(settingsPath: string, settings: unknown): void {
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  }

  const commandsOn = (settings: { hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>> }, event: string): Array<string | undefined> =>
    (settings.hooks?.[event] ?? []).flatMap((g) => g.hooks ?? []).map((h) => h.command);

  it("removes all four of ours while every foreign wrapper survives byte-identical", async () => {
    const settingsPath = join(dir, ".claude", "settings.json");
    writeSettings(settingsPath, {
      permissions: { allow: ["Bash(git *)"] },
      statusLine: { type: "command", command: FOREIGN.statusLine },
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: FOREIGN.stop }] }, { hooks: [{ type: "command", command: OURS.stop }] }],
        UserPromptSubmit: [
          { hooks: [{ type: "command", command: FOREIGN.beforeCall }] },
          { hooks: [{ type: "command", command: OURS.beforeCall }] },
          { hooks: [{ type: "command", command: FOREIGN.shaping }] },
          { hooks: [{ type: "command", command: OURS.shaping }] }
        ]
      }
    });

    const r = cli(["hooks", "uninstall", "--settings", settingsPath]);
    expect(r.code).toBe(0);

    const after = JSON.parse(await readFile(settingsPath, "utf8"));
    // Exactly the three hooks Compaction wrote are gone; exactly the user's three remain, in order.
    expect(commandsOn(after, "Stop")).toEqual([FOREIGN.stop]);
    expect(commandsOn(after, "UserPromptSubmit")).toEqual([FOREIGN.beforeCall, FOREIGN.shaping]);
    // The status line is the user's wrapper, untouched (it occupies the single slot; ours was never there).
    expect(after.statusLine).toEqual({ type: "command", command: FOREIGN.statusLine });
    // Unrelated settings preserved, as this command promises.
    expect(after.permissions).toEqual({ allow: ["Bash(git *)"] });
  });

  it("a settings file holding ONLY foreign wrappers is left byte-identical", async () => {
    const settingsPath = join(dir, ".claude", "settings.json");
    const settings = {
      statusLine: { type: "command", command: FOREIGN.statusLine },
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: FOREIGN.stop }] }],
        UserPromptSubmit: [{ hooks: [{ type: "command", command: FOREIGN.shaping }] }]
      }
    };
    writeSettings(settingsPath, settings);
    const before = readFileSync(settingsPath, "utf8");

    const r = cli(["hooks", "uninstall", "--settings", settingsPath]);
    expect(r.code).toBe(0);
    expect(readFileSync(settingsPath, "utf8")).toBe(before);
  });

  it("...and says plainly that no Compaction hooks were present", () => {
    const settingsPath = join(dir, ".claude", "settings.json");
    writeSettings(settingsPath, { hooks: { Stop: [{ hooks: [{ type: "command", command: FOREIGN.stop }] }] } });
    expect(cli(["hooks", "uninstall", "--settings", settingsPath]).stdout).toContain("No Compaction hooks present");
  });

  it("install adds OURS beside a foreign wrapper instead of skipping (measurement really starts)", async () => {
    const settingsPath = join(dir, ".claude", "settings.json");
    writeSettings(settingsPath, { hooks: { Stop: [{ hooks: [{ type: "command", command: FOREIGN.stop }] }] } });

    const r = cli(["hooks", "install", "--before-call", "--settings", settingsPath]);
    expect(r.code).toBe(0);

    const after = JSON.parse(await readFile(settingsPath, "utf8"));
    expect(commandsOn(after, "Stop")).toEqual([FOREIGN.stop, OURS.stop]);
    expect(commandsOn(after, "UserPromptSubmit")).toEqual([OURS.beforeCall]);
  });
});
