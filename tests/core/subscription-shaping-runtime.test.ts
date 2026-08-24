import { describe, expect, it } from "vitest";
import { decideShaping, shapingInstructionBlock } from "../../src/core/subscription-shaping-runtime.js";
import {
  SHAPING_HOOKS_ENV,
  isShapingHooksActivated
} from "../../src/core/output-shaping-hook-activation.js";

/**
 * Runtime shaping decision (public, pure). Invariants: AUTO-APPLY (default-ON; emit nothing only when the
 * kill-switch is thrown), CLASSIFIER-HOLD (planning/reasoning/extended-thinking turns still emit nothing even
 * when active, the critical safety property now that default is ON), content-free (a secret in the prompt
 * never appears in output), fail-open (malformed stdin → emit nothing), Codex per-prompt classify, Cursor
 * session-level always-on-when-active.
 */

// Default env: no flag set → auto-apply is ACTIVE (this is the new default).
const ON = {} as NodeJS.ProcessEnv;
// Kill-switch thrown → shaping disabled.
const OFF = { [SHAPING_HOOKS_ENV]: "0" } as NodeJS.ProcessEnv;

const codexPayload = (prompt: string) => JSON.stringify({ prompt, cwd: "/x", session_id: "s", turn_id: "t" });

describe("auto-apply activation gate (default-ON, kill-switch)", () => {
  it("is active by default and honors the kill-switch", async () => {
    expect(isShapingHooksActivated(ON)).toBe(true); // env absent → active
    expect(isShapingHooksActivated({ [SHAPING_HOOKS_ENV]: "0" })).toBe(false);
    expect(isShapingHooksActivated({ [SHAPING_HOOKS_ENV]: "false" })).toBe(false);
    expect(isShapingHooksActivated({ [SHAPING_HOOKS_ENV]: "off" })).toBe(false);
    expect(isShapingHooksActivated({ [SHAPING_HOOKS_ENV]: "no" })).toBe(false);
    expect(isShapingHooksActivated({ [SHAPING_HOOKS_ENV]: "1" })).toBe(true);
  });

  it("Codex emits NOTHING when the kill-switch is thrown, even on a shapeable prompt", async () => {
    const d = await decideShaping("codex", codexPayload("fix the failing test in utils.ts"), OFF);
    expect(d.outcome).toBe("hold-dormant");
    expect(d.stdout).toBe("");
  });

  it("Cursor emits NOTHING when the kill-switch is thrown", async () => {
    const d = await decideShaping("cursor", "", OFF);
    expect(d.outcome).toBe("hold-dormant");
    expect(d.stdout).toBe("");
  });
});

describe("Codex - per-prompt shape/hold when activated", () => {
  it("emits the verified additionalContext JSON on a shapeable (code) turn", async () => {
    const d = await decideShaping("codex", codexPayload("fix the failing test in utils.ts"), ON);
    expect(d.outcome).toBe("shape");
    const parsed = JSON.parse(d.stdout);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(typeof parsed.hookSpecificOutput.additionalContext).toBe("string");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("Output-shaping policy");
  });

  it("HOLDS on a planning/reasoning turn even when ACTIVE-by-default (critical safety property)", async () => {
    // With auto-apply default-ON, the classifier-hold is the load-bearing safety gate: a planning turn
    // must still emit nothing. This is the test that keeps auto-apply from shaping a thinking turn.
    const d = await decideShaping("codex", codexPayload("help me decide the architecture and weigh the trade-offs"), ON);
    expect(d.outcome).toBe("hold-planning");
    expect(d.stdout).toBe("");
  });

  it("HOLDS on an extended-thinking/reasoning-request turn even when ACTIVE-by-default", async () => {
    // A turn that explicitly asks the model to reason at length must be held under auto-apply.
    const d = await decideShaping("codex", codexPayload("think step by step and reason through why this approach is correct"), ON);
    expect(d.outcome).toBe("hold-planning");
    expect(d.stdout).toBe("");
  });
});

describe("Cursor - session-level only when activated", () => {
  it("emits additional_context (no per-turn classification)", async () => {
    const d = await decideShaping("cursor", JSON.stringify({ session_id: "s" }), ON);
    expect(d.outcome).toBe("shape");
    const parsed = JSON.parse(d.stdout);
    expect(typeof parsed.additional_context).toBe("string");
    expect(parsed.additional_context).toContain("Output-shaping policy");
    // The Cursor schema uses additional_context, NOT the Codex hookSpecificOutput envelope.
    expect(parsed.hookSpecificOutput).toBeUndefined();
  });
});

describe("content-free", () => {
  it("Codex: a secret in the prompt never appears in the emitted output", async () => {
    const secret = "sk-fake-SECRET-0xDEADBEEF-do-not-leak";
    const d = await decideShaping("codex", codexPayload(`refactor this and here is a token ${secret}`), ON);
    // Whether it shapes or holds, the secret must never be echoed.
    expect(d.stdout).not.toContain(secret);
    expect(d.stdout).not.toContain("0xDEADBEEF");
  });

  it("Cursor: the emitted instruction is fixed and carries no stdin content", async () => {
    const secret = "sk-fake-SECRET-cursor-9999";
    const d = await decideShaping("cursor", JSON.stringify({ prompt: secret }), ON);
    expect(d.stdout).not.toContain(secret);
    // The parsed additional_context is exactly the fixed instruction block (no request bytes).
    expect(JSON.parse(d.stdout).additional_context).toBe(shapingInstructionBlock());
  });

  it("the instruction block is generic (no request content by construction)", async () => {
    expect(shapingInstructionBlock()).toContain("Output-shaping policy");
    expect(shapingInstructionBlock()).toContain("No output-token savings are claimed");
  });
});

describe("fail-open", () => {
  it("Codex: malformed stdin → hold (emit nothing)", async () => {
    expect((await decideShaping("codex", "not json {{{", ON)).stdout).toBe("");
    expect((await decideShaping("codex", "not json {{{", ON)).outcome).toBe("hold-error");
  });

  it("Codex: valid JSON with no prompt field → hold (emit nothing)", async () => {
    const d = await decideShaping("codex", JSON.stringify({ cwd: "/x" }), ON);
    expect(d.outcome).toBe("hold-error");
    expect(d.stdout).toBe("");
  });

  it("Codex: empty stdin → hold", async () => {
    expect((await decideShaping("codex", "", ON)).stdout).toBe("");
  });
});
