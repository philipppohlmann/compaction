import { afterEach, describe, expect, it, vi } from "vitest";
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
 * engine build that regresses). The gateway must still refuse the WHOLE request, forward the
 * original unchanged, and journal nothing.
 */
const APPLY_DECISION_TOKENS = 5_000_000; // far above any allowance below

vi.mock("../../src/core/gateway/engine-ipc/engine-apply-seam.js", () => ({
  decideEngineApply: vi.fn(async (_supervisor: unknown, input: { request_body: string }) => ({
    decision: "apply" as const,
    // A real, changed, recoverable body — everything the gateway needs to proceed…
    mutatedRequestBody: JSON.stringify({ model: "claude-x", messages: [{ role: "user", content: "compacted" }] }),
    recoveryRequired: true as const,
    appliedComponents: ["deterministic-compaction"],
    meterVersion: "optimized-input-v1",
    // …except this request's metered input dwarfs the allowance. A non-enforcing engine.
    meteredOptimizedInputTokens: APPLY_DECISION_TOKENS,
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

  async function setup(allowanceTokens: number): Promise<{ port: number; seen: string[]; logs: string[]; env: NodeJS.ProcessEnv }> {
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
    const env = provisionValidLease(leaseDir, { allowance_tokens: allowanceTokens }) as NodeJS.ProcessEnv;

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
      join(cwd, ".compaction")
    );
    return { port: await listen(gateway), seen, logs, env };
  }

  it("refuses the WHOLE request when the engine's metered count exceeds the remaining allowance", async () => {
    const ctx = await setup(1000); // allowance far below the stubbed metered count
    const r = await post(ctx.port, DEDUPABLE);
    expect(r.status).toBe(200);
    expect(r.body).toBe(UPSTREAM_REPLY);
    // The gateway — not the engine — refused: the original is forwarded, nothing is journaled.
    expect(ctx.seen[0]).toBe(DEDUPABLE);
    expect((await readUsageJournal(ctx.env)).entries).toHaveLength(0);
    expect(ctx.logs.join("\n")).toContain("exceeds the remaining allowance");
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
