/**
 * Usage metering glue (PUBLIC client) — builds, DEVICE-signs, and commits ONE usage journal
 * entry for a confirmed metered full-apply, at the single confirmed-apply site in the gateway.
 *
 * RAILS:
 *  - Reachable ONLY from the gateway apply path (`gateway/server.ts`); NEVER from `mode.ts` /
 *    output-shaping / the pure lease-store. It reads the DEVICE PRIVATE key
 *    (`credentials.device_private_key_pem`) to sign, which is why it must stay off the Open graph.
 *  - ROUTE-INDEPENDENT. A confirmed Hybrid INPUT apply is debited on every route in
 *    `DEBITABLE_ROUTE_TYPES` (api-key and Claude Code subscription alike): the allowance pays for use
 *    of the Hybrid Engine, not for the provider billing route. An unrecognised route label is still
 *    refused (returns `metered:false`, writes nothing) — an unknown route is an integrity signal.
 *    OUTPUT SHAPING IS NEVER METERED on any route; only the confirmed-apply site calls this.
 *  - The metered count is ENGINE-AUTHORITATIVE (`metered_optimized_input_tokens`). Only when the
 *    engine omits it does the client fall back to a documented `ceil(chars/4)` estimate stamped with
 *    the DISTINCT fallback meter version — never presented as the engine-authoritative meter.
 *  - PRODUCT-METER ≠ PROVIDER BILL: `optimized_input_tokens` is a product allowance unit; it never
 *    feeds a cost/savings claim and is never rendered in the content-free gateway receipt.
 *  - The ALLOWANCE CEILING is enforced ATOMICALLY WITH the debit: the remaining-allowance test rides
 *    into `appendUsageEvent` and is evaluated against the journal read inside the append lock. A
 *    caller-side snapshot alone cannot bound total usage, because concurrent applies all read it
 *    before any of them commits.
 */
import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { readStoredCredentials } from "../auth/credentials.js";
import { signDetached } from "../crypto/ed25519.js";
import { compactionConfigDir } from "../config-dir.js";
import { join } from "node:path";
import { parseSignedLease } from "../entitlement/lease.js";
import { publicKeyHash } from "../crypto/key-hash.js";
import {
  USAGE_EVENT_SCHEMA_VERSION_V3,
  ACTIVE_USAGE_METER_VERSION,
  DEBITABLE_ROUTE_TYPES,
  canonicalUsageEventBytes,
  resolveMeteredOptimizedInput,
  type UsageEvent
} from "./usage-event.js";
import { appendUsageEvent } from "./usage-journal.js";

/** The content-free context the gateway hands the meter for one confirmed apply. */
export interface MeterConfirmedApplyContext {
  /** Route derived from the configured transport — `api-key` | `subscription`. Both are debited. */
  routeType: string;
  workflow: string;
  provider: string;
  /** The lease/allowance period this debit counts against (`YYYY-MM`, from the verified lease). */
  periodId: string;
  /**
   * The period's total allowance from the VERIFIED lease. Required (not optional) so the ceiling
   * can never be silently omitted at a call site: the authoritative remaining-allowance test runs
   * inside the journal append lock and needs the allowance to subtract the fresh tally from.
   */
  allowanceTokens: number;
  /**
   * Content-free local id of the retained-original record this debit belongs to — the RECOVERY id
   * (`.compaction/gateway/recovery/<id>.json`). It has always been the recovery id; only the name it
   * was stored under was wrong (see `usage-event.ts`, schema v1's `receipt_id`).
   */
  recoveryId: string;
  /** Engine-reported meter version (present on an engine-authoritative apply). */
  meterVersion?: string;
  /** Engine-authoritative pre-mutation model-visible input tokens (the meter basis). */
  meteredOptimizedInputTokens?: number;
  /** Engine local-estimate of model-visible input before input optimization. */
  estimatedInputTokensBefore?: number;
  /** Engine local-estimate after input optimization and before output shaping. */
  estimatedInputTokensAfter?: number;
  /** Engine-reported debit event id (recorded for reconciliation; the client id is authoritative). */
  engineEventId?: string;
  /** The pre-mutation request body (ONLY used for the documented fallback count; never stored). */
  preMutationBody: string;
}

export type MeterResult =
  | {
      metered: true;
      eventId: string;
      entryHash: string;
      optimizedInputTokens: number;
      meterVersion: string;
      /**
       * Allowance left for the period AFTER this debit, measured under the journal append lock
       * against the same fresh tally the ceiling refused on. Reporting-only — a countdown surface
       * needs a number the caller cannot derive, since its own pre-dispatch snapshot predates every
       * concurrent apply's debit and is stale by the time the engine has answered.
       */
      remainingTokens: number;
      /** True when the debit was already recorded (dedupe) — still a success for the caller. */
      duplicate?: boolean;
    }
  | { metered: false; reason: string };

/** Read the raw lease's `lease_id` + `lease_sequence` (journal-only ids) from `<configDir>/lease.json`. */
function readLeaseIdentity(env: NodeJS.ProcessEnv): { leaseId: string; leaseSequence: number } | undefined {
  const path = join(compactionConfigDir(env), "lease.json");
  try {
    if (!existsSync(path)) return undefined;
    const parsed = parseSignedLease(JSON.parse(readFileSync(path, "utf8")));
    if (!parsed) return undefined;
    return { leaseId: parsed.lease.lease_id, leaseSequence: parsed.lease.lease_sequence };
  } catch {
    return undefined;
  }
}

/**
 * Meter ONE confirmed metered full-apply: build the content-free event, sign it with the device
 * private key, and append it to the hash-chained journal — COMMITTED BEFORE the caller treats the
 * apply as complete. Returns `metered:false` (writing nothing) for any not-metered/fail-closed case
 * so the caller can decline the mutation (a mutation is never forwarded without its debit recorded).
 *
 * `now` is injected for deterministic `occurred_at` in tests.
 */
export async function meterConfirmedApply(
  ctx: MeterConfirmedApplyContext,
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date()
): Promise<MeterResult> {
  // The ROUTE IS RECORDED, NOT A GATE: both supported upstream routes debit. An UNRECOGNISED label is
  // still refused — the route that produced this apply would be unknown, and the server's
  // `usage_debit.route_type` CHECK constraint would reject the entry at reconciliation anyway, which
  // would silently lose a debit the client had already spent locally.
  if (!DEBITABLE_ROUTE_TYPES.has(ctx.routeType)) return { metered: false, reason: `route-not-debitable:${ctx.routeType}` };

  const credentials = readStoredCredentials(env);
  if (!credentials) return { metered: false, reason: "credentials-unavailable" };

  const leaseIdentity = readLeaseIdentity(env);
  if (!leaseIdentity) return { metered: false, reason: "lease-unreadable" };

  // Engine-authoritative count when present; otherwise the documented fallback with a DISTINCT label.
  // SHARED resolution: the gateway's pre-commit ceiling check calls the SAME function, so the number
  // refused on and the number recorded can never drift.
  const { tokens: optimizedInputTokens, meterVersion } = resolveMeteredOptimizedInput({
    ...(ctx.meterVersion !== undefined ? { meterVersion: ctx.meterVersion } : {}),
    ...(ctx.meteredOptimizedInputTokens !== undefined
      ? { meteredOptimizedInputTokens: ctx.meteredOptimizedInputTokens }
      : {}),
    preMutationBody: ctx.preMutationBody
  });

  // Current debits are independently recomputable from a SIGNED input-only pair. An older engine
  // that omits the pair, a malformed pair, or a pair that disagrees with the claimed active-unit
  // debit cannot produce a current event: fail closed and leave the original request in place.
  const estimatedBefore = ctx.estimatedInputTokensBefore;
  const estimatedAfter = ctx.estimatedInputTokensAfter;
  if (
    meterVersion !== ACTIVE_USAGE_METER_VERSION ||
    typeof estimatedBefore !== "number" ||
    !Number.isInteger(estimatedBefore) ||
    estimatedBefore < 0 ||
    typeof estimatedAfter !== "number" ||
    !Number.isInteger(estimatedAfter) ||
    estimatedAfter < 0 ||
    optimizedInputTokens !== Math.max(0, estimatedBefore - estimatedAfter)
  ) {
    return { metered: false, reason: "meter-basis-invalid" };
  }

  // NEW WRITES ARE SCHEMA v3: v1/v2 entries already on disk keep their frozen bytes and remain
  // verifiable, while new active-unit debits sign the complete recomputation basis.
  const event: UsageEvent = {
    schema_version: USAGE_EVENT_SCHEMA_VERSION_V3,
    event_id: randomUUID(),
    recovery_id: ctx.recoveryId,
    lease_id: leaseIdentity.leaseId,
    lease_sequence: leaseIdentity.leaseSequence,
    device_id: credentials.device_id,
    // Binds the entry to the key that SIGNS it, so a later legitimate key rotation reads as
    // "device rotated" rather than as a signature failure (and the history is not lost).
    device_key_hash: publicKeyHash(credentials.device_public_key),
    period_id: ctx.periodId,
    occurred_at: now.toISOString(),
    route_type: ctx.routeType,
    workflow: ctx.workflow,
    provider: ctx.provider,
    meter_version: meterVersion,
    optimized_input_tokens: optimizedInputTokens,
    estimated_input_tokens_before: estimatedBefore,
    estimated_input_tokens_after: estimatedAfter
  };

  let signature: string;
  try {
    signature = signDetached(canonicalUsageEventBytes(event), credentials.device_private_key_pem);
  } catch {
    return { metered: false, reason: "device-signature-failed" };
  }

  // ATOMIC CHECK-AND-DEBIT: the AUTHORITATIVE remaining-allowance test travels with the debit and is
  // evaluated against the journal read inside the append lock — not against the caller's pre-dispatch
  // snapshot, which is stale by the time the engine has answered and which every concurrent apply
  // would observe identically. The check reads the period and the token count off the ENTRY it is
  // about to write, so the number refused on cannot drift from the number that would have been
  // committed; the allowance from the verified lease is the only thing passed in, and passing it is
  // REQUIRED by the type — an append without a ceiling re-check does not compile.
  const appended = await appendUsageEvent(
    event,
    signature,
    {
      ceiling: { allowanceTokens: ctx.allowanceTokens },
      ...(ctx.engineEventId ? { engineEventId: ctx.engineEventId } : {})
    },
    env
  );
  if (!appended.appended) {
    // A duplicate event_id can never occur here (freshly minted uuid); any other append failure —
    // including the under-lock ceiling refusal — is fail-closed for the MUTATION (the caller
    // declines) so a mutation never rides without its debit, and a debit never exceeds the ceiling.
    return { metered: false, reason: `journal-append-failed:${appended.reason}` };
  }

  return {
    metered: true,
    eventId: appended.event_id,
    entryHash: appended.entry_hash,
    optimizedInputTokens,
    meterVersion,
    remainingTokens: appended.remaining_tokens
  };
}
