/**
 * Shared content-free record step for the unified capture→compact→record→report flow (PUBLIC CLI/SDK).
 *
 * After any tool's capture (Codex live wrapper, Claude Code capture/hook, …) this records a CONTENT-FREE
 * usage event to the hosted control-plane: `provider_metadata {tool, provider, model}` + `token_usage`
 * with **input and output counted SEPARATELY** and an honest **`token_source`**
 * (provider-reported | local-estimate). It uploads NO trace content (metrics_only) and only runs when the
 * user has configured the hosted path (URL + key), never a default network call.
 *
 * Invariant: the three axes stay distinct, provider-reported vs
 * locally-observed/estimated vs SAVINGS. This records tokens (input + output) with their source; it does
 * NOT compute or send any output-savings figure (output savings stay unavailable until the output-shaping
 * policy family produces measured + eval-confirmed evidence).
 */
import { buildOptimizeRequest, sendRequest, type ApiConfig, type TokenSource, type ToolName } from "./api-client/index.js";
import type { UsageMetadata } from "./usage-metadata.js";

/** Map a capture's UsageMetadata to the honest wire token source. */
export function captureTokenSource(usage: UsageMetadata): TokenSource {
  if (usage.provider_reported_tokens) return "provider-reported";
  if (usage.estimated_tokens) return "local-estimate";
  return "unknown";
}

export interface CaptureRecordOptions {
  usage: UsageMetadata;
  tool: ToolName;
  /** A local reference (e.g. captured-trace.json path), NOT content; the body is metrics_only. */
  reference: string;
}

/** Build the CONTENT-FREE (`metrics_only`) record request. Input/output sent separately; honest source. */
export function buildCaptureRecordRequest(opts: CaptureRecordOptions) {
  return buildOptimizeRequest({
    trace: { redacted: true, reference: opts.reference },
    payloadClass: "metrics_only",
    tokenSource: captureTokenSource(opts.usage),
    ...(typeof opts.usage.input_tokens === "number" ? { inputTokens: opts.usage.input_tokens } : {}),
    ...(typeof opts.usage.output_tokens === "number" ? { outputTokens: opts.usage.output_tokens } : {}),
    ...(opts.usage.provider ? { provider: opts.usage.provider } : {}),
    ...(opts.usage.model ? { model: opts.usage.model } : {}),
    tool: opts.tool,
    optimizationMode: "recommend"
  });
}

export type CaptureRecordResult =
  | { recorded: true; tool: ToolName; source: TokenSource }
  | { recorded: false; reason: string };

/**
 * Send the content-free record. Best-effort: a transport/HTTP failure returns `recorded: false` with a
 * sanitized reason (never the key, headers, or body), it must NEVER fail the user's capture.
 */
export async function recordCaptureContentFree(config: ApiConfig, opts: CaptureRecordOptions): Promise<CaptureRecordResult> {
  const source = captureTokenSource(opts.usage);
  try {
    const response = await sendRequest(config, "/v0/optimize", buildCaptureRecordRequest(opts));
    if (!response.ok) return { recorded: false, reason: `hosted record rejected (HTTP ${response.status})` };
    return { recorded: true, tool: opts.tool, source };
  } catch {
    return { recorded: false, reason: "could not reach the hosted API (transport error)" };
  }
}
