/**
 * RECORD-MODE OUTPUT-SHAPING PROVENANCE — the run must account for shaping it did not itself perform.
 *
 * THE CONFIGURATION UNDER TEST IS THE COMMON ONE, not an edge case: Claude Code with the prompt hook
 * installed, routed through the gateway on Open `basic`. The hook attaches the shaping policy upstream,
 * so the gateway correctly declines to attach a duplicate block and mutates nothing — while the request
 * still reaches the model carrying the policy at instruction level.
 *
 * A REAL gateway against a REAL upstream; the assertion is on the persisted receipt, not a hand-built one.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createServer, request, type Server } from "node:http";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGatewayServer } from "../../src/core/gateway/server.js";
import type { GatewayReceipt } from "../../src/core/gateway/receipt.js";
import { buildHookOutputShapingTreatment } from "../../src/core/output-shaping.js";
import { outputShapingActiveOnRequest } from "../../src/core/gateway/output-shaping-policy.js";
import { writeProductMode } from "../../src/core/onboarding-preferences.js";
import { aggregateRun } from "../../src/core/gateway/run-aggregate.js";

const UPSTREAM_REPLY = JSON.stringify({ id: "msg_fake", usage: { input_tokens: 1200, output_tokens: 400 } });
const HOOK_POLICY = buildHookOutputShapingTreatment();

/** Exactly what the tool's own UserPromptSubmit hook produces: the policy inside a system-role message. */
function hookShapedBody(): string {
  return JSON.stringify({
    model: "claude-opus-5",
    max_tokens: 4096,
    system: [{ type: "text", text: "You are a helpful assistant." }],
    messages: [
      { role: "user", content: "add a null check to the parser" },
      {
        role: "system",
        content:
          "You are Claude Code, Anthropic's official CLI for Claude.\n\n" +
          `UserPromptSubmit hook additional context: ${HOOK_POLICY.instructions}\n`
      }
    ]
  });
}

const servers: Server[] = [];
const dirs: string[] = [];
function listen(s: Server): Promise<number> {
  return new Promise((r) => s.listen(0, "127.0.0.1", () => r((s.address() as { port: number }).port)));
}
function close(s: Server): Promise<void> {
  return new Promise((r) => s.close(() => r()));
}
function post(port: number, path: string, body: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, method: "POST", path,
        headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) } },
      (res) => { res.on("data", () => {}); res.on("end", () => resolve(res.statusCode ?? 0)); }
    );
    req.on("error", reject);
    req.end(body);
  });
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map(close));
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
});

async function setup(): Promise<{ port: number; seen: string[]; receipts: GatewayReceipt[] }> {
  const seen: string[] = [];
  const upstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(UPSTREAM_REPLY);
    });
  });
  servers.push(upstream);
  const upstreamPort = await listen(upstream);

  const cwd = mkdtempSync(join(tmpdir(), "prov-cwd-"));
  const configDir = mkdtempSync(join(tmpdir(), "prov-cfg-"));
  dirs.push(cwd, configDir);
  mkdirSync(configDir, { recursive: true });
  const entitlementEnv = { COMPACTION_CONFIG_DIR: configDir } as NodeJS.ProcessEnv;
  writeProductMode("basic", entitlementEnv);

  const receipts: GatewayReceipt[] = [];
  const gateway = createGatewayServer({
    provider: "anthropic",
    upstream: `http://127.0.0.1:${upstreamPort}`,
    mode: "record",
    cwd,
    entitlementEnv,
    log: () => {},
    onReceipt: (r) => receipts.push(r)
  });
  servers.push(gateway);
  return { port: await listen(gateway), seen, receipts };
}

async function settle(receipts: GatewayReceipt[]): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (receipts.length > 0) return;
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("record-mode output-shaping provenance", () => {
  it("records already-active when the tool's hook shaped the request upstream", async () => {
    const body = hookShapedBody();
    // The premise: this body genuinely carries the policy where the model reads it.
    expect(outputShapingActiveOnRequest(body)).toBe(true);

    const { port, seen, receipts } = await setup();
    expect(await post(port, "/v1/messages", body)).toBe(200);
    await settle(receipts);

    // The gateway attached nothing (no duplicate block) — the bytes went upstream unchanged.
    expect(seen[0]).toBe(body);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.mode).toBe("record");

    // THE DEFECT: every call is genuinely shaped, and the receipt recorded nothing.
    expect(receipts[0]?.output_shaping_state).toBe("already-active");
    expect(receipts[0]?.output_shaping_policy_version).toBe(HOOK_POLICY.policyVersion);
  });

  it("the run renders its output arrow when a held call is mixed with shaped ones", async () => {
    const { port, receipts } = await setup();
    for (let i = 0; i < 3; i += 1) {
      expect(await post(port, "/v1/messages", hookShapedBody())).toBe(200);
    }
    for (let i = 0; i < 200 && receipts.length < 3; i += 1) await new Promise((r) => setTimeout(r, 25));
    expect(receipts).toHaveLength(3);

    // A HELD call joins them: shaping did not run on it, and it must dilute rather than exclude.
    const held: GatewayReceipt = { ...receipts[0]!, output_shaping_state: "absent" };
    const agg = aggregateRun([...receipts, held], {
      outputCalibrationResolver: () => ({ availability: "measured", reductionPct: 47 } as never)
    });

    expect(agg.shapedCallCount).toBe(3);
    expect(agg.output?.after).toBeGreaterThan(0);
    // The arrow exists because the run's TOTALS moved, not because the last receipt did.
    expect(agg.output?.before).toBeGreaterThan(agg.output?.after ?? 0);
  });
});
