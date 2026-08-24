import type { AgentTrace, TokenEstimate } from "./types.js";

const APPROX_CHARS_PER_TOKEN = 4;

export function estimateTextTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / APPROX_CHARS_PER_TOKEN));
}

export function estimateTraceTokens(trace: AgentTrace): TokenEstimate {
  const inputTokens = trace.messages
    .filter((message) => message.role !== "assistant")
    .reduce((sum, message) => sum + estimateTextTokens(message.content), 0);

  const outputTokens = trace.messages
    .filter((message) => message.role === "assistant")
    .reduce((sum, message) => sum + estimateTextTokens(message.content), 0);

  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens
  };
}
