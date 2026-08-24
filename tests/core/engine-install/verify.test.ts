/**
 * Engine-release verification tests: Ed25519 sign/verify round-trip, tamper detection,
 * trust-root resolution (pinned = none by design; explicit dev root only), and the full
 * verify-before-run routine over an on-disk install layout.
 *
 * All file I/O is COMPACTION_CONFIG_DIR-redirected to a tmpdir — the real ~/.compaction is never
 * touched. Keys are throwaway test keypairs generated per run.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateDevSigningKeyPair, signManifest } from "../../../src/core/engine-install/dev-signing.js";
import { canonicalManifestBytes, type EngineReleaseManifest } from "../../../src/core/engine-install/manifest.js";
import {
  MANIFEST_FILENAME,
  SIGNATURE_FILENAME,
  devRootKeyPath,
  publicKeyFromSpkiB64u,
  sha256FileSync,
  verifyDetachedSignature,
  verifyInstalledArtifact,
  verifyManifestSignature
} from "../../../src/core/engine-install/verify.js";

let configDir: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  configDir = mkdtempSync(path.join(tmpdir(), "engine-verify-"));
  env = { COMPACTION_CONFIG_DIR: configDir };
});
afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

function installDevRoot(publicKeySpkiB64u: string): void {
  mkdirSync(path.join(configDir, "engine"), { recursive: true });
  writeFileSync(devRootKeyPath(env), `${publicKeySpkiB64u}\n`);
}

function manifestFor(artifactBytes: Buffer, kind: "node-script" | "native-binary" = "node-script"): EngineReleaseManifest {
  return {
    schema_version: 1,
    version: "0.1.0-dev",
    channel: "dev",
    platform: "any",
    arch: "any",
    artifact_kind: kind,
    sha256: createHash("sha256").update(artifactBytes).digest("hex"),
    size_bytes: artifactBytes.length
  };
}

/** Lay out a signed install dir and return the artifact path. */
function writeInstall(manifest: EngineReleaseManifest, signature: string, artifactBytes: Buffer): string {
  const versionDir = path.join(configDir, "engine", manifest.version);
  mkdirSync(versionDir, { recursive: true });
  const artifactPath = path.join(versionDir, "engine.js");
  writeFileSync(artifactPath, artifactBytes);
  writeFileSync(path.join(versionDir, MANIFEST_FILENAME), canonicalManifestBytes(manifest));
  writeFileSync(path.join(versionDir, SIGNATURE_FILENAME), `${signature}\n`);
  return artifactPath;
}

describe("Ed25519 primitives", () => {
  it("sign/verify round-trips and detects tampering", () => {
    const pair = generateDevSigningKeyPair();
    const key = publicKeyFromSpkiB64u(pair.publicKeySpkiB64u)!;
    const manifest = manifestFor(Buffer.from("engine bytes"));
    const signature = signManifest(manifest, pair.privateKeyPem);

    expect(verifyDetachedSignature(canonicalManifestBytes(manifest), signature, key)).toBe(true);
    const tampered = { ...manifest, version: "9.9.9-evil" };
    expect(verifyDetachedSignature(canonicalManifestBytes(tampered), signature, key)).toBe(false);
    expect(verifyDetachedSignature(canonicalManifestBytes(manifest), "AAAA", key)).toBe(false);
    expect(verifyDetachedSignature(canonicalManifestBytes(manifest), "", key)).toBe(false);
    expect(verifyDetachedSignature(canonicalManifestBytes(manifest), "!!!", key)).toBe(false);
  });

  it("sha256FileSync matches the manifest digest computation", () => {
    const file = path.join(configDir, "f.bin");
    writeFileSync(file, Buffer.from("digest me"));
    expect(sha256FileSync(file)).toBe(createHash("sha256").update("digest me").digest("hex"));
  });
});

describe("trust-root resolution", () => {
  it("a foreign key never verifies against the pinned production root, and no dev root", () => {
    // The production engine root is pinned in this build, so an unknown signer no longer stops at
    // `root-key-not-pinned` — it reaches the signature check and is refused there. Either way the
    // load-bearing property is identical: material this build did not authorise never verifies.
    const pair = generateDevSigningKeyPair();
    const manifest = manifestFor(Buffer.from("x"));
    const signature = signManifest(manifest, pair.privateKeyPem);
    expect(verifyManifestSignature(canonicalManifestBytes(manifest), signature, env)).toEqual({
      verified: false,
      reason: "signature-invalid"
    });
  });

  it("an explicit dev root verifies and is labeled dev-root (never a release root)", () => {
    const pair = generateDevSigningKeyPair();
    installDevRoot(pair.publicKeySpkiB64u);
    const manifest = manifestFor(Buffer.from("x"));
    const signature = signManifest(manifest, pair.privateKeyPem);
    expect(verifyManifestSignature(canonicalManifestBytes(manifest), signature, env)).toEqual({
      verified: true,
      trust: "dev-root"
    });
  });

  it("a signature by a DIFFERENT key than the installed dev root is signature-invalid", () => {
    const trusted = generateDevSigningKeyPair();
    const attacker = generateDevSigningKeyPair();
    installDevRoot(trusted.publicKeySpkiB64u);
    const manifest = manifestFor(Buffer.from("x"));
    const signature = signManifest(manifest, attacker.privateKeyPem);
    expect(verifyManifestSignature(canonicalManifestBytes(manifest), signature, env)).toEqual({
      verified: false,
      reason: "signature-invalid"
    });
  });
});

describe("verify-before-run over an installed layout", () => {
  it("verifies a well-formed dev-signed install", () => {
    const pair = generateDevSigningKeyPair();
    installDevRoot(pair.publicKeySpkiB64u);
    const artifact = Buffer.from("console.log('engine')");
    const manifest = manifestFor(artifact);
    const artifactPath = writeInstall(manifest, signManifest(manifest, pair.privateKeyPem), artifact);

    const result = verifyInstalledArtifact(artifactPath, env);
    expect(result).toEqual({ verified: true, trust: "dev-root", manifest });
  });

  it("a corrupted artifact fails as artifact-digest-mismatch", () => {
    const pair = generateDevSigningKeyPair();
    installDevRoot(pair.publicKeySpkiB64u);
    const artifact = Buffer.from("console.log('engine')");
    const manifest = manifestFor(artifact);
    const artifactPath = writeInstall(manifest, signManifest(manifest, pair.privateKeyPem), artifact);
    writeFileSync(artifactPath, Buffer.concat([artifact, Buffer.from("/* tampered */")]));

    expect(verifyInstalledArtifact(artifactPath, env)).toEqual({ verified: false, reason: "artifact-digest-mismatch" });
  });

  it("a missing manifest/signature fails as manifest-missing", () => {
    const artifactPath = path.join(configDir, "engine", "0.1.0-dev", "engine.js");
    mkdirSync(path.dirname(artifactPath), { recursive: true });
    writeFileSync(artifactPath, "x");
    expect(verifyInstalledArtifact(artifactPath, env)).toEqual({ verified: false, reason: "manifest-missing" });
  });

  it("a tampered stored manifest fails as signature-invalid", () => {
    const pair = generateDevSigningKeyPair();
    installDevRoot(pair.publicKeySpkiB64u);
    const artifact = Buffer.from("console.log('engine')");
    const manifest = manifestFor(artifact);
    const artifactPath = writeInstall(manifest, signManifest(manifest, pair.privateKeyPem), artifact);
    // Rewrite the manifest with a different version but keep the old signature.
    writeFileSync(
      path.join(path.dirname(artifactPath), MANIFEST_FILENAME),
      canonicalManifestBytes({ ...manifest, version: "9.9.9" })
    );
    expect(verifyInstalledArtifact(artifactPath, env)).toEqual({ verified: false, reason: "signature-invalid" });
  });

  it("an unparseable stored manifest fails as manifest-invalid", () => {
    const pair = generateDevSigningKeyPair();
    installDevRoot(pair.publicKeySpkiB64u);
    const artifact = Buffer.from("x");
    const manifest = manifestFor(artifact);
    const artifactPath = writeInstall(manifest, signManifest(manifest, pair.privateKeyPem), artifact);
    writeFileSync(path.join(path.dirname(artifactPath), MANIFEST_FILENAME), "{not json");
    expect(verifyInstalledArtifact(artifactPath, env)).toEqual({ verified: false, reason: "manifest-invalid" });
  });
});
