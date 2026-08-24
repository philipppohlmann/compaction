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
  hasCompactionStopHook,
  hasCompactionBeforeCallHook,
  hasCompactionShapingHook,
  uninstallStopHook,
  uninstallBeforeCallHook,
  uninstallShapingHook,
  type ClaudeSettings
} from "../../src/core/claude-code-hooks.js";

/**
 * Claude Code Stop-hook settings merge (public). Invariants: merge-not-replace (never clobber existing
 * settings/hooks), idempotent install, and uninstall that removes ONLY Compaction's own hook.
 */
describe("installStopHook - merge-not-replace + idempotent", () => {
  it("adds the Stop hook to empty settings", () => {
    const r = installStopHook({});
    expect(r.changed).toBe(true);
    expect(r.settings.hooks?.Stop?.[0].hooks?.[0].command).toBe(CLAUDE_CODE_HOOK_COMMAND);
  });

  it("preserves existing unrelated settings (permissions, other keys)", () => {
    const existing: ClaudeSettings = { permissions: { allow: ["Bash(git *)"] }, model: "opus" };
    const r = installStopHook(existing);
    expect(r.settings.permissions).toEqual({ allow: ["Bash(git *)"] });
    expect(r.settings.model).toBe("opus");
    expect(r.settings.hooks?.Stop).toHaveLength(1);
  });

  it("preserves an existing unrelated Stop hook (another tool)", () => {
    const existing: ClaudeSettings = { hooks: { Stop: [{ hooks: [{ type: "command", command: "other-tool --do-thing" }] }] } };
    const r = installStopHook(existing);
    expect(r.settings.hooks?.Stop).toHaveLength(2);
    expect(r.settings.hooks?.Stop?.[0].hooks?.[0].command).toBe("other-tool --do-thing");
    expect(r.settings.hooks?.Stop?.[1].hooks?.[0].command).toBe(CLAUDE_CODE_HOOK_COMMAND);
  });

  it("is idempotent - installing twice leaves exactly one Compaction hook", () => {
    const once = installStopHook({});
    const twice = installStopHook(once.settings);
    expect(twice.changed).toBe(false);
    expect(twice.alreadyPresent).toBe(true);
    const count = (twice.settings.hooks?.Stop ?? []).flatMap((g) => g.hooks ?? []).filter((h) => isCompactionHookCommand(h.command)).length;
    expect(count).toBe(1);
  });

  it("does not mutate the input object", () => {
    const input: ClaudeSettings = { permissions: { allow: [] } };
    installStopHook(input);
    expect(input.hooks).toBeUndefined();
  });

  it("refuses to modify malformed settings rather than clobber (hooks not an object)", () => {
    expect(() => installStopHook({ hooks: "oops" } as unknown as ClaudeSettings)).toThrow(/malformed/);
  });

  it("refuses to modify malformed settings (hooks.Stop not an array)", () => {
    expect(() => installStopHook({ hooks: { Stop: { command: "x" } } } as unknown as ClaudeSettings)).toThrow(/malformed/);
  });
});

describe("uninstallStopHook - removes only Compaction's hook", () => {
  it("removes the Compaction Stop hook and cleans up empty containers", () => {
    const installed = installStopHook({}).settings;
    const r = uninstallStopHook(installed);
    expect(r.changed).toBe(true);
    expect(r.removedCount).toBe(1);
    expect(r.settings.hooks).toBeUndefined(); // emptied hooks object removed
  });

  it("preserves another tool's Stop hook while removing ours", () => {
    const base: ClaudeSettings = { hooks: { Stop: [{ hooks: [{ type: "command", command: "other-tool run" }] }] } };
    const installed = installStopHook(base).settings;
    const r = uninstallStopHook(installed);
    expect(r.removedCount).toBe(1);
    expect(r.settings.hooks?.Stop).toHaveLength(1);
    expect(r.settings.hooks?.Stop?.[0].hooks?.[0].command).toBe("other-tool run");
  });

  it("no-op when Compaction's hook is absent", () => {
    const base: ClaudeSettings = { hooks: { Stop: [{ hooks: [{ type: "command", command: "other-tool run" }] }] } };
    const r = uninstallStopHook(base);
    expect(r.changed).toBe(false);
    expect(r.removedCount).toBe(0);
  });

  it("no-op on settings with no hooks", () => {
    const r = uninstallStopHook({ permissions: { allow: [] } });
    expect(r.changed).toBe(false);
  });
});

describe("isCompactionHookCommand", () => {
  it("matches the Compaction Claude Code hook command, not others", () => {
    expect(isCompactionHookCommand("compaction capture claude-code --from-hook")).toBe(true);
    expect(isCompactionHookCommand("other-tool --from-hook")).toBe(false);
    expect(isCompactionHookCommand("compaction capture codex")).toBe(false);
    // a third-party command that merely mentions the substrings is NOT ours (lacks "compaction")
    expect(isCompactionHookCommand("some-other-tool capture claude-code blah --from-hook")).toBe(false);
    expect(isCompactionHookCommand(undefined)).toBe(false);
  });
});

/**
 * Before-call (UserPromptSubmit) hook, the pre-call surface. Installs on a DIFFERENT event than
 * the Stop (measurement) hook, and its identity must NEVER collide with the Stop hook's.
 */
describe("installBeforeCallHook - merge-not-replace + idempotent (UserPromptSubmit)", () => {
  it("adds the before-call hook to the UserPromptSubmit event (not Stop)", () => {
    const r = installBeforeCallHook({});
    expect(r.changed).toBe(true);
    expect(r.settings.hooks?.UserPromptSubmit?.[0].hooks?.[0].command).toBe(CLAUDE_CODE_BEFORE_CALL_HOOK_COMMAND);
    expect(r.settings.hooks?.Stop).toBeUndefined(); // never touches Stop
  });

  it("coexists with the Stop hook - both install on their own events, neither disturbs the other", () => {
    const withStop = installStopHook({});
    const both = installBeforeCallHook(withStop.settings);
    expect(hasCompactionStopHook(both.settings)).toBe(true);
    expect(hasCompactionBeforeCallHook(both.settings)).toBe(true);
    expect(both.settings.hooks?.Stop?.[0].hooks?.[0].command).toBe(CLAUDE_CODE_HOOK_COMMAND);
    expect(both.settings.hooks?.UserPromptSubmit?.[0].hooks?.[0].command).toBe(CLAUDE_CODE_BEFORE_CALL_HOOK_COMMAND);
  });

  it("is idempotent", () => {
    const once = installBeforeCallHook({});
    const twice = installBeforeCallHook(once.settings);
    expect(twice.changed).toBe(false);
    expect(twice.settings.hooks?.UserPromptSubmit?.length).toBe(1);
  });

  it("preserves an existing unrelated UserPromptSubmit hook (another tool)", () => {
    const other: ClaudeSettings = { hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "other-tool --check" }] }] } };
    const r = installBeforeCallHook(other);
    expect(r.settings.hooks?.UserPromptSubmit?.length).toBe(2);
    expect(r.settings.hooks?.UserPromptSubmit?.some((g) => g.hooks?.some((h) => h.command === "other-tool --check"))).toBe(true);
  });
});

describe("hook identity - before-call vs Stop NEVER collide", () => {
  it("the two identity predicates are mutually exclusive on both commands", () => {
    // The Stop command is NOT matched as before-call, and the before-call command is NOT matched as Stop.
    expect(isCompactionHookCommand(CLAUDE_CODE_HOOK_COMMAND)).toBe(true);
    expect(isCompactionBeforeCallHookCommand(CLAUDE_CODE_HOOK_COMMAND)).toBe(false);
    expect(isCompactionBeforeCallHookCommand(CLAUDE_CODE_BEFORE_CALL_HOOK_COMMAND)).toBe(true);
    // CRITICAL: "--from-hook" must NOT substring-match the before-call command "--from-prompt-hook".
    expect(isCompactionHookCommand(CLAUDE_CODE_BEFORE_CALL_HOOK_COMMAND)).toBe(false);
  });
});

describe("uninstallBeforeCallHook - removes only Compaction's before-call hook", () => {
  it("removes ours and cleans up, preserving the Stop hook", () => {
    const both = installBeforeCallHook(installStopHook({}).settings);
    const r = uninstallBeforeCallHook(both.settings);
    expect(r.changed).toBe(true);
    expect(hasCompactionBeforeCallHook(r.settings)).toBe(false);
    expect(hasCompactionStopHook(r.settings)).toBe(true); // Stop untouched
  });

  it("preserves another tool's UserPromptSubmit hook while removing ours", () => {
    const mixed = installBeforeCallHook({
      hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "other-tool --check" }] }] }
    });
    const r = uninstallBeforeCallHook(mixed.settings);
    expect(r.settings.hooks?.UserPromptSubmit?.some((g) => g.hooks?.some((h) => h.command === "other-tool --check"))).toBe(true);
    expect(hasCompactionBeforeCallHook(r.settings)).toBe(false);
  });

  it("no-op when our before-call hook is absent", () => {
    expect(uninstallBeforeCallHook({}).changed).toBe(false);
    expect(uninstallBeforeCallHook({ hooks: { Stop: [] } }).changed).toBe(false);
  });
});

/**
 * A FOREIGN COMMAND THAT CONTAINS OUR WORDS IS NOT OUR COMMAND — the Claude Code half of the defect
 * #884 fixed for `subscription-shaping-hooks.ts` and explicitly left out of scope there.
 *
 * All three hook matchers used to require three SUBSTRINGS ("compaction" + "capture claude-code" +
 * the flag). Every wrapper below satisfies all three, so a user's own entry was indistinguishable
 * from ours: install/connect SKIPPED (measurement never started) and uninstall — the path
 * `compaction hooks uninstall` and `init --disconnect 1` run — DELETED the user's entry while
 * claiming to remove only Compaction's. Install writes only a command it produced itself, so the
 * only safe identity is exact equality on the trimmed command.
 */
describe("hook command identity is EXACT, not a set of substrings", () => {
  const MATCHERS = [
    { name: "Stop", command: CLAUDE_CODE_HOOK_COMMAND, isOurs: isCompactionHookCommand },
    { name: "before-call", command: CLAUDE_CODE_BEFORE_CALL_HOOK_COMMAND, isOurs: isCompactionBeforeCallHookCommand },
    { name: "shaping", command: CLAUDE_CODE_SHAPING_HOOK_COMMAND, isOurs: isCompactionShapingHookCommand }
  ] as const;

  for (const { name, command, isOurs } of MATCHERS) {
    it(`${name}: the exact command is ours, and surrounding whitespace is tolerated`, () => {
      expect(isOurs(command)).toBe(true);
      expect(isOurs(`  ${command}\n`)).toBe(true);
    });

    it(`${name}: a command that merely WRAPS or CONTAINS ours is NOT ours`, () => {
      expect(isOurs(`echo ${command} >> /tmp/mylog`)).toBe(false);
      expect(isOurs(`my-wrapper ${command}`)).toBe(false);
      expect(isOurs(`${command} && rm -rf /tmp/x`)).toBe(false);
      expect(isOurs(`sh -c "${command}"`)).toBe(false);
    });
  }

  it("the three hook identities stay mutually exclusive under exact matching", () => {
    for (const { command, isOurs } of MATCHERS) {
      const matching = MATCHERS.filter((m) => m.isOurs(command));
      expect(matching).toHaveLength(1);
      expect(isOurs(command)).toBe(true);
    }
  });
});

/**
 * INSTALL MUST NOT SKIP BEHIND A FOREIGN WRAPPER. Under the substring rule a user's own
 * `echo compaction capture claude-code --from-hook >> /tmp/mylog` made `installStopHook` report
 * `alreadyPresent`, so the connect flow claimed Compaction was wired while nothing of ours had been
 * written and no session was ever measured.
 */
describe("install adds OUR hook even when a foreign wrapper is present", () => {
  const FOREIGN_STOP = `echo ${CLAUDE_CODE_HOOK_COMMAND} >> /tmp/mylog`;
  const FOREIGN_BEFORE_CALL = `my-wrapper ${CLAUDE_CODE_BEFORE_CALL_HOOK_COMMAND}`;
  const FOREIGN_SHAPING = `my-wrapper ${CLAUDE_CODE_SHAPING_HOOK_COMMAND}`;

  it("Stop: adds ours beside the wrapper instead of reporting already-present", () => {
    const base: ClaudeSettings = { hooks: { Stop: [{ hooks: [{ type: "command", command: FOREIGN_STOP }] }] } };
    const r = installStopHook(base);
    expect(r.alreadyPresent).toBe(false);
    expect(r.changed).toBe(true);
    expect(hasCompactionStopHook(r.settings)).toBe(true);
    const commands = (r.settings.hooks?.Stop ?? []).flatMap((g) => g.hooks ?? []).map((h) => h.command);
    expect(commands).toEqual([FOREIGN_STOP, CLAUDE_CODE_HOOK_COMMAND]);
  });

  it("before-call: adds ours beside the wrapper", () => {
    const base: ClaudeSettings = { hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: FOREIGN_BEFORE_CALL }] }] } };
    const r = installBeforeCallHook(base);
    expect(r.alreadyPresent).toBe(false);
    expect(hasCompactionBeforeCallHook(r.settings)).toBe(true);
    const commands = (r.settings.hooks?.UserPromptSubmit ?? []).flatMap((g) => g.hooks ?? []).map((h) => h.command);
    expect(commands).toEqual([FOREIGN_BEFORE_CALL, CLAUDE_CODE_BEFORE_CALL_HOOK_COMMAND]);
  });

  it("shaping: adds ours beside the wrapper", () => {
    const base: ClaudeSettings = { hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: FOREIGN_SHAPING }] }] } };
    const r = installShapingHook(base);
    expect(r.alreadyPresent).toBe(false);
    expect(hasCompactionShapingHook(r.settings)).toBe(true);
    const commands = (r.settings.hooks?.UserPromptSubmit ?? []).flatMap((g) => g.hooks ?? []).map((h) => h.command);
    expect(commands).toEqual([FOREIGN_SHAPING, CLAUDE_CODE_SHAPING_HOOK_COMMAND]);
  });

  it("installing ours twice on top of a wrapper still leaves exactly one of ours (idempotent)", () => {
    const base: ClaudeSettings = { hooks: { Stop: [{ hooks: [{ type: "command", command: FOREIGN_STOP }] }] } };
    const once = installStopHook(base);
    const twice = installStopHook(once.settings);
    expect(twice.changed).toBe(false);
    expect(twice.alreadyPresent).toBe(true);
    const ours = (twice.settings.hooks?.Stop ?? []).flatMap((g) => g.hooks ?? []).filter((h) => isCompactionHookCommand(h.command));
    expect(ours).toHaveLength(1);
  });
});

/**
 * ONE IDENTITY GOVERNS INSTALL, DETECTION, IDEMPOTENCY, AND REMOVAL.
 *
 * The install functions used to accept a caller-supplied command while the matchers recognized only the
 * canonical constant. Installing anything else produced an entry no matcher could see: the `has*`
 * predicate stayed false, so every repeat install appended ANOTHER duplicate and uninstall removed zero
 * of them. The override is gone — install writes the canonical command and nothing else — so the four
 * operations cannot disagree. This is the round trip they must all agree on.
 */
describe("install, detection, idempotency, and uninstall share ONE identity", () => {
  const SURFACES = [
    {
      name: "Stop",
      event: "Stop",
      command: CLAUDE_CODE_HOOK_COMMAND,
      install: installStopHook,
      has: hasCompactionStopHook,
      uninstall: uninstallStopHook
    },
    {
      name: "before-call",
      event: "UserPromptSubmit",
      command: CLAUDE_CODE_BEFORE_CALL_HOOK_COMMAND,
      install: installBeforeCallHook,
      has: hasCompactionBeforeCallHook,
      uninstall: uninstallBeforeCallHook
    },
    {
      name: "shaping",
      event: "UserPromptSubmit",
      command: CLAUDE_CODE_SHAPING_HOOK_COMMAND,
      install: installShapingHook,
      has: hasCompactionShapingHook,
      uninstall: uninstallShapingHook
    }
  ] as const;

  const commandsOn = (settings: ClaudeSettings, event: "Stop" | "UserPromptSubmit") =>
    ((event === "Stop" ? settings.hooks?.Stop : settings.hooks?.UserPromptSubmit) ?? [])
      .flatMap((g) => g.hooks ?? [])
      .map((h) => h.command);

  for (const { name, event, command, install, has, uninstall } of SURFACES) {
    it(`${name}: what install writes is what detection recognizes`, () => {
      const r = install({});
      expect(r.changed).toBe(true);
      expect(has(r.settings)).toBe(true);
      expect(commandsOn(r.settings, event)).toEqual([command]);
    });

    it(`${name}: installing twice adds exactly one entry`, () => {
      const once = install({});
      const twice = install(once.settings);
      expect(twice.changed).toBe(false);
      expect(twice.alreadyPresent).toBe(true);
      expect(commandsOn(twice.settings, event)).toHaveLength(1);
    });

    it(`${name}: uninstall removes exactly the entry install wrote`, () => {
      const r = uninstall(install({}).settings);
      expect(r.removedCount).toBe(1);
      expect(r.changed).toBe(true);
      expect(has(r.settings)).toBe(false);
      expect(commandsOn(r.settings, event)).toEqual([]);
    });
  }
});

/**
 * UNINSTALL MUST NOT DELETE WHAT IT DID NOT WRITE. This is the data-loss direction of the same
 * defect: a command run to remove Compaction's own entries silently removed the user's.
 */
describe("uninstall removes ONLY ours and leaves a foreign wrapper byte-identical", () => {
  const FOREIGN_STOP = `echo ${CLAUDE_CODE_HOOK_COMMAND} >> /tmp/mylog`;
  const FOREIGN_BEFORE_CALL = `my-wrapper ${CLAUDE_CODE_BEFORE_CALL_HOOK_COMMAND}`;
  const FOREIGN_SHAPING = `sh -c "${CLAUDE_CODE_SHAPING_HOOK_COMMAND}"`;

  it("Stop: a wrapper ALONE survives untouched (removedCount 0, no change)", () => {
    const base: ClaudeSettings = { hooks: { Stop: [{ hooks: [{ type: "command", command: FOREIGN_STOP }] }] } };
    const r = uninstallStopHook(base);
    expect(r.removedCount).toBe(0);
    expect(r.changed).toBe(false);
    expect(r.settings.hooks?.Stop?.[0].hooks?.[0].command).toBe(FOREIGN_STOP);
  });

  it("Stop: ours is removed while the wrapper stays", () => {
    const base: ClaudeSettings = { hooks: { Stop: [{ hooks: [{ type: "command", command: FOREIGN_STOP }] }] } };
    const r = uninstallStopHook(installStopHook(base).settings);
    expect(r.removedCount).toBe(1);
    expect(hasCompactionStopHook(r.settings)).toBe(false);
    const commands = (r.settings.hooks?.Stop ?? []).flatMap((g) => g.hooks ?? []).map((h) => h.command);
    expect(commands).toEqual([FOREIGN_STOP]);
  });

  it("before-call: ours is removed while the wrapper stays", () => {
    const base: ClaudeSettings = { hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: FOREIGN_BEFORE_CALL }] }] } };
    const r = uninstallBeforeCallHook(installBeforeCallHook(base).settings);
    expect(r.removedCount).toBe(1);
    expect(hasCompactionBeforeCallHook(r.settings)).toBe(false);
    const commands = (r.settings.hooks?.UserPromptSubmit ?? []).flatMap((g) => g.hooks ?? []).map((h) => h.command);
    expect(commands).toEqual([FOREIGN_BEFORE_CALL]);
  });

  it("shaping: ours is removed while the wrapper stays", () => {
    const base: ClaudeSettings = { hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: FOREIGN_SHAPING }] }] } };
    const r = uninstallShapingHook(installShapingHook(base).settings);
    expect(r.removedCount).toBe(1);
    expect(hasCompactionShapingHook(r.settings)).toBe(false);
    const commands = (r.settings.hooks?.UserPromptSubmit ?? []).flatMap((g) => g.hooks ?? []).map((h) => h.command);
    expect(commands).toEqual([FOREIGN_SHAPING]);
  });
});
