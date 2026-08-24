/**
 * Usage-metering seam (PUBLIC) — the thin boundary through which the gateway apply path consults the
 * allowance ceiling and commits the one debit a confirmed metered apply owes.
 *
 * Metering is a private capability: it is the accounting that makes a Community
 * allowance mean something, and it exists only on the tiers that have one. The gateway is a PUBLIC
 * mechanism and must build and run whether or not the metering modules are part of this build, so it
 * reaches them ONLY through the lazy dynamic `import()`s below — never a static import.
 *
 * ABSENT-IMPLEMENTATION SEMANTICS — fail CLOSED for mutation, fail OPEN for the workflow. With
 * metering absent:
 *   - `readMeteredAllowance` reports `ok: false` with a fixed content-free reason. The caller already
 *     treats an unreadable ceiling as a decline (never "apply anyway"), so no model-visible mutation
 *     happens on the strength of an allowance nobody can count.
 *   - `commitApplyDebit` reports `metered: false` with the same class of reason, and the caller
 *     declines the apply. A mutation and its debit stay atomic-or-neither.
 *   - In both cases the request itself is untouched: the gateway forwards the ORIGINAL bytes and the
 *     turn is recorded honestly as a non-apply. Nothing blocks, nothing errors, nothing is claimed.
 *
 * The METER DEFINITION is deliberately NOT behind this seam. `usage-event.ts` — the canonical event
 * shape, the frozen meter version, and `resolveMeteredOptimizedInput`, which derives the count a
 * request would be charged — stays public and is imported statically, because a user must be able to
 * read what their allowance is counted in. Hiding the meter while charging against it is exactly the
 * unreadable-self-report posture the per-turn receipt line exists to avoid.
 */
import { isModuleAbsentError } from "../module-absence.js";

/**
 * The specifier the lazy `import()` below uses, declared so the absence check can be scoped to THIS
 * module. Kept literal in both places on purpose (a computed specifier defeats the loader's static
 * analysis); `private-boundary-seams.test.ts` asserts the two never drift, and a drift would in any
 * case fail toward PROPAGATING the error rather than degrading silently.
 */
const USAGE_JOURNAL_SPECIFIER = "../usage/usage-journal.js";
const USAGE_METERING_SPECIFIER = "../usage/usage-metering.js";

/** Fixed, content-free reason reported when the metering modules are not part of this build. */
export const METERING_ABSENT_REASON = "usage-metering-unavailable";

/**
 * The single sanctioned message a USER-FACING surface prints when metering is not part of this build.
 * One string, never forked per command — the same discipline as the engine degrade message.
 *
 * It names all three facts a user needs and none they do not: what is missing, what CONSEQUENCE that
 * has (metered full apply cannot run, because an apply is never forwarded without its debit
 * recorded), and what is unaffected (the request itself). It invents no zero allowance, claims no
 * tier, and claims no saving. Saying only "nothing else changes" here would be false — the honest
 * degrade has a cost and the message states it.
 */
export const METERING_ABSENT_MESSAGE =
  "Usage metering is not part of this build - no allowance figures are available on this device, " +
  "and metered (API-key route) full apply does not run. Requests are forwarded unchanged; nothing is blocked.";

/**
 * Plain-English gloss for an allowance-read decline, for the one log line that reports it.
 *
 * Both classes are fail-closed declines, but they are NOT the same fact and a surface must not
 * conflate them: the ceiling can be unreadable because THIS DEVICE's hash-chained journal failed to
 * verify (an integrity finding about the user's own data), or because the metering modules are not
 * part of this build at all — in which case no journal was ever consulted and asserting it "did not
 * verify" is a false integrity claim about data that was never read.
 */
export function meteringDeclineExplanation(reason: string): string {
  return reason === METERING_ABSENT_REASON
    ? "usage metering is not part of this build"
    : "usage journal did not verify";
}

/** The allowance ceiling verdict for one period. `ok: false` always declines the apply. */
export type MeteredAllowance =
  | { ok: true; consumed: number; remaining: number }
  | { ok: false; reason: string };

/** The outcome of the single debit a confirmed metered apply commits. */
export type ApplyDebitResult =
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

/** The debit descriptor. Content-free: ids, counts, labels — never request content beyond the meter basis. */
export interface ApplyDebitContext {
  routeType: string;
  workflow: string;
  provider: string;
  periodId: string;
  allowanceTokens: number;
  receiptId: string;
  meterVersion?: string;
  meteredOptimizedInputTokens?: number;
  estimatedInputTokensAfter?: number;
  engineEventId?: string;
  /** The pre-mutation request body (ONLY used for the documented fallback count; never stored). */
  preMutationBody: string;
}

/**
 * Read the integrity-gated consumed/remaining tally for one period. When metering is absent the
 * verdict is `ok: false` with `METERING_ABSENT_REASON`, which the caller treats exactly like an
 * unverifiable journal: decline the apply, forward the original unchanged, no auto-purchase. A real
 * error from inside present metering propagates unchanged, including a module-not-found for one of
 * ITS dependencies (a packaging defect, not an excluded capability).
 */
export async function readMeteredAllowance(
  allowanceTokens: number,
  periodId: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<MeteredAllowance> {
  try {
    const { readPeriodConsumption } = await import("../usage/usage-journal.js");
    return await readPeriodConsumption(allowanceTokens, periodId, env);
  } catch (error) {
    if (!isModuleAbsentError(error, { specifier: USAGE_JOURNAL_SPECIFIER, importerUrl: import.meta.url })) throw error;
    return { ok: false, reason: METERING_ABSENT_REASON };
  }
}

/**
 * Commit the single debit for a confirmed metered apply. When metering is absent the result is
 * `metered: false` with `METERING_ABSENT_REASON` and the caller declines the apply, so a mutation is
 * never forwarded without its debit recorded. A real error from inside present metering propagates
 * unchanged, including a module-not-found for one of ITS dependencies.
 */
export async function commitApplyDebit(
  ctx: ApplyDebitContext,
  env: NodeJS.ProcessEnv = process.env
): Promise<ApplyDebitResult> {
  try {
    const { meterConfirmedApply } = await import("../usage/usage-metering.js");
    return await meterConfirmedApply(ctx, env);
  } catch (error) {
    if (!isModuleAbsentError(error, { specifier: USAGE_METERING_SPECIFIER, importerUrl: import.meta.url })) throw error;
    return { metered: false, reason: METERING_ABSENT_REASON };
  }
}
