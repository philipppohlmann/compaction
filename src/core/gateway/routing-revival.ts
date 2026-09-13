/**
 * Restore a transparent-routing gateway at the address already pinned into a live session.
 * Prompt-time repair is bounded and fail-open; status-line repair is detached and non-blocking.
 * Reachability alone is never trusted: a listener must pass the authenticated gateway identity
 * handshake or the slot is quarantined. A slot must already exist, so explicit teardown disables
 * revival before signalling the old process.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  acquireEnsureLock,
  defaultSpawnGatewayStart,
  isGatewayReachable,
  releaseEnsureLock,
  routingGatewayStartArgs,
  signallable
} from "./ensure.js";
import {
  appendRoutingLog,
  quarantineRoutingSlot,
  routingDir,
  routingSlotLockPath,
  routingSlotsForCwd,
  type ListedRoutingSlot,
  type RoutingSlotRecord
} from "./routing-registry.js";
import { clearRoutingEndpointDown, markRoutingEndpointDown } from "./routing-health.js";
import { isProcessAlive } from "./status.js";
import { queryGatewayIdentity } from "./update-identity.js";
import type { ShimEnv } from "../tool-shim.js";

/** Hard cap for the synchronous (`UserPromptSubmit`) repair. The turn is waiting on this. */
export const REVIVAL_BUDGET_MS = 1500;

/** The reachability pre-filter timeout. Short: a refused connection answers immediately. */
const PROBE_TIMEOUT_MS = 150;

/**
 * Minimum interval between DETACHED respawn attempts for one slot.
 *
 * The status line fires continuously inside the render loop. Without a floor, a gateway that cannot
 * come up at all - a broken binary, a permanently held port - would be respawned on every render.
 * This is a cooldown, not a lock: it expires on its own and can never deadlock a slot. It applies
 * ONLY to the non-waiting path; the `UserPromptSubmit` repair is never rate-limited, because that is
 * the trigger the product invariant depends on.
 */
const RESPAWN_COOLDOWN_MS = 5000;

export type RoutingRevivalStatus =
  /** No slot for this directory: this session is not routed, or was explicitly disconnected. */
  | "no-slot"
  /** The reserved port is accepting and the listener PASSED the identity handshake. */
  | "healthy"
  /** The reserved port was accepting; the handshake was not attempted (non-blocking path only). */
  | "reachable"
  /** A replacement was started and is serving, verified by the handshake. */
  | "revived"
  /** A replacement was spawned detached; this call did not wait to see whether it came up. */
  | "spawned"
  /** Another revive or ensure holds the slot's single-flight lock; this call did not spawn. */
  | "locked"
  /** Something that is not our gateway holds the reserved port. Never revived, never injected. */
  | "quarantined"
  /** A respawn was due but the cooldown had not elapsed. */
  | "cooldown"
  /** A replacement was started but did not become ready within the budget. */
  | "failed";

export interface RoutingRevivalOutcome {
  status: RoutingRevivalStatus;
  reason?: string;
  port?: number;
}

export interface ReviveRoutingGatewayOptions {
  /**
   * Whether to WAIT for the replacement to serve. `true` is the `UserPromptSubmit` repair (bounded
   * by `budgetMs`); `false` is the status line, which spawns detached and returns immediately and
   * must never add gateway-start latency to a render.
   */
  wait?: boolean;
  budgetMs?: number;
  provider?: string;
  env?: ShimEnv;
  /** Spawn seam (tests inject a fake). */
  spawnGatewayStart?: (args: string[], cwd: string, slotKey: string) => void;
  /** Reachability seam (tests inject a fake so no real network is needed). */
  isReachable?: (host: string, port: number) => Promise<boolean>;
  /**
   * Identity-handshake seam, alongside the reachability one and for the same reason: without it the
   * WAITING path's success branch is only reachable by starting a real gateway, so the bookkeeping
   * that branch performs cannot be regression-tested at all. Injecting here never widens what the
   * handshake authorises - R-1 lives in the default, which is the only implementation production
   * ever uses.
   */
  queryIdentity?: (record: RoutingSlotRecord) => Promise<unknown>;
  /** Clock seam for the respawn cooldown. */
  now?: () => number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function respawnMarkerPath(key: string, env: ShimEnv): string {
  return path.join(routingDir(env), `${key}.respawn`);
}

function respawnCooldownElapsed(key: string, env: ShimEnv, now: number): boolean {
  try {
    const last = Number(readFileSync(respawnMarkerPath(key, env), "utf8").trim());
    return !Number.isFinite(last) || now - last >= RESPAWN_COOLDOWN_MS;
  } catch {
    return true;
  }
}

function recordRespawnAttempt(key: string, env: ShimEnv, now: number): void {
  try {
    mkdirSync(routingDir(env), { recursive: true, mode: 0o700 });
    writeFileSync(respawnMarkerPath(key, env), `${now}\n`, { encoding: "utf8", mode: 0o600 });
  } catch {
    /* the cooldown is a safeguard, not a correctness requirement */
  }
}

/**
 * Put the routing gateway back at the address a running tool is already pinned to, if it is down.
 *
 * Returns the outcome for the FIRST slot that needed attention (or the last inspected one), so a
 * caller can log or surface it. Never throws: every caller is on a path that must not break the
 * tool it is embedded in.
 */
export async function reviveRoutingGatewayIfDown(
  cwd: string,
  options: ReviveRoutingGatewayOptions = {}
): Promise<RoutingRevivalOutcome> {
  const env = options.env ?? process.env;
  const provider = options.provider ?? "anthropic";
  const wait = options.wait ?? false;
  const budgetMs = options.budgetMs ?? REVIVAL_BUDGET_MS;
  const isReachable = options.isReachable ?? ((host: string, port: number) => isGatewayReachable(host, port, PROBE_TIMEOUT_MS));
  const now = options.now ?? (() => Date.now());
  const spawnStart =
    options.spawnGatewayStart ?? ((args, directory, slotKey) => defaultSpawnGatewayStart(args, directory, undefined, slotKey, env));
  const queryIdentity =
    options.queryIdentity ??
    ((record: RoutingSlotRecord) =>
      queryGatewayIdentity({
        pid: record.pid,
        host: record.host,
        port: record.reservedPort,
        ...(record.release ? { release: record.release } : {})
      }));

  try {
    const slots = routingSlotsForCwd(cwd, provider, env);
    // THE CONSENT GATE, and it is first. No slot, no action, no probe, no spawn. This function runs
    // for every Claude Code session on the machine, including sessions that were never routed.
    if (slots.length === 0) return { status: "no-slot" };

    let last: RoutingRevivalOutcome = { status: "no-slot" };
    for (const slot of slots) {
      last = await reviveOneSlot(slot, { cwd, env, wait, budgetMs, isReachable, spawnGatewayStart: spawnStart, queryIdentity, now });
      if (last.status !== "healthy" && last.status !== "reachable") return last;
    }
    return last;
  } catch (error) {
    return { status: "failed", reason: (error as Error).message };
  }
}

interface ReviveSlotContext {
  cwd: string;
  env: ShimEnv;
  wait: boolean;
  budgetMs: number;
  isReachable: (host: string, port: number) => Promise<boolean>;
  spawnGatewayStart: (args: string[], cwd: string, slotKey: string) => void;
  queryIdentity: (record: RoutingSlotRecord) => Promise<unknown>;
  now: () => number;
}

async function reviveOneSlot(slot: ListedRoutingSlot, ctx: ReviveSlotContext): Promise<RoutingRevivalOutcome> {
  const { key, record } = slot;
  const { env, wait, budgetMs, isReachable, now } = ctx;
  const deadline = now() + budgetMs;

  if (record.quarantine) {
    return { status: "quarantined", reason: record.quarantine.reason, port: record.reservedPort };
  }

  // PRE-FILTER ONLY. A refusal is conclusive - nothing is listening, and knowing that needs no
  // authentication. Anything else escalates below, or (on the non-blocking path) ends the call.
  //
  // EITHER ANSWER IS RECORDED. This probe is the only measurement of the endpoint anything performs
  // off a latency-critical path, so surfaces that may not probe read what it saw
  // (`routing-health.ts`). Recording is content-free and never gates the repair below.
  if (await isReachable(record.host, record.reservedPort)) {
    clearRoutingEndpointDown(key, env);
    if (!wait) {
      // The status line hands out nothing and starts nothing here, so it does not need - and must
      // not pay the latency of - the handshake. R-1 is satisfied because no conclusion about WHO is
      // listening is drawn or acted upon: the call simply ends.
      return { status: "reachable", port: record.reservedPort };
    }
    const identity = await ctx.queryIdentity(record);
    if (identity) return { status: "healthy", port: record.reservedPort };
    // Reachable but NOT ours. The reserved port is the only address that could repair a pinned
    // child, so it cannot be substituted; and injecting into it would hand a stranger the user's
    // provider credential. Do not spawn, do not report recovery.
    const reason = `the reserved routing port ${record.reservedPort} is held by a listener that failed the gateway identity handshake`;
    quarantineRoutingSlot(key, reason, env);
    appendRoutingLog(key, `quarantine reserved-port-not-ours port=${record.reservedPort}`, env);
    return { status: "quarantined", reason, port: record.reservedPort };
  }

  // The port refuses. Something that WAS ours is gone; put a replacement back at the same address.
  markRoutingEndpointDown(key, record.startedAt, env, now());
  if (!wait && !respawnCooldownElapsed(key, env, now())) {
    return { status: "cooldown", port: record.reservedPort };
  }

  const lockPath = routingSlotLockPath(key, env);
  const ownsLock = acquireEnsureLock(lockPath);
  if (!ownsLock) {
    // Another revive or ensure is already starting this slot. Losers never spawn. The waiting path
    // still polls within its own budget, exactly as a concurrent ensure does.
    if (!wait) return { status: "locked", port: record.reservedPort };
    return await pollUntilServing(slot, ctx, deadline, "locked");
  }
  try {
    if (signallable(record.pid) && isProcessAlive(record.pid)) {
      // The recorded owner is alive but not listening: signal it so the reserved port is certainly
      // free before a replacement tries to bind it.
      try {
        process.kill(record.pid, "SIGTERM");
        appendRoutingLog(key, `revive signalled stale owner pid=${record.pid} port=${record.reservedPort}`, env);
      } catch {
        /* already gone, or not ours to signal */
      }
    }
    recordRespawnAttempt(key, env, now());
    appendRoutingLog(key, `revive spawn port=${record.reservedPort} wait=${String(wait)}`, env);
    ctx.spawnGatewayStart(
      routingGatewayStartArgs({
        provider: record.provider,
        upstream: record.upstream,
        port: record.reservedPort,
        ...(record.workflow ? { workflow: record.workflow } : {}),
        slotKey: key
      }),
      record.cwd || ctx.cwd,
      key
    );
    if (!wait) return { status: "spawned", port: record.reservedPort };
    return await pollUntilServing(slot, ctx, deadline, "failed");
  } finally {
    releaseEnsureLock(lockPath);
  }
}

/**
 * Poll the reserved port within the caller's own budget until an AUTHENTICATED gateway answers.
 * `queryGatewayIdentity` carries a 1000 ms timeout of its own, which already sits inside the
 * revival budget, so the handshake adds no new latency ceiling.
 */
async function pollUntilServing(
  slot: ListedRoutingSlot,
  ctx: ReviveSlotContext,
  deadline: number,
  failureStatus: RoutingRevivalStatus
): Promise<RoutingRevivalOutcome> {
  const { record, key } = slot;
  const { env, isReachable, now } = ctx;
  while (now() < deadline) {
    if (await isReachable(record.host, record.reservedPort)) {
      // Re-read the slot: the replacement writes its own pid and release identity on listen, and the
      // handshake must be run against THAT identity, not the dead process's.
      const fresh = routingSlotsForCwd(record.cwd || ctx.cwd, record.provider, env).find((s) => s.key === key)?.record ?? record;
      const identity = await ctx.queryIdentity(fresh);
      if (identity) {
        // NOT redundant with the `startedAt` staleness rule, which is what an earlier draft of this
        // comment claimed. A replacement writes a fresh `startedAt` and would invalidate the marker on
        // its own - but the endpoint that comes back is not always a replacement. When the ORIGINAL
        // process answers again (it was briefly not accepting, or a spawn lost the lock and the
        // incumbent recovered), the slot is unchanged, `fresh === record`, and the recorded
        // `startedAt` still matches. Nothing else would ever clear the marker, and the status line
        // would report an outage on an endpoint that had just passed the identity handshake.
        clearRoutingEndpointDown(key, env);
        appendRoutingLog(key, `revive serving pid=${fresh.pid} port=${fresh.reservedPort}`, env);
        return { status: "revived", port: fresh.reservedPort };
      }
    }
    await sleep(60);
  }
  appendRoutingLog(key, `revive-timeout port=${record.reservedPort}`, env);
  return { status: failureStatus, reason: "the routing gateway did not come back within the revival budget", port: record.reservedPort };
}

/**
 * Is there any routing slot at all for this directory? Cheap, synchronous, no network. Call sites on
 * a latency-critical path use it to skip the whole revival machinery for unrouted sessions.
 */
export function hasRoutingSlotForCwd(cwd: string, provider = "anthropic", env: ShimEnv = process.env): boolean {
  try {
    if (!existsSync(routingDir(env))) return false;
    return routingSlotsForCwd(cwd, provider, env).length > 0;
  } catch {
    return false;
  }
}
