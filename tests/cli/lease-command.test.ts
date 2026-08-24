/**
 * `compaction lease` service-URL routing (triage of Codex #819 lease.ts).
 *
 * Two LOCAL in-process fake lease services stand in for "the service this device logged in to" and
 * "a service the user points at explicitly". The advertised precedence is asserted end to end:
 * `--api-url` > `COMPACTION_API_URL` > the login-time service. Before the fix the credentials URL
 * (always present in a valid credentials file) shadowed every override, so the flag was inert.
 *
 * COMPACTION_CONFIG_DIR + HOME point at a tmpdir — the real ~/.compaction is NEVER touched, and the
 * device token is obviously fake. The CLI is spawned ASYNCHRONOUSLY (execFile): the fake servers run
 * IN THIS process, so a synchronous spawn would deadlock (see tests/cli/login-cli.test.ts).
 */
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeStoredCredentials } from "../../src/core/auth/credentials.js";
import { generateDevSigningKeyPair } from "../../src/core/engine-install/dev-signing.js";

const CLI = join(__dirname, "..", "..", "dist", "cli", "index.js");
const FAKE_DEVICE_ID = "123e4567-e89b-42d3-a456-426614174000";
const FAKE_TOKEN = `cmpd_test_${FAKE_DEVICE_ID}.fakefakefakefakefakefakefakefake`;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "compaction-lease-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

interface FakeService {
  url: string;
  /** Requests seen, method+path only. */
  seen: string[];
  close: () => Promise<void>;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** A fake `POST /v0/lease` issuer returning a well-formed (unverifiable) signed lease. */
async function startFakeLeaseService(label: string): Promise<FakeService> {
  const seen: string[] = [];
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    seen.push(`${req.method} ${path}`);
    if (req.method === "POST" && path === "/v0/lease") {
      if (req.headers.authorization !== `Bearer ${FAKE_TOKEN}`) return sendJson(res, 401, { error: "unauthorized" });
      return sendJson(res, 200, {
        lease: {
          schema_version: 1,
          lease_id: `lease-from-${label}`,
          account_id: "acct-1",
          device_public_key_hash: "a".repeat(64),
          period_id: "2026-07",
          allowance_tokens: 2_000_000,
          issued_at: "2026-07-01T00:00:00.000Z",
          expires_at: "2026-07-02T00:00:00.000Z",
          lease_sequence: 1,
          route_scope: "all"
        },
        // No trust root is installed in this test, so the CLI reports the honest local verdict.
        signature: "not-a-real-signature"
      });
    }
    return sendJson(res, 404, { error: "not_found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

/** A service that answers every request with a 307 redirect to `target` (another host). */
async function startRedirector(target: string): Promise<FakeService> {
  const seen: string[] = [];
  const server: Server = createServer((req, res) => {
    seen.push(`${req.method} ${(req.url ?? "/").split("?")[0]}`);
    res.writeHead(307, { location: target });
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

/** Write credentials naming `apiUrl` as the login-time service (throwaway key, fake token). */
function login(apiUrl: string): void {
  const throwaway = generateDevSigningKeyPair();
  writeStoredCredentials(
    {
      schema_version: 1,
      api_url: apiUrl,
      account_id: "acct-1",
      device_id: FAKE_DEVICE_ID,
      device_token: FAKE_TOKEN,
      device_private_key_pem: throwaway.privateKeyPem,
      device_public_key: throwaway.publicKeySpkiB64u,
      created_at: new Date().toISOString()
    },
    { COMPACTION_CONFIG_DIR: dir }
  );
}

/** Run the built CLI ASYNCHRONOUSLY (see module header). */
function runCli(args: string[], extraEnv: Record<string, string> = {}): Promise<{ out: string; code: number }> {
  const env = {
    ...process.env,
    HOME: dir,
    COMPACTION_CONFIG_DIR: dir,
    COMPACTION_API_URL: "",
    COMPACTION_API_KEY: "",
    ...extraEnv
  };
  return new Promise((resolve) => {
    execFile("node", [CLI, ...args], { encoding: "utf8", env }, (err, stdout, stderr) => {
      const out = `${stdout ?? ""}${stderr ?? ""}`;
      const code = err && typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : err ? 1 : 0;
      resolve({ out, code });
    });
  });
}

describe("compaction lease — which service the acquire contacts", () => {
  it("--api-url REDIRECTS the request away from the login-time service", async () => {
    const loginService = await startFakeLeaseService("login");
    const override = await startFakeLeaseService("override");
    try {
      login(loginService.url);
      const r = await runCli(["lease", "--api-url", override.url]);
      expect(r.code).toBe(0);
      expect(r.out).toContain("Lease acquired and stored.");
      expect(override.seen).toEqual(["POST /v0/lease"]);
      expect(loginService.seen).toEqual([]);
      expect(r.out).not.toContain(FAKE_TOKEN);
    } finally {
      await override.close();
      await loginService.close();
    }
  }, 30000);

  it("COMPACTION_API_URL redirects the request too", async () => {
    const loginService = await startFakeLeaseService("login");
    const override = await startFakeLeaseService("override");
    try {
      login(loginService.url);
      const r = await runCli(["lease"], { COMPACTION_API_URL: override.url });
      expect(r.code).toBe(0);
      expect(override.seen).toEqual(["POST /v0/lease"]);
      expect(loginService.seen).toEqual([]);
    } finally {
      await override.close();
      await loginService.close();
    }
  }, 30000);

  it("REFUSES a redirect — a response can never carry the device token to another host", async () => {
    const loginService = await startFakeLeaseService("login");
    const elsewhere = await startFakeLeaseService("elsewhere");
    try {
      login(loginService.url);
      const redirector = await startRedirector(`${elsewhere.url}/v0/lease`);
      try {
        const r = await runCli(["lease", "--api-url", redirector.url]);
        expect(r.code).not.toBe(0);
        expect(r.out).toContain("Could not acquire a lease");
        // The redirect target never saw the request (nor the token).
        expect(elsewhere.seen).toEqual([]);
      } finally {
        await redirector.close();
      }
    } finally {
      await elsewhere.close();
      await loginService.close();
    }
  }, 30000);

  it("with NO override the login-time service stays authoritative", async () => {
    const loginService = await startFakeLeaseService("login");
    try {
      login(loginService.url);
      const r = await runCli(["lease"]);
      expect(r.code).toBe(0);
      expect(loginService.seen).toEqual(["POST /v0/lease"]);
    } finally {
      await loginService.close();
    }
  }, 30000);
});
