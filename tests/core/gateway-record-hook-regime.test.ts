/**
 * A RECORD turn carrying the Claude Code HOOK treatment must carry the hook's regime.
 *
 * Reproduces the 0.6.11 live Community run whose settled line read `output N/A→7,943`: 22 calls were
 * applied with the core carrier and `default-shapeable`, and ONE auxiliary call went through record mode
 * carrying the hook carrier (`already-active`) with no `output_shaping_regime`. That single call resolved
 * `unavailable`, and the run aggregate withdrew the counterfactual for the whole run. The hook HAD
 * classified the turn (`shape`, recorded per session); the gateway simply never read it.
 *
 * A REAL gateway against a REAL upstream; the assertion is on the receipt the gateway wrote.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createServer, request, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGatewayServer } from "../../src/core/gateway/server.js";
import type { GatewayReceipt } from "../../src/core/gateway/receipt.js";
import { buildHookOutputShapingTreatment, buildOutputShapingPolicy } from "../../src/core/output-shaping.js";
import { recordShapingOutcome, type ShapingDecisionOutcome } from "../../src/core/output-shaping-turn-state.js";
import { aggregateRun } from "../../src/core/gateway/run-aggregate.js";
import { outputCalibrationResolver } from "../../src/core/output-shaping-savings.js";
import { emptyCalibration } from "../../src/core/output-shaping-calibration-store.js";

const SESSION_ID = "578896ac-ac78-4a39-a939-252114d065dd";
const MODEL = "claude-opus-5-5";
const HOOK = buildHookOutputShapingTreatment();
const CORE = buildOutputShapingPolicy();

/** The live auxiliary call's shape: the hook carrier in a system-role message, session id in metadata. */
function hookCarrierBody(policyInstructions = HOOK.instructions): string {
  return JSON.stringify({
    model: MODEL,
    max_tokens: 4096,
    metadata: { user_id: JSON.stringify({ device_id: "dev", session_id: SESSION_ID }) },
    messages: [
      { role: "user", content: "review the release" },
      { role: "system", content: `UserPromptSubmit hook additional context: ${policyInstructions}\n` }
    ]
  });
}

const servers: Server[] = [];
const dirs: string[] = [];
const listen = (s: Server): Promise<number> =>
  new Promise((r) => s.listen(0, "127.0.0.1", () => r((s.address() as { port: number }).port)));
const close = (s: Server): Promise<void> => new Promise((r) => s.close(() => r()));
function post(port: number, body: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, method: "POST", path: "/v1/messages", agent: false,
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

async function recordOne(
  body: string,
  hookOutcome: ShapingDecisionOutcome | undefined,
  recordedAt: () => Date = () => new Date()
): Promise<GatewayReceipt> {
  const upstream = createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "msg_fake", usage: { input_tokens: 2, output_tokens: 171 } }));
    });
  });
  servers.push(upstream);
  const upstreamPort = await listen(upstream);
  const cwd = mkdtempSync(join(tmpdir(), "hook-regime-cwd-"));
  const configDir = mkdtempSync(join(tmpdir(), "hook-regime-cfg-"));
  dirs.push(cwd, configDir);
  const env = { COMPACTION_CONFIG_DIR: configDir } as NodeJS.ProcessEnv;
  if (hookOutcome) await recordShapingOutcome({ tool: "claude-code", sessionId: SESSION_ID }, hookOutcome, env, recordedAt);

  const receipts: GatewayReceipt[] = [];
  const gateway = createGatewayServer({
    provider: "anthropic",
    upstream: `http://127.0.0.1:${upstreamPort}`,
    mode: "record",
    workflow: "claude-code",
    cwd,
    entitlementEnv: env,
    log: () => {},
    onReceipt: (r) => receipts.push(r)
  });
  servers.push(gateway);
  expect(await post(await listen(gateway), body)).toBe(200);
  for (let i = 0; i < 200 && receipts.length === 0; i += 1) await new Promise((r) => setTimeout(r, 25));
  expect(receipts).toHaveLength(1);
  return receipts[0]!;
}

/** The 22 applied calls of the live run, reduced to the fields the aggregate reads. */
const LIVE_APPLIED_OUTPUTS = [26, 139, 229, 324, 295, 142, 667, 182, 290, 245, 147, 417, 170, 307, 154, 604, 261, 235, 204, 203, 335, 2196];
function liveAppliedReceipts(): GatewayReceipt[] {
  return LIVE_APPLIED_OUTPUTS.map((output) => ({
    provider: "anthropic",
    model: MODEL,
    mode: "apply",
    output_shaping_state: "attached-this-pass",
    output_shaping_policy_version: CORE.policyVersion,
    output_shaping_regime: "default-shapeable",
    tokens: { prompt_input: 100_000, output }
  }) as unknown as GatewayReceipt);
}

describe("record receipts carrying the hook treatment take the hook's regime", () => {
  it("stamps default-shapeable when the hook classified the turn `shape`", async () => {
    const receipt = await recordOne(hookCarrierBody(), "shape");
    expect(receipt.mode).toBe("record");
    expect(receipt.output_shaping_state).toBe("already-active");
    expect(receipt.output_shaping_policy_version).toBe(HOOK.policyVersion);
    expect(receipt.output_shaping_regime).toBe("default-shapeable");
  });

  it("the live run's output axis resolves to a number instead of N/A", async () => {
    const resolver = outputCalibrationResolver(emptyCalibration());
    const record = await recordOne(hookCarrierBody(), "shape");
    const fixed = aggregateRun([...liveAppliedReceipts(), record], { outputCalibrationResolver: resolver });
    expect(fixed.output?.after).toBe(7_943);
    expect(fixed.output?.counterfactualAvailable).toBe(true);
    expect(fixed.output!.before).toBeGreaterThan(fixed.output!.after);

    // The live failure, for contrast: the same call without the regime withdraws the whole run's figure.
    const { output_shaping_regime: _dropped, ...live } = record;
    const broken = aggregateRun([...liveAppliedReceipts(), live as GatewayReceipt], { outputCalibrationResolver: resolver });
    expect(broken.output?.counterfactualAvailable).toBe(false);
  });

  it.each([
    ["shape-basic (no classifier)", "shape-basic" as const],
    ["a planning hold", "hold-planning" as const],
    ["no hook record", undefined]
  ])("leaves the regime unset for %s", async (_label, outcome) => {
    const receipt = await recordOne(hookCarrierBody(), outcome);
    expect(receipt.output_shaping_state).toBe("already-active");
    expect(receipt.output_shaping_regime).toBeUndefined();
  });

  it("ignores a decision recorded after the request started (the NEXT prompt's, not this call's)", async () => {
    const receipt = await recordOne(hookCarrierBody(), "shape", () => new Date(Date.now() + 60_000));
    expect(receipt.output_shaping_state).toBe("already-active");
    expect(receipt.output_shaping_regime).toBeUndefined();
  });

  it("does not borrow the hook's decision for a carrier the hook did not emit", async () => {
    const receipt = await recordOne(hookCarrierBody(CORE.instructions), "shape");
    expect(receipt.output_shaping_state).toBe("already-active");
    expect(receipt.output_shaping_policy_version).toBe(CORE.policyVersion);
    expect(receipt.output_shaping_regime).toBeUndefined();
  });
});
