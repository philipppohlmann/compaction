/**
 * The two trust roots must stay two.
 *
 * The product signs two completely different things with two completely different keys: an
 * ENTITLEMENT LEASE (`core/entitlement/lease-roots.ts`) says an account may run full apply, and an
 * ENGINE RELEASE MANIFEST (`core/engine-install/manifest.ts`) says a binary is the one we built.
 * The security invariant behind that split is blunt: a lease root must not be able to sign an engine
 * artifact, and an engine root must not be able to sign a lease. Compromising the key that hands out
 * entitlements must not also hand the attacker code execution on every device.
 *
 * WHY THIS TEST EXISTS SEPARATELY FROM THE TWO VERIFIER TEST FILES. Each verifier is already tested
 * against a FOREIGN key and refuses it. But "foreign" is only meaningful if the other root is
 * foreign — and nothing, until this file, said so. Both roots are minted by one script, into one
 * directory, as two files whose names differ by a word; pinning the same public key into both lists
 * (a copy-paste at the pinning step, a re-mint that reuses a keypair) would leave every existing
 * test green and silently collapse two trust domains into one. That is the failure this catches, and
 * it is a failure of the PINNED VALUES, not of any code path — so it is asserted about the values.
 *
 * WHY IT DOES NOT SIGN ANYTHING. Demonstrating the invariant directly — signing a manifest with the
 * lease key and watching the engine verifier refuse it — needs the production PRIVATE keys, which
 * exist only outside this repository and must never enter it. So the property is decomposed into the
 * two halves that ARE checkable from the public material:
 *
 *   1. HERE: the pinned root sets are disjoint, and each is non-empty (a vacuous "no overlap between
 *      two empty lists" would otherwise pass forever).
 *   2. ALREADY COVERED, in `engine-install/verify.test.ts` and `entitlement/lease-wire-contract.test.ts`:
 *      each verifier accepts ONLY signatures made by a key in its own pinned list.
 *
 * Disjoint lists plus own-list-only verification is exactly the invariant. Neither half alone is.
 */
import { describe, expect, it } from "vitest";

import { LEASE_ROOT_KEYS, pinnedLeaseRootKeys } from "../../src/core/entitlement/lease-roots.js";
import { ENGINE_ROOT_KEYS, pinnedRootKeys } from "../../src/core/engine-install/manifest.js";

describe("lease and engine trust roots are two separate domains", () => {
  it("both root sets are pinned and non-empty, so the disjointness below is not vacuous", () => {
    expect(pinnedLeaseRootKeys().length).toBeGreaterThan(0);
    expect(pinnedRootKeys().length).toBeGreaterThan(0);
  });

  it("no public key is pinned as both a lease root and an engine root", () => {
    const leaseKeys = new Set(LEASE_ROOT_KEYS.map((root) => root.public_key_spki_b64u));
    const shared = ENGINE_ROOT_KEYS.filter((root) => leaseKeys.has(root.public_key_spki_b64u));
    expect(shared).toEqual([]);
  });

  it("no key id is shared either, so neither root can be mistaken for the other in a log or a bug report", () => {
    const leaseIds = new Set(LEASE_ROOT_KEYS.map((root) => root.key_id));
    expect(ENGINE_ROOT_KEYS.filter((root) => leaseIds.has(root.key_id))).toEqual([]);
  });
});
