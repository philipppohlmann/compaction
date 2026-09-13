import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lastReceiptLines, receiptLinesFromJsonl, runWatch, runWatchOnce } from "../../src/cli/commands/watch.js";
import { openLineForTurn, receiptProvenOpenLabel } from "../../src/core/gateway/receipt-line.js";
import { DEFAULT_GATEWAY_RECEIPTS_DIR, GATEWAY_RECEIPTS_FILE, type GatewayReceipt } from "../../src/core/gateway/receipt.js";
import { writeProductMode } from "../../src/core/onboarding-preferences.js";
import { loadOutputCalibrationResolver } from "../../src/core/output-shaping-savings.js";
import { recordShapingOutcome } from "../../src/core/output-shaping-turn-state.js";
import type { ShapingTurnScope } from "../../src/core/output-shaping-turn-state.js";
import { provisionValidLease } from "../helpers/lease-fixture.js";
import { seedOutputCalibration, TEST_OUTPUT_POLICY_VERSION } from "../helpers/output-calibration-fixture.js";

/**
 * Fold a real provider-reported A/B (1000 → 620 output tokens, a measured 38%) into `configDir`'s
 * calibration store.
 *
 * The output figure is gated on the device's OWN measurement: the shipped 0.47 default prior renders
 * none. These cases are about WHICH REPLAYED RECEIPT may draw an arrow, so the device has to be one
 * that may draw an arrow at all — otherwise the negative cases below ("a receipt proving nothing
 * renders a plain count") would pass no matter what the gate did.
 *
 * THE SEEDED RATE MUST NOT BE 0.47. It was: the fold reproduced the prior's own magnitude so the
 * reconstructed pairs would not have to change. That made every `−47%` pin in this file unable to
 * tell a device measurement from the prior leaking back through — the exact figure the withdrawal
 * removes is the one the assertions demanded, so reverting the fix would have kept them green. 38%
 * is a rate no default can produce, so a `−47%` anywhere below is now a FAILURE SIGNAL rather than
 * the expected text.
 */
async function seedMeasuredCalibration(configDir: string): Promise<void> {
  await seedOutputCalibration(
    { COMPACTION_CONFIG_DIR: configDir } as NodeJS.ProcessEnv,
    { model: "claude-sonnet-4-5", treatment: [620, 620, 620] }
  );
}

/**
 * `watch` is a side pane, not a hook: it is handed no tool session id, so at the CLI it fails closed and
 * renders no output arrow. These cases exercise the RENDERING, so they inject the scope explicitly —
 * the same one they record the decision under.
 */
const WATCH_SCOPE: ShapingTurnScope = { tool: "claude-code", sessionId: "watch-test-session" };

/**
 * THE PER-TURN TIER LABEL MUST DESCRIBE THE TURN, NOT TODAY'S SETTING.
 *
 * `compaction watch`, `watch --once` and `compaction status`'s "Last turns" all replay HISTORICAL
 * receipts through one formatter. The label they carried was read from the device's CURRENT product
 * mode, so flipping `compaction mode` retroactively relabelled turns that were never produced under
 * it - the same receipt rendered `apply off` or `basic shaping` depending on a setting changed days
 * later. The fix: omit the label on historical surfaces, and derive it from the receipt wherever the receipt proves it.
 *
 * These tests assert the PROPERTY (identical receipt ⇒ identical line) separately from the exact
 * strings, so a string change can never mask the property going dead.
 */

let cwd: string;
let observeCfg: string;
let basicCfg: string;

/** A plain record-mode turn: the gateway applied nothing and mutated nothing. */
function recordReceipt(id: string): GatewayReceipt {
  return {
    receipt_id: id,
    captured_at: "2026-07-30T10:00:00.000Z",
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    endpoint: "/v1/messages",
    mode: "record",
    upstream_status: 200,
    model_visible_bytes_changed: false,
    tokens: { prompt_input: 22012, output: 412 },
    fresh_billed_input_reduction: { available: false, note: "x" },
    token_source: "provider-reported",
    cache_source: "unavailable",
    cost_source: "unavailable",
    reasons: { cost: "x" },
    claim_scope: "run-scoped",
    approval_status: "not-required",
    sync_status: "local-only",
    content_uploaded: false,
    label: "x"
  };
}

/** A turn the GATEWAY itself shaped: mutated, output-shaping attached, no input compaction. */
function shapedReceipt(id: string): GatewayReceipt {
  return {
    ...recordReceipt(id),
    mode: "apply",
    request_mutated: true,
    model_visible_bytes_changed: true,
    approval_status: "auto-applied-by-policy",
    recovery_id: "rec-1",
    applied_components: ["output-shaping"],
    output_shaping_state: "attached-this-pass",
    output_shaping_policy_version: TEST_OUTPUT_POLICY_VERSION
  };
}

async function writeReceipts(receipts: GatewayReceipt[]): Promise<void> {
  const dir = join(cwd, DEFAULT_GATEWAY_RECEIPTS_DIR);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, GATEWAY_RECEIPTS_FILE), receipts.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
}

/** Append ONE receipt to a store `runWatch` is already following (i.e. a LIVE turn, not a replay). */
async function appendReceipt(receipt: GatewayReceipt): Promise<void> {
  const dir = join(cwd, DEFAULT_GATEWAY_RECEIPTS_DIR);
  await mkdir(dir, { recursive: true });
  await appendFile(join(dir, GATEWAY_RECEIPTS_FILE), `${JSON.stringify(receipt)}\n`, "utf8");
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Follow a LIVE `compaction watch` (no `--all`, so nothing is a replay), let `append` land one or more
 * receipts, and return the canonical lines it printed for them.
 */
async function liveWatchLines(
  env: NodeJS.ProcessEnv,
  append: () => Promise<void>,
  // `null` means "no scope at all" — an explicit `undefined` would fall back to this default and
  // silently re-run the shaped case.
  shapingScope: ShapingTurnScope | null = WATCH_SCOPE
): Promise<string[]> {
  const printed: string[] = [];
  const controller = new AbortController();
  const done = runWatch(controller.signal, {}, { cwd, env, pollMs: 30, print: (l) => printed.push(l), ...(shapingScope ? { shapingScope } : {}) });
  await delay(80);
  await append();
  await delay(200);
  controller.abort();
  await done;
  return printed.filter((l) => l.startsWith("compaction · "));
}

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "watch-tier-label-"));
  observeCfg = await mkdtemp(join(tmpdir(), "watch-tier-observe-"));
  basicCfg = await mkdtemp(join(tmpdir(), "watch-tier-basic-"));
  writeProductMode("observe", { COMPACTION_CONFIG_DIR: observeCfg });
  writeProductMode("basic", { COMPACTION_CONFIG_DIR: basicCfg });
});
afterEach(async () => {
  for (const dir of [cwd, observeCfg, basicCfg]) await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("historical per-turn lines are independent of today's product mode", () => {
  it("renders the SAME line for the same receipt under `observe` and under `basic` (status 'Last turns')", async () => {
    await writeReceipts([recordReceipt("aaaaaaaa11112222333344445555aaaa")]);

    const asObserve = await lastReceiptLines(1, { cwd, env: { COMPACTION_CONFIG_DIR: observeCfg } });
    const asBasic = await lastReceiptLines(1, { cwd, env: { COMPACTION_CONFIG_DIR: basicCfg } });

    // THE DEFECT: today this is `... · apply off · id ...` vs `... · basic shaping · id ...` for one
    // receipt that neither mode produced. The receipt records `mode: "record"`, no `request_mutated`
    // and no `applied_components` - there is no evidence for either label.
    expect(asBasic.lines, "the same receipt must render identically whatever the mode says today").toEqual(
      asObserve.lines
    );
  });

  it("renders the SAME snapshot for the same receipts under `observe` and under `basic` (`watch --once`)", async () => {
    await writeReceipts([recordReceipt("bbbbbbbb11112222333344445555bbbb"), recordReceipt("cccccccc11112222333344445555cccc")]);

    const observed: string[] = [];
    const basic: string[] = [];
    await runWatchOnce({}, { cwd, env: { COMPACTION_CONFIG_DIR: observeCfg }, print: (l) => observed.push(l) });
    await runWatchOnce({}, { cwd, env: { COMPACTION_CONFIG_DIR: basicCfg }, print: (l) => basic.push(l) });

    const receiptsOnly = (lines: string[]): string[] => lines.filter((l) => l.startsWith("compaction · "));
    expect(receiptsOnly(basic)).toEqual(receiptsOnly(observed));
  });

  it("claims no tier on a replayed receipt that proves none", async () => {
    await writeReceipts([recordReceipt("dddddddd11112222333344445555dddd")]);
    const { lines } = await lastReceiptLines(1, { cwd, env: { COMPACTION_CONFIG_DIR: basicCfg } });

    expect(lines).toHaveLength(1);
    const line = lines[0] as string;
    // `basic shaping` would claim a mutation the receipt does not record; `apply off` would claim "no
    // model-visible mutation", which a gateway receipt cannot establish either - the tool's own prompt
    // hook shapes upstream of the gateway, where this receipt cannot see it.
    expect(line).not.toContain("basic shaping");
    expect(line).not.toContain("apply off");
    expect(line).not.toContain("full apply");
    // The counts and the id still ride the line: dropping the label drops a claim, not the receipt.
    expect(line).toContain("22,012");
    expect(line).toContain("output 412");
    expect(line).toContain("id dddddddd");
  });

  it("keeps the Open `observed input N` vocabulary on an unlabelled line (no wording change)", async () => {
    await writeReceipts([recordReceipt("eeeeeeee11112222333344445555eeee")]);
    const { lines } = await lastReceiptLines(1, { cwd, env: { COMPACTION_CONFIG_DIR: observeCfg } });
    // Dropping the LABEL must not silently re-word the input clause these surfaces have always shown.
    expect(lines[0]).toContain("observed input 22,012");
  });
});

describe("the label the receipt DOES prove survives a contradicting preference", () => {
  it("labels a gateway-shaped receipt `basic shaping` even while the device says `observe`", async () => {
    await writeReceipts([shapedReceipt("ffffffff11112222333344445555ffff")]);
    const { lines } = await lastReceiptLines(1, { cwd, env: { COMPACTION_CONFIG_DIR: observeCfg } });

    // The receipt records the mutation and the component. That is a statement about THAT turn, so it
    // outlives a later `compaction mode observe`.
    expect(lines[0]).toContain("basic shaping");
    expect(lines[0]).not.toContain("apply off");
  });

  it("renders a gateway-shaped receipt identically under either mode", async () => {
    await writeReceipts([shapedReceipt("99999999111122223333444455559999")]);
    const asObserve = await lastReceiptLines(1, { cwd, env: { COMPACTION_CONFIG_DIR: observeCfg } });
    const asBasic = await lastReceiptLines(1, { cwd, env: { COMPACTION_CONFIG_DIR: basicCfg } });
    expect(asBasic.lines).toEqual(asObserve.lines);
  });
});

describe("a full apply is never relabelled as Open `basic shaping`", () => {
  /**
   * A REAL Community full apply: the input was compacted (`estimated_input_tokens_before/after`) and
   * output shaping rode the same request, which is what the composed apply pipeline produces.
   *
   * THIS IS THE GUARD FOR THE INPUT-ARROW CONJUNCT of `receiptProvenOpenLabel`. Output shaping was
   * ACTIVE on a full apply (`output_shaping_state: "attached-this-pass"`), so without the `no input
   * before→after` condition the helper answers `basic` for it — and every surface that asks (`watch`,
   * `status`, the Stop-hook line, the gateway's own inline line) would print `basic shaping` on a
   * Community full apply while suppressing its measured reduction. That is the same class of false
   * label this whole rule exists to remove, pointed the other way.
   */
  function fullApplyReceipt(id: string): GatewayReceipt {
    return {
      ...recordReceipt(id),
      mode: "apply",
      request_mutated: true,
      model_visible_bytes_changed: true,
      approval_status: "auto-applied-by-policy",
      authorization_id: "pref-1234567890abcdef12345678",
      recovery_id: "rec-full",
      applied_components: ["lcm-compaction", "deterministic-compaction", "output-shaping"],
      output_shaping_state: "attached-this-pass",
      estimated_input_tokens_before: 41210,
      estimated_input_tokens_after: 21876,
      estimated_model_visible_input_reduction_percent: 47,
      token_source_before: "local-estimate",
      token_source_after: "local-estimate"
    };
  }

  it("proves no Open label for a receipt carrying an input before→after", () => {
    expect(receiptProvenOpenLabel(fullApplyReceipt("aaaa1111222233334444555566667777"))).toBeUndefined();

    // NON-VACUOUS, and pinned to the input-arrow condition alone: the SAME receipt with ONLY the two
    // before→after counts removed is exactly the case that DOES prove `basic`. So this pair fails for
    // the missing input-arrow check and cannot pass by accident through the state condition.
    const withoutInputArrow = fullApplyReceipt("aaaa1111222233334444555566667777") as Partial<GatewayReceipt>;
    delete withoutInputArrow.estimated_input_tokens_before;
    delete withoutInputArrow.estimated_input_tokens_after;
    expect(receiptProvenOpenLabel(withoutInputArrow as GatewayReceipt)).toBe("basic");
  });

  it("does not print `basic shaping` for a full apply replayed on an Open device", async () => {
    await writeReceipts([fullApplyReceipt("bbbb1111222233334444555566667777")]);
    // The device is Open TODAY; the receipt is a full apply from when it was not. The Open path must
    // not adopt it as its own shaping - it says nothing rather than misattributing the turn.
    const { lines } = await lastReceiptLines(1, { cwd, env: { COMPACTION_CONFIG_DIR: observeCfg } });
    expect(lines[0]).not.toContain("basic shaping");
    expect(lines[0]).not.toContain("apply off");
  });

  it("does not print `basic shaping` for a full apply, whatever the injected tier says", () => {
    const chunk = JSON.stringify(fullApplyReceipt("cccc1111222233334444555566667777")) + "\n";
    for (const productTier of ["observe", "basic"] as const) {
      expect(receiptLinesFromJsonl(chunk, { productTier })[0]).not.toContain("basic shaping");
    }
  });

  /**
   * THE LIVE PATH, which the three cases above do not reach. On a live batch the label may also come
   * from the turn's own shaped-evidence (`lastTurnWasShaped`) — and that fallback must decline a
   * full-apply receipt too. The prompt hook shaping a turn does not make `basic shaping` a true
   * description of a turn whose receipt records an input compaction, and the Open rendering that
   * label rides suppresses the measured reduction the receipt actually carries.
   *
   * Each case is paired with a CONTROL that differs only in the receipt, so a green result cannot come
   * from shaped-evidence being absent in the harness.
   */
  it("does not take the live shaped-evidence label on a full apply (shared renderer)", () => {
    const context = { productTier: "basic" as const, shapedEvidence: true };
    const applyChunk = JSON.stringify(fullApplyReceipt("dddd1111222233334444555566667777")) + "\n";
    expect(receiptLinesFromJsonl(applyChunk, context)[0]).not.toContain("basic shaping");

    // CONTROL: same context, same live evidence, non-apply receipt ⇒ the fallback DOES label it.
    const recordChunk = JSON.stringify(recordReceipt("eeee1111222233334444555566667777")) + "\n";
    expect(receiptLinesFromJsonl(recordChunk, context)[0]).toContain("basic shaping");
  });

  it("does not take the live shaped-evidence label on a full apply (real `watch` follow loop)", async () => {
    const env = { COMPACTION_CONFIG_DIR: observeCfg } as NodeJS.ProcessEnv;
    await recordShapingOutcome(WATCH_SCOPE, "shape", env);

    const lines = await liveWatchLines(env, () => appendReceipt(fullApplyReceipt("ffff1111222233334444555566667777")));
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("basic shaping");
  });

  it("CONTROL: the same live follow loop DOES label a non-apply turn `basic shaping`", async () => {
    // Identical harness, identical recorded shaping outcome; only the receipt differs. Without this
    // the case above could pass simply because `lastTurnWasShaped` never became true.
    const env = { COMPACTION_CONFIG_DIR: observeCfg } as NodeJS.ProcessEnv;
    await recordShapingOutcome(WATCH_SCOPE, "shape", env);

    const lines = await liveWatchLines(env, () => appendReceipt(recordReceipt("aaaa9999222233334444555566667777")));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("basic shaping");
  });

  /**
   * `watch` fails closed. It is a side pane with no tool session identity, so it cannot name the turn on
   * screen — and the shaping evidence is now keyed by session. Without an injected scope it must decline
   * the label rather than borrow whichever session recorded last, which is exactly what the shared global
   * slot used to let it do.
   */
  it("declines the shaped label when it cannot name the session (no injected scope)", async () => {
    const env = { COMPACTION_CONFIG_DIR: observeCfg } as NodeJS.ProcessEnv;
    // A live, valid `shape` record exists — it just belongs to a session `watch` cannot claim to be.
    await recordShapingOutcome(WATCH_SCOPE, "shape", env);

    const lines = await liveWatchLines(env, () => appendReceipt(recordReceipt("bbbb9999222233334444555566667777")), null);
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("basic shaping");
    expect(lines[0], "no evidence ⇒ no derived output arrow").not.toContain("→");
  });
});

describe("receiptLinesFromJsonl (the shared renderer watch/status both call)", () => {
  it("ignores the injected product tier for the label on a receipt that proves nothing", () => {
    const chunk = JSON.stringify(recordReceipt("1111111111112222333344445555aaaa")) + "\n";
    const asObserve = receiptLinesFromJsonl(chunk, { productTier: "observe" });
    const asBasic = receiptLinesFromJsonl(chunk, { productTier: "basic" });
    expect(asBasic).toEqual(asObserve);
  });

  it("labels the live batch `basic shaping` when the turn's own shaped-evidence says so", () => {
    // The LIVE path only: `shapedEvidence` describes the turn that just happened, and it is already
    // the evidence the adjacent output arrow uses - so the two can never disagree. Historical replays
    // never receive it (see `WatchRenderContext.shapedEvidence`).
    const chunk = JSON.stringify(recordReceipt("2222222211112222333344445555aaaa")) + "\n";
    expect(receiptLinesFromJsonl(chunk, { productTier: "observe", shapedEvidence: true })[0]).toContain("basic shaping");
  });
});

/**
 * THE OUTPUT ARROW MUST SURVIVE REPLAY, ON THE SAME EVIDENCE THE LABEL USES.
 *
 * The estimated-output arrow was gated on `WatchRenderContext.shapedEvidence` ALONE - a LIVE session
 * signal (`lastTurnWasShaped`) that the two replay callers never set, because both build their context
 * in `watchRenderContext`. So `watch --once` and `status`'s "Last turns" could not render an arrow for
 * ANY turn at ANY tier: a real full apply that the gateway's own inline line rendered as
 * `output 617→327 (−47%, est. · default prior)` came back as a bare `output 327` the moment the same
 * receipt was replayed. Two descriptions of one turn, and the weaker one on the surface a user checks.
 * (That capture predates the default-prior withdrawal, hence its `est. · default prior` label; the
 * cases below seed a real measurement so the same replay gate is exercised on a device allowed to
 * render a figure at all.)
 *
 * `output_shaping_state` is FIRST-HAND, per-turn, durable proof that the turn was shaped, and unlike a
 * session signal that proof does not decay on replay. It supersedes the `applied_components` gate #941
 * introduced: that field records what THIS APPLY PASS MUTATED, so a turn whose policy arrived upstream
 * from the tool's own prompt hook was genuinely shaped and still had its arrow withheld. These cases pin
 * that the arrow rides the new proof - and, just as importantly, that a receipt proving NOTHING still
 * renders a plain count, so the gate did not simply become permissive.
 */
describe("the replay output arrow rides the receipt's own shaping evidence", () => {
  /** A real Community full apply: input compacted AND output shaped in the same pass. */
  function fullApplyReceipt(id: string): GatewayReceipt {
    return {
      ...shapedReceipt(id),
      estimated_input_tokens_before: 40203,
      estimated_input_tokens_after: 38999,
      estimated_model_visible_input_reduction_percent: 3,
      authorization_id: "pref-1234567890abcdef12345678",
      applied_components: ["lcm-compaction", "output-shaping"],
      output_shaping_state: "attached-this-pass",
      tokens: { prompt_input: 28239, output: 327 }
    } as GatewayReceipt;
  }

  let fullCfg: string;
  beforeEach(async () => {
    fullCfg = await mkdtemp(join(tmpdir(), "watch-arrow-full-"));
    // `full` is an ENTITLEMENT statement, not a preference: `resolveOpenTier` clamps a device with no
    // valid lease down to observe/basic, and the full-apply builder is then never reached. Provision a
    // real dev-signed lease so these cases exercise the branch they name.
    provisionValidLease(fullCfg, {}, { productMode: "full" });
    await seedMeasuredCalibration(fullCfg);
    await seedMeasuredCalibration(basicCfg);
  });
  afterEach(async () => {
    await rm(fullCfg, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("`status` Last turns renders the arrow for a REPLAYED full-apply receipt", async () => {
    await writeReceipts([fullApplyReceipt("dddddddd11112222333344445555dddd")]);
    const { lines } = await lastReceiptLines(1, { cwd, env: { COMPACTION_CONFIG_DIR: fullCfg } });
    // The reconstructed BEFORE is this device's MEASURED rate applied to THIS turn's own output:
    // 327 + round(327 × 0.38 / 0.62) = 527.
    expect(lines[0]).toContain("output 527→327 (−38%, est.)");
    // The measured input axis and the label are unchanged by this gate.
    expect(lines[0]).toContain("input 40,203→38,999");
    expect(lines[0]).toContain("full apply");
  });

  it("`watch --once` renders the arrow for a REPLAYED gateway-shaped Open receipt", async () => {
    await writeReceipts([shapedReceipt("eeeeeeee11112222333344445555eeee")]);
    const printed: string[] = [];
    await runWatchOnce({ once: true }, { cwd, env: { COMPACTION_CONFIG_DIR: basicCfg }, print: (l) => printed.push(l) });
    const line = printed.find((l) => l.startsWith("compaction · ")) ?? "";
    // 412 + round(412 × 0.38 / 0.62) = 665.
    expect(line).toContain("output 665→412 (−38%, est.)");
  });

  /**
   * THE CASE THAT NEARLY SHIPPED A FABRICATED SAVING.
   *
   * The first version of this gate accepted `isRealApply(receipt)` as proof of shaping. It is not:
   * `isRealApply` answers "did we mutate", and the engine composes a real apply from EITHER layer
   * (`apply-pipeline.ts`: `shapedChanged = deterministicPlan.changed || outputShapingPlan?.changed`).
   * An input-only apply is therefore a real apply on which output shaping never ran -- and every
   * An input-only `lcm-compaction` turn has exactly this receipt when the task-aware gate holds
   * shaping back on tool-call turns while input compaction still fires.
   *
   * Under that gate this receipt rendered `output 617→327 (−47%, est. …)`: a
   * reconstructed BEFORE for a saving that did not happen. The input axis is real and must survive;
   * the output axis must be a plain count.
   */
  it("an INPUT-ONLY apply renders NO output arrow — a real apply is not proof that output was shaped", async () => {
    const inputOnly = {
      ...fullApplyReceipt("cccc000011112222333344445555dddd"),
      applied_components: ["lcm-compaction"],
      // Shaping genuinely did not run on this turn — the engine measured the FINAL request and said so.
      output_shaping_state: "absent"
    } as GatewayReceipt;
    await writeReceipts([inputOnly]);
    const { lines } = await lastReceiptLines(1, { cwd, env: { COMPACTION_CONFIG_DIR: fullCfg } });
    // The measured input reduction is real and stays.
    expect(lines[0]).toContain("input 40,203→38,999");
    // The counterfactual output axis is not earned: plain count, no arrow, no estimate label.
    expect(lines[0]).toContain("output 327");
    expect(lines[0], "no reconstructed BEFORE for a turn output shaping never touched").not.toContain("→327");
    expect(lines[0]).not.toContain("est.");
    expect(lines[0]).not.toContain("default prior");
  });

  /**
   * THE CASE #941 COULD NOT SEE. `applied_components: ["lcm-compaction"]` with NO `output-shaping` —
   * because the tool's own prompt hook attached the policy upstream, so the planner correctly attached
   * nothing. The turn IS shaped: the engine measured the final model-visible request and recorded
   * `already-active`. Under the #941 gate this rendered a bare `output 327`; it is an ordinary shape
   * of an LCM turn whose policy was attached upstream.
   */
  it("an ALREADY-ACTIVE turn renders the arrow even though applied_components omits output-shaping", async () => {
    const alreadyActive = {
      ...fullApplyReceipt("aaaa999911112222333344445555bbbb"),
      applied_components: ["lcm-compaction"],
      output_shaping_state: "already-active"
    } as GatewayReceipt;
    await writeReceipts([alreadyActive]);
    const { lines } = await lastReceiptLines(1, { cwd, env: { COMPACTION_CONFIG_DIR: fullCfg } });
    expect(lines[0]).toContain("output 527→327 (−38%, est.)");
    expect(lines[0]).toContain("input 40,203→38,999");
  });

  /**
   * LEGACY RECEIPTS FAIL CLOSED. The final model-visible request is not retained anywhere (recovery
   * stores `original_body` only), so a receipt written before this field CANNOT be classified after the
   * fact. No arrow, and explicitly NO fallback to `isRealApply` — this receipt is a real apply.
   */
  it("a LEGACY receipt with no output_shaping_state renders NO arrow (unknown is not `already-active`)", async () => {
    const legacy = { ...fullApplyReceipt("bbbb999911112222333344445555cccc") } as Partial<GatewayReceipt>;
    delete legacy.output_shaping_state;
    // It IS a real apply and it DOES carry the old component evidence — neither may license the arrow.
    expect(legacy.request_mutated).toBe(true);
    expect(legacy.applied_components).toContain("output-shaping");
    await writeReceipts([legacy as GatewayReceipt]);
    const { lines } = await lastReceiptLines(1, { cwd, env: { COMPACTION_CONFIG_DIR: fullCfg } });
    expect(lines[0]).toContain("output 327");
    expect(lines[0]).not.toContain("→327");
    expect(lines[0]).not.toContain("est.");
    // The measured input axis is untouched by the output gate.
    expect(lines[0]).toContain("input 40,203→38,999");
  });

  it("a receipt that proves NO shaping still renders a plain count on replay (the gate did not go permissive)", async () => {
    await writeReceipts([recordReceipt("ffffffff11112222333344445555ffff")]);
    const { lines } = await lastReceiptLines(1, { cwd, env: { COMPACTION_CONFIG_DIR: fullCfg } });
    expect(lines[0]).toContain("output 412");
    expect(lines[0]).not.toContain("→412");
    expect(lines[0]).not.toContain("est.");
  });

  it("a DEVICE-MEASURED rate replaces the prior on the same replayed receipt (label changes, gate does not)", async () => {
    // Replace the setup cohort with one exact engine-confirmed 20% cohort.
    await rm(join(fullCfg, "shaping-calibration.json"), { force: true });
    await seedOutputCalibration(
      { COMPACTION_CONFIG_DIR: fullCfg } as NodeJS.ProcessEnv,
      { model: "claude-sonnet-4-5", treatment: [800, 800, 800] }
    );
    await writeReceipts([fullApplyReceipt("aaaabbbb11112222333344445555cccc")]);
    const { lines } = await lastReceiptLines(1, { cwd, env: { COMPACTION_CONFIG_DIR: fullCfg } });
    // 20% measured: 327 / (1 − 0.2) = 409.
    expect(lines[0]).toContain("output 409→327 (−20%, est.)");
    expect(lines[0], "a measured rate must never carry the default-prior marker").not.toContain("default prior");
  });

  it("replay and the LIVE path describe the same receipt identically", async () => {
    // The property the whole gate exists for: one receipt, one description, whichever surface renders it.
    const receipt = fullApplyReceipt("bbbbcccc11112222333344445555dddd");
    await writeReceipts([]);
    const live = await liveWatchLines({ COMPACTION_CONFIG_DIR: fullCfg }, () => appendReceipt(receipt), null);
    await writeReceipts([receipt]);
    const { lines: replayed } = await lastReceiptLines(1, { cwd, env: { COMPACTION_CONFIG_DIR: fullCfg } });
    expect(live).toHaveLength(1);
    expect(replayed[0]).toBe(live[0]);
  });
});

/**
 * THE OPEN LABEL RIDES THE SAME EVIDENCE THE ARROW RIDES.
 *
 * `receiptProvenOpenLabel` used to read `request_mutated` + an `output-shaping` entry in
 * `applied_components` — "did THIS PASS mutate" — after the arrow beside it had already moved to
 * `output_shaping_state`. On the ordinary Open `already-active` turn (policy attached upstream by the
 * tool's own prompt hook, so the planner correctly attached nothing) the line therefore drew a savings
 * arrow with NO label naming what produced it: the stronger claim shown, the weaker one withheld.
 *
 * The state is authoritative whenever it is present. `absent` never takes a label — not from the
 * receipt and not from live session state — and a legacy receipt with no state fails closed exactly as
 * the arrow does.
 */
describe("the Open label reads output_shaping_state, the same evidence as the arrow", () => {
  /** The ordinary Open LCM turn: policy already on the request upstream, this pass attached none. */
  function alreadyActiveOpenReceipt(id: string): GatewayReceipt {
    return {
      ...shapedReceipt(id),
      applied_components: ["lcm-compaction"],
      output_shaping_state: "already-active"
    };
  }

  /** The engine measured the final request and shaping was NOT on it. */
  function absentOpenReceipt(id: string): GatewayReceipt {
    return {
      ...recordReceipt(id),
      output_shaping_state: "absent"
    };
  }

  // BOTH tier dirs get a real fold, because these cases contrast an arrow against its ABSENCE. The
  // output arrow now requires this device's own measurement, so on an unmeasured device every line
  // below renders a plain count — the `absent` receipt and the `already-active` receipt alike — and
  // each `not.toContain("→")` would hold for the wrong reason, proving nothing about the evidence
  // gate it is named for. `observeCfg` is seeded too so the tier-invariance case still compares two
  // devices that differ ONLY in product mode.
  beforeEach(async () => {
    await seedMeasuredCalibration(observeCfg);
    await seedMeasuredCalibration(basicCfg);
  });

  it("proves `basic` for an already-active receipt whose applied_components omits output-shaping", () => {
    const receipt = alreadyActiveOpenReceipt("aaaa0000111122223333444455550000");
    expect(receipt.applied_components).not.toContain("output-shaping");
    expect(receiptProvenOpenLabel(receipt)).toBe("basic");
  });

  it("labels an already-active Open turn `basic shaping` AND draws the arrow on replay", async () => {
    await writeReceipts([alreadyActiveOpenReceipt("bbbb0000111122223333444455550000")]);
    const { lines } = await lastReceiptLines(1, { cwd, env: { COMPACTION_CONFIG_DIR: basicCfg } });
    expect(lines).toHaveLength(1);
    const line = lines[0] as string;
    // Label and arrow name the same event: a number without a method is the state this pins against.
    expect(line).toContain("basic shaping");
    // 412 + round(412 × 0.38 / 0.62) = 665.
    expect(line).toContain("output 665→412 (−38%, est.)");
    expect(line).not.toContain("apply off");
  });

  it("renders the already-active Open turn identically whatever the device says today", async () => {
    await writeReceipts([alreadyActiveOpenReceipt("cccc0000111122223333444455550000")]);
    const asObserve = await lastReceiptLines(1, { cwd, env: { COMPACTION_CONFIG_DIR: observeCfg } });
    const asBasic = await lastReceiptLines(1, { cwd, env: { COMPACTION_CONFIG_DIR: basicCfg } });
    expect(asBasic.lines).toEqual(asObserve.lines);
    expect(asBasic.lines[0]).toContain("basic shaping");
  });

  it("proves nothing and draws nothing for an explicit `absent` receipt on replay", async () => {
    const receipt = absentOpenReceipt("dddd0000111122223333444455550000");
    expect(receiptProvenOpenLabel(receipt)).toBeUndefined();
    await writeReceipts([receipt]);
    const { lines } = await lastReceiptLines(1, { cwd, env: { COMPACTION_CONFIG_DIR: basicCfg } });
    expect(lines).toHaveLength(1);
    const line = lines[0] as string;
    expect(line).not.toContain("basic shaping");
    // `absent` says the policy was not on the request; it does not establish "no model-visible
    // mutation", so `apply off` stays underivable here too.
    expect(line).not.toContain("apply off");
    expect(line).toContain("output 412");
    expect(line).not.toContain("→");
    expect(line).not.toContain("est.");
  });

  it("does not label a LEGACY receipt (no state) from `applied_components` alone", () => {
    // It carries the old mutation evidence and no state: the label fails closed like the arrow does.
    const legacy = { ...shapedReceipt("eeee0000111122223333444455550000") } as Partial<GatewayReceipt>;
    delete legacy.output_shaping_state;
    expect(legacy.request_mutated).toBe(true);
    expect(legacy.applied_components).toContain("output-shaping");
    expect(receiptProvenOpenLabel(legacy as GatewayReceipt)).toBeUndefined();
  });

  /**
   * `openLineForTurn` — the one rule `watch` (replay + live) and the Stop hook share. The state is
   * authoritative when present; the live fallback exists for the receipt that recorded none.
   */
  describe("openLineForTurn: an explicit state is never overridden by live session evidence", () => {
    it("never labels an explicit `absent` receipt `basic shaping` from live evidence", () => {
      expect(openLineForTurn(absentOpenReceipt("ffff0000111122223333444455550000"), true)).toBe("unlabeled");
    });

    it("CONTROL: the same live evidence DOES label a legacy receipt that recorded no state", () => {
      // Differs from the case above in the receipt only, so a green result cannot come from the live
      // fallback being dead.
      expect(openLineForTurn(recordReceipt("0000ffff111122223333444455550000"), true)).toBe("basic");
    });

    it("labels an already-active receipt `basic` with no live evidence at all (replay)", () => {
      expect(openLineForTurn(alreadyActiveOpenReceipt("1111ffff111122223333444455550000"), false)).toBe("basic");
    });

    it("still never labels an input-apply receipt, whatever the state says", () => {
      const fullApply = {
        ...alreadyActiveOpenReceipt("2222ffff111122223333444455550000"),
        estimated_input_tokens_before: 41210,
        estimated_input_tokens_after: 21876
      } as GatewayReceipt;
      expect(openLineForTurn(fullApply, true)).toBe("unlabeled");
    });
  });

  /**
   * THE COALESCED LIVE DRAIN. `runWatch` resolves `lastTurnWasShaped` once per drain and hands it to
   * every receipt appended since the last poll. An earlier receipt that explicitly says `absent` must
   * not inherit `true` from the later shaped turn and draw an arrow over a saving that did not occur.
   */
  describe("a coalesced live drain does not let `absent` inherit a later turn's shaping", () => {
    it("shared renderer: [absent, already-active] under live shaped-evidence → arrow and label on the second only", async () => {
      const env = { COMPACTION_CONFIG_DIR: basicCfg };
      const calibrationResolver = await loadOutputCalibrationResolver(env);
      const chunk =
        JSON.stringify(absentOpenReceipt("3333ffff111122223333444455550000")) +
        "\n" +
        JSON.stringify(alreadyActiveOpenReceipt("4444ffff111122223333444455550000")) +
        "\n";
      const lines = receiptLinesFromJsonl(chunk, { productTier: "basic", shapedEvidence: true, calibrationResolver, env });
      expect(lines).toHaveLength(2);
      const [absentLine, activeLine] = lines as [string, string];
      expect(absentLine).toContain("id 3333ffff");
      expect(absentLine).not.toContain("→");
      expect(absentLine).not.toContain("est.");
      expect(absentLine).not.toContain("basic shaping");
      expect(activeLine).toContain("id 4444ffff");
      expect(activeLine).toContain("output 665→412 (−38%, est.)");
      expect(activeLine).toContain("basic shaping");
    });

    it("real `watch` follow loop: two receipts landing in one poll are described by their own state", async () => {
      const env = { COMPACTION_CONFIG_DIR: basicCfg } as NodeJS.ProcessEnv;
      await recordShapingOutcome(WATCH_SCOPE, "shape", env);

      const lines = await liveWatchLines(env, async () => {
        // One append, so both receipts are drained together with the same session evidence.
        const dir = join(cwd, DEFAULT_GATEWAY_RECEIPTS_DIR);
        await mkdir(dir, { recursive: true });
        await appendFile(
          join(dir, GATEWAY_RECEIPTS_FILE),
          `${JSON.stringify(absentOpenReceipt("5555ffff111122223333444455550000"))}\n${JSON.stringify(
            alreadyActiveOpenReceipt("6666ffff111122223333444455550000")
          )}\n`,
          "utf8"
        );
      });
      expect(lines).toHaveLength(2);
      const absentLine = lines.find((l) => l.includes("id 5555ffff")) ?? "";
      const activeLine = lines.find((l) => l.includes("id 6666ffff")) ?? "";
      expect(absentLine).not.toBe("");
      expect(absentLine).not.toContain("→");
      expect(absentLine).not.toContain("basic shaping");
      expect(activeLine).toContain("→412");
      expect(activeLine).toContain("basic shaping");
    });

    it("CONTROL: live evidence labels a legacy receipt and keeps its unavailable shaped axis", async () => {
      const env = { COMPACTION_CONFIG_DIR: basicCfg } as NodeJS.ProcessEnv;
      await recordShapingOutcome(WATCH_SCOPE, "shape", env);
      const lines = await liveWatchLines(env, () => appendReceipt(recordReceipt("7777ffff111122223333444455550000")));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("basic shaping");
      // The live signal proves shaping, but this legacy receipt has no exact policy version/regime.
      // It cannot borrow a numeric cohort, and it must not erase the shaped axis either.
      expect(lines[0]).toContain("output N/A→412 (N/A%, est.)");
    });
  });
});
