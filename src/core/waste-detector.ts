import { estimateTextTokens } from "./token-estimator.js";
import type { AgentTrace, TraceMessage, WasteFinding } from "./types.js";

// Report-only skill-injection repetition detector. Re-exported here so callers have a
// single waste-detection entry point, but it builds its OWN dedup map (separate from the
// tool-output map below) and its `repeated_skill_injection` findings are intentionally
// NOT compacted, see getCompactedMessageIds.
export {
  detectSkillInjectionRepetition,
  buildSkillInjectionAdvisory,
  isSkillInjection,
  parseSkillName,
  type SkillInjectionFinding,
  type SkillInjectionAdvisory,
  type SkillInjectionSkillAttribution
} from "./skill-injection-detector.js";

export interface WasteDetectionThresholds {
  minDuplicateTokens?: number;
  minDuplicateCharacters?: number;
}

function normalizeContent(content: string): string {
  return content.trim().replace(/\s+/g, " ");
}

function describeTool(message: TraceMessage): string {
  return message.toolName ? `${message.toolName} tool output` : "tool output";
}

export function detectWaste(trace: AgentTrace, thresholds: WasteDetectionThresholds = {}): WasteFinding[] {
  const findings: WasteFinding[] = [];
  const firstToolOutputBySignature = new Map<string, TraceMessage>();

  for (const message of trace.messages) {
    if (message.role !== "tool") {
      continue;
    }

    const signature = `${message.toolName ?? "tool"}:${normalizeContent(message.content)}`;
    const originalMessage = firstToolOutputBySignature.get(signature);

    if (originalMessage) {
      const estimatedTokens = estimateTextTokens(message.content);
      if (
        estimatedTokens < (thresholds.minDuplicateTokens ?? 0) ||
        message.content.length < (thresholds.minDuplicateCharacters ?? 0)
      ) {
        continue;
      }

      findings.push({
        category: "repeated_tool_output",
        messageIds: [originalMessage.id, message.id],
        summary: `Repeated ${describeTool(message)}. Keep ${originalMessage.id} and compact ${message.id}.`,
        estimatedTokens
      });
      continue;
    }

    firstToolOutputBySignature.set(signature, message);
  }

  // ADDITIVE: input-compaction category 1 (superseded same-source reads). The existing
  // repeated_tool_output logic above is UNCHANGED; category-1 findings are appended so the existing
  // pipeline (getCompactedMessageIds, policy-middleware) can pick them up. Category 1 only emits when
  // an earlier same-source read GENUINELY DIFFERS from the latest, so it never overlaps an
  // identical-up-to-whitespace repeat (which stays a repeated_tool_output finding).
  findings.push(...detectSupersededSameSourceReads(trace, thresholds));

  return findings;
}

/**
 * Source identity of a tool OUTPUT for input-compaction category 1 (`superseded_same_source_read`).
 *
 * Identity = `toolName + "::" + normalizedArgs`, where `normalizedArgs` is derived from the
 * originating tool CALL: the nearest PRECEDING assistant message (since the last tool output) with
 * the SAME `toolName` whose `content` parses as the call args. Parsing is deterministic and
 * CONSERVATIVE - two accepted shapes ONLY:
 *   1. a JSON object  -> JSON.stringify with sorted keys (so key order does not change identity);
 *   2. a `"Tool call: <cmd>"` string -> the `<cmd>`, whitespace-normalized.
 * Anything else (no preceding same-tool call, unparseable content) yields `null` => the output is
 * NOT eligible for category 1 (conservative: if source identity cannot be PROVEN, do not compact).
 *
 * This is pure deterministic equality of provable source identity. There is NO scoring, threshold
 * (beyond the existing min-tokens/chars in detectWaste), weight, relevance, or learned logic here.
 */
function normalizeCallArgs(callContent: string): string | null {
  const trimmed = callContent.trim();

  // Shape 2: a "Tool call: <cmd>" string (the command form, whitespace-normalized).
  const toolCallMatch = /^Tool call:\s*(.+)$/s.exec(trimmed);
  if (toolCallMatch) {
    const command = toolCallMatch[1].trim().replace(/\s+/g, " ");
    return command.length > 0 ? `cmd:${command}` : null;
  }

  // Shape 1: a JSON object -> stable stringify with sorted keys.
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const sortedKeys = Object.keys(parsed as Record<string, unknown>).sort();
      const stable = JSON.stringify(parsed as Record<string, unknown>, sortedKeys);
      return `json:${stable}`;
    }
  } catch {
    // Not JSON - fall through to "not provable".
  }

  return null;
}

/**
 * Resolve the PROVABLE source identity of a tool output at `outputIndex`. Walks BACKWARD from the
 * output to the nearest preceding assistant message that has the SAME toolName and whose content
 * parses as call args (the originating CALL). Stops at the previous tool output boundary ("since the
 * last tool output") so a call belonging to an EARLIER output is never mis-attributed. Returns the
 * identity `toolName + "::" + normalizedArgs`, or `null` when no such parseable same-tool call exists
 * (source identity unknown/ambiguous => not eligible for category 1).
 */
function resolveSourceIdentity(messages: TraceMessage[], outputIndex: number): string | null {
  const output = messages[outputIndex];
  const toolName = output.toolName;
  if (!toolName) {
    return null;
  }

  for (let i = outputIndex - 1; i >= 0; i -= 1) {
    const candidate = messages[i];
    // Boundary: do not look past the previous tool output (a call before it originated THAT output).
    if (candidate.role === "tool") {
      return null;
    }
    if (candidate.role !== "assistant" || candidate.toolName !== toolName) {
      continue;
    }
    const normalizedArgs = normalizeCallArgs(candidate.content);
    if (normalizedArgs === null) {
      // A same-tool assistant message that is NOT a parseable call: ambiguous. Conservative -> skip.
      return null;
    }
    return `${toolName}::${normalizedArgs}`;
  }

  return null;
}

/**
 * Input-compaction category 1: detect SUPERSEDED same-source reads.
 *
 * When the SAME source (provable source identity) is read ≥2 times, the LATEST read is authoritative
 * (preserved verbatim). Each EARLIER read whose whitespace-normalized content GENUINELY DIFFERS from
 * the latest's is a superseded candidate that can be replaced by a recoverable pointer to the
 * retained original. Conservative & additive:
 *  - Outputs with NO provable source identity are skipped (not eligible).
 *  - An earlier output that is identical-up-to-whitespace to the latest is LEFT to the existing
 *    `repeated_tool_output` policy (NOT category-1-compacted) - no overlap, no double-compaction.
 *  - Each compacted (earlier) output must meet the SAME thresholds detectWaste uses
 *    (minDuplicateTokens / minDuplicateCharacters).
 *
 * Finding convention: `messageIds[0]` = KEPT latest authoritative read; `messageIds[1..]` = earlier
 * superseded reads to compact (estimatedTokens = sum of the compacted earlier reads' estimates).
 *
 * NO scoring formula, weight, relevance, or learned logic - only deterministic source-identity
 * equality + whitespace-normalized content difference + the existing min-tokens/chars thresholds.
 */
export function detectSupersededSameSourceReads(
  trace: AgentTrace,
  thresholds: WasteDetectionThresholds = {}
): WasteFinding[] {
  const minTokens = thresholds.minDuplicateTokens ?? 0;
  const minChars = thresholds.minDuplicateCharacters ?? 0;

  // Group eligible tool outputs by provable source identity, preserving order.
  const groups = new Map<string, TraceMessage[]>();
  for (let index = 0; index < trace.messages.length; index += 1) {
    const message = trace.messages[index];
    if (message.role !== "tool") {
      continue;
    }
    const identity = resolveSourceIdentity(trace.messages, index);
    if (identity === null) {
      continue; // source identity unknown/ambiguous -> not eligible (conservative)
    }
    const existing = groups.get(identity);
    if (existing) {
      existing.push(message);
    } else {
      groups.set(identity, [message]);
    }
  }

  const findings: WasteFinding[] = [];
  for (const outputs of groups.values()) {
    if (outputs.length < 2) {
      continue;
    }
    const latest = outputs[outputs.length - 1];
    const latestNormalized = normalizeContent(latest.content);

    const supersededIds: string[] = [];
    let estimatedTokens = 0;
    for (let i = 0; i < outputs.length - 1; i += 1) {
      const earlier = outputs[i];
      // GENUINE supersession ONLY: content changed (normalized-different from the latest). An
      // identical-up-to-whitespace earlier copy is the existing repeated_tool_output case -> leave it.
      if (normalizeContent(earlier.content) === latestNormalized) {
        continue;
      }
      // Same thresholds the existing detector uses, applied per compacted (earlier) output.
      const earlierTokens = estimateTextTokens(earlier.content);
      if (earlierTokens < minTokens || earlier.content.length < minChars) {
        continue;
      }
      supersededIds.push(earlier.id);
      estimatedTokens += earlierTokens;
    }

    if (supersededIds.length === 0) {
      continue;
    }

    findings.push({
      category: "superseded_same_source_read",
      messageIds: [latest.id, ...supersededIds],
      summary:
        `Superseded ${describeTool(latest)} from the same source. ` +
        `Keep latest ${latest.id} (verbatim) and compact superseded ${supersededIds.join(", ")}.`,
      estimatedTokens
    });
  }

  return findings;
}

export function getCompactedMessageIds(findings: WasteFinding[]): Set<string> {
  const compactedIds = new Set<string>();

  for (const finding of findings) {
    // Categories whose later message(s) are compacted (messageIds[0] is the KEPT message):
    //  - "repeated_tool_output": keep the first copy, compact the later identical duplicate(s).
    //  - "superseded_same_source_read" (category 1): keep the LATEST authoritative read, compact the
    //    earlier superseded copies (messageIds[1..]).
    // "repeated_skill_injection" is report-only and is NEVER compacted by this guard (its findings are
    // detected/reported but never enter the compacted set; policy-middleware also independently filters).
    if (finding.category !== "repeated_tool_output" && finding.category !== "superseded_same_source_read") {
      continue;
    }

    const [, ...duplicateIds] = finding.messageIds;
    for (const duplicateId of duplicateIds) {
      compactedIds.add(duplicateId);
    }
  }

  return compactedIds;
}
