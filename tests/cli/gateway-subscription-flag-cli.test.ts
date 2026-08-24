import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, request, type RequestOptions, type Server } from "node:http";
import https from "node:https";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runThroughGateway } from "../../src/cli/commands/dev.js";

/**
 * The PUBLIC `--subscription` flag on `gateway run`, proven against a fake Anthropic-pinned
 * upstream (no live call, no real credential):
 *
 *  - `--subscription` maps to the existing subscription transport: the launched `claude` binary's
 *    `/v1/messages` request routes through the ephemeral local gateway with the client credential
 *    forwarded UNTOUCHED (byte-identical at the fake upstream) and the response returned
 *    byte-identical (byte-safe); the outbound target is pinned to api.anthropic.com;
 *  - the credential NEVER appears in receipts, logs, or CLI output (tripwire);
 *  - default OFF: without `--subscription` no capability route exists and the injected base URL is
 *    the plain gateway address;
 *  - honest rejections: non-anthropic provider (Codex subscription is vendor-blocked), a
 *    non-claude command, an incompatible --workflow, and --upstream are all refused up front.
 */
const CLIENT_CRED = "Bearer sk-fake-saved-login-cli-NEVER-STORED";
const REQUEST_BODY = JSON.stringify({ model: "claude-x", messages: [{ role: "user", content: "hello from the fake claude cli" }] });
const UPSTREAM_REPLY = JSON.stringify({ id: "msg_cli", usage: { input_tokens: 21, cache_read_input_tokens: 0, output_tokens: 3 } });

interface Seen {
  url?: string;
  auth?: string;
  host?: string;
  body: string;
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/** A fake `claude` binary: POSTs one /v1/messages request to ANTHROPIC_BASE_URL and records the outcome. */
function writeFakeClaude(dir: string, outFile: string): string {
  const script = [
    "#!/usr/bin/env node",
    'const fs = require("node:fs");',
    "const base = process.env.ANTHROPIC_BASE_URL ?? '';",
    `const body = ${JSON.stringify(REQUEST_BODY)};`,
    "fetch(`${base}/v1/messages`, {",
    '  method: "POST",',
    `  headers: { "content-type": "application/json", authorization: ${JSON.stringify(CLIENT_CRED)}, "anthropic-version": "2023-06-01" },`,
    "  body",
    "})",
    "  .then((res) => res.text().then((text) => ({ status: res.status, text })))",
    `  .then((result) => { fs.writeFileSync(${JSON.stringify(outFile)}, JSON.stringify({ ...result, base })); process.exit(0); })`,
    `  .catch((err) => { fs.writeFileSync(${JSON.stringify(outFile)}, JSON.stringify({ error: String(err), base })); process.exit(3); });`,
    ""
  ].join("\n");
  const file = join(dir, "claude");
  writeFileSync(file, script, "utf8");
  chmodSync(file, 0o755);
  return file;
}

describe("gateway run --subscription (public flag, fake upstream, no keys)", () => {
  const servers: Server[] = [];
  const dirs: string[] = [];
  let originalCwd = "";
  let errors: string[] = [];
  let exitCodes: number[] = [];
  let originalStdinIsTty: boolean | undefined;

  beforeEach(() => {
    originalCwd = process.cwd();
    errors = [];
    exitCodes = [];
    // Simulate the real terminal user: `gateway run` refuses a bare interactive `claude` when stdin is
    // not a TTY (vitest workers are not), and these tests prove the interactive route itself.
    originalStdinIsTty = process.stdin.isTTY;
    process.stdin.isTTY = true;
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      exitCodes.push(code ?? 0);
      return undefined as never;
    }) as typeof process.exit);
  });

  afterEach(async () => {
    process.stdin.isTTY = originalStdinIsTty as boolean;
    process.chdir(originalCwd);
    process.exitCode = 0;
    await Promise.all(servers.splice(0).map(close));
    dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
    vi.restoreAllMocks();
  });

  function tempCwd(prefix: string): string {
    const cwd = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(cwd);
    return cwd;
  }

  async function startFakeAnthropic(): Promise<{ seen: Seen[]; pinned: RequestOptions[] }> {
    const seen: Seen[] = [];
    const upstream = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        seen.push({
          url: req.url,
          auth: req.headers.authorization as string | undefined,
          host: req.headers.host as string | undefined,
          body: Buffer.concat(chunks).toString("utf8")
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(UPSTREAM_REPLY);
      });
    });
    servers.push(upstream);
    const port = await listen(upstream);
    const pinned: RequestOptions[] = [];
    vi.spyOn(https, "request").mockImplementation(((options: RequestOptions, onResponse: (response: unknown) => void) => {
      pinned.push({ ...options });
      return request({ ...options, protocol: "http:", hostname: "127.0.0.1", port }, onResponse as Parameters<typeof request>[1]);
    }) as typeof https.request);
    return { seen, pinned };
  }

  it("routes the claude binary's /v1/messages through the gateway: credential untouched, bytes unchanged, origin pinned, receipt recorded credential-free", async () => {
    const cwd = tempCwd("sub-flag-route-");
    process.chdir(cwd);
    const { seen, pinned } = await startFakeAnthropic();
    const outFile = join(cwd, "result.json");
    const claude = writeFakeClaude(cwd, outFile);

    await runThroughGateway([claude], { provider: "anthropic", subscription: true });

    expect(exitCodes).toEqual([0]); // the child's exit code, preserved
    const result = JSON.parse(readFileSync(outFile, "utf8")) as { status: number; text: string; base: string };
    expect(result.status).toBe(200);
    expect(result.text).toBe(UPSTREAM_REPLY); // response bytes unchanged through the route
    expect(result.base).toMatch(/\/__compaction\/claude\/[A-Za-z0-9_-]{32,128}$/); // the ephemeral route capability

    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("/v1/messages");
    expect(seen[0].body).toBe(REQUEST_BODY); // request bytes unchanged
    expect(seen[0].auth).toBe(CLIENT_CRED); // saved-login credential forwarded UNTOUCHED
    expect(seen[0].host).toBe("api.anthropic.com");
    expect(pinned).toHaveLength(1);
    expect(pinned[0].hostname).toBe("api.anthropic.com"); // pinned origin - never the ordinary upstream

    // One content-free receipt was recorded for the routed request.
    const receiptsFile = join(cwd, ".compaction", "gateway", "receipts.jsonl");
    expect(existsSync(receiptsFile)).toBe(true);
    const receipts = readFileSync(receiptsFile, "utf8");
    expect(receipts.trim().split("\n")).toHaveLength(1);

    // Tripwire: the credential never appears in receipts, CLI output, or the capability in output.
    const allOutput = `${receipts}\n${errors.join("\n")}`;
    expect(allOutput).not.toContain(CLIENT_CRED);
    expect(allOutput).not.toContain("sk-fake-saved-login");
    expect(errors.join("\n")).toContain("ephemeral local subscription route");
  }, 20000);

  it("default OFF: without --subscription the injected base URL is the plain gateway address (no capability route)", async () => {
    const cwd = tempCwd("sub-flag-off-");
    process.chdir(cwd);
    await startFakeAnthropic();
    const outFile = join(cwd, "env.json");
    const script = `require("node:fs").writeFileSync(${JSON.stringify(outFile)}, JSON.stringify({ base: process.env.ANTHROPIC_BASE_URL }));`;

    await runThroughGateway([process.execPath, "-e", script], { provider: "anthropic" });

    expect(exitCodes).toEqual([0]);
    const observed = JSON.parse(readFileSync(outFile, "utf8")) as { base: string };
    expect(observed.base).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(observed.base).not.toContain("__compaction/claude");
  }, 20000);

  it("rejects --subscription for a non-anthropic provider with the honest vendor-blocked reason", async () => {
    await runThroughGateway(["claude"], { provider: "openai", subscription: true });
    expect(process.exitCode).toBe(1);
    expect(exitCodes).toEqual([]); // no gateway, no child
    expect(errors.join("\n")).toContain("saved Anthropic login only");
    expect(errors.join("\n")).toContain("vendor-blocked");
  });

  it("rejects --subscription for a non-claude command with the exact usage", async () => {
    await runThroughGateway(["npm", "run", "dev"], { provider: "anthropic", subscription: true });
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("'npm' is not the claude binary");
    expect(errors.join("\n")).toContain("compaction gateway run --provider anthropic --subscription -- claude");
  });

  it("rejects --subscription with an incompatible --workflow and with --upstream (pinned origin)", async () => {
    await runThroughGateway(["claude"], { provider: "anthropic", subscription: true, workflow: "codex" });
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("--workflow 'codex' is not compatible");

    process.exitCode = 0;
    errors = [];
    await runThroughGateway(["claude"], { provider: "anthropic", subscription: true, upstream: "https://evil.invalid" });
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("pins the Anthropic upstream");
  });
});
