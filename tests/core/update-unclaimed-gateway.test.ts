import { afterEach, describe, expect, it, vi } from "vitest";
import fs, { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertEmptyUnclaimedGatewayRegistry, bootstrapManagedInstall, inventoryRelease, loadManagedInstallation } from "../../src/core/update/ownership.js";
import { currentReleaseCompatibility } from "../../src/core/update/compatibility.js";
import { createPair } from "../../src/core/update/pair.js";
import { stageLocalArtifact } from "../../src/core/update/package-stage.js";
import { withManagedLock } from "../../src/core/update/state.js";

// Stop at the first subprocess boundary: these tests prove pre-npm validation, not npm delivery.
const subprocess = vi.hoisted(() => vi.fn((...args: unknown[]) => {
  (args.at(-1) as (error: Error) => void)(new Error("controlled npm boundary"));
}));
vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(), execFile: subprocess
}));

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks(); syncBuiltinESMExports(); subprocess.mockClear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), "compaction-unclaimed-gateway-"))); roots.push(home);
  const root = path.join(home, "managed"); mkdirSync(root, { mode: 0o700 });
  const directory = path.join(root, "gateways");
  const artifactPath = path.join(home, "controlled.tgz");
  const bytes = Buffer.from("Not an archive: execution must stop before archive inspection.");
  writeFileSync(artifactPath, bytes);
  const stage = () => stageLocalArtifact({ managedRoot: root, artifactPath,
    expectedSha256: createHash("sha256").update(bytes).digest("hex"), expectedVersion: "0.6.9" });
  const launcher = path.join(home, "bin", "compaction");
  const pair = () => {
    const installRoot = path.join(root, "releases", "fixture");
    const packageRoot = path.join(installRoot, "node_modules", "@compaction", "cli");
    mkdirSync(path.join(packageRoot, "dist", "core", "update"), { recursive: true, mode: 0o700 });
    mkdirSync(path.join(packageRoot, "dist", "cli"), { recursive: true, mode: 0o700 });
    const compatibility = currentReleaseCompatibility("0.6.9");
    writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ name: "@compaction/cli", version: "0.6.9", compactionRelease: compatibility }));
    writeFileSync(path.join(packageRoot, "dist/cli/index.js"), "// Controlled bootstrap inventory fixture.\n");
    writeFileSync(path.join(packageRoot, "dist/core/update/launcher.js"), "export async function launchManaged() { throw new Error('fixture is not executable'); }\n");
    return createPair({ root: packageRoot, installRoot, version: "0.6.9", integrity: "sha256-fixture",
      source: "local-artifact", provenance: "local-artifact", compatibility, files: inventoryRelease(installRoot) }, { mode: "basic" });
  };
  return { root, directory, launcher, stage, pair };
}

describe("empty external Gateway registry during explicit managed adoption", () => {
  it.each(["absent", "empty"])("permits %s registry through pre-npm validation and bootstrap", async (kind) => {
    const f = fixture();
    if (kind === "empty") mkdirSync(f.directory, { mode: 0o700 });
    await expect(f.stage()).rejects.toThrow("controlled npm boundary");
    expect(subprocess).toHaveBeenCalledTimes(1);
    await bootstrapManagedInstall(f.root, f.pair(), { launcherPath: f.launcher });
    expect(existsSync(path.join(f.root, "install.json"))).toBe(true);
    if (kind === "empty") expect(readdirSync(f.directory)).toEqual([]);
  });

  it.each(["nonempty", "file", "symlink", "dangling-symlink", "0755", "0777", "1700", "0000"])("rejects %s registry before npm or claim writes", async (kind) => {
    const f = fixture();
    if (kind === "file") writeFileSync(f.directory, "foreign");
    else if (kind.includes("symlink")) symlinkSync(kind === "symlink" ? f.root : path.join(f.root, "missing"), f.directory);
    else {
      mkdirSync(f.directory, { mode: 0o700 });
      if (kind === "nonempty") writeFileSync(path.join(f.directory, "foreign.json"), "preserve", { mode: 0o600 });
      else chmodSync(f.directory, Number.parseInt(kind, 8));
    }
    try {
      await expect(f.stage()).rejects.toThrow("Unclaimed Gateway registry");
      expect(subprocess).not.toHaveBeenCalled();
      await expect(bootstrapManagedInstall(f.root, f.pair(), { launcherPath: f.launcher })).rejects.toThrow(/Unclaimed Gateway registry|ownership or permissions/);
      for (const name of ["install.json", "state.json", "bootstrap.json", "bootstrap-runtime.json"]) expect(existsSync(path.join(f.root, name))).toBe(false);
      expect(existsSync(f.launcher)).toBe(false);
      if (kind === "nonempty") expect(readFileSync(path.join(f.directory, "foreign.json"), "utf8")).toBe("preserve");
    } finally { if (kind === "0000") chmodSync(f.directory, 0o700); }
  });

  it("rejects a different UID without changing directory ownership", async () => {
    const f = fixture(); mkdirSync(f.directory, { mode: 0o700 });
    const original = fs.lstatSync;
    vi.spyOn(fs, "lstatSync").mockImplementation(((file, ...args) => {
      const stat = original(file, ...args);
      return String(file) === f.directory ? Object.assign(stat, { uid: Number(stat.uid) + 1 }) : stat;
    }) as typeof fs.lstatSync);
    syncBuiltinESMExports();
    await expect(f.stage()).rejects.toThrow("Unclaimed Gateway registry");
    expect(subprocess).not.toHaveBeenCalled();
    await expect(bootstrapManagedInstall(f.root, f.pair(), { launcherPath: f.launcher })).rejects.toThrow(/Unclaimed Gateway registry|ownership or permissions/);
    expect(existsSync(path.join(f.root, "install.json"))).toBe(false);
  });

  it.each(["lstat", "readdir"])("keeps %s errors closed", async (operation) => {
    const f = fixture(); mkdirSync(f.directory, { mode: 0o700 });
    const name = operation === "lstat" ? "lstatSync" : "readdirSync";
    const original = fs[name];
    vi.spyOn(fs, name).mockImplementation(((file: fs.PathLike, ...args: unknown[]) => {
      if (String(file) === f.directory) throw Object.assign(new Error("controlled denial"), { code: "EACCES" });
      return (original as (...values: unknown[]) => unknown)(file, ...args);
    }) as typeof original);
    syncBuiltinESMExports();
    await expect(f.stage()).rejects.toThrow("controlled denial");
    expect(subprocess).not.toHaveBeenCalled();
    await expect(bootstrapManagedInstall(f.root, f.pair(), { launcherPath: f.launcher })).rejects.toThrow("controlled denial");
    expect(existsSync(path.join(f.root, "install.json"))).toBe(false);
  });

  it("does not admit other unknown unclaimed root entries beside an empty registry", async () => {
    const f = fixture(); mkdirSync(f.directory, { mode: 0o700 });
    writeFileSync(path.join(f.root, "foreign"), "preserve");
    await expect(f.stage()).rejects.toThrow("Unknown files in unclaimed managed storage");
    expect(subprocess).not.toHaveBeenCalled();
    expect(readFileSync(path.join(f.root, "foreign"), "utf8")).toBe("preserve");
  });

  it("rechecks after acquiring the bootstrap lock when registration appears after staging validation", async () => {
    const f = fixture(); mkdirSync(f.directory, { mode: 0o700 });
    const pair = f.pair(); assertEmptyUnclaimedGatewayRegistry(f.root);
    let pending: Promise<unknown> | undefined;
    await withManagedLock(f.root, async () => {
      pending = bootstrapManagedInstall(f.root, pair, { launcherPath: f.launcher });
      writeFileSync(path.join(f.directory, "registered.json"), "preserve", { mode: 0o600 });
    });
    await expect(pending).rejects.toThrow("Unclaimed Gateway registry");
    expect(readFileSync(path.join(f.directory, "registered.json"), "utf8")).toBe("preserve");
    for (const name of ["install.json", "state.json", "bootstrap.json", "bootstrap-runtime.json"]) expect(existsSync(path.join(f.root, name))).toBe(false);
    expect(existsSync(f.launcher)).toBe(false);
  });

  it("does not reinterpret or reject a claimed installation's nonempty registry", async () => {
    const f = fixture(); const pair = f.pair();
    await bootstrapManagedInstall(f.root, pair, { launcherPath: f.launcher });
    mkdirSync(f.directory, { mode: 0o700 });
    writeFileSync(path.join(f.directory, "registered.json"), "preserve", { mode: 0o600 });
    const before = readFileSync(path.join(f.root, "install.json"));
    expect(loadManagedInstallation(f.root).state.current.id).toBe(pair.id);
    await expect(f.stage()).rejects.toThrow("controlled npm boundary");
    expect(subprocess).toHaveBeenCalledTimes(1);
    await expect(bootstrapManagedInstall(f.root, pair, { launcherPath: f.launcher })).resolves.toBeDefined();
    expect(readFileSync(path.join(f.root, "install.json"))).toEqual(before);
    expect(readFileSync(path.join(f.directory, "registered.json"), "utf8")).toBe("preserve");
  });

  it.each(["file", "symlink", "dangling-symlink", "wrong-owner", "0770", "0702"])("rejects a claimed %s registry without changing its installation", async (kind) => {
    const f = fixture(); const pair = f.pair();
    await bootstrapManagedInstall(f.root, pair, { launcherPath: f.launcher });
    const before = readFileSync(path.join(f.root, "install.json"));
    if (kind === "file") writeFileSync(f.directory, "preserve");
    else if (kind.includes("symlink")) symlinkSync(kind === "symlink" ? f.root : path.join(f.root, "missing"), f.directory);
    else {
      mkdirSync(f.directory, { mode: 0o700 });
      writeFileSync(path.join(f.directory, "registered.json"), "preserve", { mode: 0o600 });
      if (kind === "wrong-owner") {
        const original = fs.lstatSync;
        vi.spyOn(fs, "lstatSync").mockImplementation(((file, ...args) => {
          const stat = original(file, ...args);
          return String(file) === f.directory ? Object.assign(stat, { uid: Number(stat.uid) + 1 }) : stat;
        }) as typeof fs.lstatSync);
        syncBuiltinESMExports();
      } else chmodSync(f.directory, Number.parseInt(kind, 8));
    }
    expect(() => loadManagedInstallation(f.root)).toThrow("ownership or permissions");
    await expect(bootstrapManagedInstall(f.root, pair, { launcherPath: f.launcher })).rejects.toThrow("ownership or permissions");
    await expect(f.stage()).rejects.toThrow("ownership or permissions");
    expect(subprocess).not.toHaveBeenCalled();
    expect(readFileSync(path.join(f.root, "install.json"))).toEqual(before);
    if (kind === "file") expect(readFileSync(f.directory, "utf8")).toBe("preserve");
    if (["wrong-owner", "0770", "0702"].includes(kind)) expect(readFileSync(path.join(f.directory, "registered.json"), "utf8")).toBe("preserve");
  });
});
