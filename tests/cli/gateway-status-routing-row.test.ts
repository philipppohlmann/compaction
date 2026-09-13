import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import http from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ensureGateway } from "../../src/core/gateway/ensure.js";
import { isProcessAlive } from "../../src/core/gateway/status.js";
import {
  quarantineRoutingSlot,
  readRoutingSlot,
  resetRoutingPortSaltCache,
  routingSlotKey,
  writeRoutingSlot
} from "../../src/core/gateway/routing-registry.js";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const CLI_DIST = path.join(REPO_ROOT, "dist/cli/index.js");

/**
 * THE REVIVAL PROMISE IN `gateway status` IS CONDITIONAL, AND THE CONDITION IS LOAD-BEARING.
 *
 * A down endpoint normally IS revived at the same address by the next prompt, so saying so is
 * useful. A QUARANTINED slot is the opposite case: its reserved port is held by a listener that
 * failed the identity handshake, so nothing will ever be started there and the pinned session is
 * beyond repair. Printing the promise there contradicts the quarantine lines directly below it, and
 * does so in the one state where the user most needs the truth.
 *
 * The two states are pinned in SEPARATE tests on purpose. An exact-string pin and a property
 * assertion in one test let the string failure report first, which can leave the property assertion
 * dead and never actually exercised.
 */
const REVIVAL_PROMISE = "the next prompt in a connected session revives it at this same address";

let root = "";
let home = "";
let projDir = "";
let env: { COMPACTION_HOME: string };
let upstream: http.Server | undefined;
let upstreamUrl = "";
const savedEnv: Record<string, string | undefined> = {};
const startedPids: number[] = [];

function setEnv(key: string, value: string): void {
  savedEnv[key] = process.env[key];
  process.env[key] = value;
}

/** A slot pinning this directory to a port nothing is listening on. */
function writeDownSlot(port = 21999): string {
  const key = routingSlotKey({ cwd: projDir, provider: "anthropic" }, env);
  writeRoutingSlot(
    key,
    {
      pid: 999_999_995,
      host: "127.0.0.1",
      port,
      reservedPort: port,
      provider: "anthropic",
      upstream: upstreamUrl,
      mode: "record",
      cwd: projDir,
      startedAt: "2026-09-08T00:00:00.000Z"
    },
    env
  );
  return key;
}

async function runStatus(extraArgs: string[] = []): Promise<string> {
  const { stdout } = await execFileAsync(process.execPath, [CLI_DIST, "gateway", "status", ...extraArgs], {
    cwd: projDir,
    env: { ...process.env, HOME: home, COMPACTION_HOME: env.COMPACTION_HOME, NO_COLOR: "1" }
  });
  return stdout;
}

/** The advice that is WRONG whenever this directory is transparently routed. */
const START_A_PROJECT_GATEWAY = "start it with 'compaction gateway start'";

beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), "routing-status-row-"));
  home = path.join(root, "home");
  projDir = path.join(root, "proj");
  mkdirSync(home, { recursive: true });
  mkdirSync(projDir, { recursive: true });
  env = { COMPACTION_HOME: path.join(home, ".compaction") };
  resetRoutingPortSaltCache();
  setEnv("HOME", home);
  setEnv("COMPACTION_HOME", env.COMPACTION_HOME);

  upstream = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((r) => upstream!.listen(0, "127.0.0.1", () => r()));
  upstreamUrl = `http://127.0.0.1:${(upstream!.address() as { port: number }).port}`;
});

afterEach(async () => {
  for (const pid of startedPids) {
    if (pid > 0 && isProcessAlive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }
  startedPids.length = 0;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetRoutingPortSaltCache();
  if (upstream) await new Promise<void>((r) => upstream!.close(() => r()));
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("gateway status - the transparent routing row", () => {
  it("promises revival at the same address when the endpoint is down but REVIVABLE", async () => {
    writeDownSlot();
    const stdout = await runStatus();
    expect(stdout).toContain("NOT ANSWERING");
    expect(stdout).toContain(REVIVAL_PROMISE);
  }, 60_000);

  it("makes NO revival promise when the slot is QUARANTINED - that session cannot be repaired", async () => {
    const key = writeDownSlot();
    quarantineRoutingSlot(key, "the reserved routing port is held by a listener that failed the gateway identity handshake", env);
    const stdout = await runStatus();
    // THE LOAD-BEARING ASSERTION, first: the promise is false here and must not appear at all.
    // Nothing will be started on that port, so the pinned session is beyond repair.
    expect(stdout).not.toContain(REVIVAL_PROMISE);
  }, 60_000);

  it("still reports the quarantine reason and the un-repairable account", async () => {
    // Kept apart from the assertion above: pinning these strings in the same test would let their
    // failure report first and leave the "no promise" check unexercised.
    const key = writeDownSlot();
    quarantineRoutingSlot(key, "the reserved routing port is held by a listener that failed the gateway identity handshake", env);
    const stdout = await runStatus();
    expect(stdout).toContain("NOT ANSWERING");
    expect(stdout).toContain("quarantined:");
    expect(stdout).toContain("failed the gateway identity handshake");
    expect(stdout).toContain("cannot be repaired");
  }, 60_000);

  it("reports a live endpoint as live, with no revival promise and no quarantine", async () => {
    const result = await ensureGateway({ provider: "anthropic", upstream: upstreamUrl, cwd: projDir, cliEntry: CLI_DIST, env });
    expect(result.status).toBe("started");
    const slot = readRoutingSlot(routingSlotKey({ cwd: projDir, provider: "anthropic" }, env), env)!;
    startedPids.push(slot.pid);
    const stdout = await runStatus();
    expect(stdout).toContain("endpoint:           live");
    expect(stdout).not.toContain(REVIVAL_PROMISE);
    expect(stdout).not.toContain("quarantined:");
  }, 60_000);
});

/**
 * THE PROJECT/DEV GATEWAY AND THE TRANSPARENT-ROUTING ENDPOINT ARE TWO LIFECYCLES.
 *
 * Measured: `gateway status` printed `gateway running: no` while transparent routing was live,
 * because that row reads the PROJECT pidfile at `<cwd>/.compaction/gateway/gateway.json` and the
 * routing gateway deliberately no longer writes it. The row was not merely unclear - it then offered
 * to start a gateway the user already had, and starting one repairs nothing a routed session uses.
 *
 * Exact-string pins and property assertions are kept in separate tests throughout: a pin that fails
 * first can leave the property assertion beside it dead and never exercised.
 */
describe("gateway status - project/dev gateway state vs transparent-routing state", () => {
  it("names the row for the lifecycle it actually describes", async () => {
    const stdout = await runStatus();
    expect(stdout).toContain("project/dev gateway:  not running");
  }, 60_000);

  it("reports BOTH lifecycles when only routing exists, without conflating them", async () => {
    writeDownSlot();
    const stdout = await runStatus();
    expect(stdout).toContain("project/dev gateway:  not running");
    expect(stdout).toContain("routed:             yes");
  }, 60_000);

  it("stops telling a routed directory to start a project gateway", async () => {
    // The load-bearing assertion, alone: this advice is the harmful half of the conflation.
    writeDownSlot();
    const stdout = await runStatus();
    expect(stdout).not.toContain(START_A_PROJECT_GATEWAY);
  }, 60_000);

  it("still offers that advice when the directory really has no gateway of either kind", async () => {
    const stdout = await runStatus();
    expect(stdout).toContain(START_A_PROJECT_GATEWAY);
    expect(stdout).toContain("routed:             no");
  }, 60_000);

  it("reports a stale project pidfile as the project row's own problem", async () => {
    mkdirSync(path.join(projDir, ".compaction", "gateway"), { recursive: true });
    writeFileSync(
      path.join(projDir, ".compaction", "gateway", "gateway.json"),
      JSON.stringify({ pid: 999_999_994, host: "127.0.0.1", port: 21998, upstream: upstreamUrl, provider: "anthropic", mode: "record", startedAt: "2026-09-08T00:00:00.000Z" }),
      "utf8"
    );
    const stdout = await runStatus();
    expect(stdout).toContain("project/dev gateway:  not running  (stale pidfile for pid 999999994");
  }, 60_000);

  it("keeps the two states separately readable in --json", async () => {
    const result = await ensureGateway({ provider: "anthropic", upstream: upstreamUrl, cwd: projDir, cliEntry: CLI_DIST, env });
    expect(result.status).toBe("started");
    const slot = readRoutingSlot(routingSlotKey({ cwd: projDir, provider: "anthropic" }, env), env)!;
    startedPids.push(slot.pid);
    const parsed = JSON.parse(await runStatus(["--json"])) as {
      running: boolean;
      projectGatewayRunning: boolean;
      transparentRoutingLive: boolean;
    };
    // The two genuinely disagree here, and a consumer must be able to see which is which.
    expect(parsed.projectGatewayRunning).toBe(false);
    expect(parsed.transparentRoutingLive).toBe(true);
    // The legacy key keeps its meaning: it has always described the project pidfile.
    expect(parsed.running).toBe(false);
  }, 60_000);
});
