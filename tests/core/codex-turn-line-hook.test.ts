/**
 * Codex per-turn line hook — the `Stop`/`systemMessage` surface.
 *
 * The premise is EMPIRICAL, verified against codex-cli 0.144.1 rather than assumed: `[tui] status_line`
 * accepts only an array of strings (Codex's own built-in segments) and rejects every command-shaped
 * form, so a status line is not available to us. The hook protocol IS: the event set includes `Stop`,
 * and the output schemas carry `systemMessage` (string, default null) — the user-facing channel, as
 * distinct from `additionalContext`, which injects into the model.
 *
 * Whether Codex RENDERS `systemMessage` is a dogfooding question, deliberately unvalidated here. These
 * tests pin the parts that are ours: the merge/uninstall discipline and the emitted JSON shape.
 */
import { describe, expect, it } from "vitest";
import {
  codexTurnLineCommand,
  codexTurnLineStdout,
  installCodexTurnLineHook,
  isCompactionTurnLineHookCommand,
  uninstallCodexTurnLineHook
} from "../../src/core/codex-turn-line-hook.js";
import type { CodexHooksConfig } from "../../src/core/subscription-shaping-hooks.js";

describe("codex per-turn line hook — emitted stdout", () => {
  it("wraps the line as systemMessage, and never sets suppressOutput", () => {
    const out = codexTurnLineStdout("compaction · output 512 · basic shaping");
    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(parsed.systemMessage).toBe("compaction · output 512 · basic shaping");
    // We are ASKING Codex to display this; suppressing it would defeat the whole surface.
    expect(parsed).not.toHaveProperty("suppressOutput");
  });

  it("emits an empty object when there is no honest line (never an empty message)", () => {
    for (const nothing of [undefined, "", "   "]) {
      expect(JSON.parse(codexTurnLineStdout(nothing))).toEqual({});
    }
  });

  it("emits valid JSON on one line, so a hook consumer can always parse it", () => {
    const out = codexTurnLineStdout("compaction · output 512");
    expect(out.endsWith("\n")).toBe(true);
    expect(out.trimEnd().includes("\n"), "must be a single line").toBe(false);
  });
});

describe("codex per-turn line hook — install/uninstall discipline", () => {
  it("merges onto hooks.Stop, preserving every other event and entry", () => {
    const existing: CodexHooksConfig = {
      model: "gpt-x",
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: "command", command: "someone-elses-hook" }] }],
        Stop: [{ hooks: [{ type: "command", command: "their-stop-hook" }] }]
      }
    };
    const { config, changed, alreadyPresent } = installCodexTurnLineHook(existing);
    expect(changed).toBe(true);
    expect(alreadyPresent).toBe(false);
    expect(config.model, "unrelated top-level keys survive").toBe("gpt-x");
    expect(config.hooks?.UserPromptSubmit, "the shaping hook's event is untouched").toEqual(
      existing.hooks?.UserPromptSubmit
    );
    const stop = config.hooks?.Stop as Array<{ hooks?: Array<{ command?: string }> }>;
    expect(stop[0].hooks?.[0].command, "their hook stays first").toBe("their-stop-hook");
    expect(stop.some((g) => (g.hooks ?? []).some((h) => h.command === codexTurnLineCommand()))).toBe(true);
  });

  it("is idempotent: a second install changes nothing", () => {
    const once = installCodexTurnLineHook({});
    const twice = installCodexTurnLineHook(once.config);
    expect(twice.changed).toBe(false);
    expect(twice.alreadyPresent).toBe(true);
    expect(twice.config).toEqual(once.config);
  });

  it("refuses to clobber a malformed hooks.Stop rather than overwriting it", () => {
    expect(() => installCodexTurnLineHook({ hooks: { Stop: "not-an-array" } as never })).toThrow(/malformed/i);
    expect(() => installCodexTurnLineHook({ hooks: [] as never })).toThrow(/malformed/i);
  });

  it("uninstall removes ONLY ours, and leaves a foreign hook and its group intact", () => {
    const seeded = installCodexTurnLineHook({
      hooks: { Stop: [{ hooks: [{ type: "command", command: "their-stop-hook" }] }] }
    }).config;
    const { config, changed, removedCount } = uninstallCodexTurnLineHook(seeded);
    expect(changed).toBe(true);
    expect(removedCount).toBe(1);
    const stop = config.hooks?.Stop as Array<{ hooks?: Array<{ command?: string }> }>;
    expect(stop).toHaveLength(1);
    expect(stop[0].hooks?.[0].command).toBe("their-stop-hook");
  });

  it("uninstall drops the Stop key entirely when ours was the only entry", () => {
    const seeded = installCodexTurnLineHook({}).config;
    const { config, removedCount } = uninstallCodexTurnLineHook(seeded);
    expect(removedCount).toBe(1);
    expect(config.hooks?.Stop).toBeUndefined();
  });

  it("uninstall on a config without our hook is a no-op", () => {
    const foreign: CodexHooksConfig = { hooks: { Stop: [{ hooks: [{ command: "theirs" }] }] } };
    const { changed, removedCount, config } = uninstallCodexTurnLineHook(foreign);
    expect(changed).toBe(false);
    expect(removedCount).toBe(0);
    expect(config).toEqual(foreign);
  });

  it("recognises only OUR command — EXACT match, not tokens", () => {
    expect(isCompactionTurnLineHookCommand(codexTurnLineCommand())).toBe(true);
    expect(isCompactionTurnLineHookCommand(`  ${codexTurnLineCommand()}  `), "whitespace tolerated").toBe(true);
    expect(isCompactionTurnLineHookCommand("hooks line codex"), "no `compaction` token").toBe(false);
    expect(isCompactionTurnLineHookCommand("compaction hooks line cursor"), "wrong tool").toBe(false);
    expect(isCompactionTurnLineHookCommand(undefined)).toBe(false);
    // A substring match would claim these; install would then skip, and uninstall would DELETE a hook
    // that is not ours.
    expect(isCompactionTurnLineHookCommand("echo compaction hooks line codex")).toBe(false);
    expect(isCompactionTurnLineHookCommand("compaction hooks line codex --their-flag")).toBe(false);
  });

  it("uninstall preserves a group the USER left empty, and drops only the one we emptied", () => {
    const seeded = installCodexTurnLineHook({
      hooks: { Stop: [{ hooks: [] }, { hooks: [{ type: "command", command: "theirs" }] }] }
    }).config;
    const { config, removedCount } = uninstallCodexTurnLineHook(seeded);
    expect(removedCount).toBe(1);
    const stop = config.hooks?.Stop as Array<{ hooks?: Array<{ command?: string }> }>;
    // The user's already-empty group survives; so does their populated one; ours is gone.
    expect(stop).toHaveLength(2);
    expect(stop[0].hooks).toEqual([]);
    expect(stop[1].hooks?.[0].command).toBe("theirs");
  });
});
