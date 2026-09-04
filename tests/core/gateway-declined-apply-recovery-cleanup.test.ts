import { afterEach, describe, expect, it, vi } from "vitest";
import { ACTIVE_USAGE_METER_VERSION } from "../../src/core/usage/usage-event.js";
import { createServer, request, type RequestOptions, type Server } from "node:http";
import https from "node:https";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A DECLINED apply must not leave the retained original on disk.
 *
 * The apply path retains the byte-exact pre-mutation body BEFORE it commits the debit, because a
 * mutation must never be forwarded without a recoverable original. When the apply is then declined
 * — the metering commit refused for any reason — nothing is forwarded and nothing will ever publish
 * that record's id: the receipt, the activity record, and the usage entry that carry a
 * `recovery_id` are written only for an APPLIED mutation. The file left behind is therefore an
 * original request body that no surface can name, `compaction gateway recover` cannot reach, and no
 * normal path can clean up.
 *
 * Two ways to produce one, both covered here:
 *  - WITH contention: N applies race a small allowance; the losers are refused by the under-lock
 *    ceiling re-check, after each of them has already retained its original.
 *  - WITHOUT contention: a single apply whose journal append cannot take the lock (a lock held by
 *    another holder) is refused after retention just the same.
 *
 * The assertion is on the FILESYSTEM, not on a log line: exactly one record survives the first
 * scenario (the committed one, and its id is the one the journal entry references), and zero survive
 * the second. Against the pre-fix gateway the first leaves four and the second leaves one.
 */
const PER_APPLY_TOKENS = 80;
const ENGINE_ROUND_TRIP_MS = 20;

vi.mock("../../src/core/gateway/engine-ipc/engine-apply-seam.js", () => ({
  decideEngineApply: vi.fn(async (_supervisor: unknown, input: { request_body: string }) => {
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
const { GATEWAY_RECOVERY_DIR } = await import("../../src/core/gateway/recovery.js");
const { readUsageJournal, usageJournalLockPath } = await import("../../src/core/usage/usage-journal.js");
// The ONE accessor for a journal entry's recovery id. Read through it rather than off a field
// name: the id is named `recovery_id` from schema v2 and `receipt_id` on frozen v1 entries, and a
// direct read of the wrong key yields `undefined` instead of failing to compile.
const { recoveryIdOf } = await import("../../src/core/usage/usage-event.js");

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

/** Every retained-original file currently on disk, by recovery id. */
function recoveryIds(cwd: string): string[] {
  const dir = join(cwd, GATEWAY_RECOVERY_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""))
    .sort();
}

describe("a declined apply leaves no retained original behind", () => {
  const servers: Server[] = [];
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map(close));
    dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
    vi.clearAllMocks();
  });

  async function setup(allowanceTokens: number): Promise<{ port: number; cwd: string; seen: string[]; logs: string[]; env: NodeJS.ProcessEnv }> {
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

    const cwd = mkdtempSync(join(tmpdir(), "declined-apply-cwd-"));
    dirs.push(cwd);
    const leaseDir = mkdtempSync(join(tmpdir(), "declined-apply-lease-"));
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
    return { port: await listen(gateway), cwd, seen, logs, env };
  }

  it("keeps ONLY the committed request's record when 4 applies race an allowance that fits 1", async () => {
    const ctx = await setup(100); // 4 × 80 requested; exactly one fits
    const responses = await Promise.all([1, 2, 3, 4].map(() => post(ctx.port, DEDUPABLE)));
    responses.forEach((r) => expect(r.status).toBe(200)); // fail-open for the workflow, as before

    // Exactly one apply committed…
    const { entries } = await readUsageJournal(ctx.env);
    expect(entries).toHaveLength(1);
    expect(ctx.logs.join("\n")).toContain("allowance-ceiling-exceeded");
    // …and the other three forwarded their INPUT untouched. They are not bare originals: losing the
    // under-lock ceiling costs the INPUT plan, not output shaping, so each one is still shaped.
    const others = ctx.seen.filter(
      (body) => JSON.stringify(JSON.parse(body).messages) === JSON.stringify(JSON.parse(DEDUPABLE).messages)
    );
    expect(others).toHaveLength(3);

    // FOUR retained originals remain and every one of them is REFERENCED — one per applied turn. What
    // must not survive is the record each ceiling-declined apply retained for the input plan it then
    // lost: those three are discarded, and the shaping-only turn that replaced each of them retains
    // its own under the policy it actually applied. Seven files here would mean an orphan per decline.
    const remaining = recoveryIds(ctx.cwd);
    expect(remaining).toHaveLength(4);
    expect(remaining).toContain(recoveryIdOf(entries[0]).recoveryId);

    // Every survivor is genuinely the byte-exact original, and the policy each one names is the policy
    // that ran on its turn — one input apply, three shaping-only.
    const records = remaining.map((id) =>
      JSON.parse(readFileSync(join(ctx.cwd, GATEWAY_RECOVERY_DIR, `${id}.json`), "utf8"))
    );
    records.forEach((record) => expect(record.original_body).toBe(DEDUPABLE));
    expect(records.filter((r) => r.policy === "deterministic-dedupe")).toHaveLength(1);
    expect(records.filter((r) => r.policy === "open-basic-output-apply")).toHaveLength(3);
  });

  it("leaves nothing behind when a SINGLE apply is declined without contention (journal lock unavailable)", async () => {
    const ctx = await setup(10_000); // allowance is ample — the ceiling is not what declines this one
    // Hold the journal lock the way a second process would. The append refuses (fail-closed), so the
    // apply is declined AFTER its original was retained — an orphan with no race involved.
    const lockPath = usageJournalLockPath(ctx.env);
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString() }), { flag: "wx" });

    const response = await post(ctx.port, DEDUPABLE);
    expect(response.status).toBe(200);
    expect(ctx.seen).toEqual([DEDUPABLE]); // the original was forwarded unchanged
    expect((await readUsageJournal(ctx.env)).entries).toHaveLength(0); // nothing debited
    expect(ctx.logs.join("\n")).toContain("metering did not commit");
    expect(recoveryIds(ctx.cwd)).toEqual([]); // …and nothing retained
  }, 20_000); // the lock wait is bounded at 5s by design; the request completes after it gives up

  it("still retains the original for an apply that DOES commit (the cleanup never touches a live record)", async () => {
    const ctx = await setup(10_000);
    const response = await post(ctx.port, DEDUPABLE);
    expect(response.status).toBe(200);
    expect(ctx.seen[0]).not.toBe(DEDUPABLE); // the mutation was forwarded

    const { entries } = await readUsageJournal(ctx.env);
    expect(entries).toHaveLength(1);
    const remaining = recoveryIds(ctx.cwd);
    const { recoveryId, provenance } = recoveryIdOf(entries[0]);
    expect(remaining).toEqual([recoveryId]);
    // The debit names that record under the CURRENT key. A regression that wrote the legacy key
    // would still resolve through the accessor above, so it is pinned here on the real end-to-end
    // write rather than inferred from the unit-level serializer test.
    expect(provenance).toBe("recovery-id-field");
    const record = JSON.parse(readFileSync(join(ctx.cwd, GATEWAY_RECOVERY_DIR, `${remaining[0]}.json`), "utf8"));
    expect(record.original_body).toBe(DEDUPABLE);
  });
});
