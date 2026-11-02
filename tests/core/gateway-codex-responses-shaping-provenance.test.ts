import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, request, type RequestOptions, type Server } from "node:http";
import https from "node:https";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACTIVE_USAGE_METER_VERSION } from "../../src/core/usage/usage-event.js";

/**
 * CODEX RECEIPT PROVENANCE: a hook-shaped Codex turn must record `already-active`.
 *
 * Measured in the 0.6.11 release benchmark (ON-1): Codex's `UserPromptSubmit` hook put the policy on
 * every request as a `developer` item in the Responses `input[]`, the gateway rightly attached no
 * duplicate, and every receipt still said the policy was not there — 16 record receipts left it unset
 * and the 5 the engine evaluated said `absent`. Two causes, both covered:
 *  - the carrier predicate never read `input[]` (record path);
 *  - the installed engine bundles its own copy of that predicate, so an engine built before the fix
 *    keeps answering `absent`, and that answer used to win (stored path, declined AND applied).
 *
 * The engine is replaced at its seam with one that answers `absent` the way engine 0.6.18 does. The
 * assertions are on the bytes the upstream received and on the receipt the gateway emitted.
 */
type EngineInput = { request_body: string; output_shaping_enabled?: boolean };
const engine = vi.hoisted(() => ({ next: null as null | ((body: string, input: EngineInput) => unknown), inputs: [] as EngineInput[] }));
vi.mock("../../src/core/gateway/engine-ipc/engine-apply-seam.js", () => ({
  decideEngineApply: vi.fn(async (_supervisor: unknown, input: EngineInput) => {
    engine.inputs.push(input);
    return engine.next?.(input.request_body, input);
  })
}));

const { createGatewayServer } = await import("../../src/core/gateway/server.js");
const { buildHookOutputShapingTreatment } = await import("../../src/core/output-shaping.js");
const { savePolicyPreference, AUTO_APPLY_ELIGIBILITY_GATES } = await import("../../src/core/policy-preferences.js");
const { provisionValidLease } = await import("../helpers/lease-fixture.js");
type GatewayReceipt = import("../../src/core/gateway/receipt.js").GatewayReceipt;

const CAP = "S".repeat(43);
const HOOK = buildHookOutputShapingTreatment();
/** The policy as it appears inside a JSON body (newlines escaped), for counting occurrences. */
const HOOK_JSON = JSON.stringify(HOOK.instructions).slice(1, -1);
const UPSTREAM_REPLY = JSON.stringify({ id: "resp_fake", usage: { input_tokens: 60, output_tokens: 4 } });
const BIG = "Z".repeat(700);

/** The Codex request shape from the benchmark rollout: hook context as a developer `input[]` item. */
function codexBody(opts: { hook: boolean }): string {
  const input: unknown[] = [{ type: "message", role: "user", content: [{ type: "input_text", text: `implement help groups ${BIG}` }] }];
  if (opts.hook) input.push({ type: "message", role: "developer", content: [{ type: "input_text", text: HOOK.instructions }] });
  return JSON.stringify({ model: "gpt-6-astra", instructions: "You are Codex.", input, stream: false });
}

/** What engine 0.6.18 answers on a turn it evaluates but does not change. */
function staleDecline() {
  return {
    decision: "forward-original" as const,
    reason: "engine-result:no-change",
    lcmOutcome: { kind: "unavailable", reason: "no-obsolete-history" },
    outputShapingState: "absent" as const
  };
}

/** An engine apply whose content-free artifacts say `absent` while its mutated body keeps the hook item. */
function staleApply(body: string) {
  const parsed = JSON.parse(body) as { input: Array<Record<string, unknown>> };
  parsed.input[0] = { type: "message", role: "user", content: [{ type: "input_text", text: "implement help groups" }] };
  return {
    decision: "apply" as const,
    mutatedRequestBody: JSON.stringify(parsed),
    recoveryRequired: true as const,
    appliedComponents: ["deterministic-compaction"],
    meterVersion: ACTIVE_USAGE_METER_VERSION,
    meteredOptimizedInputTokens: 150,
    estimatedInputTokensBefore: 200,
    estimatedInputTokensAfter: 50,
    receiptArtifacts: {
      deterministic_plan: { policy: "deterministic-dedupe", shape: "openai-responses", supported: true, changed: true, removedBlocks: 1,
        charsBefore: body.length, charsAfter: 100, estTokensBefore: 200, estTokensAfter: 50, reductionPercent: 75 },
      optimization_plan: { selected: [], rejected: [] },
      applied_components: ["deterministic-compaction"],
      composed_input_estimate: { before: 200, after: 50 },
      lcm_contributed: false,
      output_shaping_state: "absent",
      shape_gate_results: { "supported-shape": "pass", "change-produced": "pass" }
    }
  };
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
}
function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe("Codex Responses receipt provenance", () => {
  const servers: Server[] = [];
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map(close));
    dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
    engine.next = null;
    engine.inputs = [];
    vi.restoreAllMocks();
  });

  async function run(body: string, opts: { stored: boolean; allowanceTokens?: number }): Promise<{ seen: string[]; receipt: GatewayReceipt }> {
    const seen: string[] = [];
    const upstream = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        seen.push(Buffer.concat(chunks).toString("utf8"));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(UPSTREAM_REPLY);
      });
    });
    servers.push(upstream);
    const upstreamPort = await listen(upstream);
    vi.spyOn(https, "request").mockImplementation(((options: RequestOptions, cb: (response: unknown) => void) =>
      request({ ...options, protocol: "http:", hostname: "127.0.0.1", port: upstreamPort }, cb as Parameters<typeof request>[1])) as typeof https.request);

    const cwd = mkdtempSync(join(tmpdir(), "codex-prov-cwd-"));
    const deviceDir = mkdtempSync(join(tmpdir(), "codex-prov-device-"));
    dirs.push(cwd, deviceDir);
    const entitlementEnv = provisionValidLease(deviceDir, opts.allowanceTokens !== undefined ? { allowance_tokens: opts.allowanceTokens } : {}, { productMode: "full" });
    if (opts.stored) {
      const saved = await savePolicyPreference({
        scope: { tool: "codex", policy_type: "deterministic-dedupe" },
        preference: "auto-when-gates-pass",
        gates_required: [...AUTO_APPLY_ELIGIBILITY_GATES]
      }, deviceDir);
      expect(saved.saved).toBe(true);
    }
    const receipts: GatewayReceipt[] = [];
    const gateway = createGatewayServer({
      provider: "openai",
      upstream: "https://evil.invalid/ignored",
      mode: "record",
      workflow: "codex",
      optimizationMode: "cache-plus-context",
      cwd,
      entitlementEnv,
      codexSubscription: { capability: CAP },
      onReceipt: (receipt) => receipts.push(receipt),
      log: () => {}
    });
    servers.push(gateway);
    const port = await listen(gateway);

    const status = await new Promise<number>((resolve, reject) => {
      const req = request({
        host: "127.0.0.1", port, method: "POST",
        path: `/__compaction/codex/${CAP}/backend-api/codex/responses`,
        headers: { "content-type": "application/json", authorization: "Bearer fake-codex-login", "content-length": String(Buffer.byteLength(body)) }
      }, (res) => { res.on("data", () => {}); res.on("end", () => resolve(res.statusCode ?? 0)); });
      req.on("error", reject);
      req.end(body);
    });
    expect(status).toBe(200);
    for (let i = 0; i < 200 && receipts.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 25));
    expect(receipts).toHaveLength(1);
    return { seen, receipt: receipts[0] as GatewayReceipt };
  }

  it("record route: a hook-shaped Codex turn records already-active, bytes unchanged, no duplicate", async () => {
    const body = codexBody({ hook: true });
    const { seen, receipt } = await run(body, { stored: false });
    expect(seen).toEqual([body]);
    expect(seen[0].split(HOOK_JSON)).toHaveLength(2);
    expect(receipt.mode).toBe("record");
    expect(receipt.output_shaping_state).toBe("already-active");
    expect(receipt.output_shaping_policy_version).toBe(HOOK.policyVersion);
  });

  it("record route: an unshaped Codex turn claims nothing", async () => {
    const { receipt } = await run(codexBody({ hook: false }), { stored: false });
    expect(receipt.output_shaping_state).toBeUndefined();
    expect(receipt.output_shaping_policy_version).toBeUndefined();
  });

  it("stored route, engine declines with a stale absent: the receipt records already-active", async () => {
    engine.next = staleDecline;
    const body = codexBody({ hook: true });
    const { seen, receipt } = await run(body, { stored: true });
    expect(seen).toEqual([body]);
    expect(receipt.mode).toBe("record");
    expect(receipt.lcm_outcome).toEqual({ kind: "unavailable", reason: "no-obsolete-history" });
    expect(receipt.output_shaping_state).toBe("already-active");
    expect(receipt.output_shaping_policy_version).toBe(HOOK.policyVersion);
  });

  it("stored route, engine declines with absent and the turn is unshaped: absent stands", async () => {
    engine.next = staleDecline;
    const { receipt } = await run(codexBody({ hook: false }), { stored: true });
    expect(receipt.output_shaping_state).toBe("absent");
    expect(receipt.output_shaping_policy_version).toBeUndefined();
  });

  it("stored route, engine applies with a stale absent: the forwarded body's hook item is credited", async () => {
    engine.next = staleApply;
    const body = codexBody({ hook: true });
    const { seen, receipt } = await run(body, { stored: true });
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toBe(body);
    expect(seen[0].split(HOOK_JSON)).toHaveLength(2);
    expect(receipt.mode).toBe("apply");
    expect(receipt.output_shaping_state).toBe("already-active");
    expect(receipt.output_shaping_policy_version).toBe(HOOK.policyVersion);
  });

  // NO SECOND COPY ON APPLY. Measured by replaying the 0.6.11 rc2 ON-1 rollout against the installed
  // engine 0.6.18: with input compaction applied, the forwarded body carried the policy twice, because
  // the engine shapes whenever it is asked to and its own predicate misses the `input[]` carrier.
  it("stored route, input compaction applies on a hook-shaped turn: the engine is not asked to shape, one copy forwarded", async () => {
    engine.next = engine0618Apply;
    const { seen, receipt } = await run(codexBody({ hook: true }), { stored: true });
    expect(engine.inputs.map((input) => input.output_shaping_enabled)).toEqual([false]);
    expect(policyCopies(seen[0])).toBe(1);
    expect(receipt.mode).toBe("apply");
    expect(receipt.applied_components).toEqual(["lcm-compaction"]);
    expect(receipt.output_shaping_state).toBe("already-active");
    expect(receipt.output_shaping_policy_version).toBe(HOOK.policyVersion);
  });

  it("stored route, unshaped turn: the engine is still asked to shape and attaches the policy once", async () => {
    engine.next = engine0618Apply;
    const { seen, receipt } = await run(codexBody({ hook: false }), { stored: true });
    expect(engine.inputs.map((input) => input.output_shaping_enabled)).toEqual([true]);
    expect(policyCopies(seen[0])).toBe(1);
    expect(receipt.applied_components).toEqual(["lcm-compaction", "output-shaping"]);
    expect(receipt.output_shaping_state).toBe("attached-this-pass");
  });

  it("stored route, the policy only in an earlier turn or in tool output: the engine may still shape this turn", async () => {
    const earlierTurn = JSON.stringify({
      model: "gpt-6-astra",
      instructions: "You are Codex.",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "first task" }] },
        { type: "message", role: "developer", content: [{ type: "input_text", text: HOOK.instructions }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: `now plan the next step ${BIG}` }] }
      ],
      stream: false
    });
    const inToolOutput = JSON.stringify({
      model: "gpt-6-astra",
      instructions: "You are Codex.",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: `implement help groups ${BIG}` }] },
        { type: "function_call_output", call_id: "c1", output: HOOK.instructions }
      ],
      stream: false
    });
    engine.next = staleDecline;
    await run(earlierTurn, { stored: true });
    await run(inToolOutput, { stored: true });
    expect(engine.inputs.map((input) => input.output_shaping_enabled)).toEqual([true, true]);
  });

  // The rc2 benchmark: engine 0.6.18 refused every warm request at a 90-token remainder with
  // `quota-exhausted`, and the receipt read exactly like one the engine never saw.
  it("stored route, the engine declines without an LCM outcome: the receipt records the decline class", async () => {
    const declines = [
      { decision: "forward-original" as const, reason: "engine-result:refused", refusal: "quota-exhausted" as const },
      { decision: "forward-original" as const, reason: "engine-degraded:timeout" }
    ];
    const outcomes = [];
    for (const decline of declines) {
      engine.next = () => decline;
      const { seen, receipt } = await run(codexBody({ hook: true }), { stored: true });
      expect(seen).toEqual([codexBody({ hook: true })]);
      expect(receipt.mode).toBe("record");
      expect(receipt.output_shaping_state).toBe("already-active");
      outcomes.push(receipt.lcm_outcome);
    }
    expect(outcomes).toEqual([
      { kind: "rejected", reason: "allowance-insufficient" },
      { kind: "not-attempted", reason: "engine-unavailable" }
    ]);
  });

  // Before the no-duplicate change, a hook-shaped turn at the ceiling got the shaping-only fallback,
  // which carried the pause (with a second policy copy). With the policy already on the turn there is
  // nothing to fall back to, and the pause must still reach the receipt.
  it("stored route, hook-shaped turn refused at the allowance: the record receipt carries the pause", async () => {
    engine.next = () => ({ decision: "forward-original" as const, reason: "engine-result:refused", refusal: "quota-exhausted" as const });
    const { seen, receipt } = await run(codexBody({ hook: true }), { stored: true });
    expect(policyCopies(seen[0])).toBe(1);
    expect(receipt.mode).toBe("record");
    expect(receipt.lcm_outcome).toEqual({ kind: "rejected", reason: "allowance-insufficient" });
    expect(receipt.allowance_pause?.reason).toBe("insufficient");
  });

  it("stored route, hook-shaped turn whose reduction overshoots the remainder: declined with the pause, nothing attached", async () => {
    // First dispatch compacts input past the 100-token remainder; the zero-remainder re-dispatch has
    // nothing to shape (the policy is already on the turn) and no-ops.
    engine.next = (body: string, input: EngineInput & { quota?: { locally_allocated_tokens_remaining: number } }) =>
      input.quota?.locally_allocated_tokens_remaining === 0
        ? { decision: "forward-original" as const, reason: "engine-result:noop", outputShapingState: "absent" as const }
        : { ...engine0618Apply(body, input), meteredOptimizedInputTokens: 150 };
    const { seen, receipt } = await run(codexBody({ hook: true }), { stored: true, allowanceTokens: 100 });
    expect(engine.inputs.map((input) => input.output_shaping_enabled)).toEqual([false, false]);
    expect(seen).toEqual([codexBody({ hook: true })]);
    expect(receipt.mode).toBe("record");
    expect(receipt.lcm_outcome).toEqual({ kind: "rejected", reason: "allowance-insufficient" });
    expect(receipt.allowance_pause?.reason).toBe("insufficient");
    expect(receipt.output_shaping_state).toBe("already-active");
  });
});

/** One distinctive policy line, counted in the forwarded bytes whichever carrier holds it. */
const POLICY_LINE = JSON.stringify(HOOK.instructions.split("\n")[1]).slice(1, -1);
function policyCopies(body: string | undefined): number {
  return (body ?? "").split(POLICY_LINE).length - 1;
}

/**
 * Engine 0.6.18's applied answer, as the replay measured it: LCM shortens the history, and when asked
 * to shape it attaches the policy without seeing the copy already in `input[]`.
 */
function engine0618Apply(body: string, input: EngineInput) {
  const parsed = JSON.parse(body) as { instructions: string; input: Array<Record<string, unknown>> };
  parsed.input[0] = { type: "message", role: "user", content: [{ type: "input_text", text: "implement help groups" }] };
  const shaped = input.output_shaping_enabled === true;
  if (shaped) parsed.instructions = `${parsed.instructions}\n\n${HOOK.instructions}`;
  const components = shaped ? ["lcm-compaction", "output-shaping"] : ["lcm-compaction"];
  return {
    decision: "apply" as const,
    mutatedRequestBody: JSON.stringify(parsed),
    recoveryRequired: true as const,
    appliedComponents: components,
    meterVersion: ACTIVE_USAGE_METER_VERSION,
    meteredOptimizedInputTokens: 150,
    estimatedInputTokensBefore: 200,
    estimatedInputTokensAfter: 50,
    ...(shaped ? { outputShapingState: "attached-this-pass" as const, outputShapingPolicyVersion: HOOK.policyVersion } : {}),
    receiptArtifacts: {
      deterministic_plan: { policy: "deterministic-dedupe", shape: "openai-responses", supported: true, changed: false, removedBlocks: 0,
        charsBefore: body.length, charsAfter: body.length, estTokensBefore: 200, estTokensAfter: 50, reductionPercent: 0 },
      optimization_plan: { selected: [], rejected: [] },
      applied_components: components,
      composed_input_estimate: { before: 200, after: 50 },
      lcm_contributed: true,
      output_shaping_state: shaped ? "attached-this-pass" : "absent",
      ...(shaped ? { output_shaping_policy_version: HOOK.policyVersion } : {}),
      shape_gate_results: { "supported-shape": "pass", "change-produced": "pass" }
    }
  };
}
