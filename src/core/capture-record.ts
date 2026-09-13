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
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { buildOptimizeRequest, sendRequest, type ApiConfig, type TokenSource, type ToolName } from "./api-client/index.js";
import type { UsageMetadata } from "./usage-metadata.js";
import { buildCaptureUsageSidecar } from "./output-shaping-ab.js";

/** Map a capture's UsageMetadata to the honest wire token source. */
export function captureTokenSource(usage: UsageMetadata): TokenSource {
  if (usage.provider_reported_tokens) return "provider-reported";
  if (usage.estimated_tokens) return "local-estimate";
  return "unknown";
}

/**
 * Write a content-free `capture-usage.json` sidecar next to a capture artifact (operator-side evidence),
 * shared by EVERY tool's capture path (codex, cursor, claude-code). It carries provider-reported token
 * counts + honest source + (treatment) output-shaping policy names so a later
 * `compaction output-shaping-ab add` can link this run into an A/B arm. NO content is written.
 *
 * `policyNames`/`policyVersion` are optional: a caller with no truthful policy-attribution source for
 * this run (e.g. Claude Code, where shaping is attached by the UserPromptSubmit hook, not by this call
 * site) omits them, and `buildCaptureUsageSidecar` leaves `outputShaping` off entirely - it is never
 * invented.
 */
export async function writeCaptureUsageSidecar(
  outDir: string,
  tool: ToolName,
  usage: UsageMetadata,
  policyNames: string[] = [],
  policyVersion?: string
): Promise<string> {
  const sidecar = buildCaptureUsageSidecar({
    tool,
    ...(usage.provider ? { provider: usage.provider } : {}),
    ...(usage.model ? { model: usage.model } : {}),
    ...(typeof usage.input_tokens === "number" ? { inputTokens: usage.input_tokens } : {}),
    ...(typeof usage.output_tokens === "number" ? { outputTokens: usage.output_tokens } : {}),
    providerReported: usage.provider_reported_tokens === true,
    tokenSource: captureTokenSource(usage),
    tokenMetadataStatus: usage.provider_reported_tokens === true ? "present" : "missing",
    ...(policyNames.length > 0 && policyVersion ? { policyNames, policyVersion } : {})
  });
  const sidecarPath = path.join(outDir, "capture-usage.json");
  await writeFile(sidecarPath, JSON.stringify(sidecar, null, 2), "utf8");
  return sidecarPath;
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
