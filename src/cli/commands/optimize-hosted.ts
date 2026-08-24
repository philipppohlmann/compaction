import chalk from "chalk";
import {
  ApiNotConfirmedError,
  ApiTransportError,
  buildOptimizeRequest,
  ConsentError,
  resolveApiConfig,
  sendRequest,
  type ApiConfig,
  type ToolName
} from "../../core/api-client/index.js";
import { captureOpenAIAgentsCommand } from "../../core/openai-agents-capture.js";
import { estimateTraceTokens } from "../../core/token-estimator.js";
import type { AgentTrace } from "../../core/types.js";

/**
 * V0.4, the smallest CLI → hosted-API upgrade loop for `optimize openai-agents` (open-core).
 *
 * UPGRADE PATH: when, and ONLY when -
 * both `COMPACTION_API_URL` and `COMPACTION_API_KEY` are set, `optimize` routes through the
 * existing pure-HTTP `api-client` to the hosted Compaction API instead of the local engine /
 * degrade path. There is NO engine import here (pure HTTP + the FREE capture adapter), so the
 * open-core boundary is unchanged and the public npm package stays engine-free.
 *
 * HARD RAILS: default request is CONTENT-FREE (`metrics_only`), the trace content is NOT
 * uploaded. The API key is attached as `Authorization: Bearer` by the client and is NEVER logged,
 * printed, persisted, or placed in an error. The request body never appears in an error. A hosted
 * failure exits non-zero with a concise, actionable message and NEVER pretends a local
 * optimization happened. No billing-confirmed or semantic-correctness claim is made.
 */

/** True iff BOTH the hosted URL and key are configured, the explicit opt-in to the hosted path. */
export function hostedConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  const url = (env.COMPACTION_API_URL ?? "").trim();
  const key = (env.COMPACTION_API_KEY ?? "").trim();
  return url !== "" && key !== "";
}

/**
 * Build a CONTENT-FREE (`metrics_only`) optimize request from a captured trace. No inline trace
 * content is attached, only local token-count estimates, a local reference, and CONTENT-FREE
 * attribution (tool/provider/model identifiers). Content-free ⇒ the api-client sends without a
 * consent/confirm gate. Attribution is only attached when actually known; the model is taken from
 * the captured trace (never inferred).
 */
export function buildContentFreeOptimizeBody(
  trace: AgentTrace,
  reference: string,
  attribution: { tool?: ToolName; provider?: string } = {}
) {
  const tokens = estimateTraceTokens(trace);
  const model = typeof trace.model === "string" && trace.model.trim() !== "" ? trace.model : undefined;
  return buildOptimizeRequest({
    trace: { redacted: true, reference },
    payloadClass: "metrics_only",
    tokenSource: "local-estimate",
    inputTokens: tokens.inputTokens,
    outputTokens: tokens.outputTokens,
    optimizationMode: "recommend",
    ...(attribution.tool ? { tool: attribution.tool } : {}),
    ...(attribution.provider ? { provider: attribution.provider } : {}),
    ...(model ? { model } : {})
  });
}

export type HostedOptimizeResult =
  | { kind: "ok"; status: number; body: unknown }
  | { kind: "error"; message: string };

/**
 * Send a pre-built content-free optimize body to the hosted API. Returns a sanitized result -
 * an error `message` NEVER contains the API key, the Authorization header, or the request body.
 */
export async function sendHostedOptimize(config: ApiConfig, body: ReturnType<typeof buildOptimizeRequest>): Promise<HostedOptimizeResult> {
  try {
    const response = await sendRequest(config, "/v0/optimize", body);
    if (!response.ok) {
      const code = (response.body as { error?: string } | undefined)?.error ?? "error";
      const hint =
        response.status === 401
          ? "unauthorized - check that COMPACTION_API_KEY is valid for this endpoint"
          : `HTTP ${response.status} (${code})`;
      return { kind: "error", message: `hosted optimize rejected: ${hint}` };
    }
    return { kind: "ok", status: response.status, body: response.body };
  } catch (error) {
    // Sanitized - never echo the key, headers, or body. Map known client errors to a hint.
    if (error instanceof ApiTransportError) {
      return { kind: "error", message: "could not reach the hosted Compaction API (transport error); check COMPACTION_API_URL" };
    }
    if (error instanceof ConsentError || error instanceof ApiNotConfirmedError) {
      return { kind: "error", message: "request refused before sending by the no-auto-upload gate (content-free path should not hit this)" };
    }
    return { kind: "error", message: "hosted optimize failed" };
  }
}

/** Render the hosted result honestly. No key/body in any line; the API's own honest labels only. */
export function renderHostedOptimizeLines(result: HostedOptimizeResult): string[] {
  if (result.kind === "error") {
    return [
      chalk.red(`Hosted optimize error: ${result.message}.`),
      "Nothing was applied; NO local optimization was performed."
    ];
  }
  return [
    chalk.green("Hosted optimize OK (review-only; nothing applied)."),
    JSON.stringify(result.body, null, 2),
    "Labels above are the hosted API's own: token deltas are local-estimate, cost is " +
      "token-estimated-cost - NOT billing-confirmed, NOT a semantic-preservation claim, and not " +
      "extrapolated to any time period."
  ];
}

/**
 * Orchestrate the hosted optimize loop: capture LOCALLY (free, no engine, no upload) → build a
 * content-free request → send via the api-client → render honestly. Sets a non-zero exit code on
 * any failure and never claims a local optimization occurred.
 */
export async function runHostedOptimizeOpenAIAgents(opts: { out: string; commandParts: string[] }): Promise<void> {
  const config = resolveApiConfig();
  console.log(chalk.cyan("compaction optimize openai-agents (hosted)"));
  console.log(`Hosted Compaction API: ${config.url}`);
  console.log("Content-free request (metrics_only): your trace content is NOT uploaded. No auto-apply, no billing claim.");

  // 1. Capture the trace LOCALLY (free adapter - no engine, no upload).
  const capture = await captureOpenAIAgentsCommand(opts.commandParts, opts.out);
  if (!capture.trace) {
    console.error(chalk.red("Hosted optimize: local capture produced no trace (see the capture report for per-event reasons)."));
    console.error("Nothing was applied; NO local optimization was performed.");
    process.exitCode = 1;
    return;
  }

  // 2. Content-free body + 3. send (Bearer key attached by the client; never logged).
  //    Attribution is the OpenAI Agents capture adapter's known identity - tool + provider only;
  //    the model rides along from the captured trace inside buildContentFreeOptimizeBody.
  const body = buildContentFreeOptimizeBody(capture.trace, capture.paths.capturedTracePath, {
    tool: "openai-agents",
    provider: "openai"
  });
  const result = await sendHostedOptimize(config, body);

  // 4. Render honestly.
  for (const line of renderHostedOptimizeLines(result)) console.log(line);
  if (result.kind === "error") process.exitCode = 1;
}
