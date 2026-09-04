import { afterEach, describe, expect, it, vi } from "vitest";
import { ACTIVE_USAGE_METER_VERSION } from "../../src/core/usage/usage-event.js";
import { createServer, request, type RequestOptions, type Server } from "node:http";
import https from "node:https";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The GATEWAY-side overshoot guard, proven INDEPENDENTLY of the engine's own quota refusal.
 *
 * In the full e2e both layers hold, but the ENGINE refuses first, so the gateway's own pre-commit
 * check is never the deciding actor there — one layer masks the other. Here the engine seam is
 * stubbed to return a perfectly usable `apply` whose metered count exceeds the remaining allowance
 * (i.e. an engine that does NOT enforce the ceiling, i.e. exactly the pre-fix engine, or a future
 * engine build that regresses). The gateway must refuse the whole INPUT plan and journal nothing.
 *
 * The stub is also, deliberately, the shipped 0.6.5 engine on a subscription route: its `exceedsQuota`
 * returns false for every non-api-key route, so it answers the re-dispatched zero remainder with the
 * SAME input-compacted body. The gateway must not let that cost the user their output shaping — the
 * refusal is about the INPUT allowance, and shaping is the Open/base capability that allowance never
 * bought. So the forwarded body is shaped in-process, the user's own messages stay byte-exact, and
 * nothing is debited.
 */
const APPLY_DECISION_TOKENS = 5_000_000; // far above any allowance below

vi.mock("../../src/core/gateway/engine-ipc/engine-apply-seam.js", () => ({
  decideEngineApply: vi.fn(async (_supervisor: unknown, input: { request_body: string }) => ({
    decision: "apply" as const,
    // A real, changed, recoverable body — everything the gateway needs to proceed…
    mutatedRequestBody: JSON.stringify({ model: "claude-x", messages: [{ role: "user", content: "compacted" }] }),
    recoveryRequired: true as const,
    appliedComponents: ["deterministic-compaction"],
    meterVersion: ACTIVE_USAGE_METER_VERSION,
    // …except this request's metered input dwarfs the allowance. A non-enforcing engine.
    meteredOptimizedInputTokens: APPLY_DECISION_TOKENS,
    estimatedInputTokensBefore: APPLY_DECISION_TOKENS + 10,
    estimatedInputTokensAfter: 10,
    receiptArtifacts: {
      deterministic_plan: {
        policy: "deterministic-dedupe",
        shape: "anthropic-messages",
        supported: true,
        changed: true,
        removedBlocks: 1,
        charsBefore: input.request_body.length,
        charsAfter: 40,
        estTokensBefore: APPLY_DECISION_TOKENS,
        estTokensAfter: 10,
        reductionPercent: 99
      },
      optimization_plan: { selected: [], rejected: [] },
      applied_components: ["deterministic-compaction"],
      composed_input_estimate: { before: APPLY_DECISION_TOKENS, after: 10 },
      lcm_contributed: false,
      shape_gate_results: { "supported-shape": "pass", "change-produced": "pass" }
    }
  }))
}));

const { createGatewayServer } = await import("../../src/core/gateway/server.js");
const { savePolicyPreference, AUTO_APPLY_ELIGIBILITY_GATES } = await import("../../src/core/policy-preferences.js");
const { provisionValidLease } = await import("../helpers/lease-fixture.js");
const { readUsageJournal } = await import("../../src/core/usage/usage-journal.js");
const { OUTPUT_SHAPING_POLICY_MARKER } = await import("../../src/core/output-shaping.js");

const BIG = "Z".repeat(700);
const UPSTREAM_REPLY = JSON.stringify({ id: "msg_fake", usage: { input_tokens: 60, output_tokens: 4 } });
const DEDUPABLE = JSON.stringify({ model: "claude-x", messages: [{ role: "user", content: `${BIG}\n\ntail\n\n${BIG}` }] });

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
}
function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}
function post(port: number, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/v1/messages",
        headers: { "content-type": "application/json", authorization: "Bearer sk-fake", "content-length": String(Buffer.byteLength(body)) }
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

describe("gateway overshoot guard (engine stubbed to NOT enforce the ceiling)", () => {
  const servers: Server[] = [];
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map(close));
    dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
    vi.clearAllMocks();
  });

  async function setup(
    allowanceTokens: number,
    envOverrides: Record<string, string> = {}
  ): Promise<{ port: number; seen: string[]; logs: string[]; env: NodeJS.ProcessEnv }> {
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
    vi.spyOn(https, "request").mockImplementation(((options: RequestOptions, onResponse: (r: unknown) => void) =>
      request({ ...options, protocol: "http:", hostname: "127.0.0.1", port: upstreamPort }, onResponse as Parameters<typeof request>[1])) as typeof https.request);

    const cwd = mkdtempSync(join(tmpdir(), "overshoot-cwd-"));
    dirs.push(cwd);
    const leaseDir = mkdtempSync(join(tmpdir(), "overshoot-lease-"));
    dirs.push(leaseDir);
    const env = Object.assign(
      provisionValidLease(leaseDir, { allowance_tokens: allowanceTokens }) as NodeJS.ProcessEnv,
      envOverrides
    );

    const logs: string[] = [];
    const gateway = createGatewayServer({
      provider: "anthropic",
      upstream: "https://evil.invalid/ignored",
      mode: "record",
      workflow: "claude-code",
      optimizationMode: "cache-plus-context",
      cwd,
      entitlementEnv: env,
      log: (line) => logs.push(line)
    });
    servers.push(gateway);
    await savePolicyPreference(
      {
        scope: { tool: "claude-code", policy_type: "deterministic-dedupe" },
        preference: "auto-when-gates-pass",
        gates_required: [...AUTO_APPLY_ELIGIBILITY_GATES]
      },
      leaseDir // the DEVICE store, the only one the gateway reads
    );
    return { port: await listen(gateway), seen, logs, env };
  }

  it("refuses the WHOLE input plan when the engine's metered count exceeds the remaining allowance", async () => {
    const ctx = await setup(1000); // allowance far below the stubbed metered count
    const r = await post(ctx.port, DEDUPABLE);
    expect(r.status).toBe(200);
    expect(r.body).toBe(UPSTREAM_REPLY);
    // The gateway — not the engine — refused the INPUT plan: the engine's compacted body never went
    // upstream, the user's own message survives byte-exact, and nothing is journaled.
    expect(ctx.seen[0]).not.toContain("compacted");
    expect(JSON.parse(ctx.seen[0]).messages).toEqual(JSON.parse(DEDUPABLE).messages);
    expect((await readUsageJournal(ctx.env)).entries).toHaveLength(0);
    expect(ctx.logs.join("\n")).toContain("exceeds the remaining allowance");
  });

  it("keeps output shaping at the ceiling even though this engine ignores the zero remainder", async () => {
    // THE LEGACY-ENGINE CASE. The stub answers `dispatchEngine(0)` with the same input-compacted body,
    // which is what a pre-route-independent engine does on a subscription route. Without the in-process
    // fallback the turn would be forwarded bare and a Community user at their ceiling would sit BELOW
    // the Open baseline. It must be shaped instead — and still debited nothing.
    const ctx = await setup(1000);
    await post(ctx.port, DEDUPABLE);
    expect(ctx.seen[0]).toContain(OUTPUT_SHAPING_POLICY_MARKER);
    expect((await readUsageJournal(ctx.env)).entries).toHaveLength(0);
    expect(ctx.logs.join("\n")).toContain("applying the public baseline shaping instead");
  });

  it("keeps output shaping when the allowance is EXHAUSTED, not merely insufficient", async () => {
    // allowance 0 → the pre-dispatch exhausted branch dispatches with a zero remainder as the FIRST
    // call. Same legacy engine, same rule: no input apply, no debit, shaping survives.
    const ctx = await setup(0);
    await post(ctx.port, DEDUPABLE);
    expect(ctx.seen[0]).not.toContain("compacted");
    expect(ctx.seen[0]).toContain(OUTPUT_SHAPING_POLICY_MARKER);
    expect((await readUsageJournal(ctx.env)).entries).toHaveLength(0);
    expect(ctx.logs.join("\n")).toContain("allowance exhausted for this period");
  });

  it("honours the user's shaping off-switch instead of shaping at the ceiling", async () => {
    // `compaction stop` / the kill-switch is the user's own off-switch for output shaping, and it wins
    // over the fallback: at the ceiling with shaping switched off, the original is forwarded bare.
    const ctx = await setup(1000, { COMPACTION_SHAPING_HOOKS: "0" });
    await post(ctx.port, DEDUPABLE);
    expect(ctx.seen[0]).toBe(DEDUPABLE);
    expect((await readUsageJournal(ctx.env)).entries).toHaveLength(0);
    expect(ctx.logs.join("\n")).toContain("no output-shaping-only treatment available");
  });

  it("applies and meters the same request when the allowance comfortably covers it (guard is not a blanket refusal)", async () => {
    const ctx = await setup(APPLY_DECISION_TOKENS * 2);
    const r = await post(ctx.port, DEDUPABLE);
    expect(r.status).toBe(200);
    expect(ctx.seen[0]).not.toBe(DEDUPABLE); // the stubbed mutation WAS forwarded
    const { entries } = await readUsageJournal(ctx.env);
    expect(entries).toHaveLength(1);
    expect(entries[0].optimized_input_tokens).toBe(APPLY_DECISION_TOKENS);
  });
});
