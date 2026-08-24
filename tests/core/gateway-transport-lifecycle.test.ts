import http from "node:http";
import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGatewayServer } from "../../src/core/gateway/server.js";

/**
 * CONNECTION-LIFECYCLE behavior of the gateway transport (the change the characterization file
 * guards): raised client keep-alive timeouts, the connect/first-byte upstream stall guard (released
 * once the response starts, so a long/quiet stream is never killed), mid-stream upstream failure
 * containment (no crash, no JSON splice), and honest labeling of a failed request-body read.
 * Hermetic: in-process gateway + fake upstream on ::1 (IPv6 loopback) ephemeral ports, mkdtemp dirs,
 * no network, no real keys.
 */

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "::1", () => resolve((server.address() as { port: number }).port)));
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeIdleConnections?.();
    server.close(() => resolve());
  });
}

interface GatewayContext {
  server: http.Server;
  port: number;
  logs: string[];
}

async function startGateway(upstreamPort: number, extra?: { upstreamTimeoutMs?: number }): Promise<GatewayContext> {
  const cwd = mkdtempSync(join(tmpdir(), "gw-lifecycle-"));
  const configDir = mkdtempSync(join(tmpdir(), "gw-lifecycle-cfg-"));
  const logs: string[] = [];
  const gw = createGatewayServer({
    provider: "openai",
    upstream: `http://localhost:${upstreamPort}`,
    mode: "record",
    cwd,
    entitlementEnv: { COMPACTION_CONFIG_DIR: configDir },
    log: (line) => logs.push(line),
    ...(extra?.upstreamTimeoutMs !== undefined ? { upstreamTimeoutMs: extra.upstreamTimeoutMs } : {})
  });
  const port = await listen(gw);
  cleanups.push(async () => {
    await closeServer(gw);
    rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    rmSync(configDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  return { server: gw, port, logs };
}

function send(port: number, method: string, path: string, body?: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "::1", port, path, method, headers: { "content-type": "application/json" }, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
      }
    );
    req.on("error", reject);
    req.end(body);
  });
}

function post(port: number, path: string, body: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return send(port, "POST", path, body);
}

const okJson = JSON.stringify({ id: "chatcmpl-1", model: "gpt-4o-mini", choices: [], usage: { prompt_tokens: 3, completion_tokens: 1 } });

describe("gateway transport lifecycle", () => {
  it("raises the client-facing keep-alive timeouts above node's 5s default (headersTimeout >= keepAliveTimeout)", async () => {
    // Raw upstream that advertises NO keep-alive header (like real providers): the gateway forwards
    // response headers verbatim, so a node fake upstream's own `Keep-Alive: timeout=5` would mask
    // what the GATEWAY advertises. With none present, the wire value below is the gateway's own.
    const upSockets = new Set<net.Socket>();
    const up = net.createServer((socket) => {
      upSockets.add(socket);
      socket.on("close", () => upSockets.delete(socket));
      socket.on("data", () => {
        const body = "ok";
        socket.write(`HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: ${body.length}\r\n\r\n${body}`);
      });
    });
    const upPort = await new Promise<number>((resolve) =>
      up.listen(0, "::1", () => resolve((up.address() as { port: number }).port))
    );
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          for (const s of upSockets) s.destroy();
          up.close(() => resolve());
        })
    );
    const gw = await startGateway(upPort);

    // A client pooling its connection between turns must not be dropped after 5s idle.
    expect(gw.server.keepAliveTimeout).toBe(61_000);
    expect(gw.server.headersTimeout).toBe(65_000);
    expect(gw.server.headersTimeout).toBeGreaterThanOrEqual(gw.server.keepAliveTimeout);

    // And the raised value is what the wire advertises to a keep-alive client.
    const agent = new http.Agent({ keepAlive: true });
    cleanups.push(() => agent.destroy());
    const resp = await new Promise<{ keepAlive?: string }>((resolve, reject) => {
      const req = http.request(
        { hostname: "::1", port: gw.port, path: "/v1/chat/completions", method: "POST", agent },
        (res) => {
          res.resume();
          res.on("end", () => resolve({ keepAlive: res.headers["keep-alive"] }));
        }
      );
      req.on("error", reject);
      req.end("{}");
    });
    expect(resp.keepAlive).toContain("timeout=61");
  });

  it("a stalled upstream is destroyed by the stall guard and surfaced as an honest gateway error (never an infinite hang)", async () => {
    const up = http.createServer(() => {
      /* accept the request, never respond */
    });
    const upPort = await listen(up);
    cleanups.push(() => closeServer(up));
    const gw = await startGateway(upPort, { upstreamTimeoutMs: 250 });

    const resp = await post(gw.port, "/v1/chat/completions", "{}");
    expect(resp.status).toBe(502);
    const parsed = JSON.parse(resp.body) as { error: { message: string; type: string } };
    expect(parsed.error.type).toBe("gateway_error");
    expect(parsed.error.message).toContain("upstream timeout");
  });

  it("the stall guard covers connect+first-byte only: a stream that goes quiet PAST the timeout is NOT killed mid-flight", async () => {
    // Upstream: headers + first event, then silence LONGER than the guard, then a final event + end.
    // A guard that stayed armed during streaming would kill this; it must be released once bytes flow
    // (an LLM turn can legitimately go quiet for long stretches - extended thinking, a slow tool call).
    const up = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: first\n\n");
      setTimeout(() => {
        res.write("data: second-after-a-long-quiet-gap\n\n");
        res.end();
      }, 400); // gap > the 150ms guard below
    });
    const upPort = await listen(up);
    cleanups.push(() => closeServer(up));
    const gw = await startGateway(upPort, { upstreamTimeoutMs: 150 });

    const resp = await post(gw.port, "/v1/chat/completions", "{}");
    expect(resp.status).toBe(200);
    // BOTH events arrived and the stream ended cleanly - the quiet gap did not trip the guard.
    expect(resp.body).toContain("data: first");
    expect(resp.body).toContain("second-after-a-long-quiet-gap");
  });

  it("a mid-stream upstream reset does NOT crash the gateway: the client sees an aborted stream and the next request succeeds", async () => {
    let call = 0;
    const up = http.createServer((_req, res) => {
      call += 1;
      if (call === 1) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: first-chunk\n\n");
        setTimeout(() => res.socket?.destroy(), 30); // upstream dies mid-stream
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(okJson);
    });
    const upPort = await listen(up);
    cleanups.push(() => closeServer(up));
    const gw = await startGateway(upPort);

    const aborted = await new Promise<{ status: number; received: string; endedCleanly: boolean }>((resolve, reject) => {
      const req = http.request(
        { hostname: "::1", port: gw.port, path: "/v1/chat/completions", method: "POST", agent: false },
        (res) => {
          let received = "";
          let endedCleanly = false;
          res.on("data", (c: Buffer) => (received += c.toString("utf8")));
          res.on("end", () => (endedCleanly = true));
          res.on("error", () => {
            /* aborted stream is the expected shape */
          });
          res.on("close", () => resolve({ status: res.statusCode ?? 0, received, endedCleanly }));
        }
      );
      req.on("error", reject);
      req.end("{}");
    });

    // Headers + the streamed prefix arrived; the truncation stayed VISIBLE (no clean terminal end,
    // no error JSON spliced into the stream).
    expect(aborted.status).toBe(200);
    expect(aborted.received).toContain("first-chunk");
    expect(aborted.received).not.toContain("gateway_error");
    expect(aborted.endedCleanly).toBe(false);

    // The process survived (a raw pipe would have thrown an uncaught 'error' here): next request works.
    const next = await post(gw.port, "/v1/chat/completions", "{}");
    expect(next.status).toBe(200);
    expect(next.body).toBe(okJson);
  });

  it("a client abort mid-body is not labeled a size overflow (and the gateway stays healthy)", async () => {
    const up = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(okJson);
    });
    const upPort = await listen(up);
    cleanups.push(() => closeServer(up));
    const gw = await startGateway(upPort);

    // Raw socket: declare a body, send part of it, then abort the connection.
    await new Promise<void>((resolve) => {
      const socket = net.connect({ port: gw.port, host: "::1" }, () => {
        socket.write(
          "POST /v1/chat/completions HTTP/1.1\r\n" +
            `Host: [::1]:${gw.port}\r\n` +
            "Content-Type: application/json\r\n" +
            "Content-Length: 1000\r\n" +
            "\r\n" +
            '{"model":"gpt'
        );
        setTimeout(() => {
          socket.destroy();
          resolve();
        }, 50);
      });
      socket.on("error", () => resolve());
    });

    // The failed read is logged as a read failure, never as "too large".
    for (let i = 0; i < 40 && !gw.logs.some((l) => l.includes("request body read failed")); i += 1) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(gw.logs.some((l) => l.includes("request body read failed"))).toBe(true);
    expect(gw.logs.some((l) => l.toLowerCase().includes("too large"))).toBe(false);

    // And the gateway still serves the next request.
    const next = await post(gw.port, "/v1/chat/completions", "{}");
    expect(next.status).toBe(200);
    expect(next.body).toBe(okJson);
  });
});
