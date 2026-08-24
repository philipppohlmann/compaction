/**
 * ONE call that makes a Community device's runtime match its entitlement: hold a valid lease, and
 * have the signed engine on disk.
 *
 * WHY THIS EXISTS. The product journey says a user chooses Community, confirms in a browser, and
 * then works normally — with full behavior available automatically wherever they are eligible. It
 * also says the words `lease`, `entitlement`, `engine install` and `root key` are implementation
 * vocabulary the user never has to learn. Those two sentences together mean the repair has to be
 * something the product DOES, not something the user is told to run: activation acquired a lease
 * inline and stopped there, so a device whose lease expired at a month boundary, or that activated
 * before a signed engine existed, sat in a state only `compaction lease renew` could leave.
 *
 * IDEMPOTENT AND CHEAP ON THE HAPPY PATH. A valid lease and a present engine cost two local reads
 * and no network call at all, which is what makes it safe to call from several surfaces rather than
 * one. Work happens only where something is actually missing.
 *
 * FAIL-SOFT, NEVER FAIL-FALSE. Every step degrades to an honest coded reason and never throws: a
 * failed repair leaves the device exactly as entitled as it was, and the caller must render what
 * this returns rather than what it hoped for. Specifically it never reports a lease as usable
 * without re-reading the verdict from disk — a service can return a lease this build's pinned root
 * refuses, and "acquired" is not "valid".
 *
 * NO ACCOUNT ⇒ NO NETWORK. With no credentials the whole thing is a single local read and an
 * `account: "absent"` result, so an Open device keeps the "no account, no network call" property the
 * Open surfaces promise.
 *
 * DYNAMIC IMPORTS, deliberately. `auth/**`, `api-client/**` and `engine-install/**` are all
 * forbidden on the Open basic import graph (`open-basic-engine-free.test.ts`), and `mode` is an Open
 * entry point that calls this. They are reached through the same sanctioned `import()` seam
 * `engine-availability.ts` uses, so this module can be imported from an Open surface without putting
 * any of them on its static graph.
 */

import { engineAvailability } from "../engine-availability.js";
import { engineEulaAccepted } from "../legal/engine-eula.js";
import { readLeaseVerdict } from "./lease-store.js";
import type { ConfigDirEnv } from "../config-dir.js";

/** What the device's entitlement lease looks like after the attempt. */
export type CommunityLeaseState =
  /** A valid lease was already on disk — nothing was fetched. */
  | "valid"
  /** One was acquired (or renewed) from the service and verified against the pinned root. */
  | "renewed"
  /** Still no valid lease. `reason` says why, in a coded, content-free form. */
  | "unavailable";

/** What the private engine looks like after the attempt. */
export type CommunityEngineState =
  /** An engine already resolved — nothing was downloaded. */
  | "present"
  /** A signed release was fetched, verified and installed by this call. */
  | "installed"
  /** Still none. `reason` says why. */
  | "unavailable";

export interface CommunityRuntimeOutcome {
  /** Whether this device has credentials at all. `absent` ⇒ nothing was attempted and no network call was made. */
  account: "present" | "absent";
  lease: CommunityLeaseState;
  engine: CommunityEngineState;
  /**
   * Coded reason for the FIRST step that fell short, content-free and safe to display. Absent when
   * both the lease and the engine ended up in place.
   */
  reason?: string;
  /** True iff a network call was actually made, so a caller can keep a "no network" promise honest. */
  networkUsed: boolean;
}

/** The lease verdicts a fresh acquisition can plausibly repair. `lease-valid` is not one of them. */
function leaseNeedsAcquisition(label: string): boolean {
  return label !== "lease-valid";
}

/**
 * Bring the device's lease and engine into line with its entitlement, doing only the work that is
 * actually missing. Never throws.
 *
 * `onProgress` is optional and display-only: it is called before each step that will touch the
 * network, so a surface can say what it is waiting on. It receives no identifiers.
 *
 * CANCELLATION IS REAL, not decorative. Onboarding renders "Esc / Ctrl-C to stop and continue on
 * Open" while this runs, and that promise used to be a UI state change only: the signal stopped at
 * the device-login step and never reached here, so a keypress left lease acquisition and a
 * multi-megabyte engine download running to completion behind a screen that had already moved on.
 * `opts.signal` is now checked between steps AND threaded into every network call underneath, so an
 * abort ends the transfer. A cancelled attempt reports the `cancelled` reason — a user's decision,
 * never dressed up as an unreachable service — and leaves the device exactly as entitled as it was,
 * with ONE deliberate exception: if usage was already handed over to the service and the renewal
 * that reflects it then does not land, the stale lease is removed rather than left promising an
 * allowance the service has already debited (see the note at the lease step).
 */
export async function ensureCommunityRuntime(
  env: ConfigDirEnv = process.env,
  onProgress: (step: "lease" | "engine") => void = () => {},
  opts: { signal?: AbortSignal } = {}
): Promise<CommunityRuntimeOutcome> {
  let networkUsed = false;
  const signal = opts.signal;
  const cancelled = (): boolean => signal?.aborted === true;

  // The credentials read is dynamic for the import-graph reason above, and it is the ONLY thing that
  // happens on a device with no account.
  const { readStoredCredentials } = await import("../auth/credentials.js");
  const credentials = readStoredCredentials(env as NodeJS.ProcessEnv);
  if (!credentials) {
    return { account: "absent", lease: "unavailable", engine: "unavailable", reason: "no-account", networkUsed };
  }
  // Cancelled before any network work started: report it as such rather than beginning work the
  // caller has already told us it no longer wants.
  if (cancelled()) {
    return { account: "present", lease: "unavailable", engine: "unavailable", reason: "cancelled", networkUsed };
  }

  // ---- Usage reconciliation ----------------------------------------------------------------------
  //
  // WHY THIS IS HERE AND NOT IN THE APPLY PATH. The allowance is SERVER-AUTHORITATIVE: a lease carries
  // `allowance_tokens` already reduced by every debit the service has recorded, and the client adds
  // only its own UNRECONCILED journal entries on top (`readPeriodConsumption`). Those two halves stay
  // disjoint, so nothing is ever counted twice — but only if the local half is periodically handed
  // over. Until it is, the service keeps reissuing the FULL allowance and the ceiling never arrives,
  // which is how a device could burn through its period and still be told it had 2M left.
  //
  // Reconciliation used to be reachable only from `compaction usage reconcile` and `compaction lease`.
  // Both are implementation vocabulary the journey says a user never has to learn, so in practice the
  // handover never happened. Doing it here puts it on the paths that already run by themselves.
  //
  // IT STILL NEVER GATES THE WORKFLOW, and it is still not a per-turn fetch (offline policy (a)):
  // this runs once per surface invocation, not once per request, and it never enters
  // `resolveStoredAuthorizationApply`. A failure is swallowed whole — a device that cannot reach the
  // service keeps working on exactly the entitlement it already holds.
  //
  // BOUNDED AND IDEMPOTENT BY CONSTRUCTION: `reconcileStoredUsage` returns `nothing-to-reconcile`
  // without touching the network when the watermark is already current, which is the overwhelmingly
  // common case, and the server deduplicates by `event_id` so a re-send of an already-recorded entry
  // is counted as `duplicate`, never debited again.
  //
  // WHAT COUNTS AS A HANDOVER IS THE WATERMARK MOVING, not the value this call returns. An upload
  // that commits some chunks and then fails — a dropped connection, an Esc mid-batch — records the
  // watermark for the entries the service DID accept and only then rethrows, so the partial commit
  // arrives here as an exception with no result at all. The watermark is the thing that actually
  // moved, and it is the thing that just made the local half of the ceiling smaller, so it is what
  // this reads: before, and again after.
  const watermarkFingerprint = async (): Promise<string> => {
    try {
      const { readReconciliationWatermark } = await import("../usage/reconciliation-watermark.js");
      return JSON.stringify(await readReconciliationWatermark(env));
    } catch {
      return ""; // unreadable reads the same both times, so it reports no movement rather than false movement
    }
  };
  const watermarkBefore = await watermarkFingerprint();
  try {
    const { reconcileStoredUsage } = await import("../auth/usage-reconcile-client.js");
    const result = await reconcileStoredUsage(credentials.api_url, env as ConfigDirEnv & NodeJS.ProcessEnv, new Date(), {
      ...(signal === undefined ? {} : { signal })
    });
    if (result.reconciled) networkUsed = true;
  } catch {
    // Best-effort, deliberately silent. The next invocation retries from the same watermark; a
    // partially-committed upload already recorded its own watermark before throwing, so the entries
    // the service DID accept are not charged locally a second time.
  }
  const usageReconciled = (await watermarkFingerprint()) !== watermarkBefore;
  if (usageReconciled) networkUsed = true;

  // ---- Lease ------------------------------------------------------------------------------------
  let lease: CommunityLeaseState;
  let reason: string | undefined;

  // A lease that is merely VALID is not necessarily CURRENT. When usage was just handed over, the
  // lease on disk still carries the pre-reconciliation allowance, and keeping it would let the
  // runtime spend an allowance the service has already debited. Re-acquiring is what makes the
  // server's number the one this device actually enforces — and is what lets the ceiling be observed
  // by the process that is running right now, since every request re-reads the verdict from disk.
  if (!usageReconciled && !leaseNeedsAcquisition(readLeaseVerdict(env).label)) {
    lease = "valid";
  } else {
    onProgress("lease");
    networkUsed = true;
    try {
      const { acquireLease, writeStoredLease, LeaseClientError } = await import("../auth/lease-client.js");
      try {
        writeStoredLease(
          await acquireLease(credentials.api_url, credentials.device_token, {
            ...(signal === undefined ? {} : { signal })
          }),
          env
        );
      } catch (error) {
        throw error instanceof LeaseClientError ? error : new Error(String(error));
      }
      // RE-READ, do not assume. The service issued it; this build's pinned root decides whether it
      // counts, and a lease that does not verify must not be reported as one that does.
      lease = readLeaseVerdict(env).label === "lease-valid" ? "renewed" : "unavailable";
      if (lease === "unavailable") reason = "lease-unverifiable";
    } catch (error) {
      lease = "unavailable";
      reason = typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : "lease-unavailable";
    }

    // A HANDOVER WITHOUT A RENEWAL LEAVES THE STALE LEASE UNUSABLE, ON PURPOSE.
    //
    // The two halves of the ceiling are disjoint only while each token sits in exactly one of them.
    // Handing usage over moves it out of the local half — `readPeriodConsumption` stops counting
    // everything behind the watermark — and into the server's, which the device only sees when a
    // NEW lease arrives carrying the reduced allowance. If the renewal then does not land, those
    // tokens are counted nowhere: the lease on disk still promises the pre-handover allowance, and
    // the journal no longer argues with it. Worse, it does not heal by itself — the next invocation
    // finds nothing left to reconcile and a lease that still verifies, takes the cheap path, and
    // leaves the device spending an allowance the service already debited until that lease expires.
    //
    // So the lease stops being authoritative. Removing it is not a downgrade dressed up as safety:
    // it is the same fail-closed direction every other unverifiable authorization takes here, it
    // costs only full apply until the next surface invocation repairs it automatically, and it is
    // the only outcome in which no token is spent twice or spent for free.
    if (lease !== "renewed" && usageReconciled) {
      try {
        const { deleteStoredLease } = await import("../auth/lease-client.js");
        deleteStoredLease(env);
      } catch {
        // Best-effort: a lease we cannot remove is still gated by the verdict read on every request.
      }
    }
  }

  // ---- Engine -----------------------------------------------------------------------------------
  // Attempted even when the lease step failed. The two are independent: an engine on disk is not an
  // authorization to use it (the lease gate is enforced elsewhere, every request), and leaving the
  // engine missing would just mean a second round trip once the lease is repaired.
  let engine: CommunityEngineState;
  const availability = await engineAvailability(env as NodeJS.ProcessEnv);
  if (availability === "present") {
    engine = "present";
  } else if (cancelled()) {
    // Do NOT start a multi-megabyte download the caller has already abandoned. The engine is simply
    // still missing, for the honest reason that the attempt was stopped.
    engine = "unavailable";
    reason ??= "cancelled";
  } else if (availability === "unavailable") {
    // No release root is pinned in this build, so no release could be verified even if one existed.
    engine = "unavailable";
    reason ??= "no-release-root";
  } else if (!engineEulaAccepted(env)) {
    // THE ACQUISITION IS THE LICENSED ACT, so the licence gate sits exactly here and nowhere earlier.
    // A user on the Open path never reaches this line and is never asked for anything.
    //
    // FAIL CLOSED, AND SAY SO. Every caller of this function is a repair path — the onboarding
    // stepper, `mode full`, a gateway start — and most of them have no terminal to ask in. Downloading
    // a separately licensed artifact on a device that has not accepted its terms would be the wrong
    // way to resolve that, so the engine is simply reported missing with a reason the surfaces can
    // turn into the one command that fixes it. Nothing is downloaded, and no consent is inferred.
    engine = "unavailable";
    reason ??= "eula-not-accepted";
  } else {
    onProgress("engine");
    networkUsed = true;
    try {
      const { installEngineRelease } = await import("../engine-install/installer.js");
      await installEngineRelease({
        channel: "stable",
        env: env as NodeJS.ProcessEnv,
        ...(signal === undefined ? {} : { signal })
      });
      // Same rule as the lease: ask the resolver, do not trust the return. An install that cannot be
      // verified at run time never runs, and must not be reported as an engine that is there.
      engine = (await engineAvailability(env as NodeJS.ProcessEnv)) === "present" ? "installed" : "unavailable";
      if (engine === "unavailable") reason ??= "engine-unverifiable";
    } catch (error) {
      engine = "unavailable";
      reason ??= typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : "engine-unavailable";
    }
  }

  return {
    account: "present",
    lease,
    engine,
    ...(reason === undefined ? {} : { reason }),
    networkUsed
  };
}

/**
 * Why full apply is still out of reach after a repair attempt, in product language.
 *
 * ONE SOURCE for a claim that lives on several surfaces (`init` activation, `mode full`). Every
 * branch states what THIS BUILD or THIS SERVICE reported, never the state of the world: "no signed
 * engine release has been distributed yet" was true only while none existed, and a release was
 * published on 2026-08-19, which turned it into a false explanation for a device whose download or
 * verification simply failed. The two causes are also genuinely different — a build with no pinned
 * root can never verify anything, while a service with nothing published on a channel is a service
 * answer that changes without a new client — so they no longer share a sentence.
 */
export function engineBlockedReason(outcome: CommunityRuntimeOutcome): string {
  if (outcome.reason === "no-release-root") {
    return "this build pins no engine release root, so no release can be verified on it";
  }
  if (outcome.reason === "no-published-release") {
    return "your Compaction service has no published engine release on this channel";
  }
  if (outcome.reason === "eula-not-accepted") {
    return (
      "the Compaction Engine License Agreement has not been accepted on this device " +
      "(review and accept it with `compaction engine license --accept`)"
    );
  }
  if (outcome.reason === "cancelled") {
    return "the setup was stopped before the private engine finished installing";
  }
  if (outcome.engine === "unavailable" && outcome.reason !== undefined) {
    return `the private engine could not be installed on this device (${outcome.reason})`;
  }
  // FALLBACK: reached only with no coded reason to report. It used to repeat the world-claim above,
  // which a published release turned into a falsehood for every device that simply has not fetched
  // one. It now says the one thing that is true in every state that lands here — the engine is not
  // on this device — and claims nothing about whether a release exists.
  return "the private engine is not available on this device";
}

/**
 * Why the entitlement is still missing, as a phrase a user can act on rather than a wire code.
 *
 * The coded `reason` is deliberately content-free so it is safe to log and to display; it is not
 * English. Rendering it raw produced refusals that ended in "(network)". Unknown codes fall through
 * unchanged — an unfamiliar code shown verbatim is a debugging aid, whereas a generic "something went
 * wrong" would delete the only information the line carries.
 */
export function leaseBlockedReason(outcome: CommunityRuntimeOutcome): string {
  switch (outcome.reason) {
    case "network":
      return "the entitlement service could not be reached";
    case "http_error":
    case "invalid_response":
      return "the entitlement service did not answer as expected";
    case "unauthorized":
    case "device_inactive":
      return "this device is no longer active on the account";
    case "not_entitled":
      return "no Community entitlement is active for this account";
    case "signing_unavailable":
      return "the entitlement service cannot issue leases right now";
    case "lease-unverifiable":
      return "the entitlement it issued did not verify on this device";
    case "cancelled":
      // A USER DECISION, not a fault. Saying the service failed here would blame it for a keypress.
      return "the setup was stopped before it finished";
    default:
      return outcome.reason ?? "reason unknown";
  }
}

/**
 * What the repair actually CHANGED on this device, in product language — one line per thing that
 * happened, and an EMPTY list when nothing did.
 *
 * ONE SOURCE, because two surfaces make the same report. `compaction login` used to end every
 * Community attempt with "Nothing was changed by the attempt", which is false on the common case
 * this call exists for: a device whose lease had lapsed, or that predates the signed engine, has just
 * had one or both re-established. Saying nothing changed there hides the thing the user came for.
 *
 * Only the states that mean WORK WAS DONE appear: `valid`/`present` mean it was already in place, so
 * they are not news, and `unavailable` is a failure the caller reports through the blocked-reason
 * helpers instead. The lines name the outcome, never the mechanism — no lease, root, or engine-root
 * vocabulary crosses this boundary.
 */
export function describeRepairActions(outcome: CommunityRuntimeOutcome): string[] {
  const lines: string[] = [];
  if (outcome.lease === "renewed") lines.push("Renewed this device's Community access.");
  if (outcome.engine === "installed") lines.push("Installed the signed optimization engine on this device.");
  return lines;
}

/** Whether the outcome means the device can actually perform a full apply right now. */
export function communityRuntimeReady(outcome: CommunityRuntimeOutcome): boolean {
  return (outcome.lease === "valid" || outcome.lease === "renewed") && (outcome.engine === "present" || outcome.engine === "installed");
}
