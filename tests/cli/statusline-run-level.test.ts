import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeStatusLine, STATUS_LINE_PLACEHOLDER } from "../../src/cli/commands/statusline.js";
import { sessionCorrelationId } from "../../src/core/gateway/session-correlation.js";
import { endUserRun, startUserRun } from "../../src/core/gateway/run-boundary.js";
import type { GatewayReceipt } from "../../src/core/gateway/receipt.js";
import { provisionValidLease } from "../helpers/lease-fixture.js";
import { currentPeriodId, periodEndUtc } from "../../src/core/entitlement/lease.js";
import { communityLimitClause, UPGRADE_CTA_LABEL } from "../../src/core/upgrade-cta.js";
import { seedOutputCalibration, TEST_OUTPUT_POLICY_VERSION } from "../helpers/output-calibration-fixture.js";
import { writeProductMode } from "../../src/core/onboarding-preferences.js";

/**
 * THE PRIMARY REGRESSION. The persistent line must describe the RUN, not whichever provider call
 * landed last. The synthetic sequence below interleaves main apply and auxiliary record calls, which
 * previously rendered
 * `full apply → apply off → full apply → apply off → full apply`.
 */

const SESSION = "11111111-1111-4111-8111-111111111111";
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function fullDevice(): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), "statusline-run-"));
  dirs.push(dir);
  return provisionValidLease(dir, {}, { productMode: "full" }) as NodeJS.ProcessEnv;
}

/** An Open device: no lease; the product mode is whatever the preferences store says (default `observe`). */
function openDevice(mode?: "basic"): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), "statusline-run-open-"));
  dirs.push(dir);
  const env = { COMPACTION_CONFIG_DIR: dir } as NodeJS.ProcessEnv;
  if (mode) writeProductMode(mode, env);
  return env;
}

/** Fold one synthetic exact A/B into the calibration store: control 1000 → treatment 600. */
async function measureDevice(env: NodeJS.ProcessEnv): Promise<void> {
  await seedOutputCalibration(env);
}

function receipt(o: Partial<GatewayReceipt> & { captured_at: string; receipt_id: string }): GatewayReceipt {
  return {
    provider: "anthropic", model: "claude-opus-5", endpoint: "/v1/messages", mode: "record",
    upstream_status: 200, model_visible_bytes_changed: false, tokens: {},
    fresh_billed_input_reduction: { available: false, note: "x" }, token_source: "provider-reported",
    cache_source: "unavailable", cost_source: "unavailable", reasons: { cost: "x" },
    claim_scope: "run-scoped", approval_status: "not-required", sync_status: "local-only",
    content_uploaded: false, label: "x", ...o
  } as GatewayReceipt;
}

/** A synthetic interleaved sequence, correlated to one session. */
function ledger(correlationId: string): GatewayReceipt[] {
  const apply = (id: string, at: string, before: number, after: number, out: number) =>
    receipt({
      receipt_id: id, captured_at: at, mode: "apply", request_mutated: true, model_visible_bytes_changed: true,
      estimated_input_tokens_before: before, estimated_input_tokens_after: after,
      applied_components: ["lcm-compaction"], output_shaping_state: "already-active",
      output_shaping_policy_version: TEST_OUTPUT_POLICY_VERSION,
      approval_status: "auto-applied-by-policy",
      tokens: { prompt_input: before, output: out }, session_correlation_id: correlationId
    });
  const aux = (id: string, at: string, input: number) =>
    receipt({
      receipt_id: id, captured_at: at, model: "claude-sonnet-5",
      tokens: { prompt_input: input, output: 10 }, session_correlation_id: correlationId
    });
  return [
    apply("apply001", "2026-09-01T10:55:52.354Z", 1_000, 800, 100),
    aux("aux00001", "2026-09-01T10:56:15.525Z", 600),
    apply("apply002", "2026-09-01T10:56:22.717Z", 1_100, 850, 150),
    aux("aux00002", "2026-09-01T10:56:39.242Z", 650),
    apply("apply003", "2026-09-01T10:57:32.548Z", 1_200, 900, 300)
  ];
}

const STDIN = JSON.stringify({ cwd: "/some/proj", session_id: SESSION });
/** The same stdin, carrying a Claude Code output count — the last rung of the fallback ladder. */
const STDIN_WITH_OUTPUT = JSON.stringify({ cwd: "/some/proj", session_id: SESSION, output_tokens: 500 });

describe("the persistent line describes the RUN, not the last provider call", () => {
  it("holds one cumulative posture across apply → record → apply → record → apply", async () => {
    const env = fullDevice();
    const c = sessionCorrelationId(SESSION, env)!;
    startUserRun(c, "2026-09-01T10:55:00.000Z", env);
    const all = ledger(c);
    const lines: string[] = [];
    // Render after each call lands, exactly as Claude Code re-renders the status line.
    for (let n = 1; n <= all.length; n++) {
      const line = await computeStatusLine(STDIN, { env, readReceipts: async () => all.slice(0, n) });
      lines.push(line ?? "");
    }
    // NO FLICKER: the posture never changes, and `apply off` never appears.
    for (const line of lines) expect(line).toContain("full apply");
    for (const line of lines) expect(line).not.toContain("apply off");
    // CUMULATIVE: the input total grows as calls land, it does not jump to the latest call's numbers.
    const totals = lines.map((l) => Number(/input ([\d,]+)/.exec(l)?.[1]?.replace(/,/g, "") ?? 0));
    for (let i = 1; i < totals.length; i++) expect(totals[i]).toBeGreaterThan(totals[i - 1]);
  });

  it("a record/no-op receipt cannot overwrite the run line with `apply off`", async () => {
    const env = fullDevice();
    const c = sessionCorrelationId(SESSION, env)!;
    startUserRun(c, "2026-09-01T10:55:00.000Z", env);
    const all = ledger(c);
    // The exact frame that used to render `apply off`: the sonnet record call is the LATEST receipt.
    // `readReceipt` is supplied so that DISABLING the run path reproduces the old per-call rendering
    // verbatim — this test then fails with the auxiliary call's plain counts plus `apply off`,
    // which is the defect, rather than with a placeholder.
    const line = await computeStatusLine(STDIN, {
      env,
      readReceipts: async () => all.slice(0, 2),
      readReceipt: async () => all[1]
    });
    expect(line).not.toContain("apply off");
    expect(line).toContain("full apply");
    // And it is the RUN's numbers, not that call's 600.
    expect(line).toContain("1,600");
  });

  it("settles on the completed aggregate after Stop", async () => {
    const env = fullDevice();
    const c = sessionCorrelationId(SESSION, env)!;
    startUserRun(c, "2026-09-01T10:55:00.000Z", env);
    endUserRun(c, "2026-09-01T10:58:00.000Z", env);
    const line = await computeStatusLine(STDIN, { env, readReceipts: async () => ledger(c) });
    // 4,550 → 3,800 across the whole run.
    expect(line).toContain("input 4,550→3,800");
    expect(line).toContain("full apply");
  });

  it("a NEW UserPromptSubmit resets the aggregate for the new run", async () => {
    const env = fullDevice();
    const c = sessionCorrelationId(SESSION, env)!;
    startUserRun(c, "2026-09-01T10:55:00.000Z", env);
    endUserRun(c, "2026-09-01T10:58:00.000Z", env);
    const first = ledger(c);
    startUserRun(c, "2026-09-01T11:00:00.000Z", env);
    const second = receipt({
      receipt_id: "newrun01", captured_at: "2026-09-01T11:00:30.000Z", mode: "apply", request_mutated: true,
      estimated_input_tokens_before: 1000, estimated_input_tokens_after: 900,
      applied_components: ["lcm-compaction"], tokens: { prompt_input: 1000, output: 10 },
      session_correlation_id: c
    });
    const line = await computeStatusLine(STDIN, { env, readReceipts: async () => [...first, second] });
    // Only the NEW run's numbers; the previous run's 4,550 is gone.
    expect(line).toContain("input 1,000→900");
    expect(line).not.toContain("4,550");
  });

  it("a call from a CONCURRENT session in the same cwd never enters this run", async () => {
    const env = fullDevice();
    const mine = sessionCorrelationId(SESSION, env)!;
    const other = sessionCorrelationId("11111111-2222-3333-4444-555555555555", env)!;
    startUserRun(mine, "2026-09-01T10:55:00.000Z", env);
    const foreign = receipt({
      receipt_id: "foreign1", captured_at: "2026-09-01T10:56:00.000Z", mode: "apply", request_mutated: true,
      estimated_input_tokens_before: 900_000, estimated_input_tokens_after: 100_000,
      applied_components: ["lcm-compaction"], tokens: { prompt_input: 900_000, output: 50 },
      session_correlation_id: other
    });
    const line = await computeStatusLine(STDIN, { env, readReceipts: async () => [...ledger(mine), foreign] });
    expect(line).toContain("input 4,550→3,800");
    expect(line).not.toContain("900,000");
  });

  it("falls back to the per-receipt line when this session has no run boundary", async () => {
    const env = fullDevice();
    const c = sessionCorrelationId(SESSION, env)!;
    // No startUserRun: no hook installed, or the marker was never written.
    const line = await computeStatusLine(STDIN, {
      env,
      readReceipts: async () => ledger(c),
      readReceipt: async () => ledger(c)[4]
    });
    // The old per-call rendering, unchanged — the run path never guesses a run.
    expect(line).toContain("1,200→900");
  });

  /**
   * THE SHIPPED PRIOR IS NOT THIS RUN'S RESULT, AND THE RUN SAYS SO RATHER THAN SAYING NOTHING.
   * `loadCalibrationReduction` used to report the 0.47 default prior as `availability: "measured"` (the
   * rate is real; the sample behind it is empty), and gating on availability rendered
   * a numerical output before/percentage on every fresh device as if it were a measurement
   * of the run. No reconstructed BEFORE may appear here, and none does.
   *
   * What replaced it is an UNKNOWN before, not a deleted axis: this run has proven-shaped calls, so the
   * output axis exists and its size is the thing that is missing. `N/A` cannot be misread as a count,
   * which is the whole difference from the withdrawn numerical claim.
   */
  it("renders the run's UNKNOWN output axis on a DEFAULT-PRIOR device: no reconstructed before, no prior", async () => {
    const env = fullDevice();
    const c = sessionCorrelationId(SESSION, env)!;
    startUserRun(c, "2026-09-01T10:55:00.000Z", env);
    const line = (await computeStatusLine(STDIN, { env, readReceipts: async () => ledger(c) }))!;
    // 100 + 10 + 150 + 10 + 300, as the provider reported it — the AFTER is exact on either rendering.
    expect(line).toContain("output N/A→570 (N/A%, est.)");
    // NO number was reconstructed into the before slot, and the withdrawn prior figure is nowhere.
    expect(line).not.toMatch(/output [\d,]+→/);
    expect(line).not.toContain("−47%");
    expect(line).not.toContain("default prior");
    // No percentage was invented for the unknown axis either — `N/A%` is the only percent slot filled.
    expect(line).not.toMatch(/output N\/A→[\d,]+ \(−/);
    // The input axis is unaffected: it is a real measured before→after.
    expect(line).toContain("input 4,550→3,800");
  });

  it("renders the output counterfactual only on a device with its OWN measured rate", async () => {
    const env = fullDevice();
    await measureDevice(env);
    const c = sessionCorrelationId(SESSION, env)!;
    startUserRun(c, "2026-09-01T10:55:00.000Z", env);
    const line = (await computeStatusLine(STDIN, { env, readReceipts: async () => ledger(c) }))!;
    // The three proven-shaped calls use the exact 40% cohort; the two unshaped calls pass through,
    // so the whole-run reduction rounds to 39%.
    expect(line).toMatch(/output [\d,]+→570 \(−39%, est\.\)/);
    expect(line).not.toContain("default prior");
  });

  it("an `observe` setting cannot relabel a durably proven stored/full run", async () => {
    const env = openDevice();
    const c = sessionCorrelationId(SESSION, env)!;
    startUserRun(c, "2026-09-01T10:55:00.000Z", env);
    const line = (await computeStatusLine(STDIN, { env, readReceipts: async () => ledger(c) }))!;
    expect(line).toContain("input 4,550→3,800");
    expect(line).toContain("full apply");
    expect(line).not.toContain("apply off");
  });

  it("a `basic` setting cannot relabel a durably proven stored/full run", async () => {
    const env = openDevice("basic");
    const c = sessionCorrelationId(SESSION, env)!;
    startUserRun(c, "2026-09-01T10:55:00.000Z", env);
    const line = (await computeStatusLine(STDIN, { env, readReceipts: async () => ledger(c) }))!;
    expect(line).toContain("input 4,550→3,800");
    expect(line).toContain("full apply");
  });

  /**
   * A KNOWN-INCOMPLETE READ CARRIES NO RATE. The status line reads a bounded tail of one directory's
   * ledger; when bytes precede the window and the oldest receipt it holds was captured after the run
   * began, the run's earlier calls may have been cut off, and a percentage over a partial run would be
   * a claim the read cannot support. Plain totals only.
   */
  it("renders plain totals when the tail window is known to have cut into the run", async () => {
    const env = fullDevice();
    const c = sessionCorrelationId(SESSION, env)!;
    startUserRun(c, "2026-09-01T10:55:00.000Z", env);
    const line = (await computeStatusLine(STDIN, {
      env, readReceipts: async () => ({ receipts: ledger(c).slice(2), truncated: true })
    }))!;
    expect(line).toContain("input 2,400");
    expect(line).not.toContain("→");
    expect(line).not.toContain("%");
    expect(line).toContain("output 460");
    expect(line).toContain("full apply");
  });

  it("a truncated window that still reaches back before the run began is complete for this run", async () => {
    const env = fullDevice();
    const c = sessionCorrelationId(SESSION, env)!;
    startUserRun(c, "2026-09-01T10:55:00.000Z", env);
    const older = receipt({ receipt_id: "older001", captured_at: "2026-09-01T10:40:00.000Z", tokens: { prompt_input: 5, output: 1 }, session_correlation_id: c });
    const line = (await computeStatusLine(STDIN, {
      env, readReceipts: async () => ({ receipts: [older, ...ledger(c)], truncated: true })
    }))!;
    expect(line).toContain("input 4,550→3,800");
  });

  /**
   * THE CEILING RIDES THE RUN LINE. A Community user whose run hit an `insufficient` pause (allowance
   * left, but less than that call needed — a state the session resolver cannot express) must read the
   * reason, the reset date and the conversion path on the run line exactly as the per-receipt line
   * would have shown them, or the run line is a silent downgrade of the one surface they read.
   *
   * THE TWO SURFACES ARE COMPARED, NOT DESCRIBED SEPARATELY, which is what makes this the guard
   * against the repo's recurring one-claim-four-surfaces drift: a copy change landing on the
   * per-receipt renderer and not on the run line fails here even if neither line is pinned by name.
   */
  it("renders the run's allowance pause and CTA exactly as the per-receipt line does", async () => {
    const env = { ...fullDevice(), COMPACTION_HYPERLINKS: "0" } as NodeJS.ProcessEnv;
    const c = sessionCorrelationId(SESSION, env)!;
    startUserRun(c, "2026-09-01T10:55:00.000Z", env);
    const period = currentPeriodId();
    const resetsOn = periodEndUtc(period);
    const paused = receipt({
      receipt_id: "paused01", captured_at: "2026-09-01T10:57:40.000Z", mode: "apply", request_mutated: true,
      applied_components: ["output-shaping"], output_shaping_state: "attached-this-pass",
      tokens: { prompt_input: 75_946, output: 40 }, session_correlation_id: c,
      allowance_pause: { reason: "insufficient", period_id: period, resets_on: resetsOn, scope: "all-routes" }
    });
    const runLine = (await computeStatusLine(STDIN, { env, readReceipts: async () => [...ledger(c), paused] }))!;
    // The per-receipt rendering of the SAME paused call, reached by disabling the run path (no session).
    const perReceipt = (await computeStatusLine(JSON.stringify({ cwd: "/some/proj" }), { env, readReceipt: async () => paused }))!;
    // The per-receipt line ends with that receipt's id; a run has many receipts and carries none.
    const clause = communityLimitClause(resetsOn);
    const ceilingOf = (line: string) => {
      const at = line.indexOf(clause);
      // FAIL LOUDLY, NOT SILENTLY. A bare `slice(indexOf(...))` on a missing clause returns the line's
      // LAST CHARACTER, and comparing two last characters is a test that passes on any two lines that
      // both lost the ceiling. Asserted before the slice so the absence reports as the absence.
      expect(at, `${clause} missing from: ${line}`).toBeGreaterThan(-1);
      return line.slice(at).replace(/ · id [0-9a-z]+$/, "");
    };
    // The reset date is DERIVED from the current period here, exactly as the gateway derives it — the
    // literal `2026-10-01` never appears in this file.
    expect(ceilingOf(perReceipt)).toContain(`Community limit resets ${resetsOn as string}`);
    expect(ceilingOf(perReceipt)).not.toContain("paused until");
    expect(ceilingOf(perReceipt)).not.toContain("output shaping continues");
    expect(ceilingOf(perReceipt)).toContain(UPGRADE_CTA_LABEL);
    expect(ceilingOf(runLine)).toBe(ceilingOf(perReceipt));
    expect(runLine).toContain("input paused");
    // A paused run is not a full apply, on either surface: the renderer withholds the posture label
    // when the input axis was refused, and the run line inherits exactly that rule.
    expect(runLine).not.toContain("full apply");
    expect(perReceipt).not.toContain("full apply");
  });

  it("a later successful debit in the same run lifts the pause and shows the countdown instead", async () => {
    const env = { ...fullDevice(), COMPACTION_HYPERLINKS: "0" } as NodeJS.ProcessEnv;
    const c = sessionCorrelationId(SESSION, env)!;
    startUserRun(c, "2026-09-01T10:55:00.000Z", env);
    const paused = receipt({
      receipt_id: "paused01", captured_at: "2026-09-01T10:55:30.000Z", tokens: { prompt_input: 10, output: 1 }, session_correlation_id: c,
      allowance_pause: { reason: "insufficient", period_id: currentPeriodId(), resets_on: periodEndUtc(currentPeriodId()) }
    });
    const debited = receipt({
      receipt_id: "debit001", captured_at: "2026-09-01T10:56:00.000Z", tokens: { prompt_input: 10, output: 1 }, session_correlation_id: c,
      allowance_snapshot: { remaining_tokens: 1_800_000, period_total_tokens: 2_000_000 }
    });
    const line = (await computeStatusLine(STDIN, { env, readReceipts: async () => [paused, debited] }))!;
    expect(line).toContain("1.8M/2M left");
    expect(line).not.toContain("paused");
    expect(line).not.toContain(UPGRADE_CTA_LABEL);
  });

  it("the final call stays in the settled aggregate when its receipt lands after Stop", async () => {
    const env = fullDevice();
    const c = sessionCorrelationId(SESSION, env)!;
    startUserRun(c, "2026-09-01T10:55:00.000Z", env);
    endUserRun(c, "2026-09-01T10:57:32.400Z", env); // Stop fired before the last receipt was appended
    const all = ledger(c).map((r, i) =>
      i === 4 ? { ...r, request_started_at: "2026-09-01T10:57:10.000Z", captured_at: "2026-09-01T10:57:32.548Z" } : r
    );
    const line = await computeStatusLine(STDIN, { env, readReceipts: async () => all });
    // All five calls — 4,550 → 3,800 — not the first four.
    expect(line).toContain("input 4,550→3,800");
  });

  it("the output axis rides #944 provenance: unknown calls create no saving", async () => {
    const env = fullDevice();
    const c = sessionCorrelationId(SESSION, env)!;
    startUserRun(c, "2026-09-01T10:55:00.000Z", env);
    const unknown = ledger(c).map((r) => {
      const copy = { ...r } as Partial<GatewayReceipt>;
      delete copy.output_shaping_state;
      return copy as GatewayReceipt;
    });
    const line = await computeStatusLine(STDIN, { env, readReceipts: async () => unknown });
    // Output renders as a plain total: 100 + 10 + 150 + 10 + 300.
    expect(line).toContain("output 570");
    expect(line).not.toMatch(/output [\d,]+→/);
  });
});


/**
 * THE SAME DEFECT, ONE FRAME LATER. #945 stopped the line flickering INSIDE a run; it still flickered
 * BETWEEN runs. `UserPromptSubmit` opens run N+1 immediately, and until that run's first receipt lands
 * the run path found nothing and handed the surface back to the per-call fallback — which reads
 * whatever landed last in the directory's ledger, i.e. run N's FINAL micro-call (an auxiliary
 * auxiliary record call). One prompt, one wrong frame.
 */
describe("the line holds across the gap between runs", () => {
  const RUN1_START = "2026-09-01T10:55:00.000Z";
  const RUN1_END = "2026-09-01T10:58:00.000Z";
  const RUN2_START = "2026-09-01T11:00:00.000Z";

  /** Run N+1's first call: a real apply, deliberately tiny so it cannot be confused with run N. */
  const run2Receipt = (c: string): GatewayReceipt =>
    receipt({
      receipt_id: "newrun01", captured_at: "2026-09-01T11:00:30.000Z", mode: "apply", request_mutated: true,
      model_visible_bytes_changed: true, estimated_input_tokens_before: 1000, estimated_input_tokens_after: 900,
      applied_components: ["lcm-compaction"], tokens: { prompt_input: 1000, output: 10 },
      approval_status: "auto-applied-by-policy",
      session_correlation_id: c
    });

  it("keeps run N's settled aggregate while run N+1 is open and empty, never run N's last micro-call", async () => {
    const env = fullDevice();
    const c = sessionCorrelationId(SESSION, env)!;
    startUserRun(c, RUN1_START, env);
    endUserRun(c, RUN1_END, env);
    const all = ledger(c);
    const micro = all[3]!; // the auxiliary record call of run N — 650 in, 10 out
    startUserRun(c, RUN2_START, env); // the user pressed enter; no receipt of this run has landed yet

    const line = (await computeStatusLine(STDIN, {
      env, readReceipts: async () => all, readReceipt: async () => micro
    }))!;
    // Run N's settled aggregate, unchanged by the new prompt.
    expect(line).toContain("input 4,550→3,800");
    expect(line).toContain("full apply");
    expect(line).not.toContain("apply off");
    // The micro-call is genuinely in the window AND is what the tail read returns — it still never
    // reaches the surface. Proof that it WOULD have: the same receipt on a session with no run state.
    expect(micro.tokens?.prompt_input).toBe(650);
    const perCall = (await computeStatusLine(JSON.stringify({ cwd: "/some/proj" }), {
      env, readReceipt: async () => micro
    }))!;
    expect(perCall).toContain("650");
  });

  it("hands the line to run N+1 as soon as its first receipt lands", async () => {
    const env = fullDevice();
    const c = sessionCorrelationId(SESSION, env)!;
    startUserRun(c, RUN1_START, env);
    endUserRun(c, RUN1_END, env);
    const all = ledger(c);
    startUserRun(c, RUN2_START, env);
    const line = (await computeStatusLine(STDIN, {
      env, readReceipts: async () => [...all, run2Receipt(c)], readReceipt: async () => all[3]!
    }))!;
    expect(line).toContain("input 1,000→900");
    expect(line).not.toContain("4,550");
  });

  it("settles on run N+1's completed aggregate at its Stop", async () => {
    const env = fullDevice();
    const c = sessionCorrelationId(SESSION, env)!;
    startUserRun(c, RUN1_START, env);
    endUserRun(c, RUN1_END, env);
    const all = ledger(c);
    startUserRun(c, RUN2_START, env);
    endUserRun(c, "2026-09-01T11:01:00.000Z", env);
    const line = (await computeStatusLine(STDIN, {
      env, readReceipts: async () => [...all, run2Receipt(c)], readReceipt: async () => all[3]!
    }))!;
    expect(line).toContain("input 1,000→900");
    expect(line).toContain("full apply");
    expect(line).not.toContain("4,550");
  });

  /**
   * A SESSION WITH RUN STATE OWNS THE PER-CALL RECEIPT RUNG. With a run open and nothing renderable
   * anywhere in the window, the last receipt in this directory's ledger — run N's auxiliary micro-call —
   * must not take the surface, because it describes a single provider call rather than the user's run.
   * With no stdin count to fall back on either, the honest render is silence.
   */
  it("renders the quiet placeholder, not the last receipt, when no run has receipts", async () => {
    const env = fullDevice();
    const c = sessionCorrelationId(SESSION, env)!;
    startUserRun(c, RUN1_START, env);
    const micro = ledger(c)[3]!;
    const line = await computeStatusLine(STDIN, {
      env, readReceipts: async () => [], readReceipt: async () => micro
    });
    expect(line).toBe(STATUS_LINE_PLACEHOLDER);
    // Proof the receipt WOULD have rendered: the same receipt on a session with no run state.
    expect(micro.tokens?.prompt_input).toBe(650);
    const perCall = (await computeStatusLine(JSON.stringify({ cwd: "/some/proj" }), {
      env, readReceipt: async () => micro
    }))!;
    expect(perCall).toContain("650");
  });

  /**
   * THE HOOKS-ONLY DEVICE MUST KEEP ITS LINE. Run ownership is scoped to the per-call receipt rung; the
   * stdin OUTPUT-ONLY rung stays reachable because it reports the host's own count for the very turn
   * being rendered, so it can resurrect no past call.
   *
   * This is not a corner case — it is the whole subscription/output-shaping segment. `UserPromptSubmit`
   * opens a run on EVERY prompt, and `connect` installs that hook alongside this status line, while a
   * device with no gateway writes no receipts at all. Gating this rung on run ownership too rendered the
   * placeholder on every turn, permanently, for the devices whose only apply lever is output shaping.
   */
  it("renders the stdin output-only line for a hooks-only device: run state, no receipts ever", async () => {
    const env = openDevice("basic");
    const c = sessionCorrelationId(SESSION, env)!;
    startUserRun(c, RUN1_START, env);
    const open = (await computeStatusLine(STDIN_WITH_OUTPUT, {
      env, readReceipts: async () => [], readReceipt: async () => undefined
    }))!;
    expect(open).toContain("output 500");
    expect(open).not.toBe(STATUS_LINE_PLACEHOLDER);
    // And after `Stop`, when the run is settled and there is still nothing in any ledger to aggregate.
    endUserRun(c, RUN1_END, env);
    const settled = (await computeStatusLine(STDIN_WITH_OUTPUT, {
      env, readReceipts: async () => [], readReceipt: async () => undefined
    }))!;
    expect(settled).toContain("output 500");
  });

  it("a session with NO run-boundary state still reaches the stdin output-only fallback", async () => {
    const env = fullDevice();
    // No startUserRun anywhere: the pre-existing fallback ladder must behave exactly as before.
    const line = (await computeStatusLine(STDIN_WITH_OUTPUT, {
      env, readReceipts: async () => [], readReceipt: async () => undefined
    }))!;
    expect(line).toContain("output 500");
  });

  /**
   * THE HELD LINE IS THE NEWEST SETTLED RUN, NOT THE OLDEST. `completedUserRuns` returns newest-first
   * and the gap path takes the first candidate it can use, so that ordering is load-bearing — yet
   * every other test here reaches the gap with exactly ONE completed run, where newest and oldest
   * coincide. Dropping the `.reverse()` therefore rendered a STALE run's numbers on the primary
   * surface, in the ordinary case of any session past its second prompt, with no crash and nothing
   * red. Two settled runs is the smallest case that can tell the two apart.
   *
   * The stale-run assertion comes FIRST deliberately: if it trailed the positive pin, a regression
   * would fail on the pin and never reach the assertion that names the actual defect.
   */
  it("holds the NEWEST completed run's aggregate when several have settled", async () => {
    const env = fullDevice();
    const c = sessionCorrelationId(SESSION, env)!;
    const settled = (id: string, at: string, before: number, after: number, out: number): GatewayReceipt =>
      receipt({
        receipt_id: id, captured_at: at, mode: "apply", request_mutated: true,
        model_visible_bytes_changed: true, estimated_input_tokens_before: before,
        estimated_input_tokens_after: after, applied_components: ["lcm-compaction"],
        tokens: { prompt_input: before, output: out }, session_correlation_id: c
      });

    startUserRun(c, "2026-09-01T10:00:00.000Z", env);
    endUserRun(c, "2026-09-01T10:01:00.000Z", env);
    startUserRun(c, "2026-09-01T10:02:00.000Z", env);
    endUserRun(c, "2026-09-01T10:03:00.000Z", env);
    startUserRun(c, "2026-09-01T10:04:00.000Z", env); // the gap: open, and still empty

    const all = [
      settled("runaaaa1", "2026-09-01T10:00:30.000Z", 10_000, 9_000, 11),
      settled("runbbbb2", "2026-09-01T10:02:30.000Z", 50_000, 40_000, 22)
    ];
    const line = (await computeStatusLine(STDIN, {
      env, readReceipts: async () => all, readReceipt: async () => all[0]!
    }))!;
    expect(line).not.toContain("10,000→9,000");
    expect(line).toContain("input 50,000→40,000");
  });
});
