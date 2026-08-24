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

function addToken(acc: number | null, value: number | null): number | null {
  if (value === null) return acc; // missing contributes nothing and never coerces to 0
  return (acc ?? 0) + value;
}

/**
 * Aggregate hook records into a content-free source-status view. Dedups by `dedupKey`. Missing token
 * counts stay null. Token source labels preserved exactly. No savings, no content.
 */
export function aggregateHookUsageRecords(records: ClaudeCodeHookRecord[], options: AggregateOptions = {}): HookUsageAggregate {
  const since = options.since ?? null;

  // Apply the time-window filter first, then dedup by dedupKey (records are already deduped at write time;
  // this is defensive). `totalRecords` counts records IN the window so "deduped from N" reads accurately
  // under --since. When `since` is set, a record with a missing/non-string recordedAt is EXCLUDED (a record
  // with no timestamp cannot be proven to fall inside the window).
  let totalRecords = 0;
  const deduped = new Map<string, ClaudeCodeHookRecord>();
  for (const r of records) {
    if (since !== null && (typeof r.recordedAt !== "string" || r.recordedAt < since)) continue;
    totalRecords += 1;
    if (!deduped.has(r.dedupKey)) deduped.set(r.dedupKey, r);
  }

  const byTool = new Map<string, HookUsageToolAggregate>();
  const sessionsByTool = new Map<string, Set<string>>();

  for (const r of deduped.values()) {
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
    dedupedRecords: deduped.size,
    since,
    tools: Array.from(byTool.values()).sort((a, b) => a.tool.localeCompare(b.tool))
  };
}
