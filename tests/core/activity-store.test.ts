/**
 * Local metrics-only activity store tests, the minimal local metrics-only
 * activity store.
 *
 * Proven here, all in tmpdirs (never the repo checkout):
 * - append → read round-trip: one JSONL line per event; defaults materialized (sync_status
 *   "local-only", deterministic activity_event_id), the store never invents any other field;
 * - DEDUPE by activity_event_id: re-appending the same event is a reported no-op, on write AND
 *   defensively on read;
 * - CONTENT-FREE invariant is fail-closed AT WRITE TIME: content-shaped keys (prompt/response/…),
 *   unknown keys (top-level and nested), and content-sized strings are rejected and NOTHING is
 *   written; the full contract validator (incl. auto-apply off-by-default) also gates the write;
 * - honest empty state: a missing directory is "no activity yet", not an error; invalid lines
 *   are skipped with a reason, never guessed at;
 * - list: content-free summaries only.
 */
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildMeasureOnlyActivityEvent,
  ACTIVITY_EVENT_ID_PATTERN,
  computeActivityEventId,
  type ActivityEvent
} from "../../src/core/activity-event.js";
import {
  ACTIVITY_LOG_FILENAME,
  ACTIVITY_MAX_STRING_LENGTH,
  appendActivityEvent,
  listActivityEvents,
  readActivityEvents,
  validateActivityEventForStore
} from "../../src/core/activity-store.js";
import type { StandardCrossSurfaceEvent } from "../../src/core/cross-surface-event.js";
import { TEST_OUTPUT_POLICY_VERSION } from "../helpers/output-calibration-fixture.js";

const BASE_EVENT: StandardCrossSurfaceEvent = {
  surface: "cursor",
  provider: "cursor",
  model_label: "unknown",
  run_id: "cursor-1751600000001",
  token_source: {
    input: { source: "local-estimate" },
    output: { source: "unavailable", unavailable_reason: "no separable result field in the saved export" }
  },
  input_before: 800,
  cost_source: "unavailable",
  cost_unavailable_reason:
    "Compaction does not ingest Cursor's conditional result.usage, and no per-run cost or billing figure is available; no cost figure exists for this run",
  claim_scope: "run-scoped"
};

function measureOnly(overrides: Partial<StandardCrossSurfaceEvent> = {}): ActivityEvent {
  return buildMeasureOnlyActivityEvent({ ...BASE_EVENT, ...overrides }, {
    original_retained: true,
    location: "out/captured-trace.json"
  });
}

describe("activity store - append/read/list round-trip (tmpdir)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "activity-store-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("appends one JSONL line, reads it back identically, and lists a content-free summary", async () => {
    const event = measureOnly();
    const result = await appendActivityEvent(event, dir);
    expect(result.appended).toBe(true);
    if (!result.appended) return;
    expect(result.activity_event_id).toMatch(ACTIVITY_EVENT_ID_PATTERN);
    expect(result.path).toBe(join(dir, ACTIVITY_LOG_FILENAME));

    const raw = await readFile(result.path, "utf8");
    expect(raw.trim().split("\n")).toHaveLength(1);

    const { events, skipped } = await readActivityEvents(dir);
    expect(skipped).toEqual([]);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(event); // round-trip: byte-honest, nothing invented, nothing dropped

    const { summaries } = await listActivityEvents(dir);
    expect(summaries).toEqual([
      {
        activity_event_id: result.activity_event_id,
        surface: "cursor",
        run_id: "cursor-1751600000001",
        approval_status: "not-required",
        sync_status: "local-only"
      }
    ]);
  });

  it('materializes the defaults: sync_status "local-only" and the deterministic id, when absent', async () => {
    const bare: ActivityEvent = { ...BASE_EVENT, approval_status: "not-required" };
    const result = await appendActivityEvent(bare, dir);
    expect(result.appended).toBe(true);
    const { events } = await readActivityEvents(dir);
    expect(events[0]?.sync_status).toBe("local-only");
    expect(events[0]?.activity_event_id).toMatch(ACTIVITY_EVENT_ID_PATTERN);
  });

  it("DEDUPES on write: re-appending the same event is a reported no-op and the file keeps one line", async () => {
    const event = measureOnly();
    const first = await appendActivityEvent(event, dir);
    expect(first.appended).toBe(true);
    const second = await appendActivityEvent(event, dir);
    expect(second.appended).toBe(false);
    if (second.appended) return;
    expect(second.reason).toContain("duplicate activity_event_id");
    const raw = await readFile(join(dir, ACTIVITY_LOG_FILENAME), "utf8");
    expect(raw.trim().split("\n")).toHaveLength(1);
  });

  it("two DIFFERENT runs append two events (dedupe keys on the metrics, not the surface)", async () => {
    expect((await appendActivityEvent(measureOnly(), dir)).appended).toBe(true);
    expect((await appendActivityEvent(measureOnly({ run_id: "cursor-1751600000002" }), dir)).appended).toBe(true);
    const { events } = await readActivityEvents(dir);
    expect(events).toHaveLength(2);
  });

  it("keeps physical Claude snapshots append-only while the public reader/list keep only the latest cumulative run", async () => {
    const identity: Partial<ActivityEvent> = {
      surface: "claude_code" as const,
      provider: "anthropic" as const,
      workflow_id: "claude-stop",
      session_id: `claude-session-${"1".repeat(32)}`,
      run_id: `claude-stop-${"2".repeat(32)}`,
      token_source: {
        input: { source: "provider-reported" as const },
        output: { source: "provider-reported" as const }
      },
      claim_scope: "run-scoped",
      evidence_level: "exact correlated gateway run",
      approval_status: "not-required",
      recovery: { original_retained: false },
      sync_status: "local-only",
      activity_kind: "claude-stop",
      run_started_at: "2026-07-30T09:59:00.000Z",
      measurement_source: "gateway-run"
    };
    const parentBase = {
      ...identity,
      input_before: 100,
      output_after: 20,
      recorded_at: "2026-07-30T10:00:00.000Z"
    } as ActivityEvent;
    const finalBase = {
      ...identity,
      input_before: 180,
      output_after: 35,
      recorded_at: "2026-07-30T10:01:00.000Z"
    } as ActivityEvent;
    const parent = { ...parentBase, activity_event_id: computeActivityEventId(parentBase) };
    const final = { ...finalBase, activity_event_id: computeActivityEventId(finalBase) };
    expect((await appendActivityEvent(parent, dir)).appended).toBe(true);
    expect((await appendActivityEvent(final, dir)).appended).toBe(true);
    expect((await readFile(join(dir, ACTIVITY_LOG_FILENAME), "utf8")).trim().split("\n")).toHaveLength(2);
    const { events } = await readActivityEvents(dir);
    expect(events).toHaveLength(1);
    expect(events[0]?.input_before).toBe(180);
    expect((await listActivityEvents(dir)).summaries).toHaveLength(1);
    // The hidden parent snapshot still owns its physical idempotency key.
    const replay = await appendActivityEvent(parent, dir);
    expect(replay.appended).toBe(false);
    if (!replay.appended) expect(replay.reason).toContain("duplicate activity_event_id");
    expect((await readFile(join(dir, ACTIVITY_LOG_FILENAME), "utf8")).trim().split("\n")).toHaveLength(2);
  });

  it("lets a validated final Claude Stop supersede its exact earlier hook-only legacy snapshot", async () => {
    const sessionId = `claude-session-${"a".repeat(32)}`;
    const runId = `claude-stop-${"b".repeat(32)}`;
    const legacy = measureOnly({
      surface: "claude_code",
      provider: "anthropic",
      session_id: sessionId,
      run_id: runId,
      input_before: 100,
      output_after: 20,
      token_source: {
        input: { source: "provider-reported" },
        output: { source: "provider-reported" }
      }
    });
    const finalBase: ActivityEvent = {
      surface: "claude_code",
      provider: "anthropic",
      workflow_id: "claude-stop",
      session_id: sessionId,
      run_id: runId,
      input_before: 180,
      output_after: 35,
      token_source: {
        input: { source: "provider-reported" },
        output: { source: "provider-reported" }
      },
      claim_scope: "workflow-scoped",
      evidence_level: "final normalized Claude transcript cumulative session usage",
      approval_status: "not-required",
      recovery: { original_retained: false },
      sync_status: "local-only",
      activity_kind: "claude-stop",
      run_started_at: "2026-07-30T09:59:00.000Z",
      recorded_at: "2026-07-30T10:01:00.000Z",
      measurement_source: "claude-transcript"
    };
    const final = { ...finalBase, activity_event_id: computeActivityEventId(finalBase) };
    expect((await appendActivityEvent(legacy, dir)).appended).toBe(true);
    expect((await appendActivityEvent(final, dir)).appended).toBe(true);
    expect((await readFile(join(dir, ACTIVITY_LOG_FILENAME), "utf8")).trim().split("\n")).toHaveLength(2);
    expect((await readActivityEvents(dir)).events).toEqual([final]);
    expect((await listActivityEvents(dir)).summaries).toHaveLength(1);
  });

  it("keeps a legacy Claude snapshot separate when its count conflicts with the final transcript", async () => {
    const sessionId = `claude-session-${"c".repeat(32)}`;
    const runId = `claude-stop-${"d".repeat(32)}`;
    const legacy = measureOnly({
      surface: "claude_code",
      provider: "anthropic",
      session_id: sessionId,
      run_id: runId,
      input_before: 200,
      output_after: 40,
      token_source: {
        input: { source: "provider-reported" },
        output: { source: "provider-reported" }
      }
    });
    const finalBase: ActivityEvent = {
      surface: "claude_code",
      provider: "anthropic",
      workflow_id: "claude-stop",
      session_id: sessionId,
      run_id: runId,
      input_before: 180,
      output_after: 35,
      token_source: {
        input: { source: "provider-reported" },
        output: { source: "provider-reported" }
      },
      claim_scope: "workflow-scoped",
      evidence_level: "final normalized Claude transcript cumulative session usage",
      approval_status: "not-required",
      recovery: { original_retained: false },
      sync_status: "local-only",
      activity_kind: "claude-stop",
      run_started_at: "2026-07-30T09:59:00.000Z",
      recorded_at: "2026-07-30T10:01:00.000Z",
      measurement_source: "claude-transcript"
    };
    const final = { ...finalBase, activity_event_id: computeActivityEventId(finalBase) };
    await appendActivityEvent(legacy, dir);
    await appendActivityEvent(final, dir);
    expect((await readActivityEvents(dir)).events).toHaveLength(2);
  });

  it("keeps one logical Claude run when later calls legitimately change model, posture, token source, and policy", async () => {
    const identity = {
      surface: "claude_code" as const,
      provider: "anthropic" as const,
      workflow_id: "claude-stop",
      session_id: `claude-session-${"6".repeat(32)}`,
      run_id: `claude-stop-${"7".repeat(32)}`,
      claim_scope: "run-scoped" as const,
      evidence_level: "exact correlated gateway run",
      approval_status: "not-required" as const,
      recovery: { original_retained: false },
      sync_status: "local-only" as const,
      activity_kind: "claude-stop" as const,
      run_started_at: "2026-07-30T09:59:00.000Z",
      measurement_source: "gateway-run" as const,
      output_shaping_state: "active" as const
    };
    const parentBase: ActivityEvent = {
      ...identity,
      model_label: "claude-opus-5",
      input_before: 100,
      output_after: 20,
      token_source: {
        input: { source: "provider-reported" },
        output: { source: "provider-reported" }
      },
      policy_used: TEST_OUTPUT_POLICY_VERSION,
      output_estimate_state: "unseeded",
      apply_posture: "basic",
      recorded_at: "2026-07-30T10:00:00.000Z"
    };
    const finalBase: ActivityEvent = {
      ...identity,
      // Mixed-model final snapshots truthfully omit one model and one policy label.
      input_before: 180,
      input_after: 160,
      output_after: 35,
      token_source: {
        input: { source: "local-estimate" },
        output: { source: "provider-reported" }
      },
      apply_posture: "full",
      recorded_at: "2026-07-30T10:01:00.000Z"
    };
    const parent = { ...parentBase, activity_event_id: computeActivityEventId(parentBase) };
    const final = { ...finalBase, activity_event_id: computeActivityEventId(finalBase) };
    expect((await appendActivityEvent(parent, dir)).appended).toBe(true);
    expect((await appendActivityEvent(final, dir)).appended).toBe(true);
    expect((await readFile(join(dir, ACTIVITY_LOG_FILENAME), "utf8")).trim().split("\n")).toHaveLength(2);
    const { events } = await readActivityEvents(dir);
    expect(events).toEqual([final]);
    expect((await listActivityEvents(dir)).summaries).toHaveLength(1);
  });

  it("fails closed to separate events for foreign/malformed identity, changed run window, or decreasing snapshots", async () => {
    const run = `claude-stop-${"3".repeat(32)}`;
    const shared = {
      surface: "claude_code" as const,
      provider: "anthropic" as const,
      run_id: run,
      token_source: {
        input: { source: "provider-reported" as const },
        output: { source: "provider-reported" as const }
      }
    };
    await appendActivityEvent(measureOnly({
      ...shared, session_id: `claude-session-${"4".repeat(32)}`, input_before: 100, output_before: 20
    }), dir);
    await appendActivityEvent(measureOnly({
      ...shared, session_id: `claude-session-${"5".repeat(32)}`, input_before: 200, output_before: 30
    }), dir);
    await appendActivityEvent(measureOnly({
      ...shared, session_id: `claude-session-${"4".repeat(32)}`, input_before: 90, output_before: 19
    }), dir);
    await appendActivityEvent(measureOnly({
      ...shared, run_id: "claude-stop-malformed", session_id: `claude-session-${"4".repeat(32)}`,
      input_before: 300, output_before: 40
    }), dir);
    const exactIdentity = {
      surface: "claude_code" as const,
      provider: "anthropic" as const,
      workflow_id: "claude-stop",
      session_id: `claude-session-${"8".repeat(32)}`,
      run_id: `claude-stop-${"9".repeat(32)}`,
      input_before: 100,
      output_after: 10,
      token_source: {
        input: { source: "provider-reported" as const },
        output: { source: "provider-reported" as const }
      },
      claim_scope: "run-scoped" as const,
      evidence_level: "exact correlated gateway run",
      approval_status: "not-required" as const,
      recovery: { original_retained: false },
      sync_status: "local-only" as const,
      activity_kind: "claude-stop" as const,
      measurement_source: "gateway-run" as const
    };
    for (const [run_started_at, recorded_at] of [
      ["2026-07-30T09:59:00.000Z", "2026-07-30T10:00:00.000Z"],
      ["2026-07-30T09:58:00.000Z", "2026-07-30T10:01:00.000Z"]
    ] as const) {
      const base: ActivityEvent = { ...exactIdentity, run_started_at, recorded_at };
      await appendActivityEvent({ ...base, activity_event_id: computeActivityEventId(base) }, dir);
    }
    expect((await readActivityEvents(dir)).events).toHaveLength(6);
  });

  it("DEDUPES defensively on read: a hand-duplicated line keeps the first occurrence, skipped with a reason", async () => {
    const event = measureOnly();
    await appendActivityEvent(event, dir);
    const path = join(dir, ACTIVITY_LOG_FILENAME);
    const line = (await readFile(path, "utf8")).trim();
    await writeFile(path, `${line}\n${line}\n`, "utf8");
    const { events, skipped } = await readActivityEvents(dir);
    expect(events).toHaveLength(1);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.reason).toContain("duplicate activity_event_id");
  });

  it("honest empty state: a missing directory reads as no activity (never an error)", async () => {
    const { events, skipped } = await readActivityEvents(join(dir, "does-not-exist"));
    expect(events).toEqual([]);
    expect(skipped).toEqual([]);
  });

  it("skips an invalid-JSON line with a reason and keeps reading the rest", async () => {
    const event = measureOnly();
    await mkdir(dir, { recursive: true });
    const path = join(dir, ACTIVITY_LOG_FILENAME);
    await writeFile(path, `not json at all\n${JSON.stringify(event)}\n`, "utf8");
    const { events, skipped } = await readActivityEvents(dir);
    expect(events).toHaveLength(1);
    expect(skipped).toEqual([{ line: 1, reason: "invalid JSON" }]);
  });
});

describe("activity store - the CONTENT-FREE invariant is fail-closed at write time (tmpdir)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "activity-invariant-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  async function expectRejected(event: ActivityEvent, needle: string): Promise<void> {
    const result = await appendActivityEvent(event, dir);
    expect(result.appended).toBe(false);
    if (result.appended) return;
    expect(result.reason).toContain("metrics-only invariant");
    expect(result.problems?.some((p) => p.includes(needle))).toBe(true);
    // Fail-closed: NOTHING was written.
    const { events } = await readActivityEvents(dir);
    expect(events).toEqual([]);
  }

  it("rejects a content-shaped field (prompt) with the explicit content message; nothing is written", async () => {
    const smuggled = { ...measureOnly(), prompt: "the user's actual prompt text" } as unknown as ActivityEvent;
    await expectRejected(smuggled, "content-shaped field");
  });

  it("rejects ANY unknown top-level field (fail-closed allowlist)", async () => {
    const unknownField = { ...measureOnly(), extra_debug: "x" } as unknown as ActivityEvent;
    await expectRejected(unknownField, "not on the metrics-only activity-event allowlist");
  });

  it("rejects an unknown NESTED field (content can hide one level down)", async () => {
    const base = measureOnly();
    const nested = {
      ...base,
      recovery: { ...base.recovery, response: "smuggled model output" }
    } as unknown as ActivityEvent;
    await expectRejected(nested, "recovery.response");
  });

  it("rejects a content-sized string value in a labeled field", async () => {
    const oversized = measureOnly({ evidence_level: "x".repeat(ACTIVITY_MAX_STRING_LENGTH + 1) });
    await expectRejected(oversized, "content-sized");
  });

  it("rejects an event that fails the contract validator (auto-apply forged ON under ask-each-time)", async () => {
    const forged = {
      ...measureOnly(),
      auto_apply: { eligible: true, preference: "ask-each-time", applied_automatically: true, gates_passed: ["g"] }
    } as unknown as ActivityEvent;
    // Forging invalidates the precomputed id too, but the decisive problem is the off-by-default rule.
    const result = await appendActivityEvent(forged, dir);
    expect(result.appended).toBe(false);
    if (result.appended) return;
    expect(result.problems?.some((p) => p.includes("OFF by default"))).toBe(true);
    expect((await readActivityEvents(dir)).events).toEqual([]);
  });

  it("validateActivityEventForStore requires the store keys (id + sync_status) on raw data", () => {
    const { problems } = validateActivityEventForStore({ ...BASE_EVENT });
    expect(problems.some((p) => p.includes("activity_event_id: required"))).toBe(true);
    expect(problems.some((p) => p.includes("sync_status: required"))).toBe(true);
  });
});
