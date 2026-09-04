import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, request, type RequestOptions, type Server } from "node:http";
import https from "node:https";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * OUTPUT SHAPING SURVIVES AN ENGINE THAT REFUSES AT THE EXHAUSTED ALLOWANCE.
 *
 * The sibling overshoot tests stub an engine that always APPLIES — the pre-route-independent build,
 * which hands back an input-compacted body however small a remainder it is sent. This file stubs the
 * other failure the ceiling can meet: an engine that answers the zero remainder with a REFUSAL rather
 * than an output-shaping-only plan. Nothing in the IPC contract forbids it, no version handshake
 * exists to detect it, and the outcome for the user is the same one the allowance rules forbid — a
 * Community user at their ceiling forwarded bare, i.e. BELOW the Open baseline that never cost them
 * any allowance.
 *
 * The binding rule is that exhaustion pauses INPUT optimization and nothing else: no input apply,
 * zero debit, output shaping continues. So the gateway shapes in-process instead of depending on the
 * engine for the degraded treatment.
 */
vi.mock("../../src/core/gateway/engine-ipc/engine-apply-seam.js", () => ({
  decideEngineApply: vi.fn(async () => ({
    decision: "forward-original" as const,
    reason: "engine-result:quota_exceeded"
  }))
}));

const { createGatewayServer } = await import("../../src/core/gateway/server.js");
const { savePolicyPreference, AUTO_APPLY_ELIGIBILITY_GATES } = await import("../../src/core/policy-preferences.js");
const { provisionValidLease } = await import("../helpers/lease-fixture.js");
const { readUsageJournal } = await import("../../src/core/usage/usage-journal.js");
const { OUTPUT_SHAPING_POLICY_MARKER } = await import("../../src/core/output-shaping.js");
const { readActivityEvents, DEFAULT_ACTIVITY_DIRECTORY } = await import("../../src/core/activity-store.js");

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

describe("output shaping survives an engine that refuses at the allowance ceiling", () => {
  const servers: Server[] = [];
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map(close));
    dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
    vi.clearAllMocks();
  });

  async function setup(
    allowanceTokens: number
  ): Promise<{ port: number; seen: string[]; logs: string[]; env: NodeJS.ProcessEnv; cwd: string; drain: () => Promise<void> }> {
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

    const cwd = mkdtempSync(join(tmpdir(), "refusing-engine-cwd-"));
    dirs.push(cwd);
    const leaseDir = mkdtempSync(join(tmpdir(), "refusing-engine-lease-"));
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
    return {
      port: await listen(gateway),
      seen,
      logs,
      env,
      cwd,
      // `close()` is what drains the detached bookkeeping writes, so an activity assertion has to run
      // after it rather than racing the fire-and-forget append.
      drain: async () => {
        await close(gateway);
        servers.splice(servers.indexOf(gateway), 1);
      }
    };
  }

  it("shapes in-process when the allowance is exhausted and the engine refuses", async () => {
    const ctx = await setup(0);
    const r = await post(ctx.port, DEDUPABLE);
    expect(r.status).toBe(200);
    expect(r.body).toBe(UPSTREAM_REPLY);
    expect(ctx.seen[0]).toContain(OUTPUT_SHAPING_POLICY_MARKER);
    // INPUT is untouched and nothing is debited: the pause is an input ceiling, not an off switch.
    expect(JSON.parse(ctx.seen[0]).messages).toEqual(JSON.parse(DEDUPABLE).messages);
    expect((await readUsageJournal(ctx.env)).entries).toHaveLength(0);
    expect(ctx.logs.join("\n")).toContain("the engine refused at the exhausted allowance");
  });

  it("records the shaping-only fallback in the activity store, with its recover and disable commands", async () => {
    // The activity record is the ONLY surface carrying the recovery id and the disable command for an
    // automatic application. The bookkeeping guard used to require an input plan, and this fallback has
    // none — so exactly the turns that retained an original were the ones the user could not find.
    const ctx = await setup(0);
    await post(ctx.port, DEDUPABLE);
    await ctx.drain();

    const { events } = await readActivityEvents(join(ctx.cwd, DEFAULT_ACTIVITY_DIRECTORY));
    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event.approval_status).toBe("auto-applied-by-policy");
    expect(event.recovery).toEqual({ original_retained: true, location: expect.stringContaining(".json") });
    expect(event.caveats.some((c) => c.startsWith("recover the exact original: compaction gateway recover "))).toBe(true);
    expect(event.caveats.some((c) => c.startsWith("disable future automatic application: compaction policies disable "))).toBe(true);
    // NO INPUT CLAIM. No input component ran, so the record states that rather than reporting a
    // zero-removal deterministic plan (which would read as "it ran and found nothing").
    expect(event.input_before).toBeUndefined();
    expect(event.input_after).toBeUndefined();
    expect(event.caveats).toContain("no input component ran on this request; the input was forwarded unchanged");
    expect(event.caveats.some((c) => c.includes("deterministic input component"))).toBe(false);
    expect(event.evidence_level).toContain("no input component ran, so no input delta is claimed");
  });

  it("does NOT shape on an engine refusal with allowance to spare (fail-open stays fail-open)", async () => {
    // The fallback is bound to the allowance ceiling. A healthy turn that the engine simply declined
    // (engine down, unsupported shape, no candidate) must still forward the original byte-for-byte —
    // this path is not a licence to shape whenever the engine says no.
    const ctx = await setup(1_000_000);
    await post(ctx.port, DEDUPABLE);
    expect(ctx.seen[0]).toBe(DEDUPABLE);
    expect((await readUsageJournal(ctx.env)).entries).toHaveLength(0);
    expect(ctx.logs.join("\n")).toContain("did not apply - engine-result:quota_exceeded");
  });
});
