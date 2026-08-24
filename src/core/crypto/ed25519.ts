/**
 * Shared Ed25519 verification primitives (PUBLIC client, pure — `node:crypto` only).
 *
 * The ONE implementation of "build a public key from base64url SPKI DER", "verify a detached
 * Ed25519 signature", and "sign detached with a private key", shared by every client-side call site
 * so a security primitive can never drift. Verify is used by the engine-release verifier
 * (`engine-install/verify.ts`) AND the entitlement lease verifier (`entitlement/lease-store.ts`);
 * `signDetached` is used by the usage-metering path (`usage/usage-metering.ts`) to sign a usage
 * event with the DEVICE private key.
 *
 * Import-safe on the Open path: `node:crypto` only — no fs, no network, no engine, no account/api
 * client. The verify helpers are total (never throw). `signDetached` REQUIRES a private key and
 * therefore only ever runs on the apply/metering path (off the pure Open/lease-store graph); it
 * throws on an unusable key so the caller can fail-closed on the mutation.
 */
import { createPrivateKey, createPublicKey, sign as cryptoSign, verify as cryptoVerify, type KeyObject } from "node:crypto";

/** Build a KeyObject from a base64url SPKI DER Ed25519 public key. Undefined on malformed input. */
export function publicKeyFromSpkiB64u(spkiB64u: string): KeyObject | undefined {
  try {
    return createPublicKey({ key: Buffer.from(spkiB64u, "base64url"), format: "der", type: "spki" });
  } catch {
    return undefined;
  }
}

/** Ed25519 detached-signature check. `signatureB64u` is base64url of the raw 64-byte signature. */
export function verifyDetachedSignature(data: Buffer, signatureB64u: string, publicKey: KeyObject): boolean {
  try {
    const signature = Buffer.from(signatureB64u, "base64url");
    if (signature.length === 0) return false;
    return cryptoVerify(null, data, publicKey, signature);
  } catch {
    return false;
  }
}

/**
 * Ed25519 detached signature over `data` with a PKCS8 PEM private key. Returns base64url of the raw
 * 64-byte signature. THROWS on an unusable key (the caller fails-closed on the mutation) — signing is
 * never a silent no-op. Requires the PRIVATE key, so it lives ONLY on the apply/metering path.
 */
export function signDetached(data: Buffer, privateKeyPem: string): string {
  const key = createPrivateKey(privateKeyPem);
  return cryptoSign(null, data, key).toString("base64url");
}
