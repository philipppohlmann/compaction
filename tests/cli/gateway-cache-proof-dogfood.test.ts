import { describe, it, expect } from "vitest";
import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { URL } from "node:url";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { GatewayReceipt } from "../../src/core/gateway/receipt.js";
import { compareGatewayProof, formatGatewayProof, proofSummaryFromReceipt, receiptsForGatewayProof } from "../../src/core/gateway/proof.js";

/**
 * DOGFOOD e2e, the Custom OpenAI-compatible app → Compaction Gateway → OpenAI-compatible provider
 * CACHE-PROOF pipeline, end-to-end. This exercises the REAL
 * gateway server + REAL OpenAI adapter + REAL content-free receipts + REAL proof math. The ONLY thing
 * faked is the upstream provider: an in-process fake OpenAI-compatible server (NO network, NO keys, NO
 * live provider calls) that returns provider-reported usage with `prompt_tokens_details.cached_tokens`.
 *
 * What this PROVES: the pipeline produces content-free provider-reported receipts and a valid
 * fresh-input-reduction proof end-to-end over a controlled upstream.
 * What this does NOT prove: real-provider behavior. `liveVerified` stays false in the capability matrix;
 * live verification remains the operator-key gate (see docs/gateway/cache-proof-dogfood.md).
 *
 * IMPORTANT (known deadlock, see MEMORY): a CLI subprocess that must reach an in-process fake server in
 * the same vitest worker HANGS under `spawnSync`. This test uses ASYNC `spawn` for the gateway and async
 * `http.request` for client traffic, exactly like the existing gateway-proxy harness.
 */
const CLI = resolve("dist/cli/index.js");
// FAKE marker strings so the no-committed-secrets scanner never flags these, and to prove content-freeness.
const FAKE_PROMPT = "FAKE_DOGFOOD_PROMPT_must_not_be_stored";
const FAKE_REPLY = "FAKE_DOGFOOD_REPLY_must_not_be_stored";
const FAKE_KEY = "sk-fake-dogfood-key-NEVER-STORED";

/**
 * Fake OpenAI-compatible upstream. It reads the content-free `x-compaction-proof-variant` header the
 * client sent (forwarded byte-for-byte by the gateway) and returns a real-shaped Chat Completions body:
 *  - baseline (cold):  cached_tokens = 0     → fresh input = prompt_tokens
 *  - compacted (warm): cached_tokens > 0     → same prompt_tokens, fewer FRESH input tokens
 * The prompt_tokens (TOTAL input) is IDENTICAL across both, the provider-cache scenario (same
 * model-visible bytes, cheaper fresh/billed input).
 */
const PROMPT_TOKENS = 1200; // identical total input on both requests (provider-cache scenario)
const WARM_CACHED = 900; // 900 of 1200 served from provider cache on the warm/compacted request

function upstreamBody(variant: string | undefined): string {
  const cached = variant === "compacted" ? WARM_CACHED : 0;
  return JSON.stringify({
    id: "chatcmpl-fake",
    object: "chat.completion",
    model: "gpt-4o-mini",
    choices: [{ index: 0, message: { role: "assistant", content: FAKE_REPLY }, finish_reason: "stop" }],
    usage: {
      prompt_tokens: PROMPT_TOKENS,
      completion_tokens: 24,
      total_tokens: PROMPT_TOKENS + 24,
      prompt_tokens_details: { cached_tokens: cached }
    }
  });
}

function startFakeUpstream(respond: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => respond(req, res));
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ port: (server.address() as { port: number }).port, close: () => new Promise((c) => server.close(() => c())) })));
}

function freePort(): Promise<number> {
  return new Promise((r) => {
    const s = http.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => r(p));
    });
  });
}

/** Raw async node:http client (NOT spawnSync, the in-worker fake upstream would deadlock otherwise). */
function httpRequest(url: string, opts: { method: string; headers?: Record<string, string> }, body?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve2, reject) => {
    const u = new URL(url);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: opts.method, headers: opts.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve2({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function waitForListening(child: ChildProcess): Promise<void> {
  await new Promise<void>((r, reject) => {
    let out = "";
    const onData = (d: Buffer) => {
      out += d.toString();
      if (out.includes("Gateway running at")) r();
    };
    child.stdout?.on("data", onData);
    child.on("exit", (code) => reject(new Error(`gateway exited early (code ${code}): ${out}`)));
    setTimeout(() => reject(new Error(`gateway did not start in time: ${out}`)), 10000);
  });
}

function readReceiptsRaw(cwd: string): string {
  const p = join(cwd, ".compaction", "gateway", "receipts.jsonl");
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}

/** Poll the local-only receipts file until at least `n` lines are present, then return them parsed. */
async function readReceipts(cwd: string, n: number): Promise<GatewayReceipt[]> {
  const p = join(cwd, ".compaction", "gateway", "receipts.jsonl");
  for (let i = 0; i < 80; i += 1) {
    if (existsSync(p)) {
      const lines = readFileSync(p, "utf8").trim().split("\n").filter(Boolean);
      if (lines.length >= n) return lines.map((l) => JSON.parse(l) as GatewayReceipt);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return [];
}

/** Stand up { in-process fake OpenAI-compatible upstream + real CLI gateway (async spawn) }, run fn, tear down. */
async function withGateway(
  respond: (req: http.IncomingMessage, res: http.ServerResponse) => void,
  fn: (ctx: { base: string; cwd: string }) => Promise<void>
): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), "gw-cache-proof-dogfood-"));
  const upstream = await startFakeUpstream(respond);
  const listenPort = await freePort();
  const child = spawn(
    "node",
    [CLI, "gateway", "start", "--mode", "record", "--provider", "openai", "--upstream", `http://127.0.0.1:${upstream.port}`, "--listen", `http://127.0.0.1:${listenPort}`],
    { cwd, stdio: ["ignore", "pipe", "pipe"] }
  );
  try {
    await waitForListening(child);
    await fn({ base: `http://127.0.0.1:${listenPort}`, cwd });
  } finally {
    child.kill("SIGKILL");
    await upstream.close();
    rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

describe("gateway cache-proof pipeline DOGFOOD (real gateway + real adapter + real proof; fake OpenAI-compatible upstream)", () => {
  it("baseline (cold) + compacted (warm) → content-free provider-reported receipts → 'provider-reported fresh input reduced by X%'", async () => {
    await withGateway(
      (req, res) => {
        const variant = req.headers["x-compaction-proof-variant"] as string | undefined;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(upstreamBody(variant));
      },
      async ({ base, cwd }) => {
        const proofRun = "dogfood-cache-proof-001";
        const send = (variant: "baseline" | "compacted"): Promise<{ status: number; body: string }> =>
          httpRequest(
            `${base}/v1/chat/completions`,
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                authorization: `Bearer ${FAKE_KEY}`,
                "x-compaction-proof-run": proofRun,
                "x-compaction-proof-variant": variant
              }
            },
            JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: FAKE_PROMPT }] })
          );

        // Custom app → Gateway → (fake) OpenAI-compatible provider: cold baseline, then warm/cached compacted.
        const baselineResp = await send("baseline");
        const compactedResp = await send("compacted");
        expect(baselineResp.status).toBe(200);
        expect(compactedResp.status).toBe(200);

        // The two content-free receipts the REAL gateway wrote.
        const receipts = await readReceipts(cwd, 2);
        expect(receipts).toHaveLength(2);
        const { baseline, compacted } = receiptsForGatewayProof(receipts, proofRun);
        expect(baseline).toBeDefined();
        expect(compacted).toBeDefined();
        if (!baseline || !compacted) throw new Error("paired receipts missing");

        // Both receipts: provider-reported token AND cache axes (the real adapter normalized cached_tokens).
        for (const r of [baseline, compacted]) {
          expect(r.token_source).toBe("provider-reported");
          expect(r.cache_source).toBe("provider-reported");
          expect(r.provider).toBe("openai");
          expect(r.model_visible_bytes_changed).toBe(false);
          expect(r.mode).toBe("record");
        }
        // baseline cold: no cache → fresh = total.
        expect(baseline.tokens).toEqual({ prompt_input: PROMPT_TOKENS, cached_input: 0, billed_fresh_input: PROMPT_TOKENS, output: 24 });
        expect(baseline.fresh_billed_input_reduction.available).toBe(false); // cold: cached 0 → no reduction claimed
        // compacted warm: same TOTAL input, 900 cached → fresh dropped to 300.
        expect(compacted.tokens).toEqual({ prompt_input: PROMPT_TOKENS, cached_input: WARM_CACHED, billed_fresh_input: PROMPT_TOKENS - WARM_CACHED, output: 24 });
        expect(compacted.fresh_billed_input_reduction.available).toBe(true);

        // The proof math over the two receipts.
        const delta = compareGatewayProof({
          proofRunId: proofRun,
          baseline: proofSummaryFromReceipt(baseline),
          compacted: proofSummaryFromReceipt(compacted)
        });
        expect(delta.available).toBe(true);
        // SAME TOTAL INPUT - the model-visible-bytes-unchanged provider-cache scenario.
        expect(delta.beforeInputTokens).toBe(PROMPT_TOKENS);
        expect(delta.afterInputTokens).toBe(PROMPT_TOKENS);
        expect(delta.beforeInputTokens).toBe(delta.afterInputTokens);
        // fresh input dropped 1200 → 300, a 75% reduction of the fresh/billed share.
        expect(delta.beforeFreshInputTokens).toBe(PROMPT_TOKENS);
        expect(delta.afterFreshInputTokens).toBe(PROMPT_TOKENS - WARM_CACHED);
        expect(delta.freshInputReductionPercent).toBe(75);

        const rendered = formatGatewayProof(delta);
        // The exact allowed headline, with the correct X.
        expect(rendered).toContain("provider-reported fresh input reduced by 75%");
        // provider-cache scenario framing (same model-visible bytes → no approval).
        expect(rendered).toContain("Same context. Less fresh input.");
        expect(rendered).toContain("Model-visible bytes changed: no");
        expect(rendered).toContain("Approval required: no");
        // Honest negative disclaimer - never a positive billing/invoice/cost claim.
        expect(rendered).toContain("Claim: fresh-input reduction, not billing-confirmed invoice savings.");
        // No forbidden POSITIVE claim (the disclaimer above legitimately names "invoice savings" negatively).
        expect(rendered).not.toMatch(/cost saved|saved \$|billing-confirmed savings|output token(s)? reduced|reduced model-visible/i);

        // CONTENT-FREE: the persisted receipts leak NO prompt/response text and NOT the client key.
        const raw = readReceiptsRaw(cwd);
        expect(raw).not.toContain(FAKE_PROMPT);
        expect(raw).not.toContain(FAKE_REPLY);
        expect(raw).not.toContain(FAKE_KEY);
        // Structural content-freeness: every receipt key is a count / label / id - no message/content field.
        const forbiddenKeys = ["messages", "input", "prompt", "content", "choices", "completion", "response_body", "request_body", "text"];
        for (const r of receipts) {
          for (const k of Object.keys(r)) expect(forbiddenKeys).not.toContain(k);
          expect(r.content_uploaded).toBe(false);
          expect(r.sync_status).toBe("local-only");
        }
      }
    );
  });

  it("honest boundary: upstream returns NO usage → receipt is unavailable-with-reason (never a zero/fake reduction)", async () => {
    const noUsage = JSON.stringify({ id: "chatcmpl-nousage", object: "chat.completion", model: "gpt-4o-mini", choices: [{ index: 0, message: { role: "assistant", content: FAKE_REPLY }, finish_reason: "stop" }] });
    await withGateway(
      (_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(noUsage);
      },
      async ({ base, cwd }) => {
        const resp = await httpRequest(
          `${base}/v1/chat/completions`,
          { method: "POST", headers: { "content-type": "application/json", "x-compaction-proof-run": "dogfood-nousage", "x-compaction-proof-variant": "baseline" } },
          JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: FAKE_PROMPT }] })
        );
        expect(resp.status).toBe(200);
        const receipts = await readReceipts(cwd, 1);
        expect(receipts).toHaveLength(1);
        const r = receipts[0];
        expect(r.token_source).toBe("unavailable"); // NOT a silent zero
        expect(r.tokens).toEqual({});
        expect(r.reasons.token).toBeTruthy();
        expect(r.fresh_billed_input_reduction.available).toBe(false); // no fabricated 0% reduction
        expect(r.fresh_billed_input_reduction.note).toMatch(/unavailable/i);
      }
    );
  });
});
