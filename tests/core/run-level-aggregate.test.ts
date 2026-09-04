import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aggregateRun } from "../../src/core/gateway/run-aggregate.js";
import {
  currentUserRun,
  endUserRun,
  receiptBelongsToRun,
  startUserRun
} from "../../src/core/gateway/run-boundary.js";
import {
  sessionCorrelationId,
  toolSessionIdFromRequestBody
} from "../../src/core/gateway/session-correlation.js";
import { readGatewayReceiptTailWindow, type GatewayReceipt } from "../../src/core/gateway/receipt.js";
import { TEST_OUTPUT_POLICY_VERSION } from "../helpers/output-calibration-fixture.js";

/**
 * THE RUN IS THE USER-FACING UNIT. These cases use a synthetic flicker sequence: main-thread apply
 * calls interleaved with auxiliary record-mode calls, which mutate nothing and previously made the line read
 * `full apply → apply off → full apply` inside ONE request.
 */

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
function device(): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), "run-agg-"));
  dirs.push(dir);
  return { COMPACTION_CONFIG_DIR: dir } as NodeJS.ProcessEnv;
}

function receipt(o: Partial<GatewayReceipt> & { captured_at: string }): GatewayReceipt {
  return {
    receipt_id: `r${o.captured_at}`,
    provider: "anthropic",
    model: "claude-opus-5",
    endpoint: "/v1/messages",
    mode: "record",
    upstream_status: 200,
    model_visible_bytes_changed: false,
    tokens: {},
    fresh_billed_input_reduction: { available: false, note: "x" },
    token_source: "provider-reported",
    cache_source: "unavailable",
    cost_source: "unavailable",
    reasons: { cost: "x" },
    claim_scope: "run-scoped",
    approval_status: "not-required",
    sync_status: "local-only",
    content_uploaded: false,
    label: "x",
    ...o
  } as GatewayReceipt;
}

describe("session correlation", () => {
  /**
   * The fixture is wholly synthetic and covers the supported `metadata.user_id` JSON-string shape.
   * Only `session_id` is required; the other fields prove that correlation does not depend on an
   * exact key set.
   */
  const SYNTHETIC_SESSION_ID = "22222222-2222-4222-8222-222222222222";
  const SUPPORTED_SHAPE_BODY = JSON.stringify({
    model: "claude-opus-5",
    metadata: {
      user_id: JSON.stringify({
        device_id: "0".repeat(64),
        account_uuid: "11111111-1111-4111-8111-111111111111",
        session_id: SYNTHETIC_SESSION_ID
      })
    },
    messages: [{ role: "user", content: "hi" }]
  });

  it("reads the session id from the supported metadata.user_id shape", () => {
    expect(toolSessionIdFromRequestBody(SUPPORTED_SHAPE_BODY)).toBe(SYNTHETIC_SESSION_ID);
  });

  it("tolerates the optional keys the binary can add (parent_session_id, tk, extra metadata)", () => {
    const body = JSON.stringify({
      metadata: {
        user_id: JSON.stringify({
          device_id: "0".repeat(64), account_uuid: "12345678-1234-4123-8123-123456789abc",
          session_id: "22222222-2222-4222-8222-222222222222", parent_session_id: "33333333-3333-4333-8333-333333333333", tk: "x"
        })
      }
    });
    expect(toolSessionIdFromRequestBody(body)).toBe("22222222-2222-4222-8222-222222222222");
  });

  it("is deterministic across calls and stable across processes (salt is a file, not process state)", () => {
    const env = device();
    const a = sessionCorrelationId("s-1", env);
    const b = sessionCorrelationId("s-1", env);
    expect(a).toBeDefined();
    expect(a).toBe(b);
  });

  it("never contains the raw session id, and differs per session and per device", () => {
    const env = device();
    const id = sessionCorrelationId("22222222-2222-4222-8222-222222222222", env)!;
    expect(id).not.toContain("22222222");
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(sessionCorrelationId("other-session", env)).not.toBe(id);
    // A different device has a different salt ⇒ the same session hashes differently.
    expect(sessionCorrelationId("22222222-2222-4222-8222-222222222222", device())).not.toBe(id);
  });

  it("returns undefined for a body with no session metadata (uncorrelated, never guessed)", () => {
    expect(toolSessionIdFromRequestBody(JSON.stringify({ model: "m" }))).toBeUndefined();
    expect(toolSessionIdFromRequestBody("{not json")).toBeUndefined();
  });
});

describe("run boundaries", () => {
  it("invalid correlation and symlink/nonregular stores cannot select or overwrite a run path", () => {
    const env = device();
    const correlation = sessionCorrelationId("safe-session", env)!;
    const runs = join(env.COMPACTION_CONFIG_DIR!, "runs");
    mkdirSync(runs, { recursive: true });
    const path = join(runs, `${correlation}.json`);
    const outside = join(env.COMPACTION_CONFIG_DIR!, "outside.json");
    writeFileSync(outside, "outside-sentinel", "utf8");
    symlinkSync(outside, path);
    expect(startUserRun(correlation, "2026-09-01T10:00:00.000Z", env)).toBeUndefined();
    expect(readFileSync(outside, "utf8")).toBe("outside-sentinel");

    rmSync(path, { force: true });
    mkdirSync(path);
    expect(startUserRun(correlation, "2026-09-01T10:00:00.000Z", env)).toBeUndefined();
    rmSync(path, { recursive: true });
    execFileSync("mkfifo", [path]);
    expect(startUserRun(correlation, "2026-09-01T10:00:00.000Z", env)).toBeUndefined();
    expect(startUserRun("../../outside", "2026-09-01T10:00:00.000Z", env)).toBeUndefined();
    expect(readFileSync(outside, "utf8")).toBe("outside-sentinel");
  });

  it("a new UserPromptSubmit closes the previous run and starts a fresh one", () => {
    const env = device();
    const c = sessionCorrelationId("s", env)!;
    const first = startUserRun(c, "2026-09-01T10:00:00.000Z", env)!;
    endUserRun(c, "2026-09-01T10:01:00.000Z", env);
    const second = startUserRun(c, "2026-09-01T10:02:00.000Z", env)!;
    expect(first.run_seq).toBe(1);
    expect(second.run_seq).toBe(2);
    expect(currentUserRun(c, env)?.run_seq).toBe(2);
  });

  it("a missing Stop cannot leave a run accumulating forever", () => {
    const env = device();
    const c = sessionCorrelationId("s", env)!;
    startUserRun(c, "2026-09-01T10:00:00.000Z", env); // never closed (crash / interrupt)
    startUserRun(c, "2026-09-01T10:05:00.000Z", env);
    const late = receipt({ captured_at: "2026-09-01T10:06:00.000Z", session_correlation_id: c });
    // The late call belongs to run 2 only — run 1 was closed at run 2's start, not left open.
    expect(currentUserRun(c, env)?.run_seq).toBe(2);
    expect(receiptBelongsToRun(late, currentUserRun(c, env)!)).toBe(true);
  });

  it("sequential runs in ONE session do not bleed into each other", () => {
    const env = device();
    const c = sessionCorrelationId("s", env)!;
    const r1 = startUserRun(c, "2026-09-01T10:00:00.000Z", env)!;
    endUserRun(c, "2026-09-01T10:01:00.000Z", env);
    const closed = currentUserRun(c, env)!;
    const r2 = startUserRun(c, "2026-09-01T10:02:00.000Z", env)!;
    const inRun2 = receipt({ captured_at: "2026-09-01T10:02:30.000Z", session_correlation_id: c });
    expect(receiptBelongsToRun(inRun2, closed)).toBe(false);
    expect(receiptBelongsToRun(inRun2, currentUserRun(c, env)!)).toBe(true);
    expect(r1.run_seq).not.toBe(r2.run_seq);
  });

  it("two CONCURRENT sessions in the same cwd stay isolated (cwd is never consulted)", () => {
    const env = device();
    const a = sessionCorrelationId("session-A", env)!;
    const b = sessionCorrelationId("session-B", env)!;
    expect(a).not.toBe(b);
    startUserRun(a, "2026-09-01T10:00:00.000Z", env);
    startUserRun(b, "2026-09-01T10:00:00.000Z", env);
    const runA = currentUserRun(a, env)!;
    const fromB = receipt({ captured_at: "2026-09-01T10:00:30.000Z", session_correlation_id: b });
    // Overlapping in time, same directory — and still not A's.
    expect(receiptBelongsToRun(fromB, runA)).toBe(false);
    expect(receiptBelongsToRun({ ...fromB, session_correlation_id: a }, runA)).toBe(true);
  });

  it("a call that outlives Stop is UNATTRIBUTED, never folded into the next run", () => {
    const env = device();
    const c = sessionCorrelationId("s", env)!;
    startUserRun(c, "2026-09-01T10:00:00.000Z", env);
    const closed = { ...currentUserRun(c, env)!, ended_at: "2026-09-01T10:01:00.000Z" };
    endUserRun(c, "2026-09-01T10:01:00.000Z", env);
    const next = startUserRun(c, "2026-09-01T10:05:00.000Z", env)!;
    // A backgrounded subagent call landing between Stop and the next prompt.
    const orphan = receipt({ captured_at: "2026-09-01T10:03:00.000Z", session_correlation_id: c });
    expect(receiptBelongsToRun(orphan, closed)).toBe(false);
    expect(receiptBelongsToRun(orphan, next)).toBe(false);
  });

  it("an uncorrelated receipt belongs to no run", () => {
    const env = device();
    const c = sessionCorrelationId("s", env)!;
    const run = startUserRun(c, "2026-09-01T10:00:00.000Z", env)!;
    expect(receiptBelongsToRun(receipt({ captured_at: "2026-09-01T10:00:30.000Z" }), run)).toBe(false);
  });

  /**
   * THE FINAL CALL'S RECEIPT CAN LAND AFTER STOP. The gateway assigns `captured_at` only after the
   * response has streamed and the usage window is assembled (on a compressed response, after an async
   * decompressor flush), while Claude Code already has the response and fires `Stop`. Membership keys
   * on when the REQUEST arrived, which is provably before the response.
   */
  it("a call whose request started inside the run belongs to it even when its receipt lands after Stop", () => {
    const env = device();
    const c = sessionCorrelationId("s", env)!;
    startUserRun(c, "2026-09-01T10:00:00.000Z", env);
    const closed = endUserRun(c, "2026-09-01T10:01:00.000Z", env)!;
    const finalCall = receipt({
      request_started_at: "2026-09-01T10:00:58.000Z",
      captured_at: "2026-09-01T10:01:00.250Z", // after ended_at
      session_correlation_id: c
    });
    expect(receiptBelongsToRun(finalCall, closed)).toBe(true);
  });

  it("a request that STARTED after Stop is unattributed, however early its receipt claims to be", () => {
    const env = device();
    const c = sessionCorrelationId("s", env)!;
    startUserRun(c, "2026-09-01T10:00:00.000Z", env);
    const closed = endUserRun(c, "2026-09-01T10:01:00.000Z", env)!;
    const later = receipt({
      request_started_at: "2026-09-01T10:01:00.001Z",
      captured_at: "2026-09-01T10:01:00.000Z",
      session_correlation_id: c
    });
    expect(receiptBelongsToRun(later, closed)).toBe(false);
  });

  it("a previous prompt's late-finishing call cannot cross into the next run", () => {
    const env = device();
    const c = sessionCorrelationId("s", env)!;
    startUserRun(c, "2026-09-01T10:00:00.000Z", env);
    endUserRun(c, "2026-09-01T10:01:00.000Z", env);
    const next = startUserRun(c, "2026-09-01T10:02:00.000Z", env)!;
    const straggler = receipt({
      request_started_at: "2026-09-01T10:00:59.000Z",
      captured_at: "2026-09-01T10:02:05.000Z", // inside run 2 by capture time
      session_correlation_id: c
    });
    expect(receiptBelongsToRun(straggler, next)).toBe(false);
  });

  it("a legacy receipt with no request_started_at still falls back to captured_at", () => {
    const env = device();
    const c = sessionCorrelationId("s", env)!;
    const run = startUserRun(c, "2026-09-01T10:00:00.000Z", env)!;
    const legacy = receipt({ captured_at: "2026-09-01T10:00:30.000Z", session_correlation_id: c });
    expect(legacy.request_started_at).toBeUndefined();
    expect(receiptBelongsToRun(legacy, run)).toBe(true);
  });
});

describe("the receipt tail window", () => {
  it("reports whether older receipts precede the window it read", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "run-agg-tail-"));
    dirs.push(cwd);
    mkdirSync(join(cwd, ".compaction", "gateway"), { recursive: true });
    const rows = Array.from({ length: 6 }, (_, i) =>
      JSON.stringify({ receipt_id: `r-${i}`, captured_at: `2026-09-01T10:0${i}:00.000Z` })
    );
    writeFileSync(join(cwd, ".compaction", "gateway", "receipts.jsonl"), `${rows.join("\n")}\n`);
    const whole = await readGatewayReceiptTailWindow(cwd);
    expect(whole.truncated).toBe(false);
    expect(whole.receipts).toHaveLength(6);
    // A window smaller than the file: the partial first row is skipped, and the cut is reported.
    const cut = await readGatewayReceiptTailWindow(cwd, 200);
    expect(cut.truncated).toBe(true);
    expect(cut.receipts.length).toBeGreaterThan(0);
    expect(cut.receipts.length).toBeLessThan(6);
    expect(cut.receipts[cut.receipts.length - 1]?.receipt_id).toBe("r-5");
  });
});

describe("run aggregate math", () => {
  const resolver = (rate: number) => () => ({
    availability: "measured" as const,
    reductionPct: rate * 100
  }) as never;

  /** The synthetic flicker sequence: apply → record → apply → record → apply. */
  function flickerRun(): GatewayReceipt[] {
    const apply = (at: string, before: number, after: number, out: number): GatewayReceipt =>
      receipt({
        captured_at: at, mode: "apply", request_mutated: true, model_visible_bytes_changed: true,
        estimated_input_tokens_before: before, estimated_input_tokens_after: after,
        applied_components: ["lcm-compaction"], output_shaping_state: "already-active",
        output_shaping_policy_version: TEST_OUTPUT_POLICY_VERSION,
        tokens: { prompt_input: before, output: out }
      });
    const aux = (at: string, input: number): GatewayReceipt =>
      receipt({ captured_at: at, model: "claude-sonnet-5", tokens: { prompt_input: input, output: 10 } });
    return [
      apply("2026-09-01T10:55:52.354Z", 1_000, 800, 100),
      aux("2026-09-01T10:56:15.525Z", 600),
      apply("2026-09-01T10:56:22.717Z", 1_100, 850, 150),
      aux("2026-09-01T10:56:39.242Z", 650),
      apply("2026-09-01T10:57:32.548Z", 1_200, 900, 300)
    ];
  }

  it("sums optimized AND unoptimized calls; unoptimized contribute before == after", () => {
    const agg = aggregateRun(flickerRun());
    expect(agg.input).toEqual({ before: 4_550, after: 3_800 });
    expect(agg.callCount).toBe(5);
    // The no-op calls are IN the denominator: dropping them would inflate the rate.
    expect(agg.input!.before).toBe(4_550);
  });

  it("derives the percentage from totals, never from per-call percentages", () => {
    const agg = aggregateRun(flickerRun());
    const pct = 1 - agg.input!.after / agg.input!.before;
    // Each apply call alone is 20%; the run is lower because the no-op calls are counted honestly.
    expect(Math.round(pct * 100)).toBe(16);
    const perCall = (1_000 - 800) / 1_000;
    expect(Math.round(perCall * 100)).toBe(20);
    expect(Math.round(pct * 100)).not.toBe(Math.round(perCall * 100));
  });

  it("reconstructs the output counterfactual ONLY where provenance proves shaping was active", () => {
    const agg = aggregateRun(flickerRun(), { outputCalibrationResolver: resolver(0.47) });
    // Shaped: 100 + 150 + 300 (already-active). Unshaped aux calls: 10 + 10 contribute before == after.
    const shaped = Math.round(100 / 0.53) + Math.round(150 / 0.53) + Math.round(300 / 0.53);
    expect(agg.output).toEqual({ before: shaped + 20, after: 570, counterfactualAvailable: true });
    expect(agg.shapedCallCount).toBe(3);
  });

  it("counts proven-shaped calls whether or not a rate exists to reconstruct with", () => {
    // The count is EVIDENCE (how many calls shaping was active on), not a count of reconstructions —
    // a device with no measured rate must not report zero shaped calls for a fully shaped run.
    const withoutRate = aggregateRun(flickerRun());
    expect(withoutRate.shapedCallCount).toBe(3);
    expect(withoutRate.output).toEqual({ before: 570, after: 570, counterfactualAvailable: false });
    expect(aggregateRun(flickerRun(), { outputCalibrationResolver: resolver(0.4) }).shapedCallCount).toBe(3);
  });

  it("treats `absent` and LEGACY unknown identically: before == after, never a saving", () => {
    const legacy = receipt({ captured_at: "t1", tokens: { prompt_input: 100, output: 500 } });
    const absent = receipt({ captured_at: "t2", output_shaping_state: "absent", tokens: { prompt_input: 100, output: 500 } });
    for (const r of [legacy, absent]) {
      const agg = aggregateRun([r], { outputCalibrationResolver: resolver(0.47) });
      expect(agg.output).toEqual({ before: 500, after: 500, counterfactualAvailable: true });
      expect(agg.shapedCallCount).toBe(0);
    }
    expect(legacy.output_shaping_state).toBeUndefined();
  });

  it("counts `attached-this-pass` as shaped, like `already-active`", () => {
    const r = receipt({
      captured_at: "t",
      output_shaping_state: "attached-this-pass",
      output_shaping_policy_version: TEST_OUTPUT_POLICY_VERSION,
      tokens: { prompt_input: 10, output: 530 }
    });
    const agg = aggregateRun([r], { outputCalibrationResolver: resolver(0.47) });
    expect(agg.output!.before).toBe(1000);
    expect(agg.shapedCallCount).toBe(1);
  });

  it("shows the ENDING allowance, never a sum", () => {
    const agg = aggregateRun([
      receipt({ captured_at: "t1", tokens: { output: 1 }, allowance_snapshot: { remaining_tokens: 2_000_000, period_total_tokens: 2_000_000 } }),
      receipt({ captured_at: "t2", tokens: { output: 1 }, allowance_snapshot: { remaining_tokens: 1_900_000, period_total_tokens: 2_000_000 } })
    ] as GatewayReceipt[]);
    expect(agg.allowance).toEqual({ remaining_tokens: 1_900_000, period_total_tokens: 2_000_000 });
  });

  it("retains the run's ending allowance PAUSE from the call that recorded it (insufficient is not a balance)", () => {
    const pause = { reason: "insufficient" as const, period_id: "2026-09", resets_on: "2026-10-01", scope: "all-routes" as const };
    const agg = aggregateRun([
      receipt({ captured_at: "t1", tokens: { output: 1 }, allowance_snapshot: { remaining_tokens: 400, period_total_tokens: 2_000 } }),
      receipt({ captured_at: "t2", tokens: { output: 1 }, allowance_pause: pause, output_shaping_state: "already-active", applied_components: ["output-shaping"] })
    ]);
    expect(agg.pausedCall).toEqual({ allowance_pause: pause, output_shaping_state: "already-active", applied_components: ["output-shaping"] });
    // A paused turn debited nothing: the countdown and the ceiling are mutually exclusive on the run too.
    expect(agg.allowance).toBeUndefined();
  });

  it("a later successful debit clears an earlier pause: the ending state is the last allowance event", () => {
    const agg = aggregateRun([
      receipt({ captured_at: "t1", tokens: { output: 1 }, allowance_pause: { reason: "insufficient", period_id: "2026-09" } }),
      receipt({ captured_at: "t2", tokens: { output: 1 }, allowance_snapshot: { remaining_tokens: 300, period_total_tokens: 2_000 } })
    ]);
    expect(agg.pausedCall).toBeUndefined();
    expect(agg.allowance).toEqual({ remaining_tokens: 300, period_total_tokens: 2_000 });
  });

  it("drops an incompatible historical pair and contributes the plain provider count on both sides", () => {
    // A legacy receipt claims `lcm-compaction` while reporting before === after.
    const historical = receipt({
      captured_at: "t", mode: "apply", applied_components: ["lcm-compaction"],
      estimated_input_tokens_before: 900, estimated_input_tokens_after: 900,
      tokens: { prompt_input: 1_000, output: 80 }
    });
    const agg = aggregateRun([historical]);
    // Falls back to the plain model-visible count on BOTH sides — not the false zero-delta pair.
    expect(agg.input).toEqual({ before: 1_000, after: 1_000 });
  });

  it("a genuine no-change apply still contributes its honest zero", () => {
    const noChange = receipt({
      captured_at: "t", mode: "apply", applied_components: [],
      estimated_input_tokens_before: 1000, estimated_input_tokens_after: 1000,
      tokens: { prompt_input: 1000, output: 5 }
    });
    expect(aggregateRun([noChange]).input).toEqual({ before: 1000, after: 1000 });
  });
});
