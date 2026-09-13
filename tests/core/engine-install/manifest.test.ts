/**
 * Engine-release manifest schema + trust-root pinning guards.
 *
 * The load-bearing assertions:
 * - the compiled-in production trust root is the MINTED production key (the machinery shipped
 *   dormant and was activated deliberately at the distribute-engine-binary gate); no placeholder
 *   survives, and a signature from any other key still fails closed;
 * - canonical bytes are stable and round-trip through parse (signature domain never drifts);
 * - malformed manifests parse to undefined (never throw).
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { generateDevSigningKeyPair } from "../../../src/core/engine-install/dev-signing.js";
import {
  CURRENT_ENGINE_ROOT_KEY_ID,
  ENGINE_ROOT_POLICY_SHA256,
  ENGINE_ROOT_KEYS,
  UNPINNED_ROOT_KEY_MARKER,
  canonicalManifestBytes,
  manifestMatchesHost,
  parseEngineReleaseManifest,
  pinnedRootKeys,
  rootKeyPinned,
  rootAuthorizesManifest,
  type EngineReleaseManifest
} from "../../../src/core/engine-install/manifest.js";

const VALID: EngineReleaseManifest = {
  schema_version: 1,
  version: "0.1.0-dev",
  channel: "dev",
  platform: "any",
  arch: "any",
  artifact_kind: "node-script",
  sha256: "a".repeat(64),
  size_bytes: 123
};

describe("engine release manifest", () => {
  it("round-trips through canonical bytes", () => {
    const bytes = canonicalManifestBytes(VALID);
    const parsed = parseEngineReleaseManifest(bytes.toString("utf8"));
    expect(parsed).toEqual(VALID);
    // Canonicalizing the parsed manifest reproduces the signed bytes exactly (signature domain).
    expect(canonicalManifestBytes(parsed!).equals(bytes)).toBe(true);
  });

  it("rejects malformed manifests without throwing", () => {
    expect(parseEngineReleaseManifest("not json")).toBeUndefined();
    expect(parseEngineReleaseManifest("null")).toBeUndefined();
    expect(parseEngineReleaseManifest(JSON.stringify({ ...VALID, schema_version: 2 }))).toBeUndefined();
    expect(parseEngineReleaseManifest(JSON.stringify({ ...VALID, channel: "nightly" }))).toBeUndefined();
    expect(parseEngineReleaseManifest(JSON.stringify({ ...VALID, artifact_kind: "wasm" }))).toBeUndefined();
    expect(parseEngineReleaseManifest(JSON.stringify({ ...VALID, sha256: "abc" }))).toBeUndefined();
    expect(parseEngineReleaseManifest(JSON.stringify({ ...VALID, sha256: "Z".repeat(64) }))).toBeUndefined();
    expect(parseEngineReleaseManifest(JSON.stringify({ ...VALID, size_bytes: -1 }))).toBeUndefined();
    expect(parseEngineReleaseManifest(JSON.stringify({ ...VALID, version: "" }))).toBeUndefined();
  });

  it("rejects a platform/arch that could carry escape sequences into the terminal", () => {
    // These two are the only free-form strings in a manifest, and the pair is printed verbatim when a
    // release targets another host. Verification stands in front of this, so the probe is depth behind
    // the signature: a manifest must not be a transport for terminal control bytes even if signed.
    for (const hostile of ["dar\u001b]8;;http://evil\u0007win", "linux\n\rall clear", "x86_64 fake", "", "a".repeat(33)]) {
      expect(parseEngineReleaseManifest(JSON.stringify({ ...VALID, platform: hostile })), hostile).toBeUndefined();
      expect(parseEngineReleaseManifest(JSON.stringify({ ...VALID, arch: hostile })), hostile).toBeUndefined();
    }
    // …and every value a real host actually reports still parses.
    for (const ok of ["any", "darwin", "linux", "win32", "arm64", "x64", "ppc64le"]) {
      expect(parseEngineReleaseManifest(JSON.stringify({ ...VALID, platform: ok, arch: ok })), ok).toBeDefined();
    }
  });

  it("rejects any version that is not a single safe path segment (traversal probe)", () => {
    // A signed manifest authenticates a release — its version names the install dir and must
    // never be able to write outside the install root.
    for (const version of ["../../..", "../evil", "a/b", "a\\b", "..", ".", ".hidden", "-x", "a".repeat(65), "v 1"]) {
      expect(
        parseEngineReleaseManifest(JSON.stringify({ ...VALID, version })),
        `version must be rejected: ${JSON.stringify(version)}`
      ).toBeUndefined();
    }
    for (const version of ["0.1.0", "0.1.0-dev", "1.2.3_rc.1", "V2"]) {
      expect(
        parseEngineReleaseManifest(JSON.stringify({ ...VALID, version }))?.version,
        `version must be accepted: ${JSON.stringify(version)}`
      ).toBe(version);
    }
  });

  it("matches hosts exactly or via 'any'", () => {
    expect(manifestMatchesHost(VALID, { platform: "darwin", arch: "arm64" })).toBe(true);
    const pinnedHost = { ...VALID, platform: "linux", arch: "x64" };
    expect(manifestMatchesHost(pinnedHost, { platform: "linux", arch: "x64" })).toBe(true);
    expect(manifestMatchesHost(pinnedHost, { platform: "darwin", arch: "x64" })).toBe(false);
    expect(manifestMatchesHost(pinnedHost, { platform: "linux", arch: "arm64" })).toBe(false);
  });
});

describe("trust-root pinning (production root ACTIVE, still fail-closed)", () => {
  // This build ships the minted production engine root (the deliberate, versioned activation of
  // machinery that shipped dormant). The guard therefore flipped: it no longer asserts that
  // nothing is pinned, it asserts that exactly the compiled-in roots are pinned, that each is a
  // real Ed25519 SPKI key, and that no placeholder survived the activation.
  it("the compiled-in production root is a real pinned Ed25519 key, not a placeholder", () => {
    expect(ENGINE_ROOT_KEYS.length).toBeGreaterThan(0);
    for (const root of ENGINE_ROOT_KEYS) {
      expect(
        root.public_key_spki_b64u.includes(UNPINNED_ROOT_KEY_MARKER),
        `no placeholder may remain: ${root.key_id}`
      ).toBe(false);
      expect(rootKeyPinned(root), `production root must pin: ${root.key_id}`).toBe(true);
      expect(Buffer.from(root.public_key_spki_b64u, "base64url").length).toBe(44);
    }
    expect(pinnedRootKeys().map((r) => r.key_id)).toEqual(ENGINE_ROOT_KEYS.map((r) => r.key_id));
  });

  // MIRROR PIN. The control plane may not import `src/`, so its retirement tool re-declares this
  // key in apps/control-plane/src/engine-root-keys.ts and pins the same literal in its own test.
  // Rotating the root has to break BOTH pins, or the operator tool would go on trusting the old
  // one and accept retirement evidence no client can verify.
  it("pins the exact root key literal the control-plane mirror carries", () => {
    expect(ENGINE_ROOT_KEYS.map((r) => [r.key_id, r.public_key_spki_b64u])).toEqual([
      ["compaction-engine-root-v1", "MCowBQYDK2VwAyEAE_hyUbMqPEb08gIjtL7N7Naq0a3Tjg2L_w29HFtOG34"],
      ["compaction-engine-root-v2", "MCowBQYDK2VwAyEAXsFlXsmAzKxB8kY109FcW3LgEQJruUruEIb87M-bIHM"]
    ]);
  });

  it("binds the policy fingerprint to every root authorization field", () => {
    expect(createHash("sha256").update(JSON.stringify(ENGINE_ROOT_KEYS)).digest("hex"))
      .toBe(ENGINE_ROOT_POLICY_SHA256);
  });

  it("limits v1 to the exact known-good rollback manifest and v2 to canonical schema v2", () => {
    const legacy = parseEngineReleaseManifest(
      '{"schema_version":1,"version":"0.6.10","channel":"stable","platform":"any","arch":"any","artifact_kind":"node-script","sha256":"a211bfef01d872dfcd95414bf9fab0cd89040b189c7bdc7624838a7ef7b8037d","size_bytes":139415}'
    )!;
    const legacyDigest = "8f52adb6cb09e564416866aadec09f58e7ac7c0aa2ad02c20a9c31d71149b86c";
    const v1 = ENGINE_ROOT_KEYS.find((root) => root.key_id === "compaction-engine-root-v1")!;
    const v2 = ENGINE_ROOT_KEYS.find((root) => root.key_id === CURRENT_ENGINE_ROOT_KEY_ID)!;
    const current: EngineReleaseManifest = {
      schema_version: 2, version: "0.6.11", channel: "stable", platform: "any", arch: "any",
      artifact_kind: "node-script", sha256: "b".repeat(64), size_bytes: 149181,
      cli_min_version: "0.6.8", cli_max_version: "1.0.0", engine_protocol: 1,
      usage_schema_version: 3, meter_version: "optimized-input-v2", eula_version: "1.0"
    };

    expect(rootAuthorizesManifest(v1, legacy, legacyDigest)).toBe(true);
    expect(rootAuthorizesManifest(v1, { ...legacy, version: "0.6.11" }, legacyDigest)).toBe(false);
    expect(rootAuthorizesManifest(v1, { ...legacy, sha256: "b".repeat(64) }, legacyDigest)).toBe(false);
    expect(rootAuthorizesManifest(v1, legacy, "0".repeat(64))).toBe(false);
    expect(rootAuthorizesManifest(v1, current, legacyDigest)).toBe(false);
    expect(rootAuthorizesManifest(v2, legacy, legacyDigest)).toBe(false);
    expect(rootAuthorizesManifest(v2, current, "unused")).toBe(true);
  });

  it("a real Ed25519 SPKI key WOULD pin (the guard is about the placeholder, not the mechanism)", () => {
    const pair = generateDevSigningKeyPair();
    expect(rootKeyPinned({ key_id: "test", public_key_spki_b64u: pair.publicKeySpkiB64u })).toBe(true);
  });

  it("garbage keys never pin", () => {
    expect(rootKeyPinned({ key_id: "t", public_key_spki_b64u: "" })).toBe(false);
    expect(rootKeyPinned({ key_id: "t", public_key_spki_b64u: "short" })).toBe(false);
    expect(rootKeyPinned({ key_id: "t", public_key_spki_b64u: "!!not-base64url!!" })).toBe(false);
  });
});
