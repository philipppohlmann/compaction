import { appendFile, chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  captureClaudeCodeFromHook,
  captureClaudeCodeShapeFromPromptHook
} from "../../src/cli/commands/capture-claude-code.js";
import { computeStatusLine } from "../../src/cli/commands/statusline.js";
import { lastReceiptLines, receiptLinesFromJsonl } from "../../src/cli/commands/watch.js";
import { appendActivityEvent, readActivityEvents } from "../../src/core/activity-store.js";
import type { ActivityEvent } from "../../src/core/activity-event.js";
import { aggregateHookUsageRecords, loadHookUsageRecords } from "../../src/core/hook-usage-aggregate.js";
import {
  claudeProvisionalPending,
  commitClaudePositiveSettlement,
  completeClaudePositiveSettlement,
  currentUserRun,
  endClaudeUserRun,
  receiptBelongsToRun
} from "../../src/core/gateway/run-boundary.js";
import { sessionCorrelationId } from "../../src/core/gateway/session-correlation.js";
import type { GatewayReceipt } from "../../src/core/gateway/receipt.js";
import { createUsageMetadata } from "../../src/core/usage-metadata.js";
import { recordShapingOutcome } from "../../src/core/output-shaping-turn-state.js";
import { provisionValidLease } from "../helpers/lease-fixture.js";

const dirs: string[] = [];
const SESSION = "parent-session";

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "claude-provisional-e2e-"));
  const configDir = await mkdtemp(join(tmpdir(), "claude-provisional-e2e-config-"));
  dirs.push(cwd, configDir);
  const transcript = join(cwd, "session.jsonl");
  await writeFile(transcript, "", "utf8");
  const env = provisionValidLease(
    configDir,
    { COMPACTION_SHAPING_HOOKS: "0" },
    { productMode: "full" }
  );
  return { cwd, configDir, transcript, env, correlation: sessionCorrelationId(SESSION, env)! };
}

function promptPayload(transcript: string, promptId: string, prompt = "prompt bytes stay in memory"): string {
  return JSON.stringify({
    hook_event_name: "UserPromptSubmit",
    session_id: SESSION,
    transcript_path: transcript,
    prompt_id: promptId,
    prompt
  });
}

async function appendPromptRow(
  transcript: string,
  promptId: string,
  origin: Record<string, unknown>
): Promise<void> {
  await appendFile(transcript, `${JSON.stringify({
    type: "user",
    sessionId: SESSION,
    promptId,
    uuid: `transcript-row-${promptId}`,
    isSidechain: false,
    origin,
    message: { role: "user", content: "SECRET_TRANSCRIPT_CONTENT" }
  })}\n`, "utf8");
}

const usage = createUsageMetadata({
  inputTokens: 1_900,
  outputTokens: 180,
  totalTokens: 2_080,
  providerReportedTokens: true,
  estimatedTokens: false,
  provider: "anthropic",
  model: "claude-opus-5"
});

function receipt(
  id: string,
  requestAt: string,
  capturedAt: string,
  before: number,
  after: number,
  output: number,
  correlation: string
): GatewayReceipt {
  return {
    receipt_id: id,
    captured_at: capturedAt,
    request_started_at: requestAt,
    provider: "anthropic",
    model: "claude-opus-5",
    endpoint: "/v1/messages",
    mode: "apply",
    upstream_status: 200,
    request_mutated: true,
    model_visible_bytes_changed: true,
    estimated_input_tokens_before: before,
    estimated_input_tokens_after: after,
    applied_components: ["deterministic-compaction", "output-shaping"],
    output_shaping_state: "attached-this-pass",
    output_shaping_policy_version: "output-shaping-v1",
    output_shaping_regime: "default-shapeable",
    tokens: { prompt_input: before, output },
    session_correlation_id: correlation,
    fresh_billed_input_reduction: { available: false, note: "not relevant" },
    token_source: "provider-reported",
    cache_source: "unavailable",
    cost_source: "unavailable",
    reasons: { cost: "not measured" },
    claim_scope: "run-scoped",
    approval_status: "approved",
    sync_status: "local-only",
    content_uploaded: false,
    label: "test receipt"
  } as GatewayReceipt;
}

async function stop(
  f: Awaited<ReturnType<typeof fixture>>,
  at: string,
  fingerprint: string,
  latest?: GatewayReceipt,
  receipts?: GatewayReceipt[],
  normalizedUsage = usage
): Promise<string[]> {
  const lines: string[] = [];
  await captureClaudeCodeFromHook({}, {
    cwd: f.cwd,
    env: f.env,
    now: () => at,
    readStdin: async () => JSON.stringify({
      hook_event_name: "Stop",
      session_id: SESSION,
      transcript_path: f.transcript
    }),
    normalize: async () => ({ usage: normalizedUsage, messageCount: 12, fingerprint }),
    readLatestGatewayReceipt: async () => latest,
    ...(receipts ? { readGatewayReceipts: async () => ({ receipts, truncated: false }) } : {}),
    printReceiptLine: (line) => lines.push(line),
    hostedConfigured: () => false
  });
  return lines;
}

describe("Claude task-notification provisional lifecycle", () => {
  it("keeps an exact positive pair retryable when the real transcript normalizer finds no usage axes", async () => {
    const f = await fixture();
    await captureClaudeCodeShapeFromPromptHook({
      env: f.env,
      now: () => "2026-09-04T10:00:00.000Z",
      readStdin: async () => promptPayload(f.transcript, "human-no-usage"),
      write: () => undefined
    });
    await stop(f, "2026-09-04T10:01:00.000Z", "no-usage-parent", undefined, []);
    await captureClaudeCodeShapeFromPromptHook({
      env: f.env,
      now: () => "2026-09-04T10:01:01.000Z",
      readStdin: async () => promptPayload(f.transcript, "task-no-usage"),
      write: () => undefined
    });
    await appendPromptRow(f.transcript, "task-no-usage", { kind: "task-notification" });

    const lines: string[] = [];
    await captureClaudeCodeFromHook({}, {
      cwd: f.cwd,
      env: f.env,
      now: () => "2026-09-04T10:02:00.000Z",
      readStdin: async () => JSON.stringify({
        hook_event_name: "Stop",
        session_id: SESSION,
        transcript_path: f.transcript
      }),
      readGatewayReceipts: async () => ({ receipts: [], truncated: false }),
      printReceiptLine: (line) => lines.push(line),
      hostedConfigured: () => false
    });

    expect(lines).toEqual([]);
    expect(claudeProvisionalPending(f.correlation, f.env)).toMatchObject({
      phase: "open",
      predecessor_run_seq: 1,
      provisional_run_seq: 2
    });
    expect(currentUserRun(f.correlation, f.env)?.run_seq).toBe(2);
    expect(currentUserRun(f.correlation, f.env)?.ended_at).toBeUndefined();
    expect((await readActivityEvents(join(f.cwd, ".compaction", "activity"))).events).toHaveLength(1);
  });

  it("settles a hook-only continuation from final transcript totals with one truthful shared line", async () => {
    const f = await fixture();
    await captureClaudeCodeShapeFromPromptHook({
      env: f.env,
      now: () => "2026-09-04T10:00:00.000Z",
      readStdin: async () => promptPayload(f.transcript, "human-hook-only"),
      write: () => undefined
    });
    await stop(f, "2026-09-04T10:01:00.000Z", "hook-only-parent", undefined, []);

    await captureClaudeCodeShapeFromPromptHook({
      env: f.env,
      now: () => "2026-09-04T10:01:01.000Z",
      readStdin: async () => promptPayload(f.transcript, "task-hook-only"),
      write: () => undefined
    });
    await appendPromptRow(f.transcript, "task-hook-only", { kind: "task-notification" });
    const inline = await stop(f, "2026-09-04T10:02:00.000Z", "hook-only-final", undefined, []);

    expect(currentUserRun(f.correlation, f.env)).toMatchObject({
      run_seq: 1,
      started_at: "2026-09-04T10:00:00.000Z",
      ended_at: "2026-09-04T10:02:00.000Z"
    });
    expect(claudeProvisionalPending(f.correlation, f.env)).toBeUndefined();
    const finalLine = inline.find((line) => line.startsWith("compaction · "))!;
    expect(finalLine).toContain("session cumulative");
    expect(finalLine).toContain("input 1,900");
    expect(finalLine).toContain("output 180");
    expect(finalLine).not.toMatch(/input .*→|N\/A|47%|apply off|basic shaping|full apply/);

    const events = (await readActivityEvents(join(f.cwd, ".compaction", "activity"))).events;
    expect(events).toHaveLength(1);
    const settled = events.filter((event) => event.activity_kind === "claude-stop");
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({
      measurement_source: "claude-transcript",
      input_before: 1_900,
      output_after: 180
    });
    expect(settled[0].input_after).toBeUndefined();
    expect(settled[0].estimated_output_tokens_saved).toBeUndefined();

    const status = await computeStatusLine(JSON.stringify({ cwd: f.cwd, session_id: SESSION }), {
      env: f.env,
      readReceipts: async () => []
    });
    expect(status).toBe(finalLine);
    expect(await lastReceiptLines(1, { cwd: f.cwd, env: f.env })).toEqual({
      lines: [finalLine],
      killSwitch: false
    });

    await stop(f, "2026-09-04T10:02:00.000Z", "hook-only-final", undefined, []);
    expect((await readActivityEvents(join(f.cwd, ".compaction", "activity"))).events
      .filter((event) => event.activity_kind === "claude-stop")).toHaveLength(1);

    // The next genuine prompt opens a new run. Its empty/open state must not resurrect this settled
    // activity merely because it is the newest record for the same Claude session.
    await captureClaudeCodeShapeFromPromptHook({
      env: f.env,
      now: () => "2026-09-04T10:03:00.000Z",
      readStdin: async () => promptPayload(f.transcript, "next-human"),
      write: () => undefined
    });
    expect(await computeStatusLine(JSON.stringify({ cwd: f.cwd, session_id: SESSION }), {
      env: f.env,
      readReceipts: async () => []
    })).toBe("compaction · recording");

    const storeRaw = await readFile(join(f.configDir, "runs", `${f.correlation}.json`), "utf8");
    for (const forbidden of [SESSION, "human-hook-only", "task-hook-only", "SECRET_TRANSCRIPT_CONTENT"]) {
      expect(storeRaw).not.toContain(forbidden);
    }
  });

  it("carries only exact same-session positive shaping into a hook-only fallback", async () => {
    const f = await fixture();
    await captureClaudeCodeShapeFromPromptHook({
      env: f.env,
      now: () => "2026-09-04T10:00:00.000Z",
      readStdin: async () => promptPayload(f.transcript, "human-shaped"),
      write: () => undefined
    });
    await stop(f, "2026-09-04T10:01:00.000Z", "shaped-parent", undefined, []);
    await captureClaudeCodeShapeFromPromptHook({
      env: f.env,
      now: () => "2026-09-04T10:01:01.000Z",
      readStdin: async () => promptPayload(f.transcript, "task-shaped"),
      write: () => undefined
    });
    await recordShapingOutcome(
      { tool: "claude-code", sessionId: SESSION },
      "shape",
      f.env,
      () => new Date("2026-09-04T10:01:02.000Z")
    );
    await appendPromptRow(f.transcript, "task-shaped", { kind: "task-notification" });
    const lines = await stop(f, "2026-09-04T10:02:00.000Z", "shaped-final", undefined, []);
    const line = lines.find((candidate) => candidate.startsWith("compaction · "))!;
    expect(line).toContain("session cumulative");
    expect(line).toContain("observed input 1,900");
    expect(line).toContain("output N/A→180 (N/A%, est.)");
    expect(line).toContain("basic shaping");
    expect(line).not.toContain("47%");
    const event = (await readActivityEvents(join(f.cwd, ".compaction", "activity"))).events
      .find((candidate) => candidate.activity_kind === "claude-stop")!;
    expect(event.measurement_source).toBe("claude-transcript");
    expect(event.output_estimate_state).toBe("unseeded");
    expect(event.output_estimate_basis).toBeUndefined();
    expect(event.estimated_output_tokens_saved).toBeUndefined();
  });

  it("settles two genuine human tasks without carrying the first task's cumulative usage into the second", async () => {
    const f = await fixture();
    const firstUsage = createUsageMetadata({
      inputTokens: 1_000,
      outputTokens: 100,
      totalTokens: 1_100,
      providerReportedTokens: true,
      estimatedTokens: false,
      provider: "anthropic",
      model: "claude-opus-5"
    });
    const parentSecondUsage = createUsageMetadata({
      inputTokens: 1_700,
      outputTokens: 160,
      totalTokens: 1_860,
      providerReportedTokens: true,
      estimatedTokens: false,
      provider: "anthropic",
      model: "claude-opus-5"
    });

    await captureClaudeCodeShapeFromPromptHook({
      env: f.env,
      now: () => "2026-09-04T10:00:00.000Z",
      readStdin: async () => promptPayload(f.transcript, "human-first"),
      write: () => undefined
    });
    await stop(f, "2026-09-04T10:01:00.000Z", "human-first-stop", undefined, [], firstUsage);

    await captureClaudeCodeShapeFromPromptHook({
      env: f.env,
      now: () => "2026-09-04T10:02:00.000Z",
      readStdin: async () => promptPayload(f.transcript, "human-second"),
      write: () => undefined
    });
    await appendPromptRow(f.transcript, "human-second", { kind: "human" });
    await stop(f, "2026-09-04T10:03:00.000Z", "human-second-parent", undefined, [], parentSecondUsage);
    await captureClaudeCodeShapeFromPromptHook({
      env: f.env,
      now: () => "2026-09-04T10:03:01.000Z",
      readStdin: async () => promptPayload(f.transcript, "task-second"),
      write: () => undefined
    });
    await appendPromptRow(f.transcript, "task-second", { kind: "task-notification" });
    const inline = await stop(
      f,
      "2026-09-04T10:04:00.000Z",
      "human-second-final",
      undefined,
      [],
      usage
    );

    const line = inline.find((candidate) => candidate.startsWith("compaction · "))!;
    expect(line).not.toContain("session cumulative");
    expect(line).toContain("input 900");
    expect(line).toContain("output 80");
    expect(line).not.toContain("1,900");
    const events = (await readActivityEvents(join(f.cwd, ".compaction", "activity"))).events;
    expect(events).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({
      activity_kind: "claude-stop",
      measurement_source: "claude-transcript",
      claim_scope: "run-scoped",
      input_before: 900,
      output_after: 80
    });
    const status = await computeStatusLine(JSON.stringify({ cwd: f.cwd, session_id: SESSION }), {
      env: f.env,
      readReceipts: async () => []
    });
    expect(status).toBe(line);
    expect(await lastReceiptLines(1, { cwd: f.cwd, env: f.env })).toEqual({
      lines: [line],
      killSwitch: false
    });
    const aggregate = aggregateHookUsageRecords(
      await loadHookUsageRecords(join(f.cwd, ".compaction", "hooks"))
    );
    expect(aggregate.tools[0]).toMatchObject({
      events: 2,
      inputTokens: 1_900,
      outputTokens: 180
    });
  });

  it("replays the same frozen hook-only settlement after activity persistence recovers", async () => {
    const f = await fixture();
    await captureClaudeCodeShapeFromPromptHook({
      env: f.env,
      now: () => "2026-09-04T10:00:00.000Z",
      readStdin: async () => promptPayload(f.transcript, "human-recovery"),
      write: () => undefined
    });
    await stop(f, "2026-09-04T10:01:00.000Z", "recovery-parent", undefined, []);
    await captureClaudeCodeShapeFromPromptHook({
      env: f.env,
      now: () => "2026-09-04T10:01:01.000Z",
      readStdin: async () => promptPayload(f.transcript, "task-recovery"),
      write: () => undefined
    });
    await appendPromptRow(f.transcript, "task-recovery", { kind: "task-notification" });

    let failActivity = true;
    let receiptReads = 0;
    const lines: string[] = [];
    const deps = {
      cwd: f.cwd,
      env: f.env,
      now: () => "2026-09-04T10:02:00.000Z",
      readStdin: async () => JSON.stringify({
        hook_event_name: "Stop",
        session_id: SESSION,
        transcript_path: f.transcript
      }),
      normalize: async () => ({ usage, messageCount: 12, fingerprint: "recovery-final" }),
      readGatewayReceipts: async () => {
        receiptReads += 1;
        return { receipts: [], truncated: false };
      },
      appendActivity: async (event: ActivityEvent, directory?: string) =>
        failActivity
          ? { appended: false as const, reason: "synthetic activity failure" }
          : appendActivityEvent(event, directory),
      printReceiptLine: (line: string) => lines.push(line),
      hostedConfigured: () => false
    };

    await captureClaudeCodeFromHook({}, deps);
    const frozen = claudeProvisionalPending(f.correlation, f.env);
    expect(frozen).toMatchObject({
      phase: "settled",
      event: {
        measurement_source: "claude-transcript",
        input_before: 1_900,
        output_after: 180
      }
    });
    expect(lines).toEqual([]);
    expect(receiptReads).toBe(1);

    failActivity = false;
    await captureClaudeCodeFromHook({}, deps);
    expect(claudeProvisionalPending(f.correlation, f.env)).toBeUndefined();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("input 1,900");
    expect(lines[0]).toContain("output 180");
    expect(receiptReads).toBe(1);
    expect((await readActivityEvents(join(f.cwd, ".compaction", "activity"))).events).toHaveLength(1);

    await captureClaudeCodeFromHook({}, deps);
    expect(lines).toHaveLength(1);
    expect(receiptReads).toBe(1);
    expect((await readActivityEvents(join(f.cwd, ".compaction", "activity"))).events).toHaveLength(1);
  });

  it("defers classification until Stop, then keeps the parent and continuation in one settled run", async () => {
    const f = await fixture();
    await captureClaudeCodeShapeFromPromptHook({
      env: f.env,
      now: () => "2026-09-04T10:00:00.000Z",
      readStdin: async () => promptPayload(f.transcript, "human-1"),
      write: () => undefined
    });
    await stop(f, "2026-09-04T10:01:00.000Z", "parent-stop");

    // Claude has fired UserPromptSubmit, but its structured row is not visible until after this hook.
    await captureClaudeCodeShapeFromPromptHook({
      env: f.env,
      now: () => "2026-09-04T10:01:01.000Z",
      readStdin: async () => promptPayload(f.transcript, "task-1", "<task-notification>text is not evidence</task-notification>"),
      write: () => undefined
    });
    expect(currentUserRun(f.correlation, f.env)?.run_seq).toBe(2);
    expect(currentUserRun(f.correlation, f.env)?.ended_at).toBeUndefined();
    expect(claudeProvisionalPending(f.correlation, f.env)).toMatchObject({ predecessor_run_seq: 1, provisional_run_seq: 2 });

    await appendPromptRow(f.transcript, "task-1", { kind: "task-notification" });
    const first = receipt("parent-call", "2026-09-04T10:00:30.000Z", "2026-09-04T10:01:01.500Z", 1_000, 800, 100, f.correlation);
    const tail = receipt("tail-call", "2026-09-04T10:01:30.000Z", "2026-09-04T10:02:01.000Z", 900, 700, 80, f.correlation);
    const inline = await stop(f, "2026-09-04T10:02:00.000Z", "final-stop", tail, [first, tail]);

    const settled = currentUserRun(f.correlation, f.env)!;
    expect(settled).toMatchObject({
      run_seq: 1,
      started_at: "2026-09-04T10:00:00.000Z",
      ended_at: "2026-09-04T10:02:00.000Z"
    });
    expect(receiptBelongsToRun(first, settled)).toBe(true);
    expect(receiptBelongsToRun(tail, settled)).toBe(true);
    expect(claudeProvisionalPending(f.correlation, f.env)).toBeUndefined();

    const storePath = join(f.configDir, "runs", `${f.correlation}.json`);
    const beforeStatus = await readFile(storePath, "utf8");
    const beforeMtime = (await stat(storePath)).mtimeMs;
    const status = await computeStatusLine(JSON.stringify({ cwd: f.cwd, session_id: SESSION }), {
      env: f.env,
      readReceipts: async () => [first, tail]
    });
    const afterStatus = await readFile(storePath, "utf8");
    const afterMtime = (await stat(storePath)).mtimeMs;
    expect(status).toContain("input 1,900→1,500");
    expect(status).toContain("output N/A→180 (N/A%, est.)");
    expect(status).not.toContain("47%");
    expect(afterStatus).toBe(beforeStatus);
    expect(afterMtime).toBe(beforeMtime);

    const inlineLine = inline.find((line) => line.startsWith("compaction · "))!;
    const watchLine = receiptLinesFromJsonl(`${JSON.stringify(tail)}\n`, { productTier: "full", env: f.env })[0]!;
    expect(inlineLine).toContain("output N/A→180 (N/A%, est.)");
    expect(watchLine).toContain("output N/A→80 (N/A%, est.)");
    expect(inlineLine).not.toContain("47%");
    expect(watchLine).not.toContain("47%");

    const raw = await readFile(storePath, "utf8");
    for (const forbidden of [SESSION, "human-1", "task-1", "SECRET_TRANSCRIPT_CONTENT", "<task-notification>"]) {
      expect(raw).not.toContain(forbidden);
    }
  });

  it("a genuine second human prompt remains a new run", async () => {
    const f = await fixture();
    await captureClaudeCodeShapeFromPromptHook({
      env: f.env,
      now: () => "2026-09-04T10:00:00.000Z",
      readStdin: async () => promptPayload(f.transcript, "human-1"),
      write: () => undefined
    });
    await stop(f, "2026-09-04T10:01:00.000Z", "first");
    await captureClaudeCodeShapeFromPromptHook({
      env: f.env,
      now: () => "2026-09-04T10:02:00.000Z",
      readStdin: async () => promptPayload(f.transcript, "human-2"),
      write: () => undefined
    });
    await appendPromptRow(f.transcript, "human-2", { kind: "human" });
    await stop(f, "2026-09-04T10:03:00.000Z", "second");
    const raw = JSON.parse(await readFile(join(f.configDir, "runs", `${f.correlation}.json`), "utf8"));
    expect(raw.runs).toHaveLength(2);
    expect(raw.runs.map((run: { run_seq: number }) => run.run_seq)).toEqual([1, 2]);
    expect(raw.runs[1].ended_at).toBe("2026-09-04T10:03:00.000Z");
  });

  it("withholds a failed positive collapse and recovers the authoritative event from the same Stop", async () => {
    const f = await fixture();
    const first = receipt(
      "parent-call",
      "2026-09-04T10:00:30.000Z",
      "2026-09-04T10:00:31.000Z",
      1_000,
      800,
      100,
      f.correlation
    );
    const tail = receipt(
      "tail-call",
      "2026-09-04T10:01:30.000Z",
      "2026-09-04T10:01:31.000Z",
      900,
      700,
      80,
      f.correlation
    );
    await captureClaudeCodeShapeFromPromptHook({
      env: f.env,
      now: () => "2026-09-04T10:00:00.000Z",
      readStdin: async () => promptPayload(f.transcript, "human-1"),
      write: () => undefined
    });
    await captureClaudeCodeFromHook({}, {
      cwd: f.cwd,
      env: f.env,
      now: () => "2026-09-04T10:01:00.000Z",
      readStdin: async () => JSON.stringify({
        hook_event_name: "Stop",
        session_id: SESSION,
        transcript_path: f.transcript
      }),
      normalize: async () => ({ usage, messageCount: 8, fingerprint: "parent-state" }),
      readGatewayReceipts: async () => ({ receipts: [first], truncated: false }),
      hostedConfigured: () => false,
      printReceiptLine: () => undefined
    });

    await captureClaudeCodeShapeFromPromptHook({
      env: f.env,
      now: () => "2026-09-04T10:01:01.000Z",
      readStdin: async () => promptPayload(f.transcript, "task-1"),
      write: () => undefined
    });
    await appendPromptRow(f.transcript, "task-1", { kind: "task-notification" });
    const beforeFailureStore = await readFile(
      join(f.configDir, "runs", `${f.correlation}.json`),
      "utf8"
    );
    let failSettlement = true;
    const lines: string[] = [];
    const finalDeps = {
      cwd: f.cwd,
      env: f.env,
      now: () => "2026-09-04T10:02:00.000Z",
      readStdin: async () => JSON.stringify({
        hook_event_name: "Stop",
        session_id: SESSION,
        transcript_path: f.transcript
      }),
      normalize: async () => ({ usage, messageCount: 12, fingerprint: "final-state" }),
      readGatewayReceipts: async () => ({ receipts: [first, tail], truncated: false }),
      commitClaudeSettlement: (...args: Parameters<typeof commitClaudePositiveSettlement>) =>
        failSettlement ? undefined : commitClaudePositiveSettlement(...args),
      printReceiptLine: (line: string) => lines.push(line),
      hostedConfigured: () => false
    };

    // The exact positive settlement failed before it became durable. No terminal hook state,
    // fallback activity, or false line may be committed, and the bounded pending identity survives.
    await captureClaudeCodeFromHook({}, finalDeps);
    expect(lines).toEqual([]);
    expect(await readFile(join(f.configDir, "runs", `${f.correlation}.json`), "utf8")).toBe(beforeFailureStore);
    expect(claudeProvisionalPending(f.correlation, f.env)).toMatchObject({
      predecessor_run_seq: 1,
      provisional_run_seq: 2
    });
    const hookDir = join(f.cwd, ".compaction", "hooks", "claude-code");
    expect(JSON.parse(await readFile(join(hookDir, "ledger.json"), "utf8")).entries).toHaveLength(1);
    expect((await readActivityEvents(join(f.cwd, ".compaction", "activity"))).events).toHaveLength(1);

    // Restoring persistence and replaying the SAME Stop performs the collapse and publishes one
    // authoritative whole-run event. Its frozen basis is then the only replay authority.
    failSettlement = false;
    await captureClaudeCodeFromHook({}, finalDeps);
    expect(claudeProvisionalPending(f.correlation, f.env)).toBeUndefined();
    expect(currentUserRun(f.correlation, f.env)).toMatchObject({
      run_seq: 1,
      started_at: "2026-09-04T10:00:00.000Z",
      ended_at: "2026-09-04T10:02:00.000Z"
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("input 1,900→1,500");
    expect(lines[0]).toContain("output N/A→180 (N/A%, est.)");
    expect(lines[0]).not.toContain("47%");
    const rawActivity = await readFile(join(f.cwd, ".compaction", "activity", "activity.jsonl"), "utf8");
    expect(rawActivity.trim().split("\n")).toHaveLength(2);
    const logicalActivity = await readActivityEvents(join(f.cwd, ".compaction", "activity"));
    expect(logicalActivity.events).toHaveLength(1);
    expect(logicalActivity.events[0].input_before).toBe(1_900);
    expect(logicalActivity.events[0].input_after).toBe(1_500);
    expect(logicalActivity.events[0].output_after).toBe(180);
    const status = await computeStatusLine(JSON.stringify({ cwd: f.cwd, session_id: SESSION }), {
      env: f.env,
      readReceipts: async () => [first, tail]
    });
    expect(await lastReceiptLines(1, { cwd: f.cwd, env: f.env })).toEqual({
      lines: [status],
      killSwitch: false
    });

    // Another replay is terminally idempotent: no new physical event and no second final line.
    await captureClaudeCodeFromHook({}, finalDeps);
    expect(lines).toHaveLength(1);
    expect((await readFile(join(f.cwd, ".compaction", "activity", "activity.jsonl"), "utf8")).trim().split("\n")).toHaveLength(2);
    expect(JSON.parse(await readFile(join(hookDir, "ledger.json"), "utf8")).entries).toHaveLength(2);
  });

  it("retains frozen authority across hook-record, activity, and cleanup failures", async () => {
    const f = await fixture();
    const first = receipt("record-parent", "2026-09-04T10:00:30.000Z", "2026-09-04T10:00:31.000Z", 1_000, 800, 100, f.correlation);
    const tail = receipt("record-tail", "2026-09-04T10:01:30.000Z", "2026-09-04T10:01:31.000Z", 900, 700, 80, f.correlation);
    await captureClaudeCodeShapeFromPromptHook({
      env: f.env,
      now: () => "2026-09-04T10:00:00.000Z",
      readStdin: async () => promptPayload(f.transcript, "human-1"),
      write: () => undefined
    });
    await captureClaudeCodeFromHook({}, {
      cwd: f.cwd,
      env: f.env,
      now: () => "2026-09-04T10:01:00.000Z",
      readStdin: async () => JSON.stringify({ hook_event_name: "Stop", session_id: SESSION, transcript_path: f.transcript }),
      normalize: async () => ({ usage, messageCount: 8, fingerprint: "record-parent-state" }),
      readGatewayReceipts: async () => ({ receipts: [first], truncated: false }),
      hostedConfigured: () => false,
      printReceiptLine: () => undefined
    });
    await captureClaudeCodeShapeFromPromptHook({
      env: f.env,
      now: () => "2026-09-04T10:01:01.000Z",
      readStdin: async () => promptPayload(f.transcript, "task-record"),
      write: () => undefined
    });
    await appendPromptRow(f.transcript, "task-record", { kind: "task-notification" });

    const hookDir = join(f.cwd, ".compaction", "hooks", "claude-code");
    const recordsDir = join(hookDir, "records");
    const ledgerPath = join(hookDir, "ledger.json");
    const activityDir = join(f.cwd, ".compaction", "activity");
    const lines: string[] = [];
    let receiptReads = 0;
    let failActivity = true;
    let failCleanup = true;
    const deps = {
      cwd: f.cwd,
      env: f.env,
      now: () => "2026-09-04T10:02:00.000Z",
      readStdin: async () => JSON.stringify({ hook_event_name: "Stop", session_id: SESSION, transcript_path: f.transcript }),
      normalize: async () => ({ usage, messageCount: 12, fingerprint: "record-final-state" }),
      readGatewayReceipts: async () => {
        receiptReads += 1;
        if (receiptReads > 1) throw new Error("frozen replay must not reread receipts");
        return { receipts: [first, tail], truncated: false };
      },
      appendActivity: async (event: ActivityEvent, directory?: string) =>
        failActivity
          ? { appended: false as const, reason: "synthetic activity persistence failure" }
          : appendActivityEvent(event, directory),
      completeClaudeSettlement: (...args: Parameters<typeof completeClaudePositiveSettlement>) =>
        failCleanup ? false : completeClaudePositiveSettlement(...args),
      printReceiptLine: (line: string) => lines.push(line),
      hostedConfigured: () => false
    };

    // Exact capture-entrypoint failure seam: collapse/freeze commits, then the next hook-record file
    // cannot be created. No false line/activity/ledger terminal state is allowed.
    await chmod(recordsDir, 0o500);
    try {
      await captureClaudeCodeFromHook({}, deps);
    } finally {
      await chmod(recordsDir, 0o700);
    }
    const frozen = claudeProvisionalPending(f.correlation, f.env)!;
    expect(frozen).toMatchObject({ phase: "settled", predecessor_run_seq: 1, provisional_run_seq: 2 });
    if (frozen.phase !== "settled") return;
    expect(frozen.event).toMatchObject({ input_before: 1_900, input_after: 1_500, output_after: 180 });
    expect(currentUserRun(f.correlation, f.env)).toMatchObject({ run_seq: 1, ended_at: "2026-09-04T10:02:00.000Z" });
    expect(JSON.parse(await readFile(join(hookDir, "ledger.json"), "utf8")).entries).toHaveLength(1);
    expect((await readActivityEvents(activityDir)).events).toHaveLength(1);
    expect(lines).toEqual([]);

    // The record lands before a ledger write failure. The settled pending remains so replay can use
    // the immutable record/event instead of rebuilding either from mutable receipts or policy.
    await chmod(ledgerPath, 0o400);
    try {
      await captureClaudeCodeFromHook({}, deps);
    } finally {
      await chmod(ledgerPath, 0o600);
    }
    expect(claudeProvisionalPending(f.correlation, f.env)?.phase).toBe("settled");
    expect(JSON.parse(await readFile(ledgerPath, "utf8")).entries).toHaveLength(1);
    expect((await readActivityEvents(activityDir)).events).toHaveLength(1);
    expect(lines).toEqual([]);

    // Ledger recovery now lands from the frozen record, but activity fails. Frozen pending remains;
    // no event/line is fabricated.
    await captureClaudeCodeFromHook({}, deps);
    expect(claudeProvisionalPending(f.correlation, f.env)?.phase).toBe("settled");
    expect(JSON.parse(await readFile(ledgerPath, "utf8")).entries).toHaveLength(2);
    expect((await readActivityEvents(activityDir)).events).toHaveLength(1);
    expect(lines).toEqual([]);

    // Activity lands exactly once. A cleanup write failure retains only the same frozen authority.
    failActivity = false;
    await captureClaudeCodeFromHook({}, deps);
    expect(claudeProvisionalPending(f.correlation, f.env)?.phase).toBe("settled");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("input 1,900→1,500");
    expect((await readFile(join(activityDir, "activity.jsonl"), "utf8")).trim().split("\n")).toHaveLength(2);

    // Same Stop sees the durable record/event, confirms the duplicate append, and completes cleanup.
    failCleanup = false;
    await captureClaudeCodeFromHook({}, deps);
    expect(claudeProvisionalPending(f.correlation, f.env)).toBeUndefined();
    expect(lines).toHaveLength(1);
    await captureClaudeCodeFromHook({}, deps);
    expect(lines).toHaveLength(1);
    expect((await readFile(join(activityDir, "activity.jsonl"), "utf8")).trim().split("\n")).toHaveLength(2);
    expect(receiptReads).toBe(1);
  });
});
