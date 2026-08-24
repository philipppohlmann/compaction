import type { MetadataStatus } from "./openai-agents-capture.js";
import type { SafetyRiskLevel, SafetyStatus } from "./safety-report.js";
import type { WasteFinding } from "./types.js";

/**
 * PUBLIC report vocabulary + artifact shapes (open-core seam, sibling to `policy-types.ts`).
 *
 * This module holds the VOCABULARY and the JSON ARTIFACT SHAPES of the recommendation / apply /
 * integration reports. It contains NO recommendation, apply, or optimization ALGORITHM: the builders
 * (`createRecommendation`, `createApplyResult`, the OpenAI-Agents optimizer) stay in the private
 * engine, which re-exports these names so existing engine consumers are unaffected.
 *
 * WHY IT IS PUBLIC — SHIPPED DECLARATIONS MUST RESOLVE. The npm package excludes `dist/engine/**`
 * (package.json `files`). Public modules that named these types through `../engine/…` compiled fine
 * in-repo — a type-only import is erased and creates no RUNTIME edge — but `tsc` still emitted the
 * import into their `.d.ts`, so a TypeScript consumer of the published package hit
 * `TS2307: Cannot find module '../engine/recommendation.js'` on `spend-attribution`, `audit-report`,
 * and `cli/commands/recommend`. Type-only is not the same as declaration-free. Public modules name
 * these types from HERE; nothing shipped points at an excluded declaration.
 *
 * The public tree needs them because it READS these artifacts without being able to build them:
 * `audit-report` aggregates recommendation/apply reports off disk, `spend-attribution` types the
 * optional engine-supplied delta it degrades without, and `recommend` formats a report the engine
 * produced. Reading a proprietary artifact's shape is public; producing one is not.
 */

export const RECOMMENDATION_MODES = ["observe", "recommend", "apply_with_approval", "auto_eligible"] as const;
export type RecommendationMode = (typeof RECOMMENDATION_MODES)[number];

export const RECOMMENDATION_SAFETY_STATUSES = ["pass", "warn", "fail", "missing"] as const;
export type RecommendationSafetyStatus = (typeof RECOMMENDATION_SAFETY_STATUSES)[number];

export const RECOMMENDATION_RISK_LEVELS = ["low", "medium", "high"] as const;
export type RecommendationRiskLevel = (typeof RECOMMENDATION_RISK_LEVELS)[number];

/** `recommendation-report.json` as written by the engine and read back by the public audit path. */
export interface RecommendationReport {
  trace_id: string;
  generated_at: string;
  policy_name: string | null;
  waste_pattern: WasteFinding["category"] | null;
  original_input_tokens: number;
  compacted_input_tokens: number;
  tokens_saved: number;
  percent_reduction: number;
  savings_scope: "policy_level";
  cost_before_per_run: number;
  cost_after_per_run: number;
  saving_per_run: number;
  safety_status: RecommendationSafetyStatus;
  risk_level: RecommendationRiskLevel;
  recommended_mode: RecommendationMode;
  recommendation: string;
  rationale: string[];
  required_next_step: string;
}

/** A safety verdict, plus the "no safety report was present" case an apply artifact can carry. */
export type ApplySafetyStatus = SafetyStatus | "missing";

/** `apply-report.json` as written by the engine and read back by the public audit path. */
export interface ApplyReport {
  trace_id: string;
  generated_at: string;
  policy_name: string;
  safety_status: ApplySafetyStatus;
  risk_level: SafetyRiskLevel;
  applied: boolean;
  refusal_reason: string | null;
  compacted_message_count: number;
  source_pointer_count: number;
  tokens_saved: number;
  percent_reduction: number;
  cost_before_per_run: number;
  cost_after_per_run: number;
  saving_per_run: number;
  recommendation_mode?: RecommendationMode;
  required_next_step: string;
}

/** Provenance/readiness metadata attached to an integration workflow's optimization summary. */
export interface IntegrationWorkflowMetadata {
  integration_id?: string;
  readiness_level: 1 | 2;
  capture_mode: "command wrapper" | "local fixture";
  real_workflow_status: "real_workflow" | "fixture_only";
  provider_token_status: MetadataStatus;
  cost_status: MetadataStatus;
  provenance_status: "present" | "unknown";
  limitations: string[];
}
