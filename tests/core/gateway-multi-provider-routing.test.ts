import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGatewayServer } from "../../src/core/gateway/server.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
}

/** A fake upstream that records the request paths it receives. */
function recordingUpstream(): { server: http.Server; paths: string[] } {
  const paths: string[] = [];
  const server = http.createServer((req, res) => {
    paths.push(req.url ?? "");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ usage: { input_tokens: 5, output_tokens: 1, prompt_tokens: 5, completion_tokens: 1 } }));
  });
  return { server, paths };
}

function post(port: number, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const rq = http.request({ hostname: "127.0.0.1", port, path, method: "POST", headers: { "content-type": "application/json" } }, (rs) => {
      rs.on("data", () => {});
      rs.on("end", () => resolve());
    });
    rq.on("error", reject);
    rq.end("{}");
  });
}

describe("gateway multi-provider routing - one gateway, both upstreams", () => {
  it("routes /messages to Anthropic and /chat/completions to OpenAI; no-match falls back to the default", async () => {
    const openai = recordingUpstream();
    const anthropic = recordingUpstream();
    const openaiPort = await listen(openai.server);
    const anthropicPort = await listen(anthropic.server);
    const cwd = mkdtempSync(join(tmpdir(), "gw-multi-"));

    const gw = createGatewayServer({
      provider: "openai",
      upstream: `http://127.0.0.1:${openaiPort}`,
      mode: "record",
      cwd,
      providerRoutes: [{ endpointSuffixes: ["/messages"], provider: "anthropic", upstream: `http://127.0.0.1:${anthropicPort}` }]
    });
    const gwPort = await listen(gw);
    cleanups.push(async () => {
      await new Promise<void>((r) => gw.close(() => r()));
      await new Promise<void>((r) => openai.server.close(() => r()));
      await new Promise<void>((r) => anthropic.server.close(() => r()));
      rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    });

    await post(gwPort, "/v1/chat/completions"); // OpenAI shape → default upstream
    await post(gwPort, "/v1/messages"); // Anthropic shape → routed upstream
    await post(gwPort, "/v1/responses"); // no route match → default upstream

    expect(anthropic.paths).toEqual(["/v1/messages"]);
    expect(openai.paths).toEqual(["/v1/chat/completions", "/v1/responses"]);
  });

  it("with no providerRoutes, everything goes to the single default upstream (unchanged behavior)", async () => {
    const openai = recordingUpstream();
    const openaiPort = await listen(openai.server);
    const cwd = mkdtempSync(join(tmpdir(), "gw-single-"));
    const gw = createGatewayServer({ provider: "openai", upstream: `http://127.0.0.1:${openaiPort}`, mode: "record", cwd });
    const gwPort = await listen(gw);
    cleanups.push(async () => {
      await new Promise<void>((r) => gw.close(() => r()));
      await new Promise<void>((r) => openai.server.close(() => r()));
      rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    });

    await post(gwPort, "/v1/chat/completions");
    await post(gwPort, "/v1/messages");
    expect(openai.paths).toEqual(["/v1/chat/completions", "/v1/messages"]);
  });
});
