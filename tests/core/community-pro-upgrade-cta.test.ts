import { describe, expect, it } from "vitest";
import {
  communityFullApplyReceiptLine,
  nonApplyReceiptLine,
  receiptCeiling,
  receiptLineFromGatewayReceipt,
  receiptLineOutputOnly
} from "../../src/core/gateway/receipt-line.js";
import { receiptLinesFromJsonl } from "../../src/cli/commands/watch.js";
import {
  COMMUNITY_LIMIT_CLAUSE,
  COMMUNITY_LIMIT_RESETS_PREFIX,
  communityLimitClause,
  upgradeNoticeLines,
  UPGRADE_CTA_LABEL
} from "../../src/core/upgrade-cta.js";
import { hyperlinkTarget, osc8, supportsHyperlinks, terminalHyperlink } from "../../src/core/terminal-hyperlink.js";
import { PRO_PATH, proUrl } from "../../src/core/pro-destination.js";
import { DEFAULT_WEB_ORIGIN } from "../../src/core/web-origin.js";
import type { GatewayReceipt } from "../../src/core/gateway/receipt.js";
import { currentPeriodId, periodEndUtc } from "../../src/core/entitlement/lease.js";

/**
 * THE PAUSE DATE IS DERIVED, NOT WRITTEN DOWN.
 *
 * These fixtures used the literal `"2026-09-01"`. A recorded pause is only rendered with its
 * conversion path while it is still CURRENT (`allowancePauseIsCurrent`), so the literal was a live
 * pause right up to 2026-09-01 UTC and an expired one from that instant on — and ten cases in this
 * file went red on the calendar, with nothing about the product having changed. Bumping the literal
 * only moves the next failure; deriving the date from the CURRENT period means the pause is current
 * whenever the suite runs, on any date.
 */
const CURRENT_PERIOD = currentPeriodId();
const PERIOD_END = periodEndUtc(CURRENT_PERIOD) as string;

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
    tokens: { prompt_input: 1_500, output: 300 },
    fresh_billed_input_reduction: { available: false, note: "no cached tokens reported" },
    token_source: "provider-reported",
    cache_source: "unavailable",
    cost_source: "unavailable",
    reasons: { cost: "provider reports tokens, not billing" },
    claim_scope: "run-scoped",
    approval_status: "auto-applied-by-policy",
    authorization_id: "pref-1234567890abcdef12345678",
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
    estimated_input_tokens_before: 1_500,
    estimated_input_tokens_after: 1_000,
    estimated_model_visible_input_reduction_percent: 33.3,
    token_source_before: "local-estimate",
    applied_components: ["lcm-compaction", "output-shaping"],
    ...over
  });
}

/**
 * A turn refused for allowance: no input compaction happened, output shaping still ran.
 *
 * `all-routes` is what the gateway writes today — the allowance pays for the Hybrid Engine, so a live
 * pause covers every upstream route. The narrower `api-key-route` label is read back only off receipts
 * persisted before that was true, and is exercised deliberately by the historical-replay case below.
 */
function pausedTurn(reason: "exhausted" | "insufficient", over: Partial<GatewayReceipt> = {}): GatewayReceipt {
  return receipt({
    request_mutated: true,
    applied_components: ["output-shaping"],
    allowance_pause: { reason, resets_on: PERIOD_END, scope: "all-routes" },
    ...over
  });
}

describe("the CTA appears exactly when Community input optimization is unavailable", () => {
  it("a HEALTHY Community full-apply turn shows no Pro CTA at all", () => {
    const line = communityFullApplyReceiptLine(healthyFullApply(), undefined, receiptCeiling(healthyFullApply(), PLAIN_ENV));
    expect(line).toBeDefined();
    expect(line).toContain("input 1,500→1,000");
    expect(line).not.toContain(UPGRADE_CTA_LABEL);
    // The stem, so neither the dated clause nor its undated fallback can appear on a healthy turn.
    expect(line).not.toContain("Community limit");
    expect(line).not.toMatch(/https?:\/\//);
  });

  it("allowance EXHAUSTED (remaining 0) → the CTA is visible", () => {
    const r = pausedTurn("exhausted");
    const line = receiptLineFromGatewayReceipt(r, "basic", undefined, undefined, receiptCeiling(r, PLAIN_ENV));
    expect(line).toContain(communityLimitClause(PERIOD_END));
    expect(line).toContain(UPGRADE_CTA_LABEL);
  });

  /** A positive remainder can still be insufficient for one turn, so the receipt carries the pause. */
  it("remaining > 0 but INSUFFICIENT for this turn → the CTA is visible", () => {
    const r = pausedTurn("insufficient");
    const line = receiptLineFromGatewayReceipt(r, "basic", undefined, undefined, receiptCeiling(r, PLAIN_ENV));
    // `insufficient` is the reason the wording has to be reason-neutral: tokens REMAIN on this turn,
    // so "allowance spent" would be false. Naming the reset date says nothing about the balance.
    expect(line).toContain(communityLimitClause(PERIOD_END));
    expect(line).toContain(UPGRADE_CTA_LABEL);
    // NOT a false claim of input compaction: the paused turn compacted nothing, so no arrow may appear.
    expect(line).not.toMatch(/input [\d,]+→/);
  });

  /**
   * A REAL RECEIPT SHAPE, not a hypothetical: the gateway spreads `resets_on` CONDITIONALLY
   * (`server.ts`), so a pause recorded when the period could not be named carries the reason alone.
   * That turn is still a blocked user, and the clause must degrade to its undated form rather than
   * print a dangling prefix or disappear.
   */
  it("a pause recorded with no reset date still names the limit and the way out", () => {
    const r = receipt({
      request_mutated: true,
      applied_components: ["output-shaping"],
      allowance_pause: { reason: "insufficient" }
    } as Partial<GatewayReceipt>);
    const line = receiptLineFromGatewayReceipt(r, "basic", undefined, undefined, receiptCeiling(r, PLAIN_ENV)) as string;
    expect(line).toContain(COMMUNITY_LIMIT_CLAUSE);
    expect(line).not.toContain(COMMUNITY_LIMIT_RESETS_PREFIX);
    expect(line).toContain(UPGRADE_CTA_LABEL);
    expect(line).toContain("input paused");
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
    // THE EVIDENCE IS STILL READ OFF THE RECEIPT, even though the primary line no longer narrates it:
    // the detail surfaces are what state the shaping, and they must not be handed a `true` the
    // receipt does not support.
    expect(ceiling?.outputShapingContinues).toBe(false);
    const line = receiptLineFromGatewayReceipt(r, undefined, undefined, undefined, ceiling);
    expect(line).toContain(UPGRADE_CTA_LABEL);
    expect(line).not.toContain("output shaping continues");
  });

  /**
   * THE SHAPING IS SHOWN, NOT NARRATED. This case used to assert the words `output shaping continues`.
   * The words are gone from the primary line; the FACT is not, and it is now carried by evidence the
   * user can check rather than a caption: the `basic shaping` posture label, on a paused turn whose
   * `apply off` counterpart would read very differently.
   */
  it("still shows that shaping ran on a paused turn — as a posture label, not a caption", () => {
    const shaped = pausedTurn("exhausted");
    const line = receiptLineFromGatewayReceipt(shaped, "basic", undefined, undefined, receiptCeiling(shaped, PLAIN_ENV));
    expect(line).toContain("basic shaping");
    expect(line).toContain(communityLimitClause(PERIOD_END));
    expect(line).not.toContain("output shaping continues");
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
    const line = receiptLineFromGatewayReceipt(r, "basic", undefined, undefined, receiptCeiling(r, LINKING_ENV));
    expect(line).toBeDefined();
    expect(hyperlinkTarget(line as string)).toBe(proUrl(LINKING_ENV));
    // The clickable form shows the LABEL, not a raw URL, in the visible text.
    expect(line).toContain(UPGRADE_CTA_LABEL);
  });

  it("follows an overridden destination rather than a second hardcoded URL", () => {
    const staging = { ...LINKING_ENV, COMPACTION_PRO_URL: "https://staging.example/waitlist?plan=pro" } as NodeJS.ProcessEnv;
    const r = pausedTurn("exhausted");
    const line = receiptLineFromGatewayReceipt(r, "basic", undefined, undefined, receiptCeiling(r, staging));
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
      upgradeNoticeLines({ reason: "exhausted", resetsOn: PERIOD_END, scope: "all-routes", env: PLAIN_ENV }).join("\n"),
      upgradeNoticeLines({ reason: "insufficient", env: PLAIN_ENV }).join("\n"),
      receiptLineFromGatewayReceipt(pausedTurn("insufficient"), "basic", undefined, undefined, receiptCeiling(pausedTurn("insufficient"), PLAIN_ENV)) ?? "",
      receiptLineOutputOnly({
        outputTokens: 300,
        providerReported: true,
        shapingActive: true,
        tier: "basic",
        ceiling: { reason: "exhausted", resetsOn: PERIOD_END, ctaEnv: PLAIN_ENV }
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
    //
    // THE STATE IS PART OF THE ROW, not decoration. This block asserts that the line built directly and
    // the line `watch` replays are the SAME string, and the replay path derives the Open label from
    // `output_shaping_state` (`openLineForTurn`), which fails closed on a receipt that records none.
    // A turn the gateway shaped writes `attached-this-pass`, so that is what this fixture carries; a
    // legacy receipt genuinely has no label to replay, and is pinned in
    // `tests/cli/watch-tier-label-provenance.test.ts` instead of being smuggled in here.
    receipt({
      receipt_id: "aaaaaaaa-0000-0000-0000-000000000001",
      request_mutated: true,
      tokens: { prompt_input: 12_004, output: 210 },
      applied_components: ["output-shaping"],
      output_shaping_state: "attached-this-pass"
    }),
    // B — a real full-apply turn.
    healthyFullApply({ receipt_id: "bbbbbbbb-0000-0000-0000-000000000002" }),
    // C — another full-apply turn, with ITS OWN values.
    healthyFullApply({
      receipt_id: "cccccccc-0000-0000-0000-000000000003",
      tokens: { prompt_input: 1_200, output: 415 },
      estimated_input_tokens_before: 1_200,
      estimated_input_tokens_after: 900,
      estimated_model_visible_input_reduction_percent: 26.7
    }),
    // D — the allowance cannot cover this turn.
    pausedTurn("insufficient", {
      receipt_id: "dddddddd-0000-0000-0000-000000000004",
      tokens: { prompt_input: 1_500, output: 288 },
      // Input optimization is what the ceiling paused; shaping still rode this request. Same reason as
      // turn A: the replayed label reads the state, so the fixture has to record it.
      output_shaping_state: "attached-this-pass"
    })
  ];

  const lines = turns.map(
    (r) => communityFullApplyReceiptLine(r, undefined, receiptCeiling(r, PLAIN_ENV)) ??
      receiptLineFromGatewayReceipt(r, "basic", undefined, undefined, receiptCeiling(r, PLAIN_ENV)) ??
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
    expect(lines[1]).toContain("input 1,500→1,000");
    expect(lines[2]).toContain("input 1,200→900");
    // Turn C is not a repeat of turn B.
    expect(lines[2]).not.toContain("1,000");
  });

  it("no earlier turn's reduction or ceiling leaks forward, and no later one leaks back", () => {
    // The ceiling belongs to turn D alone.
    for (const line of lines.slice(0, 3)) expect(line).not.toContain(UPGRADE_CTA_LABEL);
    expect(lines[3]).toContain(UPGRADE_CTA_LABEL);
    // Turn D compacted nothing, so neither predecessor's arrow may survive onto it.
    expect(lines[3]).not.toMatch(/input [\d,]+→/);
    expect(lines[3]).not.toContain("1,000");
    expect(lines[3]).not.toContain("900");
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

/**
 * THE ALLOWANCE COUNTDOWN ACROSS SURFACES.
 *
 * §6's requirement is that the healthy-turn countdown agrees with `compaction usage` and reaches every
 * surface without any of them consulting live state. Both figures ride the RECEIPT, so `watch` replays
 * the balance of the turn it is replaying rather than today's — the same rule the ceiling already
 * follows — and the statusline render loop performs no file read and no network call to produce it.
 *
 * It is also a COMMUNITY clause. An Open device has no metered allowance to count down, so an Open
 * render of the very same receipt must not acquire one.
 */
describe("the healthy allowance countdown rides the receipt onto every surface", () => {
  const turnB = healthyFullApply({
    receipt_id: "bbbbbbbb-1111-1111-1111-111111111111",
    allowance_snapshot: { remaining_tokens: 1_823_400, period_total_tokens: 2_000_000, period_id: "2026-08" }
  });
  const turnC = healthyFullApply({
    receipt_id: "cccccccc-1111-1111-1111-111111111111",
    tokens: { prompt_input: 1_200, output: 415 },
    estimated_input_tokens_before: 1_200,
    estimated_input_tokens_after: 900,
    estimated_model_visible_input_reduction_percent: 26.7,
    allowance_snapshot: { remaining_tokens: 1_806_800, period_total_tokens: 2_000_000, period_id: "2026-08" }
  });

  function communityLine(r: GatewayReceipt): string {
    return communityFullApplyReceiptLine(r, undefined, receiptCeiling(r, PLAIN_ENV)) ?? "";
  }

  it("renders on a healthy Community turn, with no CTA and no pause claim beside it", () => {
    const line = communityLine(turnB);
    expect(line).toContain("1.82M/2M left");
    expect(line).not.toContain(UPGRADE_CTA_LABEL);
    expect(line).not.toContain("paused");
  });

  it("each turn carries ITS OWN balance — no earlier turn's countdown leaks forward", () => {
    expect(communityLine(turnB)).toContain("1.82M/2M left");
    expect(communityLine(turnC)).toContain("1.8M/2M left");
    expect(communityLine(turnC)).not.toContain("1.82M");
  });

  it("`compaction watch` replays the same countdowns, in order, from the receipts alone", () => {
    const jsonl = [turnB, turnC].map((r) => JSON.stringify(r)).join("\n");
    const replayed = receiptLinesFromJsonl(jsonl, { productTier: "full", env: PLAIN_ENV });
    expect(replayed).toEqual([communityLine(turnB), communityLine(turnC)]);
  });

  it("an OPEN render of the SAME receipt carries no Community budget clause", () => {
    // Open has no metered allowance, so the clause has nothing to describe. Pinned on the same receipt
    // object rather than a stripped copy, so the guard is about the BUILDER and not about the fixture.
    const open = receiptLineFromGatewayReceipt(turnB, "basic", undefined, undefined, receiptCeiling(turnB, PLAIN_ENV));
    expect(open).toBeDefined();
    expect(open).not.toContain("left");
    expect(open).not.toContain("2M");
  });

  it("a PAUSED turn states the pause instead — one line never both counts down and pauses", () => {
    const paused = pausedTurn("exhausted", {
      receipt_id: "eeeeeeee-1111-1111-1111-111111111111",
      allowance_snapshot: { remaining_tokens: 1_823_400, period_total_tokens: 2_000_000, period_id: "2026-08" }
    });
    const line =
      communityFullApplyReceiptLine(paused, undefined, receiptCeiling(paused, PLAIN_ENV)) ??
      receiptLineFromGatewayReceipt(paused, "basic", undefined, undefined, receiptCeiling(paused, PLAIN_ENV)) ??
      "";
    expect(line).not.toContain("1.82M/2M left");
    expect(line).toContain(UPGRADE_CTA_LABEL);
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

/** A synthetic shaping-only ceiling receipt must never masquerade as input optimization. */
describe("a shaping-only ceiling turn does not claim an input reduction", () => {
  const SYNTHETIC_RECEIPT = {
    receipt_id: "11111111-1111-4111-8111-111111111111",
    captured_at: "2026-01-02T03:04:05.000Z",
    provider: "anthropic",
    model: "claude-haiku-4-5-20251001",
    endpoint: "/v1/messages",
    mode: "apply",
    request_mutated: true,
    policy: "deterministic-dedupe",
    estimated_input_tokens_before: 1000,
    estimated_input_tokens_after: 1100,
    tokens: { prompt_input: 1050, cached_input: 0, billed_fresh_input: 1050, output: 25 },
    applied_components: ["output-shaping"]
  } as unknown as GatewayReceipt;
  const SAVED = { calibrated: true, tokensSaved: 20, basis: "default-prior" as const };

  function lineFor(pause?: Record<string, unknown>): string {
    const r = (pause === undefined ? SYNTHETIC_RECEIPT : { ...SYNTHETIC_RECEIPT, allowance_pause: pause }) as GatewayReceipt;
    const ceiling = receiptCeiling(r, PLAIN_ENV);
    return communityFullApplyReceiptLine(r, SAVED, ceiling) ?? nonApplyReceiptLine(r, SAVED, undefined, ceiling) ?? "";
  }

  it("pins the synthetic shaping-only conditions", () => {
    expect(SYNTHETIC_RECEIPT.estimated_input_tokens_before).toBe(1000);
    expect(SYNTHETIC_RECEIPT.estimated_input_tokens_after).toBe(1100);
    expect(SYNTHETIC_RECEIPT.request_mutated).toBe(true);
    expect(SYNTHETIC_RECEIPT.applied_components).toEqual(["output-shaping"]);
    expect(SYNTHETIC_RECEIPT.tokens.output).toBe(25);
  });

  it("refuses private Full posture when only output shaping ran", () => {
    const line = lineFor();
    expect(line).toContain("input 1,050");
    expect(line).toContain("output");
    expect(line).not.toContain("full apply");
    expect(line).not.toContain("1,000");
    expect(line).not.toContain("1,100");
    expect(line).not.toContain("→1,100");
  });

  it("states the pause on the input axis instead of a fabricated reduction", () => {
    const line = lineFor({ reason: "exhausted", resets_on: PERIOD_END, scope: "all-routes" });
    expect(line).toContain("input paused");
    expect(line).not.toContain("1,000");
    expect(line).not.toContain("1,100");
    // The reduction glyph must not appear on the input axis at all. Nor, on this device, on the output
    // axis: shaping really did run, but no experiment on this machine ever measured what it removed.
    expect(line.split(" · output ")[0]).not.toContain("−");
    expect(line).not.toContain("−47%");
  });

  it("never gives the shaping-only turn a `full apply` label", () => {
    expect(lineFor({ reason: "exhausted", scope: "all-routes" })).not.toContain("full apply");
    expect(lineFor()).not.toContain("full apply");
  });

  it("gives that turn the conversion path it never had", () => {
    const line = lineFor({ reason: "exhausted", resets_on: PERIOD_END, scope: "all-routes" });
    expect(line).toContain(UPGRADE_CTA_LABEL);
    expect(line).toContain(proUrl(PLAIN_ENV));
    expect(line).toContain(communityLimitClause(PERIOD_END));
    // NO SCOPE, AND THE DATE ONLY INSIDE THE CLAUSE. The clause states when the limit resets and
    // stops; the scope and the shaping are stated in sentences on the detail surfaces, and the date
    // must not ALSO reappear in a second narrating clause beside it.
    expect(line).not.toContain("input optimization paused");
    expect(line).not.toContain("API-key input optimization");
    expect(line).not.toContain(`until ${PERIOD_END}`);
    expect(line.split(PERIOD_END).length - 1).toBe(1);
  });

  it("REPLAYS a historical `api-key-route` pause without restating it as today's rule", () => {
    // Receipts outlive the contract that wrote them. A pause persisted while metering was api-key-only
    // said something narrower and true then. The old fix was to QUALIFY the pause sentence; the
    // clause no longer HAS a pause sentence, so there is nothing left to misqualify — WHEN the limit
    // resets is true under either scope, because it names no traffic at all.
    const line = lineFor({ reason: "exhausted", resets_on: PERIOD_END, scope: "api-key-route" });
    expect(line).toContain(communityLimitClause(PERIOD_END));
    expect(line).toContain(COMMUNITY_LIMIT_RESETS_PREFIX);
    expect(line).not.toContain("API-key");
    expect(line).not.toContain("paused until");
    // ...and the qualification survives where it is actually read.
    const detail = upgradeNoticeLines({ reason: "exhausted", resetsOn: PERIOD_END, scope: "api-key-route", env: PLAIN_ENV }).join("\n");
    expect(detail).toContain("Community input optimization on API-key routed turns is paused");
    expect(detail).toContain("Subscription-routed turns are unaffected.");
    expect(detail).toContain(`It resumes ${PERIOD_END}.`);
  });

  it("no longer narrates shaping on the line, and still says it on the detail surface", () => {
    expect(lineFor({ reason: "exhausted", scope: "all-routes" })).not.toContain("output shaping continues");
    const noShaping = { ...SYNTHETIC_RECEIPT, applied_components: [], allowance_pause: { reason: "exhausted" } } as unknown as GatewayReceipt;
    const ceiling = receiptCeiling(noShaping, PLAIN_ENV);
    const line = communityFullApplyReceiptLine(noShaping, SAVED, ceiling) ??
      nonApplyReceiptLine(noShaping, SAVED, undefined, ceiling) ?? "";
    expect(line).not.toContain("output shaping continues");
    expect(line).toContain(UPGRADE_CTA_LABEL);
    expect(upgradeNoticeLines({ reason: "exhausted", scope: "all-routes", env: PLAIN_ENV })).toContain("Output shaping remains active.");
  });
});
