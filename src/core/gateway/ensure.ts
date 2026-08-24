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
 *   `record` mode on a free local port, bound to 127.0.0.1 only. `--workflow none` disables the
 *   connected-workflow default, so the started server has no workflow identity and the
 *   stored-authorization apply path cannot engage. Explicit `gateway start --mode apply` /
 *   `gateway run --mode apply` remain the only mutation routes, exactly as before.
 *
 * Lifecycle: the spawned gateway is owned by the EXISTING pidfile lifecycle
 * (`<cwd>/.compaction/gateway/gateway.json`; `compaction gateway status|stop`), nothing new to
 * clean up, no orphan: a mkdir-based single-flight lock prevents concurrent ensures from
 * spawning two servers. The routing gateway is PERSISTENT by default (no idle self-stop): it backs
 * a long-lived interactive tool session and must not disappear under an idle pause (thinking,
 * lunch, overnight) and leave the session with a dead `ANTHROPIC_BASE_URL`. It is stopped only by
 * `compaction gateway stop`, `compaction init --disconnect`, or a reboot. A user may still OPT IN
 * to an idle TTL via `--idle-ttl` on the spawn (env `COMPACTION_GATEWAY_IDLE_TTL_MS`, or the
 * `idleTtlMs` option); when set, the gateway self-stops after that long without a request and the
 * next routed run transparently starts a fresh one (this same start-or-reuse path). Only the
 * gateway ENSURE starts honor that opt-in, a gateway the user started explicitly is theirs to manage.
 *
 * REUSE IS HEALTH-CHECKED: a recorded gateway is reused only when its pid is alive AND its port is
 * actually accepting connections (a fast TCP-connect check), so a stale/dead record is never handed
 * to the shim as a live URL; on any doubt this fails toward "start a fresh one".
 */
import { spawn } from "node:child_process";
import { mkdirSync, rmdirSync, statSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { DEFAULT_GATEWAY_RECEIPTS_DIR } from "./receipt.js";
import { readGatewayPid, isProcessAlive, type GatewayPidRecord } from "./status.js";

export interface EnsureGatewayOptions {
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
  /** Free-port seam (tests pin a port). */
  pickPort?: () => Promise<number>;
  /**
   * Reachability seam (tests inject a fake so no real network is needed). Given the recorded
   * gateway's host/port, resolve true only when the port is actually accepting connections. When
   * absent, a real fast TCP-connect check (`isGatewayReachable`) is used.
   */
  isReachable?: (host: string, port: number) => Promise<boolean>;
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
 * orphan that session with a dead base URL, so it stays up until `compaction gateway stop`,
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
  rec: GatewayPidRecord,
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
 * destroys the socket. Guards the reuse path so a pid that merely looks alive (or a reused pid) can
 * never be handed to the shim as a live URL: on any doubt the caller starts a fresh gateway.
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

/**
 * A running gateway pid record for this cwd, or null. "Running" means the recorded pid is alive AND
 * the recorded port is actually accepting connections (the reachability check). Reachability is
 * injectable for tests; by default it is a real fast TCP-connect. Fails toward "not running" on any
 * doubt so the caller starts a fresh gateway rather than route to a dead port.
 */
async function readRunningGateway(
  cwd: string,
  isReachable: (host: string, port: number) => Promise<boolean>
): Promise<GatewayPidRecord | null> {
  const rec = readGatewayPid(cwd);
  if (!rec) return null;
  if (!isProcessAlive(rec.pid)) return null;
  if (!(await isReachable(rec.host, rec.port))) return null;
  return rec;
}

/** Grab a free local port (bind 0 on 127.0.0.1, read, close). Racy in theory; fail-open in practice. */
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
 * Default detached spawner: re-invoke this same CLI as `… gateway start <args>`, detached with all
 * stdio ignored, so the server outlives this short-lived process. `COMPACTION_BIN` (set by the
 * shims, and by tests) names the CLI executable; without it, re-run this entry via node.
 */
function defaultSpawnGatewayStart(args: string[], cwd: string): void {
  const bin = process.env.COMPACTION_BIN;
  const child =
    bin && bin.trim() !== ""
      ? spawn(bin, args, { cwd, detached: true, stdio: "ignore" })
      : spawn(process.execPath, [process.argv[1], ...args], { cwd, detached: true, stdio: "ignore" });
  child.unref();
}

const ENSURE_LOCK_DIR = "ensure.lock";
/** A lock older than this is stale (a crashed ensure) and may be broken. */
const LOCK_STALE_MS = 20_000;

/** mkdir-based single-flight lock. Returns true when THIS call owns the lock. */
function acquireEnsureLock(lockPath: string): boolean {
  const tryOnce = (): boolean => {
    try {
      mkdirSync(lockPath, { recursive: false });
      return true;
    } catch {
      return false;
    }
  };
  mkdirSync(path.dirname(lockPath), { recursive: true });
  if (tryOnce()) return true;
  try {
    const age = Date.now() - statSync(lockPath).mtimeMs;
    if (age > LOCK_STALE_MS) {
      rmdirSync(lockPath);
      return tryOnce();
    }
  } catch {
    /* raced away, treat as not acquired */
  }
  return false;
}

function releaseEnsureLock(lockPath: string): void {
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
 * Ensure a byte-safe record gateway is running for `provider` in this cwd and return its base URL.
 * Reuse when safe; otherwise spawn one detached `gateway start` (single-flight) and wait for it.
 * Never throws.
 */
export async function ensureGateway(options: EnsureGatewayOptions): Promise<EnsureGatewayResult> {
  const cwd = options.cwd ?? process.cwd();
  const waitMs = options.waitMs ?? 6000;
  const pollMs = options.pollMs ?? 120;
  const spawnStart = options.spawnGatewayStart ?? defaultSpawnGatewayStart;
  const isReachable = options.isReachable ?? ((host: string, port: number) => isGatewayReachable(host, port));

  // Apply-routing opt-in (default OFF): spawn/reuse a workflow-scoped record gateway so the server's
  // fail-closed stored-authorization path may upgrade eligible requests to apply. The caller only sets
  // this when the dormant guard engaged. Reuse is matched to the exact expected shape (plain vs scoped).
  const applyWorkflow = options.applyRouting;

  try {
    const running = await readRunningGateway(cwd, isReachable);
    if (running) {
      const check = reusableForTransparentRouting(running, options.provider, options.upstream, applyWorkflow);
      if (!check.ok) return { status: "mismatch", reason: check.reason ?? "running gateway does not match" };
      return { status: "reused", base: `http://${running.host}:${running.port}` };
    }

    const lockPath = path.join(cwd, DEFAULT_GATEWAY_RECEIPTS_DIR, ENSURE_LOCK_DIR);
    const ownsLock = acquireEnsureLock(lockPath);
    let spawned = false;
    try {
      if (ownsLock) {
        const port = await (options.pickPort ?? pickFreeLocalPort)();
        // The ROUTING gateway is PERSISTENT by default (idle TTL 0 = never self-stop) so it cannot
        // vanish under a live session and orphan it with a dead base URL. --idle-ttl is passed ONLY
        // when a user opts in (env/option > 0); with the default 0 the flag is omitted, and a plain
        // `gateway start` stays long-lived exactly as before.
        const idleTtlMs = resolveRoutingGatewayIdleTtlMs(options.idleTtlMs);
        spawnStart(
          [
            "gateway",
            "start",
            "--provider",
            options.provider,
            "--upstream",
            options.upstream,
            "--listen",
            `http://127.0.0.1:${port}`,
            "--mode",
            "record",
            // Default: `--workflow none` (byte-safe, no stored-authorization consult). Apply-routing
            // opt-in: `--workflow <applyWorkflow>` so the server's fail-closed stored-authorization path
            // may upgrade eligible requests to apply (still `--mode record`; response byte-for-byte).
            "--workflow",
            applyWorkflow ?? "none",
            ...(idleTtlMs > 0 ? ["--idle-ttl", String(idleTtlMs)] : [])
          ],
          cwd
        );
        spawned = true;
      }
      // Poll (whether we spawned or another ensure holds the lock) until a safe gateway is up.
      const deadline = Date.now() + waitMs;
      while (Date.now() < deadline) {
        const rec = await readRunningGateway(cwd, isReachable);
        if (rec) {
          const check = reusableForTransparentRouting(rec, options.provider, options.upstream, applyWorkflow);
          if (!check.ok) return { status: "mismatch", reason: check.reason ?? "running gateway does not match" };
          return { status: spawned ? "started" : "reused", base: `http://${rec.host}:${rec.port}` };
        }
        await sleep(pollMs);
      }
      return {
        status: "unavailable",
        reason: spawned
          ? "the spawned gateway did not become ready in time"
          : "no gateway became ready in time (another start may be in progress)"
      };
    } finally {
      if (ownsLock) releaseEnsureLock(lockPath);
    }
  } catch (error) {
    return { status: "unavailable", reason: (error as Error).message };
  }
}

export interface StopRoutingGatewayResult {
  stopped: boolean;
  pid?: number;
  reason?: string;
}

/**
 * Stop the transparent-routing gateway for this cwd, if one is running. A gateway is transparent-routing
 * (exactly the shapes `ensureGateway` starts) when it is RECORD mode on the given provider AND EITHER has
 * NO workflow identity (the default byte-safe gateway) OR carries the given provider's apply-routing
 * workflow identity (the workflow-scoped gateway an apply-routing ensure starts). Both are stopped. Anything
 * else - an apply/dry-run gateway, or a workflow-scoped gateway for a DIFFERENT provider (which ensure never
 * starts on this provider) - is left untouched with the honest reason (stop it explicitly). Used by
 * `compaction init --disconnect claude-code`. Best-effort; never throws.
 */
export function stopTransparentRoutingGateway(cwd: string, provider: string): StopRoutingGatewayResult {
  try {
    const rec = readGatewayPid(cwd);
    if (!rec) return { stopped: false, reason: "no gateway pidfile in this project" };
    if (!isProcessAlive(rec.pid)) return { stopped: false, reason: `pid ${rec.pid} is not running` };
    // The apply-routing workflow ensure may start for this provider (anthropic → claude-code). A
    // record-mode gateway carrying exactly that identity IS a transparent-routing gateway and is stopped.
    const applyRoutingWorkflow = provider === "anthropic" ? "claude-code" : provider === "openai" ? "codex" : undefined;
    const isTransparentRoutingShape =
      rec.mode === "record" &&
      rec.provider === provider &&
      (rec.workflow === undefined || rec.workflow === applyRoutingWorkflow);
    if (!isTransparentRoutingShape) {
      return {
        stopped: false,
        pid: rec.pid,
        reason: `the running gateway (pid ${rec.pid}, provider ${rec.provider}, mode ${rec.mode}${rec.workflow ? `, workflow ${rec.workflow}` : ""}) was not started for transparent routing - left running (stop it explicitly: compaction gateway stop)`
      };
    }
    process.kill(rec.pid, "SIGTERM");
    return { stopped: true, pid: rec.pid };
  } catch (error) {
    return { stopped: false, reason: (error as Error).message };
  }
}
