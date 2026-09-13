import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { createHmac } from "node:crypto";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createGatewayReleaseIdentity, gatewayBarrier, gatewayCliVersion, gatewayControlHandler, gatewayReleaseMatches, queryGatewayIdentity,
  registerGatewayInstance, GATEWAY_CONTROL_PATH } from "../../src/core/gateway/update-identity.js";
import { startGatewayServer, type StartedGateway } from "../../src/core/gateway/server.js";
import { readGatewaySettlementState, RUN_BOUNDARY_SCHEMA } from "../../src/core/gateway/run-boundary.js";
import { PendingBookkeeping } from "../../src/core/gateway/pending-bookkeeping.js";
import { ensureGateway } from "../../src/core/gateway/ensure.js";
import { resetRoutingPortSaltCache, routingSlotKey, routingSlotLockPath, writeRoutingSlot } from "../../src/core/gateway/routing-registry.js";
import { writeGatewayPid, type GatewayPidRecord } from "../../src/core/gateway/status.js";
import { runGatewayStart, type RunningGateway } from "../../src/cli/commands/gateway.js";
import { withManagedLock } from "../../src/core/update/state.js";

let root: string;
const closers: Array<() => Promise<void>> = [];
/**
 * The routing slot registry is USER-GLOBAL, so every `ensureGateway` call here must be pointed at
 * a temp Compaction home. Without it these tests would read and write the developer's real
 * `~/.compaction/routing`.
 */
const routingEnv = (): { COMPACTION_HOME: string } => ({ COMPACTION_HOME: path.join(root, "compaction-home") });
beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), "gateway-update-")); resetRoutingPortSaltCache(); });
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeIdleConnections(); }));
  return (server.address() as { port: number }).port;
}
async function gateway(upstream = "http://127.0.0.1:9", pairId = "pair-old"): Promise<{ started: StartedGateway; rec: GatewayPidRecord }> {
  const release = createGatewayReleaseIdentity(pairId);
  const started = await startGatewayServer({ provider: "openai", upstream, mode: "record", host: "127.0.0.1", port: 0,
    cwd: root, entitlementEnv: { COMPACTION_CONFIG_DIR: root }, releaseIdentity: release });
  closers.push(async () => { started.server.closeIdleConnections(); await started.close(); });
  const rec: GatewayPidRecord = { pid: process.pid, host: "127.0.0.1", port: started.address.port, upstream,
    provider: "openai", mode: "record", startedAt: new Date().toISOString(), release };
  const unregister = registerGatewayInstance(root, rec);
  started.server.once("close", unregister);
  writeGatewayPid(rec, root);
  return { started, rec };
}

function runGatewayCommand(): Promise<{ code: number; stdout: string; stderr: string }> {
  const cli = fileURLToPath(new URL("../../dist/cli/index.js", import.meta.url));
  return new Promise((resolve) => execFile(process.execPath, [cli, "gateway", "run", "--workflow", "none", "--",
    process.execPath, "-e", "process.stdout.write('synthetic-child-ran')"], {
    cwd: root, timeout: 10_000,
    env: { PATH: process.env.PATH, COMPACTION_CONFIG_DIR: path.join(root, "config") }
  }, (error, stdout, stderr) => resolve({ code: error ? Number(error.code) || 1 : 0, stdout, stderr })));
}

describe("authenticated Gateway update barrier", () => {
  it("reports content-free exact identity, stores capability privately, and drains an owned idle instance", async () => {
    const { rec } = await gateway();
    const status = await queryGatewayIdentity(rec);
    expect(status).toMatchObject({ pairId: "pair-old", instanceId: rec.release!.instanceId,
      cliVersion: rec.release!.cliVersion, protocolVersion: 1, activeRequests: 0, pendingBookkeeping: 0 });
    expect(JSON.stringify(status)).not.toContain(rec.release!.controlCapability);
    expect(Object.keys(status!).sort()).toEqual(["activeRequests", "cliVersion", "draining", "instanceId", "pairId",
      "pendingBookkeeping", "pid", "protocolVersion", "settlementUnknown", "unsettledClaude", "unsettledCodex", "unsettledRuns"].sort());
    expect(statSync(path.join(root, "gateways", `${rec.release!.instanceId}.json`)).mode & 0o777).toBe(0o600);
    expect(Object.keys(JSON.parse(readFileSync(path.join(root, "gateways", `${rec.release!.instanceId}.json`), "utf8"))).sort())
      .toEqual(["host", "pid", "port", "release"]);
    expect(statSync(path.join(root, ".compaction/gateway/gateway.json")).mode & 0o777).toBe(0o600);
    expect(await gatewayBarrier(root, "pair-old")).toEqual({ ok: true });
    expect(await queryGatewayIdentity(rec)).toBeUndefined();
  });

  it("rejects browser-origin, missing capability, wrong capability and instance mismatches without draining", async () => {
    const { rec } = await gateway();
    const base = `http://127.0.0.1:${rec.port}${GATEWAY_CONTROL_PATH}`;
    expect((await fetch(base, { method: "POST" })).status).toBe(404);
    const nonce = "a".repeat(48);
    const auth = createHmac("sha256", rec.release!.controlCapability).update(`POST:${rec.release!.instanceId}:${nonce}`).digest("hex");
    expect((await fetch(base, { method: "POST", headers: { origin: "https://foreign.invalid",
      "x-compaction-control": auth, "x-compaction-instance": rec.release!.instanceId, "x-compaction-nonce": nonce } })).status).toBe(404);
    expect(await queryGatewayIdentity({ ...rec, release: { ...rec.release!, controlCapability: "0".repeat(64) } }, true)).toBeUndefined();
    expect(await queryGatewayIdentity({ ...rec, release: { ...rec.release!, instanceId: "1".repeat(48) } }, true)).toBeUndefined();
    expect(await queryGatewayIdentity(rec)).toMatchObject({ draining: false });
  });

  it("keeps delayed provider traffic intact and defers until requests and bookkeeping finish", async () => {
    let finishProvider!: () => void;
    let sawRequest!: () => void;
    const seen = new Promise<void>((resolve) => { sawRequest = resolve; });
    const upstream = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => { finishProvider = () => res.end("unchanged-provider-response"); sawRequest(); });
    });
    const port = await listen(upstream);
    const { rec } = await gateway(`http://127.0.0.1:${port}`);
    const response = fetch(`http://127.0.0.1:${rec.port}/v1/responses`, { method: "POST", body: "{}" }).then((r) => r.text());
    await seen;
    expect(await queryGatewayIdentity(rec)).toMatchObject({ activeRequests: 1 });
    expect(await gatewayBarrier(root, "pair-old")).toMatchObject({ ok: false, reason: "gateway-busy-or-unsettled" });
    expect(await queryGatewayIdentity(rec, true)).toBeUndefined();
    finishProvider();
    expect(await response).toBe("unchanged-provider-response");
    for (let i = 0; i < 100; i++) {
      const state = await queryGatewayIdentity(rec);
      if (state?.activeRequests === 0 && state.pendingBookkeeping === 0) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(await gatewayBarrier(root, "pair-old")).toEqual({ ok: true });
  });

  it("a quiet HTTP gap with open logical runs or pending Codex/Claude publication blocks without changing state", async () => {
    const { rec } = await gateway();
    const correlation = "a".repeat(32);
    const directory = path.join(root, "runs");
    mkdirSync(directory);
    const target = path.join(directory, `${correlation}.json`);
    const body = JSON.stringify({ schema: RUN_BOUNDARY_SCHEMA, runs: [{ session_correlation_id: correlation,
      run_seq: 1, started_at: "2026-09-01T12:00:00.000Z", codex_settlement_pending: { pending: true } }],
      claude_provisional_pending: { phase: "open" } });
    writeFileSync(target, body);
    expect(await queryGatewayIdentity(rec)).toMatchObject({ activeRequests: 0, unsettledRuns: 1, unsettledCodex: 1, unsettledClaude: 1 });
    expect(await gatewayBarrier(root, "pair-old")).toMatchObject({ ok: false });
    expect(readFileSync(target, "utf8")).toBe(body);
    writeFileSync(target, "invalid-json");
    expect(readGatewaySettlementState({ COMPACTION_CONFIG_DIR: root }).settlementUnknown).toBe(true);
    expect(await queryGatewayIdentity(rec, true)).toBeUndefined();
  });

  it("rechecks pending bookkeeping atomically at drain, even after an earlier idle status", async () => {
    const release = createGatewayReleaseIdentity("pair-old");
    const pending = new PendingBookkeeping();
    const control = gatewayControlHandler(release, () => ({ activeRequests: 0, pendingBookkeeping: pending.size,
      unsettledRuns: 0, unsettledCodex: 0, unsettledClaude: 0, settlementUnknown: false }), () => server);
    const server = http.createServer((req, res) => control(req, res));
    const port = await listen(server);
    const rec: GatewayPidRecord = { pid: process.pid, host: "127.0.0.1", port, release,
      provider: "openai", mode: "record", upstream: "http://127.0.0.1:9", startedAt: new Date().toISOString() };
    expect(await queryGatewayIdentity(rec)).toMatchObject({ pendingBookkeeping: 0 });
    let finish!: () => void;
    pending.track(new Promise<void>((resolve) => { finish = resolve; }));
    expect(await queryGatewayIdentity(rec, true)).toBeUndefined();
    expect(server.listening).toBe(true);
    finish();
    await pending.drain();
    expect(await queryGatewayIdentity(rec, true)).toMatchObject({ draining: true });
  });

  it("a foreign listener or reused live PID with stale identity is never killed or replaced", async () => {
    const foreign = http.createServer((_req, res) => { res.end("foreign"); });
    const port = await listen(foreign);
    const rec: GatewayPidRecord = { pid: process.pid, host: "127.0.0.1", port, release: createGatewayReleaseIdentity("pair-old"),
      provider: "openai", mode: "record", upstream: "http://127.0.0.1:9", startedAt: new Date().toISOString() };
    registerGatewayInstance(root, rec);
    writeGatewayPid(rec, root);
    expect(await gatewayBarrier(root, "pair-old")).toMatchObject({ ok: false, reason: "gateway-identity-unverified" });
    // The listener cannot pass the identity handshake, so it is never adopted, never signalled, and
    // never handed to the shim. Ensure starts its OWN gateway elsewhere instead (here the spawn is
    // stubbed, so it simply reports unavailable) - the foreign process is left completely alone.
    let spawned = 0;
    const stubbedSpawn = { waitMs: 20, pollMs: 5, env: routingEnv(), spawnGatewayStart: () => { spawned += 1; } };
    expect(await ensureGateway({ cwd: root, provider: "openai", upstream: rec.upstream, ...stubbedSpawn }))
      .not.toMatchObject({ status: "reused" });
    expect(await (await fetch(`http://127.0.0.1:${port}`)).text()).toBe("foreign");
    writeGatewayPid({ ...rec, release: undefined }, root);
    expect(await ensureGateway({ cwd: root, provider: "openai", upstream: rec.upstream, ...stubbedSpawn }))
      .not.toMatchObject({ status: "reused" });
    expect(foreign.listening).toBe(true);
  });

  it("never steals an old ensure lock based on age alone", async () => {
    // The single-flight lock is PER ROUTING SLOT and lives beside the slot under the Compaction
    // home, not in the project tree - two projects no longer serialize against each other by
    // accident. The rule it enforces is unchanged: elapsed time is not proof the owner died, so an
    // ambiguous lock stays held and the loser never spawns.
    const lock = routingSlotLockPath(routingSlotKey({ cwd: root, provider: "openai" }, routingEnv()), routingEnv());
    mkdirSync(lock, { recursive: true });
    utimesSync(lock, new Date(0), new Date(0));
    let spawned = false;
    const result = await ensureGateway({ cwd: root, provider: "openai", upstream: "http://127.0.0.1:9", env: routingEnv(),
      waitMs: 20, pollMs: 5, spawnGatewayStart: () => { spawned = true; } });
    expect(result.status).toBe("unavailable");
    expect(spawned).toBe(false);
    expect(statSync(lock).isDirectory()).toBe(true);
  });

  it("matches authenticated CLI/protocol/pair identity exactly before reuse", async () => {
    const { rec } = await gateway();
    const identity = (await queryGatewayIdentity(rec))!;
    expect(gatewayReleaseMatches(identity, "pair-old")).toBe(true);
    expect(gatewayReleaseMatches(identity, "pair-new")).toBe(false);
    expect(gatewayReleaseMatches({ ...identity, cliVersion: "0.0.0" }, "pair-old")).toBe(false);
    expect(gatewayReleaseMatches({ ...identity, protocolVersion: 999 }, "pair-old")).toBe(false);
    expect(gatewayReleaseMatches({ ...identity, draining: true }, "pair-old")).toBe(false);
    expect(gatewayReleaseMatches(undefined, "pair-old")).toBe(false);
  });

  it("checks every globally registered Gateway before draining any idle instance", async () => {
    const idle = await gateway();
    let finishProvider!: () => void;
    let sawRequest!: () => void;
    const seen = new Promise<void>((resolve) => { sawRequest = resolve; });
    const upstream = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => { finishProvider = () => res.end("busy-gateway-response"); sawRequest(); });
    });
    const port = await listen(upstream);
    const busy = await gateway(`http://127.0.0.1:${port}`);
    const response = fetch(`http://127.0.0.1:${busy.rec.port}/v1/responses`, { method: "POST", body: "{}" }).then((r) => r.text());
    await seen;
    try {
      expect(await gatewayBarrier(root, "pair-old")).toMatchObject({ ok: false, reason: "gateway-busy-or-unsettled" });
      expect(await queryGatewayIdentity(idle.rec)).toMatchObject({ draining: false });
      expect(await queryGatewayIdentity(busy.rec)).toMatchObject({ activeRequests: 1, draining: false });
    } finally {
      finishProvider();
      await response;
    }
  });

  it("Gateway admission waits for the shared activation lock before listening and registration", async () => {
    vi.stubEnv("COMPACTION_CONFIG_DIR", root);
    vi.stubEnv("COMPACTION_HOME", "");
    vi.stubEnv("COMPACTION_SESSION_PIN", "");
    const managedRoot = path.join(root, "managed");
    let launching!: Promise<RunningGateway>;
    let admitted = false;
    await withManagedLock(managedRoot, async () => {
      launching = runGatewayStart({ provider: "openai", upstream: "http://127.0.0.1:9", mode: "record",
        host: "127.0.0.1", port: 0, cwd: root, installSignals: false, log: () => {} });
      void launching.then(() => { admitted = true; });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(admitted).toBe(false);
      expect(existsSync(path.join(managedRoot, "gateways"))).toBe(false);
      expect(existsSync(path.join(root, ".compaction/gateway/gateway.json"))).toBe(false);
    });
    const started = await launching;
    closers.push(started.close);
    expect(admitted).toBe(true);
    expect(existsSync(path.join(managedRoot, "gateways"))).toBe(true);
  });

  it("gateway run reuses only the matching release and safely replaces a stale idle release", async () => {
    const { started } = await gateway("http://127.0.0.1:9", `external:${gatewayCliVersion()}`);
    const reused = await runGatewayCommand();
    expect(reused.code).toBe(0);
    expect(reused.stderr).toContain("reusing the running gateway");
    expect(reused.stdout).toContain("synthetic-child-ran");
    expect(started.server.listening).toBe(true);
    await started.close();
    const stale = await gateway();
    const replaced = await runGatewayCommand();
    expect(replaced.code).toBe(0);
    expect(replaced.stderr).toContain("started a local gateway");
    expect(replaced.stdout).toContain("synthetic-child-ran");
    expect(stale.started.server.listening).toBe(false);
  });

  it("gateway run leaves an old active or unverified listener untouched and does not run its child", async () => {
    let finishProvider!: () => void;
    let sawRequest!: () => void;
    const seen = new Promise<void>((resolve) => { sawRequest = resolve; });
    const upstream = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => { finishProvider = () => res.end("old-release-response"); sawRequest(); });
    });
    const port = await listen(upstream);
    const { rec, started } = await gateway(`http://127.0.0.1:${port}`);
    const response = fetch(`http://127.0.0.1:${rec.port}/v1/responses`, { method: "POST", body: "{}" }).then((r) => r.text());
    await seen;
    const deferred = await runGatewayCommand();
    expect(deferred.code).toBe(1);
    expect(deferred.stderr).toContain("replacement deferred");
    expect(deferred.stdout).not.toContain("synthetic-child-ran");
    expect(started.server.listening).toBe(true);
    finishProvider();
    expect(await response).toBe("old-release-response");
    writeGatewayPid({ ...rec, release: undefined }, root);
    const unverified = await runGatewayCommand();
    expect(unverified.code).toBe(1);
    expect(unverified.stderr).toContain("replacement deferred");
    expect(started.server.listening).toBe(true);
  });

  it("a new admitted pair gets a fresh owned Gateway only after the old idle identity drains", async () => {
    const { rec, started } = await gateway();
    let replacement: Promise<unknown> | undefined;
    const result = await ensureGateway({ cwd: root, provider: "openai", upstream: rec.upstream,
      releasePairId: "pair-new", waitMs: 2000, pollMs: 10, env: routingEnv(),
      // The stand-in for the detached start must own the ROUTING SLOT it was handed, exactly as a
      // real `gateway start --routing-slot <key>` does - that record is what ensure polls for.
      spawnGatewayStart: (args) => {
        const slotKey = args[args.indexOf("--routing-slot") + 1];
        replacement = gateway(rec.upstream, "pair-new").then((fresh) => {
          writeRoutingSlot(slotKey, {
            release: fresh.rec.release!, pid: fresh.rec.pid, host: fresh.rec.host, port: fresh.rec.port,
            reservedPort: fresh.rec.port, upstream: fresh.rec.upstream, provider: fresh.rec.provider,
            mode: fresh.rec.mode, cwd: root, startedAt: fresh.rec.startedAt
          }, routingEnv());
          return fresh;
        });
      } });
    await replacement;
    expect(result.status).toBe("started");
    expect(started.server.listening).toBe(false);
    expect(result.status === "started" && result.base).not.toBe(`http://127.0.0.1:${rec.port}`);
  });

  it("a disconnected client cannot hide upstream work still awaiting a response", async () => {
    let finishProvider!: () => void;
    let sawRequest!: () => void;
    const seen = new Promise<void>((resolve) => { sawRequest = resolve; });
    const upstream = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => { finishProvider = () => res.destroy(); sawRequest(); });
    });
    const port = await listen(upstream);
    const { rec } = await gateway(`http://127.0.0.1:${port}`);
    const client = http.request(`http://127.0.0.1:${rec.port}/v1/responses`, { method: "POST" });
    client.on("error", () => {});
    client.end("{}");
    await seen;
    client.destroy();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await queryGatewayIdentity(rec)).toMatchObject({ activeRequests: 1 });
    expect(await queryGatewayIdentity(rec, true)).toBeUndefined();
    finishProvider();
  });
});
