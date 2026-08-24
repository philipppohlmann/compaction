/**
 * `compaction engine` command tests — built CLI, tmp config dir (never the real
 * ~/.compaction), no live service.
 *
 * Claims honesty pinned here:
 * - `engine status` is a local read (asserted under the same network-trap preload as the Open
 *   guarantees test), and its trust-root line is DERIVED: a build that pins a release root must not
 *   print any "nothing has been distributed" copy, since a signed release now exists;
 * - a DEV-SIGNED install is loudly labeled and never presented as a release;
 * - `engine install` without login refuses with the login hint BEFORE any network call
 *   (it also runs under the network trap);
 * - `engine` is a public top-level command.
 */
import { execFileSync } from "node:child_process";
import { pinnedRootKeys } from "../../src/core/engine-install/manifest.js";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateDevSigningKeyPair } from "../../src/core/engine-install/dev-signing.js";
import { signManifest } from "../../src/core/engine-install/dev-signing.js";
import { canonicalManifestBytes, type EngineReleaseManifest } from "../../src/core/engine-install/manifest.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = path.join(repoRoot, "dist", "cli", "index.js");
const CLI_BUILT = existsSync(CLI);

// Same trap as tests/security/open-basic-engine-free.test.ts: any socket use crashes the command.
const NETWORK_TRAP = `
const failHard = (what) => { throw new Error("NETWORK CALL ATTEMPTED: " + what); };
if (typeof globalThis.fetch === "function") { globalThis.fetch = () => failHard("fetch"); }
const Module = require("module");
const origLoad = Module._load;
Module._load = function (request) {
  const mod = origLoad.apply(this, arguments);
  const trap = (obj, method, label) => {
    if (obj && typeof obj[method] === "function") { obj[method] = function () { return failHard(label); }; }
  };
  if (request === "http" || request === "node:http") { trap(mod, "request", "http.request"); trap(mod, "get", "http.get"); }
  if (request === "https" || request === "node:https") { trap(mod, "request", "https.request"); trap(mod, "get", "https.get"); }
  if (request === "net" || request === "node:net") { trap(mod, "connect", "net.connect"); trap(mod, "createConnection", "net.createConnection"); }
  return mod;
};
`;

let workDir: string;
let preloadPath: string;

beforeAll(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "engine-cmd-"));
  preloadPath = path.join(workDir, "network-trap.cjs");
  writeFileSync(preloadPath, NETWORK_TRAP, "utf8");
});
afterAll(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function runCli(
  args: string[],
  configDir: string,
  opts: { trap?: boolean; expectFailure?: boolean } = {}
): { stdout: string; status: number } {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    FORCE_COLOR: "0",
    COMPACTION_CONFIG_DIR: configDir,
    ...(opts.trap === false
      ? {}
      : { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require ${preloadPath}`.trim() })
  };
  try {
    const stdout = execFileSync("node", [CLI, ...args], { cwd: workDir, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
    return { stdout, status: 0 };
  } catch (error) {
    const e = error as { status?: number; stdout?: Buffer | string };
    if (!opts.expectFailure) throw error;
    return { stdout: (e.stdout ?? "").toString(), status: e.status ?? 1 };
  }
}

/** Lay out a signed dev-root install inside `configDir`. */
function installDevSigned(configDir: string): void {
  const pair = generateDevSigningKeyPair();
  const engineDir = path.join(configDir, "engine");
  const versionDir = path.join(engineDir, "0.1.0-dev");
  mkdirSync(versionDir, { recursive: true });
  writeFileSync(path.join(engineDir, "dev-root-key.pub"), `${pair.publicKeySpkiB64u}\n`);
  const artifactPath = path.join(versionDir, "engine.js");
  const body = "// dev engine placeholder";
  writeFileSync(artifactPath, body, "utf8");
  const manifest: EngineReleaseManifest = {
    schema_version: 1,
    version: "0.1.0-dev",
    channel: "dev",
    platform: "any",
    arch: "any",
    artifact_kind: "node-script",
    sha256: createHash("sha256").update(body).digest("hex"),
    size_bytes: Buffer.byteLength(body)
  };
  writeFileSync(path.join(versionDir, "manifest.json"), canonicalManifestBytes(manifest));
  writeFileSync(path.join(versionDir, "manifest.sig"), `${signManifest(manifest, pair.privateKeyPem)}\n`);
  writeFileSync(path.join(engineDir, "current"), `${artifactPath}\n`);
}

describe.runIf(CLI_BUILT)("compaction engine (built CLI)", () => {
  it("`engine` is a public top-level command", () => {
    const configDir = mkdtempSync(path.join(tmpdir(), "engine-cmd-cfg-"));
    try {
      const { stdout } = runCli(["--help"], configDir);
      expect(stdout).toMatch(/\bengine\b/);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it("`engine status` with no install is honest, local-only, and tracks the pinned-root state", () => {
    const configDir = mkdtempSync(path.join(tmpdir(), "engine-cmd-cfg-"));
    try {
      const { stdout } = runCli(["engine", "status"], configDir);
      // In a dev checkout the dev build resolves; either way NO release/verified claim appears.
      expect(stdout).not.toMatch(/Installed engine: verified/);

      // The distribution line is DERIVED from the pinned roots, not asserted. This test used to
      // require the "nothing is distributed yet" sentence unconditionally, which was correct only
      // while the root was a placeholder — so it is inverted here rather than dropped, and both
      // directions are pinned so neither state can print the other's copy.
      // Sweep the CLAIM, not one sentence: no phrasing of "nothing has been distributed" may
      // appear, because a signed stable release was published on 2026-08-19.
      const distributionClaim = /no engine release is distributed|has been distributed yet|no signed (engine )?release/i;
      if (pinnedRootKeys().length === 0) {
        expect(stdout).toMatch(distributionClaim);
      } else {
        expect(stdout, "a build that pins a release root must not claim nothing is distributed").not.toMatch(
          distributionClaim
        );
      }

      expect(stdout).toContain("no network call was made");
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it("`engine status` labels a dev-signed install loudly (DEV-SIGNED, not a release)", () => {
    const configDir = mkdtempSync(path.join(tmpdir(), "engine-cmd-cfg-"));
    try {
      installDevSigned(configDir);
      const { stdout } = runCli(["engine", "status"], configDir);
      expect(stdout).toContain("Installed engine: verified");
      expect(stdout).toContain("0.1.0-dev");
      expect(stdout).toContain("DEV-SIGNED");
      expect(stdout).toContain("not a release");
      expect(stdout).toContain("no network call was made");
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it("`engine status` reports an unverified (tampered) install and the fail-open behavior", () => {
    const configDir = mkdtempSync(path.join(tmpdir(), "engine-cmd-cfg-"));
    try {
      installDevSigned(configDir);
      writeFileSync(path.join(configDir, "engine", "0.1.0-dev", "engine.js"), "// tampered", "utf8");
      const { stdout } = runCli(["engine", "status"], configDir);
      expect(stdout).toContain("NOT verified");
      expect(stdout).toContain("artifact-digest-mismatch");
      expect(stdout).toMatch(/degrades fail-open/);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it("`engine install` without login refuses with the login hint, before any network call", () => {
    const configDir = mkdtempSync(path.join(tmpdir(), "engine-cmd-cfg-"));
    try {
      const { stdout, status } = runCli(["engine", "install", "--channel", "dev"], configDir, { expectFailure: true });
      expect(status).not.toBe(0);
      expect(stdout).toContain("not-logged-in");
      expect(stdout).toContain("compaction login");
      // AND THE LICENCE IS NOT OFFERED YET. A logged-out device cannot receive the Engine whatever
      // it agrees to, so putting the agreement first would ask for consent to something that cannot
      // happen and would bury the one thing the user has to fix. The account gap is the answer here.
      expect(stdout, "the account precondition is reported before the agreement is offered").not.toContain(
        "Compaction Engine License Agreement"
      );
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it("`engine install` rejects an unknown channel", () => {
    const configDir = mkdtempSync(path.join(tmpdir(), "engine-cmd-cfg-"));
    try {
      const { status } = runCli(["engine", "install", "--channel", "nightly"], configDir, { expectFailure: true });
      expect(status).not.toBe(0);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});
