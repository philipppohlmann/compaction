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
 * CONTENT-FREE: the verdict carries fixed labels + counts only — never `lease_id`, `account_id`, or
 * an email. `allowanceTokens`/`periodAllowanceTokens`/`periodId` are counts and a calendar month, and
 * they ARE rendered: `compaction usage` prints the remaining line, and a metered apply carries a
 * post-debit snapshot onto its receipt so the per-turn line can show the countdown. A token count is
 * a product allowance unit, not request content; what stays off a receipt is the lease's identity.
 *
 * TWO SEPARATE QUESTIONS, TWO SEPARATE FIELDS (load-bearing).
 * `allowance_tokens` in the signed lease answers two different things — "is this device ENTITLED to
 * the private engine?" and "how much optimized-input headroom is left?" — and this reader used to
 * collapse them, ending the verification chain with a terminal `allowance-exhausted` verdict at
 * `allowance_tokens <= 0`. That conflates a SPENT allowance with an ABSENT entitlement: a spent
 * period pauses input optimization while output shaping — which owes the allowance nothing — keeps
 * running, so every caller that asks "is this lease valid?" (the tier clamp, the gateway's
 * entitlement gate, `mode full`) withdrew the whole capability instead. Two questions, two fields. The
 * LABEL is the entitlement decision alone — signature, device binding, period, expiry. The spent
 * balance rides a VALID verdict as `meteredBalanceExhausted`, a FACT the apply path interprets — and
 * it interprets it the same way on every upstream route, because the allowance pays for use of the
 * Hybrid Engine rather than for the provider billing route.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { compactionConfigDir, type ConfigDirEnv } from "../config-dir.js";
import { publicKeyHash } from "../crypto/key-hash.js";
import { canonicalLeaseBytes, currentPeriodId, parseSignedLease, periodEndUtc, type SignedLease } from "./lease.js";
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
 * whether this device is entitled to the private engine — it is a statement about this period's
 * remaining optimized-input headroom, and it rides `meteredBalanceExhausted` on a VALID verdict.
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
   * Present ONLY when valid: the REMAINDER the lease was signed with — the period limit minus the
   * consumption the SERVER had recorded when it issued. It is the ceiling input optimization is
   * measured against (`readPeriodConsumption` subtracts the local unreconciled tally from it), and it
   * is reported by `compaction usage`.
   *
   * MAY BE ZERO — a valid lease with no metered headroom left is still a valid entitlement, and the
   * zero is exactly the snapshot input optimization must pause on, whichever route carries the turn.
   *
   * NOT A DENOMINATOR. It is already net of server-recorded consumption, so `remaining / this` reads
   * as a full tank on a half-spent period. The denominator is `periodAllowanceTokens` below.
   */
  allowanceTokens?: number;
  /**
   * The period's TOTAL allowance before any consumption, present only on a `lease-valid` verdict
   * whose lease was issued at schema v2. A v1 lease carries no total, so this is absent and a surface
   * that wants a denominator must render without one rather than substituting `allowanceTokens`.
   *
   * WHY IT IS SIGNED RATHER THAN DERIVED: the server's consumption sum is ACCOUNT-scoped, so another
   * device's debits shrink `allowanceTokens` here invisibly and `allowanceTokens + this device's
   * journal` under-reports the period total by exactly the other devices' usage — a countdown built
   * that way would silently shrink its own denominator. See `period_allowance_tokens` in `lease.ts`.
   *
   * REPORTING-ONLY, and deliberately so: nothing is enforced against it. The ceiling is
   * `allowanceTokens` and the journal, exactly as before this field existed.
   */
  periodAllowanceTokens?: number;
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
   * use is letting a surface say something true about WHAT a spent allowance pauses (input
   * optimization, not output shaping) and when it comes back. It does not authorize, refuse, or gate
   * anything.
   *
   * SANCTIONED READERS — the COMPLETE list, mirrored by `SANCTIONED_READERS` in
   * `tests/security/metered-balance-is-not-a-gate.test.ts`. That test parses the entries below and
   * fails if the two lists drift, so THIS LIST AND THAT ONE MUST BE UPDATED IN LOCKSTEP. Every entry is
   * reporting-only; none of them refuses, authorizes, or clamps anything:
   *   - `src/core/onboarding-preferences.ts` — sets the `all-routes` pause scope on `resolveOpenTier`;
   *     changes no tier.
   *   - `src/cli/commands/lease.ts` — `lease status` copy: a valid lease whose metered balance is spent.
   *   - `src/cli/commands/mode.ts` — `mode full` copy: enables the mode, states the ceiling.
   *   - `src/cli/commands/usage.ts` — REPORTING-ONLY. It chooses which remaining-line to print, and that
   *     line's number, label and copy prefix: a server-signed zero is definitive, so it is reported
   *     rather than deferred to the journal-integrity fallback. It refuses nothing and takes no action.
   *
   * WHERE THE METERED BALANCE GATE ACTUALLY LIVES — two places, neither of them here:
   *   1. `gateway/server.ts`, which reads the integrity-gated journal tally and pauses input
   *      optimization at/over the ceiling (pre-dispatch), on every route;
   *   2. `usage/usage-journal.ts`'s `appendUsageEvent` ceiling, re-evaluated against a fresh tally
   *      under the append lock — the AUTHORITATIVE check, and the only one that bounds concurrency.
   * Both work off `allowanceTokens` and the journal. Neither needs this boolean, and adding a third
   * gate that reads it would not make the ceiling stronger.
   *
   * WHY THE PROHIBITION, stated so the reasoning survives the commit: this field replaced a terminal
   * `allowance-exhausted` VERDICT, whose whole defect was that a LEASE READER answered a question that
   * belongs to the apply path. Callers asking a different question entirely (the tier clamp, the
   * gateway's entitlement gate, `mode full`) read that verdict and withdrew the whole capability —
   * including the output shaping the allowance never bought, which must keep running on a spent
   * period. Wiring an enforcement path to this boolean recreates the defect under a new name, however
   * locally reasonable the call site looks.
   *
   * A caller that asks only `label === "lease-valid"` gets the ENTITLEMENT answer. A caller that needs
   * to gate INPUT optimization on the balance must use the two checks above, which are evaluated
   * against the journal at dispatch time rather than against a snapshot signed when the lease was
   * issued.
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
 * Verify a signed lease that is not necessarily on disk yet. Same fail-closed chain as
 * `readLeaseVerdict` (signature → device → period → expiry), so a renew candidate can be checked
 * BEFORE it replaces a still-valid stored lease.
 */
export function verifySignedLease(
  signed: SignedLease,
  env: ConfigDirEnv = process.env,
  now: Date = new Date()
): LeaseVerdict {
  const { lease, signature } = signed;

  const sig = verifyLeaseSignatureBytes(canonicalLeaseBytes(lease), signature, env);
  if (!sig.verified) return { label: "lease-invalid" };

  const devicePublicKey = readDevicePublicKey(env);
  if (!devicePublicKey) return { label: "lease-invalid" };
  if (publicKeyHash(devicePublicKey) !== lease.device_public_key_hash) return { label: "lease-wrong-device" };

  if (lease.period_id !== currentPeriodId(now)) return { label: "lease-wrong-period" };
  if (Number.isNaN(Date.parse(lease.expires_at)) || now.getTime() > Date.parse(lease.expires_at)) {
    return { label: "lease-expired" };
  }

  return {
    label: "lease-valid",
    trust: sig.trust,
    allowanceTokens: lease.allowance_tokens,
    periodId: lease.period_id,
    ...(lease.period_allowance_tokens !== undefined ? { periodAllowanceTokens: lease.period_allowance_tokens } : {}),
    ...(lease.allowance_tokens <= 0 ? { meteredBalanceExhausted: true } : {})
  };
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
  return verifySignedLease(parsed, env, now);
}

/**
 * Convenience: whether this device currently holds a VALID full-apply ENTITLEMENT lease.
 *
 * Entitlement only — a valid lease whose metered balance is spent still answers `true`, because the
 * device is still entitled to the private engine and its output shaping keeps running on a spent
 * period. A caller gating INPUT optimization must additionally consult the balance.
 */
export function hasValidFullApplyLease(env: ConfigDirEnv = process.env, now: Date = new Date()): boolean {
  return readLeaseVerdict(env, now).label === "lease-valid";
}

/**
 * How far ahead of `expires_at` a still-valid lease should be renewed.
 *
 * The server issues a 24h TTL (`LEASE_TTL_MS`). Renewal is supposed to be invisible: a long-lived
 * gateway or a device that only runs `status`/`compaction` must refresh BEFORE the verdict flips to
 * `lease-expired`, otherwise Full apply silently disappears until the user re-runs activation.
 * Two hours leaves room for transient network failure without waiting until expiry.
 */
export const LEASE_REFRESH_BEFORE_MS = 2 * 60 * 60 * 1000;

/**
 * Whether this device should attempt a silent lease renew NOW.
 *
 * True when there is no usable lease, OR when a valid lease is inside the refresh window. Local-disk
 * only — never a network call. Callers that may touch the network (`ensureCommunityRuntime`, status,
 * gateway start/request recovery) consult this before deciding whether acquisition is needed.
 */
export function leaseNeedsRenewal(env: ConfigDirEnv = process.env, now: Date = new Date()): boolean {
  const path = leasePath(env);
  if (!existsSync(path)) return true;

  let expiresAtMs: number | undefined;
  try {
    const parsed = parseSignedLease(JSON.parse(readFileSync(path, "utf8")));
    if (!parsed) return true;
    expiresAtMs = Date.parse(parsed.lease.expires_at);
    if (Number.isNaN(expiresAtMs)) return true;
  } catch {
    return true;
  }

  const verdict = readLeaseVerdict(env, now);
  if (verdict.label !== "lease-valid") return true;
  return expiresAtMs - now.getTime() <= LEASE_REFRESH_BEFORE_MS;
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
