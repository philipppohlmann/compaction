import { afterEach, describe, expect, it, vi } from "vitest";
import { ACTIVE_USAGE_METER_VERSION } from "../../src/core/usage/usage-event.js";
import { createServer, request, type RequestOptions, type Server } from "node:http";
import https from "node:https";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * CONCURRENT applies must not overshoot the period allowance ceiling.
 *
 * The single-request guard (`gateway-overshoot-guard.test.ts`) proves ONE oversized apply is
 * refused. It cannot prove this: each of N overlapping applies can individually fit the remainder
 * the gateway observed BEFORE dispatching to the engine, yet their committed sum can exceed the
 * allowance. Serializing only the journal APPEND does not fix that — it makes the writes linear
 * while every writer still decides on the same stale remainder. The allowance DECISION has to be
 * inside the same lock as the debit.
 *
 * Every other metering test awaits its applies one after another, which is structurally why this
 * class of defect survived review: sequential applies can never observe each other's staleness.
 * These tests dispatch concurrently on purpose, and the engine seam is stubbed with a deliberate
 * round-trip delay so all N requests are guaranteed to be past their pre-dispatch snapshot before
 * any of them commits. Against the pre-fix gateway all N commit; the committed total is N × the
 * per-apply count regardless of the ceiling.
 */
const PER_APPLY_TOKENS = 80;
const ENGINE_ROUND_TRIP_MS = 20;

vi.mock("../../src/core/gateway/engine-ipc/engine-apply-seam.js", () => ({
  decideEngineApply: vi.fn(async (_supervisor: unknown, input: { request_body: string }) => {
    // A real engine round-trip: every concurrent request reaches this await before any of them
    // returns, so all of them hold the SAME pre-dispatch remaining-allowance snapshot.
    await new Promise((resolve) => setTimeout(resolve, ENGINE_ROUND_TRIP_MS));
    return {
      decision: "apply" as const,
      mutatedRequestBody: JSON.stringify({ model: "claude-x", messages: [{ role: "user", content: "compacted" }] }),
      recoveryRequired: true as const,
      appliedComponents: ["deterministic-compaction"],
      meterVersion: ACTIVE_USAGE_METER_VERSION,
      meteredOptimizedInputTokens: PER_APPLY_TOKENS,
      estimatedInputTokensBefore: PER_APPLY_TOKENS + 10,
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
          estTokensBefore: PER_APPLY_TOKENS,
          estTokensAfter: 10,
          reductionPercent: 87
        },
        optimization_plan: { selected: [], rejected: [] },
        applied_components: ["deterministic-compaction"],
        composed_input_estimate: { before: PER_APPLY_TOKENS, after: 10 },
        lcm_contributed: false,
        shape_gate_results: { "supported-shape": "pass", "change-produced": "pass" }
      }
    };
  })
}));

const { createGatewayServer } = await import("../../src/core/gateway/server.js");
const { savePolicyPreference, AUTO_APPLY_ELIGIBILITY_GATES } = await import("../../src/core/policy-preferences.js");
const { provisionValidLease } = await import("../helpers/lease-fixture.js");
const { readUsageJournal, sumOptimizedInputTokensForPeriod, verifyUsageChain } = await import(
  "../../src/core/usage/usage-journal.js"
);
const { currentPeriodId } = await import("../../src/core/entitlement/lease.js");

const BIG = "Z".repeat(700);
const UPSTREAM_REPLY = JSON.stringify({ id: "msg_fake", usage: { input_tokens: 60, output_tokens: 4 } });
const DEDUPABLE = JSON.stringify({ model: "claude-x", messages: [{ role: "user", content: `${BIG}\n\ntail\n\n${BIG}` }] });

/**
 * Did this forwarded body keep its INPUT byte-exact? A turn refused for want of input allowance is
 * still SHAPED in-process (output shaping is the base capability the allowance never bought), so it
 * is no longer byte-identical to the request — the shaping block is appended outside `messages`.
 * What the ceiling guarantees is that no INPUT compaction was forwarded, and that is what this tests.
 */
const inputUnchanged = (body: string): boolean =>
  JSON.stringify(JSON.parse(body).messages) === JSON.stringify(JSON.parse(DEDUPABLE).messages);

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
        headers: {
          "content-type": "application/json",
          authorization: "Bearer sk-fake",
          "content-length": String(Buffer.byteLength(body))
        }
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

describe("concurrent metered applies cannot exceed the period allowance", () => {
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
      request(
        { ...options, protocol: "http:", hostname: "127.0.0.1", port: upstreamPort },
        onResponse as Parameters<typeof request>[1]
      )) as typeof https.request);

    const cwd = mkdtempSync(join(tmpdir(), "concurrent-overshoot-cwd-"));
    dirs.push(cwd);
    const leaseDir = mkdtempSync(join(tmpdir(), "concurrent-overshoot-lease-"));
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
      leaseDir // the DEVICE store, the only one the gateway reads
    );
    return { port: await listen(gateway), seen, logs, env };
  }

  it("commits at most the allowance when 4 applies race an allowance that fits only 1, and declines the rest", async () => {
    // 4 × 80 = 320 requested against a 100-token allowance: exactly ONE fits.
    const ctx = await setup(100);
    const responses = await Promise.all([1, 2, 3, 4].map(() => post(ctx.port, DEDUPABLE)));

    // FAIL-OPEN FOR THE WORKFLOW: every request still succeeds and gets the upstream reply.
    responses.forEach((r) => {
      expect(r.status).toBe(200);
      expect(r.body).toBe(UPSTREAM_REPLY);
    });

    const { entries, skipped } = await readUsageJournal(ctx.env);
    const committed = sumOptimizedInputTokensForPeriod(entries, currentPeriodId());

    // THE CEILING GUARANTEE: the committed total never passes the allowance.
    expect(committed).toBeLessThanOrEqual(100);
    expect(entries).toHaveLength(1);
    expect(committed).toBe(PER_APPLY_TOKENS);

    // The excess applies DECLINED — their INPUT went upstream untouched, they did not partially meter.
    expect(ctx.seen.filter(inputUnchanged)).toHaveLength(3);
    expect(ctx.seen.filter((body) => !inputUnchanged(body))).toHaveLength(1);
    expect(ctx.logs.join("\n")).toContain("allowance-ceiling-exceeded");

    // The journal is still a clean, strictly LINEAR chain (the chain guarantee is not traded away).
    expect(skipped).toHaveLength(0);
    expect(verifyUsageChain(entries).valid).toBe(true);
  });

  it("is not a blanket refusal under contention: 4 racing applies all commit when the allowance covers them", async () => {
    // 4 × 80 = 320 against a 1000-token allowance: nothing should be declined.
    const ctx = await setup(1000);
    const responses = await Promise.all([1, 2, 3, 4].map(() => post(ctx.port, DEDUPABLE)));
    responses.forEach((r) => expect(r.status).toBe(200));

    const { entries, skipped } = await readUsageJournal(ctx.env);
    expect(entries).toHaveLength(4);
    expect(sumOptimizedInputTokensForPeriod(entries, currentPeriodId())).toBe(4 * PER_APPLY_TOKENS);
    expect(ctx.seen.filter(inputUnchanged)).toHaveLength(0); // every one was applied
    expect(ctx.logs.join("\n")).not.toContain("allowance-ceiling-exceeded");
    expect(skipped).toHaveLength(0);
    expect(verifyUsageChain(entries).valid).toBe(true);
  });

  it("honours the exact-allowance boundary under contention (a request that exactly fits is committed)", async () => {
    // 160 covers exactly TWO 80-token applies and no more — the boundary is `>`, not `>=`.
    const ctx = await setup(160);
    const responses = await Promise.all([1, 2, 3, 4].map(() => post(ctx.port, DEDUPABLE)));
    responses.forEach((r) => expect(r.status).toBe(200));

    const { entries } = await readUsageJournal(ctx.env);
    expect(sumOptimizedInputTokensForPeriod(entries, currentPeriodId())).toBe(160);
    expect(entries).toHaveLength(2);
    expect(ctx.seen.filter(inputUnchanged)).toHaveLength(2);
    expect(verifyUsageChain(entries).valid).toBe(true);
  });
});
