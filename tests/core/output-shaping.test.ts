import { describe, expect, it } from "vitest";
import {
  buildHookOutputShapingTreatment,
  buildOutputShapingPolicy,
  outputShapingPolicyVersion,
  OUTPUT_SHAPING_POLICIES,
  OUTPUT_SHAPING_HONESTY_NOTE
} from "../../src/core/output-shaping.js";

/**
 * Output-shaping policy family (deterministic, rule-based, public tier).
 * Asserts the claim boundaries: produces instructions + attribution only; no output-savings
 * number/claim; content-free; shape before generation.
 */
describe("output-shaping policy family (deterministic)", () => {
  it("builds a content-free instruction block + attribution from the default policies", () => {
    const r = buildOutputShapingPolicy();
    expect(r.instructions.split("\n")).toHaveLength(5);
    expect(r.applied).toHaveLength(4);
    // attribution matches the control-plane policy_* shape, family fixed to output_shaping.
    for (const a of r.applied) {
      expect(a.policy_family).toBe("output_shaping");
      expect(["low", "medium", "high"]).toContain(a.risk_level);
    }
    // default set excludes the off-by-default safe_tool_output_filtering.
    expect(r.applied.map((a) => a.policy_name)).not.toContain("safe_tool_output_filtering");
  });

  it("suppresses redundant chatter without changing required content", () => {
    const policy = OUTPUT_SHAPING_POLICIES.find(
      ({ policy_name }) => policy_name === "redundant_chatter_suppression"
    );
    expect(policy).toMatchObject({
      policy_family: "output_shaping",
      risk_level: "low",
      defaultOn: true
    });
    expect(policy?.instruction()).toBe(
      "Skip boilerplate, apologies, and repetition; do not summarize what you just said."
    );
  });

  it("keeps safe tool-output filtering outside the four-policy default treatment", () => {
    const filtering = OUTPUT_SHAPING_POLICIES.find(
      ({ policy_name }) => policy_name === "safe_tool_output_filtering"
    );
    expect(OUTPUT_SHAPING_POLICIES).toHaveLength(5);
    expect(filtering).toMatchObject({
      policy_family: "output_shaping",
      risk_level: "medium",
      defaultOn: false
    });
    expect(buildOutputShapingPolicy().applied.map(({ policy_name }) => policy_name)).toEqual([
      "concise_response",
      "verbosity_budget",
      "structured_output_constraints",
      "redundant_chatter_suppression"
    ]);
  });

  it("applies a verbosity budget when given", () => {
    const r = buildOutputShapingPolicy({ policies: ["verbosity_budget"], verbosityBudgetTokens: 300 });
    expect(r.instructions).toContain("300 output tokens");
    expect(r.applied).toEqual([{ policy_name: "verbosity_budget", policy_family: "output_shaping", risk_level: "low" }]);
  });

  it("versions the exact emitted instruction bytes deterministically", () => {
    const current = buildOutputShapingPolicy();
    expect(current.policyVersion).toMatch(/^output-shaping\.v1\.sha256\.[a-f0-9]{64}$/);
    expect(current.policyVersion).toBe(
      "output-shaping.v1.sha256.d326ef20760ad30142e0b4bc37fcb55a4a8fade7c9964f90158fdbafb49e0f83"
    );
    expect(current.policyVersion).toBe(outputShapingPolicyVersion(current.instructions));
    expect(buildOutputShapingPolicy().policyVersion).toBe(current.policyVersion);
    expect(buildOutputShapingPolicy({ verbosityBudgetTokens: 300 }).policyVersion).not.toBe(current.policyVersion);
  });

  it("versions the exact hook bytes separately", () => {
    const core = buildOutputShapingPolicy();
    const hook = buildHookOutputShapingTreatment();
    expect(hook.instructions).toBe(`${core.instructions}\n(${OUTPUT_SHAPING_HONESTY_NOTE})`);
    expect(Buffer.byteLength(core.instructions, "utf8")).toBe(425);
    expect(Buffer.byteLength(hook.instructions, "utf8")).toBe(687);
    expect(hook.policyVersion).toBe(outputShapingPolicyVersion(hook.instructions));
    expect(hook.policyVersion).toBe(
      "output-shaping.v1.sha256.18ed526481a63fc7d7c596b3622b22d106ea906a33b58125e2a36233f25b8775"
    );
  });

  it("ignores unknown policy names (never invents a policy)", () => {
    const r = buildOutputShapingPolicy({ policies: ["concise_response", "not-a-real-policy"] });
    expect(r.applied.map((a) => a.policy_name)).toEqual(["concise_response"]);
  });

  it("makes NO output-savings number or reduction claim - instructions only", () => {
    const r = buildOutputShapingPolicy({ policies: OUTPUT_SHAPING_POLICIES.map((p) => p.policy_name), verbosityBudgetTokens: 200 });
    const blob = JSON.stringify(r);
    expect(blob).not.toMatch(/saving/i);
    expect(blob).not.toMatch(/\$[0-9]/);
    expect(blob).not.toMatch(/reduced by|% reduction|tokens saved/i);
  });

  it("verbosity_budget without a budget falls back to generic concise guidance (no number)", () => {
    const r = buildOutputShapingPolicy({ policies: ["verbosity_budget"] });
    expect(r.instructions).toContain("as short as is sufficient");
    expect(r.instructions).not.toMatch(/[0-9]+ output tokens/);
  });

  it("empty selection yields no instructions (honest empty, not a fabricated block)", () => {
    const r = buildOutputShapingPolicy({ policies: ["not-a-real-policy"] });
    expect(r.instructions).toBe("");
    expect(r.applied).toEqual([]);
  });

  it("the honesty note states shape-before-generation + no-savings-without-measurement+eval", () => {
    expect(OUTPUT_SHAPING_HONESTY_NOTE).toContain("BEFORE generation");
    expect(OUTPUT_SHAPING_HONESTY_NOTE.toLowerCase()).toContain("no output-token savings");
    expect(OUTPUT_SHAPING_HONESTY_NOTE.toLowerCase()).toContain("eval-confirmed");
  });
});
