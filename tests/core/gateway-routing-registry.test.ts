import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ROUTING_PORT_BASE,
  ROUTING_PORT_SPAN,
  allocateRoutingPort,
  appendRoutingLog,
  canBindLocalPort,
  listRoutingSlots,
  quarantineRoutingSlot,
  readRoutingSlot,
  removeRoutingSlot,
  resetRoutingPortSaltCache,
  routingDir,
  routingPortCandidate,
  routingPortSalt,
  routingSlotKey,
  routingSlotLogPath,
  routingSlotPath,
  routingSlotsForCwd,
  writeRoutingSlot,
  type RoutingSlotRecord
} from "../../src/core/gateway/routing-registry.js";

/**
 * The routing slot registry's own invariants - the ones the end-to-end acceptance run cannot
 * isolate, because there a single routing identity exists and the interesting properties are about
 * how DIFFERENT identities, salts and port collisions behave.
 */
let root = "";
let home = "";
let env: { COMPACTION_HOME: string };

function slot(overrides: Partial<RoutingSlotRecord> = {}): RoutingSlotRecord {
  return {
    pid: 4242,
    host: "127.0.0.1",
    port: 21000,
    reservedPort: 21000,
    provider: "anthropic",
    upstream: "https://api.anthropic.com",
    mode: "record",
    cwd: "/tmp/project",
    startedAt: "2026-09-08T00:00:00.000Z",
    ...overrides
  };
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "routing-registry-"));
  home = path.join(root, "home", ".compaction");
  mkdirSync(home, { recursive: true });
  env = { COMPACTION_HOME: home };
  resetRoutingPortSaltCache();
});

afterEach(() => {
  resetRoutingPortSaltCache();
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("routing slot registry", () => {
  it("gives every routing identity its OWN file, so a start can never overwrite a live gateway's record", () => {
    const plain = routingSlotKey({ cwd: root, provider: "anthropic" }, env);
    const scoped = routingSlotKey({ cwd: root, provider: "anthropic", workflow: "claude-code" }, env);
    const otherProvider = routingSlotKey({ cwd: root, provider: "openai" }, env);
    const otherCwd = routingSlotKey({ cwd: tmpdir(), provider: "anthropic" }, env);
    // Four identities, four distinct keys - the single-slot pidfile's orphaning mechanism is gone
    // structurally rather than by convention.
    expect(new Set([plain, scoped, otherProvider, otherCwd]).size).toBe(4);

    writeRoutingSlot(plain, slot({ pid: 1, reservedPort: 21001, port: 21001 }), env);
    writeRoutingSlot(scoped, slot({ pid: 2, reservedPort: 21002, port: 21002, workflow: "claude-code" }), env);
    // Writing the second did not disturb the first.
    expect(readRoutingSlot(plain, env)!.pid).toBe(1);
    expect(readRoutingSlot(scoped, env)!.pid).toBe(2);
    expect(listRoutingSlots(env)).toHaveLength(2);
  });

  it("is stable for the same identity and independent of how the directory is spelled", () => {
    const a = routingSlotKey({ cwd: root, provider: "anthropic" }, env);
    const b = routingSlotKey({ cwd: `${root}/.`, provider: "anthropic" }, env);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
  });

  it("stores the slot 0600 inside a 0700 directory and round-trips every content-free field", () => {
    const key = routingSlotKey({ cwd: root, provider: "anthropic" }, env);
    const record = slot({ adopted: true });
    writeRoutingSlot(key, record, env);
    expect(readRoutingSlot(key, env)).toEqual(record);
    expect(statSync(routingSlotPath(key, env)).mode & 0o777).toBe(0o600);
    expect(statSync(routingDir(env)).mode & 0o777).toBe(0o700);
  });

  it("finds a directory's slots across workflow scopes, and only that directory's", () => {
    const here = path.join(root, "here");
    const there = path.join(root, "there");
    mkdirSync(here);
    mkdirSync(there);
    writeRoutingSlot(routingSlotKey({ cwd: here, provider: "anthropic" }, env), slot({ cwd: here }), env);
    writeRoutingSlot(
      routingSlotKey({ cwd: here, provider: "anthropic", workflow: "claude-code" }, env),
      slot({ cwd: here, workflow: "claude-code" }),
      env
    );
    writeRoutingSlot(routingSlotKey({ cwd: there, provider: "anthropic" }, env), slot({ cwd: there }), env);
    expect(routingSlotsForCwd(here, "anthropic", env)).toHaveLength(2);
    expect(routingSlotsForCwd(there, "anthropic", env)).toHaveLength(1);
    expect(routingSlotsForCwd(here, "openai", env)).toHaveLength(0);
  });

  it("removes a slot, and an instance-guarded removal never deletes a REPLACEMENT's record", () => {
    const key = routingSlotKey({ cwd: root, provider: "anthropic" }, env);
    const release = {
      instanceId: "a".repeat(48),
      controlCapability: "b".repeat(64),
      cliVersion: "0.6.8",
      protocolVersion: 1,
      pairId: "external:0.6.8"
    };
    writeRoutingSlot(key, slot({ release }), env);
    // A dying gateway's close handler passes its OWN instance id. The slot now belongs to someone
    // else, so the removal must be refused - this is what keeps an explicit stop from racing a
    // replacement into deleting the live record.
    removeRoutingSlot(key, env, "c".repeat(48));
    expect(readRoutingSlot(key, env)).not.toBeNull();
    removeRoutingSlot(key, env, release.instanceId);
    expect(readRoutingSlot(key, env)).toBeNull();
  });

  it("records a quarantine reason so a contested reserved port is reported, not silently dropped", () => {
    const key = routingSlotKey({ cwd: root, provider: "anthropic" }, env);
    writeRoutingSlot(key, slot(), env);
    quarantineRoutingSlot(key, "held by a listener that failed the handshake", env);
    expect(readRoutingSlot(key, env)!.quarantine?.reason).toContain("failed the handshake");
  });
});

describe("reserved routing port", () => {
  it("lands inside the band that sits OUTSIDE both OS ephemeral ranges", async () => {
    const key = routingSlotKey({ cwd: root, provider: "anthropic" }, env);
    const { port } = await allocateRoutingPort(key, env);
    expect(port).toBeGreaterThanOrEqual(ROUTING_PORT_BASE);
    expect(port).toBeLessThan(ROUTING_PORT_BASE + ROUTING_PORT_SPAN);
    // macOS hands out 49152-65535 and Linux 32768-60999 to unrelated outbound connections. A
    // routing port inside either can be taken by traffic that has nothing to do with us.
    expect(port).toBeLessThan(32768);
    expect(port).toBeGreaterThan(1024);
  });

  it("is NOT derivable from the path alone - it depends on the 0600 per-user salt", () => {
    const key = routingSlotKey({ cwd: root, provider: "anthropic" }, env);
    const salt = routingPortSalt(env);
    expect(salt).toBeDefined();
    expect(statSync(path.join(routingDir(env), ".port-salt")).mode & 0o777).toBe(0o600);

    // A principal that cannot read the salt cannot compute the port: the same key under a different
    // salt derives somewhere else. This is the only defence against pre-positioning on a stable
    // address, so it is asserted rather than assumed.
    const otherSalt = Buffer.alloc(32, 7);
    expect(routingPortCandidate(key, salt!)).not.toBe(routingPortCandidate(key, otherSalt));
    // Deterministic for us, though - the same salt and key always give the same port.
    expect(routingPortCandidate(key, salt!)).toBe(routingPortCandidate(key, salt!));
  });

  it("takes the NEXT port in the band when the candidate is already held", async () => {
    const key = routingSlotKey({ cwd: root, provider: "anthropic" }, env);
    const salt = routingPortSalt(env)!;
    const candidate = routingPortCandidate(key, salt);

    // Hold the derived candidate with a real listener, exactly as an unrelated dev server would.
    const squatter = net.createServer();
    await new Promise<void>((resolve, reject) => {
      squatter.once("error", reject);
      squatter.listen(candidate, "127.0.0.1", () => resolve());
    });
    try {
      expect(await canBindLocalPort(candidate)).toBe(false);
      const { port } = await allocateRoutingPort(key, env);
      // Nothing is pinned to the contested port at ALLOCATION time, so moving on costs nobody
      // anything. (At REVIVAL the opposite rule applies - see the revival tests.)
      expect(port).not.toBe(candidate);
      expect(port).toBeGreaterThanOrEqual(ROUTING_PORT_BASE);
      expect(port).toBeLessThan(ROUTING_PORT_BASE + ROUTING_PORT_SPAN);
    } finally {
      await new Promise<void>((r) => squatter.close(() => r()));
    }
  });
});

describe("routing log", () => {
  it("appends content-free lifecycle lines at 0600", () => {
    const key = routingSlotKey({ cwd: root, provider: "anthropic" }, env);
    appendRoutingLog(key, "start requested port=21000 provider=anthropic workflow=none", env);
    appendRoutingLog(key, "revive spawn port=21000 wait=true", env);
    const text = readFileSync(routingSlotLogPath(key, env), "utf8");
    expect(text.trim().split("\n")).toHaveLength(2);
    expect(text).toContain("start requested");
    expect(text).toContain("revive spawn");
    expect(statSync(routingSlotLogPath(key, env)).mode & 0o777).toBe(0o600);
  });
});
