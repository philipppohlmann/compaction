import { describe, it, expect } from "vitest";
import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { URL } from "node:url";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { GatewayReceipt } from "../../src/core/gateway/receipt.js";
import {
  compareGatewayProof,
  formatGatewayProof,
  proofSummaryFromReceipt,
  receiptsForGatewayProof
} from "../../src/core/gateway/proof.js";
import type { ApiExportDocument } from "../../src/core/api-export.js";

/**
 * FULL-FLOW DOGFOOD e2e, the whole local MVP flow, deterministically, in one test.
 * It exercises the REAL gateway server + REAL OpenAI-compatible adapter +
 * REAL content-free receipts + REAL proof math + the REAL `gateway capabilities` and `api export`
 * commands, chained end to end. The ONLY thing faked is the upstream provider: an in-process fake
 * OpenAI-compatible server (NO network, NO keys, NO live provider calls) that reports usage with
 * `prompt_tokens_details.cached_tokens`.
 *
 * The flow proved (route → receipts → proof → capabilities → export):
 *   1. route a request through the gateway (fake upstream reporting cached tokens),
 *   2. the gateway writes content-free provider-reported receipts,
 *   3. `compareGatewayProof` / `gateway proof` shows provider-reported fresh-input reduction,
 *   4. `gateway capabilities --json` reflects the honest support truth (supported ≠ live-verified),
 *   5. `api export --json` emits ONE content-free document carrying those receipts + summary + capabilities.
 * The flow is asserted COHERENT (export == the CLI surfaces) and CONTENT-FREE end to end.
 *
 * What this does NOT prove: real-provider behavior. `liveVerified` stays false everywhere, live
 * verification remains the operator-key gate (`gateway verify-cache`); this test makes NO live call.
 *
 * IMPORTANT (known deadlock, see MEMORY): a CLI subprocess that must reach an in-worker fake server
 * HANGS under `spawnSync`. This test uses ASYNC `spawn` for the gateway AND for every follow-up CLI
 * command, plus async `http.request` for client traffic, never `spawnSync`.
 */
const CLI = resolve("dist/cli/index.js");
// FAKE marker strings so the no-committed-secrets scanner never flags these, and to prove content-freeness.
const FAKE_PROMPT = "FAKE_FULLFLOW_PROMPT_must_not_be_stored";
const FAKE_REPLY = "FAKE_FULLFLOW_REPLY_must_not_be_stored";
const FAKE_KEY = "sk-fake-fullflow-key-NEVER-STORED";

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

function startFakeUpstream(
  respond: (req: http.IncomingMessage, res: http.ServerResponse) => void
): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => respond(req, res));
  });
  return new Promise((r) =>
    server.listen(0, "127.0.0.1", () =>
      r({ port: (server.address() as { port: number }).port, close: () => new Promise((c) => server.close(() => c())) })
    )
  );
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
function httpRequest(
  url: string,
  opts: { method: string; headers?: Record<string, string> },
  body?: string
): Promise<{ status: number; body: string }> {
  return new Promise((resolve2, reject) => {
    const u = new URL(url);
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: opts.method, headers: opts.headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve2({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      }
    );
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

/** Run a follow-up CLI command with ASYNC spawn (NEVER spawnSync), capturing stdout + exit code. */
function runCli(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve2, reject) => {
    const child = spawn("node", [CLI, ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("exit", (code) => resolve2({ code: code ?? 0, stdout, stderr }));
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
  const cwd = mkdtempSync(join(tmpdir(), "gw-full-flow-dogfood-"));
  const upstream = await startFakeUpstream(respond);
  const listenPort = await freePort();
  const child = spawn(
    "node",
    [
      CLI,
      "gateway",
      "start",
      "--mode",
      "record",
      "--provider",
      "openai",
      "--upstream",
      `http://127.0.0.1:${upstream.port}`,
      "--listen",
      `http://127.0.0.1:${listenPort}`
    ],
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

describe("gateway FULL local MVP flow DOGFOOD (route → receipts → proof → capabilities → api export; fake upstream, deterministic CI)", () => {
  it("routes a request, writes content-free receipts, proves fresh-input reduction, and exports a coherent content-free document", async () => {
    await withGateway(
      (req, res) => {
        const variant = req.headers["x-compaction-proof-variant"] as string | undefined;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(upstreamBody(variant));
      },
      async ({ base, cwd }) => {
        const proofRun = "full-flow-dogfood-001";
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

        // 1. ROUTE: cold baseline, then warm/cached compacted through the real gateway → fake upstream.
        const baselineResp = await send("baseline");
        const compactedResp = await send("compacted");
        expect(baselineResp.status).toBe(200);
        expect(compactedResp.status).toBe(200);

        // 2. RECEIPTS: the two content-free provider-reported receipts the REAL gateway wrote.
        const receipts = await readReceipts(cwd, 2);
        expect(receipts).toHaveLength(2);
        const { baseline, compacted } = receiptsForGatewayProof(receipts, proofRun);
        if (!baseline || !compacted) throw new Error("paired receipts missing");
        for (const r of [baseline, compacted]) {
          expect(r.token_source).toBe("provider-reported");
          expect(r.cache_source).toBe("provider-reported");
          expect(r.provider).toBe("openai");
          expect(r.model_visible_bytes_changed).toBe(false);
          expect(r.mode).toBe("record");
        }

        // 3. PROOF: provider-reported fresh-input reduction over the two receipts (same total input).
        const delta = compareGatewayProof({
          proofRunId: proofRun,
          baseline: proofSummaryFromReceipt(baseline),
          compacted: proofSummaryFromReceipt(compacted)
        });
        expect(delta.available).toBe(true);
        expect(delta.beforeInputTokens).toBe(PROMPT_TOKENS);
        expect(delta.afterInputTokens).toBe(PROMPT_TOKENS); // same model-visible bytes
        expect(delta.freshInputReductionPercent).toBe(75);
        const rendered = formatGatewayProof(delta);
        expect(rendered).toContain("provider-reported fresh input reduced by 75%");
        // No forbidden POSITIVE claim on the proof surface.
        expect(rendered).not.toMatch(/cost saved|saved \$|billing-confirmed savings|output token(s)? reduced/i);

        // The SAME proof via the REAL `gateway proof` CLI (async spawn), reading the same local receipts.
        const proofCli = await runCli(["gateway", "proof", "--proof-run", proofRun], cwd);
        expect(proofCli.code).toBe(0);
        expect(proofCli.stdout).toContain("provider-reported fresh input reduced by 75%");

        // 4. CAPABILITIES: the honest per-workflow support truth via the REAL CLI (async spawn).
        //    Supported ≠ live-verified: with NO verify-cache record, liveVerified is false everywhere.
        const capsCli = await runCli(["gateway", "capabilities", "--json"], cwd);
        expect(capsCli.code).toBe(0);
        const caps = JSON.parse(capsCli.stdout) as Array<Record<string, unknown>>;
        expect(Array.isArray(caps)).toBe(true);
        expect(caps.length).toBeGreaterThan(0);
        expect(caps.every((c) => c.liveVerified === false)).toBe(true); // no fabricated live proof
        // Cursor is honestly NOT cache-proof; the OpenAI-compatible custom app row is present.
        const cursor = caps.find((c) => c.workflow === "cursor");
        const customApp = caps.find((c) => c.workflow === "custom-openai-app");
        expect(cursor).toBeDefined();
        expect(cursor?.cacheProofSupported).toBe(false); // Cursor is local-estimate/activity-only, NOT cache-proof
        expect(cursor?.localEstimateOnly).toBe(true);
        expect(customApp).toBeDefined();

        // 5. EXPORT: ONE content-free JSON document via the REAL `api export --json` CLI (async spawn).
        const exportCli = await runCli(["api", "export", "--json"], cwd);
        expect(exportCli.code).toBe(0);
        const doc = JSON.parse(exportCli.stdout) as ApiExportDocument;

        // COHERENCE: the export carries the SAME receipts, summary, and capabilities the flow produced.
        expect(doc.receipts).toHaveLength(2);
        expect(doc.gateway_status.receiptsCount).toBe(2);
        expect(doc.cache_summary).toEqual(doc.gateway_status.summary); // no recomputation drift
        expect(doc.capabilities).toEqual(caps); // export == `gateway capabilities` output
        expect(doc.capabilities.every((c) => c.liveVerified === false)).toBe(true);
        // No live verification happened in this deterministic no-key flow.
        expect(doc.verifications).toEqual([]);

        // CONTENT-FREE END TO END: neither the persisted receipts nor the export leak prompt/reply/key.
        const raw = readReceiptsRaw(cwd);
        for (const forbidden of [FAKE_PROMPT, FAKE_REPLY, FAKE_KEY]) {
          expect(raw).not.toContain(forbidden);
          expect(exportCli.stdout).not.toContain(forbidden);
          expect(proofCli.stdout).not.toContain(forbidden);
          expect(capsCli.stdout).not.toContain(forbidden);
        }
        // Structural content-freeness of every receipt (in the export too): counts / labels / ids only.
        const forbiddenKeys = ["messages", "input", "prompt", "content", "choices", "completion", "response_body", "request_body", "text"];
        for (const r of doc.receipts) {
          for (const k of Object.keys(r)) expect(forbiddenKeys).not.toContain(k);
          expect(r.content_uploaded).toBe(false);
          expect(r.sync_status).toBe("local-only");
        }
      }
    );
  });
});
