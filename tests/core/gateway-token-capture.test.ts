import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createGatewayServer,
  headAndTailForUsage,
  USAGE_HEAD_BYTES,
  USAGE_TAIL_BYTES
} from "../../src/core/gateway/server.js";
import { anthropicAdapter } from "../../src/core/gateway/provider-adapters-multi.js";
import type { GatewayReceipt } from "../../src/core/gateway/receipt.js";

/**
 * Gateway token capture — the fix for the dogfood bug where receipts came back with NO tokens for real
 * Claude Code traffic.
 *
 * Root cause: the gateway kept only a bounded TAIL of the streamed response for usage parsing. Anthropic
 * STREAMING (what Claude Code uses) SPLITS usage — `input_tokens` (+ cache) rides the FIRST SSE event
 * (`message_start`), `output_tokens` rides the LAST (`message_delta`) — so a tail-only window lost the input
 * event entirely. The fix tees a bounded HEAD *and* TAIL and feeds head+tail to the adapter.
 *
 * Coverage:
 *  - the head+tail window ASSEMBLY (the server's `headAndTailForUsage`) fed to the REAL Anthropic adapter
 *    carries BOTH input (head) and output (tail) on a huge stream, and the OLD tail-only assembly loses the
 *    input (the regression is load-bearing);
 *  - the REAL gateway server (OpenAI adapter path a 127.0.0.1 upstream selects) still captures streaming
 *    final-chunk usage and non-streaming JSON, delivers EXACT upstream bytes, stays bounded on a huge body
 *    (never buffers the whole body), and fails open to `unavailable` with an honest reason on no-usage.
 */

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

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

/** A fake upstream that streams `bodyBytes` in small slices (forcing the middle to be dropped by the windows). */
function streamingUpstream(bodyBytes: Buffer): { server: http.Server; sent: Buffer } {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
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

function jsonUpstream(body: string): { server: http.Server; sent: Buffer } {
  const sent = Buffer.from(body, "utf8");
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(sent);
  });
  return { server, sent };
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
 * Re-run the server's bounded HEAD + TAIL tee over an already-materialized body split into `chunkSize`
 * slices (exactly what the streaming tee sees), returning the assembled window string. This is the REAL
 * `headAndTailForUsage` fed by a faithful reconstruction of the sliding windows.
 */
function assembleWindow(body: Buffer, chunkSize: number): string {
  const head: Buffer[] = [];
  let headBytes = 0;
  const tail: Buffer[] = [];
  let tailBytes = 0;
  let total = 0;
  for (let off = 0; off < body.length; off += chunkSize) {
    const c = body.subarray(off, off + chunkSize);
    total += c.length;
    if (headBytes < USAGE_HEAD_BYTES) {
      const room = USAGE_HEAD_BYTES - headBytes;
      const slice = c.length <= room ? c : c.subarray(0, room);
      head.push(slice);
      headBytes += slice.length;
    }
    tail.push(c);
    tailBytes += c.length;
    while (tailBytes > USAGE_TAIL_BYTES && tail.length > 1) {
      tailBytes -= tail[0].length;
      tail.shift();
    }
  }
  return headAndTailForUsage(head, tail, total);
}

/** Same sliding TAIL, but tail-ONLY (the pre-fix behavior) — proves the regression the fix removes. */
function assembleTailOnly(body: Buffer, chunkSize: number): string {
  const tail: Buffer[] = [];
  let tailBytes = 0;
  for (let off = 0; off < body.length; off += chunkSize) {
    const c = body.subarray(off, off + chunkSize);
    tail.push(c);
    tailBytes += c.length;
    while (tailBytes > USAGE_TAIL_BYTES && tail.length > 1) {
      tailBytes -= tail[0].length;
      tail.shift();
    }
  }
  return Buffer.concat(tail).toString("utf8");
}

async function startGateway(upstreamPort: number, provider: string): Promise<{ port: number; receipts: GatewayReceipt[] }> {
  const receipts: GatewayReceipt[] = [];
  const cwd = mkdtempSync(join(tmpdir(), "gw-token-capture-"));
  const gw = createGatewayServer({
    provider,
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

describe("gateway token capture — head+tail window over a split-usage stream (Anthropic)", () => {
  it("the assembled head+tail carries BOTH input (message_start) and output (message_delta) on a HUGE stream", () => {
    // ~1.5 MiB of filler between the two usage events — far larger than head(16K)+tail(64K).
    const body = anthropicStream({ input: 1234, cacheRead: 1000, output: 77, fillerEvents: 7000 });
    expect(body.length).toBeGreaterThan(USAGE_HEAD_BYTES + USAGE_TAIL_BYTES);

    const usage = anthropicAdapter.extractUsage(assembleWindow(body, 1024));
    expect(usage.source).toBe("provider-reported");
    // Anthropic input_tokens (1234) is FRESH; cache_read (1000) is cached separately → TOTAL = 2234.
    // The fresh count and the cache field are both recovered from the HEAD window.
    expect(usage.inputTokens).toBe(2234); // TOTAL prompt input = fresh (1234) + cached (1000)
    expect(usage.freshInputTokens).toBe(1234); // Anthropic's own fresh input_tokens
    expect(usage.outputTokens).toBe(77); // still recovered from the TAIL
    expect(usage.cachedInputTokens).toBe(1000);
  });

  it("REGRESSION GUARD: tail-only assembly LOSES the input on the same huge stream (proves the fix matters)", () => {
    const body = anthropicStream({ input: 1234, cacheRead: 1000, output: 77, fillerEvents: 7000 });
    const usage = anthropicAdapter.extractUsage(assembleTailOnly(body, 1024));
    // Output survives (final chunk), input does NOT — the exact dogfood failure.
    expect(usage.outputTokens).toBe(77);
    expect(usage.inputTokens).toBeUndefined();
  });

  it("a SMALL split-usage stream (≤ tail) is fed whole (tail alone) and still yields input + output", () => {
    const body = anthropicStream({ input: 42, cacheRead: 0, output: 9, fillerEvents: 10 });
    expect(body.length).toBeLessThan(USAGE_TAIL_BYTES);
    const usage = anthropicAdapter.extractUsage(assembleWindow(body, 1024));
    expect(usage.inputTokens).toBe(42);
    expect(usage.outputTokens).toBe(9);
  });
});

describe("gateway token capture — real server end-to-end (byte-safety, bounded, OpenAI, fail-open)", () => {
  it("OpenAI streaming: final-chunk usage captured; client receives EXACT upstream bytes", async () => {
    const body = openAiStream({ prompt: 800, cached: 200, completion: 50, fillerEvents: 30 });
    const upstream = streamingUpstream(body);
    const upstreamPort = await listen(upstream.server);
    cleanups.push(() => new Promise<void>((r) => upstream.server.close(() => r())));
    const { port, receipts } = await startGateway(upstreamPort, "openai");

    const got = await postCollect(port, "/v1/chat/completions");

    expect(receipts).toHaveLength(1);
    const r = receipts[0];
    expect(r.token_source).toBe("provider-reported");
    expect(r.tokens.prompt_input).toBe(800);
    expect(r.tokens.output).toBe(50);
    expect(r.tokens.cached_input).toBe(200);
    expect(got.equals(upstream.sent)).toBe(true); // byte-safety
  });

  it("Bounded: a VERY large streamed body (≫ head+tail) yields correct final-chunk usage and is delivered byte-for-byte", async () => {
    const body = openAiStream({ prompt: 5000, cached: 0, completion: 999, fillerEvents: 9000 });
    expect(body.length).toBeGreaterThan(1_000_000);
    const upstream = streamingUpstream(body);
    const upstreamPort = await listen(upstream.server);
    cleanups.push(() => new Promise<void>((r) => upstream.server.close(() => r())));
    const { port, receipts } = await startGateway(upstreamPort, "openai");

    const got = await postCollect(port, "/v1/chat/completions");

    const r = receipts[0];
    expect(r.token_source).toBe("provider-reported");
    expect(r.tokens.prompt_input).toBe(5000);
    expect(r.tokens.output).toBe(999);
    // The whole body is delivered even though usage is parsed from a bounded window (never buffered whole).
    expect(got.length).toBe(body.length);
    expect(got.equals(upstream.sent)).toBe(true);
  });

  it("OpenAI non-streaming JSON: usage captured; client receives EXACT upstream bytes", async () => {
    const bodyText = JSON.stringify({
      model: "gpt-x",
      usage: { prompt_tokens: 42, completion_tokens: 9, prompt_tokens_details: { cached_tokens: 10 } }
    });
    const upstream = jsonUpstream(bodyText);
    const upstreamPort = await listen(upstream.server);
    cleanups.push(() => new Promise<void>((r) => upstream.server.close(() => r())));
    const { port, receipts } = await startGateway(upstreamPort, "openai");

    const got = await postCollect(port, "/v1/chat/completions");

    const r = receipts[0];
    expect(r.token_source).toBe("provider-reported");
    expect(r.tokens.prompt_input).toBe(42);
    expect(r.tokens.output).toBe(9);
    expect(got.equals(upstream.sent)).toBe(true);
    // The run-membership timestamp is the request's arrival, never later than the ledger append.
    expect(typeof r.request_started_at).toBe("string");
    expect(r.request_started_at! <= r.captured_at).toBe(true);
  });

  it("Non-streaming JSON between the head window and the tail window is captured (tail holds the whole body)", async () => {
    // A body larger than the head (16K) but within the tail (64K): must parse intact, never spliced.
    const bodyText = JSON.stringify({
      model: "gpt-x",
      filler: "z".repeat(30 * 1024),
      usage: { prompt_tokens: 321, completion_tokens: 12 }
    });
    expect(Buffer.byteLength(bodyText)).toBeGreaterThan(USAGE_HEAD_BYTES);
    expect(Buffer.byteLength(bodyText)).toBeLessThan(USAGE_TAIL_BYTES);
    const upstream = jsonUpstream(bodyText);
    const upstreamPort = await listen(upstream.server);
    cleanups.push(() => new Promise<void>((r) => upstream.server.close(() => r())));
    const { port, receipts } = await startGateway(upstreamPort, "openai");

    const got = await postCollect(port, "/v1/chat/completions");

    const r = receipts[0];
    expect(r.token_source).toBe("provider-reported");
    expect(r.tokens.prompt_input).toBe(321);
    expect(r.tokens.output).toBe(12);
    expect(got.equals(upstream.sent)).toBe(true);
  });

  it("Fail-open: a response with NO usage → token_source unavailable (honest); body still delivered", async () => {
    const body = Buffer.from(`data: ${JSON.stringify({ id: "1", model: "gpt-x", choices: [{ delta: { content: "hi" } }] })}\n\ndata: [DONE]\n\n`, "utf8");
    const upstream = streamingUpstream(body);
    const upstreamPort = await listen(upstream.server);
    cleanups.push(() => new Promise<void>((r) => upstream.server.close(() => r())));
    const { port, receipts } = await startGateway(upstreamPort, "openai");

    const got = await postCollect(port, "/v1/chat/completions");

    const r = receipts[0];
    expect(r.token_source).toBe("unavailable");
    expect(r.tokens.prompt_input).toBeUndefined();
    expect(r.tokens.output).toBeUndefined();
    expect(typeof r.reasons?.cache).toBe("string");
    expect(got.equals(upstream.sent)).toBe(true);
  });
});
