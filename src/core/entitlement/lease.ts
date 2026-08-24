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
 * Wire contract (v1) — the signed bytes are the ASCII domain tag `compaction-lease-v1` + "\n" +
 * `JSON.stringify(payload)` with keys in EXACTLY this order:
 *   schema_version, lease_id, account_id, device_public_key_hash, period_id, allowance_tokens,
 *   issued_at, expires_at, lease_sequence, route_scope
 * The domain tag provides cryptographic domain separation: a lease signature can never be a valid
 * engine-manifest signature (different tag, different roots).
 */

/** The frozen wire schema version. */
export const LEASE_SCHEMA_VERSION = 1 as const;

/** Domain-separation tag prefixed to the signed bytes (never a valid engine-manifest prefix). */
export const LEASE_SIGNING_DOMAIN = "compaction-lease-v1";

/**
 * Route scope the lease is valid for. `all` (v1) = both api-key and subscription routes may present
 * the lease; the subscription **no-debit** rule is enforced at the gate by route_type, NOT by scope.
 */
export const LEASE_ROUTE_SCOPES = ["all"] as const;
export type LeaseRouteScope = (typeof LEASE_ROUTE_SCOPES)[number];

/** The signed lease payload. Field order in `canonicalLeaseBytes` is FROZEN (schema v1). */
export interface LeasePayload {
  schema_version: typeof LEASE_SCHEMA_VERSION;
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
    route_scope: payload.route_scope
  };
  return Buffer.from(`${LEASE_SIGNING_DOMAIN}\n${JSON.stringify(ordered)}`, "utf8");
}

/** Parse+validate a lease payload object. Returns `undefined` on anything malformed (never throws). */
export function parseLeasePayload(raw: unknown): LeasePayload | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (r.schema_version !== LEASE_SCHEMA_VERSION) return undefined;
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
    schema_version: LEASE_SCHEMA_VERSION,
    lease_id: r.lease_id,
    account_id: r.account_id,
    device_public_key_hash: r.device_public_key_hash,
    period_id: r.period_id,
    allowance_tokens: r.allowance_tokens,
    issued_at: r.issued_at,
    expires_at: r.expires_at,
    lease_sequence: r.lease_sequence,
    route_scope: r.route_scope as LeaseRouteScope
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
