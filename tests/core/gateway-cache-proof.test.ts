import { describe, it, expect } from "vitest";
import { buildGatewayReceipt, type GatewayReceipt } from "../../src/core/gateway/receipt.js";
import { usageFromResponseBody } from "../../src/core/gateway/openai-usage.js";
import { summarizeCacheProof, receiptsForProofRun, formatCacheProof } from "../../src/core/gateway/cache-proof.js";

/**
 * Gateway CACHE PROOF pairing. Pairs content-free receipts and surfaces the provider-backed
 * fresh/billed input reduction. Cached present → calculated; cached absent → unavailable (never zero); no
 * forbidden claim (model-visible input / output-token reduction / cost saved) ever appears.
 */

const SECRET = "SECRET_PROOF_completion_do_not_store";
const fixed = { now: () => "1970-01-01T00:00:00.000Z" };

/** A receipt from a Responses-API-shaped body (input_tokens / output_tokens / input_tokens_details.cached_tokens). */
function responsesReceipt(promptInput: number, cached: number | null, output: number, proofRunId: string, idx: number): GatewayReceipt {
  const body = JSON.stringify({
    model: "gpt-4o-mini",
    output: [{ content: [{ text: `reply ${SECRET}` }] }],
    usage: {
      input_tokens: promptInput,
      output_tokens: output,
      ...(cached !== null ? { input_tokens_details: { cached_tokens: cached } } : {})
    }
  });
  return buildGatewayReceipt({
    provider: "openai",
    endpoint: "/v1/responses",
    mode: "record",
    upstreamStatus: 200,
    usage: usageFromResponseBody(body),
    proofRunId,
    id: () => `rid-${idx}`,
    ...fixed
  });
}

/** Forbidden affirmative CLAIM forms (not disclaimer wording). None may appear in a proof artifact. */
function assertNoForbiddenClaims(raw: string): void {
  expect(raw).not.toMatch(/reduced model-visible/i);
  expect(raw).not.toMatch(/model-visible input reduced/i);
  expect(raw).not.toMatch(/reduced output token|output tokens? reduced/i);
  expect(raw).not.toMatch(/cost saved|saved cost|cost reduced|saved \$/i);
}

describe("summarizeCacheProof / formatCacheProof - provider-backed, content-free", () => {
  it("pairs two receipts (cold + cached) into a proof with the best provider-backed reduction", () => {
    const cold = responsesReceipt(5420, 0, 180, "run-1", 1);
    const warm = responsesReceipt(5421, 4912, 176, "run-1", 2);
    const summary = summarizeCacheProof([cold, warm]);

    expect(summary.requests).toHaveLength(2);
    expect(summary.modelVisibleBytesUnchanged).toBe(true);
    expect(summary.bestReduction.available).toBe(true);
    expect(summary.bestReduction.pct).toBe(90.6); // 4912 / 5421 → 90.6%
    expect(summary.requests[1]).toMatchObject({ promptInput: 5421, cachedInput: 4912, freshInput: 509, output: 176 });

    const out = formatCacheProof(summary);
    expect(out).toContain("COMPACTION CACHE PROOF");
    expect(out).toContain("model-visible bytes unchanged");
    expect(out).toContain("fresh/billed input reduction: -90.6%");
    expect(out).toContain("provider-backed cached-input accounting");
    // content-free + no forbidden claim
    expect(out).not.toContain(SECRET);
    assertNoForbiddenClaims(out);
  });

  it("cached tokens ABSENT → reduction unavailable (NOT a zero savings)", () => {
    const r1 = responsesReceipt(500, null, 40, "run-2", 1); // below threshold, no cached tokens reported
    const r2 = responsesReceipt(500, null, 42, "run-2", 2);
    const summary = summarizeCacheProof([r1, r2]);
    expect(summary.bestReduction.available).toBe(false);

    const out = formatCacheProof(summary);
    expect(out).toContain("fresh/billed input reduction: unavailable");
    expect(out).toContain("reason: provider did not report cached input tokens");
    expect(out).not.toMatch(/-0(\.0)?%/); // never present a zero as proof
    assertNoForbiddenClaims(out);
  });

  it("cached = 0 explicitly → still unavailable (never a zero savings)", () => {
    const summary = summarizeCacheProof([responsesReceipt(5000, 0, 50, "run-3", 1)]);
    expect(summary.bestReduction.available).toBe(false);
    expect(formatCacheProof(summary)).toContain("unavailable");
  });

  it("receiptsForProofRun groups by the client-set proof_run_id only", () => {
    const a1 = responsesReceipt(5000, 4000, 20, "A", 1);
    const b1 = responsesReceipt(5000, 4000, 20, "B", 2);
    const a2 = responsesReceipt(5000, 4500, 20, "A", 3);
    const paired = receiptsForProofRun([a1, b1, a2], "A");
    expect(paired).toHaveLength(2);
    expect(paired.every((r) => r.proof_run_id === "A")).toBe(true);
  });

  it("the proof artifact is CONTENT-FREE: no prompt/completion text anywhere", () => {
    const summary = summarizeCacheProof([responsesReceipt(5420, 0, 180, "run-4", 1), responsesReceipt(5421, 4912, 176, "run-4", 2)]);
    const raw = JSON.stringify(summary) + "\n" + formatCacheProof(summary);
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain("reply");
  });
});
