import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { censusRequestInput, type RequestInputCensus } from "../../src/core/request-input-census.js";

const FIXTURES = join(__dirname, "..", "fixtures", "request-input-census");

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf8");
}

function expectPartitioned(result: RequestInputCensus): void {
  const partitionBytes =
    result.totals.promptIncluded.utf8Bytes +
    result.totals.transportExcluded.utf8Bytes +
    result.totals.promptUnknown.utf8Bytes;
  const partitionCodePoints =
    result.totals.promptIncluded.unicodeCodePoints +
    result.totals.transportExcluded.unicodeCodePoints +
    result.totals.promptUnknown.unicodeCodePoints;
  expect(partitionBytes).toBe(result.totals.componentValues.utf8Bytes);
  expect(partitionCodePoints).toBe(result.totals.componentValues.unicodeCodePoints);
  expect(result.totals.componentValues.utf8Bytes).toBe(
    result.components.reduce((sum, component) => sum + component.exact.utf8Bytes, 0)
  );
  expect(result.totals.componentValues.unicodeCodePoints).toBe(
    result.components.reduce((sum, component) => sum + component.exact.unicodeCodePoints, 0)
  );
}

describe("censusRequestInput", () => {
  it.each([
    ["/v1/messages", "anthropic-messages.json", "anthropic-messages"],
    ["/v1/chat/completions", "openai-chat.json", "openai-chat"],
    ["/v1/responses", "openai-responses.json", "openai-responses"]
  ] as const)("partitions %s on the canonical component-value basis", (endpoint, name, protocol) => {
    const result = censusRequestInput(endpoint, fixture(name));
    expect(result.protocol).toBe(protocol);
    expect(result.parsed).toBe(true);
    expect(result.basis).toBe("canonical_component_values_v1");
    expectPartitioned(result);
    expect(result.components.some((component) => component.category === "tool_definition")).toBe(true);
    expect(result.components.some((component) => component.category === "tool_call")).toBe(true);
    expect(result.components.some((component) => component.category === "tool_result")).toBe(true);
    expect(result.totals.transportExcluded.utf8Bytes).toBeGreaterThan(0);
    expect(result.totals.promptIncluded.utf8Bytes).toBeGreaterThan(0);
  });

  it("counts UTF-8 bytes and Unicode code points independently", () => {
    const value = "A🌍é";
    const result = censusRequestInput("/v1/responses", JSON.stringify({ input: value }));
    const input = result.components.find((component) => component.path === "$.input");
    expect(input?.exact).toEqual({ utf8Bytes: 7, unicodeCodePoints: 3 });
    expect(input?.estimate).toEqual({
      kind: "local_estimate",
      estimatorId: "unicode-code-points-div-4-v1",
      tokens: 1
    });
  });

  it("keeps nested tool-result content in the tool-result component and separates tool calls", () => {
    const result = censusRequestInput("/v1/messages", fixture("anthropic-messages.json"));
    const toolResult = result.components.find((component) => component.category === "tool_result");
    const toolCall = result.components.find((component) => component.category === "tool_call");
    expect(toolResult?.path).toBe("$.messages[2].content[0].content[0].text");
    expect(toolResult?.exact.unicodeCodePoints).toBe("nested result".length);
    expect(toolCall?.path).toBe("$.messages[1].content[0]");
  });

  it("classifies Codex custom tool call output through the Responses tool-result path", () => {
    const result = censusRequestInput(
      "/v1/responses",
      fixture("openai-responses-custom-tool-output.json")
    );
    expect(result.basis).toBe("canonical_component_values_v1");
    expect(result.components.find((component) => component.path === "$.input[0].output")).toMatchObject({
      category: "tool_result",
      type: "tool_result_text",
      promptDisposition: "included",
      estimate: { kind: "local_estimate" }
    });
    expect(result.components.some((component) => component.category === "opaque_nontext")).toBe(false);
    expect(result.components.some((component) => component.category === "unclassified")).toBe(false);
  });

  it("marks active input only from an explicit component boundary", () => {
    const body = JSON.stringify({ messages: [{ role: "user", content: "old" }, { role: "user", content: "new" }] });
    const implicit = censusRequestInput("/v1/chat/completions", body);
    expect(implicit.components.filter((component) => component.category === "active_input")).toHaveLength(0);
    const explicit = censusRequestInput("/v1/chat/completions", body, {
      activeInputPaths: ["$.messages[1].content"]
    });
    expect(explicit.components.find((component) => component.path === "$.messages[1].content")?.category).toBe(
      "active_input"
    );
  });

  it("excludes transport values from the prompt total", () => {
    const result = censusRequestInput(
      "/v1/chat/completions",
      JSON.stringify({ model: "transport-marker", stream: true, messages: [{ role: "user", content: "prompt" }] })
    );
    const promptBytes = result.components
      .filter((component) => component.promptDisposition === "included")
      .reduce((sum, component) => sum + component.exact.utf8Bytes, 0);
    expect(result.totals.promptIncluded.utf8Bytes).toBe(promptBytes);
    expect(result.components.find((component) => component.path === "$.model")?.promptDisposition).toBe("excluded");
  });

  it("preserves future and malformed blocks as explicit unclassified components", () => {
    const result = censusRequestInput(
      "/v1/messages",
      JSON.stringify({
        messages: [
          { role: "user", content: [{ type: "future_block", payload: "value" }, { text: "missing type" }, null] },
          42
        ],
        future_top_level: { value: true }
      })
    );
    expect(result.components.filter((component) => component.category === "unclassified").map((component) => component.path)).toEqual([
      "$.messages[0].content[0]",
      "$.messages[0].content[1]",
      "$.messages[0].content[2]",
      "$.messages[1]",
      "$.unknown_fields[0]"
    ]);
    expect(result.components.filter((component) => component.category === "unclassified").every((component) => component.estimate.kind === "unavailable")).toBe(true);
    expectPartitioned(result);
  });

  it("withholds estimates for opaque media and lowers estimate coverage", () => {
    const result = censusRequestInput(
      "/v1/responses",
      JSON.stringify({ input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }, { type: "input_image", image_url: "synthetic://image" }] }] })
    );
    const opaque = result.components.find((component) => component.category === "opaque_nontext");
    expect(opaque?.estimate).toEqual({ kind: "unavailable", reason: "opaque_or_nontext" });
    expect(result.totals.localEstimate.coverage).toBeGreaterThan(0);
    expect(result.totals.localEstimate.coverage).toBeLessThan(1);
  });

  it("counts a Responses server reference once as opaque prompt input", () => {
    const result = censusRequestInput(
      "/v1/responses",
      JSON.stringify({ input: "continue", previous_response_id: "response_opaque" })
    );
    const references = result.components.filter((component) => component.path === "$.previous_response_id");
    expect(references).toHaveLength(1);
    expect(references[0]).toMatchObject({
      category: "opaque_nontext",
      type: "server_response_reference",
      promptDisposition: "included",
      estimate: { kind: "unavailable", reason: "opaque_or_nontext" }
    });
  });

  it("never estimates opaque content nested in tool results or encrypted reasoning items", () => {
    const responses = censusRequestInput("/v1/responses", fixture("openai-responses-opaque-result.json"));
    const responseOpaque = responses.components.find(
      (component) => component.path === "$.input[0].output[1]"
    );
    const reasoning = responses.components.find((component) => component.path === "$.input[1]");
    expect(responseOpaque).toMatchObject({ category: "opaque_nontext", estimate: { kind: "unavailable" } });
    expect(reasoning).toMatchObject({ category: "unclassified", estimate: { kind: "unavailable" } });
    expect(responses.components.find((component) => component.path === "$.input[0].output[0].text")).toMatchObject({
      category: "tool_result",
      estimate: { kind: "local_estimate" }
    });

    const anthropic = censusRequestInput(
      "/v1/messages",
      JSON.stringify({
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "call_opaque",
                content: [
                  { type: "text", text: "visible result" },
                  { type: "image", source: { type: "base64", data: "synthetic-image-bytes" } }
                ]
              }
            ]
          }
        ]
      })
    );
    expect(anthropic.components.find((component) => component.path.endsWith(".content[1]"))).toMatchObject({
      category: "opaque_nontext",
      estimate: { kind: "unavailable" }
    });
    expect(anthropic.totals.localEstimate.coverage).toBeLessThan(1);
  });

  it.each([
    ["/v1/responses", "{not json", "invalid_json"],
    ["/v9/future", JSON.stringify({ input: "value" }), "unknown_endpoint"],
    ["/v1/responses", JSON.stringify("not an object"), "non_object_body"]
  ])("reports one bounded unclassified component for %s input", (endpoint, body, type) => {
    const result = censusRequestInput(endpoint, body);
    expect(result.basis).toBe("raw_request_fallback_v1");
    expect(result.components).toHaveLength(1);
    expect(result.components[0]).toMatchObject({ path: "$", category: "unclassified", type });
    expect(result.components[0]?.exact).toEqual(result.source);
    expect(result.totals.componentValues).toEqual(result.source);
  });

  it("does not mutate options or echo known component values", () => {
    const marker = "RAW_PRIVATE_MARKER";
    const body = JSON.stringify({ input: marker, metadata: { marker } });
    const options = Object.freeze({ activeInputPaths: Object.freeze(["$.input"]) });
    const before = JSON.stringify(options);
    const result = censusRequestInput("/v1/responses", body, options);
    expect(JSON.stringify(options)).toBe(before);
    expect(JSON.stringify(result)).not.toContain(marker);
    expect(result.components.find((component) => component.path === "$.input")?.category).toBe("active_input");
  });

  it("bounds unknown keys and type labels instead of echoing caller-controlled metadata", () => {
    const keyMarker = "PRIVATE_UNKNOWN_KEY_MARKER";
    const typeMarker = "PRIVATE_UNKNOWN_TYPE_MARKER_call";
    const serverTypeMarker = "server_PRIVATE_TYPE_MARKER";
    const result = censusRequestInput(
      "/v1/responses",
      JSON.stringify({
        input: [
          { type: typeMarker, payload: "value" },
          { type: serverTypeMarker, reference: "opaque" },
          { type: "function_call_output", output: [{ type: typeMarker, [keyMarker]: "value" }] }
        ],
        [keyMarker]: { value: true }
      })
    );
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(keyMarker);
    expect(serialized).not.toContain(typeMarker);
    expect(serialized).not.toContain(serverTypeMarker);
    expect(result.components).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "$.input[0]", type: "unknown_item_type" }),
        expect.objectContaining({ path: "$.input[1]", type: "server_reference" }),
        expect.objectContaining({ path: "$.input[2].output[0]", type: "unknown_tool_result_part" }),
        expect.objectContaining({ path: "$.unknown_fields[0]", type: "unknown_field" })
      ])
    );
  });

  it("represents missing required values with zero exact size", () => {
    const missingText = censusRequestInput(
      "/v1/messages",
      JSON.stringify({ messages: [{ role: "user", content: [{ type: "text" }] }, { content: "role missing" }] })
    );
    expect(missingText.components.find((component) => component.type === "malformed_text")?.exact).toEqual({
      utf8Bytes: 0,
      unicodeCodePoints: 0
    });
    expect(missingText.components.find((component) => component.type === "missing_role")?.exact).toEqual({
      utf8Bytes: 0,
      unicodeCodePoints: 0
    });

    const missingOutput = censusRequestInput(
      "/v1/responses",
      JSON.stringify({ input: [{ type: "function_call_output", call_id: "call_1" }] })
    );
    expect(missingOutput.components.find((component) => component.type === "missing_output")?.exact).toEqual({
      utf8Bytes: 0,
      unicodeCodePoints: 0
    });
    expect(JSON.stringify(missingOutput)).not.toContain("undefined");
  });

  it("estimates only recognized plaintext thinking and withholds signed or encrypted reasoning", () => {
    const result = censusRequestInput(
      "/v1/messages",
      JSON.stringify({
        messages: [
          { role: "assistant", content: [{ type: "thinking", thinking: "plain reasoning" }] },
          { role: "assistant", content: [{ type: "thinking", thinking: "signed reasoning", signature: "opaque" }] },
          { role: "assistant", content: [{ type: "redacted_thinking", data: "opaque" }] }
        ]
      })
    );
    expect(result.components.find((component) => component.type === "thinking_text")?.estimate).toMatchObject({
      kind: "local_estimate"
    });
    expect(result.components.find((component) => component.type === "thinking" && component.path.includes("[1]"))?.estimate).toEqual({
      kind: "unavailable",
      reason: "opaque_or_nontext"
    });
    expect(result.components.find((component) => component.type === "redacted_thinking")?.estimate).toEqual({
      kind: "unavailable",
      reason: "opaque_or_nontext"
    });
  });

  it("fails safely on deeply nested valid JSON without recursive traversal or serialization errors", () => {
    const depth = 6_000;
    const nested = `${'{"child":'.repeat(depth)}"leaf"${"}".repeat(depth)}`;
    const body = `{"input":[{"type":"function_call","arguments":${nested}}]}`;
    const result = censusRequestInput("/v1/responses", body);
    expect(result.parsed).toBe(true);
    expect(result.basis).toBe("raw_request_fallback_v1");
    expect(result.source.utf8Bytes).toBe(Buffer.byteLength(body));
    expect(result.components).toHaveLength(1);
    expect(result.components[0]).toMatchObject({
      path: "$",
      category: "unclassified",
      type: "measurement_limit",
      exact: result.source,
      estimate: { kind: "unavailable", reason: "measurement_limit" }
    });
    expect(() => JSON.stringify(result)).not.toThrow();
  });
});
