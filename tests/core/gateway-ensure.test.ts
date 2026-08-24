import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ensureGateway,
  reusableForTransparentRouting,
  stopTransparentRoutingGateway,
  isGatewayReachable
} from "../../src/core/gateway/ensure.js";
import { writeGatewayPid, isProcessAlive, type GatewayPidRecord } from "../../src/core/gateway/status.js";

/**
 * `ensureGateway`, the start-or-reuse engine behind `compaction gateway ensure` (the Claude Code
 * shim's routing step). The load-bearing invariants: reuse ONLY a byte-safe plain record gateway
 * (never a workflow-scoped or non-record one), spawn-or-wait single-flight, and an honest
 * non-success result for everything else (callers fail OPEN).
 */

let cwd: string;
let listeners: net.Server[] = [];
let children: ChildProcess[] = [];

function rec(overrides: Partial<GatewayPidRecord> = {}): GatewayPidRecord {
  return {
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
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      listeners.push(server);
      const addr = server.address() as net.AddressInfo;
      resolve(Object.assign(server, { port: addr.port }));
    });
  });
}

beforeEach(() => {
  cwd = mkdtempSync(path.join(tmpdir(), "gw-ensure-"));
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
  rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
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

describe("ensureGateway", () => {
  it("reuses a running plain record gateway (alive pid + listening port)", async () => {
    const server = await listen();
    writeGatewayPid(rec({ port: server.port }), cwd);
    const result = await ensureGateway({ provider: "anthropic", upstream: "https://api.anthropic.com", cwd });
    expect(result.status).toBe("reused");
    expect(result.status === "reused" && result.base).toBe(`http://127.0.0.1:${server.port}`);
  });

  it("reports a MISMATCH (never reuses) for a running workflow-scoped gateway", async () => {
    const server = await listen();
    writeGatewayPid(rec({ port: server.port, workflow: "claude-code" }), cwd);
    const result = await ensureGateway({ provider: "anthropic", upstream: "https://api.anthropic.com", cwd });
    expect(result.status).toBe("mismatch");
    expect(result.status === "mismatch" && result.reason).toContain("workflow identity");
  });

  it("spawns a detached record start (--mode record --workflow none), PERSISTENT by default (no --idle-ttl)", async () => {
    const spawnedArgs: string[][] = [];
    const server = await listen();
    const result = await ensureGateway({
      provider: "anthropic",
      upstream: "https://api.anthropic.com",
      cwd,
      pollMs: 20,
      waitMs: 2000,
      pickPort: async () => server.port,
      spawnGatewayStart: (args) => {
        spawnedArgs.push(args);
        // Simulate the started gateway: it writes the pidfile once listening (server already is).
        setTimeout(() => writeGatewayPid(rec({ port: server.port }), cwd), 50);
      }
    });
    expect(result.status).toBe("started");
    expect(result.status === "started" && result.base).toBe(`http://127.0.0.1:${server.port}`);
    // The spawned server is record-only with NO workflow identity, the byte-safe shape.
    expect(spawnedArgs).toHaveLength(1);
    expect(spawnedArgs[0]).toContain("--mode");
    expect(spawnedArgs[0]).toContain("record");
    expect(spawnedArgs[0]).toContain("--workflow");
    expect(spawnedArgs[0]).toContain("none");
    expect(spawnedArgs[0]).toContain("--provider");
    expect(spawnedArgs[0]).toContain("anthropic");
    const listenArg = spawnedArgs[0][spawnedArgs[0].indexOf("--listen") + 1];
    expect(listenArg).toBe(`http://127.0.0.1:${server.port}`);
    // RELIABILITY: the routing gateway is PERSISTENT by default so it can never idle-shut-down
    // under a live session and orphan it with a dead base URL. No --idle-ttl flag is spawned.
    expect(spawnedArgs[0]).not.toContain("--idle-ttl");
    // Single-flight lock released after completion.
    expect(existsSync(path.join(cwd, ".compaction", "gateway", "ensure.lock"))).toBe(false);
  });

  it("APPLY-ROUTING opt-in spawns a WORKFLOW-SCOPED record gateway (--mode record --workflow claude-code)", async () => {
    const spawnedArgs: string[][] = [];
    const server = await listen();
    const result = await ensureGateway({
      provider: "anthropic",
      upstream: "https://api.anthropic.com",
      cwd,
      pollMs: 20,
      waitMs: 2000,
      applyRouting: "claude-code",
      pickPort: async () => server.port,
      spawnGatewayStart: (args) => {
        spawnedArgs.push(args);
        // The spawned gateway records ITS scoped shape (workflow claude-code) once listening.
        setTimeout(() => writeGatewayPid(rec({ port: server.port, workflow: "claude-code" }), cwd), 50);
      }
    });
    expect(result.status).toBe("started");
    expect(spawnedArgs[0]).toContain("--mode");
    expect(spawnedArgs[0]).toContain("record"); // still record mode; the server upgrades eligible POSTs
    expect(spawnedArgs[0]).toContain("--workflow");
    expect(spawnedArgs[0]).toContain("claude-code"); // scoped so the stored-authorization path may apply
    expect(spawnedArgs[0]).not.toContain("none");
  });

  it("APPLY-ROUTING ensure REUSES a matching workflow-scoped record gateway (no double-spawn)", async () => {
    const server = await listen();
    writeGatewayPid(rec({ port: server.port, workflow: "claude-code" }), cwd);
    const result = await ensureGateway({
      provider: "anthropic",
      upstream: "https://api.anthropic.com",
      cwd,
      applyRouting: "claude-code"
    });
    expect(result.status).toBe("reused");
    expect(result.status === "reused" && result.base).toBe(`http://127.0.0.1:${server.port}`);
  });

  it("APPLY-ROUTING ensure does NOT reuse a plain (workflow-none) gateway (starts a scoped one instead)", async () => {
    const staleServer = await listen();
    writeGatewayPid(rec({ port: staleServer.port }), cwd); // plain, no workflow
    const result = await ensureGateway({
      provider: "anthropic",
      upstream: "https://api.anthropic.com",
      cwd,
      applyRouting: "claude-code",
      waitMs: 150,
      pollMs: 20,
      pickPort: async () => 46999,
      spawnGatewayStart: () => {
        /* never comes up in this test - we only assert it did NOT reuse the plain gateway */
      }
    });
    // It refused to reuse the plain gateway (that would be byte-safe, not apply-capable) → it tried to
    // start a scoped one, which never came up here → unavailable (fail-open caller runs the tool anyway).
    expect(result.status).not.toBe("reused");
  });

  it("a routed session survives an idle interval: the default ensure-started gateway does not self-stop", async () => {
    // Proven via the spawned args (not a real idle wait): the persistent default means the started
    // gateway never carries a self-stop TTL, so an idle pause (thinking/lunch/overnight) cannot end it.
    const spawnedArgs: string[][] = [];
    const server = await listen();
    const result = await ensureGateway({
      provider: "anthropic",
      upstream: "https://api.anthropic.com",
      cwd,
      pollMs: 20,
      waitMs: 2000,
      pickPort: async () => server.port,
      spawnGatewayStart: (args) => {
        spawnedArgs.push(args);
        setTimeout(() => writeGatewayPid(rec({ port: server.port }), cwd), 50);
      }
    });
    expect(result.status).toBe("started");
    expect(spawnedArgs[0]).not.toContain("--idle-ttl"); // no TTL ⇒ server default = never self-stop
  });

  it("idleTtlMs 0 (the persistent default, made explicit) spawns WITHOUT --idle-ttl", async () => {
    const spawnedArgs: string[][] = [];
    const server = await listen();
    const result = await ensureGateway({
      provider: "anthropic",
      upstream: "https://api.anthropic.com",
      cwd,
      pollMs: 20,
      waitMs: 2000,
      idleTtlMs: 0,
      pickPort: async () => server.port,
      spawnGatewayStart: (args) => {
        spawnedArgs.push(args);
        setTimeout(() => writeGatewayPid(rec({ port: server.port }), cwd), 50);
      }
    });
    expect(result.status).toBe("started");
    expect(spawnedArgs[0]).not.toContain("--idle-ttl");
  });

  it("a positive idleTtlMs opt-in spawns WITH --idle-ttl (a user can still choose auto-stop)", async () => {
    const spawnedArgs: string[][] = [];
    const server = await listen();
    const result = await ensureGateway({
      provider: "anthropic",
      upstream: "https://api.anthropic.com",
      cwd,
      pollMs: 20,
      waitMs: 2000,
      idleTtlMs: 60_000,
      pickPort: async () => server.port,
      spawnGatewayStart: (args) => {
        spawnedArgs.push(args);
        setTimeout(() => writeGatewayPid(rec({ port: server.port }), cwd), 50);
      }
    });
    expect(result.status).toBe("started");
    expect(spawnedArgs[0]).toContain("--idle-ttl");
    const idleTtlArg = spawnedArgs[0][spawnedArgs[0].indexOf("--idle-ttl") + 1];
    expect(idleTtlArg).toBe(String(60_000));
  });

  it("starts a FRESH gateway when the recorded port is UNREACHABLE (pid may look alive, nothing listening)", async () => {
    // A pidfile pointing at an alive pid but a dead/never-listening port must NOT be reused (that
    // is exactly the dead-URL the shim would hand the tool). The injected reachability check reports
    // the recorded port unreachable, so ensure ignores the record and starts a fresh gateway.
    const staleServer = await listen();
    writeGatewayPid(rec({ port: staleServer.port }), cwd); // pid = this process (alive)
    const fresh = await listen();
    const spawnedArgs: string[][] = [];
    const result = await ensureGateway({
      provider: "anthropic",
      upstream: "https://api.anthropic.com",
      cwd,
      pollMs: 20,
      waitMs: 2000,
      // Recorded stale port is treated as unreachable; the freshly spawned port is reachable.
      isReachable: async (_host, port) => port === fresh.port,
      pickPort: async () => fresh.port,
      spawnGatewayStart: (args) => {
        spawnedArgs.push(args);
        setTimeout(() => writeGatewayPid(rec({ port: fresh.port }), cwd), 50);
      }
    });
    expect(result.status).toBe("started"); // NOT "reused"
    expect(result.status === "started" && result.base).toBe(`http://127.0.0.1:${fresh.port}`);
    expect(spawnedArgs).toHaveLength(1); // a fresh gateway was actually spawned
  });

  it("returns UNAVAILABLE (never throws, never blocks long) when the spawned gateway never comes up", async () => {
    const result = await ensureGateway({
      provider: "anthropic",
      upstream: "https://api.anthropic.com",
      cwd,
      pollMs: 20,
      waitMs: 200,
      pickPort: async () => 45999,
      spawnGatewayStart: () => {
        /* start fails silently - e.g. bind failure in the detached process */
      }
    });
    expect(result.status).toBe("unavailable");
    expect(existsSync(path.join(cwd, ".compaction", "gateway", "ensure.lock"))).toBe(false);
  });

  it("does not double-spawn under the single-flight lock (second caller waits, then reuses)", async () => {
    const server = await listen();
    let spawns = 0;
    const opts = {
      provider: "anthropic",
      upstream: "https://api.anthropic.com",
      cwd,
      pollMs: 20,
      waitMs: 2000,
      pickPort: async () => server.port,
      spawnGatewayStart: () => {
        spawns += 1;
        setTimeout(() => writeGatewayPid(rec({ port: server.port }), cwd), 100);
      }
    };
    const [a, b] = await Promise.all([ensureGateway(opts), ensureGateway(opts)]);
    expect(spawns).toBe(1);
    const statuses = [a.status, b.status].sort();
    expect(statuses.every((s) => s === "started" || s === "reused")).toBe(true);
  });
});

describe("stopTransparentRoutingGateway", () => {
  function spawnFakeGateway(): ChildProcess {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    children.push(child);
    return child;
  }

  it("SIGTERMs only the plain record routing gateway shape", async () => {
    const child = spawnFakeGateway();
    writeGatewayPid(rec({ pid: child.pid!, port: 45001 }), cwd);
    const result = stopTransparentRoutingGateway(cwd, "anthropic");
    expect(result.stopped).toBe(true);
    expect(result.pid).toBe(child.pid);
    await new Promise((r) => setTimeout(r, 200));
    expect(isProcessAlive(child.pid!)).toBe(false);
  });

  it("ALSO SIGTERMs the apply-routing workflow-scoped record gateway on its matching provider", async () => {
    // The apply-routing ensure starts a `--workflow claude-code` record gateway on anthropic; disconnect
    // must stop THAT too (it is a transparent-routing shape, not a user-started apply/dry-run gateway).
    const child = spawnFakeGateway();
    writeGatewayPid(rec({ pid: child.pid!, port: 45005, workflow: "claude-code" }), cwd);
    const result = stopTransparentRoutingGateway(cwd, "anthropic");
    expect(result.stopped).toBe(true);
    expect(result.pid).toBe(child.pid);
    await new Promise((r) => setTimeout(r, 200));
    expect(isProcessAlive(child.pid!)).toBe(false);
  });

  it("leaves an APPLY/DRY-RUN gateway (a user-started mutating gateway) RUNNING (with the honest reason)", () => {
    const child = spawnFakeGateway();
    writeGatewayPid(rec({ pid: child.pid!, port: 45002, mode: "apply", workflow: "claude-code" }), cwd);
    const result = stopTransparentRoutingGateway(cwd, "anthropic");
    expect(result.stopped).toBe(false);
    expect(result.reason).toContain("not started for transparent routing");
    expect(isProcessAlive(child.pid!)).toBe(true);
  });

  it("leaves a workflow-scoped gateway for a DIFFERENT provider RUNNING (ensure never starts it here)", () => {
    const child = spawnFakeGateway();
    // A codex/openai workflow gateway is not what an anthropic disconnect started.
    writeGatewayPid(rec({ pid: child.pid!, port: 45006, provider: "openai", workflow: "codex", upstream: "https://api.openai.com" }), cwd);
    const result = stopTransparentRoutingGateway(cwd, "anthropic");
    expect(result.stopped).toBe(false);
    expect(result.reason).toContain("not started for transparent routing");
    expect(isProcessAlive(child.pid!)).toBe(true);
  });

  it("reports honestly when nothing is running", () => {
    const result = stopTransparentRoutingGateway(cwd, "anthropic");
    expect(result.stopped).toBe(false);
    expect(result.reason).toContain("no gateway pidfile");
  });
});
