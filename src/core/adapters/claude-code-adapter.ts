import { createReadStream } from "node:fs";
import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { createInterface } from "node:readline";
import type { CaptureAdapter, CaptureAdapterInput, CapturedRun, CaptureProvenance, CaptureSubagentProvenance } from "../capture-adapter.js";
import { createUsageMetadata } from "../usage-metadata.js";
import { computeTraceFingerprint } from "../trace-fingerprint.js";
import { CURRENT_AGENT_TRACE_ARTIFACT_VERSION } from "../trace-parser.js";
import type { AgentTrace, TraceMessage } from "../types.js";

//  Claude Code session JSONL entry types

interface ClaudeCodeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  service_tier?: string;
  server_tool_use?: unknown;
  cache_creation?: unknown;
  inference_geo?: string;
  iterations?: number;
  speed?: number;
}

interface ClaudeCodeContentItem {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  thinking?: string;
  signature?: string;
  tool_use_id?: string;
  content?: string | ClaudeCodeContentItem[];
}

interface ClaudeCodeMessage {
  id?: string;
  model?: string;
  role?: string;
  type?: string;
  content?: string | ClaudeCodeContentItem[];
  stop_reason?: string;
  stop_sequence?: string | null;
  stop_details?: unknown;
  usage?: ClaudeCodeUsage;
  diagnostics?: unknown;
}

interface ClaudeCodeEntry {
  type: string;
  uuid?: string;
  timestamp?: string;
  sessionId?: string;
  parentUuid?: string | null;
  isSidechain?: boolean;
  message?: ClaudeCodeMessage;
  userType?: string;
  entrypoint?: string;
  cwd?: string;
  version?: string;
  gitBranch?: string;
  promptId?: string;
  slug?: string;
  requestId?: string;
  aiTitle?: string;
  [key: string]: unknown;
}

//  Constants

const MAX_TOOL_RESULT_CHARS = 32_000;
const TRUNCATION_SUFFIX = "[TRUNCATED - full content in source session JSONL]";

export const PRIVACY_WARNING =
  "WARNING: The Claude Code session file may contain file content read during your session\n" +
  "(source code, config files, Bash output, etc.). The captured trace is written locally\n" +
  "to the output directory only. Do not share captured-trace.json artifacts without reviewing\n" +
  "them for sensitive content first.";

const SUBAGENT_WARNING =
  "Subagent JSONL files were not included in this capture. Pass --include-subagents to include them.";

//  Helpers

function extractTextContent(content: string | ClaudeCodeContentItem[] | undefined): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  return content
    .filter((item) => item.type === "text" && item.text !== undefined)
    .map((item) => item.text ?? "")
    .join("\n");
}

function serializeToolInput(input: unknown): string {
  if (input === null || input === undefined) return "";
  if (typeof input === "string") return input;
  // Deterministic key order at each nesting level
  return JSON.stringify(sortKeys(input));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(obj)
        .sort()
        .map((k) => [k, sortKeys(obj[k])])
    );
  }
  return value;
}

function truncate(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars) + "\n" + TRUNCATION_SUFFIX, truncated: true };
}

function extractToolResultContent(content: string | ClaudeCodeContentItem[] | undefined, maxChars: number): { text: string; truncated: boolean } {
  if (!content) return { text: "", truncated: false };
  if (typeof content === "string") {
    return truncate(content, maxChars);
  }
  // Join multiple content items
  const joined = content
    .map((item) => {
      if (item.type === "text") return item.text ?? "";
      if (item.type === "tool_result") {
        const inner = item.content;
        if (typeof inner === "string") return inner;
        if (Array.isArray(inner)) return inner.map((c) => (c as ClaudeCodeContentItem).text ?? "").join("\n");
      }
      return "";
    })
    .filter(Boolean)
    .join("\n---\n");
  return truncate(joined, maxChars);
}

//  Read JSONL entries

async function readJsonlEntries(sourcePath: string): Promise<ClaudeCodeEntry[]> {
  const entries: ClaudeCodeEntry[] = [];
  const rl = createInterface({
    input: createReadStream(sourcePath, { encoding: "utf8" }),
    crlfDelay: Infinity
  });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as ClaudeCodeEntry);
    } catch {
      // Skip malformed lines
    }
  }
  return entries;
}

//  Entry processing result

interface ProcessEntriesResult {
  messages: TraceMessage[];
  sessionId: string | null;
  model: string;
  aiTitle: string | undefined;
  firstTimestamp: string | undefined;
  lastTimestamp: string | undefined;
  thinkingBlockCount: number;
  truncationCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  assistantCount: number;
  userCount: number;
  otherCount: number;
  /** agentId found in subagent entries (undefined for main session) */
  agentId: string | undefined;
}

/**
 * Process a list of JSONL entries into messages and usage accumulators.
 *
 * @param entries - Parsed JSONL entries.
 * @param maxToolResultChars - Max characters for tool result content.
 * @param includeAllIsSidechain - When true (subagent mode), include user/assistant entries
 *   regardless of isSidechain (all subagent entries have isSidechain:true by design).
 *   When false (main session mode), exclude entries with isSidechain:true.
 * @param idPrefix - If provided, prefix each message id with "<idPrefix>-".
 */
function processEntries(
  entries: ClaudeCodeEntry[],
  maxToolResultChars: number,
  includeAllIsSidechain: boolean,
  idPrefix?: string
): ProcessEntriesResult {
  let sessionId: string | null = null;
  let model = "unknown";
  let aiTitle: string | undefined;
  let firstTimestamp: string | undefined;
  let lastTimestamp: string | undefined;
  let thinkingBlockCount = 0;
  let truncationCount = 0;
  let assistantCount = 0;
  let userCount = 0;
  let otherCount = 0;
  let agentId: string | undefined;

  // Build a lookup map from tool_use_id → tool type name by scanning all assistant entries.
  // This enables tool_result messages to carry the human-readable tool type name (e.g. "Read",
  // "Bash") instead of the globally-unique tool_use_id UUID, which would make waste detection
  // structurally impossible since no two UUIDs ever match.
  const toolUseIdToName = new Map<string, string>();
  for (const entry of entries) {
    if (entry.type !== "assistant") continue;
    const msg = entry.message;
    if (!msg || !msg.content || typeof msg.content === "string") continue;
    for (const item of msg.content) {
      if (item.type === "tool_use" && item.id && item.name) {
        toolUseIdToName.set(item.id, item.name);
      }
    }
  }

  const messages: TraceMessage[] = [];

  // Provider usage is aggregated ONCE PER API REQUEST, not once per JSONL line. Claude Code writes
  // one "assistant" line per content block of the same API response, and every line repeats that
  // request's usage object (same message.id / requestId). Summing per line double-counts every
  // axis (input, output, cache read, cache creation) by the number of content blocks. Keyed by
  // message.id (falling back to requestId, then the entry uuid), keeping the LAST usage seen for a
  // request so streamed partial counts resolve to the final ones.
  const usageByRequest = new Map<string, ClaudeCodeUsage>();
  let usageFallbackCounter = 0;

  for (const entry of entries) {
    // Capture sessionId from any entry
    if (!sessionId && entry.sessionId) {
      sessionId = entry.sessionId;
    }

    // Capture agentId from any entry (present in subagent files)
    if (!agentId && typeof entry["agentId"] === "string") {
      agentId = entry["agentId"] as string;
    }

    // Capture ai-title
    if (entry.type === "ai-title" && entry.aiTitle) {
      aiTitle = entry.aiTitle;
      continue;
    }

    // Skip non-conversation entries
    if (!["user", "assistant"].includes(entry.type)) {
      otherCount++;
      continue;
    }

    // isSidechain handling:
    //   Main session: exclude entries with isSidechain === true (they are subagent branches)
    //   Subagent file: include all user/assistant entries regardless of isSidechain
    //   (all subagent entries have isSidechain:true by definition)
    if (!includeAllIsSidechain && entry.isSidechain === true) {
      otherCount++;
      continue;
    }

    const timestamp = entry.timestamp ?? new Date().toISOString();
    if (!firstTimestamp) firstTimestamp = timestamp;
    lastTimestamp = timestamp;

    const makeId = (fallback: string): string => {
      const base = entry.uuid ?? fallback;
      return idPrefix ? `${idPrefix}-${base}` : base;
    };

    if (entry.type === "assistant") {
      assistantCount++;
      const msg = entry.message;
      if (!msg) continue;

      // Capture model from first assistant entry
      if (model === "unknown" && msg.model) {
        model = msg.model;
      }

      // Record usage per request (deduped across the request's content-block lines; last line wins).
      if (msg.usage) {
        const requestKey = msg.id ?? entry.requestId ?? entry.uuid ?? `no-request-id-${usageFallbackCounter++}`;
        usageByRequest.set(requestKey, msg.usage);
      }

      // Extract content items
      const content = msg.content;
      if (!content) continue;
      const items: ClaudeCodeContentItem[] = typeof content === "string"
        ? [{ type: "text", text: content }]
        : content;

      for (const item of items) {
        if (item.type === "thinking") {
          thinkingBlockCount++;
          continue; // Exclude thinking blocks
        }

        if (item.type === "text" && item.text !== undefined) {
          messages.push({
            id: makeId(`${sessionId ?? "unknown"}-${messages.length}`),
            role: "assistant",
            content: item.text,
            timestamp
          });
        } else if (item.type === "tool_use") {
          const serialized = serializeToolInput(item.input);
          const { text: truncatedContent, truncated } = truncate(serialized, maxToolResultChars);
          if (truncated) {
            truncationCount++;
          }
          messages.push({
            id: makeId(`${sessionId ?? "unknown"}-${messages.length}`),
            role: "assistant",
            content: truncatedContent,
            timestamp,
            toolName: item.name ?? undefined
          });
        }
      }
    } else if (entry.type === "user") {
      userCount++;
      const msg = entry.message;
      if (!msg) continue;

      const content = msg.content;
      if (!content) continue;

      const items: ClaudeCodeContentItem[] = typeof content === "string"
        ? [{ type: "text", text: content }]
        : content;

      for (const item of items) {
        if (item.type === "tool_result") {
          const { text: extracted, truncated } = extractToolResultContent(item.content, maxToolResultChars);
          if (truncated) {
            truncationCount++;
          }
          // Resolve tool type name from the lookup map built from assistant tool_use items.
          // Fall back to the raw tool_use_id if not found (preserves backward compatibility).
          const resolvedToolName = item.tool_use_id
            ? (toolUseIdToName.get(item.tool_use_id) ?? item.tool_use_id)
            : undefined;
          messages.push({
            id: makeId(`${sessionId ?? "unknown"}-${messages.length}`),
            role: "tool",
            content: extracted,
            timestamp,
            toolName: resolvedToolName
          });
        } else if (item.type === "text" && item.text !== undefined) {
          messages.push({
            id: makeId(`${sessionId ?? "unknown"}-${messages.length}`),
            role: "user",
            content: item.text,
            timestamp
          });
        }
      }
    }
  }

  // Sum the per-request usage - input and output are cumulative over the SAME request set (one
  // comparable basis; a session's input is the sum of every request's input, likewise output).
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheCreationTokens = 0;
  let cacheReadTokens = 0;
  for (const usage of usageByRequest.values()) {
    inputTokens += usage.input_tokens ?? 0;
    outputTokens += usage.output_tokens ?? 0;
    cacheCreationTokens += usage.cache_creation_input_tokens ?? 0;
    cacheReadTokens += usage.cache_read_input_tokens ?? 0;
  }

  return {
    messages,
    sessionId,
    model,
    aiTitle,
    firstTimestamp,
    lastTimestamp,
    thinkingBlockCount,
    truncationCount,
    inputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    assistantCount,
    userCount,
    otherCount,
    agentId
  };
}

//  Subagent meta.json shape

interface SubagentMeta {
  agentType?: string;
  description?: string;
  toolUseId?: string;
}

async function readSubagentMeta(metaPath: string): Promise<SubagentMeta | null> {
  try {
    const raw = await readFile(metaPath, "utf8");
    return JSON.parse(raw) as SubagentMeta;
  } catch {
    return null;
  }
}

//  Discover subagent JSONL files

/**
 * Discover subagent JSONL files from the subagents directory adjacent to the session file.
 * The session file is expected at: <parent>/<session-id>.jsonl
 * The subagents directory is at: <parent>/<session-id>/subagents/
 */
function discoverSubagentJSONLFiles(sessionPath: string): string[] {
  const sessionFileName = basename(sessionPath);
  const sessionId = sessionFileName.replace(/\.jsonl$/, "");
  const sessionDir = dirname(sessionPath);
  const subagentsDir = join(sessionDir, sessionId, "subagents");

  if (!existsSync(subagentsDir)) {
    return [];
  }

  let entries: string[];
  try {
    entries = readdirSync(subagentsDir);
  } catch {
    return [];
  }

  return entries
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => join(subagentsDir, name));
}

//  Session metadata scan (discovery)

/**
 * Lightweight metadata for a single discoverable Claude Code session.
 *
 * Computed by reusing the existing adapter parser (`readJsonlEntries` +
 * `processEntries` + `discoverSubagentJSONLFiles`) so the counts match what
 * `normalize()` would produce - NOT a re-implemented parser. This is metadata
 * ONLY: no session message content is surfaced.
 */
export interface ClaudeCodeSessionMetadata {
  /** Absolute path to the session JSONL file (ready for `--session <path>`). */
  sessionPath: string;
  /** Project slug (the `<slug>` directory name under projects root). */
  projectSlug: string;
  /** Decoded project working directory, if recoverable from the slug / entries. */
  projectDir: string | undefined;
  /** Session ID parsed from the session entries, or null if unknown. */
  sessionId: string | null;
  /** Earliest entry timestamp (ISO 8601), or undefined if none present. */
  firstTimestamp: string | undefined;
  /** Latest entry timestamp (ISO 8601), or undefined if none present. */
  lastTimestamp: string | undefined;
  /**
   * Message count as the adapter would produce for the MAIN session
   * (subagent messages are only merged when --include-subagents is passed,
   * so they are NOT counted here, matching the default capture).
   */
  messageCount: number;
  /** Number of subagent JSONL files discoverable under <session-id>/subagents/. */
  subagentCount: number;
  /**
   * True when at least one assistant entry carries a provider `usage` object -
   * i.e. the capture would set provider_reported_tokens: true.
   */
  providerReportedUsagePresent: boolean;
}

/**
 * Scan a single Claude Code session JSONL file for discovery metadata.
 *
 * Reuses the existing parser exactly (no re-implementation): it reads the same
 * entries `normalize()` reads, runs the same `processEntries` over the main
 * session, and counts subagent files via the same `discoverSubagentJSONLFiles`.
 * Reads only the given session file (and lists its subagents directory).
 * Surfaces metadata only; never returns message content.
 */
export async function scanSessionMetadata(
  sessionPath: string,
  projectSlug: string
): Promise<ClaudeCodeSessionMetadata> {
  const entries = await readJsonlEntries(sessionPath);
  // Same parse the adapter uses for the main session (subagents excluded by default).
  const main = processEntries(entries, MAX_TOOL_RESULT_CHARS, false, undefined);

  // provider-reported-usage present iff any assistant entry carried a usage object.
  let providerReportedUsagePresent = false;
  let projectDir: string | undefined;
  for (const entry of entries) {
    if (!providerReportedUsagePresent && entry.type === "assistant" && entry.message?.usage) {
      providerReportedUsagePresent = true;
    }
    if (projectDir === undefined && typeof entry.cwd === "string" && entry.cwd.length > 0) {
      projectDir = entry.cwd;
    }
  }

  const subagentCount = discoverSubagentJSONLFiles(sessionPath).length;

  return {
    sessionPath,
    projectSlug,
    projectDir: projectDir ?? decodeProjectSlug(projectSlug),
    sessionId: main.sessionId,
    firstTimestamp: main.firstTimestamp,
    lastTimestamp: main.lastTimestamp,
    messageCount: main.messages.length,
    subagentCount,
    providerReportedUsagePresent
  };
}

/**
 * Best-effort decode of a Claude Code project slug back to a directory path.
 * Claude Code encodes the absolute working directory by replacing path
 * separators with "-" (e.g. "-Users-me-Projects-app"). The decode is lossy
 * (real "-" in path segments are indistinguishable from separators), so this is
 * only a best-effort hint; the on-disk `cwd` from entries is preferred when
 * available. Returns undefined when the slug does not look like an encoded path.
 */
function decodeProjectSlug(slug: string): string | undefined {
  if (!slug.startsWith("-")) return undefined;
  return slug.replace(/-/g, "/");
}

//  ClaudeCodeAdapter

export class ClaudeCodeAdapter implements CaptureAdapter {
  readonly id = "claude-code";

  async normalize(input: CaptureAdapterInput): Promise<CapturedRun> {
    const maxToolResultChars: number =
      typeof input.options?.["maxToolResultChars"] === "number"
        ? (input.options["maxToolResultChars"] as number)
        : MAX_TOOL_RESULT_CHARS;

    const includeSubagents = input.options?.["includeSubagents"] === true;

    //  Process main session
    const mainEntries = await readJsonlEntries(input.sourcePath);
    const main = processEntries(mainEntries, maxToolResultChars, false, undefined);

    const {
      sessionId,
      model,
      aiTitle,
      firstTimestamp: mainFirstTs,
      lastTimestamp: mainLastTs,
      thinkingBlockCount,
      truncationCount,
      assistantCount,
      userCount,
      otherCount
    } = main;

    let inputTokens = main.inputTokens;
    let outputTokens = main.outputTokens;
    let cacheCreationTokens = main.cacheCreationTokens;
    let cacheReadTokens = main.cacheReadTokens;

    let allMessages: TraceMessage[] = [...main.messages];
    let firstTimestamp = mainFirstTs;
    let lastTimestamp = mainLastTs;

    const warnings: string[] = [PRIVACY_WARNING];

    // Add thinking block warning if any were excluded
    if (thinkingBlockCount > 0) {
      warnings.push(
        `${thinkingBlockCount} thinking block(s) excluded - content is an opaque signed blob not suitable for trace analysis.`
      );
    }

    // Add truncation warning (updated after subagent processing below if needed)
    // (handled after subagent loop)

    //  Process subagents
    const subagentProvenanceRecords: CaptureSubagentProvenance[] = [];
    let totalSubagentThinkingBlocks = thinkingBlockCount;
    let totalTruncationCount = truncationCount;

    if (includeSubagents) {
      const subagentFiles = discoverSubagentJSONLFiles(input.sourcePath);

      for (const subagentFile of subagentFiles) {
        const subagentEntries = await readJsonlEntries(subagentFile);
        // Derive agentId from the filename (e.g. a10161f797ef2c3ee.jsonl -> a10161f797ef2c3ee)
        const subagentFileName = basename(subagentFile);
        const fileAgentId = subagentFileName.replace(/\.jsonl$/, "");

        const sub = processEntries(subagentEntries, maxToolResultChars, true, fileAgentId);

        // Use agentId from entries if present; fall back to filename-derived id
        const agentId = sub.agentId ?? fileAgentId;

        // Accumulate totals
        inputTokens += sub.inputTokens;
        outputTokens += sub.outputTokens;
        cacheCreationTokens += sub.cacheCreationTokens;
        cacheReadTokens += sub.cacheReadTokens;
        totalSubagentThinkingBlocks += sub.thinkingBlockCount;
        totalTruncationCount += sub.truncationCount;

        // Track timestamps across all sources
        if (sub.firstTimestamp && (!firstTimestamp || sub.firstTimestamp < firstTimestamp)) {
          firstTimestamp = sub.firstTimestamp;
        }
        if (sub.lastTimestamp && (!lastTimestamp || sub.lastTimestamp > lastTimestamp)) {
          lastTimestamp = sub.lastTimestamp;
        }

        allMessages = allMessages.concat(sub.messages);

        // Build provenance record
        const subagentDir = dirname(subagentFile);
        const metaPath = join(subagentDir, agentId, "meta.json");
        const meta = await readSubagentMeta(metaPath);

        const record: CaptureSubagentProvenance = {
          agentId,
          entryCount: sub.assistantCount + sub.userCount
        };
        if (meta?.agentType !== undefined) record.agentType = meta.agentType;
        if (meta?.description !== undefined) record.description = meta.description;
        if (meta?.toolUseId !== undefined) record.toolUseId = meta.toolUseId;

        subagentProvenanceRecords.push(record);
      }

      // Sort all messages by timestamp ascending
      allMessages.sort((a, b) => {
        const ta = a.timestamp ?? "";
        const tb = b.timestamp ?? "";
        return ta < tb ? -1 : ta > tb ? 1 : 0;
      });
    }

    // Add thinking block warning (combined across main + subagents)
    // Already added for main above; update if subagents added more
    if (includeSubagents && totalSubagentThinkingBlocks > thinkingBlockCount) {
      // Remove the main-only thinking block warning if it was added (update count)
      const thinkingIdx = warnings.findIndex((w) => w.includes("thinking block(s) excluded"));
      const totalThinking = totalSubagentThinkingBlocks;
      if (thinkingIdx >= 0) {
        warnings[thinkingIdx] = `${totalThinking} thinking block(s) excluded - content is an opaque signed blob not suitable for trace analysis.`;
      } else if (totalThinking > 0) {
        warnings.push(
          `${totalThinking} thinking block(s) excluded - content is an opaque signed blob not suitable for trace analysis.`
        );
      }
    }

    // Add truncation warning
    if (totalTruncationCount > 0) {
      warnings.push(
        `${totalTruncationCount} content item(s) truncated at ${maxToolResultChars} characters - full content in source session JSONL.`
      );
    }

    // Add subagent warning (conditional)
    if (!includeSubagents) {
      warnings.push(SUBAGENT_WARNING);
    }

    const now = new Date().toISOString();
    const sessionPrefix = sessionId ? sessionId.slice(0, 8) : "unknown";
    const title = aiTitle ?? `Claude Code session ${sessionPrefix}`;
    const traceId = `claude-code-${sessionId ?? "unknown"}`;

    const createdAt = firstTimestamp ?? now;
    const durationMs =
      firstTimestamp && lastTimestamp
        ? Math.max(0, new Date(lastTimestamp).getTime() - new Date(firstTimestamp).getTime())
        : 0;

    const totalTokens = inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens;

    const trace: AgentTrace = {
      id: traceId,
      title,
      artifactVersion: CURRENT_AGENT_TRACE_ARTIFACT_VERSION,
      source: "real_captured",
      createdAt,
      generatedAt: now,
      model,
      durationMs,
      messages: allMessages
    };

    const usage = createUsageMetadata({
      inputTokens,
      outputTokens,
      totalTokens,
      cacheReadInputTokens: cacheReadTokens,
      cacheCreationInputTokens: cacheCreationTokens,
      providerReportedTokens: true,
      estimatedTokens: false,
      model,
      provider: "anthropic",
      limitations: [
        "Token counts are from the Claude Code session JSONL usage fields (actual API response metadata).",
        "Cost is estimated from the Anthropic price table, not from billing records.",
        "Cache read tokens priced at ~10% of standard input rate (estimated). Cache creation tokens priced at ~125% of standard input rate (estimated). Not billing-confirmed."
      ]
    });

    const limitations: string[] = [
      `Assistant entries: ${assistantCount}`,
      `User entries: ${userCount}`,
      `Other/excluded entries: ${otherCount}`,
      `Thinking blocks excluded: ${thinkingBlockCount}`,
      `Cache creation tokens (stored in provenance, not in cost estimate): ${cacheCreationTokens}`,
      `Cache read tokens (stored in provenance, not in cost estimate): ${cacheReadTokens}`
    ];

    if (includeSubagents) {
      limitations.push(
        `Subagents included: ${subagentProvenanceRecords.length} subagent JSONL file(s) processed.`
      );
    }

    // Per-run distinctness fingerprint: a one-way digest over the canonical normalized
    // trace content (NOT raw content). It is computed from `trace` after capture-time
    // fields (capturedAt/generatedAt/sourcePath/durationMs) are set, but those varying
    // fields are intentionally NOT part of the digest input (see trace-fingerprint.ts),
    // so re-capturing the same session yields the same fingerprint. Surfacing it lets
    // distinct real sessions be told apart from re-captures without ever counting a
    // re-capture as new.
    const traceFingerprint = computeTraceFingerprint(trace);

    const provenance: CaptureProvenance = {
      captureAdapter: this.id,
      sourcePath: input.sourcePath,
      capturedAt: now,
      sessionId,
      warnings,
      limitations,
      traceFingerprint,
      ...(includeSubagents ? { subagents: subagentProvenanceRecords } : {})
    };

    return { trace, usage, provenance };
  }
}
