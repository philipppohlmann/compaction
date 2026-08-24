/**
 * Connect-once installer for the Claude Code before-call SHAPING hook (the subscription apply lever).
 * Proves: fresh install verifies by re-read, idempotent, merge-not-clobber (a user's own hooks + the Stop
 * hook survive), disconnect removes ONLY ours, and a shaping install never disturbs the Stop hook. All
 * tmp-dir scoped; never touches the real ~/.claude.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  connectClaudeCodeHook,
  connectClaudeCodeShapingHook,
  disconnectClaudeCodeShapingHook,
  isShapingHookInstalled
} from "../../src/core/claude-code-connect.js";
import {
  CLAUDE_CODE_SHAPING_HOOK_COMMAND,
  hasCompactionShapingHook,
  hasCompactionStopHook
} from "../../src/core/claude-code-hooks.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cc-connect-shaping-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("connectClaudeCodeShapingHook", () => {
  it("fresh install writes the shaping hook and VERIFIES it by re-reading", async () => {
    const settingsPath = join(dir, ".claude", "settings.json");
    const result = await connectClaudeCodeShapingHook({ settingsPath });
    expect(result.status).toBe("installed");
    expect(result.verified).toBe(true);
    const onDisk = JSON.parse(await readFile(settingsPath, "utf8"));
    expect(hasCompactionShapingHook(onDisk)).toBe(true);
    const cmds = onDisk.hooks.UserPromptSubmit.flatMap((g: { hooks: { command: string }[] }) => g.hooks.map((h) => h.command));
    expect(cmds).toContain(CLAUDE_CODE_SHAPING_HOOK_COMMAND);
    expect(await isShapingHookInstalled(settingsPath)).toBe(true);
  });

  it("idempotent: a second connect is already-present, no duplicate entry", async () => {
    const settingsPath = join(dir, ".claude", "settings.json");
    await connectClaudeCodeShapingHook({ settingsPath });
    const again = await connectClaudeCodeShapingHook({ settingsPath });
    expect(again.status).toBe("already-present");
    expect(again.verified).toBe(true);
    const onDisk = JSON.parse(await readFile(settingsPath, "utf8"));
    const shapingEntries = onDisk.hooks.UserPromptSubmit.flatMap((g: { hooks: { command: string }[] }) => g.hooks.map((h) => h.command)).filter(
      (c: string) => c === CLAUDE_CODE_SHAPING_HOOK_COMMAND
    );
    expect(shapingEntries).toHaveLength(1);
  });

  it("merge-not-clobber: preserves a user's own UserPromptSubmit hook and other settings", async () => {
    const settingsPath = join(dir, ".claude", "settings.json");
    await mkdir(join(dir, ".claude"), { recursive: true });
    await writeFile(
      settingsPath,
      JSON.stringify({
        model: "some-model",
        hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "user-own --run" }] }] }
      }),
      "utf8"
    );
    const result = await connectClaudeCodeShapingHook({ settingsPath });
    expect(result.status).toBe("installed");
    const onDisk = JSON.parse(await readFile(settingsPath, "utf8"));
    expect(onDisk.model).toBe("some-model");
    const cmds = onDisk.hooks.UserPromptSubmit.flatMap((g: { hooks: { command: string }[] }) => g.hooks.map((h) => h.command));
    expect(cmds).toContain("user-own --run");
    expect(cmds).toContain(CLAUDE_CODE_SHAPING_HOOK_COMMAND);
  });

  it("coexists with the Stop hook: connecting shaping does not disturb an existing Stop hook", async () => {
    const settingsPath = join(dir, ".claude", "settings.json");
    await connectClaudeCodeHook({ settingsPath }); // Stop hook first
    await connectClaudeCodeShapingHook({ settingsPath });
    const onDisk = JSON.parse(await readFile(settingsPath, "utf8"));
    expect(hasCompactionStopHook(onDisk)).toBe(true);
    expect(hasCompactionShapingHook(onDisk)).toBe(true);
  });

  it("dry-run writes nothing", async () => {
    const settingsPath = join(dir, ".claude", "settings.json");
    const result = await connectClaudeCodeShapingHook({ settingsPath, dryRun: true });
    expect(result.status).toBe("dry-run");
    expect(result.verified).toBe(false);
    await expect(readFile(settingsPath, "utf8")).rejects.toThrow(); // nothing written
  });
});

describe("disconnectClaudeCodeShapingHook - removes ONLY ours", () => {
  it("removes the shaping hook but leaves the Stop hook and a user's own hook intact", async () => {
    const settingsPath = join(dir, ".claude", "settings.json");
    await mkdir(join(dir, ".claude"), { recursive: true });
    await writeFile(
      settingsPath,
      JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "user-own --run" }] }] } }),
      "utf8"
    );
    await connectClaudeCodeHook({ settingsPath }); // Stop hook
    await connectClaudeCodeShapingHook({ settingsPath }); // shaping hook

    const removed = await disconnectClaudeCodeShapingHook(settingsPath);
    expect(removed.removed).toBe(true);
    const onDisk = JSON.parse(await readFile(settingsPath, "utf8"));
    expect(hasCompactionShapingHook(onDisk)).toBe(false);
    expect(hasCompactionStopHook(onDisk)).toBe(true); // Stop hook untouched
    const cmds = onDisk.hooks.UserPromptSubmit.flatMap((g: { hooks: { command: string }[] }) => g.hooks.map((h) => h.command));
    expect(cmds).toContain("user-own --run"); // user's own untouched
  });

  it("a missing file is a safe no-op (removed:false), never throws", async () => {
    const result = await disconnectClaudeCodeShapingHook(join(dir, "nope", "settings.json"));
    expect(result.removed).toBe(false);
  });
});
