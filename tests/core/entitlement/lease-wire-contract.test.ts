/**
 * Lease wire-contract pins — the FROZEN bytes both the client verifier and the self-contained
 * control-plane signer must produce. The server (`apps/control-plane/src/leases.ts`) re-implements
 * `canonicalLeaseBytes` independently (it may not import `src/`); its own test pins the SAME literal.
 * If either side reorders a field or drops the domain tag, one of these vectors breaks.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalLeaseBytes, parseSignedLease, type LeasePayload } from "../../../src/core/entitlement/lease.js";
import { publicKeyHash } from "../../../src/core/crypto/key-hash.js";
import {
  generateDevLeaseSigningKeyPair,
  signLeasePayload
} from "../../../src/core/entitlement/dev-lease-signing.js";
import { verifyLeaseSignatureBytes } from "../../../src/core/entitlement/lease-roots.js";
import { publicKeyFromSpkiB64u, verifyDetachedSignature } from "../../../src/core/crypto/ed25519.js";

const FIXTURE: LeasePayload = {
  schema_version: 1,
  lease_id: "11111111-1111-1111-1111-111111111111",
  account_id: "acct-1",
  device_public_key_hash: "a".repeat(64),
  period_id: "2026-07",
  allowance_tokens: 2_000_000,
  issued_at: "2026-07-01T00:00:00.000Z",
  expires_at: "2026-07-02T00:00:00.000Z",
  lease_sequence: 3,
  route_scope: "all"
};

// The EXACT frozen serialization: domain tag + "\n" + JSON with keys in the pinned order. Written by
// hand so a reordering in `canonicalLeaseBytes` breaks this literal.
const EXPECTED_CANONICAL =
  "compaction-lease-v1\n" +
  '{"schema_version":1,"lease_id":"11111111-1111-1111-1111-111111111111","account_id":"acct-1",' +
  '"device_public_key_hash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",' +
  '"period_id":"2026-07","allowance_tokens":2000000,"issued_at":"2026-07-01T00:00:00.000Z",' +
  '"expires_at":"2026-07-02T00:00:00.000Z","lease_sequence":3,"route_scope":"all"}';

// v2 = the same ten keys, with `period_allowance_tokens` APPENDED last. Written out in full rather
// than derived from EXPECTED_CANONICAL, so an accidental reorder cannot be masked by a shared prefix.
const FIXTURE_V2: LeasePayload = { ...FIXTURE, schema_version: 2, period_allowance_tokens: 50_000_000 };
const EXPECTED_CANONICAL_V2 =
  "compaction-lease-v1\n" +
  '{"schema_version":2,"lease_id":"11111111-1111-1111-1111-111111111111","account_id":"acct-1",' +
  '"device_public_key_hash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",' +
  '"period_id":"2026-07","allowance_tokens":2000000,"issued_at":"2026-07-01T00:00:00.000Z",' +
  '"expires_at":"2026-07-02T00:00:00.000Z","lease_sequence":3,"route_scope":"all",' +
  '"period_allowance_tokens":50000000}';

describe("lease wire contract (frozen)", () => {
  it("canonicalLeaseBytes produces the exact frozen bytes (domain tag + fixed key order)", () => {
    expect(canonicalLeaseBytes(FIXTURE).toString("utf8")).toBe(EXPECTED_CANONICAL);
  });

  it("v2 appends period_allowance_tokens and changes nothing before it", () => {
    expect(canonicalLeaseBytes(FIXTURE_V2).toString("utf8")).toBe(EXPECTED_CANONICAL_V2);
  });

  it("v1 bytes are UNCHANGED by v2 existing - every lease already signed still verifies", () => {
    // The whole reason the field is appended and version-gated. If `canonicalLeaseBytes` ever
    // serialized it unconditionally, this fails and so would every stored v1 lease on every device.
    const bytes = canonicalLeaseBytes(FIXTURE).toString("utf8");
    expect(bytes).not.toContain("period_allowance_tokens");
    expect(bytes.length).toBe(EXPECTED_CANONICAL.length);
  });

  it("a v1 payload carrying a total, or a v2 payload missing one, is refused", () => {
    // A v1 lease with a total would be claiming its signature covers bytes it does not cover; a v2
    // lease without one would render a countdown with no denominator.
    const v1WithTotal = { ...FIXTURE, period_allowance_tokens: 1 };
    const v2NoTotal: Record<string, unknown> = { ...FIXTURE_V2 };
    delete v2NoTotal.period_allowance_tokens;
    expect(parseSignedLease({ lease: v1WithTotal, signature: "sig" })).toBeUndefined();
    expect(parseSignedLease({ lease: v2NoTotal, signature: "sig" })).toBeUndefined();
    expect(parseSignedLease({ lease: { ...FIXTURE_V2, schema_version: 3 }, signature: "sig" })).toBeUndefined();
    // Both supported versions round-trip.
    expect(parseSignedLease({ lease: FIXTURE, signature: "sig" })?.lease.period_allowance_tokens).toBeUndefined();
    expect(parseSignedLease({ lease: FIXTURE_V2, signature: "sig" })?.lease.period_allowance_tokens).toBe(50_000_000);
  });

  it("publicKeyHash matches a plain SHA-256 hex of the key string (server parity)", () => {
    const key = "SOME-BASE64URL-SPKI-KEY";
    const expected = createHash("sha256").update(key, "utf8").digest("hex");
    expect(publicKeyHash(key)).toBe(expected);
    // Pinned vector (must equal apps/control-plane/src/device-keys.ts#publicKeyHash on the same input).
    expect(publicKeyHash("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });

  it("a dev-signed lease verifies against the matching dev root; a wrong key does not", () => {
    const signer = generateDevLeaseSigningKeyPair();
    const other = generateDevLeaseSigningKeyPair();
    const sig = signLeasePayload(FIXTURE, signer.privateKeyPem);
    const bytes = canonicalLeaseBytes(FIXTURE);
    // No pinned root is minted; the pinned path fails closed. Verify that the raw signature verifies
    // against the signer's key and NOT the other key via the shared primitive.
    expect(verifyDetachedSignature(bytes, sig, publicKeyFromSpkiB64u(signer.publicKeySpkiB64u)!)).toBe(true);
    expect(verifyDetachedSignature(bytes, sig, publicKeyFromSpkiB64u(other.publicKeySpkiB64u)!)).toBe(false);
    // With no root installed the high-level verifier fails closed (placeholder pinned root).
    expect(verifyLeaseSignatureBytes(bytes, sig, { COMPACTION_CONFIG_DIR: "/nonexistent-xyz" }).verified).toBe(false);
  });

  it("parseSignedLease round-trips a signed lease and rejects a malformed one", () => {
    const sig = signLeasePayload(FIXTURE, generateDevLeaseSigningKeyPair().privateKeyPem);
    expect(parseSignedLease({ lease: FIXTURE, signature: sig })?.lease.lease_id).toBe(FIXTURE.lease_id);
    expect(parseSignedLease({ lease: FIXTURE })).toBeUndefined();
    expect(parseSignedLease(null)).toBeUndefined();
  });
});
