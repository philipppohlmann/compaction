import { describe, it, expect } from "vitest";
import { resolveStdinPromptBoundary, analyzeBeforeCall } from "../../src/core/before-call.js";
import { planStdinApply } from "../../src/core/before-call-stdin.js";

/**
 * STDIN-BOUNDARY resolver + planner, the FIRST real before-call mutation
 * surface. The argv route was blocked (bare positional prompts); this covers the stdin route:
 * Codex `exec` reads instructions from stdin when no positional prompt is given, an explicit boundary.
 */

const BLOCK = "SHARED CONTEXT BLOCK long enough to clear the duplicate size floor here for sure.";
const SECRET = "SECRET_STDIN_marker_do_not_store";
const dupStdin = `${BLOCK}\n\ndo the task with ${SECRET}, concisely.\n\n${BLOCK}`;

describe("resolveStdinPromptBoundary - Codex `exec` stdin is the whole prompt (fail-closed otherwise)", () => {
  it("SAFE: `codex exec --json` with no positional prompt (stdin is the prompt)", () => {
    expect(resolveStdinPromptBoundary("codex", ["exec", "--json"]).safe).toBe(true);
  });

  it("SAFE: `codex exec --json -` (the documented explicit stdin marker)", () => {
    expect(resolveStdinPromptBoundary("codex", ["exec", "--json", "-"]).safe).toBe(true);
  });

  it("SAFE: value flags and their values are skipped, never mistaken for a positional prompt", () => {
    expect(resolveStdinPromptBoundary("codex", ["exec", "-m", "gpt-5-codex", "--json", "-C", "/tmp"]).safe).toBe(true);
    expect(resolveStdinPromptBoundary("codex", ["exec", "--model=gpt-5", "--json"]).safe).toBe(true);
  });

  it("NOT SAFE: a positional prompt is present (Codex would append stdin as a <stdin> block)", () => {
    const r = resolveStdinPromptBoundary("codex", ["exec", "--json", "do the task"]);
    expect(r.safe).toBe(false);
    expect(r.reason).toMatch(/positional/i);
  });

  it("NOT SAFE: an unknown flag → cannot prove the argv shape (fail-closed)", () => {
    expect(resolveStdinPromptBoundary("codex", ["exec", "--json", "--totally-unknown"]).safe).toBe(false);
  });

  it("NOT SAFE: nested subcommand (resume/review) is a bare positional (fail-closed)", () => {
    expect(resolveStdinPromptBoundary("codex", ["exec", "resume", "--last"]).safe).toBe(false);
  });

  it("NOT SAFE: not the `exec` batch form at all", () => {
    expect(resolveStdinPromptBoundary("codex", ["--json"]).safe).toBe(false);
  });

  it("NOT SAFE: Cursor has NO documented stdin prompt boundary (unverifiable → fail-closed)", () => {
    const r = resolveStdinPromptBoundary("cursor", ["-p", "--output-format", "json"]);
    expect(r.safe).toBe(false);
    expect(r.reason).toMatch(/no documented stdin/i);
  });
});

describe("planStdinApply - emits `compacted` ONLY on a safe boundary + avoidable context + approval", () => {
  const base = { tool: "codex" as const, argv: ["exec", "--json"] };

  it("safe + avoidable + interactive + APPROVE → emit compacted (the compacted stdin stream)", () => {
    const plan = planStdinApply({ ...base, stdinContent: dupStdin, interactive: true, decide: () => "apply" });
    expect(plan.boundary.safe).toBe(true);
    expect(plan.emit).toBe("compacted");
    expect(plan.applied).toBe(true);
    expect(plan.approvalStatus).toBe("asked-approved");
    expect(plan.compacted).toBe(analyzeBeforeCall("codex", dupStdin).compacted_input);
    expect(plan.compacted!.length).toBeLessThan(dupStdin.length); // realized local-estimate reduction
    expect(plan.record).toBe(true);
  });

  it("safe + avoidable + interactive + DECLINE → emit original (no default yes)", () => {
    const plan = planStdinApply({ ...base, stdinContent: dupStdin, interactive: true, decide: () => "decline" });
    expect(plan.emit).toBe("original");
    expect(plan.applied).toBe(false);
    expect(plan.approvalStatus).toBe("asked-declined");
    expect(plan.compacted).toBeUndefined();
    expect(plan.record).toBe(true);
  });

  it("safe + avoidable + NO terminal → NEVER apply without approval (emit original, honest not-asked)", () => {
    let asked = false;
    const plan = planStdinApply({
      ...base,
      stdinContent: dupStdin,
      interactive: false,
      decide: () => {
        asked = true;
        return "apply";
      }
    });
    expect(asked).toBe(false); // decide is NEVER consulted without a terminal
    expect(plan.emit).toBe("original");
    expect(plan.applied).toBe(false);
    expect(plan.approvalStatus).toBe("not-asked");
    expect(plan.notAvailableReason).toMatch(/no interactive terminal/i);
    expect(plan.record).toBe(true);
  });

  it("safe boundary but NO avoidable context → honest no-op (emit original, no event)", () => {
    const plan = planStdinApply({ ...base, stdinContent: "just one unique block, nothing repeated", interactive: true, decide: () => "apply" });
    expect(plan.emit).toBe("original");
    expect(plan.approvalStatus).toBe("not-required");
    expect(plan.record).toBe(false);
  });

  it("UNSAFE boundary (positional prompt) → emit original, never apply; caller falls back to argv reco", () => {
    const plan = planStdinApply({
      tool: "codex",
      argv: ["exec", "--json", "the positional prompt"],
      stdinContent: dupStdin,
      interactive: true,
      decide: () => "apply"
    });
    expect(plan.boundary.safe).toBe(false);
    expect(plan.emit).toBe("original");
    expect(plan.applied).toBe(false);
    expect(plan.record).toBe(false);
  });
});
