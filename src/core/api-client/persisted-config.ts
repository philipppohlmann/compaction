/**
 * Compaction API client, PERSISTED configuration (PUBLIC CLI/SDK code).
 *
 * ADDITIVE layer over the env-only `config.ts`: `config.ts` stays pure/env-only and its
 * `resolveApiConfig` contract is UNCHANGED. This module adds an OPT-IN on-disk store used ONLY by
 * `compaction upgrade` / `compaction status` so a private-beta / self-hosted user can save an
 * endpoint + key once instead of re-exporting env vars every shell.
 *
 * HARD RAILS:
 *  - The file lives at `~/.compaction/config.json`, written with mode 0600 (dir 0700). An env
 *    override `COMPACTION_CONFIG_DIR` redirects it (tests point it at a tmpdir; the real
 *    `~/.compaction` is NEVER touched by tests).
 *  - The default URL is `DEFAULT_API_URL`, which is now the PRODUCTION origin: a normal install
 *    activates against the real service rather than a loopback address nobody is running.
 *    `LOCAL_DEV_API_URL` is the loopback origin and is never a default — see `isLocalDevUrl`.
 *  - The API key is written ONLY to this 0600 file. `maskKey` is the ONLY form that may ever be
 *    printed, logged, or placed in an artifact/error; the full key is never surfaced anywhere else.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_API_URL, DEFAULT_TIMEOUT_MS, LOCAL_DEV_API_URL, type ApiConfig, type EnvLike } from "./config.js";
import { compactionConfigDir } from "../config-dir.js";

/** On-disk shape. Only these two fields are ever written; nothing else is persisted. */
export interface PersistedConfig {
  api_url: string;
  api_key: string;
}

/** Where a value came from in the resolution precedence (for honest status reporting). */
export type Source = "flag" | "env" | "file" | "default" | "none";

export interface ResolvedTarget {
  /** Resolved base URL (no trailing slash). */
  url: string;
  /** Resolved bearer token, or `undefined` when none is configured anywhere. */
  apiKey?: string;
  urlSource: Source;
  keySource: Source;
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

/** Resolve the config directory. `COMPACTION_CONFIG_DIR` overrides `~/.compaction` (tests use this). */
export function configDir(env: EnvLike = process.env): string {
  return compactionConfigDir(env);
}

/** Absolute path to the persisted config file. */
export function configPath(env: EnvLike = process.env): string {
  return join(configDir(env), "config.json");
}

/**
 * Read the persisted config, or `undefined` if absent/empty/malformed. Never throws: a corrupt or
 * partial file resolves to `undefined` (fail-closed to "not configured") rather than crashing a
 * command. Only returns a value when BOTH `api_url` and `api_key` are non-empty strings.
 */
export function readPersistedConfig(env: EnvLike = process.env): PersistedConfig | undefined {
  const path = configPath(env);
  if (!existsSync(path)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const url = typeof raw.api_url === "string" ? raw.api_url.trim() : "";
    const key = typeof raw.api_key === "string" ? raw.api_key.trim() : "";
    if (url === "" || key === "") return undefined;
    return { api_url: stripTrailingSlash(url), api_key: key };
  } catch {
    return undefined;
  }
}

/**
 * Persist `{api_url, api_key}` at `~/.compaction/config.json` with mode 0600 (dir 0700). The key
 * touches disk ONLY here. Returns the absolute path written. `chmod` is applied explicitly AFTER the
 * write because `writeFileSync`'s `mode` only takes effect on file CREATION (a pre-existing file
 * keeps its old mode otherwise).
 */
export function writePersistedConfig(config: PersistedConfig, env: EnvLike = process.env): string {
  const dir = configDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "config.json");
  const body = `${JSON.stringify(
    { api_url: stripTrailingSlash(config.api_url.trim()), api_key: config.api_key.trim() },
    null,
    2
  )}\n`;
  writeFileSync(path, body, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

/**
 * Mask an API key for display. Shows a short prefix + the last 4 characters
 * (e.g. `ck_live_…a1b2`). A key too short to mask safely (< 16 chars, where a prefix+suffix would
 * reveal most of it) is FULLY masked. Empty → `(none)`. The full key is NEVER returned.
 */
export function maskKey(key: string | undefined): string {
  const k = (key ?? "").trim();
  if (k === "") return "(none)";
  // Too short to reveal a prefix AND a suffix without exposing most of the key → fully mask.
  if (k.length < 16) return "…(hidden)";
  return `${k.slice(0, 8)}…${k.slice(-4)}`;
}

/**
 * True iff the resolved URL is the LOCAL-DEV origin - i.e. NO hosted endpoint is in play.
 *
 * COMPARE AGAINST THE LOCAL CONSTANT, NEVER THE DEFAULT. This used to read `=== DEFAULT_API_URL`,
 * which was correct only while the default happened to BE loopback. The moment the default was
 * repointed at production, the predicate inverted: production classified as local, so
 * `compaction api connect` refused the very endpoint a fresh install now targets ("no public hosted
 * Compaction endpoint is live yet") and `compaction status` reported `local-only` with a key set.
 * The unit test did not catch it because it asserted `isLocal…(DEFAULT_API_URL) === true` — pinning
 * the symbol, which moved along with the behaviour. The test below now names both origins outright.
 */
export function isLocalDevUrl(url: string): boolean {
  return stripTrailingSlash(url.trim()) === LOCAL_DEV_API_URL;
}

/** Extract the HOST (host:port, no scheme/path) for display. Falls back to the raw string. */
export function urlHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Resolve the effective target for the upgrade/status commands.
 *
 * Precedence (independently for url and key): explicit flag > env
 * (`COMPACTION_API_URL` / `COMPACTION_API_KEY`) > persisted file > `DEFAULT_API_URL` (url) / none
 * (key). Pure: it reads the given env + the persisted file and returns a plain object.
 */
export function resolveTarget(opts: {
  flagUrl?: string;
  flagKey?: string;
  env?: EnvLike;
}): ResolvedTarget {
  const env = opts.env ?? process.env;
  const file = readPersistedConfig(env);

  const flagUrl = (opts.flagUrl ?? "").trim();
  const envUrl = (env.COMPACTION_API_URL ?? "").trim();
  let url: string;
  let urlSource: Source;
  if (flagUrl !== "") {
    url = flagUrl;
    urlSource = "flag";
  } else if (envUrl !== "") {
    url = envUrl;
    urlSource = "env";
  } else if (file) {
    url = file.api_url;
    urlSource = "file";
  } else {
    url = DEFAULT_API_URL;
    urlSource = "default";
  }

  const flagKey = (opts.flagKey ?? "").trim();
  const envKey = (env.COMPACTION_API_KEY ?? "").trim();
  let apiKey: string | undefined;
  let keySource: Source;
  if (flagKey !== "") {
    apiKey = flagKey;
    keySource = "flag";
  } else if (envKey !== "") {
    apiKey = envKey;
    keySource = "env";
  } else if (file) {
    apiKey = file.api_key;
    keySource = "file";
  } else {
    apiKey = undefined;
    keySource = "none";
  }

  return { url: stripTrailingSlash(url), apiKey, urlSource, keySource };
}

/** Build a bounded-timeout `ApiConfig` for a health check from a resolved target. */
export function healthCheckConfig(target: ResolvedTarget, timeoutMs = 5000): ApiConfig {
  return {
    url: target.url,
    apiKey: target.apiKey,
    timeoutMs: timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS
  };
}
