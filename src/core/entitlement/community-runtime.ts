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
import { compactionConfigDir, type ConfigDirEnv } from "../config-dir.js";
import { leaseNeedsRenewal, readLeaseVerdict, verifySignedLease } from "./lease-store.js";

/**
 * Bound for request-time lease recovery on the gateway apply path. A hung entitlement service must
 * not stall provider traffic for the network stack's full timeout — the current request fails open
 * to record-only, and the next request can retry.
 */
export const REQUEST_TIME_LEASE_RENEW_MS = 2_500;

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

/**
 * Server answers that mean Community authorization is GONE for this device — not a blip.
 * Only these may clear a stored lease. Transient network/HTTP failures must leave existing state
 * alone: deleting a still-usable lease on a 503 is how a signed-in Community device silently became
 * Plan: Open / "needs activation" during normal use.
 */
function isAuthoritativeLeaseDenial(code: string | undefined): boolean {
  return code === "not_entitled" || code === "unauthorized" || code === "device_inactive";
}

/**
 * Lease-repair in-flight map (config dir → promise). Shared by lease-only callers AND the lease
 * half of a full repair, so concurrent renews coalesce without making a lease-only caller wait for
 * an engine download that a full repair may still be running.
 */
const inflightLeaseRepairs = new Map<string, Promise<LeaseRepairOutcome>>();

/** Full-repair in-flight map — never returned to a lease-only caller. */
const inflightFullRepairs = new Map<string, Promise<CommunityRuntimeOutcome>>();

/** Lease half of a repair — enough for request-time recovery without an engine step. */
interface LeaseRepairOutcome {
  account: "present" | "absent";
  lease: CommunityLeaseState;
  reason?: string;
  networkUsed: boolean;
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
 * never dressed up as an unreachable service — and leaves the device exactly as entitled as it was.
 *
 * Authoritative server denials (`not_entitled` / `unauthorized` / `device_inactive`) still clear the
 * lease. Transient renew failures never do: Community activation is persistent from the user's
 * point of view, and a brief outage must not force them through browser activation again.
 *
 * `opts.leaseOnly` skips the engine step — used by request-time recovery so a missing/expired lease
 * can be repaired without starting a multi-megabyte download on the apply path. Lease-only callers
 * coalesce on the lease repair only; they never await a concurrent full repair's engine half.
 */
export async function ensureCommunityRuntime(
  env: ConfigDirEnv = process.env,
  onProgress: (step: "lease" | "engine") => void = () => {},
  opts: { signal?: AbortSignal; engineIntent?: "automatic" | "explicit"; leaseOnly?: boolean } = {}
): Promise<CommunityRuntimeOutcome> {
  if (opts.leaseOnly) {
    const leaseOutcome = await ensureCommunityLease(env, onProgress, opts.signal);
    return {
      account: leaseOutcome.account,
      lease: leaseOutcome.lease,
      engine: "unavailable",
      ...(leaseOutcome.reason === undefined ? {} : { reason: leaseOutcome.reason }),
      networkUsed: leaseOutcome.networkUsed
    };
  }

  const dirKey = compactionConfigDir(env);
  const existingFull = inflightFullRepairs.get(dirKey);
  if (existingFull) return existingFull;

  const run = runFullCommunityRepair(env, onProgress, opts).finally(() => {
    if (inflightFullRepairs.get(dirKey) === run) inflightFullRepairs.delete(dirKey);
  });
  inflightFullRepairs.set(dirKey, run);
  return run;
}

async function ensureCommunityLease(
  env: ConfigDirEnv,
  onProgress: (step: "lease" | "engine") => void,
  signal?: AbortSignal
): Promise<LeaseRepairOutcome> {
  const dirKey = compactionConfigDir(env);
  const existing = inflightLeaseRepairs.get(dirKey);
  if (existing) {
    // CALLER-LOCAL BOUND. Returning `existing` alone would make a request-time AbortSignal a no-op
    // whenever gateway start / status already began a hung repair without that signal — the gateway
    // would stay blocked past REQUEST_TIME_LEASE_RENEW_MS. Race the shared work against THIS caller's
    // abort; do not cancel the shared repair (other callers may still need it).
    return signal ? awaitSharedLeaseRepair(existing, signal, env) : existing;
  }

  const run = runLeaseRepair(env, onProgress, signal).finally(() => {
    if (inflightLeaseRepairs.get(dirKey) === run) inflightLeaseRepairs.delete(dirKey);
  });
  inflightLeaseRepairs.set(dirKey, run);
  return run;
}

/**
 * Wait for a shared lease repair, but let THIS caller leave early when its AbortSignal fires.
 * The shared promise keeps running — abort here is a wait bound, not a cancellation of others' work.
 */
function awaitSharedLeaseRepair(
  existing: Promise<LeaseRepairOutcome>,
  signal: AbortSignal,
  env: ConfigDirEnv
): Promise<LeaseRepairOutcome> {
  const abortedOutcome = (): LeaseRepairOutcome => {
    const stillValid = readLeaseVerdict(env).label === "lease-valid";
    return {
      account: "present",
      lease: stillValid ? "valid" : "unavailable",
      reason: "cancelled",
      networkUsed: true
    };
  };
  if (signal.aborted) return Promise.resolve(abortedOutcome());

  return new Promise<LeaseRepairOutcome>((resolve) => {
    let settled = false;
    const finish = (outcome: LeaseRepairOutcome): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve(outcome);
    };
    const onAbort = (): void => finish(abortedOutcome());
    signal.addEventListener("abort", onAbort, { once: true });
    existing.then(
      (outcome) => finish(outcome),
      () => finish(abortedOutcome())
    );
  });
}

async function runFullCommunityRepair(
  env: ConfigDirEnv,
  onProgress: (step: "lease" | "engine") => void,
  opts: { signal?: AbortSignal; engineIntent?: "automatic" | "explicit" }
): Promise<CommunityRuntimeOutcome> {
  const leaseOutcome = await ensureCommunityLease(env, onProgress, opts.signal);
  if (leaseOutcome.account === "absent") {
    return {
      account: "absent",
      lease: "unavailable",
      engine: "unavailable",
      reason: leaseOutcome.reason ?? "no-account",
      networkUsed: leaseOutcome.networkUsed
    };
  }
  return runEngineRepair(env, onProgress, opts, leaseOutcome);
}

async function runLeaseRepair(
  env: ConfigDirEnv,
  onProgress: (step: "lease" | "engine") => void,
  signal?: AbortSignal
): Promise<LeaseRepairOutcome> {
  let networkUsed = false;
  const cancelled = (): boolean => signal?.aborted === true;

  const { readStoredCredentials } = await import("../auth/credentials.js");
  const credentials = readStoredCredentials(env as NodeJS.ProcessEnv);
  if (!credentials) {
    return { account: "absent", lease: "unavailable", reason: "no-account", networkUsed };
  }
  if (cancelled()) {
    const stillValid = readLeaseVerdict(env).label === "lease-valid";
    return {
      account: "present",
      lease: stillValid ? "valid" : "unavailable",
      reason: "cancelled",
      networkUsed
    };
  }

  let usageReconciled = false;
  let commitReconciliationWatermark: (() => Promise<void>) | undefined;
  try {
    const client = await import("../auth/usage-reconcile-client.js");
    try {
      const result = await client.reconcileStoredUsage(
        credentials.api_url,
        env as ConfigDirEnv & NodeJS.ProcessEnv,
        new Date(),
        {
          ...(signal === undefined ? {} : { signal }),
          // A reconcile and the replacement lease are one accounting handover. Until a verified
          // replacement lands, keep these entries in the local half of the ceiling so a transient
          // lease failure cannot replenish headroom. Explicit reconcile callers keep the default
          // immediate-watermark behavior.
          deferWatermark: true
        }
      );
      if (result.reconciled) {
        usageReconciled = true;
        networkUsed = true;
        commitReconciliationWatermark = () =>
          client.recordReconciliationWatermark(result.summary, env);
      }
    } catch (error) {
      // A partial upload may already have committed server-side. Treat it as a handover that needs
      // a replacement lease, but leave its watermark deferred so the stale lease remains paired
      // with the conservative local tally until that replacement verifies.
      if (error instanceof client.UsageReconcileClientError && error.partial) {
        usageReconciled = true;
        networkUsed = true;
        const partial = error.partial;
        commitReconciliationWatermark = () =>
          client.recordReconciliationWatermark(partial, env);
      }
    }
  } catch {
    // Best-effort.
  }

  let lease: CommunityLeaseState;
  let reason: string | undefined;

  if (!usageReconciled && !leaseNeedsRenewal(env)) {
    lease = "valid";
  } else {
    onProgress("lease");
    networkUsed = true;
    // Snapshot BEFORE acquire: a near-expiry device must keep this authorization if the candidate
    // does not verify — writing first made renew itself the silent Open downgrade.
    const hadValidLease = readLeaseVerdict(env).label === "lease-valid";
    try {
      const { acquireLease, writeStoredLease, LeaseClientError } = await import("../auth/lease-client.js");
      let acquired;
      try {
        acquired = await acquireLease(credentials.api_url, credentials.device_token, {
          ...(signal === undefined ? {} : { signal })
        });
      } catch (error) {
        throw error instanceof LeaseClientError ? error : new Error(String(error));
      }
      // VERIFY BEFORE REPLACE. An unverifiable candidate must not overwrite a still-valid lease
      // (signing-root rollout, wrong-device/period payload, etc.).
      if (verifySignedLease(acquired, env).label === "lease-valid") {
        writeStoredLease(acquired, env);
        lease = "renewed";
      } else {
        reason = "lease-unverifiable";
        lease = hadValidLease || readLeaseVerdict(env).label === "lease-valid" ? "valid" : "unavailable";
      }
    } catch (error) {
      reason = typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : "lease-unavailable";
      if (readLeaseVerdict(env).label === "lease-valid") {
        lease = "valid";
      } else {
        lease = "unavailable";
      }
    }

    if (lease !== "renewed" && isAuthoritativeLeaseDenial(reason)) {
      try {
        const { deleteStoredLease } = await import("../auth/lease-client.js");
        deleteStoredLease(env);
      } catch {
        // Best-effort.
      }
      lease = "unavailable";
    }

    if (lease === "renewed" && commitReconciliationWatermark) {
      // If this best-effort write fails, the client conservatively counts the entries locally on
      // top of the new server-net lease until a later reconcile. That may understate headroom; it
      // can never grant unearned headroom.
      await commitReconciliationWatermark();
    }
  }

  return {
    account: "present",
    lease,
    ...(reason === undefined ? {} : { reason }),
    networkUsed
  };
}

async function runEngineRepair(
  env: ConfigDirEnv,
  onProgress: (step: "lease" | "engine") => void,
  opts: { signal?: AbortSignal; engineIntent?: "automatic" | "explicit" },
  leaseOutcome: LeaseRepairOutcome
): Promise<CommunityRuntimeOutcome> {
  let networkUsed = leaseOutcome.networkUsed;
  let reason = leaseOutcome.reason;
  const lease = leaseOutcome.lease;
  const signal = opts.signal;
  const cancelled = (): boolean => signal?.aborted === true;

  // Managed repairs only stage a coherent pair. The current session retains its selected pair;
  // a successful download is not evidence that this running session can use the new engine.
  const { loadExecutingManagedInstallation } = await import("../update/ownership.js");
  let managed: ReturnType<typeof loadExecutingManagedInstallation>;
  try {
    managed = loadExecutingManagedInstallation(env as NodeJS.ProcessEnv);
  } catch {
    return { account: "present", lease, engine: "unavailable", reason: reason ?? "managed-state-invalid", networkUsed };
  }
  if (managed) {
    if (cancelled()) return { account: "present", lease, engine: "unavailable", reason: reason ?? "cancelled", networkUsed };
    if ((await engineAvailability(env as NodeJS.ProcessEnv)) === "present") {
      return { account: "present", lease, engine: "present", ...(reason ? { reason } : {}), networkUsed };
    }
    try {
      const { stageManagedEngine } = await import("../update/engine-pair.js");
      const candidate = await stageManagedEngine(managed.root, {
        env: env as NodeJS.ProcessEnv,
        signal,
        intent: opts.engineIntent ?? "automatic",
        onNetwork: () => {
          networkUsed = true;
          onProgress("engine");
        }
      });
      reason ??= candidate.reason ?? (candidate.staged ? "engine-staged-next-session" : "engine-unavailable");
    } catch {
      reason ??= "engine-update-deferred";
    }
    return { account: "present", lease, engine: "unavailable", reason, networkUsed };
  }

  // Attempted even when the lease step failed. The two are independent: an engine on disk is not an
  // authorization to use it (the lease gate is enforced elsewhere, every request), and leaving the
  // engine missing would just mean a second round trip once the lease is repaired.
  let engine: CommunityEngineState;
  const availability = await engineAvailability(env as NodeJS.ProcessEnv);
  if (availability === "present") {
    engine = "present";
  } else if (cancelled()) {
    engine = "unavailable";
    reason ??= "cancelled";
  } else if (availability === "unavailable") {
    engine = "unavailable";
    reason ??= "no-release-root";
  } else if (!engineEulaAccepted(env)) {
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
  if (outcome.reason === "engine-staged-next-session") {
    return "a compatible engine is staged for a safe next session; this session keeps its current pair";
  }
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
