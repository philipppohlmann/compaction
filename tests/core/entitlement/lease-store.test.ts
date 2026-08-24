/**
 * Entitlement lease-store verifier — the Open-path-safe verification rail.
 *
 * Proves every content-free verdict label + that verification NEVER throws, using a DEV-signed lease
 * (generated in-process, verified against an installed dev lease root). No network, no engine.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  generateDevLeaseSigningKeyPair,
  signLeasePayload
} from "../../../src/core/entitlement/dev-lease-signing.js";
import { currentPeriodId, type LeasePayload } from "../../../src/core/entitlement/lease.js";
import { readLeaseVerdict, leasePath, hasValidFullApplyLease } from "../../../src/core/entitlement/lease-store.js";
import { devLeaseRootKeyPath } from "../../../src/core/entitlement/lease-roots.js";
import { publicKeyHash } from "../../../src/core/crypto/key-hash.js";
import { generateDeviceKeyPair } from "../../../src/core/auth/device-flow.js";

describe("entitlement lease-store (content-free verdict, fail-closed, never throws)", () => {
  let dir = "";
  let env: NodeJS.ProcessEnv;
  let signingKeyPem = "";
  let devicePublicKey = "";

  function env0(configDir: string): NodeJS.ProcessEnv {
    return { COMPACTION_CONFIG_DIR: configDir };
  }

  /** Write the credentials file carrying this device's public key (read as a FILE by the store). */
  function writeCredentials(publicKey: string): void {
    writeFileSync(
      join(dir, "credentials.json"),
      JSON.stringify({
        schema_version: 1,
        api_url: "http://127.0.0.1:0",
        account_id: "acct-1",
        device_id: "dev-1",
        device_token: "cmpd_test_x",
        device_private_key_pem: "x",
        device_public_key: publicKey,
        created_at: new Date().toISOString()
      })
    );
  }

  /** Install the dev lease root so dev-signed leases verify (labeled dev-lease-root). */
  function installDevRoot(spkiB64u: string): void {
    const p = devLeaseRootKeyPath(env);
    mkdirSync(join(dir, "entitlement"), { recursive: true });
    writeFileSync(p, `${spkiB64u}\n`);
  }

  function basePayload(overrides: Partial<LeasePayload> = {}): LeasePayload {
    const now = Date.now();
    return {
      schema_version: 1,
      lease_id: "11111111-1111-1111-1111-111111111111",
      account_id: "acct-1",
      device_public_key_hash: publicKeyHash(devicePublicKey),
      period_id: currentPeriodId(),
      allowance_tokens: 2_000_000,
      issued_at: new Date(now).toISOString(),
      expires_at: new Date(now + 24 * 60 * 60 * 1000).toISOString(),
      lease_sequence: 1,
      route_scope: "all",
      ...overrides
    };
  }

  function writeSignedLease(payload: LeasePayload, signature?: string): void {
    const sig = signature ?? signLeasePayload(payload, signingKeyPem);
    writeFileSync(leasePath(env), JSON.stringify({ lease: payload, signature: sig }));
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lease-store-"));
    env = env0(dir);
    const signer = generateDevLeaseSigningKeyPair();
    signingKeyPem = signer.privateKeyPem;
    installDevRoot(signer.publicKeySpkiB64u);
    devicePublicKey = generateDeviceKeyPair().publicKey;
    writeCredentials(devicePublicKey);
  });
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("lease-absent when there is no lease file", () => {
    expect(readLeaseVerdict(env).label).toBe("lease-absent");
    expect(hasValidFullApplyLease(env)).toBe(false);
  });

  it("lease-valid for a well-formed, in-period, dev-signed, device-bound lease", () => {
    writeSignedLease(basePayload());
    const v = readLeaseVerdict(env);
    expect(v.label).toBe("lease-valid");
    expect(v.trust).toBe("dev-lease-root");
    expect(v.allowanceTokens).toBe(2_000_000);
    expect(v.periodId).toBe(currentPeriodId());
    expect(hasValidFullApplyLease(env)).toBe(true);
  });

  it("lease-invalid on a bad signature", () => {
    writeSignedLease(basePayload(), "AAAA");
    expect(readLeaseVerdict(env).label).toBe("lease-invalid");
  });

  it("lease-invalid on a tampered payload (signature no longer covers the bytes)", () => {
    const payload = basePayload();
    const sig = signLeasePayload(payload, signingKeyPem);
    // Tamper the allowance after signing: canonical bytes change → signature fails.
    writeSignedLease({ ...payload, allowance_tokens: 9_999_999 }, sig);
    expect(readLeaseVerdict(env).label).toBe("lease-invalid");
  });

  it("lease-invalid on malformed JSON / missing fields", () => {
    writeFileSync(leasePath(env), "{ not json");
    expect(readLeaseVerdict(env).label).toBe("lease-invalid");
    writeFileSync(leasePath(env), JSON.stringify({ lease: { schema_version: 1 }, signature: "x" }));
    expect(readLeaseVerdict(env).label).toBe("lease-invalid");
  });

  it("lease-wrong-device when the lease binds to a different device key hash", () => {
    writeSignedLease(basePayload({ device_public_key_hash: publicKeyHash("some-other-device-key") }));
    expect(readLeaseVerdict(env).label).toBe("lease-wrong-device");
  });

  it("lease-wrong-period when the period is a different month", () => {
    writeSignedLease(basePayload({ period_id: "2000-01" }));
    expect(readLeaseVerdict(env).label).toBe("lease-wrong-period");
  });

  it("lease-expired when past expires_at (same period)", () => {
    // Use a fixed clock so period matches but expiry has passed.
    const now = new Date("2026-07-15T00:00:00Z");
    const issued = new Date("2026-07-14T00:00:00Z");
    const expired = new Date("2026-07-14T12:00:00Z");
    const payload = basePayload({
      period_id: "2026-07",
      issued_at: issued.toISOString(),
      expires_at: expired.toISOString()
    });
    writeSignedLease(payload);
    expect(readLeaseVerdict(env, now).label).toBe("lease-expired");
  });

  /**
   * ENTITLEMENT AND BALANCE ARE TWO QUESTIONS.
   *
   * A zero carried allowance used to END the verification chain as `allowance-exhausted` — a terminal
   * verdict every caller reads as "not entitled". That is the right answer for the metered api-key
   * route and the wrong one for the subscription route, whose full apply consumes no allowance: the
   * tier clamp and the gateway's route-blind entitlement gate both withdrew full apply from traffic
   * that owes the allowance nothing. The zero is now a FACT on a VALID verdict, and the route decides.
   */
  it("a zero carried allowance is a spent METERED BALANCE, not a withdrawn entitlement", () => {
    writeSignedLease(basePayload({ allowance_tokens: 0 }));
    const v = readLeaseVerdict(env);
    expect(v.label).toBe("lease-valid");
    expect(v.meteredBalanceExhausted).toBe(true);
    // The snapshot the metered route refuses on, and the period a surface names the reset date from.
    expect(v.allowanceTokens).toBe(0);
    expect(v.periodId).toBe(currentPeriodId());
    // Still entitled: subscription-route full apply runs on exactly this lease.
    expect(hasValidFullApplyLease(env)).toBe(true);
  });

  it("a positive allowance carries no exhaustion flag at all (never a fabricated pause)", () => {
    writeSignedLease(basePayload({ allowance_tokens: 1 }));
    expect(readLeaseVerdict(env).meteredBalanceExhausted).toBeUndefined();
  });

  /**
   * The balance is reported ONLY behind the full entitlement chain. A lease that fails signature,
   * device binding, period, or expiry must not leak a balance fact a caller could act on — those are
   * fail-closed on BOTH routes, and this is what keeps "exhausted balance" from ever being confused
   * with "no entitlement".
   */
  it("never reports a balance on a verdict that is not lease-valid", () => {
    writeSignedLease(basePayload({ allowance_tokens: 0, device_public_key_hash: publicKeyHash(generateDeviceKeyPair().publicKey) }));
    const wrongDevice = readLeaseVerdict(env);
    expect(wrongDevice.label).toBe("lease-wrong-device");
    expect(wrongDevice.meteredBalanceExhausted).toBeUndefined();
    expect(wrongDevice.allowanceTokens).toBeUndefined();

    writeSignedLease(basePayload({ allowance_tokens: 0 }), "bad-signature");
    const invalid = readLeaseVerdict(env);
    expect(invalid.label).toBe("lease-invalid");
    expect(invalid.meteredBalanceExhausted).toBeUndefined();
  });

  it("lease-invalid when not logged in (no credentials file to bind against)", () => {
    rmSync(join(dir, "credentials.json"), { force: true });
    writeSignedLease(basePayload());
    expect(readLeaseVerdict(env).label).toBe("lease-invalid");
  });

  it("lease-invalid when NO trust root is installed (fail-closed; pinned root is a placeholder)", () => {
    rmSync(devLeaseRootKeyPath(env), { force: true });
    writeSignedLease(basePayload());
    // With no dev root and the pinned production root a refused placeholder, nothing verifies.
    expect(readLeaseVerdict(env).label).toBe("lease-invalid");
  });

  it("never throws on arbitrary garbage input", () => {
    for (const junk of ["", "null", "[]", "42", '{"lease":null}', '{"lease":{},"signature":123}']) {
      writeFileSync(leasePath(env), junk);
      expect(() => readLeaseVerdict(env)).not.toThrow();
      expect(readLeaseVerdict(env).label).not.toBe("lease-valid");
    }
  });
});
