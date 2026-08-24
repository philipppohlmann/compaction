import { describe, expect, it } from "vitest";
import { estimateTextTokens, estimateTraceTokens } from "../../src/core/token-estimator.js";
import type { AgentTrace } from "../../src/core/types.js";

const baseTrace: AgentTrace = {
  id: "trace_test",
  title: "Token estimator test trace",
  artifactVersion: "agent-trace-v1",
  source: "manual",
  createdAt: "2026-01-01T00:00:00.000Z",
  generatedAt: "2026-01-01T00:00:00.000Z",
  model: "placeholder-agent-model",
  messages: [
    {
      id: "msg_system",
      role: "system",
      timestamp: "2026-01-01T00:00:00.000Z",
      content: "abcd"
    },
    {
      id: "msg_user",
      role: "user",
      timestamp: "2026-01-01T00:00:01.000Z",
      content: "abcde"
    },
    {
      id: "msg_assistant",
      role: "assistant",
      timestamp: "2026-01-01T00:00:02.000Z",
      content: "abcdefghi"
    }
  ]
};

describe("token-estimator", () => {
  it("estimates text tokens with the local ceil(length / 4) heuristic", () => {
    expect(estimateTextTokens("abcd")).toBe(1);
    expect(estimateTextTokens("abcde")).toBe(2);
    expect(estimateTextTokens("abcdefghi")).toBe(3);
  });

  it("splits trace tokens into input and assistant output tokens", () => {
    expect(estimateTraceTokens(baseTrace)).toEqual({
      inputTokens: 3,
      outputTokens: 3,
      totalTokens: 6
    });
  });

  it("counts captured stdout and stderr as input context, not assistant output", () => {
    expect(
      estimateTraceTokens({
        ...baseTrace,
        messages: [
          ...baseTrace.messages,
          {
            id: "msg_stdout",
            role: "stdout",
            timestamp: "2026-01-01T00:00:03.000Z",
            content: "abcd"
          },
          {
            id: "msg_stderr",
            role: "stderr",
            timestamp: "2026-01-01T00:00:04.000Z",
            content: "abcdefgh"
          }
        ]
      })
    ).toEqual({
      inputTokens: 6,
      outputTokens: 3,
      totalTokens: 9
    });
  });
});
