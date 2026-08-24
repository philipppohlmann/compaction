/**
 * Community account credentials store (PUBLIC client).
 *
 * Holds the device identity created by the onboarding Community step or `compaction login`: the
 * device token issued by the
 * control plane plus the locally-generated device key pair. One file, one device — Community is
 * a 1-device tier.
 *
 * HARD RAILS (same discipline as `persisted-config.ts`):
 *  - The file lives at `~/.compaction/credentials.json`, mode 0600 (dir 0700).
 *    `COMPACTION_CONFIG_DIR` redirects it (tests point it at a tmpdir; the real `~/.compaction`
 *    is NEVER touched by tests).
 *  - `maskToken` is the ONLY form of the device token that may ever be printed, logged, or placed
 *    in an artifact/error. The private key is NEVER printed in any form.
 *  - Read never throws: a corrupt/partial file resolves to `undefined` (fail-closed to
 *    "not logged in").
 *  - This module does NO network I/O — it is a pure local store (so account state can be read by
 *    surfaces that must stay network-free).
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "../api-client/persisted-config.js";
import type { EnvLike } from "../api-client/config.js";

export interface StoredCredentials {
  schema_version: 1;
  /** Base URL of the Compaction service that issued the device token. */
  api_url: string;
  account_id: string;
  /** Dev-phase asserted email shown at login; display only. */
  email?: string;
  device_id: string;
  device_name?: string;
  /** The issued device token (`cmpd_…`). Only ever printed via `maskToken`. */
  device_token: string;
  /** Locally-generated Ed25519 device key pair (PKCS8 PEM private, base64url SPKI public). */
  device_private_key_pem: string;
  device_public_key: string;
  created_at: string;
}

/** Absolute path of the credentials file. */
export function credentialsPath(env: EnvLike = process.env): string {
  return join(configDir(env), "credentials.json");
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * Read the stored credentials, or `undefined` when absent/corrupt/incomplete (fail-closed to
 * "not logged in"). Never throws.
 */
export function readStoredCredentials(env: EnvLike = process.env): StoredCredentials | undefined {
  const path = credentialsPath(env);
  if (!existsSync(path)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (raw.schema_version !== 1) return undefined;
    if (
      !isNonEmptyString(raw.api_url) ||
      !isNonEmptyString(raw.account_id) ||
      !isNonEmptyString(raw.device_id) ||
      !isNonEmptyString(raw.device_token) ||
      !isNonEmptyString(raw.device_private_key_pem) ||
      !isNonEmptyString(raw.device_public_key) ||
      !isNonEmptyString(raw.created_at)
    ) {
      return undefined;
    }
    return {
      schema_version: 1,
      api_url: raw.api_url.replace(/\/+$/, ""),
      account_id: raw.account_id,
      ...(isNonEmptyString(raw.email) ? { email: raw.email } : {}),
      device_id: raw.device_id,
      ...(isNonEmptyString(raw.device_name) ? { device_name: raw.device_name } : {}),
      device_token: raw.device_token,
      device_private_key_pem: raw.device_private_key_pem,
      device_public_key: raw.device_public_key,
      created_at: raw.created_at
    };
  } catch {
    return undefined;
  }
}

/**
 * Persist credentials at mode 0600 (dir 0700). `chmod` is applied explicitly AFTER the write
 * because `writeFileSync`'s `mode` only takes effect on file CREATION. Returns the path written.
 */
export function writeStoredCredentials(credentials: StoredCredentials, env: EnvLike = process.env): string {
  const dir = configDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "credentials.json");
  writeFileSync(path, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

/** Delete the stored credentials (logout). Missing file is fine. */
export function deleteStoredCredentials(env: EnvLike = process.env): void {
  rmSync(credentialsPath(env), { force: true });
}

/**
 * Mask a device token for display: shows the non-secret prefix (env label + short device id) and
 * the last 4 characters. The full token is NEVER returned.
 */
export function maskToken(token: string | undefined): string {
  const t = (token ?? "").trim();
  if (t === "") return "(none)";
  if (t.length < 24) return "…(hidden)";
  return `${t.slice(0, 14)}…${t.slice(-4)}`;
}
