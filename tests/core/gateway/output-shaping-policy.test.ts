import { describe, expect, it } from "vitest";
import {
  planGatewayOutputShaping,
  planPublicBasicOutputShaping
} from "../../../src/core/gateway/output-shaping-policy.js";
import { taskAwareGate } from "../../../src/core/gateway/output-shaping-task-classifier.js";

const BIG = "Q".repeat(700);

describe("Gateway pre-generation output shaping", () => {
  it("attaches idempotently to OpenAI Responses instructions", () => {
    const original = JSON.stringify({ model: "gpt-x", instructions: "Keep the facts exact.", input: "hello" });
    const first = planGatewayOutputShaping("/v1/responses", original);
    expect(first.supported).toBe(true);
    expect(first.changed).toBe(true);
    expect(first.applied.map((entry) => entry.policy_name)).toContain("concise_response");
    const body = JSON.parse(first.mutatedBody!) as { instructions: string };
    expect(body.instructions).toContain("Keep the facts exact.");
    expect(body.instructions).toContain("Output-shaping policy");

    const second = planGatewayOutputShaping("/v1/responses", first.mutatedBody!);
    expect(second.supported).toBe(true);
    expect(second.changed).toBe(false);
    expect(second.reason).toMatch(/already attached/i);
  });

  it("uses the Anthropic top-level system field without changing message content", () => {
    const original = JSON.stringify({
      model: "claude-x",
      system: "Preserve exact identifiers.",
      messages: [{ role: "user", content: "hello" }]
    });
    const result = planGatewayOutputShaping("/v1/messages", original);
    expect(result.changed).toBe(true);
    const body = JSON.parse(result.mutatedBody!) as { system: string; messages: unknown[] };
    expect(body.system).toContain("Preserve exact identifiers.");
    expect(body.system).toContain("Output-shaping policy");
    expect(body.messages).toEqual([{ role: "user", content: "hello" }]);
  });

  it("inserts one chat system message before the first user message", () => {
    const original = JSON.stringify({ model: "gpt-x", messages: [{ role: "user", content: "hello" }] });
    const result = planGatewayOutputShaping("/v1/chat/completions", original);
    const body = JSON.parse(result.mutatedBody!) as { messages: Array<{ role: string; content: string }> };
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[0].content).toContain("Output-shaping policy");
    expect(body.messages[1]).toEqual({ role: "user", content: "hello" });
  });

  // These two were one test. The tool-bearing assertion failed first, which masked the
  // instructions assertion below it entirely - it could not have failed. Split so both are live.
  it("SHAPES a tool-bearing request: shaping never touches tool schemas, so tools do not block it", () => {
    const tools = [{ type: "function", name: "read_file" }];
    const original = JSON.stringify({ model: "gpt-x", input: `${BIG}\n\n${BIG}`, instructions: "agent", tools });
    const result = planGatewayOutputShaping("/v1/responses", original);
    expect(result).toMatchObject({ supported: true, changed: true });

    // The widened refusal boundary must not widen the mutation boundary: only `instructions` moves.
    const before = JSON.parse(original) as Record<string, unknown>;
    const after = JSON.parse(result.mutatedBody!) as Record<string, unknown>;
    expect(Object.keys(after).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]))).toEqual([
      "instructions"
    ]);
    expect(after.tools).toEqual(tools);
    expect(after.input).toEqual(before.input);
  });

  it("fails closed on a non-string instructions field, reported as recognized-but-unchanged", () => {
    const structuredInstructions = JSON.stringify({ model: "gpt-x", input: "hello", instructions: [{ type: "text", text: "x" }] });
    expect(planGatewayOutputShaping("/v1/responses", structuredInstructions)).toMatchObject({ supported: true, changed: false });
  });

  describe("task-aware gating (PRIVATE-ENGINE enhancement, injected via taskGate)", () => {
    const gate = taskAwareGate({});
    it("holds shaping on a planning turn when the gate is injected (supported, unchanged, signal recorded)", () => {
      const body = JSON.stringify({
        model: "claude-x",
        messages: [{ role: "user", content: "Design the retry strategy and weigh the trade-offs." }]
      });
      const result = planGatewayOutputShaping("/v1/messages", body, { taskGate: gate });
      expect(result).toMatchObject({ supported: true, changed: false, taskSignal: "planning-request" });
      expect(result.reason).toMatch(/task-aware: held/i);
    });

    it("still shapes a code-output turn with the gate injected", () => {
      const body = JSON.stringify({
        model: "claude-x",
        messages: [{ role: "user", content: "Implement merge_intervals and return the code." }]
      });
      const result = planGatewayOutputShaping("/v1/messages", body, { taskGate: gate });
      expect(result.changed).toBe(true);
      expect(result.applied.map((entry) => entry.policy_name)).toContain("concise_response");
    });

    it("holds when extended thinking is enabled even on a code turn (gate injected)", () => {
      const body = JSON.stringify({
        model: "claude-x",
        thinking: { type: "enabled", budget_tokens: 2000 },
        messages: [{ role: "user", content: "Implement merge_intervals." }]
      });
      expect(planGatewayOutputShaping("/v1/messages", body, { taskGate: gate })).toMatchObject({
        supported: true,
        changed: false,
        taskSignal: "extended-thinking"
      });
    });

    it("a throwing gate degrades to BLANKET shaping (fail-open to the public method), never a hard failure", () => {
      const body = JSON.stringify({
        model: "claude-x",
        messages: [{ role: "user", content: "Design the retry strategy and weigh the trade-offs." }]
      });
      const throwing = () => {
        throw new Error("classifier unavailable");
      };
      const result = planGatewayOutputShaping("/v1/messages", body, { taskGate: throwing });
      expect(result.changed).toBe(true);
      expect(result.applied.map((entry) => entry.policy_name)).toContain("concise_response");
    });
  });

  describe("public basic path applies the now-public turn gate", () => {
    it("planning turn: the raw planner with NO gate is blanket, the PUBLIC entry point holds", () => {
      const body = JSON.stringify({
        model: "claude-x",
        messages: [{ role: "user", content: "Design the retry strategy and weigh the trade-offs." }]
      });

      // The raw planner is unchanged: no injected gate still means blanket. This is the degrade a build
      // without the classifier (or with task-awareness switched off) falls back to.
      const blanket = planGatewayOutputShaping("/v1/messages", body);
      expect(blanket.changed).toBe(true);
      expect(blanket.applied.map((entry) => entry.policy_name)).toContain("concise_response");

      // The named PUBLIC entry point no longer behaves identically: every plan gets the same
      // method, so the Open surface holds a planning turn rather than shaping the untested regime.
      const publicBasic = planPublicBasicOutputShaping("/v1/messages", body);
      expect(publicBasic.changed, "Open must hold a planning turn, like the paid path").toBe(false);
      expect(publicBasic.taskSignal).toBe("planning-request");
    });

    it("public basic attaches concise_response before generation on a supported responses request", () => {
      const original = JSON.stringify({ model: "gpt-x", input: "hello" });
      const result = planPublicBasicOutputShaping("/v1/responses", original);
      expect(result.supported).toBe(true);
      expect(result.changed).toBe(true);
      const bodyOut = JSON.parse(result.mutatedBody!) as { instructions: string };
      expect(bodyOut.instructions).toContain("Output-shaping policy");
      expect(result.applied.map((entry) => entry.policy_name)).toContain("concise_response");
    });
  });
});
