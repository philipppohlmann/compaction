import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, request, type RequestOptions, type Server } from "node:http";
import https from "node:https";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGatewayServer } from "../../src/core/gateway/server.js";
import type { GatewayReceipt } from "../../src/core/gateway/receipt.js";

const CAP = "C".repeat(43);
const AUTH = "Bearer SENTINEL_AUTH_VALUE";
const ACCOUNT = "SENTINEL_ACCOUNT_VALUE";
const PREFIX = `/__compaction/codex/${CAP}/backend-api/codex`;

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function call(port: number, target: string, method = "POST", body = Buffer.alloc(0), headers: string[] = []): Promise<{ status: number; rawHeaders: string[]; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const requestHeaders = headers.some((value, index) => index % 2 === 0 && value.toLowerCase() === "host")
      ? headers
      : [...headers, "Host", `127.0.0.1:${port}`];
    const req = request({ host: "127.0.0.1", port, path: target, method, headers: requestHeaders }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, rawHeaders: res.rawHeaders, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    if (body.length > 0) req.write(body);
    req.end();
  });
}

describe("Codex ChatGPT-subscription Gateway envelope", () => {
  const servers: Server[] = [];
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map(close));
    dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
    vi.restoreAllMocks();
  });

  async function setup(status = 200) {
    const seen: Array<{ method?: string; url?: string; rawHeaders: string[]; body: Buffer }> = [];
    const upstream = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        seen.push({ method: req.method, url: req.url, rawHeaders: req.rawHeaders, body: Buffer.concat(chunks) });
        if (status === 307) {
          res.writeHead(307, ["Location", "https://evil.invalid/collect", "Set-Cookie", "SENTINEL_RESPONSE_COOKIE"]);
          res.end("redirect");
          return;
        }
        res.writeHead(200, [
          "Content-Type", req.url?.includes("/responses") ? "text/event-stream" : "application/json",
          "Set-Cookie", "SENTINEL_RESPONSE_COOKIE",
          "X-Response-Secret", "SENTINEL_RESPONSE_SECRET"
        ]);
        res.end(req.url?.includes("/responses")
          ? 'data: {"type":"response.completed","response":{"usage":{"input_tokens":10,"output_tokens":2}}}\n\n'
          : '{"models":[]}');
      });
    });
    servers.push(upstream);
    const upstreamPort = await listen(upstream);
    const pinned: RequestOptions[] = [];
    vi.spyOn(https, "request").mockImplementation(((options: RequestOptions, cb: (response: unknown) => void) => {
      pinned.push({ ...options });
      return request({ ...options, protocol: "http:", hostname: "127.0.0.1", port: upstreamPort }, cb as Parameters<typeof request>[1]);
    }) as typeof https.request);
    const cwd = mkdtempSync(join(tmpdir(), "codex-sub-envelope-"));
    dirs.push(cwd);
    const receipts: GatewayReceipt[] = [];
    const logs: string[] = [];
    const gateway = createGatewayServer({
      provider: "openai",
      upstream: "https://evil.invalid/ignored",
      workflow: "codex",
      mode: "record",
      cwd,
      codexSubscription: { capability: CAP },
      onReceipt: (receipt) => receipts.push(receipt),
      log: (line) => logs.push(line)
    });
    servers.push(gateway);
    return { port: await listen(gateway), seen, pinned, receipts, logs };
  }

  it("pins and forwards one Responses request once, preserves bytes/auth, strips unsafe fields, and writes one receipt", async () => {
    const ctx = await setup();
    const body = Buffer.from('{"model":"gpt-5","input":[],"stream":true}');
    const result = await call(ctx.port, `${PREFIX}/responses`, "POST", body, [
      "Authorization", AUTH,
      "ChatGPT-Account-Id", ACCOUNT,
      "Content-Type", "application/json",
      "Cookie", "SENTINEL_COOKIE",
      "Proxy-Authorization", "SENTINEL_PROXY",
      "X-Unknown", "SENTINEL_UNKNOWN",
      "Content-Length", String(body.length)
    ]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(result.status).toBe(200);
    expect(ctx.seen).toHaveLength(1);
    expect(ctx.seen[0].url).toBe("/backend-api/codex/responses");
    expect(ctx.seen[0].body).toEqual(body);
    expect(ctx.seen[0].rawHeaders).toContain(AUTH);
    expect(ctx.seen[0].rawHeaders).toContain(ACCOUNT);
    for (const secret of ["SENTINEL_COOKIE", "SENTINEL_PROXY", "SENTINEL_UNKNOWN"]) expect(ctx.seen[0].rawHeaders).not.toContain(secret);
    expect(result.rawHeaders).not.toContain("SENTINEL_RESPONSE_COOKIE");
    expect(result.rawHeaders).not.toContain("SENTINEL_RESPONSE_SECRET");
    expect(ctx.pinned).toHaveLength(1);
    expect(ctx.pinned[0].hostname).toBe("chatgpt.com");
    expect(ctx.pinned[0].path).toBe("/backend-api/codex/responses");
    expect(ctx.receipts).toHaveLength(1);
    const output = `${ctx.logs.join("\n")}\n${JSON.stringify(ctx.receipts)}`;
    for (const secret of [CAP, AUTH, ACCOUNT]) expect(output).not.toContain(secret);
  });

  it("passes the exact bounded models query with no receipt", async () => {
    const ctx = await setup();
    const result = await call(ctx.port, `${PREFIX}/models?client_version=0.153.4`, "GET", Buffer.alloc(0), [
      "Authorization", AUTH, "ChatGPT-Account-Id", ACCOUNT
    ]);
    expect(result.status).toBe(200);
    expect(ctx.seen.map((entry) => entry.url)).toEqual(["/backend-api/codex/models?client_version=0.153.4"]);
    expect(ctx.receipts).toHaveLength(0);
  });

  it("rejects unknown, ambiguous, wrong-method, wrong-query, and wrong-capability targets before upstream contact", async () => {
    const ctx = await setup();
    for (const [target, method] of [
      [`${PREFIX}/responses?x=1`, "POST"],
      [`${PREFIX}/auth`, "POST"],
      [`${PREFIX}/../responses`, "POST"],
      [`${PREFIX}%2fresponses`, "POST"],
      [`${PREFIX}/responses`, "GET"],
      [`${PREFIX}/models?client_version=0.153.4&x=1`, "GET"],
      [`/__compaction/codex/${"D".repeat(43)}/backend-api/codex/responses`, "POST"]
    ]) {
      const result = await call(ctx.port, target, method, Buffer.alloc(0), ["Authorization", AUTH]);
      expect(result.status).toBe(404);
      expect(result.body.toString()).not.toContain(CAP);
    }
    expect(ctx.seen).toHaveLength(0);
    expect(ctx.receipts).toHaveLength(0);
  });

  it("rejects redirects without following, retrying, or replaying", async () => {
    const ctx = await setup(307);
    const result = await call(ctx.port, `${PREFIX}/responses`, "POST", Buffer.from("once"), ["Authorization", AUTH, "Content-Length", "4"]);
    expect(result.status).toBe(502);
    expect(ctx.seen).toHaveLength(1);
    expect(ctx.seen[0].body.toString()).toBe("once");
    expect(ctx.pinned).toHaveLength(1);
    expect(result.body.toString()).not.toContain("evil.invalid");
  });
});
