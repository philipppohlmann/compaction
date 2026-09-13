/**
 * Content-free endpoint health for readers that cannot probe a socket, such as a status-line render.
 * Observers record failures here; readers resolve the most recent observation synchronously. A short
 * grace period avoids reporting a transient refusal during normal recovery, and `startedAt` prevents
 * an old failure marker from being attributed to a replacement gateway in the same slot.
 */
import { readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { routingDir, routingSlotsForCwdAnyProvider } from "./routing-registry.js";
import type { ShimEnv } from "../tool-shim.js";

/**
 * How long the endpoint must stay unreachable before any surface says so.
 *
 * Long enough for ordinary recovery to finish, short enough to report a sustained outage promptly.
 */
export const ROUTING_DOWN_GRACE_MS = 5000;

/** What a reader may honestly say about this directory's transparent-routing endpoint. */
export type RoutingEndpointState =
  /** No routing slot for this directory: nothing was routed, so there is nothing to report. */
  | "unrouted"
  /** Nothing recorded says the endpoint is down. NOT an assertion that it is healthy. */
  | "ok"
  /** Continuously unreachable for longer than the grace window, as recorded by a prior observation. */
  | "unavailable"
  /** The reserved port is held by a listener that failed the identity handshake. Never revived. */
  | "quarantined";

interface RoutingDownMarker {
  /** `startedAt` of the slot record this marker describes. A mismatch means the marker is stale. */
  slotStartedAt: string;
  /** Epoch ms of the FIRST refusal in the current unreachable stretch. */
  unreachableSince: number;
}

function markerPath(key: string, env: ShimEnv): string {
  return path.join(routingDir(env), `${key}.down`);
}

function readMarker(key: string, env: ShimEnv): RoutingDownMarker | undefined {
  try {
    const raw = JSON.parse(readFileSync(markerPath(key, env), "utf8")) as Record<string, unknown>;
    const slotStartedAt = raw.slotStartedAt;
    const unreachableSince = raw.unreachableSince;
    if (typeof slotStartedAt !== "string" || typeof unreachableSince !== "number" || !Number.isFinite(unreachableSince)) {
      return undefined;
    }
    return { slotStartedAt, unreachableSince };
  } catch {
    return undefined;
  }
}

/**
 * Record that this slot's reserved port refused a connection.
 *
 * FIRST REFUSAL WINS for a given `slotStartedAt`: the marker measures how long the endpoint has been
 * down, so a later observation of the same outage must not reset the clock and postpone the report
 * forever. A marker describing a different `startedAt` is overwritten - that outage ended with the
 * process it belonged to.
 */
export function markRoutingEndpointDown(key: string, slotStartedAt: string, env: ShimEnv, now: number): void {
  try {
    const existing = readMarker(key, env);
    if (existing && existing.slotStartedAt === slotStartedAt) return;
    mkdirSync(routingDir(env), { recursive: true, mode: 0o700 });
    writeFileSync(markerPath(key, env), `${JSON.stringify({ slotStartedAt, unreachableSince: now })}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
  } catch {
    /* the marker is a reporting aid; failing to write one must never affect whether traffic flows */
  }
}

/**
 * Record that this slot's reserved port accepted a connection.
 *
 * Needed even though markers are `startedAt`-keyed: a transient refusal against a gateway that never
 * died leaves the slot record - and so its `startedAt` - unchanged, and without this the stale marker
 * would age past the grace window and report a live endpoint as down.
 */
export function clearRoutingEndpointDown(key: string, env: ShimEnv): void {
  try {
    rmSync(markerPath(key, env), { force: true });
  } catch {
    /* best-effort */
  }
}

/**
 * Resolve this directory's routing state from what is already on disk. Synchronous, no socket, no
 * handshake, no spawn - safe on a render path. Any failure resolves to `unrouted`, i.e. "say
 * nothing", because a reporting aid must never be the reason a surface breaks.
 */
export function routingEndpointState(cwd: string, env: ShimEnv = process.env, now: number = Date.now()): RoutingEndpointState {
  try {
    if (!existsSync(routingDir(env))) return "unrouted";
    const slots = routingSlotsForCwdAnyProvider(cwd, env);
    if (slots.length === 0) return "unrouted";
    // Quarantine is a durable fact on the slot itself and needs no grace window: nothing will ever be
    // started on that port, so the state cannot resolve itself the way a plain refusal can.
    if (slots.some((slot) => slot.record.quarantine)) return "quarantined";
    for (const slot of slots) {
      const marker = readMarker(slot.key, env);
      if (!marker || marker.slotStartedAt !== slot.record.startedAt) continue;
      if (now - marker.unreachableSince >= ROUTING_DOWN_GRACE_MS) return "unavailable";
    }
    return "ok";
  } catch {
    return "unrouted";
  }
}
