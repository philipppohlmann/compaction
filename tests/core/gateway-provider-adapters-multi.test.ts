import { describe, it, expect } from "vitest";
import {
  anthropicAdapter,
  geminiAdapter,
  mistralAdapter
} from "../../src/core/gateway/provider-adapters-multi.js";
import {
  adapterForUpstream,
  getProviderAdapter,
  openAiAdapter,
  DEFAULT_ADAPTER,
  openAiBreakdownFromNormalizedUsage
} from "../../src/core/gateway/provider-adapter.js";

/**
 * Concrete Anthropic / Gemini / Mistral provider adapters.
 * Each `extractUsage(body)` normalizes the provider's own usage object into the
 * provider-neutral, CONTENT-FREE `NormalizedUsage`. Honesty boundaries asserted here: missing usage →
 * `unavailable` WITH a reason (never zeros); missing cache field → `cacheUnavailableReason` (never a
 * fabricated 0); Mistral ALWAYS lacks a cache field (cache proof structurally unavailable); output is
 * numbers + labels ONLY (no prompt/response content). These are "fields normalized + fixture-tested", NOT
 * a live-verified readiness claim.
 */

// Fake secrets embedded in fixture bodies, the NormalizedUsage output must never carry them.
const SECRET_PROMPT = "SECRET_PROMPT_must_not_appear_fake";
const SECRET_REPLY = "SECRET_REPLY_must_not_appear_fake";

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
const labelKeys = new Set(["source", "unavailableReason", "cacheUnavailableReason", "model"]);

// ------------------------------------------------------------------ Anthropic

const anthropicFullBody = JSON.stringify({
  id: "msg_01abc",
  type: "message",
  model: "claude-3-5-sonnet-20241022",
  content: [{ type: "text", text: `reply ${SECRET_REPLY}` }],
  usage: {
    input_tokens: 100,
    output_tokens: 20,
    cache_read_input_tokens: 40,
    cache_creation_input_tokens: 12 // a cache WRITE - must NOT be folded into cachedInputTokens
  }
});

describe("Anthropic adapter - extractUsage normalization", () => {
  it("(1) full usage → provider-reported TOTAL input/output/cached/fresh (+ model)", () => {
    const u = anthropicAdapter.extractUsage(anthropicFullBody);
    expect(u.source).toBe("provider-reported");
    // Anthropic input_tokens (100) is the FRESH count; cache_read (40) is the cached portion reported
    // SEPARATELY. Normalized total prompt input = fresh + cached = 140 (cached ⊆ total).
    expect(u.inputTokens).toBe(140); // TOTAL = input_tokens (100) + cache_read (40)
    expect(u.outputTokens).toBe(20);
    expect(u.cachedInputTokens).toBe(40); // cache_read_input_tokens (the HIT portion)
    expect(u.freshInputTokens).toBe(100); // Anthropic's own fresh input_tokens
    expect(u.model).toBe("claude-3-5-sonnet-20241022");
    expect(u.unavailableReason).toBeUndefined();
    expect(u.cacheUnavailableReason).toBeUndefined();
  });

  it("(cache-write not mislabeled) cache_creation_input_tokens never appears as a cache hit", () => {
    const u = anthropicAdapter.extractUsage(anthropicFullBody);
    // 12 (the cache-creation/write count) must not leak into any hit axis.
    expect(u.cachedInputTokens).not.toBe(12);
    expect(u.freshInputTokens).not.toBe(88); // would be 100-12 if it were wrongly treated as a hit
    expect(JSON.stringify(u)).not.toContain("12");
  });

  it("(STREAMING defensive parse) usage split across message_start + message_delta events", () => {
    const stream = [
      `event: message_start`,
      `data: ${JSON.stringify({
        type: "message_start",
        message: {
          id: "msg_stream",
          model: "claude-3-opus-20240229",
          usage: { input_tokens: 500, cache_read_input_tokens: 200, output_tokens: 1 }
        }
      })}`,
      ``,
      `event: content_block_delta`,
      `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: SECRET_REPLY } })}`,
      ``,
      `event: message_delta`,
      `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 77 } })}`,
      ``,
      `event: message_stop`,
      `data: ${JSON.stringify({ type: "message_stop" })}`,
      ``
    ].join("\n");
    const u = anthropicAdapter.extractUsage(stream);
    expect(u.source).toBe("provider-reported");
    // input_tokens (500) is the FRESH count; cache_read (200) is cached separately → TOTAL = 700.
    expect(u.inputTokens).toBe(700); // TOTAL = fresh (500) + cached (200), from message_start
    expect(u.cachedInputTokens).toBe(200); // from message_start
    expect(u.freshInputTokens).toBe(500); // Anthropic's own fresh input_tokens
    expect(u.outputTokens).toBe(77); // final message_delta wins
    expect(u.model).toBe("claude-3-opus-20240229");
  });

  it("(partial streaming tail) only message_delta present → emits output, marks input unavailable-with-reason (not zero)", () => {
    const tailOnly = `data: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 42 } })}\n`;
    const u = anthropicAdapter.extractUsage(tailOnly);
    expect(u.source).toBe("provider-reported");
    expect(u.outputTokens).toBe(42);
    expect(u.inputTokens).toBeUndefined(); // never a fabricated 0
    expect(u.cachedInputTokens).toBeUndefined();
    expect(u.freshInputTokens).toBeUndefined();
    expect(u.cacheUnavailableReason).toBeTruthy();
  });

  it("(2) no usage object → unavailable WITH reason, NOT zeros", () => {
    const u = anthropicAdapter.extractUsage(JSON.stringify({ type: "message", model: "claude-3-5-sonnet", content: [] }));
    expect(u.source).toBe("unavailable");
    expect(u.unavailableReason).toBeTruthy();
    expect(u.inputTokens).toBeUndefined();
    expect(u.outputTokens).toBeUndefined();
    expect(u.cachedInputTokens).toBeUndefined();
    expect(u.model).toBe("claude-3-5-sonnet"); // metadata still surfaced
  });

  it("(3) usage present but no cache field → cachedInputTokens undefined + cacheUnavailableReason (never 0)", () => {
    const u = anthropicAdapter.extractUsage(JSON.stringify({ model: "claude-3-haiku", usage: { input_tokens: 80, output_tokens: 10 } }));
    expect(u.source).toBe("provider-reported");
    expect(u.inputTokens).toBe(80);
    expect(u.cachedInputTokens).toBeUndefined();
    expect(u.freshInputTokens).toBeUndefined();
    expect(u.cacheUnavailableReason).toBeTruthy();
  });

  it("(heavily-cached turn) input_tokens=2 + cache_read=66000 → total 66002, fresh 2, cached 66000 (NOT millions)", () => {
    // A real heavily-cached Anthropic turn. Before the accounting fix this produced a
    // nonsense cached percentage (cached / fresh ≈ 3.3M%); the corrected normalization makes the TOTAL
    // 66002 with cached ⊆ total, so downstream cached/total is a sane ~99.997%.
    const u = anthropicAdapter.extractUsage(
      JSON.stringify({ model: "claude-3-5-sonnet-20241022", usage: { input_tokens: 2, output_tokens: 15, cache_read_input_tokens: 66000 } })
    );
    expect(u.source).toBe("provider-reported");
    expect(u.inputTokens).toBe(66002); // TOTAL = fresh (2) + cached (66000)
    expect(u.freshInputTokens).toBe(2); // Anthropic's own fresh input_tokens
    expect(u.cachedInputTokens).toBe(66000);
    // cached ⊆ total (the invariant that keeps cached/total in [0, 100]).
    expect(u.cachedInputTokens as number).toBeLessThanOrEqual(u.inputTokens as number);
  });

  it("accepts a Buffer body identically to a string body", () => {
    expect(anthropicAdapter.extractUsage(Buffer.from(anthropicFullBody, "utf8"))).toEqual(
      anthropicAdapter.extractUsage(anthropicFullBody)
    );
  });
});

// ------------------------------------------------------------------ Gemini

const geminiFullBody = JSON.stringify({
  candidates: [{ content: { parts: [{ text: SECRET_REPLY }] } }],
  modelVersion: "gemini-1.5-pro-002",
  usageMetadata: {
    promptTokenCount: 1000,
    candidatesTokenCount: 150,
    cachedContentTokenCount: 600,
    totalTokenCount: 1150
  }
});

describe("Gemini adapter - extractUsage normalization", () => {
  it("(1) full usageMetadata → provider-reported input/output/cached/fresh (+ model)", () => {
    const u = geminiAdapter.extractUsage(geminiFullBody);
    expect(u.source).toBe("provider-reported");
    expect(u.inputTokens).toBe(1000); // promptTokenCount
    expect(u.outputTokens).toBe(150); // candidatesTokenCount
    expect(u.cachedInputTokens).toBe(600); // cachedContentTokenCount
    expect(u.freshInputTokens).toBe(400); // 1000 - 600
    expect(u.model).toBe("gemini-1.5-pro-002");
    expect(u.cacheUnavailableReason).toBeUndefined();
  });

  it("(streaming SSE) final chunk's usageMetadata is taken", () => {
    const stream = [
      `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "partial" }] } }] })}`,
      ``,
      `data: ${JSON.stringify({
        candidates: [{ content: { parts: [{ text: SECRET_REPLY }] }, finishReason: "STOP" }],
        modelVersion: "gemini-2.0-flash",
        usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 40, cachedContentTokenCount: 100 }
      })}`,
      ``
    ].join("\n");
    const u = geminiAdapter.extractUsage(stream);
    expect(u.source).toBe("provider-reported");
    expect(u.inputTokens).toBe(300);
    expect(u.outputTokens).toBe(40);
    expect(u.cachedInputTokens).toBe(100);
    expect(u.freshInputTokens).toBe(200);
    expect(u.model).toBe("gemini-2.0-flash");
  });

  it("(2) no usageMetadata → unavailable WITH reason, NOT zeros", () => {
    const u = geminiAdapter.extractUsage(JSON.stringify({ candidates: [], modelVersion: "gemini-1.5-flash" }));
    expect(u.source).toBe("unavailable");
    expect(u.unavailableReason).toBeTruthy();
    expect(u.inputTokens).toBeUndefined();
    expect(u.outputTokens).toBeUndefined();
    expect(u.model).toBe("gemini-1.5-flash");
  });

  it("(3) usageMetadata present but no cachedContentTokenCount → cacheUnavailableReason (never 0)", () => {
    const u = geminiAdapter.extractUsage(
      JSON.stringify({ modelVersion: "gemini-1.5-pro", usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 30 } })
    );
    expect(u.source).toBe("provider-reported");
    expect(u.inputTokens).toBe(500);
    expect(u.cachedInputTokens).toBeUndefined();
    expect(u.freshInputTokens).toBeUndefined();
    expect(u.cacheUnavailableReason).toBeTruthy();
  });
});

// ------------------------------------------------------------------ Mistral

const mistralFullBody = JSON.stringify({
  id: "cmpl-abc",
  model: "mistral-large-latest",
  choices: [{ message: { role: "assistant", content: SECRET_REPLY } }],
  usage: { prompt_tokens: 200, completion_tokens: 60, total_tokens: 260 }
});

describe("Mistral adapter - extractUsage normalization (no-cache honest boundary)", () => {
  it("(1) usage → provider-reported input/output (+ model)", () => {
    const u = mistralAdapter.extractUsage(mistralFullBody);
    expect(u.source).toBe("provider-reported");
    expect(u.inputTokens).toBe(200); // prompt_tokens
    expect(u.outputTokens).toBe(60); // completion_tokens
    expect(u.model).toBe("mistral-large-latest");
  });

  it("(3, ALWAYS) Mistral exposes no cache field → cached/fresh undefined + cacheUnavailableReason (never 0)", () => {
    const u = mistralAdapter.extractUsage(mistralFullBody);
    expect(u.cachedInputTokens).toBeUndefined(); // structurally unavailable - never a fabricated 0
    expect(u.freshInputTokens).toBeUndefined(); // not derivable without a cache field
    expect(u.cacheUnavailableReason).toBeTruthy();
    expect(u.cacheUnavailableReason?.toLowerCase()).toContain("mistral");
  });

  it("(streaming SSE) final chunk usage taken; still no cache axis", () => {
    const stream = [
      `data: ${JSON.stringify({ model: "mistral-small", choices: [{ delta: { content: "hi" } }] })}`,
      ``,
      `data: ${JSON.stringify({ model: "mistral-small", choices: [{ delta: {} }], usage: { prompt_tokens: 15, completion_tokens: 5 } })}`,
      ``,
      `data: [DONE]`,
      ``
    ].join("\n");
    const u = mistralAdapter.extractUsage(stream);
    expect(u.source).toBe("provider-reported");
    expect(u.inputTokens).toBe(15);
    expect(u.outputTokens).toBe(5);
    expect(u.cachedInputTokens).toBeUndefined();
    expect(u.cacheUnavailableReason).toBeTruthy();
  });

  it("(2) no usage object → unavailable WITH reason, NOT zeros", () => {
    const u = mistralAdapter.extractUsage(JSON.stringify({ model: "mistral-large", choices: [] }));
    expect(u.source).toBe("unavailable");
    expect(u.unavailableReason).toBeTruthy();
    expect(u.inputTokens).toBeUndefined();
    expect(u.model).toBe("mistral-large");
  });
});

// ------------------------------------------------------------------ shared honesty / registry

describe("empty / unparseable bodies → unavailable with reason (never throw, never zeros)", () => {
  for (const [name, adapter] of [
    ["anthropic", anthropicAdapter],
    ["gemini", geminiAdapter],
    ["mistral", mistralAdapter]
  ] as const) {
    it(`${name}: empty body → unavailable`, () => {
      const u = adapter.extractUsage("");
      expect(u.source).toBe("unavailable");
      expect(u.unavailableReason).toBeTruthy();
      expect(u.inputTokens).toBeUndefined();
    });
    it(`${name}: truncated JSON → unavailable (never throws)`, () => {
      const u = adapter.extractUsage('{"usage": {"input_tokens": 10');
      expect(u.source).toBe("unavailable");
      expect(u.inputTokens).toBeUndefined();
    });
  }
});

describe("(10) content-free guarantee - NormalizedUsage carries only numeric/label keys, no prompt/response text", () => {
  const bodies: Array<[string, string]> = [
    ["anthropic", anthropicFullBody],
    ["gemini", geminiFullBody],
    ["mistral", mistralFullBody]
  ];
  const adapters = { anthropic: anthropicAdapter, gemini: geminiAdapter, mistral: mistralAdapter } as const;
  for (const [name, body] of bodies) {
    it(`${name}: fixture body containing a fake secret prompt/reply → output has no content, only numbers + labels`, () => {
      // Splice a fake secret prompt into the fixture too, then normalize.
      const withPrompt = JSON.stringify({ ...JSON.parse(body), system: `${SECRET_PROMPT}` });
      const u = adapters[name as keyof typeof adapters].extractUsage(withPrompt);
      const serialized = JSON.stringify(u);
      expect(serialized).not.toContain(SECRET_PROMPT);
      expect(serialized).not.toContain(SECRET_REPLY);
      for (const [key, value] of Object.entries(u)) {
        expect(allowedKeys.has(key)).toBe(true);
        if (labelKeys.has(key)) expect(typeof value).toBe("string");
        else expect(typeof value).toBe("number");
      }
      // label strings are our own honesty text or the provider model id - never user content.
      expect(u.source === "provider-reported" || u.source === "unavailable").toBe(true);
    });
  }
});

describe("(4) provider-reported fields are labeled provider-reported; nothing mislabeled local-estimate", () => {
  it("present usage → provider-reported; absent → unavailable; never local-estimate", () => {
    expect(anthropicAdapter.extractUsage(anthropicFullBody).source).toBe("provider-reported");
    expect(geminiAdapter.extractUsage(geminiFullBody).source).toBe("provider-reported");
    expect(mistralAdapter.extractUsage(mistralFullBody).source).toBe("provider-reported");
    for (const a of [anthropicAdapter, geminiAdapter, mistralAdapter]) {
      expect(a.extractUsage("{}").source).toBe("unavailable");
      expect(a.extractUsage(anthropicFullBody).source).not.toBe("local-estimate");
    }
  });
});

describe("registry - adapterForUpstream + matchesUpstream resolve each provider origin", () => {
  it("adapterForUpstream(provider origin) → the right adapter", () => {
    expect(adapterForUpstream("https://api.anthropic.com").providerId).toBe("anthropic");
    expect(adapterForUpstream("https://generativelanguage.googleapis.com").providerId).toBe("gemini");
    expect(adapterForUpstream("https://us-central1-aiplatform.googleapis.com").providerId).toBe("gemini"); // Vertex
    expect(adapterForUpstream("https://api.mistral.ai").providerId).toBe("mistral");
    expect(adapterForUpstream("https://api.openai.com").providerId).toBe("openai");
  });

  it("matchesUpstream is correct + mutually exclusive across providers", () => {
    expect(anthropicAdapter.matchesUpstream("https://api.anthropic.com/v1/messages")).toBe(true);
    expect(anthropicAdapter.matchesUpstream("https://api.openai.com")).toBe(false);
    expect(geminiAdapter.matchesUpstream("https://generativelanguage.googleapis.com/v1beta/models")).toBe(true);
    expect(geminiAdapter.matchesUpstream("https://europe-west4-aiplatform.googleapis.com")).toBe(true);
    expect(geminiAdapter.matchesUpstream("https://api.anthropic.com")).toBe(false);
    expect(mistralAdapter.matchesUpstream("https://api.mistral.ai/v1/chat/completions")).toBe(true);
    expect(mistralAdapter.matchesUpstream("https://api.openai.com")).toBe(false);
    // A garbage / non-URL origin never matches (defensive, never throws).
    for (const a of [anthropicAdapter, geminiAdapter, mistralAdapter]) expect(a.matchesUpstream("not a url")).toBe(false);
  });

  it("getProviderAdapter resolves each id; unknown → OpenAI DEFAULT", () => {
    expect(getProviderAdapter("anthropic")).toBe(anthropicAdapter);
    expect(getProviderAdapter("gemini")).toBe(geminiAdapter);
    expect(getProviderAdapter("mistral")).toBe(mistralAdapter);
    expect(getProviderAdapter("nope")).toBe(DEFAULT_ADAPTER);
  });

  it("upstreamOrigin keeps only the configured origin (client path stays authoritative)", () => {
    expect(anthropicAdapter.upstreamOrigin("https://api.anthropic.com/v1/messages")).toBe("https://api.anthropic.com");
    expect(geminiAdapter.upstreamOrigin("https://generativelanguage.googleapis.com/v1beta/models:generateContent")).toBe(
      "https://generativelanguage.googleapis.com"
    );
    expect(mistralAdapter.upstreamOrigin("https://api.mistral.ai/v1/chat/completions")).toBe("https://api.mistral.ai");
  });
});

describe("(12) the shared normalized→OpenAI bridge still maps each provider result (byte-safe receipt path unchanged)", () => {
  it("provider-reported Anthropic usage bridges to a present OpenAiUsageBreakdown", () => {
    const bridged = openAiBreakdownFromNormalizedUsage(anthropicAdapter.extractUsage(anthropicFullBody));
    expect(bridged.present).toBe(true);
    // The bridge carries the TOTAL prompt input (140) as promptInputTokens, cached (40) ⊆ it, and the
    // fresh (100) as billedFreshInputTokens - the same "prompt = total, cached ⊆ prompt" shape as OpenAI.
    expect(bridged.promptInputTokens).toBe(140);
    expect(bridged.cachedInputTokens).toBe(40);
    expect(bridged.billedFreshInputTokens).toBe(100);
    expect(bridged.outputTokens).toBe(20);
  });

  it("Mistral (no cache) bridges without inventing a cached figure", () => {
    const bridged = openAiBreakdownFromNormalizedUsage(mistralAdapter.extractUsage(mistralFullBody));
    expect(bridged.present).toBe(true);
    expect(bridged.promptInputTokens).toBe(200);
    expect(bridged.cachedInputTokens).toBeUndefined(); // never fabricated
    expect(bridged.billedFreshInputTokens).toBeUndefined();
  });

  it("OpenAI adapter is untouched by the new registrations (default + extraction unchanged)", () => {
    expect(openAiAdapter.providerId).toBe("openai");
    expect(DEFAULT_ADAPTER).toBe(openAiAdapter);
    const u = openAiAdapter.extractUsage(JSON.stringify({ model: "gpt-4o-mini", usage: { prompt_tokens: 10, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 4 } } }));
    expect(u.source).toBe("provider-reported");
    expect(u.inputTokens).toBe(10);
    expect(u.cachedInputTokens).toBe(4);
    expect(u.freshInputTokens).toBe(6);
  });
});
