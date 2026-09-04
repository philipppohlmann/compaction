import { describe, expect, it } from "vitest";
import {
  classifyOutputShapingTask,
  isOutputShapingTaskAware,
  OUTPUT_SHAPING_TASK_AWARE_ENV
} from "../../../src/core/gateway/output-shaping-task-classifier.js";

describe("output-shaping task classifier", () => {
  it("shapes a code-output turn (the measured-safe bulk)", () => {
    const body = JSON.stringify({ model: "m", messages: [{ role: "user", content: "Implement a function rotate(lst, k)." }] });
    const r = classifyOutputShapingTask("/v1/chat/completions", body);
    expect(r.decision).toBe("shape");
    expect(r.signal).toBe("default-shapeable");
  });

  it("shapes a verifier-in-loop fix turn", () => {
    const body = JSON.stringify({
      model: "m",
      messages: [
        { role: "user", content: "Implement parse_range." },
        { role: "assistant", content: "def parse_range(...): ..." },
        { role: "user", content: "Test failed: AssertionError on parse_range('8-5'). Fix and resubmit." }
      ]
    });
    const r = classifyOutputShapingTask("/v1/chat/completions", body);
    expect(r.decision).toBe("shape");
  });

  // REGRESSION PIN for a false comment corrected in this PR: three source comments asserted that the
  // task-aware gate "holds shaping back on tool-call turns". It never has. A tool-result turn carries
  // no planning text and no reasoning field, so it falls through to the default and is SHAPED. The
  // real reason a shaped turn can show no `output-shaping` component is that the tool's own prompt
  // hook attached the policy upstream (`already-active`), not a turn-class exclusion.
  it("shapes a tool_result turn - tool-call turns are NOT a held class", () => {
    const body = JSON.stringify({
      model: "m",
      messages: [
        { role: "user", content: "Add a retry to fetchUser." },
        { role: "assistant", content: [{ type: "tool_use", id: "tu_1", name: "read_file", input: { path: "user.ts" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "export async function fetchUser() {}" }] }
      ]
    });
    const r = classifyOutputShapingTask("/v1/messages", body);
    expect(r.decision).toBe("shape");
    expect(r.signal).toBe("default-shapeable");
  });

  it("holds on a planning/design request (prose plausibly load-bearing)", () => {
    const body = JSON.stringify({ model: "m", messages: [{ role: "user", content: "Help me design the architecture for a rate limiter and weigh the trade-offs." }] });
    const r = classifyOutputShapingTask("/v1/chat/completions", body);
    expect(r.decision).toBe("hold");
    expect(r.signal).toBe("planning-request");
  });

  it("holds on an explain/why request", () => {
    const body = JSON.stringify({ model: "m", messages: [{ role: "user", content: "Explain why this deadlock happens and walk me through the fix." }] });
    expect(classifyOutputShapingTask("/v1/chat/completions", body).decision).toBe("hold");
  });

  it("holds when Anthropic extended thinking is enabled", () => {
    const body = JSON.stringify({
      model: "claude-x",
      thinking: { type: "enabled", budget_tokens: 4000 },
      messages: [{ role: "user", content: "Implement a function." }]
    });
    const r = classifyOutputShapingTask("/v1/messages", body);
    expect(r.decision).toBe("hold");
    expect(r.signal).toBe("extended-thinking");
  });

  it("holds when OpenAI reasoning effort is high", () => {
    const body = JSON.stringify({ model: "o", reasoning: { effort: "high" }, input: "Write a function." });
    expect(classifyOutputShapingTask("/v1/responses", body).decision).toBe("hold");
  });

  it("reads the latest user turn across the responses input array", () => {
    const body = JSON.stringify({
      model: "o",
      input: [
        { role: "user", content: "Implement it." },
        { role: "assistant", content: "done" },
        { role: "user", content: "Now plan the rollout strategy step by step." }
      ]
    });
    expect(classifyOutputShapingTask("/v1/responses", body).decision).toBe("hold");
  });

  it("treats a role-less responses turn as a user turn (over-hold safe bias)", () => {
    const body = JSON.stringify({ model: "o", input: [{ content: "Design the architecture and weigh the trade-offs." }] });
    expect(classifyOutputShapingTask("/v1/responses", body).decision).toBe("hold");
  });

  it("shapes code turns that merely mention plan/design in passing (regex context-guard)", () => {
    for (const content of [
      "My plan is to implement this function and return the code.",
      "The design pattern for this is a singleton; write the class.",
      "Refactor design_pattern_registry to use a map."
    ]) {
      const body = JSON.stringify({ model: "m", messages: [{ role: "user", content }] });
      expect(classifyOutputShapingTask("/v1/chat/completions", body).decision).toBe("shape");
    }
  });

  it("still holds genuine plan/design phrasings after the context-guard", () => {
    for (const content of [
      "Plan out the rollout for this migration.",
      "Design a caching strategy for the gateway.",
      "Help me plan the approach before we code."
    ]) {
      const body = JSON.stringify({ model: "m", messages: [{ role: "user", content }] });
      expect(classifyOutputShapingTask("/v1/chat/completions", body).decision).toBe("hold");
    }
  });

  it("holds full-word strategy phrasings, not just the truncated stem", () => {
    for (const content of [
      "Give me a strategy for the migration.",
      "Plan strategy for the migration.",
      "What's the strategic call here?",
      "Help me strategize the rollout."
    ]) {
      const body = JSON.stringify({ model: "m", messages: [{ role: "user", content }] });
      expect(classifyOutputShapingTask("/v1/chat/completions", body).decision).toBe("hold");
    }
  });

  it("fails safe to shapeable on unparseable body (no planning signal to hold on)", () => {
    const r = classifyOutputShapingTask("/v1/chat/completions", "{not json");
    expect(r.decision).toBe("shape");
    expect(r.reason).toMatch(/not valid json/i);
  });

  it("never embeds request content in the reason or signal", () => {
    const secret = "SUPER_SECRET_PROMPT_TEXT";
    const body = JSON.stringify({ model: "m", messages: [{ role: "user", content: `Plan ${secret} for me` }] });
    const r = classifyOutputShapingTask("/v1/chat/completions", body);
    expect(r.reason).not.toContain(secret);
    expect(r.signal).not.toContain(secret);
  });

  describe("isOutputShapingTaskAware", () => {
    it("defaults on when unset", () => {
      expect(isOutputShapingTaskAware({})).toBe(true);
    });
    it("can be disabled to fall back to blanket shaping", () => {
      for (const off of ["0", "false", "off", "no", "FALSE"]) {
        expect(isOutputShapingTaskAware({ [OUTPUT_SHAPING_TASK_AWARE_ENV]: off })).toBe(false);
      }
    });
    it("stays on for any other value", () => {
      expect(isOutputShapingTaskAware({ [OUTPUT_SHAPING_TASK_AWARE_ENV]: "1" })).toBe(true);
    });
  });
});
