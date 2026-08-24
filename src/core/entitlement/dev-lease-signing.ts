/**
 * DEV/TEST lease signing (PUBLIC code, dev tooling + tests only — no production key lives here).
 *
 * Generates throwaway Ed25519 keypairs and signs lease payloads for LOCAL dev/test. Anything signed
 * with a key from here verifies ONLY via the explicit dev lease root
 * (`<configDir>/entitlement/dev-lease-root.pub`) and is labeled DEV-SIGNED — not a production
 * entitlement — on every surface. Production lease signing happens SERVER-SIDE with an offline-minted
 * key; the compiled-in production lease root (`lease-roots.ts`) is a refused
 * placeholder until then.
 *
 * The SERVER (`apps/control-plane/src/leases.ts`, a self-contained package) re-implements the same
 * canonical-bytes signing against the frozen wire contract; a pinned byte vector on both sides
 * catches drift.
 */
import { generateKeyPairSync, sign as cryptoSign, createPrivateKey } from "node:crypto";
import { canonicalLeaseBytes, type LeasePayload } from "./lease.js";

export interface DevLeaseSigningKeyPair {
  /** Base64url SPKI DER — the dev lease-root content (`dev-lease-root.pub`). */
  publicKeySpkiB64u: string;
  /** PKCS8 PEM — the throwaway signing key. Never a production secret. */
  privateKeyPem: string;
}

/** Generate a throwaway Ed25519 dev lease-signing keypair. */
export function generateDevLeaseSigningKeyPair(): DevLeaseSigningKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKeySpkiB64u: publicKey.export({ type: "spki", format: "der" }).toString("base64url"),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString()
  };
}

/** Sign a lease payload's canonical bytes. Returns base64url of the raw Ed25519 signature. */
export function signLeasePayload(payload: LeasePayload, privateKeyPem: string): string {
  const key = createPrivateKey(privateKeyPem);
  return cryptoSign(null, canonicalLeaseBytes(payload), key).toString("base64url");
}
