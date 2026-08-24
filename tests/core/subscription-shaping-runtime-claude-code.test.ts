import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decideShaping, shapingInstructionBlock } from "../../src/core/subscription-shaping-runtime.js";
import { stopShaping } from "../../src/core/subscription-shaping-state.js";
import { SHAPING_HOOKS_ENV } from "../../src/core/output-shaping-hook-activation.js";

/**
 * Claude Code shares the Codex per-prompt UserPromptSubmit shape: `await decideShaping("claude-code", …)` MUST
 * emit `hookSpecificOutput.additionalContext` on a shapeable turn and HOLD (emit nothing) on planning,
 * kill-switch, `compaction stop`, and malformed input. This is the versioned-activation guard for the
 * new before-call MUTATION surface: it must mutate ONLY on the whitelisted UserPromptSubmit event and only
 * when both the env kill-switch and the persisted stop-state are clear.
 */

let dir: string;
let onEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "compaction-cc-shape-"));
  onEnv = { COMPACTION_CONFIG_DIR: dir } as NodeJS.ProcessEnv; // no kill-switch, no persisted stop → active
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const payload = (prompt: string) => JSON.stringify({ prompt, cwd: "/x", session_id: "s", hook_event_name: "UserPromptSubmit" });

describe("await decideShaping('claude-code') - per-prompt UserPromptSubmit shaping", () => {
  it("emits the Claude Code additionalContext JSON on a shapeable (code) turn - the whitelisted surface", async () => {
    const d = await decideShaping("claude-code", payload("fix the failing test in utils.ts"), onEnv);
    expect(d.outcome).toBe("shape");
    const parsed = JSON.parse(d.stdout);
    // MUTATION happens ONLY via the whitelisted UserPromptSubmit hookSpecificOutput field.
    expect(parsed.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(typeof parsed.hookSpecificOutput.additionalContext).toBe("string");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("Output-shaping policy");
  });

  it("HOLDS on a planning/reasoning turn (never shapes a thinking turn) - the load-bearing safety property", async () => {
    const d = await decideShaping("claude-code", payload("help me decide the architecture and weigh the trade-offs"), onEnv);
    expect(d.outcome).toBe("hold-planning");
    expect(d.stdout).toBe("");
  });

  it("HOLDS when extended thinking is requested in the turn text", async () => {
    const d = await decideShaping("claude-code", payload("think step by step and reason through the design"), onEnv);
    expect(d.outcome).toBe("hold-planning");
    expect(d.stdout).toBe("");
  });

  it("HOLDS (emits nothing) when the env kill-switch is thrown", async () => {
    const d = await decideShaping("claude-code", payload("fix the bug"), { ...onEnv, [SHAPING_HOOKS_ENV]: "0" });
    expect(d.outcome).toBe("hold-dormant");
    expect(d.stdout).toBe("");
  });

  it("HOLDS (emits nothing) when the user has run `compaction stop` (persisted stop-state)", async () => {
    stopShaping({ COMPACTION_CONFIG_DIR: dir });
    const d = await decideShaping("claude-code", payload("fix the bug"), onEnv);
    expect(d.outcome).toBe("hold-dormant");
    expect(d.stdout).toBe("");
  });

  it("fail-open: malformed stdin / no prompt → hold (emit nothing)", async () => {
    expect((await decideShaping("claude-code", "not json {{{", onEnv)).stdout).toBe("");
    expect((await decideShaping("claude-code", JSON.stringify({ cwd: "/x" }), onEnv)).outcome).toBe("hold-error");
    expect((await decideShaping("claude-code", "", onEnv)).stdout).toBe("");
  });

  it("content-free: a secret in the prompt never appears in the emitted output", async () => {
    const secret = "sk-fake-SECRET-cc-0xC0FFEE";
    const d = await decideShaping("claude-code", payload(`refactor and here is a token ${secret}`), onEnv);
    expect(d.stdout).not.toContain(secret);
    expect(d.stdout).not.toContain("0xC0FFEE");
    // The injected instruction is the fixed, generic block (no request bytes).
    expect(JSON.parse(d.stdout).hookSpecificOutput.additionalContext).toBe(shapingInstructionBlock());
  });
});
