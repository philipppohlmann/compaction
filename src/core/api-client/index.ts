/**
 * Compaction API client, public surface (PUBLIC CLI/SDK code).
 *
 * The typed boundary the public CLI uses to talk to the private Compaction API over the documented HTTP
 * contract ONLY. It imports NOTHING from `src/engine`, makes NO call at import time, and never
 * auto-uploads. It is NOT wired into any free command; an API call happens only when a caller
 * explicitly invokes `apiStatus` / `sendRequest`.
 */
export {
  DEFAULT_API_URL,
  PRODUCTION_API_URL,
  LOCAL_DEV_API_URL,
  DEFAULT_TIMEOUT_MS,
  resolveApiConfig,
  buildHeaders,
  type ApiConfig,
  type EnvLike
} from "./config.js";

// ADDITIVE opt-in persisted-config layer (upgrade/status). Does NOT change the env-only
// `resolveApiConfig` contract above.
export {
  configDir,
  configPath,
  readPersistedConfig,
  writePersistedConfig,
  maskKey,
  isLocalDevUrl,
  urlHost,
  resolveTarget,
  healthCheckConfig,
  type PersistedConfig,
  type ResolvedTarget,
  type Source
} from "./persisted-config.js";

export {
  isContentBearing,
  ConsentError,
  buildOptimizeRequest,
  buildEvaluateRequest,
  buildReportsRequest,
  previewPayload,
  sanitizePreviewUrl,
  validateContentFreeDocument,
  type OptimizeBuildOptions,
  type EvaluateBuildOptions,
  type ReportsBuildOptions,
  type PayloadPreview
} from "./payload.js";

export {
  apiStatus,
  sendIngestExport,
  sendRequest,
  ApiNotConfirmedError,
  ApiTransportError,
  type ApiResponse,
  type SendOptions
} from "./client.js";

export {
  CONTENT_BEARING_PAYLOAD_CLASSES,
  type PayloadClass,
  type TokenSource,
  type Consent,
  type Trace,
  type TokenUsage,
  type ProviderMetadata,
  type OptimizeRequest,
  type EvaluateRequest,
  type ReportsRequest,
  type ApiRequestBody,
  type StatusResponse,
  type ApiErrorBody
} from "./types.js";

export { TOOL_NAMES, isToolName, resolveToolName, type ToolName } from "./tool.js";
