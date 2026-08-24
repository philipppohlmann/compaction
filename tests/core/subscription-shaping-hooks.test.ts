import { describe, expect, it } from "vitest";
import {
  installCodexShapingHook,
  uninstallCodexShapingHook,
  hasCodexShapingHook,
  installCursorShapingHook,
  uninstallCursorShapingHook,
  hasCursorShapingHook,
  isCompactionShapingHookCommand,
  shapingHookCommand,
  CODEX_SHAPING_HOOK_TIMEOUT_SECONDS,
  CURSOR_HOOKS_SCHEMA_VERSION,
  type CodexHooksConfig,
  type CursorHooksConfig
} from "../../src/core/subscription-shaping-hooks.js";

/**
 * Codex + Cursor native shaping-hook config merge (public, pure). Invariants: merge-not-replace (never
 * clobber existing config/hooks), idempotent install, uninstall removes ONLY Compaction's own hook, and
 * the two tools' hooks never collide.
 */

describe("shaping hook command identity", () => {
  it("matches ours per tool, not others, and never cross-matches codex vs cursor", () => {
    expect(isCompactionShapingHookCommand(shapingHookCommand("codex"), "codex")).toBe(true);
    expect(isCompactionShapingHookCommand(shapingHookCommand("cursor"), "cursor")).toBe(true);
    // cross-tool: a codex command is not a cursor hook and vice versa
    expect(isCompactionShapingHookCommand(shapingHookCommand("codex"), "cursor")).toBe(false);
    expect(isCompactionShapingHookCommand(shapingHookCommand("cursor"), "codex")).toBe(false);
    // third-party command that merely mentions "hooks shape" is NOT ours (lacks "compaction")
    expect(isCompactionShapingHookCommand("other-tool hooks shape codex", "codex")).toBe(false);
    expect(isCompactionShapingHookCommand(undefined, "codex")).toBe(false);
  });

  /**
   * A FOREIGN COMMAND THAT CONTAINS OUR WORDS IS NOT OUR COMMAND.
   *
   * The matcher used to require three SUBSTRINGS ("compaction", "hooks shape", the tool). Every
   * command that wraps ours satisfies all three — `echo compaction hooks shape cursor` is the
   * reproduction Codex ran — so uninstall claimed a hook the user wrote and deleted it, while this
   * module's own contract says every foreign entry survives. The install/uninstall path only ever
   * writes a command it produced itself, so an EXACT comparison is both sufficient and the only safe
   * rule; it is the same rule `isCompactionTurnLineHookCommand` (codex-turn-line-hook.ts) already uses.
   */
  it("a foreign command that merely WRAPS ours is not ours (exact match, not substrings)", () => {
    for (const tool of ["codex", "cursor"] as const) {
      expect(isCompactionShapingHookCommand(`echo ${shapingHookCommand(tool)}`, tool)).toBe(false);
      expect(isCompactionShapingHookCommand(`${shapingHookCommand(tool)} && rm -rf /tmp/x`, tool)).toBe(false);
      expect(isCompactionShapingHookCommand(`my-wrapper --run "compaction hooks shape ${tool}"`, tool)).toBe(false);
    }
  });

  it("tolerates surrounding whitespace on a hand-edited config (same rule as the Stop-hook matcher)", () => {
    expect(isCompactionShapingHookCommand(`  ${shapingHookCommand("codex")}  `, "codex")).toBe(true);
  });
});

describe("installCodexShapingHook - merge-not-replace + idempotent (UserPromptSubmit)", () => {
  it("adds the hook to empty config with the verified nested shape + timeout", () => {
    const r = installCodexShapingHook({});
    expect(r.changed).toBe(true);
    const entry = r.config.hooks?.UserPromptSubmit?.[0].hooks?.[0];
    expect(entry?.type).toBe("command");
    expect(entry?.command).toBe(shapingHookCommand("codex"));
    expect(entry?.timeout).toBe(CODEX_SHAPING_HOOK_TIMEOUT_SECONDS);
  });

  it("preserves an existing unrelated UserPromptSubmit hook (another tool)", () => {
    const existing: CodexHooksConfig = { hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "other-tool --x" }] }] } };
    const r = installCodexShapingHook(existing);
    expect(r.config.hooks?.UserPromptSubmit).toHaveLength(2);
    expect(r.config.hooks?.UserPromptSubmit?.[0].hooks?.[0].command).toBe("other-tool --x");
  });

  it("preserves unrelated top-level keys", () => {
    const existing = { schema: "x", hooks: { OtherEvent: [] } } as unknown as CodexHooksConfig;
    const r = installCodexShapingHook(existing);
    expect((r.config as Record<string, unknown>).schema).toBe("x");
    expect(r.config.hooks?.OtherEvent).toEqual([]);
  });

  it("is idempotent - installing twice leaves exactly one Compaction hook", () => {
    const once = installCodexShapingHook({});
    const twice = installCodexShapingHook(once.config);
    expect(twice.changed).toBe(false);
    expect(twice.alreadyPresent).toBe(true);
    const count = (twice.config.hooks?.UserPromptSubmit ?? [])
      .flatMap((g) => g.hooks ?? [])
      .filter((h) => isCompactionShapingHookCommand(h.command, "codex")).length;
    expect(count).toBe(1);
  });

  it("does not mutate the input object", () => {
    const input: CodexHooksConfig = {};
    installCodexShapingHook(input);
    expect(input.hooks).toBeUndefined();
  });

  it("refuses malformed config rather than clobber", () => {
    expect(() => installCodexShapingHook({ hooks: "oops" } as unknown as CodexHooksConfig)).toThrow(/malformed/);
    expect(() => installCodexShapingHook({ hooks: { UserPromptSubmit: { x: 1 } } } as unknown as CodexHooksConfig)).toThrow(/malformed/);
  });
});

describe("uninstallCodexShapingHook - removes only Compaction's hook", () => {
  it("removes ours and cleans up empty containers", () => {
    const installed = installCodexShapingHook({}).config;
    const r = uninstallCodexShapingHook(installed);
    expect(r.changed).toBe(true);
    expect(r.removedCount).toBe(1);
    expect(r.config.hooks).toBeUndefined();
    expect(hasCodexShapingHook(r.config)).toBe(false);
  });

  it("preserves another tool's hook while removing ours", () => {
    const base: CodexHooksConfig = { hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "other-tool run" }] }] } };
    const installed = installCodexShapingHook(base).config;
    const r = uninstallCodexShapingHook(installed);
    expect(r.removedCount).toBe(1);
    expect(r.config.hooks?.UserPromptSubmit?.[0].hooks?.[0].command).toBe("other-tool run");
  });

  it("no-op when ours is absent", () => {
    expect(uninstallCodexShapingHook({}).changed).toBe(false);
    expect(uninstallCodexShapingHook({ hooks: { UserPromptSubmit: [{ hooks: [{ command: "x" }] }] } }).changed).toBe(false);
  });

  /** A user's own command that WRAPS ours is theirs; uninstall must not touch it. */
  it("a foreign `echo compaction hooks shape codex` entry SURVIVES uninstall (removedCount 0)", () => {
    const foreign = "echo compaction hooks shape codex";
    const config: CodexHooksConfig = { hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: foreign }] }] } };
    const r = uninstallCodexShapingHook(config);
    expect(r.removedCount).toBe(0);
    expect(r.changed).toBe(false);
    expect(r.config.hooks?.UserPromptSubmit?.[0].hooks?.[0].command).toBe(foreign);
  });

  it("and OUR real entry still uninstalls while that foreign entry stays", () => {
    const foreign = "echo compaction hooks shape codex";
    const base: CodexHooksConfig = { hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: foreign }] }] } };
    const installed = installCodexShapingHook(base).config;
    const r = uninstallCodexShapingHook(installed);
    expect(r.removedCount).toBe(1);
    expect(hasCodexShapingHook(r.config)).toBe(false);
    expect(r.config.hooks?.UserPromptSubmit?.[0].hooks?.[0].command).toBe(foreign);
  });
});

describe("installCursorShapingHook - merge-not-replace + idempotent (sessionStart, session-level)", () => {
  it("adds the flat hook to empty config and sets the schema version", () => {
    const r = installCursorShapingHook({});
    expect(r.changed).toBe(true);
    expect(r.config.version).toBe(CURSOR_HOOKS_SCHEMA_VERSION);
    expect(r.config.hooks?.sessionStart?.[0].command).toBe(shapingHookCommand("cursor"));
    // Cursor entries are FLAT, no inner hooks array / no type.
    expect((r.config.hooks?.sessionStart?.[0] as Record<string, unknown>).hooks).toBeUndefined();
  });

  it("never overwrites an existing version", () => {
    const r = installCursorShapingHook({ version: 2 });
    expect(r.config.version).toBe(2);
  });

  it("preserves an existing unrelated sessionStart hook", () => {
    const existing: CursorHooksConfig = { version: 1, hooks: { sessionStart: [{ command: "other --x" }] } };
    const r = installCursorShapingHook(existing);
    expect(r.config.hooks?.sessionStart).toHaveLength(2);
    expect(r.config.hooks?.sessionStart?.[0].command).toBe("other --x");
  });

  it("is idempotent", () => {
    const once = installCursorShapingHook({});
    const twice = installCursorShapingHook(once.config);
    expect(twice.changed).toBe(false);
    expect(twice.config.hooks?.sessionStart?.length).toBe(1);
  });

  it("refuses malformed config rather than clobber", () => {
    expect(() => installCursorShapingHook({ hooks: "oops" } as unknown as CursorHooksConfig)).toThrow(/malformed/);
    expect(() => installCursorShapingHook({ hooks: { sessionStart: { x: 1 } } } as unknown as CursorHooksConfig)).toThrow(/malformed/);
  });
});

describe("uninstallCursorShapingHook - removes only Compaction's hook", () => {
  it("removes ours and cleans up, preserving another tool's hook", () => {
    const mixed = installCursorShapingHook({ hooks: { sessionStart: [{ command: "other --x" }] } });
    const r = uninstallCursorShapingHook(mixed.config);
    expect(r.removedCount).toBe(1);
    expect(hasCursorShapingHook(r.config)).toBe(false);
    expect(r.config.hooks?.sessionStart?.[0].command).toBe("other --x");
  });

  it("no-op when ours is absent", () => {
    expect(uninstallCursorShapingHook({}).changed).toBe(false);
  });

  /** The exact command Codex reproduced `removedCount: 1` with. It is the user's, and it must survive. */
  it("a foreign `echo compaction hooks shape cursor` entry SURVIVES uninstall (removedCount 0)", () => {
    const foreign = "echo compaction hooks shape cursor";
    const config: CursorHooksConfig = { version: 1, hooks: { sessionStart: [{ command: foreign }] } };
    const r = uninstallCursorShapingHook(config);
    expect(r.removedCount).toBe(0);
    expect(r.changed).toBe(false);
    expect(r.config.hooks?.sessionStart?.[0].command).toBe(foreign);
  });

  it("and OUR real entry still uninstalls while that foreign entry stays", () => {
    const foreign = "echo compaction hooks shape cursor";
    const installed = installCursorShapingHook({ version: 1, hooks: { sessionStart: [{ command: foreign }] } }).config;
    const r = uninstallCursorShapingHook(installed);
    expect(r.removedCount).toBe(1);
    expect(hasCursorShapingHook(r.config)).toBe(false);
    expect(r.config.hooks?.sessionStart?.[0].command).toBe(foreign);
  });
});
