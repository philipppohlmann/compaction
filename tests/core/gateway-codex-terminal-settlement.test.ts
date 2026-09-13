import http, { createServer, request, type RequestOptions, type Server } from "node:http";
import https from "node:https";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGatewayServer } from "../../src/core/gateway/server.js";
import type { GatewayReceipt } from "../../src/core/gateway/receipt.js";

const CAPABILITY = "T".repeat(43);
const ROUTE = `/__compaction/codex/${CAPABILITY}/backend-api/codex/responses`;
const REQUEST_BODY = JSON.stringify({ model: "gpt-5.6-sol", input: "meaningful terminal settlement check" });
const VALID_USAGE = { input_tokens: 41_955, output_tokens: 1_242, total_tokens: 43_197 };
const completedEvent = (response: Record<string, unknown>) =>
  `data: ${JSON.stringify({ type: "response.completed", response })}\n\n`;
const COMPLETED_EVENT = completedEvent({ id: "resp_terminal_fixture", model: "gpt-5.6-sol", usage: VALID_USAGE });
const NONTERMINAL_EVENT =
  `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "partial" })}\n\n`;

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

describe("Codex subscription terminal SSE settlement", () => {
  const servers: Server[] = [];
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => close(server)));
    dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
    vi.restoreAllMocks();
  });

  async function harness(
    upstreamResponse: string,
    leaveOpen: boolean,
    response: { status?: number; contentType?: string | null } = {}
  ) {
    const upstream = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        const headers = response.contentType === null
          ? {}
          : { "content-type": response.contentType ?? "text/event-stream" };
        res.writeHead(response.status ?? 200, headers);
        if (leaveOpen) res.write(upstreamResponse);
        else res.end(upstreamResponse);
      });
    });
    servers.push(upstream);
    const upstreamPort = await listen(upstream);
    vi.spyOn(https, "request").mockImplementation(((options: RequestOptions, callback: (response: unknown) => void) =>
      request({ ...options, protocol: "http:", hostname: "127.0.0.1", port: upstreamPort }, callback as Parameters<typeof request>[1])) as typeof https.request);

    const cwd = mkdtempSync(join(tmpdir(), "codex-terminal-settlement-"));
    dirs.push(cwd);
    const observed: GatewayReceipt[] = [];
    const gateway = createGatewayServer({
      provider: "openai",
      upstream: "https://ignored.invalid",
      mode: "record",
      workflow: "codex",
      cwd,
      codexSubscription: { capability: CAPABILITY },
      onReceipt: (receipt) => observed.push(receipt)
    });
    servers.push(gateway);
    const gatewayPort = await listen(gateway);

    const post = (destroyAfterEvent: boolean) => new Promise<Buffer>((resolve, reject) => {
      const req = http.request({
        hostname: "127.0.0.1",
        port: gatewayPort,
        path: ROUTE,
        method: "POST",
        agent: false,
        headers: {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(REQUEST_BODY))
        }
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
          const body = Buffer.concat(chunks);
          if (destroyAfterEvent && body.includes("\n\n")) {
            res.destroy();
            resolve(body);
          }
        });
        res.on("end", () => resolve(Buffer.concat(chunks)));
        res.on("error", reject);
      });
      req.on("error", reject);
      req.end(REQUEST_BODY);
    });

    let gatewayClosed = false;
    const closeGateway = async () => {
      if (gatewayClosed) return;
      gatewayClosed = true;
      await new Promise<void>((resolve) => gateway.close(() => resolve()));
    };
    return { cwd, observed, post, closeGateway };
  }

  function persistedReceipts(cwd: string): Array<Record<string, unknown>> {
    const receiptPath = join(cwd, ".compaction", "gateway", "receipts.jsonl");
    if (!existsSync(receiptPath)) return [];
    return readFileSync(receiptPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  }

  it("registers Codex terminal settlement before response bytes can be piped", () => {
    const source = readFileSync("src/core/gateway/server.ts", "utf8");
    const tracked = source.indexOf("pendingBookkeeping.track(responseSettlement)");
    const downstreamClose = source.indexOf('res.once("close", () => settleResponse("premature"))', tracked);
    const responsePipeline = source.indexOf("pipeline(upstreamRes, res", tracked);

    expect(tracked).toBeGreaterThan(-1);
    expect(downstreamClose).toBeGreaterThan(tracked);
    expect(responsePipeline).toBeGreaterThan(downstreamClose);
    expect(source).toContain("const mayBeCodexResponsesSse = isCodexResponsesSse || !hasContentTypeHeader");
  });

  it("settles exactly one receipt when Codex consumes response.completed and closes before EOF", async () => {
    const h = await harness(COMPLETED_EVENT, true);
    expect((await h.post(true)).toString("utf8")).toBe(COMPLETED_EVENT);

    await h.closeGateway();

    expect(h.observed).toHaveLength(1);
    expect(h.observed[0].token_source).toBe("provider-reported");
    expect(h.observed[0].tokens.prompt_input).toBe(41_955);
    expect(h.observed[0].tokens.output).toBe(1_242);
    expect(persistedReceipts(h.cwd)).toHaveLength(1);
  });

  it("does not write a successful receipt for a partial nonterminal abort", async () => {
    const h = await harness(NONTERMINAL_EVENT, true);
    expect((await h.post(true)).toString("utf8")).toBe(NONTERMINAL_EVENT);

    await h.closeGateway();

    expect(h.observed).toHaveLength(0);
    expect(persistedReceipts(h.cwd)).toHaveLength(0);
  });

  it.each([
    ["missing response id", completedEvent({ usage: VALID_USAGE })],
    ["non-string response id", completedEvent({ id: 7, usage: VALID_USAGE })],
    ["missing total_tokens", completedEvent({ id: "resp_terminal_fixture", usage: { input_tokens: 41_955, output_tokens: 1_242 } })],
    ["fractional input_tokens", completedEvent({ id: "resp_terminal_fixture", usage: { ...VALID_USAGE, input_tokens: 41_955.5 } })],
    ["fractional output_tokens", completedEvent({ id: "resp_terminal_fixture", usage: { ...VALID_USAGE, output_tokens: 1_242.5 } })],
    ["fractional total_tokens", completedEvent({ id: "resp_terminal_fixture", usage: { ...VALID_USAGE, total_tokens: 43_197.5 } })],
    ["negative usage", completedEvent({ id: "resp_terminal_fixture", usage: { ...VALID_USAGE, input_tokens: -1 } })],
    ["non-numeric input usage", completedEvent({ id: "resp_terminal_fixture", usage: { ...VALID_USAGE, input_tokens: "41955" } })],
    ["non-numeric total usage", completedEvent({ id: "resp_terminal_fixture", usage: { ...VALID_USAGE, total_tokens: "43197" } })],
    ["invalid nested usage details", completedEvent({
      id: "resp_terminal_fixture",
      usage: { ...VALID_USAGE, input_tokens_details: { cached_tokens: 0, cache_write_tokens: null } }
    })]
  ])("fails closed for malformed terminal evidence: %s", async (_label, event) => {
    const h = await harness(event, true);
    await h.post(true);

    await h.closeGateway();

    expect(h.observed).toHaveLength(0);
    expect(persistedReceipts(h.cwd)).toHaveLength(0);
  });

  it("fails closed for a usage-less response.completed abort", async () => {
    const event = completedEvent({ id: "resp_terminal_fixture" });
    const h = await harness(event, true);
    await h.post(true);

    await h.closeGateway();

    expect(h.observed).toHaveLength(0);
    expect(persistedReceipts(h.cwd)).toHaveLength(0);
  });

  it.each([
    ["non-2xx", { status: 500 }],
    ["non-SSE", { contentType: "application/json" }],
    ["explicit empty Content-Type", { contentType: "" }]
  ])("fails closed for %s terminal transport", async (_label, response) => {
    const h = await harness(COMPLETED_EVENT, true, response);
    await h.post(true);

    await h.closeGateway();

    expect(h.observed).toHaveLength(0);
    expect(persistedReceipts(h.cwd)).toHaveLength(0);
  });

  it("accepts strict terminal evidence when the pinned Codex backend omits Content-Type", async () => {
    const h = await harness(COMPLETED_EVENT, true, { contentType: null });
    expect((await h.post(true)).toString("utf8")).toBe(COMPLETED_EVENT);

    await h.closeGateway();

    expect(h.observed).toHaveLength(1);
    expect(h.observed[0].tokens.prompt_input).toBe(41_955);
    expect(persistedReceipts(h.cwd)).toHaveLength(1);
  });

  it("keeps the normal EOF path at exactly one receipt", async () => {
    const h = await harness(COMPLETED_EVENT, false);
    expect((await h.post(false)).toString("utf8")).toBe(COMPLETED_EVENT);

    await h.closeGateway();

    expect(h.observed).toHaveLength(1);
    expect(persistedReceipts(h.cwd)).toHaveLength(1);
  });
});
