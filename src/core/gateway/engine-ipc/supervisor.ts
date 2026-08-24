/**
 * Native-engine client supervisor (PUBLIC — public client half of the IPC boundary).
 *
 * Spawns the private native engine as a supervised child process and speaks the versioned framed
 * protocol (`protocol.ts`) over its stdin/stdout. It is the seam that routes the gateway
 * apply path through; this PR introduces it alongside — it does NOT replace — the existing
 * `lcm-apply-boundary.ts` seam.
 *
 * Fail-open by construction: engine absent / unverified install / spawn failure / crash /
 * per-request timeout / protocol-version mismatch / malformed frame / bad response all resolve to
 * a typed DEGRADE outcome. The supervisor NEVER throws into the request path.
 *
 * Verify-before-run: a signed install (the `current` pointer under `<configDir>/engine`,
 * containment-checked against the install root) only runs when its Ed25519-signed manifest
 * verifies against an allowed trust root AND the artifact's sha256 matches the signed digest —
 * re-checked immediately before EVERY spawn, including crash restarts, so bytes swapped after an
 * earlier check can never execute. An install that fails verification degrades
 * `engine-unverified` and is never substituted by the dev build.
 *
 * Credential isolation (asserted in tests): the supervisor passes ONLY the request bytes +
 * content-free metadata + authorization descriptor + opaque entitlement + local quota to the
 * engine. It never passes the provider key, an Authorization header, or a network endpoint, and it
 * gives the child a scrubbed environment so no ambient credential leaks in.
 *
 * Engine-free at import: this module reaches the engine solely by `child_process.spawn`-ing a
 * resolved script path. It imports nothing from `src/engine/**`, so `npm run boundary:engine`
 * keeps the CLI static graph at zero engine edges.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configDir } from "../../api-client/persisted-config.js";
import { verifyInstalledArtifact, type EngineTrustSource, type InstalledArtifactFailure } from "../../engine-install/verify.js";
import type { EngineArtifactKind, EngineReleaseManifest } from "../../engine-install/manifest.js";
import {
  ENGINE_IPC_PROTOCOL_VERSION,
  EngineIpcFrameError,
  FrameDecoder,
  encodeFrame,
  isEngineIpcResponse,
  type EngineIpcAuthorization,
  type EngineIpcEntitlement,
  type EngineIpcOperation,
  type EngineIpcQuota,
  type EngineIpcRequest,
  type EngineIpcResponse
} from "./protocol.js";

/** Default per-request budget. A response still pending after this degrades (never blocks). */
export const DEFAULT_ENGINE_REQUEST_TIMEOUT_MS = 5_000;

/** Bounded spawn/ping handshake budget. */
export const DEFAULT_ENGINE_SPAWN_TIMEOUT_MS = 5_000;

/** Cap on automatic restarts within one supervisor's life (last-known-good, then stay degraded). */
export const MAX_ENGINE_RESTARTS = 3;

/** Why a request degraded instead of receiving an engine outcome. Fixed labels, never error text. */
export type EngineDegradeReason =
  | "engine-absent"
  | "engine-unverified"
  | "spawn-failed"
  | "crash"
  | "timeout"
  | "protocol-version-mismatch"
  | "bad-frame"
  | "bad-response"
  | "restart-exhausted";

/** A degraded outcome: no engine result is available; the caller forwards the original unchanged. */
export interface EngineDegradeOutcome {
  status: "degraded";
  reason: EngineDegradeReason;
}

/** A live engine response (already validated + version-checked). */
export interface EngineResponseOutcome {
  status: "response";
  response: EngineIpcResponse;
}

export type EngineSupervisorOutcome = EngineResponseOutcome | EngineDegradeOutcome;

/** Parameters for a single supervised request. Only content-free metadata + request bytes. */
export interface EngineRequestInput {
  operation: EngineIpcOperation;
  workflow: string;
  provider: string;
  route_type: string;
  /** Content-free routed endpoint path (e.g. "/v1/messages"); selects the engine's request shape. */
  endpoint?: string;
  /** Whether deterministic pre-generation output shaping is enabled for this request (content-free). */
  output_shaping_enabled?: boolean;
  /**
   * Whether the caller's VERIFIED entitlement covers hybrid/LCM input compaction (content-free).
   * The explicit activation channel — see the field's doc on `EngineIpcRequest` for why activation
   * travels the frame and not the environment.
   */
  input_compaction_enabled?: boolean;
  /** The request body bytes to optimize (the class of data the gateway already forwards). */
  request_body: string;
  authorization: EngineIpcAuthorization;
  entitlement: EngineIpcEntitlement;
  quota: EngineIpcQuota;
  timeoutMs?: number;
}

export interface EngineSupervisorOptions {
  /**
   * Absolute path to the engine entry script. Test/dev override. When omitted the supervisor
   * resolves the signed install under `<configDir>/engine` (VERIFIED before every run), else the
   * local dev build (`dist/engine/native/engine-main.js`), else degrades `engine-absent`.
   */
  enginePath?: string;
  requestTimeoutMs?: number;
  spawnTimeoutMs?: number;
  maxRestarts?: number;
  /** Node executable to run a node-script engine with. Defaults to the current process's node. */
  nodeExecPath?: string;
  /** Environment for path resolution (`COMPACTION_ENGINE_PATH`, `COMPACTION_CONFIG_DIR`). Tests. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Explicit env override for the engine entry path (content-free; a filesystem path, never a
 * credential). Used for dev/test and by any environment that pins the engine location. Absent/
 * non-existent → fall through to the installed/dev resolution.
 */
export const ENGINE_PATH_ENV = "COMPACTION_ENGINE_PATH";

/**
 * Read the env override. Returns `{ set: true, path }` when the operator explicitly pinned an engine
 * path (existent → that path; non-existent → null, an EXPLICIT absent, no silent dev fallback), or
 * `{ set: false }` when unset (fall through to installed/dev resolution).
 */
function resolveEnginePathFromEnv(env: NodeJS.ProcessEnv = process.env): { set: boolean; path: string | null } {
  const raw = env[ENGINE_PATH_ENV];
  if (typeof raw !== "string" || raw.trim() === "") return { set: false, path: null };
  const trimmed = raw.trim();
  return { set: true, path: existsSync(trimmed) ? trimmed : null };
}

/** Where the resolved engine came from (honest status reporting + degrade semantics). */
export type EngineResolutionSource = "option" | "env" | "installed" | "dev-build" | "none";

/** The full engine resolution: path (when runnable), provenance, and verify-before-run outcome. */
export interface ResolvedEngine {
  /** Runnable engine entry, or null (absent / unverified — see `unverifiedReason`). */
  path: string | null;
  source: EngineResolutionSource;
  /** How to run it: `node <path>` for a node-script, direct spawn for a native binary. */
  artifactKind: EngineArtifactKind;
  /**
   * Set when the `current` pointer named an artifact that FAILED verify-before-run — including
   * `pointer-escape` (the pointer/symlink target resolved OUTSIDE the install root). Fail-closed:
   * an unverified install never runs and never falls through to the dev build (a tampered install
   * must not be silently substituted). The supervisor degrades `engine-unverified`.
   */
  unverifiedReason?: InstalledArtifactFailure | "pointer-escape";
  /** For a VERIFIED signed install: which trust root verified it + its manifest. */
  installed?: { trust: EngineTrustSource; manifest: EngineReleaseManifest };
}

/**
 * Signed-install resolution with VERIFY-BEFORE-RUN: read the `current` pointer under
 * `<configDir>/engine` (COMPACTION_CONFIG_DIR-redirectable), then require a valid signed manifest
 * next to the artifact (Ed25519 against the pinned/dev roots) AND a matching sha256 of the
 * artifact bytes. Absent pointer/target → null (fall through). Present-but-unverified → an
 * explicit unverified resolution (NO dev fallback). Never throws.
 */
function resolveInstalledEngine(env: NodeJS.ProcessEnv): ResolvedEngine | null {
  const engineRoot = path.join(configDir(env), "engine");
  const pointer = path.join(engineRoot, "current");
  let target: string;
  try {
    if (!existsSync(pointer)) return null;
    target = readFileSync(pointer, "utf8").trim();
  } catch {
    return null;
  }
  if (target === "" || !existsSync(target)) return null;
  // CONTAINMENT: the pointer may only name an artifact INSIDE the install root. Realpath BOTH
  // sides so neither a pointer to an outside path nor an inside symlink to an outside file can
  // ever reach verification (let alone a spawn). Escape is a tamper signal — terminal unverified,
  // never a dev-build fallback.
  try {
    const realRoot = realpathSync(engineRoot);
    const realTarget = realpathSync(target);
    if (!realTarget.startsWith(realRoot + path.sep)) {
      return { path: null, source: "installed", artifactKind: "node-script", unverifiedReason: "pointer-escape" };
    }
    target = realTarget;
  } catch {
    return { path: null, source: "installed", artifactKind: "node-script", unverifiedReason: "pointer-escape" };
  }
  const verification = verifyInstalledArtifact(target, env);
  if (!verification.verified) {
    return { path: null, source: "installed", artifactKind: "node-script", unverifiedReason: verification.reason };
  }
  return {
    path: target,
    source: "installed",
    artifactKind: verification.manifest.artifact_kind,
    installed: { trust: verification.trust, manifest: verification.manifest }
  };
}

/** Dev build fallback: the compiled interim engine, present in a dev checkout, excluded from npm. */
function resolveDevEnginePath(): string | null {
  // Both candidates are resolved relative to THIS MODULE, never to `process.cwd()`.
  //
  // A cwd-relative candidate used to be tried as well, and it was a real defect: running the
  // installed CLI from a directory that happened to contain `dist/engine/native/engine-main.js`
  // (i.e. anyone standing in a repo checkout) reported `Engine: ready` from material that was not
  // part of the installed package at all. Engine availability must be a property of the build, not
  // of the shell's working directory.
  //
  // Compiled layout: dist/core/gateway/engine-ipc/supervisor.js → dist/engine/native/engine-main.js.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const fromModule = path.join(path.resolve(here, "..", "..", ".."), "engine", "native", "engine-main.js");
  if (existsSync(fromModule)) return fromModule;
  // Source layout: under a source-mapped test runner (or `npm run dev`) `import.meta.url` points at
  // src/core/gateway/engine-ipc/supervisor.ts, so the build output is the repo's own
  // <repo>/dist/engine/native/engine-main.js. Derived from THIS MODULE's path, so — unlike the
  // cwd-relative candidate it replaces — it is still a property of the checkout that owns this
  // code, and cannot be conjured by running an unrelated install from inside a repo directory.
  const fromSourceTree = path.join(
    path.resolve(here, "..", "..", "..", ".."),
    "dist", "engine", "native", "engine-main.js"
  );
  return existsSync(fromSourceTree) ? fromSourceTree : null;
}

/**
 * Resolve the engine per the degradation order: explicit option override → env override →
 * VERIFIED installed signed artifact (verify-before-run; unverified is terminal, no dev fallback)
 * → dev build → none (degrade `engine-absent`).
 */
export function resolveEngine(options: EngineSupervisorOptions = {}): ResolvedEngine {
  const env = options.env ?? process.env;
  if (options.enginePath) {
    const exists = existsSync(options.enginePath);
    return { path: exists ? options.enginePath : null, source: exists ? "option" : "none", artifactKind: "node-script" };
  }
  // An explicit env override is authoritative: if it names a non-existent path the engine is
  // EXPLICITLY absent (no silent dev fallback). Only when the override is unset do we fall through.
  const fromEnv = resolveEnginePathFromEnv(env);
  if (fromEnv.set) {
    return { path: fromEnv.path, source: fromEnv.path === null ? "none" : "env", artifactKind: "node-script" };
  }
  const installed = resolveInstalledEngine(env);
  if (installed) return installed;
  const dev = resolveDevEnginePath();
  if (dev !== null) return { path: dev, source: "dev-build", artifactKind: "node-script" };
  return { path: null, source: "none", artifactKind: "node-script" };
}

/** Back-compat path-only view of `resolveEngine` (null = absent OR unverified). */
export function resolveEnginePath(options: EngineSupervisorOptions = {}): string | null {
  return resolveEngine(options).path;
}

interface PendingRequest {
  resolve: (outcome: EngineSupervisorOutcome) => void;
  timer: NodeJS.Timeout;
}

/**
 * Supervises a single engine child, correlates responses by `request_id`, and degrades on any
 * fault. One supervisor manages one child; `request()` spawns lazily on first use and restarts a
 * crashed child up to `maxRestarts` times (last-known-good semantics).
 */
export class EngineSupervisor {
  private child: ChildProcessWithoutNullStreams | null = null;
  private decoder = new FrameDecoder();
  private readonly pending = new Map<string, PendingRequest>();
  private restarts = 0;
  private disposed = false;
  private seq = 0;

  /** Mutable: an installed engine is RE-resolved + RE-verified before every spawn (see ensureChild). */
  private enginePath: string | null;
  private artifactKind: EngineArtifactKind;
  /** Degrade reason when no engine runs: `engine-unverified` iff a signed install failed verify. */
  private absentReason: Extract<EngineDegradeReason, "engine-absent" | "engine-unverified">;
  /** Where the engine resolved from at construction (drives the per-spawn re-verify). */
  private readonly source: EngineResolutionSource;
  private readonly resolveEnv: NodeJS.ProcessEnv;
  private readonly requestTimeoutMs: number;
  private readonly spawnTimeoutMs: number;
  private readonly maxRestarts: number;
  private readonly nodeExecPath: string;

  constructor(options: EngineSupervisorOptions = {}) {
    const resolved = resolveEngine(options);
    this.enginePath = resolved.path;
    this.artifactKind = resolved.artifactKind;
    this.absentReason = resolved.unverifiedReason === undefined ? "engine-absent" : "engine-unverified";
    this.source = resolved.source;
    this.resolveEnv = options.env ?? process.env;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_ENGINE_REQUEST_TIMEOUT_MS;
    this.spawnTimeoutMs = options.spawnTimeoutMs ?? DEFAULT_ENGINE_SPAWN_TIMEOUT_MS;
    this.maxRestarts = options.maxRestarts ?? MAX_ENGINE_RESTARTS;
    this.nodeExecPath = options.nodeExecPath ?? process.execPath;
  }

  /** Whether an engine path resolved at all (absent → every request degrades `engine-absent`). */
  get engineResolved(): boolean {
    return this.enginePath !== null;
  }

  /**
   * Ensure a live child exists. Returns the child or null when spawning is impossible/exhausted.
   * Never throws.
   */
  private ensureChild(): ChildProcessWithoutNullStreams | null {
    if (this.disposed) return null;
    if (this.child && this.child.exitCode === null && !this.child.killed) return this.child;
    // VERIFY BEFORE EVERY SPAWN: a signed install is re-resolved and re-verified (pointer
    // containment + Ed25519 signature + sha256 digest) immediately before EACH spawn — including
    // crash restarts — so artifact bytes swapped after construction (or after a previous spawn)
    // can never execute. Verification failure is terminal `engine-unverified` (no dev fallback);
    // a removed install degrades `engine-absent`. Explicit dev/test overrides (option/env) and
    // the dev build are unsigned by design and are not re-verified.
    if (this.source === "installed") {
      const fresh = resolveInstalledEngine(this.resolveEnv);
      if (fresh === null) {
        this.enginePath = null;
        this.absentReason = "engine-absent";
        return null;
      }
      if (fresh.path === null) {
        this.enginePath = null;
        this.absentReason = "engine-unverified";
        return null;
      }
      this.enginePath = fresh.path;
      this.artifactKind = fresh.artifactKind;
    }
    if (this.enginePath === null) return null;
    if (this.restarts > this.maxRestarts) return null;

    let child: ChildProcessWithoutNullStreams;
    // A node-script artifact runs under the current node; a native-binary artifact (per its SIGNED
    // manifest's artifact_kind) is spawned directly. The scrubbed child env is identical for both.
    const [command, args] =
      this.artifactKind === "native-binary" ? [this.enginePath, [] as string[]] : [this.nodeExecPath, [this.enginePath]];
    try {
      child = spawn(command, args, {
        stdio: ["pipe", "pipe", "pipe"],
        // Scrubbed environment, ALLOWLIST not denylist: exactly these two keys are forwarded, so no
        // ambient credential — and no ambient feature-activation marker — reaches the engine. The
        // engine needs no secret: it makes no provider call, and the only endpoint it can reach is a
        // loopback local-model daemon. Pinned in `tests/core/engine-supervisor.test.ts`; adding a key
        // here changes what the child can switch on, so it is a reviewed change, not a convenience.
        env: {
          PATH: process.env.PATH ?? "",
          COMPACTION_ENGINE_IPC: "1"
        }
      }) as ChildProcessWithoutNullStreams;
    } catch {
      return null;
    }

    this.decoder = new FrameDecoder();
    this.child = child;

    child.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk));
    // stderr is ignored for correlation; the engine must never emit content there. Drain to avoid
    // backpressure stalls.
    child.stderr.on("data", () => {});
    // Bind exit/error to THIS child instance: after a kill+restart the old child's late exit must
    // not be mistaken for the healthy replacement's, which would fail the replacement's in-flight
    // request as `crash` and orphan it. `onChildExit` ignores a stale emitter.
    child.on("exit", () => this.onChildExit(child));
    child.on("error", () => this.onChildExit(child));
    return child;
  }

  private onStdout(chunk: Buffer): void {
    let frames;
    try {
      frames = this.decoder.push(chunk);
    } catch (error) {
      // A malformed/over-large frame: fail every pending request `bad-frame` and reset the child.
      if (error instanceof EngineIpcFrameError) {
        this.failAllPending("bad-frame");
        this.killChild();
      }
      return;
    }
    for (const frame of frames) {
      const requestId = (frame as { request_id?: unknown }).request_id;
      const version = (frame as { protocol_version?: unknown }).protocol_version;
      // A response-shaped frame at a version we do not speak degrades version-mismatch (checked
      // BEFORE the strict guard, which only accepts the current version).
      if (typeof version === "number" && version !== ENGINE_IPC_PROTOCOL_VERSION) {
        this.settle(typeof requestId === "string" ? requestId : undefined, {
          status: "degraded",
          reason: "protocol-version-mismatch"
        });
        continue;
      }
      if (!isEngineIpcResponse(frame)) {
        this.settle(typeof requestId === "string" ? requestId : undefined, { status: "degraded", reason: "bad-response" });
        continue;
      }
      this.settle(frame.request_id, { status: "response", response: frame });
    }
  }

  private onChildExit(emitter?: ChildProcessWithoutNullStreams): void {
    // Ignore a stale exit/error from a child we already replaced or cleared (e.g. a kill()ed child
    // whose `exit` arrives after `ensureChild` spawned its successor): only the CURRENT child's
    // termination fails pending requests and consumes the restart budget. Detach the stale emitter.
    if (emitter !== undefined && emitter !== this.child) {
      emitter.removeAllListeners();
      return;
    }
    // Any in-flight request whose child vanished degrades `crash`. The next request restarts.
    this.failAllPending("crash");
    if (this.child) {
      this.child.removeAllListeners();
      this.child = null;
    }
    this.restarts += 1;
  }

  private killChild(): void {
    if (this.child) {
      try {
        this.child.kill("SIGKILL");
      } catch {
        // best effort
      }
    }
  }

  private failAllPending(reason: EngineDegradeReason): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.resolve({ status: "degraded", reason });
    }
    this.pending.clear();
  }

  private settle(requestId: string | undefined, outcome: EngineSupervisorOutcome): void {
    if (!requestId) return;
    const entry = this.pending.get(requestId);
    if (!entry) return;
    this.pending.delete(requestId);
    clearTimeout(entry.timer);
    entry.resolve(outcome);
  }

  /**
   * Send one request and resolve with a live response or a typed degrade. Never rejects. A pending
   * response past the per-request budget degrades `timeout`. `ping` uses the spawn budget.
   */
  request(input: EngineRequestInput): Promise<EngineSupervisorOutcome> {
    if (this.disposed) return Promise.resolve({ status: "degraded", reason: "engine-absent" });
    if (this.enginePath === null) return Promise.resolve({ status: "degraded", reason: this.absentReason });

    const child = this.ensureChild();
    if (!child) {
      // ensureChild may have re-run verify-before-spawn and nulled the path (unverified/removed).
      const reason: EngineDegradeReason =
        this.enginePath === null
          ? this.absentReason
          : this.restarts > this.maxRestarts
            ? "restart-exhausted"
            : "spawn-failed";
      return Promise.resolve({ status: "degraded", reason });
    }

    const requestId = `req-${process.pid}-${Date.now()}-${this.seq++}`;
    const budget =
      input.operation === "ping"
        ? this.spawnTimeoutMs
        : input.timeoutMs !== undefined && Number.isFinite(input.timeoutMs) && input.timeoutMs > 0
          ? input.timeoutMs
          : this.requestTimeoutMs;

    const message: EngineIpcRequest = {
      protocol_version: ENGINE_IPC_PROTOCOL_VERSION,
      request_id: requestId,
      operation: input.operation,
      workflow: input.workflow,
      provider: input.provider,
      route_type: input.route_type,
      ...(input.endpoint !== undefined ? { endpoint: input.endpoint } : {}),
      ...(input.output_shaping_enabled !== undefined ? { output_shaping_enabled: input.output_shaping_enabled } : {}),
      ...(input.input_compaction_enabled !== undefined
        ? { input_compaction_enabled: input.input_compaction_enabled }
        : {}),
      request_body: input.request_body,
      authorization: input.authorization,
      entitlement: input.entitlement,
      quota: input.quota
    };

    return new Promise<EngineSupervisorOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve({ status: "degraded", reason: "timeout" });
      }, budget);
      this.pending.set(requestId, { resolve, timer });

      let frame: Buffer;
      try {
        frame = encodeFrame(message);
      } catch {
        this.settle(requestId, { status: "degraded", reason: "bad-frame" });
        return;
      }
      try {
        child.stdin.write(frame, (err) => {
          if (err) this.settle(requestId, { status: "degraded", reason: "crash" });
        });
      } catch {
        this.settle(requestId, { status: "degraded", reason: "crash" });
      }
    });
  }

  /**
   * Liveness + version-compat handshake. Returns true only when the engine answered `ping` at the
   * current protocol version. Any degrade (absent/crash/timeout/mismatch) returns false.
   */
  async ping(): Promise<boolean> {
    const outcome = await this.request({
      operation: "ping",
      workflow: "",
      provider: "",
      route_type: "",
      request_body: "",
      authorization: { policy_id: "", scope_hash: "" },
      entitlement: { token: "" },
      quota: { period_id: "", locally_allocated_tokens_remaining: 0 }
    });
    return outcome.status === "response" && outcome.response.result === "noop" && outcome.response.protocol_version === ENGINE_IPC_PROTOCOL_VERSION;
  }

  /** Terminate the supervised child and refuse further requests. Idempotent, never throws. */
  dispose(): void {
    this.disposed = true;
    this.failAllPending("crash");
    this.killChild();
    if (this.child) {
      this.child.removeAllListeners();
      this.child = null;
    }
  }
}
