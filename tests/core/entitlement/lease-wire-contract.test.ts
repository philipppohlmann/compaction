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

describe("lease wire contract (frozen)", () => {
  it("canonicalLeaseBytes produces the exact frozen bytes (domain tag + fixed key order)", () => {
    expect(canonicalLeaseBytes(FIXTURE).toString("utf8")).toBe(EXPECTED_CANONICAL);
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
