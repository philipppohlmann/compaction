import { describe, expect, it } from "vitest";
import {
  communityFullApplyReceiptLine,
  receiptCeiling,
  receiptLineFromGatewayReceipt,
  receiptLineOutputOnly
} from "../../src/core/gateway/receipt-line.js";
import { receiptLinesFromJsonl } from "../../src/cli/commands/watch.js";
import { upgradeNoticeLines, UPGRADE_CTA_LABEL } from "../../src/core/upgrade-cta.js";
import { hyperlinkTarget, osc8, supportsHyperlinks, terminalHyperlink } from "../../src/core/terminal-hyperlink.js";
import { PRO_PATH, proUrl } from "../../src/core/pro-destination.js";
import { DEFAULT_WEB_ORIGIN } from "../../src/core/web-origin.js";
import type { GatewayReceipt } from "../../src/core/gateway/receipt.js";

/**
 * COMMUNITY → PRO CONVERSION UX.
 *
 * The defect these close: a Community user whose optimized-input allowance could not cover a turn had
 * input optimization silently paused, was (at best) told so, and was given NO reachable way to convert.
 * The per-turn line named a command and explicitly refused to carry a URL; `usage` and `lease status`
 * named neither. The rules pinned here:
 *
 *   1. The CTA appears when — and ONLY when — Community input optimization is unavailable for the
 *      allowance, on BOTH causes (`exhausted` AND `insufficient`). A healthy turn carries none.
 *   2. It is CLICKABLE where the terminal supports OSC 8, and carries the URL in plain text where it
 *      does not. Either way the destination survives.
 *   3. There is ONE destination, resolved through `proUrl`, on every surface.
 *   4. Nothing navigates on its own. The user chooses to click.
 */

/** A terminal that renders OSC 8, so the CTA is emitted as an encoded link. */
const LINKING_ENV = { COMPACTION_HYPERLINKS: "1" } as NodeJS.ProcessEnv;
/** A terminal that does not, so the CTA degrades to `label: url`. */
const PLAIN_ENV = { COMPACTION_HYPERLINKS: "0" } as NodeJS.ProcessEnv;

function receipt(over: Partial<GatewayReceipt> = {}): GatewayReceipt {
  return {
    receipt_id: "11111111-2222-3333-4444-555555555555",
    captured_at: "2026-08-17T10:00:00.000Z",
    provider: "anthropic",
    model: "claude-opus-5",
    endpoint: "/v1/messages",
    mode: "apply",
    upstream_status: 200,
    model_visible_bytes_changed: true,
    tokens: { prompt_input: 75_946, output: 300 },
    fresh_billed_input_reduction: { available: false, note: "no cached tokens reported" },
    token_source: "provider-reported",
    cache_source: "unavailable",
    cost_source: "unavailable",
    reasons: { cost: "provider reports tokens, not billing" },
    claim_scope: "run-scoped",
    approval_status: "auto-applied-by-policy",
    sync_status: "local-only",
    content_uploaded: false,
    label: "apply",
    ...over
  };
}

/** A healthy Community full-apply turn: input really was compacted, and it was paid for. */
function healthyFullApply(over: Partial<GatewayReceipt> = {}): GatewayReceipt {
  return receipt({
    request_mutated: true,
    estimated_input_tokens_before: 75_946,
    estimated_input_tokens_after: 51_682,
    estimated_model_visible_input_reduction_percent: 31.9,
    token_source_before: "local-estimate",
    applied_components: ["lcm-compaction", "output-shaping"],
    ...over
  });
}

/** A turn refused for allowance: no input compaction happened, output shaping still ran. */
function pausedTurn(reason: "exhausted" | "insufficient", over: Partial<GatewayReceipt> = {}): GatewayReceipt {
  return receipt({
    request_mutated: true,
    applied_components: ["output-shaping"],
    allowance_pause: { reason, resets_on: "2026-09-01", scope: "api-key-route" },
    ...over
  });
}

describe("the CTA appears exactly when Community input optimization is unavailable", () => {
  it("a HEALTHY Community full-apply turn shows no Pro CTA at all", () => {
    const line = communityFullApplyReceiptLine(healthyFullApply(), undefined, receiptCeiling(healthyFullApply(), PLAIN_ENV));
    expect(line).toBeDefined();
    // The real receipt values still render — the healthy path is untouched by this work.
    expect(line).toContain("input 75,946→51,682");
    expect(line).not.toContain(UPGRADE_CTA_LABEL);
    expect(line).not.toContain("Community limit reached");
    expect(line).not.toMatch(/https?:\/\//);
  });

  it("allowance EXHAUSTED (remaining 0) → the CTA is visible", () => {
    const r = pausedTurn("exhausted");
    const line = receiptLineFromGatewayReceipt(r, "basic", undefined, undefined, undefined, receiptCeiling(r, PLAIN_ENV));
    expect(line).toContain("Community limit reached");
    expect(line).toContain(UPGRADE_CTA_LABEL);
  });

  /**
   * THE CASE THE PRODUCT COULD NOT EXPRESS BEFORE, and the one actually observed: 44,054 tokens
   * remaining against a 75,946-token eligible turn. `resolveOpenTier` fires on `remaining <= 0` only,
   * so session state calls this device healthy. The pause rides the RECEIPT precisely so this turn is
   * not silent.
   */
  it("remaining > 0 but INSUFFICIENT for this turn → the CTA is visible", () => {
    const r = pausedTurn("insufficient");
    const line = receiptLineFromGatewayReceipt(r, "basic", undefined, undefined, undefined, receiptCeiling(r, PLAIN_ENV));
    expect(line).toContain("Community limit reached");
    expect(line).toContain(UPGRADE_CTA_LABEL);
    // NOT a false claim of input compaction: the paused turn compacted nothing, so no arrow may appear.
    expect(line).not.toMatch(/input [\d,]+→/);
  });

  it("a paused turn NEVER claims an input reduction and never carries an apply label", () => {
    for (const reason of ["exhausted", "insufficient"] as const) {
      const r = pausedTurn(reason);
      expect(communityFullApplyReceiptLine(r, undefined, receiptCeiling(r, PLAIN_ENV)), reason).toBeUndefined();
    }
  });

  /**
   * A TASK-AWARE HOLD AT THE CEILING. Output shaping fires on prose turns and not on tool-call turns,
   * so a paused turn can leave the body unchanged. The user is blocked either way and the CTA must
   * still appear — but the line must NOT then claim a shaping that did not happen.
   */
  it("shows the CTA on a held turn, without claiming output shaping ran", () => {
    const r = pausedTurn("insufficient", { applied_components: [], request_mutated: false });
    const ceiling = receiptCeiling(r, PLAIN_ENV);
    expect(ceiling?.outputShapingContinues).toBe(false);
    const line = receiptLineFromGatewayReceipt(r, undefined, undefined, undefined, undefined, ceiling);
    expect(line).toContain(UPGRADE_CTA_LABEL);
    expect(line).not.toContain("output shaping continues");
  });

  it("says output shaping continues ONLY when the receipt's own components record it", () => {
    const shaped = pausedTurn("exhausted");
    const line = receiptLineFromGatewayReceipt(shaped, "basic", undefined, undefined, undefined, receiptCeiling(shaped, PLAIN_ENV));
    expect(line).toContain("output shaping continues");
  });
});

describe("the CTA is clickable, and points at the ONE canonical destination", () => {
  it("resolves to the canonical Pro waitlist route", () => {
    expect(proUrl({} as NodeJS.ProcessEnv)).toContain(PRO_PATH);
  });

  /**
   * The encoded link target. A rendered per-turn line is parsed back through `hyperlinkTarget`,
   * so this asserts the bytes a terminal would actually follow, not the label beside them.
   */
  it("the OSC 8 hyperlink target on a rendered per-turn line IS proUrl", () => {
    const r = pausedTurn("insufficient");
    const line = receiptLineFromGatewayReceipt(r, "basic", undefined, undefined, undefined, receiptCeiling(r, LINKING_ENV));
    expect(line).toBeDefined();
    expect(hyperlinkTarget(line as string)).toBe(proUrl(LINKING_ENV));
    // The clickable form shows the LABEL, not a raw URL, in the visible text.
    expect(line).toContain(UPGRADE_CTA_LABEL);
  });

  it("follows an overridden destination rather than a second hardcoded URL", () => {
    const staging = { ...LINKING_ENV, COMPACTION_PRO_URL: "https://staging.example/waitlist?plan=pro" } as NodeJS.ProcessEnv;
    const r = pausedTurn("exhausted");
    const line = receiptLineFromGatewayReceipt(r, "basic", undefined, undefined, undefined, receiptCeiling(r, staging));
    expect(hyperlinkTarget(line as string)).toBe("https://staging.example/waitlist?plan=pro");
    expect(line).not.toContain(new URL(DEFAULT_WEB_ORIGIN).hostname);
  });

  it("degrades to plain `label: url` where the terminal does not support OSC 8 — never a bare label", () => {
    const rendered = terminalHyperlink(UPGRADE_CTA_LABEL, proUrl(PLAIN_ENV), PLAIN_ENV);
    expect(hyperlinkTarget(rendered)).toBeUndefined();
    expect(rendered).toBe(`${UPGRADE_CTA_LABEL}: ${proUrl(PLAIN_ENV)}`);
  });

  it("is FAIL-CLOSED: an unknown terminal, NO_COLOR, TERM=dumb and CI all render plain text", () => {
    for (const env of [{}, { NO_COLOR: "1" }, { TERM: "dumb" }, { CI: "true" }, { TERM_PROGRAM: "Apple_Terminal" }]) {
      expect(supportsHyperlinks(env as NodeJS.ProcessEnv), JSON.stringify(env)).toBe(false);
    }
    // ...and known-good terminals do link, so the fail-closed default is not simply "never".
    for (const env of [{ TERM_PROGRAM: "iTerm.app" }, { WT_SESSION: "x" }, { TERM: "xterm-kitty" }, { VTE_VERSION: "6003" }]) {
      expect(supportsHyperlinks(env as NodeJS.ProcessEnv), JSON.stringify(env)).toBe(true);
    }
  });

  it("EVERY state surface resolves the same destination and names no second one", () => {
    const surfaces = [
      upgradeNoticeLines({ reason: "exhausted", resetsOn: "2026-09-01", scope: "api-key-route", env: PLAIN_ENV }).join("\n"),
      upgradeNoticeLines({ reason: "insufficient", env: PLAIN_ENV }).join("\n"),
      receiptLineFromGatewayReceipt(pausedTurn("insufficient"), "basic", undefined, undefined, undefined, receiptCeiling(pausedTurn("insufficient"), PLAIN_ENV)) ?? "",
      receiptLineOutputOnly({
        outputTokens: 300,
        providerReported: true,
        shapingActive: true,
        tier: "basic",
        ceiling: { reason: "exhausted", resetsOn: "2026-09-01", ctaEnv: PLAIN_ENV }
      }) ?? ""
    ];
    for (const s of surfaces) {
      const urls = s.match(/https?:\/\/\S+/g) ?? [];
      expect(urls, s).toEqual([proUrl(PLAIN_ENV)]);
    }
  });
});

/**
 * PER-TURN LINKAGE. A line the user reads mid-turn must describe THAT turn. The failure this
 * pins is a stale line: turn N rendering turn N-1's numbers, id, or ceiling state.
 */
describe("sequential turns produce sequential, non-stale lines", () => {
  const turns: GatewayReceipt[] = [
    // A — shaping-only warm-up. No input compaction, so no input arrow may appear.
    receipt({
      receipt_id: "aaaaaaaa-0000-0000-0000-000000000001",
      request_mutated: true,
      tokens: { prompt_input: 12_004, output: 210 },
      applied_components: ["output-shaping"]
    }),
    // B — a real full-apply turn.
    healthyFullApply({ receipt_id: "bbbbbbbb-0000-0000-0000-000000000002" }),
    // C — another full-apply turn, with ITS OWN values.
    healthyFullApply({
      receipt_id: "cccccccc-0000-0000-0000-000000000003",
      tokens: { prompt_input: 61_220, output: 415 },
      estimated_input_tokens_before: 61_220,
      estimated_input_tokens_after: 44_900,
      estimated_model_visible_input_reduction_percent: 26.7
    }),
    // D — the allowance cannot cover this turn.
    pausedTurn("insufficient", {
      receipt_id: "dddddddd-0000-0000-0000-000000000004",
      tokens: { prompt_input: 75_946, output: 288 }
    })
  ];

  const lines = turns.map(
    (r) => communityFullApplyReceiptLine(r, undefined, receiptCeiling(r, PLAIN_ENV)) ??
      receiptLineFromGatewayReceipt(r, "basic", undefined, undefined, undefined, receiptCeiling(r, PLAIN_ENV)) ??
      ""
  );

  it("renders four DISTINCT lines, each carrying its own receipt id", () => {
    expect(new Set(lines).size).toBe(4);
    for (const [i, line] of lines.entries()) {
      expect(line, `turn ${i + 1}`).toContain(turns[i]!.receipt_id.slice(0, 8));
    }
  });

  it("turn A claims NO input saving (shaping-only), and turns B/C claim their own", () => {
    expect(lines[0]).not.toMatch(/input [\d,]+→/);
    expect(lines[1]).toContain("input 75,946→51,682");
    expect(lines[2]).toContain("input 61,220→44,900");
    // Turn C is not a repeat of turn B.
    expect(lines[2]).not.toContain("51,682");
  });

  it("no earlier turn's reduction or ceiling leaks forward, and no later one leaks back", () => {
    // The ceiling belongs to turn D alone.
    for (const line of lines.slice(0, 3)) expect(line).not.toContain(UPGRADE_CTA_LABEL);
    expect(lines[3]).toContain(UPGRADE_CTA_LABEL);
    // Turn D compacted nothing, so neither predecessor's arrow may survive onto it.
    expect(lines[3]).not.toMatch(/input [\d,]+→/);
    expect(lines[3]).not.toContain("51,682");
    expect(lines[3]).not.toContain("44,900");
  });

  it("`compaction watch` replays the SAME lines in the SAME order", () => {
    const jsonl = turns.map((r) => JSON.stringify(r)).join("\n");
    const replayed = receiptLinesFromJsonl(jsonl, { productTier: "full", env: PLAIN_ENV });
    expect(replayed).toEqual(lines);
  });

  /**
   * REPLAY CARRIES THE TURN'S OWN CEILING, not today's session state — the header says that. A paused
   * turn stays paused on replay however the device is configured now, which is what makes `watch`
   * checkable against the line the user saw live.
   */
  it("a replayed paused turn keeps its CTA, and a replayed healthy turn never gains one", () => {
    const replayed = receiptLinesFromJsonl(turns.map((r) => JSON.stringify(r)).join("\n"), {
      productTier: "full",
      env: PLAIN_ENV
    });
    expect(replayed.filter((l) => l.includes(UPGRADE_CTA_LABEL))).toHaveLength(1);
    expect(replayed.at(-1)).toContain(UPGRADE_CTA_LABEL);
  });
});

describe("nothing navigates by itself", () => {
  /**
   * A ceiling turn must not open a browser, and ceiling turns repeat. The rendering path is
   * proven inert by CONSTRUCTION rather than by observing one call: `osc8` returns a string built from
   * its arguments, and neither it nor anything it reaches can perform an action.
   */
  it("the CTA is a string, and the modules that build it import nothing that can navigate", async () => {
    const rendered = osc8(UPGRADE_CTA_LABEL, proUrl(LINKING_ENV));
    expect(typeof rendered).toBe("string");
    const { readFileSync } = await import("node:fs");
    for (const file of ["src/core/upgrade-cta.ts", "src/core/terminal-hyperlink.ts", "src/core/pro-destination.ts"]) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/openBrowser|child_process|\bopen\(/);
    }
  });
});

/**
 * THE CAPTURED DEFECT, PINNED.
 *
 * Receipt `e64ff2cb-a9c8-48b0-a6e3-48e5b770a551` is a REAL post-ceiling turn recorded on 2026-08-22
 * against the live Anthropic endpoint, in the run that first reached the Community allowance ceiling.
 * The allowance was spent, so NO input optimization ran — but output shaping still rewrote the request,
 * which set `request_mutated: true` and left an `estimated_input_tokens_*` pair whose "after" is the
 * SHAPED body: 926 → 1,032, i.e. bigger. `isRealApply` therefore answered true, and the shipped line
 * read, verbatim from the run log:
 *
 *   compaction · input 926→1,032 (−-11%) · output 43→23 (−47%, est. · default prior) · full apply · id e64ff2cb
 *
 * Three lies on the one turn where the user most needed the truth: a reduction that did not happen
 * (with a mangled double-minus), a `full apply` label on a refused apply, and no way to convert. The
 * numbers below are that receipt's own; they are counts, so nothing of the prompt travels with them.
 */
describe("the real captured ceiling turn no longer claims a reduction it did not make", () => {
  const CAPTURED = {
    receipt_id: "e64ff2cb-a9c8-48b0-a6e3-48e5b770a551",
    captured_at: "2026-08-22T20:41:00.000Z",
    provider: "anthropic",
    model: "claude-haiku-4-5-20251001",
    endpoint: "/v1/messages",
    mode: "apply",
    request_mutated: true,
    policy: "deterministic-dedupe",
    estimated_input_tokens_before: 926,
    estimated_input_tokens_after: 1032,
    tokens: { prompt_input: 960, cached_input: 0, billed_fresh_input: 960, output: 23 },
    applied_components: ["output-shaping"]
  } as unknown as GatewayReceipt;
  const SAVED = { calibrated: true, tokensSaved: 20, basis: "default-prior" as const };

  function lineFor(pause?: Record<string, unknown>): string {
    const r = (pause === undefined ? CAPTURED : { ...CAPTURED, allowance_pause: pause }) as GatewayReceipt;
    return communityFullApplyReceiptLine(r, SAVED, receiptCeiling(r, PLAIN_ENV)) ?? "";
  }

  it("is still the captured receipt, field for field", () => {
    // FIXTURE FIDELITY, asserted on the RECEIPT rather than on the line it renders. This used to pin the
    // rendered defect string byte-for-byte — which was the right guard while the pause was the only fix,
    // and became the wrong one once the input axis itself was corrected: the renderer no longer produces
    // that string for ANY input, so pinning it would only prove the fixture had been rewritten to keep a
    // dead assertion alive. What must not drift is the capture, so that is what is pinned.
    expect(CAPTURED.estimated_input_tokens_before).toBe(926);
    expect(CAPTURED.estimated_input_tokens_after).toBe(1032); // the SHAPED body — bigger, not smaller
    expect(CAPTURED.request_mutated).toBe(true); // output shaping mutated it, which is what fooled isRealApply
    expect(CAPTURED.applied_components).toEqual(["output-shaping"]); // and nothing compacted input
    expect(CAPTURED.tokens?.output).toBe(23);
  });

  it("no longer renders the fabricated reduction even with NO pause recorded", () => {
    // THE SECOND HALF OF THE SAME DEFECT. The pause clause fixed the line for a turn the gateway KNEW it
    // had refused. This turn is the other case — a shaping-only turn carrying no pause at all — and it
    // rendered `input 926→1,032 (−-11%)` from the same bad inference. The axis now follows
    // `applied_components`, so a turn that compacted nothing shows no before→after: just the plain
    // provider-reported input count, its real output evidence, and the device's tier label.
    const line = lineFor();
    expect(line).toBe(
      "compaction · input 960 · output 43→23 (−47%, est. · default prior) · full apply · id e64ff2cb"
    );
    expect(line).not.toContain("926");
    expect(line).not.toContain("1,032");
    expect(line).not.toContain("→1,032");
    expect(line.split(" · output ")[0]).not.toContain("−"); // no reduction glyph on the input axis
  });

  it("states the pause on the input axis instead of a fabricated reduction", () => {
    const line = lineFor({ reason: "exhausted", resets_on: "2026-09-01", scope: "api-key-route" });
    expect(line).toContain("input paused");
    expect(line).not.toContain("926");
    expect(line).not.toContain("1,032");
    // The reduction glyph must not appear on the input axis at all. The output axis keeps its own
    // (−47%, est. · default prior) — that shaping really did run, and the ceiling leaves its
    // provenance alone.
    expect(line.split(" · output ")[0]).not.toContain("−");
  });

  it("drops the `full apply` label on a turn whose apply was refused", () => {
    expect(lineFor({ reason: "exhausted", scope: "api-key-route" })).not.toContain("full apply");
    // ...and keeps it on the identical turn WITHOUT a pause, so the label was suppressed by the pause
    // and not by some unrelated change to the builder.
    expect(lineFor()).toContain("full apply");
  });

  it("gives that turn the conversion path it never had", () => {
    const line = lineFor({ reason: "exhausted", resets_on: "2026-09-01", scope: "api-key-route" });
    expect(line).toContain(UPGRADE_CTA_LABEL);
    expect(line).toContain(proUrl(PLAIN_ENV));
    expect(line).toContain("Community limit reached");
    // The scope stays named: this pause covers the metered API-key route, and a subscription user
    // reading an unqualified "input optimization paused" would be reading a false statement.
    expect(line).toContain("API-key input optimization paused until 2026-09-01");
  });

  it("says output shaping continues, because THIS receipt's components record that it did", () => {
    expect(lineFor({ reason: "exhausted", scope: "all-routes" })).toContain("output shaping continues");
    const noShaping = { ...CAPTURED, applied_components: [], allowance_pause: { reason: "exhausted" } } as unknown as GatewayReceipt;
    const line = communityFullApplyReceiptLine(noShaping, SAVED, receiptCeiling(noShaping, PLAIN_ENV)) ?? "";
    expect(line).not.toContain("output shaping continues");
    expect(line).toContain(UPGRADE_CTA_LABEL);
  });
});
