import { createHash } from "node:crypto";
import { existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { atomicWrite, readState, syncDirectory, withManagedLock, writeState } from "./state.js";
import type { InstallationReceipt, ManagedState, PairDescriptor } from "./types.js";
import { parseReleaseCompatibility } from "./compatibility.js";
import { resolveSessionPin, SESSION_PIN_ENV } from "./sessions.js";
import { classifyOfficialNpmGlobalEntry, type OfficialNpmGlobalInstallation } from "./npm-global-ownership.js";

export function defaultManagedRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(env.COMPACTION_HOME || env.COMPACTION_CONFIG_DIR || path.join(env.HOME || homedir(), ".compaction"), "managed");
}

export function sha256(bytes: string | Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }

/** Validate only owned anchors, not OS-managed ancestors such as macOS /var or /tmp aliases. */
export function assertOwnedDirectory(directory: string): void {
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0
    || (process.getuid && stat.uid !== process.getuid())) throw new Error("Managed storage directory ownership or permissions cannot be verified");
}

/** An external Gateway may leave its empty private registry before installation is claimed. */
export function assertEmptyUnclaimedGatewayRegistry(root: string): void {
  const directory = path.join(root, "gateways");
  let stat: ReturnType<typeof lstatSync>;
  try { stat = lstatSync(directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o7777) !== 0o700
    || !process.getuid || stat.uid !== process.getuid() || readdirSync(directory).length !== 0) {
    throw new Error("Unclaimed Gateway registry must be an empty private owned directory");
  }
}

function validateStorage(root: string): void {
  assertOwnedDirectory(root);
  for (const name of ["releases", "transactions", "sessions", "backups", "migrations", "gateways"]) {
    const directory = path.join(root, name);
    if (name === "gateways" ? lstatSync(directory, { throwIfNoEntry: false }) !== undefined : existsSync(directory)) assertOwnedDirectory(directory);
  }
}

export function containedPath(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Includes dependencies; internal npm .bin links are allowed, escaping links are rejected. */
export function inventoryRelease(installRoot: string): Record<string, string> {
  const base = realpathSync(installRoot);
  const inventory: Record<string, string> = {};
  const walk = (directory: string, ancestors: ReadonlySet<string>): void => {
    const physical = realpathSync(directory);
    if (ancestors.has(physical)) throw new Error("Release contains a cyclic directory link");
    const next = new Set([...ancestors, physical]);
    for (const entry of readdirSync(directory).sort()) {
      const file = path.join(directory, entry);
      const target = realpathSync(file);
      if (!containedPath(base, target)) throw new Error("Release path escapes the owned installation");
      const stat = statSync(file);
      if (stat.isDirectory()) walk(file, next);
      else if (stat.isFile()) inventory[path.relative(base, file).split(path.sep).join("/")] = sha256(readFileSync(file));
      else throw new Error("Release contains a nonregular file");
    }
  };
  walk(base, new Set());
  return inventory;
}

/** Static imports execute before launcher admission. Bind their exact installed bytes in the wrapper. */
function bootstrapStaticFiles(pair: PairDescriptor): Record<string, string> {
  const files: Record<string, string> = {};
  const base = realpathSync(pair.cli.installRoot);
  const visit = (file: string): void => {
    const real = realpathSync(file);
    const relative = path.relative(base, real).split(path.sep).join("/");
    if (!containedPath(base, real) || !pair.cli.files[relative]) throw new Error("Bootstrap import escapes verified release inventory");
    if (files[relative]) return;
    files[relative] = pair.cli.files[relative];
    const source = readFileSync(real, "utf8");
    for (const match of source.matchAll(/(?:^|\n)(?:import|export)\s+(?:(?:[^;]*?)\s+from\s+)?["']([^"']+)["']/g)) {
      const specifier = match[1];
      if (specifier.startsWith("node:")) continue;
      // The bootstrap runtime intentionally uses only builtins and relative public modules.
      if (!specifier.startsWith(".")) throw new Error("Bootstrap runtime contains an unsupported package import");
      visit(path.resolve(path.dirname(real), specifier));
    }
  };
  visit(path.join(pair.cli.root, "dist/core/update/launcher.js"));
  return files;
}

export function validatePair(root: string, pair: PairDescriptor, verifyFiles = true): void {
  if (!pair || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(pair.id)) throw new Error("Invalid pair identity");
  const managed = realpathSync(root);
  const releases = path.join(managed, "releases");
  const installRoot = realpathSync(pair.cli.installRoot);
  if (!containedPath(releases, installRoot) || path.dirname(installRoot) !== releases
    || realpathSync(releases) !== releases || lstatSync(pair.cli.installRoot).isSymbolicLink()) {
    throw new Error("CLI release is outside managed storage");
  }
  const packageRoot = realpathSync(pair.cli.root);
  if (packageRoot !== path.join(installRoot, "node_modules", "@compaction", "cli")) throw new Error("Unexpected CLI package root");
  const pkg = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  if (pkg.name !== "@compaction/cli" || pkg.version !== pair.cli.version
    || pair.cli.compatibility?.cliVersion !== pair.cli.version || pair.cli.compatibility.launcherProtocol !== 1
    || pair.cli.compatibility.integrationProtocol !== 1 || !pair.cli.integrity) throw new Error("Invalid managed CLI package identity or protocol");
  if (!parseReleaseCompatibility(pkg.compactionRelease, pkg.version)
    || JSON.stringify(pkg.compactionRelease) !== JSON.stringify(pair.cli.compatibility)) throw new Error("Package release compatibility does not match the pair");
  if (!verifyFiles) return;
  const actual = inventoryRelease(installRoot);
  const keys = Object.keys(actual).sort();
  if (!pair.cli.files || JSON.stringify(keys) !== JSON.stringify(Object.keys(pair.cli.files).sort())
    || keys.some((file) => actual[file] !== pair.cli.files[file])) throw new Error("Managed release integrity changed");
  if (!actual["node_modules/@compaction/cli/dist/cli/index.js"]) throw new Error("Managed CLI entrypoint is missing");
  if (!pair.engine || !["basic", "signed"].includes(pair.engine.mode)) throw new Error("Invalid managed engine selection");
}

export function loadManagedInstallation(root = defaultManagedRoot(), verifyFiles = true): { receipt: InstallationReceipt; state: ManagedState } {
  validateStorage(root);
  const receipt = JSON.parse(readFileSync(path.join(root, "install.json"), "utf8")) as InstallationReceipt;
  assertOwnedDirectory(path.dirname(receipt.launcherPath));
  if (receipt.schema !== 1 || receipt.kind !== "compaction-managed" || receipt.packageName !== "@compaction/cli"
    || receipt.root !== realpathSync(root) || !path.isAbsolute(receipt.launcherPath)
    || lstatSync(receipt.launcherPath).isSymbolicLink()
    || sha256(readFileSync(receipt.launcherPath)) !== receipt.launcherSha256) throw new Error("Managed installation ownership cannot be verified");
  const state = readState(root);
  validatePair(root, state.current, verifyFiles);
  return { receipt, state };
}

export function isManagedInstallation(root = defaultManagedRoot()): boolean {
  try { loadManagedInstallation(root); return true; } catch { return false; }
}

/** A receipt elsewhere on disk never silently adopts a source/npm/npx invocation. */
export function loadExecutingManagedInstallation(env: NodeJS.ProcessEnv = process.env, entry = process.argv[1]): {
  root: string; receipt: InstallationReceipt; state: ManagedState; pair: PairDescriptor;
} | undefined {
  const root = defaultManagedRoot(env);
  let isManagedPath = false;
  try {
    isManagedPath = !!entry && containedPath(path.join(realpathSync(root), "releases"), realpathSync(entry));
  } catch { return undefined; }
  if (!isManagedPath) return undefined;
  try {
    const { receipt, state } = loadManagedInstallation(root, false);
    if (!entry) return undefined;
    const resolved = realpathSync(entry);
    const token = env[SESSION_PIN_ENV];
    const pinned = token ? resolveSessionPin(root, token) : undefined;
    if (token && !pinned) throw new Error("Managed session reference is expired or invalid");
    const pair = pinned ?? [state.current, state.previous, state.staged].find((candidate) => candidate
      && resolved === realpathSync(path.join(candidate.cli.root, "dist/cli/index.js")));
    if (!pair || resolved !== realpathSync(path.join(pair.cli.root, "dist/cli/index.js"))) throw new Error("Managed execution is not a selected compatible CLI");
    return { root, receipt, state, pair };
  } catch { throw new Error("Managed execution ownership or session reference cannot be verified"); }
}

function managedLauncherContents(root: string, launcherPath: string, runtimeUrl: string, manifestPath: string, runtimeManifest: string): string {
  return `#!/usr/bin/env node
// COMPACTION_MANAGED_LAUNCHER_V1
Promise.all([import('node:fs'), import('node:crypto'), import('node:path')]).then(async ([fs, crypto, path]) => {
  for (const directory of ${JSON.stringify([root, path.dirname(launcherPath)])}) {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022) || (process.getuid && stat.uid !== process.getuid())) throw new Error('unsafe managed storage');
  }
  const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  const manifestBytes = fs.readFileSync(${JSON.stringify(manifestPath)});
  if (digest(manifestBytes) !== ${JSON.stringify(sha256(runtimeManifest))}) throw new Error('bootstrap manifest changed');
  const manifest = JSON.parse(manifestBytes);
  const args = process.argv.slice(2);
  const hook = ['hooks', 'statusline', 'capture', 'precall'].includes(args[0]);
  const files = hook || process.env.COMPACTION_SESSION_PIN ? manifest.staticFiles : manifest.files;
  if (files === manifest.files) {
    const found = [];
    const walk = (directory, ancestors) => {
      const real = fs.realpathSync(directory);
      if (ancestors.has(real)) throw new Error('cyclic bootstrap directory');
      const next = new Set([...ancestors, real]);
      for (const name of fs.readdirSync(directory)) {
        const file = path.join(directory, name);
        const physical = fs.realpathSync(file);
        const inside = path.relative(manifest.installRoot, physical);
        if (!inside || inside === '..' || inside.startsWith('..' + path.sep) || path.isAbsolute(inside)) throw new Error('bootstrap path escaped');
        const stat = fs.statSync(file);
        if (stat.isDirectory()) walk(file, next);
        else if (stat.isFile()) found.push(path.relative(manifest.installRoot, file).split(path.sep).join('/'));
        else throw new Error('nonregular bootstrap file');
      }
    };
    walk(manifest.installRoot, new Set());
    if (JSON.stringify(found.sort()) !== JSON.stringify(Object.keys(files).sort())) throw new Error('bootstrap inventory changed');
  }
  for (const [relative, expected] of Object.entries(files)) {
    const file = fs.realpathSync(path.join(manifest.installRoot, relative));
    const inside = path.relative(manifest.installRoot, file);
    if (!inside || inside === '..' || inside.startsWith('..' + path.sep) || path.isAbsolute(inside)
      || digest(fs.readFileSync(file)) !== expected) throw new Error('bootstrap runtime changed');
  }
  const runtime = await import(${JSON.stringify(runtimeUrl)});
  process.exitCode = await runtime.launchManaged(${JSON.stringify(root)}, args);
}).catch(() => { process.stderr.write('compaction: managed launcher integrity could not be verified\\n'); process.exitCode = 125; });
`;
}

/** Reclaim only a previously receipted launcher that an exact official npm reinstall replaced. */
export async function reclaimManagedLauncherAfterNpmReplacement(
  root: string,
  adoption: OfficialNpmGlobalInstallation
): Promise<{ receipt: InstallationReceipt; state: ManagedState }> {
  validateStorage(root); root = realpathSync(root);
  return withManagedLock(root, () => {
    const current = classifyOfficialNpmGlobalEntry(adoption.entryPath);
    if (current.kind !== "official-npm-global" || current.prefix !== adoption.prefix
      || current.launcherPath !== adoption.launcherPath || current.entryPath !== adoption.entryPath
      || current.version !== adoption.version || JSON.stringify(current.compatibility) !== JSON.stringify(adoption.compatibility)) {
      throw new Error("The replacement npm installation could not be verified.");
    }
    const receipt = JSON.parse(readFileSync(path.join(root, "install.json"), "utf8")) as InstallationReceipt;
    const state = readState(root);
    for (const pair of [state.current, state.previous, state.staged]) if (pair) validatePair(root, pair);
    const launcherPath = path.resolve(adoption.launcherPath);
    if (receipt.schema !== 1 || receipt.kind !== "compaction-managed" || receipt.packageName !== "@compaction/cli"
      || receipt.root !== root || receipt.launcherPath !== launcherPath || !/^[a-f0-9]{64}$/.test(receipt.launcherSha256)
      || !receipt.bootstrapInstallRoot) throw new Error("Existing managed ownership metadata could not be verified.");
    assertOwnedDirectory(path.dirname(launcherPath));
    const manifestPath = path.join(root, "bootstrap-runtime.json");
    const runtimeManifest = readFileSync(manifestPath, "utf8");
    const manifest = JSON.parse(runtimeManifest) as { installRoot?: unknown };
    if (typeof manifest.installRoot !== "string" || realpathSync(manifest.installRoot) !== receipt.bootstrapInstallRoot
      || !containedPath(path.join(root, "releases"), receipt.bootstrapInstallRoot)) {
      throw new Error("Existing managed runtime metadata could not be verified.");
    }
    const runtimeUrl = pathToFileURL(path.join(receipt.bootstrapInstallRoot, "node_modules/@compaction/cli/dist/core/update/launcher.js")).href;
    const contents = managedLauncherContents(root, launcherPath, runtimeUrl, manifestPath, runtimeManifest);
    if (sha256(contents) !== receipt.launcherSha256) throw new Error("Existing managed launcher receipt could not be reproduced.");
    const backup = `${launcherPath}.npm-replacement-${randomUUID()}`;
    renameSync(launcherPath, backup);
    try {
      atomicWrite(launcherPath, contents, 0o755);
      const recovered = loadManagedInstallation(root);
      unlinkSync(backup);
      return recovered;
    } catch (error) {
      if (existsSync(launcherPath)) unlinkSync(launcherPath);
      renameSync(backup, launcherPath);
      throw error;
    }
  });
}

export async function bootstrapManagedInstall(root: string, pair: PairDescriptor, options: {
  launcherPath: string;
  /** Runs under the managed lock, after an existing receipt check and before launcher ownership is claimed. */
  beforeLauncherClaim?: () => void;
}): Promise<{ receipt: InstallationReceipt; state: ManagedState }> {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  validateStorage(root);
  root = realpathSync(root);
  return withManagedLock(root, () => {
    if (existsSync(path.join(root, "install.json"))) return loadManagedInstallation(root);
    assertEmptyUnclaimedGatewayRegistry(root);
    validatePair(root, pair);
    const launcherPath = path.resolve(options.launcherPath);
    mkdirSync(path.dirname(launcherPath), { recursive: true, mode: 0o700 });
    assertOwnedDirectory(path.dirname(launcherPath));
    options.beforeLauncherClaim?.();
    const runtimeUrl = pathToFileURL(path.join(pair.cli.root, "dist/core/update/launcher.js")).href;
    const manifestPath = path.join(root, "bootstrap-runtime.json");
    const runtimeManifest = JSON.stringify({ installRoot: realpathSync(pair.cli.installRoot),
      staticFiles: bootstrapStaticFiles(pair), files: pair.cli.files });
    const contents = managedLauncherContents(root, launcherPath, runtimeUrl, manifestPath, runtimeManifest);
    const receipt: InstallationReceipt = { schema: 1, kind: "compaction-managed", packageName: "@compaction/cli", root,
      launcherPath, launcherSha256: sha256(contents), bootstrapInstallRoot: realpathSync(pair.cli.installRoot) };
    const state: ManagedState = { schema: 1, revision: 0, current: pair, rejectedPairIds: [], integrationSchema: 1 };
    const preparedPath = path.join(root, "bootstrap.json");
    let launcherExists = false;
    try { lstatSync(launcherPath); launcherExists = true; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (launcherExists) {
      const prepared = existsSync(preparedPath) ? JSON.parse(readFileSync(preparedPath, "utf8")) : undefined;
      if (!prepared || JSON.stringify(prepared.receipt) !== JSON.stringify(receipt) || prepared.pair !== pair.id
        || lstatSync(launcherPath).isSymbolicLink() || sha256(readFileSync(launcherPath)) !== receipt.launcherSha256) {
        throw new Error("Refusing to overwrite an unknown launcher; select an empty managed prefix");
      }
    }
    atomicWrite(preparedPath, JSON.stringify({ schema: 1, receipt, pair: pair.id }) + "\n");
    atomicWrite(manifestPath, runtimeManifest);
    writeState(root, state, "bootstrap");
    if (!launcherExists) {
      const preparedLauncher = `${launcherPath}.${randomUUID()}.prepared`;
      atomicWrite(preparedLauncher, contents, 0o755);
      try { linkSync(preparedLauncher, launcherPath); syncDirectory(path.dirname(launcherPath)); }
      finally { unlinkSync(preparedLauncher); }
    }
    atomicWrite(path.join(root, "install.json"), JSON.stringify(receipt) + "\n");
    return { receipt, state };
  });
}
