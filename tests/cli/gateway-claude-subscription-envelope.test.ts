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
const COOKIE = "session=SENTINEL_COOKIE_VALUE";

interface Seen { method?: string; url?: string; rawHeaders: string[]; body: Buffer }
interface Reply { status?: number; rawHeaders?: string[]; chunks?: Buffer[]; destroySocket?: boolean }

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function call(port: number, target: string, method = "POST", body = Buffer.alloc(0), rawHeaders?: string[]): Promise<{ status: number; rawHeaders: string[]; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const headers = rawHeaders && !rawHeaders.some((value, index) => index % 2 === 0 && value.toLowerCase() === "host")
      ? [...rawHeaders, "Host", `127.0.0.1:${port}`]
      : rawHeaders;
    const req = request({ host: "127.0.0.1", port, method, path: target, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, rawHeaders: res.rawHeaders, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    if (body.length) req.write(body);
    req.end();
  });
}

describe("default-off Claude subscription Gateway envelope", () => {
  const servers: Server[] = [];
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map(close));
    dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
    vi.restoreAllMocks();
  });

  async function setup(reply: Reply = {}, capability = CAP): Promise<{ gatewayPort: number; seen: Seen[]; receipts: GatewayReceipt[]; logs: string[]; cwd: string; pinnedTargets: RequestOptions[] }> {
    const seen: Seen[] = [];
    const upstream = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        seen.push({ method: req.method, url: req.url, rawHeaders: req.rawHeaders, body: Buffer.concat(chunks) });
        if (reply.destroySocket) {
          req.socket.destroy();
          return;
        }
        res.writeHead(reply.status ?? 200, reply.rawHeaders ?? ["Content-Type", "text/event-stream"]);
        if (req.method !== "HEAD") {
          for (const chunk of reply.chunks ?? [Buffer.from("data: {\"type\":\"message_stop\"}\n\n")]) res.write(chunk);
        }
        res.end();
      });
    });
    servers.push(upstream);
    const upstreamPort = await listen(upstream);
    const receipts: GatewayReceipt[] = [];
    const logs: string[] = [];
    const pinnedTargets: RequestOptions[] = [];
    vi.spyOn(https, "request").mockImplementation(((options: RequestOptions, onResponse: (response: unknown) => void) => {
      pinnedTargets.push({ ...options });
      return request(
        { ...options, protocol: "http:", hostname: "127.0.0.1", port: upstreamPort },
        onResponse as Parameters<typeof request>[1]
      );
    }) as typeof https.request);
    const cwd = mkdtempSync(join(tmpdir(), "claude-sub-envelope-"));
    dirs.push(cwd);
    const gateway = createGatewayServer({
      provider: "anthropic",
      // Even an adversarial ordinary upstream option cannot redirect the subscription envelope.
      upstream: "https://evil.invalid/credential-collector",
      mode: "record",
      workflow: "claude-code",
      cwd,
      log: (line) => logs.push(line),
      onReceipt: (receipt) => receipts.push(receipt),
      claudeSubscription: { capability }
    });
    servers.push(gateway);
    return { gatewayPort: await listen(gateway), seen, receipts, logs, cwd, pinnedTargets };
  }

  it("forwards messages once with exact body/SSE and duplicate anthropic headers, strips local fields, and records one receipt", async () => {
    const response = [Buffer.from("data: first\n"), Buffer.from("data: second\n\n")];
    const ctx = await setup({ rawHeaders: ["Content-Type", "text/event-stream", "Set-Cookie", "a=1", "Set-Cookie", "b=2", "X-Unknown-Sensitive", "SENTINEL_RESPONSE_SECRET", "Connection", "SENTINEL_UPSTREAM_CONNECTION"], chunks: response });
    const body = Buffer.from('{"model":"claude-test","messages":[]}');
    const result = await call(ctx.gatewayPort, `/__compaction/claude/${CAP}/v1/messages?beta=true`, "POST", body, [
      "Authorization", AUTH,
      "Cookie", COOKIE,
      "x-api-key", "SENTINEL_X_API_KEY",
      "anthropic-version", "2023-06-01",
      "anthropic-beta", "feature-a",
      "anthropic-beta", "feature-b",
      "Proxy-Authorization", "SENTINEL_PROXY_AUTH",
      "X-Unrecognized-Secret", "SENTINEL_UNKNOWN_HEADER",
      "Connection", "SENTINEL_CLIENT_CONNECTION",
      "Host", "local.invalid",
      "Content-Length", String(body.length)
    ]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(ctx.seen).toHaveLength(1);
    expect(ctx.seen[0].url).toBe("/v1/messages?beta=true");
    expect(ctx.seen[0].body).toEqual(body);
    const pairs = Array.from({ length: ctx.seen[0].rawHeaders.length / 2 }, (_, i) => ctx.seen[0].rawHeaders.slice(i * 2, i * 2 + 2));
    expect(pairs.filter(([name]) => name.toLowerCase() === "anthropic-beta").map(([, value]) => value)).toEqual(["feature-a", "feature-b"]);
    expect(pairs).toContainEqual(["Authorization", AUTH]);
    expect(pairs).toContainEqual(["Cookie", COOKIE]);
    expect(pairs.some(([name]) => name.toLowerCase() === "proxy-authorization")).toBe(false);
    expect(pairs.some(([name]) => name.toLowerCase() === "x-unrecognized-secret")).toBe(false);
    expect(pairs.find(([name]) => name.toLowerCase() === "connection")?.[1]).not.toBe("SENTINEL_CLIENT_CONNECTION");
    expect(pairs.find(([name]) => name.toLowerCase() === "host")?.[1]).toBe("api.anthropic.com");
    expect(result.body).toEqual(Buffer.concat(response));
    expect(result.rawHeaders.filter((value) => value === "Set-Cookie")).toHaveLength(2);
    expect(result.rawHeaders).not.toContain("X-Unknown-Sensitive");
    expect(result.rawHeaders).not.toContain("SENTINEL_RESPONSE_SECRET");
    expect(result.rawHeaders).not.toContain("SENTINEL_UPSTREAM_CONNECTION");
    expect(ctx.receipts).toHaveLength(1);
    expect(ctx.pinnedTargets).toHaveLength(1);
    expect(ctx.pinnedTargets[0].protocol).toBe("https:");
    expect(ctx.pinnedTargets[0].hostname).toBe("api.anthropic.com");
    expect(ctx.pinnedTargets[0].path).toBe("/v1/messages?beta=true");
    const allOutput = `${ctx.logs.join("\n")}\n${JSON.stringify(ctx.receipts)}`;
    for (const sentinel of [CAP, AUTH, COOKIE, "SENTINEL_X_API_KEY", "SENTINEL_PROXY_AUTH"]) expect(allOutput).not.toContain(sentinel);
  });

  it("honors every Connection token in both directions, including nominated credential headers", async () => {
    const ctx = await setup({
      rawHeaders: [
        "Content-Type", "application/json",
        "Set-Cookie", "keep=1",
        "Set-Cookie", "drop=1",
        "X-Route-Capability", CAP,
        "Connection", " set-cookie, X-Route-Capability "
      ],
      chunks: [Buffer.from("ok")]
    });
    const result = await call(ctx.gatewayPort, `/__compaction/claude/${CAP}/v1/messages`, "POST", Buffer.from("{}"), [
      "Authorization", AUTH,
      "anthropic-beta", "drop-me",
      "anthropic-version", "keep-me",
      "Connection", " AUTHORIZATION, anthropic-beta ",
      "Content-Length", "2"
    ]);
    const upstreamNames = ctx.seen[0].rawHeaders.filter((_, index) => index % 2 === 0).map((name) => name.toLowerCase());
    expect(upstreamNames).not.toContain("authorization");
    expect(upstreamNames).not.toContain("anthropic-beta");
    expect(upstreamNames).toContain("anthropic-version");
    expect(result.rawHeaders.map((value) => value.toLowerCase())).not.toContain("set-cookie");
    expect(result.rawHeaders.map((value) => value.toLowerCase())).not.toContain("x-route-capability");
    expect(result.body.toString()).toBe("ok");
  });

  it("passes HEAD and count_tokens through byte-exact with no optimization or receipt", async () => {
    const ctx = await setup({ chunks: [Buffer.from("count-stream-byte-1"), Buffer.from("-byte-2")] });
    expect((await call(ctx.gatewayPort, `/__compaction/claude/${CAP}`, "HEAD")).status).toBe(200);
    const body = Buffer.from("opaque-count-body");
    const count = await call(ctx.gatewayPort, `/__compaction/claude/${CAP}/v1/messages/count_tokens`, "POST", body, ["Content-Length", String(body.length), "Authorization", AUTH]);
    expect(count.body).toEqual(Buffer.from("count-stream-byte-1-byte-2"));
    expect(ctx.seen.map((entry) => entry.url)).toEqual(["/", "/v1/messages/count_tokens"]);
    expect(ctx.seen[1].body).toEqual(body);
    expect(ctx.receipts).toHaveLength(0);
  });

  it("rejects an oversized count_tokens body before any upstream contact", async () => {
    const ctx = await setup();
    const body = Buffer.alloc(25 * 1024 * 1024 + 1, 65);
    const result = await call(ctx.gatewayPort, `/__compaction/claude/${CAP}/v1/messages/count_tokens`, "POST", body, ["Content-Length", String(body.length)]);
    expect(result.status).toBe(413);
    expect(ctx.seen).toHaveLength(0);
    expect(ctx.receipts).toHaveLength(0);
  }, 20000);

  it("rejects invalid capabilities, unknown/auth/admin paths, ambiguity and methods locally without upstream contact or leaks", async () => {
    const ctx = await setup();
    const targets = [
      `/__compaction/claude/${"D".repeat(43)}/v1/messages`,
      `/__compaction/claude/${CAP}/oauth/token`,
      `/__compaction/claude/${CAP}/v1/admin`,
      `/__compaction/claude/${CAP}%2fv1/messages`,
      `/__compaction/claude/${CAP}/../v1/messages`
    ];
    for (const target of targets) {
      const result = await call(ctx.gatewayPort, target, "POST", Buffer.from(AUTH), ["Authorization", AUTH, "Content-Length", String(AUTH.length)]);
      expect(result.status).toBe(404);
      expect(result.body.toString()).not.toContain(CAP);
      expect(result.body.toString()).not.toContain(AUTH);
    }
    expect((await call(ctx.gatewayPort, `/__compaction/claude/${CAP}/v1/messages`, "GET")).status).toBe(404);
    expect(ctx.seen).toHaveLength(0);
    expect(ctx.receipts).toHaveLength(0);
    expect(ctx.logs.join("\n")).not.toContain(CAP);
  });

  it("rejects a cross-origin redirect locally without following, retrying, or replaying credentials/body", async () => {
    const ctx = await setup({ status: 307, rawHeaders: ["Location", "https://evil.invalid/collect"], chunks: [Buffer.from("redirect")] });
    const result = await call(ctx.gatewayPort, `/__compaction/claude/${CAP}/v1/messages`, "POST", Buffer.from("once"), ["Authorization", AUTH, "Content-Length", "4"]);
    expect(result.status).toBe(502);
    expect(result.body.toString()).not.toContain("evil.invalid");
    expect(ctx.seen).toHaveLength(1);
    expect(ctx.seen[0].body.toString()).toBe("once");
  });

  it("relays an allowed relative redirect unchanged without following it", async () => {
    const ctx = await setup({ status: 307, rawHeaders: ["Location", "/v1/messages"], chunks: [Buffer.from("relative")] });
    const result = await call(ctx.gatewayPort, `/__compaction/claude/${CAP}/v1/messages`, "POST", Buffer.from("once"), ["Authorization", AUTH, "Content-Length", "4"]);
    expect(result.status).toBe(307);
    expect(result.rawHeaders).toContain("/v1/messages");
    expect(result.body.toString()).toBe("relative");
    expect(ctx.seen).toHaveLength(1);
  });

  it("does not retry or replay a request when the pinned upstream connection fails", async () => {
    const ctx = await setup({ destroySocket: true });
    const result = await call(ctx.gatewayPort, `/__compaction/claude/${CAP}/v1/messages`, "POST", Buffer.from("once"), ["Authorization", AUTH, "Content-Length", "4"]);
    expect(result.status).toBe(502);
    expect(ctx.seen).toHaveLength(1);
    expect(ctx.seen[0].body.toString()).toBe("once");
    expect(ctx.receipts).toHaveLength(0);
  });

  it("isolates concurrent ephemeral capabilities and rejects cross-route use locally", async () => {
    const other = "E".repeat(43);
    const first = await setup({}, CAP);
    expect((await call(first.gatewayPort, `/__compaction/claude/${CAP}/v1/messages`, "POST", Buffer.from("one"), ["Content-Length", "3"])).status).toBe(200);
    const second = await setup({}, other);
    expect((await call(second.gatewayPort, `/__compaction/claude/${other}/v1/messages`, "POST", Buffer.from("two"), ["Content-Length", "3"])).status).toBe(200);
    expect((await call(first.gatewayPort, `/__compaction/claude/${other}/v1/messages`, "POST")).status).toBe(404);
    expect((await call(second.gatewayPort, `/__compaction/claude/${CAP}/v1/messages`, "POST")).status).toBe(404);
    expect(first.seen.map((entry) => entry.body.toString())).toEqual(["one"]);
    expect(second.seen.map((entry) => entry.body.toString())).toEqual(["two"]);
  });
});
