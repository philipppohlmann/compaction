import { calculateCost } from "./cost-calculator.js";
// The result SHAPE comes from the PUBLIC seam: `buildTokenAccounting` takes one as a parameter, and
// `policy-middleware` is excluded from the published package, so naming it from there would ship a
// declaration a TypeScript consumer cannot resolve.
import type { PolicyMiddlewareResult } from "./policy-types.js";
import type { AgentTrace } from "./types.js";

/**
 * Token & cost accounting surface (Strong-MVP Track D).
 *
 * Produces ONE honestly-labeled before/after token + cost summary that a developer can read to
 * answer: tokens used, input vs output, how much was reduced, estimated $ saved, and, critically -
 * whether each figure was MEASURED (provider-reported) or ESTIMATED (local chars/4).
 *
 * Label discipline (mvp-capability-matrix.md rows 2/3/10, README evidence ladder):
 *  - `provider-reported` is used ONLY when the trace/run carries provider usage metadata.
 *  - otherwise every figure is `local estimate` (chars/4 trace tokens + price-table cost).
 *  - NEVER `billing-confirmed`. Cost is a price-table estimate, not a billed figure.
 *
 * Output tokens BEFORE come from the trace (assistant messages). Output tokens AFTER are equal to
 * the before value for the supported policies (compaction targets non-assistant input spans -
 * repeated tool output / skill injections, so assistant output is unchanged); this is stated
 * explicitly rather than implied. When provider usage data is absent, output figures are labeled
 * local estimates like the rest.
 */

export type TokenFigureSource = "provider_reported" | "local_estimate";

export interface TokenAccountingFigure {
  value: number;
  /** Honest source label for THIS figure. */
  source: TokenFigureSource;
}

export interface TokenAccounting {
  model: string;
  /** Per-figure honest source label (provider_reported only when usage metadata is present). */
  measured: boolean;
  input_tokens_before: TokenAccountingFigure;
  input_tokens_after: TokenAccountingFigure;
  output_tokens_before: TokenAccountingFigure;
  output_tokens_after: TokenAccountingFigure;
  input_tokens_saved: number;
  percent_input_reduction: number;
  estimated_cost_before_usd: number;
  estimated_cost_after_usd: number;
  estimated_saving_per_run_usd: number;
  /** Visible pricing assumptions for the cost figures (price-table, NOT billed). */
  pricing_assumptions: string[];
  /** Whether the required token/cost evidence is present (Track C gate input). */
  evidence_present: boolean;
  limitations: string[];
}

function pct(before: number, after: number): number {
  if (before <= 0) {
    return 0;
  }
  return Number((((before - after) / before) * 100).toFixed(2));
}

/**
 * Build the token/cost accounting summary from an in-memory policy result.
 *
 * HONESTY: the numeric token figures here come from `policyResult.tokenEstimateBefore/After`,
 * which are ALWAYS the LOCAL chars/4 estimator (`estimateTraceTokens`) over the trace messages -
 * regardless of `trace.source`. `AgentTrace` carries no provider usage metadata (real provider
 * usage lives in `UsageMetadata`, NOT in the trace), and a `provider_usage` capture has no messages
 * to estimate from, so labeling its figures `provider_reported` would emit a FALSE
 * `0 (provider-reported)` over an empty local estimate. A figure is therefore labeled
 * `provider_reported` ONLY when it genuinely derives from provider usage metadata, which the
 * current `AgentTrace` shape never carries, so every figure here is a `local_estimate`. When a
 * provider-usage path is added that attaches real usage numbers, source those figures from it and
 * flip the label per-figure; until then, never claim provider-reported over a local estimate.
 */
export function buildTokenAccounting(trace: AgentTrace, policyResult: PolicyMiddlewareResult): TokenAccounting {
  // The figures below come from the local chars/4 estimator (`estimateTraceTokens` via
  // `policyResult.tokenEstimateBefore/After`), NOT from provider usage metadata, which the
  // `AgentTrace` shape does not carry. So these are local estimates even on a `provider_usage`
  // trace (whose capture has no messages to estimate from). Fail honest: label them local_estimate.
  const measured = false;
  const source: TokenFigureSource = "local_estimate";

  const inputBefore = policyResult.tokenEstimateBefore.inputTokens;
  const inputAfter = policyResult.tokenEstimateAfter.inputTokens;
  const outputBefore = policyResult.tokenEstimateBefore.outputTokens;
  // Supported policies do not touch assistant output spans, so output-after equals output-before.
  const outputAfter = policyResult.tokenEstimateAfter.outputTokens;

  const costBefore = calculateCost(trace.model, policyResult.tokenEstimateBefore).totalCostUsd;
  const costAfter = calculateCost(trace.model, policyResult.tokenEstimateAfter).totalCostUsd;

  const evidencePresent = Number.isFinite(inputBefore) && Number.isFinite(inputAfter) && inputBefore >= 0;

  return {
    model: trace.model,
    measured,
    input_tokens_before: { value: inputBefore, source },
    input_tokens_after: { value: inputAfter, source },
    output_tokens_before: { value: outputBefore, source },
    output_tokens_after: { value: outputAfter, source },
    input_tokens_saved: Math.max(0, inputBefore - inputAfter),
    percent_input_reduction: pct(inputBefore, inputAfter),
    estimated_cost_before_usd: Number(costBefore.toFixed(6)),
    estimated_cost_after_usd: Number(costAfter.toFixed(6)),
    estimated_saving_per_run_usd: Number(Math.max(0, costBefore - costAfter).toFixed(6)),
    pricing_assumptions: [
      `price-table estimate for ${trace.model} (NOT billing-confirmed, NOT a billed figure)`,
      measured
        ? "token counts are provider-reported; cost is a local price-table estimate over those counts"
        : "token counts are local estimates (chars/4); cost is a local price-table estimate over those counts"
    ],
    evidence_present: evidencePresent,
    limitations: [
      measured
        ? "Input/output token counts are provider-reported; cost remains a price-table ESTIMATE, never billing-confirmed."
        : "Input/output token counts are LOCAL ESTIMATES (chars/4); cost is a price-table ESTIMATE, never provider-reported or billing-confirmed.",
      "Output tokens after compaction equal output tokens before: the supported policies compact only non-assistant input spans (repeated tool output / skill injections), so assistant output is unchanged.",
      "No realized/applied savings is claimed; these are per-run estimates only."
    ]
  };
}

/** One-line-per-figure human rendering for stdout / markdown (each line carries its source label). */
export function describeTokenAccounting(acc: TokenAccounting): string[] {
  const label = (f: TokenAccountingFigure): string =>
    `${f.value} (${f.source === "provider_reported" ? "provider-reported" : "local estimate (chars/4)"})`;
  return [
    `model: ${acc.model}`,
    `input tokens before: ${label(acc.input_tokens_before)}`,
    `input tokens after:  ${label(acc.input_tokens_after)}`,
    `output tokens before: ${label(acc.output_tokens_before)}`,
    `output tokens after:  ${label(acc.output_tokens_after)}`,
    `input tokens saved: ${acc.input_tokens_saved} (${acc.percent_input_reduction}% input reduction)`,
    `estimated cost before: $${acc.estimated_cost_before_usd.toFixed(6)} (price-table estimate, NOT billed)`,
    `estimated cost after:  $${acc.estimated_cost_after_usd.toFixed(6)} (price-table estimate, NOT billed)`,
    `estimated saving per run: $${acc.estimated_saving_per_run_usd.toFixed(6)} (estimate, NOT billing-confirmed, NOT realized)`,
    ...acc.pricing_assumptions.map((a) => `pricing assumption: ${a}`)
  ];
}
