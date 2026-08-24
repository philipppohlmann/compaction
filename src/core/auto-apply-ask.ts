/**
 * The post-approval binary auto-apply ask.
 *
 * Pure logic for the one binary question offered AFTER a user has already explicitly approved a
 * compaction in-workflow ("Apply this automatically next time for this workflow when safety gates
 * pass?", default no). Invariants:
 *   - Applies nothing and does no I/O: it returns a decision the CLI boundary may persist via
 *     `savePolicyPreference` or skip. A saved preference records intent only (see
 *     `auto-apply-gates.ts`, report-only, and `policy-preferences.ts`, a store with no apply path).
 *   - The offer exists only after an explicit approval; `approvedInWorkflow=false` → skip, always.
 *   - Default is no: only an explicit affirmative saves anything; anything unrecognized saves nothing.
 *   - Scope is the safest inferred scope (one tool/workflow + repo where detectable + policy type),
 *     never global, never cross-tool, never chosen from a menu. A missing/global/cross-tool tool
 *     blocks the offer (fail-closed, saves nothing).
 */
import { AUTO_APPLY_GATE_NAMES } from "./auto-apply-gates.js";
import {
  validatePolicyPreferenceScope,
  type PolicyPreference,
  type PolicyPreferenceScope
} from "./policy-preferences.js";

/** The exact binary question. No scope menu, the scope is inferred, never asked. */
export const AUTO_APPLY_QUESTION_LINES: readonly string[] = [
  "Apply this automatically next time for this workflow when safety gates pass?",
  "  [y] yes",
  "  [n] no, ask me each time"
];

/** A stored preference records these gate names (the gate list from `auto-apply-gates`). */
export const AUTO_APPLY_PREFERENCE_GATES_REQUIRED: readonly string[] = [...AUTO_APPLY_GATE_NAMES];

export type AutoApplyAnswer = "yes" | "no";

/**
 * Interpret a raw answer. DEFAULT IS NO: only an explicit `y` / `yes` (case-insensitive, trimmed) is
 * `yes`; empty, `n`, `no`, undefined, or anything unrecognized is `no`. Never throws.
 */
export function interpretAutoApplyAnswer(raw: string | null | undefined): AutoApplyAnswer {
  if (typeof raw !== "string") return "no";
  const value = raw.trim().toLowerCase();
  return value === "y" || value === "yes" ? "yes" : "no";
}

/** Inputs from which the SAFEST scope is inferred, never a scope menu; the caller supplies facts. */
export interface AutoApplyScopeInputs {
  /** REQUIRED. The workflow/tool this run belongs to (never global/cross-tool). */
  tool?: string;
  /** OPTIONAL. The repo, when detectable (content-free identifier). */
  repo?: string;
  /** REQUIRED. The policy type that was approved (content-free identifier). */
  policyType?: string;
}

export interface AutoApplyOfferInput {
  /** TRUE only when an explicit in-workflow approval already emitted an approved context. */
  approvedInWorkflow: boolean;
  /** The interpreted answer to the binary question (default no). */
  answer: AutoApplyAnswer;
  /** The facts from which the safest scope is inferred. */
  scope: AutoApplyScopeInputs;
}

export type AutoApplyOfferDecision =
  /** No approval happened, or the answer was no/default, save nothing (the common, safe path). */
  | { action: "skip"; reason: string }
  /** Approval + explicit yes, but the scope could not be inferred safely, fail-closed, save nothing. */
  | { action: "blocked"; problems: string[] }
  /** Approval + explicit yes + a safe scope, the CLI should upsert this preference (applies nothing). */
  | {
      action: "save";
      scope: PolicyPreferenceScope;
      preference: "auto-when-gates-pass";
      gatesRequired: string[];
    };

/**
 * Resolve the binary offer into a decision. Pure, no I/O, no side effects. Offer only after
 * approval; default no; safest inferred scope; never global/cross-tool. Saving is left to the CLI
 * boundary (`savePolicyPreference`); this never applies anything.
 */
export function resolveAutoApplyOffer(input: AutoApplyOfferInput): AutoApplyOfferDecision {
  if (!input.approvedInWorkflow) {
    return {
      action: "skip",
      reason: "no in-workflow approval happened - the auto-apply offer is only made after an explicit approval"
    };
  }
  if (input.answer !== "yes") {
    return { action: "skip", reason: "answered no (or default) - nothing saved; Compaction will keep asking each time" };
  }

  const tool = input.scope.tool?.trim();
  const policyType = input.scope.policyType?.trim();
  const repo = input.scope.repo?.trim();
  const candidateScope = {
    tool: tool ?? "",
    policy_type: policyType ?? "",
    ...(repo ? { repo } : {})
  };
  const { problems } = validatePolicyPreferenceScope(candidateScope);
  if (problems.length > 0) {
    return { action: "blocked", problems };
  }

  const scope: PolicyPreferenceScope = {
    tool: candidateScope.tool,
    policy_type: candidateScope.policy_type,
    ...(repo ? { repo } : {})
  };
  return {
    action: "save",
    scope,
    preference: "auto-when-gates-pass",
    gatesRequired: [...AUTO_APPLY_PREFERENCE_GATES_REQUIRED]
  };
}

/**
 * The saved-preference confirmation (scope · gates · undo hint). States the preference is stored
 * and that every future application would be logged, evidence-labeled, and undoable, it does not
 * claim anything was applied. No wall-clock, no content.
 */
export function formatSavedPreferenceConfirmation(preference: PolicyPreference): string {
  const scopeParts = ["this tool", preference.scope.repo ? "this repo" : null, "this policy type"].filter(
    (part): part is string => part !== null
  );
  return [
    "Saved preference:",
    `Compaction will apply ${preference.scope.policy_type} automatically for`,
    "this workflow when safety gates pass.",
    "",
    `Scope: this workflow only (${scopeParts.join(" · ")}) - never`,
    "global, never cross-tool. Every automatic application is logged, evidence-labeled,",
    "and undoable.",
    "",
    "This preference is active only for a matching routed Gateway workflow in Full optimization mode.",
    "Every request still has to pass the supported-shape, retention, and recovery gates.",
    "",
    "Review or turn off anytime:",
    "  compaction policies list",
    `  compaction policies disable ${preference.id}`
  ].join("\n");
}
