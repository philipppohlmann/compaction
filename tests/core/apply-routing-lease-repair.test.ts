/**
 * `resolveApplyRoutingActivationWithLeaseRepair` — the ONE bounded lease repair `gateway ensure` may
 * run before deciding a tool session's route.
 *
 * The rule under test: repair ONLY when the credential condition is the SOLE blocker on a device that
 * holds credentials; bounded; fail-open to the original dormant decision; never repairs (and never
 * makes a network call for) any other dormant cause.
 *
 * Every non-repairable case asserts the repair was NOT CALLED, not merely that the result is dormant —
 * a dormant result alone cannot distinguish "correctly skipped" from "attempted and failed".
 *
 * HERMETIC: per-test config dir; the only services are loopback servers started here.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resolveApplyRoutingActivationWithLeaseRepair,
  type LeaseRepairDeps
} from "../../src/core/gateway/apply-routing-activation.js";
import {
  writeOptimizationMode,
  addConnectedWorkflows,
  removeConnectedWorkflow
} from "../../src/core/onboarding-preferences.js";
import { devLeaseRootKeyPath } from "../../src/core/entitlement/lease-roots.js";
import { stopShaping } from "../../src/core/subscription-shaping-state.js";
import {
  savePolicyPreference,
  AUTO_APPLY_ELIGIBILITY_GATES,
  POLICY_PREFERENCES_FILENAME
} from "../../src/core/policy-preferences.js";
import { leasePath, readLeaseVerdict } from "../../src/core/entitlement/lease-store.js";
import { provisionValidLease } from "../helpers/lease-fixture.js";

let cwd: string;
let configDir: string;
let env: NodeJS.ProcessEnv;
/** A valid signed lease captured at setup, so a repair can "reissue" it. */
let validLeaseText: string;

async function seedOptIns(): Promise<void> {
  writeOptimizationMode("cache-plus-context", env);
  addConnectedWorkflows(["claude-code"], env);
  await savePolicyPreference(
    {
      scope: { tool: "claude-code", policy_type: "deterministic-dedupe" },
      preference: "auto-when-gates-pass",
      gates_required: [...AUTO_APPLY_ELIGIBILITY_GATES]
    },
    configDir
  );
}

/** Signed-in device whose lease has lapsed (file absent ⇒ `lease-absent` ⇒ cause `credential-missing`). */
function lapseLease(): void {
  unlinkSync(leasePath(env));
}

interface RepairProbe {
  deps: LeaseRepairDeps;
  calls: () => number;
  lastSignal: () => AbortSignal | undefined;
}

function probe(repair: (signal: AbortSignal) => Promise<unknown>, timeoutMs = 2_500): RepairProbe {
  let calls = 0;
  let signal: AbortSignal | undefined;
  return {
    deps: {
      hasCredentials: (e) => existsSync(join(e.COMPACTION_CONFIG_DIR ?? "", "credentials.json")),
      repairLease: (_e, s) => {
        calls += 1;
        signal = s;
        return repair(s);
      },
      timeoutMs
    },
    calls: () => calls,
    lastSignal: () => signal
  };
}

const reissue = (): Promise<void> => {
  writeFileSync(leasePath(env), validLeaseText);
  return Promise.resolve();
};

beforeEach(async () => {
  cwd = mkdtempSync(join(tmpdir(), "apply-routing-repair-"));
  configDir = join(cwd, ".compaction");
  const enginePath = join(cwd, "engine.js");
  // The engine condition is pinned explicitly so this suite tests the repair rule, not whatever engine
  // the machine running it happens to have.
  env = { COMPACTION_CONFIG_DIR: configDir, ANTHROPIC_API_KEY: "", COMPACTION_ENGINE_PATH: enginePath };
  provisionValidLease(configDir);
  writeFileSync(enginePath, "// test engine artifact\n");
  validLeaseText = readFileSync(leasePath(env), "utf8");
  await seedOptIns();
});

afterEach(() => rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

const params = (): { provider: string; cwd: string; env: NodeJS.ProcessEnv } => ({ provider: "anthropic", cwd, env });

describe("B2 — repairable: the credential condition is the sole blocker on a signed-in device", () => {
  it("repairs once and ENGAGES when the reissued lease verifies", async () => {
    lapseLease();
    const p = probe(reissue);
    const decision = await resolveApplyRoutingActivationWithLeaseRepair(params(), p.deps);
    expect(p.calls()).toBe(1);
    expect(decision.engage).toBe(true);
  });

  it("keeps the ORIGINAL dormant decision when the repair throws (fail-open, never blocks)", async () => {
    lapseLease();
    const p = probe(() => Promise.reject(new Error("boom")));
    const decision = await resolveApplyRoutingActivationWithLeaseRepair(params(), p.deps);
    expect(p.calls()).toBe(1);
    expect(decision.engage).toBe(false);
    if (!decision.engage) expect(decision.cause).toBe("credential-missing");
  });

  it("keeps the dormant decision when the repair completes but the lease is still invalid", async () => {
    lapseLease();
    const p = probe(() => Promise.resolve({ lease: "unavailable" }));
    const decision = await resolveApplyRoutingActivationWithLeaseRepair(params(), p.deps);
    expect(p.calls()).toBe(1);
    expect(decision.engage).toBe(false);
  });

  it("is BOUNDED: a repair that never settles cannot hold the launch past its deadline, and is aborted", async () => {
    lapseLease();
    const p = probe(() => new Promise<never>(() => {}), 50);
    const started = Date.now();
    const decision = await resolveApplyRoutingActivationWithLeaseRepair(params(), p.deps);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(decision.engage).toBe(false);
    expect(p.lastSignal()?.aborted).toBe(true);
  });
});

describe("B2 — NOT repaired: every other dormant cause stays visible, with no repair attempt", () => {
  it("Open device (no credentials): no repair", async () => {
    lapseLease();
    unlinkSync(join(configDir, "credentials.json"));
    const p = probe(reissue);
    const decision = await resolveApplyRoutingActivationWithLeaseRepair(params(), p.deps);
    expect(p.calls()).toBe(0);
    expect(decision.engage).toBe(false);
  });

  it("engine absent: no repair, cause engine-unreachable", async () => {
    lapseLease();
    env.COMPACTION_ENGINE_PATH = join(cwd, "no-such-engine.js");
    const p = probe(reissue);
    const decision = await resolveApplyRoutingActivationWithLeaseRepair(params(), p.deps);
    expect(p.calls()).toBe(0);
    if (!decision.engage) expect(decision.cause).toBe("engine-unreachable");
    else throw new Error("engaged with no engine");
  });

  it("`compaction stop`: no repair, cause stopped", async () => {
    lapseLease();
    stopShaping(env);
    const p = probe(reissue);
    const decision = await resolveApplyRoutingActivationWithLeaseRepair(params(), p.deps);
    expect(p.calls()).toBe(0);
    if (!decision.engage) expect(decision.cause).toBe("stopped");
    else throw new Error("engaged while stopped");
  });

  it("workflow not connected: no repair (a lapsed lease is not the sole blocker)", async () => {
    lapseLease();
    removeConnectedWorkflow("claude-code", env);
    const p = probe(reissue);
    const decision = await resolveApplyRoutingActivationWithLeaseRepair(params(), p.deps);
    expect(p.calls()).toBe(0);
    expect(decision.engage).toBe(false);
  });

  it("optimization mode not selected: no repair", async () => {
    lapseLease();
    writeOptimizationMode("cache", env);
    const p = probe(reissue);
    const decision = await resolveApplyRoutingActivationWithLeaseRepair(params(), p.deps);
    expect(p.calls()).toBe(0);
    expect(decision.engage).toBe(false);
  });

  it("stored apply authorization absent: no repair", async () => {
    lapseLease();
    rmSync(join(configDir, POLICY_PREFERENCES_FILENAME), { force: true });
    const p = probe(reissue);
    const decision = await resolveApplyRoutingActivationWithLeaseRepair(params(), p.deps);
    expect(p.calls()).toBe(0);
    expect(decision.engage).toBe(false);
  });

  it("wrong provider: no repair, cause provider-not-applicable", async () => {
    lapseLease();
    const p = probe(reissue);
    const decision = await resolveApplyRoutingActivationWithLeaseRepair({ ...params(), provider: "openai" }, p.deps);
    expect(p.calls()).toBe(0);
    if (!decision.engage) expect(decision.cause).toBe("provider-not-applicable");
    else throw new Error("engaged for openai");
  });
});

describe("B3 — continuity on the ensure path", () => {
  it("restart / new shell with valid credentials + lease: engages with NO repair (no network)", async () => {
    const p = probe(reissue);
    const decision = await resolveApplyRoutingActivationWithLeaseRepair(params(), p.deps);
    expect(p.calls()).toBe(0);
    expect(decision.engage).toBe(true);
  });

  /** A loopback entitlement service answering reconcile and lease independently. */
  async function startService(lease: { status: number; body: unknown }): Promise<{ url: string; leaseHits: () => number; stop: () => Promise<void> }> {
    let leaseHits = 0;
    const server: Server = createServer((req, res) => {
      const isLease = (req.url ?? "").includes("/v0/lease");
      if (isLease) leaseHits += 1;
      const chosen = isLease ? lease : { status: 503, body: { error: "temporarily_unavailable" } };
      const payload = JSON.stringify(chosen.body);
      req.resume();
      req.on("end", () => {
        res.writeHead(chosen.status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
        res.end(payload);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    return {
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      leaseHits: () => leaseHits,
      stop: () => new Promise<void>((resolve) => server.close(() => resolve()))
    };
  }

  function repointCredentials(url: string): void {
    const file = join(configDir, "credentials.json");
    const credentials = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    writeFileSync(file, JSON.stringify({ ...credentials, api_url: url }));
  }

  it("END TO END (real repair): a lapsed lease the service reissues ENGAGES this launch, silently", async () => {
    lapseLease();
    const service = await startService({ status: 200, body: JSON.parse(validLeaseText) });
    repointCredentials(service.url);
    try {
      const decision = await resolveApplyRoutingActivationWithLeaseRepair(params());
      expect(service.leaseHits()).toBe(1);
      expect(decision.engage).toBe(true);
    } finally {
      await service.stop();
    }
  });

  it("END TO END: an AUTHORITATIVE denial is not repaired — dormant, lease cleared per the existing contract", async () => {
    // Expired-but-present lease, so the deletion is observable.
    const expired = provisionExpiredLeaseText();
    writeFileSync(leasePath(env), expired.text);
    expect(readLeaseVerdict(env).label).not.toBe("lease-valid");
    const service = await startService({ status: 403, body: { error: "not_entitled" } });
    repointCredentials(service.url);
    try {
      const decision = await resolveApplyRoutingActivationWithLeaseRepair(params());
      expect(decision.engage).toBe(false);
      if (!decision.engage) expect(decision.cause).toBe("credential-missing");
      expect(existsSync(leasePath(env))).toBe(false);
    } finally {
      await service.stop();
    }
  });

  it("END TO END: a TRANSIENT failure stays dormant, does not delete the stored lease, and never throws", async () => {
    const expired = provisionExpiredLeaseText();
    writeFileSync(leasePath(env), expired.text);
    const service = await startService({ status: 503, body: { error: "temporarily_unavailable" } });
    repointCredentials(service.url);
    try {
      const decision = await resolveApplyRoutingActivationWithLeaseRepair(params());
      expect(decision.engage).toBe(false);
      expect(existsSync(leasePath(env))).toBe(true);
      expect(readFileSync(leasePath(env), "utf8")).toBe(expired.text);
    } finally {
      await service.stop();
    }
  });

  /**
   * An EXPIRED lease signed by this device's own dev root. `provisionValidLease` mints a fresh root and
   * credentials each call, so it is minted in a scratch dir and then the root/credentials of THAT dir
   * are adopted here — the lease verifies on signature and binding and fails only on expiry.
   */
  function provisionExpiredLeaseText(): { text: string } {
    const scratch = mkdtempSync(join(tmpdir(), "apply-routing-expired-"));
    try {
      provisionValidLease(scratch, { expires_at: new Date(Date.now() - 60_000).toISOString() });
      const scratchEnv = { COMPACTION_CONFIG_DIR: scratch };
      const credentialsFile = join(configDir, "credentials.json");
      const keepUrl = (JSON.parse(readFileSync(credentialsFile, "utf8")) as { api_url: string }).api_url;
      const scratchCredentials = JSON.parse(readFileSync(join(scratch, "credentials.json"), "utf8")) as Record<string, unknown>;
      writeFileSync(credentialsFile, JSON.stringify({ ...scratchCredentials, api_url: keepUrl }));
      writeFileSync(devLeaseRootKeyPath(env), readFileSync(devLeaseRootKeyPath(scratchEnv), "utf8"));
      return { text: readFileSync(leasePath(scratchEnv), "utf8") };
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
});
