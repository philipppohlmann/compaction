import { afterEach, describe, expect, it, vi } from "vitest";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { convergeOfficialNpmGlobalInvocation, shouldAttemptNpmGlobalAdoption } from "../../src/core/update/npm-global-adoption.js";
import { classifyOfficialNpmGlobalEntry } from "../../src/core/update/npm-global-ownership.js";
import { currentReleaseCompatibility } from "../../src/core/update/compatibility.js";
import { addConnectedWorkflows, writeOptimizationMode, writeProductMode, writeUpdatePreferences } from "../../src/core/onboarding-preferences.js";
import { bootstrapManaged } from "../../src/core/update/bootstrap.js";
import { defaultManagedRoot, inventoryRelease, loadManagedInstallation } from "../../src/core/update/ownership.js";
import { stageLatestUpdate } from "../../src/core/update/worker.js";
import { tryActivate } from "../../src/core/update/activation.js";
import { sessionFile } from "../../src/core/update/sessions.js";
import { identifyProcess, hasUntrackedToolProcesses, hasUntrackedToolProcessesForLauncher } from "../../src/core/update/process-identity.js";
import { discoverVersion } from "../../src/core/update/registry.js";
import { stageRegistryPackage } from "../../src/core/update/package-stage.js";
import { selectCandidateEngine } from "../../src/core/update/engine-pair.js";
import type { PairDescriptor, SessionLease } from "../../src/core/update/types.js";

vi.mock("../../src/core/update/registry.js", () => ({ discoverVersion: vi.fn(), registryRelease: vi.fn((release) => release) }));
vi.mock("../../src/core/update/package-stage.js", () => ({ stageRegistryPackage: vi.fn() }));
vi.mock("../../src/core/update/engine-pair.js", () => ({ selectCandidateEngine: vi.fn() }));
vi.mock("../../src/core/update/process-identity.js", async original => ({
  ...await original<typeof import("../../src/core/update/process-identity.js")>(),
  hasUntrackedToolProcesses: vi.fn(() => false),
  hasUntrackedToolProcessesForLauncher: vi.fn(() => false)
}));

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.clearAllMocks(); });

function official(version = "0.6.10") {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "compaction-npm-owner-"))); roots.push(root);
  const prefix = path.join(root, "prefix");
  const packageRoot = path.join(prefix, "lib/node_modules/@compaction/cli");
  const entry = path.join(packageRoot, "dist/cli/index.js");
  const launcher = path.join(prefix, "bin/compaction");
  mkdirSync(path.dirname(entry), { recursive: true }); mkdirSync(path.dirname(launcher), { recursive: true });
  writeFileSync(entry, "#!/usr/bin/env node\n");
  writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ name: "@compaction/cli", version, type: "module",
    bin: { compaction: "dist/cli/index.js" }, compactionRelease: currentReleaseCompatibility(version) }));
  symlinkSync(path.relative(path.dirname(launcher), entry), launcher);
  return { root, prefix, packageRoot, entry, launcher };
}

function replaceWithOfficialNpm(f: ReturnType<typeof official>, version: string): void {
  writeFileSync(path.join(f.packageRoot, "package.json"), JSON.stringify({ name: "@compaction/cli", version, type: "module",
    bin: { compaction: "dist/cli/index.js" }, compactionRelease: currentReleaseCompatibility(version) }));
  writeFileSync(f.entry, "#!/usr/bin/env node\n");
  try { unlinkSync(f.launcher); } catch { /* fixture launcher may already be absent */ }
  symlinkSync(path.relative(path.dirname(f.launcher), f.entry), f.launcher);
}

function managedCli(f: ReturnType<typeof official>, version: string): PairDescriptor["cli"] {
  const installRoot = path.join(f.root, "config", "managed", "releases", version);
  const packageRoot = path.join(installRoot, "node_modules/@compaction/cli");
  mkdirSync(path.join(packageRoot, "dist/cli"), { recursive: true });
  cpSync(path.resolve("dist/core"), path.join(packageRoot, "dist/core"), { recursive: true });
  const compatibility = currentReleaseCompatibility(version);
  writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ name: "@compaction/cli", version, type: "module", compactionRelease: compatibility }));
  writeFileSync(path.join(packageRoot, "dist/cli/index.js"), `console.log(${JSON.stringify(version)});`);
  return { root: packageRoot, installRoot, version, integrity: "sha512-controlled-lifecycle-fixture",
    files: inventoryRelease(installRoot), compatibility, source: "npm-registry", provenance: "verified" };
}

function protectedUserFiles(f: ReturnType<typeof official>, env: NodeJS.ProcessEnv): string[] {
  writeOptimizationMode("cache-plus-context", env); writeProductMode("full", env);
  addConnectedWorkflows(["claude-code", "codex"], env); writeUpdatePreferences({ autoUpdates: true, channel: "stable" }, env);
  const files = [
    path.join(env.COMPACTION_CONFIG_DIR!, "preferences.json"),
    path.join(env.COMPACTION_CONFIG_DIR!, "credentials.json"),
    path.join(env.COMPACTION_CONFIG_DIR!, "authorizations.json"),
    path.join(env.COMPACTION_CONFIG_DIR!, "config.json"),
    path.join(f.root, ".claude/settings.json"),
    path.join(f.root, ".codex/hooks.json"),
    path.join(f.root, ".cursor/hooks.json")
  ];
  for (const [index, file] of files.slice(1).entries()) {
    mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, `foreign-config-${index}\n`);
  }
  return files;
}

describe("official npm-global ownership", () => {
  it("accepts only the canonical package entry and exact launcher target", () => {
    const f = official();
    expect(classifyOfficialNpmGlobalEntry(f.entry)).toMatchObject({ kind: "official-npm-global", prefix: f.prefix,
      launcherPath: f.launcher, packageRoot: f.packageRoot, entryPath: f.entry, version: "0.6.10" });
    unlinkSync(f.launcher); symlinkSync(path.join(f.root, "foreign"), f.launcher);
    expect(classifyOfficialNpmGlobalEntry(f.entry)).toMatchObject({ kind: "unsupported" });
  });

  it.each([
    "checkout/src/cli/index.ts",
    "cache/_npx/fixture/node_modules/@compaction/cli/dist/cli/index.js",
    "Cellar/compaction/0.6.10/libexec/lib/node_modules/@compaction/cli/dist/cli/index.js",
    "arbitrary/lib/node_modules/@compaction/cli/dist/cli/index.js",
    "custom/node_modules/@compaction/cli/dist/cli/index.js"
  ])("rejects unsupported owner layout %s", (relative) => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "compaction-foreign-owner-"))); roots.push(root);
    const entry = path.join(root, relative); mkdirSync(path.dirname(entry), { recursive: true }); writeFileSync(entry, "foreign");
    expect(classifyOfficialNpmGlobalEntry(entry)).toMatchObject({ kind: "unsupported" });
  });

  it("rejects foreign release metadata", () => {
    const f = official();
    writeFileSync(path.join(f.packageRoot, "package.json"), JSON.stringify({ name: "@compaction/cli", version: "0.6.10",
      bin: { compaction: "dist/cli/index.js", other: "dist/other.js" }, compactionRelease: currentReleaseCompatibility("0.6.10") }));
    expect(classifyOfficialNpmGlobalEntry(f.entry)).toMatchObject({ kind: "unsupported" });
  });
});

describe("npm-global startup convergence", () => {
  it("adopts, updates safely, then reclaims repeated npm replacements for ordinary and managed-shim invocations", async () => {
    const f = official("0.6.9");
    const env = { HOME: f.root, COMPACTION_HOME: path.join(f.root, "config"), COMPACTION_CONFIG_DIR: path.join(f.root, "config"),
      COMPACTION_SHIM_DIR: path.join(f.root, "shims"), COMPACTION_AUTO_UPDATE: "1", CI: "" };
    const protectedFiles = protectedUserFiles(f, env); const before = protectedFiles.map(file => readFileSync(file));
    vi.mocked(stageRegistryPackage).mockImplementation(async (_root, release) => managedCli(f, (release as { version: string }).version));
    vi.mocked(selectCandidateEngine).mockResolvedValue({ engine: { mode: "basic" }, reason: "no-account" });
    let latest = "0.6.10";
    vi.mocked(discoverVersion).mockImplementation(async (_channel, exactVersion) => ({ version: exactVersion ?? latest }));
    vi.mocked(hasUntrackedToolProcessesForLauncher).mockReturnValue(false);
    vi.mocked(hasUntrackedToolProcesses).mockReturnValue(false);

    const execute = vi.fn(() => ({ code: 0, signal: null })); const notice = vi.fn();
    const adopted = await convergeOfficialNpmGlobalInvocation(f.entry, ["status"], env, { execute, notice });
    expect(adopted).toEqual({ handled: true, code: 0, adopted: true }); expect(notice).not.toHaveBeenCalled();
    const managedRoot = defaultManagedRoot(env);
    expect(loadManagedInstallation(managedRoot).state.current.cli.version).toBe("0.6.9");
    expect(execute).toHaveBeenCalledOnce();

    expect(await stageLatestUpdate(managedRoot, "stable", env, true)).toMatchObject({ status: "staged", version: "0.6.10" });
    const staged = loadManagedInstallation(managedRoot).state;
    expect(staged.current.cli.version).toBe("0.6.9"); expect(staged.staged?.cli.version).toBe("0.6.10");
    const lease: SessionLease = { schema: 1, id: randomUUID(), pair: staged.current, owners: [identifyProcess()] };
    mkdirSync(path.dirname(sessionFile(managedRoot, lease.id)), { recursive: true });
    writeFileSync(sessionFile(managedRoot, lease.id), JSON.stringify(lease) + "\n");
    const barrier = vi.fn(async () => ({ ok: true }));
    expect(await tryActivate(managedRoot, { gatewayBarrier: barrier, env })).toMatchObject({ status: "deferred", reason: "active-sessions" });
    expect(barrier).not.toHaveBeenCalled();
    unlinkSync(sessionFile(managedRoot, lease.id));
    expect(await tryActivate(managedRoot, { gatewayBarrier: barrier, env })).toMatchObject({ status: "active" });
    expect(loadManagedInstallation(managedRoot).state.current.cli.version).toBe("0.6.10");

    latest = "0.6.11";
    expect(await stageLatestUpdate(managedRoot, "stable", env, true)).toMatchObject({ status: "staged", version: "0.6.11" });
    const selectedBeforeReplacement = loadManagedInstallation(managedRoot).state;
    expect(selectedBeforeReplacement.previous?.cli.version).toBe("0.6.9");
    expect(selectedBeforeReplacement.staged?.cli.version).toBe("0.6.11");
    for (let repeat = 0; repeat < 2; repeat++) {
      replaceWithOfficialNpm(f, "0.6.10");
      expect(await convergeOfficialNpmGlobalInvocation(f.entry, ["status"], env, { execute, notice })).toEqual({ handled: true, code: 0, adopted: true });
      expect(loadManagedInstallation(managedRoot).state).toEqual(selectedBeforeReplacement);
    }
    replaceWithOfficialNpm(f, "0.6.10");
    expect(await convergeOfficialNpmGlobalInvocation(f.entry, ["--managed-session-shim", "fixture"],
      { ...env, COMPACTION_SESSION_PIN: "existing-managed-session" }, { execute, notice })).toEqual({ handled: true, code: 0, adopted: true });
    expect(loadManagedInstallation(managedRoot).state).toEqual(selectedBeforeReplacement);
    expect(execute).toHaveBeenCalledTimes(4);
    protectedFiles.forEach((file, index) => expect(readFileSync(file)).toEqual(before[index]));
  });

  it("reclaims a newer exact npm replacement as a staged safe update", async () => {
    const f = official("0.6.9"); const env = { HOME: f.root, COMPACTION_CONFIG_DIR: path.join(f.root, "config"), CI: "" };
    vi.mocked(stageRegistryPackage).mockImplementation(async (_root, release) => managedCli(f, (release as { version: string }).version));
    vi.mocked(selectCandidateEngine).mockResolvedValue({ engine: { mode: "basic" }, reason: "no-account" });
    vi.mocked(discoverVersion).mockImplementation(async (_channel, exactVersion) => ({ version: exactVersion ?? "0.6.10" }));
    vi.mocked(hasUntrackedToolProcessesForLauncher).mockReturnValue(false);
    const execute = vi.fn(() => ({ code: 0, signal: null }));
    expect(await convergeOfficialNpmGlobalInvocation(f.entry, ["status"], env, { execute })).toMatchObject({ handled: true });
    replaceWithOfficialNpm(f, "0.6.10");
    expect(await convergeOfficialNpmGlobalInvocation(f.entry, ["status"], env, { execute })).toMatchObject({ handled: true });
    const state = loadManagedInstallation(defaultManagedRoot(env)).state;
    expect(state.current.cli.version).toBe("0.6.9"); expect(state.staged?.cli.version).toBe("0.6.10");
    expect(state.stagedIntent).toBe("explicit");
  });

  it("leaves ambiguous and foreign post-adoption replacements untouched", async () => {
    const f = official("0.6.9"); const env = { HOME: f.root, COMPACTION_CONFIG_DIR: path.join(f.root, "config"), CI: "" };
    vi.mocked(stageRegistryPackage).mockResolvedValue(managedCli(f, "0.6.9"));
    vi.mocked(selectCandidateEngine).mockResolvedValue({ engine: { mode: "basic" }, reason: "no-account" });
    vi.mocked(hasUntrackedToolProcessesForLauncher).mockReturnValue(false);
    const execute = vi.fn(() => ({ code: 0, signal: null }));
    expect(await convergeOfficialNpmGlobalInvocation(f.entry, ["status"], env, { execute })).toMatchObject({ handled: true });
    const stateFile = path.join(defaultManagedRoot(env), "state.json"); const before = readFileSync(stateFile);
    replaceWithOfficialNpm(f, "0.6.9");
    writeFileSync(path.join(f.packageRoot, "package.json"), JSON.stringify({ name: "foreign", version: "0.6.9" }));
    const ambiguousLink = readFileSync(stateFile);
    expect(await convergeOfficialNpmGlobalInvocation(f.entry, ["status"], env, { notice: vi.fn(), execute })).toEqual({ handled: false });
    expect(readFileSync(stateFile)).toEqual(ambiguousLink);
    writeFileSync(path.join(f.packageRoot, "package.json"), JSON.stringify({ name: "@compaction/cli", version: "0.6.9", type: "module",
      bin: { compaction: "dist/cli/index.js" }, compactionRelease: currentReleaseCompatibility("0.6.9") }));
    unlinkSync(f.launcher); symlinkSync(path.join(f.root, "foreign-entry.js"), f.launcher); writeFileSync(path.join(f.root, "foreign-entry.js"), "foreign");
    expect(await convergeOfficialNpmGlobalInvocation(f.entry, ["status"], env, { notice: vi.fn(), execute })).toEqual({ handled: false });
    expect(readFileSync(stateFile)).toEqual(before);
  });

  it("adopts before dispatch and executes update exactly once through the verified launcher", async () => {
    const f = official(); const bootstrap = vi.fn(async () => ({ launcherPath: f.launcher, version: "0.6.10", staged: false }));
    const execute = vi.fn(() => ({ code: 17, signal: null }));
    const env = { HOME: f.root, COMPACTION_CONFIG_DIR: path.join(f.root, "config") };
    const result = await convergeOfficialNpmGlobalInvocation(f.entry, ["update"], env, {
      bootstrap, execute, managedLauncher: () => f.launcher
    });
    expect(bootstrap).toHaveBeenCalledWith(expect.objectContaining({ prefix: f.prefix, exactVersion: "0.6.10",
      adoptSelectedNpmPrefix: true, automaticUpdates: true, channel: "stable" }));
    expect(execute).toHaveBeenCalledOnce(); expect(execute).toHaveBeenCalledWith(f.launcher, ["update"], env);
    expect(result).toEqual({ handled: true, code: 17, adopted: true });
  });

  it("continues through the real verified receipt and warns when post-claim integration migration fails", async () => {
    const f = official("0.6.9"); const env = { HOME: f.root, COMPACTION_CONFIG_DIR: path.join(f.root, "config") };
    vi.mocked(stageRegistryPackage).mockResolvedValue(managedCli(f, "0.6.9"));
    vi.mocked(selectCandidateEngine).mockResolvedValue({ engine: { mode: "basic" }, reason: "no-account" });
    const execute = vi.fn(() => ({ code: 0, signal: null })); const notice = vi.fn();
    const result = await convergeOfficialNpmGlobalInvocation(f.entry, ["status"], env, {
      bootstrap: (options) => bootstrapManaged(options, { migrate: async () => { throw new Error("controlled migration failure"); } }),
      execute, notice
    });
    expect(execute).toHaveBeenCalledOnce(); expect(result).toEqual({ handled: true, code: 0, adopted: false });
    expect(loadManagedInstallation(defaultManagedRoot(env)).receipt.launcherPath).toBe(f.launcher);
    expect(notice).toHaveBeenCalledWith("Automatic updates are enabled, but setup is incomplete: Tool integration migration did not finish (controlled migration failure). Run `compaction init` to verify and repair setup.");
  });

  it("preserves preview and an explicit automatic-update opt-out", async () => {
    const f = official(); const config = path.join(f.root, "config"); const env = { HOME: f.root, COMPACTION_CONFIG_DIR: config };
    writeUpdatePreferences({ channel: "preview", autoUpdates: false }, env);
    const bootstrap = vi.fn(async () => ({ launcherPath: f.launcher, version: "0.6.10", staged: false }));
    await convergeOfficialNpmGlobalInvocation(f.entry, ["status"], env, { bootstrap,
      managedLauncher: () => f.launcher, execute: () => ({ code: 0, signal: null }) });
    expect(bootstrap).toHaveBeenCalledWith(expect.objectContaining({ channel: "preview", automaticUpdates: false }));
  });

  it("does not recover a managed session shim without an existing managed receipt", async () => {
    const f = official(); const bootstrap = vi.fn(); const execute = vi.fn();
    const env = { HOME: f.root, COMPACTION_CONFIG_DIR: path.join(f.root, "config"), COMPACTION_SESSION_PIN: "fixture" };
    expect(await convergeOfficialNpmGlobalInvocation(f.entry, ["--managed-session-shim", "fixture"], env,
      { bootstrap, execute })).toEqual({ handled: false });
    expect(bootstrap).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
  });

  it("fails a managed session shim closed when its npm replacement is ambiguous", async () => {
    const f = official(); const env = { HOME: f.root, COMPACTION_CONFIG_DIR: path.join(f.root, "config") };
    mkdirSync(path.join(defaultManagedRoot(env), "releases"), { recursive: true });
    writeFileSync(path.join(defaultManagedRoot(env), "install.json"), "{}\n");
    writeFileSync(path.join(f.packageRoot, "package.json"), JSON.stringify({ name: "foreign", version: "0.6.10" }));
    const bootstrap = vi.fn(); const execute = vi.fn();
    expect(await convergeOfficialNpmGlobalInvocation(f.entry, ["--managed-session-shim", "fixture"], env,
      { bootstrap, execute })).toEqual({ handled: true, code: 125, adopted: false });
    expect(bootstrap).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
  });

  it("leaves the npm CLI usable with one safe TTY notice when adoption fails before a receipt", async () => {
    const f = official(); const notice = vi.fn(); const execute = vi.fn();
    const result = await convergeOfficialNpmGlobalInvocation(f.entry, ["status"], { HOME: f.root }, {
      bootstrap: vi.fn(async () => { throw new Error("Legacy integration sessions may still be active"); }),
      managedLauncher: () => undefined, notice, execute
    });
    expect(result).toEqual({ handled: false }); expect(execute).not.toHaveBeenCalled(); expect(notice).toHaveBeenCalledOnce();
    const copy = notice.mock.calls[0][0];
    expect(copy).toBe("Automatic updates could not be enabled. Continuing with this npm installation. Close active Compaction sessions and retry.");
    expect(copy).not.toMatch(/managed adoption|prefix|pair|bootstrap/i);
  });

  it.each([
    { args: ["--help"], env: {} }, { args: ["--version"], env: {} }, { args: ["hooks", "line", "codex"], env: {} },
    { args: ["statusline"], env: {} }, { args: ["precall"], env: {} }, { args: ["capture", "claude-code", "--from-hook"], env: {} },
    { args: ["capture", "codex", "--from-shim", "/tmp/x"], env: {} }, { args: ["--managed-session-shim"], env: {} },
    { args: ["status"], env: { CI: "1" } }, { args: ["status"], env: { COMPACTION_PACKAGE_SMOKE: "1" } },
    { args: ["status"], env: { COMPACTION_UPDATE_WORKER: "1" } }, { args: ["status"], env: { COMPACTION_ENGINE_IPC: "1" } },
    { args: ["status"], env: { COMPACTION_SESSION_PIN: "fixture" } }
  ])("does not adopt inspection or machine invocation $args", ({ args, env }) => {
    expect(shouldAttemptNpmGlobalAdoption(args, env)).toBe(false);
  });

  it("does not call bootstrap for a foreign entry", async () => {
    const bootstrap = vi.fn();
    expect(await convergeOfficialNpmGlobalInvocation("/tmp/source/src/cli/index.ts", ["update"], {}, { bootstrap })).toEqual({ handled: false });
    expect(bootstrap).not.toHaveBeenCalled();
  });

  it("reports an exact safe reason only for an ambiguous canonical npm-global candidate", async () => {
    const f = official(); const notice = vi.fn(); const bootstrap = vi.fn();
    writeFileSync(path.join(f.packageRoot, "package.json"), JSON.stringify({ name: "foreign", version: "0.6.10",
      bin: { compaction: "dist/cli/index.js" }, compactionRelease: currentReleaseCompatibility("0.6.10") }));
    expect(await convergeOfficialNpmGlobalInvocation(f.entry, ["status"], {}, { notice, bootstrap })).toEqual({ handled: false });
    expect(bootstrap).not.toHaveBeenCalled();
    expect(notice).toHaveBeenCalledWith("Automatic updates were not enabled: npm-global package identity or release metadata does not match. Reinstall @compaction/cli globally with npm, then retry.");
  });

  it.each([
    "checkout/src/cli/index.ts",
    "cache/_npx/fixture/node_modules/@compaction/cli/dist/cli/index.js",
    "Cellar/compaction/0.6.10/libexec/lib/node_modules/@compaction/cli/dist/cli/index.js",
    "custom/node_modules/@compaction/cli/dist/cli/index.js"
  ])("stays silent for noncanonical installation %s", async (relative) => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "compaction-silent-owner-"))); roots.push(root);
    const entry = path.join(root, relative); mkdirSync(path.dirname(entry), { recursive: true }); writeFileSync(entry, "foreign");
    const notice = vi.fn(); const bootstrap = vi.fn();
    expect(await convergeOfficialNpmGlobalInvocation(entry, ["status"], {}, { notice, bootstrap })).toEqual({ handled: false });
    expect(notice).not.toHaveBeenCalled(); expect(bootstrap).not.toHaveBeenCalled();
  });
});
