/**
 * Shared per-run token report for the unified `compaction run <tool> -- …` flow (public CLI/SDK -
 * engine-free). Formats counts and source labels already
 * produced by the per-tool capture (`UsageMetadata` + output status), no engine internals.
 *
 * Invariants:
 * - `token_source` is surfaced explicitly per field: provider-reported | local-estimate | unavailable.
 * - Input and output tokens are shown separately; the axes are never conflated.
 * - Input and output share ONE basis: both are the capture's cumulative totals over the same
 *   requests. The input count is the MODEL-VISIBLE input. For Anthropic-semantics usage (where the
 *   raw `input_tokens` field is only the uncached remainder of each request's context) that means
 *   fresh `input_tokens` plus provider-reported cached input (cache read + cache creation) -
 *   comparing the uncached slice against full output would be a mixed-basis, misleading number.
 *   OpenAI-style usage already reports `input_tokens` inclusive of cached tokens and is untouched.
 * - Output tokens are shown as tokens, never as a saving (no output-savings figure until
 *   measured + eval-confirmed output-shaping exists).
 * - The caller may show the input before/after reduction from the compaction report; this module
 *   labels that reduction measured vs estimated per the token source.
 */
import type { UsageMetadata } from "./usage-metadata.js";

/** The per-field token source. */
export type RunFlowTokenSource = "provider-reported" | "local-estimate" | "unavailable";

/** Whether the wrapper could safely separate/count output tokens for this run. */
export type RunFlowOutputStatus = "present" | "unavailable";

export interface RunFlowTokenReport {
  tool: string;
  /** Source for the INPUT token count (never stronger than the evidence). */
  input_token_source: RunFlowTokenSource;
  /** Source for the OUTPUT token count; `unavailable` when the field could not be safely counted. */
  output_token_source: RunFlowTokenSource;
  input_tokens?: number;
  output_tokens?: number;
  /**
   * Label for how the (real, input) compaction reduction shown by the caller should be read:
   * `measured` when the capture is provider-reported, `estimated` when it is a local estimate.
   */
  input_reduction_label: "measured" | "estimated";
  /** Honest notes carried from the capture (e.g. "not billing-confirmed", "no separable result field"). */
  notes: string[];
}

/**
 * Map a capture's whole-usage source to the per-field honest token source. Output can independently be
 * `unavailable` even when input is counted (the Cursor case), so the two fields carry sources separately.
 */
function fieldSource(usage: UsageMetadata): RunFlowTokenSource {
  if (usage.provider_reported_tokens) return "provider-reported";
  if (usage.estimated_tokens) return "local-estimate";
  return "unavailable";
}

/**
 * Build the honest per-run token report from a capture's `UsageMetadata` and the wrapper's output status.
 * `outputStatus === "unavailable"` forces `output_token_source: "unavailable"` regardless of the input
 * source, a genuinely-missing output field is never silently labeled provider-reported or local-estimate.
 */
export function buildRunFlowTokenReport(params: {
  tool: string;
  usage: UsageMetadata;
  outputStatus: RunFlowOutputStatus;
}): RunFlowTokenReport {
  const source = fieldSource(params.usage);
  // Model-visible input = fresh input + provider-reported cached input (read + creation). This
  // fold-in applies ONLY to Anthropic-semantics usage, where the raw `input_tokens` field is the
  // UNCACHED slice of each request's context (total context = input + cache_read + cache_creation).
  // Leaving cached context out would put input on a different basis than output (the full generated
  // output) and make output look larger than input for context-heavy sessions. OpenAI-style usage
  // reports `input_tokens` INCLUSIVE of cached tokens, so folding there would double-count.
  const cacheExclusiveOfInput = params.usage.provider === "anthropic";
  const cachedInputTokens = cacheExclusiveOfInput
    ? (params.usage.cache_read_input_tokens ?? 0) + (params.usage.cache_creation_input_tokens ?? 0)
    : 0;
  const inputTokens = params.usage.input_tokens === undefined ? undefined : params.usage.input_tokens + cachedInputTokens;
  const outputTokens = params.usage.output_tokens;

  // Input source is `unavailable` when there is no input count at all; otherwise the capture's source.
  const inputSource: RunFlowTokenSource = inputTokens === undefined ? "unavailable" : source;
  // Output source is `unavailable` when the wrapper could not separate output, OR there is no output count.
  const outputSource: RunFlowTokenSource =
    params.outputStatus === "unavailable" || outputTokens === undefined ? "unavailable" : source;

  return {
    tool: params.tool,
    input_token_source: inputSource,
    output_token_source: outputSource,
    ...(inputTokens !== undefined ? { input_tokens: inputTokens } : {}),
    ...(outputTokens !== undefined ? { output_tokens: outputTokens } : {}),
    input_reduction_label: params.usage.provider_reported_tokens ? "measured" : "estimated",
    notes: [
      ...(inputTokens !== undefined && cachedInputTokens > 0
        ? [
            "input tokens are the model-visible input (fresh input + provider-reported cache read + cache creation), on the same cumulative per-request basis as output - not the fresh/billed input alone."
          ]
        : []),
      ...params.usage.limitations
    ]
  };
}

function tokenLine(label: string, tokens: number | undefined, source: RunFlowTokenSource, reason?: string): string {
  if (source === "unavailable" || tokens === undefined) {
    // An unavailable axis always carries a reason: the capture's TRUE per-run reason when it has one,
    // else the generic honest fallback, never a bare "unavailable"/"unknown" with nothing after it.
    const fallback = source === "unavailable" ? "not safely separable / not reported" : "no count";
    return `  ${label} tokens: unavailable (${reason ?? fallback})`;
  }
  return `  ${label} tokens: ${tokens} (source: ${source})`;
}

/** Optional TRUE per-axis unavailability reasons from the capture (printed on the token lines). */
export interface RunFlowUnavailableReasons {
  input?: string;
  output?: string;
}

export interface RunFlowFormatOptions {
  reasons?: RunFlowUnavailableReasons;
  /**
   * Set false on surfaces that do NOT print a compaction input-reduction below the block (e.g.
   * `capture cursor`, which captures but does not compact) so the block never points the reader at
   * reduction figures that are not there. Default true (the `run` front-ends compact + report below).
   */
  inputReductionFollows?: boolean;
}

/**
 * Render the shared honest token block for a run-flow front-end. This block:
 * - states `token_source` explicitly per field (provider-reported | local-estimate | unavailable);
 * - shows input and output SEPARATELY;
 * - shows output as TOKENS only - it contains NO output-savings figure and no savings language for output.
 *
 * `options.reasons` carries the capture's TRUE per-axis unavailability reasons so an unavailable axis
 * prints WHY (e.g. "a saved Cursor export does not contain the prompt …") instead of the generic fallback.
 * The same reasons already ride in `report.notes` (capture limitations), so the persisted run record and
 * the summary rollup carry the identical reason - no divergence between surfaces.
 *
 * The caller prints the (real) INPUT before/after reduction from the compaction report separately; the
 * `input_reduction_label` in the report tells the caller whether that reduction is measured or estimated.
 */
export function formatRunFlowTokenReport(report: RunFlowTokenReport, options?: RunFlowFormatOptions): string[] {
  return [
    `Token reality for ${report.tool} (honest per-field source):`,
    tokenLine("input", report.input_tokens, report.input_token_source, options?.reasons?.input),
    tokenLine("output", report.output_tokens, report.output_token_source, options?.reasons?.output),
    // Stated on every report so no reader mistakes observed output for a saving.
    "  output is shown as TOKENS ONLY - output-token savings are not claimed (gated on measured + eval-confirmed output-shaping).",
    ...(options?.inputReductionFollows === false
      ? []
      : [`  input-reduction figures below are ${report.input_reduction_label} (from the token source above).`]),
    ...report.notes.map((n) => `  note: ${n}`)
  ];
}
