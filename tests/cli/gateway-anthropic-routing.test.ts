import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

/**
 * `compaction gateway run --provider anthropic -- <command>`, provider-aware Gateway ROUTING for Claude
 * Code. Verified against a fake in-process upstream (NEVER a real provider /
 * real key). Asserts the ANTHROPIC-shaped injection: the child sees ANTHROPIC_BASE_URL (with NO /v1 -
 * Claude Code appends /v1/messages itself), routes through the local gateway, a content-free receipt is
 * recorded, the key is never injected/stored, and a gateway-start failure errors clearly WITHOUT running
 * the child against a dead endpoint.
 *
 * The provider-aware UPSTREAM default (anthropic → api.anthropic.com → Anthropic adapter) and the exact
 * env values are unit-proven in tests/core/gateway-routing-injection.test.ts. Here the fake upstream is
 * on 127.0.0.1 (so the default OpenAI adapter parses the tail); the Anthropic adapter's own usage/cache
 * normalization is unit-tested in tests/core/gateway-provider-adapters-multi.test.ts. We use async spawn
 * (NOT spawnSync) so the in-worker fake upstream can answer (spawnSync would deadlock the worker loop).
 */
const CLI = resolve("dist/cli/index.js");

interface Ran {
  code: number | null;
  stdout: string;
  stderr: string;
}
function runCli(args: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<Ran> {
  return new Promise((resolvePromise) => {
    const child: ChildProcess = spawn("node", [CLI, ...args], { cwd, env });
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (d) => (stdout += d.toString()));
    child.stderr!.on("data", (d) => (stderr += d.toString()));
    child.on("exit", (code) => resolvePromise({ code, stdout, stderr }));
    child.on("error", () => resolvePromise({ code: null, stdout, stderr }));
  });
}

// Child (CommonJS `node -e`, no top-level await): POSTs to ANTHROPIC_BASE_URL + '/v1/messages' (the path
// Claude Code appends itself) and echoes the injected base. Short beat before exit so the gateway's
// fire-and-forget receipt append flushes before the runner reads receipts on the child's exit.
const CLAUDE_CHILD = (exitCode: number): string =>
  `const b=process.env.ANTHROPIC_BASE_URL;` +
  `fetch(b+'/v1/messages',{method:'POST',headers:{'content-type':'application/json','x-api-key':process.env.ANTHROPIC_API_KEY||''},body:'{"model":"claude-x","messages":[]}'})` +
  `.then(r=>r.text()).then(t=>{console.log('CHILD_ANTHROPIC_BASE='+b);console.log('CHILD_BODY='+t);setTimeout(()=>process.exit(${exitCode}),200);})` +
  `.catch(e=>{console.log('CHILD_ERR '+e.message);process.exit(4);});`;

// A fake Anthropic Messages upstream: any request → a message JSON with usage (incl. a cache-read hit).
const UPSTREAM_BODY = JSON.stringify({
  id: "msg_fake",
  type: "message",
  role: "assistant",
  model: "claude-x",
  content: [{ type: "text", text: "ok" }],
  usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 40 }
});

describe("compaction gateway run --provider anthropic - Claude Code routing (fake upstream only)", () => {
  let upstream: Server;
  let upstreamUrl = "";
  let seenPaths: string[] = [];
  let cwd = "";

  beforeEach(async () => {
    seenPaths = [];
    upstream = createServer((req, res) => {
      seenPaths.push(req.url ?? "");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(UPSTREAM_BODY);
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    const addr = upstream.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    upstreamUrl = `http://127.0.0.1:${port}`;
    cwd = mkdtempSync(join(tmpdir(), "gw-anthropic-"));
  });

  afterEach(async () => {
    await new Promise<void>((r) => upstream.close(() => r()));
    if (cwd) rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    cwd = "";
  });

  const receiptsPath = (): string => join(cwd, ".compaction", "gateway", "receipts.jsonl");

  it("injects ANTHROPIC_BASE_URL with NO /v1, routes /v1/messages through the gateway, records a receipt", async () => {
    const r = await runCli(
      ["gateway", "run", "--provider", "anthropic", "--upstream", upstreamUrl, "--", "node", "-e", CLAUDE_CHILD(0)],
      { ...process.env, ANTHROPIC_API_KEY: "" },
      cwd
    );
    expect(r.code).toBe(0);
    // The child saw an injected 127.0.0.1 gateway base URL as ANTHROPIC_BASE_URL, and NO /v1 suffix.
    const m = r.stdout.match(/CHILD_ANTHROPIC_BASE=(http:\/\/127\.0\.0\.1:\d+)(\S*)/);
    expect(m).not.toBeNull();
    expect(m![2]).toBe(""); // nothing after host:port → no /v1 was appended to the base
    // The honest routing log names ANTHROPIC_BASE_URL (not OPENAI_BASE_URL).
    expect(r.stderr).toMatch(/routing → ANTHROPIC_BASE_URL=http:\/\/127\.0\.0\.1:\d+/);
    expect(r.stderr).not.toMatch(/routing → OPENAI_BASE_URL/);
    // The client appended /v1/messages itself → the gateway forwarded exactly that path to the upstream.
    expect(seenPaths.some((p) => p === "/v1/messages")).toBe(true);
    // stdio pass-through: the child printed the (fake) upstream body byte-for-byte.
    expect(r.stdout).toContain("msg_fake");
    // A content-free receipt was recorded for the routed request.
    expect(existsSync(receiptsPath())).toBe(true);
  }, 20000);

  it("no ANTHROPIC key: still routes (sets base URL) but never injects/stores a key - honest note names ANTHROPIC_API_KEY", async () => {
    const r = await runCli(
      ["gateway", "run", "--provider", "anthropic", "--upstream", upstreamUrl, "--", "node", "-e", CLAUDE_CHILD(0)],
      { ...process.env, ANTHROPIC_API_KEY: "" },
      cwd
    );
    expect(r.stderr).toMatch(/still needs its provider API key/i);
    expect(r.stderr).toMatch(/ANTHROPIC_API_KEY/);
    expect(r.stderr).toMatch(/never injects or stores keys/i);
  }, 20000);

  it("never prints or persists the ANTHROPIC key value, and makes no savings/overclaim", async () => {
    const SECRET = "sk-ant-fake-DO-NOT-LEAK-123456";
    const r = await runCli(
      ["gateway", "run", "--provider", "anthropic", "--upstream", upstreamUrl, "--", "node", "-e", CLAUDE_CHILD(0)],
      { ...process.env, ANTHROPIC_API_KEY: SECRET },
      cwd
    );
    expect(r.stdout).not.toContain(SECRET);
    expect(r.stderr).not.toContain(SECRET);
    // Key present → no missing-key warning.
    expect(r.stderr).not.toMatch(/still needs its provider API key/i);
    // Claim boundary: no output-token / model-visible-input / cost-savings / live-verified claims.
    expect(r.stderr).not.toMatch(/cost saved|reduced output|reduced model-visible|output tokens? reduced|live-verified|liveVerified/i);
  }, 20000);

  it("gateway start FAILURE is reported clearly and does NOT run the child against a dead endpoint", async () => {
    // Occupy a fixed port, then force the runner to bind THAT port → bind fails → the runner must error
    // and NOT spawn the child (no CHILD_ marker, no receipt).
    const port = 8795;
    const blocker = createServer((_q, s) => s.end("busy"));
    await new Promise<void>((res) => blocker.listen(port, "127.0.0.1", res));
    try {
      const r = await runCli(
        ["gateway", "run", "--provider", "anthropic", "--upstream", upstreamUrl, "--listen", `http://127.0.0.1:${port}`, "--", "node", "-e", CLAUDE_CHILD(0)],
        { ...process.env, ANTHROPIC_API_KEY: "" },
        cwd
      );
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/could not start a local gateway/i);
      // The child NEVER ran (no injected-base echo), so it was never routed to a dead gateway.
      expect(r.stdout).not.toContain("CHILD_ANTHROPIC_BASE");
      expect(existsSync(receiptsPath())).toBe(false);
    } finally {
      await new Promise<void>((res) => blocker.close(() => res()));
    }
  }, 20000);
});
