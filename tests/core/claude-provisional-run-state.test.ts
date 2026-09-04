import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  claudeProvisionalPending,
  commitClaudePositiveSettlement,
  completeClaudePositiveSettlement,
  endClaudeUserRun,
  projectClaudePositiveSettlement,
  startClaudeUserRun,
  type ClaudeOpenProvisionalPending
} from "../../src/core/gateway/run-boundary.js";
import { claudeLogicalRunIdentity } from "../../src/core/claude-logical-run-id.js";
import { computeActivityEventId, type ActivityEvent } from "../../src/core/activity-event.js";
import {
  claudePromptCorrelationId,
  resetSessionCorrelationCache,
  sessionCorrelationId
} from "../../src/core/gateway/session-correlation.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function state(session = "session-a") {
  const dir = await mkdtemp(join(tmpdir(), "claude-provisional-store-"));
  dirs.push(dir);
  const env = { COMPACTION_CONFIG_DIR: dir } as NodeJS.ProcessEnv;
  return {
    dir,
    env,
    session,
    correlation: sessionCorrelationId(session, env)!,
    prompt: (id: string) => claudePromptCorrelationId(session, id, env)!
  };
}

function resolution(expected: ClaudeOpenProvisionalPending, taskNotification: boolean) {
  return { expected, taskNotification };
}

function frozenEvent(run: NonNullable<ReturnType<typeof projectClaudePositiveSettlement>>): ActivityEvent {
  const identity = claudeLogicalRunIdentity(run)!;
  const base: ActivityEvent = {
    surface: "claude_code",
    provider: "anthropic",
    workflow_id: "claude-stop",
    session_id: identity.sessionId,
    run_id: identity.runId,
    input_before: 1_900,
    input_after: 1_500,
    output_after: 180,
    token_source: {
      input: { source: "provider-reported" },
      output: { source: "provider-reported" }
    },
    claim_scope: "run-scoped",
    evidence_level: "exact correlated gateway run",
    approval_status: "not-required",
    recovery: { original_retained: false },
    sync_status: "local-only",
    activity_kind: "claude-stop",
    recorded_at: run.ended_at!,
    run_started_at: run.started_at,
    measurement_source: "gateway-run"
  };
  return { ...base, activity_event_id: computeActivityEventId(base) };
}

describe("Claude provisional run store", () => {
  it("atomically transitions one exact open identity to one frozen settled phase until explicit completion", async () => {
    const s = await state();
    startClaudeUserRun(s.correlation, s.prompt("human-1"), "2026-09-04T10:00:00.000Z", undefined, s.env);
    endClaudeUserRun(s.correlation, "2026-09-04T10:01:00.000Z", undefined, s.env);
    startClaudeUserRun(s.correlation, s.prompt("task-1"), "2026-09-04T10:01:01.000Z", undefined, s.env);
    const open = claudeProvisionalPending(s.correlation, s.env)!;
    expect(open.phase).toBe("open");
    if (open.phase !== "open") return;
    const projected = projectClaudePositiveSettlement(s.correlation, "2026-09-04T10:02:00.000Z", open, s.env)!;
    const event = frozenEvent(projected);
    const settled = commitClaudePositiveSettlement(
      s.correlation,
      "2026-09-04T10:02:00.000Z",
      open,
      "a".repeat(32),
      event,
      s.env
    )!;
    expect(settled).toMatchObject({ phase: "settled", predecessor_run_seq: 1, provisional_run_seq: 2, event });
    const raw = JSON.parse(await readFile(join(s.dir, "runs", `${s.correlation}.json`), "utf8"));
    expect(raw.runs).toHaveLength(1);
    expect(raw.claude_provisional_pending).toEqual(settled);

    // First frozen writer wins: the open identity no longer exists, so no conflicting replacement.
    expect(commitClaudePositiveSettlement(
      s.correlation,
      "2026-09-04T10:02:00.000Z",
      open,
      "b".repeat(32),
      { ...event, output_after: 181 },
      s.env
    )).toBeUndefined();
    expect(claudeProvisionalPending(s.correlation, s.env)).toEqual(settled);

    expect(completeClaudePositiveSettlement(s.correlation, { ...settled, dedup_key: "b".repeat(32) }, s.env)).toBe(false);
    expect(completeClaudePositiveSettlement(s.correlation, settled, s.env)).toBe(true);
    expect(claudeProvisionalPending(s.correlation, s.env)).toBeUndefined();
  });

  it("fails closed for every malformed or foreign frozen phase without resurrecting a closed run", async () => {
    for (const corruption of [
      "schema",
      "session",
      "predecessor",
      "provisional",
      "dedup",
      "started",
      "ended",
      "event-id",
      "event-session",
      "event-run",
      "extra"
    ] as const) {
      const s = await state(`settled-${corruption}`);
      startClaudeUserRun(s.correlation, s.prompt("human-1"), "2026-09-04T10:00:00.000Z", undefined, s.env);
      endClaudeUserRun(s.correlation, "2026-09-04T10:01:00.000Z", undefined, s.env);
      startClaudeUserRun(s.correlation, s.prompt("task-1"), "2026-09-04T10:01:01.000Z", undefined, s.env);
      const open = claudeProvisionalPending(s.correlation, s.env)!;
      if (open.phase !== "open") throw new Error("expected open pending");
      const projected = projectClaudePositiveSettlement(s.correlation, "2026-09-04T10:02:00.000Z", open, s.env)!;
      commitClaudePositiveSettlement(
        s.correlation,
        "2026-09-04T10:02:00.000Z",
        open,
        "a".repeat(32),
        frozenEvent(projected),
        s.env
      );
      const storePath = join(s.dir, "runs", `${s.correlation}.json`);
      const raw = JSON.parse(await readFile(storePath, "utf8"));
      const pending = raw.claude_provisional_pending;
      if (corruption === "schema") pending.schema = "compaction.claude-provisional-pending.v999";
      if (corruption === "session") pending.session_correlation_id = "0".repeat(32);
      if (corruption === "predecessor") pending.predecessor_run_seq = 99;
      if (corruption === "provisional") pending.provisional_run_seq = 99;
      if (corruption === "dedup") pending.dedup_key = "not-a-digest";
      if (corruption === "started") pending.run_started_at = "2026-09-04T09:59:59.000Z";
      if (corruption === "ended") pending.run_ended_at = "2026-09-04T10:02:01.000Z";
      if (corruption === "event-id") pending.event.activity_event_id = "activity-event-v1-invalid";
      if (corruption === "event-session") pending.event.session_id = "claude-session-invalid";
      if (corruption === "event-run") pending.event.run_id = "claude-stop-invalid";
      if (corruption === "extra") pending.raw_session_id = "must never be accepted";
      await writeFile(storePath, JSON.stringify(raw), "utf8");

      expect(claudeProvisionalPending(s.correlation, s.env)).toBeUndefined();
      expect(projectClaudePositiveSettlement(
        s.correlation,
        "2026-09-04T10:03:00.000Z",
        open,
        s.env
      )).toBeUndefined();
      expect(endClaudeUserRun(
        s.correlation,
        "2026-09-04T10:03:00.000Z",
        resolution(open, true),
        s.env
      )).toBeUndefined();

      const next = startClaudeUserRun(
        s.correlation,
        s.prompt("human-2"),
        "2026-09-04T10:04:00.000Z",
        undefined,
        s.env
      );
      expect(next?.run_seq).toBe(2);
      expect(claudeProvisionalPending(s.correlation, s.env)).toMatchObject({
        phase: "open",
        predecessor_run_seq: 1,
        provisional_run_seq: 2
      });
      const cleaned = JSON.parse(await readFile(storePath, "utf8"));
      expect(cleaned.runs).toHaveLength(2);
      expect(cleaned.runs[0]).toMatchObject({ run_seq: 1, ended_at: "2026-09-04T10:02:00.000Z" });
    }
  });

  it("a new prompt discards an unfinished frozen publication and starts a normal separate run", async () => {
    const s = await state();
    startClaudeUserRun(s.correlation, s.prompt("human-1"), "2026-09-04T10:00:00.000Z", undefined, s.env);
    endClaudeUserRun(s.correlation, "2026-09-04T10:01:00.000Z", undefined, s.env);
    startClaudeUserRun(s.correlation, s.prompt("task-1"), "2026-09-04T10:01:01.000Z", undefined, s.env);
    const open = claudeProvisionalPending(s.correlation, s.env)!;
    if (open.phase !== "open") throw new Error("expected open pending");
    const projected = projectClaudePositiveSettlement(s.correlation, "2026-09-04T10:02:00.000Z", open, s.env)!;
    commitClaudePositiveSettlement(
      s.correlation,
      "2026-09-04T10:02:00.000Z",
      open,
      "a".repeat(32),
      frozenEvent(projected),
      s.env
    );

    const next = startClaudeUserRun(
      s.correlation,
      s.prompt("human-2"),
      "2026-09-04T10:03:00.000Z",
      undefined,
      s.env
    );
    expect(next?.run_seq).toBe(2);
    expect(claudeProvisionalPending(s.correlation, s.env)).toMatchObject({
      phase: "open",
      predecessor_run_seq: 1,
      provisional_run_seq: 2,
      prompt_correlation_id: s.prompt("human-2")
    });
    const raw = JSON.parse(await readFile(join(s.dir, "runs", `${s.correlation}.json`), "utf8"));
    expect(raw.runs).toHaveLength(2);
    expect(raw.runs[0]).toMatchObject({ run_seq: 1, ended_at: "2026-09-04T10:02:00.000Z" });
    expect(raw.runs[1]).toMatchObject({ run_seq: 2, started_at: "2026-09-04T10:03:00.000Z" });
  });

  it("collapses only an exact adjacent open provisional pair on positive evidence", async () => {
    const s = await state();
    startClaudeUserRun(s.correlation, s.prompt("human-1"), "2026-09-04T10:00:00.000Z", undefined, s.env);
    endClaudeUserRun(s.correlation, "2026-09-04T10:01:00.000Z", undefined, s.env);
    startClaudeUserRun(s.correlation, s.prompt("task-1"), "2026-09-04T10:01:01.000Z", undefined, s.env);
    const pending = claudeProvisionalPending(s.correlation, s.env)!;

    const settled = endClaudeUserRun(
      s.correlation,
      "2026-09-04T10:02:00.000Z",
      resolution(pending, true),
      s.env
    );
    expect(settled).toMatchObject({ run_seq: 1, started_at: "2026-09-04T10:00:00.000Z", ended_at: "2026-09-04T10:02:00.000Z" });
    expect(claudeProvisionalPending(s.correlation, s.env)).toBeUndefined();
    const raw = JSON.parse(await readFile(join(s.dir, "runs", `${s.correlation}.json`), "utf8"));
    expect(raw.runs).toHaveLength(1);
  });

  it("negative evidence closes a genuine second prompt as its own run", async () => {
    const s = await state();
    startClaudeUserRun(s.correlation, s.prompt("human-1"), "2026-09-04T10:00:00.000Z", undefined, s.env);
    endClaudeUserRun(s.correlation, "2026-09-04T10:01:00.000Z", undefined, s.env);
    startClaudeUserRun(s.correlation, s.prompt("human-2"), "2026-09-04T10:02:00.000Z", undefined, s.env);
    const pending = claudeProvisionalPending(s.correlation, s.env)!;
    const settled = endClaudeUserRun(s.correlation, "2026-09-04T10:03:00.000Z", resolution(pending, false), s.env);
    expect(settled).toMatchObject({ run_seq: 2, ended_at: "2026-09-04T10:03:00.000Z" });
    const raw = JSON.parse(await readFile(join(s.dir, "runs", `${s.correlation}.json`), "utf8"));
    expect(raw.runs).toHaveLength(2);
    expect(raw.claude_provisional_pending).toBeUndefined();
  });

  it("recovers a missed Stop before opening the next prompt", async () => {
    const s = await state();
    startClaudeUserRun(s.correlation, s.prompt("human-1"), "2026-09-04T10:00:00.000Z", undefined, s.env);
    endClaudeUserRun(s.correlation, "2026-09-04T10:01:00.000Z", undefined, s.env);
    startClaudeUserRun(s.correlation, s.prompt("task-1"), "2026-09-04T10:01:01.000Z", undefined, s.env);
    const prior = claudeProvisionalPending(s.correlation, s.env)!;
    const current = startClaudeUserRun(
      s.correlation,
      s.prompt("human-2"),
      "2026-09-04T10:04:00.000Z",
      resolution(prior, true),
      s.env
    )!;
    expect(current.run_seq).toBe(2);
    const next = claudeProvisionalPending(s.correlation, s.env)!;
    expect(next).toMatchObject({ predecessor_run_seq: 1, provisional_run_seq: 2, prompt_correlation_id: s.prompt("human-2") });
    const raw = JSON.parse(await readFile(join(s.dir, "runs", `${s.correlation}.json`), "utf8"));
    expect(raw.runs).toHaveLength(2);
    expect(raw.runs[0].ended_at).toBe("2026-09-04T10:04:00.000Z");
    expect(raw.runs[1].ended_at).toBeUndefined();
  });

  it("survives process-local cache loss between provisional creation and reconciliation", async () => {
    const s = await state();
    startClaudeUserRun(s.correlation, s.prompt("human-1"), "2026-09-04T10:00:00.000Z", undefined, s.env);
    endClaudeUserRun(s.correlation, "2026-09-04T10:01:00.000Z", undefined, s.env);
    startClaudeUserRun(s.correlation, s.prompt("task-1"), "2026-09-04T10:01:01.000Z", undefined, s.env);
    const beforeRestart = claudeProvisionalPending(s.correlation, s.env)!;

    resetSessionCorrelationCache();
    expect(sessionCorrelationId(s.session, s.env)).toBe(s.correlation);
    expect(claudePromptCorrelationId(s.session, "task-1", s.env)).toBe(beforeRestart.prompt_correlation_id);
    expect(claudeProvisionalPending(s.correlation, s.env)).toEqual(beforeRestart);

    const settled = endClaudeUserRun(
      s.correlation,
      "2026-09-04T10:02:00.000Z",
      resolution(beforeRestart, true),
      s.env
    );
    expect(settled?.run_seq).toBe(1);
  });

  it("a missed Stop with negative evidence closes the old provisional before starting the next run", async () => {
    const s = await state();
    startClaudeUserRun(s.correlation, s.prompt("human-1"), "2026-09-04T10:00:00.000Z", undefined, s.env);
    endClaudeUserRun(s.correlation, "2026-09-04T10:01:00.000Z", undefined, s.env);
    startClaudeUserRun(s.correlation, s.prompt("human-2"), "2026-09-04T10:02:00.000Z", undefined, s.env);
    const prior = claudeProvisionalPending(s.correlation, s.env)!;
    const third = startClaudeUserRun(
      s.correlation,
      s.prompt("human-3"),
      "2026-09-04T10:03:00.000Z",
      resolution(prior, false),
      s.env
    )!;
    expect(third.run_seq).toBe(3);
    const raw = JSON.parse(await readFile(join(s.dir, "runs", `${s.correlation}.json`), "utf8"));
    expect(raw.runs).toHaveLength(3);
    expect(raw.runs[1].ended_at).toBe("2026-09-04T10:03:00.000Z");
    expect(raw.claude_provisional_pending).toMatchObject({ predecessor_run_seq: 2, provisional_run_seq: 3 });
  });

  it("changed, foreign, stale, and malformed pending state can only settle separately", async () => {
    for (const corruption of ["digest", "session", "predecessor", "provisional", "extra", "ended"] as const) {
      const s = await state(`session-${corruption}`);
      startClaudeUserRun(s.correlation, s.prompt("human-1"), "2026-09-04T10:00:00.000Z", undefined, s.env);
      endClaudeUserRun(s.correlation, "2026-09-04T10:01:00.000Z", undefined, s.env);
      startClaudeUserRun(s.correlation, s.prompt("task-1"), "2026-09-04T10:01:01.000Z", undefined, s.env);
      const pending = claudeProvisionalPending(s.correlation, s.env)!;
      const path = join(s.dir, "runs", `${s.correlation}.json`);
      const raw = JSON.parse(await readFile(path, "utf8"));
      if (corruption === "digest") raw.claude_provisional_pending.prompt_correlation_id = "0".repeat(32);
      if (corruption === "session") raw.claude_provisional_pending.session_correlation_id = "0".repeat(32);
      if (corruption === "predecessor") raw.claude_provisional_pending.predecessor_run_seq = 99;
      if (corruption === "provisional") raw.claude_provisional_pending.provisional_run_seq = 99;
      if (corruption === "extra") raw.claude_provisional_pending.prompt = "must never be accepted";
      if (corruption === "ended") raw.runs[1].ended_at = "2026-09-04T10:01:30.000Z";
      await writeFile(path, JSON.stringify(raw), "utf8");

      const settled = endClaudeUserRun(s.correlation, "2026-09-04T10:02:00.000Z", resolution(pending, true), s.env);
      if (corruption === "ended") expect(settled).toBeUndefined();
      else expect(settled?.run_seq).toBe(2);
      const after = JSON.parse(await readFile(path, "utf8"));
      expect(after.runs).toHaveLength(2);
    }
  });

  it("same prompt digest in another session cannot consume or collapse either session", async () => {
    const a = await state("session-a");
    const b = await state("session-b");
    for (const s of [a, b]) {
      startClaudeUserRun(s.correlation, s.prompt("human"), "2026-09-04T10:00:00.000Z", undefined, s.env);
      endClaudeUserRun(s.correlation, "2026-09-04T10:01:00.000Z", undefined, s.env);
      startClaudeUserRun(s.correlation, s.prompt("same-prompt"), "2026-09-04T10:02:00.000Z", undefined, s.env);
    }
    const pendingA = claudeProvisionalPending(a.correlation, a.env)!;
    const pendingB = claudeProvisionalPending(b.correlation, b.env)!;
    expect(pendingA.prompt_correlation_id).not.toBe(pendingB.prompt_correlation_id);
    endClaudeUserRun(a.correlation, "2026-09-04T10:03:00.000Z", resolution(pendingB, true), a.env);
    expect(claudeProvisionalPending(b.correlation, b.env)).toEqual(pendingB);
    const rawA = JSON.parse(await readFile(join(a.dir, "runs", `${a.correlation}.json`), "utf8"));
    expect(rawA.runs).toHaveLength(2);
  });

  it("retains at most twenty runs and one pending object", async () => {
    const s = await state();
    for (let i = 0; i < 24; i += 1) {
      const at = new Date(Date.UTC(2026, 8, 4, 10, i, 0)).toISOString();
      const end = new Date(Date.UTC(2026, 8, 4, 10, i, 30)).toISOString();
      startClaudeUserRun(s.correlation, s.prompt(`prompt-${i}`), at, undefined, s.env);
      const pending = claudeProvisionalPending(s.correlation, s.env);
      endClaudeUserRun(
        s.correlation,
        end,
        pending ? resolution(pending, false) : undefined,
        s.env
      );
    }
    const raw = JSON.parse(await readFile(join(s.dir, "runs", `${s.correlation}.json`), "utf8"));
    expect(raw.runs).toHaveLength(20);
    expect(Object.keys(raw).filter((key) => key === "claude_provisional_pending")).toHaveLength(0);
  });

  it("persists no raw session, prompt, path, origin, or content bytes", async () => {
    const s = await state("RAW_SESSION_SECRET");
    startClaudeUserRun(s.correlation, s.prompt("human"), "2026-09-04T10:00:00.000Z", undefined, s.env);
    endClaudeUserRun(s.correlation, "2026-09-04T10:01:00.000Z", undefined, s.env);
    startClaudeUserRun(s.correlation, s.prompt("RAW_PROMPT_SECRET"), "2026-09-04T10:02:00.000Z", undefined, s.env);
    const raw = await readFile(join(s.dir, "runs", `${s.correlation}.json`), "utf8");
    for (const forbidden of ["RAW_SESSION_SECRET", "RAW_PROMPT_SECRET", "transcript", "task-notification", "origin", "message"]) {
      expect(raw).not.toContain(forbidden);
    }
  });
});
