import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assembleContext,
  contextItemsFromCapsule,
  contextItemsFromTrace,
  dedupeContextItems,
  makeContextItem,
  retrieveContextItems,
  CONTEXT_STORE_ITEM_VERSION,
  type ContextStoreItem
} from "../../src/core/context-store.js";
import { appendContextItems, contextStorePath, loadContextStore } from "../../src/core/context-store-fs.js";
import type { AgentTrace, StateCapsule } from "../../src/core/types.js";

const T = "2026-06-24T10:00:00.000Z";

function item(content: string, overrides: Partial<Parameters<typeof makeContextItem>[0]> = {}): ContextStoreItem {
  return makeContextItem({ content, created_at: T, ...overrides });
}

describe("makeContextItem", () => {
  it("derives the dedup hash and a local token estimate, and normalizes whitespace", () => {
    const built = item("  hello   world  ");
    expect(built.version).toBe(CONTEXT_STORE_ITEM_VERSION);
    expect(built.content).toBe("hello world");
    expect(built.content_sha256).toHaveLength(64);
    expect(built.estimated_tokens).toBeGreaterThan(0);
    expect(built.recoverability).toBe("unknown");
  });

  it("is deterministic: same content -> same hash", () => {
    expect(item("same content").content_sha256).toBe(item("same content").content_sha256);
    expect(item("a").content_sha256).not.toBe(item("b").content_sha256);
  });
});

describe("dedupeContextItems", () => {
  it("collapses byte-identical content to one item and merges labels", () => {
    const a = item("dup", { labels: ["x"], created_at: "2026-06-24T11:00:00.000Z" });
    const b = item("dup", { labels: ["y"], created_at: "2026-06-24T09:00:00.000Z" });
    const deduped = dedupeContextItems([a, b]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0].created_at).toBe("2026-06-24T09:00:00.000Z"); // earliest kept
    expect(deduped[0].labels).toEqual(["x", "y"]); // labels merged + sorted
  });
});

describe("contextItemsFromCapsule", () => {
  const capsule: StateCapsule = {
    traceId: "trace-1",
    source_trace_id: "trace-1",
    source_pointer: "trace=trace-1 message=m1",
    source_recoverable: true,
    retainedFacts: ["ship the rung-1 store", "keep the 8 commands"],
    openQuestions: ["what eviction policy"],
    safetyNotes: ["no network in the free path"],
    provenance_entries: [
      { source_pointer: "trace=trace-1 message=m1", source_recoverable: true, source_trace_id: "trace-1" }
    ]
  };

  it("derives one item per retained fact / open question / safety note, carrying provenance", () => {
    const items = contextItemsFromCapsule(capsule, { created_at: T, trace_fingerprint: "fp-1" });
    expect(items).toHaveLength(4);
    for (const it of items) {
      expect(it.source_pointer).toBe("trace=trace-1 message=m1");
      expect(it.recoverability).toBe(true);
      expect(it.source_trace_id).toBe("trace-1");
      expect(it.trace_fingerprint).toBe("fp-1");
    }
    expect(items.some((it) => it.labels.includes("retained_fact"))).toBe(true);
    expect(items.some((it) => it.labels.includes("open_question"))).toBe(true);
    expect(items.some((it) => it.labels.includes("safety_note"))).toBe(true);
  });

  it("skips empty entries", () => {
    const empty: StateCapsule = { ...capsule, retainedFacts: ["  ", "real fact"], openQuestions: [], safetyNotes: [] };
    const items = contextItemsFromCapsule(empty, { created_at: T });
    expect(items).toHaveLength(1);
    expect(items[0].content).toBe("real fact");
  });
});

describe("contextItemsFromTrace", () => {
  const trace: AgentTrace = {
    id: "trace-z",
    title: "session",
    artifactVersion: "agent-trace-v1",
    source: "fixture",
    createdAt: T,
    generatedAt: T,
    model: "test-model",
    messages: [
      { id: "m1", role: "user", content: "refresh the auth token before upload" },
      { id: "m2", role: "tool", toolName: "test", content: "all tests passed" },
      { id: "m3", role: "assistant", content: "   " } // empty -> skipped
    ]
  };

  it("derives one source-pointed, recoverable item per non-empty message", () => {
    const items = contextItemsFromTrace(trace, { created_at: T });
    expect(items).toHaveLength(2); // m3 (whitespace) skipped
    const m1 = items.find((i) => i.content.includes("auth token"))!;
    expect(m1.source_pointer).toBe("trace=trace-z message=m1");
    expect(m1.source_trace_id).toBe("trace-z");
    expect(m1.recoverability).toBe(true);
    expect(m1.trace_fingerprint).toMatch(/^[0-9a-f]{64}$/); // per-run distinctness digest
    expect(m1.labels).toContain("user");
    const tool = items.find((i) => i.content === "all tests passed")!;
    expect(tool.labels).toEqual(expect.arrayContaining(["tool", "test"]));
  });

  it("dedups byte-identical message content", () => {
    const dupTrace: AgentTrace = {
      ...trace,
      messages: [
        { id: "a", role: "user", content: "same line" },
        { id: "b", role: "assistant", content: "same line" }
      ]
    };
    expect(contextItemsFromTrace(dupTrace, { created_at: T })).toHaveLength(1);
  });
});

describe("retrieveContextItems", () => {
  const items = [
    item("the database connection pool was exhausted under load", {
      source_pointer: "trace=A message=m1",
      source_trace_id: "A"
    }),
    item("the user prefers a restrained blue palette", { source_trace_id: "B" }),
    item("connection retries should use exponential backoff", { source_trace_id: "C" })
  ];

  it("ranks by lexical overlap deterministically", () => {
    const ranked = retrieveContextItems(items, { text: "why was the database connection failing" });
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked[0].item.content).toContain("database connection pool");
    // Same query twice -> identical order (determinism).
    const again = retrieveContextItems(items, { text: "why was the database connection failing" });
    expect(again.map((r) => r.item.content_sha256)).toEqual(ranked.map((r) => r.item.content_sha256));
  });

  it("boosts an exact source/trace match above pure lexical overlap", () => {
    const ranked = retrieveContextItems(items, { text: "unrelated query terms", trace_ids: ["B"] });
    expect(ranked[0].item.source_trace_id).toBe("B");
    expect(ranked[0].source_match).toBe(true);
  });

  it("returns only items with a positive signal and honors the limit", () => {
    const ranked = retrieveContextItems(items, { text: "database connection" }, { limit: 1 });
    expect(ranked).toHaveLength(1);
    const none = retrieveContextItems(items, { text: "zzz nonexistent tokens qqq" });
    expect(none).toHaveLength(0);
  });
});

describe("assembleContext", () => {
  it("includes items greedily under the token budget and preserves provenance", () => {
    const a = item("alpha fact that costs some tokens here", { source_pointer: "trace=A message=m1" });
    const b = item("beta fact that also costs tokens", { source_pointer: "trace=B message=m2" });
    const assembled = assembleContext([a, b], { tokenBudget: a.estimated_tokens });
    expect(assembled.included).toHaveLength(1);
    expect(assembled.included[0].source_pointer).toBe("trace=A message=m1"); // provenance preserved
    expect(assembled.dropped).toHaveLength(1);
    expect(assembled.within_budget).toBe(false);
    expect(assembled.estimated_tokens).toBeLessThanOrEqual(a.estimated_tokens);
  });

  it("dedups by content hash during assembly", () => {
    const a = item("same", { source_pointer: "p1" });
    const dup = item("same", { source_pointer: "p2" });
    const assembled = assembleContext([a, dup], { tokenBudget: 1000 });
    expect(assembled.included).toHaveLength(1);
  });

  it("reports within_budget when everything fits", () => {
    const assembled = assembleContext([item("a"), item("b")], { tokenBudget: 1000 });
    expect(assembled.within_budget).toBe(true);
    expect(assembled.dropped).toHaveLength(0);
    expect(assembled.text).toBe("a\nb");
  });

  it("drops everything under a zero token budget", () => {
    const assembled = assembleContext([item("alpha"), item("beta")], { tokenBudget: 0 });
    expect(assembled.included).toHaveLength(0);
    expect(assembled.dropped).toHaveLength(2);
    expect(assembled.within_budget).toBe(false);
    expect(assembled.estimated_tokens).toBe(0);
    expect(assembled.text).toBe("");
  });
});

describe("context-store persistence (local file only)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "compaction-context-store-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("returns [] for a store that does not exist yet", async () => {
    expect(await loadContextStore(dir)).toEqual([]);
  });

  it("appends items, skips duplicates idempotently, and round-trips", async () => {
    const first = await appendContextItems(dir, [item("one"), item("two")]);
    expect(first.appended).toHaveLength(2);
    expect(first.total).toBe(2);

    const second = await appendContextItems(dir, [item("two"), item("three")]);
    expect(second.appended.map((i) => i.content)).toEqual(["three"]);
    expect(second.skipped.map((i) => i.content)).toEqual(["two"]);
    expect(second.total).toBe(3);

    const loaded = await loadContextStore(dir);
    expect(loaded.map((i) => i.content).sort()).toEqual(["one", "three", "two"]);
  });

  it("round-trips an item with no source pointer, preserving recoverability=unknown", async () => {
    await appendContextItems(dir, [item("no source here")]);
    const loaded = await loadContextStore(dir);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].source_pointer).toBeUndefined();
    expect(loaded[0].recoverability).toBe("unknown");
  });

  it("writes JSONL under the store directory", async () => {
    await appendContextItems(dir, [item("persisted")]);
    const raw = await readFile(contextStorePath(dir), "utf8");
    expect(raw.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(raw.trim()).content).toBe("persisted");
  });

  it("skips malformed lines without throwing", async () => {
    await appendContextItems(dir, [item("good")]);
    const { appendFile } = await import("node:fs/promises");
    await appendFile(contextStorePath(dir), "not json\n", "utf8");
    const loaded = await loadContextStore(dir);
    expect(loaded.map((i) => i.content)).toEqual(["good"]);
  });
});
