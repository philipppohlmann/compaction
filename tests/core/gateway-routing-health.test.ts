import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  clearRoutingEndpointDown,
  markRoutingEndpointDown,
  routingEndpointState,
  ROUTING_DOWN_GRACE_MS
} from "../../src/core/gateway/routing-health.js";
import {
  quarantineRoutingSlot,
  routingDir,
  routingSlotKey,
  writeRoutingSlot
} from "../../src/core/gateway/routing-registry.js";
import { reviveRoutingGatewayIfDown } from "../../src/core/gateway/routing-revival.js";

/**
 * The recorded-observation half of the false-green fix.
 *
 * `routing-health.ts` is what lets a surface that MAY NOT PROBE (the Claude Code status line, inside
 * the render loop) still refuse to assert health. Everything here is about the read being honest in
 * both directions: it must report a real outage, and it must not report a recovery, a successor
 * gateway, or an unrouted directory as one.
 */

const STARTED_AT = "2026-09-08T00:00:00.000Z";

let root = "";
let projDir = "";
let env: { COMPACTION_HOME: string };

function writeSlot(startedAt = STARTED_AT, provider = "anthropic"): string {
  const key = routingSlotKey({ cwd: projDir, provider }, env);
  writeRoutingSlot(
    key,
    {
      pid: 999_999_995,
      host: "127.0.0.1",
      port: 21999,
      reservedPort: 21999,
      provider,
      upstream: "http://127.0.0.1:1",
      mode: "record",
      cwd: projDir,
      startedAt
    },
    env
  );
  return key;
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "routing-health-"));
  projDir = path.join(root, "proj");
  mkdirSync(projDir, { recursive: true });
  env = { COMPACTION_HOME: path.join(root, ".compaction") };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("routingEndpointState - what a non-probing reader may honestly say", () => {
  it("says nothing about a directory that was never routed", () => {
    expect(routingEndpointState(projDir, env, 10_000_000)).toBe("unrouted");
  });

  it("says nothing about a routed directory with no recorded refusal", () => {
    writeSlot();
    expect(routingEndpointState(projDir, env, 10_000_000)).toBe("ok");
  });

  it("holds through a measured self-repair, so a recovery that worked never renders as an outage", () => {
    // 0.9 s after the refusal. The accepted design's repair is measured at 0.79 s end to end
    // (incident §7.2), so a window narrower than this would paint a failure across a recovery that
    // succeeded - the same surface, the opposite lie. The literal is deliberate: expressing this
    // bound in terms of ROUTING_DOWN_GRACE_MS would make it pass for any window, including none.
    const key = writeSlot();
    markRoutingEndpointDown(key, STARTED_AT, env, 1_000_000);
    expect(routingEndpointState(projDir, env, 1_000_000 + 900)).toBe("ok");
  });

  it("holds right up to the last millisecond of the grace window", () => {
    const key = writeSlot();
    markRoutingEndpointDown(key, STARTED_AT, env, 1_000_000);
    expect(routingEndpointState(projDir, env, 1_000_000 + ROUTING_DOWN_GRACE_MS - 1)).toBe("ok");
  });

  it("reports an endpoint that has been unreachable past the grace window", () => {
    const key = writeSlot();
    markRoutingEndpointDown(key, STARTED_AT, env, 1_000_000);
    expect(routingEndpointState(projDir, env, 1_000_000 + ROUTING_DOWN_GRACE_MS)).toBe("unavailable");
  });

  it("reports a quarantined slot IMMEDIATELY - that state cannot resolve itself", () => {
    // A plain refusal is repaired at the same address; a quarantine never is, so there is no window
    // to wait out.
    const key = writeSlot();
    quarantineRoutingSlot(key, "held by a listener that failed the gateway identity handshake", env);
    expect(routingEndpointState(projDir, env, 0)).toBe("quarantined");
  });

  it("stops reporting once the refusal is cleared", () => {
    const key = writeSlot();
    markRoutingEndpointDown(key, STARTED_AT, env, 1_000_000);
    clearRoutingEndpointDown(key, env);
    expect(routingEndpointState(projDir, env, 10_000_000)).toBe("ok");
  });

  it("does not report a SUCCESSOR gateway dead on its predecessor's marker", () => {
    // The slot key is derived from (uid, cwd, provider, workflow), so a replacement REUSES it. Only
    // the recorded `startedAt` distinguishes the dead process from the live one.
    const key = writeSlot();
    markRoutingEndpointDown(key, STARTED_AT, env, 1_000_000);
    writeSlot("2026-09-08T01:00:00.000Z");
    expect(routingEndpointState(projDir, env, 10_000_000)).toBe("ok");
  });

  it("reports an unreachable slot owned by ANY provider, not only the default one", () => {
    const key = writeSlot(STARTED_AT, "openai");
    markRoutingEndpointDown(key, STARTED_AT, env, 1_000_000);
    expect(routingEndpointState(projDir, env, 10_000_000)).toBe("unavailable");
  });

  it("resolves to 'unrouted' rather than throwing when the routing record is unreadable", () => {
    const key = writeSlot();
    // A reporting aid must never be the reason a render-loop surface breaks.
    writeFileSync(path.join(routingDir(env), `${key}.json`), "{ not json", "utf8");
    expect(routingEndpointState(projDir, env, 10_000_000)).toBe("unrouted");
  });
});

/**
 * THE SEAM ITSELF, NOT A FIXTURE OF IT.
 *
 * Everything above writes the marker by hand. That proves the state machine reads correctly and
 * proves nothing about whether anything ever WRITES. `reviveOneSlot` is the only code that connects a
 * real probe to this file, and with it deleted every test above still passed - the status line would
 * have gone on reporting `ok` through a real outage with a fully green suite, which is precisely the
 * defect class this whole PR exists to remove.
 *
 * These drive the REAL revival entry point with the probe seam the module already exposes for tests,
 * so the assertion is about the wiring and cannot be satisfied by a hand-written file.
 */
describe("reviveRoutingGatewayIfDown - the observation actually reaches the marker", () => {
  const NOW = 1_700_000_000_000;

  function markerFile(key: string): string {
    return path.join(routingDir(env), `${key}.down`);
  }

  it("WRITES the marker when a real probe sees the reserved port refuse", async () => {
    const key = writeSlot();
    let spawned = 0;
    const outcome = await reviveRoutingGatewayIfDown(projDir, {
      env,
      wait: false,
      isReachable: async () => false,
      spawnGatewayStart: () => {
        spawned += 1;
      },
      now: () => NOW
    });
    // The path really did run to the repair, so the marker below was written by THIS call and not by
    // an early return that happens to leave a file behind.
    expect(outcome.status).toBe("spawned");
    expect(spawned).toBe(1);
    expect(JSON.parse(readFileSync(markerFile(key), "utf8"))).toEqual({
      slotStartedAt: STARTED_AT,
      unreachableSince: NOW
    });
  });

  it("CLEARS the marker when the reserved port answers again", async () => {
    const key = writeSlot();
    await reviveRoutingGatewayIfDown(projDir, {
      env,
      wait: false,
      isReachable: async () => false,
      spawnGatewayStart: () => {},
      now: () => NOW
    });
    // The precondition is PROVEN, not assumed: without this, a clear-side regression and a
    // write-side regression would look identical to the assertion below.
    expect(existsSync(markerFile(key))).toBe(true);

    const outcome = await reviveRoutingGatewayIfDown(projDir, {
      env,
      wait: false,
      isReachable: async () => true,
      spawnGatewayStart: () => {
        throw new Error("a reachable endpoint must never be spawned over");
      },
      now: () => NOW
    });
    expect(outcome.status).toBe("reachable");
    expect(existsSync(markerFile(key))).toBe(false);
  });

  it("records the refusal even when the respawn cooldown suppresses the repair", async () => {
    // ORDERING, and it is load-bearing. The detached respawn is rate-limited; a gateway that cannot
    // come up at all spends most of its renders in cooldown. Recording after that early return would
    // leave the surface green for exactly the endpoint that is most thoroughly broken.
    const key = writeSlot();
    await reviveRoutingGatewayIfDown(projDir, {
      env,
      wait: false,
      isReachable: async () => false,
      spawnGatewayStart: () => {},
      now: () => NOW
    });
    rmSync(markerFile(key), { force: true });

    let spawned = 0;
    const outcome = await reviveRoutingGatewayIfDown(projDir, {
      env,
      wait: false,
      isReachable: async () => false,
      spawnGatewayStart: () => {
        spawned += 1;
      },
      now: () => NOW + 10
    });
    expect(outcome.status).toBe("cooldown");
    expect(spawned).toBe(0);
    expect(existsSync(markerFile(key))).toBe(true);
  });

  it("CLEARS the marker on the WAITING path when the same endpoint answers again", async () => {
    // The third uncovered seam, and the one whose absence is hardest to notice: the incumbent gateway
    // recovers rather than being replaced, so the slot - and its `startedAt` - never change and the
    // staleness rule cannot retire the marker. Only the explicit clear in `pollUntilServing` does.
    const key = writeSlot();
    let refuseOnce = true;
    const outcome = await reviveRoutingGatewayIfDown(projDir, {
      env,
      wait: true,
      budgetMs: 2000,
      isReachable: async () => {
        if (refuseOnce) {
          refuseOnce = false;
          return false;
        }
        return true;
      },
      // Deliberately writes NO new slot record: this is the incumbent coming back, not a successor.
      spawnGatewayStart: () => {},
      queryIdentity: async () => ({ ok: true }),
      // A REAL clock here on purpose: `pollUntilServing` loops against its own deadline, and a frozen
      // clock would turn any regression that stops the loop terminating into a hang instead of a fail.
      now: () => Date.now()
    });
    expect(outcome.status).toBe("revived");
    expect(existsSync(markerFile(key))).toBe(false);
  });

  it("leaves an unrouted directory alone - no probe, no marker, no directory", async () => {
    const outcome = await reviveRoutingGatewayIfDown(projDir, {
      env,
      wait: false,
      isReachable: async () => {
        throw new Error("the consent gate must be checked before anything is probed");
      },
      spawnGatewayStart: () => {},
      now: () => NOW
    });
    expect(outcome.status).toBe("no-slot");
  });
});

describe("markRoutingEndpointDown - the clock measures the outage, not the last look at it", () => {
  it("keeps the FIRST refusal time across repeated observations of one outage", () => {
    // The status line observes on every render. Re-stamping would push the reported state past the
    // grace window forever and the outage would never be reported at all.
    const key = writeSlot();
    markRoutingEndpointDown(key, STARTED_AT, env, 1_000_000);
    markRoutingEndpointDown(key, STARTED_AT, env, 1_000_000 + 60_000);
    const marker = JSON.parse(readFileSync(path.join(routingDir(env), `${key}.down`), "utf8")) as {
      unreachableSince: number;
    };
    expect(marker.unreachableSince).toBe(1_000_000);
  });

  it("restarts the clock for a DIFFERENT slot lifetime", () => {
    const key = writeSlot();
    markRoutingEndpointDown(key, STARTED_AT, env, 1_000_000);
    markRoutingEndpointDown(key, "2026-09-08T01:00:00.000Z", env, 5_000_000);
    const marker = JSON.parse(readFileSync(path.join(routingDir(env), `${key}.down`), "utf8")) as {
      slotStartedAt: string;
      unreachableSince: number;
    };
    expect(marker).toEqual({ slotStartedAt: "2026-09-08T01:00:00.000Z", unreachableSince: 5_000_000 });
  });
});
