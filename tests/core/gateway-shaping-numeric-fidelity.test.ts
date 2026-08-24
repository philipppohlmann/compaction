import { describe, expect, it } from "vitest";
import { planGatewayOutputShaping } from "../../src/core/gateway/output-shaping-policy.js";

/**
 * Attaching the shaping instruction reserializes the whole request body, so every number in it makes a
 * `JSON.parse` -> `JSON.stringify` round trip. JSON numbers are not JS numbers: an integer past 2^53
 * comes back rounded, `-0` loses its sign, and `1e400` comes back as `null`. Since the shaping envelope
 * was widened to admit tool-bearing traffic, those numbers now include tool schema bounds and tool-call
 * arguments this policy was never asked to touch.
 *
 * The rule: shaping may ADD its instruction, and may reformat a number (`1.0` and `1` denote the same
 * value). It may never change what a number MEANS. A body that cannot be rebuilt exactly is forwarded
 * unshaped rather than forwarded altered.
 */

const bodyWith = (literal: string) =>
  `{"model":"claude-sonnet-4","max_tokens":1024,"system":"be brief",` +
  `"tools":[{"name":"seek","input_schema":{"type":"object","properties":{"offset":{"type":"integer","maximum":${literal}}}}}],` +
  `"messages":[{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"seek","input":{"offset":${literal}}}]}]}`;

const argOf = (body: string) => /"input":\{"offset":([^}]*)\}/.exec(body)?.[1];

describe("output shaping never alters a number it was not asked to touch", () => {
  // Each of these reserializes to a DIFFERENT value than the one the caller sent.
  it.each([
    ["an integer past 2^53 (a 64-bit id in a tool argument)", "9007199254740993"],
    ["a 20-digit integer", "12345678901234567890"],
    ["negative zero", "-0"],
    ["a magnitude that overflows to non-finite", "1e400"]
  ])("forwards unshaped rather than rewriting %s", (_label, literal) => {
    const plan = planGatewayOutputShaping("/v1/messages", bodyWith(literal));
    expect(plan.changed).toBe(false);
    expect(plan.mutatedBody).toBeUndefined();
    expect(plan.reason).toContain("does not survive JSON round-tripping");
  });

  it("still shapes traffic whose numbers all survive, leaving tool arguments intact", () => {
    const plan = planGatewayOutputShaping("/v1/messages", bodyWith("9007199254740991"));
    expect(plan.changed).toBe(true);
    expect(argOf(plan.mutatedBody!)).toBe("9007199254740991");
  });

  it("treats a pure formatting difference as survivable, since 1.0 and 1 are the same number", () => {
    const plan = planGatewayOutputShaping("/v1/messages", bodyWith("1.0"));
    expect(plan.changed).toBe(true);
    expect(Number(argOf(plan.mutatedBody!))).toBe(1);
  });

  it("preserves ordinary integers exactly", () => {
    const plan = planGatewayOutputShaping("/v1/messages", bodyWith("42"));
    expect(plan.changed).toBe(true);
    expect(argOf(plan.mutatedBody!)).toBe("42");
  });

  it("applies the same guard to the OpenAI chat carrier", () => {
    const body = `{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}],` +
      `"tools":[{"type":"function","function":{"name":"seek","parameters":{"properties":{"id":{"maximum":9007199254740993}}}}}]}`;
    const plan = planGatewayOutputShaping("/v1/chat/completions", body);
    expect(plan.changed).toBe(false);
    expect(plan.reason).toContain("does not survive JSON round-tripping");
  });

  it("applies the same guard to the OpenAI responses carrier", () => {
    const body = `{"model":"gpt-4o","input":"hi","metadata":{"cursor":9007199254740993}}`;
    const plan = planGatewayOutputShaping("/v1/responses", body);
    expect(plan.changed).toBe(false);
    expect(plan.reason).toContain("does not survive JSON round-tripping");
  });
});
