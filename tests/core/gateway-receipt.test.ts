import { describe, it, expect } from "vitest";
import {
  buildGatewayReceipt,
  freshBilledInputReduction,
  formatFreshBilledInputReduction,
  GATEWAY_RECORD_LABEL
} from "../../src/core/gateway/receipt.js";
import { usageFromResponseBody } from "../../src/core/gateway/openai-usage.js";
import { openAiBreakdownFromNormalizedUsage } from "../../src/core/gateway/provider-adapter.js";
import { anthropicAdapter } from "../../src/core/gateway/provider-adapters-multi.js";
import { receiptLineFromGatewayReceipt } from "../../src/core/gateway/receipt-line.js";

/**
 * Gateway receipt builder. A receipt is CONTENT-FREE. Record mode never mutates
 * (model_visible_bytes_changed:false). CLAIM BOUNDARY: a provider-backed FRESH/BILLED input
 * reduction MAY be displayed when the provider reports cached input tokens; NO model-visible input
 * reduction, output-token reduction, or cost-savings claim is made.
 */

/** Affirmative forbidden CLAIM forms (NOT the disclaimer wording). None may appear on a receipt. */
function assertNoForbiddenClaims(raw: string): void {
  expect(raw).not.toMatch(/reduced model-visible/i);
  expect(raw).not.toMatch(/model-visible input reduced/i);
  expect(raw).not.toMatch(/reduced output token/i);
  expect(raw).not.toMatch(/output tokens? reduced/i);
  expect(raw).not.toMatch(/cost saved|saved cost|cost reduced|saved \$/i);
}

const SECRET = "SECRET_PROMPT_and_completion_marker";
const usage = usageFromResponseBody(
  JSON.stringify({
    model: "gpt-4o-mini",
    choices: [{ message: { content: `reply ${SECRET}` } }],
    usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40 } }
  })
);

const fixed = { now: () => "1970-01-01T00:00:00.000Z", id: () => "rid-fixed" };

describe("buildGatewayReceipt - content-free, record-mode, honest", () => {
  it("carries the honest per-axis token breakdown, record mode, no byte change", () => {
    const r = buildGatewayReceipt({ provider: "openai", endpoint: "/v1/chat/completions", mode: "record", upstreamStatus: 200, usage, ...fixed });
    expect(r.mode).toBe("record");
    expect(r.model_visible_bytes_changed).toBe(false);
    expect(r.model).toBe("gpt-4o-mini");
    expect(r.tokens).toEqual({ prompt_input: 100, cached_input: 40, billed_fresh_input: 60, output: 20 });
    expect(r.token_source).toBe("provider-reported");
    expect(r.cache_source).toBe("provider-reported");
    expect(r.cost_source).toBe("unavailable");
    expect(r.reasons.cost).toMatch(/no cost/i);
    expect(r.approval_status).toBe("not-required");
    expect(r.sync_status).toBe("local-only");
    expect(r.content_uploaded).toBe(false);
    expect(r.claim_scope).toBe("run-scoped");
    expect(r.label).toBe(GATEWAY_RECORD_LABEL);
    // provider-backed fresh/billed input reduction IS displayed (cached 40 of 100 prompt → -40%).
    expect(r.fresh_billed_input_reduction).toEqual({ available: true, pct: 40, note: expect.stringMatching(/cached input tokens/i) });
  });

  it("is CONTENT-FREE + claim boundary: displays fresh/billed reduction, makes no forbidden claim", () => {
    const raw = JSON.stringify(buildGatewayReceipt({ provider: "openai", endpoint: "/v1/chat/completions", mode: "record", upstreamStatus: 200, usage, ...fixed }));
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain("reply");
    // claim boundary: the ALLOWED provider-backed fresh/billed input reduction is present…
    expect(raw).toContain("fresh/billed input");
    expect(raw).toContain("model-visible bytes unchanged");
    // …and NONE of the forbidden claims (model-visible input / output-token reduction / cost saved).
    assertNoForbiddenClaims(raw);
    expect(raw).not.toMatch(/"cost_source":"provider-reported"/);
  });

  it("no usage → token_source unavailable with a reason; cache unavailable; never a silent zero", () => {
    const noUsage = usageFromResponseBody(JSON.stringify({ model: "gpt-4o", choices: [] }));
    const r = buildGatewayReceipt({ provider: "openai", endpoint: "/v1/models", mode: "record", upstreamStatus: 200, usage: noUsage, ...fixed });
    expect(r.token_source).toBe("unavailable");
    expect(r.cache_source).toBe("unavailable");
    expect(r.tokens).toEqual({}); // no counts at all - not zeros
    expect(r.reasons.token).toBeTruthy();
    expect(r.reasons.cache).toBeTruthy();
    // NO cached tokens → fresh/billed reduction UNAVAILABLE (never a zero "savings").
    expect(r.fresh_billed_input_reduction.available).toBe(false);
    expect(r.fresh_billed_input_reduction.pct).toBeUndefined();
  });

  it("falls back to the request model only when the response echoed none", () => {
    const noModel = usageFromResponseBody(JSON.stringify({ usage: { prompt_tokens: 5, completion_tokens: 1 } }));
    const r = buildGatewayReceipt({ provider: "openai", endpoint: "/v1/chat/completions", mode: "record", upstreamStatus: 200, usage: noModel, requestModel: "gpt-5", ...fixed });
    expect(r.model).toBe("gpt-5");
  });
});

describe("freshBilledInputReduction - provider-backed, or unavailable (never zero savings)", () => {
  it("cached present → available with pct = cached/prompt·100 and the allowed display form", () => {
    const r = freshBilledInputReduction({ promptInputTokens: 100, cachedInputTokens: 40 });
    expect(r.available).toBe(true);
    expect(r.pct).toBe(40);
    expect(formatFreshBilledInputReduction(r)).toBe("-40% fresh/billed input");
    expect(r.note).toMatch(/model-visible bytes unchanged/i);
  });

  it("cached absent → UNAVAILABLE (not a 0% savings); the display says so", () => {
    const r = freshBilledInputReduction({ promptInputTokens: 100 });
    expect(r.available).toBe(false);
    expect(r.pct).toBeUndefined();
    expect(formatFreshBilledInputReduction(r)).toBe("fresh/billed input reduction: unavailable");
  });

  it("cached = 0 → UNAVAILABLE (never a zero savings); prompt = 0 → unavailable", () => {
    expect(freshBilledInputReduction({ promptInputTokens: 100, cachedInputTokens: 0 }).available).toBe(false);
    expect(freshBilledInputReduction({ promptInputTokens: 0, cachedInputTokens: 0 }).available).toBe(false);
  });

  it("the display string only ever uses the ALLOWED fresh/billed form (no forbidden claim)", () => {
    const forms = [
      formatFreshBilledInputReduction(freshBilledInputReduction({ promptInputTokens: 200, cachedInputTokens: 50 })),
      formatFreshBilledInputReduction(freshBilledInputReduction({ promptInputTokens: 200 }))
    ].join(" ");
    expect(forms).toContain("fresh/billed input");
    assertNoForbiddenClaims(forms);
  });

  it("heavily-cached turn (TOTAL 66002, cached 66000) → a SANE ~99.997% (never millions)", () => {
    // With the corrected accounting the prompt input is the TOTAL (66002) and cached ⊆ it, so the percent
    // of input served from cache is a sane provider fact just under 100%, not a garbage 3.3M%.
    const r = freshBilledInputReduction({ promptInputTokens: 66002, cachedInputTokens: 66000 });
    expect(r.available).toBe(true);
    expect(r.pct).toBeGreaterThan(99.9);
    expect(r.pct).toBeLessThanOrEqual(100); // bounded, never over 100
    expect(r.pct).toBeCloseTo(100, 1);
  });

  it("inconsistent counts (cached > total prompt input) → UNAVAILABLE, never a >100% garbage number", () => {
    const r = freshBilledInputReduction({ promptInputTokens: 2, cachedInputTokens: 66000 });
    expect(r.available).toBe(false);
    expect(r.pct).toBeUndefined();
    expect(r.note).toMatch(/inconsistent|more cached/i);
  });
});

describe("Anthropic accounting fix - end-to-end receipt + line (the heavily-cached case)", () => {
  // Build a record-mode receipt from a real heavily-cached Anthropic turn through the adapter → bridge.
  function anthropicReceipt(inputTokens: number, cacheRead: number, output = 15) {
    const usageBody = JSON.stringify({
      model: "claude-3-5-sonnet-20241022",
      usage: { input_tokens: inputTokens, output_tokens: output, cache_read_input_tokens: cacheRead }
    });
    const breakdown = openAiBreakdownFromNormalizedUsage(anthropicAdapter.extractUsage(usageBody));
    return buildGatewayReceipt({
      provider: "anthropic",
      endpoint: "/v1/messages",
      mode: "record",
      upstreamStatus: 200,
      usage: breakdown,
      ...fixed
    });
  }

  it("receipt carries TOTAL prompt input (66002), cached (66000), fresh (2); pct is a sane ~100%", () => {
    const r = anthropicReceipt(2, 66000);
    expect(r.tokens.prompt_input).toBe(66002); // TOTAL, not the fresh 2
    expect(r.tokens.cached_input).toBe(66000);
    expect(r.tokens.billed_fresh_input).toBe(2);
    expect(r.fresh_billed_input_reduction.available).toBe(true);
    expect(r.fresh_billed_input_reduction.pct).toBeGreaterThan(99.9);
    expect(r.fresh_billed_input_reduction.pct).toBeLessThanOrEqual(100);
  });

  it("the per-turn receipt LINE renders a sane `input 66,002` (record mode: no minus, never millions)", () => {
    const line = receiptLineFromGatewayReceipt(anthropicReceipt(2, 66000));
    expect(line).toBeTruthy();
    expect(line).toContain("input 66,002"); // TOTAL prompt input, not "input 2"
    // Record mode surfaces a PLAIN input count. Provider prompt-cache is a provider
    // FACT, NOT surfaced on this line at all (carrying it invited the "Compaction reduced my tokens"
    // misread). NO minus sign, NO "reduction", NO mode/source label.
    expect(line).not.toContain("provider-cached");
    expect(line).not.toContain("−"); // NO minus sign anywhere on a record-mode line
    expect(line).not.toMatch(/reduction/i);
    expect(line).not.toContain("record"); // the standalone mode clause is dropped
    expect(line).not.toMatch(/329|3297350|\d{4,}%/); // never the old garbage percentage (>=4 digit %)
    expect(line).not.toContain("%"); // record mode carries no percent at all
  });

  it("reason strings are provider-neutral (no OpenAI copy leaking onto an anthropic receipt)", () => {
    const r = anthropicReceipt(2, 66000);
    // cost is always unavailable on the record path, but the reason must not name a specific provider.
    expect(r.reasons.cost).toMatch(/no cost/i);
    expect(r.reasons.cost).not.toMatch(/openai/i);
    // when a cache reason is emitted it must not reference an OpenAI-only field name.
    const noCache = buildGatewayReceipt({
      provider: "anthropic",
      endpoint: "/v1/messages",
      mode: "record",
      upstreamStatus: 200,
      usage: openAiBreakdownFromNormalizedUsage(
        anthropicAdapter.extractUsage(JSON.stringify({ model: "claude-3-haiku", usage: { input_tokens: 80, output_tokens: 10 } }))
      ),
      ...fixed
    });
    expect(noCache.reasons.cache).toBeTruthy();
    expect(noCache.reasons.cache).not.toMatch(/openai|prompt_tokens_details/i);
  });

  it("no-cache Anthropic turn → pct UNAVAILABLE (no cache hit), a plain input count line", () => {
    const usageBody = JSON.stringify({ model: "claude-3-haiku", usage: { input_tokens: 80, output_tokens: 10 } });
    const breakdown = openAiBreakdownFromNormalizedUsage(anthropicAdapter.extractUsage(usageBody));
    const r = buildGatewayReceipt({ provider: "anthropic", endpoint: "/v1/messages", mode: "record", upstreamStatus: 200, usage: breakdown, ...fixed });
    expect(r.tokens.prompt_input).toBe(80);
    expect(r.tokens.cached_input).toBeUndefined();
    expect(r.fresh_billed_input_reduction.available).toBe(false);
    const line = receiptLineFromGatewayReceipt(r);
    expect(line).toContain("input 80");
    expect(line).not.toContain("cached");
  });
});
