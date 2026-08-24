import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import http from "node:http";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { installToolShim, type ShimEnv } from "../../src/core/tool-shim.js";
import { readGatewayPid, isProcessAlive } from "../../src/core/gateway/status.js";

const execFileAsync = promisify(execFile);

/**
 * End-to-end transparent routing through the ACTUAL generated `claude` shim, with a fake `claude`
 * binary and a fake Anthropic upstream, no real network, no real credential (every fake credential
 * carries a FAKE marker), async spawn only (an in-worker fake upstream deadlocks under spawnSync).
 *
 * Proves the hard rails:
 *  1. FAIL-OPEN, a broken/missing compaction CLI still runs the real claude unchanged, exit code
 *     preserved, no ANTHROPIC_BASE_URL injected.
 *  2. RECORD byte-safety, the upstream receives the request body + credential headers byte-identical;
 *     the client receives the exact upstream response bytes.
 *  3. Persistent lifecycle, first run starts ONE gateway (pidfile), second run REUSES it.
 *  4. Content-free receipts, token counts land; no prompt text, no credential anywhere on disk.
 *  5. No double-capture, routing writes gateway receipts only, never activity events (the Stop
 *     hook remains the sole activity source).
 */
const TSX = path.resolve("node_modules/.bin/tsx");
const CLI_ENTRY = path.resolve("src/cli/index.ts");

// FAKE credentials (test-only tripwires; the FAKE marker keeps the secret scanner honest).
const FAKE_API_KEY = "sk-ant-FAKE-test-key-tripwire";
const FAKE_OAUTH = "Bearer FAKE-oauth-credential-tripwire";
const SECRET_PROMPT = "SECRET_PROMPT_omega_fake";

let root: string;
let realBinDir: string;
let home: string;
let projDir: string;
let compactionBin: string;
let shimPath: string;
let upstream: http.Server;
let upstreamUrl: string;
let upstreamSeen: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders; body: string }>;

const UPSTREAM_RESPONSE = JSON.stringify({
  id: "msg_01",
  type: "message",
  role: "assistant",
  content: [{ type: "text", text: "RESP_TEXT_kappa" }],
  usage: { input_tokens: 100, cache_read_input_tokens: 25, output_tokens: 9 }
});

/** The fake `claude`: POSTs to ANTHROPIC_BASE_URL when set (proving injection), else says DIRECT. */
const FAKE_CLAUDE_JS = `
const http = require("node:http");
const base = process.env.ANTHROPIC_BASE_URL;
const args = process.argv.slice(2).join(" ");
if (!base) { console.log("DIRECT args=" + args); process.exit(7); }
const body = JSON.stringify({ model: "claude-test", messages: [{ role: "user", content: ${JSON.stringify(SECRET_PROMPT)} }] });
const url = new URL("/v1/messages", base);
const req = http.request(
  { hostname: url.hostname, port: url.port, path: url.pathname, method: "POST",
    headers: { "content-type": "application/json", "x-api-key": ${JSON.stringify(FAKE_API_KEY)},
      authorization: ${JSON.stringify(FAKE_OAUTH)}, "content-length": Buffer.byteLength(body) } },
  (res) => { let data = ""; res.on("data", (c) => (data += c)); res.on("end", () => { console.log("ROUTED " + data); process.exit(7); }); }
);
req.on("error", (e) => { console.log("REQERR " + e.message); process.exit(8); });
req.end(body);
`;

function shimRunEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    HOME: home,
    COMPACTION_HOME: path.join(home, ".compaction"),
    PATH: `${path.dirname(process.execPath)}${path.delimiter}/usr/bin${path.delimiter}/bin`,
    COMPACTION_BIN: compactionBin,
    COMPACTION_GATEWAY_UPSTREAM: upstreamUrl,
    NO_COLOR: "1",
    ...overrides
  } as NodeJS.ProcessEnv;
}

async function runShim(args: string[], envOverrides: Record<string, string | undefined> = {}): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const res = await execFileAsync("bash", [shimPath, ...args], { cwd: projDir, env: shimRunEnv(envOverrides), timeout: 30_000 });
    return { stdout: res.stdout, stderr: res.stderr, code: 0 };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", code: typeof e.code === "number" ? e.code : 1 };
  }
}

function receiptsPath(): string {
  return path.join(projDir, ".compaction", "gateway", "receipts.jsonl");
}

function receiptLines(): string[] {
  if (!existsSync(receiptsPath())) return [];
  return readFileSync(receiptsPath(), "utf8").trim().split("\n").filter(Boolean);
}

async function waitFor(check: () => boolean, ms = 5000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return check();
}

function killGatewayIfRunning(): void {
  const rec = readGatewayPid(projDir);
  if (rec && isProcessAlive(rec.pid)) {
    try {
      process.kill(rec.pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
}

beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), "claude-shim-e2e-"));
  realBinDir = path.join(root, "realbin");
  home = path.join(root, "home");
  projDir = path.join(root, "proj");
  mkdirSync(realBinDir, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(projDir, { recursive: true });

  // Fake upstream Anthropic API (async in-test server).
  upstreamSeen = [];
  upstream = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      upstreamSeen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(UPSTREAM_RESPONSE);
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
  const addr = upstream.address() as { port: number };
  upstreamUrl = `http://127.0.0.1:${addr.port}`;

  // Fake `claude` = bash wrapper → node script (echo/route + DISTINCT exit code 7).
  const fakeClaudeJs = path.join(realBinDir, "fake-claude.cjs");
  writeFileSync(fakeClaudeJs, FAKE_CLAUDE_JS, "utf8");
  const claude = path.join(realBinDir, "claude");
  writeFileSync(claude, `#!/usr/bin/env bash\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeClaudeJs)} "$@"\n`, "utf8");
  chmodSync(claude, 0o755);

  // COMPACTION_BIN stub → the real CLI via tsx (`gateway ensure` + the detached `gateway start`).
  compactionBin = path.join(root, "compaction-test");
  writeFileSync(compactionBin, `#!/usr/bin/env bash\nexec ${JSON.stringify(TSX)} ${JSON.stringify(CLI_ENTRY)} "$@"\n`, "utf8");
  chmodSync(compactionBin, 0o755);

  // Install the shim against the controlled PATH.
  const shimEnv: ShimEnv = { HOME: home, COMPACTION_HOME: path.join(home, ".compaction"), PATH: realBinDir };
  const install = installToolShim("claude-code", shimEnv);
  expect(install.status).toBe("installed-not-on-path");
  shimPath = install.shimPath;
});

afterEach(async () => {
  killGatewayIfRunning();
  await waitFor(() => {
    const rec = readGatewayPid(projDir);
    return !rec || !isProcessAlive(rec.pid);
  }, 3000);
  await new Promise<void>((r) => upstream.close(() => r()));
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("claude transparent-routing shim (e2e: fake claude + fake upstream)", () => {
  it(
    "routes a normal run through a persistent RECORD gateway: transparent stdout/exit, byte-identical request+response, untouched credential, content-free receipt, reuse on the second run, no activity double-capture",
    async () => {
      // ---- First run: starts the persistent gateway, routes, execs the fake claude.
      const first = await runShim(["-p", "do the thing"]);
      expect(first.code).toBe(7); // the real tool's exit code, preserved
      expect(first.stdout).toContain(`ROUTED ${UPSTREAM_RESPONSE}`); // exact upstream bytes reached the client

      // The upstream saw the request byte-for-byte, credential headers untouched.
      expect(upstreamSeen).toHaveLength(1);
      const seen = upstreamSeen[0];
      expect(seen.method).toBe("POST");
      expect(seen.url).toBe("/v1/messages");
      expect(JSON.parse(seen.body).messages[0].content).toBe(SECRET_PROMPT); // byte-identical body
      expect(seen.headers["x-api-key"]).toBe(FAKE_API_KEY);
      expect(seen.headers.authorization).toBe(FAKE_OAUTH);

      // Persistent gateway: pidfile written, process alive, RECORD mode, NO workflow identity
      // (the byte-safe shape - the stored-authorization apply path is structurally unreachable).
      const rec = readGatewayPid(projDir);
      expect(rec).not.toBeNull();
      expect(isProcessAlive(rec!.pid)).toBe(true);
      expect(rec!.mode).toBe("record");
      expect(rec!.provider).toBe("anthropic");
      expect(rec!.workflow).toBeUndefined();
      expect(rec!.host).toBe("127.0.0.1"); // local-only bind

      // Content-free receipt (async append - poll briefly).
      expect(await waitFor(() => receiptLines().length >= 1)).toBe(true);
      const receipt = JSON.parse(receiptLines()[0]);
      expect(receipt.provider).toBe("anthropic");
      expect(receipt.mode).toBe("record");
      expect(receipt.request_mutated ?? false).toBe(false);
      // Adapter selection is by upstream HOST; a localhost fake upstream falls back to the default
      // OpenAI parser (documented), which still reads input_tokens/output_tokens - token counts
      // land, Anthropic-specific cache fields are exercised by the adapter unit tests.
      expect(receipt.tokens.prompt_input).toBe(100);
      expect(receipt.tokens.output).toBe(9);

      // Tripwire: no credential and no prompt/response content anywhere Compaction persisted.
      const receiptsRaw = readFileSync(receiptsPath(), "utf8");
      const pidRaw = readFileSync(path.join(projDir, ".compaction", "gateway", "gateway.json"), "utf8");
      for (const persisted of [receiptsRaw, pidRaw]) {
        expect(persisted).not.toContain(FAKE_API_KEY);
        expect(persisted).not.toContain("FAKE-oauth-credential");
        expect(persisted).not.toContain(SECRET_PROMPT);
        expect(persisted).not.toContain("RESP_TEXT_kappa");
      }

      // No double-capture: routing produced gateway receipts ONLY - zero activity events (the
      // Claude Code Stop hook remains the single activity/measurement source).
      expect(existsSync(path.join(projDir, ".compaction", "activity", "activity.jsonl"))).toBe(false);

      // ---- Second run: REUSES the running gateway (same pid - no second start).
      const second = await runShim(["-p", "again"]);
      expect(second.code).toBe(7);
      expect(second.stdout).toContain("ROUTED ");
      const rec2 = readGatewayPid(projDir);
      expect(rec2!.pid).toBe(rec!.pid);
      expect(upstreamSeen).toHaveLength(2);
      expect(await waitFor(() => receiptLines().length >= 2)).toBe(true);
    },
    60_000
  );

  it("FAIL-OPEN: a broken compaction CLI → the real claude runs unchanged (no injection, exit preserved, nothing persisted)", async () => {
    const failingBin = path.join(root, "compaction-broken");
    writeFileSync(failingBin, "#!/usr/bin/env bash\nexit 1\n", "utf8");
    chmodSync(failingBin, 0o755);
    const res = await runShim(["-p", "hello"], { COMPACTION_BIN: failingBin });
    expect(res.code).toBe(7); // the real tool still ran, exit code preserved
    expect(res.stdout).toContain("DIRECT args=-p hello"); // no ANTHROPIC_BASE_URL leaked into the child
    expect(readGatewayPid(projDir)).toBeNull();
    expect(receiptLines()).toHaveLength(0);
  });

  it("FAIL-OPEN: a missing compaction CLI → the real claude runs unchanged", async () => {
    const res = await runShim(["--version"], { COMPACTION_BIN: path.join(root, "does-not-exist") });
    expect(res.code).toBe(7);
    expect(res.stdout).toContain("DIRECT args=--version");
  });

  it("FAIL-OPEN: stale baked REAL_BIN + a real claude elsewhere on PATH → the shim re-resolves and execs it unrouted (no self-recursion even with its own dir FIRST on PATH)", async () => {
    // Simulate a Claude Code reinstall: the baked path disappears, the real binary now lives in
    // a NEW dir. The shim dir goes FIRST on PATH - a naive `command -v claude` would find the
    // shim itself and recurse forever; exact-dir stripping must skip it.
    const newBinDir = path.join(root, "newbin");
    mkdirSync(newBinDir, { recursive: true });
    const fakeClaudeJs = path.join(realBinDir, "fake-claude.cjs");
    const moved = path.join(newBinDir, "claude");
    writeFileSync(moved, `#!/usr/bin/env bash\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeClaudeJs)} "$@"\n`, "utf8");
    chmodSync(moved, 0o755);
    rmSync(path.join(realBinDir, "claude")); // the baked REAL_BIN is now stale

    const shimDir = path.dirname(shimPath);
    const res = await runShim(["-p", "still works"], {
      PATH: `${shimDir}${path.delimiter}${newBinDir}${path.delimiter}/usr/bin${path.delimiter}/bin`
    });
    expect(res.code).toBe(7); // the real tool ran; its exit code preserved
    expect(res.stdout).toContain("DIRECT args=-p still works"); // unrouted - no ANTHROPIC_BASE_URL injected
    expect(readGatewayPid(projDir)).toBeNull(); // no gateway on the stale-path fallback
    expect(receiptLines()).toHaveLength(0);
  });

  it("stale baked REAL_BIN and NO claude anywhere on PATH → honest re-connect error, non-zero exit", async () => {
    rmSync(path.join(realBinDir, "claude"));
    const shimDir = path.dirname(shimPath);
    const res = await runShim(["--version"], {
      PATH: `${shimDir}${path.delimiter}/usr/bin${path.delimiter}/bin` // shim dir present; no claude anywhere
    });
    expect(res.code).toBe(127);
    expect(res.stderr).toContain("no other claude is on PATH");
    expect(res.stderr).toContain("re-run 'compaction init --connect 1'");
    expect(res.stdout).not.toContain("DIRECT"); // it did not run anything
  });

  it("never clobbers an existing ANTHROPIC_BASE_URL (no double-route: gateway run / user override wins)", async () => {
    const res = await runShim(["-p", "x"], { ANTHROPIC_BASE_URL: upstreamUrl });
    expect(res.code).toBe(7);
    // The fake claude hit the PRE-SET base directly; the shim started no gateway and injected nothing.
    expect(res.stdout).toContain(`ROUTED ${UPSTREAM_RESPONSE}`);
    expect(readGatewayPid(projDir)).toBeNull();
    expect(receiptLines()).toHaveLength(0);
  });
});
