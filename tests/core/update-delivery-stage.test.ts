import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { currentReleaseCompatibility } from "../../src/core/update/compatibility.js";
import { inventoryRelease } from "../../src/core/update/ownership.js";
import { auditInstalledRegistryRoot, isolatedPackageEnvironment, resolveNpmCli, stageLocalArtifact } from "../../src/core/update/package-stage.js";
import * as registry from "../../src/core/update/registry.js";

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function artifact(options: { badHelp?: boolean; badMetadata?: boolean } = {}) {
  const home = mkdtempSync(path.join(tmpdir(), "compaction-package-test-")); roots.push(home);
  const pkg = path.join(home, "package"); mkdirSync(path.join(pkg, "dist/cli"), { recursive: true });
  mkdirSync(path.join(pkg, "dist/cli/commands"), { recursive: true }); mkdirSync(path.join(pkg, "dist/core/update"), { recursive: true });
  for (const module of ["dist/cli/commands/update.js", "dist/core/update/bootstrap.js", "dist/core/update/scheduler.js", "dist/core/update/worker.js"]) writeFileSync(path.join(pkg, module), "// Controlled package presence fixture; command behavior is in the test entrypoint.\n");
  const sentinel = path.join(home, "lifecycle-ran");
  writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "@compaction/cli", version: "0.6.9", type: "module", bin: { compaction: "dist/cli/index.js" },
    compactionRelease: { ...currentReleaseCompatibility("0.6.9"), ...(options.badMetadata ? { engineProtocol: 44 } : {}) },
    scripts: { install: `node -e 'require("node:fs").writeFileSync(${JSON.stringify(sentinel)},"ran")'` } }));
  writeFileSync(path.join(pkg, "dist/cli/index.js"), `console.log(process.argv.includes('--version') ? '0.6.9' : ${JSON.stringify(options.badHelp ? "broken" : "compaction update --check --channel --rollback --auto")});`);
  const artifactPath = path.join(home, "cli.tgz");
  execFileSync("/usr/bin/tar", ["-czf", artifactPath, "-C", home, "package"], { env: { PATH: "/usr/bin:/bin" } });
  const expectedSha256 = createHash("sha256").update(readFileSync(artifactPath)).digest("hex");
  return { home, sentinel, managedRoot: path.join(home, "managed"), artifactPath, expectedSha256, expectedVersion: "0.6.9" };
}
describe("exact local delivery artifacts through real npm and CLI smoke", () => {
  it("stages exact bytes outside active selection, disables lifecycle scripts, and inventories installed dependencies", async () => {
    const fixture = artifact();
    for (const key of ["NPM_TOKEN", "NODE_OPTIONS", "TAR_OPTIONS", "HTTP_PROXY", "npm_execpath"]) vi.stubEnv(key, "fixture-must-not-execute");
    expect(resolveNpmCli()).toMatch(/npm\/bin\/npm-cli\.js$/);
    const cli = await stageLocalArtifact(fixture);
    expect(cli.version).toBe("0.6.9"); expect(cli.source).toBe("local-artifact");
    expect(cli.provenance).toBe("local-artifact"); expect(cli.files).toEqual(inventoryRelease(cli.installRoot));
    expect(existsSync(fixture.sentinel)).toBe(false);
    expect(existsSync(path.join(fixture.managedRoot, "state.json"))).toBe(false);
    expect(readdirSync(path.join(fixture.managedRoot, "transactions"))).toEqual([]);
  }, 30_000);
  it("rejects mismatched SHA before creating any managed files", async () => {
    const fixture = artifact();
    await expect(stageLocalArtifact({ ...fixture, expectedSha256: "0".repeat(64) })).rejects.toThrow("SHA-256 mismatch");
    expect(existsSync(fixture.managedRoot)).toBe(false);
  });
  it.each([{ badHelp: true }, { badMetadata: true }])("rejects a broken candidate without promoting a release: %j", async (options) => {
    const fixture = artifact(options);
    await expect(stageLocalArtifact(fixture)).rejects.toThrow(/smoke|metadata/);
    expect(readdirSync(path.join(fixture.managedRoot, "releases"))).toEqual([]);
    expect(existsSync(path.join(fixture.managedRoot, "state.json"))).toBe(false);
  }, 30_000);
  it.each(["root-link", "releases-link", "writable-root", "writable-releases"])("refuses unsafe owned storage before npm: %s", async (kind) => {
    const fixture = artifact(); const outside = path.join(fixture.home, "outside"); mkdirSync(outside);
    if (kind === "root-link") symlinkSync(outside, fixture.managedRoot);
    else {
      mkdirSync(fixture.managedRoot);
      if (kind === "releases-link") symlinkSync(outside, path.join(fixture.managedRoot, "releases"));
      if (kind === "writable-root") chmodSync(fixture.managedRoot, 0o777);
      if (kind === "writable-releases") { mkdirSync(path.join(fixture.managedRoot, "releases")); chmodSync(path.join(fixture.managedRoot, "releases"), 0o777); }
    }
    await expect(stageLocalArtifact(fixture)).rejects.toThrow(/symbolic link|unsafe directory|ownership|permissions/);
    expect(readdirSync(outside)).toEqual([]);
  });
  it("concurrent stages use independent immutable release and transaction paths", async () => {
    const fixture = artifact();
    const [a, b] = await Promise.all([stageLocalArtifact(fixture), stageLocalArtifact(fixture)]);
    expect(a.installRoot).not.toBe(b.installRoot);
    expect(inventoryRelease(a.installRoot)).toEqual(a.files);
    expect(inventoryRelease(b.installRoot)).toEqual(b.files);
    expect(readdirSync(path.join(fixture.managedRoot, "transactions"))).toEqual([]);
  }, 30_000);
});

// Explicit public-network opt-in. This tests npm's signature-selection mechanism, not full
// staging: published 0.6.7 has no Update v1 compatibility metadata or provenance attestation.
it.skipIf(process.env.COMPACTION_PUBLIC_ROOT_AUDIT_ACCEPTANCE !== "1")(
  "audits the sole real published 0.6.7 root, not hoisted dependencies, and refuses metadata drift",
  async () => {
    const home = mkdtempSync(path.join(tmpdir(), "compaction-public-root-audit-")); roots.push(home);
    for (const child of ["home", "tmp", "cache", "installation"]) mkdirSync(path.join(home, child));
    for (const config of ["npmrc", "global-npmrc"]) writeFileSync(path.join(home, config), "");
    const env = isolatedPackageEnvironment(home);
    const discover = registry.discoverVersion;
    const published = await discover("stable", "0.6.7");
    expect(published.compactionRelease).toBeUndefined();
    const dist = published.dist as { signatures?: unknown[]; attestations?: unknown };
    expect(dist.signatures?.length).toBeGreaterThan(0);
    expect(dist.attestations).toBeUndefined();
    // Only this compatibility tuple is synthetic. All immutable registry identity, bytes,
    // integrity and signature information remains exactly what public npm supplied.
    const fixtureMetadata = { ...published, compactionRelease: currentReleaseCompatibility("0.6.7") };
    const release = registry.registryRelease(fixtureMetadata);
    const bytes = await registry.downloadPackage(release);
    const artifact = path.join(home, "cli.tgz"); writeFileSync(artifact, bytes);
    const working = path.join(home, "installation");
    writeFileSync(path.join(working, "package.json"), JSON.stringify({ private: true }));
    execFileSync(process.execPath, [resolveNpmCli(), "install", "--ignore-scripts", "--no-audit", "--no-fund", "--save-exact", "--workspaces=false", artifact],
      { cwd: working, env, timeout: 180_000, stdio: "pipe" });
    const lock = JSON.parse(readFileSync(path.join(working, "package-lock.json"), "utf8"));
    const installed = lock.packages["node_modules/@compaction/cli"];
    expect(installed.version).toBe(release.version);
    expect(installed.integrity).toBe(release.integrity);
    registry.verifyIntegrity(bytes, installed.integrity);
    const before = inventoryRelease(working);
    const packageRoot = path.join(working, "node_modules/@compaction/cli");
    // Fetch real immutable metadata at both helper boundaries; insert only the labelled tuple.
    const discovery = vi.spyOn(registry, "discoverVersion").mockImplementation(async (channel, version) => ({
      ...await discover(channel, version), compactionRelease: fixtureMetadata.compactionRelease
    }));
    // This calls the production argv and fails if --workspaces=false filters out the sole root.
    await expect(auditInstalledRegistryRoot(packageRoot, release, home, env)).resolves.toBeUndefined();
    expect(discovery).toHaveBeenCalledTimes(2);
    expect(inventoryRelease(working)).toEqual(before);
    expect(release.hasProvenance).toBe(false);
    const tampered = Buffer.from(bytes); tampered[0] ^= 1;
    expect(() => registry.verifyIntegrity(tampered, release.integrity)).toThrow("integrity mismatch");
    for (const changed of [
      { ...fixtureMetadata, dist: { ...published.dist as object, integrity: `sha512-${Buffer.alloc(64).toString("base64")}` } },
      { ...fixtureMetadata, dist: { ...published.dist as object, tarball: "https://registry.npmjs.org/@compaction/cli/-/changed.tgz" } }
    ]) {
      discovery.mockResolvedValueOnce(changed);
      await expect(auditInstalledRegistryRoot(packageRoot, release, path.join(home, "drift"), env)).rejects.toThrow("metadata changed");
      expect(existsSync(path.join(home, "drift"))).toBe(false);
      expect(inventoryRelease(working)).toEqual(before);
    }
  }, 240_000
);
