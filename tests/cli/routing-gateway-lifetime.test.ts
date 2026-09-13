import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import http from "node:http";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { installToolShim, type ShimEnv } from "../../src/core/tool-shim.js";
import { isProcessAlive } from "../../src/core/gateway/status.js";
import { isGatewayReachable } from "../../src/core/gateway/ensure.js";
import {
  ROUTING_PORT_BASE,
  ROUTING_PORT_SPAN,
  readRoutingSlot,
  routingSlotKey,
  type RoutingSlotRecord
} from "../../src/core/gateway/routing-registry.js";

const execFileAsync = promisify(execFile);

/**
 * THE BINDING PRODUCT INVARIANT, end to end: a running Claude survives its gateway's death.
 *
 * This drives the ACTUAL generated `claude` shim, a fake `claude` that STAYS ALIVE across the
 * gateway's death (the whole point - a child that restarts proves nothing, because a restart is
 * exactly what the frozen `ANTHROPIC_BASE_URL` makes impossible for a real session), and a fake
 * Anthropic upstream. No real network, no real credential (every fake carries a FAKE marker for the
 * secret scanner), async spawn only - `spawnSync` deadlocks against an in-worker fake upstream.
 * `COMPACTION_HOME` is redirected to a temp dir so no real `~/.compaction` is touched.
 *
 * The scenario runs ONCE and each acceptance row asserts against what it recorded. That is
 * deliberate: rows 5-7 are the safety envelope of row 4 - recovery must not be bought with a child
 * restart, a replayed provider request, or a duplicate inference - and they are only meaningful
 * about the SAME run in which the recovery happened.
 */
/**
 * Resolved from THIS FILE, not from `process.cwd()`.
 *
 * `path.resolve("src/cli/index.ts")` resolves against the runner's working directory, which is not
 * necessarily the checkout the test file belongs to - running vitest with `--root <dir>` from a
 * different directory silently points the subprocess CLI at the OTHER checkout's source, so the test
 * reports on code it is not testing. `import.meta.url` cannot drift that way.
 */
const REPO_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
/**
 * FALSIFICATION SEAM. Point the subprocess CLI at a different checkout to run this acceptance table
 * against another commit's product code - the intended use is proving that the row below FAILS on
 * the canonical pre-fix commit. Defaults to this checkout.
 */
const CLI_ROOT = process.env.COMPACTION_TEST_CLI_ROOT ?? REPO_ROOT;
const TSX = path.join(REPO_ROOT, "node_modules/.bin/tsx");
const CLI_ENTRY = path.join(CLI_ROOT, "src/cli/index.ts");

const FAKE_API_KEY = "sk-ant-FAKE-test-key-tripwire";
const FAKE_OAUTH = "Bearer FAKE-oauth-credential-tripwire";
const SECRET_PROMPT = "SECRET_PROMPT_omega_fake";

const UPSTREAM_RESPONSE = JSON.stringify({
  id: "msg_01",
  type: "message",
  role: "assistant",
  content: [{ type: "text", text: "RESP_TEXT_kappa" }],
  usage: { input_tokens: 100, cache_read_input_tokens: 25, output_tokens: 9 }
});

/**
 * The long-lived fake `claude`. Unlike the one-shot fake in `claude-shim-routing.test.ts`, this one
 * models the property under test: it is `exec`ed ONCE with a base URL frozen into its environment,
 * and it stays up issuing provider calls on demand for the rest of the scenario.
 *
 *  - writes its own pid ONCE at startup            (row 5: the child is never restarted)
 *  - appends ANTHROPIC_BASE_URL on EVERY request   (row 2: exactly one base URL for its whole life)
 *  - sends an incrementing FAKE-marked nonce       (row 6: nothing is replayed upstream)
 *  - counts only SUCCEEDED calls                   (row 7: refused calls appear in neither count)
 */
const FAKE_CLAUDE_JS = `
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const dir = process.env.FAKE_CLAUDE_DIR;
const base = process.env.ANTHROPIC_BASE_URL;
if (!base) { fs.writeFileSync(path.join(dir, "direct.txt"), "DIRECT\\n"); process.exit(7); }
fs.writeFileSync(path.join(dir, "child-pid.txt"), String(process.pid) + "\\n");
let issued = 0;
let nonce = 0;
function callProvider(cb) {
  fs.appendFileSync(path.join(dir, "base-urls.txt"), base + "\\n");
  nonce += 1;
  const body = JSON.stringify({ model: "claude-test", messages: [{ role: "user", content: ${JSON.stringify(SECRET_PROMPT)} }] });
  const url = new URL("/v1/messages", base);
  const req = http.request(
    { hostname: url.hostname, port: url.port, path: url.pathname, method: "POST",
      headers: { "content-type": "application/json", "x-api-key": ${JSON.stringify(FAKE_API_KEY)},
        authorization: ${JSON.stringify(FAKE_OAUTH)},
        "x-compaction-test-nonce": "FAKE-nonce-" + nonce,
        "content-length": Buffer.byteLength(body) } },
    (res) => { let data = ""; res.on("data", (c) => (data += c)); res.on("end", () => {
      issued += 1;
      fs.writeFileSync(path.join(dir, "child-issued.txt"), String(issued) + "\\n");
      cb("OK " + data);
    }); }
  );
  req.on("error", (e) => cb("ERR " + e.message));
  req.end(body);
}
const control = http.createServer((req, res) => {
  if (req.url === "/exit") { res.end("BYE"); setTimeout(() => process.exit(7), 20); return; }
  callProvider((text) => { res.writeHead(200, { "content-type": "text/plain" }); res.end(text); });
});
control.listen(0, "127.0.0.1", () => {
  fs.writeFileSync(path.join(dir, "child-ctl-port.txt"), String(control.address().port) + "\\n");
});
`;

interface Scenario {
  projDir: string;
  home: string;
  slotKey: string;
  reservedPort: number;
  injectedBase: string;
  slotBeforeKill?: RoutingSlotRecord | null;
  slotAfterRevive?: RoutingSlotRecord | null;
  killedGatewayPid: number;
  gatewayDeadAfterKill: boolean;
  portRefusedAfterKill: boolean;
  duringOutage: string;
  afterRevival: string;
  portReachableAfterRevival: boolean;
  childPidLines: string[];
  baseUrlLines: string[];
  childIssuedCount: number;
  upstreamNonces: string[];
  upstreamCount: number;
  shimOutput: string;
  routingDirListing: string[];
  routingLog: string;
}

let root = "";
let upstream: http.Server | undefined;
let shimChild: ReturnType<typeof spawn> | undefined;
const scenario: Partial<Scenario> = {};

function readLines(file: string): string[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
}

async function waitFor(check: () => boolean | Promise<boolean>, ms = 15_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await check()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Ask the STILL-RUNNING child to issue one provider call on its unchanged, frozen base URL. */
async function askChildToCallProvider(dir: string): Promise<string> {
  const port = Number(readLines(path.join(dir, "child-ctl-port.txt"))[0]);
  if (!Number.isFinite(port) || port <= 0) return "ERR no control port";
  return await new Promise<string>((resolve) => {
    const req = http.request({ hostname: "127.0.0.1", port, path: "/issue", method: "POST" }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve(data));
    });
    req.on("error", (e) => resolve(`ERR control ${e.message}`));
    req.end();
  });
}

beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), "routing-lifetime-"));
  const realBinDir = path.join(root, "realbin");
  const home = path.join(root, "home");
  const projDir = path.join(root, "proj");
  const fakeDir = path.join(root, "fake");
  for (const dir of [realBinDir, home, projDir, fakeDir]) mkdirSync(dir, { recursive: true });
  scenario.home = home;
  scenario.projDir = projDir;

  const upstreamSeen: Array<{ nonce: string }> = [];
  upstream = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      upstreamSeen.push({ nonce: String(req.headers["x-compaction-test-nonce"] ?? "") });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(UPSTREAM_RESPONSE);
    });
  });
  await new Promise<void>((r) => upstream!.listen(0, "127.0.0.1", () => r()));
  const upstreamUrl = `http://127.0.0.1:${(upstream!.address() as { port: number }).port}`;

  const fakeClaudeJs = path.join(realBinDir, "fake-claude.cjs");
  writeFileSync(fakeClaudeJs, FAKE_CLAUDE_JS, "utf8");
  const claude = path.join(realBinDir, "claude");
  writeFileSync(claude, `#!/usr/bin/env bash\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeClaudeJs)} "$@"\n`, "utf8");
  chmodSync(claude, 0o755);

  const compactionBin = path.join(root, "compaction-test");
  writeFileSync(compactionBin, `#!/usr/bin/env bash\nexec ${JSON.stringify(TSX)} ${JSON.stringify(CLI_ENTRY)} "$@"\n`, "utf8");
  chmodSync(compactionBin, 0o755);

  const compactionHome = path.join(home, ".compaction");
  const shimEnv: ShimEnv = { HOME: home, COMPACTION_HOME: compactionHome, PATH: realBinDir };
  const install = installToolShim("claude-code", shimEnv);
  const shimPath = install.shimPath;

  const runEnv = {
    HOME: home,
    COMPACTION_HOME: compactionHome,
    PATH: `${path.dirname(process.execPath)}${path.delimiter}/usr/bin${path.delimiter}/bin`,
    COMPACTION_BIN: compactionBin,
    COMPACTION_GATEWAY_UPSTREAM: upstreamUrl,
    FAKE_CLAUDE_DIR: fakeDir,
    NO_COLOR: "1"
  } as NodeJS.ProcessEnv;

  // ---- The child comes up ONCE, through the real shim, and stays up for the whole scenario. ------
  shimChild = spawn("bash", [shimPath, "-p", "stay alive"], { cwd: projDir, env: runEnv, stdio: ["ignore", "pipe", "pipe"] });
  let shimOutput = "";
  shimChild.stdout?.on("data", (c: Buffer) => (shimOutput += c.toString("utf8")));
  shimChild.stderr?.on("data", (c: Buffer) => (shimOutput += c.toString("utf8")));
  await waitFor(() => existsSync(path.join(fakeDir, "child-ctl-port.txt")));
  scenario.shimOutput = shimOutput;

  const slotKey = routingSlotKey({ cwd: projDir, provider: "anthropic" }, { COMPACTION_HOME: compactionHome });
  scenario.slotKey = slotKey;
  await waitFor(() => readRoutingSlot(slotKey, { COMPACTION_HOME: compactionHome }) !== null);
  const slot = readRoutingSlot(slotKey, { COMPACTION_HOME: compactionHome });
  scenario.slotBeforeKill = slot;
  scenario.reservedPort = slot?.reservedPort ?? 0;
  scenario.injectedBase = `http://127.0.0.1:${slot?.reservedPort ?? 0}`;

  // A first real call, so the route is proven working before anything is killed.
  await askChildToCallProvider(fakeDir);

  // ---- Row 3: the gateway REALLY dies and the port REALLY refuses. ------------------------------
  const gatewayPid = slot?.pid ?? 0;
  scenario.killedGatewayPid = gatewayPid;
  // NEVER signal a non-positive pid: `process.kill(0, …)` targets the whole process GROUP, which on
  // a missing slot would take down the test runner itself and report as a silent, output-free exit.
  if (gatewayPid > 0) {
    try {
      process.kill(gatewayPid, "SIGKILL");
    } catch {
      /* recorded below as not-dead */
    }
  }
  scenario.gatewayDeadAfterKill = gatewayPid > 0 && (await waitFor(() => !isProcessAlive(gatewayPid), 8000));
  scenario.portRefusedAfterKill = await waitFor(async () => !(await isGatewayReachable("127.0.0.1", scenario.reservedPort!, 200)), 8000);

  // The outage is real for the pinned child too: its next call is refused, not silently rerouted.
  scenario.duringOutage = await askChildToCallProvider(fakeDir);

  // ---- Row 4: the revival triggers, invoked EXACTLY as Claude Code invokes them. -----------------
  const stdinJson = JSON.stringify({ cwd: projDir, session_id: "11111111-2222-3333-4444-555555555555" });
  const runCli = async (args: string[], stdin: string): Promise<void> => {
    await new Promise<void>((resolve) => {
      const child = spawn(compactionBin, args, { cwd: projDir, env: runEnv, stdio: ["pipe", "ignore", "ignore"] });
      child.stdin.end(stdin);
      child.on("close", () => resolve());
      child.on("error", () => resolve());
    });
  };
  await runCli(["statusline"], stdinJson);
  await runCli(["capture", "claude-code", "--shape-prompt-hook"], stdinJson);

  scenario.portReachableAfterRevival = await waitFor(
    () => isGatewayReachable("127.0.0.1", scenario.reservedPort!, 300),
    20_000
  );
  scenario.slotAfterRevive = readRoutingSlot(slotKey, { COMPACTION_HOME: compactionHome });

  // The still-running child's next POST to its UNCHANGED base URL must return the upstream's bytes.
  scenario.afterRevival = await askChildToCallProvider(fakeDir);

  scenario.childPidLines = readLines(path.join(fakeDir, "child-pid.txt"));
  scenario.baseUrlLines = readLines(path.join(fakeDir, "base-urls.txt"));
  scenario.childIssuedCount = Number(readLines(path.join(fakeDir, "child-issued.txt"))[0] ?? "0");
  scenario.upstreamNonces = upstreamSeen.map((s) => s.nonce);
  scenario.upstreamCount = upstreamSeen.length;

  // The routing directory and its log ARE the diagnostic surface this change adds. Capturing them
  // means a failure here names what actually happened instead of only what did not.
  const routingDirPath = path.join(compactionHome, "routing");
  scenario.routingDirListing = existsSync(routingDirPath) ? readdirSync(routingDirPath) : [];
  scenario.routingLog = (scenario.routingDirListing ?? [])
    .filter((name) => name.endsWith(".log"))
    .map((name) => readFileSync(path.join(routingDirPath, name), "utf8"))
    .join("\n");
  if (process.env.ROUTING_TEST_DEBUG === "1") {
    console.error("[compaction-home]", compactionHome, existsSync(compactionHome) ? readdirSync(compactionHome) : "MISSING");
    console.error("[proj]", existsSync(path.join(projDir, ".compaction")) ? readdirSync(path.join(projDir, ".compaction")) : "MISSING");
    console.error("[fakedir]", readdirSync(fakeDir));
    console.error("[routing-dir]", scenario.routingDirListing);
    console.error("[routing-log]", scenario.routingLog);
    console.error("[shim]", scenario.shimOutput);
    console.error("[base-urls]", scenario.baseUrlLines);
  }
}, 180_000);

afterAll(async () => {
  const compactionHome = path.join(scenario.home ?? "", ".compaction");
  for (const pid of [scenario.slotAfterRevive?.pid, scenario.slotBeforeKill?.pid, Number(scenario.childPidLines?.[0])]) {
    // Same rail as the kill above: a non-positive pid would signal the whole process group.
    if (pid && Number.isFinite(pid) && pid > 0 && isProcessAlive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }
  try {
    shimChild?.kill("SIGKILL");
  } catch {
    /* already gone */
  }
  void compactionHome;
  if (upstream) await new Promise<void>((r) => upstream!.close(() => r()));
  if (root) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("routing gateway lifetime (e2e: real shim, long-lived fake claude, fake upstream)", () => {
  it("[row 1] the routing gateway is recorded in the user-global slot on a reserved band port, not in the project pidfile", () => {
    const slot = scenario.slotBeforeKill;
    expect(slot).not.toBeNull();
    expect(slot!.port).toBe(slot!.reservedPort);
    expect(slot!.reservedPort).toBeGreaterThanOrEqual(ROUTING_PORT_BASE);
    expect(slot!.reservedPort).toBeLessThan(ROUTING_PORT_BASE + ROUTING_PORT_SPAN);
    expect(slot!.mode).toBe("record");
    expect(slot!.provider).toBe("anthropic");
    expect(slot!.workflow).toBeUndefined();
    // The project pidfile is what `compaction gateway stop` and the `dev` conflict advice act on.
    // The routing endpoint must not be reachable from there any more (requirement 9).
    expect(existsSync(path.join(scenario.projDir!, ".compaction", "gateway", "gateway.json"))).toBe(false);
  });

  it("[row 2] the child observes exactly one base URL for its whole life", () => {
    expect(scenario.baseUrlLines!.length).toBeGreaterThanOrEqual(2);
    expect(new Set(scenario.baseUrlLines!).size).toBe(1);
    expect(scenario.baseUrlLines![0]).toBe(scenario.injectedBase);
  });

  it("[row 3] the gateway really dies and the port really refuses", () => {
    expect(scenario.killedGatewayPid).toBeGreaterThan(0);
    expect(scenario.gatewayDeadAfterKill).toBe(true);
    expect(scenario.portRefusedAfterKill).toBe(true);
    // The pinned child felt it: its call during the outage was refused, never quietly rerouted.
    expect(scenario.duringOutage).toMatch(/^ERR/);
  });

  it("a killed routing gateway is revived on the SAME injected base URL and the still-running child recovers", () => {
    expect(scenario.portReachableAfterRevival).toBe(true);
    const revived = scenario.slotAfterRevive;
    expect(revived).not.toBeNull();
    // The address did not move - this is the whole repair.
    expect(revived!.port).toBe(scenario.reservedPort);
    expect(revived!.reservedPort).toBe(scenario.reservedPort);
    // It is a genuinely new process, not the corpse being misread as alive.
    expect(revived!.pid).not.toBe(scenario.killedGatewayPid);
    expect(isProcessAlive(revived!.pid)).toBe(true);
    // And the still-running child, on its UNCHANGED frozen base URL, gets the upstream's bytes.
    expect(scenario.afterRevival).toContain("OK ");
    expect(scenario.afterRevival).toContain("RESP_TEXT_kappa");
  });

  it("[row 5] the child process is never restarted", () => {
    expect(scenario.childPidLines).toHaveLength(1);
    const childPid = Number(scenario.childPidLines![0]);
    expect(Number.isFinite(childPid)).toBe(true);
    expect(isProcessAlive(childPid)).toBe(true);
  });

  it("[row 6] no request nonce reaches the upstream twice", () => {
    const nonces = scenario.upstreamNonces!;
    expect(nonces.length).toBeGreaterThanOrEqual(2);
    expect(new Set(nonces).size).toBe(nonces.length);
  });

  it("[row 7] upstream call count equals child call count", () => {
    // Exactly 1:1 across death and revival. A refused call appears in NEITHER count, and a revival
    // bug that spawned in a loop or replayed a request would break this equality.
    expect(scenario.upstreamCount).toBe(scenario.childIssuedCount);
    expect(scenario.upstreamCount).toBeGreaterThanOrEqual(2);
  });
});
