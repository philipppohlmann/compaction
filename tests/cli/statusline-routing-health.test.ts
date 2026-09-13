import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  computeStatusLine,
  STATUS_LINE_PLACEHOLDER,
  STATUS_LINE_ROUTING_DOWN,
  STATUS_LINE_ROUTING_QUARANTINED
} from "../../src/cli/commands/statusline.js";
import { markRoutingEndpointDown, ROUTING_DOWN_GRACE_MS } from "../../src/core/gateway/routing-health.js";
import { quarantineRoutingSlot, routingSlotKey, writeRoutingSlot } from "../../src/core/gateway/routing-registry.js";
import type { GatewayReceipt } from "../../src/core/gateway/receipt.js";

/**
 * THE STATUS LINE MUST NOT ASSERT HEALTH DURING A ROUTING OUTAGE.
 *
 * Measured (incident §7.1): the endpoint backing a live session was dead for minutes, every request
 * failed, and this line - the only per-turn surface Claude Code renders - went on printing
 * `compaction · recording` throughout.
 *
 * The states that matter are covered separately here: routing live, routing down but still inside
 * the self-repair window, routing down past it, routing quarantined, and no routing at all. Exact
 * string pins are kept in their OWN tests, apart from the property assertions: in one test the string
 * failure reports first and can leave the property assertion dead and never exercised.
 */

const STARTED_AT = "2026-09-08T00:00:00.000Z";
/** Old enough that any grace window has elapsed, without pinning the window's size here. */
const LONG_AGO = Date.now() - ROUTING_DOWN_GRACE_MS - 60_000;

let root = "";
let projDir = "";
let env: NodeJS.ProcessEnv;

function stdin(): string {
  return JSON.stringify({ cwd: projDir });
}

function writeSlot(startedAt = STARTED_AT): string {
  const key = routingSlotKey({ cwd: projDir, provider: "anthropic" }, env);
  writeRoutingSlot(
    key,
    {
      pid: 999_999_995,
      host: "127.0.0.1",
      port: 21999,
      reservedPort: 21999,
      provider: "anthropic",
      upstream: "http://127.0.0.1:1",
      mode: "record",
      cwd: projDir,
      startedAt
    },
    env
  );
  return key;
}

/** A routed directory whose endpoint has been refusing for longer than a self-repair takes. */
function routingDownPastGrace(): void {
  const key = writeSlot();
  markRoutingEndpointDown(key, STARTED_AT, env, LONG_AGO);
}

/** A receipt-bearing render, so the surface has a real line of its own to render instead. */
function receipt(): GatewayReceipt {
  return {
    receipt_id: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
    captured_at: "2026-09-08T10:00:00.000Z",
    provider: "anthropic",
    model: "claude-opus-4",
    endpoint: "/v1/messages",
    mode: "record",
    upstream_status: 200,
    model_visible_bytes_changed: false,
    tokens: { prompt_input: 22012, output: 412 },
    fresh_billed_input_reduction: { available: false, note: "x" },
    token_source: "provider-reported",
    cache_source: "unavailable",
    cost_source: "unavailable",
    reasons: { cost: "x" },
    claim_scope: "run-scoped",
    approval_status: "not-required",
    sync_status: "local-only"
  } as GatewayReceipt;
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "statusline-routing-"));
  projDir = path.join(root, "proj");
  mkdirSync(projDir, { recursive: true });
  env = {
    COMPACTION_HOME: path.join(root, ".compaction"),
    COMPACTION_CONFIG_DIR: path.join(root, "config")
  };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("statusline - an unavailable routed endpoint", () => {
  it("renders the routing line VERBATIM once the endpoint has been down past the grace window", async () => {
    routingDownPastGrace();
    const line = await computeStatusLine(stdin(), { readReceipt: async () => undefined, env });
    expect(line).toBe(STATUS_LINE_ROUTING_DOWN);
  });

  it("no longer claims recording while the endpoint is down", async () => {
    // The property, kept apart from the pin above: whatever the exact copy becomes, it may not
    // assert that this device is recording when nothing can be recorded.
    routingDownPastGrace();
    const line = await computeStatusLine(stdin(), { readReceipt: async () => undefined, env });
    expect(line).not.toBe(STATUS_LINE_PLACEHOLDER);
    expect(line).not.toMatch(/recording/i);
  });

  it("replaces a receipt-bearing line too, not only the quiet placeholder", async () => {
    // The counts are stale by construction while the endpoint is down - no receipt can land - so
    // decorating them would leave the stale number as the sentence's subject.
    routingDownPastGrace();
    const line = await computeStatusLine(stdin(), { readReceipt: async () => receipt(), env });
    expect(line).toBe(STATUS_LINE_ROUTING_DOWN);
  });

  it("replaces the stdin output-only line too", async () => {
    routingDownPastGrace();
    const line = await computeStatusLine(JSON.stringify({ cwd: projDir, output_tokens: 412 }), {
      readReceipt: async () => undefined,
      env
    });
    expect(line).toBe(STATUS_LINE_ROUTING_DOWN);
  });

  it("still prints nothing at all when the kill switch is set", async () => {
    // `COMPACTION_RECEIPT_LINE=0` means this surface is off. An outage does not reopen it.
    routingDownPastGrace();
    const line = await computeStatusLine(stdin(), {
      readReceipt: async () => undefined,
      env: { ...env, COMPACTION_RECEIPT_LINE: "0" }
    });
    expect(line).toBeUndefined();
  });
});

describe("statusline - a quarantined routed endpoint", () => {
  it("renders the quarantine line VERBATIM, with no grace window", async () => {
    const key = writeSlot();
    quarantineRoutingSlot(key, "held by a listener that failed the gateway identity handshake", env);
    const line = await computeStatusLine(stdin(), { readReceipt: async () => undefined, env });
    expect(line).toBe(STATUS_LINE_ROUTING_QUARANTINED);
  });

  it("makes no promise that the endpoint comes back, and claims no recording", async () => {
    // The precedent this follows: the quarantined routing row in `gateway status` prints a bare
    // NOT ANSWERING rather than promising revival, because in that state the promise is false.
    const key = writeSlot();
    quarantineRoutingSlot(key, "held by a listener that failed the gateway identity handshake", env);
    const line = await computeStatusLine(stdin(), { readReceipt: async () => undefined, env });
    expect(line).not.toMatch(/recording/i);
    expect(line).not.toMatch(/revive|revives|will come back|reconnect/i);
  });
});

/**
 * THE CHAIN FROM THE COMMAND TO THE MARKER, END TO END, THROUGH THE SHIPPED BINARY.
 *
 * `computeStatusLine` above only READS. The write happens in the command's action, after the line:
 * `statusline` -> `detectDeadRoutingEndpoint` -> `reviveRoutingGatewayIfDown` -> the marker. Every
 * link in that chain could be deleted and every test above would still pass, because they all write
 * the marker by hand - and the surface would go on reporting `ok` through a real outage with a green
 * suite. This drives `dist/cli/index.js` exactly as Claude Code drives it.
 *
 * A recent respawn marker is pre-placed so the refusal lands in the detached-respawn COOLDOWN and no
 * real gateway process is started by a unit test. That is not a workaround: the cooldown branch is
 * the state a permanently-broken endpoint spends most of its renders in, so it is the branch whose
 * recording matters most.
 */
describe("the statusline COMMAND records what it observed", () => {
  const CLI_DIST = path.join(
    path.resolve(fileURLToPath(new URL("../..", import.meta.url))),
    "dist/cli/index.js"
  );

  it("writes the down marker for a refused reserved port, driven through the real CLI", async () => {
    const key = writeSlot();
    const routing = path.join(root, ".compaction", "routing");
    writeFileSync(path.join(routing, `${key}.respawn`), `${Date.now()}\n`, "utf8");
    expect(existsSync(path.join(routing, `${key}.down`))).toBe(false);

    await new Promise<void>((resolve) => {
      const child = spawn(process.execPath, [CLI_DIST, "statusline"], {
        cwd: projDir,
        env: { ...process.env, HOME: root, COMPACTION_HOME: path.join(root, ".compaction"), NO_COLOR: "1" },
        stdio: ["pipe", "ignore", "ignore"]
      });
      child.stdin.end(stdin());
      child.on("close", () => resolve());
      child.on("error", () => resolve());
    });

    // The slot's reserved port (21999) is not listening, so the real probe refused and the real
    // revival path recorded it. Nothing in this test wrote the file.
    const marker = JSON.parse(readFileSync(path.join(routing, `${key}.down`), "utf8")) as {
      slotStartedAt: string;
      unreachableSince: number;
    };
    expect(marker.slotStartedAt).toBe(STARTED_AT);
    expect(marker.unreachableSince).toBeGreaterThan(0);
  }, 60_000);
});

describe("statusline - the states that must NOT be reported as an outage", () => {
  it("leaves an unrouted directory's line exactly as it was", async () => {
    // Every hooks-only and subscription device is in this state permanently. It has no routing slot,
    // so this surface has nothing to say about routing and must not invent it.
    const line = await computeStatusLine(stdin(), { readReceipt: async () => undefined, env });
    expect(line).toBe(STATUS_LINE_PLACEHOLDER);
  });

  it("leaves a routed directory with no recorded refusal exactly as it was", async () => {
    writeSlot();
    const line = await computeStatusLine(stdin(), { readReceipt: async () => undefined, env });
    expect(line).toBe(STATUS_LINE_PLACEHOLDER);
  });

  it("does not flash an outage across a self-repair that is still inside the grace window", async () => {
    const key = writeSlot();
    markRoutingEndpointDown(key, STARTED_AT, env, Date.now());
    const line = await computeStatusLine(stdin(), { readReceipt: async () => undefined, env });
    expect(line).toBe(STATUS_LINE_PLACEHOLDER);
  });

  it("does not report a SUCCESSOR gateway dead on its predecessor's recorded refusal", async () => {
    const key = writeSlot();
    markRoutingEndpointDown(key, STARTED_AT, env, LONG_AGO);
    writeSlot("2026-09-08T02:00:00.000Z");
    const line = await computeStatusLine(stdin(), { readReceipt: async () => undefined, env });
    expect(line).toBe(STATUS_LINE_PLACEHOLDER);
  });

  it("renders the ordinary receipt line unchanged while routing is live", async () => {
    // The healthy path must be byte-identical, or the fix trades one wrong line for another.
    writeSlot();
    const routed = await computeStatusLine(stdin(), { readReceipt: async () => receipt(), env });
    const unrouted = await computeStatusLine(JSON.stringify({ cwd: path.join(root, "elsewhere") }), {
      readReceipt: async () => receipt(),
      env
    });
    expect(routed).toBe(unrouted);
    expect(routed).toContain("input 22,012");
  });
});
