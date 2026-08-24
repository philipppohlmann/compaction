/**
 * Connect-once installer for the Claude Code Stop hook. Proves the
 * VERIFY-AFTER-INSTALL contract: a "connected" claim rests ONLY on a re-read that finds the hook;
 * a malformed/unwritable settings file is reported honestly (never a false success). All tmp-dir
 * scoped, never touches the real ~/.claude.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectClaudeCodeHook } from "../../src/core/claude-code-connect.js";
import { hasCompactionStopHook } from "../../src/core/claude-code-hooks.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cc-connect-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("connectClaudeCodeHook", () => {
  it("fresh install writes the hook and VERIFIES it by re-reading (status installed, verified true)", async () => {
    const settingsPath = join(dir, ".claude", "settings.json");
    const result = await connectClaudeCodeHook({ settingsPath });
    expect(result.status).toBe("installed");
    expect(result.verified).toBe(true);
    // The file on disk really carries the hook.
    const onDisk = JSON.parse(await readFile(settingsPath, "utf8"));
    expect(hasCompactionStopHook(onDisk)).toBe(true);
    expect(onDisk.hooks.Stop[0].hooks[0].command).toBe("compaction capture claude-code --from-hook");
  });

  it("idempotent: a second connect is already-present, still verified, no duplicate entry", async () => {
    const settingsPath = join(dir, ".claude", "settings.json");
    await connectClaudeCodeHook({ settingsPath });
    const again = await connectClaudeCodeHook({ settingsPath });
    expect(again.status).toBe("already-present");
    expect(again.verified).toBe(true);
    const onDisk = JSON.parse(await readFile(settingsPath, "utf8"));
    expect(onDisk.hooks.Stop).toHaveLength(1);
  });

  it("merge-not-replace: preserves other hooks and settings", async () => {
    const settingsPath = join(dir, ".claude", "settings.json");
    await mkdir(join(dir, ".claude"), { recursive: true });
    await writeFile(
      settingsPath,
      JSON.stringify({
        model: "some-model",
        hooks: { Stop: [{ hooks: [{ type: "command", command: "other-tool --run" }] }] }
      }),
      "utf8"
    );
    const result = await connectClaudeCodeHook({ settingsPath });
    expect(result.status).toBe("installed");
    const onDisk = JSON.parse(await readFile(settingsPath, "utf8"));
    expect(onDisk.model).toBe("some-model"); // untouched
    const commands = onDisk.hooks.Stop.flatMap((g: { hooks: Array<{ command: string }> }) => g.hooks.map((h) => h.command));
    expect(commands).toContain("other-tool --run"); // preserved
    expect(commands).toContain("compaction capture claude-code --from-hook"); // added
  });

  it("--dry-run writes NOTHING but shows what would be written (verified false)", async () => {
    const settingsPath = join(dir, ".claude", "settings.json");
    const result = await connectClaudeCodeHook({ settingsPath, dryRun: true });
    expect(result.status).toBe("dry-run");
    expect(result.verified).toBe(false);
    expect(result.wouldWrite).toBeDefined();
    // Nothing on disk.
    await expect(readFile(settingsPath, "utf8")).rejects.toThrow();
  });

  it("malformed settings → status error, verified FALSE, nothing written (never claims connected)", async () => {
    const settingsPath = join(dir, ".claude", "settings.json");
    await mkdir(join(dir, ".claude"), { recursive: true });
    // hooks.Stop is a string, not an array, installStopHook refuses to clobber it.
    await writeFile(settingsPath, JSON.stringify({ hooks: { Stop: "not-an-array" } }), "utf8");
    const result = await connectClaudeCodeHook({ settingsPath });
    expect(result.status).toBe("error");
    expect(result.verified).toBe(false);
    expect(result.error).toBeTruthy();
    // The malformed file is left exactly as it was (not clobbered).
    const onDisk = JSON.parse(await readFile(settingsPath, "utf8"));
    expect(onDisk.hooks.Stop).toBe("not-an-array");
  });
});
