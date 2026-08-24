import { describe, it, expect } from "vitest";
import { usageFromResponseBody, usageFromResponseObject } from "../../src/core/gateway/openai-usage.js";

/**
 * OpenAI usage parsing for the gateway record mode. Pure + content-free: only the
 * provider's own reported token COUNTS + the model label are extracted; a missing axis is unavailable
 * with a reason, never a silent zero. billed = prompt - cached (only when both present).
 */

const SECRET = "SECRET_COMPLETION_do_not_store";
const fullUsage = {
  id: "chatcmpl-abc",
  model: "gpt-4o-mini",
  choices: [{ message: { content: `answer with ${SECRET}` } }],
  usage: {
    prompt_tokens: 100,
    completion_tokens: 20,
    total_tokens: 120,
    prompt_tokens_details: { cached_tokens: 40 },
    completion_tokens_details: { reasoning_tokens: 5 }
  }
};

describe("usageFromResponseObject / usageFromResponseBody", () => {
  it("parses a full non-streaming usage object (prompt/cached/billed/output/reasoning + model)", () => {
    const u = usageFromResponseBody(JSON.stringify(fullUsage));
    expect(u.present).toBe(true);
    expect(u.promptInputTokens).toBe(100);
    expect(u.cachedInputTokens).toBe(40);
    expect(u.billedFreshInputTokens).toBe(60); // prompt - cached
    expect(u.outputTokens).toBe(20);
    expect(u.reasoningTokens).toBe(5);
    expect(u.model).toBe("gpt-4o-mini");
  });

  it("computes billed_fresh ONLY when both prompt and cached are present", () => {
    const noCached = usageFromResponseObject({ usage: { prompt_tokens: 100, completion_tokens: 10 } });
    expect(noCached.promptInputTokens).toBe(100);
    expect(noCached.cachedInputTokens).toBeUndefined();
    expect(noCached.billedFreshInputTokens).toBeUndefined();
  });

  it("no usage object → unavailable with a reason (never a silent zero)", () => {
    const u = usageFromResponseBody(JSON.stringify({ id: "x", model: "gpt-4o", choices: [] }));
    expect(u.present).toBe(false);
    expect(u.promptInputTokens).toBeUndefined();
    expect(u.unavailableReason).toMatch(/no usage/i);
    expect(u.model).toBe("gpt-4o"); // model still surfaced (metadata)
  });

  it("empty / truncated body → unavailable (never throws)", () => {
    expect(usageFromResponseBody("").present).toBe(false);
    expect(usageFromResponseBody('{"usage":{"prompt_tokens":10').present).toBe(false); // truncated JSON
  });

  it("parses usage from the FINAL chunk of a streaming SSE body (stream_options.include_usage)", () => {
    const sse = [
      `data: ${JSON.stringify({ model: "gpt-4o-mini", choices: [{ delta: { content: SECRET } }] })}`,
      "",
      `data: ${JSON.stringify({ model: "gpt-4o-mini", choices: [{ delta: {} }], usage: { prompt_tokens: 200, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 50 } } })}`,
      "",
      "data: [DONE]",
      ""
    ].join("\n");
    const u = usageFromResponseBody(sse);
    expect(u.present).toBe(true);
    expect(u.promptInputTokens).toBe(200);
    expect(u.cachedInputTokens).toBe(50);
    expect(u.billedFreshInputTokens).toBe(150);
    expect(u.outputTokens).toBe(30);
    expect(u.model).toBe("gpt-4o-mini");
  });

  it("streamed body with NO usage chunk → unavailable with the include_usage hint", () => {
    const sse = `data: ${JSON.stringify({ model: "gpt-4o", choices: [{ delta: { content: "hi" } }] })}\n\ndata: [DONE]\n`;
    const u = usageFromResponseBody(sse);
    expect(u.present).toBe(false);
    expect(u.unavailableReason).toMatch(/include_usage/i);
  });
});

describe("usage parsing - OpenAI Responses API shape (input_tokens / output_tokens / *_details)", () => {
  it("parses a non-streaming Responses API usage object", () => {
    const u = usageFromResponseBody(
      JSON.stringify({
        model: "gpt-5",
        output: [{ content: [{ text: SECRET }] }],
        usage: {
          input_tokens: 5421,
          input_tokens_details: { cached_tokens: 4912 },
          output_tokens: 176,
          output_tokens_details: { reasoning_tokens: 32 }
        }
      })
    );
    expect(u.present).toBe(true);
    expect(u.promptInputTokens).toBe(5421);
    expect(u.cachedInputTokens).toBe(4912);
    expect(u.billedFreshInputTokens).toBe(509); // 5421 - 4912
    expect(u.outputTokens).toBe(176);
    expect(u.reasoningTokens).toBe(32);
    expect(u.model).toBe("gpt-5");
  });

  it("parses usage from the Responses API SSE `response.completed` event (usage nested under `response`)", () => {
    const sse =
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: SECRET })}\n\n` +
      `data: ${JSON.stringify({ type: "response.completed", response: { model: "gpt-5", usage: { input_tokens: 200, input_tokens_details: { cached_tokens: 50 }, output_tokens: 30 } } })}\n\n`;
    const u = usageFromResponseBody(sse);
    expect(u.present).toBe(true);
    expect(u.promptInputTokens).toBe(200);
    expect(u.cachedInputTokens).toBe(50);
    expect(u.billedFreshInputTokens).toBe(150);
    expect(u.outputTokens).toBe(30);
    expect(u.model).toBe("gpt-5");
  });
});
