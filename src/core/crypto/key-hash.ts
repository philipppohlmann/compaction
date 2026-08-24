/**
 * Public-key hash (PUBLIC client, pure — `node:crypto` only).
 *
 * The single client-side implementation of the device public-key hash: lowercase SHA-256 hex of the
 * base64url SPKI DER public-key STRING (exactly as stored in `credentials.json` and sent to the
 * control plane at device registration). It MUST byte-for-byte match the server-side
 * `apps/control-plane/src/device-keys.ts#publicKeyHash` — the lease binds to
 * `device_public_key_hash` computed there at registration, and the lease-store recomputes it here
 * to prove the lease belongs to THIS device. The parity is pinned by a test.
 *
 * Import-safe on the Open path: `node:crypto` only. Never throws.
 */
import { createHash } from "node:crypto";

/** Lowercase SHA-256 hex of a base64url SPKI DER public-key string. */
export function publicKeyHash(publicKey: string): string {
  return createHash("sha256").update(publicKey, "utf8").digest("hex");
}
