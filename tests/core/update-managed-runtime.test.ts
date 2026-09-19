import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrapManagedInstall, inventoryRelease, loadExecutingManagedInstallation, loadManagedInstallation } from "../../src/core/update/ownership.js";
import { currentReleaseCompatibility } from "../../src/core/update/compatibility.js";
import { rollbackPair, stagePair as stageManagedPair, tryActivate } from "../../src/core/update/activation.js";
import { activeSessions, resolveSessionPin, readSession, sessionFile } from "../../src/core/update/sessions.js";
import { identifyProcess, processIdentityStatus, hasUntrackedToolProcesses, findUnregisteredGatewayProcess, listUnregisteredGatewayProcessIds } from "../../src/core/update/process-identity.js";
import { atomicWrite, readState, withManagedLock } from "../../src/core/update/state.js";
import { migrateOwnedIntegrations, rollbackIntegrationMigration } from "../../src/core/update/migrations.js";
import { generateShimScript } from "../../src/core/tool-shim.js";
import type { PairDescriptor } from "../../src/core/update/types.js";
import { processMetadataParser, readToolProcessMetadata } from "../../src/core/update/process-metadata.js";
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { createInterface } from "node:readline";
import { writeUpdatePreferences } from "../../src/core/onboarding-preferences.js";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const roots: string[] = [];
const children: ReturnType<typeof spawn>[] = [];
const groups = new Set<number>();
// These controlled artifact fixtures represent explicit operator staging, not background checks.
const stagePair = (root: string, pair: PairDescriptor, revision?: number, precondition?: () => boolean) =>
  stageManagedPair(root, pair, "explicit", revision, precondition);
afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  vi.unstubAllGlobals();
  for (const group of groups) { try { process.kill(-group, "SIGKILL"); } catch { /* Already exited. */ } } groups.clear();
  for (const child of children.splice(0)) { try { child.kill("SIGKILL"); } catch { /* Already exited. */ } }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Linux terminal snapshot boundary (synthetic kernel faults)", () => {
  function kernel(snapshots: Array<{ state?: string; statState?: string; threads?: string; statThreads?: string; start?: string; uid?: string }>, denied = false) {
    const pid = 4242, uid = process.getuid!();
    let observation = 0; let active = snapshots[0]; const offsets = new Map<number, number>();
    vi.stubGlobal("process", { ...process, platform: "linux", kill: vi.fn() });
    vi.spyOn(fs, "readFileSync").mockReturnValue("00000000-0000-0000-0000-000000000000\n");
    vi.spyOn(fs, "openSync").mockImplementation(((file: fs.PathLike) => {
      const status = String(file).endsWith("/status");
      if (status) active = snapshots[Math.min(observation++, snapshots.length - 1)];
      const fd = status ? 100 : 101; offsets.set(fd, 0); return fd;
    }) as typeof fs.openSync);
    vi.spyOn(fs, "readSync").mockImplementation(((fd: number, buffer: Buffer, offset: number, length: number) => {
      const fields = Array(22).fill("0"); fields[0] = active.statState ?? active.state ?? "Z";
      fields[17] = active.statThreads ?? active.threads ?? "1"; fields[19] = active.start ?? "12345";
      const ids = active.uid ?? String(uid);
      const value = fd === 100 ? `State:\t${active.state ?? "Z"} (fixture)\nUid:\t${ids}\t${ids}\t${ids}\t${ids}\nThreads:\t${active.threads ?? "1"}\n`
        : `${pid} (fixture) ${fields.join(" ")}\n`;
      const bytes = Buffer.from(value), position = offsets.get(fd) ?? 0;
      const count = bytes.copy(buffer, offset, position, position + length); offsets.set(fd, position + count); return count;
    }) as typeof fs.readSync);
    vi.spyOn(fs, "closeSync").mockImplementation(() => {});
    const executable = vi.spyOn(fs, "readlinkSync").mockImplementation(() => {
      if (denied) throw Object.assign(new Error("fixture denial"), { code: "EACCES" });
      return "/fixture/unrelated";
    });
    syncBuiltinESMExports();
    return { pid, executable };
  }

  it("excludes only a twice-observed same-birth single-thread zombie without inspecting its missing executable", () => {
    const { pid, executable } = kernel([{}, {}]);
    const result = readToolProcessMetadata([pid], []);
    expect(fs.openSync).toHaveBeenCalledTimes(4);
    expect(result).toEqual([]);
    expect(executable).not.toHaveBeenCalled();
  });

  it.each([
    { state: "R", statState: "S" }, { state: "S", statState: "R" },
    { state: "S", threads: "1", statThreads: "2" }, { state: "R", threads: "2", statThreads: "1" },
  ])("preserves live noncandidate handling across ordinary state/thread transitions: %j", (snapshot) => {
    const { pid, executable } = kernel([snapshot]);
    expect(readToolProcessMetadata([pid], [])).toEqual([]);
    expect(executable).toHaveBeenCalled();
  });

  it.each([
    { label: "zombie leader with subthreads", states: [{ threads: "2" }] },
    { label: "status-only zombie", states: [{ state: "Z", statState: "S" }] },
    { label: "stat-only zombie", states: [{ state: "S", statState: "Z" }] },
    { label: "stat thread count higher", states: [{ threads: "1", statThreads: "2" }] },
    { label: "status thread count higher", states: [{ threads: "2", statThreads: "1" }] },
    { label: "birth changed", states: [{}, { start: "99999" }] },
    { label: "UID changed", states: [{}, { uid: "99999" }] },
    { label: "terminal state changed", states: [{}, { state: "S" }] },
    { label: "subthread appeared", states: [{}, { threads: "2" }] },
    { label: "malformed thread count", states: [{ threads: "invalid" }] },
    { label: "duplicate thread count", states: [{ threads: "1\nThreads:\t1", statThreads: "1" }] },
    { label: "malformed duplicate thread count", states: [{ threads: "1\nThreads:\tinvalid", statThreads: "1" }] },
    { label: "malformed duplicate state", states: [{ state: "Z (fixture)\nState:\tinvalid", statState: "Z" }] },
    { label: "invalid status state", states: [{ state: "Q", statState: "S" }] },
    { label: "invalid stat state", states: [{ state: "S", statState: "Q" }] },
    { label: "zero live status thread count", states: [{ state: "S", threads: "0", statThreads: "1" }] },
  ])("keeps $label closed", ({ states }) => {
    const { pid, executable } = kernel(states);
    expect(readToolProcessMetadata([pid], [])).toBeUndefined();
    expect(executable).not.toHaveBeenCalled();
  });

  it("keeps inspection-denied live processes closed", () => {
    const { pid, executable } = kernel([{ state: "S" }], true);
    expect(readToolProcessMetadata([pid], [])).toBeUndefined();
    expect(executable).toHaveBeenCalled();
  });
});

describe("Linux owned terminal processes (real kernel)", () => {
  async function bounded<T>(operation: Promise<T>, timeout = 5_000): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("owned process protocol timed out")), timeout);
    })]); } finally { clearTimeout(timer); }
  }

  it.skipIf(process.platform !== "linux")("does not let an unreaped single-thread zombie poison the inventory", async () => {
    const parent = spawn("/usr/bin/perl", ["-e", String.raw`
      $|=1; my $pid=fork(); die unless defined $pid;
      if ($pid==0) { while(1) { sleep 1; } }
      print "$pid\n";
      while(defined(my $line=<STDIN>)) {
        if($line eq "reap\n") { waitpid($pid,0); print "reaped\n"; exit; }
        if($line eq "stop\n") { last; }
      }
      kill 9,$pid; waitpid($pid,0);
    `],
      { env: { HOME: "/tmp", PATH: "/usr/bin:/bin" }, stdio: ["pipe", "pipe", "ignore"] });
    children.push(parent);
    const lines = createInterface({ input: parent.stdout! })[Symbol.asyncIterator]();
    const exited = new Promise((resolve) => parent.once("exit", resolve));
    let pid: number | undefined;
    try {
      const value = (await bounded(lines.next())).value;
      expect(/^\d+$/.test(value ?? "")).toBe(true); pid = Number(value);
      expect(readToolProcessMetadata([pid], [])).toEqual([]);
      process.kill(pid, "SIGTERM");
      await until(() => {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] === "Z";
      });
      expect(readToolProcessMetadata([pid], [])).toEqual([]);
      parent.stdin!.write("reap\n");
      expect((await bounded(lines.next())).value === "reaped").toBe(true);
      await bounded(exited);
      expect(readToolProcessMetadata([pid], [])).toEqual([]);
      pid = undefined;
    } finally {
      if (pid !== undefined) { try { process.kill(pid, "SIGKILL"); } catch {} }
      if (parent.exitCode === null && parent.signalCode === null) { parent.stdin!.end("stop\n"); await bounded(exited); }
    }
  });

  it.skipIf(process.platform !== "linux" || process.arch !== "x64")("keeps an actually inspection-denied live process closed", async () => {
    // Linux x86_64 syscall table prctl=157; UAPI PR_SET_DUMPABLE=4. Self-restriction only.
    const child = spawn("/usr/bin/perl", ["-e", String.raw`$|=1; exit 3 if syscall(157,4,0,0,0,0) != 0; print "ready\n"; while(1) { sleep 1; }`],
      { env: { HOME: "/tmp", PATH: "/usr/bin:/bin" }, stdio: ["ignore", "pipe", "ignore"] });
    children.push(child);
    const exited = new Promise((resolve) => child.once("exit", resolve));
    try {
      const lines = createInterface({ input: child.stdout! })[Symbol.asyncIterator]();
      expect((await bounded(lines.next())).value === "ready").toBe(true);
      let code: string | undefined;
      try { fs.readlinkSync(`/proc/${child.pid}/exe`); } catch (error) { code = (error as NodeJS.ErrnoException).code; }
      expect(code).toBe("EACCES");
      expect(readToolProcessMetadata([child.pid!], [])).toBeUndefined();
    } finally { child.kill("SIGKILL"); await bounded(exited); }
  });
});

function temporary(): string { const dir = mkdtempSync(path.join(tmpdir(), "compaction-managed-test-")); roots.push(dir); return dir; }
function fixture(root: string, version: string): PairDescriptor {
  const installRoot = path.join(root, "releases", version);
  const packageRoot = path.join(installRoot, "node_modules/@compaction/cli");
  mkdirSync(path.join(packageRoot, "dist/cli"), { recursive: true });
  cpSync(path.join(project, "dist/core"), path.join(packageRoot, "dist/core"), { recursive: true });
  const compatibility = currentReleaseCompatibility(version);
  writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ name: "@compaction/cli", version, type: "module", compactionRelease: compatibility }));
  writeFileSync(path.join(packageRoot, "dist/cli/index.js"), `import fs from 'node:fs';
    import { spawnSync } from 'node:child_process';
    if (process.argv[2] === 'gateway' && process.argv[3] === 'run') {
      const separator = process.argv.indexOf('--');
      if (separator < 0 || separator + 1 >= process.argv.length) process.exit(2);
      const child = spawnSync(process.argv[separator + 1], process.argv.slice(separator + 2), {
        env: process.env,
        stdio: 'inherit'
      });
      process.exit(child.status ?? 1);
    }
    process.stdout.write(${JSON.stringify(version)} + '\\n');
    if (process.argv.includes('--report-pin')) process.stdout.write((process.env.COMPACTION_SESSION_PIN || '') + '\\n');
    if (process.argv.includes('--report-root')) process.stdout.write(JSON.stringify({home:process.env.COMPACTION_HOME,config:process.env.COMPACTION_CONFIG_DIR}) + '\\n');
    if (process.argv.includes('--tty-check')) {
      let ttyOpen = true;
      try { fs.closeSync(fs.openSync('/dev/tty', 'r')); } catch { ttyOpen = false; }
      process.stdout.write(JSON.stringify({stdinTTY:!!process.stdin.isTTY,stdoutTTY:!!process.stdout.isTTY,ttyOpen}) + '\\n');
    }
    if (process.argv.includes('--emit-stderr')) process.stderr.write('fixture stderr retained\\n');
    if (process.argv[2] === '--hold') {
      fs.writeFileSync(process.argv[3], JSON.stringify({pid:process.pid,pin:process.env.COMPACTION_SESSION_PIN}));
      setInterval(() => { if (fs.existsSync(process.argv[4])) process.exit(0); }, 20);
    }`);
  return { id: `pair-${version}`, cli: { root: packageRoot, installRoot, version, compatibility,
    integrity: "sha512-controlled-local-fixture", files: inventoryRelease(installRoot), source: "local-artifact", provenance: "local-artifact" }, engine: { mode: "basic" } };
}
async function installation(currentVersion = "0.6.8", candidateVersion = "0.6.9") {
  const home = temporary(); const root = path.join(home, "managed");
  const a = fixture(root, currentVersion), b = fixture(root, candidateVersion);
  const launcher = path.join(home, "bin/compaction");
  await bootstrapManagedInstall(root, a, { launcherPath: launcher });
  return { home, root, a, b, launcher };
}
const barrier = async () => ({ ok: true });
async function until(check: () => boolean, timeout = 8_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!check()) { if (Date.now() >= deadline) throw new Error("fixture condition timed out"); await new Promise((resolve) => setTimeout(resolve, 20)); }
}

describe("staged activation intent", () => {
  async function automaticCandidate() {
    const installed = await installation();
    await stageManagedPair(installed.root, installed.b, "automatic");
    const stateFile = path.join(installed.root, "state.json");
    const env = { ...process.env, HOME: installed.home, COMPACTION_HOME: installed.home,
      COMPACTION_CONFIG_DIR: installed.home, COMPACTION_AUTO_UPDATE: "1", CI: "" };
    writeUpdatePreferences({ autoUpdates: true }, env);
    return { ...installed, stateFile, env };
  }

  it.each(["persisted-off", "environment-off", "CI", "corrupt-preferences"])("keeps automatic staging byte-stable before Gateway work when %s", async (kind) => {
    const f = await automaticCandidate();
    if (kind === "persisted-off") writeUpdatePreferences({ autoUpdates: false }, f.env);
    if (kind === "environment-off") f.env.COMPACTION_AUTO_UPDATE = "0";
    if (kind === "CI") f.env.CI = "1";
    if (kind === "corrupt-preferences") writeFileSync(writeUpdatePreferences({}, f.env), "{");
    const before = readFileSync(f.stateFile), gatewayBarrier = vi.fn(barrier);
    expect(await tryActivate(f.root, { gatewayBarrier, env: f.env })).toMatchObject({ status: "deferred", reason: "automatic-updates-disabled" });
    expect(gatewayBarrier).not.toHaveBeenCalled();
    expect(readFileSync(f.stateFile)).toEqual(before);
    const launch = spawnSync(f.launcher, ["--version"], { env: f.env, encoding: "utf8" });
    expect(launch.status).toBe(0); expect(launch.stdout.trim()).toBe(f.a.cli.version);
    expect(readFileSync(f.stateFile)).toEqual(before);
  });

  it("activates eligible automatic work and clears its intent, while rollback stays explicit", async () => {
    const f = await automaticCandidate();
    expect((await tryActivate(f.root, { gatewayBarrier: barrier, env: f.env })).status).toBe("active");
    expect(readState(f.root)).not.toHaveProperty("stagedIntent");
    expect(readState(f.root).staged).toBeUndefined();
    writeUpdatePreferences({ autoUpdates: false }, f.env);
    expect((await rollbackPair(f.root, { gatewayBarrier: barrier, env: f.env })).status).toBe("rolled-back");
    expect(readState(f.root).current.id).toBe(f.a.id);
  });

  it.each([undefined, "invalid", true])("keeps an unknown staged intent closed and the current release usable: %s", async (stagedIntent) => {
    const f = await automaticCandidate();
    atomicWrite(f.stateFile, JSON.stringify({ ...readState(f.root), stagedIntent }) + "\n");
    const before = readFileSync(f.stateFile), gatewayBarrier = vi.fn(barrier);
    expect(await tryActivate(f.root, { gatewayBarrier, env: f.env })).toMatchObject({ status: "deferred", reason: "staged-intent-unknown" });
    expect(gatewayBarrier).not.toHaveBeenCalled(); expect(readFileSync(f.stateFile)).toEqual(before);
    const launch = spawnSync(f.launcher, ["--version"], { env: { ...f.env, COMPACTION_AUTO_UPDATE: "0" }, encoding: "utf8" });
    expect(launch.status).toBe(0); expect(launch.stdout.trim()).toBe(f.a.cli.version);
    expect(readFileSync(f.stateFile)).toEqual(before);
  });

  it("observes opt-out that wins the lock before its activation decision", async () => {
    const f = await automaticCandidate();
    let entered!: () => void, release!: () => void;
    const enteredLock = new Promise<void>((resolve) => { entered = resolve; });
    const releaseLock = new Promise<void>((resolve) => { release = resolve; });
    const preference = withManagedLock(f.root, async () => { entered(); await releaseLock; writeUpdatePreferences({ autoUpdates: false }, f.env); });
    await enteredLock;
    const before = readFileSync(f.stateFile), gatewayBarrier = vi.fn(barrier);
    const activation = tryActivate(f.root, { gatewayBarrier, env: f.env });
    release(); await preference;
    expect(await activation).toMatchObject({ status: "deferred", reason: "automatic-updates-disabled" });
    expect(gatewayBarrier).not.toHaveBeenCalled(); expect(readFileSync(f.stateFile)).toEqual(before);
  });

  it("rechecks an out-of-lock opt-out written while the Gateway barrier is awaited", async () => {
    const f = await automaticCandidate();
    const before = readFileSync(f.stateFile);
    let entered!: () => void, release!: () => void;
    const enteredBarrier = new Promise<void>((resolve) => { entered = resolve; });
    const releaseBarrier = new Promise<void>((resolve) => { release = resolve; });
    const gatewayBarrier = vi.fn(async () => { entered(); await releaseBarrier; return { ok: true }; });
    const activation = tryActivate(f.root, { gatewayBarrier, env: f.env });
    await enteredBarrier;
    writeUpdatePreferences({ autoUpdates: false }, f.env);
    release();
    expect(await activation).toMatchObject({ status: "deferred", reason: "automatic-updates-disabled" });
    expect(gatewayBarrier).toHaveBeenCalledTimes(1);
    expect(readFileSync(f.stateFile)).toEqual(before);
  });

  it("atomically promotes same-pair explicit intent without a later automatic downgrade, then activates under opt-out", async () => {
    const f = await automaticCandidate(); const initial = readState(f.root);
    writeUpdatePreferences({ autoUpdates: false }, f.env);
    await stageManagedPair(f.root, f.b, "explicit", initial.revision);
    const explicit = readState(f.root);
    expect(explicit.stagedIntent).toBe("explicit"); expect(explicit.revision).toBe(initial.revision + 1);
    await expect(stageManagedPair(f.root, f.b, "automatic", initial.revision)).rejects.toThrow("state changed");
    const before = readFileSync(f.stateFile);
    await stageManagedPair(f.root, f.b, "automatic", explicit.revision);
    expect(readFileSync(f.stateFile)).toEqual(before);
    await expect(stageManagedPair(f.root, f.b, "automatic", explicit.revision, () => false)).rejects.toThrow("preferences changed");
    expect(readFileSync(f.stateFile)).toEqual(before);
    expect((await tryActivate(f.root, { gatewayBarrier: barrier, env: { ...f.env, COMPACTION_AUTO_UPDATE: "0", CI: "1" } })).status).toBe("active");
    expect(readState(f.root)).not.toHaveProperty("stagedIntent");
  });
});

describe("managed pair ownership and atomic selection (controlled local artifacts)", () => {
  it("activates a verified 0.6.10 pair from 0.6.9 without changing local user state", async () => {
    const { home, root, a, b, launcher } = await installation("0.6.9", "0.6.10");
    const env = { ...process.env, HOME: home, COMPACTION_HOME: home, COMPACTION_CONFIG_DIR: home, COMPACTION_AUTO_UPDATE: "0" };
    const protectedFiles = [
      path.join(home, "preferences.json"), path.join(home, "credentials.json"),
      path.join(home, "authorizations.json"), path.join(home, "config.json"),
      path.join(home, ".claude/settings.json"), path.join(home, ".codex/hooks.json"), path.join(home, ".cursor/hooks.json")
    ];
    protectedFiles.forEach((file, index) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, `protected-${index}\n`); });
    const before = protectedFiles.map(file => readFileSync(file));
    await stageManagedPair(root, b, "explicit");
    expect(readState(root).current.cli.version).toBe("0.6.9");
    const gatewayBarrier = vi.fn(barrier);
    expect((await tryActivate(root, { gatewayBarrier, env })).status).toBe("active");
    expect(gatewayBarrier).toHaveBeenCalledTimes(1);
    expect(readState(root).current).toEqual(b); expect(readState(root).previous).toEqual(a);
    expect(readState(root).current.engine).toEqual(b.engine);
    protectedFiles.forEach((file, index) => expect(readFileSync(file)).toEqual(before[index]));
    expect(execFileSync(launcher, ["--version"], { encoding: "utf8", env })).toBe("0.6.10\n");
  });

  it("gives hook administration a short command lease while real hook events retain their parent lease", async () => {
    const { home, root, a, b, launcher } = await installation();
    await stagePair(root, b);
    const env = { ...process.env, HOME: home, COMPACTION_HOME: home, COMPACTION_CONFIG_DIR: home, COMPACTION_AUTO_UPDATE: "0" };
    for (const verb of ["install", "status", "uninstall", "unknown", "--help"]) {
      const result = spawnSync(launcher, ["hooks", verb], { env, encoding: "utf8" });
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe(a.cli.version);
      expect(activeSessions(root)).toEqual([]);
      expect(readState(root).staged?.id).toBe(b.id);
    }
    for (const args of [["hooks", "line", "codex"], ["hooks", "shape", "cursor"],
      ["capture", "claude-code", "--from-hook"], ["capture", "claude-code", "--from-prompt-hook"],
      ["capture", "claude-code", "--shape-prompt-hook"], ["statusline"], ["precall", "codex"]]) {
      const hook = spawnSync(launcher, args, { env, encoding: "utf8" });
      expect(hook.status).toBe(0);
      expect(activeSessions(root)).toHaveLength(1);
      expect(activeSessions(root)[0].owners.some((owner) => owner.pid === process.pid)).toBe(true);
    }
    expect(readState(root).current.id).toBe(a.id);
  });

  it("retains a compatible previous pair and prevents immediate rollback rollforward", async () => {
    const { root, a, b } = await installation();
    await stagePair(root, b);
    expect(readState(root).current.id).toBe(a.id);
    expect((await tryActivate(root, { gatewayBarrier: barrier })).status).toBe("active");
    expect(readState(root).previous?.id).toBe(a.id);
    expect((await rollbackPair(root, { gatewayBarrier: barrier })).status).toBe("rolled-back");
    expect(readState(root).current.id).toBe(a.id);
    await expect(stagePair(root, b)).rejects.toThrow("rolled back");
    const journal = readdirSync(path.join(root, "transactions")).map((file) => readFileSync(path.join(root, "transactions", file), "utf8")).join("");
    expect(journal).not.toContain("node_modules");
    expect(journal).not.toContain("artifactPath");
  });

  it("rejects CLI and dependency tampering before activation and refuses external roots", async () => {
    const { root, a, b } = await installation();
    await stagePair(root, b);
    writeFileSync(path.join(b.cli.root, "dist/cli/index.js"), "throw new Error('tampered')");
    await expect(tryActivate(root, { gatewayBarrier: barrier })).rejects.toThrow("integrity changed");
    expect(readState(root).current.id).toBe(a.id);
    const outside = temporary();
    symlinkSync(outside, path.join(a.cli.installRoot, "outside"));
    expect(() => loadManagedInstallation(root)).toThrow("escapes");
  });

  it("never adopts source/npm entrypoints just because a managed receipt exists", async () => {
    const { home, root, a, launcher } = await installation();
    const env = { COMPACTION_HOME: home };
    expect(loadExecutingManagedInstallation(env, path.join(project, "dist/cli/index.js"))).toBeUndefined();
    expect(loadExecutingManagedInstallation(env, path.join(a.cli.root, "dist/cli/index.js"))?.root).toBe(root);
    writeFileSync(launcher, "foreign launcher");
    expect(() => loadManagedInstallation(root)).toThrow("ownership");
  });

  it("verifies the retained bootstrap runtime before executing any of its code", async () => {
    const { home, root, a, b, launcher } = await installation();
    await stagePair(root, b); await tryActivate(root, { gatewayBarrier: barrier });
    const c = fixture(root, "0.6.10");
    await stagePair(root, c); await tryActivate(root, { gatewayBarrier: barrier });
    expect(readState(root).previous?.id).toBe(b.id);
    const manifest = JSON.parse(readFileSync(path.join(root, "bootstrap-runtime.json"), "utf8"));
    expect(Object.keys(manifest.staticFiles)).toContain("node_modules/@compaction/cli/dist/core/update/process-identity.js");
    expect(Object.keys(manifest.staticFiles).length).toBeLessThan(Object.keys(manifest.files).length);
    const marker = path.join(home, "unverified-code-executed");
    const module = path.join(a.cli.root, "dist/core/update/process-identity.js");
    writeFileSync(module, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'unsafe');\n` + readFileSync(module, "utf8"));
    const result = spawnSync(launcher, ["hooks", "line", "codex"], { encoding: "utf8", env: { ...process.env,
      COMPACTION_HOME: home, COMPACTION_CONFIG_DIR: home, COMPACTION_AUTO_UPDATE: "0" } });
    expect(result.status).toBe(125);
    expect(result.stderr).toContain("integrity could not be verified");
    expect(result.stdout).toBe("");
    expect(existsSync(marker)).toBe(false);
    expect(readState(root).current.id).toBe(c.id);
  });

  it("refuses unexpected additions to the retained bootstrap release at a top-level launch", async () => {
    const { home, a, launcher } = await installation();
    writeFileSync(path.join(a.cli.root, "dist/core/update/unverified-extra.js"), "throw new Error('unverified');");
    const result = spawnSync(launcher, ["--version"], { encoding: "utf8", env: { ...process.env,
      COMPACTION_HOME: home, COMPACTION_CONFIG_DIR: home, COMPACTION_AUTO_UPDATE: "0" } });
    expect(result.status).toBe(125);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("integrity could not be verified");
  });

  it("refuses concurrent stale stage publication and never steals a live old lock", async () => {
    const { root, b } = await installation();
    await stagePair(root, b, 0);
    await expect(stagePair(root, b, 0)).rejects.toThrow("state changed");
    let release!: () => void;
    const held = withManagedLock(root, () => new Promise<void>((resolve) => { release = resolve; }));
    await until(() => !!release);
    await expect(withManagedLock(root, () => undefined, 25)).rejects.toThrow("busy");
    release(); await held;
    await expect(withManagedLock(root, () => "released")).resolves.toBe("released");
  });

  it("rechecks publication eligibility under the shared lock before staging", async () => {
    const { root, b } = await installation();
    await expect(stagePair(root, b, 0, () => false)).rejects.toThrow("preferences changed");
    expect(readState(root).revision).toBe(0);
    expect(readState(root).staged).toBeUndefined();
    await stagePair(root, b, 0, () => existsSync(path.join(root, "runtime.lock")));
    expect(readState(root).staged?.id).toBe(b.id);
  });

  it("refuses writable-by-others owned anchors and direct root symlinks", async () => {
    const { root, home } = await installation();
    chmodSync(root, 0o777);
    try { expect(() => loadManagedInstallation(root)).toThrow("ownership or permissions"); }
    finally { chmodSync(root, 0o700); }
    const link = path.join(home, "managed-link"); symlinkSync(root, link);
    await expect(withManagedLock(link, () => "unsafe")).rejects.toThrow("ownership or permissions");
    expect(existsSync(path.join(root, "runtime.lock"))).toBe(false);
    chmodSync(path.join(root, "releases"), 0o777);
    try { expect(() => loadManagedInstallation(root)).toThrow("ownership or permissions"); }
    finally { chmodSync(path.join(root, "releases"), 0o700); }
  });

  it("uses OS birth identity, conservatively distinguishing a reused PID", () => {
    const owner = identifyProcess();
    expect(processIdentityStatus(owner)).toBe("alive");
    expect(processIdentityStatus({ ...owner, birth: `${owner.birth}-different-generation` })).toBe("dead");
  });
});

describe("stable shim session envelope", () => {
  it("binds update dispatch to the trusted launcher root even with a conflicting ambient config", async () => {
    const { home, launcher } = await installation();
    const output = execFileSync(launcher, ["update", "--report-root"], { encoding: "utf8", env: { ...process.env,
      COMPACTION_HOME: "/tmp/unrelated-compaction-home", COMPACTION_CONFIG_DIR: "/tmp/unrelated-compaction-config", COMPACTION_AUTO_UPDATE: "0" } }).trim().split("\n");
    const expected = path.dirname(JSON.parse(readFileSync(path.join(home, "managed/install.json"), "utf8")).root);
    expect(JSON.parse(output[1])).toEqual({ home: expected, config: expected });
  });
  it("preserves the controlling terminal and inherited stderr through the process-group envelope", async () => {
    const { home, launcher } = await installation();
    const env = { ...process.env, COMPACTION_HOME: home, COMPACTION_CONFIG_DIR: home, COMPACTION_AUTO_UPDATE: "0" };
    const command = process.platform === "darwin" ? "/usr/bin/expect" : "/usr/bin/script";
    const args = process.platform === "darwin" ? ["-c", "set timeout 5; spawn -noecho $env(COMPACTION_TEST_LAUNCHER) --tty-check; expect eof; set result [wait]; exit [lindex $result 3]"]
      : ["-q", "-e", "-c", `'${launcher.replace(/'/g, `'\\''`)}' --tty-check`, "/dev/null"];
    const result = spawnSync(command, args, { encoding: "utf8", env: { ...env, COMPACTION_TEST_LAUNCHER: launcher }, timeout: 8_000 });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('{"stdinTTY":true,"stdoutTTY":true,"ttyOpen":true}');
    const stderr = spawnSync(launcher, ["--emit-stderr"], { encoding: "utf8", env, timeout: 8_000 });
    expect(stderr.status).toBe(0);
    expect(stderr.stdout).toBe("0.6.8\n");
    expect(stderr.stderr).toBe("fixture stderr retained\n");
  });
  it("admits hook-only calls with the same locked pair and an opaque inherited reference, without checking updates", async () => {
    const { home, root, a, b, launcher } = await installation();
    await stagePair(root, b);
    const env = { ...process.env, COMPACTION_HOME: home, COMPACTION_CONFIG_DIR: home, COMPACTION_AUTO_UPDATE: "0" };
    const output = execFileSync(launcher, ["hooks", "line", "codex", "--report-pin"], { encoding: "utf8", env }).trim().split("\n");
    expect(output[0]).toBe(a.cli.version);
    expect(resolveSessionPin(root, output[1])?.id).toBe(a.id);
    expect(readState(root).current.id).toBe(a.id);
    expect(existsSync(path.join(root, "update-check.json"))).toBe(false);
    const next = execFileSync(launcher, ["hooks", "line", "codex", "--report-pin"], { encoding: "utf8", env }).trim().split("\n");
    expect(next[1]).toBe(output[1]);
    expect(activeSessions(root)).toHaveLength(1);
  });
  it("serializes concurrent admissions with activation and retains both admitted sessions", async () => {
    const { home, root, a, b, launcher } = await installation();
    const release = path.join(home, "concurrent-release");
    const running = [0, 1].map((index) => {
      const ready = path.join(home, `ready-${index}`);
      const child = spawn(launcher, ["--hold", ready, release], { cwd: home, env: { ...process.env,
        COMPACTION_HOME: home, COMPACTION_CONFIG_DIR: home, COMPACTION_AUTO_UPDATE: "0" }, stdio: "ignore" });
      children.push(child);
      return { ready, child, exited: new Promise((resolve) => child.once("exit", resolve)) };
    });
    await until(() => running.every(({ ready }) => existsSync(ready)));
    const leases = activeSessions(root);
    expect(leases).toHaveLength(2);
    for (const lease of leases) {
      expect(lease.pair.id).toBe(a.id);
      for (const group of lease.processGroups ?? []) groups.add(group);
    }
    await stagePair(root, b);
    const transitions = await Promise.all([tryActivate(root, { gatewayBarrier: barrier }), tryActivate(root, { gatewayBarrier: barrier })]);
    expect(transitions.map((result) => result.reason)).toEqual(["active-sessions", "active-sessions"]);
    writeFileSync(release, "go");
    await Promise.all(running.map(({ exited }) => exited));
    expect(activeSessions(root)).toEqual([]);
    const promoted = await Promise.all([tryActivate(root, { gatewayBarrier: barrier }), tryActivate(root, { gatewayBarrier: barrier })]);
    expect(promoted.map((result) => result.status).sort()).toEqual(["active", "unchanged"]);
    expect(readState(root).current.id).toBe(b.id);
  });
  it("keeps a surviving real child leased after its wrapper receives SIGKILL", async () => {
    const { home, root, a, b, launcher } = await installation();
    const ready = path.join(home, "child-ready"), release = path.join(home, "child-release");
    const child = spawn(launcher, ["--hold", ready, release], { cwd: home, env: { ...process.env, COMPACTION_HOME: home, COMPACTION_CONFIG_DIR: home, COMPACTION_AUTO_UPDATE: "0" }, stdio: "ignore" });
    children.push(child);
    await until(() => existsSync(ready));
    const running = JSON.parse(readFileSync(ready, "utf8"));
    const lease = readSession(root, running.pin);
    for (const group of lease.processGroups ?? []) groups.add(group);
    expect(lease.owners.some((owner) => owner.pid === running.pid)).toBe(true);
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGKILL"); await exited;
    expect(resolveSessionPin(root, running.pin)?.id).toBe(a.id);
    await stagePair(root, b);
    expect((await tryActivate(root, { gatewayBarrier: barrier })).reason).toBe("active-sessions");
    writeFileSync(release, "go");
    await until(() => activeSessions(root).length === 0);
    expect(resolveSessionPin(root, running.pin)).toBeUndefined();
    expect((await tryActivate(root, { gatewayBarrier: barrier })).status).toBe("active");
  });

  it("forwards termination to the complete tool group and rejects arbitrary pin paths", async () => {
    const { home, root, launcher } = await installation();
    const ready = path.join(home, "child-ready"), release = path.join(home, "child-release");
    const env = { ...process.env, COMPACTION_HOME: home, COMPACTION_CONFIG_DIR: home, COMPACTION_AUTO_UPDATE: "0" };
    const invalid = spawnSync(launcher, ["--version"], { encoding: "utf8", env: { ...env, COMPACTION_SESSION_PIN: "/tmp/arbitrary-executable" } });
    expect(invalid.status).toBe(125); expect(invalid.stdout).toBe("");
    const child = spawn(launcher, ["--hold", ready, release], { cwd: home, env, stdio: "ignore" }); children.push(child);
    await until(() => existsSync(ready));
    for (const group of activeSessions(root)[0].processGroups ?? []) groups.add(group);
    const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    expect(await exited).toBe(143);
    await until(() => activeSessions(root).length === 0);
  });
  it("pins full tool lifetime and inherited hook calls while staging, preserving arguments/stdout/exit", async () => {
    const { home, root, a, b, launcher } = await installation();
    const shimDir = path.join(home, "shims"); mkdirSync(shimDir);
    const real = path.join(home, "fixture-tool");
    const ready = path.join(home, "ready");
    const release = path.join(home, "release");
    writeFileSync(real, `#!/bin/bash\nprintf '%s\\n' "$@"\n"$COMPACTION_BIN" hooks line codex\ntouch ${JSON.stringify(ready)}\nwhile [ ! -f ${JSON.stringify(release)} ]; do sleep 0.05; done\n"$COMPACTION_BIN" hooks line codex\nexit 17\n`, { mode: 0o755 });
    const shim = path.join(shimDir, "codex");
    writeFileSync(shim, generateShimScript("codex", real, launcher), { mode: 0o755 });
    writeFileSync(path.join(shimDir, ".shim-record.json"), JSON.stringify({ version: 1, shims: { codex: { realBin: real, shimName: "codex" } } }));
    const child = spawn(shim, ["space argument", "$literal"], { env: { ...process.env, COMPACTION_HOME: home, COMPACTION_CONFIG_DIR: home, COMPACTION_SHIM_DIR: shimDir, COMPACTION_AUTO_UPDATE: "0" }, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    let output = "", errors = ""; child.stdout?.on("data", (part) => { output += part; }); child.stderr?.on("data", (part) => { errors += part; });
    const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
    await until(() => existsSync(ready));
    const leases = activeSessions(root);
    expect(leases).toHaveLength(1);
    expect(leases[0].owners.length).toBeGreaterThanOrEqual(3);
    expect(resolveSessionPin(root, leases[0].id)?.id).toBe(a.id);
    await stagePair(root, b);
    expect((await tryActivate(root, { gatewayBarrier: barrier })).reason).toBe("active-sessions");
    writeFileSync(release, "go");
    expect(await exited).toBe(17);
    expect(errors).toBe("");
    expect(output).toBe("space argument\n$literal\n0.6.8\n0.6.8\n");
    expect(activeSessions(root)).toEqual([]);
    expect((await tryActivate(root, { gatewayBarrier: barrier })).status).toBe("active");
    expect(execFileSync(launcher, ["--version"], { encoding: "utf8", env: { ...process.env, COMPACTION_HOME: home, COMPACTION_CONFIG_DIR: home, COMPACTION_AUTO_UPDATE: "0" } })).toBe("0.6.9\n");
  });
});

describe("installation-scoped untracked process ownership", () => {
  it("excludes only the exact Claude Chrome native-host dispatch so a staged pair can activate", async () => {
    const { home, root, launcher, b } = await installation();
    const script = path.join(home, "known-claude-script.js"); writeFileSync(script, "setInterval(() => {}, 1000);");
    const shimDir = path.join(home, "shims"); mkdirSync(shimDir);
    writeFileSync(path.join(shimDir, "claude"), generateShimScript("claude-code", script, launcher));
    writeFileSync(path.join(shimDir, ".shim-record.json"), JSON.stringify({ shims: { "claude-code": { realBin: script } } }));
    const sentinel = "fixture-native-host-secret-never-returned";
    const env = { ...process.env, HOME: home, PATH: `${shimDir}:${path.dirname(launcher)}:/usr/bin:/bin`,
      COMPACTION_HOME: home, COMPACTION_SHIM_DIR: shimDir, UNPROJECTED_SENTINEL: sentinel };
    const nativeHost = spawn(process.execPath, [script, "--chrome-native-host"], { cwd: home, env, stdio: "ignore" }); children.push(nativeHost);
    const exited = new Promise((resolve) => nativeHost.once("exit", resolve));
    await new Promise((resolve) => nativeHost.once("spawn", resolve));
    try {
      const execute = childProcess.execFileSync; const uid = process.getuid!();
      vi.spyOn(childProcess, "execFileSync").mockImplementation(((...args: Parameters<typeof execute>) =>
        args[0] === "/bin/ps" && (args[1] as string[] | undefined)?.[0] === "-axo"
          ? `${uid} ${uid} ${nativeHost.pid}\n` as ReturnType<typeof execute> : execute(...args)) as typeof execute);
      syncBuiltinESMExports();
      const metadata = readToolProcessMetadata([nativeHost.pid!], [{ path: script, tool: "claude" }]);
      expect(metadata?.[0]?.dispatch).toBe("chrome-native-host");
      expect(JSON.stringify(metadata)).not.toContain(sentinel);
      expect(hasUntrackedToolProcesses(root, new Set(), env)).toBe(false);
      await stagePair(root, b);
      expect((await tryActivate(root, { gatewayBarrier: barrier })).status).toBe("active");
    } finally {
      nativeHost.kill("SIGKILL"); await exited;
    }
  });

  it("keeps an ordinary Claude process reached through the same owned shim blocking", async () => {
    const { home, root, launcher, b } = await installation();
    const script = path.join(home, "known-claude-script.js"); writeFileSync(script, "setInterval(() => {}, 1000);");
    const shimDir = path.join(home, "shims"); mkdirSync(shimDir);
    writeFileSync(path.join(shimDir, "claude"), generateShimScript("claude-code", script, launcher));
    writeFileSync(path.join(shimDir, ".shim-record.json"), JSON.stringify({ shims: { "claude-code": { realBin: script } } }));
    const env = { ...process.env, HOME: home, PATH: `${shimDir}:${path.dirname(launcher)}:/usr/bin:/bin`,
      COMPACTION_HOME: home, COMPACTION_SHIM_DIR: shimDir };
    const ordinary = spawn(process.execPath, [script], { cwd: home, env, stdio: "ignore" }); children.push(ordinary);
    const exited = new Promise((resolve) => ordinary.once("exit", resolve));
    await new Promise((resolve) => ordinary.once("spawn", resolve));
    try {
      const execute = childProcess.execFileSync; const uid = process.getuid!();
      vi.spyOn(childProcess, "execFileSync").mockImplementation(((...args: Parameters<typeof execute>) =>
        args[0] === "/bin/ps" && (args[1] as string[] | undefined)?.[0] === "-axo"
          ? `${uid} ${uid} ${ordinary.pid}\n` as ReturnType<typeof execute> : execute(...args)) as typeof execute);
      syncBuiltinESMExports();
      expect(readToolProcessMetadata([ordinary.pid!], [{ path: script, tool: "claude" }])?.[0]?.dispatch).toBe("ordinary");
      expect(hasUntrackedToolProcesses(root, new Set(), env)).toBe(true);
      await stagePair(root, b);
      expect((await tryActivate(root, { gatewayBarrier: barrier })).reason).toBe("untracked-tool-process");
    } finally {
      ordinary.kill("SIGKILL"); await exited;
    }
  });

  it("keeps malformed native-host metadata fail-closed at activation", async () => {
    if (process.platform !== "darwin") return;
    const { root, b } = await installation(); await stagePair(root, b);
    const execute = childProcess.execFileSync;
    vi.spyOn(childProcess, "execFileSync").mockImplementation(((...args: Parameters<typeof execute>) => {
      if (args[0] === "/usr/bin/osascript") return '{"ok":true,"processes":[{"dispatch":"chrome-native-host"}]}' as ReturnType<typeof execute>;
      return execute(...args);
    }) as typeof execute);
    expect((await tryActivate(root, { gatewayBarrier: barrier })).reason).toBe("untracked-tool-process");
  });

  it("routes an exact known interpreter script using the target environment, never the inspector environment", async () => {
    const { home, root, launcher } = await installation();
    const shimDir = path.join(home, "shims"); mkdirSync(shimDir);
    const script = path.join(home, "owned-tool.js");
    writeFileSync(script, "setInterval(() => {}, 1000);");
    writeFileSync(path.join(shimDir, "codex"), generateShimScript("codex", script, launcher));
    writeFileSync(path.join(shimDir, ".shim-record.json"), JSON.stringify({ shims: { codex: { realBin: script } } }));
    const env = { ...process.env, HOME: home, PATH: `${path.dirname(launcher)}:${process.env.PATH}`, COMPACTION_HOME: home };
    const helperFailures: Array<{ stage: string; pid: number }> = [];
    const execute = childProcess.execFileSync;
    vi.spyOn(childProcess, "execFileSync").mockImplementation(((...args: Parameters<typeof execute>) => {
      const output = execute(...args);
      if (args[0] === "/usr/bin/osascript") { const result = JSON.parse(String(output)); if (!result.ok) helperFailures.push({ stage: result.stage, pid: result.pid }); }
      return output;
    }) as typeof execute);
    const owned = spawn(process.execPath, ["--enable-source-maps", script], { cwd: home, env, stdio: "ignore" }); children.push(owned);
    await new Promise((resolve) => owned.once("spawn", resolve));
    expect(hasUntrackedToolProcesses(root, new Set(), env)).toBe(true);
    const tracked = hasUntrackedToolProcesses(root, new Set([owned.pid!]), env);
    expect(helperFailures).toEqual([]);
    expect(tracked).toBe(false);
    const exited = new Promise((resolve) => owned.once("exit", resolve)); owned.kill(); await exited;
    const lookalike = path.join(home, "codex", "unrelated.js"); mkdirSync(path.dirname(lookalike));
    writeFileSync(lookalike, "setInterval(() => {}, 1000);");
    const unrelated = spawn(process.execPath, [lookalike], { cwd: home, env, stdio: "ignore" }); children.push(unrelated);
    await new Promise((resolve) => unrelated.once("spawn", resolve));
    expect(hasUntrackedToolProcesses(root, new Set(), env)).toBe(false);
    const foreignHome = temporary();
    const foreign = spawn(process.execPath, [script], { cwd: foreignHome, env: { HOME: foreignHome, PATH: "/usr/bin:/bin" }, stdio: "ignore" }); children.push(foreign);
    await new Promise((resolve) => foreign.once("spawn", resolve));
    expect(hasUntrackedToolProcesses(root, new Set(), env)).toBe(false);
    const spoof = spawn("/bin/sleep", ["20"], { argv0: "claude", cwd: home, env, stdio: "ignore" }); children.push(spoof);
    await new Promise((resolve) => spoof.once("spawn", resolve));
    expect(readToolProcessMetadata([spoof.pid!], [])).toEqual([]);
    expect(hasUntrackedToolProcesses(root, new Set(), env)).toBe(false);
  });

  it("projects Unicode/space paths from a birth-bound owned child without leaking a secret sentinel or argv lookalike", async () => {
    const home = path.join(temporary(), "ü space 😀"); mkdirSync(home);
    const script = path.join(home, "known-script.js"); writeFileSync(script, "setInterval(() => {}, 1000);");
    const env = { HOME: home, PATH: `${home}:/usr/bin:/bin`, CODEX_HOME: path.join(home, "codex ü"), CLAUDE_CONFIG_DIR: path.join(home, "claude ü"), UNPROJECTED_SENTINEL: "fixture-only-secret-never-returned" };
    const child = spawn(process.execPath, ["--enable-source-maps", script, "HOME=/argv-lookalike"], { cwd: home, env, stdio: "ignore" }); children.push(child);
    await new Promise((resolve) => child.once("spawn", resolve));
    const metadata = readToolProcessMetadata([child.pid!], [{ path: script, tool: "codex" }]);
    // Assertions print only selected numeric/path fields; raw argv/environment never enters diagnostics.
    expect(metadata?.length).toBe(1);
    expect(metadata?.[0]?.pid).toBe(child.pid);
    expect(metadata?.[0]?.uid).toBe(process.getuid?.());
    expect(metadata?.[0]?.cwd).toBe(realpathSync(home));
    expect(metadata?.[0]?.environment.HOME).toBe(home);
    expect(metadata?.[0]?.environment.CODEX_HOME).toBe(env.CODEX_HOME);
    expect(metadata?.[0]?.environment.CLAUDE_CONFIG_DIR).toBe(env.CLAUDE_CONFIG_DIR);
    expect(metadata?.[0]?.birth).toMatch(/^\d+:\d+:/);
    expect((JSON.stringify(metadata) ?? "").includes(env.UNPROJECTED_SENTINEL)).toBe(false);
    expect((JSON.stringify(metadata) ?? "").includes("argv-lookalike")).toBe(false);
  });

  it("protects a real pre-hook process through its own config override even without a reachable shim or generic launcher", async () => {
    const { home, root, launcher, b } = await installation();
    const script = path.join(home, "known-claude-script.js"); writeFileSync(script, "setInterval(() => {}, 1000);");
    const shimDir = path.join(home, "shims"); mkdirSync(shimDir);
    writeFileSync(path.join(shimDir, "claude"), generateShimScript("claude-code", script, launcher));
    writeFileSync(path.join(shimDir, ".shim-record.json"), JSON.stringify({ shims: { "claude-code": { realBin: script } } }));
    const custom = path.join(home, "native ü settings"); mkdirSync(custom);
    writeFileSync(path.join(custom, "settings.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: `${launcher} capture claude-code --from-hook` }] }] } }));
    const unrelatedHome = temporary();
    const own = spawn(process.execPath, [script], { cwd: unrelatedHome, env: { HOME: unrelatedHome, PATH: "/usr/bin:/bin", CLAUDE_CONFIG_DIR: custom }, stdio: "ignore" }); children.push(own);
    await new Promise((resolve) => own.once("spawn", resolve));
    expect(activeSessions(root)).toEqual([]); // The fixture has never called a hook or admitted a lease.
    await stagePair(root, b);
    expect((await tryActivate(root, { gatewayBarrier: barrier })).reason).toBe("untracked-tool-process");
    const ended = new Promise((resolve) => own.once("exit", resolve)); own.kill("SIGKILL"); await ended;
    const foreign = spawn(process.execPath, [script], { cwd: unrelatedHome, env: { HOME: unrelatedHome, PATH: "/usr/bin:/bin", CLAUDE_CONFIG_DIR: unrelatedHome }, stdio: "ignore" }); children.push(foreign);
    await new Promise((resolve) => foreign.once("spawn", resolve));
    expect(hasUntrackedToolProcesses(root, new Set(), { HOME: home, PATH: path.dirname(launcher) })).toBe(false);
    expect((await tryActivate(root, { gatewayBarrier: barrier })).status).toBe("active");
  });

  it("rejects duplicate, truncated, malformed UTF-8 and oversized projected metadata", () => {
    const parser = processMetadataParser();
    for (const bytes of [Buffer.from("HOME=/a\0HOME=/b\0"), Buffer.from("HOME=/unterminated"),
      Buffer.concat([Buffer.from("HOME="), Buffer.from([0xc0, 0xaf, 0])]),
      Buffer.from(`HOME=/${"a".repeat(16385)}\0`), Buffer.from("MALFORMED\0")]) {
      expect(() => parser.parse(bytes, bytes.length, false, true)).toThrow(/^metadata /);
    }
    const bytes = Buffer.from("HOME=/ü 😀 space\0PATH=/usr/bin:/bin\0SECRET=never-return-this\0");
    const projected = parser.parse(bytes, bytes.length, false, true).environment;
    expect(Object.keys(projected).sort()).toEqual(["HOME", "PATH"]);
    expect(projected.HOME).toBe("/ü 😀 space");
    const malformedDispatch = Buffer.concat([Buffer.from("claude\0"), Buffer.from([0xc0, 0xaf, 0])]);
    expect(() => parser.parse(malformedDispatch, malformedDispatch.length, false, false).dispatch(1)).toThrow(/^metadata encoding/);
  });

  it("treats denied, raced, truncated and malformed helper output as unknown", () => {
    if (process.platform !== "darwin") return;
    for (const output of ['{"ok":false,"stage":"identity"}', '{"ok":false,"stage":"recheck"}', '{"ok":true', '{"ok":true,"processes":[{}]}']) {
      const spy = vi.spyOn(childProcess, "execFileSync").mockReturnValue(output);
      expect(readToolProcessMetadata([process.pid], [])).toBeUndefined(); spy.mockRestore();
    }
    const spy = vi.spyOn(childProcess, "execFileSync").mockImplementation(() => { throw new Error("fixture denial"); });
    expect(readToolProcessMetadata([process.pid], [])).toBeUndefined(); spy.mockRestore();
  });

  it("recognizes actual Gateway start argv, skips registered identities, and ignores argument text", async () => {
    const directory = temporary(); const script = path.join(directory, "dist/cli/index.js"); mkdirSync(path.dirname(script), { recursive: true });
    writeFileSync(script, "setInterval(() => {}, 1000);");
    const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "compaction gateway start"], { stdio: "ignore" }); children.push(unrelated);
    const gateway = spawn(process.execPath, [script, "gateway", "start"], { stdio: "ignore" }); children.push(gateway);
    await new Promise((resolve) => gateway.once("spawn", resolve));
    expect(findUnregisteredGatewayProcess(new Set())).toBe(true);
    const unmatched = listUnregisteredGatewayProcessIds(new Set());
    expect(unmatched).toContain(gateway.pid!);
    expect(unmatched).not.toContain(unrelated.pid!);
    const registered = listUnregisteredGatewayProcessIds(new Set([gateway.pid!]));
    expect(registered).not.toBe("unknown");
    expect(registered).not.toContain(gateway.pid!);
    expect(registered).not.toContain(unrelated.pid!);
  });
});

describe("owned-only integration migration", () => {
  it("refuses a real linked shim even when the link stays in the configured directory", async () => {
    const { root, home } = await installation();
    const shims = path.join(home, "shims"); mkdirSync(shims);
    const original = path.join(shims, "original");
    writeFileSync(original, generateShimScript("codex", "/bin/true"));
    symlinkSync(original, path.join(shims, "codex"));
    writeFileSync(path.join(shims, ".shim-record.json"), JSON.stringify({ shims: { codex: { realBin: "/bin/true" } } }));
    await expect(migrateOwnedIntegrations(root, { COMPACTION_HOME: home })).rejects.toThrow("linked shim");
    expect(readFileSync(original, "utf8")).toBe(generateShimScript("codex", "/bin/true"));
  });
  it("keeps restrictive raw backups separate and preserves later foreign edits on inverse", async () => {
    const { root, home, launcher } = await installation();
    const shims = path.join(home, "shims"); mkdirSync(shims);
    const file = path.join(shims, "codex");
    const before = generateShimScript("codex", "/usr/bin/fixture-real-tool");
    writeFileSync(file, before, { mode: 0o755 });
    writeFileSync(path.join(shims, ".shim-record.json"), JSON.stringify({ version: 1, shims: {
      codex: { realBin: "/usr/bin/fixture-real-tool" }, cursor: { realBin: "/usr/bin/deselected" }
    } }));
    const id = await migrateOwnedIntegrations(root, { COMPACTION_HOME: home });
    expect(id).toBeDefined();
    expect(readFileSync(file, "utf8")).toBe(generateShimScript("codex", "/usr/bin/fixture-real-tool", launcher));
    expect(existsSync(path.join(shims, "cursor-agent"))).toBe(false);
    expect(await migrateOwnedIntegrations(root, { COMPACTION_HOME: home })).toBeUndefined();
    const record = JSON.parse(readFileSync(path.join(root, "migrations", `${id}.json`), "utf8"));
    expect(statSync(record.entries[0].backup).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(record)).not.toContain("#!/");
    writeFileSync(file, readFileSync(file, "utf8") + "# later foreign edit\n");
    expect(await rollbackIntegrationMigration(root, id!)).toEqual({ reverted: 0, conflicts: 1 });
    expect(readFileSync(file, "utf8")).toContain("later foreign edit");
  });

  it("reverses an unchanged owned shim byte-for-byte without touching a removed tool", async () => {
    const { root, home } = await installation();
    const shims = path.join(home, "shims"); mkdirSync(shims);
    const file = path.join(shims, "claude");
    const before = generateShimScript("claude-code", "/bin/true");
    writeFileSync(file, before, { mode: 0o755 });
    writeFileSync(path.join(shims, ".shim-record.json"), JSON.stringify({ shims: { "claude-code": { realBin: "/bin/true" } } }));
    const id = await migrateOwnedIntegrations(root, { COMPACTION_HOME: home });
    expect(await rollbackIntegrationMigration(root, id!)).toEqual({ reverted: 1, conflicts: 0 });
    expect(readFileSync(file, "utf8")).toBe(before);
  });
});

/** SIGKILL injection uses real compiled I/O and real owner identities, not a successful fake write. */
function interruptedWrite(root: string, action: string, target: string, position: "before" | "after", occurrence = 1) {
  const script = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { pathToFileURL } from 'node:url';
    const [root, project, target, position, occurrence, action] = process.argv.slice(1);
    const rename = fs.renameSync; let seen = 0;
    fs.renameSync = function(from, to) {
      const hit = String(to).includes(target) && ++seen === Number(occurrence);
      if (hit && position === 'before') process.kill(process.pid, 'SIGKILL');
      const result = rename(from, to);
      if (hit && position === 'after') process.kill(process.pid, 'SIGKILL');
      return result;
    };
    syncBuiltinESMExports();
    const state = await import(pathToFileURL(project + '/dist/core/update/state.js'));
    const ownership = await import(pathToFileURL(project + '/dist/core/update/ownership.js'));
    const migration = await import(pathToFileURL(project + '/dist/core/update/migrations.js'));
    const candidate = JSON.parse(fs.readFileSync(root + '/candidate.json', 'utf8'));
    if (action === 'session') {
      const launcher = await import(pathToFileURL(project + '/dist/core/update/launcher.js'));
      await launcher.launchManaged(root, ['--hold', root + '/../admission-ready', root + '/../admission-release']);
    }
    else if (action === 'bootstrap') await ownership.bootstrapManagedInstall(root, candidate, {launcherPath: root + '/../bin/compaction'});
    else if (action === 'migrate') await migration.migrateOwnedIntegrations(root, {COMPACTION_HOME: root + '/..'});
    else await state.withManagedLock(root, () => {
      const previous = state.readState(root);
      state.writeState(root, {...previous, revision: previous.revision + 1, current: candidate, previous: previous.current}, 'activate');
    });
  `;
  return spawnSync(process.execPath, ["--input-type=module", "-e", script, root, project, target, position, String(occurrence), action], {
    encoding: "utf8", timeout: 8_000, env: { ...process.env, COMPACTION_HOME: path.dirname(root), COMPACTION_CONFIG_DIR: path.dirname(root), COMPACTION_AUTO_UPDATE: "0" }
  });
}

describe("interrupted managed filesystem boundaries", () => {
  it.each([["before", 1], ["after", 1], ["before", 2], ["after", 2]] as const)(
    "never execs a tool when its wrapper dies %s admission write %i", async (position, occurrence) => {
      const { root, home, a } = await installation();
      writeFileSync(path.join(root, "candidate.json"), JSON.stringify(a));
      const killed = interruptedWrite(root, "session", "/sessions/", position, occurrence);
      expect(killed.signal, killed.stderr).toBe("SIGKILL");
      await until(() => activeSessions(root).length === 0);
      expect(existsSync(path.join(home, "admission-ready"))).toBe(false);
      await expect(withManagedLock(root, () => "recovered")).resolves.toBe("recovered");
    }
  );
  it.each([
    ["/transactions/", "before", 1, false], ["/transactions/", "after", 1, false],
    ["/state.json", "before", 1, false], ["/state.json", "after", 1, true],
    ["/transactions/", "before", 2, true], ["/transactions/", "after", 2, true]
  ] as const)("keeps a complete pair at %s %s occurrence %i", async (target, position, occurrence, newSelected) => {
    const { root, a, b } = await installation();
    writeFileSync(path.join(root, "candidate.json"), JSON.stringify(b));
    const killed = interruptedWrite(root, "switch", target, position, occurrence);
    expect(killed.signal, killed.stderr).toBe("SIGKILL");
    const state = loadManagedInstallation(root).state;
    expect(state.current).toEqual(newSelected ? b : a);
    expect(state.previous).toEqual(newSelected ? a : undefined);
    // Reclaim the killed owner's lock through its OS identity; never by age.
    await expect(withManagedLock(root, () => "recovered")).resolves.toBe("recovered");
  });

  it.each(["before", "after"] as const)("recovers bootstrap %s receipt publication without adopting a foreign launcher", async (position) => {
    const home = temporary(); const root = path.join(home, "managed");
    const pair = fixture(root, "0.6.8");
    writeFileSync(path.join(root, "candidate.json"), JSON.stringify(pair));
    const killed = interruptedWrite(root, "bootstrap", "/install.json", position);
    expect(killed.signal, killed.stderr).toBe("SIGKILL");
    const launcher = path.join(home, "bin/compaction");
    expect(existsSync(launcher)).toBe(true);
    await bootstrapManagedInstall(root, pair, { launcherPath: launcher });
    expect(loadManagedInstallation(root).state.current.id).toBe(pair.id);
    expect(statSync(launcher).mode & 0o111).not.toBe(0);
  });

  it.each(["before", "after"] as const)("resumes an interrupted shim replacement %s rename and preserves foreign settings", async (position) => {
    const { root, home, a, launcher } = await installation();
    writeFileSync(path.join(root, "candidate.json"), JSON.stringify(a));
    const shims = path.join(home, "shims"); mkdirSync(shims);
    const file = path.join(shims, "codex");
    const old = generateShimScript("codex", "/bin/true");
    writeFileSync(file, old, { mode: 0o755 });
    writeFileSync(path.join(shims, ".shim-record.json"), JSON.stringify({ shims: { codex: { realBin: "/bin/true" } } }));
    const foreign = path.join(home, "foreign-settings.json");
    writeFileSync(foreign, '{"foreign":"preserve exactly"}\n');
    const killed = interruptedWrite(root, "migrate", "/shims/codex", position);
    expect(killed.signal, killed.stderr).toBe("SIGKILL");
    expect([old, generateShimScript("codex", "/bin/true", launcher)]).toContain(readFileSync(file, "utf8"));
    await migrateOwnedIntegrations(root, { COMPACTION_HOME: home });
    expect(readFileSync(file, "utf8")).toBe(generateShimScript("codex", "/bin/true", launcher));
    expect(readFileSync(foreign, "utf8")).toBe('{"foreign":"preserve exactly"}\n');
  });
});
