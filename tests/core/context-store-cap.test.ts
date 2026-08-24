import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeContextItem, type ContextStoreItem } from "../../src/core/context-store.js";
import {
  appendContextItems,
  applyContextStoreCap,
  DEFAULT_CONTEXT_STORE_CAP,
  enforceContextStoreCap,
  loadContextStore,
  writeContextStore
} from "../../src/core/context-store-fs.js";

function item(
  content: string,
  created_at: string,
  opts: { pointer?: string; recoverable?: boolean | "unknown" } = {}
): ContextStoreItem {
  return makeContextItem({
    content,
    created_at,
    source_pointer: opts.pointer,
    recoverability: opts.recoverable ?? true
  });
}

const T0 = "2026-06-20T09:00:00.000Z";
const T1 = "2026-06-21T09:00:00.000Z";
const T2 = "2026-06-22T09:00:00.000Z";
const T3 = "2026-06-23T09:00:00.000Z";

function bytesOf(it: ContextStoreItem): number {
  return Buffer.byteLength(`${JSON.stringify(it)}\n`, "utf8");
}

describe("applyContextStoreCap (pure)", () => {
  it("keeps the newest N items under a maxItems cap and evicts the oldest", () => {
    const items = [item("a", T0), item("b", T1), item("c", T2)];
    const { kept, evicted } = applyContextStoreCap(items, { maxItems: 2 });
    expect(kept.map((i) => i.content)).toEqual(["b", "c"]); // chronological: oldest-kept -> newest
    expect(evicted.map((i) => i.content)).toEqual(["a"]);
  });

  it("keeps the newest items that fit under a maxBytes cap", () => {
    const a = item("alpha", T0);
    const b = item("beta", T1);
    const c = item("gamma", T2);
    // Budget for exactly the two newest items.
    const { kept, evicted } = applyContextStoreCap([a, b, c], { maxBytes: bytesOf(b) + bytesOf(c) });
    expect(kept.map((i) => i.content)).toEqual(["beta", "gamma"]);
    expect(evicted.map((i) => i.content)).toEqual(["alpha"]);
  });

  it("always retains the most recent item even if it alone exceeds maxBytes", () => {
    const big = item("x".repeat(5000), T2);
    const { kept, evicted } = applyContextStoreCap([item("old", T0), big], { maxBytes: 10 });
    expect(kept).toHaveLength(1);
    expect(kept[0].content).toBe(big.content); // newest retained, never dropped to empty
    expect(evicted.map((i) => i.content)).toEqual(["old"]);
  });

  it("keeps the newest CONTIGUOUS block - a small old item is evicted when a huge mid item blocks it", () => {
    const oldSmall = item("old small", T0, { pointer: "trace=A message=m1" });
    const midHuge = item("m".repeat(5000), T1, { pointer: "trace=B message=m1" });
    const newSmall = item("new small", T2, { pointer: "trace=C message=m1" });
    // Budget fits the two small items but NOT the huge mid one.
    const { kept, evicted } = applyContextStoreCap([oldSmall, midHuge, newSmall], {
      maxBytes: bytesOf(oldSmall) + bytesOf(newSmall)
    });
    // Only the newest is kept; the huge mid blocks, so the (individually-fitting) old item is also evicted.
    expect(kept.map((i) => i.content)).toEqual(["new small"]);
    expect(evicted.map((i) => i.content).sort()).toEqual([midHuge.content, "old small"].sort());
    expect(kept[0].source_pointer).toBe("trace=C message=m1"); // retained provenance intact
  });

  it("is a no-op when within both caps", () => {
    const items = [item("a", T0), item("b", T1)];
    const { kept, evicted } = applyContextStoreCap(items, { maxItems: 10, maxBytes: 1_000_000 });
    expect(kept).toHaveLength(2);
    expect(evicted).toHaveLength(0);
  });

  it("evicts deterministically (stable across calls), tie-breaking equal timestamps by hash", () => {
    const sameTime = [item("one", T1), item("two", T1), item("three", T1)];
    const first = applyContextStoreCap(sameTime, { maxItems: 2 });
    const second = applyContextStoreCap(sameTime, { maxItems: 2 });
    expect(first.kept.map((i) => i.content_sha256)).toEqual(second.kept.map((i) => i.content_sha256));
    expect(first.kept).toHaveLength(2);
    expect(first.evicted).toHaveLength(1);
  });

  it("preserves source pointer + recoverability on every RETAINED item (provenance invariant)", () => {
    const old = item("old fact", T0, { pointer: "trace=A message=m1" });
    const kept1 = item("kept fact one", T1, { pointer: "trace=B message=m1", recoverable: true });
    const kept2 = item("kept fact two", T2, { pointer: "trace=C message=m1", recoverable: true });
    const { kept, evicted } = applyContextStoreCap([old, kept1, kept2], { maxItems: 2 });
    expect(evicted.map((i) => i.content)).toEqual(["old fact"]);
    // Retained items are unchanged - pointers/recoverability intact.
    expect(kept.map((i) => i.source_pointer)).toEqual(["trace=B message=m1", "trace=C message=m1"]);
    expect(kept.every((i) => i.recoverability === true)).toBe(true);
  });

  it("the default cap retains a small store unchanged", () => {
    const items = [item("a", T0), item("b", T1)];
    expect(applyContextStoreCap(items, DEFAULT_CONTEXT_STORE_CAP).evicted).toHaveLength(0);
  });
});

describe("context-store persistence under the size cap", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "compaction-context-cap-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("appendContextItems evicts the oldest, rewrites the file, and reports what was evicted", async () => {
    await appendContextItems(dir, [item("a", T0, { pointer: "trace=A message=m1" })], { maxItems: 2 });
    const r = await appendContextItems(
      dir,
      [item("b", T1, { pointer: "trace=B message=m1" }), item("c", T2, { pointer: "trace=C message=m1" })],
      { maxItems: 2 }
    );
    expect(r.evicted.map((i) => i.content)).toEqual(["a"]);
    expect(r.total).toBe(2);

    const loaded = await loadContextStore(dir);
    expect(loaded.map((i) => i.content).sort()).toEqual(["b", "c"]);
    // Provenance survives the rewrite for retained items.
    const byContent = Object.fromEntries(loaded.map((i) => [i.content, i.source_pointer]));
    expect(byContent.b).toBe("trace=B message=m1");
    expect(byContent.c).toBe("trace=C message=m1");
  });

  it("does not evict when within the cap (evicted empty, total grows)", async () => {
    await appendContextItems(dir, [item("a", T0)], { maxItems: 100 });
    const r = await appendContextItems(dir, [item("b", T1)], { maxItems: 100 });
    expect(r.evicted).toHaveLength(0);
    expect(r.total).toBe(2);
  });

  it("enforceContextStoreCap trims an over-cap store deterministically without appending", async () => {
    await writeContextStore(dir, [item("a", T0), item("b", T1), item("c", T2), item("d", T3)]);
    const { kept, evicted } = await enforceContextStoreCap(dir, { maxItems: 2 });
    expect(kept.map((i) => i.content)).toEqual(["c", "d"]); // newest two retained
    expect(evicted.map((i) => i.content).sort()).toEqual(["a", "b"]);
    const loaded = await loadContextStore(dir);
    expect(loaded.map((i) => i.content).sort()).toEqual(["c", "d"]);
  });

  it("a byte cap forces eviction across appends while keeping provenance", async () => {
    const a = item("alpha fact alpha", T0, { pointer: "trace=A message=m1" });
    const b = item("beta fact beta", T1, { pointer: "trace=B message=m1" });
    await appendContextItems(dir, [a], { maxBytes: bytesOf(a) + bytesOf(b) });
    const r = await appendContextItems(dir, [b, item("gamma fact gamma", T2, { pointer: "trace=C message=m1" })], {
      maxBytes: bytesOf(a) + bytesOf(b)
    });
    // The OLDEST is the one evicted (deterministic); the two newest are retained with pointers.
    expect(r.evicted.map((i) => i.content)).toEqual(["alpha fact alpha"]);
    const loaded = await loadContextStore(dir);
    expect(loaded.map((i) => i.content).sort()).toEqual(["beta fact beta", "gamma fact gamma"]);
    expect(loaded.every((i) => typeof i.source_pointer === "string")).toBe(true);
  });
});
