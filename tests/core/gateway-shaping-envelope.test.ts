import { describe, expect, it } from "vitest";
import {
  classifyAnthropicShapingEnvelope,
  classifyOpenAiShapingEnvelope
} from "../../src/core/gateway/request-shape.js";
import { planGatewayOutputShaping } from "../../src/core/gateway/output-shaping-policy.js";
import { taskAwareGate } from "../../src/core/gateway/output-shaping-task-classifier.js";

/**
 * OUTPUT-SHAPING REACHABILITY.
 *
 * Output shaping is the base capability on every plan, and its attachment boundary is independent
 * from input compaction's stricter request classifier.
 *
 * The rule these tests pin: the REFUSAL boundary is widened for envelopes we can attach to safely;
 * the MUTATION boundary is not widened at all. Shaping only ever ADDS its instruction. Anything it
 * cannot attach to without guessing still fails closed.
 */

const tools = [{ name: "read_file", input_schema: { type: "object", properties: {} } }];
const gate = { taskGate: taskAwareGate() };
const shapeOf = (endpoint: string, body: unknown) =>
  planGatewayOutputShaping(endpoint, JSON.stringify(body), gate);

describe("anthropic shaping envelope", () => {
  it("accepts a tool-bearing request with a block-array system (what real Claude Code sends)", () => {
    const env = classifyAnthropicShapingEnvelope(
      "/v1/messages",
      JSON.stringify({
        model: "claude-opus-5",
        system: [{ type: "text", text: "You are Claude Code.", cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: [{ type: "tool_result", content: "x" }] }],
        tools
      })
    );
    expect(env.supported).toBe(true);
    // The block form reports only a COUNT: editing an existing block is inexpressible by construction,
    // so the attach can never invalidate a cache_control prefix.
    expect(env.supported === true && env.system).toEqual({ kind: "blocks", blockCount: 1 });
  });

  it("fails closed on a malformed system block rather than guessing", () => {
    const env = classifyAnthropicShapingEnvelope(
      "/v1/messages",
      JSON.stringify({ system: [{ type: "image" }], messages: [{ role: "user", content: "hi" }] })
    );
    expect(env.supported).toBe(false);
    expect(env.supported === false && env.failClosedReason).toMatch(/well-formed text block/);
  });

  it("fails closed on a body that is not valid JSON", () => {
    const env = classifyAnthropicShapingEnvelope("/v1/messages", "{not json");
    expect(env.supported).toBe(false);
  });

  it("shapes a tool-bearing turn by APPENDING a system block, leaving existing blocks byte-identical", () => {
    const cached = { type: "text", text: "You are Claude Code.", cache_control: { type: "ephemeral", ttl: "1h" } };
    const before = {
      model: "claude-opus-5",
      system: [cached],
      messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "file text" }] }],
      tools,
      max_tokens: 4096
    };
    const plan = shapeOf("/v1/messages", before);
    expect(plan.changed).toBe(true);

    const after = JSON.parse(plan.mutatedBody!) as Record<string, unknown>;
    // Only `system` differs, and only by one appended block.
    expect(Object.keys(after).filter((k) => JSON.stringify((before as never)[k]) !== JSON.stringify(after[k]))).toEqual([
      "system"
    ]);
    const system = after.system as Array<Record<string, unknown>>;
    expect(system).toHaveLength(2);
    expect(system[0]).toEqual(cached);
    // The appended block must NOT carry a cache_control breakpoint of its own.
    expect(system[1].cache_control).toBeUndefined();
    expect(after.tools).toEqual(tools);
    expect(after.messages).toEqual(before.messages);
  });

  it("is idempotent: a second pass does not double-attach", () => {
    const body = { model: "claude-opus-5", system: [{ type: "text", text: "s" }], messages: [{ role: "user", content: "hi" }], tools };
    const once = shapeOf("/v1/messages", body);
    const twice = planGatewayOutputShaping("/v1/messages", once.mutatedBody!, gate);
    expect(twice.changed).toBe(false);
    expect(twice.supported).toBe(true);
  });
});

describe("openai-family shaping envelope", () => {
  it("shapes a tool-bearing /v1/responses turn without touching tools or input", () => {
    const before = { model: "gpt-5", instructions: "You are a coding agent.", input: [{ type: "function_call_output", output: "x" }], tools };
    const plan = shapeOf("/v1/responses", before);
    expect(plan.changed).toBe(true);
    const after = JSON.parse(plan.mutatedBody!) as Record<string, unknown>;
    expect(Object.keys(after).filter((k) => JSON.stringify((before as never)[k]) !== JSON.stringify(after[k]))).toEqual([
      "instructions"
    ]);
    expect(after.tools).toEqual(tools);
    expect(after.input).toEqual(before.input);
    expect(after.instructions as string).toContain(before.instructions);
  });

  it("shapes a tool-bearing multimodal /v1/chat/completions turn by inserting ONE new system message", () => {
    const before = {
      model: "gpt-4",
      messages: [
        { role: "system", content: "agent" },
        { role: "user", content: [{ type: "text", text: "fix" }, { type: "image_url", image_url: { url: "data:x" } }] }
      ],
      tools
    };
    const plan = shapeOf("/v1/chat/completions", before);
    expect(plan.changed).toBe(true);
    const after = JSON.parse(plan.mutatedBody!) as Record<string, unknown>;
    const messages = after.messages as Array<Record<string, unknown>>;
    expect(messages).toHaveLength(before.messages.length + 1);
    // Every pre-existing message survives byte-identically.
    for (const original of before.messages) {
      expect(messages.some((m) => JSON.stringify(m) === JSON.stringify(original))).toBe(true);
    }
    expect(after.tools).toEqual(tools);
  });

  it("fails closed on a non-string responses.instructions and on a malformed chat message", () => {
    expect(classifyOpenAiShapingEnvelope("/v1/responses", JSON.stringify({ instructions: { a: 1 }, input: "x" })).supported).toBe(false);
    expect(classifyOpenAiShapingEnvelope("/v1/chat/completions", JSON.stringify({ messages: ["hi"] })).supported).toBe(false);
    expect(classifyOpenAiShapingEnvelope("/v1/chat/completions", JSON.stringify({ messages: [] })).supported).toBe(false);
  });
});

describe("the task gate holds on per-turn signals only", () => {
  const base = (extra: Record<string, unknown>) => ({
    model: "claude-opus-5",
    system: [{ type: "text", text: "You are Claude Code." }],
    messages: [{ role: "user", content: "Rename this variable." }],
    tools,
    ...extra
  });

  it("does NOT hold on thinking:adaptive or output_config.effort - they are session settings, not task signals", () => {
    // These are session capabilities rather than a positive per-turn reasoning request. Holding on
    // them would suppress every turn inheriting the setting.
    const plan = shapeOf("/v1/messages", base({ thinking: { type: "adaptive", display: "omitted" }, output_config: { effort: "high" } }));
    expect(plan.changed).toBe(true);
  });

  it("still holds on an explicit per-turn extended-thinking opt-in", () => {
    const plan = shapeOf("/v1/messages", base({ thinking: { type: "enabled", budget_tokens: 8000 } }));
    expect(plan.changed).toBe(false);
    expect(plan.supported).toBe(true);
  });

  it("still holds on a planning request, which does vary per turn", () => {
    const body = base({});
    body.messages = [{ role: "user", content: "Think step by step and create a detailed plan for the architecture. Do not write code yet." }];
    const plan = shapeOf("/v1/messages", body);
    expect(plan.changed).toBe(false);
    expect(plan.supported).toBe(true);
  });
});
