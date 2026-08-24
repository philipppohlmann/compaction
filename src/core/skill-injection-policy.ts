import { contentHash } from "./content-hash.js";
import { estimateTextTokens } from "./token-estimator.js";
import {
  isSkillInjection,
  parseSkillName
} from "./skill-injection-detector.js";
import {
  SKILL_INJECTION_POLICY_NAME,
  type PolicyMiddlewareStateCapsule,
  type SkillInjectionProvenance,
  type SourcePointer
} from "./policy-types.js";
import type { AgentTrace, StateCapsule, TraceMessage } from "./types.js";

// Re-export the public policy-name + provenance type (now owned by ./policy-types.js) so existing
// consumers that import them from this module keep working unchanged.
export { SKILL_INJECTION_POLICY_NAME };
export type { SkillInjectionProvenance };

/**
 * APPROVAL-REQUIRED rung of the role:user skill-injection compaction policy.
 *
 * SCOPE (approval-required rung):
 * This module builds the byte-identical, same-skill `role:user` skill-injection compaction
 * candidates and their state capsules. It is the SECOND, separately-named compaction policy
 * (`repeated_skill_injection_to_state_capsule`). It NEVER runs by default: `applyCompactionPolicy`
 * only invokes it when `compactSkillInjections === true`, which is set ONLY on explicit approval
 * in the existing approve/apply loop (optimization-approval.ts). There is NO auto-apply path.
 *
 * Byte-identical-only boundary: the dedup key is the report-only detector's exact
 * `skill:normalizeExactContent(content)` key. Near-identical (same skill, divergent trailing
 * `ARGUMENTS:`) produces a DIFFERENT key and can NEVER be compacted. No prefix/fuzzy matching.
 *
 * Provenance: the capture step prefixes SUBAGENT message ids `<agentId>-<uuid>`,
 * but ROOT-agent injections carry a bare UUID (no encoded agent id). So every compacted skill
 * injection's capsule carries an ADDITIVE `skillInjectionProvenance` field recording the owning
 * agent id (parsed from the id prefix, or "root" when absent) AND the replaced copy's trace
 * position, so a consumer can reconstruct per-agent / per-position receipt even for the bare-UUID
 * root copies. This is additive metadata on the capsule; it does NOT change the AgentTrace /
 * TraceSource / TraceMessage schema.
 */

/**
 * A skill-injection compaction candidate: a later byte-identical copy to be replaced by a
 * `whole_message` state capsule pointing at the FIRST copy of its `skill:exactContent` group.
 */
export interface SkillInjectionCompactionCandidate {
  skillName: string;
  firstCopyMessage: TraceMessage;
  firstCopyIndex: number;
  replacedMessage: TraceMessage;
  replacedIndex: number;
  replacedTokens: number;
}

/**
 * Mirrors the report-only detector's normalization (trailing whitespace only). Internal
 * whitespace is preserved so near-identical bodies produce DIFFERENT keys. This MUST match
 * skill-injection-detector.ts `normalizeExactContent` exactly, the same hard safety boundary.
 */
function normalizeExactContent(content: string): string {
  return content.replace(/\s+$/, "");
}

/**
 * Recover the owning agent id of a captured message. Subagent message ids are prefixed
 * `<agentId>-<uuid>` by the claude-code adapter; root-agent ids are bare UUIDs (no prefix).
 * Returns "root" with recovered=false when no agent prefix is present.
 */
export function owningAgentIdForMessage(message: TraceMessage): {
  owningAgentId: string;
  recoveredFromPrefix: boolean;
} {
  // A bare UUID has the canonical 8-4-4-4-12 hex form. Anything with an extra leading
  // `<prefix>-` segment before a trailing UUID is a subagent-prefixed id.
  const uuid = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
  const bareUuid = new RegExp(`^${uuid}$`);
  if (bareUuid.test(message.id)) {
    return { owningAgentId: "root", recoveredFromPrefix: false };
  }
  const prefixed = message.id.match(new RegExp(`^(.+)-${uuid}$`));
  if (prefixed) {
    return { owningAgentId: prefixed[1], recoveredFromPrefix: true };
  }
  // Non-UUID id forms (e.g. test fixtures or `<session>-<n>` ids): not an agent-encoded id.
  return { owningAgentId: "root", recoveredFromPrefix: false };
}

/**
 * Find byte-identical, same-skill later skill-injection copies. First occurrence
 * of each `skill:exactContent` group is retained; each later exact-key copy is a candidate.
 * Pure: returns candidates; never mutates the trace.
 */
export function findSkillInjectionCompactionCandidates(trace: AgentTrace): SkillInjectionCompactionCandidate[] {
  const candidates: SkillInjectionCompactionCandidate[] = [];
  const firstByKey = new Map<string, { message: TraceMessage; index: number }>();

  trace.messages.forEach((message, index) => {
    if (!isSkillInjection(message)) {
      return;
    }
    const skillName = parseSkillName(message.content);
    if (skillName === null) {
      return;
    }
    const key = `${skillName}:${normalizeExactContent(message.content)}`;
    const first = firstByKey.get(key);
    if (!first) {
      firstByKey.set(key, { message, index });
      return;
    }
    candidates.push({
      skillName,
      firstCopyMessage: first.message,
      firstCopyIndex: first.index,
      replacedMessage: message,
      replacedIndex: index,
      replacedTokens: estimateTextTokens(message.content)
    });
  });

  return candidates;
}

function sourceExcerptPreview(content: string): string {
  const normalized = content.trim().replace(/\s+/g, " ");
  return normalized.length > 160 ? `${normalized.slice(0, 157)}...` : normalized;
}

function createSourcePointer(trace: AgentTrace, message: TraceMessage, messageIndex: number): SourcePointer {
  return {
    traceId: trace.id,
    messageId: message.id,
    messageIndex,
    contentSha256: contentHash(message.content)
  };
}

function createCapsuleText(
  skillName: string,
  sourcePointer: SourcePointer,
  replacedTokens: number
): string {
  return [
    `[state capsule: ${SKILL_INJECTION_POLICY_NAME}]`,
    `A byte-identical repeat of the ${skillName} skill injection was compacted before this model call.`,
    `First-copy pointer: trace=${sourcePointer.traceId} message=${sourcePointer.messageId} index=${sourcePointer.messageIndex} sha256=${sourcePointer.contentSha256}.`,
    `The original instruction body is byte-identical to the first copy and is retained locally at that pointer for audit and replay.`,
    `Estimated raw duplicate input tokens replaced: ${replacedTokens}.`
  ].join("\n");
}

/**
 * Build `whole_message` state capsules for skill-injection candidates, mirroring the tool-output
 * policy's capsule shape (`PolicyMiddlewareStateCapsule`) and reusing the same SourcePointer /
 * provenance machinery. Each capsule additionally carries `skillInjectionProvenance`.
 */
export function createSkillInjectionCapsules(
  trace: AgentTrace,
  candidates: SkillInjectionCompactionCandidate[],
  baseCapsule: Pick<StateCapsule, "retainedFacts" | "openQuestions" | "safetyNotes">,
  idOffset = 0
): PolicyMiddlewareStateCapsule[] {
  return candidates.map((candidate, index) => {
    const sourcePointer = createSourcePointer(trace, candidate.firstCopyMessage, candidate.firstCopyIndex);
    const owning = owningAgentIdForMessage(candidate.replacedMessage);
    const provenance: SkillInjectionProvenance = {
      skillName: candidate.skillName,
      owningAgentId: owning.owningAgentId,
      owningAgentIdRecoveredFromPrefix: owning.recoveredFromPrefix,
      replacedMessagePosition: candidate.replacedIndex,
      replacedMessageId: candidate.replacedMessage.id,
      firstCopyPosition: candidate.firstCopyIndex,
      firstCopyMessageId: candidate.firstCopyMessage.id
    };

    const capsule: PolicyMiddlewareStateCapsule = {
      id: `skill_injection_capsule_${idOffset + index + 1}`,
      // The capsule's policyName is the SECOND policy name. The shared type widens to a
      // string union via SupportedCompactionPolicyName (see policy-middleware.ts).
      policyName: SKILL_INJECTION_POLICY_NAME,
      traceId: trace.id,
      sourcePointer,
      compactedMessageIds: [candidate.replacedMessage.id],
      replacementMode: "whole_message",
      sourceExcerptPreview: sourceExcerptPreview(candidate.firstCopyMessage.content),
      originalPayloadTokenCount: estimateTextTokens(candidate.firstCopyMessage.content),
      text: createCapsuleText(candidate.skillName, sourcePointer, candidate.replacedTokens),
      retainedFacts: baseCapsule.retainedFacts,
      openQuestions: baseCapsule.openQuestions,
      safetyNotes: [
        ...baseCapsule.safetyNotes,
        `Byte-identical ${candidate.skillName} skill injection ${candidate.replacedMessage.id} (position ${candidate.replacedIndex}, owning agent ${provenance.owningAgentId}) replaced with a state capsule pointing at first copy ${candidate.firstCopyMessage.id}.`
      ],
      skillInjectionProvenance: provenance
    };

    return capsule;
  });
}

/**
 * Rollback / recovery: re-expand a skill-injection capsule's first-copy pointer to
 * restore the original later-copy content. Because the bytes are byte-identical by construction,
 * the restored content equals the retained first copy. Returns the restored content, or null when
 * the pointer no longer resolves (which a safety check would already have failed).
 */
export function restoreCompactedSkillInjectionContent(
  originalTrace: AgentTrace,
  capsule: PolicyMiddlewareStateCapsule
): string | null {
  const pointer = capsule.sourcePointer;
  const atIndex = originalTrace.messages[pointer.messageIndex];
  const firstCopy = atIndex?.id === pointer.messageId
    ? atIndex
    : originalTrace.messages.find((message) => message.id === pointer.messageId);
  if (!firstCopy) {
    return null;
  }
  if (contentHash(firstCopy.content) !== pointer.contentSha256) {
    return null;
  }
  return firstCopy.content;
}

/**
 * Round-trip rollback: given the compacted messages and the skill-injection capsules,
 * restore the ORIGINAL trace messages by re-expanding each capsule pointer back to the first-copy
 * bytes. Asserts byte-for-byte recovery of the later copies. Pure; returns a restored message list.
 */
export function rollbackSkillInjectionCompaction(
  originalTrace: AgentTrace,
  compactedMessages: TraceMessage[],
  capsules: PolicyMiddlewareStateCapsule[]
): TraceMessage[] {
  const restoredById = new Map<string, string>();
  for (const capsule of capsules) {
    const restored = restoreCompactedSkillInjectionContent(originalTrace, capsule);
    if (restored === null) {
      continue;
    }
    for (const compactedId of capsule.compactedMessageIds) {
      restoredById.set(compactedId, restored);
    }
  }

  return compactedMessages.map((message) => {
    const restored = restoredById.get(message.id);
    if (restored === undefined) {
      return message;
    }
    const metadata = message.metadata ? { ...message.metadata } : undefined;
    if (metadata && "compaction" in metadata) {
      delete (metadata as Record<string, unknown>).compaction;
    }
    return {
      ...message,
      content: restored,
      metadata: metadata && Object.keys(metadata).length > 0 ? metadata : undefined
    };
  });
}
