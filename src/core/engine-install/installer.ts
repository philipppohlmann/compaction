/**
 * Signed engine installer (PUBLIC client).
 *
 * Downloads a published engine release from the user-chosen Compaction service (device-token
 * authenticated — engine releases are a Community-account feature), verifies its Ed25519-signed
 * manifest + sha256 digest, and atomically promotes it into its own identity-keyed release
 * directory under `<configDir>/engine/`, then rewrites the `current` pointer the supervisor
 * resolves. Staging happens beside the live install, never inside it, so a failed or interrupted
 * install always leaves the previous signed install verifying. The supervisor INDEPENDENTLY re-runs
 * verify-before-run at every spawn, so a post-install tamper still degrades fail-open.
 *
 * HARD RAILS:
 *  - Network I/O happens ONLY inside the explicit `compaction engine install|update` commands,
 *    only to the service URL stored at login and the artifact URL that service returned. Nothing
 *    on the Open path imports this module.
 *  - There is NO default release URL: without a device registered to a Community account (by the
 *    onboarding Community step or `compaction login`) install refuses. No compiled-in endpoint points
 *    at live artifacts.
 *  - The device token is sent ONLY to the credentialed service origin — never to a cross-origin
 *    artifact URL.
 *  - Verification is fail-closed: with no pinned production root and no explicit dev root, nothing
 *    installs. This build HAS a pinned production root, so that clause is the fallback for a build
 *    without one, not a description of this one. Dev-root installs are labeled DEV-SIGNED everywhere.
 *  - Every failure is a coded, content-free label; raw server/file text never enters an error.
 */
import {
  chmodSync,
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { configDir } from "../api-client/persisted-config.js";
import type { EnvLike } from "../api-client/config.js";
import { readStoredCredentials } from "../auth/credentials.js";
import { ENGINE_EULA_VERSION, canPresentEngineEula, engineEulaAccepted } from "../legal/engine-eula.js";
import { compatibleFull, type ReleaseCompatibility } from "../update/compatibility.js";
import { credentialedFetchInit } from "../net/credentialed-fetch.js";
import {
  canonicalManifestBytes,
  manifestMatchesHost,
  parseEngineReleaseManifest,
  type EngineChannel,
  type EngineReleaseManifest
} from "./manifest.js";
import {
  MANIFEST_FILENAME,
  SIGNATURE_FILENAME,
  devRootKeyPath,
  publicKeyFromSpkiB64u,
  sha256File,
  verifyInstalledArtifact,
  verifyManifestSignature,
  type EngineTrustSource
} from "./verify.js";

/** Coded, content-free installer failure. `code` is the contract; message adds no server text. */
export class EngineInstallError extends Error {
  constructor(
    message: string,
    readonly code:
      | "not-logged-in"
      | "release-fetch-failed"
      | "no-published-release"
      | "release-response-invalid"
      | "release-not-for-host"
      | "root-key-not-pinned"
      | "signature-invalid"
      | "manifest-invalid"
      | "artifact-download-failed"
      | "artifact-digest-mismatch"
      | "install-write-failed"
      | "dev-root-key-invalid"
      | "eula-not-accepted"
      | "release-incompatible"
      /** The caller aborted the install (user pressed Esc / Ctrl-C). NOT a download or trust failure. */
      | "cancelled",
    /** Present only after the release signature and canonical manifest have been verified. */
    readonly requiredEulaVersion?: string
  ) {
    super(message);
    this.name = "EngineInstallError";
  }
}

/** One published release as served by `GET /v0/engine/releases`. */
export interface EngineReleaseDescriptor {
  /** The EXACT signed manifest text (canonical bytes). */
  manifest: string;
  /** Base64url Ed25519 signature over the manifest bytes. */
  signature: string;
  /** Where to download the artifact. Credential is attached ONLY when same-origin with the service. */
  artifact_url: string;
}

/**
 * Injectable side-effect surface (network only — fs promotion is deterministic local work).
 * Mirrors the model-mirror ops pattern so tests never touch the network.
 */
export interface EngineInstallOps {
  /**
   * Fetch the latest published release for a channel from the service. Bearer device token; refuses
   * redirects. An optional `signal` cancels the request in flight — implementations may ignore it,
   * but the real ops honour it so onboarding's advertised Esc / Ctrl-C is not merely cosmetic.
   */
  fetchLatestRelease(
    apiUrl: string,
    deviceToken: string,
    channel: EngineChannel,
    signal?: AbortSignal
  ): Promise<EngineReleaseDescriptor | undefined>;
  /**
   * Download `url` to `destPath` (streaming; throws on any non-ok status or IO failure). A
   * CREDENTIALED download (device token in `headers`) refuses redirects; an un-credentialed CDN
   * download follows them.
   */
  download(url: string, destPath: string, headers: Record<string, string>, signal?: AbortSignal): Promise<void>;
}

/** Real ops: node builtins only. Never constructed in unit tests. */
export function createEngineInstallOps(): EngineInstallOps {
  return {
    fetchLatestRelease: async (apiUrl, deviceToken, channel, signal) => {
      let res: Response;
      try {
        const query = new URLSearchParams({
          channel,
          latest: "1",
          platform: process.platform,
          arch: process.arch
        });
        // The device token is a credential: it goes to the host the user named and NOWHERE else.
        // This is our own release-listing API, never a CDN, so it has no legitimate reason to
        // redirect — refusing beats following (the shared credentialed init, same as every other
        // credential-bearing call).
        res = await fetch(
          `${apiUrl.replace(/\/+$/, "")}/v0/engine/releases?${query.toString()}`,
          credentialedFetchInit({
            headers: { authorization: `Bearer ${deviceToken}` },
            ...(signal === undefined ? {} : { signal })
          })
        );
      } catch {
        // An ABORT lands here too, and it is the user's decision rather than an unreachable service.
        if (signal?.aborted === true) throw new EngineInstallError("the engine install was cancelled", "cancelled");
        throw new EngineInstallError("the Compaction service could not be reached", "release-fetch-failed");
      }
      if (res.status !== 200) {
        throw new EngineInstallError(`release listing failed (HTTP ${res.status})`, "release-fetch-failed");
      }
      let body: { releases?: unknown };
      try {
        body = (await res.json()) as { releases?: unknown };
      } catch {
        throw new EngineInstallError("release listing response was malformed", "release-response-invalid");
      }
      if (!Array.isArray(body.releases)) {
        throw new EngineInstallError("release listing response was malformed", "release-response-invalid");
      }
      const first = body.releases[0] as Record<string, unknown> | undefined;
      if (first === undefined) return undefined;
      if (
        typeof first.manifest !== "string" ||
        typeof first.signature !== "string" ||
        typeof first.artifact_url !== "string"
      ) {
        throw new EngineInstallError("release entry was malformed", "release-response-invalid");
      }
      return { manifest: first.manifest, signature: first.signature, artifact_url: first.artifact_url };
    },
    download: async (url, destPath, headers, signal) => {
      // REDIRECTS, split by whether this request carries a credential:
      //  - CREDENTIALED (same-origin with the service, so the device token is attached): refuse. Our
      //    own API serving the artifact has no reason to redirect, and a credentialed request must
      //    reach the host the user named and no other.
      //  - UN-CREDENTIALED (a CDN-hosted artifact): follow. Redirects are how CDNs work and there is
      //    no credential in the request to carry anywhere.
      // The condition is the presence of the credential itself, so the rule cannot drift from the
      // `sameOrigin` decision that attaches it.
      const credentialed = Object.keys(headers).some((name) => name.toLowerCase() === "authorization");
      const signalInit = signal === undefined ? {} : { signal };
      const response = await fetch(
        url,
        credentialed ? credentialedFetchInit({ headers, ...signalInit }) : { headers, ...signalInit }
      );
      if (!response.ok || response.body === null) {
        throw new Error(`artifact-status-${response.status}`);
      }
      // The signal is passed to `pipeline` as well as to `fetch`: an engine artifact is tens of
      // megabytes, so most of the wait is the BODY streaming, long after the response headers landed.
      // Aborting only the request would leave that stream running to completion.
      const source = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
      if (signal === undefined) {
        await pipeline(source, createWriteStream(destPath));
      } else {
        await pipeline(source, createWriteStream(destPath), { signal });
      }
    }
  };
}

/** The artifact's on-disk basename inside its release directory, per kind. */
export function artifactFilename(kind: EngineReleaseManifest["artifact_kind"]): string {
  return kind === "node-script" ? "engine.js" : "engine";
}

/**
 * The install directory PREFIX of one release: version, channel, and a digest prefix — the full
 * release identity, for legibility on disk. A unique suffix is appended when the directory is
 * created (`mkdtemp`), so every install gets a directory of its OWN. Nothing is ever written into,
 * renamed over, or removed from a directory another install may have made live; promotion is the
 * pointer swap alone.
 *
 * Every component is already schema-validated before it reaches here (version by
 * `ENGINE_VERSION_RE`, channel by the channel enum, sha256 by the hex check), so the result is a
 * single safe path segment; the caller re-checks containment against the install root regardless.
 */
export function engineReleaseDirPrefix(manifest: EngineReleaseManifest): string {
  return `${manifest.version}-${manifest.channel}-${manifest.sha256.slice(0, 12)}.`;
}

/** Root of the engine install tree (`<configDir>/engine`). */
export function engineInstallRoot(env: EnvLike = process.env): string {
  return join(configDir(env), "engine");
}

/** The `current` pointer file the supervisor resolves (contains the artifact's absolute path). */
export function enginePointerPath(env: EnvLike = process.env): string {
  return join(engineInstallRoot(env), "current");
}

/** Read the `current` pointer's target path, or undefined when absent/unreadable. Never throws. */
export function readCurrentPointer(env: EnvLike = process.env): string | undefined {
  try {
    const pointer = enginePointerPath(env);
    if (!existsSync(pointer)) return undefined;
    const target = readFileSync(pointer, "utf8").trim();
    return target === "" ? undefined : target;
  } catch {
    return undefined;
  }
}

/**
 * True only when `target` resolves strictly INSIDE `installRoot`. Both sides are realpath'd, so
 * neither an outside path nor an inside symlink to an outside file passes — the same containment
 * rule the supervisor applies to the pointer before it verifies (let alone spawns) anything.
 */
function insideInstallRoot(target: string, installRoot: string): boolean {
  try {
    return realpathSync(target).startsWith(realpathSync(installRoot) + sep);
  } catch {
    return false;
  }
}

/**
 * Install an EXPLICIT dev trust root (the `--dev-root-key <path>` flow). Validates the key parses
 * as an Ed25519 SPKI public key before persisting it at `<configDir>/engine/dev-root-key.pub`.
 * This is the ONLY way a non-pinned root becomes trusted — a visible, user-initiated act, never an
 * env var. Callers print the loud DEV-SIGNED warning.
 */
export function installDevRootKey(spkiB64u: string, env: EnvLike = process.env): string {
  const trimmed = spkiB64u.trim();
  if (trimmed === "" || publicKeyFromSpkiB64u(trimmed) === undefined) {
    throw new EngineInstallError("the dev root key is not a valid Ed25519 public key", "dev-root-key-invalid");
  }
  const path = devRootKeyPath(env);
  mkdirSync(join(configDir(env), "engine"), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${trimmed}\n`, { mode: 0o600 });
  return path;
}

export interface EngineInstallResult {
  manifest: EngineReleaseManifest;
  version: string;
  channel: EngineChannel;
  artifactKind: EngineReleaseManifest["artifact_kind"];
  /** Which trust root verified the release. `dev-root` ⇒ DEV-SIGNED, loudly labeled by callers. */
  trust: EngineTrustSource;
  /** Present for a production-signed release; identifies the authorizing compiled-in root. */
  keyId?: string;
  /** Absolute path of the installed artifact (what the `current` pointer names). */
  artifactPath: string;
  /** False when the requested release is ALREADY current and verifying (nothing downloaded or written). */
  updated: boolean;
}

/** True when `artifactUrl` shares an origin with the credentialed service URL. */
function sameOrigin(apiUrl: string, artifactUrl: string): boolean {
  try {
    return new URL(apiUrl).origin === new URL(artifactUrl).origin;
  } catch {
    return false;
  }
}

/**
 * Inputs shared by legacy installation and managed release staging.
 *
 * Order is verify-then-promote: manifest signature (pinned roots, else explicit dev root) →
 * manifest schema + host match → download to a private temp dir → streaming sha256 vs the signed
 * digest (mismatch ⇒ delete, never promote) → STAGE the complete release (artifact + manifest +
 * signature) in a directory of its OWN inside the install root → verify the staged release exactly
 * as verify-before-run will. Legacy installation separately rewrites `current`; staging never
 * publishes a pointer. Any failure leaves the previous install untouched and still verifying:
 * no existing release directory is ever written into, renamed over, or removed.
 */
export interface EngineInstallInput {
  channel?: EngineChannel;
  env?: EnvLike;
  ops?: EngineInstallOps;
  /**
   * Cancels the install. Checked between steps AND threaded into both network calls, so an abort
   * stops the transfer rather than letting it finish invisibly. Nothing is left half-promoted: the
   * pointer swap is the only thing that makes a release live and it happens after every check.
   */
  signal?: AbortSignal;
  /** When provided, only a production-signed compatible v2 release can be staged. */
  compatibility?: ReleaseCompatibility;
}

/** Acquire a verified immutable release without changing the legacy current pointer. */
export async function stageEngineRelease(input: EngineInstallInput): Promise<EngineInstallResult> {
  const env = input.env ?? process.env;
  const channel = input.channel ?? "stable";
  const ops = input.ops ?? createEngineInstallOps();

  const credentials = readStoredCredentials(env);
  if (!credentials) {
    throw new EngineInstallError("not logged in — run `compaction login` first", "not-logged-in");
  }

  const signal = input.signal;
  /** Throw the cancellation the caller asked for, at a point where nothing is half-done. */
  const throwIfCancelled = (): void => {
    if (signal?.aborted === true) throw new EngineInstallError("the engine install was cancelled", "cancelled");
  };
  throwIfCancelled();

  const release = await ops.fetchLatestRelease(credentials.api_url, credentials.device_token, channel, signal);
  if (release === undefined) {
    throw new EngineInstallError(`no published engine release on the ${channel} channel`, "no-published-release");
  }

  // Verify the signature over the EXACT bytes the service returned, against the allowed roots.
  const signatureCheck = verifyManifestSignature(Buffer.from(release.manifest, "utf8"), release.signature, env);
  if (!signatureCheck.verified) {
    throw new EngineInstallError(
      signatureCheck.reason === "root-key-not-pinned"
        ? "no trust root is pinned in this build; releases cannot be verified"
        : signatureCheck.reason === "manifest-invalid"
          ? "the signed release manifest is invalid"
          : "the release signature did not verify against any trusted root",
      signatureCheck.reason
    );
  }

  const manifest = parseEngineReleaseManifest(release.manifest);
  if (!manifest) throw new EngineInstallError("the signed release manifest is invalid", "manifest-invalid");
  // The stored/canonical form must round-trip to the verified bytes (defense against a manifest
  // that verifies but parses differently than it will re-serialize at verify-before-run time).
  if (!canonicalManifestBytes(manifest).equals(Buffer.from(release.manifest, "utf8"))) {
    throw new EngineInstallError("the release manifest is not in canonical form", "manifest-invalid");
  }
  if (!manifestMatchesHost(manifest)) {
    throw new EngineInstallError(
      `the ${channel} release targets ${manifest.platform}/${manifest.arch}, not this host`,
      "release-not-for-host"
    );
  }
  if (manifest.channel !== channel) throw new EngineInstallError("release channel mismatch", "release-incompatible");
  const eulaVersion = manifest.schema_version === 2 ? manifest.eula_version : ENGINE_EULA_VERSION;
  if (!canPresentEngineEula(eulaVersion) || !engineEulaAccepted(env, eulaVersion)) {
    throw new EngineInstallError(`accept engine EULA ${eulaVersion} before acquisition`, "eula-not-accepted", eulaVersion);
  }
  if (input.compatibility && !compatibleFull(input.compatibility,
    { verified: true, trust: signatureCheck.trust, manifest }, eulaVersion)) {
    throw new EngineInstallError("the signed release is incompatible with this CLI", "release-incompatible");
  }

  // CONTAINMENT (belt-and-braces over the parse-time version-segment rule): the release dir must
  // resolve strictly INSIDE the install root. A signed manifest authenticates a release; it must
  // never grant a filesystem write outside the install root.
  const installRoot = resolve(engineInstallRoot(env));
  const releaseDirPrefix = resolve(installRoot, engineReleaseDirPrefix(manifest));
  if (!releaseDirPrefix.startsWith(installRoot + sep)) {
    throw new EngineInstallError("the release version is not a safe install directory name", "manifest-invalid");
  }

  // Already current AND still verifying? Nothing to download; report up-to-date honestly. The check
  // is on the CURRENT POINTER's target, not on a directory name: require the full release identity —
  // version, channel, artifact kind, and the signed digest — to match. A pointer naming anything
  // outside the install root is disregarded here exactly as the supervisor refuses it at spawn.
  const currentTarget = readCurrentPointer(env);
  if (currentTarget !== undefined && insideInstallRoot(currentTarget, installRoot)) {
    const existing = verifyInstalledArtifact(currentTarget, env);
    if (
      existing.verified &&
      existing.trust === signatureCheck.trust &&
      canonicalManifestBytes(existing.manifest).equals(canonicalManifestBytes(manifest)) &&
      existing.manifest.version === manifest.version &&
      existing.manifest.channel === manifest.channel &&
      existing.manifest.artifact_kind === manifest.artifact_kind &&
      existing.manifest.sha256.toLowerCase() === manifest.sha256.toLowerCase()
    ) {
      return {
        manifest: existing.manifest,
        version: existing.manifest.version,
        channel: existing.manifest.channel,
        artifactKind: existing.manifest.artifact_kind,
        trust: existing.trust,
        keyId: existing.trust === "pinned-root" ? existing.key_id : undefined,
        artifactPath: currentTarget,
        updated: false
      };
    }
  }

  const tempDir = mkdtempSync(join(tmpdir(), "compaction-engine-install-"));
  try {
    const downloadPath = join(tempDir, "artifact");
    try {
      // The device token goes ONLY to the credentialed service origin, never cross-origin.
      const headers: Record<string, string> = sameOrigin(credentials.api_url, release.artifact_url)
        ? { authorization: `Bearer ${credentials.device_token}` }
        : {};
      throwIfCancelled();
      await ops.download(release.artifact_url, downloadPath, headers, signal);
    } catch (error) {
      // Preserve a cancellation as a cancellation: reporting the user's Esc as a failed download
      // would tell them the release could not be fetched, which is not what happened.
      if (error instanceof EngineInstallError && error.code === "cancelled") throw error;
      if (signal?.aborted === true) throw new EngineInstallError("the engine install was cancelled", "cancelled");
      throw new EngineInstallError("the engine artifact could not be downloaded", "artifact-download-failed");
    }

    // THE DOWNLOAD IS NOT THE LAST CANCELLABLE MOMENT. `ops.download` was the only signal-aware
    // step, so an Esc pressed while the transfer was finishing — or during the hash below, which on
    // a multi-megabyte artifact is not instant — used to be read too late to matter: the install
    // went on to stage and PROMOTE, and a device whose onboarding had already moved on to Open
    // ended up with a new engine published under it. Re-asked here, and again immediately before
    // the pointer swap, so the answer is current at the only step that changes what this device runs.
    throwIfCancelled();

    const digest = await sha256File(downloadPath);
    throwIfCancelled();
    if (digest !== manifest.sha256.toLowerCase()) {
      // Reject: the artifact is not the signed release. The temp dir (and file) is deleted below.
      throw new EngineInstallError("the downloaded artifact does not match the signed digest", "artifact-digest-mismatch");
    }

    // STAGE: assemble the COMPLETE release in a directory of its OWN inside the install root —
    // created by `mkdtemp`, so it belongs exclusively to this install. No existing directory is
    // written into, renamed over, or removed: a concurrent installer's release (and the live one)
    // cannot be disturbed, and an interruption anywhere in here leaves the previous signed install
    // byte-for-byte intact and still verifying. Publication by the caller is separate: either a
    // managed session pair pins this immutable artifact or legacy installation updates `current`.
    let releaseDir: string;
    try {
      mkdirSync(installRoot, { recursive: true, mode: 0o700 });
      releaseDir = mkdtempSync(releaseDirPrefix);
    } catch {
      throw new EngineInstallError("the engine install could not be written", "install-write-failed");
    }
    const artifactPath = join(releaseDir, artifactFilename(manifest.artifact_kind));
    try {
      // Copy (not rename): the download temp dir may live on a different filesystem.
      copyFileSync(downloadPath, artifactPath);
      if (manifest.artifact_kind === "native-binary") chmodSync(artifactPath, 0o755);
      writeFileSync(join(releaseDir, MANIFEST_FILENAME), release.manifest, { mode: 0o600 });
      writeFileSync(join(releaseDir, SIGNATURE_FILENAME), `${release.signature}\n`, { mode: 0o600 });
      // The staged release must pass the SAME check the supervisor runs before every spawn. Only a
      // release that already verifies on disk may become current.
      const stagedVerification = verifyInstalledArtifact(artifactPath, env);
      if (!stagedVerification.verified || stagedVerification.trust !== signatureCheck.trust ||
          (signatureCheck.trust === "pinned-root" &&
            (stagedVerification.trust !== "pinned-root" || stagedVerification.key_id !== signatureCheck.key_id)) ||
          !canonicalManifestBytes(stagedVerification.manifest).equals(canonicalManifestBytes(manifest))) {
        throw new EngineInstallError("the staged engine install did not verify", "install-write-failed");
      }
      // LAST CALL, INSIDE THE STAGING GUARD so a cancellation here takes the staged directory with
      // it. Everything above is private to this call and unreachable by anything else; the pointer
      // swap below is the step that would make it this device's engine.
      throwIfCancelled();
    } catch (error) {
      // Only ever removes the directory this call created and never published.
      rmSync(releaseDir, { recursive: true, force: true });
      if (error instanceof EngineInstallError) throw error;
      throw new EngineInstallError("the engine install could not be written", "install-write-failed");
    }

    return {
      manifest,
      version: manifest.version,
      channel: manifest.channel,
      artifactKind: manifest.artifact_kind,
      trust: signatureCheck.trust,
      keyId: signatureCheck.trust === "pinned-root" ? signatureCheck.key_id : undefined,
      artifactPath,
      updated: true
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

/** Legacy installation explicitly promotes only after acquisition and verification succeed. */
export async function installEngineRelease(input: EngineInstallInput): Promise<EngineInstallResult> {
  const result = await stageEngineRelease(input);
  if (!result.updated) return result;
  const env = input.env ?? process.env;
  if (input.signal?.aborted) throw new EngineInstallError("the engine install was cancelled", "cancelled");
  let pointerDir: string | undefined;
  try {
    // A call owns its temp directory. Concurrent promotions cannot overwrite each other's temp
    // file; rename is the single atomic, last-completed publication step.
    pointerDir = mkdtempSync(join(engineInstallRoot(env), ".current-"));
    const pointerTmp = join(pointerDir, "pointer");
    writeFileSync(pointerTmp, `${result.artifactPath}\n`, { mode: 0o600 });
    renameSync(pointerTmp, enginePointerPath(env));
  } catch {
    throw new EngineInstallError("the engine install could not be written", "install-write-failed");
  } finally {
    if (pointerDir) rmSync(pointerDir, { recursive: true, force: true });
  }
  return result;
}
