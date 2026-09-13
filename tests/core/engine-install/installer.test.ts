/**
 * Signed engine installer tests — injected ops (zero network), tmp config dir (the real
 * ~/.compaction is never touched), throwaway signing keys.
 *
 * Load-bearing:
 * - refuses without login (no default release URL exists);
 * - with NO trust root (pinned roots are a refused placeholder by design) nothing installs:
 *   root-key-not-pinned — the dormant machinery fails closed;
 * - a dev-root-verified release installs atomically (artifact + manifest + sig + pointer) and
 *   verify-before-run then passes with trust "dev-root";
 * - a digest-mismatched download is rejected and NOTHING is promoted (previous pointer intact);
 * - the device token is attached ONLY to a same-origin artifact URL;
 * - a new release is staged BESIDE the live one and an install that fails after the artifact is
 *   written leaves the previous install current, verifying, and runnable.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeStoredCredentials } from "../../../src/core/auth/credentials.js";
import { generateDevSigningKeyPair, signManifest, type DevSigningKeyPair } from "../../../src/core/engine-install/dev-signing.js";
import {
  EngineInstallError,
  engineInstallRoot,
  enginePointerPath,
  engineReleaseDirPrefix,
  installDevRootKey,
  installEngineRelease,
  readCurrentPointer,
  type EngineInstallOps,
  type EngineReleaseDescriptor
} from "../../../src/core/engine-install/installer.js";
import { canonicalManifestBytes, type EngineReleaseManifest } from "../../../src/core/engine-install/manifest.js";
import { verifyInstalledArtifact } from "../../../src/core/engine-install/verify.js";
import { resolveEngine } from "../../../src/core/gateway/engine-ipc/supervisor.js";
import { recordEngineEulaAcceptance } from "../../../src/core/legal/engine-eula.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});

const API_URL = "http://127.0.0.1:9";

let configDir: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  configDir = mkdtempSync(path.join(tmpdir(), "engine-install-"));
  env = { COMPACTION_CONFIG_DIR: configDir };
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(configDir, { recursive: true, force: true });
});

function login(): void {
  recordEngineEulaAcceptance(env);
  // Throwaway keypair generated per run — never a literal PEM in source (the committed-secret
  // scanner would rightly flag one, fake or not).
  const throwaway = generateDevSigningKeyPair();
  writeStoredCredentials(
    {
      schema_version: 1,
      api_url: API_URL,
      account_id: "acct-1",
      device_id: "dev-1",
      device_token: "cmpd_test_dev-1.fake-secret-for-tests",
      device_private_key_pem: throwaway.privateKeyPem,
      device_public_key: throwaway.publicKeySpkiB64u,
      created_at: new Date().toISOString()
    },
    env
  );
}

function makeRelease(
  pair: DevSigningKeyPair,
  artifactBytes: Buffer,
  overrides: Partial<EngineReleaseManifest> = {},
  artifactUrl = `${API_URL}/artifacts/engine.js`
): { descriptor: EngineReleaseDescriptor; manifest: EngineReleaseManifest } {
  const manifest: EngineReleaseManifest = {
    schema_version: 1,
    version: "0.1.0-dev",
    channel: "dev",
    platform: "any",
    arch: "any",
    artifact_kind: "node-script",
    sha256: createHash("sha256").update(artifactBytes).digest("hex"),
    size_bytes: artifactBytes.length,
    ...overrides
  };
  return {
    manifest,
    descriptor: {
      manifest: canonicalManifestBytes(manifest).toString("utf8"),
      signature: signManifest(manifest, pair.privateKeyPem),
      artifact_url: artifactUrl
    }
  };
}

/** Ops serving one release + its artifact bytes from memory, recording download headers. */
function fakeOps(
  descriptor: EngineReleaseDescriptor | undefined,
  artifactBytes: Buffer,
  record: { downloadHeaders?: Record<string, string> } = {}
): EngineInstallOps {
  return {
    fetchLatestRelease: async () => descriptor,
    download: async (_url, destPath, headers) => {
      record.downloadHeaders = headers;
      writeFileSync(destPath, artifactBytes);
    }
  };
}

async function expectInstallError(promise: Promise<unknown>, code: EngineInstallError["code"]): Promise<void> {
  try {
    await promise;
    expect.fail(`expected EngineInstallError ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(EngineInstallError);
    expect((error as EngineInstallError).code).toBe(code);
  }
}

describe("installEngineRelease", () => {
  it("refuses without login — there is no default release URL", async () => {
    const pair = generateDevSigningKeyPair();
    const artifact = Buffer.from("engine");
    const { descriptor } = makeRelease(pair, artifact);
    await expectInstallError(
      installEngineRelease({ channel: "dev", env, ops: fakeOps(descriptor, artifact) }),
      "not-logged-in"
    );
  });

  it("fails closed when the release is signed by a key this build does not trust", async () => {
    login();
    const pair = generateDevSigningKeyPair();
    const artifact = Buffer.from("engine");
    const { descriptor } = makeRelease(pair, artifact);
    await expectInstallError(
      installEngineRelease({ channel: "dev", env, ops: fakeOps(descriptor, artifact) }),
      "signature-invalid"
    );
    expect(existsSync(enginePointerPath(env))).toBe(false);
  });

  it("reports no-published-release when the service has nothing on the channel", async () => {
    login();
    await expectInstallError(
      installEngineRelease({ channel: "stable", env, ops: fakeOps(undefined, Buffer.alloc(0)) }),
      "no-published-release"
    );
  });

  it("installs a dev-root-verified release atomically and verify-before-run passes", async () => {
    login();
    const pair = generateDevSigningKeyPair();
    installDevRootKey(pair.publicKeySpkiB64u, env);
    const artifact = Buffer.from("console.log('interim engine')");
    const { descriptor, manifest } = makeRelease(pair, artifact);
    const record: { downloadHeaders?: Record<string, string> } = {};

    const result = await installEngineRelease({ channel: "dev", env, ops: fakeOps(descriptor, artifact, record) });
    expect(result.updated).toBe(true);
    expect(result.trust).toBe("dev-root");
    expect(result.version).toBe("0.1.0-dev");
    expect(result.artifactKind).toBe("node-script");

    // Pointer names the artifact; the artifact + manifest + signature are colocated and verify.
    expect(readCurrentPointer(env)).toBe(result.artifactPath);
    expect(readFileSync(result.artifactPath)).toEqual(artifact);
    const verification = verifyInstalledArtifact(result.artifactPath, env);
    expect(verification).toEqual({ verified: true, trust: "dev-root", manifest });

    // Same-origin artifact URL ⇒ the device token was attached.
    expect(record.downloadHeaders?.authorization).toMatch(/^Bearer cmpd_test_/);
  });

  it("NEVER sends the device token to a cross-origin artifact URL", async () => {
    login();
    const pair = generateDevSigningKeyPair();
    installDevRootKey(pair.publicKeySpkiB64u, env);
    const artifact = Buffer.from("engine");
    const { descriptor } = makeRelease(pair, artifact, {}, "http://cdn.example.test/engine.js");
    const record: { downloadHeaders?: Record<string, string> } = {};
    await installEngineRelease({ channel: "dev", env, ops: fakeOps(descriptor, artifact, record) });
    expect(record.downloadHeaders).toEqual({});
  });

  it("an Esc that lands AFTER the bytes arrive still cancels — the transfer is not the last word", async () => {
    // WHY THIS IS NOT COVERED BY THE PRE-DOWNLOAD CHECK. Onboarding renders "Esc / Ctrl-C to stop and
    // continue on Open" for the whole wait, and the download was the only signal-aware step: a
    // keypress landing as the transfer finished — or during the hash, which on a real multi-megabyte
    // artifact is not instant — was read too late to change anything. The install went on to stage
    // and promote, so a device whose UI had already moved on to Open ended up running a new engine
    // it had just been told would not be installed.
    login();
    const pair = generateDevSigningKeyPair();
    installDevRootKey(pair.publicKeySpkiB64u, env);
    const artifact = Buffer.from("console.log('interim engine')");
    const { descriptor } = makeRelease(pair, artifact);
    const controller = new AbortController();
    const ops: EngineInstallOps = {
      fetchLatestRelease: async () => descriptor,
      download: async (_url, destPath) => {
        // The bytes are complete and correct. The user presses Esc at this exact moment.
        writeFileSync(destPath, artifact);
        controller.abort();
      }
    };

    await expectInstallError(installEngineRelease({ channel: "dev", env, ops, signal: controller.signal }), "cancelled");
    // NOTHING was published: no pointer, so the supervisor has nothing new to resolve.
    expect(existsSync(enginePointerPath(env))).toBe(false);
    expect(readCurrentPointer(env)).toBeUndefined();
  });

  it("asks again IMMEDIATELY BEFORE THE POINTER SWAP, and takes the staged release with it", async () => {
    // The pointer swap is the only step that makes a release this device's engine, so it is the step
    // that has to read a CURRENT answer. This signal reports aborted from the moment a staged release
    // exists on disk — i.e. the user pressed Esc while the install was assembling the directory —
    // which is after every earlier check has already passed. If the last guard were missing, the
    // release would be promoted and this test would find a pointer.
    login();
    const pair = generateDevSigningKeyPair();
    installDevRootKey(pair.publicKeySpkiB64u, env);
    const artifact = Buffer.from("console.log('interim engine')");
    const { descriptor, manifest } = makeRelease(pair, artifact);
    const installRoot = engineInstallRoot(env);
    const stagedPrefix = path.basename(engineReleaseDirPrefix(manifest));
    const staged = (): string[] => {
      try {
        return readdirSync(installRoot).filter((name) => name.startsWith(stagedPrefix));
      } catch {
        return [];
      }
    };
    const signal = {
      get aborted(): boolean {
        return staged().length > 0;
      },
      addEventListener: () => {},
      removeEventListener: () => {}
    } as unknown as AbortSignal;

    await expectInstallError(
      installEngineRelease({ channel: "dev", env, ops: fakeOps(descriptor, artifact), signal }),
      "cancelled"
    );
    expect(existsSync(enginePointerPath(env))).toBe(false);
    // And the staged directory did not survive the cancellation it caused: the guard sits inside the
    // staging block, so the half-built release is removed exactly as a failed staging would be.
    expect(staged()).toEqual([]);
  });

  it("rejects a digest-mismatched download and promotes NOTHING", async () => {
    login();
    const pair = generateDevSigningKeyPair();
    installDevRootKey(pair.publicKeySpkiB64u, env);
    const artifact = Buffer.from("real engine bytes");
    const { descriptor } = makeRelease(pair, artifact);
    // The server serves DIFFERENT bytes than the signed digest.
    await expectInstallError(
      installEngineRelease({ channel: "dev", env, ops: fakeOps(descriptor, Buffer.from("evil bytes")) }),
      "artifact-digest-mismatch"
    );
    expect(existsSync(enginePointerPath(env))).toBe(false);
  });

  it("rejects a signature from an untrusted key", async () => {
    login();
    const trusted = generateDevSigningKeyPair();
    const attacker = generateDevSigningKeyPair();
    installDevRootKey(trusted.publicKeySpkiB64u, env);
    const artifact = Buffer.from("engine");
    const { descriptor } = makeRelease(attacker, artifact);
    await expectInstallError(
      installEngineRelease({ channel: "dev", env, ops: fakeOps(descriptor, artifact) }),
      "signature-invalid"
    );
  });

  it("rejects a non-canonical (but signed) manifest", async () => {
    login();
    const pair = generateDevSigningKeyPair();
    installDevRootKey(pair.publicKeySpkiB64u, env);
    const artifact = Buffer.from("engine");
    const { manifest } = makeRelease(pair, artifact);
    // Sign a NON-canonical serialization (extra whitespace). It verifies but is refused.
    const nonCanonical = JSON.stringify(manifest, null, 2);
    const { sign, createPrivateKey } = await import("node:crypto");
    const signature = sign(null, Buffer.from(nonCanonical, "utf8"), createPrivateKey(pair.privateKeyPem)).toString(
      "base64url"
    );
    await expectInstallError(
      installEngineRelease({
        channel: "dev",
        env,
        ops: fakeOps({ manifest: nonCanonical, signature, artifact_url: `${API_URL}/a` }, artifact)
      }),
      "manifest-invalid"
    );
  });

  it("rejects a release that targets a different host", async () => {
    login();
    const pair = generateDevSigningKeyPair();
    installDevRootKey(pair.publicKeySpkiB64u, env);
    const artifact = Buffer.from("engine");
    const { descriptor } = makeRelease(pair, artifact, { platform: "not-a-real-platform" });
    await expectInstallError(
      installEngineRelease({ channel: "dev", env, ops: fakeOps(descriptor, artifact) }),
      "release-not-for-host"
    );
  });

  it("reinstalling the same verified version reports updated=false and downloads nothing", async () => {
    login();
    const pair = generateDevSigningKeyPair();
    installDevRootKey(pair.publicKeySpkiB64u, env);
    const artifact = Buffer.from("engine");
    const { descriptor } = makeRelease(pair, artifact);
    const first = await installEngineRelease({ channel: "dev", env, ops: fakeOps(descriptor, artifact) });
    expect(first.updated).toBe(true);

    let downloads = 0;
    const countingOps: EngineInstallOps = {
      fetchLatestRelease: async () => descriptor,
      download: async () => {
        downloads += 1;
        throw new Error("should not download");
      }
    };
    const second = await installEngineRelease({ channel: "dev", env, ops: countingOps });
    expect(second.updated).toBe(false);
    expect(second.version).toBe(first.version);
    expect(downloads).toBe(0);
  });

  it("a stable install over a same-version DEV install is NOT treated as current (reinstalls)", async () => {
    // Regression for Codex #817 installer.ts: a version-only "already current" check let an installed
    // DEV artifact satisfy a STABLE install. The full release identity (channel + digest + kind) must
    // be compared, so a channel change forces a real reinstall.
    login();
    const pair = generateDevSigningKeyPair();
    installDevRootKey(pair.publicKeySpkiB64u, env);
    const devArtifact = Buffer.from("dev engine");
    const dev = makeRelease(pair, devArtifact, { version: "1.0.0", channel: "dev" });
    const firstInstall = await installEngineRelease({ channel: "dev", env, ops: fakeOps(dev.descriptor, devArtifact) });
    expect(firstInstall.updated).toBe(true);
    expect(firstInstall.channel).toBe("dev");

    // Same version, STABLE channel, different bytes → must download + reinstall, not report current.
    const stableArtifact = Buffer.from("stable engine");
    const stable = makeRelease(pair, stableArtifact, { version: "1.0.0", channel: "stable" });
    const second = await installEngineRelease({ channel: "stable", env, ops: fakeOps(stable.descriptor, stableArtifact) });
    expect(second.updated).toBe(true);
    expect(second.channel).toBe("stable");
    // The on-disk manifest now reflects the stable release the caller asked for.
    const verification = verifyInstalledArtifact(second.artifactPath, env);
    expect(verification.verified && verification.manifest.channel).toBe("stable");
    expect(readFileSync(second.artifactPath)).toEqual(stableArtifact);
  });

  it("a channel switch is staged BESIDE the live release — the previous install still verifies", async () => {
    // Regression for Codex #818 installer.ts: a same-version different-channel install used to
    // rewrite artifact + manifest + signature IN PLACE in the directory `current` already named.
    // Releases now live in identity-keyed directories, so the previous install is never touched.
    login();
    const pair = generateDevSigningKeyPair();
    installDevRootKey(pair.publicKeySpkiB64u, env);
    const devArtifact = Buffer.from("dev engine");
    const dev = makeRelease(pair, devArtifact, { version: "2.0.0", channel: "dev" });
    const first = await installEngineRelease({ channel: "dev", env, ops: fakeOps(dev.descriptor, devArtifact) });

    const stableArtifact = Buffer.from("stable engine");
    const stable = makeRelease(pair, stableArtifact, { version: "2.0.0", channel: "stable" });
    const second = await installEngineRelease({ channel: "stable", env, ops: fakeOps(stable.descriptor, stableArtifact) });

    // Distinct directories, and the DEV release is still on disk, unmodified, and still verifying.
    expect(second.artifactPath).not.toBe(first.artifactPath);
    expect(readFileSync(first.artifactPath)).toEqual(devArtifact);
    const previous = verifyInstalledArtifact(first.artifactPath, env);
    expect(previous.verified && previous.manifest.channel).toBe("dev");
    // The pointer moved to the newly promoted release.
    expect(readCurrentPointer(env)).toBe(second.artifactPath);
  });

  it("an install that fails AFTER the artifact is written leaves the previous install current and runnable", async () => {
    // The interruption the finding describes: a write fails once the new artifact bytes are already
    // on disk. Inject a failure at the pointer rename (its temporary path is unique per call).
    // In-place installs left `current` naming a
    // half-replaced release (previous install no longer verifies ⇒ supervisor `engine-unverified`);
    // with stage-then-promote the previous install is untouched, still verifies, and still runs.
    login();
    const pair = generateDevSigningKeyPair();
    installDevRootKey(pair.publicKeySpkiB64u, env);
    const devArtifact = Buffer.from("dev engine");
    const dev = makeRelease(pair, devArtifact, { version: "3.0.0", channel: "dev" });
    const first = await installEngineRelease({ channel: "dev", env, ops: fakeOps(dev.descriptor, devArtifact) });

    vi.mocked(fs.renameSync).mockImplementationOnce(() => { throw new Error("injected pointer publication failure"); });

    const stableArtifact = Buffer.from("stable engine");
    const stable = makeRelease(pair, stableArtifact, { version: "3.0.0", channel: "stable" });
    await expectInstallError(
      installEngineRelease({ channel: "stable", env, ops: fakeOps(stable.descriptor, stableArtifact) }),
      "install-write-failed"
    );

    // The previous install is STILL what `current` names, still verifies, and still resolves as a
    // runnable engine for the supervisor (no `engine-unverified` degrade).
    expect(readCurrentPointer(env)).toBe(first.artifactPath);
    expect(readFileSync(first.artifactPath)).toEqual(devArtifact);
    const previous = verifyInstalledArtifact(first.artifactPath, env);
    expect(previous.verified && previous.manifest.channel).toBe("dev");
    const resolved = resolveEngine({ env });
    // The supervisor realpaths its containment check (on macOS /var → /private/var).
    expect(resolved.path).toBe(realpathSync(first.artifactPath));
    expect(resolved.source).toBe("installed");
    expect(resolved.unverifiedReason).toBeUndefined();
  });

  it("reinstalling over a NON-VERIFYING install of the same release never removes the old directory", async () => {
    // Promote must not pre-remove anything: the old tree stays on disk (merely unreferenced) so a
    // failure — or a concurrent installer holding that path — can never be left pointing at a
    // deleted release.
    login();
    const pair = generateDevSigningKeyPair();
    installDevRootKey(pair.publicKeySpkiB64u, env);
    const artifact = Buffer.from("engine bytes");
    const { descriptor } = makeRelease(pair, artifact, { version: "4.0.0" });
    const first = await installEngineRelease({ channel: "dev", env, ops: fakeOps(descriptor, artifact) });

    // Tamper with the live artifact: the SAME release identity is requested again, but the current
    // install no longer verifies, so a real reinstall must happen.
    writeFileSync(first.artifactPath, "tampered");
    const second = await installEngineRelease({ channel: "dev", env, ops: fakeOps(descriptor, artifact) });

    expect(second.updated).toBe(true);
    expect(second.artifactPath).not.toBe(first.artifactPath);
    expect(readCurrentPointer(env)).toBe(second.artifactPath);
    // The old (tampered) directory was NOT deleted, and the new one verifies.
    expect(existsSync(first.artifactPath)).toBe(true);
    expect(readFileSync(first.artifactPath, "utf8")).toBe("tampered");
    expect(verifyInstalledArtifact(second.artifactPath, env).verified).toBe(true);
  });

  it("two concurrent installs of the same release do not disturb each other", async () => {
    login();
    const pair = generateDevSigningKeyPair();
    installDevRootKey(pair.publicKeySpkiB64u, env);
    const artifact = Buffer.from("concurrent engine");
    const { descriptor } = makeRelease(pair, artifact, { version: "5.0.0" });

    const [a, b] = await Promise.all([
      installEngineRelease({ channel: "dev", env, ops: fakeOps(descriptor, artifact) }),
      installEngineRelease({ channel: "dev", env, ops: fakeOps(descriptor, artifact) })
    ]);

    // Each install published its own directory; neither removed the other's.
    expect(a.artifactPath).not.toBe(b.artifactPath);
    expect(existsSync(a.artifactPath)).toBe(true);
    expect(existsSync(b.artifactPath)).toBe(true);
    expect(verifyInstalledArtifact(a.artifactPath, env).verified).toBe(true);
    expect(verifyInstalledArtifact(b.artifactPath, env).verified).toBe(true);
    // The pointer names one of them (last writer wins) and it resolves as a runnable engine.
    const current = readCurrentPointer(env);
    expect([a.artifactPath, b.artifactPath]).toContain(current);
    const resolved = resolveEngine({ env });
    expect(resolved.path).toBe(realpathSync(current!));
    expect(resolved.unverifiedReason).toBeUndefined();
  });

  it("a pointer naming a path OUTSIDE the install root is never treated as the current install", async () => {
    // Containment is re-checked here, not just at spawn: an escaped pointer (with a genuinely valid
    // release behind it) must not let `engine install` report up-to-date and skip a real install.
    login();
    const pair = generateDevSigningKeyPair();
    installDevRootKey(pair.publicKeySpkiB64u, env);
    const artifact = Buffer.from("outside engine");
    const { descriptor } = makeRelease(pair, artifact, { version: "6.0.0" });
    const installed = await installEngineRelease({ channel: "dev", env, ops: fakeOps(descriptor, artifact) });

    // Copy the verified release outside the install root and point `current` at it.
    const outside = mkdtempSync(path.join(tmpdir(), "engine-outside-"));
    for (const name of ["engine.js", "manifest.json", "manifest.sig"]) {
      writeFileSync(path.join(outside, name), readFileSync(path.join(path.dirname(installed.artifactPath), name)));
    }
    const escaped = path.join(outside, "engine.js");
    writeFileSync(enginePointerPath(env), `${escaped}\n`);
    expect(verifyInstalledArtifact(escaped, env).verified).toBe(true); // valid — but out of bounds

    try {
      const again = await installEngineRelease({ channel: "dev", env, ops: fakeOps(descriptor, artifact) });
      expect(again.updated).toBe(true); // NOT reported as already current
      expect(readCurrentPointer(env)).toBe(again.artifactPath);
      expect(again.artifactPath.startsWith(path.resolve(configDir, "engine") + path.sep)).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("installDevRootKey rejects a malformed key", () => {
    expect(() => installDevRootKey("not-a-key", env)).toThrowError(EngineInstallError);
    expect(() => installDevRootKey("", env)).toThrowError(EngineInstallError);
  });

  it("rejects a SIGNED manifest with a traversal version and writes NOTHING outside the config dir", async () => {
    login();
    const pair = generateDevSigningKeyPair();
    installDevRootKey(pair.publicKeySpkiB64u, env);
    const artifact = Buffer.from("engine");
    // The probe: a validly-signed manifest whose version traverses out of the
    // install root. Signing must never grant a filesystem write outside the install root.
    const evil: EngineReleaseManifest = {
      schema_version: 1,
      version: "../../pr7-escape",
      channel: "dev",
      platform: "any",
      arch: "any",
      artifact_kind: "node-script",
      sha256: createHash("sha256").update(artifact).digest("hex"),
      size_bytes: artifact.length
    };
    const descriptor: EngineReleaseDescriptor = {
      manifest: canonicalManifestBytes(evil).toString("utf8"),
      signature: signManifest(evil, pair.privateKeyPem),
      artifact_url: `${API_URL}/a`
    };
    await expectInstallError(
      installEngineRelease({ channel: "dev", env, ops: fakeOps(descriptor, artifact) }),
      "manifest-invalid"
    );
    // Nothing escaped: the traversal targets (relative to <configDir>/engine) do not exist.
    expect(existsSync(path.join(configDir, "pr7-escape"))).toBe(false);
    expect(existsSync(path.resolve(configDir, "..", "pr7-escape"))).toBe(false);
    expect(existsSync(enginePointerPath(env))).toBe(false);
  });
});
