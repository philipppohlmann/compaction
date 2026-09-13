/**
 * Community entitlement lifecycle — silent-Open-downgrade regressions.
 *
 * Product invariant: once a device has signed in, activated Community, and been entitled,
 * normal lease expiry/refresh must NOT silently downgrade to Open or force browser activation again.
 *
 * These tests deliberately reproduce the pre-fix failure mode (expired/missing lease + connected
 * credentials → Plan: Open / "needs activation") and prove the silent-renew path restores Community
 * without fabricating entitlement on denial or transient failure.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureCommunityRuntime, REQUEST_TIME_LEASE_RENEW_MS } from "../../../src/core/entitlement/community-runtime.js";
import {
  LEASE_REFRESH_BEFORE_MS,
  leaseNeedsRenewal,
  leasePath,
  readLeaseVerdict
} from "../../../src/core/entitlement/lease-store.js";
import { currentPeriodId, type LeasePayload } from "../../../src/core/entitlement/lease.js";
import {
  generateDevLeaseSigningKeyPair,
  signLeasePayload
} from "../../../src/core/entitlement/dev-lease-signing.js";
import { devLeaseRootKeyPath } from "../../../src/core/entitlement/lease-roots.js";
import { publicKeyHash } from "../../../src/core/crypto/key-hash.js";
import { generateDeviceKeyPair } from "../../../src/core/auth/device-flow.js";
import { writeProductMode, effectiveOpenTier } from "../../../src/core/onboarding-preferences.js";
import { runStatus } from "../../../src/cli/commands/upgrade-status.js";

let dir: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "community-lifecycle-"));
  env = { ...process.env, COMPACTION_CONFIG_DIR: dir, COMPACTION_ENGINE_PATH: join(dir, "no-engine.js") };
});
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

/** Device + dev lease root + optional initial lease; returns the signer so a mock service can re-issue. */
function provisionDevice(options: {
  lease?: "valid" | "expired" | "near-expiry" | "absent";
  productMode?: "full" | "basic";
}): {
  env: NodeJS.ProcessEnv;
  signer: ReturnType<typeof generateDevLeaseSigningKeyPair>;
  devicePublicKey: string;
  mintLease: (overrides?: Partial<LeasePayload>) => { lease: LeasePayload; signature: string };
} {
  const signer = generateDevLeaseSigningKeyPair();
  const deviceKeyPair = generateDeviceKeyPair();
  const devicePublicKey = deviceKeyPair.publicKey;
  mkdirSync(join(dir, "entitlement"), { recursive: true });
  writeFileSync(devLeaseRootKeyPath({ COMPACTION_CONFIG_DIR: dir }), `${signer.publicKeySpkiB64u}\n`);
  writeFileSync(
    join(dir, "credentials.json"),
    JSON.stringify({
      schema_version: 1,
      api_url: "http://127.0.0.1:0",
      account_id: "acct-test",
      device_id: "dev-test",
      device_token: "cmpd_test_lifecycle",
      device_private_key_pem: deviceKeyPair.privateKeyPem,
      device_public_key: devicePublicKey,
      created_at: new Date().toISOString()
    })
  );
  writeProductMode(options.productMode ?? "full", { COMPACTION_CONFIG_DIR: dir });

  const mintLease = (overrides: Partial<LeasePayload> = {}) => {
    const now = Date.now();
    const payload: LeasePayload = {
      schema_version: 2,
      lease_id: "00000000-0000-0000-0000-0000000000bb",
      account_id: "acct-test",
      device_public_key_hash: publicKeyHash(devicePublicKey),
      period_id: currentPeriodId(),
      allowance_tokens: 2_000_000,
      issued_at: new Date(now).toISOString(),
      expires_at: new Date(now + 24 * 60 * 60 * 1000).toISOString(),
      lease_sequence: 1,
      route_scope: "all",
      period_allowance_tokens: 2_000_000,
      ...overrides
    };
    return { lease: payload, signature: signLeasePayload(payload, signer.privateKeyPem) };
  };

  if (options.lease === "valid") {
    writeFileSync(leasePath({ COMPACTION_CONFIG_DIR: dir }), JSON.stringify(mintLease()));
  } else if (options.lease === "expired") {
    writeFileSync(
      leasePath({ COMPACTION_CONFIG_DIR: dir }),
      JSON.stringify(mintLease({ expires_at: new Date(Date.now() - 60_000).toISOString() }))
    );
  } else if (options.lease === "near-expiry") {
    writeFileSync(
      leasePath({ COMPACTION_CONFIG_DIR: dir }),
      JSON.stringify(
        mintLease({
          expires_at: new Date(Date.now() + Math.floor(LEASE_REFRESH_BEFORE_MS / 2)).toISOString()
        })
      )
    );
  }

  return { env: { COMPACTION_CONFIG_DIR: dir }, signer, devicePublicKey, mintLease };
}

async function startLeaseService(
  mint: () => { lease: LeasePayload; signature: string },
  opts: { leaseStatus?: number; leaseError?: string } = {}
): Promise<{ url: string; leaseHits: number; stop: () => Promise<void> }> {
  let leaseHits = 0;
  const server: Server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if ((req.url ?? "").includes("/v0/usage/reconcile")) {
        const body = JSON.stringify({
          schema_version: 1,
          period_id: currentPeriodId(),
          accepted: 0,
          duplicate: 0,
          rejected: [],
          chain_continuous: true,
          anchor: { entry_count: 0 }
        });
        res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
        res.end(body);
        return;
      }
      if ((req.url ?? "").includes("/v0/lease")) {
        leaseHits += 1;
        if (opts.leaseStatus && opts.leaseStatus !== 200) {
          const body = JSON.stringify({ error: opts.leaseError ?? "error" });
          res.writeHead(opts.leaseStatus, {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body)
          });
          res.end(body);
          return;
        }
        const signed = mint();
        const body = JSON.stringify(signed);
        res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
        res.end(body);
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    get leaseHits() {
      return leaseHits;
    },
    stop: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

function repointCredentials(url: string): void {
  const path = join(dir, "credentials.json");
  const credentials = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  credentials.api_url = url;
  writeFileSync(path, JSON.stringify(credentials));
}

async function captureStatus(): Promise<string> {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  try {
    await runStatus({
      env,
      version: "0.0.0-test",
      projectsDir: join(dir, "none")
    });
  } finally {
    vi.restoreAllMocks();
  }
  return lines.join("\n");
}

describe("leaseNeedsRenewal", () => {
  it("exposes a request-time renew bound that is short enough not to stall provider traffic", () => {
    expect(REQUEST_TIME_LEASE_RENEW_MS).toBeGreaterThan(0);
    expect(REQUEST_TIME_LEASE_RENEW_MS).toBeLessThanOrEqual(5_000);
  });

  it("is true for an expired lease and false for a fresh valid lease", () => {
    provisionDevice({ lease: "expired" });
    expect(leaseNeedsRenewal(env)).toBe(true);
    expect(readLeaseVerdict(env).label).toBe("lease-expired");
  });

  it("is false for a fresh valid lease outside the refresh window", () => {
    provisionDevice({ lease: "valid" });
    expect(readLeaseVerdict(env).label).toBe("lease-valid");
    expect(leaseNeedsRenewal(env)).toBe(false);
  });

  it("is true inside the near-expiry refresh window while the verdict is still lease-valid", () => {
    provisionDevice({ lease: "near-expiry" });
    expect(readLeaseVerdict(env).label).toBe("lease-valid");
    expect(leaseNeedsRenewal(env)).toBe(true);
  });
});

describe("silent Community renewal", () => {
  it("REGRESSION (pre-fix): expired lease + connected credentials read as Open / needs activation without renew", async () => {
    // Documents the failure mode status used to render when it was local-disk-only and never renewed.
    provisionDevice({ lease: "expired" });
    expect(readLeaseVerdict(env).label).toBe("lease-expired");
    expect(effectiveOpenTier(env)).toBe("observe"); // product_mode full clamped off — Full gone
    // Without a renew path, Plan would be Open. The fix makes status renew; this assertion pins the
    // LOCAL pre-renew state that was shown as the product-truth defect.
    expect(readLeaseVerdict(env).label).not.toBe("lease-valid");
  });

  it("expired lease + still-entitled connected device → silent renewal → Community stays active", async () => {
    const device = provisionDevice({ lease: "expired" });
    let seq = 2;
    const service = await startLeaseService(() =>
      device.mintLease({
        lease_id: "00000000-0000-0000-0000-0000000000cc",
        lease_sequence: seq++,
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
      })
    );
    repointCredentials(service.url);

    try {
      const outcome = await ensureCommunityRuntime(env, () => {}, { leaseOnly: true });
      expect(outcome.lease).toBe("renewed");
      expect(readLeaseVerdict(env).label).toBe("lease-valid");
      expect(effectiveOpenTier(env)).toBe("full");
      expect(service.leaseHits).toBeGreaterThanOrEqual(1);

      const status = await captureStatus();
      expect(status).toContain("Account: connected");
      expect(status).toContain("Plan: Community");
      expect(status).toContain("Community: active");
      expect(status).not.toContain("needs activation");
      expect(status).not.toContain("Plan: Open");
    } finally {
      await service.stop();
    }
  });

  it("near-expiry renewal refreshes before the verdict flips to lease-expired", async () => {
    const device = provisionDevice({ lease: "near-expiry" });
    const before = JSON.parse(readFileSync(leasePath(env), "utf8")) as { lease: LeasePayload };
    const service = await startLeaseService(() =>
      device.mintLease({
        lease_id: "00000000-0000-0000-0000-0000000000dd",
        lease_sequence: before.lease.lease_sequence + 1,
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
      })
    );
    repointCredentials(service.url);

    try {
      expect(leaseNeedsRenewal(env)).toBe(true);
      const outcome = await ensureCommunityRuntime(env, () => {}, { leaseOnly: true });
      expect(outcome.lease).toBe("renewed");
      expect(service.leaseHits).toBeGreaterThanOrEqual(1);
      const after = JSON.parse(readFileSync(leasePath(env), "utf8")) as { lease: LeasePayload };
      expect(after.lease.lease_sequence).toBe(before.lease.lease_sequence + 1);
      expect(readLeaseVerdict(env).label).toBe("lease-valid");
    } finally {
      await service.stop();
    }
  });

  it("revoked / not_entitled Community → Open (fail closed, no fabricated entitlement)", async () => {
    provisionDevice({ lease: "expired" });
    const service = await startLeaseService(() => {
      throw new Error("must not mint");
    }, { leaseStatus: 403, leaseError: "not_entitled" });
    repointCredentials(service.url);

    try {
      const outcome = await ensureCommunityRuntime(env, () => {}, { leaseOnly: true });
      expect(outcome.lease).toBe("unavailable");
      expect(outcome.reason).toBe("not_entitled");
      expect(readLeaseVerdict(env).label).not.toBe("lease-valid");
      expect(effectiveOpenTier(env)).toBe("observe");

      const status = await captureStatus();
      expect(status).toContain("Plan: Open");
      expect(status).toContain("Community: not entitled");
      expect(status).not.toContain("Community: active");
    } finally {
      await service.stop();
    }
  });

  it("logged-out device → no renew, login required", async () => {
    // No credentials file at all.
    const outcome = await ensureCommunityRuntime(env, () => {}, { leaseOnly: true });
    expect(outcome.account).toBe("absent");
    expect(outcome.networkUsed).toBe(false);
    expect(outcome.reason).toBe("no-account");

    const status = await captureStatus();
    expect(status).toContain("Account: not connected");
    expect(status).toContain("Run compaction to set up Community.");
  });

  it("transient renewal failure does not fabricate entitlement and does not clear a still-valid lease", async () => {
    provisionDevice({ lease: "near-expiry" });
    expect(readLeaseVerdict(env).label).toBe("lease-valid");
    const service = await startLeaseService(() => {
      throw new Error("must not mint");
    }, { leaseStatus: 503, leaseError: "temporarily_unavailable" });
    repointCredentials(service.url);

    try {
      const outcome = await ensureCommunityRuntime(env, () => {}, { leaseOnly: true });
      expect(outcome.lease).toBe("valid"); // kept the near-expiry but still-valid lease
      expect(readLeaseVerdict(env).label).toBe("lease-valid");
      expect(existsSync(leasePath(env))).toBe(true);
    } finally {
      await service.stop();
    }
  });

  it("restart / new shell: valid lease on disk keeps Community without network", async () => {
    provisionDevice({ lease: "valid" });
    const first = await ensureCommunityRuntime(env, () => {}, { leaseOnly: true });
    expect(first.lease).toBe("valid");
    expect(first.networkUsed).toBe(false);

    // Simulate a new process: same config dir, fresh call.
    const second = await ensureCommunityRuntime({ COMPACTION_CONFIG_DIR: dir }, () => {}, { leaseOnly: true });
    expect(second.lease).toBe("valid");
    expect(second.networkUsed).toBe(false);
    expect(effectiveOpenTier({ COMPACTION_CONFIG_DIR: dir })).toBe("full");
  });

  it("status and onboarding identity/authorization agree after automatic renewal", async () => {
    const device = provisionDevice({ lease: "expired" });
    const service = await startLeaseService(() =>
      device.mintLease({
        lease_sequence: 9,
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
      })
    );
    repointCredentials(service.url);

    try {
      // status silently renews, then both surfaces must agree the device is Community.
      const status = await captureStatus();
      expect(status).toContain("Plan: Community");
      expect(status).toContain("Community: active");
      expect(readLeaseVerdict(env).label).toBe("lease-valid");
      // Onboarding's communityAuthorized bit is the same lease verdict status used.
      expect(readLeaseVerdict(env).label === "lease-valid").toBe(true);
    } finally {
      await service.stop();
    }
  });

  it("Full authorization remains usable after automatic renewal (tier clamp)", async () => {
    const device = provisionDevice({ lease: "expired", productMode: "full" });
    expect(effectiveOpenTier(env)).toBe("observe");
    const service = await startLeaseService(() =>
      device.mintLease({
        lease_sequence: 3,
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
      })
    );
    repointCredentials(service.url);

    try {
      await ensureCommunityRuntime(env, () => {}, { leaseOnly: true });
      expect(effectiveOpenTier(env)).toBe("full");
    } finally {
      await service.stop();
    }
  });

  it("concurrent renewals are idempotent — one network issue, both callers see a valid lease", async () => {
    const device = provisionDevice({ lease: "expired" });
    const service = await startLeaseService(() =>
      device.mintLease({
        lease_sequence: 5,
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
      })
    );
    repointCredentials(service.url);

    try {
      const [a, b] = await Promise.all([
        ensureCommunityRuntime(env, () => {}, { leaseOnly: true }),
        ensureCommunityRuntime(env, () => {}, { leaseOnly: true })
      ]);
      expect(a.lease === "renewed" || a.lease === "valid").toBe(true);
      expect(b.lease === "renewed" || b.lease === "valid").toBe(true);
      expect(readLeaseVerdict(env).label).toBe("lease-valid");
      // Shared in-flight promise: a single lease POST, not a race of two writers.
      expect(service.leaseHits).toBe(1);
    } finally {
      await service.stop();
    }
  });

  it("an unverifiable renewal candidate does not replace a still-valid near-expiry lease", async () => {
    // Codex P2: writing before verify made renew itself the silent Open downgrade during a
    // signing-root mismatch. The foreign-signed payload is parseable but must not overwrite disk.
    const device = provisionDevice({ lease: "near-expiry" });
    const before = readFileSync(leasePath(env), "utf8");
    const foreign = generateDevLeaseSigningKeyPair();
    const service = await startLeaseService(() => {
      const { lease } = device.mintLease({
        lease_sequence: 99,
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
      });
      return { lease, signature: signLeasePayload(lease, foreign.privateKeyPem) };
    });
    repointCredentials(service.url);

    try {
      const outcome = await ensureCommunityRuntime(env, () => {}, { leaseOnly: true });
      expect(outcome.lease).toBe("valid");
      expect(outcome.reason).toBe("lease-unverifiable");
      expect(readFileSync(leasePath(env), "utf8")).toBe(before);
      expect(readLeaseVerdict(env).label).toBe("lease-valid");
      expect(effectiveOpenTier(env)).toBe("full");
    } finally {
      await service.stop();
    }
  });

  it("Community active → transient renew miss → later renew succeeds → still Community", async () => {
    const device = provisionDevice({ lease: "near-expiry" });
    expect(readLeaseVerdict(env).label).toBe("lease-valid");

    const failing = await startLeaseService(() => {
      throw new Error("must not mint");
    }, { leaseStatus: 503, leaseError: "temporarily_unavailable" });
    repointCredentials(failing.url);
    try {
      const missed = await ensureCommunityRuntime(env, () => {}, { leaseOnly: true });
      expect(missed.lease).toBe("valid");
      expect(readLeaseVerdict(env).label).toBe("lease-valid");
      expect(effectiveOpenTier(env)).toBe("full");
    } finally {
      await failing.stop();
    }

    const ok = await startLeaseService(() =>
      device.mintLease({
        lease_sequence: 7,
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
      })
    );
    repointCredentials(ok.url);
    try {
      const renewed = await ensureCommunityRuntime(env, () => {}, { leaseOnly: true });
      expect(renewed.lease).toBe("renewed");
      expect(readLeaseVerdict(env).label).toBe("lease-valid");
      expect(effectiveOpenTier(env)).toBe("full");
    } finally {
      await ok.stop();
    }
  });

  it("aborted request-time renew preserves a still-valid near-expiry lease", async () => {
    provisionDevice({ lease: "near-expiry" });
    const server: Server = createServer((_req, res) => {
      void res; // never answers
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    repointCredentials(`http://127.0.0.1:${port}`);

    try {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 40);
      const started = Date.now();
      const outcome = await ensureCommunityRuntime(env, () => {}, {
        leaseOnly: true,
        signal: controller.signal
      });
      expect(Date.now() - started).toBeLessThan(3_000);
      expect(outcome.reason === "cancelled" || outcome.lease === "valid").toBe(true);
      expect(readLeaseVerdict(env).label).toBe("lease-valid");
      expect(effectiveOpenTier(env)).toBe("full");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("P0: joining a hung no-signal repair still respects THIS caller's AbortSignal deadline", async () => {
    // MERGE-GATE adversarial case: gateway start / status begins lease repair WITHOUT a signal;
    // a later request-time caller with REQUEST_TIME_LEASE_RENEW_MS must NOT stay blocked on that
    // shared promise past its own deadline.
    provisionDevice({ lease: "expired" });
    const server: Server = createServer((_req, res) => {
      void res; // never answers — hung entitlement service
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    repointCredentials(`http://127.0.0.1:${port}`);

    const startup = ensureCommunityRuntime(env, () => {}, { leaseOnly: true });
    // Let the hung fetch attach before the late joiner arrives.
    await new Promise((resolve) => setTimeout(resolve, 30));

    const controller = new AbortController();
    const bound = Math.min(REQUEST_TIME_LEASE_RENEW_MS, 400); // keep the test fast; same wiring
    setTimeout(() => controller.abort(), bound);
    const started = Date.now();
    const late = await ensureCommunityRuntime(env, () => {}, {
      leaseOnly: true,
      signal: controller.signal
    });
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(bound + 500);
    expect(late.reason).toBe("cancelled");
    expect(readLeaseVerdict(env).label).toBe("lease-expired");

    // Shared startup repair must still be running (we did not cancel it for others).
    let startupSettled = false;
    void startup.then(
      () => {
        startupSettled = true;
      },
      () => {
        startupSettled = true;
      }
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(startupSettled).toBe(false);

    // Force-drop hung sockets so close() cannot wait on the startup fetch.
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
