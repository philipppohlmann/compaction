/**
 * Compaction API client, wire types (PUBLIC CLI/SDK code).
 *
 * OPEN-CORE BOUNDARY: this module is part of the PUBLIC `@compaction/cli` package and
 * ships in the published tarball. It MUST NOT import anything from `src/engine` and MUST
 * NOT import the private `apps/api` package. It mirrors, by hand, with no cross-package
 * import, the request/response SHAPES defined in `apps/api/src/schemas.ts` and the contract
 * in `docs/api/compaction-api-v0.md`. The client speaks only the documented HTTP contract.
 *
 * Keeping these types LOCAL (rather than importing the `apps/api` zod schemas) is deliberate:
 * it guarantees the public package has zero build/runtime coupling to the server package or
 * the engine. The local-stub tests assert the shapes still line up with the live contract.

 */

/** Payload classes (mirror of `apps/api` `PayloadClassSchema`). */
export type PayloadClass =
  | "metrics_only"
  | "redacted_structure"
  | "sanitized_snippets"
  | "full_trace";

/** Classes that carry raw-or-sanitized CONTENT and therefore require explicit upload consent. */
export const CONTENT_BEARING_PAYLOAD_CLASSES: ReadonlySet<PayloadClass> = new Set<PayloadClass>([
  "sanitized_snippets",
  "full_trace"
]);

/** Honest token-source labels (mirror of `apps/api` `TokenSourceSchema`). Never upgraded. */
export type TokenSource = "provider-reported" | "local-estimate" | "unknown";

/** Canonical coding-tool identity (re-exported from the source of truth in `./tool`). */
export type { ToolName } from "./tool.js";
import type { ToolName } from "./tool.js";

/**
 * Content-free provider/tool attribution sent alongside a request. All fields are short
 * identifiers (provider, tool, model name), NEVER prompt/completion/trace content. The server
 * records them on the content-free usage event so a workspace can be grouped by tool/provider/model.
 */
export interface ProviderMetadata {
  provider?: string;
  runtime?: string;
  tool?: ToolName;
  model?: string;
}

export interface Consent {
  upload_permitted: boolean;
  redacted: boolean;
}

export interface Trace {
  redacted: boolean;
  content?: Record<string, unknown>;
  reference?: string;
}

export interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  source: TokenSource;
}

export interface OptimizeRequest {
  trace: Trace;
  consent: Consent;
  payload_class?: PayloadClass;
  provider_metadata?: ProviderMetadata;
  token_usage: TokenUsage;
  evidence_labels?: Record<string, unknown>;
  labels?: { project?: string; session?: string };
  optimization_mode: "recommend" | "compact" | "apply-ready";
}

export interface EvaluateRequest {
  original_trace: Trace;
  compacted_context: { content?: Record<string, unknown>; reference?: string };
  consent: Consent;
  payload_class?: PayloadClass;
  evidence_requirements?: {
    require_recoverability?: boolean;
    require_commitment_preservation?: boolean;
    require_task_replay?: boolean;
  };
}

export interface ReportsRequest {
  report_bundle: {
    runs?: Array<Record<string, unknown>>;
    summary?: Record<string, unknown>;
    redacted: boolean;
  };
  labels?: { team?: string; project?: string };
  consent: Consent;
  payload_class?: PayloadClass;
}

/** Any payload-bearing request body (carries `consent` + optional `payload_class`). */
export type ApiRequestBody = OptimizeRequest | EvaluateRequest | ReportsRequest;

/** `GET /v0/status` response (honest local-engine-dev shape). */
export interface StatusResponse {
  status: "ok";
  service: "compaction-api";
  version: "v0";
  mode: string;
  engine: string;
  hosted: boolean;
  uptime_seconds: number;
}

/** Coded error body shape returned by every endpoint on failure. */
export interface ApiErrorBody {
  error: string;
  details?: unknown;
}
