/**
 * DEV/TEST release signing (PUBLIC code, dev tooling + tests only — no production key lives here).
 *
 * Generates throwaway Ed25519 keypairs and signs release manifests for LOCAL dev/test releases.
 * Anything signed with a key from here verifies ONLY via the explicit dev root
 * (`engine install --dev-root-key`) and is labeled DEV-SIGNED on every surface. Production
 * signing happens offline, outside this repo, with a key that is never checked in; the
 * compiled-in production root (`manifest.ts`) never verifies one of these: a dev-signed artifact is
 * accepted only against an explicitly installed dev root, and by nothing else.
 */
import { generateKeyPairSync, sign as cryptoSign, createPrivateKey } from "node:crypto";
import { canonicalManifestBytes, type EngineReleaseManifest } from "./manifest.js";

export interface DevSigningKeyPair {
  /** Base64url SPKI DER — the dev trust root content (`dev-root-key.pub`). */
  publicKeySpkiB64u: string;
  /** PKCS8 PEM — the throwaway signing key. Never a production secret. */
  privateKeyPem: string;
}

/** Generate a throwaway Ed25519 dev signing keypair. */
export function generateDevSigningKeyPair(): DevSigningKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKeySpkiB64u: publicKey.export({ type: "spki", format: "der" }).toString("base64url"),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString()
  };
}

/** Sign a manifest's canonical bytes. Returns base64url of the raw Ed25519 signature. */
export function signManifest(manifest: EngineReleaseManifest, privateKeyPem: string): string {
  const key = createPrivateKey(privateKeyPem);
  return cryptoSign(null, canonicalManifestBytes(manifest), key).toString("base64url");
}
