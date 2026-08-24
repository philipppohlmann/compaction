import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Integration tests for `compaction upgrade` + `compaction status`.
 *
 * Everything is LOCAL and OFFLINE: a `node:http` server bound to 127.0.0.1 stands in for the
 * `/v0/status` health check (no external calls, no deps). NOTHING here may run against the DEFAULT
 * target: the default is the PRODUCTION origin, so a case that leaves the URL unset would put a live
 * request to the real service inside the test suite. Every case names its endpoint. `COMPACTION_CONFIG_DIR` points every run
 * at a tmpdir, so the real `~/.compaction` is NEVER touched. The API key is an obviously-fake,
 * non-secret token; every test greps the COMBINED stdout+stderr and asserts the full key never
 * appears on ANY path.
 */

const CLI = join(__dirname, "..", "..", "dist", "cli", "index.js");
const FAKE_KEY = "ck_test_deadbeefdeadbeef0000";
const NO_LIVE_ENDPOINT_MESSAGE =
  "no public hosted Compaction endpoint is live yet; hosted access is private-beta; pass `--api-url <url>` (private-beta/staging/self-hosted) or set `COMPACTION_API_URL`.";
/** The LOOPBACK dev origin — the one target that legitimately has nothing to validate against. */
const LOCAL_DEV_URL = "http://127.0.0.1:8787";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "compaction-upg-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

interface Mock {
  url: string;
  close: () => Promise<void>;
}

/** Start a 127.0.0.1 mock that answers `GET /v0/status` with the given HTTP status. */
async function startMock(status: number, body: unknown = { status: "ok", service: "compaction-api", version: "v0" }): Promise<Mock> {
  const server: Server = createServer((req, res) => {
    if (req.method === "GET" && (req.url ?? "").startsWith("/v0/status")) {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

/**
 * Run the built CLI ASYNCHRONOUSLY (execFile, not execFileSync). This matters: the mock server runs
 * IN THIS process, so a synchronous spawn would block the event loop and the server could never
 * answer the child's health check. Async keeps the loop free to serve `/v0/status`.
 */
function runCli(args: string[], extraEnv: Record<string, string> = {}, cwd?: string): Promise<{ out: string; code: number }> {
  // Baseline: config dir AND HOME → tmpdir (status also renders the local readiness report, which
  // must stay hermetic - never scanning the real ~/.claude or ~/.compaction); NO hosted env unless
  // a case sets it.
  const env = { ...process.env, HOME: dir, COMPACTION_CONFIG_DIR: dir, COMPACTION_API_URL: "", COMPACTION_API_KEY: "", ...extraEnv };
  return new Promise((resolve) => {
    execFile("node", [CLI, ...args], { encoding: "utf8", env, ...(cwd ? { cwd } : {}) }, (err, stdout, stderr) => {
      const out = `${stdout ?? ""}${stderr ?? ""}`;
      const code = err && typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : err ? 1 : 0;
      resolve({ out, code });
    });
  });
}

/** Seed a content-free receipts.jsonl under `<cwd>/.compaction/gateway` so `status` has last-turn lines. */
function seedReceipts(runCwd: string, records: Array<Record<string, unknown>>): void {
  const gwDir = join(runCwd, ".compaction", "gateway");
  mkdirSync(gwDir, { recursive: true });
  writeFileSync(join(gwDir, "receipts.jsonl"), records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
}

function recordReceipt(id: string, promptInput: number, output: number): Record<string, unknown> {
  return {
    receipt_id: id,
    provider: "anthropic",
    endpoint: "/v1/messages",
    mode: "record",
    upstream_status: 200,
    tokens: { prompt_input: promptInput, output },
    cost: { status: "unavailable" }
  };
}

const configFile = () => join(dir, "config.json");

describe("compaction upgrade - fail-closed matrix, no key leak, no live-endpoint pretense", () => {
  it("key-only against the LOOPBACK dev origin: FAILS GRACEFULLY, persists nothing, no key leak", async () => {
    // THE TARGET IS NAMED, and that is the point of this edit. This case used to pass no URL at all
    // and call the default "the local default" — true only while the default WAS loopback. Once the
    // default was repointed at production, leaving it unset meant this test made a live request to
    // the real service on every run, and asserted a refusal the CLI correctly no longer prints.
    // The property under test is unchanged: against an origin with nothing to validate against, the
    // refusal is graceful, persists nothing, and never leaks the key. That the PRODUCTION default is
    // NOT this origin is proven hermetically in `tests/core/persisted-config.test.ts`.
    const r = await runCli(["upgrade", "--key", FAKE_KEY], { COMPACTION_API_URL: LOCAL_DEV_URL });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain(NO_LIVE_ENDPOINT_MESSAGE);
    expect(r.out).not.toMatch(/api\.compaction\.dev/); // never pretends a remote is live
    expect(existsSync(configFile())).toBe(false); // persisted NOTHING
    expect(r.out).not.toContain(FAKE_KEY); // key never printed on any path
  }, 20000);

  it("401: FAILS CLOSED, persists nothing, no key leak", async () => {
    const mock = await startMock(401, { error: "unauthorized" });
    try {
      const r = await runCli(["upgrade", "--key", FAKE_KEY, "--api-url", mock.url]);
      expect(r.code).not.toBe(0);
      expect(r.out).toMatch(/rejected this API key \(HTTP 401\)/);
      expect(r.out).toMatch(/Nothing was saved/);
      expect(existsSync(configFile())).toBe(false);
      expect(r.out).not.toContain(FAKE_KEY);
    } finally {
      await mock.close();
    }
  }, 20000);

  it("network/unreachable: fails, persists nothing, no key leak", async () => {
    const r = await runCli(["upgrade", "--key", FAKE_KEY, "--api-url", "http://127.0.0.1:1"]);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/could not reach/);
    expect(existsSync(configFile())).toBe(false);
    expect(r.out).not.toContain(FAKE_KEY);
  }, 20000);

  it("200: persists {api_url,api_key} at mode 0600, output MASKS the key, no full-key leak", async () => {
    const mock = await startMock(200);
    try {
      const r = await runCli(["upgrade", "--key", FAKE_KEY, "--api-url", mock.url]);
      expect(r.code).toBe(0);
      expect(r.out).toMatch(/Hosted upgrade configured/);
      expect(r.out).toContain("ck_test_…0000"); // masked form present
      expect(r.out).not.toContain(FAKE_KEY); // full key NEVER printed

      expect(existsSync(configFile())).toBe(true);
      expect((statSync(configFile()).mode & 0o777).toString(8)).toBe("600");
      const saved = JSON.parse(readFileSync(configFile(), "utf8"));
      expect(saved).toEqual({ api_url: mock.url, api_key: FAKE_KEY }); // key stored ONLY in the 0600 file
    } finally {
      await mock.close();
    }
  }, 20000);

  it("precedence: --api-url flag overrides a bad env URL (flag wins → success)", async () => {
    const good = await startMock(200);
    try {
      const r = await runCli(["upgrade", "--key", FAKE_KEY, "--api-url", good.url], {
        COMPACTION_API_URL: "http://127.0.0.1:1" // env points at an unreachable port; flag must win
      });
      expect(r.code).toBe(0);
      expect(r.out).toMatch(/Hosted upgrade configured/);
      expect(r.out).not.toContain(FAKE_KEY);
    } finally {
      await good.close();
    }
  }, 20000);
});

describe("compaction status - honest, masked, capabilities only when reachable", () => {
  it("unconfigured: Account & access shows not connected, NO local-only / connect copy, no key leak", async () => {
    const r = await runCli(["status", "--projects-dir", join(dir, "none")]);
    expect(r.code).toBe(0);
    // F52/F55: an unconfigured device reads through the Account & access section, not the old
    // misleading "Hosted endpoint / Mode: local-only / Connect a private-beta …" block.
    expect(r.out).toContain("Account & access");
    expect(r.out).toContain("Account: not connected");
    expect(r.out).toContain("Run compaction to set up Community.");
    expect(r.out).not.toMatch(/Mode: local-only/);
    expect(r.out).not.toMatch(/Connect a private-beta/);
    expect(r.out).not.toMatch(/Capabilities/); // no tier claims when unconfigured
    expect(r.out).not.toContain(FAKE_KEY);
  }, 20000);

  it("configured + reachable: masked key + host, reachable, capabilities shown, no key leak", async () => {
    const mock = await startMock(200);
    try {
      // Persist via upgrade first, then re-check live via status (server still up).
      expect((await runCli(["upgrade", "--key", FAKE_KEY, "--api-url", mock.url])).code).toBe(0);
      const r = await runCli(["status", "--projects-dir", join(dir, "none")]);
      expect(r.code).toBe(0);
      expect(r.out).toMatch(/Hosted API: configured/);
      expect(r.out).toContain("ck_test_…0000");
      expect(r.out).toMatch(/Reachability: reachable/);
      expect(r.out).toMatch(/Mode: private beta \(hosted\)/);
      expect(r.out).toMatch(/unlocked by the hosted tier \(not individually confirmed live here\)/);
      expect(r.out).not.toContain(FAKE_KEY);
    } finally {
      await mock.close();
    }
  }, 20000);

  it("configured + unreachable: reports unreachable, NO capabilities claim, no key leak", async () => {
    const mock = await startMock(200);
    expect((await runCli(["upgrade", "--key", FAKE_KEY, "--api-url", mock.url])).code).toBe(0);
    await mock.close(); // now the persisted endpoint is down

    const r = await runCli(["status", "--projects-dir", join(dir, "none")]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Hosted API: configured/);
    expect(r.out).toMatch(/Reachability: unreachable/);
    expect(r.out).not.toMatch(/unlocked by the hosted tier/); // capabilities suppressed when unreachable
    expect(r.out).not.toContain(FAKE_KEY);
  }, 20000);
});

describe("compaction status - 'Last turns' section (last 3 per-turn receipt lines)", () => {
  it("renders the last 3 canonical content-free lines, newest last", async () => {
    const runCwd = mkdtempSync(join(tmpdir(), "compaction-status-cwd-"));
    try {
      // Five receipts; status shows the last three via the SAME formatter `compaction watch` uses.
      seedReceipts(
        runCwd,
        [1, 2, 3, 4, 5].map((n) => recordReceipt(`cccccc${n}0000000000000000000000000000`, 1000 * n, 10 * n))
      );
      const r = await runCli(["status", "--projects-dir", join(dir, "none")], {}, runCwd);
      expect(r.code).toBe(0);
      expect(r.out).toMatch(/Last turns \(most recent 3/);
      // The last three (3000/4000/5000 input) are shown; the first two (1000/2000) are not.
      expect(r.out).toContain("input 3,000");
      expect(r.out).toContain("input 5,000");
      expect(r.out).not.toContain("input 1,000");
      expect(r.out).not.toContain("input 2,000");
    } finally {
      rmSync(runCwd, { recursive: true, force: true });
    }
  }, 20000);

  it("empty store: honest 'no turns recorded yet', never an error (exit 0)", async () => {
    const runCwd = mkdtempSync(join(tmpdir(), "compaction-status-cwd-"));
    try {
      const r = await runCli(["status", "--projects-dir", join(dir, "none")], {}, runCwd);
      expect(r.code).toBe(0);
      expect(r.out).toMatch(/Last turns/);
      expect(r.out).toMatch(/no turns recorded yet/);
    } finally {
      rmSync(runCwd, { recursive: true, force: true });
    }
  }, 20000);

  it("kill switch (COMPACTION_RECEIPT_LINE=0): the 'Last turns' section is OMITTED entirely", async () => {
    const runCwd = mkdtempSync(join(tmpdir(), "compaction-status-cwd-"));
    try {
      seedReceipts(runCwd, [recordReceipt("dddddddd0000000000000000000000000000", 1000, 10)]);
      const r = await runCli(["status", "--projects-dir", join(dir, "none")], { COMPACTION_RECEIPT_LINE: "0" }, runCwd);
      expect(r.code).toBe(0);
      expect(r.out).not.toMatch(/Last turns/); // omitted when the user chose silence
    } finally {
      rmSync(runCwd, { recursive: true, force: true });
    }
  }, 20000);
});
