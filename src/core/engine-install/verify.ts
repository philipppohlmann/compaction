/**
 * Engine-release verification — Ed25519 signature + sha256 digest checks (PUBLIC client).
 *
 * Pure/deterministic verification primitives plus the ONE shared "is this installed artifact
 * trustworthy" routine (`verifyInstalledArtifact`) used by BOTH the supervisor (verify-before-run,
 * synchronous, on the spawn path) and `compaction engine status` (display). Single implementation
 * so run-time trust and reported trust can never drift.
 *
 * Trust model (fail-closed):
 *  - A signature verifies against the compiled-in PINNED roots (`manifest.ts`) — empty today by
 *    design (a build with no minted root refuses everything; this one pins a real key at the distribute-engine-binary
 *    gate) — or against the EXPLICIT dev root installed at `<configDir>/engine/dev-root-key.pub`
 *    by `compaction engine install --dev-root-key`. Nothing else. No env-var trust override.
 *  - A dev-root verification is labeled `trust: "dev-root"` everywhere so a DEV-SIGNED install can
 *    never present as a release.
 *  - Every failure is a fixed content-free label; no server/file text leaks into results.
 */
import { createHash, type KeyObject } from "node:crypto";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { pipeline } from "node:stream/promises";
import { configDir } from "../api-client/persisted-config.js";
import type { EnvLike } from "../api-client/config.js";
import { publicKeyFromSpkiB64u, verifyDetachedSignature } from "../crypto/ed25519.js";
import {
  canonicalManifestBytes,
  parseEngineReleaseManifest,
  pinnedRootKeys,
  rootAuthorizesManifest,
  type EngineReleaseManifest
} from "./manifest.js";

// Re-exported for backward compatibility: these Ed25519 primitives moved to the shared, pure
// `../crypto/ed25519.js` (single implementation, no drift with the entitlement lease verifier).
export { publicKeyFromSpkiB64u, verifyDetachedSignature };

/** File names of a signed install, colocated with the artifact in its version directory. */
export const MANIFEST_FILENAME = "manifest.json";
export const SIGNATURE_FILENAME = "manifest.sig";

/** The explicit dev trust root file (written ONLY by `engine install --dev-root-key`). */
export function devRootKeyPath(env: EnvLike = process.env): string {
  return join(configDir(env), "engine", "dev-root-key.pub");
}

/** Which trust root class verified a signature. `dev-root` is loudly surfaced everywhere. */
export type EngineTrustSource = "pinned-root" | "dev-root";

/** Streaming sha256 of a file, lowercase hex (installer path — potentially large artifacts). */
export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(filePath), hash);
  return hash.digest("hex");
}

/** Synchronous sha256 of a file, lowercase hex (supervisor verify-before-run path). */
export function sha256FileSync(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

/** Read the explicit dev root, if installed. Malformed/absent → undefined (never throws). */
export function readDevRootKey(env: EnvLike = process.env): KeyObject | undefined {
  const path = devRootKeyPath(env);
  try {
    if (!existsSync(path)) return undefined;
    const spki = readFileSync(path, "utf8").trim();
    if (spki === "") return undefined;
    return publicKeyFromSpkiB64u(spki);
  } catch {
    return undefined;
  }
}

export type ManifestVerification =
  | { verified: true; trust: "pinned-root"; key_id: string }
  | { verified: true; trust: "dev-root" }
  | { verified: false; reason: "root-key-not-pinned" | "signature-invalid" | "manifest-invalid" };

/**
 * Verify a manifest's signature bytes against the allowed trust roots: pinned roots first, then
 * the explicit dev root (labeled). With NO pinned root and NO dev root the reason is
 * `root-key-not-pinned`: a build nobody has minted a root for verifies nothing rather than
 * everything. (This build has one — see `pinnedRootKeys` — so that is the fallback, not the state.)
 */
export function verifyManifestSignature(
  manifestBytes: Buffer,
  signatureB64u: string,
  env: EnvLike = process.env
): ManifestVerification {
  let sawUsableRoot = false;
  const manifest = parseEngineReleaseManifest(manifestBytes.toString("utf8"));
  const canonical = manifest === undefined ? undefined : canonicalManifestBytes(manifest);
  if (manifest === undefined || canonical === undefined || !canonical.equals(manifestBytes)) {
    return { verified: false, reason: "manifest-invalid" };
  }
  const canonicalDigest = createHash("sha256").update(canonical).digest("hex");
  for (const root of pinnedRootKeys()) {
    const key = publicKeyFromSpkiB64u(root.public_key_spki_b64u);
    if (!key) continue;
    sawUsableRoot = true;
    if (rootAuthorizesManifest(root, manifest, canonicalDigest) &&
        verifyDetachedSignature(manifestBytes, signatureB64u, key)) {
      return { verified: true, trust: "pinned-root", key_id: root.key_id };
    }
  }
  const devRoot = readDevRootKey(env);
  if (devRoot) {
    sawUsableRoot = true;
    if (verifyDetachedSignature(manifestBytes, signatureB64u, devRoot)) {
      return { verified: true, trust: "dev-root" };
    }
  }
  return { verified: false, reason: sawUsableRoot ? "signature-invalid" : "root-key-not-pinned" };
}

/** Fixed content-free reasons an installed artifact can fail verify-before-run. */
export type InstalledArtifactFailure =
  | "manifest-missing"
  | "manifest-invalid"
  | "root-key-not-pinned"
  | "signature-invalid"
  | "artifact-digest-mismatch"
  | "artifact-unreadable";

export type InstalledArtifactVerification =
  | { verified: true; trust: "pinned-root"; key_id: string; manifest: EngineReleaseManifest }
  | { verified: true; trust: "dev-root"; manifest: EngineReleaseManifest }
  | { verified: false; reason: InstalledArtifactFailure };

/**
 * Verify-before-run: given the artifact path the `current` pointer names, require a valid signed
 * manifest NEXT TO the artifact whose signature verifies against an allowed root AND whose sha256
 * matches the artifact bytes. Synchronous (spawn path), never throws, fail-closed on any anomaly.
 */
export function verifyInstalledArtifact(
  artifactPath: string,
  env: EnvLike = process.env
): InstalledArtifactVerification {
  const dir = dirname(artifactPath);
  let manifestText: string;
  let signature: string;
  try {
    const manifestFile = join(dir, MANIFEST_FILENAME);
    const signatureFile = join(dir, SIGNATURE_FILENAME);
    if (!existsSync(manifestFile) || !existsSync(signatureFile)) {
      return { verified: false, reason: "manifest-missing" };
    }
    manifestText = readFileSync(manifestFile, "utf8");
    signature = readFileSync(signatureFile, "utf8").trim();
  } catch {
    return { verified: false, reason: "manifest-missing" };
  }

  const manifest = parseEngineReleaseManifest(manifestText);
  if (!manifest) return { verified: false, reason: "manifest-invalid" };

  // The signature covers the CANONICAL bytes; a stored manifest that verifies but re-serializes
  // differently would be a tamper vector, so verify against the canonical form of what we parsed.
  const canonical = canonicalManifestBytes(manifest);
  if (manifest.schema_version === 2 && !canonical.equals(Buffer.from(manifestText, "utf8"))) {
    return { verified: false, reason: "manifest-invalid" };
  }
  const signatureCheck = verifyManifestSignature(canonical, signature, env);
  if (!signatureCheck.verified) return { verified: false, reason: signatureCheck.reason };

  let digest: string;
  try {
    digest = sha256FileSync(artifactPath);
  } catch {
    return { verified: false, reason: "artifact-unreadable" };
  }
  if (digest !== manifest.sha256.toLowerCase()) {
    return { verified: false, reason: "artifact-digest-mismatch" };
  }
  return signatureCheck.trust === "pinned-root"
    ? { verified: true, trust: signatureCheck.trust, key_id: signatureCheck.key_id, manifest }
    : { verified: true, trust: signatureCheck.trust, manifest };
}
