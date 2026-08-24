import http from "node:http";
import { gzipSync } from "node:zlib";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGatewayServer } from "../../src/core/gateway/server.js";

/**
 * TRANSPORT CHARACTERIZATION for the gateway proxy: pins the forwarding invariants a
 * connection-lifecycle change must not regress. Hermetic: in-process gateway + in-process fake
 * upstream on ::1 (IPv6 loopback) ephemeral ports, mkdtemp cwd/config dir, no network, no real keys.
 *
 * These tests pin CURRENT behavior (they were written green against the pre-change transport):
 *  1. request body forwarded byte-exact when apply does not mutate
 *  2. request header rules (hop-by-hop + x-compaction-* stripped; authorization/x-api-key kept;
 *     host rewritten; content-length recomputed - including when the client sent chunked)
 *  3. response status + body bytes verbatim (including a gzip body the usage tee must not corrupt)
 *  4. SSE/chunked streaming reaches the client with all bytes and a clean end
 *  5. honest 502 gateway_error JSON on a genuine upstream connect failure
 *  6. gateway log lines never contain the client's credentials
 */

const SECRET_AUTH = "Bearer sk-fake-transport-secret-FAKE_MARKER";
const SECRET_KEY = "sk-ant-fake-transport-key-FAKE_MARKER";

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

interface UpstreamSeen {
  method?: string;
  url?: string;
  headers?: http.IncomingHttpHeaders;
  rawHeaderNames?: string[];
  body?: Buffer;
}

/** Fake upstream capturing exactly what arrived; `respond` writes the canned response. */
function fakeUpstream(respond: (req: http.IncomingMessage, res: http.ServerResponse) => void): { server: http.Server; seen: UpstreamSeen[] } {
  const seen: UpstreamSeen[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        rawHeaderNames: req.rawHeaders.filter((_, i) => i % 2 === 0).map((n) => n.toLowerCase()),
        body: Buffer.concat(chunks)
      });
      respond(req, res);
    });
  });
  return { server, seen };
}

interface GatewayContext {
  port: number;
  cwd: string;
  logs: string[];
}

async function startGateway(upstreamPort: number): Promise<GatewayContext> {
  const cwd = mkdtempSync(join(tmpdir(), "gw-transport-"));
  const configDir = mkdtempSync(join(tmpdir(), "gw-transport-cfg-"));
  const logs: string[] = [];
  const gw = createGatewayServer({
    provider: "openai",
    upstream: `http://localhost:${upstreamPort}`,
    mode: "record",
    cwd,
    entitlementEnv: { COMPACTION_CONFIG_DIR: configDir },
    log: (line) => logs.push(line)
  });
  const port = await listen(gw);
  cleanups.push(async () => {
    await closeServer(gw);
    rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    rmSync(configDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  return { port, cwd, logs };
}

interface ClientResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

/** Raw byte-exact client; a fresh socket per request (`agent: false`) keeps each test independent. */
function request(
  port: number,
  opts: { method: string; path: string; headers?: Record<string, string>; body?: Buffer | string; chunked?: boolean }
): Promise<ClientResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "::1", port, path: opts.path, method: opts.method, headers: opts.headers, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      }
    );
    req.on("error", reject);
    if (opts.body !== undefined) {
      if (opts.chunked) {
        // write() before end() with no content-length header → chunked transfer to the gateway.
        req.write(opts.body);
        req.end();
      } else {
        req.end(opts.body);
      }
    } else {
      req.end();
    }
  });
}

const okJson = JSON.stringify({ id: "chatcmpl-1", model: "gpt-4o-mini", choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } });

describe("gateway transport characterization (pins pre-existing forwarding behavior)", () => {
  it("1. forwards the request body BYTE-EXACT when apply does not mutate", async () => {
    const up = fakeUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(okJson);
    });
    const upPort = await listen(up.server);
    cleanups.push(() => closeServer(up.server));
    const gw = await startGateway(upPort);

    // Deliberately awkward bytes: multi-byte UTF-8, embedded newlines, no trailing newline.
    const body = Buffer.from(JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: "héllo\n  wörld 😀" }] }), "utf8");
    const resp = await request(gw.port, {
      method: "POST",
      path: "/v1/chat/completions",
      headers: { "content-type": "application/json", "content-length": String(body.length) },
      body
    });

    expect(resp.status).toBe(200);
    expect(up.seen).toHaveLength(1);
    expect(up.seen[0].method).toBe("POST");
    expect(up.seen[0].url).toBe("/v1/chat/completions");
    expect(Buffer.compare(up.seen[0].body!, body)).toBe(0); // byte-exact
  });

  it("2. header rules: hop-by-hop + x-compaction-* stripped; authorization/x-api-key preserved; host rewritten; content-length recomputed (chunked client input included)", async () => {
    const up = fakeUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(okJson);
    });
    const upPort = await listen(up.server);
    cleanups.push(() => closeServer(up.server));
    const gw = await startGateway(upPort);

    const body = Buffer.from('{"model":"gpt-4o-mini","messages":[]}', "utf8");
    // Chunked on purpose: the client sends NO content-length, so the forwarded value must be recomputed.
    await request(gw.port, {
      method: "POST",
      path: "/v1/chat/completions",
      headers: {
        "content-type": "application/json",
        authorization: SECRET_AUTH,
        "x-api-key": SECRET_KEY,
        "x-compaction-mode": "record",
        "x-compaction-policy": "deterministic-dedupe",
        connection: "keep-alive",
        "keep-alive": "timeout=5",
        te: "trailers",
        trailer: "x-ignored",
        upgrade: "h2c",
        "proxy-authorization": "Basic ZmFrZQ=="
      },
      body,
      chunked: true
    });

    expect(up.seen).toHaveLength(1);
    const names = up.seen[0].rawHeaderNames!;
    // hop-by-hop stripped (node adds its own connection management; the CLIENT's values must not ride through)
    expect(names).not.toContain("te");
    expect(names).not.toContain("trailer");
    expect(names).not.toContain("upgrade");
    expect(names).not.toContain("proxy-authorization");
    expect(names).not.toContain("keep-alive");
    expect(names).not.toContain("transfer-encoding");
    // the client's own connection header value never rides through (node may add its own)
    expect(up.seen[0].headers!.connection ?? "").not.toContain("keep-alive, timeout");
    // local control headers stripped
    expect(names).not.toContain("x-compaction-mode");
    expect(names).not.toContain("x-compaction-policy");
    // credentials preserved untouched
    expect(up.seen[0].headers!.authorization).toBe(SECRET_AUTH);
    expect(up.seen[0].headers!["x-api-key"]).toBe(SECRET_KEY);
    // host rewritten to the upstream
    expect(up.seen[0].headers!.host).toBe(`localhost:${upPort}`);
    // content-length recomputed from the buffered body even though the client sent chunked
    expect(up.seen[0].headers!["content-length"]).toBe(String(body.length));
    expect(Buffer.compare(up.seen[0].body!, body)).toBe(0);
  });

  it("3. response status + body bytes verbatim, including a gzip-compressed body (usage tee never corrupts client bytes)", async () => {
    const plain = JSON.stringify({ id: "chatcmpl-gz", model: "gpt-4o-mini", choices: [], usage: { prompt_tokens: 42, completion_tokens: 7 } });
    const gzipped = gzipSync(Buffer.from(plain, "utf8"));
    const up = fakeUpstream((_req, res) => {
      res.writeHead(201, { "content-type": "application/json", "content-encoding": "gzip", "x-upstream-marker": "kept" });
      res.end(gzipped);
    });
    const upPort = await listen(up.server);
    cleanups.push(() => closeServer(up.server));
    const gw = await startGateway(upPort);

    const resp = await request(gw.port, {
      method: "POST",
      path: "/v1/chat/completions",
      headers: { "content-type": "application/json", "accept-encoding": "gzip" },
      body: "{}"
    });

    expect(resp.status).toBe(201);
    expect(resp.headers["content-encoding"]).toBe("gzip");
    expect(resp.headers["x-upstream-marker"]).toBe("kept");
    expect(Buffer.compare(resp.body, gzipped)).toBe(0); // the exact compressed bytes, not a re-encode
  });

  it("4. SSE/chunked response is streamed to the client with all bytes intact and a clean terminal end", async () => {
    const events = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "chunk-one" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "chunk-two" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { prompt_tokens: 5, completion_tokens: 2 } })}\n\n`,
      "data: [DONE]\n\n"
    ];
    const up = fakeUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      let i = 0;
      const tick = setInterval(() => {
        res.write(events[i]);
        i += 1;
        if (i === events.length) {
          clearInterval(tick);
          res.end();
        }
      }, 10);
    });
    const upPort = await listen(up.server);
    cleanups.push(() => closeServer(up.server));
    const gw = await startGateway(upPort);

    const resp = await request(gw.port, {
      method: "POST",
      path: "/v1/chat/completions",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stream: true })
    });

    expect(resp.status).toBe(200);
    expect(resp.body.toString("utf8")).toBe(events.join("")); // every byte, ended cleanly ('end' fired)
  });

  it("5. genuine upstream connect failure → honest 502 gateway_error JSON (never a fake success)", async () => {
    // Reserve an ephemeral port, then close it so nothing listens there.
    const probe = http.createServer();
    const deadPort = await listen(probe);
    await closeServer(probe);

    const gw = await startGateway(deadPort);
    const resp = await request(gw.port, {
      method: "POST",
      path: "/v1/chat/completions",
      headers: { "content-type": "application/json" },
      body: "{}"
    });

    expect(resp.status).toBe(502);
    const parsed = JSON.parse(resp.body.toString("utf8")) as { error: { message: string; type: string } };
    expect(parsed.error.type).toBe("gateway_error");
    expect(parsed.error.message).toContain("upstream request failed");
  });

  it("6. gateway log lines never contain the client's authorization or x-api-key values", async () => {
    const up = fakeUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(okJson);
    });
    const upPort = await listen(up.server);
    cleanups.push(() => closeServer(up.server));
    const gw = await startGateway(upPort);

    await request(gw.port, {
      method: "POST",
      path: "/v1/chat/completions",
      headers: { "content-type": "application/json", authorization: SECRET_AUTH, "x-api-key": SECRET_KEY },
      body: "{}"
    });
    // Also exercise the error path (its log line interpolates the error message).
    const probe = http.createServer();
    const deadPort = await listen(probe);
    await closeServer(probe);
    const gwDead = await startGateway(deadPort);
    await request(gwDead.port, {
      method: "POST",
      path: "/v1/chat/completions",
      headers: { "content-type": "application/json", authorization: SECRET_AUTH, "x-api-key": SECRET_KEY },
      body: "{}"
    });

    // Bookkeeping (receipt line) is detached; give it a beat to log whatever it will log.
    await new Promise((r) => setTimeout(r, 150));
    for (const line of [...gw.logs, ...gwDead.logs]) {
      expect(line).not.toContain(SECRET_AUTH);
      expect(line).not.toContain(SECRET_KEY);
      expect(line).not.toContain("sk-fake-transport-secret");
      expect(line).not.toContain("sk-ant-fake-transport-key");
    }
  });
});
