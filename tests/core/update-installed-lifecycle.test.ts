import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

// Explicit acceptance only: this runs the real installer and public npm dependency signature
// verification. Ordinary npm test remains offline. No CLI business logic is replaced or mocked.
const enabled = process.env.COMPACTION_PACKED_UPDATE_ACCEPTANCE === "1";
const keep = process.env.COMPACTION_KEEP_PACKED_UPDATE_FIXTURE === "1";
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const run = promisify(execFile);
const children: ChildProcess[] = [];
let fixture: string | undefined;
let upstream: http.Server | undefined;
let managedRoot: string | undefined;

afterEach(async () => {
  if (fixture) writeFileSync(path.join(fixture, "finish"), "cleanup");
  for (const child of children.splice(0)) { try { child.kill("SIGTERM"); } catch { /* Already exited. */ } }
  // Ask only this fixture's authenticated owned listeners to drain, never a pid-only signal.
  if (managedRoot && existsSync(path.join(managedRoot, "state.json"))) {
    const installed = json(path.join(managedRoot, "state.json")).current.cli.root;
    await run(process.execPath, ["--input-type=module", "-e", `
      import fs from 'node:fs'; import path from 'node:path';
      const {queryGatewayIdentity}=await import(${JSON.stringify(pathToFileURL(path.join(installed, "dist/core/gateway/update-identity.js")).href)});
      const directory=${JSON.stringify(path.join(managedRoot, "gateways"))};
      if(fs.existsSync(directory))for(const name of fs.readdirSync(directory)){
        const record=JSON.parse(fs.readFileSync(path.join(directory,name),'utf8'));
        await queryGatewayIdentity(record,true);
      }
    `], { timeout: 15_000 });
  }
  await new Promise<void>((resolve) => upstream ? upstream.close(() => resolve()) : resolve());
  if (fixture && !keep) rmSync(fixture, { recursive: true, force: true });
});

async function until(check: () => boolean, timeout = 20_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Installed acceptance condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}
function json(file: string): any { return JSON.parse(readFileSync(file, "utf8")); }
function digest(file: string): string { return createHash("sha256").update(readFileSync(file)).digest("hex"); }

describe.skipIf(!enabled)("real packed public CLI managed lifecycle (public npm, isolated local fixtures)", () => {
  it("bootstraps the packed CLI when TMPDIR has a trailing separator", async () => {
    fixture = realpathSync(mkdtempSync(path.join(tmpdir(), "compaction-packed-installer-")));
    const home = path.join(fixture, "home"), config = path.join(home, ".compaction");
    const prefix = path.join(home, ".local"), scratch = path.join(fixture, "artifacts");
    const tmpTarget = path.join(fixture, "tmp-target"), tmpAlias = path.join(fixture, "tmp-alias");
    for (const dir of [home, config, prefix, scratch, tmpTarget]) mkdirSync(dir, { recursive: true, mode: 0o700 });
    symlinkSync(tmpTarget, tmpAlias);
    managedRoot = path.join(config, "managed");
    const env: NodeJS.ProcessEnv = {
      HOME: home, COMPACTION_HOME: config, COMPACTION_CONFIG_DIR: config,
      COMPACTION_PREFIX: prefix, COMPACTION_AUTO_UPDATE: "0", COMPACTION_NO_ONBOARD: "1", CI: "1", NO_COLOR: "1",
      PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, TMPDIR: `${tmpAlias}${path.sep}`
    };
    const packed = JSON.parse((await run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", scratch],
      { cwd: project, env, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 })).stdout)[0];
    const artifact = path.join(scratch, packed.filename), installer = path.join(fixture, "install.sh");
    cpSync(path.join(project, "scripts/install.sh"), installer);
    const installed = await run("/bin/bash", [installer], { env: { ...env, COMPACTION_VERSION: "0.6.8",
      COMPACTION_LOCAL_ARTIFACT: artifact, COMPACTION_LOCAL_SHA256: digest(artifact) }, timeout: 240_000 });
    const launcher = path.join(prefix, "bin/compaction");
    expect(installed.stdout).toContain(`Installed Compaction 0.6.8: ${launcher}`);
    expect(existsSync(launcher)).toBe(true);
    expect((await run(launcher, ["--version"], { env })).stdout.trim()).toBe("0.6.8");
    expect(json(path.join(managedRoot, "state.json"))).toMatchObject({ current: { cli: { version: "0.6.8", source: "local-artifact" } } });
  }, 240_000);

  it("preserves A on failed acquisition, pins live sessions, updates the runtime, and rolls back the exact previous release", async () => {
    fixture = realpathSync(mkdtempSync(path.join(tmpdir(), "compaction-packed-update-")));
    const home = path.join(fixture, "home"), config = path.join(home, ".compaction");
    const cwd = path.join(fixture, "unrelated-project"), prefix = path.join(home, ".local");
    const realbin = path.join(fixture, "realbin"), scratch = path.join(fixture, "artifacts");
    for (const dir of [home, config, cwd, realbin, scratch]) mkdirSync(dir, { recursive: true, mode: 0o700 });
    managedRoot = path.join(config, "managed");
    const launcher = path.join(prefix, "bin/compaction");
    const shim = path.join(config, "shims/claude");
    const env: NodeJS.ProcessEnv = {
      HOME: home, COMPACTION_HOME: config, COMPACTION_CONFIG_DIR: config,
      COMPACTION_PREFIX: prefix, COMPACTION_AUTO_UPDATE: "0", COMPACTION_NO_ONBOARD: "1", CI: "1", NO_COLOR: "1",
      PATH: `${path.join(config, "shims")}:${path.join(prefix, "bin")}:${realbin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
      TMPDIR: fixture, SHELL: "/bin/bash"
    };
    let upstreamCalls = 0;
    upstream = http.createServer((_req, res) => { upstreamCalls++; res.writeHead(500); res.end("unused local fixture"); });
    await new Promise<void>((resolve) => upstream!.listen(0, "127.0.0.1", resolve));
    env.COMPACTION_GATEWAY_UPSTREAM = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;

    // npm's actual public files allowlist, then version metadata changed ONLY in temporary
    // extracted copies. The compiled CLI, hooks, updater, runtime and Gateway bytes are untouched.
    const packed = JSON.parse((await run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", scratch],
      { cwd: project, env, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 })).stdout)[0];
    const base = path.join(scratch, packed.filename);
    const files = (await run("/usr/bin/tar", ["-tzf", base], { env })).stdout.trim().split("\n");
    expect(files).toContain("package/dist/cli/index.js");
    expect(files).toContain("package/dist/core/update/bootstrap.js");
    expect(files).toContain("package/dist/core/gateway/update-identity.js");
    expect(files.some((file) => /package\/(src|tests|dist\/engine)\//.test(file))).toBe(false);
    const versions = ["0.6.8-acceptance.a", "0.6.8-acceptance.b", "0.6.8-acceptance.c"];
    const artifacts: Array<{ version: string; artifact: string; sha256: string }> = [];
    for (const version of versions) {
      const directory = path.join(scratch, version); mkdirSync(directory);
      await run("/usr/bin/tar", ["-xzf", base, "-C", directory], { env });
      const manifest = path.join(directory, "package/package.json"), pkg = json(manifest);
      pkg.version = version; pkg.compactionRelease.cliVersion = version;
      writeFileSync(manifest, `${JSON.stringify(pkg, null, 2)}\n`);
      const artifact = path.join(scratch, `${version}.tgz`);
      await run("/usr/bin/tar", ["-czf", artifact, "-C", directory, "package"], { env });
      artifacts.push({ version, artifact, sha256: digest(artifact) });
    }
    const installer = path.join(fixture, "install.sh"); cpSync(path.join(project, "scripts/install.sh"), installer);
    const install = async (candidate: typeof artifacts[number]) => run("/bin/bash", [installer], {
      cwd, env: { ...env, COMPACTION_VERSION: candidate.version,
        COMPACTION_LOCAL_ARTIFACT: candidate.artifact, COMPACTION_LOCAL_SHA256: candidate.sha256 },
      timeout: 240_000, maxBuffer: 4 * 1024 * 1024
    });
    const cli = (args: string[], input?: string, extraEnv: NodeJS.ProcessEnv = {}) => new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
      const child = execFile(launcher, args, { cwd, env: { ...env, ...extraEnv }, timeout: 30_000 }, (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") reject(error);
        else resolve({ stdout, stderr, code: error ? error.code as number : 0 });
      });
      child.stdin?.end(input ?? "");
    });
    const installed = await install(artifacts[0]);
    expect(installed.stdout).toContain(versions[0]);
    const a = json(path.join(managedRoot, "state.json")).current;
    expect(a.cli.version).toBe(versions[0]); expect(a.engine).toEqual({ mode: "basic" });
    expect(a.cli.source).toBe("local-artifact"); expect(a.cli.provenance).toBe("local-artifact");
    expect(a.cli.installRoot.startsWith(managedRoot + "/releases/")).toBe(true);
    expect(existsSync(path.join(a.cli.installRoot, "node_modules/commander/package.json"))).toBe(true);
    expect((await cli(["--version"])).stdout.trim()).toBe(versions[0]);

    const ready = path.join(fixture, "ready.json"), restart = path.join(fixture, "restart"), restarted = path.join(fixture, "restarted.json"), finish = path.join(fixture, "finish");
    const realTool = path.join(realbin, "claude");
    writeFileSync(realTool, `#!${process.execPath}
const fs=require('node:fs'),cp=require('node:child_process'),net=require('node:net');
if(process.argv.includes('--version')||process.argv.includes('--help')){console.log('controlled tool fixture');process.exit(0);}
const cli=(args,input='')=>cp.execFileSync(process.env.COMPACTION_BIN,args,{input,encoding:'utf8'}).trim();
function nativeHook(){const settings=JSON.parse(fs.readFileSync(${JSON.stringify(path.join(home, ".claude/settings.json"))},'utf8'));
 const command=settings.hooks.Stop.flatMap(group=>group.hooks).find(hook=>hook.command.includes('compaction capture claude-code --from-hook')).command;
 return cp.execFileSync('/bin/bash',['-c',command],{input:'{}',encoding:'utf8'}).trim();}
function routing(){const status=JSON.parse(cli(['gateway','status','--json']));return status.routing.find(route=>route.provider==='anthropic');}
function processAlive(pid){try{process.kill(pid,0);return true;}catch{return false;}}
function listenerLive(base){return new Promise(resolve=>{const url=new URL(base),socket=net.createConnection({host:url.hostname,port:Number(url.port)});
 let settled=false;const finish=value=>{if(settled)return;settled=true;socket.destroy();resolve(value);};
 socket.once('connect',()=>finish(true));socket.once('error',()=>finish(false));socket.setTimeout(250,()=>finish(false));});}
async function waitRoutingGone(route){const deadline=Date.now()+10000;
 while(processAlive(route.pid)||await listenerLive(route.base)){if(Date.now()>=deadline)throw Error('routing gateway did not stop');await new Promise(resolve=>setTimeout(resolve,30));}}
function report(extra={}){const gateway=JSON.parse(cli(['gateway','ensure','--provider','anthropic','--json']));return {version:cli(['--version']),hook:cli(['hooks','line','codex'],'{}'),nativeHook:nativeHook(),pin:process.env.COMPACTION_SESSION_PIN,
 base:process.env.ANTHROPIC_BASE_URL,gateway,routing:routing(),args:process.argv.slice(2),...extra};}
fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify(report()));
let done=false; const timer=setInterval(()=>{
 if(!done&&fs.existsSync(${JSON.stringify(restart)})){done=true;(async()=>{const old=routing();cli(['gateway','stop','--routing']);await waitRoutingGone(old);
  const routingStopped={pid:old.pid,base:old.base,pidGone:!processAlive(old.pid),listenerGone:!(await listenerLive(old.base))};
  fs.writeFileSync(${JSON.stringify(restarted)},JSON.stringify(report({routingStopped})));})().catch(error=>{process.stderr.write(String(error));process.exit(19);});}
 if(fs.existsSync(${JSON.stringify(finish)})){clearInterval(timer);process.stderr.write('fixture tool stderr retained\\n');process.exit(17);}
},30);
`); chmodSync(realTool, 0o755);
    // Exercise the packed generator and migration implementation, not a hand-written shim.
    const module = pathToFileURL(path.join(a.cli.root, "dist/core/tool-shim.js")).href;
    await run(process.execPath, ["--input-type=module", "-e", `
      import fs from 'node:fs'; const m=await import(${JSON.stringify(module)});
      const result=m.installToolShim('claude-code');
      if(!['installed-active','installed-not-on-path'].includes(result.status))throw Error(result.status);
      fs.writeFileSync(result.shimPath,m.generateShimScript('claude-code',result.realBin));
    `], { env, cwd });
    const oldShim = readFileSync(shim, "utf8");
    await run(process.execPath, ["--input-type=module", "-e", `
      const m=await import(${JSON.stringify(pathToFileURL(path.join(a.cli.root, "dist/core/update/migrations.js")).href)});
      await m.migrateOwnedIntegrations(${JSON.stringify(managedRoot)});
    `], { env, cwd });
    expect(readFileSync(shim, "utf8")).toContain("COMPACTION_MANAGED_SESSION_V1");
    const migration = json(path.join(managedRoot, "migrations", readdirSync(path.join(managedRoot, "migrations"))[0]));
    expect(readFileSync(migration.entries[0].backup, "utf8")).toBe(oldShim);
    expect(statSync(migration.entries[0].backup).mode & 0o777).toBe(0o600);
    expect(await cli(["init", "--connect", "claude-code", "--user", "--no-write-shell-config", "--static"])).toMatchObject({ code: 0 });
    const settings = path.join(home, ".claude/settings.json"), record = path.join(config, "shims/.shim-record.json");
    const snapshots = [settings, shim, record].map((file) => ({ file, bytes: readFileSync(file) }));
    const preferences = path.join(config, "preferences.json"), preferenceValues = json(preferences);
    expect(readFileSync(settings, "utf8")).toContain("compaction capture claude-code --from-hook");
    expect(readFileSync(settings, "utf8")).not.toContain("releases/");

    const initialState = readFileSync(path.join(managedRoot, "state.json"));
    const launcherBytes = readFileSync(launcher);
    const assertUnchangedA = async () => {
      expect(readFileSync(path.join(managedRoot!, "state.json"))).toEqual(initialState);
      expect(readFileSync(launcher)).toEqual(launcherBytes);
      expect((await cli(["--version"])).stdout.trim()).toBe(versions[0]);
      for (const [file, sha256] of Object.entries(a.cli.files)) expect(digest(path.join(a.cli.installRoot, file))).toBe(sha256);
      for (const snapshot of snapshots) expect(readFileSync(snapshot.file)).toEqual(snapshot.bytes);
      expect(json(preferences)).toEqual(preferenceValues);
    };
    // Deliberately invalid local artifacts exercise the real installed acquisition guards.
    // These are not published releases, and they do not establish registry authenticity.
    await expect(install({ ...artifacts[1], sha256: "0".repeat(64) })).rejects.toThrow();
    await assertUnchangedA();
    for (const failure of ["compatibility", "smoke"] as const) {
      const directory = path.join(scratch, `bad-${failure}`); mkdirSync(directory);
      await run("/usr/bin/tar", ["-xzf", artifacts[1].artifact, "-C", directory], { env });
      if (failure === "compatibility") {
        const manifest = path.join(directory, "package/package.json"), pkg = json(manifest);
        pkg.compactionRelease.engineProtocol = 44;
        writeFileSync(manifest, `${JSON.stringify(pkg, null, 2)}\n`);
      } else {
        // A deliberately broken entrypoint must fail the real installed package smoke.
        writeFileSync(path.join(directory, "package/dist/cli/index.js"), "process.exitCode = 23;\n");
      }
      const artifact = path.join(scratch, `bad-${failure}.tgz`);
      await run("/usr/bin/tar", ["-czf", artifact, "-C", directory, "package"], { env });
      await expect(install({ version: versions[1], artifact, sha256: digest(artifact) })).rejects.toThrow();
      await assertUnchangedA();
    }

    const coveredVersion = async (label: string) => {
      const directory = path.join(fixture!, `coverage-${label}`); mkdirSync(directory);
      const result = await cli(["--version"], undefined, { NODE_V8_COVERAGE: directory });
      expect(result.code).toBe(0);
      const scripts = readdirSync(directory).filter(file => file.endsWith(".json")).flatMap(file => json(path.join(directory, file)).result);
      const executed = (root: string, module: string, name: string) => scripts.some(script =>
        script.url === pathToFileURL(path.join(root, "dist", module)).href &&
        script.functions.some((fn: { functionName: string; ranges: Array<{ count: number }> }) =>
          fn.functionName === name && fn.ranges.some(range => range.count > 0)));
      return { result, executed };
    };

    const child = spawn(shim, ["literal space", "--fixture"], { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child); let stderr = "", stdout = "";
    child.stderr!.on("data", (data) => { stderr += data; }); child.stdout!.on("data", (data) => { stdout += data; });
    const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
    await until(() => existsSync(ready)); const first = json(ready);
    expect(first).toMatchObject({ version: versions[0], hook: "{}", args: ["literal space", "--fixture"],
      routing: { live: true, provider: "anthropic" } });
    expect(first.gateway).toMatchObject({ status: "reused" });
    // An empty Stop fixture intentionally exercises the existing content-free missing-transcript
    // diagnostic. Preserve that actual hook output across update; it is not an updater notice.
    expect(first.nativeHook).toContain("no transcript_path");
    expect(first.pin).toMatch(/^[0-9a-f-]{36}$/); expect(first.base).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const gatewayRecords = () => readdirSync(path.join(managedRoot!, "gateways")).map((name) => json(path.join(managedRoot!, "gateways", name)));
    expect(gatewayRecords()).toHaveLength(1);
    const firstGateway = gatewayRecords()[0]; expect(firstGateway.release).toMatchObject({ pairId: a.id, cliVersion: versions[0] });
    expect(first.routing).toMatchObject({ pid: firstGateway.pid, base: first.base });

    const staged = await install(artifacts[1]); expect(staged.stdout).toContain(versions[1]);
    const before = json(path.join(managedRoot, "state.json")), b = before.staged;
    expect(before.current.id).toBe(a.id); expect(b.cli.version).toBe(versions[1]);
    expect((await cli(["--version"])).stdout.trim()).toBe(versions[0]);
    writeFileSync(restart, "go"); await until(() => existsSync(restarted));
    const afterRestart = json(restarted);
    expect(afterRestart).toMatchObject({ version: versions[0], hook: "{}", nativeHook: first.nativeHook, pin: first.pin,
      routingStopped: { pid: first.routing.pid, base: first.routing.base, pidGone: true, listenerGone: true },
      routing: { live: true, provider: "anthropic", base: first.routing.base } });
    expect(afterRestart.routing.pid).not.toBe(first.routing.pid);
    expect(gatewayRecords()).toHaveLength(1);
    expect(gatewayRecords()[0].release).toMatchObject({ pairId: a.id, cliVersion: versions[0] });
    expect(gatewayRecords()[0]).toMatchObject({ pid: afterRestart.routing.pid, host: firstGateway.host, port: firstGateway.port });
    expect(gatewayRecords()[0].release.instanceId).not.toBe(firstGateway.release.instanceId);
    expect(json(path.join(managedRoot, "state.json")).current.id).toBe(a.id);
    writeFileSync(finish, "done"); expect(await exited).toBe(17);
    expect(stdout).toBe(""); expect(stderr).toBe("fixture tool stderr retained\n");

    // No explicit activation API or fake barrier: the next real stable command drains idle A.
    const toB = await coveredVersion("a-to-b");
    expect(toB.result.stdout.trim()).toBe(versions[1]);
    expect(toB.executed(a.cli.root, "core/update/activation.js", "tryActivate")).toBe(true);
    for (const [module, name] of [["core/update/scheduler.js", "maybeScheduleUpdate"], ["core/update/sessions.js", "runManagedSession"]]) {
      expect(toB.executed(a.cli.root, module, name), `${name} must not use A after switching to B`).toBe(false);
      expect(toB.executed(b.cli.root, module, name), `${name} must use B in the first B invocation`).toBe(true);
    }
    expect(json(path.join(managedRoot, "state.json"))).toMatchObject({ current: { id: b.id }, previous: { id: a.id } });

    // Version metadata alone cannot prove the updater itself changed implementation.
    const onB = await coveredVersion("b");
    expect(onB.result.stdout.trim()).toBe(versions[1]);
    for (const [module, name] of [["core/update/launcher.js", "launchManaged"], ["core/update/ownership.js", "loadManagedInstallation"],
      ["core/update/sessions.js", "runManagedSession"], ["core/update/scheduler.js", "maybeScheduleUpdate"]]) {
      expect(onB.executed(b.cli.root, module, name), `${module}:${name} must execute from B`).toBe(true);
    }
    // The installer's final version smoke is itself a safe launch. Keep an actual B session
    // open so C stays staged until the separate, covered activation invocation below.
    for (const marker of [ready, restart, restarted, finish]) if (existsSync(marker)) unlinkSync(marker);
    const heldB = spawn(shim, ["--fixture"], { env, cwd, stdio: "ignore" });
    children.push(heldB);
    const heldBExited = new Promise<number | null>(resolve => heldB.once("exit", resolve));
    await until(() => existsSync(ready));
    expect(json(ready)).toMatchObject({ version: versions[1], gateway: { status: "reused" } });
    const heldSessions = readdirSync(path.join(managedRoot, "sessions")).map((name) =>
      json(path.join(managedRoot!, "sessions", name)));
    expect(heldSessions).toHaveLength(1);
    expect(heldSessions[0].owners).toHaveLength(3);
    expect(heldSessions[0].processGroups).toHaveLength(1);
    await install(artifacts[2]);
    const c = json(path.join(managedRoot, "state.json")).staged;
    expect(c.cli.version).toBe(versions[2]);
    expect(json(path.join(managedRoot, "state.json")).current.id).toBe(b.id);
    writeFileSync(finish, "done"); expect(await heldBExited).toBe(17);
    expect(readdirSync(path.join(managedRoot, "sessions"))).toHaveLength(0);
    const cLauncher = path.join(c.cli.root, "dist/core/update/launcher.js"), verifiedLauncher = readFileSync(cLauncher);
    // Deliberate corruption of this test-owned staged fixture must never execute.
    writeFileSync(cLauncher, Buffer.concat([verifiedLauncher, Buffer.from("\nthrow new Error('corrupted fixture executed');\n")]));
    const rejected = await coveredVersion("tampered-c");
    expect(rejected.result.stdout.trim()).toBe(versions[1]);
    expect(rejected.executed(c.cli.root, "core/update/launcher.js", "launchManaged")).toBe(false);
    expect(json(path.join(managedRoot, "state.json"))).toMatchObject({ current: { id: b.id }, staged: { id: c.id } });
    writeFileSync(cLauncher, verifiedLauncher);
    const toC = await coveredVersion("b-to-c");
    expect(toC.result.stdout.trim()).toBe(versions[2]);
    expect(toC.executed(b.cli.root, "core/update/activation.js", "tryActivate")).toBe(true);
    expect(toC.executed(b.cli.root, "core/gateway/update-identity.js", "gatewayBarrier")).toBe(true);
    expect(toC.executed(b.cli.root, "core/update/sessions.js", "runManagedSession")).toBe(false);
    expect(toC.executed(c.cli.root, "core/update/sessions.js", "runManagedSession")).toBe(true);
    const onC = await coveredVersion("c");
    expect(onC.executed(c.cli.root, "core/update/launcher.js", "launchManaged")).toBe(true);
    expect((await cli(["update", "--rollback"])).code).toBe(0);
    expect((await cli(["--version"])).stdout.trim()).toBe(versions[1]);
    expect(json(path.join(managedRoot, "state.json"))).toMatchObject({ current: { id: b.id }, previous: { id: c.id }, rejectedPairIds: [c.id] });
    for (const snapshot of snapshots) expect(readFileSync(snapshot.file)).toEqual(snapshot.bytes);
    // A normal preferences write may reorder JSON keys; every stored value must survive.
    expect(json(preferences)).toEqual(preferenceValues);
    expect(upstreamCalls).toBe(0);
    // The generated launcher and every selected executable live in the isolated installed tree.
    expect(readFileSync(launcher, "utf8")).not.toContain(project);
    expect(JSON.stringify(json(path.join(managedRoot, "install.json")))).not.toContain(project);
    const evidence = { label: "controlled full public CLI artifacts; synthetic tool; zero provider requests", fixture,
      publicPack: { sha256: digest(base), files: files.length }, artifacts, pairA: a.id, pairB: b.id, pairC: c.id,
      assertions: ["SHA/compatibility/smoke failures preserve A", "owned migration", "stable native hook", "live session A", "Gateway restart A",
        "safe launch B with B admission", "B runtime execution", "tampered C never executes", "B coordinates C activation",
        "C runtime execution", "exact rollback B", "integration bytes and preference values retained"] };
    writeFileSync(path.join(fixture, "acceptance-evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
    console.log(JSON.stringify(evidence));
  }, 600_000);
});
