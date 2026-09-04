/**
 * Signed entitlement lease — shared payload shape + canonical signing bytes (PUBLIC client).
 *
 * A lease is a small content-free document the control plane SIGNS (Ed25519) to grant a Community
 * device a bounded full-apply entitlement for one server-authoritative UTC period. This module owns
 * the CLIENT half: the payload type, the FROZEN canonical byte serialization the signature covers,
 * and a fail-closed parser. The SERVER half re-implements `canonicalLeaseBytes` identically
 * (`apps/control-plane/src/leases.ts`, self-contained package) against the SAME frozen wire
 * contract; a pinned byte-vector test on both sides catches any drift.
 *
 * Content-free: identity + counts + timestamps + a device-key hash only — never request content,
 * never a credential. Import-safe on the Open path (no fs/network/engine/account import here).
 *
 * Wire contract — the signed bytes are the ASCII domain tag `compaction-lease-v1` + "\n" +
 * `JSON.stringify(payload)` with keys in EXACTLY this order:
 *   v1: schema_version, lease_id, account_id, device_public_key_hash, period_id, allowance_tokens,
 *       issued_at, expires_at, lease_sequence, route_scope
 *   v2: ...the same ten, then period_allowance_tokens APPENDED last.
 * v1's bytes are unchanged by v2's existence — the new field is serialized only for a payload that
 * declares itself v2 — so every lease already signed still verifies against the same bytes it was
 * signed over. The domain tag provides cryptographic domain separation: a lease signature can never
 * be a valid engine-manifest signature (different tag, different roots).
 */

/**
 * The schema version this client ISSUES nothing at (it only verifies) but treats as current: v2.
 * Kept as the "latest" marker for the server-side mirror and the wire-contract vectors.
 */
export const LEASE_SCHEMA_VERSION = 2 as const;

/**
 * Every schema version a lease on disk may declare. BOTH ARE ACCEPTED, deliberately.
 *
 * A device that upgrades the CLI keeps whatever lease it last fetched until the next renew (up to one
 * 24h TTL), so rejecting v1 would refuse a valid, signed, in-date entitlement and pause input
 * optimization for a day on every upgrading device — a self-inflicted outage in exchange for a
 * cosmetic denominator. v2 adds ONE reporting-only field (`period_allowance_tokens`, the period total
 * a countdown needs a denominator for); it grants nothing, so a v1 lease is not a weaker grant, it is
 * the same grant with no total to render. Surfaces that want the total must handle its absence.
 */
export const SUPPORTED_LEASE_SCHEMA_VERSIONS: ReadonlySet<number> = new Set([1, 2]);

/** Domain-separation tag prefixed to the signed bytes (never a valid engine-manifest prefix). */
export const LEASE_SIGNING_DOMAIN = "compaction-lease-v1";

/**
 * Route scope the lease is valid for. `all` (v1) = every supported upstream route may present the
 * lease, and every one of them SPENDS it: the allowance pays for use of the Hybrid Engine, not for the
 * billing route the provider traffic takes. `all` is therefore the only scope the product has a use
 * for, and the field survives as a wire slot for a future grant that is genuinely narrower.
 *
 * What decides a debit is `compactsInput` at the gate — INPUT was compacted — never `route_type`, which
 * is recorded on the usage entry and consulted for nothing. Output shaping is never metered, on any
 * route. (This comment previously described a subscription **no-debit** rule enforced at the gate by
 * route_type; that rule was removed on 2026-08-27 — see `commercial-boundary-v1` §1.2/§3, amended.)
 */
export const LEASE_ROUTE_SCOPES = ["all"] as const;
export type LeaseRouteScope = (typeof LEASE_ROUTE_SCOPES)[number];

/** The signed lease payload. Field order in `canonicalLeaseBytes` is FROZEN per schema version. */
export interface LeasePayload {
  schema_version: 1 | 2;
  /** Opaque lease id (uuid). Content-free; NEVER rendered in receipts/logs. */
  lease_id: string;
  account_id: string;
  /** SHA-256 hex of the device public key — binds the lease to ONE device. */
  device_public_key_hash: string;
  /** Server-authoritative period, `YYYY-MM` (UTC). */
  period_id: string;
  /** Locally-allocated allowance carried IN the lease (server-movable without a client change). */
  allowance_tokens: number;
  /** RFC3339 UTC issue time. */
  issued_at: string;
  /** RFC3339 UTC expiry (hard bound — no client-side post-expiry grace in v1). */
  expires_at: string;
  /** Monotonic per-device sequence — supersession / anti-rollback signal. */
  lease_sequence: number;
  route_scope: LeaseRouteScope;
  /**
   * v2 ONLY (absent on a v1 lease): the period's TOTAL optimized-input allowance — the account's
   * resolved entitlement limit for `period_id`, BEFORE any consumption is subtracted.
   *
   * WHY IT HAD TO BE SIGNED. `allowance_tokens` above is the REMAINDER, already net of what the server
   * has recorded, so a client holding only that has no denominator: it can say how much is left but not
   * out of what. It also cannot derive the total by adding its own journal back, because
   * `sumUsageDebitsForPeriod` is ACCOUNT-scoped — another device's debits shrink this device's
   * remainder invisibly, so `remainder + local journal` under-reports the total by exactly the other
   * devices' usage, and the countdown would silently shrink its own denominator. The total is a fact
   * only the server holds, so the server states it, signed, in the same document as the remainder.
   *
   * REPORTING-ONLY. Nothing enforces against it — the ceiling is `allowance_tokens` and the journal,
   * exactly as before. Its whole job is to be the `N/TOTAL left` denominator.
   */
  period_allowance_tokens?: number;
}

/** On-disk / on-wire signed lease: the payload plus its base64url Ed25519 signature. */
export interface SignedLease {
  lease: LeasePayload;
  /** Base64url raw 64-byte Ed25519 signature over `canonicalLeaseBytes(lease)`. */
  signature: string;
}

const PERIOD_ID_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * The canonical bytes the signature covers. Fixed key order + a domain tag — signer and verifier
 * MUST both produce these exact bytes. (The server re-implements this identically; the byte vector
 * is pinned by a test on each side.)
 */
export function canonicalLeaseBytes(payload: LeasePayload): Buffer {
  const ordered = {
    schema_version: payload.schema_version,
    lease_id: payload.lease_id,
    account_id: payload.account_id,
    device_public_key_hash: payload.device_public_key_hash,
    period_id: payload.period_id,
    allowance_tokens: payload.allowance_tokens,
    issued_at: payload.issued_at,
    expires_at: payload.expires_at,
    lease_sequence: payload.lease_sequence,
    route_scope: payload.route_scope,
    // APPENDED, AND ONLY FOR v2. Serializing it for a v1 payload would change bytes that are already
    // signed, so every stored v1 lease would fail verification the moment this shipped. The key is
    // last so a v3 field can be appended the same way.
    ...(payload.schema_version === 2 ? { period_allowance_tokens: payload.period_allowance_tokens ?? 0 } : {})
  };
  return Buffer.from(`${LEASE_SIGNING_DOMAIN}\n${JSON.stringify(ordered)}`, "utf8");
}

/** Parse+validate a lease payload object. Returns `undefined` on anything malformed (never throws). */
export function parseLeasePayload(raw: unknown): LeasePayload | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.schema_version !== "number" || !SUPPORTED_LEASE_SCHEMA_VERSIONS.has(r.schema_version)) return undefined;
  const schemaVersion = r.schema_version as 1 | 2;
  // v2 MUST carry the total; v1 must NOT. A v2 lease missing it would render a countdown with no
  // denominator, and a v1 lease carrying one would be claiming a signature covers bytes it does not.
  if (schemaVersion === 2 && !isNonNegativeInt(r.period_allowance_tokens)) return undefined;
  if (schemaVersion === 1 && r.period_allowance_tokens !== undefined) return undefined;
  if (!isNonEmptyString(r.lease_id)) return undefined;
  if (!isNonEmptyString(r.account_id)) return undefined;
  if (typeof r.device_public_key_hash !== "string" || !SHA256_HEX_RE.test(r.device_public_key_hash)) return undefined;
  if (typeof r.period_id !== "string" || !PERIOD_ID_RE.test(r.period_id)) return undefined;
  if (!isNonNegativeInt(r.allowance_tokens)) return undefined;
  if (!isNonEmptyString(r.issued_at) || Number.isNaN(Date.parse(r.issued_at))) return undefined;
  if (!isNonEmptyString(r.expires_at) || Number.isNaN(Date.parse(r.expires_at))) return undefined;
  if (!isNonNegativeInt(r.lease_sequence)) return undefined;
  if (!LEASE_ROUTE_SCOPES.includes(r.route_scope as LeaseRouteScope)) return undefined;
  return {
    schema_version: schemaVersion,
    lease_id: r.lease_id,
    account_id: r.account_id,
    device_public_key_hash: r.device_public_key_hash,
    period_id: r.period_id,
    allowance_tokens: r.allowance_tokens,
    issued_at: r.issued_at,
    expires_at: r.expires_at,
    lease_sequence: r.lease_sequence,
    route_scope: r.route_scope as LeaseRouteScope,
    ...(schemaVersion === 2 ? { period_allowance_tokens: r.period_allowance_tokens as number } : {})
  };
}

/** Parse a full signed lease (payload + signature) from an unknown value. Fail-closed. */
export function parseSignedLease(raw: unknown): SignedLease | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const lease = parseLeasePayload(r.lease);
  if (!lease) return undefined;
  if (!isNonEmptyString(r.signature)) return undefined;
  return { lease, signature: r.signature };
}

/** Derive the current UTC period id (`YYYY-MM`) for a given clock (default now). */
export function currentPeriodId(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = `${now.getUTCMonth() + 1}`.padStart(2, "0");
  return `${y}-${m}`;
}

/**
 * The UTC calendar date (`YYYY-MM-DD`) on which a period's allowance resets: 00:00 UTC on the 1st of
 * the month AFTER `periodId`. Pure, clock-free, offline — the only honest reset date a client can
 * state without asking the service.
 *
 * NOT `lease.expires_at`: that is the LEASE's expiry, which is renewed repeatedly WITHIN one period.
 * Presenting it as the allowance reset would tell a user their allowance returns days or weeks before
 * it actually does. The period is the allowance boundary; the lease is not.
 *
 * Returns `undefined` for anything that is not a well-formed `YYYY-MM` — a surface with no valid
 * period says nothing rather than naming a fabricated date.
 */
export function periodEndUtc(periodId: string): string | undefined {
  if (!PERIOD_ID_RE.test(periodId)) return undefined;
  const year = Number(periodId.slice(0, 4));
  const month = Number(periodId.slice(5, 7)); // 1-12
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  return `${nextYear}-${`${nextMonth}`.padStart(2, "0")}-01`;
}
