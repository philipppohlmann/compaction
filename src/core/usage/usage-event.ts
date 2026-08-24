/**
 * Optimized-input-v1 usage event — shared payload shape + canonical signing bytes (PUBLIC client).
 *
 * A usage event is a small CONTENT-FREE record of ONE metered Community full-apply on the API-key
 * route (metering `optimized-input-v1`, FROZEN). This module owns the
 * canonical byte serialization the DEVICE signature covers and the frozen meter-version + signing-
 * domain constants. It is import-safe on any graph: no fs, no network, no engine, no account import.
 *
 * CONTENT-FREE: identity + counts + labels + timestamps only — never request/prompt/response content.
 * The ids it carries (`event_id`, `receipt_id`, `lease_id`, `device_id`) live in the SEPARATE usage
 * journal; they are NEVER rendered in the content-free gateway receipt.
 *
 * PRODUCT-METER ≠ PROVIDER BILL: `optimized_input_tokens` is a PRODUCT ALLOWANCE unit, distinct from
 * provider billing tokens. It must never feed a cost / savings / reduction claim.
 *
 * LOCAL ESTIMATE: `optimized_input_tokens` is a `chars/4` LOCAL-ESTIMATE token count (the engine's
 * `composedInputEstimate.before`), never a provider-reported or billing figure. Every surface that
 * renders it must label it as a local estimate — this repo's standing convention for chars/4 counts.
 *
 * Wire contract (v1) — the signed bytes are the ASCII domain tag `compaction-usage-v1` + "\n" +
 * `JSON.stringify(payload)` with keys in EXACTLY this order:
 *   schema_version, event_id, receipt_id, lease_id, lease_sequence, device_id, device_key_hash,
 *   period_id, occurred_at, route_type, workflow, provider, meter_version, optimized_input_tokens,
 *   estimated_input_tokens_after
 * The domain tag provides cryptographic domain separation from `compaction-lease-v1` (leases) and any
 * engine-manifest tag: a usage signature can never be replayed as a lease or manifest signature.
 *
 * `device_key_hash` binds each entry to the key that SIGNED it, so a legitimate device-key rotation
 * (`compaction logout` + fresh `login`) reads as "unverifiable — device rotated" rather than as
 * tampering, and the consumption history survives the rotation.
 */

/** The frozen wire schema version. */
export const USAGE_EVENT_SCHEMA_VERSION = 1 as const;

/** Domain-separation tag prefixed to the signed bytes (distinct from lease / engine-manifest tags). */
export const USAGE_SIGNING_DOMAIN = "compaction-usage-v1";

/**
 * FROZEN meter version. Stamped on every engine-authoritative event. A
 * meter definition change requires a NEW version (`optimized-input-v2`); v1 is frozen under this name.
 */
export const USAGE_METER_VERSION = "optimized-input-v1";

/**
 * DISTINCT fallback meter version, used ONLY when the engine omits `metered_optimized_input_tokens`
 * and the client falls back to a deterministic `ceil(chars/4)` estimate of the pre-mutation body. The
 * distinct label guarantees a fallback count is never reported as the engine-authoritative meter. The
 * interim engine always reports the count today, so this is a defensive path, not the norm.
 */
export const USAGE_METER_VERSION_FALLBACK = "optimized-input-v1-fallback-chars4";

/** Approx chars-per-token used ONLY by the documented fallback estimate (mirrors token-estimator.ts). */
const FALLBACK_APPROX_CHARS_PER_TOKEN = 4;

/** The only route that is ever metered/debited. Subscription apply runs unmetered. */
export const METERED_ROUTE_TYPE = "api-key";

/** The signed usage-event payload. Field order in `canonicalUsageEventBytes` is FROZEN (schema v1). */
export interface UsageEvent {
  schema_version: typeof USAGE_EVENT_SCHEMA_VERSION;
  /** Client-minted uuid — the authoritative id for the signed hash chain + the debit. */
  event_id: string;
  /** Content-free local id linking the event to the retained-original / apply receipt. */
  receipt_id: string;
  /** Opaque lease id the apply rode on (content-free; journal-only, NEVER rendered in receipts). */
  lease_id: string;
  /** Monotonic per-device lease sequence carried in the signed lease (anti-rollback signal). */
  lease_sequence: number;
  /** This device's id (content-free; journal-only, NEVER rendered in receipts). */
  device_id: string;
  /**
   * SHA-256 hex of the device PUBLIC key that signed this entry. Binds the signature to a specific
   * device key so a legitimate rotation is distinguishable from tampering (an entry whose key hash
   * differs from the current device key is "unverifiable — device rotated", not a signature failure).
   */
  device_key_hash: string;
  /** Server-authoritative period, `YYYY-MM` (UTC) — the allowance window this debit counts against. */
  period_id: string;
  /** RFC3339 UTC time the apply was confirmed (injected clock — deterministic in tests). */
  occurred_at: string;
  /** Content-free route label — always `api-key` for a metered event (subscription is never metered). */
  route_type: string;
  /** Content-free workflow/tool label (e.g. "claude-code" | "codex" | "cursor"). */
  workflow: string;
  /** Content-free provider label (e.g. "openai" | "anthropic"). */
  provider: string;
  /** The meter version stamped on this event (`optimized-input-v1` or the distinct fallback label). */
  meter_version: string;
  /**
   * PRODUCT ALLOWANCE unit: pre-mutation model-visible input tokens metered. A `chars/4` LOCAL
   * ESTIMATE — NOT a provider bill and NOT a provider-reported count.
   */
  optimized_input_tokens: number;
  /** Local estimate of model-visible input tokens after the mutation (counts only; never a claim). */
  estimated_input_tokens_after: number;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * The canonical bytes the DEVICE signature covers — fixed key order + the `compaction-usage-v1`
 * domain tag. Signer and verifier MUST both produce these exact bytes.
 */
export function canonicalUsageEventBytes(event: UsageEvent): Buffer {
  const ordered = {
    schema_version: event.schema_version,
    event_id: event.event_id,
    receipt_id: event.receipt_id,
    lease_id: event.lease_id,
    lease_sequence: event.lease_sequence,
    device_id: event.device_id,
    device_key_hash: event.device_key_hash,
    period_id: event.period_id,
    occurred_at: event.occurred_at,
    route_type: event.route_type,
    workflow: event.workflow,
    provider: event.provider,
    meter_version: event.meter_version,
    optimized_input_tokens: event.optimized_input_tokens,
    estimated_input_tokens_after: event.estimated_input_tokens_after
  };
  return Buffer.from(`${USAGE_SIGNING_DOMAIN}\n${JSON.stringify(ordered)}`, "utf8");
}

/** The documented deterministic fallback token estimate (used only when the engine omits its count). */
export function fallbackOptimizedInputTokens(preMutationBody: string): number {
  return Math.max(1, Math.ceil(preMutationBody.length / FALLBACK_APPROX_CHARS_PER_TOKEN));
}

/**
 * Resolve the metered count + its meter version from an engine apply result — the SINGLE resolution
 * used by BOTH the gateway's pre-commit ceiling check and the journal commit, so the number the gate
 * refuses on can never drift from the number the journal records.
 *
 * Engine-authoritative when present; otherwise the documented `ceil(chars/4)` fallback stamped with
 * the DISTINCT fallback meter version (so a fallback count is never reported as the engine meter).
 */
export function resolveMeteredOptimizedInput(input: {
  meterVersion?: string;
  meteredOptimizedInputTokens?: number;
  preMutationBody: string;
}): { tokens: number; meterVersion: string } {
  if (
    typeof input.meteredOptimizedInputTokens === "number" &&
    Number.isInteger(input.meteredOptimizedInputTokens) &&
    input.meteredOptimizedInputTokens >= 0
  ) {
    return { tokens: input.meteredOptimizedInputTokens, meterVersion: input.meterVersion ?? USAGE_METER_VERSION };
  }
  return {
    tokens: fallbackOptimizedInputTokens(input.preMutationBody),
    meterVersion: USAGE_METER_VERSION_FALLBACK
  };
}

/** Parse+validate a usage-event payload object. Returns `undefined` on anything malformed (never throws). */
export function parseUsageEvent(raw: unknown): UsageEvent | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (r.schema_version !== USAGE_EVENT_SCHEMA_VERSION) return undefined;
  if (!isNonEmptyString(r.event_id)) return undefined;
  if (!isNonEmptyString(r.receipt_id)) return undefined;
  if (!isNonEmptyString(r.lease_id)) return undefined;
  if (!isNonNegativeInt(r.lease_sequence)) return undefined;
  if (!isNonEmptyString(r.device_id)) return undefined;
  if (typeof r.device_key_hash !== "string" || !/^[0-9a-f]{64}$/.test(r.device_key_hash)) return undefined;
  if (typeof r.period_id !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(r.period_id)) return undefined;
  if (!isNonEmptyString(r.occurred_at) || Number.isNaN(Date.parse(r.occurred_at))) return undefined;
  if (!isNonEmptyString(r.route_type)) return undefined;
  if (!isNonEmptyString(r.workflow)) return undefined;
  if (!isNonEmptyString(r.provider)) return undefined;
  if (!isNonEmptyString(r.meter_version)) return undefined;
  if (!isNonNegativeInt(r.optimized_input_tokens)) return undefined;
  if (!isNonNegativeInt(r.estimated_input_tokens_after)) return undefined;
  return {
    schema_version: USAGE_EVENT_SCHEMA_VERSION,
    event_id: r.event_id,
    receipt_id: r.receipt_id,
    lease_id: r.lease_id,
    lease_sequence: r.lease_sequence,
    device_id: r.device_id,
    device_key_hash: r.device_key_hash,
    period_id: r.period_id,
    occurred_at: r.occurred_at,
    route_type: r.route_type,
    workflow: r.workflow,
    provider: r.provider,
    meter_version: r.meter_version,
    optimized_input_tokens: r.optimized_input_tokens,
    estimated_input_tokens_after: r.estimated_input_tokens_after
  };
}
