import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import http from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ensureGateway, isGatewayReachable } from "../../src/core/gateway/ensure.js";
import { reviveRoutingGatewayIfDown } from "../../src/core/gateway/routing-revival.js";
import { isProcessAlive } from "../../src/core/gateway/status.js";
import {
  readRoutingSlot,
  resetRoutingPortSaltCache,
  routingDir,
  routingSlotKey,
  routingSlotLogPath,
  routingSlotPath,
  writeRoutingSlot
} from "../../src/core/gateway/routing-registry.js";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const CLI_DIST = path.join(REPO_ROOT, "dist/cli/index.js");

/**
 * Two hard rails on the routing surfaces this change adds.
 *
 * (8) CONTENT-FREE AND CREDENTIAL-FREE. The slot record, the new routing log, and the receipts must
 *     carry no provider credential, no prompt, and no response byte - the routing log especially,
 *     because it is a NEW on-disk artefact that did not exist before and now captures the gateway's
 *     own stdout.
 *
 * (8b) INVARIANT R-1. A listener that holds the reserved port but cannot pass the
 *     capability-authenticated identity handshake is never injected into, never spawned over, and
 *     never counted as "our gateway is back". This row exists precisely because the tempting
 *     shortcut - "the reserved port accepts connections, so our gateway must be back" - passes a
 *     TCP-only check and would hand a squatter the user's real provider credential.
 */
const FAKE_API_KEY = "sk-ant-FAKE-test-key-tripwire";
const FAKE_OAUTH = "Bearer FAKE-oauth-credential-tripwire";
const SECRET_PROMPT = "SECRET_PROMPT_omega_fake";
const RESPONSE_TEXT = "RESP_TEXT_kappa";

let root = "";
let home = "";
let projDir = "";
let env: { COMPACTION_HOME: string };
let upstream: http.Server | undefined;
let upstreamUrl = "";
const savedEnv: Record<string, string | undefined> = {};

function setEnv(key: string, value: string): void {
  savedEnv[key] = process.env[key];
  process.env[key] = value;
}

beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), "routing-content-free-"));
  home = path.join(root, "home");
  projDir = path.join(root, "proj");
  mkdirSync(home, { recursive: true });
  mkdirSync(projDir, { recursive: true });
  env = { COMPACTION_HOME: path.join(home, ".compaction") };
  resetRoutingPortSaltCache();
  // The gateway is spawned as a real detached child and inherits this process's environment, so the
  // redirection has to be here rather than only in the option bag.
  setEnv("HOME", home);
  setEnv("COMPACTION_HOME", env.COMPACTION_HOME);

  upstream = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ content: [{ type: "text", text: RESPONSE_TEXT }], usage: { input_tokens: 10, output_tokens: 3 } }));
    });
  });
  await new Promise<void>((r) => upstream!.listen(0, "127.0.0.1", () => r()));
  upstreamUrl = `http://127.0.0.1:${(upstream!.address() as { port: number }).port}`;
});

afterEach(async () => {
  const key = routingSlotKey({ cwd: projDir, provider: "anthropic" }, env);
  const slot = readRoutingSlot(key, env);
  if (slot && slot.pid > 0 && isProcessAlive(slot.pid)) {
    try {
      process.kill(slot.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetRoutingPortSaltCache();
  if (upstream) await new Promise<void>((r) => upstream!.close(() => r()));
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function postThroughGateway(base: string): Promise<string> {
  const body = JSON.stringify({ model: "claude-test", messages: [{ role: "user", content: SECRET_PROMPT }] });
  const url = new URL("/v1/messages", base);
  return await new Promise<string>((resolve) => {
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": FAKE_API_KEY,
          authorization: FAKE_OAUTH,
          "content-length": Buffer.byteLength(body)
        }
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve(data));
      }
    );
    req.on("error", (e) => resolve(`ERR ${e.message}`));
    req.end(body);
  });
}

describe("routing gateway: credential- and content-free at rest", () => {
  it("slot, log and receipts are credential- and content-free", async () => {
    const result = await ensureGateway({
      provider: "anthropic",
      upstream: upstreamUrl,
      cwd: projDir,
      cliEntry: CLI_DIST,
      env
    });
    expect(result.status).toBe("started");
    const base = (result as { base: string }).base;
    // Drive a REAL request carrying a fake credential and a distinctive prompt through it, so the
    // tripwires below are checking a file that actually saw traffic.
    const response = await postThroughGateway(base);
    expect(response).toContain(RESPONSE_TEXT);

    const key = routingSlotKey({ cwd: projDir, provider: "anthropic" }, env);
    await new Promise((r) => setTimeout(r, 400));

    const slotRaw = readFileSync(routingSlotPath(key, env), "utf8");
    const logRaw = existsSync(routingSlotLogPath(key, env)) ? readFileSync(routingSlotLogPath(key, env), "utf8") : "";
    const receiptsPath = path.join(projDir, ".compaction", "gateway", "receipts.jsonl");
    const receiptsRaw = existsSync(receiptsPath) ? readFileSync(receiptsPath, "utf8") : "";
    expect(receiptsRaw).not.toBe("");

    for (const [name, persisted] of [["slot", slotRaw], ["routing log", logRaw], ["receipts", receiptsRaw]] as const) {
      expect(persisted, `${name} must not carry a credential`).not.toContain(FAKE_API_KEY);
      expect(persisted, `${name} must not carry a credential`).not.toContain("FAKE-oauth-credential");
      expect(persisted, `${name} must not carry request content`).not.toContain(SECRET_PROMPT);
      expect(persisted, `${name} must not carry response content`).not.toContain(RESPONSE_TEXT);
    }

    // The routing log is the NEW artefact: assert it holds lifecycle lines and nothing per-request.
    expect(logRaw).toContain("start requested");
    expect(logRaw).not.toContain("x-api-key");
    expect(logRaw).not.toContain("authorization");

    // Modes: 0700 directory, 0600 files. The slot carries the control capability, so this is the
    // posture that keeps it as private as the pidfile it replaced.
    expect(statSync(routingDir(env)).mode & 0o777).toBe(0o700);
    for (const name of readdirSync(routingDir(env))) {
      const target = path.join(routingDir(env), name);
      if (statSync(target).isFile()) expect(statSync(target).mode & 0o777, `${name} must be 0600`).toBe(0o600);
    }
  }, 60_000);
});

/**
 * A fake listener that accepts TCP and answers EVERYTHING 200 - the perfect TCP-only impostor. It
 * holds no `controlCapability`, so it cannot forge `x-compaction-proof` and cannot pass the identity
 * handshake however cooperative it looks. Returns the port and the requests it saw.
 */
async function startSquatter(): Promise<{ port: number; seen: Array<{ url: string; headers: http.IncomingHttpHeaders }>; close: () => Promise<void> }> {
  const seen: Array<{ url: string; headers: http.IncomingHttpHeaders }> = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ url: req.url ?? "", headers: req.headers });
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return {
    port: (server.address() as { port: number }).port,
    seen,
    close: () => new Promise<void>((r) => server.close(() => r()))
  };
}

/** A slot pinning this directory to `port`, whose recorded owner is long gone. NOT quarantined. */
function pinSlotTo(port: number): string {
  const key = routingSlotKey({ cwd: projDir, provider: "anthropic" }, env);
  writeRoutingSlot(
    key,
    {
      pid: 999_999_999,
      host: "127.0.0.1",
      port,
      reservedPort: port,
      provider: "anthropic",
      upstream: upstreamUrl,
      mode: "record",
      cwd: projDir,
      startedAt: "2026-09-08T00:00:00.000Z",
      release: {
        instanceId: "a".repeat(48),
        controlCapability: "b".repeat(64),
        cliVersion: "0.6.8",
        protocolVersion: 1,
        pairId: "external:0.6.8"
      }
    },
    env
  );
  return key;
}

function assertNoCredentialReached(seen: Array<{ url: string; headers: http.IncomingHttpHeaders }>): void {
  // Everything the impostor may legitimately have received is the unauthenticated control probe,
  // which carries no credential at all. A provider request reaching it would be the failure this
  // whole invariant exists to prevent.
  for (const request of seen) {
    expect(request.url).not.toContain("/v1/");
    expect(request.headers["x-api-key"]).toBeUndefined();
    expect(request.headers.authorization).toBeUndefined();
    expect(JSON.stringify(request.headers)).not.toContain(FAKE_API_KEY);
    expect(JSON.stringify(request.headers)).not.toContain("FAKE-oauth-credential");
  }
}

/**
 * Each guard gets its OWN test against its OWN fresh slot.
 *
 * They were originally one test, and that hid a dead assertion: `gateway ensure` quarantines the
 * slot, after which the revival call returns `quarantined` from its quarantine check without ever
 * reaching the handshake - so the revival guard could be removed entirely and the test still passed.
 * Split, each assertion falsifies the code path it names.
 */
describe("routing gateway: a squatter on the reserved port is never injected into (invariant R-1)", () => {
  it("a fake listener holding the reserved port is never returned as a base URL and receives no credential", async () => {
    const squatter = await startSquatter();
    const key = pinSlotTo(squatter.port);
    try {
      // The pre-filter is satisfied: something really is accepting on that port.
      expect(await isGatewayReachable("127.0.0.1", squatter.port, 500)).toBe(true);

      const ensureRun = await execFileAsync(process.execPath, [CLI_DIST, "gateway", "ensure", "--provider", "anthropic"], {
        cwd: projDir,
        env: { ...process.env, HOME: home, COMPACTION_HOME: env.COMPACTION_HOME, COMPACTION_GATEWAY_UPSTREAM: upstreamUrl, NO_COLOR: "1" }
      }).then(
        (r) => ({ code: 0, stdout: r.stdout, stderr: r.stderr }),
        (e: { code?: number; stdout?: string; stderr?: string }) => ({ code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" })
      );
      expect(ensureRun.code).not.toBe(0);
      // The shim's whole contract is "stdout is the base URL". Nothing may appear there.
      expect(ensureRun.stdout).not.toContain("http://127.0.0.1:");
      expect(ensureRun.stdout.trim()).toBe("");
      // The slot is quarantined WITH the reason, so `gateway status` can report it rather than the
      // pinned session being silently abandoned.
      expect(readRoutingSlot(key, env)?.quarantine?.reason).toContain("failed the gateway identity handshake");
      assertNoCredentialReached(squatter.seen);
    } finally {
      await squatter.close();
    }
  }, 60_000);

  it("revival does not spawn on, or report recovery from, a reserved port held by a listener that fails the handshake", async () => {
    const squatter = await startSquatter();
    // A FRESH, non-quarantined slot: the revival path must reach the handshake and decide for
    // itself, not inherit a verdict some earlier call already wrote.
    const key = pinSlotTo(squatter.port);
    expect(readRoutingSlot(key, env)?.quarantine).toBeUndefined();
    try {
      const spawns: string[][] = [];
      const outcome = await reviveRoutingGatewayIfDown(projDir, {
        wait: true,
        env,
        spawnGatewayStart: (args) => {
          spawns.push(args);
        }
      });
      // "Reachable" must NEVER be read as "our gateway is back" - that shortcut is exactly what
      // would hand a squatter the user's provider credential.
      expect(outcome.status).toBe("quarantined");
      expect(outcome.reason).toContain("failed the gateway identity handshake");
      expect(spawns).toHaveLength(0);
      expect(readRoutingSlot(key, env)?.quarantine?.reason).toContain("failed the gateway identity handshake");
      assertNoCredentialReached(squatter.seen);
    } finally {
      await squatter.close();
    }
  }, 60_000);
});
