/**
 * Signed engine-release manifest — schema, canonical bytes, and the pinned trust roots
 * (PUBLIC client, signed engine delivery).
 *
 * The private engine ships as a SIGNED artifact NOT in the npm package. What is signed is this
 * manifest: a small content-free JSON document binding a release (version/channel/platform/arch/
 * artifact kind) to the artifact's sha256. The signature is Ed25519 over the manifest's EXACT
 * UTF-8 bytes; the verifier stores those bytes verbatim next to the installed artifact and
 * re-verifies them BEFORE every engine spawn (verify-before-run in the supervisor).
 *
 * HARD RAILS:
 *  - The production trust root below is PINNED to a real key, minted offline.
 *    `rootKeyPinned` still refuses a placeholder, so a build that has
 *    NOT had a root minted for it fails closed — that mechanism is unchanged, and pinning is the
 *    deliberate, reviewed activation it was waiting for rather than machinery that woke itself up.
 *  - The trust root is NEVER overridable via an environment variable. The only non-pinned trust
 *    path is the EXPLICIT dev root installed by `compaction engine install --dev-root-key <path>`,
 *    which is persisted visibly in the config dir and loudly labeled DEV-SIGNED on every surface.
 *  - Everything here is content-free: versions, digests, sizes, kinds — never request content,
 *    never a credential.
 */

/** Release channels a client may install from. */
export const ENGINE_CHANNELS = ["stable", "dev"] as const;
export type EngineChannel = (typeof ENGINE_CHANNELS)[number];

/** How the supervisor runs the artifact: a Node entry script or a directly-spawned binary. */
export const ENGINE_ARTIFACT_KINDS = ["node-script", "native-binary"] as const;
export type EngineArtifactKind = (typeof ENGINE_ARTIFACT_KINDS)[number];

/** The signed release manifest. Field order in `canonicalManifestBytes` is FROZEN (schema v1). */
interface EngineReleaseManifestBase {
  /** Release version label (content-free, e.g. "0.1.0-interim"). */
  version: string;
  channel: EngineChannel;
  /** Target platform (`process.platform`) or "any". */
  platform: string;
  /** Target architecture (`process.arch`) or "any". */
  arch: string;
  artifact_kind: EngineArtifactKind;
  /** Lowercase sha256 hex of the artifact bytes. */
  sha256: string;
  /** Artifact size in bytes (display/sanity only; the digest is the integrity check). */
  size_bytes: number;
}

export interface EngineReleaseManifestV1 extends EngineReleaseManifestBase { schema_version: 1 }
export interface EngineReleaseManifestV2 extends EngineReleaseManifestBase {
  schema_version: 2;
  /** Inclusive minimum and exclusive maximum CLI SemVer bounds. */
  cli_min_version: string;
  cli_max_version: string;
  engine_protocol: number;
  usage_schema_version: number;
  meter_version: string;
  eula_version: string;
}
export type EngineReleaseManifest = EngineReleaseManifestV1 | EngineReleaseManifestV2;

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/**
 * A version label must be a SINGLE safe path segment: it names the install directory
 * (`<configDir>/engine/<version>/`), so separators, leading dots ("." / ".." / hidden dirs), and
 * anything traversal-shaped are rejected at parse time. Signing authenticates a release; it must
 * never grant a filesystem write outside the install root.
 */
export const ENGINE_VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * `platform` and `arch` are the only free-form strings in a manifest, and the only two that reach a
 * printed line ("the stable release targets X/Y, not this host"). A real value is a `process.platform`
 * / `process.arch` token or "any", so constraining them here cannot reject a legitimate release - and
 * it keeps a signed manifest from being able to carry escape sequences into a terminal. Verification
 * already stands in front of this, so this is depth behind the signature, not the check itself.
 */
const HOST_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * Parse and validate a manifest from its exact signed bytes/text. Returns `undefined` for anything
 * malformed (fail-closed to "not a valid release"), never throws.
 */
export function parseEngineReleaseManifest(text: string): EngineReleaseManifest | undefined {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (raw === null || typeof raw !== "object") return undefined;
  if (raw.schema_version !== 1 && raw.schema_version !== 2) return undefined;
  if (!isNonEmptyString(raw.version) || !ENGINE_VERSION_RE.test(raw.version.trim())) return undefined;
  if (!ENGINE_CHANNELS.includes(raw.channel as EngineChannel)) return undefined;
  if (!isNonEmptyString(raw.platform) || !HOST_TOKEN_RE.test(raw.platform.trim())) return undefined;
  if (!isNonEmptyString(raw.arch) || !HOST_TOKEN_RE.test(raw.arch.trim())) return undefined;
  if (!ENGINE_ARTIFACT_KINDS.includes(raw.artifact_kind as EngineArtifactKind)) return undefined;
  if (typeof raw.sha256 !== "string" || !SHA256_HEX_RE.test(raw.sha256)) return undefined;
  if (typeof raw.size_bytes !== "number" || !Number.isInteger(raw.size_bytes) || raw.size_bytes < 0) return undefined;
  const base = {
    version: raw.version.trim(),
    channel: raw.channel as EngineChannel,
    platform: raw.platform.trim(),
    arch: raw.arch.trim(),
    artifact_kind: raw.artifact_kind as EngineArtifactKind,
    sha256: raw.sha256,
    size_bytes: raw.size_bytes
  };
  if (raw.schema_version === 1) return { schema_version: 1, ...base };
  for (const field of ["cli_min_version", "cli_max_version", "meter_version", "eula_version"]) {
    if (typeof raw[field] !== "string" || !ENGINE_VERSION_RE.test(raw[field] as string)) return undefined;
  }
  if (!Number.isSafeInteger(raw.engine_protocol) || Number(raw.engine_protocol) < 1 ||
      !Number.isSafeInteger(raw.usage_schema_version) || Number(raw.usage_schema_version) < 1) return undefined;
  return {
    schema_version: 2, ...base,
    cli_min_version: raw.cli_min_version as string, cli_max_version: raw.cli_max_version as string,
    engine_protocol: raw.engine_protocol as number, usage_schema_version: raw.usage_schema_version as number,
    meter_version: raw.meter_version as string, eula_version: raw.eula_version as string
  };
}

/**
 * The canonical byte serialization that is SIGNED. Fixed key order, no whitespace variance —
 * signer and verifier must both use this function (single implementation, no drift). The signed
 * text is also what gets stored verbatim as `manifest.json` in the install dir.
 */
export function canonicalManifestBytes(manifest: EngineReleaseManifest): Buffer {
  const ordered = {
    schema_version: manifest.schema_version,
    version: manifest.version,
    channel: manifest.channel,
    platform: manifest.platform,
    arch: manifest.arch,
    artifact_kind: manifest.artifact_kind,
    sha256: manifest.sha256,
    size_bytes: manifest.size_bytes
  };
  if (manifest.schema_version === 1) return Buffer.from(JSON.stringify(ordered), "utf8");
  return Buffer.from(JSON.stringify({
    ...ordered, cli_min_version: manifest.cli_min_version, cli_max_version: manifest.cli_max_version,
    engine_protocol: manifest.engine_protocol, usage_schema_version: manifest.usage_schema_version,
    meter_version: manifest.meter_version, eula_version: manifest.eula_version
  }), "utf8");
}

/** Whether a manifest targets this host (exact platform/arch match, or "any"). */
export function manifestMatchesHost(
  manifest: EngineReleaseManifest,
  host: { platform: string; arch: string } = { platform: process.platform, arch: process.arch }
): boolean {
  const platformOk = manifest.platform === "any" || manifest.platform === host.platform;
  const archOk = manifest.arch === "any" || manifest.arch === host.arch;
  return platformOk && archOk;
}

/** What a compiled-in release root is allowed to authorize. */
export type EngineRootAuthorization =
  | { kind: "current-release"; schema_version: 2 }
  | {
      kind: "legacy-manifest";
      schema_version: 1;
      version: string;
      channel: EngineChannel;
      platform: string;
      arch: string;
      artifact_kind: EngineArtifactKind;
      sha256: string;
      size_bytes: number;
      canonical_manifest_sha256: string;
    };

/** A compiled-in trust root and its release authorization policy. */
export interface EngineRootKey {
  key_id: string;
  /** Base64url SPKI DER Ed25519 public key, or a refused placeholder. */
  public_key_spki_b64u: string;
  authorization: EngineRootAuthorization;
}

/**
 * Marker prefix of the refused production placeholder. `rootKeyPinned` fails anything carrying it,
 * so a build that has not had a root minted for it keeps the compiled-in trust path DORMANT
 * (fail-closed). Not what THIS build carries — see `ENGINE_ROOT_KEYS` — but still the mechanism, and
 * the state a rollback or a fresh branch falls back to.
 */
export const UNPINNED_ROOT_KEY_MARKER = "UNPINNED-PLACEHOLDER";
export const CURRENT_ENGINE_ROOT_KEY_ID = "compaction-engine-root-v2";
export const ENGINE_ROOT_POLICY_SHA256 = "138749eb6fd460d8807ff1372881fd5c95fa8ac92d492097f8dc9d8cda07d69a";

/**
 * The compiled-in production trust roots. PINNED: a real Ed25519 public key, minted offline.
 * The public half is all that is here and all that ever ships. The v2 private half lives in Secret
 * Manager and is retrieved only into a protected temporary file for an authorized release; it never
 * enters this package.
 *
 * SEPARATE FROM THE LEASE ROOT, cryptographically and by file (`entitlement/lease-roots.ts`): this
 * root verifies artifacts and cannot vouch for an entitlement, and that one verifies entitlements
 * and cannot vouch for code. Neither compromise yields the other.
 */
export const ENGINE_ROOT_KEYS: readonly EngineRootKey[] = [
  {
    key_id: "compaction-engine-root-v1",
    public_key_spki_b64u: "MCowBQYDK2VwAyEAE_hyUbMqPEb08gIjtL7N7Naq0a3Tjg2L_w29HFtOG34",
    authorization: {
      kind: "legacy-manifest",
      schema_version: 1,
      version: "0.6.10",
      channel: "stable",
      platform: "any",
      arch: "any",
      artifact_kind: "node-script",
      sha256: "a211bfef01d872dfcd95414bf9fab0cd89040b189c7bdc7624838a7ef7b8037d",
      size_bytes: 139415,
      canonical_manifest_sha256: "8f52adb6cb09e564416866aadec09f58e7ac7c0aa2ad02c20a9c31d71149b86c"
    }
  },
  {
    key_id: CURRENT_ENGINE_ROOT_KEY_ID,
    public_key_spki_b64u: "MCowBQYDK2VwAyEAXsFlXsmAzKxB8kY109FcW3LgEQJruUruEIb87M-bIHM",
    authorization: { kind: "current-release", schema_version: 2 }
  }
];

/** Root signatures authorize only manifests within that root's compiled-in policy. */
export function rootAuthorizesManifest(
  root: EngineRootKey,
  manifest: EngineReleaseManifest,
  canonicalManifestSha256: string
): boolean {
  const authorization = root.authorization;
  if (authorization.kind === "current-release") {
    return manifest.schema_version === authorization.schema_version;
  }
  return manifest.schema_version === authorization.schema_version &&
    manifest.version === authorization.version &&
    manifest.channel === authorization.channel &&
    manifest.platform === authorization.platform &&
    manifest.arch === authorization.arch &&
    manifest.artifact_kind === authorization.artifact_kind &&
    manifest.sha256 === authorization.sha256 &&
    manifest.size_bytes === authorization.size_bytes &&
    canonicalManifestSha256 === authorization.canonical_manifest_sha256;
}

/**
 * True only when a root entry carries a plausibly real key (not the placeholder). Guard style
 * mirrors the model-mirror `digestPinned` check: a placeholder can never verify anything.
 * Ed25519 SPKI DER is 44 bytes → 59 base64url chars; require valid base64url of exactly that size.
 */
export function rootKeyPinned(root: Pick<EngineRootKey, "public_key_spki_b64u">): boolean {
  const key = root.public_key_spki_b64u;
  if (key.includes(UNPINNED_ROOT_KEY_MARKER)) return false;
  if (!/^[A-Za-z0-9_-]+$/.test(key)) return false;
  return Buffer.from(key, "base64url").length === 44;
}

/**
 * The pinned (usable) subset of the compiled-in roots. NON-EMPTY in this build: engine availability
 * is therefore `installable` rather than `unavailable` on a device that has not fetched one, and
 * every caller that branches on emptiness is taking its other branch for real.
 */
export function pinnedRootKeys(): EngineRootKey[] {
  return ENGINE_ROOT_KEYS.filter(rootKeyPinned);
}
