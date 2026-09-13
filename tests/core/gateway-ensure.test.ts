import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ensureGateway,
  reusableForTransparentRouting,
  stopTransparentRoutingGateway,
  isGatewayReachable
} from "../../src/core/gateway/ensure.js";
import { writeGatewayPid, isProcessAlive, type GatewayPidRecord } from "../../src/core/gateway/status.js";
import { createGatewayReleaseIdentity, gatewayControlHandler } from "../../src/core/gateway/update-identity.js";
import {
  readRoutingSlot,
  resetRoutingPortSaltCache,
  routingSlotKey,
  routingSlotLockPath,
  writeRoutingSlot,
  type RoutingSlotRecord
} from "../../src/core/gateway/routing-registry.js";

/**
 * `ensureGateway`, the start-or-reuse engine behind `compaction gateway ensure` (the Claude Code
 * shim's routing step). The load-bearing invariants: reuse ONLY a byte-safe plain record gateway
 * (never a workflow-scoped or non-record one), spawn-or-wait single-flight, and an honest
 * non-success result for everything else (callers fail OPEN).
 */

let cwd: string;
/**
 * The routing slot registry is USER-GLOBAL, so every test here must redirect the Compaction home to
 * a temp directory. Without it these tests would read and write the developer's real
 * `~/.compaction/routing`, and could stop a gateway backing their live session.
 */
let compactionHome: string;
let env: { COMPACTION_HOME: string };
let listeners: net.Server[] = [];
let children: ChildProcess[] = [];
let release = createGatewayReleaseIdentity();

function rec(overrides: Partial<GatewayPidRecord> = {}): GatewayPidRecord {
  return {
    release,
    pid: process.pid,
    host: "127.0.0.1",
    port: 0,
    upstream: "https://api.anthropic.com",
    provider: "anthropic",
    mode: "record",
    startedAt: new Date().toISOString(),
    ...overrides
  };
}

function listen(): Promise<net.Server & { port: number }> {
  return new Promise((resolve) => {
    const control = gatewayControlHandler(release, () => ({ activeRequests: 0, pendingBookkeeping: 0,
      unsettledRuns: 0, unsettledCodex: 0, unsettledClaude: 0, settlementUnknown: false }), () => server);
    const server = http.createServer((req, res) => { if (!control(req, res)) res.end(); });
    server.listen(0, "127.0.0.1", () => {
      listeners.push(server);
      const addr = server.address() as net.AddressInfo;
      resolve(Object.assign(server, { port: addr.port }));
    });
  });
}

/** A listener with NO control handler: it accepts TCP and answers, but cannot pass the handshake. */
function listenWithoutControl(): Promise<net.Server & { port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    server.listen(0, "127.0.0.1", () => {
      listeners.push(server);
      resolve(Object.assign(server, { port: (server.address() as net.AddressInfo).port }));
    });
  });
}

beforeEach(() => {
  release = createGatewayReleaseIdentity();
  cwd = mkdtempSync(path.join(tmpdir(), "gw-ensure-"));
  compactionHome = mkdtempSync(path.join(tmpdir(), "gw-ensure-home-"));
  env = { COMPACTION_HOME: compactionHome };
  resetRoutingPortSaltCache();
});

afterEach(async () => {
  for (const s of listeners) await new Promise((r) => s.close(() => r(undefined)));
  listeners = [];
  for (const c of children) {
    try {
      c.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
  children = [];
  resetRoutingPortSaltCache();
  rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  rmSync(compactionHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("reusableForTransparentRouting (byte-safe reuse gate)", () => {
  it("accepts only a plain record gateway on the same provider + upstream", () => {
    expect(reusableForTransparentRouting(rec(), "anthropic", "https://api.anthropic.com").ok).toBe(true);
    // Trailing-slash upstream equivalence.
    expect(reusableForTransparentRouting(rec(), "anthropic", "https://api.anthropic.com/").ok).toBe(true);
  });

  it("REFUSES a workflow-scoped gateway (stored authorizations may apply there)", () => {
    const check = reusableForTransparentRouting(rec({ workflow: "claude-code" }), "anthropic", "https://api.anthropic.com");
    expect(check.ok).toBe(false);
    expect(check.reason).toContain("workflow identity");
  });

  it("REFUSES apply/dry-run modes, other providers, and other upstreams", () => {
    expect(reusableForTransparentRouting(rec({ mode: "apply" }), "anthropic", "https://api.anthropic.com").ok).toBe(false);
    expect(reusableForTransparentRouting(rec({ provider: "openai" }), "anthropic", "https://api.anthropic.com").ok).toBe(false);
    expect(reusableForTransparentRouting(rec(), "anthropic", "http://127.0.0.1:9999").ok).toBe(false);
  });

  it("apply-routing reuse is WORKFLOW-MATCHED: a scoped ensure reuses only the matching scoped gateway", () => {
    // Apply-routing ensure (expectedWorkflow=claude-code): reuse the matching workflow-scoped record gateway…
    expect(
      reusableForTransparentRouting(rec({ workflow: "claude-code" }), "anthropic", "https://api.anthropic.com", "claude-code").ok
    ).toBe(true);
    // …but NOT a plain (workflow-none) gateway (a plain one is byte-safe; apply routing needs the scoped shape).
    const plainForApply = reusableForTransparentRouting(rec(), "anthropic", "https://api.anthropic.com", "claude-code");
    expect(plainForApply.ok).toBe(false);
    expect(plainForApply.reason).toContain("apply-routing");
    // …and NOT a differently-scoped gateway.
    expect(
      reusableForTransparentRouting(rec({ workflow: "codex" }), "anthropic", "https://api.anthropic.com", "claude-code").ok
    ).toBe(false);
  });

  it("a PLAIN ensure still refuses ANY workflow-scoped gateway (the two reuse classes never cross)", () => {
    expect(reusableForTransparentRouting(rec({ workflow: "claude-code" }), "anthropic", "https://api.anthropic.com").ok).toBe(false);
    expect(reusableForTransparentRouting(rec({ workflow: "codex" }), "anthropic", "https://api.anthropic.com").ok).toBe(false);
  });
});

describe("isGatewayReachable (fast TCP-connect health check)", () => {
  it("resolves true for a listening port and false for a dead one, never throws", async () => {
    const server = await listen();
    expect(await isGatewayReachable("127.0.0.1", server.port, 500)).toBe(true);
    await new Promise((r) => server.close(() => r(undefined)));
    listeners = listeners.filter((s) => s !== server);
    // Port is now closed → connection refused → false (fail toward "start fresh").
    expect(await isGatewayReachable("127.0.0.1", server.port, 500)).toBe(false);
  });
});


/**
 * `ensureGateway` under the ROUTING SLOT model.
 *
 * The lifecycle record moved out of `<cwd>/.compaction/gateway/gateway.json` and into the
 * user-global slot, so a started gateway is observed there, the single-flight lock lives beside it,
 * and the port is the slot's STABLE reserved port rather than a fresh ephemeral one. The cwd
 * pidfile still matters in exactly one place: a gateway recorded there before the upgrade is
 * ADOPTED at its current port and never restarted.
 */
describe("ensureGateway", () => {
  const baseOptions = (): { provider: string; upstream: string; cwd: string; env: { COMPACTION_HOME: string } } => ({
    provider: "anthropic",
    upstream: "https://api.anthropic.com",
    cwd,
    env
  });

  function slotRec(port: number, overrides: Partial<RoutingSlotRecord> = {}): RoutingSlotRecord {
    return {
      release,
      pid: process.pid,
      host: "127.0.0.1",
      port,
      reservedPort: port,
      upstream: "https://api.anthropic.com",
      provider: "anthropic",
      mode: "record",
      cwd,
      startedAt: new Date().toISOString(),
      ...overrides
    };
  }

  const keyFor = (workflow?: "claude-code" | "codex"): string =>
    routingSlotKey({ cwd, provider: "anthropic", ...(workflow ? { workflow } : {}) }, env);

  /** Stand in for the detached `gateway start`: it is the CHILD that writes the slot, on listen. */
  const writeSlotSoon = (port: number, overrides: Partial<RoutingSlotRecord> = {}, workflow?: "claude-code" | "codex"): void => {
    setTimeout(() => writeRoutingSlot(keyFor(workflow), slotRec(port, overrides), env), 50);
  };

  it("reuses a running plain record gateway recorded in the slot", async () => {
    const server = await listen();
    writeRoutingSlot(keyFor(), slotRec(server.port), env);
    const result = await ensureGateway(baseOptions());
    expect(result.status).toBe("reused");
    expect(result.status === "reused" && result.base).toBe(`http://127.0.0.1:${server.port}`);
  });

  it("ADOPTS a pre-upgrade cwd-pidfile routing gateway AT ITS CURRENT PORT, without restarting it", async () => {
    // MIGRATION. A Claude that is running right now froze this exact URL at `exec`; restarting the
    // gateway on a different port would strand it. Adoption records the slot and changes nothing else.
    const server = await listen();
    writeGatewayPid(rec({ port: server.port }), cwd);
    const spawns: string[][] = [];
    const result = await ensureGateway({ ...baseOptions(), spawnGatewayStart: (args) => spawns.push(args) });
    expect(result.status).toBe("reused");
    expect(result.status === "reused" && result.base).toBe(`http://127.0.0.1:${server.port}`);
    expect(spawns).toHaveLength(0); // never restarted
    const adopted = readRoutingSlot(keyFor(), env);
    expect(adopted?.port).toBe(server.port);
    expect(adopted?.reservedPort).toBe(server.port); // the adopted port IS the reserved port
    expect(adopted?.adopted).toBe(true); // flagged: kernel-chosen, so weaker than a band port
  });

  it("never adopts a workflow-scoped gateway for a PLAIN ensure (the two reuse classes never cross)", async () => {
    const server = await listen();
    writeGatewayPid(rec({ port: server.port, workflow: "claude-code" }), cwd);
    const result = await ensureGateway({
      ...baseOptions(),
      pollMs: 20,
      waitMs: 150,
      pickPort: async () => 45998,
      spawnGatewayStart: () => {
        /* never comes up here - we only assert the scoped gateway was NOT reused */
      }
    });
    expect(result.status).not.toBe("reused");
    expect(readRoutingSlot(keyFor(), env)).toBeNull();
  });

  it("spawns a detached record start (--mode record --workflow none) that OWNS the slot, PERSISTENT by default", async () => {
    const spawnedArgs: string[][] = [];
    const server = await listen();
    const result = await ensureGateway({
      ...baseOptions(),
      pollMs: 20,
      waitMs: 2000,
      pickPort: async () => server.port,
      spawnGatewayStart: (args) => {
        spawnedArgs.push(args);
        writeSlotSoon(server.port);
      }
    });
    expect(result.status).toBe("started");
    expect(result.status === "started" && result.base).toBe(`http://127.0.0.1:${server.port}`);
    expect(spawnedArgs).toHaveLength(1);
    expect(spawnedArgs[0][spawnedArgs[0].indexOf("--mode") + 1]).toBe("record");
    expect(spawnedArgs[0][spawnedArgs[0].indexOf("--workflow") + 1]).toBe("none");
    expect(spawnedArgs[0][spawnedArgs[0].indexOf("--provider") + 1]).toBe("anthropic");
    expect(spawnedArgs[0][spawnedArgs[0].indexOf("--listen") + 1]).toBe(`http://127.0.0.1:${server.port}`);
    // The child is told WHICH slot it owns, so the recorded pid is always the listening process.
    expect(spawnedArgs[0][spawnedArgs[0].indexOf("--routing-slot") + 1]).toBe(keyFor());
    // PERSISTENT by default: no self-stop TTL, so it cannot vanish under a live session.
    expect(spawnedArgs[0]).not.toContain("--idle-ttl");
    // The single-flight lock lives beside the slot now, not in the project tree, and is released.
    expect(existsSync(routingSlotLockPath(keyFor(), env))).toBe(false);
    expect(existsSync(path.join(cwd, ".compaction", "gateway", "ensure.lock"))).toBe(false);
  });

  it("APPLY-ROUTING opt-in spawns a WORKFLOW-SCOPED record gateway owning its OWN slot", async () => {
    const spawnedArgs: string[][] = [];
    const server = await listen();
    const result = await ensureGateway({
      ...baseOptions(),
      pollMs: 20,
      waitMs: 2000,
      applyRouting: "claude-code",
      pickPort: async () => server.port,
      spawnGatewayStart: (args) => {
        spawnedArgs.push(args);
        writeSlotSoon(server.port, { workflow: "claude-code" }, "claude-code");
      }
    });
    expect(result.status).toBe("started");
    expect(spawnedArgs[0][spawnedArgs[0].indexOf("--mode") + 1]).toBe("record");
    expect(spawnedArgs[0][spawnedArgs[0].indexOf("--workflow") + 1]).toBe("claude-code");
    // A DIFFERENT slot from the plain one: the two never share a record, so neither can orphan the other.
    expect(spawnedArgs[0][spawnedArgs[0].indexOf("--routing-slot") + 1]).toBe(keyFor("claude-code"));
    expect(keyFor("claude-code")).not.toBe(keyFor());
  });

  it("APPLY-ROUTING ensure REUSES a matching workflow-scoped record gateway (no double-spawn)", async () => {
    const server = await listen();
    writeRoutingSlot(keyFor("claude-code"), slotRec(server.port, { workflow: "claude-code" }), env);
    const result = await ensureGateway({ ...baseOptions(), applyRouting: "claude-code" });
    expect(result.status).toBe("reused");
    expect(result.status === "reused" && result.base).toBe(`http://127.0.0.1:${server.port}`);
  });

  it("APPLY-ROUTING ensure does NOT reuse a plain (workflow-none) gateway (starts a scoped one instead)", async () => {
    const staleServer = await listen();
    writeRoutingSlot(keyFor(), slotRec(staleServer.port), env); // plain slot, different key
    const result = await ensureGateway({
      ...baseOptions(),
      applyRouting: "claude-code",
      waitMs: 150,
      pollMs: 20,
      pickPort: async () => 46999,
      spawnGatewayStart: () => {
        /* never comes up here - we only assert it did NOT reuse the plain gateway */
      }
    });
    expect(result.status).not.toBe("reused");
  });

  it("idleTtlMs 0 (the persistent default, made explicit) spawns WITHOUT --idle-ttl", async () => {
    const spawnedArgs: string[][] = [];
    const server = await listen();
    const result = await ensureGateway({
      ...baseOptions(),
      pollMs: 20,
      waitMs: 2000,
      idleTtlMs: 0,
      pickPort: async () => server.port,
      spawnGatewayStart: (args) => {
        spawnedArgs.push(args);
        writeSlotSoon(server.port);
      }
    });
    expect(result.status).toBe("started");
    expect(spawnedArgs[0]).not.toContain("--idle-ttl");
  });

  it("a positive idleTtlMs opt-in spawns WITH --idle-ttl (a user can still choose auto-stop)", async () => {
    const spawnedArgs: string[][] = [];
    const server = await listen();
    const result = await ensureGateway({
      ...baseOptions(),
      pollMs: 20,
      waitMs: 2000,
      idleTtlMs: 60_000,
      pickPort: async () => server.port,
      spawnGatewayStart: (args) => {
        spawnedArgs.push(args);
        writeSlotSoon(server.port);
      }
    });
    expect(result.status).toBe("started");
    expect(spawnedArgs[0][spawnedArgs[0].indexOf("--idle-ttl") + 1]).toBe(String(60_000));
  });

  it("REBINDS THE SAME RESERVED PORT when the slot's gateway is gone (the repair a pinned child needs)", async () => {
    // The recorded owner is dead and its port refuses. A replacement must come back at the SAME
    // address - a fresh port would be useless to a tool whose base URL was frozen at `exec`.
    const reservedPort = 23571;
    writeRoutingSlot(keyFor(), slotRec(reservedPort, { pid: 999_999_997 }), env);
    const fresh = await listen();
    const spawnedArgs: string[][] = [];
    const result = await ensureGateway({
      ...baseOptions(),
      pollMs: 20,
      waitMs: 2000,
      // The reserved port is dead; the fake server stands in for the replacement that comes up.
      isReachable: async (_host, port) => port === fresh.port,
      spawnGatewayStart: (args) => {
        spawnedArgs.push(args);
        writeSlotSoon(fresh.port, { port: fresh.port, reservedPort: fresh.port });
      }
    });
    expect(result.status).toBe("started");
    expect(spawnedArgs).toHaveLength(1);
    // It asked for the SLOT'S reserved port, not a newly allocated one.
    expect(spawnedArgs[0][spawnedArgs[0].indexOf("--listen") + 1]).toBe(`http://127.0.0.1:${reservedPort}`);
  });

  it("starts a FRESH gateway when the recorded port is UNREACHABLE (pid may look alive, nothing listening)", async () => {
    const staleServer = await listen();
    writeRoutingSlot(keyFor(), slotRec(staleServer.port), env); // pid = this process (alive)
    const fresh = await listen();
    const spawnedArgs: string[][] = [];
    const result = await ensureGateway({
      ...baseOptions(),
      pollMs: 20,
      waitMs: 2000,
      isReachable: async (_host, port) => port === fresh.port,
      spawnGatewayStart: (args) => {
        spawnedArgs.push(args);
        writeSlotSoon(fresh.port, { port: fresh.port, reservedPort: fresh.port });
      }
    });
    expect(result.status).toBe("started"); // NOT "reused"
    expect(result.status === "started" && result.base).toBe(`http://127.0.0.1:${fresh.port}`);
    expect(spawnedArgs).toHaveLength(1);
  });

  it("returns UNAVAILABLE (never throws, never blocks long) when the spawned gateway never comes up", async () => {
    const result = await ensureGateway({
      ...baseOptions(),
      pollMs: 20,
      waitMs: 200,
      pickPort: async () => 45999,
      spawnGatewayStart: () => {
        /* start fails silently - e.g. bind failure in the detached process */
      }
    });
    expect(result.status).toBe("unavailable");
    expect(existsSync(routingSlotLockPath(keyFor(), env))).toBe(false);
  });

  it("does not double-spawn under the single-flight lock (second caller waits, then reuses)", async () => {
    const server = await listen();
    let spawns = 0;
    const opts = {
      ...baseOptions(),
      pollMs: 20,
      waitMs: 2000,
      pickPort: async () => server.port,
      spawnGatewayStart: () => {
        spawns += 1;
        setTimeout(() => writeRoutingSlot(keyFor(), slotRec(server.port), env), 100);
      }
    };
    const [a, b] = await Promise.all([ensureGateway(opts), ensureGateway(opts)]);
    expect(spawns).toBe(1);
    expect([a.status, b.status].every((s) => s === "started" || s === "reused")).toBe(true);
  });

  it("QUARANTINES rather than injecting when the reserved port is held by a listener that is not ours", async () => {
    // Invariant R-1. The reserved port is the only address that could repair a pinned child, so it
    // is never substituted - and a listener that cannot pass the handshake is never injected into.
    const impostor = await listenWithoutControl();
    writeRoutingSlot(keyFor(), slotRec(impostor.port, { pid: 999_999_996 }), env);
    const spawns: string[][] = [];
    const result = await ensureGateway({ ...baseOptions(), spawnGatewayStart: (args) => spawns.push(args) });
    expect(result.status).toBe("mismatch");
    expect(result.status === "mismatch" && result.reason).toContain("failed the gateway identity handshake");
    expect(spawns).toHaveLength(0);
    expect(readRoutingSlot(keyFor(), env)?.quarantine?.reason).toContain("failed the gateway identity handshake");
  });
});

describe("stopTransparentRoutingGateway", () => {
  function spawnFakeGateway(): ChildProcess {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    children.push(child);
    return child;
  }

  const keyFor = (workflow?: "claude-code" | "codex"): string =>
    routingSlotKey({ cwd, provider: "anthropic", ...(workflow ? { workflow } : {}) }, env);

  it("REMOVES THE SLOT FIRST, then SIGTERMs the plain record routing gateway", async () => {
    // The order is the mechanism: revival is gated on the slot's existence, so with the slot already
    // gone nothing can resurrect what the user explicitly stopped.
    const child = spawnFakeGateway();
    writeRoutingSlot(
      keyFor(),
      {
        release, pid: child.pid!, host: "127.0.0.1", port: 21801, reservedPort: 21801,
        upstream: "https://api.anthropic.com", provider: "anthropic", mode: "record", cwd,
        startedAt: new Date().toISOString()
      },
      env
    );
    const result = stopTransparentRoutingGateway(cwd, "anthropic", env);
    expect(result.stopped).toBe(true);
    expect(result.pid).toBe(child.pid);
    expect(readRoutingSlot(keyFor(), env)).toBeNull();
    await new Promise((r) => setTimeout(r, 200));
    expect(isProcessAlive(child.pid!)).toBe(false);
  });

  it("ALSO stops the apply-routing workflow-scoped record gateway on its matching provider", async () => {
    const child = spawnFakeGateway();
    writeRoutingSlot(
      keyFor("claude-code"),
      {
        release, pid: child.pid!, host: "127.0.0.1", port: 21802, reservedPort: 21802,
        upstream: "https://api.anthropic.com", provider: "anthropic", mode: "record",
        workflow: "claude-code", cwd, startedAt: new Date().toISOString()
      },
      env
    );
    const result = stopTransparentRoutingGateway(cwd, "anthropic", env);
    expect(result.stopped).toBe(true);
    expect(result.pid).toBe(child.pid);
    expect(readRoutingSlot(keyFor("claude-code"), env)).toBeNull();
    await new Promise((r) => setTimeout(r, 200));
    expect(isProcessAlive(child.pid!)).toBe(false);
  });

  it("leaves a pre-upgrade APPLY/DRY-RUN gateway (a user-started mutating gateway) RUNNING", () => {
    const child = spawnFakeGateway();
    writeGatewayPid(rec({ pid: child.pid!, port: 45002, mode: "apply", workflow: "claude-code" }), cwd);
    const result = stopTransparentRoutingGateway(cwd, "anthropic", env);
    expect(result.stopped).toBe(false);
    expect(result.reason).toContain("not started for transparent routing");
    expect(isProcessAlive(child.pid!)).toBe(true);
  });

  it("leaves a pre-upgrade workflow-scoped gateway for a DIFFERENT provider RUNNING", () => {
    const child = spawnFakeGateway();
    writeGatewayPid(rec({ pid: child.pid!, port: 45006, provider: "openai", workflow: "codex", upstream: "https://api.openai.com" }), cwd);
    const result = stopTransparentRoutingGateway(cwd, "anthropic", env);
    expect(result.stopped).toBe(false);
    expect(result.reason).toContain("not started for transparent routing");
    expect(isProcessAlive(child.pid!)).toBe(true);
  });

  it("reports honestly when nothing is running", () => {
    const result = stopTransparentRoutingGateway(cwd, "anthropic", env);
    expect(result.stopped).toBe(false);
    expect(result.reason).toContain("no routing gateway is recorded for this directory");
  });
});
