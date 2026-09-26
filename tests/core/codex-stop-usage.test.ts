import { afterEach, describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  beginCodexTurn,
  codexStopLineFromActivityEvent,
  readCodexTurnUsage,
  settleCodexStop,
  type CodexTurnUsage
} from "../../src/core/codex-stop-usage.js";
import {
  SHAPING_TURN_STATE_DIR,
  recordShapingOutcome,
  shapingTurnScopeKey
} from "../../src/core/output-shaping-turn-state.js";
import {
  codexSessionCorrelationFromRawHeaders,
  codexSessionCorrelationId,
  codexTurnCorrelationId,
  resetSessionCorrelationCache
} from "../../src/core/gateway/session-correlation.js";
import type { GatewayReceipt, GatewayReceiptTailWindow } from "../../src/core/gateway/receipt.js";
import { activityTurnLinesFromJsonl, codexStopRunWindowsFromJsonl } from "../../src/core/activity-receipt-line.js";
import { receiptTurnLinesFromJsonl } from "../../src/cli/commands/watch.js";
import { buildActivityRows } from "../../src/core/activity-view.js";
import {
  buildHookOutputShapingTreatment,
  buildOutputShapingPolicy
} from "../../src/core/output-shaping.js";
import {
  TEST_OUTPUT_POLICY_VERSION,
  seedOutputCalibration
} from "../helpers/output-calibration-fixture.js";
import {
  calibrationStorePath,
  loadCalibration
} from "../../src/core/output-shaping-calibration-store.js";
import {
  CODEX_SETTLEMENT_PENDING_SCHEMA,
  codexSettlementPending,
  endUserRun
} from "../../src/core/gateway/run-boundary.js";

const roots: string[] = [];
afterEach(() => {
  resetSessionCorrelationCache();
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

function fixture(): { root: string; cwd: string; env: NodeJS.ProcessEnv; rollout: string } {
  const root = mkdtempSync(join(tmpdir(), "codex-stop-"));
  roots.push(root);
  const cwd = join(root, "repo");
  mkdirSync(cwd, { recursive: true });
  return {
    root,
    cwd,
    env: { COMPACTION_CONFIG_DIR: join(root, "config") } as NodeJS.ProcessEnv,
    rollout: join(root, "rollout.jsonl")
  };
}

const SESSION = "11111111-1111-4111-8111-111111111111";
const TURN = "22222222-2222-4222-8222-222222222222";

function usage(input: number, output: number): CodexTurnUsage {
  return {
    input_tokens: input,
    cached_input_tokens: Math.floor(input / 2),
    cache_write_input_tokens: 0,
    output_tokens: output,
    reasoning_output_tokens: Math.floor(output / 2),
    total_tokens: input + output
  };
}

function usageRecord(ordinal: number, session: string, turn: string, turnUsage: CodexTurnUsage): string {
  return JSON.stringify({
    ordinal,
    timestamp: "2026-09-04T07:39:18.350Z",
    type: "token_usage_record",
    payload: {
      thread_id: session,
      turn_id: turn,
      session_id: session,
      root_turn_id: turn,
      response_id: `response-${ordinal}`,
      usage: usage(9_999_999, 9_999_999),
      turn_token_usage: turnUsage,
      thread_token_usage: usage(8_888_888, 8_888_888)
    }
  });
}

function hookPayload(cwd: string, rollout: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: SESSION,
    turn_id: TURN,
    transcript_path: rollout,
    cwd,
    hook_event_name: "Stop",
    model: "gpt-5.6-sol",
    last_assistant_message: "SECRET assistant bytes",
    ...overrides
  });
}

function receipt(overrides: Partial<GatewayReceipt>): GatewayReceipt {
  return {
    receipt_id: "receipt-a",
    captured_at: "2026-09-04T07:39:18.400Z",
    request_started_at: "2026-09-04T07:39:17.000Z",
    provider: "openai",
    model: "gpt-5.6-sol",
    endpoint: "/v1/responses",
    mode: "record",
    upstream_status: 200,
    model_visible_bytes_changed: false,
    tokens: { prompt_input: 100, cached_input: 0, billed_fresh_input: 100, output: 20 },
    fresh_billed_input_reduction: { available: false, note: "not measured" },
    token_source: "provider-reported",
    cache_source: "provider-reported",
    cost_source: "unavailable",
    reasons: { cost: "not reported" },
    claim_scope: "run-scoped",
    approval_status: "not-required",
    sync_status: "local-only",
    content_uploaded: false,
    label: "content-free",
    ...overrides
  } as GatewayReceipt;
}

describe("Codex rollout turn usage", () => {
  it("selects the final cumulative exact session+turn record and never substitutes usage/thread totals", async () => {
    const f = fixture();
    writeFileSync(f.rollout, [
      JSON.stringify({ ordinal: 1, type: "event_msg", payload: { message: "SECRET" } }),
      usageRecord(2, SESSION, TURN, usage(100, 10)),
      usageRecord(3, "other-session", TURN, usage(70_000, 70_000)),
      usageRecord(4, SESSION, TURN, usage(350, 41)),
      ""
    ].join("\n"));
    expect(await readCodexTurnUsage(f.rollout, SESSION, TURN)).toEqual(usage(350, 41));
    expect(await readCodexTurnUsage(f.rollout, SESSION, "wrong-turn")).toBeUndefined();
  });

  it("fails closed on malformed, partial, decreasing, and ambiguous terminal records", async () => {
    for (const lines of [
      [usageRecord(1, SESSION, TURN, usage(10, 1)), "{bad", ""],
      [usageRecord(1, SESSION, TURN, usage(10, 1))],
      [usageRecord(2, SESSION, TURN, usage(10, 2)), usageRecord(3, SESSION, TURN, usage(9, 2)), ""],
      [usageRecord(3, SESSION, TURN, usage(10, 2)), usageRecord(3, SESSION, TURN, usage(11, 2)), ""]
    ]) {
      const f = fixture();
      writeFileSync(f.rollout, lines.join("\n"));
      expect(await readCodexTurnUsage(f.rollout, SESSION, TURN)).toBeUndefined();
    }
  });

  it("is bounded and refuses symlinks, FIFOs, directories, missing paths, and null paths", async () => {
    const f = fixture();
    writeFileSync(f.rollout, `${usageRecord(1, SESSION, TURN, usage(10, 1))}\n${"x".repeat(512)}\n`);
    expect(await readCodexTurnUsage(f.rollout, SESSION, TURN, 128)).toBeUndefined();
    const link = join(f.root, "link.jsonl");
    symlinkSync(f.rollout, link);
    expect(await readCodexTurnUsage(link, SESSION, TURN)).toBeUndefined();
    expect(await readCodexTurnUsage(f.root, SESSION, TURN)).toBeUndefined();
    expect(await readCodexTurnUsage(undefined, SESSION, TURN)).toBeUndefined();
    const fifo = join(f.root, "rollout.fifo");
    execFileSync("mkfifo", [fifo]);
    expect(await readCodexTurnUsage(fifo, SESSION, TURN)).toBeUndefined();
  });
});

describe("Codex exact lifecycle settlement", () => {
  it("settles from cumulative rollout usage, persists content-free, renders identically in Stop/watch, and is idempotent", async () => {
    const f = fixture();
    const raw = hookPayload(f.cwd, f.rollout);
    writeFileSync(f.rollout, `${usageRecord(1, SESSION, TURN, usage(100, 10))}\n${usageRecord(2, SESSION, TURN, usage(427, 41))}\n`);
    const scope = beginCodexTurn(raw, f.env, () => new Date("2026-09-04T07:39:00.000Z"));
    expect(scope).toEqual({ tool: "codex", sessionId: SESSION, turnId: TURN });
    await recordShapingOutcome(scope, "shape", f.env, () => new Date("2026-09-04T07:39:01.000Z"));
    const shapingDirectory = join(f.env.COMPACTION_CONFIG_DIR!, SHAPING_TURN_STATE_DIR);
    expect(readdirSync(shapingDirectory)).toHaveLength(1);
    const deps = {
      env: f.env,
      now: () => new Date("2026-09-04T07:39:18.456Z"),
      readReceipts: async (): Promise<GatewayReceiptTailWindow> => ({ receipts: [], truncated: false })
    };
    const first = await settleCodexStop(raw, deps);
    expect(first?.line).toBe("compaction · observed input 427 · output N/A→41 (N/A%, est.) · basic shaping");
    expect(first?.line).not.toMatch(/recording|reporting|47%/);
    const activityPath = join(f.cwd, ".compaction", "activity", "activity.jsonl");
    const stored = readFileSync(activityPath, "utf8");
    expect(stored).not.toContain("SECRET");
    expect(stored).not.toContain(f.rollout);
    expect(stored).not.toContain(SESSION);
    expect(stored).not.toContain(TURN);
    expect(activityTurnLinesFromJsonl(stored).map((entry) => entry.line)).toEqual([first?.line]);
    expect(readdirSync(shapingDirectory)).toEqual([]);
    // If the original best-effort unlink had failed, replay from the durable event retries it.
    await recordShapingOutcome(scope, "shape", f.env, () => new Date("2026-09-04T07:39:19.000Z"));
    expect(readdirSync(shapingDirectory)).toHaveLength(1);
    const second = await settleCodexStop(raw, deps);
    expect(second?.line).toBe(first?.line);
    expect(readFileSync(activityPath, "utf8").trim().split("\n")).toHaveLength(1);
    expect(readdirSync(shapingDirectory)).toEqual([]);
  });

  it("keeps repeated turns unseeded until an exact current-policy confirmation is installed", async () => {
    const f = fixture();
    const settle = async (turnId: string, sequence: number, at: string) => {
      const raw = hookPayload(f.cwd, f.rollout, { turn_id: turnId });
      writeFileSync(f.rollout, `${usageRecord(sequence, SESSION, turnId, usage(427, 72))}\n`);
      const scope = beginCodexTurn(raw, f.env, () => new Date(at));
      expect(scope).toBeDefined();
      await recordShapingOutcome(scope!, "shape", f.env, () => new Date(Date.parse(at) + 1_000));
      return settleCodexStop(raw, {
        env: f.env,
        now: () => new Date(Date.parse(at) + 18_000),
        readReceipts: async () => ({ receipts: [], truncated: false })
      });
    };

    expect(existsSync(calibrationStorePath(f.env))).toBe(false);
    const first = await settle("turn-cold", 1, "2026-09-05T09:00:00.000Z");
    expect(first?.line).toBe("compaction · observed input 427 · output N/A→72 (N/A%, est.) · basic shaping");
    expect(first?.event.output_estimate_state).toBe("unseeded");
    expect(first?.event.policy_used).toBe(buildHookOutputShapingTreatment().policyVersion);
    expect(first?.event.policy_used).not.toBe(buildOutputShapingPolicy().policyVersion);
    expect(first?.event.estimated_output_tokens_saved).toBeUndefined();
    const calibration = await loadCalibration(f.env);
    expect(calibration.records).toEqual([]);
    expect(JSON.stringify(calibration)).not.toMatch(/prompt|response|transcript|credential|SECRET/i);

    const second = await settle("turn-still-cold", 2, "2026-09-05T09:01:00.000Z");
    expect(second?.line).toBe("compaction · observed input 427 · output N/A→72 (N/A%, est.) · basic shaping");
    expect(second?.event).toMatchObject({
      output_after: 72,
      output_estimate_state: "unseeded"
    });
    expect(second?.event.output_estimate_basis).toBeUndefined();
    expect(second?.event.estimated_output_tokens_saved).toBeUndefined();

    await seedOutputCalibration(f.env, {
      policyVersion: buildHookOutputShapingTreatment().policyVersion,
      provider: "openai",
      model: "gpt-5.6-sol",
      regime: "default-shapeable",
      control: [120, 120, 120],
      treatment: [72, 72, 72]
    });
    const calibrated = await settle("turn-calibrated", 3, "2026-09-05T09:02:00.000Z");
    expect(calibrated?.line).toBe("compaction · observed input 427 · output 120→72 (−40%, est.) · basic shaping");
    expect(calibrated?.event).toMatchObject({
      output_after: 72,
      output_estimate_state: "calibrated",
      output_estimate_basis: "measured",
      estimated_output_tokens_saved: 48
    });
  });

  it("freezes one retry event before append and never recomputes it after sources change", async () => {
    const f = fixture();
    const raw = hookPayload(f.cwd, f.rollout);
    writeFileSync(f.rollout, `${usageRecord(1, SESSION, TURN, usage(427, 41))}\n`);
    const scope = beginCodexTurn(raw, f.env, () => new Date("2026-09-04T07:39:00.000Z"))!;
    await recordShapingOutcome(scope, "shape", f.env, () => new Date("2026-09-04T07:39:01.000Z"));
    const sessionCorrelation = codexSessionCorrelationId(SESSION, f.env)!;
    const turnCorrelation = codexTurnCorrelationId(SESSION, TURN, f.env)!;
    let appendAttempts = 0;
    const failed = await settleCodexStop(raw, {
      env: f.env,
      now: () => new Date("2026-09-04T07:39:18.456Z"),
      readReceipts: async () => ({ receipts: [], truncated: false }),
      readEvents: async () => { throw new Error("injected activity read failure"); },
      appendEvent: async () => {
        appendAttempts += 1;
        throw new Error("must not append while durable activity state is unreadable");
      }
    });
    expect(failed).toBeUndefined();
    expect(appendAttempts).toBe(0);
    expect(existsSync(join(f.cwd, ".compaction", "activity", "activity.jsonl"))).toBe(false);
    const pending = codexSettlementPending(sessionCorrelation, turnCorrelation, f.env);
    expect(pending?.schema).toBe(CODEX_SETTLEMENT_PENDING_SCHEMA);
    expect(pending?.event.output_after).toBe(41);
    const runStore = readFileSync(
      join(f.env.COMPACTION_CONFIG_DIR!, "runs", `${sessionCorrelation}.json`),
      "utf8"
    );
    expect(runStore).not.toContain(SESSION);
    expect(runStore).not.toContain(TURN);
    expect(runStore).not.toContain(f.cwd);
    expect(runStore).not.toContain(f.rollout);
    expect(runStore).not.toContain("SECRET");
    expect(readdirSync(join(f.env.COMPACTION_CONFIG_DIR!, SHAPING_TURN_STATE_DIR))).toEqual([]);

    rmSync(f.rollout, { force: true });
    const recovered = await settleCodexStop(raw, {
      env: f.env,
      now: () => new Date("2026-09-04T08:00:00.000Z"),
      readReceipts: async () => { throw new Error("changed receipts must not be read"); },
      readTurnUsage: async () => { throw new Error("removed rollout must not be read"); },
      calibrationResolver: () => { throw new Error("changed calibration must not be read"); }
    });
    expect(recovered?.event).toEqual(pending?.event);
    expect(recovered?.line).toBe("compaction · observed input 427 · output N/A→41 (N/A%, est.) · basic shaping");
    expect(codexSettlementPending(sessionCorrelation, turnCorrelation, f.env)).toBeUndefined();
    const activityPath = join(f.cwd, ".compaction", "activity", "activity.jsonl");
    expect(readFileSync(activityPath, "utf8").trim().split("\n")).toHaveLength(1);

    const third = await settleCodexStop(raw, {
      env: f.env,
      readReceipts: async () => { throw new Error("durable replay must not read receipts"); }
    });
    expect(third?.event).toEqual(pending?.event);
    expect(readFileSync(activityPath, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("retains the frozen pending event when post-close activity append fails", async () => {
    const f = fixture();
    const raw = hookPayload(f.cwd, f.rollout);
    writeFileSync(f.rollout, `${usageRecord(1, SESSION, TURN, usage(80, 8))}\n`);
    const scope = beginCodexTurn(raw, f.env, () => new Date("2026-09-04T07:39:00.000Z"));
    await recordShapingOutcome(scope!, "shape", f.env, () => new Date("2026-09-04T07:39:01.000Z"));
    const sessionCorrelation = codexSessionCorrelationId(SESSION, f.env)!;
    const turnCorrelation = codexTurnCorrelationId(SESSION, TURN, f.env)!;
    expect(await settleCodexStop(raw, {
      env: f.env,
      now: () => new Date("2026-09-04T07:39:18.456Z"),
      readReceipts: async () => ({ receipts: [], truncated: false }),
      appendEvent: async () => { throw new Error("injected append failure"); }
    })).toBeUndefined();
    expect(codexSettlementPending(sessionCorrelation, turnCorrelation, f.env)?.event.output_after).toBe(8);
    expect(existsSync(join(f.cwd, ".compaction", "activity", "activity.jsonl"))).toBe(false);
    expect(existsSync(calibrationStorePath(f.env))).toBe(false);
    expect(readdirSync(join(f.env.COMPACTION_CONFIG_DIR!, SHAPING_TURN_STATE_DIR))).toEqual([]);
  });

  it("a failed pending clear after durable append is retried by event-first replay", async () => {
    const f = fixture();
    const raw = hookPayload(f.cwd, f.rollout);
    writeFileSync(f.rollout, `${usageRecord(1, SESSION, TURN, usage(50, 5))}\n`);
    beginCodexTurn(raw, f.env, () => new Date("2026-09-04T07:39:00.000Z"));
    const sessionCorrelation = codexSessionCorrelationId(SESSION, f.env)!;
    const turnCorrelation = codexTurnCorrelationId(SESSION, TURN, f.env)!;
    const first = await settleCodexStop(raw, {
      env: f.env,
      now: () => new Date("2026-09-04T07:39:18.456Z"),
      readReceipts: async () => ({ receipts: [], truncated: false }),
      clearPending: () => false
    });
    expect(first).toBeDefined();
    expect(codexSettlementPending(sessionCorrelation, turnCorrelation, f.env)).toBeDefined();
    const replay = await settleCodexStop(raw, { env: f.env });
    expect(replay?.event).toEqual(first?.event);
    expect(codexSettlementPending(sessionCorrelation, turnCorrelation, f.env)).toBeUndefined();
    expect(readFileSync(join(f.cwd, ".compaction", "activity", "activity.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("does not let another turn or concurrent session shaping state take over", async () => {
    const f = fixture();
    const raw = hookPayload(f.cwd, f.rollout);
    writeFileSync(f.rollout, `${usageRecord(1, SESSION, TURN, usage(50, 5))}\n`);
    beginCodexTurn(raw, f.env, () => new Date("2026-09-04T07:39:00.000Z"));
    const foreignScope = {
      tool: "codex",
      sessionId: "33333333-3333-4333-8333-333333333333",
      turnId: TURN
    } as const;
    await recordShapingOutcome(
      foreignScope,
      "shape",
      f.env,
      () => new Date("2026-09-04T07:39:01.000Z")
    );
    const settled = await settleCodexStop(raw, {
      env: f.env,
      now: () => new Date("2026-09-04T07:39:18.456Z"),
      readReceipts: async () => ({ receipts: [], truncated: false })
    });
    expect(settled?.line).toBe("compaction · input 50 · output 5");
    expect(readdirSync(join(f.env.COMPACTION_CONFIG_DIR!, SHAPING_TURN_STATE_DIR))).toEqual([
      `${shapingTurnScopeKey(foreignScope, f.env)}.json`
    ]);
  });

  it("settles three sequential Codex turns without retaining per-turn shaping files", async () => {
    const f = fixture();
    const shapingDirectory = join(f.env.COMPACTION_CONFIG_DIR!, SHAPING_TURN_STATE_DIR);
    for (let index = 1; index <= 3; index += 1) {
      const turnId = `turn-${index}`;
      const raw = hookPayload(f.cwd, f.rollout, { turn_id: turnId });
      writeFileSync(f.rollout, `${usageRecord(index, SESSION, turnId, usage(index * 100, index * 10))}\n`);
      const scope = beginCodexTurn(raw, f.env, () => new Date(`2026-09-04T07:3${index}:00.000Z`));
      expect(scope).toBeDefined();
      await recordShapingOutcome(scope, "shape", f.env, () => new Date(`2026-09-04T07:3${index}:01.000Z`));
      expect(await settleCodexStop(raw, {
        env: f.env,
        now: () => new Date(`2026-09-04T07:3${index}:18.456Z`),
        readReceipts: async () => ({ receipts: [], truncated: false })
      })).toBeDefined();
      expect(readdirSync(shapingDirectory)).toEqual([]);
    }
  });

  it("prefers a complete exact gateway aggregate, sums micro-calls, and suppresses those duplicate watch lines", async () => {
    const f = fixture();
    const raw = hookPayload(f.cwd, f.rollout);
    writeFileSync(f.rollout, `${usageRecord(1, SESSION, TURN, usage(999, 99))}\n`);
    const started = "2026-09-04T07:39:00.000Z";
    beginCodexTurn(raw, f.env, () => new Date(started));
    const sessionCorrelation = codexSessionCorrelationId(SESSION, f.env)!;
    const receipts = [
      receipt({ receipt_id: "micro-a", session_correlation_id: sessionCorrelation, request_started_at: "2026-09-04T07:39:02.000Z", tokens: { prompt_input: 100, output: 10 } }),
      receipt({ receipt_id: "micro-b", session_correlation_id: sessionCorrelation, request_started_at: "2026-09-04T07:39:10.000Z", tokens: { prompt_input: 200, output: 20 } }),
      receipt({ receipt_id: "stale", session_correlation_id: sessionCorrelation, request_started_at: "2026-09-04T07:38:59.999Z", tokens: { prompt_input: 40_000, output: 8_000 } }),
      receipt({ receipt_id: "future", session_correlation_id: sessionCorrelation, request_started_at: "2026-09-04T07:39:18.457Z", tokens: { prompt_input: 30_000, output: 7_000 } }),
      receipt({ receipt_id: "foreign", session_correlation_id: "0".repeat(32), request_started_at: "2026-09-04T07:39:11.000Z", tokens: { prompt_input: 50_000, output: 9_000 } })
    ];
    const settled = await settleCodexStop(raw, {
      env: f.env,
      now: () => new Date("2026-09-04T07:39:18.456Z"),
      readReceipts: async () => ({ receipts, truncated: false })
    });
    expect(settled?.event.measurement_source).toBe("gateway-run");
    expect(settled?.line).toBe("compaction · input 300 · output 30");
    const activityRaw = `${JSON.stringify(settled?.event)}\n`;
    const windows = codexStopRunWindowsFromJsonl(activityRaw);
    const gatewayRaw = receipts.map((entry) => JSON.stringify(entry)).join("\n");
    expect(receiptTurnLinesFromJsonl(gatewayRaw, undefined, windows).map((entry) => entry.line)).toHaveLength(3);
    expect(receiptTurnLinesFromJsonl(gatewayRaw, undefined, windows).map((entry) => entry.line).join("\n")).toContain("50,000");
    expect(codexStopLineFromActivityEvent(settled!.event)).toBe(settled?.line);
  });

  it("keeps aggregateRun's per-call output reconstruction instead of applying one rate to unshaped calls", async () => {
    const f = fixture();
    const raw = hookPayload(f.cwd, f.rollout);
    writeFileSync(f.rollout, `${usageRecord(1, SESSION, TURN, usage(999, 99))}\n`);
    beginCodexTurn(raw, f.env, () => new Date("2026-09-04T07:39:00.000Z"));
    const correlation = codexSessionCorrelationId(SESSION, f.env)!;
    const receipts = [
      receipt({
        receipt_id: "shaped-call",
        session_correlation_id: correlation,
        request_started_at: "2026-09-04T07:39:02.000Z",
        output_shaping_state: "attached-this-pass",
        output_shaping_policy_version: TEST_OUTPUT_POLICY_VERSION,
        output_shaping_regime: "default-shapeable",
        tokens: { prompt_input: 100, output: 20 }
      }),
      receipt({
        receipt_id: "unshaped-call",
        session_correlation_id: correlation,
        request_started_at: "2026-09-04T07:39:10.000Z",
        tokens: { prompt_input: 200, output: 30 }
      })
    ];
    const settled = await settleCodexStop(raw, {
      env: f.env,
      now: () => new Date("2026-09-04T07:39:18.456Z"),
      readReceipts: async () => ({ receipts, truncated: false }),
      calibrationResolver: () => ({
        availability: "measured",
        reductionPct: 50,
        basis: "measured",
        state: "calibrated"
      } as never)
    });
    // Shaped call: 20 after at 50% => 20 saved. Unshaped call: 30 after => zero saved.
    // The run is therefore 70→50, not 100→50 from applying the shaped cohort to every call.
    expect(settled?.event.estimated_output_tokens_saved).toBe(20);
    expect(settled?.line).toContain("output 70→50 (−29%, est.)");
  });

  it("never labels a public explicit deterministic input reduction as full apply", async () => {
    const f = fixture();
    const raw = hookPayload(f.cwd, f.rollout);
    writeFileSync(f.rollout, `${usageRecord(1, SESSION, TURN, usage(100, 10))}\n`);
    beginCodexTurn(raw, f.env, () => new Date("2026-09-04T07:39:00.000Z"));
    const correlation = codexSessionCorrelationId(SESSION, f.env)!;
    const explicit = receipt({
      session_correlation_id: correlation,
      mode: "apply",
      request_mutated: true,
      approval_status: "explicit-mode",
      estimated_input_tokens_before: 200,
      estimated_input_tokens_after: 100,
      applied_components: ["deterministic-compaction"],
      tokens: { prompt_input: 100, output: 10 }
    });
    const settled = await settleCodexStop(raw, {
      env: f.env,
      now: () => new Date("2026-09-04T07:39:18.456Z"),
      readReceipts: async () => ({ receipts: [explicit], truncated: false })
    });
    expect(settled?.line).toContain("input 200→100 (−50%)");
    expect(settled?.line).not.toContain("full apply");
  });

  it("fails closed on malformed component provenance in the real Codex Stop settlement", async () => {
    const f = fixture();
    const raw = hookPayload(f.cwd, f.rollout);
    writeFileSync(f.rollout, `${usageRecord(1, SESSION, TURN, usage(100, 10))}\n`);
    beginCodexTurn(raw, f.env, () => new Date("2026-09-04T07:39:00.000Z"));
    const correlation = codexSessionCorrelationId(SESSION, f.env)!;
    const malformed = receipt({
      session_correlation_id: correlation,
      mode: "apply",
      request_mutated: true,
      estimated_input_tokens_before: 200,
      estimated_input_tokens_after: 100,
      applied_components: { 0: "lcm-compaction" } as unknown as GatewayReceipt["applied_components"],
      tokens: { prompt_input: 100, output: 10 }
    });
    const settled = await settleCodexStop(raw, {
      env: f.env,
      now: () => new Date("2026-09-04T07:39:18.456Z"),
      readReceipts: async () => ({ receipts: [malformed], truncated: false })
    });
    expect(settled?.line).toContain("input 100");
    expect(settled?.line).not.toContain("→");
    expect(settled?.line).not.toContain("full apply");
  });

  it("labels full only from exact stored-policy gateway provenance and retains the input source", async () => {
    const f = fixture();
    const raw = hookPayload(f.cwd, f.rollout);
    writeFileSync(f.rollout, `${usageRecord(1, SESSION, TURN, usage(100, 10))}\n`);
    beginCodexTurn(raw, f.env, () => new Date("2026-09-04T07:39:00.000Z"));
    const correlation = codexSessionCorrelationId(SESSION, f.env)!;
    const stored = receipt({
      session_correlation_id: correlation,
      mode: "apply",
      request_mutated: true,
      approval_status: "auto-applied-by-policy",
      authorization_id: "pref-1234567890abcdef12345678",
      estimated_input_tokens_before: 200,
      estimated_input_tokens_after: 100,
      applied_components: ["lcm-compaction"],
      tokens: { prompt_input: 100, output: 10 }
    });
    const settled = await settleCodexStop(raw, {
      env: f.env,
      now: () => new Date("2026-09-04T07:39:18.456Z"),
      readReceipts: async () => ({ receipts: [stored], truncated: false })
    });
    expect(settled?.event.apply_posture).toBe("full");
    expect(settled?.event.token_source?.input.source).toBe("local-estimate");
    expect(settled?.line).toBe("compaction · input 200→100 (−50%) · output 10 · +~0.28m · full apply");
  });

  it("keeps exact Full input authoritative when subscription receipts omit output usage", async () => {
    const f = fixture();
    const raw = hookPayload(f.cwd, f.rollout);
    writeFileSync(f.rollout, "");
    beginCodexTurn(raw, f.env, () => new Date("2026-09-04T07:39:00.000Z"));
    const correlation = codexSessionCorrelationId(SESSION, f.env)!;
    const stored = receipt({
      session_correlation_id: correlation,
      mode: "apply",
      request_mutated: true,
      approval_status: "auto-applied-by-policy",
      authorization_id: "pref-1234567890abcdef12345678",
      estimated_input_tokens_before: 200,
      estimated_input_tokens_after: 100,
      applied_components: ["lcm-compaction"],
      tokens: { prompt_input: 100 }
    });
    const settled = await settleCodexStop(raw, {
      env: f.env,
      now: () => new Date("2026-09-04T07:39:18.456Z"),
      readReceipts: async () => ({ receipts: [stored], truncated: false }),
      readTurnUsage: async () => undefined
    });
    expect(settled?.event.measurement_source).toBe("gateway-run");
    expect(settled?.event.apply_posture).toBe("full");
    expect(settled?.event.input_before).toBe(200);
    expect(settled?.event.input_after).toBe(100);
    expect(settled?.event.output_after).toBeUndefined();
    expect(settled?.event.token_source?.output).toEqual({
      source: "unavailable",
      unavailable_reason: "no exact Gateway or attributable Codex rollout output usage"
    });
    expect(buildActivityRows([settled!.event])[0]).toMatchObject({
      output_tokens: null,
      output_source: "unavailable",
      output_unavailable_reason: "no exact Gateway or attributable Codex rollout output usage"
    });
    expect(settled?.line).toBe("compaction · input 200→100 (−50%) · full apply");
  });

  it("labels rollout output separately when exact Full input receipts omit output usage", async () => {
    const f = fixture();
    const raw = hookPayload(f.cwd, f.rollout);
    writeFileSync(f.rollout, "");
    beginCodexTurn(raw, f.env, () => new Date("2026-09-04T07:39:00.000Z"));
    const correlation = codexSessionCorrelationId(SESSION, f.env)!;
    const stored = receipt({
      session_correlation_id: correlation,
      mode: "apply",
      request_mutated: true,
      approval_status: "auto-applied-by-policy",
      authorization_id: "pref-1234567890abcdef12345678",
      estimated_input_tokens_before: 200,
      estimated_input_tokens_after: 100,
      applied_components: ["lcm-compaction"],
      tokens: { prompt_input: 100 }
    });
    const settled = await settleCodexStop(raw, {
      env: f.env,
      now: () => new Date("2026-09-04T07:39:18.456Z"),
      readReceipts: async () => ({ receipts: [stored], truncated: false }),
      readTurnUsage: async () => usage(999, 40)
    });
    expect(settled?.event.measurement_source).toBe("gateway-run");
    expect(settled?.event.evidence_level).toBe(
      "exact correlated gateway input; provider-reported cumulative Codex turn output"
    );
    expect(settled?.event.token_source?.input.source).toBe("local-estimate");
    expect(settled?.event.token_source?.output.source).toBe("provider-reported");
    expect(settled?.event.output_after).toBe(40);
    expect(settled?.event.apply_posture).toBe("full");
  });

  it("uses rollout for both axes when exact receipts have output but no authoritative input", async () => {
    const f = fixture();
    const raw = hookPayload(f.cwd, f.rollout);
    writeFileSync(f.rollout, "");
    beginCodexTurn(raw, f.env, () => new Date("2026-09-04T07:39:00.000Z"));
    const correlation = codexSessionCorrelationId(SESSION, f.env)!;
    const settled = await settleCodexStop(raw, {
      env: f.env,
      now: () => new Date("2026-09-04T07:39:18.456Z"),
      readReceipts: async () => ({
        receipts: [receipt({ session_correlation_id: correlation, tokens: { output: 10 } })],
        truncated: false
      }),
      readTurnUsage: async () => usage(999, 40)
    });
    expect(settled?.event.measurement_source).toBe("codex-rollout");
    expect(settled?.event.evidence_level).toBe("provider-reported cumulative Codex turn usage");
    expect(settled?.event.input_before).toBe(999);
    expect(settled?.event.output_after).toBe(40);
  });

  it("does not let an unrelated old request make a truncated exact-run gateway tail look complete", async () => {
    const f = fixture();
    const raw = hookPayload(f.cwd, f.rollout);
    writeFileSync(f.rollout, `${usageRecord(1, SESSION, TURN, usage(1_000, 100))}\n`);
    beginCodexTurn(raw, f.env, () => new Date("2026-09-04T07:39:00.000Z"));
    const correlation = codexSessionCorrelationId(SESSION, f.env)!;
    const settled = await settleCodexStop(raw, {
      env: f.env,
      now: () => new Date("2026-09-04T07:39:18.456Z"),
      readReceipts: async () => ({
        receipts: [
          receipt({
            receipt_id: "unrelated-long-request",
            session_correlation_id: "0".repeat(32),
            request_started_at: "2026-09-04T06:00:00.000Z",
            captured_at: "2026-09-04T07:39:12.000Z",
            tokens: { prompt_input: 9_000, output: 900 }
          }),
          receipt({
            receipt_id: "truncated-exact-tail",
            session_correlation_id: correlation,
            request_started_at: "2026-09-04T07:39:10.000Z",
            captured_at: "2026-09-04T07:39:13.000Z",
            tokens: { prompt_input: 10, output: 1 }
          })
        ],
        truncated: true
      })
    });
    expect(settled?.event.measurement_source).toBe("codex-rollout");
    expect(settled?.line).toBe("compaction · input 1,000 · output 100");
  });

  it("accepts a truncated tail that contains append-order coverage before the run", async () => {
    const f = fixture();
    const raw = hookPayload(f.cwd, f.rollout);
    writeFileSync(f.rollout, `${usageRecord(1, SESSION, TURN, usage(1_000, 100))}\n`);
    beginCodexTurn(raw, f.env, () => new Date("2026-09-04T07:39:00.000Z"));
    const correlation = codexSessionCorrelationId(SESSION, f.env)!;
    const settled = await settleCodexStop(raw, {
      env: f.env,
      now: () => new Date("2026-09-04T07:39:18.456Z"),
      readReceipts: async () => ({
        receipts: [
          receipt({
            receipt_id: "pre-run-coverage",
            session_correlation_id: "0".repeat(32),
            request_started_at: "2026-09-04T07:38:58.000Z",
            captured_at: "2026-09-04T07:38:59.000Z"
          }),
          receipt({
            receipt_id: "exact-full",
            session_correlation_id: correlation,
            request_started_at: "2026-09-04T07:39:10.000Z",
            captured_at: "2026-09-04T07:39:13.000Z",
            mode: "apply",
            request_mutated: true,
            estimated_input_tokens_before: 200,
            estimated_input_tokens_after: 100,
            applied_components: ["lcm-compaction"],
            approval_status: "auto-applied-by-policy",
            authorization_id: "pref-1234567890abcdef12345678"
          })
        ],
        truncated: true
      })
    });
    expect(settled?.line).toContain("input 200→100");
    expect(settled?.line).toContain("full apply");
  });

  it("asks the bounded receipt reader to cover the exact run start", async () => {
    const f = fixture();
    const raw = hookPayload(f.cwd, f.rollout);
    writeFileSync(f.rollout, `${usageRecord(1, SESSION, TURN, usage(1_000, 100))}\n`);
    const startedAt = "2026-09-04T07:39:00.000Z";
    beginCodexTurn(raw, f.env, () => new Date(startedAt));
    let requestedCoverFrom: string | undefined;
    await settleCodexStop(raw, {
      env: f.env,
      now: () => new Date("2026-09-04T07:39:18.456Z"),
      readReceipts: async (_cwd, coverFrom) => {
        requestedCoverFrom = coverFrom;
        return { receipts: [], truncated: false };
      }
    });
    expect(requestedCoverFrom).toBe(startedAt);
  });

  it("fails closed without an open exact run or independently supported counts", async () => {
    const f = fixture();
    expect(await settleCodexStop(hookPayload(f.cwd, f.rollout), {
      env: f.env,
      readReceipts: async () => ({ receipts: [], truncated: false })
    })).toBeUndefined();
    beginCodexTurn(hookPayload(f.cwd, f.rollout), f.env);
    const scope = { tool: "codex", sessionId: SESSION, turnId: TURN } as const;
    await recordShapingOutcome(scope, "shape", f.env);
    expect(await settleCodexStop(hookPayload(f.cwd, f.rollout), {
      env: f.env,
      readReceipts: async () => ({ receipts: [], truncated: false })
    })).toBeUndefined();
    expect(readdirSync(join(f.env.COMPACTION_CONFIG_DIR!, SHAPING_TURN_STATE_DIR))).toEqual([]);
  });

  it("cleans exact shaping state when the terminal Stop cannot recover an open run", async () => {
    for (const failure of ["deleted", "malformed", "already-closed", "throwing"] as const) {
      const f = fixture();
      const raw = hookPayload(f.cwd, f.rollout);
      const scope = beginCodexTurn(raw, f.env, () => new Date("2026-09-04T07:39:00.000Z"));
      expect(scope).toBeDefined();
      await recordShapingOutcome(scope, "shape", f.env, () => new Date("2026-09-04T07:39:01.000Z"));
      const correlation = codexSessionCorrelationId(SESSION, f.env)!;
      const turnCorrelation = codexTurnCorrelationId(SESSION, TURN, f.env)!;
      const runPath = join(f.env.COMPACTION_CONFIG_DIR!, "runs", `${correlation}.json`);
      if (failure === "deleted") rmSync(runPath, { force: true });
      if (failure === "malformed") {
        writeFileSync(runPath, JSON.stringify({ schema: "compaction.run-boundary.v1", runs: [null] }), "utf8");
      }
      if (failure === "already-closed") {
        expect(endUserRun(
          correlation,
          "2026-09-04T07:39:18.000Z",
          f.env,
          turnCorrelation
        )).toBeDefined();
      }
      const settled = await settleCodexStop(raw, {
        env: f.env,
        now: () => new Date("2026-09-04T07:39:18.456Z"),
        ...(failure === "throwing"
          ? { endRun: (() => { throw new Error("injected end-run failure"); }) as typeof endUserRun }
          : {}),
        readReceipts: async () => ({ receipts: [], truncated: false })
      });
      expect(settled, failure).toBeUndefined();
      expect(
        readdirSync(join(f.env.COMPACTION_CONFIG_DIR!, SHAPING_TURN_STATE_DIR)),
        failure
      ).toEqual([]);
    }
  });

  it("rejects malformed, foreign, mismatched, and ambiguous pending records without resurrection", async () => {
    const corruptions = [
      "schema",
      "session",
      "turn",
      "sequence",
      "started",
      "ended",
      "event-id",
      "event-session",
      "event-run",
      "extra-field",
      "scalar",
      "ambiguous"
    ] as const;
    for (const corruption of corruptions) {
      const f = fixture();
      const raw = hookPayload(f.cwd, f.rollout);
      writeFileSync(f.rollout, `${usageRecord(1, SESSION, TURN, usage(50, 5))}\n`);
      const scope = beginCodexTurn(raw, f.env, () => new Date("2026-09-04T07:39:00.000Z"))!;
      await recordShapingOutcome(scope, "shape", f.env, () => new Date("2026-09-04T07:39:01.000Z"));
      await settleCodexStop(raw, {
        env: f.env,
        now: () => new Date("2026-09-04T07:39:18.456Z"),
        readReceipts: async () => ({ receipts: [], truncated: false }),
        appendEvent: async () => { throw new Error("seed only"); }
      });
      await recordShapingOutcome(scope, "shape", f.env, () => new Date("2026-09-04T07:39:19.000Z"));
      const sessionCorrelation = codexSessionCorrelationId(SESSION, f.env)!;
      const turnCorrelation = codexTurnCorrelationId(SESSION, TURN, f.env)!;
      const runPath = join(f.env.COMPACTION_CONFIG_DIR!, "runs", `${sessionCorrelation}.json`);
      const store = JSON.parse(readFileSync(runPath, "utf8")) as { runs: Array<Record<string, any>> };
      const run = store.runs[0]!;
      const pending = run.codex_settlement_pending as Record<string, any>;
      if (corruption === "schema") pending.schema = "wrong";
      if (corruption === "session") pending.session_correlation_id = "0".repeat(32);
      if (corruption === "turn") pending.turn_correlation_id = "0".repeat(32);
      if (corruption === "sequence") pending.run_seq = 99;
      if (corruption === "started") pending.run_started_at = "2026-09-04T07:38:00.000Z";
      if (corruption === "ended") pending.run_ended_at = "not-a-time";
      if (corruption === "event-id") pending.event.activity_event_id = "act-000000000000000000000000";
      if (corruption === "event-session") pending.event.session_id = "codex-session-00000000000000000000000000000000";
      if (corruption === "event-run") pending.event.run_id = "codex-stop-00000000000000000000000000000000";
      if (corruption === "extra-field") pending.prompt = "must not be accepted";
      if (corruption === "scalar") run.codex_settlement_pending = 7;
      if (corruption === "ambiguous") store.runs.push(JSON.parse(JSON.stringify(run)));
      writeFileSync(runPath, JSON.stringify(store), "utf8");

      expect(codexSettlementPending(sessionCorrelation, turnCorrelation, f.env), corruption).toBeUndefined();
      expect(await settleCodexStop(raw, { env: f.env }), corruption).toBeUndefined();
      expect(readdirSync(join(f.env.COMPACTION_CONFIG_DIR!, SHAPING_TURN_STATE_DIR)), corruption).toEqual([]);
      expect(existsSync(join(f.cwd, ".compaction", "activity", "activity.jsonl")), corruption).toBe(false);
    }
  });

  it("retains at most twenty failed settlements and eviction cannot orphan shaping", async () => {
    const f = fixture();
    let firstScope: { tool: "codex"; sessionId: string; turnId: string } | undefined;
    for (let index = 1; index <= 22; index += 1) {
      const turnId = `turn-${index}`;
      const raw = hookPayload(f.cwd, f.rollout, { turn_id: turnId });
      writeFileSync(f.rollout, `${usageRecord(index, SESSION, turnId, usage(index * 10, index))}\n`);
      const scope = beginCodexTurn(raw, f.env, () => new Date(`2026-09-04T07:${String(index).padStart(2, "0")}:00.000Z`))!;
      if (index === 1) firstScope = scope;
      await recordShapingOutcome(scope, "shape", f.env, () => new Date(`2026-09-04T07:${String(index).padStart(2, "0")}:01.000Z`));
      expect(await settleCodexStop(raw, {
        env: f.env,
        now: () => new Date(`2026-09-04T07:${String(index).padStart(2, "0")}:18.000Z`),
        readReceipts: async () => ({ receipts: [], truncated: false }),
        appendEvent: async () => { throw new Error("bounded failure"); }
      })).toBeUndefined();
      if (index === 1) {
        await recordShapingOutcome(firstScope, "shape", f.env, () => new Date("2026-09-04T07:01:19.000Z"));
      }
    }
    const sessionCorrelation = codexSessionCorrelationId(SESSION, f.env)!;
    const store = JSON.parse(readFileSync(
      join(f.env.COMPACTION_CONFIG_DIR!, "runs", `${sessionCorrelation}.json`),
      "utf8"
    )) as { runs: Array<Record<string, unknown>> };
    expect(store.runs).toHaveLength(20);
    expect(store.runs.every((run) => run.codex_settlement_pending !== undefined)).toBe(true);
    expect(readdirSync(join(f.env.COMPACTION_CONFIG_DIR!, SHAPING_TURN_STATE_DIR))).toEqual([]);
  });

  it("recovers one failed session without consuming another concurrent session's pending event", async () => {
    const f = fixture();
    const sessionB = "33333333-3333-4333-8333-333333333333";
    const turnB = "44444444-4444-4444-8444-444444444444";
    const rawA = hookPayload(f.cwd, f.rollout);
    const rawB = hookPayload(f.cwd, f.rollout, { session_id: sessionB, turn_id: turnB });
    writeFileSync(f.rollout, `${usageRecord(1, SESSION, TURN, usage(50, 5))}\n`);
    beginCodexTurn(rawA, f.env, () => new Date("2026-09-04T07:39:00.000Z"));
    expect(await settleCodexStop(rawA, {
      env: f.env,
      now: () => new Date("2026-09-04T07:39:10.000Z"),
      readReceipts: async () => ({ receipts: [], truncated: false }),
      appendEvent: async () => { throw new Error("A append failure"); }
    })).toBeUndefined();
    writeFileSync(f.rollout, `${usageRecord(2, sessionB, turnB, usage(80, 8))}\n`);
    beginCodexTurn(rawB, f.env, () => new Date("2026-09-04T07:39:01.000Z"));
    expect(await settleCodexStop(rawB, {
      env: f.env,
      now: () => new Date("2026-09-04T07:39:11.000Z"),
      readReceipts: async () => ({ receipts: [], truncated: false }),
      appendEvent: async () => { throw new Error("B append failure"); }
    })).toBeUndefined();
    const correlationA = codexSessionCorrelationId(SESSION, f.env)!;
    const turnCorrelationA = codexTurnCorrelationId(SESSION, TURN, f.env)!;
    const correlationB = codexSessionCorrelationId(sessionB, f.env)!;
    const turnCorrelationB = codexTurnCorrelationId(sessionB, turnB, f.env)!;
    expect(codexSettlementPending(correlationA, turnCorrelationA, f.env)).toBeDefined();
    const frozenB = codexSettlementPending(correlationB, turnCorrelationB, f.env);
    expect(frozenB).toBeDefined();

    const recoveredA = await settleCodexStop(rawA, { env: f.env });
    expect(recoveredA?.event.output_after).toBe(5);
    expect(codexSettlementPending(correlationA, turnCorrelationA, f.env)).toBeUndefined();
    expect(codexSettlementPending(correlationB, turnCorrelationB, f.env)).toEqual(frozenB);
  });

  it("persists under the rendering kill switch but returns no systemMessage line", async () => {
    const f = fixture();
    const raw = hookPayload(f.cwd, f.rollout);
    writeFileSync(f.rollout, `${usageRecord(1, SESSION, TURN, usage(50, 5))}\n`);
    const env = { ...f.env, COMPACTION_RECEIPT_LINE: "0" };
    beginCodexTurn(raw, env, () => new Date("2026-09-04T07:39:00.000Z"));
    const settled = await settleCodexStop(raw, {
      env,
      now: () => new Date("2026-09-04T07:39:18.456Z"),
      readReceipts: async () => ({ receipts: [], truncated: false })
    });
    expect(settled?.line).toBeUndefined();
    expect(readFileSync(join(f.cwd, ".compaction", "activity", "activity.jsonl"), "utf8")).toContain("codex-stop");
  });
});

describe("Codex request correlation", () => {
  it("accepts exactly one strict session-id header and fails closed on missing/malformed/multiple", () => {
    const f = fixture();
    expect(codexSessionCorrelationFromRawHeaders(["Session-Id", SESSION], f.env)).toBe(
      codexSessionCorrelationId(SESSION, f.env)
    );
    expect(codexSessionCorrelationFromRawHeaders([], f.env)).toBeUndefined();
    expect(codexSessionCorrelationFromRawHeaders(["session-id", "bad value"], f.env)).toBeUndefined();
    expect(codexSessionCorrelationFromRawHeaders(["session-id", SESSION, "SESSION-ID", SESSION], f.env)).toBeUndefined();
    expect(codexTurnCorrelationId(SESSION, TURN, f.env)).toMatch(/^[0-9a-f]{32}$/);
  });
});
