/**
 * Post-approval binary auto-apply ASK tests.
 *
 * Proven here (pure logic, no I/O in the module under test):
 * - the offer is made ONLY after an explicit approval: approvedInWorkflow=false → skip;
 * - DEFAULT IS NO: answer "no"/default/unrecognized → skip (saves nothing); only "yes" → save;
 * - the saved scope is the SAFEST inferred scope and is NEVER global/cross-tool (rejected → blocked);
 * - gates_required on the save decision = the gate names from auto-apply-gates (single source);
 * - the resolver itself does no I/O (it returns a decision; the CLI performs the save).
 */
import { describe, expect, it } from "vitest";
import { AUTO_APPLY_GATE_NAMES } from "../../src/core/auto-apply-gates.js";
import {
  AUTO_APPLY_PREFERENCE_GATES_REQUIRED,
  AUTO_APPLY_QUESTION_LINES,
  formatSavedPreferenceConfirmation,
  interpretAutoApplyAnswer,
  resolveAutoApplyOffer
} from "../../src/core/auto-apply-ask.js";
import { computePolicyPreferenceId, type PolicyPreference } from "../../src/core/policy-preferences.js";

const SCOPE = { tool: "claude-code", repo: "my-repo", policyType: "stale_tool_output_to_state_capsule" };

describe("interpretAutoApplyAnswer - default no", () => {
  it("only explicit y/yes → yes", () => {
    for (const yes of ["y", "yes", "YES", " Yes "]) expect(interpretAutoApplyAnswer(yes)).toBe("yes");
  });
  it("everything else → no (default)", () => {
    for (const no of ["", "n", "no", "nope", "sure", undefined, null, "yep", "1"]) {
      expect(interpretAutoApplyAnswer(no)).toBe("no");
    }
  });
});

describe("resolveAutoApplyOffer - rails", () => {
  it("no prior approval → skip (offer only after an explicit approval)", () => {
    const decision = resolveAutoApplyOffer({ approvedInWorkflow: false, answer: "yes", scope: SCOPE });
    expect(decision.action).toBe("skip");
  });

  it("answer no → skip, saves nothing", () => {
    const decision = resolveAutoApplyOffer({ approvedInWorkflow: true, answer: "no", scope: SCOPE });
    expect(decision.action).toBe("skip");
  });

  it("approval + yes → save with the inferred scope, preference auto-when-gates-pass, gates from module 1", () => {
    const decision = resolveAutoApplyOffer({ approvedInWorkflow: true, answer: "yes", scope: SCOPE });
    expect(decision.action).toBe("save");
    if (decision.action !== "save") throw new Error("expected save");
    expect(decision.preference).toBe("auto-when-gates-pass");
    expect(decision.scope).toEqual({ tool: "claude-code", repo: "my-repo", policy_type: SCOPE.policyType });
    expect(decision.gatesRequired).toEqual([...AUTO_APPLY_GATE_NAMES]);
    expect(decision.gatesRequired).toEqual([...AUTO_APPLY_PREFERENCE_GATES_REQUIRED]);
  });

  it("omitting a detectable repo still saves a tool-scoped (never global) preference", () => {
    const decision = resolveAutoApplyOffer({
      approvedInWorkflow: true,
      answer: "yes",
      scope: { tool: "codex", policyType: "stale_tool_output_to_state_capsule" }
    });
    expect(decision.action).toBe("save");
    if (decision.action !== "save") throw new Error("expected save");
    expect(decision.scope).toEqual({ tool: "codex", policy_type: "stale_tool_output_to_state_capsule" });
    expect(decision.scope).not.toHaveProperty("repo");
  });

  it.each(["global", "all", "*", "any", "cross-tool"])(
    "yes with a GLOBAL/cross-tool tool '%s' → BLOCKED (fail-closed, saves nothing)",
    (badTool) => {
      const decision = resolveAutoApplyOffer({
        approvedInWorkflow: true,
        answer: "yes",
        scope: { tool: badTool, policyType: "p" }
      });
      expect(decision.action).toBe("blocked");
    }
  );

  it("yes with a missing tool → BLOCKED (never guesses a global scope)", () => {
    const decision = resolveAutoApplyOffer({ approvedInWorkflow: true, answer: "yes", scope: { policyType: "p" } });
    expect(decision.action).toBe("blocked");
  });

  it("yes with a missing policy type → BLOCKED", () => {
    const decision = resolveAutoApplyOffer({ approvedInWorkflow: true, answer: "yes", scope: { tool: "claude-code" } });
    expect(decision.action).toBe("blocked");
  });
});

describe("presentation", () => {
  it("the question is the binary question with no scope menu", () => {
    const text = AUTO_APPLY_QUESTION_LINES.join("\n");
    expect(text).toContain("Apply this automatically next time");
    expect(text).toContain("[y] yes");
    expect(text).toContain("[n] no, ask me each time");
    expect(text.toLowerCase()).not.toContain("scope");
    expect(text).not.toContain("global");
  });

  it("saved-preference confirmation shows scope, activation boundary, and undo hint", () => {
    const scope = { tool: "claude-code", repo: "my-repo", policy_type: "stale_tool_output_to_state_capsule" };
    const preference: PolicyPreference = {
      id: computePolicyPreferenceId(scope),
      scope,
      preference: "auto-when-gates-pass",
      enabled: true,
      gates_required: [...AUTO_APPLY_GATE_NAMES]
    };
    const text = formatSavedPreferenceConfirmation(preference);
    expect(text).toContain("Saved preference:");
    expect(text).toContain("never");
    expect(text).toContain("active only for a matching routed Gateway workflow in Full optimization mode");
    expect(text).toContain("supported-shape, retention, and recovery gates");
    expect(text).toContain(`compaction policies disable ${preference.id}`);
    expect(text).toContain("compaction policies list");
  });
});
