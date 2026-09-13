/**
 * THE PAIRING ASSERTION THAT WAS MISSING.
 *
 * On 2026-09-03 the client made `optimized-input-v2` mandatory for any apply that compacted input.
 * The engine installed on the affected machines (`0.6.10-stable`, built 2026-08-28) ships a
 * schema-v1 manifest, which has no field to declare a meter unit in. Nothing compared the two: the
 * engine resolved, spawned, compacted, and had every result thrown away at request time with a log
 * line. Input compaction was dead for five days and the only evidence was in a receipt corpus.
 *
 * The compatibility tuple ALREADY compared meter units — `compatibleFull` has always required
 * `engine.meter_version === cli.meterVersion`. It was simply never consulted on the resolution path
 * that actually runs: a plain `compaction gateway start` has no session pin, so it takes the ambient
 * `current`-pointer path, which checks pointer containment, signature, and digest and stops there.
 *
 * So the assertions below are deliberately split in two:
 *  - the CONTRACT (`engineInputCompactionSupport`) — what a manifest declares, as a pure function;
 *  - the GATE (`resolveEngine` / `EngineSupervisor`) — that the ambient path evaluates that contract
 *    at all. The second is the one that would have failed in August.
 *
 * Fixtures are dev-signed installs under a redirected `COMPACTION_CONFIG_DIR`; the real
 * `~/.compaction` is never read or written.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EngineSupervisor, resolveEngine } from "../../src/core/gateway/engine-ipc/supervisor.js";
import { engineInputCompactionSupport } from "../../src/core/update/compatibility.js";
import { generateDevSigningKeyPair, signManifest } from "../../src/core/engine-install/dev-signing.js";
import { canonicalManifestBytes, type EngineReleaseManifest } from "../../src/core/engine-install/manifest.js";
import { MANIFEST_FILENAME, SIGNATURE_FILENAME, devRootKeyPath } from "../../src/core/engine-install/verify.js";
import { ACTIVE_USAGE_METER_VERSION } from "../../src/core/usage/usage-event.js";

const CLI = { meterVersion: ACTIVE_USAGE_METER_VERSION };

/** The shape a shipped pre-contract install actually has: signed, valid, and undeclared. */
function v1Manifest(body: string): EngineReleaseManifest {
  return {
    schema_version: 1,
    version: "0.6.10-stable",
    channel: "dev",
    platform: "any",
    arch: "any",
    artifact_kind: "node-script",
    sha256: createHash("sha256").update(body).digest("hex"),
    size_bytes: Buffer.byteLength(body)
  };
}

/** A post-contract manifest, parameterised on the unit so a stale one can be exercised too. */
function v2Manifest(body: string, meterVersion: string): EngineReleaseManifest {
  return {
    ...v1Manifest(body),
    schema_version: 2,
    cli_min_version: "0.0.1",
    cli_max_version: "1.0.0",
    engine_protocol: 1,
    usage_schema_version: 3,
    meter_version: meterVersion,
    eula_version: "1.0"
  };
}

let configDir: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  configDir = mkdtempSync(path.join(tmpdir(), "engine-pair-meter-"));
  env = { COMPACTION_CONFIG_DIR: configDir };
});
afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

/** Lay out a dev-signed install and point `current` at it. The artifact is never spawned here. */
function installSigned(manifestFor: (body: string) => EngineReleaseManifest): void {
  const pair = generateDevSigningKeyPair();
  const engineRoot = path.join(configDir, "engine");
  const versionDir = path.join(engineRoot, "0.6.10-stable");
  mkdirSync(versionDir, { recursive: true });
  writeFileSync(devRootKeyPath(env), `${pair.publicKeySpkiB64u}\n`);

  const body = "// signed engine fixture\n";
  const artifactPath = path.join(versionDir, "engine.js");
  writeFileSync(artifactPath, body, "utf8");
  const manifest = manifestFor(body);
  writeFileSync(path.join(versionDir, MANIFEST_FILENAME), canonicalManifestBytes(manifest));
  writeFileSync(path.join(versionDir, SIGNATURE_FILENAME), `${signManifest(manifest, pair.privateKeyPem)}\n`);
  writeFileSync(path.join(engineRoot, "current"), `${artifactPath}\n`);
}

describe("the declared input-compaction contract", () => {
  it("reads a v2 manifest that declares this client's active unit as supported", () => {
    expect(engineInputCompactionSupport(CLI, v2Manifest("x", ACTIVE_USAGE_METER_VERSION)))
      .toEqual({ support: "supported", meterVersion: ACTIVE_USAGE_METER_VERSION });
  });

  it("refuses a schema-v1 manifest: the schema predates the contract, so its silence is not consent", () => {
    // The exact shape of the shipped 0.6.10 install. `meter-undeclared`, not `meter-mismatch`:
    // this engine did not say something else, it had nowhere to say anything.
    expect(engineInputCompactionSupport(CLI, v1Manifest("x")))
      .toEqual({ support: "unsupported", reason: "meter-undeclared" });
  });

  it("refuses a v2 manifest that declares a DIFFERENT unit, and reports which", () => {
    expect(engineInputCompactionSupport(CLI, v2Manifest("x", "optimized-input-v1")))
      .toEqual({ support: "unsupported", reason: "meter-mismatch", declaredMeterVersion: "optimized-input-v1" });
  });

  it("never INFERS a unit: an absent manifest is unknown, not supported and not unsupported", () => {
    // `unknown` is what keeps the dev build and an explicit path override working. Folding it into
    // either of the other two would be a claim about an artifact that declared nothing.
    expect(engineInputCompactionSupport(CLI, undefined)).toEqual({ support: "unknown" });
  });
});

describe("the AMBIENT resolution path evaluates that contract (the gate that was missing)", () => {
  it("admits a signed pre-contract engine but declares it cannot compact input", () => {
    installSigned(v1Manifest);
    const resolved = resolveEngine({ env });

    // ADMITTED. Refusing the artifact would take the engine's OUTPUT SHAPING away too - a base
    // capability that costs no input allowance and is unaffected by the input meter. The engine is
    // signed and verified; it is only the input meter it cannot speak.
    expect(resolved.path).not.toBeNull();
    expect(resolved.source).toBe("installed");
    expect(resolved.unverifiedReason).toBeUndefined();

    // ...AND DECLARED INCAPABLE, at resolution, from the signed manifest - not discovered per
    // request after the engine has already done the work.
    expect(resolved.inputCompaction).toEqual({ support: "unsupported", reason: "meter-undeclared" });
  });

  it("declares a signed engine that speaks the active unit as supported", () => {
    installSigned((body) => v2Manifest(body, ACTIVE_USAGE_METER_VERSION));
    expect(resolveEngine({ env }).inputCompaction).toEqual({
      support: "supported",
      meterVersion: ACTIVE_USAGE_METER_VERSION
    });
  });

  it("declares a signed engine on a stale unit as unsupported", () => {
    installSigned((body) => v2Manifest(body, "optimized-input-v1"));
    expect(resolveEngine({ env }).inputCompaction).toEqual({
      support: "unsupported",
      reason: "meter-mismatch",
      declaredMeterVersion: "optimized-input-v1"
    });
  });

  it("claims nothing when there is no signed manifest to read", () => {
    // No install at all: the resolution falls through to the dev build (or to none). Either way
    // nothing declared a unit, and the request-time guard remains the only authority.
    expect(resolveEngine({ env }).inputCompaction).toEqual({ support: "unknown" });
  });
});

describe("the supervisor carries the declaration to its callers", () => {
  it("exposes the resolved pair's declaration, so a caller can narrow what it asks for", () => {
    installSigned(v1Manifest);
    const supervisor = new EngineSupervisor({ env });
    try {
      expect(supervisor.engineResolved).toBe(true);
      expect(supervisor.inputCompactionSupport).toEqual({ support: "unsupported", reason: "meter-undeclared" });
    } finally {
      supervisor.dispose();
    }
  });

  it("reports unknown for an explicit path override, which carries no manifest", () => {
    const stub = path.join(configDir, "override-engine.js");
    writeFileSync(stub, "// existence is all an explicit override is checked for\n");
    const supervisor = new EngineSupervisor({ env, enginePath: stub });
    try {
      expect(supervisor.inputCompactionSupport).toEqual({ support: "unknown" });
    } finally {
      supervisor.dispose();
    }
  });
});
