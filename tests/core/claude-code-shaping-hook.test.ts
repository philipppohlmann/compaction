import { describe, expect, it } from "vitest";
import {
  CLAUDE_CODE_HOOK_COMMAND,
  CLAUDE_CODE_BEFORE_CALL_HOOK_COMMAND,
  CLAUDE_CODE_SHAPING_HOOK_COMMAND,
  installStopHook,
  installBeforeCallHook,
  installShapingHook,
  isCompactionHookCommand,
  isCompactionBeforeCallHookCommand,
  isCompactionShapingHookCommand,
  hasCompactionShapingHook,
  hasCompactionStopHook,
  hasCompactionBeforeCallHook,
  uninstallShapingHook,
  uninstallStopHook,
  type ClaudeSettings
} from "../../src/core/claude-code-hooks.js";

/**
 * Claude Code before-call SHAPING hook merge (the subscription apply lever). Invariants: merge-not-clobber,
 * idempotent, DISTINCT identity from the Stop + recommendation hooks (uninstall removes ONLY ours), and all
 * three hooks coexist without collision.
 */
describe("installShapingHook - merge-not-clobber + idempotent (UserPromptSubmit)", () => {
  it("adds our shaping hook while preserving a user's own UserPromptSubmit hook and other settings", () => {
    const input: ClaudeSettings = {
      model: "opus",
      hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "user-own-prompt-hook" }] }] }
    };
    const { settings, changed } = installShapingHook(input);
    expect(changed).toBe(true);
    expect(settings.model).toBe("opus"); // untouched
    const cmds = settings.hooks!.UserPromptSubmit!.flatMap((g) => (g.hooks ?? []).map((h) => h.command));
    expect(cmds).toContain("user-own-prompt-hook"); // never clobbered
    expect(cmds).toContain(CLAUDE_CODE_SHAPING_HOOK_COMMAND);
    expect(hasCompactionShapingHook(settings)).toBe(true);
  });

  it("is idempotent - installing twice does not duplicate", () => {
    const once = installShapingHook({});
    const twice = installShapingHook(once.settings);
    expect(twice.changed).toBe(false);
    expect(twice.alreadyPresent).toBe(true);
    const cmds = twice.settings.hooks!.UserPromptSubmit!.flatMap((g) => (g.hooks ?? []).map((h) => h.command));
    expect(cmds.filter((c) => c === CLAUDE_CODE_SHAPING_HOOK_COMMAND)).toHaveLength(1);
  });
});

describe("hook identity - shaping vs recommendation vs Stop NEVER collide", () => {
  it("each identity matches only its own command", () => {
    expect(isCompactionShapingHookCommand(CLAUDE_CODE_SHAPING_HOOK_COMMAND)).toBe(true);
    expect(isCompactionShapingHookCommand(CLAUDE_CODE_BEFORE_CALL_HOOK_COMMAND)).toBe(false);
    expect(isCompactionShapingHookCommand(CLAUDE_CODE_HOOK_COMMAND)).toBe(false);

    // The recommendation + Stop identities must NOT match the shaping command.
    expect(isCompactionBeforeCallHookCommand(CLAUDE_CODE_SHAPING_HOOK_COMMAND)).toBe(false);
    expect(isCompactionHookCommand(CLAUDE_CODE_SHAPING_HOOK_COMMAND)).toBe(false);
  });

  it("all three hooks coexist on UserPromptSubmit/Stop and each `has…` sees exactly its own", () => {
    let s = installStopHook({}).settings;
    s = installBeforeCallHook(s).settings;
    s = installShapingHook(s).settings;
    expect(hasCompactionStopHook(s)).toBe(true);
    expect(hasCompactionBeforeCallHook(s)).toBe(true);
    expect(hasCompactionShapingHook(s)).toBe(true);
  });
});

describe("uninstallShapingHook - removes ONLY the shaping hook", () => {
  it("removes our shaping hook but leaves the recommendation hook, Stop hook, and user hooks intact", () => {
    let s: ClaudeSettings = {
      hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "user-own-prompt-hook" }] }] }
    };
    s = installStopHook(s).settings;
    s = installBeforeCallHook(s).settings;
    s = installShapingHook(s).settings;

    const { settings, changed, removedCount } = uninstallShapingHook(s);
    expect(changed).toBe(true);
    expect(removedCount).toBe(1);
    expect(hasCompactionShapingHook(settings)).toBe(false);
    // The other Compaction hooks + the user's own survive.
    expect(hasCompactionBeforeCallHook(settings)).toBe(true);
    expect(hasCompactionStopHook(settings)).toBe(true);
    const cmds = settings.hooks!.UserPromptSubmit!.flatMap((g) => (g.hooks ?? []).map((h) => h.command));
    expect(cmds).toContain("user-own-prompt-hook");
  });

  it("removing ours does NOT touch the Stop hook and vice versa (independent identities)", () => {
    const s = installShapingHook(installStopHook({}).settings).settings;
    const afterStopRemoval = uninstallStopHook(s).settings;
    expect(hasCompactionShapingHook(afterStopRemoval)).toBe(true); // shaping survives Stop removal
    expect(hasCompactionStopHook(afterStopRemoval)).toBe(false);
  });
});
