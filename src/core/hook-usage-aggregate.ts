/**
 * Aggregate the content-free Claude Code hook usage records (PUBLIC CLI/SDK code, engine-free).
 * Rolls up the records written by `capture claude-code --from-hook`
 * (`.compaction/hooks/**​/records/*.json`) into a CONTENT-FREE source-status view, by tool, by session,
 * and over a time window, mirroring the `/app` source-status model (events / input / output / token
 * sources / providers / models / provider-reported-vs-unavailable). Local-first; no network.
 *
 * Invariants:
 *  - Content-free in / content-free out: counts, honest source, ids, providers, models, timestamps only.
 *    No prompt/completion/message content, no transcript content, no `last_assistant_message`.
 *  - Missing usage stays null / unavailable, never 0. A tool with no recorded input tokens reports
 *    `inputTokens: null`, not 0.
 *  - Token source labels are preserved exactly (provider-reported / local-estimate / unknown).
 *  - Idempotent: records are deduped by `dedupKey` so the same Stop/session state is counted once.
 *  - No savings claim, this surfaces usage only.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  CLAUDE_CODE_HOOK_RECORD_SCHEMA,
  type ClaudeCodeHookRecord
} from "./claude-code-hook-record.js";
import {
  coalesceClaudeLogicalRuns,
  validateActivityEventForStore
} from "./activity-store.js";
import {
  validClaudeLogicalRunId,
  validClaudeLogicalSessionId
} from "./claude-logical-run-id.js";

export const HOOK_USAGE_AGGREGATE_SCHEMA = "compaction.hook-usage-aggregate.v1" as const;

/** A loaded record plus nothing else, we only ever read the content-free fields. */
function isHookRecord(value: unknown): value is ClaudeCodeHookRecord {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return v.schema === CLAUDE_CODE_HOOK_RECORD_SCHEMA && typeof v.dedupKey === "string" && typeof v.tool === "string";
}

/** Recursively find `*.json` files under any `records/` directory below baseDir. */
async function findRecordFiles(baseDir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return; // missing dir → no records (not an error)
    }
    for (const name of names) {
      const full = path.join(dir, name);
      let isDir = false;
      try {
        isDir = (await stat(full)).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        await walk(full);
      } else if (name.endsWith(".json") && path.basename(dir) === "records") {
        out.push(full);
      }
    }
  }
  await walk(baseDir);
  return out;
}

/** Load + validate all hook usage records under baseDir (default `.compaction/hooks`). Invalid files skipped. */
export async function loadHookUsageRecords(baseDir = ".compaction/hooks"): Promise<ClaudeCodeHookRecord[]> {
  const files = await findRecordFiles(baseDir);
  const records: ClaudeCodeHookRecord[] = [];
  for (const file of files) {
    try {
      const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
      if (isHookRecord(parsed)) records.push(parsed);
    } catch {
      // skip unreadable/invalid record file (never throw, local-first, best-effort)
    }
  }
  return records;
}

export interface HookUsageToolAggregate {
  tool: string;
  /** Deduped record count for this tool. */
  events: number;
  /** Sum of input tokens across records that HAVE input; null when none do (never 0-for-missing). */
  inputTokens: number | null;
  outputTokens: number | null;
  /** Reasoning tokens are not separately reported by Claude Code session usage → always null here. */
  reasoningTokens: number | null;
  /** Distinct honest token sources, preserved exactly (e.g. ["provider-reported"]). */
  tokenSources: string[];
  providers: string[];
  models: string[];
  /** Records whose output tokens are present. */
  outputRecorded: number;
  /** Records flagged provider-reported. */
  providerReportedEvents: number;
  /** Records with NO input and NO output token data (usage unavailable). */
  unavailableEvents: number;
  /** Distinct session ids seen. */
  sessions: number;
  firstRecordedAt: string | null;
  lastRecordedAt: string | null;
}

export interface HookUsageAggregate {
  schema: typeof HOOK_USAGE_AGGREGATE_SCHEMA;
  /** Records loaded before dedup. */
  totalRecords: number;
  /** Records after dedup by dedupKey. */
  dedupedRecords: number;
  /** Optional ISO lower bound applied to recordedAt. */
  since: string | null;
  tools: HookUsageToolAggregate[];
}

export interface AggregateOptions {
  /** Only include records with recordedAt >= this ISO timestamp (time-window filter). */
  since?: string;
}

const HOOK_USAGE_COUNT_FIELDS = [
  "inputTokens",
  "outputTokens",
  "cacheReadInputTokens",
  "cacheCreationInputTokens",
  "totalTokens"
] as const;

function validHookUsageCounts(record: ClaudeCodeHookRecord): boolean {
  return HOOK_USAGE_COUNT_FIELDS.every((field) => {
    const value = record[field];
    return value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0);
  });
}

/**
 * Resolve one exact prior cumulative baseline for a known completed Claude run. Identity comes from
 * the run store; this helper merely selects that run's latest monotonic content-free hook snapshot.
 * Missing, tied, malformed, source-conflicting, or regressing records yield no baseline.
 */
export function exactPriorClaudeHookRecord(
  records: ClaudeCodeHookRecord[],
  expected: { sessionId: string; logicalRunId: string; before: string }
): ClaudeCodeHookRecord | undefined {
  const sessionRecords = records.filter((record) =>
    record.tool === "claude-code" &&
    record.sessionId === expected.sessionId
  );
  if (sessionRecords.some((record) => !canonicalRecordedAt(record.recordedAt))) return undefined;
  const candidates = sessionRecords.filter((record) => record.recordedAt <= expected.before);
  if (candidates.length === 0 || candidates.some((record) =>
    !validClaudeLogicalRunId(record.logicalRunId) ||
    record.recordedAt >= expected.before ||
    !validHookUsageCounts(record) ||
    (record.tokenSource !== "provider-reported" && record.tokenSource !== "local-estimate")
  )) return undefined;
  candidates.sort((left, right) => left.recordedAt.localeCompare(right.recordedAt));
  for (let index = 1; index < candidates.length; index += 1) {
    const older = candidates[index - 1];
    const newer = candidates[index];
    if (newer.recordedAt <= older.recordedAt || newer.tokenSource !== older.tokenSource) return undefined;
    if (HOOK_USAGE_COUNT_FIELDS.some((field) => {
      const before = older[field];
      const after = newer[field];
      return typeof before === "number" && (typeof after !== "number" || after < before);
    })) return undefined;
  }
  const latest = candidates[candidates.length - 1];
  return latest.logicalRunId === expected.logicalRunId ? latest : undefined;
}

function addToken(acc: number | null, value: number | null): number | null {
  if (value === null) return acc; // missing contributes nothing and never coerces to 0
  return (acc ?? 0) + value;
}

const CUMULATIVE_FIELDS = [
  "inputTokens",
  "outputTokens",
  "cacheReadInputTokens",
  "cacheCreationInputTokens",
  "totalTokens"
] as const;

function canonicalRecordedAt(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function compatibleLogicalRecords(records: ClaudeCodeHookRecord[]): boolean {
  if (records.length < 2) return true;
  const first = records[0];
  if (!canonicalRecordedAt(first.recordedAt)) return false;
  for (let index = 1; index < records.length; index += 1) {
    const older = records[index - 1];
    const newer = records[index];
    if (!canonicalRecordedAt(newer.recordedAt) || newer.recordedAt <= older.recordedAt) return false;
    if (
      newer.tool !== first.tool ||
      newer.tool !== "claude-code" ||
      newer.sessionId !== first.sessionId ||
      newer.logicalRunId !== first.logicalRunId
    ) return false;
    if (newer.messageCount < older.messageCount) return false;
    for (const field of CUMULATIVE_FIELDS) {
      const before = older[field];
      const after = newer[field];
      if (typeof before === "number" && (typeof after !== "number" || after < before)) return false;
    }
  }
  const final = records[records.length - 1];
  if (!exactLogicalRecordPair(final)) return false;
  const snapshots = records.flatMap((record) =>
    record.settledActivityEvent ? [record.settledActivityEvent] : []
  );
  const coalesced = coalesceClaudeLogicalRuns(snapshots);
  return coalesced.length === 1 && coalesced[0] === final.settledActivityEvent;
}

function exactLogicalRecordPair(record: ClaudeCodeHookRecord): string | undefined {
  const event = record.settledActivityEvent;
  return record.tool === "claude-code" &&
    typeof record.sessionId === "string" &&
    record.sessionId.length > 0 &&
    validClaudeLogicalRunId(record.logicalRunId) &&
    event !== undefined &&
    validateActivityEventForStore(event).problems.length === 0 &&
    event.surface === "claude_code" &&
    event.activity_kind === "claude-stop" &&
    event.workflow_id === "claude-stop" &&
    validClaudeLogicalSessionId(event.session_id) &&
    event.run_id === record.logicalRunId
    ? `${record.sessionId}\0${event.session_id}\0${record.logicalRunId}`
    : undefined;
}

function logicalRecordIdentity(record: ClaudeCodeHookRecord): string | undefined {
  return record.tool === "claude-code" &&
    typeof record.sessionId === "string" &&
    record.sessionId.length > 0 &&
    validClaudeLogicalRunId(record.logicalRunId)
    ? `${record.sessionId}\0${record.logicalRunId}`
    : undefined;
}

function coalesceLogicalHookRecords(records: ClaudeCodeHookRecord[]): ClaudeCodeHookRecord[] {
  const logical = new Map<string, ClaudeCodeHookRecord[]>();
  for (const record of records) {
    const pair = logicalRecordIdentity(record);
    if (!pair) continue;
    const group = logical.get(pair) ?? [];
    group.push(record);
    logical.set(pair, group);
  }
  const suppressed = new Set<ClaudeCodeHookRecord>();
  for (const group of logical.values()) {
    if (group.length < 2) continue;
    const ordered = [...group].sort((left, right) => left.recordedAt.localeCompare(right.recordedAt));
    if (!compatibleLogicalRecords(ordered)) continue;
    for (const record of ordered.slice(0, -1)) suppressed.add(record);
  }
  return records.filter((record) => !suppressed.has(record));
}

function taskScopedClaudeHookCounts(records: ClaudeCodeHookRecord[]): ClaudeCodeHookRecord[] {
  const result = records.map((record) => ({ ...record }));
  const sessions = new Map<string, number[]>();
  result.forEach((record, index) => {
    if (
      record.tool !== "claude-code" ||
      typeof record.sessionId !== "string" ||
      !validClaudeLogicalRunId(record.logicalRunId)
    ) return;
    const group = sessions.get(record.sessionId) ?? [];
    group.push(index);
    sessions.set(record.sessionId, group);
  });
  for (const indices of sessions.values()) {
    if (indices.length < 2) continue;
    const ordered = [...indices].sort((left, right) =>
      result[left].recordedAt.localeCompare(result[right].recordedAt)
    );
    const unambiguous = ordered.every((index) =>
      canonicalRecordedAt(result[index].recordedAt) && validHookUsageCounts(result[index])
    ) && ordered.every((index, position) =>
      position === 0 || result[index].recordedAt > result[ordered[position - 1]].recordedAt
    );
    if (!unambiguous) {
      for (const index of ordered) {
        for (const field of HOOK_USAGE_COUNT_FIELDS) result[index][field] = null;
      }
      continue;
    }
    let tainted = false;
    for (let position = 1; position < ordered.length; position += 1) {
      const current = result[ordered[position]];
      const previous = records[ordered[position - 1]];
      if (tainted) {
        for (const field of HOOK_USAGE_COUNT_FIELDS) current[field] = null;
        continue;
      }
      const exactTaskDelta = exactLogicalRecordPair(current) !== undefined &&
        current.settledActivityEvent?.measurement_source === "claude-transcript" &&
        current.settledActivityEvent.claim_scope === "run-scoped";
      const compatible = current.tokenSource === previous.tokenSource &&
        HOOK_USAGE_COUNT_FIELDS.every((field) => {
          const after = current[field];
          const before = previous[field];
          return typeof before !== "number" || (typeof after === "number" && after >= before);
        });
      if (!compatible) {
        for (const field of HOOK_USAGE_COUNT_FIELDS) current[field] = null;
        tainted = true;
        continue;
      }
      if (!exactTaskDelta) {
        // This is another cumulative session snapshot, not a proven task delta. The newer snapshot
        // supersedes all earlier contributions for this session so overlapping totals are never summed.
        for (const earlier of ordered.slice(0, position)) {
          for (const field of HOOK_USAGE_COUNT_FIELDS) result[earlier][field] = null;
        }
        continue;
      }
      for (const field of HOOK_USAGE_COUNT_FIELDS) {
        const after = current[field];
        const before = previous[field];
        current[field] = typeof after === "number" && typeof before === "number"
          ? after - before
          : null;
      }
    }
  }
  return result;
}

/**
 * Aggregate hook records into a content-free source-status view. Dedups by `dedupKey`. Missing token
 * counts stay null. Token source labels preserved exactly. No savings, no content.
 */
export function aggregateHookUsageRecords(records: ClaudeCodeHookRecord[], options: AggregateOptions = {}): HookUsageAggregate {
  const since = options.since ?? null;

  // Dedup + derive exact-session cumulative deltas over the complete bounded record set BEFORE the
  // display window is applied. Otherwise the first record inside `--since` would lose its immediately
  // preceding baseline and its cumulative session total would be mislabeled as new usage. `totalRecords`
  // still counts physical records IN the requested window so "deduped from N" remains accurate.
  let totalRecords = 0;
  const physical = new Map<string, ClaudeCodeHookRecord>();
  for (const r of records) {
    if (since === null || (typeof r.recordedAt === "string" && r.recordedAt >= since)) totalRecords += 1;
    if (!physical.has(r.dedupKey)) physical.set(r.dedupKey, r);
  }
  const normalized = taskScopedClaudeHookCounts(coalesceLogicalHookRecords([...physical.values()]));
  const deduped = since === null
    ? normalized
    : normalized.filter((record) =>
        typeof record.recordedAt === "string" && record.recordedAt >= since
      );

  const byTool = new Map<string, HookUsageToolAggregate>();
  const sessionsByTool = new Map<string, Set<string>>();

  for (const r of deduped) {
    let agg = byTool.get(r.tool);
    if (!agg) {
      agg = {
        tool: r.tool,
        events: 0,
        inputTokens: null,
        outputTokens: null,
        reasoningTokens: null,
        tokenSources: [],
        providers: [],
        models: [],
        outputRecorded: 0,
        providerReportedEvents: 0,
        unavailableEvents: 0,
        sessions: 0,
        firstRecordedAt: null,
        lastRecordedAt: null
      };
      byTool.set(r.tool, agg);
      sessionsByTool.set(r.tool, new Set());
    }

    agg.events += 1;
    agg.inputTokens = addToken(agg.inputTokens, r.inputTokens ?? null);
    agg.outputTokens = addToken(agg.outputTokens, r.outputTokens ?? null);
    if (typeof r.outputTokens === "number") agg.outputRecorded += 1;
    if (r.providerReported === true) agg.providerReportedEvents += 1;
    if ((r.inputTokens ?? null) === null && (r.outputTokens ?? null) === null) agg.unavailableEvents += 1;
    if (r.tokenSource && !agg.tokenSources.includes(r.tokenSource)) agg.tokenSources.push(r.tokenSource);
    if (r.provider && !agg.providers.includes(r.provider)) agg.providers.push(r.provider);
    if (r.model && !agg.models.includes(r.model)) agg.models.push(r.model);
    if (r.sessionId) sessionsByTool.get(r.tool)!.add(r.sessionId);
    if (typeof r.recordedAt === "string") {
      if (agg.firstRecordedAt === null || r.recordedAt < agg.firstRecordedAt) agg.firstRecordedAt = r.recordedAt;
      if (agg.lastRecordedAt === null || r.recordedAt > agg.lastRecordedAt) agg.lastRecordedAt = r.recordedAt;
    }
  }

  for (const [tool, agg] of byTool) {
    agg.sessions = sessionsByTool.get(tool)!.size;
    agg.tokenSources.sort();
    agg.providers.sort();
    agg.models.sort();
  }

  return {
    schema: HOOK_USAGE_AGGREGATE_SCHEMA,
    totalRecords,
    dedupedRecords: deduped.length,
    since,
    tools: Array.from(byTool.values()).sort((a, b) => a.tool.localeCompare(b.tool))
  };
}
