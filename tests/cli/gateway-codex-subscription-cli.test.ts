import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, request, type RequestOptions, type Server } from "node:http";
import https from "node:https";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runThroughGateway } from "../../src/cli/commands/dev.js";

const AUTH = "Bearer SENTINEL_CHATGPT_LOGIN";
const ACCOUNT = "SENTINEL_CHATGPT_ACCOUNT";

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
}
function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe("gateway run OpenAI/Codex ChatGPT subscription", () => {
  const servers: Server[] = [];
  const dirs: string[] = [];
  let originalCwd: string;
  let exitCodes: number[];
  let errors: string[];

  beforeEach(() => {
    originalCwd = process.cwd();
    exitCodes = [];
    errors = [];
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      exitCodes.push(code ?? 0);
      return undefined as never;
    }) as typeof process.exit);
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(" ")); });
  });
  afterEach(async () => {
    process.chdir(originalCwd);
    process.exitCode = 0;
    await Promise.all(servers.splice(0).map(close));
    dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
    vi.restoreAllMocks();
  });

  it("generates the authenticated Responses provider config and maps GET models + one POST responses", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "codex-sub-cli-"));
    dirs.push(cwd);
    process.chdir(cwd);
    const seen: Array<{ method?: string; url?: string; auth?: string; account?: string; body: string }> = [];
    const upstream = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        seen.push({
          method: req.method,
          url: req.url,
          auth: req.headers.authorization,
          account: req.headers["chatgpt-account-id"] as string | undefined,
          body: Buffer.concat(chunks).toString("utf8")
        });
        res.writeHead(200, { "content-type": req.method === "GET" ? "application/json" : "text/event-stream" });
        res.end(req.method === "GET"
          ? '{"models":[]}'
          : 'data: {"type":"response.completed","response":{"usage":{"input_tokens":8,"output_tokens":2}}}\n\n');
      });
    });
    servers.push(upstream);
    const upstreamPort = await listen(upstream);
    const pinned: RequestOptions[] = [];
    vi.spyOn(https, "request").mockImplementation(((options: RequestOptions, cb: (response: unknown) => void) => {
      pinned.push({ ...options });
      return request({ ...options, protocol: "http:", hostname: "127.0.0.1", port: upstreamPort }, cb as Parameters<typeof request>[1]);
    }) as typeof https.request);

    const out = join(cwd, "codex-result.json");
    const codex = join(cwd, "codex");
    writeFileSync(codex, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const entry = args.find((value) => value.startsWith("model_providers.compaction_subscription.base_url="));
const base = entry ? JSON.parse(entry.slice(entry.indexOf("=") + 1)) : "";
const headers = { authorization: ${JSON.stringify(AUTH)}, "chatgpt-account-id": ${JSON.stringify(ACCOUNT)}, "content-type": "application/json" };
Promise.all([
  fetch(base + "/models?client_version=0.153.4", { headers }),
  fetch(base + "/responses", { method: "POST", headers, body: JSON.stringify({ model: "gpt-5", input: [], stream: true }) })
]).then(async ([models, response]) => {
  fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({ args, base, models: models.status, response: response.status, body: await response.text() }));
}).catch((error) => { fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({ error: String(error), args, base })); process.exitCode = 3; });
`, "utf8");
    chmodSync(codex, 0o755);

    await runThroughGateway([codex, "exec", "hello"], { provider: "openai", workflow: "codex", subscription: true });

    expect(exitCodes).toEqual([0]);
    const result = JSON.parse(readFileSync(out, "utf8")) as { args: string[]; base: string; models: number; response: number };
    expect(result.models).toBe(200);
    expect(result.response).toBe(200);
    expect(result.base).toMatch(/\/__compaction\/codex\/[A-Za-z0-9_-]{32,128}\/backend-api\/codex$/);
    expect(result.args).toContain("model_providers.compaction_subscription.requires_openai_auth=true");
    expect(result.args).toContain('model_providers.compaction_subscription.wire_api="responses"');
    expect(seen.map((entry) => [entry.method, entry.url])).toEqual([
      ["GET", "/backend-api/codex/models?client_version=0.153.4"],
      ["POST", "/backend-api/codex/responses"]
    ]);
    expect(seen.every((entry) => entry.auth === AUTH && entry.account === ACCOUNT)).toBe(true);
    expect(pinned).toHaveLength(2);
    expect(pinned.every((target) => target.hostname === "chatgpt.com")).toBe(true);
    const receipts = readFileSync(join(cwd, ".compaction", "gateway", "receipts.jsonl"), "utf8");
    expect(receipts.trim().split("\n")).toHaveLength(1);
    expect(`${receipts}\n${errors.join("\n")}`).not.toContain(AUTH);
    expect(`${receipts}\n${errors.join("\n")}`).not.toContain(ACCOUNT);
    const capability = /\/__compaction\/codex\/([^/]+)\//.exec(result.base)?.[1];
    expect(capability).toBeTruthy();
    expect(errors.join("\n")).not.toContain(capability!);
  }, 20_000);
});
