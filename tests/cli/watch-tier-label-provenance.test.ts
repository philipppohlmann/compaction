import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lastReceiptLines, receiptLinesFromJsonl, runWatch, runWatchOnce } from "../../src/cli/commands/watch.js";
import { receiptProvenOpenLabel } from "../../src/core/gateway/receipt-line.js";
import { DEFAULT_GATEWAY_RECEIPTS_DIR, GATEWAY_RECEIPTS_FILE, type GatewayReceipt } from "../../src/core/gateway/receipt.js";
import { writeProductMode } from "../../src/core/onboarding-preferences.js";
import { recordShapingOutcome } from "../../src/core/output-shaping-turn-state.js";

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
    applied_components: ["output-shaping"]
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
async function liveWatchLines(env: NodeJS.ProcessEnv, append: () => Promise<void>): Promise<string[]> {
  const printed: string[] = [];
  const controller = new AbortController();
  const done = runWatch(controller.signal, {}, { cwd, env, pollMs: 30, print: (l) => printed.push(l) });
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
   * THIS IS THE GUARD FOR THE THIRD CONJUNCT of `receiptProvenOpenLabel`. `request_mutated` and the
   * `output-shaping` component are BOTH true on a full apply, so without the `no input before→after`
   * condition the helper answers `basic` for it — and every surface that asks (`watch`, `status`, the
   * Stop-hook line, the gateway's own inline line) would print `basic shaping` on a Community full
   * apply while suppressing its measured reduction. That is the same class of false label this whole
   * rule exists to remove, pointed the other way.
   */
  function fullApplyReceipt(id: string): GatewayReceipt {
    return {
      ...recordReceipt(id),
      mode: "apply",
      request_mutated: true,
      model_visible_bytes_changed: true,
      approval_status: "auto-applied-by-policy",
      recovery_id: "rec-full",
      applied_components: ["lcm-compaction", "deterministic-compaction", "output-shaping"],
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
    // the missing input-arrow check and cannot pass by accident through the other two conditions.
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
    await recordShapingOutcome("shape", env);

    const lines = await liveWatchLines(env, () => appendReceipt(fullApplyReceipt("ffff1111222233334444555566667777")));
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("basic shaping");
  });

  it("CONTROL: the same live follow loop DOES label a non-apply turn `basic shaping`", async () => {
    // Identical harness, identical recorded shaping outcome; only the receipt differs. Without this
    // the case above could pass simply because `lastTurnWasShaped` never became true.
    const env = { COMPACTION_CONFIG_DIR: observeCfg } as NodeJS.ProcessEnv;
    await recordShapingOutcome("shape", env);

    const lines = await liveWatchLines(env, () => appendReceipt(recordReceipt("aaaa9999222233334444555566667777")));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("basic shaping");
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
