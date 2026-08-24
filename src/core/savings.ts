import type { CostEstimate, TokenEstimate } from "./types.js";

export type SavingsScope = "trace_level" | "policy_level" | "repeated_segment" | "embedded_context" | "run_level";

export interface SavingsCalculation {
  savings_scope: SavingsScope;
  input_tokens_before: number;
  input_tokens_after: number;
  tokens_saved: number;
  percent_reduction: number;
  estimated_cost_before: number;
  estimated_cost_after: number;
  estimated_saving_per_run: number;
}

export function roundCurrency(value: number): number {
  return Number(value.toFixed(6));
}

export function roundPercent(value: number): number {
  return Number(value.toFixed(2));
}

export function calculateSavings(input: {
  scope: SavingsScope;
  beforeTokens: Pick<TokenEstimate, "inputTokens">;
  afterTokens: Pick<TokenEstimate, "inputTokens">;
  beforeCost: Pick<CostEstimate, "totalCostUsd">;
  afterCost: Pick<CostEstimate, "totalCostUsd">;
}): SavingsCalculation {
  const inputTokensBefore = input.beforeTokens.inputTokens;
  const inputTokensAfter = input.afterTokens.inputTokens;
  const tokensSaved = Math.max(0, inputTokensBefore - inputTokensAfter);

  return {
    savings_scope: input.scope,
    input_tokens_before: inputTokensBefore,
    input_tokens_after: inputTokensAfter,
    tokens_saved: tokensSaved,
    percent_reduction: inputTokensBefore === 0 ? 0 : roundPercent((tokensSaved / inputTokensBefore) * 100),
    estimated_cost_before: roundCurrency(input.beforeCost.totalCostUsd),
    estimated_cost_after: roundCurrency(input.afterCost.totalCostUsd),
    estimated_saving_per_run: roundCurrency(Math.max(0, input.beforeCost.totalCostUsd - input.afterCost.totalCostUsd))
  };
}

export function savingsScopeLabel(scope: SavingsScope): string {
  switch (scope) {
    case "trace_level":
      return "Trace-level";
    case "policy_level":
      return "Policy-level";
    case "repeated_segment":
      return "Repeated-segment";
    case "embedded_context":
      return "Embedded-context";
    case "run_level":
      return "Run-level";
  }
}
