/**
 * Output-shaping policy family, deterministic, rule-based (public CLI/SDK code, engine-free).
 *
 * Produces a content-free output-shaping
 * instruction block to attach to a request BEFORE generation, the only mechanism that can reduce
 * provider output tokens (post-generation processing does not).
 *
 * Claim boundary:
 * - This module emits instructions + attribution labels only. It computes no output-savings number
 *   and makes no claim that output was reduced. A savings figure requires a measured A/B on
 *   provider-reported output AND the eval-gated short-but-sufficient check, both live in the
 *   private engine, not here. Until both pass, savings are unavailable.
 * - Content-free: instructions are generic shaping text; no prompt/completion/trace content.
 */

export type RiskLevel = "low" | "medium" | "high";

/** Content-free attribution for a recorded run (matches the control-plane policy_* columns). */
export interface OutputShapingAttribution {
  policy_name: string;
  policy_family: "output_shaping";
  risk_level: RiskLevel;
}

export interface OutputShapingPolicy extends OutputShapingAttribution {
  /** Human-readable description (what the policy instructs, never content). */
  description: string;
  /** Whether the policy is part of the default rule-based set. */
  defaultOn: boolean;
  /** Builds the instruction line(s). `verbosityBudgetTokens` is used only by the verbosity-budget policy. */
  instruction(verbosityBudgetTokens?: number): string;
}

/**
 * The deterministic rule-based output-shaping policies (the public tier). The learned tier and the
 * eval-gated verification live in the private engine, not here.
 */
export const OUTPUT_SHAPING_POLICIES: readonly OutputShapingPolicy[] = [
  {
    policy_name: "concise_response",
    policy_family: "output_shaping",
    risk_level: "low",
    defaultOn: true,
    description: "Ask for a concise answer where the task allows (no padding, no restating the prompt).",
    instruction: () => "Answer concisely: omit preamble and restatement of the request; give only what the task needs."
  },
  {
    policy_name: "verbosity_budget",
    policy_family: "output_shaping",
    risk_level: "low",
    defaultOn: true,
    description: "Set a soft target on response length (a budget, not a hard cap).",
    instruction: (budget?: number) =>
      typeof budget === "number" && budget > 0
        ? `Aim to stay within roughly ${budget} output tokens; prioritize the most task-relevant content if space is tight.`
        : "Keep the response as short as is sufficient for the task; do not pad to fill space."
  },
  {
    policy_name: "structured_output_constraints",
    policy_family: "output_shaping",
    risk_level: "low",
    defaultOn: true,
    description: "Prefer a bounded, structured format (lists/sections) that reduces filler.",
    instruction: () => "Prefer a tight structured format (short bullets or labeled sections) over long prose where it fits the task."
  },
  {
    policy_name: "redundant_chatter_suppression",
    policy_family: "output_shaping",
    risk_level: "low",
    defaultOn: true,
    description: "Suppress boilerplate, preamble, apologies, and repetition.",
    instruction: () => "Skip boilerplate, apologies, and repetition; do not summarize what you just said."
  },
  {
    policy_name: "safe_tool_output_filtering",
    policy_family: "output_shaping",
    // Slightly higher risk: trimming tool output can drop detail, so it is OFF by default and only
    // requests omission of clearly-redundant tool echo - recoverability of task-critical detail first.
    risk_level: "medium",
    defaultOn: false,
    description: "Request omission of clearly-redundant tool-output echo (recoverability preserved first).",
    instruction: () => "Do not echo large tool outputs verbatim; reference them and include only the task-relevant lines."
  }
];

/** Note attached to every emitted block: this is a request-shaping instruction, not a savings claim. */
export const OUTPUT_SHAPING_HONESTY_NOTE =
  "Attach BEFORE generation (post-generation processing does not reduce provider output tokens). " +
  "No output-token savings are claimed: a savings figure requires a measured before/after (provider-reported) " +
  "and eval-confirmed sufficiency - neither is asserted here.";

export interface OutputShapingResult {
  /** The content-free instruction block to prepend to the request/system prompt BEFORE generation. */
  instructions: string;
  /** Attribution for the applied policies (content-free; for recording / reporting). */
  applied: OutputShapingAttribution[];
}

export interface BuildOutputShapingOptions {
  /** Policy names to apply; defaults to the `defaultOn` set. Unknown names are ignored (never invented). */
  policies?: string[];
  /** Soft verbosity budget in output tokens (used by the verbosity-budget policy). */
  verbosityBudgetTokens?: number;
}

/**
 * The FIRST LINE of every instruction block this module produces, and therefore the marker by which a
 * body can be recognised as ALREADY carrying our shaping policy.
 *
 * It exists because the gateway and the tool's own `UserPromptSubmit` hook can both be active on the
 * same turn: the hook injects before the gateway ever sees the request, so without a check the
 * gateway would attach a second, identical block. Exported (rather than re-spelled at the call site)
 * so the emitted text and the recogniser can never drift apart — they are the same constant.
 */
export const OUTPUT_SHAPING_POLICY_MARKER = "Output-shaping policy (apply to your response):";

/**
 * Build the content-free output-shaping instruction block + attribution from the deterministic family.
 * Produces instructions only - NO savings number, NO claim of reduction.
 */
export function buildOutputShapingPolicy(opts: BuildOutputShapingOptions = {}): OutputShapingResult {
  const selected =
    opts.policies && opts.policies.length > 0
      ? OUTPUT_SHAPING_POLICIES.filter((p) => opts.policies!.includes(p.policy_name))
      : OUTPUT_SHAPING_POLICIES.filter((p) => p.defaultOn);

  const lines = selected.map((p) => `- ${p.instruction(opts.verbosityBudgetTokens)}`);
  const instructions = selected.length === 0 ? "" : [OUTPUT_SHAPING_POLICY_MARKER, ...lines].join("\n");

  return {
    instructions,
    applied: selected.map((p) => ({ policy_name: p.policy_name, policy_family: p.policy_family, risk_level: p.risk_level }))
  };
}
