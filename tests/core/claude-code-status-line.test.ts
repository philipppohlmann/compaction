import { describe, expect, it } from "vitest";
import {
  CLAUDE_CODE_STATUS_LINE_COMMAND,
  hasCompactionStatusLine,
  installStatusLine,
  isCompactionStatusLineCommand,
  uninstallStatusLine,
  type ClaudeSettings
} from "../../src/core/claude-code-hooks.js";

/**
 * Claude Code status-line settings merge (public). Claude Code's `statusLine` is a SINGLE slot (an
 * object, not an array), so the invariants differ from the hooks: add ONLY when absent, NEVER clobber a
 * user's own status line, idempotent, and removal that touches ONLY Compaction's own entry.
 */
describe("installStatusLine - single-slot, merge-not-replace", () => {
  it("adds the status line when none exists", () => {
    const r = installStatusLine({});
    expect(r.status).toBe("installed");
    expect(r.changed).toBe(true);
    expect(r.settings.statusLine).toEqual({ type: "command", command: CLAUDE_CODE_STATUS_LINE_COMMAND });
  });

  it("preserves all other settings when adding", () => {
    const existing: ClaudeSettings = {
      permissions: { allow: ["Bash(git *)"] },
      hooks: { Stop: [{ hooks: [{ type: "command", command: "compaction capture claude-code --from-hook" }] }] }
    };
    const r = installStatusLine(existing);
    expect(r.settings.permissions).toEqual({ allow: ["Bash(git *)"] });
    expect(r.settings.hooks?.Stop?.[0].hooks?.[0].command).toBe("compaction capture claude-code --from-hook");
  });

  it("is idempotent when ours is already present", () => {
    const first = installStatusLine({});
    const second = installStatusLine(first.settings);
    expect(second.status).toBe("already-present");
    expect(second.changed).toBe(false);
    // Same object reference back (no rewrite).
    expect(second.settings).toBe(first.settings);
  });

  it("does NOT overwrite a user's own status line (reports user-owned)", () => {
    const userOwned: ClaudeSettings = { statusLine: { type: "command", command: "my-own-prompt.sh" } };
    const r = installStatusLine(userOwned);
    expect(r.status).toBe("user-owned");
    expect(r.changed).toBe(false);
    expect(r.settings.statusLine).toEqual({ type: "command", command: "my-own-prompt.sh" });
  });
});

describe("uninstallStatusLine - removes ONLY ours", () => {
  it("removes Compaction's own status line", () => {
    const withOurs = installStatusLine({}).settings;
    const r = uninstallStatusLine(withOurs);
    expect(r.removed).toBe(true);
    expect(r.changed).toBe(true);
    expect(r.settings.statusLine).toBeUndefined();
  });

  it("leaves a user's own status line untouched", () => {
    const userOwned: ClaudeSettings = { statusLine: { type: "command", command: "my-own-prompt.sh" } };
    const r = uninstallStatusLine(userOwned);
    expect(r.removed).toBe(false);
    expect(r.changed).toBe(false);
    expect(r.settings.statusLine).toEqual({ type: "command", command: "my-own-prompt.sh" });
  });

  it("no status line present → no-op", () => {
    const r = uninstallStatusLine({ model: "opus" });
    expect(r.removed).toBe(false);
    expect(r.settings).toEqual({ model: "opus" });
  });
});

describe("status-line command identity", () => {
  it("matches our own command, not an arbitrary one", () => {
    expect(isCompactionStatusLineCommand(CLAUDE_CODE_STATUS_LINE_COMMAND)).toBe(true);
    expect(isCompactionStatusLineCommand("my-own-prompt.sh")).toBe(false);
    expect(isCompactionStatusLineCommand(undefined)).toBe(false);
  });

  it("tolerates surrounding whitespace on a hand-edited settings file", () => {
    expect(isCompactionStatusLineCommand(`  ${CLAUDE_CODE_STATUS_LINE_COMMAND}\n`)).toBe(true);
  });

  /**
   * A COMMAND THAT MERELY CONTAINS OURS IS THE USER'S, NOT OURS — the half of #884 left out of scope
   * there. This matcher used to test two substrings ("compaction" + "statusline"), which every wrapper
   * below satisfies. `statusLine` is a SINGLE slot, so the cost was the worst in the module: connect
   * reported `already-present` for a line we never wrote, and disconnect deleted the user's only
   * per-turn surface outright. The install path writes only `CLAUDE_CODE_STATUS_LINE_COMMAND`, so
   * anything else — including a launcher variant we never emit — belongs to the user.
   */
  it("a command that merely WRAPS or CONTAINS ours is NOT ours", () => {
    expect(isCompactionStatusLineCommand(`my-status && ${CLAUDE_CODE_STATUS_LINE_COMMAND}`)).toBe(false);
    expect(isCompactionStatusLineCommand(`${CLAUDE_CODE_STATUS_LINE_COMMAND} >> /tmp/mylog`)).toBe(false);
    expect(isCompactionStatusLineCommand("npx compaction statusline")).toBe(false);
    expect(isCompactionStatusLineCommand("echo compaction statusline")).toBe(false);
  });

  it("a wrapper in the single slot is user-owned on install and SURVIVES uninstall", () => {
    const wrapper = `my-status && ${CLAUDE_CODE_STATUS_LINE_COMMAND}`;
    const userOwned: ClaudeSettings = { statusLine: { type: "command", command: wrapper } };
    // Install must not claim the slot is already ours, and must not clobber it.
    const installed = installStatusLine(userOwned);
    expect(installed.status).toBe("user-owned");
    expect(installed.settings.statusLine).toEqual({ type: "command", command: wrapper });
    // Uninstall must leave it byte-identical.
    const removed = uninstallStatusLine(userOwned);
    expect(removed.removed).toBe(false);
    expect(removed.settings.statusLine).toEqual({ type: "command", command: wrapper });
  });

  /**
   * ONE IDENTITY GOVERNS INSTALL, DETECTION, IDEMPOTENCY, AND REMOVAL — the single-slot case, which
   * failed worst. `installStatusLine` used to accept a caller-supplied command while this matcher
   * recognized only the canonical constant, so a line installed with anything else was reported
   * `user-owned` on the next install and could never be removed: the slot was occupied by an entry
   * Compaction had written but no longer claimed. The override is gone, so the slot install fills is
   * always the slot detection and uninstall act on.
   */
  it("what install writes is what detection recognizes and uninstall removes", () => {
    const installed = installStatusLine({});
    expect(installed.status).toBe("installed");
    expect(installed.settings.statusLine?.command).toBe(CLAUDE_CODE_STATUS_LINE_COMMAND);
    expect(hasCompactionStatusLine(installed.settings)).toBe(true);

    const again = installStatusLine(installed.settings);
    expect(again.status).toBe("already-present");
    expect(again.changed).toBe(false);

    const removed = uninstallStatusLine(installed.settings);
    expect(removed.removed).toBe(true);
    expect(removed.settings.statusLine).toBeUndefined();
  });

  it("hasCompactionStatusLine reflects install state", () => {
    expect(hasCompactionStatusLine({})).toBe(false);
    expect(hasCompactionStatusLine(installStatusLine({}).settings)).toBe(true);
    expect(hasCompactionStatusLine({ statusLine: { type: "command", command: "other" } })).toBe(false);
  });
});
