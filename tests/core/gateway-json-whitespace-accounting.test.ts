import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, request, type RequestOptions, type Server } from "node:http";
import https from "node:https";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACTIVE_USAGE_METER_VERSION } from "../../src/core/usage/usage-event.js";

const ORIGINAL = JSON.stringify({
  model: "claude-test",
  messages: [
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tool-1", content: `{${" ".repeat(80)}\"x\": [ 1, 2 ] }` }]
    }
  ]
});
const MUTATED = ORIGINAL.replace(`${" ".repeat(80)}\\\"x\\\": [ 1, 2 ] `, "\\\"x\\\":[1,2]");
const METERED = 23;

vi.mock("../../src/core/gateway/engine-ipc/engine-apply-seam.js", () => ({
  decideEngineApply: vi.fn(async (_supervisor: unknown, input: {
    request_body: string;
    quota: { locally_allocated_tokens_remaining: number };
  }) => {
    if (input.quota.locally_allocated_tokens_remaining < METERED) {
      return { decision: "forward-original" as const, reason: "engine-result:refused" };
    }
    return {
      decision: "apply" as const,
      mutatedRequestBody: MUTATED,
      recoveryRequired: true as const,
      appliedComponents: ["json-whitespace-compaction"],
      meterVersion: ACTIVE_USAGE_METER_VERSION,
      meteredOptimizedInputTokens: METERED,
      estimatedInputTokensBefore: 100,
      estimatedInputTokensAfter: 77,
      receiptArtifacts: {
        deterministic_plan: {
          policy: "deterministic-dedupe",
          shape: "anthropic-messages",
          supported: false,
          changed: false,
          failClosedReason: "public dedupe unsupported",
          removedBlocks: 0,
          charsBefore: 0,
          charsAfter: 0,
          estTokensBefore: 0,
          estTokensAfter: 0,
          reductionPercent: 0
        },
        optimization_plan: {
          selectedMethod: "no-op",
          selectedReason: "no public optimization selected",
          rejectedMethods: [],
          evidenceLabel: "unavailable",
          approvalRequirement: "none",
          approvalSource: "none",
          cacheEvidence: "unavailable",
          composableMethods: [],
          expectedInputTokenDelta: -23
        },
        applied_components: ["json-whitespace-compaction"],
        composed_input_estimate: { before: 100, after: 77 },
        lcm_contributed: false,
        shape_gate_results: { "supported-shape": "pass", "change-produced": "pass" }
      }
    };
  })
}));

const { createGatewayServer } = await import("../../src/core/gateway/server.js");
const { buildApplyReceipt } = await import("../../src/core/gateway/apply-receipt.js");
const { buildAutoApplyActivityEvent } = await import("../../src/core/gateway/auto-apply-activity.js");
const { receiptCompactedInput, receiptProvesPrivateFullApply } = await import("../../src/core/gateway/receipt-line.js");
const { savePolicyPreference, AUTO_APPLY_ELIGIBILITY_GATES } = await import("../../src/core/policy-preferences.js");
const { GATEWAY_RECOVERY_DIR } = await import("../../src/core/gateway/recovery.js");
const { readUsageJournal } = await import("../../src/core/usage/usage-journal.js");
const { provisionValidLease } = await import("../helpers/lease-fixture.js");

describe("JSON whitespace component receipt and activity accounting", () => {
  it("is input compaction for the measured axis but does not prove private Full LCM provenance", () => {
    const receipt = buildApplyReceipt({
      provider: "anthropic",
      endpoint: "/v1/messages",
      upstreamStatus: 200,
      usage: { present: false, unavailableReason: "synthetic focused test" },
      activation: {
        mode: "apply",
        requested: true,
        policy: "deterministic-dedupe",
        activation: "stored-authorization"
      },
      plan: {
        policy: "deterministic-dedupe",
        shape: "anthropic-messages",
        supported: false,
        changed: false,
        removedBlocks: 0,
        charsBefore: 0,
        charsAfter: 0,
        estTokensBefore: 0,
        estTokensAfter: 0,
        reductionPercent: 0
      },
      applied: true,
      recoveryId: "recovery-1",
      authorizationId: "policy-pref-12345678",
      appliedComponents: ["json-whitespace-compaction"],
      composedInputEstimate: { before: 100, after: 77 }
    });
    expect(receipt.applied_components).toEqual(["json-whitespace-compaction"]);
    expect(receipt.estimated_input_tokens_before).toBe(100);
    expect(receipt.estimated_input_tokens_after).toBe(77);
    expect(receiptCompactedInput(receipt)).toBe(true);
    expect(receiptProvesPrivateFullApply(receipt)).toBe(false);
    expect(receipt.label).toContain("JSON whitespace compaction");
  });

  it("uses the composed original-to-post-input basis in the activity event", () => {
    const event = buildAutoApplyActivityEvent({
      cwd: "/tmp/synthetic-json-whitespace",
      workflow: "claude-code",
      plan: {
        policy: "deterministic-dedupe",
        shape: "anthropic-messages",
        supported: false,
        changed: false,
        removedBlocks: 0,
        charsBefore: 0,
        charsAfter: 0,
        estTokensBefore: 0,
        estTokensAfter: 0,
        reductionPercent: 0
      },
      recoveryId: "recovery-1",
      authorizationId: "policy-pref-12345678",
      authorizationScopeLine: "claude-code",
      gatesPassed: ["stored-authorization"],
      appliedComponents: ["json-whitespace-compaction"],
      composedInputEstimate: { before: 100, after: 77 }
    });
    expect(event.input_before).toBe(100);
    expect(event.input_after).toBe(77);
    expect(event.policy_used).toBe("json-whitespace-compaction");
    expect(event.caveats.join("\n")).toContain("json-whitespace-compaction");
  });
});

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function post(port: number, body: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/v1/messages",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer synthetic-test",
          "content-length": String(Buffer.byteLength(body))
        }
      },
      (res) => {
        res.resume();
        res.on("end", resolve);
      }
    );
    req.on("error", reject);
    req.end(body);
  });
}

describe("JSON whitespace component through the gateway apply seam", () => {
  const servers: Server[] = [];
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(close));
    dirs.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
    vi.restoreAllMocks();
  });

  async function setup(allowanceTokens: number, cwdOverride?: string) {
    const seen: string[] = [];
    const upstream = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        seen.push(Buffer.concat(chunks).toString("utf8"));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ usage: { input_tokens: 100, output_tokens: 4 } }));
      });
    });
    servers.push(upstream);
    const upstreamPort = await listen(upstream);
    vi.spyOn(https, "request").mockImplementation(((options: RequestOptions, callback: (response: unknown) => void) =>
      request(
        { ...options, protocol: "http:", hostname: "127.0.0.1", port: upstreamPort },
        callback as Parameters<typeof request>[1]
      )) as typeof https.request);

    const configDir = mkdtempSync(join(tmpdir(), "json-whitespace-config-"));
    dirs.push(configDir);
    const cwd = cwdOverride ?? mkdtempSync(join(tmpdir(), "json-whitespace-cwd-"));
    if (cwdOverride === undefined) dirs.push(cwd);
    const env = provisionValidLease(configDir, { allowance_tokens: allowanceTokens }, { productMode: "full" }) as NodeJS.ProcessEnv;
    await savePolicyPreference(
      {
        scope: { tool: "claude-code", policy_type: "deterministic-dedupe" },
        preference: "auto-when-gates-pass",
        gates_required: [...AUTO_APPLY_ELIGIBILITY_GATES]
      },
      configDir
    );
    const receipts: Array<{ applied_components?: string[]; recovery_id?: string }> = [];
    const gateway = createGatewayServer({
      provider: "anthropic",
      upstream: "https://synthetic.invalid",
      mode: "record",
      workflow: "claude-code",
      optimizationMode: "cache-plus-context",
      cwd,
      entitlementEnv: env,
      onReceipt: (receipt) => receipts.push(receipt)
    });
    servers.push(gateway);
    return { port: await listen(gateway), seen, receipts, env, cwd };
  }

  it("meters L1 as input compaction and retains the exact pre-L1 request", async () => {
    const context = await setup(1_000);
    await post(context.port, ORIGINAL);
    expect(context.seen).toEqual([MUTATED]);
    const journal = await readUsageJournal(context.env);
    expect(journal.entries).toHaveLength(1);
    expect(journal.entries[0].optimized_input_tokens).toBe(METERED);
    const receipt = context.receipts.at(-1)!;
    expect(receipt.applied_components).toEqual(["json-whitespace-compaction"]);
    const recoveryFile = join(context.cwd, GATEWAY_RECOVERY_DIR, `${receipt.recovery_id}.json`);
    const recovery = JSON.parse(readFileSync(recoveryFile, "utf8")) as { original_body: string };
    expect(recovery.original_body).toBe(ORIGINAL);
  });

  it("does not run L1 after allowance exhaustion", async () => {
    const context = await setup(0);
    await post(context.port, ORIGINAL);
    const forwarded = JSON.parse(context.seen[0]) as {
      messages: Array<{ content: Array<{ content: string }> }>;
    };
    expect(forwarded.messages[0].content[0].content).toBe(
      (JSON.parse(ORIGINAL) as typeof forwarded).messages[0].content[0].content
    );
    expect(context.receipts.at(-1)?.applied_components).not.toContain("json-whitespace-compaction");
    expect((await readUsageJournal(context.env)).entries).toHaveLength(0);
  });

  it("forwards the original when recovery retention fails", async () => {
    const parent = mkdtempSync(join(tmpdir(), "json-whitespace-retention-"));
    dirs.push(parent);
    const unusableCwd = join(parent, "not-a-directory");
    writeFileSync(unusableCwd, "file blocks recovery directory creation");
    const context = await setup(1_000, unusableCwd);
    await post(context.port, ORIGINAL);
    expect(context.seen).toEqual([ORIGINAL]);
    expect((await readUsageJournal(context.env)).entries).toHaveLength(0);
    expect(existsSync(join(unusableCwd, GATEWAY_RECOVERY_DIR))).toBe(false);
  });
});
