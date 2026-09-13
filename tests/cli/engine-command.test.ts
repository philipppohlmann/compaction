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
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { createInterface } from "node:readline/promises";
import * as installer from "../../src/core/engine-install/installer.js";
import * as manifests from "../../src/core/engine-install/manifest.js";
import { registerEngineCommand } from "../../src/cli/commands/engine.js";
import { writeStoredCredentials } from "../../src/core/auth/credentials.js";
import { engineEulaAccepted, readEngineEulaAcceptance, recordEngineEulaAcceptance } from "../../src/core/legal/engine-eula.js";
import { generateDevSigningKeyPair } from "../../src/core/engine-install/dev-signing.js";
import { signManifest } from "../../src/core/engine-install/dev-signing.js";
import { canonicalManifestBytes, type EngineReleaseManifest } from "../../src/core/engine-install/manifest.js";

vi.mock("node:readline/promises", () => ({ createInterface: vi.fn() }));

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

describe("verified EULA consent through engine command (controlled release I/O)", () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;
  let manifest: manifests.EngineReleaseManifestV2;
  let signer: ReturnType<typeof generateDevSigningKeyPair>;
  let tty: PropertyDescriptor | undefined;
  let output: string[];
  const actualInstall = installer.installEngineRelease;
  const question = vi.fn();
  const close = vi.fn();
  const fetchRelease = vi.fn();
  const download = vi.fn();
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "engine-consent-command-")); env = { COMPACTION_CONFIG_DIR: dir };
    vi.stubEnv("COMPACTION_CONFIG_DIR", dir); vi.stubEnv("COMPACTION_HOME", "");
    signer = generateDevSigningKeyPair();
    writeStoredCredentials({ schema_version: 1, api_url: "http://127.0.0.1:9", account_id: "fixture", device_id: "fixture",
      device_token: "synthetic-only", device_private_key_pem: signer.privateKeyPem, device_public_key: signer.publicKeySpkiB64u,
      created_at: new Date().toISOString() }, env);
    const body = "// synthetic engine artifact; never executed\n";
    manifest = { schema_version: 2, version: "0.6.8", channel: "stable", platform: "any", arch: "any", artifact_kind: "node-script",
      sha256: createHash("sha256").update(body).digest("hex"), size_bytes: Buffer.byteLength(body),
      cli_min_version: "0.6.0", cli_max_version: "0.8.0", engine_protocol: 1, usage_schema_version: 3,
      meter_version: "optimized-input-v2", eula_version: "1.0" };
    vi.spyOn(manifests, "pinnedRootKeys").mockReturnValue([{ key_id: "synthetic-only", public_key_spki_b64u: signer.publicKeySpkiB64u,
      authorization: { kind: "current-release", schema_version: 2 } }]);
    fetchRelease.mockReset().mockImplementation(async () => ({ manifest: canonicalManifestBytes(manifest).toString(),
      signature: signManifest(manifest, signer.privateKeyPem), artifact_url: "http://127.0.0.1:9/artifact" }));
    download.mockReset().mockImplementation(async (_url: string, target: string) => { writeFileSync(target, body); });
    vi.spyOn(installer, "installEngineRelease").mockImplementation(input => actualInstall({ ...input, ops: { fetchLatestRelease: fetchRelease, download } }));
    question.mockReset().mockResolvedValue("yes"); close.mockReset();
    vi.mocked(createInterface).mockReturnValue({ question, close } as unknown as ReturnType<typeof createInterface>);
    tty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    output = []; vi.spyOn(console, "log").mockImplementation((...args) => { output.push(args.join(" ")); });
  });
  afterEach(() => {
    if (tty) Object.defineProperty(process.stdin, "isTTY", tty); else delete (process.stdin as { isTTY?: boolean }).isTTY;
    process.exitCode = undefined; vi.restoreAllMocks(); vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });
  async function run(): Promise<void> {
    const command = new Command(); registerEngineCommand(command);
    await command.parseAsync(["engine", "install"], { from: "user" });
  }
  it("offers verified known terms, requires explicit yes, and reverifies before download", async () => {
    await run();
    expect(output.join("\n")).toContain("Compaction Engine License Agreement (version 1.0)");
    expect(question).toHaveBeenCalledTimes(1); expect(close).toHaveBeenCalledTimes(1);
    expect(fetchRelease).toHaveBeenCalledTimes(2); expect(download).toHaveBeenCalledTimes(1);
    expect(engineEulaAccepted(env)).toBe(true);
  });
  it.each(["no", "", "EOF"])("decline/EOF %s never records consent or downloads", async answer => {
    if (answer === "EOF") question.mockRejectedValueOnce(new Error("synthetic EOF")); else question.mockResolvedValueOnce(answer);
    await run();
    expect(process.exitCode).toBe(1); expect(readEngineEulaAcceptance(env)).toBeUndefined();
    expect(fetchRelease).toHaveBeenCalledTimes(1); expect(download).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });
  it("does not prompt without a terminal and retains explicit license guidance", async () => {
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });
    await run();
    expect(output.join("\n")).toContain("compaction engine license --accept");
    expect(question).not.toHaveBeenCalled(); expect(download).not.toHaveBeenCalled();
    expect(readEngineEulaAcceptance(env)).toBeUndefined();
  });
  it("never offers unknown terms or treats a direct helper record as presentable consent", async () => {
    manifest.eula_version = "2.0"; recordEngineEulaAcceptance(env, new Date(), "2.0");
    const record = readEngineEulaAcceptance(env);
    await run();
    expect(output.join("\n")).toContain("signed engine release requires EULA 2.0");
    expect(output.join("\n")).toContain("can present only EULA 1.0");
    expect(output.join("\n")).toContain("Update and activate a CLI");
    expect(output.join("\n")).toContain("compaction engine license");
    expect(question).not.toHaveBeenCalled(); expect(download).not.toHaveBeenCalled();
    expect(readEngineEulaAcceptance(env)).toEqual(record);
  });
  it("does not reuse consent when a retry requires a different signed version", async () => {
    question.mockImplementationOnce(async () => { manifest.eula_version = "2.0"; return "yes"; });
    await run();
    expect(fetchRelease).toHaveBeenCalledTimes(2); expect(download).not.toHaveBeenCalled();
    expect(engineEulaAccepted(env, "1.0")).toBe(true); expect(engineEulaAccepted(env, "2.0")).toBe(false);
    expect(output.join("\n")).toContain("signed engine release requires EULA 2.0");
  });
  it("does not present unverified EULA metadata as a consent requirement", async () => {
    manifest.eula_version = "2.0";
    fetchRelease.mockResolvedValueOnce({ manifest: canonicalManifestBytes(manifest).toString(), signature: "invalid", artifact_url: "http://127.0.0.1:9/artifact" });
    await run();
    expect(question).not.toHaveBeenCalled(); expect(download).not.toHaveBeenCalled();
    expect(output.join("\n")).not.toContain("requires EULA 2.0");
    expect(readEngineEulaAcceptance(env)).toBeUndefined();
  });
});
