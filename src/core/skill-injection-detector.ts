import { estimateTextTokens } from "./token-estimator.js";
import type { AgentTrace, TraceMessage, WasteFinding } from "./types.js";

/**
 * Report-only skill-injection repetition detector.
 *
 * SCOPE (report-only rung):
 * This module DETECTS and REPORTS repeated byte-identical, same-skill `role:user`
 * skill injections. It compacts NOTHING. The `repeated_skill_injection` finding
 * category it produces is intentionally excluded from `getCompactedMessageIds`
 * (see waste-detector.ts) and from the apply path (policy-middleware.ts), so the
 * policy is report-only by construction. No message is ever removed, replaced, or
 * capsuled by this detector.
 *
 * The dedup map here is SEPARATE from the tool-output dedup map in `detectWaste`.
 * An ordinary `role:user`/orchestrator message can never enter this candidate set
 * because the identification gate requires the literal skill-injection prefix and a
 * parseable skill name.
 *
 * Open questions resolved against a real --include-subagents capture
 * (ae4dce14-e4ef-4d50-a852-f531fc53b490, 131 injection messages):
 * - Q5 (threshold reuse): the smallest captured injection body is 1,267 chars / 317 est
 *   tokens, every body is well above the existing 800-char / 200-token tool-output
 *   thresholds, so those thresholds are effectively moot for this policy. This detector
 *   therefore applies no size threshold (full exact-key dedup is the rule).
 * - Q2 (owning-agent-id recoverability): capture prefixes SUBAGENT message ids
 *   `agent-<agentId>-<uuid>`, so for the 108 subagent injections the owning agent id IS
 *   recoverable from `messageId` alone. The 23 ROOT-agent injections (start-cycle,
 *   complete-cycle, next-cycles) carry a bare UUID with NO agent prefix, so root-agent
 *   identity is NOT encoded in `messageId`. Report-only does not act on this; at the later
 *   apply rung a small additive provenance field would be needed to record root-agent
 *   identity + replaced-position for the bare-UUID copies.
 */

const SKILL_INJECTION_PREFIX = "Base directory for this skill:";

// Matches the skill name in the `.../.claude/skills/<NAME>` path on the first line.
const SKILL_PATH_PATTERN = /\.claude\/skills\/([A-Za-z0-9._-]+)/;

export interface SkillInjectionFinding extends WasteFinding {
  category: "repeated_skill_injection";
  skillName: string;
  /** The first (retained) copy's message id. Never compacted. */
  firstCopyMessageId: string;
  /** The later byte-identical copy's message id (the redundant, reportable volume). */
  redundantCopyMessageId: string;
}

export interface SkillInjectionSkillAttribution {
  skill_name: string;
  /** Number of redundant byte-identical copies (second-and-later occurrences). */
  redundant_byte_identical_copies: number;
  /** Estimated (chars/4) trace tokens carried by the redundant copies, NOT realized savings. */
  estimated_tokens: number;
  redundant_copy_message_ids: string[];
}

export interface SkillInjectionAdvisory {
  /** Report-only advisory. Nothing was compacted; these are detection-only figures. */
  report_only: true;
  /** Distinct skills that have at least one redundant byte-identical copy. */
  skills: SkillInjectionSkillAttribution[];
  /** Total redundant byte-identical copies across all skills. */
  total_redundant_byte_identical_copies: number;
  /** Total addressable est trace-token volume (chars/4) the policy COULD unlock if applied later. */
  total_addressable_estimated_tokens: number;
  /** Number of first/unique injection copies that are retained (never candidates). */
  first_copy_count: number;
  estimate_label: string;
  recommendation: string;
}

const ESTIMATE_LABEL =
  "estimated (chars/4) trace-token reduction - NOT billing-confirmed, NOT realized savings, NOT yet applied";

const RECOMMENDATION =
  "Report-only: no message was compacted. The byte-identical, same-skill skill-injection " +
  "repetition above is the addressable volume a future approval-required rung could compact. " +
  "Near-identical (ARGUMENTS-divergent) injections are excluded by construction and are never addressable.";

export function parseSkillName(content: string): string | null {
  const firstLine = content.split("\n", 1)[0] ?? "";
  const match = firstLine.match(SKILL_PATH_PATTERN);
  return match ? match[1] : null;
}

export function isSkillInjection(message: TraceMessage): boolean {
  return (
    message.role === "user" &&
    typeof message.content === "string" &&
    message.content.startsWith(SKILL_INJECTION_PREFIX) &&
    parseSkillName(message.content) !== null
  );
}

/**
 * Normalize for the EXACT (byte-identical) dedup key. Trailing whitespace only is
 * trimmed (per the design's `normalizeTrailingWhitespace`). Internal whitespace is
 * preserved so near-identical bodies (divergent trailing `ARGUMENTS:` blocks)
 * produce DIFFERENT keys and can never be grouped. This is the hard safety boundary.
 */
function normalizeExactContent(content: string): string {
  return content.replace(/\s+$/, "");
}

/**
 * Detect repeated byte-identical, same-skill skill injections.
 *
 * Key = `${skillName}:${normalizeExactContent(content)}`, exact, NOT a prefix, NOT fuzzy.
 * First occurrence of each key is retained; each later exact-key copy is a redundant
 * byte-identical candidate (the reportable volume). Different normalized content (e.g.
 * divergent ARGUMENTS) ⇒ different key ⇒ never grouped (near-identical excluded by
 * construction). Two different skills can never share a key because the key is prefixed
 * with the parsed skill name.
 *
 * REPORT-ONLY: returns findings; never mutates the trace.
 */
export function detectSkillInjectionRepetition(trace: AgentTrace): SkillInjectionFinding[] {
  const findings: SkillInjectionFinding[] = [];
  const firstBySkillExactContent = new Map<string, TraceMessage>();

  for (const message of trace.messages) {
    if (!isSkillInjection(message)) {
      continue;
    }

    const skillName = parseSkillName(message.content);
    if (skillName === null) {
      continue;
    }

    const key = `${skillName}:${normalizeExactContent(message.content)}`;
    const firstCopy = firstBySkillExactContent.get(key);

    if (!firstCopy) {
      firstBySkillExactContent.set(key, message);
      continue;
    }

    findings.push({
      category: "repeated_skill_injection",
      messageIds: [firstCopy.id, message.id],
      summary: `Repeated byte-identical ${skillName} skill injection. Retain ${firstCopy.id}; ${message.id} is a redundant byte-identical copy (report-only, not compacted).`,
      estimatedTokens: estimateTextTokens(message.content),
      skillName,
      firstCopyMessageId: firstCopy.id,
      redundantCopyMessageId: message.id
    });
  }

  return findings;
}

function countUniqueFirstCopies(trace: AgentTrace): number {
  const keys = new Set<string>();
  for (const message of trace.messages) {
    if (!isSkillInjection(message)) {
      continue;
    }
    const skillName = parseSkillName(message.content);
    if (skillName === null) {
      continue;
    }
    keys.add(`${skillName}:${normalizeExactContent(message.content)}`);
  }
  return keys.size;
}

/**
 * Build the report-only advisory (per-skill spend attribution + total addressable est).
 * Pure: derived from the detector findings; nothing is compacted.
 */
export function buildSkillInjectionAdvisory(trace: AgentTrace): SkillInjectionAdvisory {
  const findings = detectSkillInjectionRepetition(trace);
  const bySkill = new Map<string, SkillInjectionSkillAttribution>();
  let totalTokens = 0;

  for (const finding of findings) {
    const bucket = bySkill.get(finding.skillName) ?? {
      skill_name: finding.skillName,
      redundant_byte_identical_copies: 0,
      estimated_tokens: 0,
      redundant_copy_message_ids: []
    };
    bucket.redundant_byte_identical_copies += 1;
    bucket.estimated_tokens += finding.estimatedTokens;
    bucket.redundant_copy_message_ids.push(finding.redundantCopyMessageId);
    bySkill.set(finding.skillName, bucket);
    totalTokens += finding.estimatedTokens;
  }

  const skills = [...bySkill.values()].sort((a, b) => b.estimated_tokens - a.estimated_tokens);

  return {
    report_only: true,
    skills,
    total_redundant_byte_identical_copies: findings.length,
    total_addressable_estimated_tokens: totalTokens,
    first_copy_count: countUniqueFirstCopies(trace),
    estimate_label: ESTIMATE_LABEL,
    recommendation: RECOMMENDATION
  };
}
