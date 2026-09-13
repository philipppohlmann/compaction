/**
 * Start-or-reuse the persistent local gateway for TRANSPARENT tool routing (PUBLIC CLI core -
 * engine-free). Backs `compaction gateway ensure`, which the Claude Code PATH shim calls before
 * every normal `claude` run. The caller contract is FAIL-OPEN: any non-success result means the
 * shim runs the real tool unchanged, ensure must therefore never block, never take long, and
 * never print anything but the base URL on success.
 *
 * RECORD-ONLY BY CONSTRUCTION (transparent routing must be byte-safe):
 * - A running gateway is reused ONLY when it is provably safe for transparent traffic: provider
 *   match, mode `record`, NO workflow identity, upstream match. A workflow-scoped gateway may
 *   honor a stored apply authorization (`server.ts` consults the preference store only when a
 *   workflow identity was declared), so it is NEVER reused here, shim traffic must be
 *   structurally unreachable by every mutating path.
 * - A started gateway is spawned as a DETACHED `compaction gateway start --workflow none` in
 *   `record` mode, bound to 127.0.0.1 only. `--workflow none` disables the connected-workflow
 *   default, so the started server has no workflow identity and the stored-authorization apply path
 *   cannot engage. Explicit `gateway start --mode apply` / `gateway run --mode apply` remain the
 *   only mutation routes, exactly as before.
 *
 * LIFECYCLE - THE ROUTING SLOT, NOT THE PROJECT PIDFILE. The routing gateway is recorded in the
 * user-global slot registry (`routing-registry.ts`), one file per routing identity under the
 * Compaction home. It no longer writes `<cwd>/.compaction/gateway/gateway.json`, so ordinary
 * project/dev cleanup - `compaction gateway stop`, and the `dev` conflict advice that names it -
 * can no longer reach the endpoint backing a live interactive session. `compaction gateway
 * stop --routing` and `compaction init --disconnect claude-code` own routing, and both remove the
 * slot BEFORE signalling so nothing can revive what a user explicitly stopped.
 *
 * THE ENDPOINT COMES BACK AT THE SAME ADDRESS. A tool froze its base URL at `exec` and has no path
 * back to `gateway ensure`; a replacement on a fresh ephemeral port could never repair it. Each slot
 * therefore owns a `reservedPort` allocated once from a band outside both OS ephemeral ranges, and
 * every later start of that slot re-binds it. Same-port rebind after the previous owner died is safe
 * on macOS and Linux (Node sets `SO_REUSEADDR` by default; a lingering `TIME_WAIT` does not block a
 * new listener). Replacement is EXPLICIT - drain, signal, wait for the port to free, rebind - so a
 * live gateway is superseded rather than silently orphaned.
 *
 * REUSE IS AUTHENTICATED, NEVER MERELY REACHABLE. A TCP accept proves nothing about who is on the
 * other end, and a stable address is exactly what makes pre-positioning on it possible. The
 * reachability probe is a cheap PRE-FILTER only; `queryGatewayIdentity` -> `gatewayReleaseMatches`
 * (mutual HMAC over a fresh nonce, with the capability read from our own `0600` record) is what
 * authorises reuse. A listener that cannot prove it is ours is never handed to the shim, never
 * spawned over, and never counted as "the gateway is back".
 *
 * The routing gateway is PERSISTENT by default (no idle self-stop): it backs a long-lived
 * interactive tool session and must not disappear under an idle pause. A user may still OPT IN to an
 * idle TTL via `--idle-ttl` on the spawn (env `COMPACTION_GATEWAY_IDLE_TTL_MS`, or the `idleTtlMs`
 * option); only the gateway ENSURE starts honor that opt-in, a gateway the user started explicitly
 * is theirs to manage.
 */
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, rmdirSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { readGatewayPid, isProcessAlive, type GatewayPidRecord } from "./status.js";
import {
  allocateRoutingPort,
  appendRoutingLog,
  quarantineRoutingSlot,
  readRoutingSlot,
  removeRoutingSlot,
  routingSlotKey,
  routingSlotLockPath,
  routingSlotLogPath,
  writeRoutingSlot,
  type RoutingSlotRecord
} from "./routing-registry.js";
import { gatewayCliVersion, gatewayQuiescent, gatewayReleaseMatches, queryGatewayIdentity } from "./update-identity.js";
import type { ShimEnv } from "../tool-shim.js";

export interface EnsureGatewayOptions {
  /** Validated managed session pair/entry supplied by the CLI session resolver. */
  releasePairId?: string;
  cliEntry?: string;
  /** Provider route to ensure (e.g. "anthropic" for the Claude Code shim). */
  provider: string;
  /** Upstream provider base URL a started gateway forwards to (and a reused one must match). */
  upstream: string;
  cwd?: string;
  /** How long to wait for a spawned gateway to come up before reporting unavailable. */
  waitMs?: number;
  pollMs?: number;
  /** Detached-spawn seam (tests inject a fake). Args are the full `gateway start …` argv tail. */
  spawnGatewayStart?: (args: string[], cwd: string) => void;
  /** Free-port seam (tests pin a port). Used for the reserved-port allocation and the fallback. */
  pickPort?: () => Promise<number>;
  /**
   * Reachability seam (tests inject a fake so no real network is needed). Given the recorded
   * gateway's host/port, resolve true only when the port is actually accepting connections. When
   * absent, a real fast TCP-connect check (`isGatewayReachable`) is used.
   */
  isReachable?: (host: string, port: number) => Promise<boolean>;
  /** Environment seam for the Compaction home (tests redirect `COMPACTION_HOME`). */
  env?: ShimEnv;
  /**
   * Idle TTL (ms) OPT-IN for a gateway this ensure STARTS (a reused gateway keeps its own lifecycle).
   * Overrides the `COMPACTION_GATEWAY_IDLE_TTL_MS` env and the persistent default; 0 = the default,
   * never auto-stop (the persistent routing gateway). A positive value opts into self-stop after
   * that idle interval.
   */
  idleTtlMs?: number;
  /**
   * APPLY-ROUTING opt-in (DEFAULT OFF). When set to a workflow, ensure spawns/reuses a WORKFLOW-SCOPED
   * record gateway (`--workflow <applyRouting>`) so the server's existing fail-closed stored-authorization
   * path may upgrade eligible requests to deterministic apply. It stays `--mode record`; the gateway never
   * mutates a request except through that per-request-gated, original-retained path, and the response is
   * always byte-for-byte. Absent (the default) spawns the plain `--workflow none` byte-safe record gateway,
   * exactly as before. The caller (`gateway ensure`) sets this ONLY when `resolveApplyRoutingActivation`
   * engages (its dormant guard has already checked key + input-opt + stored auth + explicit init + not
   * stopped). Reuse is workflow-aware: an apply-routing ensure reuses ONLY a matching workflow-scoped record
   * gateway, and a plain ensure reuses ONLY a plain (`--workflow none`) record gateway - the two never cross.
   */
  applyRouting?: "claude-code" | "codex";
}

/**
 * Default idle TTL for the ENSURE-started transparent-routing gateway: 0 = PERSISTENT (never
 * self-stops). The routing gateway backs a long-lived interactive session; an idle self-stop would
 * orphan that session with a dead base URL, so it stays up until `compaction gateway stop --routing`,
 * `compaction init --disconnect`, or reboot. A user may opt into a TTL via env/option.
 */
export const DEFAULT_ROUTING_GATEWAY_IDLE_TTL_MS = 0;

/**
 * Resolve the routing gateway's idle TTL: explicit option > `COMPACTION_GATEWAY_IDLE_TTL_MS` env >
 * the persistent default (0 = never auto-stop). A malformed/negative value falls back to the
 * persistent default (fail-safe: a bad override must never accidentally make the routing gateway
 * self-stop under a live session).
 */
export function resolveRoutingGatewayIdleTtlMs(explicit?: number, env: NodeJS.ProcessEnv = process.env): number {
  if (explicit !== undefined && Number.isFinite(explicit) && explicit >= 0) return Math.floor(explicit);
  const raw = env.COMPACTION_GATEWAY_IDLE_TTL_MS;
  if (raw !== undefined && raw.trim() !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed);
  }
  return DEFAULT_ROUTING_GATEWAY_IDLE_TTL_MS;
}

export type EnsureGatewayResult =
  | { status: "reused"; base: string }
  | { status: "started"; base: string }
  | { status: "mismatch"; reason: string }
  | { status: "unavailable"; reason: string };

/** Compare upstream URLs ignoring hash and trailing slashes (same intent as gateway run's reuse check). */
function sameUpstream(a: string, b: string): boolean {
  const norm = (value: string): string => {
    const url = new URL(value);
    url.hash = "";
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.toString();
  };
  try {
    return norm(a) === norm(b);
  } catch {
    return false;
  }
}

/**
 * Is this running gateway safe to put transparent shim traffic through? Fail closed: anything not an
 * exact match for the intended shape is a mismatch with the honest reason, the shim then runs the tool
 * unchanged. The intended shape is record mode + same provider + same upstream, and a workflow identity
 * that EXACTLY matches `expectedWorkflow`:
 *  - `expectedWorkflow` undefined (the default): the gateway must carry NO workflow identity (a plain
 *    byte-safe record gateway; a workflow-scoped one may honor a stored apply authorization and is
 *    NEVER reused here). This is the historical byte-safe reuse gate, unchanged.
 *  - `expectedWorkflow` set (an apply-routing ensure): the gateway must carry EXACTLY that workflow
 *    identity. A plain (`--workflow none`) gateway is NOT reused for apply routing, and a
 *    differently-scoped one is never reused either. The two reuse classes never cross.
 */
export function reusableForTransparentRouting(
  rec: Pick<GatewayPidRecord, "mode" | "provider" | "upstream" | "workflow">,
  provider: string,
  upstream: string,
  expectedWorkflow?: "claude-code" | "codex"
): { ok: boolean; reason?: string } {
  if (rec.mode !== "record") {
    return { ok: false, reason: `the running gateway is in '${rec.mode}' mode - transparent routing reuses record-mode gateways only` };
  }
  if (rec.provider !== provider) {
    return { ok: false, reason: `the running gateway routes provider '${rec.provider}', not '${provider}'` };
  }
  if (expectedWorkflow === undefined) {
    if (rec.workflow !== undefined) {
      return {
        ok: false,
        reason:
          `the running gateway carries the '${rec.workflow}' workflow identity (stored authorizations may apply) - ` +
          "transparent routing reuses plain record gateways only"
      };
    }
  } else if (rec.workflow !== expectedWorkflow) {
    return {
      ok: false,
      reason:
        `the running gateway workflow identity is '${rec.workflow ?? "none"}', not the expected apply-routing ` +
        `workflow '${expectedWorkflow}' - not reused (a fresh workflow-scoped gateway is started instead)`
    };
  }
  if (!sameUpstream(rec.upstream, upstream)) {
    return { ok: false, reason: "the running gateway points at a different upstream" };
  }
  return { ok: true };
}

/**
 * Fast TCP-connect reachability check for a recorded gateway's `host:port`. Resolves true only when
 * a connection is accepted within `timeoutMs`; false on any error or timeout. Never throws, always
 * destroys the socket.
 *
 * THIS IS A PRE-FILTER, NOT AN AUTHORISATION. A REFUSAL is conclusive - nothing is listening, and no
 * authentication is needed to know that. "Reachable" is NEVER conclusive: any process can accept a
 * TCP connection on a loopback port. Every caller that is about to hand out a base URL, reuse a
 * listener, or record "our gateway is back" must escalate to `queryGatewayIdentity` first.
 */
export function isGatewayReachable(host: string, port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: boolean): void => {
      if (done) return;
      done = true;
      try {
        socket.destroy();
      } catch {
        /* best-effort */
      }
      resolve(v);
    };
    const socket = net.connect({ host, port });
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

/** Grab a free local port (bind 0 on 127.0.0.1, read, close). The FALLBACK when band allocation fails. */
function pickFreeLocalPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      server.close(() => (port > 0 ? resolve(port) : reject(new Error("could not allocate a local port"))));
    });
  });
}

/**
 * Default detached spawner: re-invoke this same CLI as `… gateway start <args>`, detached so the
 * server outlives this short-lived process. `COMPACTION_BIN` (set by the shims, and by tests) names
 * the CLI executable; without it, re-run this entry via node.
 *
 * OBSERVABILITY: for a ROUTING start (`logKey` present) stdout/stderr are APPENDED to
 * `<home>/routing/<key>.log` instead of being discarded. The previous `stdio: "ignore"` is why a
 * gateway death left no trace of any kind and its proximate cause could not be established after the
 * fact. The gateway's own log lines are content-free (banner, provider/upstream, idle-stop notice);
 * no request or response byte, header, prompt or credential ever reaches this file.
 */
export function defaultSpawnGatewayStart(
  args: string[],
  cwd: string,
  cliEntry?: string,
  logKey?: string,
  env: ShimEnv = process.env
): void {
  const bin = process.env.COMPACTION_BIN;
  let stdio: "ignore" | ["ignore", number, number] = "ignore";
  let fd: number | undefined;
  if (logKey) {
    try {
      mkdirSync(path.dirname(routingSlotLogPath(logKey, env)), { recursive: true, mode: 0o700 });
      fd = openSync(routingSlotLogPath(logKey, env), "a", 0o600);
      stdio = ["ignore", fd, fd];
    } catch {
      stdio = "ignore";
    }
  }
  try {
    const child =
      cliEntry ? spawn(process.execPath, [cliEntry, ...args], { cwd, detached: true, stdio }) : bin && bin.trim() !== ""
        ? spawn(bin, args, { cwd, detached: true, stdio })
        : spawn(process.execPath, [process.argv[1], ...args], { cwd, detached: true, stdio });
    child.unref();
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* the child holds its own duplicate */
      }
    }
  }
}

/**
 * mkdir-based single-flight lock. Returns true when THIS call owns the lock. `mkdir` with
 * `recursive: false` is atomic, so exactly one caller wins.
 *
 * Elapsed time is not proof the owner died, so an ambiguous lock stays HELD rather than being
 * stolen. Below the lock, Node's `listen()` does not set `SO_REUSEPORT`, so a double-spawn that
 * somehow slipped the lock produces `EADDRINUSE` on the loser - a safe, observable failure rather
 * than two listeners on one port.
 */
export function acquireEnsureLock(lockPath: string): boolean {
  const tryOnce = (): boolean => {
    try {
      mkdirSync(lockPath, { recursive: false });
      return true;
    } catch {
      return false;
    }
  };
  mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  return tryOnce();
}

export function releaseEnsureLock(lockPath: string): void {
  try {
    rmdirSync(lockPath);
  } catch {
    /* best-effort */
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * May this pid be signalled?
 *
 * `process.kill` treats 0 as "the whole process GROUP" and a negative pid as another group, so a
 * malformed or zeroed record must never reach it - that turns a stale-slot cleanup into a
 * self-inflicted kill of the caller and everything sharing its group. Our OWN pid is excluded for
 * the same reason: a slot should never name the process reading it, and if one somehow does, the
 * correct response is to leave it alone rather than terminate ourselves.
 */
export function signallable(pid: number): boolean {
  return Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid;
}

/** The `gateway start …` argv tail for one routing slot. Shared by ensure and by revival. */
export function routingGatewayStartArgs(input: {
  provider: string;
  upstream: string;
  port: number;
  workflow?: "claude-code" | "codex";
  slotKey: string;
  idleTtlMs?: number;
}): string[] {
  return [
    "gateway",
    "start",
    "--provider",
    input.provider,
    "--upstream",
    input.upstream,
    "--listen",
    `http://127.0.0.1:${input.port}`,
    "--mode",
    "record",
    // Default: `--workflow none` (byte-safe, no stored-authorization consult). Apply-routing opt-in:
    // `--workflow <workflow>` so the server's fail-closed stored-authorization path may upgrade
    // eligible requests to apply (still `--mode record`; response byte-for-byte).
    "--workflow",
    input.workflow ?? "none",
    // The started gateway owns this slot's record: it writes it on listen and removes it on close.
    // Passing the key rather than letting the parent write the record keeps the pid in the file
    // always the pid of the process actually listening.
    "--routing-slot",
    input.slotKey,
    ...(input.idleTtlMs && input.idleTtlMs > 0 ? ["--idle-ttl", String(input.idleTtlMs)] : [])
  ];
}

/**
 * Wait, bounded, for `port` to stop accepting connections after the previous owner was told to go.
 * Returns true when the port is free. The reserved port cannot be re-bound while a live LISTEN is
 * held on it, so replacement must observe the release rather than assume it.
 */
async function waitForPortToFree(
  host: string,
  port: number,
  isReachable: (host: string, port: number) => Promise<boolean>,
  budgetMs: number,
  pollMs: number
): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    if (!(await isReachable(host, port))) return true;
    if (Date.now() >= deadline) return false;
    await sleep(pollMs);
  }
}

/**
 * Ensure a byte-safe record gateway is running for `provider` in this cwd, at this routing slot's
 * stable reserved port, and return its base URL. Never throws.
 */
export async function ensureGateway(options: EnsureGatewayOptions): Promise<EnsureGatewayResult> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const waitMs = options.waitMs ?? 6000;
  const pollMs = options.pollMs ?? 120;
  const applyWorkflow = options.applyRouting;
  const slotKey = routingSlotKey({ cwd, provider: options.provider, ...(applyWorkflow ? { workflow: applyWorkflow } : {}) }, env);
  const spawnStart =
    options.spawnGatewayStart ?? ((args, directory) => defaultSpawnGatewayStart(args, directory, options.cliEntry, slotKey, env));
  const isReachable = options.isReachable ?? ((host: string, port: number) => isGatewayReachable(host, port));
  const expectedPair = options.releasePairId ?? `external:${gatewayCliVersion()}`;

  /**
   * The authorisation gate, and the ONLY one. A reachable port is not evidence: the handshake is
   * mutual HMAC over a fresh nonce keyed by a capability held only in our own `0600` record, so a
   * listener that is not ours cannot pass it however convincingly it accepts TCP.
   */
  const authenticated = async (rec: { pid: number; host: string; port: number; release?: RoutingSlotRecord["release"] }) =>
    queryGatewayIdentity(rec);

  try {
    const slot = readRoutingSlot(slotKey, env);

    if (slot) {
      const reachable = await isReachable(slot.host, slot.reservedPort);
      if (reachable) {
        const identity = await authenticated({ pid: slot.pid, host: slot.host, port: slot.reservedPort, ...(slot.release ? { release: slot.release } : {}) });
        if (!identity) {
          // Something holds the reserved port and cannot prove it is ours. This is the ONE address
          // that could repair a still-running child, so it can never be substituted and must never
          // be injected into. Quarantine, report, hand out nothing.
          const reason = `the reserved routing port ${slot.reservedPort} is held by a listener that failed the gateway identity handshake`;
          quarantineRoutingSlot(slotKey, reason, env);
          appendRoutingLog(slotKey, `quarantine reserved-port-not-ours port=${slot.reservedPort}`, env);
          return { status: "mismatch", reason: `${reason} - not reused, not replaced, and no base URL was handed out` };
        }
        const check = reusableForTransparentRouting(slot, options.provider, options.upstream, applyWorkflow);
        if (!check.ok) return { status: "mismatch", reason: check.reason ?? "running gateway does not match" };
        if (gatewayReleaseMatches(identity, expectedPair)) {
          return { status: "reused", base: `http://${slot.host}:${slot.reservedPort}` };
        }
        // Our gateway, wrong release. SUPERSEDE rather than orphan: refuse while it is busy, then
        // drain it through the same authenticated control path, then signal, then take its port.
        if (!gatewayQuiescent(identity)) return { status: "mismatch", reason: "running gateway has active or unsettled work; update deferred" };
        const drained = await queryGatewayIdentity(
          { pid: slot.pid, host: slot.host, port: slot.reservedPort, ...(slot.release ? { release: slot.release } : {}) },
          true
        );
        if (!drained?.draining) return { status: "mismatch", reason: "running gateway could not safely drain; update deferred" };
        appendRoutingLog(slotKey, `supersede drained pid=${slot.pid} port=${slot.reservedPort}`, env);
      }
      const superseded = await supersedeSlotOwner(slot, slotKey, isReachable, env, pollMs);
      if (!superseded.ok) return { status: "unavailable", reason: superseded.reason };
      return await startOnReservedPort({
        slotKey,
        port: slot.reservedPort,
        cwd,
        env,
        options,
        applyWorkflow,
        expectedPair,
        isReachable,
        spawnStart,
        waitMs,
        pollMs
      });
    }

    // ---- No slot yet ----------------------------------------------------------------------------
    // MIGRATION: a live routing-shaped gateway recorded by the PRE-UPGRADE cwd pidfile is ADOPTED at
    // its CURRENT port and never restarted. A running session's endpoint must not move underneath it
    // just because the record format changed.
    const adopted = await adoptLegacyCwdGateway({ cwd, slotKey, options, applyWorkflow, expectedPair, isReachable, env });
    if (adopted) return adopted;

    // `pickPort` PINS the reserved port when supplied (the test seam). Otherwise the port is
    // allocated once from the salted band, falling back to an ephemeral port only if the whole band
    // is unavailable - an honest degradation, logged with its reason.
    let port: number;
    if (options.pickPort) {
      port = await options.pickPort();
    } else {
      const allocation = await allocateRoutingPort(slotKey, env);
      if (allocation.port === undefined) {
        appendRoutingLog(slotKey, `allocation-fallback reason=${allocation.reason ?? "unknown"}`, env);
        port = await pickFreeLocalPort();
      } else {
        port = allocation.port;
      }
    }
    return await startOnReservedPort({
      slotKey,
      port,
      cwd,
      env,
      options,
      applyWorkflow,
      expectedPair,
      isReachable,
      spawnStart,
      waitMs,
      pollMs
    });
  } catch (error) {
    return { status: "unavailable", reason: (error as Error).message };
  }
}

/**
 * Make the reserved port available for a replacement. Signals the recorded owner when it is still
 * alive and waits for the port to actually stop accepting - the port is the contract, so its release
 * is observed rather than assumed.
 */
async function supersedeSlotOwner(
  slot: RoutingSlotRecord,
  slotKey: string,
  isReachable: (host: string, port: number) => Promise<boolean>,
  env: ShimEnv,
  pollMs: number
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (signallable(slot.pid) && isProcessAlive(slot.pid)) {
    try {
      process.kill(slot.pid, "SIGTERM");
      appendRoutingLog(slotKey, `supersede signalled pid=${slot.pid} port=${slot.reservedPort}`, env);
    } catch {
      /* already gone, or not ours to signal */
    }
  }
  if (await waitForPortToFree(slot.host, slot.reservedPort, isReachable, 3000, pollMs)) return { ok: true };
  const reason = `the reserved routing port ${slot.reservedPort} did not free after the previous owner was signalled`;
  appendRoutingLog(slotKey, `supersede-failed port=${slot.reservedPort}`, env);
  return { ok: false, reason };
}

interface StartOnPortInput {
  slotKey: string;
  port: number;
  cwd: string;
  env: ShimEnv;
  options: EnsureGatewayOptions;
  applyWorkflow?: "claude-code" | "codex";
  expectedPair: string;
  isReachable: (host: string, port: number) => Promise<boolean>;
  spawnStart: (args: string[], cwd: string) => void;
  waitMs: number;
  pollMs: number;
}

/** Single-flight spawn on the slot's reserved port, then poll for an AUTHENTICATED listener. */
async function startOnReservedPort(input: StartOnPortInput): Promise<EnsureGatewayResult> {
  const { slotKey, port, cwd, env, options, applyWorkflow, expectedPair, isReachable, spawnStart, waitMs, pollMs } = input;
  const lockPath = routingSlotLockPath(slotKey, env);
  const ownsLock = acquireEnsureLock(lockPath);
  let spawned = false;
  try {
    if (ownsLock) {
      const idleTtlMs = resolveRoutingGatewayIdleTtlMs(options.idleTtlMs);
      spawnStart(
        routingGatewayStartArgs({
          provider: options.provider,
          upstream: options.upstream,
          port,
          ...(applyWorkflow ? { workflow: applyWorkflow } : {}),
          slotKey,
          idleTtlMs
        }),
        cwd
      );
      spawned = true;
      appendRoutingLog(slotKey, `start requested port=${port} provider=${options.provider} workflow=${applyWorkflow ?? "none"}`, env);
    }
    // Poll (whether we spawned or another ensure holds the lock) until an AUTHENTICATED gateway is up.
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      const rec = readRoutingSlot(slotKey, env);
      if (rec && (await isReachable(rec.host, rec.port))) {
        const identity = await queryGatewayIdentity({ pid: rec.pid, host: rec.host, port: rec.port, ...(rec.release ? { release: rec.release } : {}) });
        if (identity && gatewayReleaseMatches(identity, expectedPair)) {
          const check = reusableForTransparentRouting(rec, options.provider, options.upstream, applyWorkflow);
          if (!check.ok) return { status: "mismatch", reason: check.reason ?? "running gateway does not match" };
          return { status: spawned ? "started" : "reused", base: `http://${rec.host}:${rec.port}` };
        }
      }
      await sleep(pollMs);
    }
    appendRoutingLog(slotKey, `start-timeout port=${port} spawned=${String(spawned)}`, env);
    return {
      status: "unavailable",
      reason: spawned
        ? "the spawned gateway did not become ready in time"
        : "no gateway became ready in time (another start may be in progress)"
    };
  } finally {
    if (ownsLock) releaseEnsureLock(lockPath);
  }
}

interface AdoptInput {
  cwd: string;
  slotKey: string;
  options: EnsureGatewayOptions;
  applyWorkflow?: "claude-code" | "codex";
  expectedPair: string;
  isReachable: (host: string, port: number) => Promise<boolean>;
  env: ShimEnv;
}

/**
 * LEGACY ADOPTION. Before the slot model the routing gateway was recorded at
 * `<cwd>/.compaction/gateway/gateway.json`. On the first ensure after upgrade, a gateway recorded
 * there that is live, AUTHENTICATED, and of the routing shape is adopted into a slot AT ITS CURRENT
 * PORT and is NOT restarted - a Claude that is running right now froze that exact URL and would be
 * stranded by a restart on a different port.
 *
 * An adopted slot carries an honest caveat: its port was kernel-chosen and may sit inside an OS
 * ephemeral range, so a later revival can find it taken by an unrelated connection. That is recorded
 * as `adopted: true` and surfaced by `gateway status`, not papered over.
 */
async function adoptLegacyCwdGateway(input: AdoptInput): Promise<EnsureGatewayResult | null> {
  const { cwd, slotKey, options, applyWorkflow, expectedPair, isReachable, env } = input;
  const legacy = readGatewayPid(cwd);
  if (!legacy || !isProcessAlive(legacy.pid)) return null;
  if (!(await isReachable(legacy.host, legacy.port))) return null;
  const check = reusableForTransparentRouting(legacy, options.provider, options.upstream, applyWorkflow);
  if (!check.ok) return null;
  const identity = await queryGatewayIdentity(legacy);
  if (!identity) return null;
  if (!gatewayReleaseMatches(identity, expectedPair)) {
    // It IS ours, but from a different release. Adoption would pin the slot to a gateway this CLI
    // must not reuse, so instead it is retired the same way the slot path retires a superseded
    // owner: never while it is busy, and only through the authenticated control drain. Without this
    // the pre-slot update path would silently stop draining old gateways and leave them running.
    if (!gatewayQuiescent(identity)) return null;
    await queryGatewayIdentity(legacy, true);
    return null;
  }
  const record: RoutingSlotRecord = {
    pid: legacy.pid,
    host: legacy.host,
    port: legacy.port,
    reservedPort: legacy.port,
    provider: legacy.provider,
    upstream: legacy.upstream,
    mode: legacy.mode,
    ...(legacy.workflow ? { workflow: legacy.workflow } : {}),
    cwd,
    startedAt: legacy.startedAt,
    adopted: true,
    ...(legacy.release ? { release: legacy.release } : {})
  };
  writeRoutingSlot(slotKey, record, env);
  appendRoutingLog(slotKey, `adopted legacy pid=${legacy.pid} port=${legacy.port} (port not moved; may be inside an OS ephemeral range)`, env);
  return { status: "reused", base: `http://${legacy.host}:${legacy.port}` };
}

export interface StopRoutingGatewayResult {
  stopped: boolean;
  pid?: number;
  reason?: string;
}

/**
 * Stop the transparent-routing gateway for this cwd, if one is running. Used by
 * `compaction init --disconnect claude-code` and by `compaction gateway stop --routing`.
 *
 * THE SLOT IS REMOVED FIRST, THEN THE PROCESS IS SIGNALLED. That order is the entire reason the
 * gateway does not become immortal: revival is gated on the slot's EXISTENCE, so with the slot gone
 * neither the status line nor the `UserPromptSubmit` hook can resurrect what a user explicitly
 * stopped. Reversing the order would leave a window in which a revival trigger sees a live slot and
 * a dead port and starts a replacement.
 *
 * Best-effort; never throws.
 */
export function stopTransparentRoutingGateway(cwd: string, provider: string, env: ShimEnv = process.env): StopRoutingGatewayResult {
  try {
    const applyRoutingWorkflow = provider === "anthropic" ? "claude-code" : provider === "openai" ? "codex" : undefined;
    const keys = [
      routingSlotKey({ cwd, provider }, env),
      ...(applyRoutingWorkflow ? [routingSlotKey({ cwd, provider, workflow: applyRoutingWorkflow }, env)] : [])
    ];
    const stopped: number[] = [];
    let sawSlot = false;
    for (const key of keys) {
      const slot = readRoutingSlot(key, env);
      if (!slot) continue;
      sawSlot = true;
      // Unguarded by instanceId on purpose: an explicit stop must clear the slot even when the
      // record is partial or the gateway never wrote a release identity.
      removeRoutingSlot(key, env);
      appendRoutingLog(key, `explicit-stop slot removed pid=${slot.pid} port=${slot.reservedPort}`, env);
      if (!signallable(slot.pid) || !isProcessAlive(slot.pid)) continue;
      try {
        process.kill(slot.pid, "SIGTERM");
        stopped.push(slot.pid);
      } catch {
        /* already gone */
      }
    }
    if (stopped.length > 0) return { stopped: true, pid: stopped[0] };
    if (sawSlot) return { stopped: false, reason: "the recorded routing gateway was not running; its slot was removed" };
    return stopLegacyCwdRoutingGateway(cwd, provider);
  } catch (error) {
    return { stopped: false, reason: (error as Error).message };
  }
}

/**
 * Pre-upgrade fallback: a routing gateway that is still only recorded by the cwd pidfile (started
 * before this release and never adopted, because no ensure has run since). Same shape gate as
 * before; anything else is left running with the honest reason.
 */
function stopLegacyCwdRoutingGateway(cwd: string, provider: string): StopRoutingGatewayResult {
  const rec = readGatewayPid(cwd);
  if (!rec) return { stopped: false, reason: "no routing gateway is recorded for this directory" };
  if (!signallable(rec.pid) || !isProcessAlive(rec.pid)) return { stopped: false, reason: `pid ${rec.pid} is not running` };
  const applyRoutingWorkflow = provider === "anthropic" ? "claude-code" : provider === "openai" ? "codex" : undefined;
  const isTransparentRoutingShape =
    rec.mode === "record" && rec.provider === provider && (rec.workflow === undefined || rec.workflow === applyRoutingWorkflow);
  if (!isTransparentRoutingShape) {
    return {
      stopped: false,
      pid: rec.pid,
      reason: `the running gateway (pid ${rec.pid}, provider ${rec.provider}, mode ${rec.mode}${rec.workflow ? `, workflow ${rec.workflow}` : ""}) was not started for transparent routing - left running (stop it explicitly: compaction gateway stop)`
    };
  }
  process.kill(rec.pid, "SIGTERM");
  return { stopped: true, pid: rec.pid };
}
