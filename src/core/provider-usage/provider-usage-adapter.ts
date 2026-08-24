/**
 * Provider-usage capture adapter (Option A, read-only, aggregate-only).
 *
 * Normalizes a read-only provider usage/cost API read into a CapturedRun carrying
 * usage/cost UsageMetadata ONLY (source = "provider_usage"), with NO message
 * content:
 *  - the credential is env-only, in-memory, never stored/logged/serialized
 *  - the capture is aggregate-only, no content
 *  - `provider_usage` maps to `provider_reported_usage`: cost/spend evidence, which
 *    caps approval-readiness at "conditional", never "ready"
 *
 * HARD INVARIANTS enforced here:
 *  - The credential is read from an env var, held in a local variable, passed ONLY
 *    to the client's auth header, and NEVER copied into the trace/usage/provenance
 *    or any returned/serialized structure.
 *  - Missing/empty credential => clean refusal (clear message naming the env var),
 *    no artifact, no network read. Never a silent fallback.
 *  - The produced trace has NO messages (a usage-only read has nothing to compact)
 *    and NO content fields. UsageMetadata carries aggregate usage/cost only.
 *  - cost_source: "provider_reported" ONLY when the endpoint genuinely exposed cost;
 *    otherwise price-table estimate / missing.
 */

import { createUsageMetadata, type UsageMetadata } from "../usage-metadata.js";
import type { CaptureProvenance, CapturedRun } from "../capture-adapter.js";
import type { AgentTrace } from "../types.js";
import {
  FetchProviderUsageClient,
  type ProviderAggregateUsage,
  type ProviderUsageClient
} from "./provider-usage-client.js";

export const PROVIDER_USAGE_ADAPTER_ID = "provider-usage-read-v1";

/** Default env var name the credential is read from. A flag may only NAME the var. */
export const DEFAULT_CREDENTIAL_ENV_VAR = "COMPACTION_PROVIDER_USAGE_TOKEN";

export const PROVIDER_USAGE_PRIVACY_NOTE =
  "NOTE: This is a read-only, aggregate-only provider usage/cost read. It captures token/cost\n" +
  "aggregates ONLY - NO prompt/completion content is read or stored. The captured artifact is\n" +
  "written locally to the output directory only. The credential is read from an environment\n" +
  "variable, used only for the single read-only request, and is never logged or written to any\n" +
  "artifact.";

/** Thrown when the credential env var is absent/empty. Carries NO secret value. */
export class MissingProviderCredentialError extends Error {
  readonly envVar: string;
  constructor(envVar: string) {
    super(
      `No provider usage credential found. Set the ${envVar} environment variable ` +
        `(a read-only, usage/cost-scoped token) and re-run. Refusing; no fallback, no artifact written.`
    );
    this.name = "MissingProviderCredentialError";
    this.envVar = envVar;
  }
}

export interface ProviderUsageCaptureInput {
  /** Configurable provider usage/cost endpoint (non-secret descriptor). */
  endpoint: string;
  /** Env var name to read the credential from (NAME only - never the value). */
  credentialEnvVar?: string;
  /** Optional reporting window start (ISO 8601). */
  windowStart?: string;
  /** Optional reporting window end (ISO 8601). */
  windowEnd?: string;
  /** Human-readable label for the run/window, if any. */
  label?: string;
  /** Injectable client. Tests pass a mock; defaults to the real fetch client. */
  client?: ProviderUsageClient;
  /** Override env reader (tests). Defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Fixed timestamp for deterministic artifacts/tests. */
  capturedAt?: string;
  /** Fixed run id for deterministic artifacts/tests. */
  runId?: string;
}

/**
 * Build the UsageMetadata for an aggregate read. cost_source is "provider_reported"
 * only when the endpoint genuinely exposed a cost; otherwise the existing estimate
 * path (price-table when a known model is present, else missing) is used.
 */
function buildUsageMetadata(usage: ProviderAggregateUsage): UsageMetadata {
  const endpointExposedCost = typeof usage.cost === "number";
  const limitations: string[] = [
    "Aggregate usage/cost read from the provider usage/cost reporting API for account-level reporting; this is a usage/cost report, not a per-run invoice reconciliation.",
    "Aggregate usage only - NO prompt/completion content was captured by this read.",
    "Not billing-confirmed savings (Tier 3): this is the usage/cost substrate only, not a measured applied-optimization billing delta."
  ];
  if (!endpointExposedCost) {
    limitations.push("Cost not exposed by the endpoint; cost remains a price-table estimate or missing.");
  }

  return createUsageMetadata({
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    totalTokens: usage.total_tokens,
    providerReportedTokens: true,
    estimatedTokens: false,
    providerReportedCost: endpointExposedCost,
    currency: usage.currency,
    model: usage.model,
    provider: usage.provider,
    limitations
  });
}

/** A usage-only read produces a trace with NO messages and NO content. */
function buildUsageOnlyTrace(
  usage: ProviderAggregateUsage,
  input: ProviderUsageCaptureInput,
  capturedAt: string,
  runId: string
): AgentTrace {
  return {
    id: runId,
    title: input.label ?? `Provider usage/cost read (${input.endpoint})`,
    artifactVersion: "agent-trace-v1",
    source: "provider_usage",
    createdAt: capturedAt,
    generatedAt: capturedAt,
    model: usage.model ?? "unknown",
    // Aggregate-only: NO messages. A usage-only trace has nothing to compact.
    messages: []
  };
}

/**
 * Build a non-secret provenance descriptor of the read. Records the endpoint and
 * window and the explicit "aggregate usage only, no content" note. NEVER records
 * the credential or any credential-derived value.
 */
function buildProvenance(
  input: ProviderUsageCaptureInput,
  usage: ProviderAggregateUsage,
  capturedAt: string
): CaptureProvenance {
  const windowStart = input.windowStart ?? usage.window_start ?? null;
  const windowEnd = input.windowEnd ?? usage.window_end ?? null;
  const windowDescriptor =
    windowStart || windowEnd ? `window ${windowStart ?? "unspecified"} .. ${windowEnd ?? "unspecified"}` : "window unspecified";

  return {
    captureAdapter: PROVIDER_USAGE_ADAPTER_ID,
    // Non-secret descriptor ONLY: endpoint + window. Never the credential.
    sourcePath: `${input.endpoint} (${windowDescriptor})`,
    capturedAt,
    sessionId: null,
    warnings: [PROVIDER_USAGE_PRIVACY_NOTE],
    limitations: [
      "Read-only, aggregate-only provider usage/cost read (Option A).",
      "NO prompt/completion content was captured by this read.",
      "Credential was read from an environment variable, used only for the single read-only request, and is not recorded here.",
      `Provider-reported usage; cost is ${typeof usage.cost === "number" ? "provider-reported" : "price-table estimated or missing"}.`,
      "Billing-confirmed savings (Tier 3) are NOT claimed."
    ]
  };
}

/**
 * Capture aggregate provider usage/cost into a CapturedRun.
 *
 * Reads the credential from the named env var (refusing cleanly if absent/empty),
 * performs the single read via the injectable client, and normalizes the result
 * into a usage-only CapturedRun. The credential never leaves this function except
 * as the client's auth header value.
 */
export async function captureProviderUsage(input: ProviderUsageCaptureInput): Promise<CapturedRun> {
  const envVar = input.credentialEnvVar ?? DEFAULT_CREDENTIAL_ENV_VAR;
  const env = input.env ?? process.env;

  // Credential acquisition: env var ONLY. Clean refusal on absence - never a fallback.
  const credential = env[envVar];
  if (typeof credential !== "string" || credential.length === 0) {
    throw new MissingProviderCredentialError(envVar);
  }

  const capturedAt = input.capturedAt ?? new Date().toISOString();
  const runId = input.runId ?? `provider-usage-${Date.parse(capturedAt) || Date.now()}`;
  const client = input.client ?? new FetchProviderUsageClient();

  // The single read-only request. The credential is passed in-memory only and is
  // NOT retained after this call (no copy into any returned structure below).
  const usage = await client.fetchUsage({
    endpoint: input.endpoint,
    credential,
    windowStart: input.windowStart,
    windowEnd: input.windowEnd
  });

  const trace = buildUsageOnlyTrace(usage, input, capturedAt, runId);
  const usageMetadata = buildUsageMetadata(usage);
  const provenance = buildProvenance(input, usage, capturedAt);

  // The returned CapturedRun carries usage/cost + non-secret descriptors ONLY.
  // The credential is never part of trace, usage, or provenance.
  return { trace, usage: usageMetadata, provenance };
}
