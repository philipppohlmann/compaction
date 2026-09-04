/**
 * Optimized-input usage event — shared payload shape + canonical signing bytes (PUBLIC client).
 *
 * A usage event is a small CONTENT-FREE record of ONE metered Community full-apply — on ANY supported
 * upstream route (the allowance pays for use of the Hybrid Engine, not for the provider billing
 * route, so `route_type` is RECORDED here and decides nothing). This module owns the canonical byte
 * serialization the DEVICE signature covers, the meter-version vocabulary, and the signing-domain
 * constant. It is import-safe on any graph: no fs, no network, no engine, no account import.
 *
 * THE ACTIVE UNIT IS `optimized-input-v2` (`ACTIVE_USAGE_METER_VERSION`): tokens Compaction REMOVED.
 * `optimized-input-v1` is frozen under its own name and its entries stay audit history — never
 * summed into a v2 balance, never reinterpreted as v2 quantities.
 *
 * CONTENT-FREE: identity + counts + labels + timestamps only — never request/prompt/response content.
 * The ids it carries (`event_id`, `recovery_id` — `receipt_id` on legacy schema v1 —, `lease_id`,
 * `device_id`) live in the SEPARATE usage journal; they are NEVER rendered in the content-free
 * gateway receipt.
 *
 * PRODUCT-METER ≠ PROVIDER BILL: `optimized_input_tokens` is a PRODUCT ALLOWANCE unit, distinct from
 * provider billing tokens. It must never feed a cost / savings / reduction claim.
 *
 * LOCAL ESTIMATE: `optimized_input_tokens` is a `chars/4` LOCAL-ESTIMATE token count — under the
 * active unit, the model-visible input tokens the apply REMOVED (`before - after`, floored at zero,
 * measured before output shaping adds anything). Never a provider-reported or billing figure. Every
 * surface that renders it must label it as a local estimate — this repo's standing convention for
 * chars/4 counts.
 *
 * Wire contract — the signed bytes are the ASCII domain tag `compaction-usage-v1` + "\n" +
 * `JSON.stringify(payload)` with keys in EXACTLY this order:
 *   schema_version, event_id, <recovery-id key>, lease_id, lease_sequence, device_id,
 *   device_key_hash, period_id, occurred_at, route_type, workflow, provider, meter_version,
 *   optimized_input_tokens, estimated_input_tokens_after
 * Schema v3 appends a signed, independently recomputable input-only basis in this order:
 *   optimized_input_tokens, estimated_input_tokens_before, estimated_input_tokens_after
 * Byte position 3 is the ONLY difference between the frozen v1/v2 schema versions: v1 names it
 * `receipt_id`, v2 names it `recovery_id`. The domain tag provides cryptographic domain separation
 * from `compaction-lease-v1` (leases) and any engine-manifest tag: a usage signature can never be
 * replayed as a lease or manifest signature. The tag is NOT a schema version and does not move with
 * one — it separates usage bytes from lease/manifest bytes, which is unchanged by the rename.
 *
 * WHY TWO VERSIONS. The v1 key was a MISNOMER from the first write: the value stored there has
 * always been the RECOVERY id (`.compaction/gateway/recovery/<id>.json`), never a gateway
 * `receipt_id`. Renaming the key in place would change the canonical bytes of every historical
 * entry, so every stored device signature and the whole hash chain would break at once. Instead the
 * misnomer is FROZEN under schema v1 and named truthfully from schema v2 on; `recoveryIdOf` is the
 * one accessor, and it reports which shape the value came from.
 *
 * `device_key_hash` binds each entry to the key that SIGNED it, so a legitimate device-key rotation
 * (`compaction logout` + fresh `login`) reads as "unverifiable — device rotated" rather than as
 * tampering, and the consumption history survives the rotation.
 */

/**
 * The FROZEN legacy wire schema version. Its byte layout — including the misnamed `receipt_id` at
 * byte position 3 — may never change: historical entries are signed and hash-chained over exactly
 * these bytes.
 */
export const USAGE_EVENT_SCHEMA_VERSION = 1 as const;

/**
 * The frozen schema-v2 wire version — identical to v1 except that byte position 3 is named
 * `recovery_id`, which is what the value at that position has always been. v1 and v2 entries
 * coexist in one journal and verify as one unbroken chain, because the
 * serializer branches on this field.
 */
export const USAGE_EVENT_SCHEMA_VERSION_V2 = 2 as const;

/**
 * The CURRENT wire schema version. It keeps v2's truthful `recovery_id` and signs both ends of the
 * `optimized-input-v2` basis: BEFORE input optimization and AFTER input optimization but BEFORE
 * output shaping. The server can therefore recompute the claimed debit without request content.
 */
export const USAGE_EVENT_SCHEMA_VERSION_V3 = 3 as const;

/** Domain-separation tag prefixed to the signed bytes (distinct from lease / engine-manifest tags). */
export const USAGE_SIGNING_DOMAIN = "compaction-usage-v1";

/**
 * FROZEN meter version. Stamped on every engine-authoritative event. A
 * meter definition change requires a NEW version (`optimized-input-v2`); v1 is frozen under this name.
 */
export const USAGE_METER_VERSION = "optimized-input-v1";

/**
 * THE VALUE-BASED METER. One optimized input token = one model-visible input token Compaction actually
 * REMOVED through applied input optimization.
 *
 * v1 metered THROUGHPUT — everything the engine inspected. That basis could charge a large request
 * even when input optimization removed little or nothing.
 *
 * v2 debits `max(0, before - after)` on ONE model-visible basis, measured BEFORE output shaping adds
 * anything. A request Compaction inspects but cannot improve costs ZERO.
 *
 * v1 IS NOT REDEFINED — it is frozen and its history stays labelled v1. The two units are never summed
 * into one balance (see `sumUnreconciledOptimizedInputTokensForPeriod`).
 */
export const USAGE_METER_VERSION_V2 = "optimized-input-v2";

/**
 * DISTINCT fallback meter version, used ONLY when the engine omits `metered_optimized_input_tokens`
 * and the client falls back to a deterministic `ceil(chars/4)` estimate of the pre-mutation body. The
 * distinct label guarantees a fallback count is never reported as the engine-authoritative meter. The
 * interim engine always reports the count today, so this is a defensive path, not the norm.
 */
export const USAGE_METER_VERSION_FALLBACK = "optimized-input-v1-fallback-chars4";

/**
 * THE LABEL FOR A QUANTITY WHOSE UNIT WAS NEVER DECLARED — an engine that reported a count but named
 * no meter version.
 *
 * The engine is installed SEPARATELY from this client (a signed artifact fetched from the control
 * plane, versioned on its own cadence), so a v2 client meeting a pre-v2 engine is an ordinary
 * install state, not an exotic one. That engine reports its count on the v1 THROUGHPUT basis:
 * everything it inspected. Adopting the active unit for an undeclared quantity would write inspected
 * tokens into a journal labelled `optimized-input-v2` and charge them against a removal-denominated
 * balance.
 *
 * So an undeclared unit is named as unplaceable rather than guessed. It is deliberately NOT in
 * `KNOWN_USAGE_METER_VERSIONS`: `appendUsageEvent` refuses it (nothing written) and the gateway's
 * fail-closed path forwards the original unchanged. The user loses input optimization until the
 * engine is updated, and is charged nothing — the honest direction when the unit is unknown.
 */
export const USAGE_METER_VERSION_UNDECLARED = "optimized-input-undeclared";

/**
 * THE UNIT AN ACTIVE BALANCE IS DENOMINATED IN — and the unit this client STAMPS on every
 * engine-authoritative debit it writes. One constant, read by the writer and by the consumption
 * reader alike.
 *
 * It is a single constant BECAUSE the reader and the writer disagreeing is a ceiling BYPASS, not a
 * cosmetic drift: a reader that filters on a unit the writer never stamps computes `consumed = 0`,
 * and the allowance silently stops existing while still looking enforced.
 * Deriving the filter from the journal's own entries instead does not fix it either: it makes the
 * unit depend on what happens to be on disk, which brings its own failure (see
 * `KNOWN_USAGE_METER_VERSIONS`). The invariant that actually holds is that there is ONE name, here.
 */
export const ACTIVE_USAGE_METER_VERSION = USAGE_METER_VERSION_V2;

/**
 * Every meter version this client can PLACE relative to its own active unit — i.e. recognise as a
 * SUPERSEDED quantity whose entries belong to a different balance and are therefore neither summed
 * into the active tally nor reinterpreted as active-unit tokens.
 *
 * WHY A CLOSED LIST RATHER THAN "SKIP ANYTHING THAT IS NOT ACTIVE": skipping every unfamiliar label
 * would make a client that is BEHIND the writer (a downgrade, a mixed install) silently ignore real
 * consumption it cannot interpret, which is the fail-OPEN direction. A version this client has never
 * heard of is an unplaceable quantity, and the only safe reading of an unplaceable quantity is to
 * refuse the tally. Known-older is skippable precisely because the ordering is known here.
 */
export const KNOWN_USAGE_METER_VERSIONS: ReadonlySet<string> = new Set([
  USAGE_METER_VERSION,
  USAGE_METER_VERSION_FALLBACK,
  USAGE_METER_VERSION_V2
]);

/** Approx chars-per-token used ONLY by the documented fallback estimate (mirrors token-estimator.ts). */
const FALLBACK_APPROX_CHARS_PER_TOKEN = 4;

/** The upstream route label for a request the gateway forwards with the user's own provider API key. */
export const API_KEY_ROUTE_TYPE = "api-key";

/** The upstream route label for a request the gateway forwards on a Claude Code subscription session. */
export const SUBSCRIPTION_ROUTE_TYPE = "subscription";

/**
 * THE ROUTES A CONFIRMED HYBRID INPUT APPLY IS DEBITED ON.
 *
 * The Compaction allowance pays for USE OF THE HYBRID ENGINE, not for the provider billing route. A
 * successful input optimization consumed the same engine work whether the turn was forwarded on the
 * user's API key or on a Claude Code subscription session, so both debit the ACTIVE unit. The route
 * widening changed nothing about the meter itself, and OUTPUT SHAPING IS NEVER METERED on any route —
 * under the active unit it is structurally unchargeable, because the measurement point precedes it.
 *
 * It is a CLOSED SET rather than "any non-empty label" for two reasons: it mirrors the
 * `usage_debit.route_type` CHECK constraint (migration 0013), so a label this client would write is
 * always a label the server can store; and an unrecognised label means the route that produced the
 * apply is unknown, which is an integrity signal, not a billing nuance. Extending it is a deliberate
 * act on both sides — the control-plane mirror is cross-checked against this module as text.
 */
export const DEBITABLE_ROUTE_TYPES: ReadonlySet<string> = new Set([API_KEY_ROUTE_TYPE, SUBSCRIPTION_ROUTE_TYPE]);

/**
 * The fields all versions share. Their order is frozen for v1/v2 after the recovery-id key; schema
 * v3 signs one additional before count in its own explicit serializer branch below.
 */
export interface UsageEventCommon {
  /** Client-minted uuid — the authoritative id for the signed hash chain + the debit. */
  event_id: string;
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
  /**
   * Content-free UPSTREAM ROUTE label for the request this apply rode on — one of
   * `DEBITABLE_ROUTE_TYPES`. It RECORDS the route; it does not decide whether the event exists. The
   * field stays a free string in the parser (schema v1 is frozen and this byte position with it), and
   * the closed set is enforced at the write site instead.
   */
  route_type: string;
  /** Content-free workflow/tool label (e.g. "claude-code" | "codex" | "cursor"). */
  workflow: string;
  /** Content-free provider label (e.g. "openai" | "anthropic"). */
  provider: string;
  /**
   * The unit `optimized_input_tokens` is denominated in, as declared by whoever produced the count.
   * Only `ACTIVE_USAGE_METER_VERSION` entries join the active balance; a known superseded label is
   * audit history and an unrecognised one fails the tally closed.
   */
  meter_version: string;
  /**
   * PRODUCT ALLOWANCE unit, in `meter_version`. Under `optimized-input-v2`: the model-visible input
   * tokens this apply REMOVED. A `chars/4` LOCAL ESTIMATE — NOT a provider bill and NOT a
   * provider-reported count.
   */
  optimized_input_tokens: number;
  /** Local estimate of model-visible input tokens after the mutation (counts only; never a claim). */
  estimated_input_tokens_after: number;
}

/**
 * A LEGACY (schema v1) signed usage-event payload. FROZEN: its canonical bytes must keep
 * reproducing byte-for-byte, or every historical device signature and the whole hash chain break.
 */
export interface UsageEventV1 extends UsageEventCommon {
  schema_version: typeof USAGE_EVENT_SCHEMA_VERSION;
  /**
   * LEGACY MISNOMER. This field always held the RECOVERY id — the name of the retained-original
   * record at `.compaction/gateway/recovery/<id>.json` — and NEVER a gateway `receipt_id`. It is
   * never reinterpreted as a receipt id, is never used to look anything up in `receipts.jsonl`, and
   * is never renamed in place. Read it through `recoveryIdOf`, which reports the legacy provenance.
   */
  receipt_id: string;
  /** Structurally excluded: a v1 entry carrying BOTH keys is ambiguous and is rejected by the parser. */
  recovery_id?: never;
  /** Structurally excluded: the recomputation basis was introduced by schema v3. */
  estimated_input_tokens_before?: never;
}

/** A frozen schema-v2 signed payload — the recovery id under its true name. */
export interface UsageEventV2 extends UsageEventCommon {
  schema_version: typeof USAGE_EVENT_SCHEMA_VERSION_V2;
  /**
   * Content-free local id of the retained-original record this debit belongs to
   * (`.compaction/gateway/recovery/<id>.json`). A `randomUUID`, never derived from request content.
   * The record it names is LOCAL-ONLY and is never uploaded; the id travels to the control plane as
   * a verify-only signed byte and is discarded there.
   */
  recovery_id: string;
  /** Structurally excluded: the legacy key exists only on schema v1. */
  receipt_id?: never;
  /** Structurally excluded: the recomputation basis was introduced by schema v3. */
  estimated_input_tokens_before?: never;
}

/** A CURRENT (schema v3) payload with a signed, input-only recomputation basis. */
export interface UsageEventV3 extends UsageEventCommon {
  schema_version: typeof USAGE_EVENT_SCHEMA_VERSION_V3;
  recovery_id: string;
  receipt_id?: never;
  /** Model-visible input before any input optimization (local estimate; content-free count only). */
  estimated_input_tokens_before: number;
}

/**
 * The signed usage-event payload — a DISCRIMINATED UNION on `schema_version`, so "exactly one of
 * `receipt_id` / `recovery_id`" is a type-level fact rather than a rule each consumer must remember.
 * Field order in `canonicalUsageEventBytes` is FROZEN per version.
 */
export type UsageEvent = UsageEventV1 | UsageEventV2 | UsageEventV3;

/** Which shape a recovery id was read out of. DERIVED — never persisted, never uploaded, never signed. */
export type RecoveryIdProvenance = "recovery-id-field" | "legacy-receipt-id-field";

/**
 * The ONE accessor for a usage event's recovery id, across both shapes.
 *
 * Historical v1 data is recognised EXPLICITLY as legacy recovery-id data rather than reinterpreted:
 * the caller gets the id AND the shape it came from. The provenance is computed on read — writing it
 * into the entry would either enter the signed bytes (a second frozen-contract change) or sit
 * outside them where tampering could flip it.
 */
export function recoveryIdOf(event: UsageEvent): { recoveryId: string; provenance: RecoveryIdProvenance } {
  return event.schema_version === USAGE_EVENT_SCHEMA_VERSION
    ? { recoveryId: event.receipt_id, provenance: "legacy-receipt-id-field" }
    : { recoveryId: event.recovery_id, provenance: "recovery-id-field" };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** The frozen key order AFTER byte position 3 — identical on frozen schema versions v1 and v2. */
function canonicalTailV1V2(event: UsageEventV1 | UsageEventV2) {
  return {
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
}

/** Schema v3 key order after `recovery_id`; v1/v2 continue through the frozen helper above. */
function canonicalTailV3(event: UsageEventV3) {
  return {
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
    estimated_input_tokens_before: event.estimated_input_tokens_before,
    estimated_input_tokens_after: event.estimated_input_tokens_after
  };
}

/**
 * The canonical bytes the DEVICE signature covers — fixed key order + the `compaction-usage-v1`
 * domain tag. Signer and verifier MUST both produce these exact bytes.
 *
 * BRANCHES ON `schema_version`, and that is what makes a mixed journal verifiable: a v1 entry keeps
 * producing its ORIGINAL bytes (`receipt_id` at position 3) forever, so every historical signature
 * and every historical `entry_hash` still recompute; a v2 entry produces the same layout with
 * `recovery_id` there instead. The chain therefore spans the version boundary with no special case.
 */
export function canonicalUsageEventBytes(event: UsageEvent): Buffer {
  const ordered =
    event.schema_version === USAGE_EVENT_SCHEMA_VERSION_V3
      ? {
          schema_version: event.schema_version,
          event_id: event.event_id,
          recovery_id: event.recovery_id,
          ...canonicalTailV3(event)
        }
      : event.schema_version === USAGE_EVENT_SCHEMA_VERSION_V2
      ? {
          schema_version: event.schema_version,
          event_id: event.event_id,
          recovery_id: event.recovery_id,
          ...canonicalTailV1V2(event)
        }
      : {
          schema_version: event.schema_version,
          event_id: event.event_id,
          receipt_id: event.receipt_id,
          ...canonicalTailV1V2(event)
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
    // THE UNIT COMES FROM WHOEVER PRODUCED THE COUNT — it is never inferred from this client's own
    // version. The engine ships separately and declares its meter on every applied response; a
    // reconciliation replay pins the version the history was recorded under. An undeclared quantity
    // is UNPLACEABLE, not active-by-default: see `USAGE_METER_VERSION_UNDECLARED`.
    return {
      tokens: input.meteredOptimizedInputTokens,
      meterVersion: isNonEmptyString(input.meterVersion) ? input.meterVersion : USAGE_METER_VERSION_UNDECLARED
    };
  }
  return {
    tokens: fallbackOptimizedInputTokens(input.preMutationBody),
    meterVersion: USAGE_METER_VERSION_FALLBACK
  };
}

/**
 * Parse+validate a usage-event payload object. Returns `undefined` on anything malformed (never throws).
 *
 * EXACTLY ONE recovery-id key, matching the DECLARED version. A line carrying both keys, or the
 * wrong one for its version, is refused rather than repaired: the canonical bytes are chosen by
 * `schema_version`, so an entry whose keys disagree with its version would be a line whose signed
 * layout could only be guessed at.
 */
export function parseUsageEvent(raw: unknown): UsageEvent | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const version = r.schema_version;
  if (
    version !== USAGE_EVENT_SCHEMA_VERSION &&
    version !== USAGE_EVENT_SCHEMA_VERSION_V2 &&
    version !== USAGE_EVENT_SCHEMA_VERSION_V3
  ) return undefined;
  const legacy = version === USAGE_EVENT_SCHEMA_VERSION;
  if (!isNonEmptyString(legacy ? r.receipt_id : r.recovery_id)) return undefined;
  if ((legacy ? r.recovery_id : r.receipt_id) !== undefined) return undefined;
  if (!isNonEmptyString(r.event_id)) return undefined;
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
  const current = version === USAGE_EVENT_SCHEMA_VERSION_V3;
  if (current ? !isNonNegativeInt(r.estimated_input_tokens_before) : r.estimated_input_tokens_before !== undefined) {
    return undefined;
  }
  const common: UsageEventCommon = {
    event_id: r.event_id,
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
  return legacy
    ? { schema_version: USAGE_EVENT_SCHEMA_VERSION, receipt_id: r.receipt_id as string, ...common }
    : current
      ? {
          schema_version: USAGE_EVENT_SCHEMA_VERSION_V3,
          recovery_id: r.recovery_id as string,
          estimated_input_tokens_before: r.estimated_input_tokens_before as number,
          ...common
        }
      : { schema_version: USAGE_EVENT_SCHEMA_VERSION_V2, recovery_id: r.recovery_id as string, ...common };
}
