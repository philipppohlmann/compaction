/**
 * Entitlement lease trust roots (PUBLIC client) — SEPARATE from the engine-release roots.
 *
 * A leased entitlement and a signed engine binary are DIFFERENT trust domains: a leaked lease key
 * must not be able to sign an engine artifact and vice versa. So the lease roots live here, wholly
 * apart from `engine-install/manifest.ts`, and the signed bytes additionally carry the
 * `compaction-lease-v1` domain tag (`entitlement/lease.ts`).
 *
 * HARD RAILS (mirror the engine trust model exactly):
 *  - The compiled-in production lease root is PINNED to a real key, minted offline.
 *    `leaseRootPinned` still refuses a placeholder, so a build that has
 *    NOT had a root minted for it fails closed (`lease-root-not-pinned`) — that mechanism is
 *    unchanged, and pinning is the deliberate, reviewed activation it was waiting for rather than
 *    machinery that woke itself up.
 *  - The trust root is NEVER overridable via an environment variable. The only non-pinned path is an
 *    EXPLICIT dev root at `<configDir>/entitlement/dev-lease-root.pub`, written by a visible local
 *    dev act; anything it verifies is labeled DEV-SIGNED — not a production entitlement.
 *  - Pure/Open-path-safe: `node:fs` + `node:crypto` (via `../crypto/ed25519`) only. Never a network
 *    call, never an account/api-client or engine import.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { KeyObject } from "node:crypto";
import { compactionConfigDir, type ConfigDirEnv } from "../config-dir.js";
import { publicKeyFromSpkiB64u, verifyDetachedSignature } from "../crypto/ed25519.js";

/** Which trust root class verified a lease signature. `dev-lease-root` is loudly surfaced. */
export type LeaseTrustSource = "pinned-lease-root" | "dev-lease-root";

/** A compiled-in lease trust root: a key id + an Ed25519 public key (base64url SPKI DER). */
export interface LeaseRootKey {
  key_id: string;
  /** Base64url SPKI DER Ed25519 public key, or a refused placeholder. */
  public_key_spki_b64u: string;
}

/**
 * Marker prefix of the refused production placeholder. `leaseRootPinned` fails anything carrying it,
 * so a build that has not had a root minted for it keeps the compiled-in lease trust path DORMANT
 * (fail-closed). It is not what THIS build carries — see `LEASE_ROOT_KEYS` — but it remains the
 * mechanism, and the one a rollback or a fresh branch falls back to.
 */
export const UNPINNED_LEASE_ROOT_KEY_MARKER = "UNPINNED-PLACEHOLDER";

/**
 * The compiled-in production lease trust roots. PINNED: a real Ed25519 public key, minted offline.
 * Only the PUBLIC half is here and only the public half ever
 * ships — the private key exists solely as a server-side secret the issuing service reads, and this
 * file is the reason a lease that key did not sign cannot be used on any device.
 *
 * SEPARATE FROM THE ENGINE ROOT, cryptographically and by file: this root can only verify leases and
 * the engine release root (`engine-install/manifest.ts`) can only verify artifacts, so compromising
 * one cannot forge the other.
 */
export const LEASE_ROOT_KEYS: readonly LeaseRootKey[] = [
  {
    key_id: "compaction-lease-root-v1",
    public_key_spki_b64u: "MCowBQYDK2VwAyEAwMe8cGisb3j7_HA-Qgt0Wbun65_WsHMWaugCzXEXsEg"
  }
];

/**
 * True only when a root entry carries a plausibly real key (not the placeholder). Ed25519 SPKI DER
 * is 44 bytes → 59 base64url chars; require valid base64url decoding to exactly 44 bytes.
 */
export function leaseRootPinned(root: LeaseRootKey): boolean {
  const key = root.public_key_spki_b64u;
  if (key.includes(UNPINNED_LEASE_ROOT_KEY_MARKER)) return false;
  if (!/^[A-Za-z0-9_-]+$/.test(key)) return false;
  return Buffer.from(key, "base64url").length === 44;
}

/**
 * The pinned (usable) subset of the compiled-in lease roots. NON-EMPTY in this build — the lease path
 * is live, and every caller that branches on emptiness is now taking its other branch for real.
 */
export function pinnedLeaseRootKeys(): LeaseRootKey[] {
  return LEASE_ROOT_KEYS.filter(leaseRootPinned);
}

/** The explicit dev lease-root file (separate from the engine dev root). */
export function devLeaseRootKeyPath(env: ConfigDirEnv = process.env): string {
  return join(compactionConfigDir(env), "entitlement", "dev-lease-root.pub");
}

/** Read the explicit dev lease root, if installed. Malformed/absent → undefined (never throws). */
export function readDevLeaseRootKey(env: ConfigDirEnv = process.env): KeyObject | undefined {
  const path = devLeaseRootKeyPath(env);
  try {
    if (!existsSync(path)) return undefined;
    const spki = readFileSync(path, "utf8").trim();
    if (spki === "") return undefined;
    return publicKeyFromSpkiB64u(spki);
  } catch {
    return undefined;
  }
}

export type LeaseSignatureVerification =
  | { verified: true; trust: LeaseTrustSource }
  | { verified: false; reason: "lease-root-not-pinned" | "signature-invalid" };

/**
 * Verify a lease's signature bytes against the allowed roots: pinned roots first, then the explicit
 * dev root (labeled). With NO pinned root and NO dev root the reason is `lease-root-not-pinned`: a
 * build nobody has minted a root for verifies nothing rather than everything. (This build has one —
 * see `pinnedLeaseRootKeys` — so that is the fallback, not the state.)
 */
export function verifyLeaseSignatureBytes(
  leaseBytes: Buffer,
  signatureB64u: string,
  env: ConfigDirEnv = process.env
): LeaseSignatureVerification {
  let sawUsableRoot = false;
  for (const root of pinnedLeaseRootKeys()) {
    const key = publicKeyFromSpkiB64u(root.public_key_spki_b64u);
    if (!key) continue;
    sawUsableRoot = true;
    if (verifyDetachedSignature(leaseBytes, signatureB64u, key)) {
      return { verified: true, trust: "pinned-lease-root" };
    }
  }
  const devRoot = readDevLeaseRootKey(env);
  if (devRoot) {
    sawUsableRoot = true;
    if (verifyDetachedSignature(leaseBytes, signatureB64u, devRoot)) {
      return { verified: true, trust: "dev-lease-root" };
    }
  }
  return { verified: false, reason: sawUsableRoot ? "signature-invalid" : "lease-root-not-pinned" };
}
