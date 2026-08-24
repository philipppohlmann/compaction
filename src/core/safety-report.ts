import { contentHash } from "./content-hash.js";
import {
  SKILL_INJECTION_POLICY_NAME,
  SUPPORTED_COMPACTION_POLICY_NAMES,
  isSupportedCompactionPolicyName
} from "./policy-types.js";
import type {
  PolicyMiddlewareStateCapsule,
  ReplacementMode,
  SkillInjectionProvenance,
  SourcePointer
} from "./policy-types.js";
import type { AgentTrace, ApprovalReadinessStatus, TraceMessage, TraceSource } from "./types.js";

export type SafetyStatus = "pass" | "warn" | "fail";
export type SafetyRiskLevel = "low" | "medium" | "high";
export type { ApprovalReadinessStatus };
export type EvidenceSourceType = "demo" | "fixture" | "imported_local" | "real_captured" | "provider_reported_usage" | "unknown";
export type ReviewerType = "human" | "internal" | "independent" | "automated" | "none";

export interface SafetyReportCheck {
  id: string;
  label: string;
  status: SafetyStatus;
  required: boolean;
  details: string;
}

export interface SafetyReport {
  run_id: string;
  generated_at: string;
  policy_name: string;
  status: SafetyStatus;
  checks: SafetyReportCheck[];
  warnings: string[];
  failures: string[];
  source_pointer_count: number;
  compacted_message_count: number;
  tokens_saved: number;
  savings_scope: "policy_level";
  source_recoverability: boolean | "unknown";
  risk_level: SafetyRiskLevel;
  recommendation: string;
  evidence_source_type: EvidenceSourceType;
  reviewer_type: ReviewerType;
  review_summary_present: boolean;
  approval_readiness_status: ApprovalReadinessStatus;
  approval_readiness_reason: string;
}

export interface CreateSafetyReportInput {
  runId: string;
  generatedAt?: string;
  originalTrace: AgentTrace;
  compactedMessages: TraceMessage[];
  stateCapsules: PolicyMiddlewareStateCapsule[];
  compactedMessageIds: string[];
  tokensSaved: number;
  policyName: string;
  reviewerType?: ReviewerType;
  reviewSummaryPresent?: boolean;
}

interface CompactionMetadata {
  policyName?: string;
  capsuleId?: string;
  rawSourcePointer?: Partial<SourcePointer>;
  compactedMessageId?: string;
  replacementMode?: ReplacementMode;
  replacedContentSha256?: string;
  skillInjectionProvenance?: SkillInjectionProvenance;
  replacements?: CompactionMetadata[];
}

function readCompactionMetadata(message: TraceMessage): CompactionMetadata[] {
  const metadata = message.metadata?.compaction as CompactionMetadata | undefined;
  if (!metadata) {
    return [];
  }

  if (Array.isArray(metadata.replacements) && metadata.replacements.length > 0) {
    return metadata.replacements;
  }

  return [metadata];
}

function isSourcePointer(value: Partial<SourcePointer> | undefined): value is SourcePointer {
  return (
    typeof value?.traceId === "string" &&
    typeof value.messageId === "string" &&
    typeof value.messageIndex === "number" &&
    typeof value.contentSha256 === "string" &&
    value.contentSha256.length > 0
  );
}

function findOriginalMessage(trace: AgentTrace, pointer: SourcePointer): TraceMessage | undefined {
  const messageAtIndex = trace.messages[pointer.messageIndex];
  if (messageAtIndex?.id === pointer.messageId) {
    return messageAtIndex;
  }

  return trace.messages.find((message) => message.id === pointer.messageId);
}

function collectMetadataForCompactedMessages(compactedMessages: TraceMessage[], compactedMessageIds: string[]): CompactionMetadata[] {
  const compactedIds = new Set(compactedMessageIds);

  return compactedMessages.flatMap((message) =>
    readCompactionMetadata(message).filter((metadata) => compactedIds.has(metadata.compactedMessageId ?? message.id))
  );
}

function addCheck(
  checks: SafetyReportCheck[],
  id: string,
  label: string,
  status: SafetyStatus,
  required: boolean,
  details: string
): void {
  checks.push({ id, label, status, required, details });
}

function statusFromChecks(checks: SafetyReportCheck[]): SafetyStatus {
  if (checks.some((check) => check.required && check.status === "fail")) {
    return "fail";
  }

  if (checks.some((check) => check.status === "warn" || check.status === "fail")) {
    return "warn";
  }

  return "pass";
}

function summarizeIssues(checks: SafetyReportCheck[], status: SafetyStatus): string[] {
  return checks.filter((check) => check.status === status).map((check) => `${check.label}: ${check.details}`);
}

function riskLevelForStatus(status: SafetyStatus): SafetyRiskLevel {
  if (status === "pass") {
    return "low";
  }

  if (status === "warn") {
    return "medium";
  }

  return "high";
}

function recommendationForStatus(status: SafetyStatus, approvalReadiness: ApprovalReadinessStatus): string {
  if (status === "pass") {
    if (approvalReadiness === "conditional") {
      return "Safety checks passed. This compaction is suitable for local inspection with the recorded source pointers and state capsules. Evidence scope is limited (demo or fixture traces, no independent reviewer) - requires real captured traces and independent review before broader approval.";
    }
    if (approvalReadiness === "ready") {
      return "Safety checks passed with real captured traces, an independent reviewer, and a complete review summary. This compaction is ready for approval.";
    }
    // approvalReadiness === "not_ready" should not occur when status === "pass", but handle defensively
    return "Safety checks passed. Review approval readiness status before applying this compaction.";
  }

  if (status === "warn") {
    return "Review missing non-critical metadata before recommending this compaction beyond local inspection.";
  }

  return "Do not recommend this compaction until the failed safety checks are fixed.";
}

export function evidenceSourceTypeFromTrace(source: TraceSource): EvidenceSourceType {
  if (source === "demo") {
    return "demo";
  }
  if (source === "manual") {
    return "fixture";
  }
  // `codex_import` is a real, user-supplied local `codex exec --json` JSONL export
  // brought in through the import/adapter path - genuine local input, stronger than a
  // hand-authored `manual` fixture, but NOT captured by this tool under controlled
  // conditions. It therefore maps to `imported_local`, which is strictly BELOW
  // `real_captured` and can never unlock the "ready" approval rung (only
  // "real_captured" does), so a passing report on a codex_import trace caps at
  // "conditional". This mirrors the provider_usage classification below.
  //
  // `cursor_import` is the SAME class for an imported real Cursor EXPORT: genuine local
  // input, stronger than a
  // `manual` fixture, strictly BELOW `real_captured`, caps at "conditional".
  if (
    source === "cli_wrapper" ||
    source === "local_command" ||
    source === "codex_import" ||
    source === "cursor_import"
  ) {
    return "imported_local";
  }
  if (source === "real_captured") {
    return "real_captured";
  }
  // A read-only provider usage/cost read is cost/spend-attribution evidence, NOT
  // compaction-safety evidence. It maps to a dedicated evidence type that, by
  // construction, can NEVER unlock the "ready" approval-readiness rung (only
  // "real_captured" does), so a passing safety report on such a record caps at
  if (source === "provider_usage") {
    return "provider_reported_usage";
  }
  return "unknown";
}

export function approvalReadinessStatusFromReport(
  status: SafetyStatus,
  evidenceSourceType: EvidenceSourceType,
  reviewerType: ReviewerType,
  reviewSummaryPresent: boolean
): ApprovalReadinessStatus {
  if (status === "fail" || status === "warn") {
    return "not_ready";
  }

  // status is "pass" - check evidence quality
  const hasRealCapture = evidenceSourceType === "real_captured";
  const hasIndependentReviewer = reviewerType === "independent" || reviewerType === "human";
  const hasReviewSummary = reviewSummaryPresent;

  if (hasRealCapture && hasIndependentReviewer && hasReviewSummary) {
    return "ready";
  }

  return "conditional";
}

export function approvalReadinessReasonFromReport(
  status: SafetyStatus,
  approvalStatus: ApprovalReadinessStatus,
  evidenceSourceType: EvidenceSourceType,
  reviewerType: ReviewerType,
  reviewSummaryPresent: boolean
): string {
  if (approvalStatus === "not_ready") {
    if (status === "fail") {
      return "Safety checks failed - approval cannot proceed until all required checks pass.";
    }
    return "Safety checks produced warnings - review warnings before considering approval.";
  }

  if (approvalStatus === "ready") {
    return "Safety checks passed with real captured traces, an independent reviewer, and a complete review summary.";
  }

  // conditional
  const reasons: string[] = [];
  if (evidenceSourceType !== "real_captured") {
    const label =
      evidenceSourceType === "demo"
        ? "demo"
        : evidenceSourceType === "fixture"
          ? "fixture"
          : evidenceSourceType === "imported_local"
            ? "imported local"
            : evidenceSourceType === "provider_reported_usage"
              ? "provider-reported usage/cost (cost/spend evidence, not compaction-safety evidence)"
              : "unknown";
    const captureHint =
      evidenceSourceType === "demo" || evidenceSourceType === "fixture"
        ? ` - use \`compaction capture claude-code --session <path>\` to capture a real session`
        : "";
    reasons.push(`evidence is ${label} only - requires real captured traces before approval${captureHint}`);
  }
  if (reviewerType !== "independent" && reviewerType !== "human") {
    reasons.push("no independent reviewer assigned");
  }
  if (!reviewSummaryPresent) {
    reasons.push("no review summary generated");
  }

  const reasonText = reasons.length > 0 ? reasons.join("; ") : "evidence quality is insufficient for full approval";
  return `Safety checks passed but ${reasonText}.`;
}

/** Trailing-whitespace-only normalization - MUST match skill-injection-policy.ts / detector. */
function normalizeExactContent(content: string): string {
  return content.replace(/\s+$/, "");
}

interface SkillInjectionCheckResult {
  applied: boolean;
  byteIdenticalEquality: { status: SafetyStatus; details: string };
  firstOfGroupRetained: { status: SafetyStatus; details: string };
  noCrossSkillGroup: { status: SafetyStatus; details: string };
  provenancePresent: { status: SafetyStatus; details: string };
}

/**
 * Compute the 4 NEW skill-injection-specific safety checks. The checks are
 * "applied" (and `required`) whenever the skill-injection policy compacted ≥1 message - detected
 * EITHER from a `repeated_skill_injection_to_state_capsule` state capsule OR from compacted
 * metadata carrying that policy name. The capsule gate is the robust one: it means an adversary
 * cannot silence the checks by stripping the per-message provenance metadata - doing so instead
 * trips the provenance-present check (a missing-provenance compacted message is a failure, not N/A).
 */
function computeSkillInjectionChecks(
  originalTrace: AgentTrace,
  compactedMetadata: CompactionMetadata[],
  stateCapsules: PolicyMiddlewareStateCapsule[]
): SkillInjectionCheckResult {
  const skillCapsules = stateCapsules.filter((capsule) => capsule.policyName === SKILL_INJECTION_POLICY_NAME);
  const skillMetadata = compactedMetadata.filter((metadata) => metadata.policyName === SKILL_INJECTION_POLICY_NAME);

  if (skillCapsules.length === 0 && skillMetadata.length === 0) {
    const na = { status: "pass" as SafetyStatus, details: "No skill-injection compaction in this run; check not applicable." };
    return {
      applied: false,
      byteIdenticalEquality: na,
      firstOfGroupRetained: na,
      noCrossSkillGroup: na,
      provenancePresent: na
    };
  }

  // The set of compacted skill-injection message ids - from capsules (authoritative) unioned with
  // metadata-declared ids - so a stripped-metadata message is still checked for provenance.
  const compactedSkillMessageIds = new Set<string>([
    ...skillCapsules.flatMap((capsule) => capsule.compactedMessageIds),
    ...skillMetadata.map((metadata) => metadata.compactedMessageId).filter((id): id is string => typeof id === "string")
  ]);
  const provenanceByCompactedId = new Map(
    skillMetadata
      .filter((metadata) => metadata.skillInjectionProvenance && metadata.compactedMessageId)
      .map((metadata) => [metadata.compactedMessageId as string, metadata.skillInjectionProvenance!] as const)
  );

  const messageById = new Map(originalTrace.messages.map((message) => [message.id, message] as const));
  // First-copy pointer per compacted id, from the authoritative capsule set (used when the
  // per-message metadata provenance has been stripped).
  const firstCopyIdByCompactedId = new Map<string, string>();
  for (const capsule of skillCapsules) {
    for (const compactedId of capsule.compactedMessageIds) {
      firstCopyIdByCompactedId.set(compactedId, capsule.sourcePointer.messageId);
    }
  }

  const equalityFailures: string[] = []; // Check 1
  const provenanceFailures: string[] = []; // Check 4
  const firstCopyCompacted: string[] = []; // Check 2
  const groupSkillNames = new Map<string, Set<string>>(); // Check 3

  for (const compactedId of compactedSkillMessageIds) {
    const provenance = provenanceByCompactedId.get(compactedId);

    // Check 4: provenance present (owning-agent id + replaced position) for every compacted injection.
    const provenanceComplete =
      provenance !== undefined &&
      typeof provenance.owningAgentId === "string" &&
      provenance.owningAgentId.length > 0 &&
      typeof provenance.replacedMessagePosition === "number" &&
      provenance.replacedMessagePosition >= 0;
    if (!provenanceComplete) {
      provenanceFailures.push(compactedId);
    }

    // Resolve the first-copy id from metadata provenance, else from the capsule pointer.
    const firstCopyId = provenance?.firstCopyMessageId ?? firstCopyIdByCompactedId.get(compactedId);

    // Check 1: byte-identical (normalized sha256) equality between the compacted later copy and
    // its first-copy source - the machine guarantee of the hard safety boundary.
    const firstCopy = firstCopyId ? messageById.get(firstCopyId) : undefined;
    const replacedCopy = messageById.get(compactedId);
    if (!firstCopy || !replacedCopy) {
      equalityFailures.push(`${compactedId} (missing source in original trace)`);
    } else if (
      contentHash(normalizeExactContent(firstCopy.content)) !== contentHash(normalizeExactContent(replacedCopy.content))
    ) {
      equalityFailures.push(`${compactedId} (normalized content not byte-identical to first copy ${firstCopyId})`);
    }

    // Check 2: the first occurrence of each group is retained - a first-copy id must never appear
    // among the compacted ids.
    if (firstCopyId && compactedSkillMessageIds.has(firstCopyId)) {
      firstCopyCompacted.push(firstCopyId);
    }

    // Check 3: no compacted group spans more than one skill name. Group by first-copy id.
    if (firstCopyId && provenance?.skillName) {
      const set = groupSkillNames.get(firstCopyId) ?? new Set<string>();
      set.add(provenance.skillName);
      groupSkillNames.set(firstCopyId, set);
    }
  }

  const crossSkillGroups = [...groupSkillNames.entries()].filter(([, names]) => names.size > 1);

  return {
    applied: true,
    byteIdenticalEquality: {
      status: equalityFailures.length === 0 ? "pass" : "fail",
      details:
        equalityFailures.length === 0
          ? `All ${compactedSkillMessageIds.size} compacted skill injection(s) are byte-identical (sha256) to their first-copy source.`
          : `Non-byte-identical compacted skill injection(s): ${equalityFailures.join(", ")}.`
    },
    firstOfGroupRetained: {
      status: firstCopyCompacted.length === 0 ? "pass" : "fail",
      details:
        firstCopyCompacted.length === 0
          ? "The first occurrence of every (skill, exact-content) group is retained (never compacted)."
          : `First-of-group copy was compacted: ${[...new Set(firstCopyCompacted)].join(", ")}.`
    },
    noCrossSkillGroup: {
      status: crossSkillGroups.length === 0 ? "pass" : "fail",
      details:
        crossSkillGroups.length === 0
          ? "No compacted group spans more than one skill name."
          : `Cross-skill group(s) detected for first copy: ${crossSkillGroups.map(([id]) => id).join(", ")}.`
    },
    provenancePresent: {
      status: provenanceFailures.length === 0 ? "pass" : "fail",
      details:
        provenanceFailures.length === 0
          ? "Owning-agent-id + replaced-position provenance is present for every compacted skill injection."
          : `Missing provenance for compacted skill injection(s): ${provenanceFailures.join(", ")}.`
    }
  };
}

export function createSafetyReport(input: CreateSafetyReportInput): SafetyReport {
  if (input.compactedMessageIds.length === 0 && input.stateCapsules.length === 0) {
    const noCompactionEvidenceSource = evidenceSourceTypeFromTrace(input.originalTrace.source);
    const noCompactionReviewerType: ReviewerType = input.reviewerType ?? "none";
    const noCompactionReviewSummaryPresent = input.reviewSummaryPresent ?? false;
    const noCompactionApprovalStatus = approvalReadinessStatusFromReport(
      "pass",
      noCompactionEvidenceSource,
      noCompactionReviewerType,
      noCompactionReviewSummaryPresent
    );

    return {
      run_id: input.runId,
      generated_at: input.generatedAt ?? new Date().toISOString(),
      policy_name: input.policyName,
      status: "pass",
      checks: [
        {
          id: "no_compaction_applied",
          label: "No compaction was applied",
          status: "pass",
          required: true,
          details: "No duplicate tool output met the policy thresholds. No context was removed and no safety evidence is required."
        }
      ],
      warnings: [],
      failures: [],
      source_pointer_count: 0,
      compacted_message_count: 0,
      tokens_saved: 0,
      savings_scope: "policy_level",
      source_recoverability: "unknown",
      risk_level: "low",
      recommendation: "No compaction was applied. The original trace is unchanged.",
      evidence_source_type: noCompactionEvidenceSource,
      reviewer_type: noCompactionReviewerType,
      review_summary_present: noCompactionReviewSummaryPresent,
      approval_readiness_status: noCompactionApprovalStatus,
      approval_readiness_reason: approvalReadinessReasonFromReport(
        "pass",
        noCompactionApprovalStatus,
        noCompactionEvidenceSource,
        noCompactionReviewerType,
        noCompactionReviewSummaryPresent
      )
    };
  }

  const checks: SafetyReportCheck[] = [];
  const compactedMetadata = collectMetadataForCompactedMessages(input.compactedMessages, input.compactedMessageIds);
  const sourcePointers = compactedMetadata.flatMap((metadata) =>
    isSourcePointer(metadata.rawSourcePointer) ? [metadata.rawSourcePointer] : []
  );
  const sourcePointerKeys = new Set(
    sourcePointers.map((pointer) => `${pointer.traceId}:${pointer.messageId}:${pointer.messageIndex}:${pointer.contentSha256}`)
  );
  const capsuleByCompactedMessageId = new Map(
    input.stateCapsules.flatMap((capsule) => capsule.compactedMessageIds.map((messageId) => [messageId, capsule] as const))
  );
  const missingCapsuleIds = input.compactedMessageIds.filter((messageId) => !capsuleByCompactedMessageId.has(messageId));
  const messagesWithMetadata = new Set(compactedMetadata.map((metadata) => metadata.compactedMessageId).filter(Boolean));
  const allMetadataPresent = input.compactedMessageIds.every((messageId) => messagesWithMetadata.has(messageId));
  const allMetadataPolicyNamesPresent = compactedMetadata.every((metadata) => typeof metadata.policyName === "string");
  const allMetadataReplacementModesPresent = compactedMetadata.every(
    (metadata) => metadata.replacementMode === "whole_message" || metadata.replacementMode === "embedded_payload"
  );
  const allMetadataRawPointersPresent = input.compactedMessageIds.length > 0 && compactedMetadata.every((metadata) => isSourcePointer(metadata.rawSourcePointer));
  const allMetadataContentHashesPresent = compactedMetadata.every(
    (metadata) =>
      (isSourcePointer(metadata.rawSourcePointer) && metadata.rawSourcePointer.contentSha256.length > 0) ||
      (typeof metadata.replacedContentSha256 === "string" && metadata.replacedContentSha256.length > 0)
  );
  const unavailablePointers = sourcePointers.filter((pointer) => {
    if (pointer.traceId !== input.originalTrace.id) {
      return true;
    }

    const originalMessage = findOriginalMessage(input.originalTrace, pointer);
    return !originalMessage;
  });
  const pointersWithPayloadMismatch = sourcePointers.filter((pointer) => {
    const originalMessage = findOriginalMessage(input.originalTrace, pointer);
    return originalMessage ? contentHash(originalMessage.content) !== pointer.contentSha256 : false;
  });
  const capsulesReferenceOriginalSource = input.stateCapsules.every((capsule) => {
    const pointer = capsule.sourcePointer;
    return pointer.traceId === input.originalTrace.id && Boolean(findOriginalMessage(input.originalTrace, pointer));
  });
  // Supported-policy SET: both the shipped tool-output policy and the
  // approval-required skill-injection policy are supported. Any OTHER policy name is unsupported.
  const unsupportedMetadataPolicies = compactedMetadata.filter(
    (metadata) => metadata.policyName && !isSupportedCompactionPolicyName(metadata.policyName)
  );
  const unsupportedCapsulePolicies = input.stateCapsules.filter(
    (capsule) => !isSupportedCompactionPolicyName(capsule.policyName)
  );
  const unsupportedPolicyApplied =
    !isSupportedCompactionPolicyName(input.policyName) ||
    unsupportedMetadataPolicies.length > 0 ||
    unsupportedCapsulePolicies.length > 0;

  addCheck(
    checks,
    "raw_payload_preserved_by_source_pointer",
    "Raw payload preserved by source pointer",
    sourcePointers.length > 0 && unavailablePointers.length === 0 && pointersWithPayloadMismatch.length === 0 ? "pass" : "fail",
    true,
    sourcePointers.length === 0
      ? "No raw source pointer was recorded."
      : unavailablePointers.length > 0
        ? `Source pointer(s) do not resolve to original trace message(s): ${unavailablePointers.map((pointer) => pointer.messageId).join(", ")}.`
        : pointersWithPayloadMismatch.length > 0
          ? `Source pointer content hash mismatch for message(s): ${pointersWithPayloadMismatch.map((pointer) => pointer.messageId).join(", ")}.`
          : `${sourcePointers.length} source pointer(s) resolve to original trace payloads with matching hashes.`
  );
  addCheck(
    checks,
    "state_capsule_exists",
    "State capsule exists",
    missingCapsuleIds.length === 0 && input.compactedMessageIds.length > 0 ? "pass" : "fail",
    true,
    input.compactedMessageIds.length === 0
      ? "No compacted messages were recorded, so no state capsule can cover compacted output."
      : missingCapsuleIds.length === 0
        ? `${input.stateCapsules.length} state capsule(s) cover compacted messages.`
        : `Missing state capsule for compacted message(s): ${missingCapsuleIds.join(", ")}.`
  );
  addCheck(
    checks,
    "state_capsule_references_original_source",
    "State capsule references original source message",
    input.stateCapsules.length > 0 && capsulesReferenceOriginalSource ? "pass" : "fail",
    true,
    input.stateCapsules.length === 0
      ? "No state capsules were recorded for compacted messages."
      : capsulesReferenceOriginalSource
        ? "Every state capsule source pointer resolves to the original trace."
        : "At least one state capsule source pointer does not resolve to the original trace."
  );
  addCheck(
    checks,
    "metadata_policy_name",
    "Compacted message metadata includes policyName",
    allMetadataPresent && allMetadataPolicyNamesPresent ? "pass" : "warn",
    false,
    allMetadataPolicyNamesPresent ? "Every compaction metadata entry records policyName." : "At least one metadata entry is missing policyName."
  );
  addCheck(
    checks,
    "metadata_replacement_mode",
    "Compacted message metadata includes replacementMode",
    allMetadataPresent && allMetadataReplacementModesPresent ? "pass" : "warn",
    false,
    allMetadataReplacementModesPresent
      ? "Every compaction metadata entry records replacementMode."
      : "At least one metadata entry is missing replacementMode."
  );
  addCheck(
    checks,
    "metadata_raw_source_pointer",
    "Compacted message metadata includes rawSourcePointer",
    allMetadataRawPointersPresent ? "pass" : "fail",
    true,
    input.compactedMessageIds.length === 0
      ? "No compacted messages were recorded, so no rawSourcePointer metadata can be validated."
      : allMetadataRawPointersPresent
        ? "Every compaction metadata entry records rawSourcePointer."
        : "At least one compacted message is missing rawSourcePointer metadata."
  );
  addCheck(
    checks,
    "metadata_content_hash",
    "Compacted message metadata includes content hash",
    allMetadataPresent && allMetadataContentHashesPresent ? "pass" : "warn",
    false,
    allMetadataContentHashesPresent
      ? "Every compaction metadata entry includes a content hash."
      : "At least one metadata entry is missing a content hash."
  );
  addCheck(
    checks,
    "source_message_available",
    "Source message remains available in original trace",
    unavailablePointers.length === 0 && sourcePointers.length > 0 ? "pass" : "fail",
    true,
    sourcePointers.length === 0
      ? "No source pointers were recorded for compacted messages."
      : unavailablePointers.length === 0
        ? "All source messages remain available in the original trace."
        : `Unavailable source pointer(s): ${unavailablePointers.map((pointer) => pointer.messageId).join(", ")}.`
  );
  addCheck(
    checks,
    "positive_token_savings",
    "Token savings are positive",
    input.tokensSaved > 0 ? "pass" : "fail",
    true,
    `${input.tokensSaved} input token(s) saved.`
  );
  addCheck(
    checks,
    "policy_name_expected",
    "Policy name is one of the supported compaction policies",
    isSupportedCompactionPolicyName(input.policyName) ? "pass" : "fail",
    true,
    `Policy name: ${input.policyName}. Supported: ${SUPPORTED_COMPACTION_POLICY_NAMES.join(", ")}.`
  );
  addCheck(
    checks,
    "no_unsupported_policy",
    "No unsupported policy was applied",
    unsupportedPolicyApplied ? "fail" : "pass",
    true,
    unsupportedPolicyApplied ? "Unsupported policy metadata was found." : "Only supported policies were applied."
  );

  // NEW skill-injection-specific checks. Only relevant - and only `required` - when
  // the approval-required skill-injection policy compacted ≥1 message. For the tool-output-only
  // path these are informational passes and do not change existing behavior.
  const skillChecks = computeSkillInjectionChecks(input.originalTrace, compactedMetadata, input.stateCapsules);
  addCheck(
    checks,
    "skill_injection_byte_identical_equality",
    "Every compacted skill injection is byte-identical to its first-copy source",
    skillChecks.byteIdenticalEquality.status,
    skillChecks.applied,
    skillChecks.byteIdenticalEquality.details
  );
  addCheck(
    checks,
    "skill_injection_first_of_group_retained",
    "First occurrence of each (skill, exact-content) group is retained",
    skillChecks.firstOfGroupRetained.status,
    skillChecks.applied,
    skillChecks.firstOfGroupRetained.details
  );
  addCheck(
    checks,
    "skill_injection_no_cross_skill_group",
    "No compacted skill-injection group spans more than one skill name",
    skillChecks.noCrossSkillGroup.status,
    skillChecks.applied,
    skillChecks.noCrossSkillGroup.details
  );
  addCheck(
    checks,
    "skill_injection_provenance_present",
    "Owning-agent-id + replaced-position provenance present for every compacted skill injection",
    skillChecks.provenancePresent.status,
    skillChecks.applied,
    skillChecks.provenancePresent.details
  );

  const preliminaryStatus = statusFromChecks(checks);
  addCheck(
    checks,
    "valid_safety_status",
    "Safety status is one of pass, warn, fail",
    ["pass", "warn", "fail"].includes(preliminaryStatus) ? "pass" : "fail",
    true,
    `Safety status: ${preliminaryStatus}.`
  );

  const status = statusFromChecks(checks);
  const evidenceSourceType = evidenceSourceTypeFromTrace(input.originalTrace.source);
  const reviewerType: ReviewerType = input.reviewerType ?? "none";
  const reviewSummaryPresent = input.reviewSummaryPresent ?? false;
  const approvalStatus = approvalReadinessStatusFromReport(status, evidenceSourceType, reviewerType, reviewSummaryPresent);

  return {
    run_id: input.runId,
    generated_at: input.generatedAt ?? new Date().toISOString(),
    policy_name: input.policyName,
    status,
    checks,
    warnings: summarizeIssues(checks, "warn"),
    failures: summarizeIssues(checks, "fail"),
    source_pointer_count: sourcePointerKeys.size,
    compacted_message_count: input.compactedMessageIds.length,
    tokens_saved: input.tokensSaved,
    savings_scope: "policy_level",
    source_recoverability: sourcePointers.length === 0 ? "unknown" : unavailablePointers.length === 0,
    risk_level: riskLevelForStatus(status),
    recommendation: recommendationForStatus(status, approvalStatus),
    evidence_source_type: evidenceSourceType,
    reviewer_type: reviewerType,
    review_summary_present: reviewSummaryPresent,
    approval_readiness_status: approvalStatus,
    approval_readiness_reason: approvalReadinessReasonFromReport(status, approvalStatus, evidenceSourceType, reviewerType, reviewSummaryPresent)
  };
}

export function formatSafetyMarkdownReport(report: SafetyReport): string {
  const passedChecks = report.checks.filter((check) => check.status === "pass");
  const warnings = report.warnings.length > 0 ? report.warnings : ["None."];
  const failures = report.failures.length > 0 ? report.failures : ["None."];

  return [
    `# Safety Report: ${report.run_id}`,
    "",
    `**Status:** ${report.status.toUpperCase()}`,
    `**Risk level:** ${report.risk_level}`,
    `**Policy:** ${report.policy_name}`,
    `${report.savings_scope === "policy_level" ? "**Policy-level tokens saved:**" : "**Tokens saved:**"} ${report.tokens_saved}`,
    `**Compacted messages:** ${report.compacted_message_count}`,
    `**Source pointers:** ${report.source_pointer_count}`,
    `**Source recoverability:** ${report.source_recoverability}`,
    "",
    "## Checks passed",
    ...passedChecks.map((check) => `- ${check.label}: ${check.details}`),
    "",
    "## Warnings",
    ...warnings.map((warning) => `- ${warning}`),
    "",
    "## Failures",
    ...failures.map((failure) => `- ${failure}`),
    "",
    "## Recommendation",
    report.recommendation,
    "",
    "## Known limitations",
    "- Safety Report v0 is deterministic local safety evidence, not semantic replay.",
    "- It validates source pointers, state capsules, supported policy metadata, and positive token savings only.",
    "- It does not call model providers, perform fuzzy matching, or prove task-level semantic equivalence."
  ].join("\n");
}
