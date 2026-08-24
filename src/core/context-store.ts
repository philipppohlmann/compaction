import { contentHash } from "./content-hash.js";
import { estimateTextTokens } from "./token-estimator.js";
import { computeTraceFingerprint } from "./trace-fingerprint.js";
import type { AgentTrace, StateCapsule, StateCapsuleProvenanceEntry } from "./types.js";

/**
 * V0.4 context store (local, deterministic, source-grounded).
 *
 * SCOPE: a durable, local, file-based store of source-pointed context items
 * accumulated across runs, plus DETERMINISTIC local retrieval and assembly under a
 * token budget.
 *
 * HARD NON-GOALS (load-bearing, do not add here):
 * - NO semantic / embedding retrieval. Retrieval ranks by deterministic signals only
 *   (source-pointer match, lexical overlap, recency). Semantic retrieval needs a model
 *   → outside this model-free CLI core → belongs to the separately distributed engine.
 * - NO network call, credential, upload, or model invocation. This module is pure +
 *   local-file I/O only (see `loadContextStore` / `appendContextItems`).
 * - NO hosted DB / vector store / auth.
 * - NO large-memory / 300M-token / retrieval-correctness claim. Those need eval evidence this
 *   module does not produce.
 *
 * HONESTY: token figures here are `local_estimate` (chars/4), never provider-reported.
 * Every stored item retains its `source_pointer` + recoverability so the assembled
 * context stays recoverable to its sources (the substrate invariant).
 */

/** Algorithm + schema version, so a persisted store is self-describing. */
export const CONTEXT_STORE_ITEM_VERSION = "context-store-item-v1";

/**
 * A single source-pointed context item accumulated in the store.
 *
 * `content` is local-only (like a captured trace) and is NEVER uploaded; the store
 * lives under the gitignored `.compaction/` tree. `content_sha256` is the dedup key.
 */
export interface ContextStoreItem {
  /** Schema version for forward-compatible reads. */
  version: string;
  /** SHA-256 of `content`, the dedup key (reuses the fingerprint discipline). */
  content_sha256: string;
  /** The retained context text (local-only; never uploaded). */
  content: string;
  /** Local token estimate (chars/4) for assembly budgeting. NOT provider-reported. */
  estimated_tokens: number;
  /** Recoverable pointer back to the source (kept so assembly stays recoverable). */
  source_pointer?: string;
  /** Source recoverability, carried straight from the substrate. */
  recoverability: boolean | "unknown";
  /** Per-run distinctness digest (from `computeTraceFingerprint`), if known. */
  trace_fingerprint?: string;
  /** The originating trace id, when known (a deterministic retrieval signal). */
  source_trace_id?: string;
  /** Provenance entry carried from the state-capsule, when available. */
  provenance?: StateCapsuleProvenanceEntry;
  /** Free-form deterministic labels (e.g. "retained_fact", "open_question"). */
  labels: string[];
  /** ISO-8601 creation timestamp (recency signal). Stamped at append time. */
  created_at: string;
}

/** Input to `makeContextItem`, everything except the derived hash/token fields. */
export interface ContextItemInput {
  content: string;
  source_pointer?: string;
  recoverability?: boolean | "unknown";
  trace_fingerprint?: string;
  source_trace_id?: string;
  provenance?: StateCapsuleProvenanceEntry;
  labels?: string[];
  created_at: string;
}

function normalizeContent(content: string): string {
  return content.trim().replace(/\s+/g, " ");
}

/**
 * Build a single context item, deriving the dedup hash + local token estimate.
 * Pure, no I/O, no clock (the caller supplies `created_at` so this stays
 * deterministic and testable).
 */
export function makeContextItem(input: ContextItemInput): ContextStoreItem {
  const content = normalizeContent(input.content);
  return {
    version: CONTEXT_STORE_ITEM_VERSION,
    content_sha256: contentHash(content),
    content,
    estimated_tokens: estimateTextTokens(content),
    source_pointer: input.source_pointer,
    recoverability: input.recoverability ?? "unknown",
    trace_fingerprint: input.trace_fingerprint,
    source_trace_id: input.source_trace_id,
    provenance: input.provenance,
    labels: input.labels ? [...input.labels] : [],
    created_at: input.created_at
  };
}

/**
 * Derive context items from a `StateCapsule`. Each retained fact / open question /
 * safety note becomes a source-pointed item, inheriting the capsule's source pointer +
 * recoverability + the originating trace id (and the supplied per-run fingerprint).
 * Pure, `created_at` is supplied by the caller.
 */
export function contextItemsFromCapsule(
  capsule: StateCapsule,
  opts: { created_at: string; trace_fingerprint?: string }
): ContextStoreItem[] {
  const primaryProvenance = capsule.provenance_entries?.[0];
  const base = {
    source_pointer: capsule.source_pointer ?? primaryProvenance?.source_pointer,
    recoverability: capsule.source_recoverable ?? primaryProvenance?.source_recoverable ?? "unknown",
    source_trace_id: capsule.source_trace_id ?? capsule.traceId,
    provenance: primaryProvenance,
    trace_fingerprint: opts.trace_fingerprint,
    created_at: opts.created_at
  } as const;

  const items: ContextStoreItem[] = [];
  for (const fact of capsule.retainedFacts) {
    if (fact.trim().length === 0) continue;
    items.push(makeContextItem({ ...base, content: fact, labels: ["retained_fact"] }));
  }
  for (const question of capsule.openQuestions) {
    if (question.trim().length === 0) continue;
    items.push(makeContextItem({ ...base, content: question, labels: ["open_question"] }));
  }
  for (const note of capsule.safetyNotes) {
    if (note.trim().length === 0) continue;
    items.push(makeContextItem({ ...base, content: note, labels: ["safety_note"] }));
  }
  return dedupeContextItems(items);
}

/**
 * Derive context items from a normalized `AgentTrace` (the local artifact `compaction capture`
 * / `import` produces). Each non-empty message becomes a source-pointed item recoverable to its
 * `trace=<id> message=<id>` origin, tagged with the run's distinctness fingerprint. This is the
 * free-CLI populate path (state-capsules require the gated engine; trace messages do not). Pure -
 * `created_at` is supplied by the caller.
 */
export function contextItemsFromTrace(trace: AgentTrace, opts: { created_at: string }): ContextStoreItem[] {
  const trace_fingerprint = computeTraceFingerprint(trace).content_sha256;
  const items: ContextStoreItem[] = [];
  for (const message of trace.messages) {
    if (message.content.trim().length === 0) continue;
    const labels: string[] = [message.role];
    if (message.toolName) labels.push(message.toolName);
    items.push(
      makeContextItem({
        content: message.content,
        source_pointer: `trace=${trace.id} message=${message.id}`,
        source_trace_id: trace.id,
        recoverability: true,
        trace_fingerprint,
        labels,
        created_at: opts.created_at
      })
    );
  }
  return dedupeContextItems(items);
}

/**
 * Dedup by `content_sha256`, keeping the EARLIEST item deterministically (ties broken
 * by `created_at`, then by the existing order). Reuses the fingerprint discipline:
 * byte-identical content is one item, not many. Output order follows the
 * first-occurrence order of each distinct hash in the input array.
 */
export function dedupeContextItems(items: ContextStoreItem[]): ContextStoreItem[] {
  const byHash = new Map<string, ContextStoreItem>();
  for (const item of items) {
    const existing = byHash.get(item.content_sha256);
    if (!existing || item.created_at < existing.created_at) {
      // Merge labels so a later duplicate's labels are not lost.
      if (existing) {
        const labels = Array.from(new Set([...item.labels, ...existing.labels])).sort();
        byHash.set(item.content_sha256, { ...item, labels });
      } else {
        byHash.set(item.content_sha256, item);
      }
    } else {
      const labels = Array.from(new Set([...existing.labels, ...item.labels])).sort();
      byHash.set(item.content_sha256, { ...existing, labels });
    }
  }
  return Array.from(byHash.values());
}

const WORD_RE = /[a-z0-9]+/g;

function tokenSet(text: string): Set<string> {
  const set = new Set<string>();
  const matches = text.toLowerCase().match(WORD_RE);
  if (matches) {
    for (const word of matches) set.add(word);
  }
  return set;
}

/** A retrieval query: the current step's context + optional source/trace hints. */
export interface RetrievalQuery {
  /** Free text describing the current step (task, recent messages, etc.). */
  text: string;
  /** Source pointers known to be relevant to the current step (exact-match boost). */
  source_pointers?: string[];
  /** Trace ids known to be relevant to the current step (exact-match boost). */
  trace_ids?: string[];
}

export interface RetrievalOptions {
  /** Max items to return (after ranking). Default: all candidates with score > 0. */
  limit?: number;
  /** Weight on exact source-pointer / trace-id match. Default 1. */
  sourceMatchWeight?: number;
  /** Weight on lexical overlap (overlap coefficient in [0,1]). Default 1. */
  lexicalWeight?: number;
}

export interface RankedContextItem {
  item: ContextStoreItem;
  score: number;
  source_match: boolean;
  lexical_overlap: number;
}

/**
 * Deterministic, local retrieval. Ranks items by:
 *   score = sourceMatchWeight * (exact source/trace match ? 1 : 0)
 *         + lexicalWeight     * lexical overlap coefficient in [0,1]
 *
 * Ties are broken deterministically by recency (newer first) then `content_sha256`
 * ascending, so the same store + query always yields the same order. No model, no
 * embeddings, no network - overlap is a pure word-set intersection.
 */
export function retrieveContextItems(
  items: ContextStoreItem[],
  query: RetrievalQuery,
  options: RetrievalOptions = {}
): RankedContextItem[] {
  const sourceWeight = options.sourceMatchWeight ?? 1;
  const lexicalWeight = options.lexicalWeight ?? 1;
  const queryWords = tokenSet(query.text);
  const wantedPointers = new Set(query.source_pointers ?? []);
  const wantedTraces = new Set(query.trace_ids ?? []);

  const ranked: RankedContextItem[] = items.map((item) => {
    const sourceMatch =
      (item.source_pointer !== undefined && wantedPointers.has(item.source_pointer)) ||
      (item.source_trace_id !== undefined && wantedTraces.has(item.source_trace_id));

    let overlap = 0;
    if (queryWords.size > 0) {
      const itemWords = tokenSet(item.content);
      if (itemWords.size > 0) {
        let intersection = 0;
        const [small, large] = queryWords.size <= itemWords.size ? [queryWords, itemWords] : [itemWords, queryWords];
        for (const word of small) {
          if (large.has(word)) intersection += 1;
        }
        // Overlap coefficient: intersection / min(|q|, |item|) - in [0, 1].
        overlap = intersection / Math.min(queryWords.size, itemWords.size);
      }
    }

    const score = sourceWeight * (sourceMatch ? 1 : 0) + lexicalWeight * overlap;
    return { item, score, source_match: sourceMatch, lexical_overlap: overlap };
  });

  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.item.created_at !== b.item.created_at) return a.item.created_at < b.item.created_at ? 1 : -1;
    return a.item.content_sha256 < b.item.content_sha256 ? -1 : 1;
  });

  const withSignal = ranked.filter((entry) => entry.score > 0);
  return options.limit !== undefined ? withSignal.slice(0, options.limit) : withSignal;
}

export interface AssembleOptions {
  /** Token budget for the assembled context (local estimate). */
  tokenBudget: number;
}

export interface AssembledContext {
  /** The assembled context text (included items joined, in ranked order). */
  text: string;
  /** Items that fit within the budget (provenance preserved on each). */
  included: ContextStoreItem[];
  /** Items dropped because the budget was exhausted (still recoverable from source). */
  dropped: ContextStoreItem[];
  /** Local token estimate of the assembled context. */
  estimated_tokens: number;
  /** Whether everything offered fit within the budget. */
  within_budget: boolean;
}

/**
 * Assemble ranked items into the sufficient active context under a token budget.
 * Greedy in ranked order; dedups by `content_sha256`; PRESERVES the source pointer +
 * provenance on every included item (so the assembled context stays recoverable).
 * Token figures are local estimates.
 */
export function assembleContext(
  ranked: Array<RankedContextItem | ContextStoreItem>,
  options: AssembleOptions
): AssembledContext {
  const items = ranked.map((entry) => ("item" in entry ? entry.item : entry));
  const included: ContextStoreItem[] = [];
  const dropped: ContextStoreItem[] = [];
  const seen = new Set<string>();
  let total = 0;

  for (const item of items) {
    if (seen.has(item.content_sha256)) continue;
    seen.add(item.content_sha256);
    if (total + item.estimated_tokens <= options.tokenBudget) {
      included.push(item);
      total += item.estimated_tokens;
    } else {
      dropped.push(item);
    }
  }

  return {
    text: included.map((item) => item.content).join("\n"),
    included,
    dropped,
    estimated_tokens: total,
    within_budget: dropped.length === 0
  };
}
