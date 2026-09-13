import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import http from "node:http";
import net from "node:net";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ensureGateway, isGatewayReachable } from "../../src/core/gateway/ensure.js";
import { reviveRoutingGatewayIfDown } from "../../src/core/gateway/routing-revival.js";
import { isProcessAlive, readGatewayPid } from "../../src/core/gateway/status.js";
import {
  readRoutingSlot,
  resetRoutingPortSaltCache,
  routingSlotKey,
  writeRoutingSlot
} from "../../src/core/gateway/routing-registry.js";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const CLI_DIST = path.join(REPO_ROOT, "dist/cli/index.js");

/**
 * OWNERSHIP: project/dev cleanup CANNOT reach the endpoint a live tool session depends on.
 *
 * This is acceptance row 9. It lives in its own file rather than extending
 * `gateway-lifecycle-ownership.test.ts` because that file module-mocks
 * `src/core/gateway/server.js` at import scope, so no real gateway process can exist in it - and the
 * whole claim here is about which REAL process survives a real signal.
 */
let root = "";
let home = "";
let projDir = "";
let env: { COMPACTION_HOME: string };
let upstream: http.Server | undefined;
let upstreamUrl = "";
const savedEnv: Record<string, string | undefined> = {};
const startedPids: number[] = [];

function setEnv(key: string, value: string): void {
  savedEnv[key] = process.env[key];
  process.env[key] = value;
}

function freeLocalPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => resolve(port));
    });
  });
}

async function waitFor(check: () => boolean | Promise<boolean>, ms = 8000): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await check()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 80));
  }
}

beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), "routing-stop-ownership-"));
  home = path.join(root, "home");
  projDir = path.join(root, "proj");
  mkdirSync(home, { recursive: true });
  mkdirSync(projDir, { recursive: true });
  env = { COMPACTION_HOME: path.join(home, ".compaction") };
  resetRoutingPortSaltCache();
  setEnv("HOME", home);
  setEnv("COMPACTION_HOME", env.COMPACTION_HOME);

  upstream = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((r) => upstream!.listen(0, "127.0.0.1", () => r()));
  upstreamUrl = `http://127.0.0.1:${(upstream!.address() as { port: number }).port}`;
});

afterEach(async () => {
  for (const pid of startedPids) {
    if (pid > 0 && isProcessAlive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }
  startedPids.length = 0;
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetRoutingPortSaltCache();
  if (upstream) await new Promise<void>((r) => upstream!.close(() => r()));
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("project/dev cleanup cannot kill routing", () => {
  it("`gateway stop` in the project leaves the routing endpoint alive", async () => {
    // The ROUTING gateway: user-global slot, reserved port.
    const routing = await ensureGateway({ provider: "anthropic", upstream: upstreamUrl, cwd: projDir, cliEntry: CLI_DIST, env });
    expect(routing.status).toBe("started");
    const key = routingSlotKey({ cwd: projDir, provider: "anthropic" }, env);
    const slot = readRoutingSlot(key, env)!;
    expect(slot).not.toBeNull();
    startedPids.push(slot.pid);

    // A PROJECT gateway in the SAME directory: the cwd pidfile, exactly what `gateway stop` acts on.
    // `--listen` needs a concrete port (`parseListen` rejects 0), so take a free one first.
    const projectPort = await freeLocalPort();
    const project = execFile(process.execPath, [
      CLI_DIST, "gateway", "start", "--provider", "openai", "--upstream", upstreamUrl,
      "--listen", `http://127.0.0.1:${projectPort}`, "--mode", "record", "--workflow", "none"
    ], { cwd: projDir, env: process.env });
    expect(await waitFor(() => readGatewayPid(projDir) !== null)).toBe(true);
    const projectRec = readGatewayPid(projDir)!;
    startedPids.push(projectRec.pid);
    // The two really are different processes, so the assertion below is not vacuous.
    expect(projectRec.pid).not.toBe(slot.pid);

    await execFileAsync(process.execPath, [CLI_DIST, "gateway", "stop"], { cwd: projDir, env: process.env });

    expect(await waitFor(() => !isProcessAlive(projectRec.pid))).toBe(true);
    // The routing endpoint is untouched: same pid, still listening, slot still present.
    expect(isProcessAlive(slot.pid)).toBe(true);
    expect(await isGatewayReachable(slot.host, slot.reservedPort, 800)).toBe(true);
    expect(readRoutingSlot(key, env)).not.toBeNull();
    project.kill("SIGKILL");
  }, 90_000);

  it("`gateway stop --routing` removes the slot first, then stops it, and nothing revives it", async () => {
    const routing = await ensureGateway({ provider: "anthropic", upstream: upstreamUrl, cwd: projDir, cliEntry: CLI_DIST, env });
    expect(routing.status).toBe("started");
    const key = routingSlotKey({ cwd: projDir, provider: "anthropic" }, env);
    const slot = readRoutingSlot(key, env)!;
    startedPids.push(slot.pid);

    const stop = await execFileAsync(process.execPath, [CLI_DIST, "gateway", "stop", "--routing"], { cwd: projDir, env: process.env });
    expect(stop.stdout).toContain("removed the routing slot");
    expect(await waitFor(() => !isProcessAlive(slot.pid))).toBe(true);
    expect(readRoutingSlot(key, env)).toBeNull();

    const spawns: string[][] = [];
    const outcome = await reviveRoutingGatewayIfDown(projDir, { wait: true, env, spawnGatewayStart: (args) => spawns.push(args) });
    expect(outcome.status).toBe("no-slot");
    expect(spawns).toHaveLength(0);
  }, 90_000);
});

describe("apply-routing (workflow-scoped) slots are revived on the same terms as plain ones", () => {
  it("revives a workflow-scoped routing slot at its reserved port", async () => {
    // The routing gateway observed in the real incident carried `--workflow claude-code` (the
    // apply-routing opt-in), not a plain record gateway, so the workflow-scoped path is the one that
    // actually has to survive. Its slot key differs from the plain one, and revival must find it.
    const key = routingSlotKey({ cwd: projDir, provider: "anthropic", workflow: "claude-code" }, env);
    expect(key).not.toBe(routingSlotKey({ cwd: projDir, provider: "anthropic" }, env));

    // A slot whose recorded owner is gone and whose reserved port refuses.
    const deadPort = 20481;
    writeRoutingSlot(
      key,
      {
        pid: 999_999_998,
        host: "127.0.0.1",
        port: deadPort,
        reservedPort: deadPort,
        provider: "anthropic",
        upstream: upstreamUrl,
        mode: "record",
        workflow: "claude-code",
        cwd: projDir,
        startedAt: new Date().toISOString()
      },
      env
    );

    const spawns: string[][] = [];
    const outcome = await reviveRoutingGatewayIfDown(projDir, {
      wait: true,
      budgetMs: 300,
      env,
      spawnGatewayStart: (args) => spawns.push(args)
    });
    // It found the workflow-scoped slot and started a replacement on the SAME reserved port, with
    // the workflow identity carried through so the replacement is the same shape as what died.
    expect(spawns).toHaveLength(1);
    expect(spawns[0]).toContain("--routing-slot");
    expect(spawns[0][spawns[0].indexOf("--routing-slot") + 1]).toBe(key);
    expect(spawns[0]).toContain(`http://127.0.0.1:${deadPort}`);
    expect(spawns[0][spawns[0].indexOf("--workflow") + 1]).toBe("claude-code");
    // The injected spawner starts nothing, so the poll times out - the assertion above is about
    // WHAT was requested, which is the part the revival owns.
    expect(outcome.status).toBe("failed");
  }, 30_000);

  it("does nothing at all for a directory that was never routed", async () => {
    const spawns: string[][] = [];
    const outcome = await reviveRoutingGatewayIfDown(path.join(root, "never-routed"), {
      wait: true,
      env,
      spawnGatewayStart: (args) => spawns.push(args)
    });
    // The slot-existence gate is the first thing the function does: no slot, no probe, no spawn.
    // This runs for EVERY Claude Code session on the machine, including unrouted ones.
    expect(outcome.status).toBe("no-slot");
    expect(spawns).toHaveLength(0);
    expect(existsSync(path.join(root, "never-routed"))).toBe(false);
  });
});
