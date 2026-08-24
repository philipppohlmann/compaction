import { describe, expect, it } from "vitest";
import { calculateCost } from "../../src/core/cost-calculator.js";

describe("cost-calculator", () => {
  it("calculates cost from the local placeholder pricing table", () => {
    expect(
      calculateCost("placeholder-agent-model", {
        inputTokens: 1_000_000,
        outputTokens: 500_000,
        totalTokens: 1_500_000
      })
    ).toEqual({
      model: "placeholder-agent-model",
      inputCostUsd: 1,
      outputCostUsd: 1.5,
      totalCostUsd: 2.5
    });
  });

  it("falls back to default pricing for unknown models while preserving the reported model name", () => {
    expect(
      calculateCost("unknown-local-model", {
        inputTokens: 250_000,
        outputTokens: 250_000,
        totalTokens: 500_000
      })
    ).toEqual({
      model: "unknown-local-model",
      inputCostUsd: 0.25,
      outputCostUsd: 0.75,
      totalCostUsd: 1
    });
  });
});
