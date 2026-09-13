import { execFile } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { chmod, cp, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { assertEmptyUnclaimedGatewayRegistry, assertOwnedDirectory, inventoryRelease, loadManagedInstallation } from "./ownership.js";
import { compareReleaseVersions } from "./compatibility.js";
import { discoverVersion, downloadPackage, PACKAGE_NAME, REGISTRY, registryRelease, releaseCompatibility, verifyIntegrity, type RegistryRelease } from "./registry.js";
import type { PairDescriptor } from "./types.js";

const run = promisify(execFile);
const MAX_PACKAGE_BYTES = 64 * 1024 * 1024;

/** Invoke npm itself with this Node runtime; never adopt npm_execpath/pnpm/yarn or a PATH wrapper. */
export function resolveNpmCli(searchPath = process.env.PATH ?? ""): string {
  const candidates = [join(dirname(process.execPath), "npm"), ...searchPath.split(":").filter(Boolean).map(directory => join(directory, "npm"))];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const actual = realpathSync(candidate);
    try {
      const pkg = JSON.parse(readFileSync(join(dirname(actual), "..", "package.json"), "utf8"));
      if (pkg.name === "npm" && pkg.bin?.npm === "bin/npm-cli.js" && actual.endsWith("/bin/npm-cli.js")) return actual;
    } catch { /* Unknown executable is not npm ownership evidence. */ }
    throw new Error("npm executable ownership cannot be verified.");
  }
  throw new Error("npm is required for managed package staging.");
}

export function isolatedPackageEnvironment(directory: string): NodeJS.ProcessEnv {
  return {
    PATH: `${dirname(process.execPath)}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    HOME: join(directory, "home"), TMPDIR: join(directory, "tmp"),
    XDG_CACHE_HOME: join(directory, "cache"), CI: "1", NO_COLOR: "1",
    NPM_CONFIG_USERCONFIG: join(directory, "npmrc"), NPM_CONFIG_GLOBALCONFIG: join(directory, "global-npmrc"),
    NPM_CONFIG_REGISTRY: REGISTRY, NPM_CONFIG_CACHE: join(directory, "cache", "npm"),
    NPM_CONFIG_IGNORE_SCRIPTS: "true", NPM_CONFIG_AUDIT: "false", NPM_CONFIG_FUND: "false",
    NPM_CONFIG_UPDATE_NOTIFIER: "false", NPM_CONFIG_FETCH_RETRIES: "0", NPM_CONFIG_FETCH_TIMEOUT: "20000"
  };
}

async function prepareEnvironment(directory: string): Promise<NodeJS.ProcessEnv> {
  for (const child of ["home", "tmp", "cache"]) await mkdir(join(directory, child), { recursive: true, mode: 0o700 });
  await writeFile(join(directory, "npmrc"), "", { mode: 0o600 });
  await writeFile(join(directory, "global-npmrc"), "", { mode: 0o600 });
  return isolatedPackageEnvironment(directory);
}

async function npm(args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  try {
    return (await run(process.execPath, [resolveNpmCli(), ...args], { cwd, env, timeout: 180_000, maxBuffer: 2 * 1024 * 1024 })).stdout;
  } catch {
    throw new Error(`npm ${args[0] === "audit" ? "signature/provenance verification" : "package installation"} failed; the active release was not changed.`);
  }
}

/** npm's public audit output must confirm the sole installed root, not just its dependencies. */
export function assertRootAuditOutput(output: string, requireProvenance: boolean): void {
  if (!/^audited 1 package in /m.test(output) || !/^1 package has a verified registry signature\s*$/m.test(output) ||
      (requireProvenance && !/^1 package has a verified attestation\s*$/m.test(output))) {
    throw new Error("npm did not confirm verification of the exact package root.");
  }
}

export async function auditInstalledRegistryRoot(packageRoot: string, release: RegistryRelease, directory: string, env: NodeJS.ProcessEnv): Promise<void> {
  const checkMetadata = async () => {
    const current = registryRelease(await discoverVersion("stable", release.version));
    if (JSON.stringify(current) !== JSON.stringify(release)) throw new Error("Registry verification metadata changed during staging.");
  };
  await checkMetadata();
  const auditRoot = join(directory, "root-audit");
  const copied = join(auditRoot, "node_modules", "@compaction", "cli");
  await mkdir(dirname(copied), { recursive: true, mode: 0o700 });
  // A byte-identical copy of the installed root, without its hoisted neighbours, yields an audit
  // with exactly one installed registry package. Missing dependencies are not represented as
  // installed or verified. Nested dependencies would make the count differ and fail closed.
  await cp(packageRoot, copied, { recursive: true, dereference: false });
  if (JSON.stringify(inventoryRelease(packageRoot)) !== JSON.stringify(inventoryRelease(copied))) throw new Error("Root verification copy changed.");
  await writeFile(join(auditRoot, "package.json"), JSON.stringify({ private: true, dependencies: { [PACKAGE_NAME]: release.version } }));
  assertRootAuditOutput(await npm(["audit", "signatures"], auditRoot, env), release.hasProvenance);
  await checkMetadata();
}

async function inspectArchive(artifact: string, expectedVersion: string): Promise<Record<string, unknown>> {
  const { stdout } = await run("/usr/bin/tar", ["-xOzf", artifact, "package/package.json"], {
    env: { PATH: "/usr/bin:/bin" }, timeout: 10_000, maxBuffer: 1024 * 1024 });
  const pkg = JSON.parse(stdout) as Record<string, unknown>;
  if (pkg.name !== PACKAGE_NAME || pkg.version !== expectedVersion) throw new Error("Artifact package identity/version mismatch.");
  releaseCompatibility(pkg.compactionRelease, expectedVersion);
  const bin = pkg.bin as Record<string, unknown> | undefined;
  if (!bin || bin.compaction !== "dist/cli/index.js") throw new Error("Unsupported CLI entrypoint.");
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    const entries = pkg[field];
    if (entries === undefined) continue;
    if (typeof entries !== "object" || entries === null || Array.isArray(entries)) throw new Error("Invalid package dependencies.");
    for (const [name, spec] of Object.entries(entries)) {
      if (!/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name) || typeof spec !== "string" ||
          !/^[\d\s~^<>=*|.xX+-]+$/.test(spec)) throw new Error("Update packages must use public registry dependency versions.");
    }
  }
  return pkg;
}

async function syncTree(directory: string): Promise<void> {
  const files = await inventoryRelease(directory);
  for (const relative of Object.keys(files)) {
    const file = await open(join(directory, relative), "r");
    try { await file.sync(); } finally { await file.close(); }
  }
  const handle = await open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function smokeInstalledPackage(packageRoot: string, version: string, isolation: string): Promise<void> {
  const env = await prepareEnvironment(isolation);
  env.COMPACTION_CONFIG_DIR = join(isolation, "config");
  env.COMPACTION_HOME = join(isolation, "compaction");
  env.COMPACTION_AUTO_UPDATE = "0";
  const entry = join(packageRoot, "dist", "cli", "index.js");
  const { stdout } = await run(process.execPath, [entry, "--version"], { cwd: isolation, env, timeout: 30_000, maxBuffer: 1024 * 1024 });
  if (stdout.trim() !== version) throw new Error("Installed package version smoke failed.");
  const help = await run(process.execPath, [entry, "--help"], { cwd: isolation, env, timeout: 30_000, maxBuffer: 1024 * 1024 });
  if (!help.stdout.includes("compaction") || !help.stdout.includes("update")) throw new Error("Installed package help smoke failed.");
  const updateHelp = await run(process.execPath, [entry, "update", "--help"], { cwd: isolation, env, timeout: 30_000, maxBuffer: 1024 * 1024 });
  if (!["--check", "--channel", "--rollback", "--auto"].every(flag => updateHelp.stdout.includes(flag))) throw new Error("Installed update command smoke failed.");
  const files = await inventoryRelease(packageRoot);
  for (const required of ["dist/cli/commands/update.js", "dist/core/update/bootstrap.js", "dist/core/update/scheduler.js", "dist/core/update/worker.js"]) {
    if (!files[required]) throw new Error("Installed updater module smoke failed.");
  }
  if (Object.keys(files).some((file) => file.startsWith("dist/engine/"))) throw new Error("Public package contains private engine implementation.");
}

interface StageInput {
  managedRoot: string;
  version: string;
  bytes: Buffer;
  integrity: string;
  registry?: RegistryRelease;
}

async function stage(input: StageInput): Promise<PairDescriptor["cli"]> {
  if (input.bytes.length > MAX_PACKAGE_BYTES || compareReleaseVersions(input.version, input.version) === undefined) throw new Error("Invalid CLI artifact.");
  await mkdir(resolve(input.managedRoot), { recursive: true, mode: 0o700 });
  if ((await lstat(input.managedRoot)).isSymbolicLink()) throw new Error("Managed storage must not be a symbolic link.");
  const managedRoot = await realpath(input.managedRoot);
  assertOwnedDirectory(managedRoot);
  const names = await readdir(managedRoot);
  if (names.includes("install.json")) loadManagedInstallation(managedRoot, false);
  else {
    if (names.some(name => !["transactions", "releases", "gateways"].includes(name))) throw new Error("Unknown files in unclaimed managed storage.");
    assertEmptyUnclaimedGatewayRegistry(managedRoot);
  }
  for (const child of ["transactions", "releases"]) {
    if (names.includes(child) && (!(await lstat(join(managedRoot, child))).isDirectory() || (await lstat(join(managedRoot, child))).isSymbolicLink())) {
      throw new Error("Managed storage contains an unsafe directory.");
    }
  }
  await mkdir(join(managedRoot, "transactions"), { recursive: true, mode: 0o700 });
  await mkdir(join(managedRoot, "releases"), { recursive: true, mode: 0o700 });
  for (const child of ["transactions", "releases"]) assertOwnedDirectory(join(managedRoot, child));
  const transaction = await mkdtemp(join(managedRoot, "transactions", "package-"));
  const working = join(transaction, "installation");
  const artifact = join(transaction, "cli.tgz");
  try {
    const env = await prepareEnvironment(transaction);
    const npmVersion = (await run(process.execPath, [resolveNpmCli(), "--version"], { cwd: transaction, env, timeout: 10_000 })).stdout.trim();
    if ((compareReleaseVersions(npmVersion, "8.15.0") ?? -1) < 0) throw new Error("Managed updates require npm 8.15 or newer for signature verification.");
    await writeFile(artifact, input.bytes, { mode: 0o600 });
    const pkg = await inspectArchive(artifact, input.version);
    await mkdir(working, { mode: 0o700 });
    await writeFile(join(working, "package.json"), JSON.stringify({ private: true, name: "compaction-managed-release", version: "0.0.0" }), { mode: 0o600 });
    // Install the exact bounded, integrity-verified bytes. No second root artifact download.
    await npm(["install", "--ignore-scripts", "--no-audit", "--no-fund", "--save-exact", "--workspaces=false", artifact], working, env);
    const lock = JSON.parse(await readFile(join(working, "package-lock.json"), "utf8")) as { packages?: Record<string, { resolved?: string; integrity?: string; version?: string }> };
    const rootEntry = lock.packages?.["node_modules/@compaction/cli"];
    if (!rootEntry || rootEntry.version !== input.version) throw new Error("Installed lockfile version mismatch.");
    if (!rootEntry.integrity) throw new Error("Installed package has no integrity record.");
    verifyIntegrity(input.bytes, rootEntry.integrity);
    if (input.registry) verifyIntegrity(input.bytes, input.registry.integrity);
    let registryDependencies = 0;
    for (const [name, entry] of Object.entries(lock.packages ?? {})) {
      if (name === "" || name === "node_modules/@compaction/cli") continue;
      if (!entry.resolved || new URL(entry.resolved).origin !== REGISTRY || !entry.integrity) throw new Error("Dependency was not installed from the public registry.");
      registryDependencies++;
    }
    if (input.registry) {
      // npm's signature audit selects registry edges from the installed parent's dependency spec.
      // Name the exact published version after local installation, so that audit verifies the root
      // as well as its dependencies. The lock retains the actual local tarball integrity evidence.
      await writeFile(join(working, "package.json"), JSON.stringify({ private: true, name: "compaction-managed-release",
        version: "0.0.0", dependencies: { [PACKAGE_NAME]: input.version } }), { mode: 0o600 });
    }
    if (input.registry || registryDependencies > 0) await npm(["audit", "signatures", "--json", "--workspaces=false"], working, env);
    const packageRoot = join(working, "node_modules", "@compaction", "cli");
    if (await realpath(packageRoot) !== packageRoot) throw new Error("CLI package must not be a link outside its installation.");
    const installed = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as Record<string, unknown>;
    if (installed.name !== PACKAGE_NAME || installed.version !== input.version || JSON.stringify(installed.compactionRelease) !== JSON.stringify(pkg.compactionRelease)) throw new Error("Installed package metadata mismatch.");
    const compatibility = releaseCompatibility(installed.compactionRelease, input.version);
    if (input.registry && JSON.stringify(compatibility) !== JSON.stringify(input.registry.compatibility)) throw new Error("Discovered package compatibility changed.");
    const verifiedFiles = inventoryRelease(working);
    if (input.registry) await auditInstalledRegistryRoot(packageRoot, input.registry, transaction, env);
    await smokeInstalledPackage(packageRoot, input.version, join(transaction, "smoke"));
    const files = await inventoryRelease(working);
    if (JSON.stringify(files) !== JSON.stringify(verifiedFiles)) throw new Error("Installed release changed during verification or smoke.");
    await syncTree(working);
    const releaseRoot = join(managedRoot, "releases", `${input.version}-${randomUUID()}`);
    await rename(working, releaseRoot);
    await chmod(releaseRoot, 0o700);
    const releases = await open(dirname(releaseRoot), "r");
    try { await releases.sync(); } finally { await releases.close(); }
    return {
      root: join(releaseRoot, "node_modules", "@compaction", "cli"), installRoot: releaseRoot,
      version: input.version, integrity: input.integrity, compatibility, files,
      source: input.registry ? "npm-registry" : "local-artifact",
      provenance: input.registry ? (input.registry.hasProvenance ? "verified" : "not-present") : "local-artifact"
    };
  } finally {
    await rm(transaction, { recursive: true, force: true });
  }
}

export async function stageRegistryPackage(managedRoot: string, release: RegistryRelease): Promise<PairDescriptor["cli"]> {
  return stage({ managedRoot, version: release.version, bytes: await downloadPackage(release), integrity: release.integrity, registry: release });
}

export async function stageLocalArtifact(input: { managedRoot: string; artifactPath: string; expectedSha256: string; expectedVersion: string }): Promise<PairDescriptor["cli"]> {
  if (!/^[a-f0-9]{64}$/.test(input.expectedSha256)) throw new Error("An exact SHA-256 is required for a local release artifact.");
  const bytes = await readFile(input.artifactPath);
  if (createHash("sha256").update(bytes).digest("hex") !== input.expectedSha256) throw new Error("Local release SHA-256 mismatch.");
  return stage({ managedRoot: input.managedRoot, version: input.expectedVersion, bytes, integrity: `sha256-${Buffer.from(input.expectedSha256, "hex").toString("base64")}` });
}
