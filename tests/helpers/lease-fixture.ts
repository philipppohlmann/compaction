/**
 * Test helper: provision a VALID dev-signed entitlement lease into a config dir.
 *
 * Writes the files the pure lease-store verifies against — a dev lease root, a credentials file
 * carrying a device key pair, and a device-bound, in-period, dev-signed lease — plus the
 * persisted product mode, so a gateway apply test (or any surface gated on `community_full_apply`)
 * can exercise the entitled path. All local, no network. Returns the env to hand to `entitlementEnv`
 * (gateway) or as `COMPACTION_CONFIG_DIR`.
 *
 * The product mode defaults to `full` because the apply gate requires THREE independent conditions
 * (stored authorization + valid lease + effective mode `full`). Pass `productMode: "observe"` /
 * `"basic"` to prove the mode gate declines, or `null` to leave no persisted mode at all.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateDevLeaseSigningKeyPair, signLeasePayload } from "../../src/core/entitlement/dev-lease-signing.js";
import { currentPeriodId, type LeasePayload } from "../../src/core/entitlement/lease.js";
import { leasePath } from "../../src/core/entitlement/lease-store.js";
import { devLeaseRootKeyPath } from "../../src/core/entitlement/lease-roots.js";
import { publicKeyHash } from "../../src/core/crypto/key-hash.js";
import { generateDeviceKeyPair } from "../../src/core/auth/device-flow.js";
import { writeProductMode, type ProductMode } from "../../src/core/onboarding-preferences.js";

/** Provision a valid dev-signed lease under `configDir`; returns `{ COMPACTION_CONFIG_DIR }`. */
export function provisionValidLease(
  configDir: string,
  overrides: Partial<LeasePayload> = {},
  options: { productMode?: ProductMode | null } = {}
): { COMPACTION_CONFIG_DIR: string } {
  const env = { COMPACTION_CONFIG_DIR: configDir };
  const signer = generateDevLeaseSigningKeyPair();
  mkdirSync(join(configDir, "entitlement"), { recursive: true });
  writeFileSync(devLeaseRootKeyPath(env), `${signer.publicKeySpkiB64u}\n`);

  // A REAL device key pair: the private key is load-bearing for usage metering (the gateway signs
  // each debit with it). Writing the real key is strictly more realistic and harmless to lease tests
  // (which only ever read the public key). Both halves come from ONE keypair so the hash stays consistent.
  const deviceKeyPair = generateDeviceKeyPair();
  const devicePublicKey = deviceKeyPair.publicKey;
  writeFileSync(
    join(configDir, "credentials.json"),
    JSON.stringify({
      schema_version: 1,
      api_url: "http://127.0.0.1:0",
      account_id: "acct-test",
      device_id: "dev-test",
      device_token: "cmpd_test_x",
      device_private_key_pem: deviceKeyPair.privateKeyPem,
      device_public_key: devicePublicKey,
      created_at: new Date().toISOString()
    })
  );

  const now = Date.now();
  // v2 BY DEFAULT, because that is what the control plane now issues: the signed period TOTAL travels
  // with the remainder so a countdown has a denominator it did not invent. `allowance_tokens` stays the
  // remainder every existing override adjusts; the total is separate and defaults to the same 2M limit.
  const payload: LeasePayload = {
    schema_version: 2,
    lease_id: "00000000-0000-0000-0000-0000000000aa",
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
  // A caller that deliberately pins v1 gets a REAL v1 lease. The total is a v2-only field — the parser
  // refuses a v1 payload that carries one — so leaving the default in place would hand such a test an
  // unparseable lease instead of the older wire format it asked for.
  if (payload.schema_version === 1) delete payload.period_allowance_tokens;
  writeFileSync(leasePath(env), JSON.stringify({ lease: payload, signature: signLeasePayload(payload, signer.privateKeyPem) }));

  // The apply gate also requires the persisted product mode to resolve to `full` (a user in
  // observe/basic never receives model-visible mutations). Default the fixture to an entitled,
  // full-mode device; `null` leaves no persisted mode (which clamps to observe).
  const productMode = options.productMode === undefined ? "full" : options.productMode;
  if (productMode !== null) writeProductMode(productMode, env);
  return env;
}
