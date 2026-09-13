import { afterEach, describe, expect, it, vi } from "vitest";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { bootstrapManaged, isDirectBootstrapInvocation } from "../../src/core/update/bootstrap.js";
import { currentReleaseCompatibility } from "../../src/core/update/compatibility.js";
import { inventoryRelease, loadManagedInstallation } from "../../src/core/update/ownership.js";
import { stageLocalArtifact, stageRegistryPackage } from "../../src/core/update/package-stage.js";
import { readUpdatePreferences } from "../../src/core/onboarding-preferences.js";
import { hasUntrackedToolProcessesForLauncher } from "../../src/core/update/process-identity.js";
import type { PairDescriptor } from "../../src/core/update/types.js";
vi.mock("../../src/core/update/package-stage.js", () => ({ stageLocalArtifact: vi.fn(), stageRegistryPackage: vi.fn() }));
vi.mock("../../src/core/update/process-identity.js", async original => ({ ...await original<typeof import("../../src/core/update/process-identity.js")>(), hasUntrackedToolProcessesForLauncher: vi.fn(() => false) }));
const homes: string[] = [];
afterEach(() => { vi.clearAllMocks(); for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
function fixture() {
  const home = mkdtempSync(path.join(tmpdir(), "compaction-bootstrap-test-")); homes.push(home);
  const env = { HOME: home, COMPACTION_CONFIG_DIR: path.join(home, "config"), COMPACTION_SHIM_DIR: path.join(home, "shims") };
  const root = path.join(env.COMPACTION_CONFIG_DIR, "managed"); const prefix = path.join(home, "prefix");
  const localArtifact = { artifactPath: path.join(home, "controlled.tgz"), expectedSha256: "a".repeat(64), expectedVersion: "0.6.8" };
  function cli(version = "0.6.8"): PairDescriptor["cli"] {
    const installRoot = path.join(root, "releases", version), packageRoot = path.join(installRoot, "node_modules/@compaction/cli");
    mkdirSync(path.join(packageRoot, "dist/cli"), { recursive: true });
    cpSync(path.resolve("dist/core"), path.join(packageRoot, "dist/core"), { recursive: true });
    const compatibility = currentReleaseCompatibility(version);
    writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ name: "@compaction/cli", version, type: "module", compactionRelease: compatibility }));
    writeFileSync(path.join(packageRoot, "dist/cli/index.js"), `console.log(${JSON.stringify(version)});`);
    return { root: packageRoot, installRoot, version, integrity: `sha256-${Buffer.from(localArtifact.expectedSha256, "hex").toString("base64")}`,
      files: inventoryRelease(installRoot), compatibility, source: "local-artifact", provenance: "local-artifact" };
  }
  vi.mocked(stageLocalArtifact).mockResolvedValue(cli());
  return { home, env, root, prefix, localArtifact, cli };
}
describe("managed bootstrap coordinator (controlled acquisition, real files and locks)", () => {
  it("recognizes the direct entrypoint through a canonical path alias", () => {
    const home = mkdtempSync(path.join(tmpdir(), "compaction-bootstrap-entry-")); homes.push(home);
    const target = path.join(home, "bootstrap.js"), alias = path.join(home, "bootstrap-alias.js");
    writeFileSync(target, "// controlled entrypoint fixture\n"); symlinkSync(target, alias);
    expect(isDirectBootstrapInvocation(pathToFileURL(target).href, alias)).toBe(true);
    expect(isDirectBootstrapInvocation(pathToFileURL(target).href, path.join(home, "missing.js"))).toBe(false);
  });
  it("creates stable owned selection and persists exact-artifact opt-out without private acquisition", async () => {
    const f = fixture(); const result = await bootstrapManaged(f);
    expect(result.staged).toBe(false); expect(result.launcherPath).toBe(path.join(f.prefix, "bin/compaction"));
    expect(loadManagedInstallation(f.root).state.current.cli.version).toBe("0.6.8");
    expect(readUpdatePreferences(f.env).autoUpdates).toBe(false);
    expect(stageRegistryPackage).not.toHaveBeenCalled();
  });
  it("resumes an exact prepared bootstrap after wrapper publication without downloading again", async () => {
    const f = fixture(); const first = await bootstrapManaged(f); const bytes = readFileSync(first.launcherPath);
    unlinkSync(path.join(f.root, "install.json")); vi.mocked(stageLocalArtifact).mockClear();
    const resumed = await bootstrapManaged(f);
    expect(resumed.version).toBe("0.6.8"); expect(readFileSync(first.launcherPath)).toEqual(bytes);
    expect(stageLocalArtifact).not.toHaveBeenCalled(); expect(loadManagedInstallation(f.root).state.current.cli.version).toBe("0.6.8");
  });
  it("does not silently substitute a differently requested exact artifact while resuming", async () => {
    const f = fixture(); await bootstrapManaged(f); unlinkSync(path.join(f.root, "install.json"));
    await expect(bootstrapManaged({ ...f, exactVersion: "0.6.9" })).rejects.toThrow("different release");
  });
  it("reruns stage a coherent candidate while leaving the original launcher/current pair intact", async () => {
    const f = fixture(); const first = await bootstrapManaged(f); const bytes = readFileSync(first.launcherPath);
    vi.mocked(stageLocalArtifact).mockResolvedValue(f.cli("0.6.9"));
    expect((await bootstrapManaged({ ...f, localArtifact: { ...f.localArtifact, expectedVersion: "0.6.9" } })).staged).toBe(true);
    const { state } = loadManagedInstallation(f.root);
    expect(state.current.cli.version).toBe("0.6.8"); expect(state.staged?.cli.version).toBe("0.6.9");
    expect(state.stagedIntent).toBe("explicit");
    expect(readUpdatePreferences(f.env).autoUpdates).toBe(false);
    expect(readFileSync(first.launcherPath)).toEqual(bytes);
  });
  it("refuses unknown launchers before acquisition", async () => {
    const f = fixture(); mkdirSync(path.join(f.prefix, "bin"), { recursive: true }); writeFileSync(path.join(f.prefix, "bin/compaction"), "foreign");
    await expect(bootstrapManaged(f)).rejects.toThrow("unknown launcher"); expect(stageLocalArtifact).not.toHaveBeenCalled();
  });
  it("defers explicit recognized legacy adoption while old integration sessions may remain", async () => {
    const f = fixture(); const pkg = path.join(f.prefix, "lib/node_modules/@compaction/cli");
    mkdirSync(path.join(pkg, "dist/cli"), { recursive: true }); mkdirSync(path.join(f.prefix, "bin"), { recursive: true });
    writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "@compaction/cli", bin: { compaction: "dist/cli/index.js" } }));
    writeFileSync(path.join(pkg, "dist/cli/index.js"), "// Controlled legacy launcher fixture");
    symlinkSync(path.join(pkg, "dist/cli/index.js"), path.join(f.prefix, "bin/compaction"));
    vi.mocked(hasUntrackedToolProcessesForLauncher).mockReturnValueOnce(true);
    await expect(bootstrapManaged({ ...f, adoptSelectedNpmPrefix: true })).rejects.toThrow("sessions may still be active");
    expect(stageLocalArtifact).not.toHaveBeenCalled(); expect(existsSync(path.join(f.root, "install.json"))).toBe(false);
  });
});
