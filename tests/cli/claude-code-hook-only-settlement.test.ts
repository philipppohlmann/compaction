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

describe("Claude hook-only settlement of an ordinary run", () => {
  it("a run with no gateway receipts settles from the transcript and later activity keeps that result", async () => {
    const f = await fixture();
    const prompt = (at: string, id: string) => captureClaudeCodeShapeFromPromptHook({
      env: f.env, now: () => at, readStdin: async () => promptPayload(f.transcript, id), write: () => undefined
    });
    const status = () => computeStatusLine(JSON.stringify({ cwd: f.cwd, session_id: SESSION }), {
      env: f.env, readReceipts: async () => []
    });

    await prompt("2026-09-04T10:00:00.000Z", "human-1");
    expect(await status()).toBe("compaction · working");
    const inline = await stop(f, "2026-09-04T10:01:00.000Z", "plain-1", undefined, []);

    const settled = (await readActivityEvents(join(f.cwd, ".compaction", "activity"))).events
      .filter((event) => event.activity_kind === "claude-stop");
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ measurement_source: "claude-transcript", input_before: 1_900, output_after: 180 });
    expect(settled[0].input_after).toBeUndefined();
    expect(settled[0].estimated_output_tokens_saved).toBeUndefined();
    const line = await status();
    expect(line).toMatch(/^compaction · /);
    expect(line).toContain("input 1,900");
    expect(line).toContain("output 180");
    expect(inline).toContain(line);

    // Later activity: the next prompt is in flight, then settles with no usable result of its own.
    await prompt("2026-09-04T10:02:00.000Z", "human-2");
    expect(await status()).toBe(line);
    await stop(f, "2026-09-04T10:03:00.000Z", "plain-2", undefined, [],
      createUsageMetadata({ providerReportedTokens: false, estimatedTokens: false }));
    expect(await status()).toBe(line);
  });


  it("a later exactly reconciled continuation supersedes its transcript-settled parent (one logical run)", async () => {
    const f = await fixture();
    const prompt = (at: string, id: string) => captureClaudeCodeShapeFromPromptHook({
      env: f.env, now: () => at, readStdin: async () => promptPayload(f.transcript, id), write: () => undefined
    });
    await prompt("2026-09-04T10:00:00.000Z", "human-parent");
    await stop(f, "2026-09-04T10:01:00.000Z", "parent", undefined, []);
    const parent = (await readActivityEvents(join(f.cwd, ".compaction", "activity"))).events;
    expect(parent.filter((event) => event.measurement_source === "claude-transcript")).toHaveLength(1);

    await prompt("2026-09-04T10:01:01.000Z", "task-continuation");
    await appendPromptRow(f.transcript, "task-continuation", { kind: "task-notification" });
    const receipts = [
      receipt("r1", "2026-09-04T10:00:10.000Z", "2026-09-04T10:00:20.000Z", 1_000, 800, 90, f.correlation),
      receipt("r2", "2026-09-04T10:01:10.000Z", "2026-09-04T10:01:20.000Z", 1_200, 900, 100, f.correlation)
    ];
    await stop(f, "2026-09-04T10:02:00.000Z", "continuation", undefined, receipts);

    const logical = (await readActivityEvents(join(f.cwd, ".compaction", "activity"))).events
      .filter((event) => event.activity_kind === "claude-stop");
    expect(logical).toHaveLength(1);
    expect(logical[0]).toMatchObject({ measurement_source: "gateway-run", run_started_at: "2026-09-04T10:00:00.000Z" });
  });

  it("claims no shaping over cumulative output that cannot be isolated to this run", async () => {
    const f = await fixture();
    const prompt = (at: string, id: string) => captureClaudeCodeShapeFromPromptHook({
      env: f.env, now: () => at, readStdin: async () => promptPayload(f.transcript, id), write: () => undefined
    });
    await prompt("2026-09-04T10:00:00.000Z", "human-1");
    await stop(f, "2026-09-04T10:01:00.000Z", "first", undefined, []);
    await prompt("2026-09-04T10:02:00.000Z", "human-2");
    await recordShapingOutcome({ tool: "claude-code", sessionId: SESSION }, "shape", f.env,
      () => new Date("2026-09-04T10:02:01.000Z"));
    // The agent changed directory: run 1's hook record is not in this directory, so no baseline.
    const elsewhere = await mkdtemp(join(tmpdir(), "claude-settle-elsewhere-"));
    dirs.push(elsewhere);
    await captureClaudeCodeFromHook({}, {
      cwd: elsewhere, env: f.env, now: () => "2026-09-04T10:03:00.000Z",
      readStdin: async () => JSON.stringify({ hook_event_name: "Stop", session_id: SESSION, transcript_path: f.transcript }),
      normalize: async () => ({ usage: createUsageMetadata({ inputTokens: 4_000, outputTokens: 1_100, totalTokens: 5_100,
        providerReportedTokens: true, estimatedTokens: false, provider: "anthropic", model: "claude-opus-5" }),
        messageCount: 20, fingerprint: "second" }),
      readLatestGatewayReceipt: async () => undefined,
      readGatewayReceipts: async () => ({ receipts: [], truncated: false }),
      printReceiptLine: () => undefined,
      hostedConfigured: () => false
    });
    const event = (await readActivityEvents(join(elsewhere, ".compaction", "activity"))).events
      .find((candidate) => candidate.activity_kind === "claude-stop")!;
    expect(event).toMatchObject({ measurement_source: "claude-transcript", claim_scope: "workflow-scoped", output_after: 1_100 });
    expect(event.estimated_output_tokens_saved).toBeUndefined();
    expect(event.output_shaping_state).toBeUndefined();
    expect(event.apply_posture).toBeUndefined();
  });
});
