import { describe, it, expect } from "vitest";
import {
  openAiAdapter,
  adapterForUpstream,
  getProviderAdapter,
  normalizedUsageFromOpenAiBreakdown,
  openAiBreakdownFromNormalizedUsage,
  DEFAULT_ADAPTER,
  type NormalizedUsage
} from "../../src/core/gateway/provider-adapter.js";

/**
 * Provider adapter abstraction + OpenAI concrete. The OpenAI
 * adapter DELEGATES to the existing `openai-usage.ts` parser (no reimplementation) and MAPS the breakdown
 * into the provider-neutral, CONTENT-FREE `NormalizedUsage`. Missing usage → `unavailable`
 * WITH a reason (never a zero); present-but-no-cache → `cacheUnavailableReason` (never a fabricated 0).
 * OpenAI is the only concrete adapter this cycle; unknown origins fall back to the OpenAI DEFAULT.
 */

const SECRET_PROMPT = "SECRET_PROMPT_must_not_appear";
const SECRET_REPLY = "SECRET_REPLY_must_not_appear";

const fullChatBody = JSON.stringify({
  id: "chatcmpl-abc",
  model: "gpt-4o-mini",
  choices: [{ message: { content: `reply ${SECRET_REPLY}` } }],
  usage: {
    prompt_tokens: 100,
    completion_tokens: 20,
    total_tokens: 120,
    prompt_tokens_details: { cached_tokens: 40 },
    completion_tokens_details: { reasoning_tokens: 5 }
  }
});

describe("OpenAI adapter - extractUsage normalization (delegates to openai-usage, content-free)", () => {
  // Test 1: provider-reported usage → correct input/output/cached/fresh + provider-reported.
  it("maps a full provider usage object → provider-reported input/output/cached/fresh (+ reasoning/model)", () => {
    const u = openAiAdapter.extractUsage(fullChatBody);
    expect(u.source).toBe("provider-reported");
    expect(u.inputTokens).toBe(100);
    expect(u.outputTokens).toBe(20);
    expect(u.cachedInputTokens).toBe(40);
    expect(u.freshInputTokens).toBe(60); // inputTokens - cachedInputTokens
    expect(u.reasoningTokens).toBe(5);
    expect(u.model).toBe("gpt-4o-mini");
    expect(u.unavailableReason).toBeUndefined();
    expect(u.cacheUnavailableReason).toBeUndefined();
  });

  // Test 4: Responses-API shape also normalizes to the same axes (proves delegation, not reimplementation).
  it("maps a Responses-API usage object (input_tokens/output_tokens/*_details) → same normalized axes", () => {
    const body = JSON.stringify({
      model: "gpt-5",
      output: [{ content: [{ text: SECRET_REPLY }] }],
      usage: {
        input_tokens: 5421,
        input_tokens_details: { cached_tokens: 4912 },
        output_tokens: 176,
        output_tokens_details: { reasoning_tokens: 32 }
      }
    });
    const u = openAiAdapter.extractUsage(body);
    expect(u.source).toBe("provider-reported");
    expect(u.inputTokens).toBe(5421);
    expect(u.cachedInputTokens).toBe(4912);
    expect(u.freshInputTokens).toBe(509); // 5421 - 4912
    expect(u.outputTokens).toBe(176);
    expect(u.reasoningTokens).toBe(32);
    expect(u.model).toBe("gpt-5");
  });

  it("accepts a Buffer body identically to a string body (bounded response tail)", () => {
    const fromString = openAiAdapter.extractUsage(fullChatBody);
    const fromBuffer = openAiAdapter.extractUsage(Buffer.from(fullChatBody, "utf8"));
    expect(fromBuffer).toEqual(fromString);
  });

  // Test 2: missing usage object → unavailable WITH reason, NOT zeros.
  it("no usage object → source:unavailable with a reason, and NO zero token axes", () => {
    const u = openAiAdapter.extractUsage(JSON.stringify({ model: "gpt-4o", choices: [] }));
    expect(u.source).toBe("unavailable");
    expect(u.unavailableReason).toBeTruthy();
    expect(u.inputTokens).toBeUndefined();
    expect(u.outputTokens).toBeUndefined();
    expect(u.cachedInputTokens).toBeUndefined();
    expect(u.freshInputTokens).toBeUndefined();
    expect(u.model).toBe("gpt-4o"); // model still surfaced as metadata
  });

  it("empty / truncated body → unavailable with a reason (never throws, never zeros)", () => {
    const empty = openAiAdapter.extractUsage("");
    expect(empty.source).toBe("unavailable");
    expect(empty.unavailableReason).toBeTruthy();
    expect(empty.inputTokens).toBeUndefined();
  });

  // Test 3: usage present but NO cache field → cachedInputTokens undefined + cacheUnavailableReason, NOT 0.
  it("usage present but no cache field → cachedInputTokens undefined + cacheUnavailableReason (never a 0)", () => {
    const u = openAiAdapter.extractUsage(JSON.stringify({ model: "gpt-4o-mini", usage: { prompt_tokens: 100, completion_tokens: 10 } }));
    expect(u.source).toBe("provider-reported");
    expect(u.inputTokens).toBe(100);
    expect(u.outputTokens).toBe(10);
    expect(u.cachedInputTokens).toBeUndefined(); // NOT a fabricated 0
    expect(u.freshInputTokens).toBeUndefined(); // not derivable without cached
    expect(u.cacheUnavailableReason).toBeTruthy();
  });
});

describe("NormalizedUsage - content-free guarantee (test 10 seed)", () => {
  it("carries ONLY numeric/label fields - no request/response content leaks in", () => {
    const u = openAiAdapter.extractUsage(fullChatBody);
    const serialized = JSON.stringify(u);
    expect(serialized).not.toContain(SECRET_REPLY);
    expect(serialized).not.toContain(SECRET_PROMPT);
    // Every present value is a number, or one of the known label strings - never free text content.
    const labelKeys = new Set(["source", "unavailableReason", "cacheUnavailableReason", "model"]);
    for (const [key, value] of Object.entries(u)) {
      if (labelKeys.has(key)) {
        expect(typeof value).toBe("string");
      } else {
        expect(typeof value).toBe("number");
      }
    }
    // The only string label fields the type allows are exactly these (no content-bearing field exists).
    const allowedKeys = new Set([
      "inputTokens",
      "outputTokens",
      "cachedInputTokens",
      "freshInputTokens",
      "reasoningTokens",
      "model",
      "source",
      "unavailableReason",
      "cacheUnavailableReason"
    ]);
    for (const key of Object.keys(u)) expect(allowedKeys.has(key)).toBe(true);
  });

  // Test 5: no local estimator is added this cycle - assert nothing is mislabeled local-estimate.
  it("no estimator this cycle: adapter output is provider-reported or unavailable, never local-estimate", () => {
    const present = openAiAdapter.extractUsage(fullChatBody);
    const absent = openAiAdapter.extractUsage("{}");
    expect(present.source).toBe("provider-reported");
    expect(absent.source).toBe("unavailable");
    // local-estimate is a valid UsageSource for future estimators, but nothing emits it here.
    expect(present.source).not.toBe("local-estimate");
    expect(absent.source).not.toBe("local-estimate");
  });
});

describe("adapter registry - OpenAI default fallback (documented)", () => {
  it("adapterForUpstream(openai origin) → the OpenAI adapter", () => {
    expect(adapterForUpstream("https://api.openai.com").providerId).toBe("openai");
  });

  it("unknown origin → OpenAI DEFAULT adapter (today's behavior)", () => {
    const a = adapterForUpstream("http://127.0.0.1:8787");
    expect(a).toBe(DEFAULT_ADAPTER);
    expect(a.providerId).toBe("openai");
  });

  it("getProviderAdapter resolves each registered provider id; a truly unknown id → OpenAI DEFAULT", () => {
    expect(getProviderAdapter("openai").providerId).toBe("openai");
    // Anthropic/Gemini/Mistral are now registered (usage normalized + fixture-tested - NOT live readiness).
    expect(getProviderAdapter("anthropic").providerId).toBe("anthropic");
    expect(getProviderAdapter("gemini").providerId).toBe("gemini");
    expect(getProviderAdapter("mistral").providerId).toBe("mistral");
    // An unknown id still falls back to the documented OpenAI default (never a fabricated adapter).
    expect(getProviderAdapter("does-not-exist")).toBe(DEFAULT_ADAPTER);
  });

  it("upstreamOrigin() keeps only the configured origin (client path stays authoritative)", () => {
    expect(openAiAdapter.upstreamOrigin("https://api.openai.com/v1/chat/completions")).toBe("https://api.openai.com");
  });
});

describe("mapping bridges are lossless (byte-identical receipt guarantee)", () => {
  it("openAiBreakdownFromNormalizedUsage ∘ normalizedUsageFromOpenAiBreakdown preserves every axis", () => {
    const breakdown = {
      present: true,
      promptInputTokens: 100,
      cachedInputTokens: 40,
      billedFreshInputTokens: 60,
      outputTokens: 20,
      reasoningTokens: 5,
      model: "gpt-4o-mini"
    };
    const roundTripped = openAiBreakdownFromNormalizedUsage(normalizedUsageFromOpenAiBreakdown(breakdown));
    expect(roundTripped).toEqual(breakdown);
  });

  it("unavailable breakdown round-trips to present:false with its reason (never a zero)", () => {
    const breakdown = { present: false as const, unavailableReason: "no usage reported", model: "gpt-4o" };
    const back = openAiBreakdownFromNormalizedUsage(normalizedUsageFromOpenAiBreakdown(breakdown));
    expect(back.present).toBe(false);
    expect(back.unavailableReason).toBe("no usage reported");
    expect(back.model).toBe("gpt-4o");
    expect(back.promptInputTokens).toBeUndefined();
  });

  it("normalized unavailable never carries a numeric token axis", () => {
    const n: NormalizedUsage = normalizedUsageFromOpenAiBreakdown({ present: false, unavailableReason: "x" });
    expect(n.inputTokens).toBeUndefined();
    expect(n.outputTokens).toBeUndefined();
    expect(n.cachedInputTokens).toBeUndefined();
    expect(n.freshInputTokens).toBeUndefined();
  });
});
