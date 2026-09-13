/**
 * `ensureCommunityRuntime` — the ONE call that makes a Community device's runtime match its
 * entitlement (productionization items 11–13).
 *
 * The properties proven here are the ones the product journey depends on, not the implementation:
 *  - NO ACCOUNT ⇒ NO NETWORK. An Open device gets a local read and nothing else, which is what lets
 *    `mode full` keep printing "no account, entitlement, usage, or network call was made" honestly.
 *  - A VALID LEASE IS NOT REFETCHED — the repair is cheap enough to call from several surfaces.
 *  - A FAILED REPAIR NEVER THROWS and never reports what it did not achieve: an unreachable service
 *    leaves the device exactly as entitled as it was, with a coded, content-free reason.
 *  - `engineBlockedReason` is DERIVED from what the attempt hit, so the sentence two surfaces print
 *    cannot outlive the world it describes.
 *
 * HERMETIC: `COMPACTION_CONFIG_DIR` is a per-test tmpdir and the only service URL any credentials
 * carry is a dead loopback port, so "the network" here can only fail — never reach anything real.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ACTIVE_USAGE_METER_VERSION } from "../../src/core/usage/usage-event.js";
import {
  communityRuntimeReady,
  describeRepairActions,
  engineBlockedReason,
  ensureCommunityRuntime,
  type CommunityRuntimeOutcome
} from "../../src/core/entitlement/community-runtime.js";
import { writeStoredCredentials } from "../../src/core/auth/credentials.js";
import { generateDeviceKeyPair } from "../../src/core/auth/device-flow.js";
import { provisionValidLease } from "../helpers/lease-fixture.js";
import { readLeaseVerdict } from "../../src/core/entitlement/lease-store.js";
import { leasePath } from "../../src/core/entitlement/lease-store.js";
import { currentPeriodId } from "../../src/core/entitlement/lease.js";
import { meterConfirmedApply } from "../../src/core/usage/usage-metering.js";
import { readReconciliationWatermark } from "../../src/core/usage/reconciliation-watermark.js";
import { readPeriodConsumption } from "../../src/core/usage/usage-journal.js";

/** A dead port: a connection attempt fails immediately and cannot reach any real service. */
const DEAD_SERVICE = "http://127.0.0.1:1";

let dir: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "community-runtime-"));
  env = { COMPACTION_CONFIG_DIR: dir };
});
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

/** Real, schema-valid credentials whose service is a dead port — and no lease anywhere. */
function writeUnreachableCredentials(): void {
  const keys = generateDeviceKeyPair();
  writeStoredCredentials(
    {
      schema_version: 1,
      api_url: DEAD_SERVICE,
      account_id: "acct-test",
      device_id: "123e4567-e89b-42d3-a456-426614174000",
      device_token: "cmpd_test_123e4567-e89b-42d3-a456-426614174000.fakefakefakefakefakefakefakefake",
      device_private_key_pem: keys.privateKeyPem,
      device_public_key: keys.publicKey,
      created_at: new Date().toISOString()
    },
    env
  );
}

describe("ensureCommunityRuntime", () => {
  it("attempts NOTHING and makes no network call on a device with no account", async () => {
    const steps: string[] = [];
    const outcome = await ensureCommunityRuntime(env, (step) => steps.push(step));

    expect(outcome.account).toBe("absent");
    expect(outcome.networkUsed).toBe(false);
    expect(outcome.reason).toBe("no-account");
    // Not one progress callback: a progress line is only emitted before a step that touches the
    // network, so an empty list is the same fact stated a second way.
    expect(steps).toEqual([]);
    expect(communityRuntimeReady(outcome)).toBe(false);
  });

  it("does not refetch a lease that is already valid", async () => {
    const leaseEnv = provisionValidLease(dir);
    const steps: string[] = [];
    const outcome = await ensureCommunityRuntime(leaseEnv, (step) => steps.push(step));

    expect(outcome.account).toBe("present");
    expect(outcome.lease).toBe("valid");
    // The lease step is the one thing that must not have run. (The engine step may still run: this
    // fixture has no engine, which is precisely the state the repair exists to fix.)
    expect(steps).not.toContain("lease");
  });

  it("reports an unreachable service as unavailable — with a coded reason, and without throwing", async () => {
    writeUnreachableCredentials();
    const outcome = await ensureCommunityRuntime(env);

    expect(outcome.account).toBe("present");
    expect(outcome.lease).toBe("unavailable");
    expect(outcome.networkUsed).toBe(true);
    // Coded and content-free: safe to print, and never a claim that something was achieved.
    expect(typeof outcome.reason).toBe("string");
    expect(outcome.reason).not.toBe("");
    expect(communityRuntimeReady(outcome)).toBe(false);
  });

  it("is idempotent — a second call on an unchanged device reports the same thing", async () => {
    const leaseEnv = provisionValidLease(dir);
    const first = await ensureCommunityRuntime(leaseEnv);
    const second = await ensureCommunityRuntime(leaseEnv);
    expect(second.lease).toBe(first.lease);
    expect(second.engine).toBe(first.engine);
  });

  it("does no work at all when the caller has ALREADY cancelled", async () => {
    writeUnreachableCredentials();
    const steps: string[] = [];
    const outcome = await ensureCommunityRuntime(env, (step) => steps.push(step), {
      signal: AbortSignal.abort()
    });

    // A cancelled attempt is a USER DECISION, so nothing is attempted and nothing is blamed on the
    // service. `networkUsed: false` is the same fact stated in the field a caller uses to keep a
    // "no network" promise honest.
    expect(outcome.reason).toBe("cancelled");
    expect(outcome.networkUsed).toBe(false);
    expect(steps).toEqual([]);
    expect(communityRuntimeReady(outcome)).toBe(false);
  });

  it("CANCELS A LEASE REQUEST THAT IS ALREADY IN FLIGHT rather than waiting it out", async () => {
    // THE POINT OF THIS TEST. Onboarding renders "Esc / Ctrl-C to stop and continue on Open" during
    // this exact wait. Before the signal was threaded through, the keypress moved the screen on while
    // the request kept running underneath — so the assertion that matters is not the reason code but
    // that the call RETURNS while the service is still holding the connection open.
    //
    // The server below accepts the request and never answers. If the abort did not reach the fetch,
    // this test would hang until vitest's timeout rather than fail fast.
    let held = false;
    const server: Server = createServer((_req, res) => {
      held = true;
      void res; // deliberately never answered
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;

    try {
      const keys = generateDeviceKeyPair();
      writeStoredCredentials(
        {
          schema_version: 1,
          api_url: `http://127.0.0.1:${port}`,
          account_id: "acct-test",
          device_id: "123e4567-e89b-42d3-a456-426614174000",
          device_token: "cmpd_test_123e4567-e89b-42d3-a456-426614174000.fakefakefakefakefakefakefakefake",
          device_private_key_pem: keys.privateKeyPem,
          device_public_key: keys.publicKey,
          created_at: new Date().toISOString()
        },
        env
      );

      const controller = new AbortController();
      const started = Date.now();
      const outcome = await ensureCommunityRuntime(
        env,
        (step) => {
          // Abort exactly as the user would: at the moment the surface says it is waiting on the lease.
          if (step === "lease") setTimeout(() => controller.abort(), 50);
        },
        { signal: controller.signal }
      );
      const elapsed = Date.now() - started;

      expect(held).toBe(true); // the request really was in flight
      expect(outcome.reason).toBe("cancelled"); // a decision, not "the service could not be reached"
      expect(outcome.lease).toBe("unavailable");
      expect(communityRuntimeReady(outcome)).toBe(false);
      // Generous, but far below any connection/TLS/read timeout a hung service would otherwise take.
      expect(elapsed).toBeLessThan(5_000);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

/**
 * THE HANDOVER AND THE LEASE ARE ONE TRANSACTION, and these two tests are the halves of it.
 *
 * The device's ceiling is the sum of two DISJOINT halves: the allowance the service signed into the
 * lease (already net of every debit it has recorded) plus the local journal entries it has not seen
 * yet. Reconciling moves tokens from the second half into the first, but the device only ever LEARNS
 * the first half's new value by acquiring a fresh lease. Automatic repair therefore defers the
 * watermark until that verified lease lands. If renewal fails, the entries remain in the local
 * tally and the next invocation retries the same idempotent handover instead of taking the cheap
 * valid-lease path.
 */
describe("ensureCommunityRuntime - a committed usage handover and the lease that must follow it", () => {
  /** Point the fixture's credentials at a real loopback service WITHOUT touching the device key the lease is bound to. */
  function repointCredentials(url: string): void {
    const path = join(dir, "credentials.json");
    const credentials = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    credentials.api_url = url;
    writeFileSync(path, JSON.stringify(credentials));
  }

  /** Two REAL metered debits, so there is something the service has not seen. */
  async function seedUnreconciledUsage(env: NodeJS.ProcessEnv): Promise<void> {
    for (let i = 0; i < 2; i++) {
      const result = await meterConfirmedApply(
        {
          routeType: "api-key",
          workflow: "codex",
          provider: "openai",
          periodId: currentPeriodId(),
          allowanceTokens: 2_000_000,
          recoveryId: `rec-${i}`,
          meterVersion: ACTIVE_USAGE_METER_VERSION,
          meteredOptimizedInputTokens: 1000,
          estimatedInputTokensBefore: 1500,
          estimatedInputTokensAfter: 500,
          preMutationBody: "x".repeat(100)
        },
        env
      );
      expect(result.metered).toBe(true);
    }
  }

  /** A service that answers reconcile and lease independently, recording which paths were asked for. */
  async function startService(handlers: {
    reconcile: { status: number; body: unknown };
    lease: { status: number; body: unknown };
  }): Promise<{ url: string; paths: string[]; stop: () => Promise<void> }> {
    const paths: string[] = [];
    const server: Server = createServer((req, res) => {
      paths.push(req.url ?? "");
      const chosen = (req.url ?? "").includes("/v0/lease") ? handlers.lease : handlers.reconcile;
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
      paths,
      stop: () => new Promise<void>((resolve) => server.close(() => resolve()))
    };
  }

  const acceptedReconcile = {
    status: 200,
    body: {
      schema_version: 1,
      period_id: currentPeriodId(),
      accepted: 2,
      duplicate: 0,
      rejected: [],
      chain_continuous: true,
      anchor: { entry_count: 2 }
    }
  };

  it("KEEPS authorization without replenishing headroom and retries the lease after a transient post-reconcile failure", async () => {
    // Deleting the lease on a 503 after reconcile silently turned a
    // signed-in Community device into Plan: Open / "needs activation". Transient renew failure must
    // leave existing authorization on disk; only authoritative denials clear it.
    const leaseEnv = provisionValidLease(dir) as NodeJS.ProcessEnv;
    await seedUnreconciledUsage(leaseEnv);
    const before = await readPeriodConsumption(2_000_000, currentPeriodId(), leaseEnv);
    expect(before).toEqual({ ok: true, consumed: 2_000, remaining: 1_998_000 });
    const stillValidSignedLease = JSON.parse(readFileSync(leasePath(leaseEnv), "utf8"));
    const service = await startService({
      reconcile: acceptedReconcile,
      lease: { status: 503, body: { error: "temporarily_unavailable" } }
    });
    repointCredentials(service.url);

    try {
      const outcome = await ensureCommunityRuntime(leaseEnv);

      const watermark = await readReconciliationWatermark(leaseEnv);
      expect(JSON.stringify(watermark)).not.toContain(currentPeriodId());
      expect(service.paths.some((p) => p.includes("/v0/lease"))).toBe(true);

      expect(outcome.lease).toBe("valid");
      expect(existsSync(leasePath(leaseEnv))).toBe(true);
      expect(readLeaseVerdict(leaseEnv).label).toBe("lease-valid");

      // The service accepted these debits, but the stale lease does not reflect them. They must
      // therefore remain charged locally until a replacement lease lands; otherwise a transient
      // renewal failure silently replenishes 2,000 tokens of headroom.
      const afterFailure = await readPeriodConsumption(2_000_000, currentPeriodId(), leaseEnv);
      expect(afterFailure).toEqual({ ok: true, consumed: 2_000, remaining: 1_998_000 });
    } finally {
      await service.stop();
    }

    // The old lease is fresh, not near expiry. A later repair must still retry acquisition because
    // the preceding usage handover was not completed by a verified replacement lease.
    const recovery = await startService({
      reconcile: acceptedReconcile,
      lease: { status: 200, body: stillValidSignedLease }
    });
    repointCredentials(recovery.url);
    try {
      const outcome = await ensureCommunityRuntime(leaseEnv);
      expect(outcome.lease).toBe("renewed");
      expect(recovery.paths.some((p) => p.includes("/v0/lease"))).toBe(true);
    } finally {
      await recovery.stop();
    }
  });

  it("CLEARS the lease when the service authoritatively denies Community", async () => {
    const leaseEnv = provisionValidLease(dir) as NodeJS.ProcessEnv;
    await seedUnreconciledUsage(leaseEnv);
    const service = await startService({
      reconcile: acceptedReconcile,
      lease: { status: 403, body: { error: "not_entitled" } }
    });
    repointCredentials(service.url);

    try {
      const outcome = await ensureCommunityRuntime(leaseEnv);

      expect(outcome.lease).toBe("unavailable");
      expect(outcome.reason).toBe("not_entitled");
      expect(existsSync(leasePath(leaseEnv))).toBe(false);
      expect(readLeaseVerdict(leaseEnv).label).not.toBe("lease-valid");
    } finally {
      await service.stop();
    }
  });

  it("KEEPS the lease when nothing was handed over — a failed upload is not a reason to drop an entitlement", async () => {
    // The other half of the rule, and the one that keeps it from being a blunt instrument: the lease
    // is invalidated by the WATERMARK MOVING, not by a reconcile attempt going badly. A device that
    // could not upload has changed nothing about what the service has recorded, so its lease still
    // describes its allowance exactly and must survive untouched.
    const leaseEnv = provisionValidLease(dir) as NodeJS.ProcessEnv;
    await seedUnreconciledUsage(leaseEnv);
    const service = await startService({
      reconcile: { status: 503, body: { error: "usage_reconcile_unavailable" } },
      lease: { status: 503, body: { error: "temporarily_unavailable" } }
    });
    repointCredentials(service.url);

    try {
      const outcome = await ensureCommunityRuntime(leaseEnv);

      expect((await readReconciliationWatermark(leaseEnv)).periods).toEqual({});
      expect(outcome.lease).toBe("valid");
      expect(existsSync(leasePath(leaseEnv))).toBe(true);
      expect(readLeaseVerdict(leaseEnv).label).toBe("lease-valid");
      // The cheap path was taken: no lease request was made at all.
      expect(service.paths.some((p) => p.includes("/v0/lease"))).toBe(false);
    } finally {
      await service.stop();
    }
  });
});

describe("engineBlockedReason", () => {
  const base: CommunityRuntimeOutcome = {
    account: "present",
    lease: "valid",
    engine: "unavailable",
    networkUsed: true
  };

  it("attributes a block to this BUILD or this SERVICE, never to the state of the world", () => {
    // A signed release is published, so no branch may say one does not exist. The two causes are
    // also distinct — an unpinned build can never verify anything; an empty channel is a service
    // answer that changes without a new client — so they must not share a sentence.
    const noRoot = engineBlockedReason({ ...base, reason: "no-release-root" });
    expect(noRoot).toMatch(/this build pins no engine release root/i);
    expect(noRoot).not.toMatch(/has been distributed yet/);

    const noRelease = engineBlockedReason({ ...base, reason: "no-published-release" });
    expect(noRelease).toMatch(/service has no published engine release on this channel/i);
    expect(noRelease).not.toMatch(/has been distributed yet/);

    expect(noRoot).not.toBe(noRelease);
  });

  it("does NOT claim nothing was distributed when there is no coded reason at all", () => {
    // The fallback branch. It used to return the world-claim, so a device with no reason code was
    // told a published release does not exist. It must now say only what it knows: not here.
    const reason = engineBlockedReason(base);
    expect(reason).not.toMatch(/has been distributed yet/);
    expect(reason).toMatch(/not available on this device/i);
  });

  it("does NOT blame an undistributed release for a download that failed on this device", () => {
    // The distinction this whole helper exists for: once a release is published, "none exists" is a
    // false explanation for a device that failed to fetch or verify one.
    const reason = engineBlockedReason({ ...base, reason: "artifact-digest-mismatch" });
    expect(reason).not.toMatch(/has been distributed yet/);
    expect(reason).toMatch(/could not be installed on this device/);
    expect(reason).toContain("artifact-digest-mismatch");
  });
});

describe("describeRepairActions", () => {
  const base: CommunityRuntimeOutcome = {
    account: "present",
    lease: "valid",
    engine: "present",
    networkUsed: false
  };

  it("says NOTHING when the device already held everything", () => {
    // `valid`/`present` mean it was already in place. Reporting that as an action would manufacture
    // news out of two local reads.
    expect(describeRepairActions(base)).toEqual([]);
  });

  it("reports a renewed access and an installed engine SEPARATELY", () => {
    const lines = describeRepairActions({ ...base, lease: "renewed", engine: "installed" });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/renewed/i);
    expect(lines[1]).toMatch(/engine/i);
  });

  it("reports the half that landed when the other half failed", () => {
    // THE CASE THAT MATTERS. `compaction login` used to end this attempt with "Nothing was changed",
    // which is false: the device's access was just renewed and only the engine download fell short.
    const lines = describeRepairActions({ ...base, lease: "renewed", engine: "unavailable", reason: "network" });
    expect(lines).toEqual(["Renewed this device's Community access."]);
  });

  it("names outcomes, never the mechanism the journey keeps out of the user's way", () => {
    const lines = describeRepairActions({ ...base, lease: "renewed", engine: "installed" });
    for (const line of lines) {
      expect(line).not.toMatch(/lease|entitlement service|trust root|root key|artifact|manifest/i);
    }
  });
});
