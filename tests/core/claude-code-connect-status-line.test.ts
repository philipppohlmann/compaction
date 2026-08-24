import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  connectClaudeCodeStatusLine,
  disconnectClaudeCodeStatusLine,
  isStatusLineInstalled
} from "../../src/core/claude-code-connect.js";
import { CLAUDE_CODE_STATUS_LINE_COMMAND, type ClaudeSettings } from "../../src/core/claude-code-hooks.js";

/**
 * Onboarding status-line wiring (install-then-verify, single-slot-safe). Connecting Claude Code adds the
 * status line when absent, NEVER overwrites a user's own (guidance, not clobber), and disconnect removes
 * ONLY ours.
 */

let dir: string;
let settingsPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "connect-statusline-"));
  settingsPath = join(dir, "settings.json");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function readSettings(): Promise<ClaudeSettings> {
  return JSON.parse(await readFile(settingsPath, "utf8")) as ClaudeSettings;
}

describe("connectClaudeCodeStatusLine", () => {
  it("adds the status line when none exists, and verifies it landed", async () => {
    const r = await connectClaudeCodeStatusLine({ settingsPath });
    expect(r.status).toBe("installed");
    expect(r.verified).toBe(true);
    const settings = await readSettings();
    expect(settings.statusLine).toEqual({ type: "command", command: CLAUDE_CODE_STATUS_LINE_COMMAND });
    expect(await isStatusLineInstalled(settingsPath)).toBe(true);
  });

  it("is idempotent (already-present, verified) on a second connect", async () => {
    await connectClaudeCodeStatusLine({ settingsPath });
    const r = await connectClaudeCodeStatusLine({ settingsPath });
    expect(r.status).toBe("already-present");
    expect(r.verified).toBe(true);
  });

  it("preserves existing settings when adding (merge-not-replace)", async () => {
    const existing: ClaudeSettings = {
      permissions: { allow: ["Bash(git *)"] },
      hooks: { Stop: [{ hooks: [{ type: "command", command: "compaction capture claude-code --from-hook" }] }] }
    };
    await writeFile(settingsPath, JSON.stringify(existing, null, 2), "utf8");
    await connectClaudeCodeStatusLine({ settingsPath });
    const settings = await readSettings();
    expect(settings.permissions).toEqual({ allow: ["Bash(git *)"] });
    expect(settings.hooks?.Stop?.[0].hooks?.[0].command).toBe("compaction capture claude-code --from-hook");
    expect(settings.statusLine).toEqual({ type: "command", command: CLAUDE_CODE_STATUS_LINE_COMMAND });
  });

  it("does NOT overwrite a user's own status line (reports user-owned, writes nothing)", async () => {
    const userOwned: ClaudeSettings = { statusLine: { type: "command", command: "my-own-prompt.sh" } };
    await writeFile(settingsPath, JSON.stringify(userOwned, null, 2), "utf8");
    const r = await connectClaudeCodeStatusLine({ settingsPath });
    expect(r.status).toBe("user-owned");
    expect(r.verified).toBe(false);
    // The user's own status line is untouched on disk.
    const settings = await readSettings();
    expect(settings.statusLine).toEqual({ type: "command", command: "my-own-prompt.sh" });
  });

  it("--dry-run writes nothing", async () => {
    const r = await connectClaudeCodeStatusLine({ settingsPath, dryRun: true });
    expect(r.status).toBe("dry-run");
    await expect(readFile(settingsPath, "utf8")).rejects.toThrow();
  });
});

describe("disconnectClaudeCodeStatusLine", () => {
  it("removes ONLY Compaction's own status line", async () => {
    await connectClaudeCodeStatusLine({ settingsPath });
    const r = await disconnectClaudeCodeStatusLine(settingsPath);
    expect(r.removed).toBe(true);
    const settings = await readSettings();
    expect(settings.statusLine).toBeUndefined();
  });

  it("leaves a user's own status line untouched", async () => {
    const userOwned: ClaudeSettings = { statusLine: { type: "command", command: "my-own-prompt.sh" } };
    await writeFile(settingsPath, JSON.stringify(userOwned, null, 2), "utf8");
    const r = await disconnectClaudeCodeStatusLine(settingsPath);
    expect(r.removed).toBe(false);
    const settings = await readSettings();
    expect(settings.statusLine).toEqual({ type: "command", command: "my-own-prompt.sh" });
  });

  it("missing settings file → no-op (never throws)", async () => {
    const r = await disconnectClaudeCodeStatusLine(settingsPath);
    expect(r.removed).toBe(false);
  });
});
