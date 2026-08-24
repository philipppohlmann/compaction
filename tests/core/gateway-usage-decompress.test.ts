import http from "node:http";
import zlib from "node:zlib";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGatewayServer } from "../../src/core/gateway/server.js";
import { anthropicAdapter } from "../../src/core/gateway/provider-adapters-multi.js";
import { openAiAdapter } from "../../src/core/gateway/provider-adapter.js";
import { createUsageTee, effectiveContentCoding } from "../../src/core/gateway/usage-response-tee.js";
import type { GatewayReceipt } from "../../src/core/gateway/receipt.js";

/**
 * Gateway usage decompression — the fix for the empty-receipts dogfood bug that survived the 0.6.3 head+tail
 * fix.
 *
 * Root cause: the gateway forwards the client's `Accept-Encoding`, so the upstream (Anthropic on a real
 * Max/Fable-5 subscription) returns a gzip/brotli-COMPRESSED body. The client pipe forwards those exact
 * compressed bytes (byte-safe), but the usage-parsing copy was fed the COMPRESSED head+tail, which the
 * adapter cannot parse — so every real receipt came back with empty tokens {}.
 *
 * Fix: decompress the usage-parsing COPY ONLY (streaming, bounded head+tail); the client keeps receiving
 * the exact compressed upstream bytes. A decompression failure fails open to `token_source: unavailable`
 * with an honest reason. No receipt-schema change, no request mutation, no new dependency, content-free.
 *
 * Coverage:
 *  - the streaming tee + REAL Anthropic adapter recovers input+output+cache from a COMPRESSED Anthropic SSE
 *    stream (the exact subscription shape), and proves the pre-fix path (compressed bytes → adapter) is empty;
 *  - the REAL gateway server end-to-end (OpenAI adapter, which a 127.0.0.1 upstream selects) recovers usage
 *    from gzip/br/deflate, is byte-safe to the client, stays bounded on a >1 MiB decompressed body, does not
 *    regress the identity/uncompressed path, and fails open (honest reason) on corrupt/unsupported codings.
 */

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

const HEAD = 16 * 1024;
const TAIL = 64 * 1024;

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
}

/** POST to the gateway and return the EXACT response body bytes the client received. */
function postCollect(port: number, path: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const rq = http.request(
      { hostname: "127.0.0.1", port, path, method: "POST", headers: { "content-type": "application/json" } },
      (rs) => {
        const chunks: Buffer[] = [];
        rs.on("data", (c: Buffer) => chunks.push(c));
        rs.on("end", () => resolve(Buffer.concat(chunks)));
      }
    );
    rq.on("error", reject);
    rq.end(JSON.stringify({ model: "m" }));
  });
}

/** Synthetic Anthropic SSE: message_start (input+cache) → many content deltas → message_delta (output). */
function anthropicStream(opts: { input: number; cacheRead: number; output: number; fillerEvents: number }): Buffer {
  const parts: string[] = [];
  parts.push(
    `event: message_start\ndata: ${JSON.stringify({
      type: "message_start",
      message: { model: "claude-x", usage: { input_tokens: opts.input, cache_read_input_tokens: opts.cacheRead } }
    })}\n\n`
  );
  for (let i = 0; i < opts.fillerEvents; i++) {
    parts.push(
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: `chunk-${i}-` + "x".repeat(200) }
      })}\n\n`
    );
  }
  parts.push(`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: opts.output } })}\n\n`);
  parts.push(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
  return Buffer.from(parts.join(""), "utf8");
}

/** OpenAI streaming with usage in the FINAL chunk (client sent stream_options.include_usage). */
function openAiStream(opts: { prompt: number; cached: number; completion: number; fillerEvents: number }): Buffer {
  const parts: string[] = [];
  parts.push(`data: ${JSON.stringify({ id: "1", model: "gpt-x", choices: [{ delta: { role: "assistant" } }] })}\n\n`);
  for (let i = 0; i < opts.fillerEvents; i++) {
    parts.push(`data: ${JSON.stringify({ id: "1", model: "gpt-x", choices: [{ delta: { content: "y".repeat(200) } }] })}\n\n`);
  }
  parts.push(
    `data: ${JSON.stringify({
      id: "1",
      model: "gpt-x",
      choices: [],
      usage: { prompt_tokens: opts.prompt, completion_tokens: opts.completion, prompt_tokens_details: { cached_tokens: opts.cached } }
    })}\n\n`
  );
  parts.push("data: [DONE]\n\n");
  return Buffer.from(parts.join(""), "utf8");
}

/**
 * Run copied chunks through the streaming tee for a given content-coding, returning the tee outcome — this
 * exercises the SAME code the server uses to build the usage-parsing window.
 */
async function teeWindow(bodyBytes: Buffer, contentEncoding: string | undefined, chunkSize = 1024): ReturnType<ReturnType<typeof createUsageTee>["finish"]> {
  const tee = createUsageTee(contentEncoding, HEAD, TAIL);
  for (let off = 0; off < bodyBytes.length; off += chunkSize) tee.push(bodyBytes.subarray(off, off + chunkSize));
  return tee.finish();
}

/**
 * A fake upstream that returns `bodyBytes` with the given `content-encoding` header, streamed in small slices
 * (forcing the middle to be dropped by the bounded windows). `bodyBytes` are the ACTUAL bytes on the wire
 * (already compressed when a coding is set).
 */
function encodedStreamingUpstream(bodyBytes: Buffer, contentEncoding?: string): { server: http.Server; sent: Buffer } {
  const server = http.createServer((_req, res) => {
    const headers: Record<string, string> = { "content-type": "text/event-stream" };
    if (contentEncoding) headers["content-encoding"] = contentEncoding;
    res.writeHead(200, headers);
    let offset = 0;
    const step = 1024;
    const pump = (): void => {
      if (offset >= bodyBytes.length) {
        res.end();
        return;
      }
      const slice = bodyBytes.subarray(offset, offset + step);
      offset += step;
      res.write(slice, () => setImmediate(pump));
    };
    pump();
  });
  return { server, sent: bodyBytes };
}

async function startOpenAiGateway(upstreamPort: number): Promise<{ port: number; receipts: GatewayReceipt[] }> {
  const receipts: GatewayReceipt[] = [];
  const cwd = mkdtempSync(join(tmpdir(), "gw-usage-decompress-"));
  const gw = createGatewayServer({
    provider: "openai",
    upstream: `http://127.0.0.1:${upstreamPort}`,
    mode: "record",
    cwd,
    onReceipt: (r) => receipts.push(r)
  });
  const port = await listen(gw);
  cleanups.push(async () => {
    await new Promise<void>((r) => gw.close(() => r()));
    rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  return { port, receipts };
}

/** Await the receipt for the single request (onReceipt fires on a detached promise after the body ends). */
async function waitForReceipt(receipts: GatewayReceipt[]): Promise<GatewayReceipt> {
  for (let i = 0; i < 300 && receipts.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
  expect(receipts).toHaveLength(1);
  return receipts[0];
}

describe("effectiveContentCoding", () => {
  it("identifies identity/absent/empty as identity", () => {
    expect(effectiveContentCoding(undefined).kind).toBe("identity");
    expect(effectiveContentCoding("").kind).toBe("identity");
    expect(effectiveContentCoding("identity").kind).toBe("identity");
    expect(effectiveContentCoding("gzip, identity").kind).toBe("supported");
  });
  it("is case-insensitive and uses the last effective coding", () => {
    expect(effectiveContentCoding("GZIP")).toEqual({ kind: "supported", coding: "gzip" });
    expect(effectiveContentCoding("Br")).toEqual({ kind: "supported", coding: "br" });
    expect(effectiveContentCoding("deflate")).toEqual({ kind: "supported", coding: "deflate" });
  });
  it("treats a stacked coding as unsupported (fail-open)", () => {
    expect(effectiveContentCoding("gzip, br").kind).toBe("unsupported");
    expect(effectiveContentCoding("zstd").kind).toBe("unsupported");
  });
});

describe("streaming tee + REAL Anthropic adapter — compressed subscription SSE shape", () => {
  it("PRE-FIX PROOF: feeding the adapter the COMPRESSED bytes directly yields no usage", () => {
    const plain = anthropicStream({ input: 1234, cacheRead: 1000, output: 77, fillerEvents: 50 });
    const gz = zlib.gzipSync(plain);
    const usage = anthropicAdapter.extractUsage(gz); // exactly what the gateway did before this fix
    expect(usage.source).toBe("unavailable");
    expect(usage.inputTokens).toBeUndefined();
    expect(usage.outputTokens).toBeUndefined();
  });

  it("gzip: the decompressed window carries real input + output + cache", async () => {
    const plain = anthropicStream({ input: 1234, cacheRead: 1000, output: 77, fillerEvents: 50 });
    const w = await teeWindow(zlib.gzipSync(plain), "gzip");
    expect(w.ok).toBe(true);
    if (!w.ok) return;
    const usage = anthropicAdapter.extractUsage(w.windowText);
    expect(usage.source).toBe("provider-reported");
    // input_tokens (1234) is FRESH; cache_read (1000) is cached separately → TOTAL prompt input = 2234.
    expect(usage.inputTokens).toBe(2234);
    expect(usage.freshInputTokens).toBe(1234);
    expect(usage.outputTokens).toBe(77);
    expect(usage.cachedInputTokens).toBe(1000);
  });

  it("brotli: the decompressed window carries real input + output + cache", async () => {
    const plain = anthropicStream({ input: 4321, cacheRead: 400, output: 33, fillerEvents: 50 });
    const w = await teeWindow(zlib.brotliCompressSync(plain), "br");
    expect(w.ok).toBe(true);
    if (!w.ok) return;
    const usage = anthropicAdapter.extractUsage(w.windowText);
    // input_tokens (4321) is FRESH; cache_read (400) is cached separately → TOTAL prompt input = 4721.
    expect(usage.inputTokens).toBe(4721);
    expect(usage.freshInputTokens).toBe(4321);
    expect(usage.outputTokens).toBe(33);
    expect(usage.cachedInputTokens).toBe(400);
  });

  it("bounded: a >1 MiB DECOMPRESSED gzip stream still yields input (head) + output (tail), middle discarded", async () => {
    const plain = anthropicStream({ input: 9000, cacheRead: 0, output: 500, fillerEvents: 10000 });
    expect(plain.length).toBeGreaterThan(1024 * 1024);
    const w = await teeWindow(zlib.gzipSync(plain), "gzip");
    expect(w.ok).toBe(true);
    if (!w.ok) return;
    // The window is bounded to head+tail+1 (never the whole >1 MiB decompressed body).
    expect(w.windowText.length).toBeLessThanOrEqual(HEAD + TAIL + 1);
    const usage = anthropicAdapter.extractUsage(w.windowText);
    expect(usage.inputTokens).toBe(9000); // recovered from the DECOMPRESSED head
    expect(usage.outputTokens).toBe(500); // recovered from the DECOMPRESSED tail
  });

  it("corrupt/truncated gzip → fail-open marker with an honest reason (no throw)", async () => {
    const gz = zlib.gzipSync(anthropicStream({ input: 1, cacheRead: 0, output: 1, fillerEvents: 5 }));
    const w = await teeWindow(gz.subarray(0, Math.floor(gz.length / 2)), "gzip");
    expect(w.ok).toBe(false);
    if (w.ok) return;
    expect(w.reason).toMatch(/decompress/i);
  });
});

describe("gateway server end-to-end — compressed responses (OpenAI adapter path, byte-safety, bounded, fail-open)", () => {
  it("gzip: the receipt now carries real usage; client receives EXACT compressed upstream bytes", async () => {
    const gz = zlib.gzipSync(openAiStream({ prompt: 800, cached: 200, completion: 50, fillerEvents: 30 }));
    const upstream = encodedStreamingUpstream(gz, "gzip");
    const upstreamPort = await listen(upstream.server);
    cleanups.push(() => new Promise<void>((r) => upstream.server.close(() => r())));
    const { port, receipts } = await startOpenAiGateway(upstreamPort);

    const got = await postCollect(port, "/v1/chat/completions");
    const r = await waitForReceipt(receipts);

    expect(r.token_source).toBe("provider-reported");
    expect(r.tokens.prompt_input).toBe(800);
    expect(r.tokens.output).toBe(50);
    expect(r.tokens.cached_input).toBe(200);
    expect(got.equals(upstream.sent)).toBe(true); // byte-safety: exact compressed bytes
  });

  it("brotli: the receipt now carries real usage; client bytes exact", async () => {
    const br = zlib.brotliCompressSync(openAiStream({ prompt: 111, cached: 0, completion: 22, fillerEvents: 20 }));
    const upstream = encodedStreamingUpstream(br, "br");
    const upstreamPort = await listen(upstream.server);
    cleanups.push(() => new Promise<void>((r) => upstream.server.close(() => r())));
    const { port, receipts } = await startOpenAiGateway(upstreamPort);

    const got = await postCollect(port, "/v1/chat/completions");
    const r = await waitForReceipt(receipts);

    expect(r.token_source).toBe("provider-reported");
    expect(r.tokens.prompt_input).toBe(111);
    expect(r.tokens.output).toBe(22);
    expect(got.equals(upstream.sent)).toBe(true);
  });

  it("deflate: the receipt now carries real usage; client bytes exact", async () => {
    const df = zlib.deflateSync(openAiStream({ prompt: 60, cached: 0, completion: 7, fillerEvents: 10 }));
    const upstream = encodedStreamingUpstream(df, "deflate");
    const upstreamPort = await listen(upstream.server);
    cleanups.push(() => new Promise<void>((r) => upstream.server.close(() => r())));
    const { port, receipts } = await startOpenAiGateway(upstreamPort);

    const got = await postCollect(port, "/v1/chat/completions");
    const r = await waitForReceipt(receipts);

    expect(r.token_source).toBe("provider-reported");
    expect(r.tokens.prompt_input).toBe(60);
    expect(r.tokens.output).toBe(7);
    expect(got.equals(upstream.sent)).toBe(true);
  });

  it("identity/uncompressed: still works (no regression to the current path)", async () => {
    const plain = openAiStream({ prompt: 700, cached: 100, completion: 40, fillerEvents: 30 });
    const upstream = encodedStreamingUpstream(plain); // no content-encoding
    const upstreamPort = await listen(upstream.server);
    cleanups.push(() => new Promise<void>((r) => upstream.server.close(() => r())));
    const { port, receipts } = await startOpenAiGateway(upstreamPort);

    const got = await postCollect(port, "/v1/chat/completions");
    const r = await waitForReceipt(receipts);

    expect(r.token_source).toBe("provider-reported");
    expect(r.tokens.prompt_input).toBe(700);
    expect(r.tokens.output).toBe(40);
    expect(r.tokens.cached_input).toBe(100);
    expect(got.equals(upstream.sent)).toBe(true);
  });

  it("bounded: a gzip body whose DECOMPRESSED size is > 1 MiB → correct usage; client bytes exact", async () => {
    const plain = openAiStream({ prompt: 5000, cached: 0, completion: 999, fillerEvents: 9000 });
    expect(plain.length).toBeGreaterThan(1024 * 1024);
    const gz = zlib.gzipSync(plain);
    const upstream = encodedStreamingUpstream(gz, "gzip");
    const upstreamPort = await listen(upstream.server);
    cleanups.push(() => new Promise<void>((r) => upstream.server.close(() => r())));
    const { port, receipts } = await startOpenAiGateway(upstreamPort);

    const got = await postCollect(port, "/v1/chat/completions");
    const r = await waitForReceipt(receipts);

    expect(r.token_source).toBe("provider-reported");
    expect(r.tokens.prompt_input).toBe(5000);
    expect(r.tokens.output).toBe(999);
    expect(got.equals(upstream.sent)).toBe(true); // whole compressed body delivered, usage from a bounded window
  });

  it("fail-open: a corrupt/truncated gzip → token_source unavailable (honest reason), body still delivered", async () => {
    const gz = zlib.gzipSync(openAiStream({ prompt: 800, cached: 0, completion: 50, fillerEvents: 30 }));
    const corrupt = gz.subarray(0, Math.floor(gz.length / 2)); // still labeled content-encoding: gzip
    const upstream = encodedStreamingUpstream(corrupt, "gzip");
    const upstreamPort = await listen(upstream.server);
    cleanups.push(() => new Promise<void>((r) => upstream.server.close(() => r())));
    const { port, receipts } = await startOpenAiGateway(upstreamPort);

    const got = await postCollect(port, "/v1/chat/completions");
    const r = await waitForReceipt(receipts);

    expect(r.token_source).toBe("unavailable");
    expect(r.tokens.prompt_input).toBeUndefined();
    expect(r.tokens.output).toBeUndefined();
    expect(typeof r.reasons?.token).toBe("string");
    expect(r.reasons?.token).toMatch(/decompress/i);
    expect(got.equals(upstream.sent)).toBe(true); // fail-open: exact (corrupt) upstream bytes forwarded
  });

  it("unsupported coding (zstd) → token_source unavailable (honest reason), body still delivered", async () => {
    const plain = openAiStream({ prompt: 12, cached: 0, completion: 3, fillerEvents: 5 });
    const upstream = encodedStreamingUpstream(plain, "zstd"); // we do not decompress zstd
    const upstreamPort = await listen(upstream.server);
    cleanups.push(() => new Promise<void>((r) => upstream.server.close(() => r())));
    const { port, receipts } = await startOpenAiGateway(upstreamPort);

    const got = await postCollect(port, "/v1/chat/completions");
    const r = await waitForReceipt(receipts);

    expect(r.token_source).toBe("unavailable");
    expect(r.reasons?.token).toMatch(/not supported/i);
    expect(got.equals(upstream.sent)).toBe(true);
  });

  it("OpenAI adapter directly parses a decompressed OpenAI window (sanity for the end-to-end path)", async () => {
    const w = await teeWindow(zlib.gzipSync(openAiStream({ prompt: 42, cached: 10, completion: 9, fillerEvents: 5 })), "gzip");
    expect(w.ok).toBe(true);
    if (!w.ok) return;
    const usage = openAiAdapter.extractUsage(w.windowText);
    expect(usage.inputTokens).toBe(42);
    expect(usage.outputTokens).toBe(9);
    expect(usage.cachedInputTokens).toBe(10);
  });
});
