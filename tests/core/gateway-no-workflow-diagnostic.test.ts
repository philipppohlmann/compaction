/**
 * THE NO-WORKFLOW DIAGNOSTIC: once per gateway, and only for a device that could have expected apply.
 *
 * A `--workflow none` gateway can never consult the stored-policy input-compaction path, and used to
 * return from that decision with no log line at all — the commonest reason a session silently never
 * compacts input, and the reason diagnosing it took a process-level investigation.
 *
 * The first attempt at a fix went too far in the other direction: it emitted the three-sentence paragraph
 * ONCE PER POST. Measured, three POSTs produced three copies against ONE receipt line — the diagnostic
 * outnumbering the product's own per-turn signal 3:1, on the surface this repo protects hardest, and
 * writing an unbounded per-request line into a 0600 routing-slot log whose guard documents
 * "nothing per-request". It also fired on Open devices, handing a user who never had input compaction a
 * diagnosis of a problem they do not have.
 *
 * Both halves are pinned here.
 */
import http from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGatewayServer } from "../../src/core/gateway/server.js";
import { provisionValidLease } from "../helpers/lease-fixture.js";
import { readLeaseVerdict } from "../../src/core/entitlement/lease-store.js";

const MARKER = "no routable workflow identity";
let upstream: http.Server;
let upstreamUrl: string;
let originalConfigDir: string | undefined;
let originalApiKey: string | undefined;
const temporaries: string[] = [];

beforeEach(async () => {
  originalConfigDir = process.env.COMPACTION_CONFIG_DIR;
  originalApiKey = process.env.ANTHROPIC_API_KEY;
  upstream = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ usage: { input_tokens: 3, output_tokens: 1 } }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
});

afterEach(async () => {
  if (originalConfigDir === undefined) delete process.env.COMPACTION_CONFIG_DIR;
  else process.env.COMPACTION_CONFIG_DIR = originalConfigDir;
  // Restored too: a DELETED key would otherwise leak to later files sharing this worker.
  if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = originalApiKey;
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  for (const dir of temporaries.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temporary(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temporaries.push(dir);
  return dir;
}

/** Drive `posts` POSTs through a `--workflow none` gateway and return how many diagnostics it logged. */
async function diagnosticsFor(posts: number): Promise<number> {
  const logs: string[] = [];
  // No `workflow` — exactly the shape `gateway ensure` spawns when any apply-routing condition is unmet.
  const server = createGatewayServer({
    provider: "anthropic",
    upstream: upstreamUrl,
    mode: "record",
    log: (line) => logs.push(line),
    cwd: temporary("gw-noworkflow-")
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as { port: number }).port;
  try {
    for (let i = 0; i < posts; i++) {
      await new Promise<void>((resolve) => {
        const request = http.request(
          { host: "127.0.0.1", port, path: "/v1/messages", method: "POST", headers: { "content-type": "application/json" } },
          (response) => {
            response.on("data", () => {});
            response.on("end", () => resolve());
          }
        );
        request.end(JSON.stringify({ model: "m", max_tokens: 4, messages: [{ role: "user", content: "hi" }] }));
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  return logs.filter((line) => line.includes(MARKER)).length;
}

describe("the --workflow none diagnostic", () => {
  it("fires exactly ONCE per gateway, not once per request", async () => {
    const configDir = temporary("gw-lease-");
    provisionValidLease(configDir); // a verified lease: this device could have expected input compaction
    process.env.COMPACTION_CONFIG_DIR = configDir;
    delete process.env.ANTHROPIC_API_KEY;
    // Three POSTs, one line. The dead-code defect is gone AND the spam defect is gone.
    expect(await diagnosticsFor(3)).toBe(1);
  });

  it("fires on an API-KEY device too, which has no lease at all", async () => {
    // The second arm of the predicate, and the one a lease-only check would have missed.
    process.env.COMPACTION_CONFIG_DIR = temporary("gw-key-");
    process.env.ANTHROPIC_API_KEY = "sk-ant-fake-not-a-real-key";
    expect(await diagnosticsFor(3)).toBe(1);
  });

  it("is silent for a logged-out device, because a lease alone cannot survive logout", async () => {
    // A review raised this as a gap: `compaction logout` deletes credentials but NOT the lease, so a
    // lease-only predicate might silence a device the apply guard would still credential. Checked rather
    // than assumed, and the premise does not hold — the lease is DEVICE-BOUND, and the device public key is
    // read from `credentials.json` (`lease-store.ts:188-189`), so with credentials gone the verdict is
    // `lease-invalid`, never `lease-valid`. Such a device cannot pass the guard's credential condition
    // either, so staying silent is correct, not a miss.
    const configDir = temporary("gw-loggedout-");
    provisionValidLease(configDir);
    rmSync(join(configDir, "credentials.json"), { force: true });
    process.env.COMPACTION_CONFIG_DIR = configDir;
    delete process.env.ANTHROPIC_API_KEY;
    expect(readLeaseVerdict({ COMPACTION_CONFIG_DIR: configDir } as NodeJS.ProcessEnv).label)
      .not.toBe("lease-valid");
    expect(await diagnosticsFor(3)).toBe(0);
  });

  it("stays SILENT on an Open device, which never had input compaction to lose", async () => {
    process.env.COMPACTION_CONFIG_DIR = temporary("gw-open-"); // no credentials, no lease
    delete process.env.ANTHROPIC_API_KEY;
    expect(await diagnosticsFor(3)).toBe(0);
  });
});
