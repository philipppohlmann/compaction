/**
 * Compaction API client, configuration (PUBLIC CLI/SDK code).
 *
 * Reads env ONLY. Persists NOTHING. The default URL is the PRODUCTION service, so a normal
 * install — which sets no environment at all — activates against production rather than a
 * loopback address nobody is running. The API key (when set) is attached as a bearer token at
 * call time and is NEVER persisted, logged, or printed.
 */

/**
 * The canonical production API origin. This is the origin a fresh device activation records, and
 * therefore the origin every later entitlement call is made against.
 *
 * It is deliberately a single constant: the host a device authenticated to is a trust boundary
 * (`lease-client` refuses redirects precisely so a device token cannot be moved to another host),
 * so it must be reviewable in one place rather than assembled at call time. Local development
 * overrides it with `COMPACTION_API_URL`; nothing else may.
 */
export const PRODUCTION_API_URL = "https://compaction-api-513828095806.europe-west1.run.app";

/** Default base URL for a normal install: production. Override with `COMPACTION_API_URL`. */
export const DEFAULT_API_URL = PRODUCTION_API_URL;

/** The loopback origin `apps/api` binds in local development. Never a default. */
export const LOCAL_DEV_API_URL = "http://127.0.0.1:8787";

/** Default per-request timeout. Override with `COMPACTION_API_TIMEOUT_MS`. */
export const DEFAULT_TIMEOUT_MS = 30_000;

export interface ApiConfig {
  /** Resolved base URL (no trailing slash). */
  url: string;
  /** Optional bearer token. `undefined` when `COMPACTION_API_KEY` is unset. */
  apiKey?: string;
  /** Per-request timeout in milliseconds. */
  timeoutMs: number;
}

/** A minimal env shape so this is pure/testable (defaults to `process.env`). */
export type EnvLike = Record<string, string | undefined>;

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

/**
 * Resolve API config from the environment. Pure: same env in → same config out. Never reads
 * or writes any file and never mutates the env.
 *
 *  - `COMPACTION_API_URL`     → base URL. Unset → the PRODUCTION Compaction API origin
 *                                (`DEFAULT_API_URL`); loopback is never a default and must be asked for.
 *  - `COMPACTION_API_KEY`     → optional bearer token (unset by default).
 *  - `COMPACTION_API_TIMEOUT_MS` → optional positive integer timeout.
 */
export function resolveApiConfig(env: EnvLike = process.env): ApiConfig {
  const rawUrl = (env.COMPACTION_API_URL ?? "").trim();
  const url = stripTrailingSlash(rawUrl === "" ? DEFAULT_API_URL : rawUrl);

  const rawKey = (env.COMPACTION_API_KEY ?? "").trim();
  const apiKey = rawKey === "" ? undefined : rawKey;

  const rawTimeout = (env.COMPACTION_API_TIMEOUT_MS ?? "").trim();
  const parsedTimeout = Number.parseInt(rawTimeout, 10);
  const timeoutMs =
    Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : DEFAULT_TIMEOUT_MS;

  return { url, apiKey, timeoutMs };
}

/**
 * Build request headers. The API key (when present) is attached as a bearer token. Returns a
 * fresh object each call; the key is never stored elsewhere.
 */
export function buildHeaders(config: ApiConfig): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
  return headers;
}
