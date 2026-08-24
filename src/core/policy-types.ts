import type { AgentTrace, CostEstimate, StateCapsule, TokenEstimate, TraceMessage } from "./types.js";

/**
 * PUBLIC policy types + name constants (open-core Phase 1a seam).
 *
 * This module holds the public-safe surface of the two compaction policies, the policy NAME
 * constants, the supported-policy-name set + its validator, and the structural types of a state
 * capsule / source pointer / replacement mode / skill-injection provenance. It contains NO
 * optimization, scoring, policy-application, or aggregation ALGORITHM. It exists so public modules
 * (state-capsule, safety-report, report-generator, token-accounting, the analyze/summary/spend/
 * feedback/audit public paths) can validate and shape compaction artifacts WITHOUT a runtime import
 * of the proprietary engine modules (`policy-middleware`'s policy-application core,
 * `skill-injection-policy`'s candidate/capsule builder, etc.).
 *
 * The proprietary engine modules re-export these names for backward compatibility, so existing
 * engine consumers are unaffected; the algorithms themselves remain in the engine modules.
 */

/** Shipped tool-output policy name. */
export const COMPACTION_POLICY_NAME = "stale_tool_output_to_state_capsule" as const;

/** Approval-required skill-injection policy name. */
export const SKILL_INJECTION_POLICY_NAME = "repeated_skill_injection_to_state_capsule" as const;

/**
 * The set of supported compaction policy names. The first is the shipped tool-output policy;
 * the second is the approval-required skill-injection policy. A capsule or
 * applied policy carrying any OTHER name is "unsupported" and fails the safety report.
 */
export const SUPPORTED_COMPACTION_POLICY_NAMES = [COMPACTION_POLICY_NAME, SKILL_INJECTION_POLICY_NAME] as const;
export type SupportedCompactionPolicyName = (typeof SUPPORTED_COMPACTION_POLICY_NAMES)[number];

export function isSupportedCompactionPolicyName(name: string): name is SupportedCompactionPolicyName {
  return (SUPPORTED_COMPACTION_POLICY_NAMES as readonly string[]).includes(name);
}

export type ReplacementMode = "whole_message" | "embedded_payload";

export interface SourcePointer {
  traceId: string;
  messageId: string;
  messageIndex: number;
  contentSha256: string;
}

export interface ReplacedRange {
  start: number;
  end: number;
}

/**
 * Additive, backward-compatible provenance for a compacted skill injection.
 * Recorded per-capsule; not part of the trace schema.
 */
export interface SkillInjectionProvenance {
  /** Skill name parsed from the injection's `.claude/skills/<NAME>` path. */
  skillName: string;
  /**
   * Owning agent id of the REPLACED copy. Recovered from the captured message-id prefix
   * (`<agentId>-<uuid>` for subagents) or "root" when the id is a bare UUID (root-agent
   * injections such as start-cycle / complete-cycle / next-cycles).
   */
  owningAgentId: string;
  /** True when the owning agent id was recovered from a message-id prefix (subagent). */
  owningAgentIdRecoveredFromPrefix: boolean;
  /** Trace position (index) of the replaced later copy (within-context re-injection mode). */
  replacedMessagePosition: number;
  /** Id of the replaced later copy. */
  replacedMessageId: string;
  /** Trace position (index) of the retained first copy this capsule points at. */
  firstCopyPosition: number;
  /** Id of the retained first copy. */
  firstCopyMessageId: string;
}

export interface PolicyMiddlewareStateCapsule {
  id: string;
  policyName: SupportedCompactionPolicyName;
  traceId: string;
  sourcePointer: SourcePointer;
  compactedMessageIds: string[];
  replacementMode: ReplacementMode;
  replacedRanges?: ReplacedRange[];
  replacedContentSha256?: string;
  sourceExcerptPreview: string;
  originalPayloadTokenCount: number;
  text: string;
  retainedFacts: StateCapsule["retainedFacts"];
  openQuestions: StateCapsule["openQuestions"];
  safetyNotes: StateCapsule["safetyNotes"];
  /**
   * Additive, backward-compatible provenance for compacted skill injections.
   * Present ONLY on `repeated_skill_injection_to_state_capsule` capsules; undefined for the
   * tool-output policy. Not part of the trace schema.
   */
  skillInjectionProvenance?: SkillInjectionProvenance;
}

/**
 * What one policy-application run PRODUCED. The shape only — every field is a public type, and the
 * application ALGORITHM stays in the (npm-excluded) `policy-middleware`, which re-exports this name.
 *
 * Public here because public modules consume the result without producing it: `buildTokenAccounting`
 * takes one as a parameter, so its shipped declaration would otherwise import a declaration the
 * tarball withholds.
 */
export interface PolicyMiddlewareResult {
  compactedTrace?: AgentTrace;
  compactedMessages: TraceMessage[];
  stateCapsules: PolicyMiddlewareStateCapsule[];
  compactedMessageIds: string[];
  tokenEstimateBefore: TokenEstimate;
  tokenEstimateAfter: TokenEstimate;
  tokensSaved: number;
  costEstimateBefore: CostEstimate;
  costEstimateAfter: CostEstimate;
  savingsEstimate: number;
  appliedPolicyName: typeof COMPACTION_POLICY_NAME;
  /**
   * Names of every policy that compacted at least one message in this run (sequential
   * composition). Always includes the tool-output policy name; additionally
   * includes the skill-injection policy name when `compactSkillInjections` was enabled
   * AND it compacted ≥1 byte-identical injection. Used by the safety report's
   * supported-policy-set checks. Default (no approval) runs contain only the tool-output name.
   */
  appliedPolicyNames: SupportedCompactionPolicyName[];
  /** State capsules produced by the skill-injection policy only (disjoint from tool-output). */
  skillInjectionCapsules: PolicyMiddlewareStateCapsule[];
  safetyNotes: string[];
}
