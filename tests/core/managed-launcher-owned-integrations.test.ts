import { afterEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { currentReleaseCompatibility } from "../../src/core/update/compatibility.js";
import { bootstrapManaged } from "../../src/core/update/bootstrap.js";
import { defaultManagedRoot, inventoryRelease, loadManagedInstallation, owningManagedLauncher } from "../../src/core/update/ownership.js";
import { untrackedToolProcessInventoryForLauncher } from "../../src/core/update/process-identity.js";
import { discoverVersion } from "../../src/core/update/registry.js";
import { stageRegistryPackage } from "../../src/core/update/package-stage.js";
import { selectCandidateEngine } from "../../src/core/update/engine-pair.js";
import { pinOwnedNativeHookCommands } from "../../src/core/update/native-hook-pinning.js";
import { installStatusLine, installShapingHook, installStopHook, uninstallShapingHook, uninstallStatusLine, uninstallStopHook } from "../../src/core/claude-code-hooks.js";
import { installSubscriptionHooks, uninstallSubscriptionHooks } from "../../src/core/subscription-hooks-install.js";
import type { PairDescriptor } from "../../src/core/update/types.js";

// The registry, package download and engine selection are the network edges; process scanning is
// machine-global. Everything else (adoption, the real managed launcher, the hook config files, the shell
// a tool runs a hook command in) is the shipped code path.
vi.mock("../../src/core/update/registry.js", () => ({ discoverVersion: vi.fn(), registryRelease: vi.fn((release) => release) }));
vi.mock("../../src/core/update/package-stage.js", () => ({ stageRegistryPackage: vi.fn() }));
vi.mock("../../src/core/update/engine-pair.js", () => ({ selectCandidateEngine: vi.fn() }));
vi.mock("../../src/core/update/process-identity.js", async original => ({
  ...await original<typeof import("../../src/core/update/process-identity.js")>(),
  hasUntrackedToolProcesses: vi.fn(() => false),
  untrackedToolProcessInventoryForLauncher: vi.fn(() => ({ state: "none" }))
}));

const run = promisify(execFile);
const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.clearAllMocks(); });

const VERSION = "0.6.12";

/** A temp HOME with an official npm-global install AND an older stale `compaction` earlier on PATH. */
function machine() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "compaction-owned-integrations-"))); roots.push(root);
  const prefix = path.join(root, "prefix");
  const packageRoot = path.join(prefix, "lib/node_modules/@compaction/cli");
  const entry = path.join(packageRoot, "dist/cli/index.js");
  const launcher = path.join(prefix, "bin/compaction");
  mkdirSync(path.dirname(entry), { recursive: true }); mkdirSync(path.dirname(launcher), { recursive: true });
  writeFileSync(entry, "#!/usr/bin/env node\n");
  writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ name: "@compaction/cli", version: VERSION, type: "module",
    bin: { compaction: "dist/cli/index.js" }, compactionRelease: currentReleaseCompatibility(VERSION) }));
  symlinkSync(path.relative(path.dirname(launcher), entry), launcher);

  const marks = path.join(root, "marks"); mkdirSync(marks);
  const staleBin = path.join(root, "old-global/bin"); mkdirSync(staleBin, { recursive: true });
  writeFileSync(path.join(staleBin, "compaction"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${marks}/stale'\n`);
  chmodSync(path.join(staleBin, "compaction"), 0o755);

  const config = path.join(root, "config");
  const env: NodeJS.ProcessEnv = { HOME: root, COMPACTION_HOME: config, COMPACTION_CONFIG_DIR: config,
    COMPACTION_SHIM_DIR: path.join(root, "shims"), COMPACTION_AUTO_UPDATE: "0", CI: "", NO_COLOR: "1",
    PATH: `${staleBin}:${path.dirname(launcher)}:${path.dirname(process.execPath)}:/usr/bin:/bin` };
  return { root, prefix, launcher, marks, env };
}

/** The managed release a stubbed registry stages: the real shipped core, with a CLI entry that records its argv. */
function managedCli(m: ReturnType<typeof machine>, version: string): PairDescriptor["cli"] {
  const installRoot = path.join(m.root, "config", "managed", "releases", version);
  const packageRoot = path.join(installRoot, "node_modules/@compaction/cli");
  mkdirSync(path.join(packageRoot, "dist/cli"), { recursive: true });
  cpSync(path.resolve("dist/core"), path.join(packageRoot, "dist/core"), { recursive: true });
  const compatibility = currentReleaseCompatibility(version);
  writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ name: "@compaction/cli", version, type: "module", compactionRelease: compatibility }));
  writeFileSync(path.join(packageRoot, "dist/cli/index.js"),
    `import fs from "node:fs";\nfs.appendFileSync(${JSON.stringify(path.join(m.marks, "managed"))}, process.argv.slice(2).join(" ") + "\\n");\n`);
  return { root: packageRoot, installRoot, version, integrity: "sha512-owned-integrations-fixture",
    files: inventoryRelease(installRoot), compatibility, source: "npm-registry", provenance: "verified" };
}

/** Run a configured hook command the way Claude Code and Codex do: a shell, the user's PATH, no stdin. */
async function runAsTool(command: string, env: NodeJS.ProcessEnv): Promise<void> {
  await run("/bin/sh", ["-c", `${command} </dev/null`], { env, timeout: 30_000 });
}

function read(file: string): string { return existsSync(file) ? readFileSync(file, "utf8") : ""; }
function json(file: string): any { return JSON.parse(readFileSync(file, "utf8")); }

/** The pre-adoption world: integrations written by an npm-global CLI, in the bare PATH-resolved form. */
async function connectBeforeAdoption(m: ReturnType<typeof machine>): Promise<{ claude: string; codex: string }> {
  const claude = path.join(m.root, ".claude/settings.json");
  let settings = installStopHook({ hooks: { Stop: [{ hooks: [{ type: "command", command: "echo user-stop" }] }] } }, undefined).settings;
  settings = installShapingHook(settings, undefined).settings;
  settings = installStatusLine(settings, undefined).settings;
  mkdirSync(path.dirname(claude), { recursive: true });
  writeFileSync(claude, `${JSON.stringify(settings, null, 2)}\n`);
  const codex = path.join(m.root, ".codex/hooks.json");
  mkdirSync(path.dirname(codex), { recursive: true });
  writeFileSync(codex, `${JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "echo user-codex" }] }] } }, null, 2)}\n`);
  expect((await installSubscriptionHooks("codex", { home: m.root, launcher: undefined })).status).toBe("installed");
  return { claude, codex };
}

function stubRegistry(m: ReturnType<typeof machine>): void {
  vi.mocked(stageRegistryPackage).mockImplementation(async (_root, release) => managedCli(m, (release as { version: string }).version));
  vi.mocked(selectCandidateEngine).mockResolvedValue({ engine: { mode: "basic" }, reason: "no-account" });
  vi.mocked(discoverVersion).mockImplementation(async (_channel, exactVersion) => ({ version: exactVersion ?? VERSION }));
}

describe("managed adoption pins owned integrations to the managed launcher", () => {
  it("a new tool session's hooks, status line and Codex hooks run the managed launcher, not a stale global earlier on PATH", async () => {
    const m = machine(); stubRegistry(m);
    const files = await connectBeforeAdoption(m);
    const bareStop = json(files.claude).hooks.Stop[1].hooks[0].command;
    expect(bareStop).toBe("compaction capture claude-code --from-hook");

    // The defect, reproduced: the bare form is served by whichever `compaction` PATH finds first.
    await runAsTool(bareStop, m.env);
    expect(read(path.join(m.marks, "stale"))).toBe("capture claude-code --from-hook\n");
    rmSync(path.join(m.marks, "stale"));

    // First adoption refused while a tool session holds the old launcher: nothing is touched.
    vi.mocked(untrackedToolProcessInventoryForLauncher).mockReturnValue({ state: "live" });
    const settingsBefore = read(files.claude), codexBefore = read(files.codex);
    await expect(bootstrapManaged({ env: m.env, prefix: m.prefix, exactVersion: VERSION, adoptSelectedNpmPrefix: true }))
      .rejects.toThrow(/session connected to Compaction is still running/);
    expect(read(files.claude)).toBe(settingsBefore); expect(read(files.codex)).toBe(codexBefore);

    // Sessions closed: adoption completes and pins Claude Code entries to the launcher in the receipt.
    vi.mocked(untrackedToolProcessInventoryForLauncher).mockReturnValue({ state: "none" });
    const adopted = await bootstrapManaged({ env: m.env, prefix: m.prefix, exactVersion: VERSION, adoptSelectedNpmPrefix: true });
    const { receipt } = loadManagedInstallation(defaultManagedRoot(m.env));
    expect(adopted.launcherPath).toBe(m.launcher); expect(receipt.launcherPath).toBe(m.launcher);

    // Adoption is silent, so it never rewrites Codex hooks (Codex would hold a changed hook until reviewed).
    expect(read(files.codex)).toBe(codexBefore);

    // An explicit update pins Codex too, and reports the Codex rewrite so its one-time review can be announced.
    expect(pinOwnedNativeHookCommands(receipt.launcherPath, { codex: true }, m.env))
      .toEqual([{ tool: "codex", file: files.codex, rewritten: 2 }]);

    // A NEW tool session reads the configs from disk: every owned command names the managed launcher.
    const settings = json(files.claude), codex = json(files.codex);
    const commands = {
      stop: settings.hooks.Stop[1].hooks[0].command,
      shaping: settings.hooks.UserPromptSubmit[0].hooks[0].command,
      statusLine: settings.statusLine.command,
      codexShaping: codex.hooks.UserPromptSubmit[0].hooks[0].command,
      codexLine: codex.hooks.Stop[1].hooks[0].command
    };
    expect(commands).toEqual({
      stop: `${m.launcher} capture claude-code --from-hook`,
      shaping: `${m.launcher} capture claude-code --shape-prompt-hook`,
      statusLine: `${m.launcher} statusline`,
      codexShaping: `${m.launcher} hooks shape codex`,
      codexLine: `${m.launcher} hooks line codex`
    });
    expect(settings.hooks.Stop[0].hooks[0].command).toBe("echo user-stop");
    expect(codex.hooks.Stop[0].hooks[0].command).toBe("echo user-codex");

    for (const command of Object.values(commands)) await runAsTool(command, m.env);
    expect(read(path.join(m.marks, "stale"))).toBe("");
    expect(read(path.join(m.marks, "managed")).trim().split("\n")).toEqual([
      "capture claude-code --from-hook", "capture claude-code --shape-prompt-hook", "statusline", "hooks shape codex", "hooks line codex"
    ]);

    // A connect run BY the managed runtime writes the launcher form directly; any other entry writes bare.
    const managedEntry = path.join(loadManagedInstallation(defaultManagedRoot(m.env)).state.current.cli.root, "dist/cli/index.js");
    expect(owningManagedLauncher(m.env, managedEntry)).toBe(m.launcher);
    expect(owningManagedLauncher(m.env, path.resolve("dist/cli/index.js"))).toBeUndefined();

    // Idempotent: a later explicit update re-pins nothing.
    expect(pinOwnedNativeHookCommands(receipt.launcherPath, { codex: true }, m.env)).toEqual([]);

    // Disconnect, run in this machine's environment, recognizes the receipt launcher as Compaction's.
    vi.stubEnv("HOME", m.root); vi.stubEnv("COMPACTION_HOME", m.env.COMPACTION_HOME!); vi.stubEnv("COMPACTION_CONFIG_DIR", m.env.COMPACTION_CONFIG_DIR!);
    // Disconnect removes ONLY Compaction's pinned entries.
    let claude = json(files.claude);
    for (const strip of [uninstallStopHook, uninstallShapingHook]) claude = strip(claude).settings;
    claude = uninstallStatusLine(claude).settings;
    expect(claude).toEqual({ hooks: { Stop: [{ hooks: [{ type: "command", command: "echo user-stop" }] }] } });
    expect((await uninstallSubscriptionHooks("codex", { home: m.root })).removedCount).toBe(2);
    expect(json(files.codex)).toEqual({ hooks: { Stop: [{ hooks: [{ type: "command", command: "echo user-codex" }] }] } });
  }, 90_000);

  it("pinning repairs an already-adopted install, writes through a symlinked config, and never touches unparseable files", async () => {
    const m = machine();
    const launcher = m.launcher;
    const dotfiles = path.join(m.root, "dotfiles/claude-settings.json");
    mkdirSync(path.dirname(dotfiles), { recursive: true });
    writeFileSync(dotfiles, `${JSON.stringify(installStatusLine({}, undefined).settings)}\n`);
    mkdirSync(path.join(m.root, ".claude"));
    symlinkSync(dotfiles, path.join(m.root, ".claude/settings.json"));
    mkdirSync(path.join(m.root, ".codex")); writeFileSync(path.join(m.root, ".codex/hooks.json"), "{ // hand-written\n}");

    expect(pinOwnedNativeHookCommands(launcher, { codex: true }, m.env))
      .toEqual([{ tool: "claude-code", file: path.join(m.root, ".claude/settings.json"), rewritten: 1 }]);
    expect(json(dotfiles).statusLine.command).toBe(`${launcher} statusline`);
    expect(lstatSync(path.join(m.root, ".claude/settings.json")).isSymbolicLink()).toBe(true);
    expect(read(path.join(m.root, ".codex/hooks.json"))).toBe("{ // hand-written\n}");
    expect(pinOwnedNativeHookCommands("compaction", { codex: true }, m.env)).toEqual([]);
  });
});
