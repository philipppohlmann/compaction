import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { Command } from "commander";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runGatewayStart, registerGatewayCommand, type RunningGateway } from "../../src/cli/commands/gateway.js";
import { ensureGateway } from "../../src/core/gateway/ensure.js";
import { probeListening } from "../../src/core/gateway/status.js";

/**
 * Idle auto-shutdown LIFECYCLE through the real CLI start path (`runGatewayStart`): the routing
 * gateway's clean self-stop must remove its own pidfile (start-or-reuse never sees a dead gateway
 * as live), the next `ensure` must transparently start a FRESH gateway that works, and an explicit
 * `gateway start` WITHOUT --idle-ttl must stay long-lived (the user's gateway is theirs to manage).
 * No real network: the upstream is a local fake; the restarted gateway runs in-process (async).
 */

let cwd: string;
let upstream: { port: number; close: () => Promise<void> };
let running: RunningGateway[] = [];

function startFakeUpstream(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "fake", usage: { input_tokens: 2, output_tokens: 1 } }));
    });
  });
  return new Promise((r) =>
    server.listen(0, "127.0.0.1", () =>
      r({
        port: (server.address() as { port: number }).port,
        close: () => new Promise((c) => server.close(() => c(undefined)))
      })
    )
  );
}

async function waitFor(cond: () => Promise<boolean> | boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return cond();
}

function pidfile(): string {
  return path.join(cwd, ".compaction", "gateway", "gateway.json");
}

function startViaCli(config: { idleTtlMs?: number; port?: number }): Promise<RunningGateway> {
  return runGatewayStart({
    provider: "anthropic",
    upstream: `http://127.0.0.1:${upstream.port}`,
    mode: "record",
    host: "127.0.0.1",
    port: config.port ?? 0,
    cwd,
    log: () => {},
    installSignals: false,
    ...(config.idleTtlMs !== undefined ? { idleTtlMs: config.idleTtlMs } : {})
  }).then((g) => {
    running.push(g);
    return g;
  });
}

function portOf(g: RunningGateway): number {
  return Number(new URL(g.base).port);
}

beforeEach(async () => {
  cwd = mkdtempSync(path.join(tmpdir(), "gw-idle-cli-"));
  upstream = await startFakeUpstream();
});

afterEach(async () => {
  for (const g of running) await g.close().catch(() => undefined);
  running = [];
  await upstream.close();
  rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("idle shutdown lifecycle (runGatewayStart)", () => {
  it("an idle gateway with a TTL stops cleanly AND removes its own pidfile", async () => {
    const g = await startViaCli({ idleTtlMs: 150 });
    expect(existsSync(pidfile())).toBe(true);
    expect(await waitFor(async () => !(await probeListening("127.0.0.1", portOf(g))), 3000)).toBe(true);
    expect(existsSync(pidfile())).toBe(false); // start-or-reuse can never mistake it for live
  });

  it("after an idle shutdown, ensure transparently starts a FRESH gateway and routing works", async () => {
    const dead = await startViaCli({ idleTtlMs: 120 });
    expect(await waitFor(async () => !(await probeListening("127.0.0.1", portOf(dead))), 3000)).toBe(true);

    // The shim's next run calls ensure: no live gateway → start (here: in-process, same config path).
    const result = await ensureGateway({
      provider: "anthropic",
      upstream: `http://127.0.0.1:${upstream.port}`,
      cwd,
      pollMs: 20,
      waitMs: 3000,
      spawnGatewayStart: () => {
        void startViaCli({ idleTtlMs: 60_000 });
      },
      pickPort: async () => 0
    });
    expect(result.status).toBe("started");
    if (result.status !== "started") return;
    const res = await fetch(`${result.base}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", messages: [] })
    });
    expect(res.status).toBe(200); // the tool still works through the fresh gateway
  });

  it("an explicit start WITHOUT a TTL stays long-lived (pidfile intact, still listening)", async () => {
    const g = await startViaCli({});
    await new Promise((r) => setTimeout(r, 400));
    expect(await probeListening("127.0.0.1", portOf(g))).toBe(true);
    expect(existsSync(pidfile())).toBe(true);
  });
});

describe("gateway start --idle-ttl flag validation", () => {
  it("rejects a non-integer --idle-ttl honestly without starting anything", async () => {
    const program = new Command();
    program.exitOverride();
    registerGatewayCommand(program);
    const errors: string[] = [];
    const origError = console.error;
    console.error = (line: string) => errors.push(String(line));
    const origExitCode = process.exitCode;
    try {
      await program.parseAsync(["node", "compaction", "gateway", "start", "--idle-ttl", "soon"]);
    } finally {
      console.error = origError;
      process.exitCode = origExitCode;
    }
    expect(errors.join("\n")).toContain("--idle-ttl 'soon' is not a non-negative integer");
    expect(existsSync(pidfile())).toBe(false);
  });
});
