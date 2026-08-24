/**
 * Entitlement lease store + verifier (PUBLIC client) — THE Open-path-safe verification rail.
 *
 * Reads `~/.compaction/lease.json` (0600), verifies the Ed25519 signature against the pinned lease
 * root (else the explicit dev root), binds it to THIS device, checks period/expiry/allowance, and
 * returns a CONTENT-FREE verdict (fixed labels only). It NEVER throws (any anomaly resolves to a
 * fail-closed verdict) and it NEVER performs a network call.
 *
 * PURITY (load-bearing — this module sits on the Open import graph via `effectiveOpenTier`):
 *  - Imports ONLY `node:fs` + `node:crypto` (via sibling pure helpers). It imports NOTHING from
 *    `src/core/auth/**` or `src/core/api-client/**` — both are forbidden substrings on the Open
 *    basic import graph (`tests/security/open-basic-engine-free.test.ts`). The device public key is
 *    read from the credentials FILE by `fs` (a filesystem read is allowed; importing the auth module
 *    is not), and its hash is recomputed with the shared `crypto/key-hash` helper.
 *  - No import-time I/O: everything happens inside `readLeaseVerdict` / helpers, called by explicit
 *    surfaces (tier read, `compaction lease status`), never at module load (package-smoke offline).
 *
 * CONTENT-FREE: the verdict carries fixed labels + counts only — never `lease_id`, `account_id`,
 * email, or a remaining-token figure to a receipt/log. The `allowanceTokens`/`periodId` on a VALID
 * verdict are for the gate's non-debitable quota snapshot (the IPC boundary), never a rendered value.
 *
 * TWO SEPARATE QUESTIONS, TWO SEPARATE FIELDS (load-bearing).
 * `allowance_tokens` in the signed lease answers two different things — "is this device ENTITLED to
 * the private engine?" and "how much METERED api-key headroom is left?" — and this reader used to
 * collapse them, ending the verification chain with a terminal `allowance-exhausted` verdict at
 * `allowance_tokens <= 0`. That is the right answer for the metered route and the WRONG answer for
 * the subscription route, whose full apply consumes no allowance at all: every caller that asks "is
 * this lease valid?" (the tier clamp, the gateway's entitlement gate, `mode full`) then withdrew full
 * apply from traffic that owes the allowance nothing. So the two questions are now two fields. The
 * LABEL is the entitlement decision alone — signature, device binding, period, expiry. The spent
 * balance rides a VALID verdict as `meteredBalanceExhausted`, a FACT the route interprets, and the
 * only route that interprets it as a refusal is the metered one.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { compactionConfigDir, type ConfigDirEnv } from "../config-dir.js";
import { publicKeyHash } from "../crypto/key-hash.js";
import { canonicalLeaseBytes, currentPeriodId, parseSignedLease, periodEndUtc } from "./lease.js";
import { validResetsOn } from "../upgrade-cta.js";
import { verifyLeaseSignatureBytes, type LeaseTrustSource } from "./lease-roots.js";

/** Absolute path of the lease file (`<configDir>/lease.json`). */
export function leasePath(env: ConfigDirEnv = process.env): string {
  return join(compactionConfigDir(env), "lease.json");
}

/** Absolute path of the credentials file (read as a FILE — the auth module is NOT imported here). */
function credentialsFilePath(env: ConfigDirEnv = process.env): string {
  return join(compactionConfigDir(env), "credentials.json");
}

/**
 * The fixed, content-free lease verdict labels — the ENTITLEMENT decision and nothing else. Every
 * anomaly maps to exactly one of these; the gate and the `lease status` surface render only the label
 * (never lease/account/allowance content).
 *
 * There is deliberately no `allowance-exhausted` label. A spent balance is not a statement about
 * whether this device is entitled to the private engine — it is a statement about the metered
 * api-key route's remaining headroom, and it rides `meteredBalanceExhausted` on a VALID verdict.
 */
export type LeaseVerdictLabel =
  | "lease-valid"
  | "lease-absent"
  | "lease-invalid"
  | "lease-expired"
  | "lease-wrong-device"
  | "lease-wrong-period";

export interface LeaseVerdict {
  label: LeaseVerdictLabel;
  /** Present ONLY when `label === "lease-valid"`: which trust root verified it (dev-signed is loud). */
  trust?: LeaseTrustSource;
  /**
   * Present ONLY when valid: allowance carried in the lease (gate quota snapshot; never rendered).
   * MAY BE ZERO — a valid lease with no metered headroom left is still a valid entitlement, and the
   * zero is exactly the snapshot the metered route must refuse on.
   */
  allowanceTokens?: number;
  /**
   * The lease period id (`YYYY-MM`), present on `lease-valid`. It is the gate's quota snapshot AND
   * what lets a surface name the honest allowance RESET date (`periodEndUtc`) when the balance is
   * spent. Content-free: a calendar month, never a lease/account id or a remaining-token figure.
   */
  periodId?: string;
  /**
   * A REPORTING FACT FOR SCOPING USER-FACING NOTICES. **NO ENFORCEMENT DECISION MAY READ IT.**
   *
   * Present on `lease-valid` only: the ISSUER signed this lease with no optimized-input allowance left
   * for the period (server-authoritative as of issue — see the check that sets it). Its ONLY sanctioned
   * use is letting a surface say something true about WHICH traffic a spent allowance pauses, and when
   * it comes back. It does not authorize, refuse, or gate anything.
   *
   * SANCTIONED READERS — the COMPLETE list, mirrored by `SANCTIONED_READERS` in
   * `tests/security/metered-balance-is-not-a-gate.test.ts`. That test parses the entries below and
   * fails if the two lists drift, so THIS LIST AND THAT ONE MUST BE UPDATED IN LOCKSTEP. Every entry is
   * reporting-only; none of them refuses, authorizes, or clamps anything:
   *   - `src/core/onboarding-preferences.ts` — sets the `api-key-route` pause scope on `resolveOpenTier`;
   *     changes no tier.
   *   - `src/cli/commands/lease.ts` — `lease status` copy: a valid lease whose metered balance is spent.
   *   - `src/cli/commands/mode.ts` — `mode full` copy: enables the mode, scopes the promise to the route.
   *   - `src/cli/commands/usage.ts` — REPORTING-ONLY. It chooses which remaining-line to print, and that
   *     line's number, label and copy prefix: a server-signed zero is definitive, so it is reported
   *     rather than deferred to the journal-integrity fallback. It refuses nothing and takes no action.
   *
   * WHERE THE METERED BALANCE GATE ACTUALLY LIVES — two places, neither of them here:
   *   1. `gateway/server.ts`, inside the `routeType === METERED_ROUTE_TYPE` branch, which reads the
   *      integrity-gated journal tally and declines at/over the ceiling (pre-dispatch);
   *   2. `usage/usage-journal.ts`'s `appendUsageEvent` ceiling, re-evaluated against a fresh tally
   *      under the append lock — the AUTHORITATIVE check, and the only one that bounds concurrency.
   * Both work off `allowanceTokens` and the journal, and both are route-gated by their caller. Neither
   * needs this boolean, and adding a third gate that reads it would not make the ceiling stronger.
   *
   * WHY THE PROHIBITION, stated so the reasoning survives the commit: this field replaced a terminal
   * `allowance-exhausted` VERDICT, whose whole defect was that a lease reader decided the balance
   * question for BOTH routes at once. Route-blind callers (the tier clamp, the gateway's entitlement
   * gate) read that decision and withdrew full apply from subscription traffic, which consumes no
   * allowance at all — re-coupling exactly what the two routes keep separate. A verdict field
   * cannot know its reader's route. Wiring an enforcement path to this boolean recreates the defect
   * under a new name, however locally reasonable the call site looks.
   *
   * A caller that asks only `label === "lease-valid"` gets the ENTITLEMENT answer, which is the same on
   * both routes. A caller that needs to gate on the balance must first know its route, and must use the
   * two checks above.
   *
   * `tests/security/metered-balance-is-not-a-gate.test.ts` enforces the file-level half of this rule;
   * read its docblock for what it does and does not catch. In particular it checks WHICH files mention
   * this field, never HOW — so every name on the list above is a file where a future enforcement use
   * would pass silently. The rationale on each entry is the mitigation: if a listed file's use of this
   * flag changes, re-read its entry and confirm the entry is still true.
   */
  meteredBalanceExhausted?: boolean;
}

/** Read THIS device's public key from the credentials FILE (fs read; the auth module is not imported). */
function readDevicePublicKey(env: ConfigDirEnv): string | undefined {
  const path = credentialsFilePath(env);
  try {
    if (!existsSync(path)) return undefined;
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const key = typeof raw.device_public_key === "string" ? raw.device_public_key.trim() : "";
    return key === "" ? undefined : key;
  } catch {
    return undefined;
  }
}

/**
 * Verify the stored lease and return a content-free verdict. Fail-closed on every anomaly; never
 * throws. `now` is injectable for tests. Check order (most-specific reason wins): presence → parse →
 * signature → device binding → period → expiry. The ENTITLEMENT chain ends there; the metered
 * balance is read afterwards and reported as a field, because it disqualifies no route on its own.
 */
export function readLeaseVerdict(env: ConfigDirEnv = process.env, now: Date = new Date()): LeaseVerdict {
  const path = leasePath(env);
  if (!existsSync(path)) return { label: "lease-absent" };

  let parsed: ReturnType<typeof parseSignedLease>;
  try {
    parsed = parseSignedLease(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return { label: "lease-invalid" };
  }
  if (!parsed) return { label: "lease-invalid" };
  const { lease, signature } = parsed;

  // Cryptographic gate FIRST: a lease whose signature does not verify against an allowed root is
  // invalid regardless of its contents (pinned-root-not-minted and bad-signature both → invalid).
  const sig = verifyLeaseSignatureBytes(canonicalLeaseBytes(lease), signature, env);
  if (!sig.verified) return { label: "lease-invalid" };

  // Device binding: recompute the hash of THIS device's public key and require it to match the
  // lease's `device_public_key_hash`. No credentials (not logged in) ⇒ cannot bind ⇒ invalid.
  const devicePublicKey = readDevicePublicKey(env);
  if (!devicePublicKey) return { label: "lease-invalid" };
  if (publicKeyHash(devicePublicKey) !== lease.device_public_key_hash) return { label: "lease-wrong-device" };

  // Period + expiry (server-authoritative fields carried IN the signed lease).
  if (lease.period_id !== currentPeriodId(now)) return { label: "lease-wrong-period" };
  if (Number.isNaN(Date.parse(lease.expires_at)) || now.getTime() > Date.parse(lease.expires_at)) {
    return { label: "lease-expired" };
  }

  // METERED BALANCE — reported, NOT decided. A zero/negative allowance means the metered api-key
  // route has no headroom left this period; ceiling behavior there is refuse/degrade, never
  // auto-purchase. The number is SERVER-AUTHORITATIVE as of issue: the issuer subtracts the
  // consumption the server has recorded for the period before signing, so a device that deleted its
  // local journal still receives the reduced figure. Per-turn spend within the lease's life is
  // tracked separately by the local journal; this is the outer bound the server put in the signature.
  //
  // It is NOT a verdict, because it is not the same fact on both routes: subscription full
  // apply consumes no allowance, so refusing the ENTITLEMENT here would switch off apply for traffic
  // that owes the allowance nothing. The route decides; this reader only states.
  //
  // The period rides the verdict so the ceiling is EXPLAINABLE, not just refused: the reset date a
  // surface names is derived from this (`periodEndUtc`). It is necessarily the current period — the
  // wrong-period check above already returned for anything else.
  return {
    label: "lease-valid",
    trust: sig.trust,
    allowanceTokens: lease.allowance_tokens,
    periodId: lease.period_id,
    ...(lease.allowance_tokens <= 0 ? { meteredBalanceExhausted: true } : {})
  };
}

/**
 * Convenience: whether this device currently holds a VALID full-apply ENTITLEMENT lease.
 *
 * Entitlement only — a valid lease whose metered balance is spent still answers `true`, because the
 * device is still entitled to the private engine and subscription-route full apply still runs on it
 * A caller gating METERED apply must additionally consult the balance, on its route.
 */
export function hasValidFullApplyLease(env: ConfigDirEnv = process.env, now: Date = new Date()): boolean {
  return readLeaseVerdict(env, now).label === "lease-valid";
}

/**
 * The persisted shape a recorded allowance pause is judged by. Structural on purpose: the pause lives
 * on a gateway receipt, and the entitlement layer must not depend on the gateway to answer a question
 * that is entirely about periods.
 */
export interface RecordedAllowancePause {
  /** The allowance period the pause was recorded in, when the writer stamped one. */
  period_id?: string;
  /** The reset date the pause was recorded with (`YYYY-MM-DD`), when one was known. */
  resets_on?: string;
}

/**
 * WHERE a recorded pause sits relative to the period the reader is in now.
 *
 *   - `current` — it belongs to the period being spent right now.
 *   - `stale`   — it provably belongs to a period that has ENDED.
 *   - `unknown` — it carries nothing datable and there is no authority to date it against.
 *
 * The third value is not pedantry, and collapsing it into either of the others causes a real defect.
 * Folded into `stale` it silences a LIVE ceiling (a blocked user loses the one reachable conversion
 * path on the only line they read mid-turn); folded into `current` it resurrects the stale-state bug
 * this whole gate exists to close. So the two consumers below each pick the side that fails safe.
 *
 * THE VERIFIED LEASE PERIOD IS THE AUTHORITY, never the wall clock, when one is available. The period
 * a Community user is spending against is the one their signed lease says they are in; deriving a
 * period from the local clock would let a clock change silence or fabricate a ceiling, and this is
 * exactly the state the entitlement chain exists to establish. So:
 *
 *   - verified period + a receipt that names its period ⇒ they must MATCH.
 *   - verified period + a legacy receipt with no `period_id` ⇒ its reset date must be the date THIS
 *     period would produce. Same test, expressed through the only field an older receipt carries.
 *   - NO verified period at all (no lease, expired, wrong device — an Open-tier reader) ⇒ there is no
 *     authority to bind to, and the compatibility guard is the weaker but honest one: a valid
 *     `resets_on` STRICTLY IN THE FUTURE. A reset date that has passed cannot describe a live pause.
 */
export function allowancePausePeriodStatus(
  pause: RecordedAllowancePause,
  env: ConfigDirEnv = process.env,
  now: Date = new Date()
): "current" | "stale" | "unknown" {
  let verifiedPeriodId: string | undefined;
  try {
    const verdict = readLeaseVerdict(env, now);
    if (verdict.label === "lease-valid") verifiedPeriodId = verdict.periodId;
  } catch {
    verifiedPeriodId = undefined;
  }

  if (verifiedPeriodId !== undefined) {
    if (pause.period_id !== undefined) return pause.period_id === verifiedPeriodId ? "current" : "stale";
    const expected = periodEndUtc(verifiedPeriodId);
    const recorded = validResetsOn(pause.resets_on);
    if (expected === undefined || recorded === undefined) return "unknown";
    return recorded === expected ? "current" : "stale";
  }

  const resetsOn = validResetsOn(pause.resets_on);
  if (resetsOn === undefined) return "unknown";
  return resetsOn > now.toISOString().slice(0, 10) ? "current" : "stale";
}

/**
 * May a recorded pause be promoted to CURRENT STATE — the thing `watch`, `status`, `usage` and
 * `lease status` report as happening now?
 *
 * THE DEFECT THIS CLOSES. "Newest turn" was the only filter, and a newest turn is newest forever. A
 * receipt written on July 28 kept every state surface saying "Community input optimization is paused…
 * it resumes 2026-08-01" on August 3 — after the allowance had reset and while nothing was paused at
 * all. The pause was TRUE when written; it is the PROMOTION of it to current state that has to be
 * bound to the period it belongs to.
 *
 * Only a provably CURRENT pause is promoted: an undatable one is not evidence that anything is paused
 * now, and a state surface asserting a pause it cannot date is the failure being fixed. A pause that
 * fails is ignored ENTIRELY, not softened — no "paused", no stale resume date, no conversion CTA
 * derived from it.
 */
export function allowancePauseIsCurrent(
  pause: RecordedAllowancePause,
  env: ConfigDirEnv = process.env,
  now: Date = new Date()
): boolean {
  return allowancePausePeriodStatus(pause, env, now) === "current";
}
