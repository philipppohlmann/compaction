import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startGatewayServer, type StartedGateway } from "../../src/core/gateway/server.js";
import { probeListening } from "../../src/core/gateway/status.js";
import { resolveRoutingGatewayIdleTtlMs, DEFAULT_ROUTING_GATEWAY_IDLE_TTL_MS } from "../../src/core/gateway/ensure.js";

/**
 * Gateway idle auto-shutdown (`idleTtlMs`), the routing-gateway posture fix: an ensure-started
 * gateway must not linger forever after sessions end. Load-bearing invariants: (1) a genuinely idle
 * gateway stops cleanly after the TTL (listener closed, `onIdleShutdown` fired), (2) any request
 * resets the idle clock, (3) an IN-FLIGHT request is NEVER cut off by the TTL, (4) absent/0 TTL
 * means the gateway never self-stops (default long-lived behavior unchanged).
 *
 * No real network: the upstream is a local fake; everything is async (no subprocess).
 */

const UPSTREAM_BODY = JSON.stringify({ id: "fake", usage: { input_tokens: 3, output_tokens: 1 } });

let cwd: string;
let upstream: { port: number; close: () => Promise<void> };
let gateways: StartedGateway[] = [];

function startFakeUpstream(delayMs = 0): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(UPSTREAM_BODY);
      }, delayMs);
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

async function startGateway(options: { idleTtlMs?: number; onIdleShutdown?: () => void; upstreamPort?: number }): Promise<StartedGateway> {
  const started = await startGatewayServer({
    provider: "anthropic",
    upstream: `http://127.0.0.1:${options.upstreamPort ?? upstream.port}`,
    mode: "record",
    cwd,
    host: "127.0.0.1",
    port: 0,
    ...(options.idleTtlMs !== undefined ? { idleTtlMs: options.idleTtlMs } : {}),
    ...(options.onIdleShutdown ? { onIdleShutdown: options.onIdleShutdown } : {})
  });
  gateways.push(started);
  return started;
}

function post(port: number): Promise<{ status: number; body: string }> {
  return fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "m", messages: [] })
  }).then(async (res) => ({ status: res.status, body: await res.text() }));
}

async function waitFor(cond: () => Promise<boolean> | boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return cond();
}

beforeEach(async () => {
  cwd = mkdtempSync(path.join(tmpdir(), "gw-idle-"));
  upstream = await startFakeUpstream();
});

afterEach(async () => {
  for (const g of gateways) await g.close().catch(() => undefined);
  gateways = [];
  await upstream.close();
  rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("gateway idle auto-shutdown", () => {
  it("stops cleanly after the idle TTL: listener closed, onIdleShutdown fired once", async () => {
    let shutdowns = 0;
    const g = await startGateway({ idleTtlMs: 150, onIdleShutdown: () => (shutdowns += 1) });
    expect(await probeListening("127.0.0.1", g.address.port)).toBe(true);
    expect(await waitFor(async () => !(await probeListening("127.0.0.1", g.address.port)), 3000)).toBe(true);
    expect(shutdowns).toBe(1);
  });

  it("a request RESETS the idle clock - an active gateway stays up past the TTL window", async () => {
    const g = await startGateway({ idleTtlMs: 300 });
    // Keep requests coming every ~150ms for well over one TTL window.
    for (let i = 0; i < 4; i += 1) {
      const res = await post(g.address.port);
      expect(res.status).toBe(200);
      await new Promise((r) => setTimeout(r, 150));
    }
    // > 600ms elapsed since start (two TTL windows), still up, because requests kept arriving.
    expect(await probeListening("127.0.0.1", g.address.port)).toBe(true);
    // Once genuinely idle, it stops.
    expect(await waitFor(async () => !(await probeListening("127.0.0.1", g.address.port)), 3000)).toBe(true);
  });

  it("NEVER shuts down mid-request: a slow in-flight request outliving the TTL completes byte-intact", async () => {
    const slow = await startFakeUpstream(400); // upstream takes 4x the TTL to answer
    try {
      const g = await startGateway({ idleTtlMs: 100, upstreamPort: slow.port });
      const res = await post(g.address.port); // in flight across several TTL checks
      expect(res.status).toBe(200);
      expect(res.body).toBe(UPSTREAM_BODY); // full upstream bytes, not cut off
      // After the response completes and the TTL elapses idle, it stops cleanly.
      expect(await waitFor(async () => !(await probeListening("127.0.0.1", g.address.port)), 3000)).toBe(true);
    } finally {
      await slow.close();
    }
  });

  it("TTL absent or 0 → the gateway never self-stops (default long-lived behavior)", async () => {
    const noTtl = await startGateway({});
    const zeroTtl = await startGateway({ idleTtlMs: 0 });
    await new Promise((r) => setTimeout(r, 400));
    expect(await probeListening("127.0.0.1", noTtl.address.port)).toBe(true);
    expect(await probeListening("127.0.0.1", zeroTtl.address.port)).toBe(true);
  });
});

describe("resolveRoutingGatewayIdleTtlMs (default + env + explicit override)", () => {
  it("defaults to 0 = PERSISTENT (the routing gateway never idle-shuts-down under a live session)", () => {
    expect(DEFAULT_ROUTING_GATEWAY_IDLE_TTL_MS).toBe(0);
    expect(resolveRoutingGatewayIdleTtlMs(undefined, {})).toBe(0);
  });

  it("honors COMPACTION_GATEWAY_IDLE_TTL_MS opt-in, including an explicit 0 (= never auto-stop)", () => {
    expect(resolveRoutingGatewayIdleTtlMs(undefined, { COMPACTION_GATEWAY_IDLE_TTL_MS: "60000" })).toBe(60000);
    expect(resolveRoutingGatewayIdleTtlMs(undefined, { COMPACTION_GATEWAY_IDLE_TTL_MS: "0" })).toBe(0);
  });

  it("an explicit option wins over the env", () => {
    expect(resolveRoutingGatewayIdleTtlMs(1234, { COMPACTION_GATEWAY_IDLE_TTL_MS: "60000" })).toBe(1234);
    expect(resolveRoutingGatewayIdleTtlMs(0, { COMPACTION_GATEWAY_IDLE_TTL_MS: "60000" })).toBe(0);
  });

  it("a malformed or negative env value falls back to the persistent default (never an accidental self-stop)", () => {
    expect(resolveRoutingGatewayIdleTtlMs(undefined, { COMPACTION_GATEWAY_IDLE_TTL_MS: "soon" })).toBe(DEFAULT_ROUTING_GATEWAY_IDLE_TTL_MS);
    expect(resolveRoutingGatewayIdleTtlMs(undefined, { COMPACTION_GATEWAY_IDLE_TTL_MS: "-5" })).toBe(DEFAULT_ROUTING_GATEWAY_IDLE_TTL_MS);
    expect(resolveRoutingGatewayIdleTtlMs(undefined, { COMPACTION_GATEWAY_IDLE_TTL_MS: "" })).toBe(DEFAULT_ROUTING_GATEWAY_IDLE_TTL_MS);
  });
});
