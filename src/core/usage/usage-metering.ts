/**
 * Usage metering glue (PUBLIC client) — builds, DEVICE-signs, and commits ONE usage journal
 * entry for a confirmed metered full-apply, at the single confirmed-apply site in the gateway.
 *
 * RAILS:
 *  - Reachable ONLY from the gateway apply path (`gateway/server.ts`); NEVER from `mode.ts` /
 *    output-shaping / the pure lease-store. It reads the DEVICE PRIVATE key
 *    (`credentials.device_private_key_pem`) to sign, which is why it must stay off the Open graph.
 *  - `route_type === "api-key"` ONLY. A subscription-labeled apply is REFUSED here (returns
 *    `metered:false`, writes nothing) — subscription apply is never metered/debited.
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
  USAGE_EVENT_SCHEMA_VERSION,
  METERED_ROUTE_TYPE,
  canonicalUsageEventBytes,
  resolveMeteredOptimizedInput,
  type UsageEvent
} from "./usage-event.js";
import { appendUsageEvent } from "./usage-journal.js";

/** The content-free context the gateway hands the meter for one confirmed apply. */
export interface MeterConfirmedApplyContext {
  /** Route derived from the configured transport — `api-key` | `subscription`. Only api-key is metered. */
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
  /** Content-free local id linking the debit to the retained-original / apply receipt (the recovery id). */
  receiptId: string;
  /** Engine-reported meter version (present on an engine-authoritative apply). */
  meterVersion?: string;
  /** Engine-authoritative pre-mutation model-visible input tokens (the meter basis). */
  meteredOptimizedInputTokens?: number;
  /** Engine local-estimate of model-visible input tokens after the mutation. */
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
  // Subscription route is NEVER metered/debited — refuse defensively even if a caller mis-routes here.
  if (ctx.routeType !== METERED_ROUTE_TYPE) return { metered: false, reason: `route-not-metered:${ctx.routeType}` };

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

  const estimatedAfter =
    typeof ctx.estimatedInputTokensAfter === "number" &&
    Number.isInteger(ctx.estimatedInputTokensAfter) &&
    ctx.estimatedInputTokensAfter >= 0
      ? ctx.estimatedInputTokensAfter
      : optimizedInputTokens;

  const event: UsageEvent = {
    schema_version: USAGE_EVENT_SCHEMA_VERSION,
    event_id: randomUUID(),
    receipt_id: ctx.receiptId,
    lease_id: leaseIdentity.leaseId,
    lease_sequence: leaseIdentity.leaseSequence,
    device_id: credentials.device_id,
    // Binds the entry to the key that SIGNS it, so a later legitimate key rotation reads as
    // "device rotated" rather than as a signature failure (and the history is not lost).
    device_key_hash: publicKeyHash(credentials.device_public_key),
    period_id: ctx.periodId,
    occurred_at: now.toISOString(),
    route_type: METERED_ROUTE_TYPE,
    workflow: ctx.workflow,
    provider: ctx.provider,
    meter_version: meterVersion,
    optimized_input_tokens: optimizedInputTokens,
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
    meterVersion
  };
}
