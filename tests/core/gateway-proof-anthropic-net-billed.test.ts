import { describe, expect, it } from "vitest";
import { buildGatewayReceipt } from "../../src/core/gateway/receipt.js";
import { compareGatewayProof, formatGatewayProof, proofSummaryFromReceipt } from "../../src/core/gateway/proof.js";
import { anthropicAdapter } from "../../src/core/gateway/provider-adapters-multi.js";

/**
 * Anthropic net fresh-BILLED A/B: the SAME proof math (`compareGatewayProof`) applied to ANTHROPIC receipts.
 *
 * Anthropic reports `input_tokens` as the FRESH (non-cached) count and `cache_read_input_tokens` as the
 * cached portion SEPARATELY. The adapter normalizes to the gateway-neutral shape (prompt_input = fresh +
 * cached, cached_input = cache_read), so fresh-billed = prompt_input − cached_input = Anthropic's own
 * `input_tokens`. This proves the net-billed delta = baseline fresh-billed − compacted fresh-billed is
 * computed correctly for Anthropic — INCLUDING the negative cache-busting case (surfaced honestly, never
 * floored) and the both-arms-provider-reported-or-unavailable rule.
 */
const SECRET = "prompt completion message content must not leak";

function anthropicBody(input: number | undefined, cacheRead: number | undefined): string {
  return JSON.stringify({
    model: "claude-3-5-haiku-latest",
    content: [{ type: "text", text: SECRET }],
    ...(input === undefined
      ? {}
      : {
          usage: {
            input_tokens: input,
            output_tokens: 8,
            ...(cacheRead === undefined ? {} : { cache_read_input_tokens: cacheRead })
          }
        })
  });
}

function anthropicReceipt(
  input: number | undefined,
  cacheRead: number | undefined,
  proofRunId = "a1",
  variant: "baseline" | "compacted" = "baseline"
) {
  // Build the receipt from the ANTHROPIC adapter's normalized usage (the real record-mode path).
  const usage = anthropicAdapter.extractUsage(anthropicBody(input, cacheRead));
  return buildGatewayReceipt({
    provider: "anthropic",
    endpoint: "/v1/messages",
    mode: "record",
    upstreamStatus: 200,
    // proof.ts consumes prompt_input + cached_input off the receipt (via proofSummaryFromReceipt); the
    // adapter's NormalizedUsage maps 1:1 onto the OpenAiUsageBreakdown shape the builder expects.
    usage: {
      present: usage.source === "provider-reported",
      ...(usage.inputTokens !== undefined ? { promptInputTokens: usage.inputTokens } : {}),
      ...(usage.cachedInputTokens !== undefined ? { cachedInputTokens: usage.cachedInputTokens } : {}),
      ...(usage.freshInputTokens !== undefined ? { billedFreshInputTokens: usage.freshInputTokens } : {}),
      ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
      ...(usage.model ? { model: usage.model } : {}),
      ...(usage.source === "unavailable" ? { unavailableReason: usage.unavailableReason } : {})
    },
    proofRunId,
    proofVariant: variant,
    now: () => "1970-01-01T00:00:00.000Z",
    id: () => "rid"
  });
}

function abDelta(baseline: ReturnType<typeof anthropicReceipt>, compacted: ReturnType<typeof anthropicReceipt>, proofRunId = "a1") {
  return compareGatewayProof({
    proofRunId,
    baseline: proofSummaryFromReceipt(baseline),
    compacted: proofSummaryFromReceipt(compacted)
  });
}

describe("Anthropic net fresh-billed A/B (same proof math, provider-reported)", () => {
  it("computes a POSITIVE net-billed reduction: baseline fresh 1000 vs compacted fresh 400 (cache read on both)", () => {
    // baseline: input_tokens=1000, cache_read=50 → fresh-billed = 1000. compacted: input_tokens=400,
    // cache_read=600 → fresh-billed = 400. net-billed reduction = 1000 − 400 = 600 (60%).
    const d = abDelta(anthropicReceipt(1000, 50), anthropicReceipt(400, 600, "a1", "compacted"));
    expect(d.available).toBe(true);
    expect(d.beforeFreshInputTokens).toBe(1000);
    expect(d.afterFreshInputTokens).toBe(400);
    expect(d.freshInputReductionAbsolute).toBe(600);
    expect(d.freshInputReductionPercent).toBe(60);
  });

  it("surfaces a NEGATIVE net-billed delta HONESTLY when apply busts the cache (never floored to 0)", () => {
    // baseline: input_tokens=300, cache_read=700 → fresh-billed=300 (most served from cache).
    // compacted (apply): input_tokens=800, cache_read=0 → fresh-billed=800 (cache busted). The model-visible
    // prompt got smaller, but net fresh-BILLED input ROSE 300 → 800: a real, honest negative outcome.
    const d = abDelta(anthropicReceipt(300, 700), anthropicReceipt(800, 0, "a1", "compacted"));
    expect(d.available).toBe(true);
    expect(d.beforeFreshInputTokens).toBe(300);
    expect(d.afterFreshInputTokens).toBe(800);
    expect(d.freshInputReductionAbsolute).toBe(-500); // negative: apply RAISED fresh-billed input
    expect(d.freshInputReductionPercent).toBeLessThan(0);
    const out = formatGatewayProof(d);
    expect(out).toContain("increased by");
    expect(out).not.toContain("reduced by");
    expect(out).not.toContain("Claim: fresh-input reduction");
  });

  it("both-arms-provider-reported: is UNAVAILABLE when one arm has no cache field (never fabricates a zero)", () => {
    // compacted arm reports no cache_read → cachedInputTokens undefined → the proof cannot derive fresh split.
    const d = abDelta(anthropicReceipt(1000, 50), anthropicReceipt(400, undefined, "a1", "compacted"));
    expect(d.available).toBe(false);
    expect(d.reasons.join(" ")).toMatch(/cached_tokens/);
  });

  it("both-arms-provider-reported: is UNAVAILABLE when one arm has no usage at all", () => {
    const d = abDelta(anthropicReceipt(1000, 50), anthropicReceipt(undefined, undefined, "a1", "compacted"));
    expect(d.available).toBe(false);
  });

  it("stays content-free (no prompt/response bytes on the rendered proof)", () => {
    const out = formatGatewayProof(abDelta(anthropicReceipt(1000, 50), anthropicReceipt(400, 600, "a1", "compacted")));
    expect(out).not.toContain(SECRET);
    expect(out).not.toMatch(/prompt|completion|message|content/i);
  });
});
