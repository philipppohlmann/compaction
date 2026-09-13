/**
 * `compaction status` SAYS WHEN INPUT COMPACTION CANNOT RUN.
 *
 * The five-day outage's worst property was not the refusal — the refusal is correct — it was that
 * the ONLY signal was a per-request gateway log line. `status` reported `Engine: ready` and
 * `Optimization: Full`, both true of output shaping, while every input apply was discarded. Nothing
 * a user could run said the flagship capability was off.
 *
 * PURE LOCAL DISK, NO SOCKETS: `runStatus` is driven in-process against a redirected config dir
 * holding a dev-signed engine install; no API key is configured so no health check runs.
 *
 * The exact-string pins live in their own cases, separate from the behavioural ones. A pin and a
 * property rule in one test means the string failure reports first and the property assertion can go
 * silently dead.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  INPUT_COMPACTION_UNSUPPORTED,
  INPUT_COMPACTION_UNSUPPORTED_REMEDY,
  runStatus
} from "../../src/cli/commands/upgrade-status.js";
import { generateDevSigningKeyPair, signManifest } from "../../src/core/engine-install/dev-signing.js";
import { canonicalManifestBytes, type EngineReleaseManifest } from "../../src/core/engine-install/manifest.js";
import { MANIFEST_FILENAME, SIGNATURE_FILENAME, devRootKeyPath } from "../../src/core/engine-install/verify.js";
import { ACTIVE_USAGE_METER_VERSION } from "../../src/core/usage/usage-event.js";

let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "status-input-compaction-"));
});
afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

/** Install a dev-signed engine whose manifest declares `meterVersion`, or nothing when v1. */
function installEngine(meterVersion?: string): void {
  const env = { COMPACTION_CONFIG_DIR: configDir };
  const pair = generateDevSigningKeyPair();
  const engineRoot = join(configDir, "engine");
  const versionDir = join(engineRoot, "0.6.10-stable");
  mkdirSync(versionDir, { recursive: true });
  writeFileSync(devRootKeyPath(env), `${pair.publicKeySpkiB64u}\n`);

  const body = "// signed engine fixture\n";
  const artifactPath = join(versionDir, "engine.js");
  writeFileSync(artifactPath, body, "utf8");
  const base = {
    version: "0.6.10-stable", channel: "dev" as const, platform: "any", arch: "any",
    artifact_kind: "node-script" as const, sha256: createHash("sha256").update(body).digest("hex"),
    size_bytes: Buffer.byteLength(body)
  };
  const manifest: EngineReleaseManifest = meterVersion === undefined
    ? { schema_version: 1, ...base }
    : {
        schema_version: 2, ...base, cli_min_version: "0.0.1", cli_max_version: "1.0.0",
        engine_protocol: 1, usage_schema_version: 3, meter_version: meterVersion, eula_version: "1.0"
      };
  writeFileSync(join(versionDir, MANIFEST_FILENAME), canonicalManifestBytes(manifest));
  writeFileSync(join(versionDir, SIGNATURE_FILENAME), `${signManifest(manifest, pair.privateKeyPem)}\n`);
  writeFileSync(join(engineRoot, "current"), `${artifactPath}\n`);
}

/** Offline env: tmp config dir, no hosted key/url, no ambient engine-path override. */
function statusEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    COMPACTION_CONFIG_DIR: configDir,
    COMPACTION_ENGINE_PATH: "",
    COMPACTION_API_URL: "",
    COMPACTION_API_KEY: "",
    ANTHROPIC_API_KEY: "",
    OPENAI_API_KEY: ""
  };
}

async function status(json = false): Promise<string> {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  try {
    await runStatus({
      env: statusEnv(), version: "0.0.0-test", projectsDir: join(configDir, "none"),
      ...(json ? { json: true } : {})
    });
  } finally {
    vi.restoreAllMocks();
  }
  return lines.join("\n");
}

describe("status reports an engine that cannot compact input", () => {
  it("shows the limitation when the installed engine predates the meter contract", async () => {
    installEngine();
    const out = await status();
    expect(out).toContain(INPUT_COMPACTION_UNSUPPORTED);
    expect(out).toContain(INPUT_COMPACTION_UNSUPPORTED_REMEDY);
  });

  it("stays silent when the installed engine declares this client's active unit", async () => {
    installEngine(ACTIVE_USAGE_METER_VERSION);
    const out = await status();
    expect(out).not.toContain(INPUT_COMPACTION_UNSUPPORTED);
    expect(out).not.toContain(INPUT_COMPACTION_UNSUPPORTED_REMEDY);
  });

  it("stays silent when no signed manifest declared anything either way", async () => {
    // No install: nothing declared a unit, so `status` makes no claim about one. Saying the
    // capability was unavailable here would be guessing about an artifact it never read.
    const out = await status();
    expect(out).not.toContain(INPUT_COMPACTION_UNSUPPORTED);
  });

  it("carries the pair's declaration on the --json diagnostic surface", async () => {
    installEngine();
    const parsed = JSON.parse(await status(true)) as {
      entitlement?: { engineInputCompaction?: string };
    };
    expect(parsed.entitlement?.engineInputCompaction).toBe("unsupported");
  });
});

describe("the user-facing wording (exact-string pins, kept apart from the rules above)", () => {
  it("names what is off and why, without asserting a compatible engine already exists", () => {
    expect(INPUT_COMPACTION_UNSUPPORTED).toBe(
      "Input compaction: unavailable - the installed engine predates this release's metering contract."
    );
    expect(INPUT_COMPACTION_UNSUPPORTED_REMEDY).toBe(
      "Output shaping continues. Run compaction engine install to pick up a compatible engine once one is published."
    );
  });
});
