/**
 * OpenAI usage parsing for the Compaction Gateway record mode (PUBLIC CLI/SDK code, engine-free,
 * ships in the npm package).
 *
 * This module is PURE and CONTENT-FREE by construction: it takes a response body (a non-streaming JSON
 * body, or the tail of an SSE stream) and extracts ONLY the token-usage COUNTS + the model label. It
 * never returns, stores, or logs any message / completion / tool text, only the numbers the provider
 * itself reports in its `usage` object, plus the model name (metadata, not content).
 *
 * OpenAI usage shape (Chat Completions / Responses):
 *   usage.prompt_tokens                             , total input tokens the provider billed for
 *   usage.prompt_tokens_details.cached_tokens       , the portion served from the provider prompt cache
 *   usage.completion_tokens                         , output tokens
 *   usage.completion_tokens_details.reasoning_tokens, reasoning/output-detail tokens (o-series), where present
 *
 * Honesty: a field is reported ONLY when the provider actually returned it. A missing axis is
 * `unavailable` with a reason, NEVER a silent zero. `billed_fresh_input_tokens = prompt - cached`
 * (the input the provider billed at full rate) is computed ONLY when BOTH prompt and cached are present.
 */

/** A normalized, content-free token breakdown from a provider `usage` object. */
export interface OpenAiUsageBreakdown {
  /** True when a `usage` object with a numeric `prompt_tokens` (or output) was found. */
  present: boolean;
  /** Total input tokens the provider reports (usage.prompt_tokens), when present. */
  promptInputTokens?: number;
  /** Input tokens served from the provider prompt cache (prompt_tokens_details.cached_tokens), when present. */
  cachedInputTokens?: number;
  /** Fresh/billed-at-full-rate input tokens = prompt - cached (only when BOTH are present). */
  billedFreshInputTokens?: number;
  /** Output tokens (usage.completion_tokens), when present. */
  outputTokens?: number;
  /** Reasoning/output-detail tokens (completion_tokens_details.reasoning_tokens), when present. */
  reasoningTokens?: number;
  /** The model label the provider echoed (metadata, NOT content), when present. */
  model?: string;
  /** Honest reason the usage is unavailable, when `present` is false. */
  unavailableReason?: string;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function obj_(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

/**
 * Extract the content-free usage breakdown from an already-parsed OpenAI response object. Handles BOTH
 * OpenAI APIs (their usage field names differ):
 *  - Chat Completions: `usage.prompt_tokens` / `completion_tokens` / `prompt_tokens_details.cached_tokens`
 *    / `completion_tokens_details.reasoning_tokens`.
 *  - Responses API: `usage.input_tokens` / `output_tokens` / `input_tokens_details.cached_tokens`
 *    / `output_tokens_details.reasoning_tokens`. Its SSE events wrap the payload under `response`
 *    (`{"type":"response.completed","response":{usage,model}}`), so we also look one level down.
 */
export function usageFromResponseObject(obj: unknown): OpenAiUsageBreakdown {
  if (!obj || typeof obj !== "object") {
    return { present: false, unavailableReason: "response body was not a JSON object" };
  }
  const root = obj as Record<string, unknown>;
  // The Responses API SSE stream nests the completed response under `response`.
  const nested = obj_(root.response);
  const usage = obj_(root.usage) ?? obj_(nested?.usage);
  const model =
    typeof root.model === "string" ? root.model : typeof nested?.model === "string" ? (nested.model as string) : undefined;
  if (!usage) {
    return {
      present: false,
      ...(model ? { model } : {}),
      unavailableReason: "the provider response carried no usage object (e.g. a streamed response without usage/include_usage)"
    };
  }
  // Accept both APIs' field names (Chat Completions ?? Responses API).
  const promptInputTokens = num(usage.prompt_tokens) ?? num(usage.input_tokens);
  const outputTokens = num(usage.completion_tokens) ?? num(usage.output_tokens);
  const cachedInputTokens =
    num(obj_(usage.prompt_tokens_details)?.cached_tokens) ?? num(obj_(usage.input_tokens_details)?.cached_tokens);
  const reasoningTokens =
    num(obj_(usage.completion_tokens_details)?.reasoning_tokens) ?? num(obj_(usage.output_tokens_details)?.reasoning_tokens);

  if (promptInputTokens === undefined && outputTokens === undefined) {
    return {
      present: false,
      ...(model ? { model } : {}),
      unavailableReason: "the usage object carried no numeric input/prompt or output/completion tokens"
    };
  }
  const billedFreshInputTokens =
    promptInputTokens !== undefined && cachedInputTokens !== undefined
      ? Math.max(0, promptInputTokens - cachedInputTokens)
      : undefined;

  return {
    present: true,
    ...(promptInputTokens !== undefined ? { promptInputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(billedFreshInputTokens !== undefined ? { billedFreshInputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(model ? { model } : {})
  };
}

/**
 * Extract usage from a raw response body string. Handles BOTH shapes byte-safely (it only READS a copy):
 *  - non-streaming JSON: `JSON.parse(body).usage`.
 *  - streaming SSE: the LAST `data:` line carrying a `usage` object (present only when the caller sent
 *    `stream_options.include_usage: true`). The `[DONE]` sentinel is ignored.
 * Any parse failure → `present: false` with an honest reason (never throws; the proxy stays byte-safe).
 */
export function usageFromResponseBody(body: string): OpenAiUsageBreakdown {
  const trimmed = body.trim();
  if (trimmed === "") return { present: false, unavailableReason: "empty response body" };

  // Non-streaming JSON first.
  if (trimmed.startsWith("{")) {
    try {
      return usageFromResponseObject(JSON.parse(trimmed));
    } catch {
      return { present: false, unavailableReason: "response body was not parseable JSON (may be truncated)" };
    }
  }

  // Streaming SSE: scan for the LAST `data:` payload that parses and carries a usage object.
  let best: OpenAiUsageBreakdown | undefined;
  let lastModel: string | undefined;
  for (const line of trimmed.split(/\r?\n/)) {
    const s = line.trim();
    if (!s.startsWith("data:")) continue;
    const payload = s.slice("data:".length).trim();
    if (payload === "" || payload === "[DONE]") continue;
    let obj: unknown;
    try {
      obj = JSON.parse(payload);
    } catch {
      continue; // a partial/truncated SSE line, skip it
    }
    if (obj && typeof obj === "object" && typeof (obj as Record<string, unknown>).model === "string") {
      lastModel = (obj as Record<string, unknown>).model as string;
    }
    const b = usageFromResponseObject(obj);
    if (b.present) best = b; // keep the latest present usage (OpenAI emits it in the final chunk)
  }
  if (best) return best;
  return {
    present: false,
    ...(lastModel ? { model: lastModel } : {}),
    unavailableReason: "streamed response carried no usage chunk (send stream_options.include_usage:true to get one)"
  };
}
