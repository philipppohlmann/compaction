import { describe, expect, it } from "vitest";
import { attachOutputShapingToCommand, findPromptArgIndex } from "../../src/core/output-shaping-attach.js";

/**
 * Output-shaping attach (increment 3), prepends the output-shaping instruction block to a wrapped
 * command's prompt BEFORE generation. Asserts: correct prompt-arg detection across Codex/Cursor shapes;
 * original command never mutated; no-prompt → not attached (never shapes the wrong arg); no savings number.
 */
describe("findPromptArgIndex", () => {
  it("finds the prompt positional in a Codex command", () => {
    const cmd = ["codex", "exec", "--json", "do the thing"];
    expect(findPromptArgIndex(cmd)).toBe(3);
  });
  it("skips flag values (--output-format json) in a Cursor command", () => {
    const cmd = ["cursor", "agent", "-p", "fix the bug", "--output-format", "json"];
    expect(findPromptArgIndex(cmd)).toBe(3); // "fix the bug", not "json"
  });
  it("returns -1 when there is no prompt positional", () => {
    expect(findPromptArgIndex(["codex", "exec", "--json"])).toBe(-1);
  });
});

describe("attachOutputShapingToCommand", () => {
  it("prepends the instruction block to the prompt arg (Codex) without mutating the original", () => {
    const original = ["codex", "exec", "--json", "do the thing"];
    const r = attachOutputShapingToCommand(original);
    expect(r.attached).toBe(true);
    expect(r.applied.length).toBeGreaterThan(0);
    expect(r.commandParts[3]).toContain("Output-shaping policy");
    expect(r.commandParts[3]).toContain("do the thing"); // original prompt preserved after the block
    expect(original[3]).toBe("do the thing"); // input untouched (returns a copy)
  });

  it("attaches to the Cursor prompt, not the --output-format value", () => {
    const r = attachOutputShapingToCommand(["cursor", "agent", "-p", "fix the bug", "--output-format", "json"], { verbosityBudgetTokens: 200 });
    expect(r.attached).toBe(true);
    expect(r.commandParts[3]).toContain("200 output tokens");
    expect(r.commandParts[5]).toBe("json"); // the flag value is untouched
  });

  it("does NOT attach (and never shapes a wrong arg) when no prompt is found", () => {
    const r = attachOutputShapingToCommand(["codex", "exec", "--json"]);
    expect(r.attached).toBe(false);
    expect(r.applied).toEqual([]);
    expect(r.reason).toContain("no prompt argument");
    expect(r.commandParts).toEqual(["codex", "exec", "--json"]);
  });

  it("does NOT attach when no policies match", () => {
    const r = attachOutputShapingToCommand(["codex", "exec", "do X"], { policies: ["not-a-real-policy"] });
    expect(r.attached).toBe(false);
    expect(r.reason).toContain("no matching output-shaping policies");
  });

  it("never emits an output-savings number/claim (instructions only)", () => {
    const r = attachOutputShapingToCommand(["codex", "exec", "do X"]);
    expect(JSON.stringify(r)).not.toMatch(/saving/i);
    expect(JSON.stringify(r)).not.toMatch(/\$[0-9]/);
  });
});
