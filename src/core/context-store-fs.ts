import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { dedupeContextItems, type ContextStoreItem } from "./context-store.js";

/**
 * Local-file persistence for the V0.4 context store, with a simple local SIZE CAP.
 *
 * LOCAL-ONLY: the store is an append-only JSONL file under a `.compaction/`-rooted directory
 * (gitignored). There is NO network, credential, upload, or DB here, plain local file I/O, by
 * design. Store content is LOCAL-ONLY and must be EXCLUDED-BY-DEFAULT from any future share /
 * `feedback` bundle (reuse the existing redaction discipline), never uploaded.
 *
 * SIZE CAP (accepted decision): a simple,
 * deterministic local cap bounds unbounded growth. See `applyContextStoreCap`:
 * - Capped on BOTH item count AND total serialized bytes.
 * - Eviction is DETERMINISTIC and oldest-first (by `created_at`, ties by `content_sha256`).
 * - Eviction removes WHOLE items only; it NEVER mutates a retained item, so every retained
 *   item keeps its `source_pointer` + recoverability intact (the provenance invariant holds).
 * - The most recent item is always retained (a single oversized newest item is never silently
 *   dropped to an empty store).
 * Normal writes stay append-only; the file is rewritten (atomically) only when the cap evicts.
 */

/** Default store filename inside the store directory. */
export const CONTEXT_STORE_FILE = "items.jsonl";

/** Resolve the JSONL path for a given store directory. */
export function contextStorePath(storeDir: string): string {
  return join(storeDir, CONTEXT_STORE_FILE);
}

/** A simple local size cap. Either bound may be omitted (treated as unbounded). */
export interface ContextStoreCap {
  /** Maximum number of items retained. */
  maxItems?: number;
  /** Maximum total serialized (JSONL) bytes retained. */
  maxBytes?: number;
}

/** Conservative local defaults, enough headroom for real use, bounded against runaway growth. */
export const DEFAULT_CONTEXT_STORE_CAP: Required<ContextStoreCap> = {
  maxItems: 10_000,
  maxBytes: 5 * 1024 * 1024 // 5 MiB
};

/** Serialized on-disk footprint of one item (its JSONL line, including the newline). */
function serializedBytes(item: ContextStoreItem): number {
  return Buffer.byteLength(`${JSON.stringify(item)}\n`, "utf8");
}

/** Deterministic oldest-first order: `created_at` ascending, ties broken by `content_sha256`. */
function oldestFirst(items: ContextStoreItem[]): ContextStoreItem[] {
  return [...items].sort((a, b) => {
    if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
    return a.content_sha256 < b.content_sha256 ? -1 : 1;
  });
}

export interface CapResult {
  /** Items retained, in deterministic chronological (oldest-kept → newest) order. */
  kept: ContextStoreItem[];
  /** Items evicted (the oldest), deterministic. */
  evicted: ContextStoreItem[];
}

/**
 * Apply the size cap. PURE - no I/O. Keeps the NEWEST items that fit within BOTH caps and
 * evicts the OLDEST; the most recent item is always retained. Deterministic and testable.
 * Input is assumed deduped by `content_sha256` (as produced by `loadContextStore`).
 */
export function applyContextStoreCap(
  items: ContextStoreItem[],
  cap: ContextStoreCap = DEFAULT_CONTEXT_STORE_CAP
): CapResult {
  const maxItems = cap.maxItems ?? Number.POSITIVE_INFINITY;
  const maxBytes = cap.maxBytes ?? Number.POSITIVE_INFINITY;
  const ordered = oldestFirst(items);

  const keptReversed: ContextStoreItem[] = [];
  let count = 0;
  let bytes = 0;
  // Walk newest → oldest, keeping while within both caps. The newest item is always kept.
  for (let i = ordered.length - 1; i >= 0; i -= 1) {
    const item = ordered[i];
    const itemBytes = serializedBytes(item);
    const isNewestKept = keptReversed.length === 0;
    if (!isNewestKept && (count + 1 > maxItems || bytes + itemBytes > maxBytes)) {
      break; // every still-older item is evicted (keep the newest contiguous block)
    }
    keptReversed.push(item);
    count += 1;
    bytes += itemBytes;
  }

  const kept = keptReversed.reverse();
  const keptHashes = new Set(kept.map((item) => item.content_sha256));
  const evicted = ordered.filter((item) => !keptHashes.has(item.content_sha256));
  return { kept, evicted };
}

/**
 * Read every persisted item from the store directory, deduped by content hash.
 * Returns `[]` if the store does not exist yet (starts empty - no migration).
 * Malformed lines are skipped (a partially-written tail never throws).
 */
export async function loadContextStore(storeDir: string): Promise<ContextStoreItem[]> {
  const path = contextStorePath(storeDir);
  if (!existsSync(path)) {
    return [];
  }
  const raw = await readFile(path, "utf8");
  const items: ContextStoreItem[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = JSON.parse(trimmed) as ContextStoreItem;
      if (parsed && typeof parsed.content_sha256 === "string" && typeof parsed.content === "string") {
        items.push(parsed);
      }
    } catch {
      // Skip a malformed/partial line rather than failing the whole read.
    }
  }
  return dedupeContextItems(items);
}

/** Atomically (write-temp-then-rename) replace the store file with `items`. */
export async function writeContextStore(storeDir: string, items: ContextStoreItem[]): Promise<void> {
  const path = contextStorePath(storeDir);
  await mkdir(dirname(path), { recursive: true });
  const payload = items.length > 0 ? `${items.map((item) => JSON.stringify(item)).join("\n")}\n` : "";
  const tmp = `${path}.tmp`;
  await writeFile(tmp, payload, "utf8");
  await rename(tmp, path);
}

export interface AppendResult {
  /** Items newly written this call (i.e. not already present by content hash). */
  appended: ContextStoreItem[];
  /** Items skipped because their content hash already existed in the store. */
  skipped: ContextStoreItem[];
  /** Items evicted by the size cap during this call (the oldest), deterministic. */
  evicted: ContextStoreItem[];
  /** Total distinct items retained in the store after this append (post-cap). */
  total: number;
}

/**
 * Append items to the store, skipping any whose `content_sha256` already exists (idempotent),
 * then enforce the size cap. New writes are append-only; the file is rewritten (atomically)
 * only when the cap evicts something. Returns what was appended / skipped / evicted.
 */
export async function appendContextItems(
  storeDir: string,
  items: ContextStoreItem[],
  cap: ContextStoreCap = DEFAULT_CONTEXT_STORE_CAP
): Promise<AppendResult> {
  const existing = await loadContextStore(storeDir);
  const seen = new Set(existing.map((item) => item.content_sha256));

  const appended: ContextStoreItem[] = [];
  const skipped: ContextStoreItem[] = [];
  const fresh = dedupeContextItems(items);
  for (const item of fresh) {
    if (seen.has(item.content_sha256)) {
      skipped.push(item);
    } else {
      seen.add(item.content_sha256);
      appended.push(item);
    }
  }

  if (appended.length > 0) {
    const path = contextStorePath(storeDir);
    await mkdir(dirname(path), { recursive: true });
    const payload = `${appended.map((item) => JSON.stringify(item)).join("\n")}\n`;
    await appendFile(path, payload, "utf8");
  }

  // Enforce the size cap (rewrites the file only when something is evicted).
  const { kept, evicted } = applyContextStoreCap([...existing, ...appended], cap);
  if (evicted.length > 0) {
    await writeContextStore(storeDir, kept);
  }

  return { appended, skipped, evicted, total: kept.length };
}

/**
 * Enforce the size cap on an existing store WITHOUT appending (e.g. after lowering the cap).
 * Rewrites the file only when something is evicted. Returns the kept/evicted split.
 */
export async function enforceContextStoreCap(
  storeDir: string,
  cap: ContextStoreCap = DEFAULT_CONTEXT_STORE_CAP
): Promise<CapResult> {
  const existing = await loadContextStore(storeDir);
  const result = applyContextStoreCap(existing, cap);
  if (result.evicted.length > 0) {
    await writeContextStore(storeDir, result.kept);
  }
  return result;
}
