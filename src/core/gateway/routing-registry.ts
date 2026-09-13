/**
 * USER-GLOBAL ROUTING SLOT REGISTRY (PUBLIC CLI core - engine-free, content-free).
 *
 * The transparent-routing endpoint backs a long-lived interactive tool session. Recording it in the
 * launch directory made it owned by whatever directory the tool happened to start from, and a single
 * JSON object per directory meant a second start silently orphaned a gateway that was still serving.
 * This module is the replacement record: one file per routing identity, under the Compaction home,
 * outside any project tree.
 *
 * MULTI-SLOT BY CONSTRUCTION. `routing/<key>.json`, one file per `(uid, cwd, provider, workflow)`.
 * Two different routing identities cannot land on the same path, so a start can never overwrite a
 * live gateway's record. That is the whole of the anti-orphan mechanism; nothing else depends on
 * cooperative behavior.
 *
 * THE PORT IS RESERVED, NOT EPHEMERAL. A running tool froze its base URL at `exec` and can never ask
 * for a new one, so a replacement gateway is only useful if it comes back at the SAME address.
 * `reservedPort` is allocated once from a band chosen to sit outside BOTH OS ephemeral ranges
 * (macOS 49152-65535, Linux 32768-60999), so the kernel can never hand our routing port to an
 * unrelated outbound connection, and every later start of the slot re-binds it.
 *
 * THE PORT IS SALTED, NOT PUBLISHED. A stable address creates a hazard a kernel-chosen port did not
 * have: a local process that can PREDICT the port can bind it first and wait. The candidate is
 * therefore derived through 32 random bytes in a `0600` per-user `.port-salt`, so the address is
 * stable for us and unpredictable to any principal that cannot read our home. This is a real defence
 * only against OTHER users; a process running as our own uid can read the salt, and no port scheme
 * defends a principal against itself.
 *
 * WHAT THE SLOT HOLDS. The same content-free fields the gateway pidfile already carried
 * (pid/host/port/provider/upstream/mode/workflow/timestamps) plus `reservedPort`, `cwd` and the
 * adoption/quarantine markers. It carries `release` - which includes `controlCapability` - because
 * revival must AUTHENTICATE the listener rather than trust a TCP accept. That capability is a MOVE,
 * not a new secret: it already lived in the project-tree pidfile at `0600`. Moving it under the
 * Compaction home is a strict improvement, since a repo archive, a stray `tar` or a container build
 * context no longer sweeps it up. It is credential-adjacent and its exposure is "HOME is readable";
 * it is NOT a provider credential and grants access to none - the provider key never enters gateway
 * storage at all.
 *
 * NEVER IN THIS DIRECTORY: a request or response byte, a prompt, a header, a provider credential, or
 * a URL carrying userinfo. Asserted by `tests/security/routing-gateway-content-free.test.ts`.
 */
import { createHash, createHmac, randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { resolveCompactionHome, type ShimEnv } from "../tool-shim.js";
import { isGatewayReleaseIdentity, type GatewayReleaseIdentity } from "./update-identity.js";

/** Directory under the Compaction home that owns every routing slot, its salt, locks and logs. */
export const ROUTING_DIR = "routing";

/** The per-user port salt. 32 random bytes, `0600`. Not a credential: it keys a local derivation. */
export const ROUTING_PORT_SALT_FILE = ".port-salt";

/**
 * Bottom of the reserved routing band. Chosen to sit BELOW both OS ephemeral ranges (measured:
 * macOS `net.inet.ip.portrange.first/last` = 49152-65535; Linux `ip_local_port_range` =
 * 32768-60999) and above 1024 so no privilege is needed. A routing port inside an ephemeral range
 * can be handed by the kernel to an unrelated outbound connection - the previous behavior, and a
 * live hazard this band removes.
 */
export const ROUTING_PORT_BASE = 20480;

/**
 * Width of the band (20480-28671). Wide enough that squatting the WHOLE band to force allocation
 * failure costs an attacker 8192 held sockets in an otherwise-idle range - expensive, noisy, and
 * trivially visible to `lsof`/`ss` - while the payoff is only disabling a measurement path, never
 * capturing a credential.
 */
export const ROUTING_PORT_SPAN = 8192;

/** How many band ports are tried before allocation gives up and the caller falls back. */
const ALLOCATION_PROBE_LIMIT = 64;

/** Bytes kept in a routing log before it is truncated. Small: these are lifecycle lines, not traffic. */
const ROUTING_LOG_MAX_BYTES = 256 * 1024;

/**
 * Content-free record of one routing slot. Every field is metadata about the PROCESS and its ROUTE;
 * none of it is derived from a request or a response.
 */
export interface RoutingSlotRecord {
  pid: number;
  host: string;
  port: number;
  /**
   * The stable address this slot owns. Every later start of the slot binds THIS port, which is the
   * only reason a still-running tool with a frozen base URL can be repaired at all.
   */
  reservedPort: number;
  provider: string;
  upstream: string;
  mode: string;
  workflow?: "codex" | "claude-code";
  /** The resolved directory this routing identity belongs to (receipts stay project-local). */
  cwd: string;
  startedAt: string;
  /**
   * True when this slot was ADOPTED from a pre-existing cwd pidfile rather than started by the slot
   * model. An adopted slot keeps the gateway's CURRENT port so a live session's endpoint never
   * moves - which means its `reservedPort` may sit inside an OS ephemeral range and is therefore
   * weaker than a freshly allocated one until the gateway is next replaced.
   */
  adopted?: boolean;
  /**
   * Set when something that is NOT our gateway holds `reservedPort`. The slot is then never revived
   * and never injected; the reason is surfaced by `compaction gateway status`.
   */
  quarantine?: { reason: string; at: string };
  release?: GatewayReleaseIdentity;
}

/** The routing directory, created `0700` on demand. */
export function routingDir(env: ShimEnv = process.env): string {
  return path.join(resolveCompactionHome(env), ROUTING_DIR);
}

function ensureRoutingDir(env: ShimEnv = process.env): string {
  const dir = routingDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Resolve a directory to its canonical form so two spellings of one path share a slot. */
function resolvedCwd(cwd: string): string {
  try {
    return realpathSync(cwd);
  } catch {
    return path.resolve(cwd);
  }
}

export interface RoutingSlotIdentity {
  cwd: string;
  provider: string;
  /** The gateway's workflow identity, or absent for the plain byte-safe record gateway. */
  workflow?: "codex" | "claude-code";
}

/**
 * The slot key: `sha256(uid : resolvedCwd : provider : workflowScope)`, truncated to 32 hex chars.
 *
 * The uid is in the key so two users on one machine can never name the same slot even before the
 * `0700` directory mode is considered. The cwd is in the key - rather than one machine-wide routing
 * endpoint - because the gateway writes its receipts into its own cwd and the per-turn receipt line
 * reads them from there; a single shared endpoint would deposit every project's receipts into
 * whichever project started it first, silently breaking the status line for every other project.
 */
export function routingSlotKey(identity: RoutingSlotIdentity, env: ShimEnv = process.env): string {
  void env;
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const scope = identity.workflow ?? "none";
  return createHash("sha256")
    .update(`${uid}:${resolvedCwd(identity.cwd)}:${identity.provider}:${scope}`)
    .digest("hex")
    .slice(0, 32);
}

export function routingSlotPath(key: string, env: ShimEnv = process.env): string {
  return path.join(routingDir(env), `${key}.json`);
}

/** The per-slot single-flight lock. One lock per routing identity, not per directory. */
export function routingSlotLockPath(key: string, env: ShimEnv = process.env): string {
  return path.join(routingDir(env), `${key}.lock`);
}

export function routingSlotLogPath(key: string, env: ShimEnv = process.env): string {
  return path.join(routingDir(env), `${key}.log`);
}

function isValidKey(key: string): boolean {
  return /^[0-9a-f]{32}$/.test(key);
}

/** Parse a slot file. Returns null on anything malformed - a bad record is never half-trusted. */
export function readRoutingSlot(key: string, env: ShimEnv = process.env): RoutingSlotRecord | null {
  if (!isValidKey(key)) return null;
  try {
    const raw = JSON.parse(readFileSync(routingSlotPath(key, env), "utf8")) as Record<string, unknown>;
    if (!raw || typeof raw.pid !== "number") return null;
    const port = raw.port;
    const reservedPort = raw.reservedPort;
    if (!Number.isSafeInteger(port) || !Number.isSafeInteger(reservedPort)) return null;
    const workflow = raw.workflow === "codex" || raw.workflow === "claude-code" ? raw.workflow : undefined;
    const quarantine =
      raw.quarantine && typeof raw.quarantine === "object" && typeof (raw.quarantine as { reason?: unknown }).reason === "string"
        ? { reason: (raw.quarantine as { reason: string }).reason, at: String((raw.quarantine as { at?: unknown }).at ?? "") }
        : undefined;
    return {
      pid: raw.pid,
      host: String(raw.host ?? "127.0.0.1"),
      port: port as number,
      reservedPort: reservedPort as number,
      provider: String(raw.provider ?? ""),
      upstream: String(raw.upstream ?? ""),
      mode: String(raw.mode ?? ""),
      ...(workflow ? { workflow } : {}),
      cwd: String(raw.cwd ?? ""),
      startedAt: String(raw.startedAt ?? ""),
      ...(raw.adopted === true ? { adopted: true as const } : {}),
      ...(quarantine ? { quarantine } : {}),
      ...(isGatewayReleaseIdentity(raw.release) ? { release: raw.release } : {})
    };
  } catch {
    return null;
  }
}

/** Write the slot `0600` inside the `0700` routing directory. */
export function writeRoutingSlot(key: string, record: RoutingSlotRecord, env: ShimEnv = process.env): void {
  if (!isValidKey(key)) throw new Error("invalid routing slot key");
  ensureRoutingDir(env);
  const target = routingSlotPath(key, env);
  writeFileSync(target, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(target, 0o600);
}

/**
 * Remove the slot. `expectedInstanceId` guards the one dangerous ordering: an explicit stop removes
 * the slot BEFORE signalling, so the dying gateway's own `close` handler must not delete a slot a
 * REPLACEMENT has meanwhile written.
 */
export function removeRoutingSlot(key: string, env: ShimEnv = process.env, expectedInstanceId?: string): void {
  try {
    if (expectedInstanceId && readRoutingSlot(key, env)?.release?.instanceId !== expectedInstanceId) return;
    rmSync(routingSlotPath(key, env), { force: true });
  } catch {
    /* best-effort */
  }
}

export interface ListedRoutingSlot {
  key: string;
  record: RoutingSlotRecord;
}

export function listRoutingSlots(env: ShimEnv = process.env): ListedRoutingSlot[] {
  let names: string[];
  try {
    names = readdirSync(routingDir(env));
  } catch {
    return [];
  }
  const slots: ListedRoutingSlot[] = [];
  for (const name of names) {
    const match = /^([0-9a-f]{32})\.json$/.exec(name);
    if (!match) continue;
    const record = readRoutingSlot(match[1], env);
    if (record) slots.push({ key: match[1], record });
  }
  return slots;
}

/**
 * Every slot this user owns for `cwd` + `provider`, across workflow scopes. Revival uses this rather
 * than one computed key so an apply-routing (workflow-scoped) slot is repaired exactly like a plain
 * one; the set is identical to the per-key lookups it replaces.
 */
export function routingSlotsForCwd(cwd: string, provider: string, env: ShimEnv = process.env): ListedRoutingSlot[] {
  return routingSlotsForCwdAnyProvider(cwd, env).filter((slot) => slot.record.provider === provider);
}

/**
 * Every slot this user owns for `cwd`, across BOTH providers and every workflow scope.
 *
 * A reader that only wants to know whether this directory is routed at all - and in what state -
 * has no provider to supply, and asking per provider would re-read the directory once per guess.
 */
export function routingSlotsForCwdAnyProvider(cwd: string, env: ShimEnv = process.env): ListedRoutingSlot[] {
  // BOTH sides are resolved. A record may have been written with an unresolved path (on macOS
  // `/var/...` and `/private/var/...` name the same directory), and comparing raw strings would
  // silently report "this directory is not routed" for a directory that is.
  const target = resolvedCwd(cwd);
  return listRoutingSlots(env).filter((slot) => resolvedCwd(slot.record.cwd) === target);
}

/** Mark a slot as held by something that is not ours. A quarantined slot is never revived. */
export function quarantineRoutingSlot(key: string, reason: string, env: ShimEnv = process.env): void {
  const record = readRoutingSlot(key, env);
  if (!record) return;
  writeRoutingSlot(key, { ...record, quarantine: { reason, at: new Date().toISOString() } }, env);
}

export function clearRoutingSlotQuarantine(key: string, env: ShimEnv = process.env): void {
  const record = readRoutingSlot(key, env);
  if (!record?.quarantine) return;
  const { quarantine: _dropped, ...rest } = record;
  writeRoutingSlot(key, rest, env);
}

/* ------------------------------------------------------------------------------------------------
 * The port salt and the reserved port.
 * ---------------------------------------------------------------------------------------------- */

const saltCache = new Map<string, Buffer | undefined>();

/** Drop the in-process salt cache. Tests that swap `COMPACTION_HOME` call this; production does not. */
export function resetRoutingPortSaltCache(): void {
  saltCache.clear();
}

/**
 * Read the per-user port salt, creating it on first use. `wx` so two processes racing on first use
 * cannot clobber each other; the loser re-reads. Returns undefined only when the salt can neither be
 * read nor created, in which case allocation reports failure and the caller falls back to the
 * ephemeral path rather than deriving a port from a publicly guessable input.
 */
export function routingPortSalt(env: ShimEnv = process.env): Buffer | undefined {
  const dir = routingDir(env);
  if (saltCache.has(dir)) return saltCache.get(dir);
  const salt = readOrCreatePortSalt(dir, env);
  saltCache.set(dir, salt);
  return salt;
}

function readOrCreatePortSalt(dir: string, env: ShimEnv): Buffer | undefined {
  const target = path.join(dir, ROUTING_PORT_SALT_FILE);
  try {
    const existing = readFileSync(target);
    if (existing.length >= 16) return existing;
  } catch {
    /* fall through to creation */
  }
  try {
    ensureRoutingDir(env);
    const salt = randomBytes(32);
    try {
      writeFileSync(target, salt, { flag: "wx", mode: 0o600 });
      chmodSync(target, 0o600);
      return salt;
    } catch {
      const raced = readFileSync(target);
      return raced.length >= 16 ? raced : undefined;
    }
  } catch {
    return undefined;
  }
}

/** The salted candidate port for a slot: stable for us, unpredictable without the `0600` salt. */
export function routingPortCandidate(key: string, salt: Buffer): number {
  const digest = createHmac("sha256", salt).update(key).digest();
  return ROUTING_PORT_BASE + (digest.readUInt32BE(0) % ROUTING_PORT_SPAN);
}

/** Can this local port be bound right now? A live LISTEN held by another process is the only no. */
export function canBindLocalPort(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      try {
        server.close(() => resolve(value));
      } catch {
        resolve(value);
      }
    };
    server.once("error", () => {
      settled = true;
      resolve(false);
    });
    server.listen(port, host, () => finish(true));
  });
}

export interface AllocateRoutingPortResult {
  port?: number;
  reason?: string;
}

/**
 * Allocate this slot's stable port ONCE. Candidate from the salted derivation, then a bounded linear
 * probe within the band on collision.
 *
 * AT ALLOCATION, NOTHING IS PINNED YET, so a contested candidate is simply skipped: the common case
 * is an unrelated dev server, there is nothing to repair, and taking the next port degrades nobody.
 * This is deliberately NOT the revival rule - at revival the reserved port is the only address that
 * could repair a pinned child, so it can never be substituted (see `routing-revival.ts`).
 */
export async function allocateRoutingPort(
  key: string,
  env: ShimEnv = process.env,
  canBind: (port: number) => Promise<boolean> = (port) => canBindLocalPort(port)
): Promise<AllocateRoutingPortResult> {
  const salt = routingPortSalt(env);
  if (!salt) return { reason: "the routing port salt could not be read or created" };
  const start = routingPortCandidate(key, salt);
  for (let step = 0; step < ALLOCATION_PROBE_LIMIT; step += 1) {
    const port = ROUTING_PORT_BASE + ((start - ROUTING_PORT_BASE + step) % ROUTING_PORT_SPAN);
    if (await canBind(port)) return { port };
  }
  return { reason: `no free port in the reserved routing band after ${ALLOCATION_PROBE_LIMIT} attempts` };
}

/* ------------------------------------------------------------------------------------------------
 * The routing log.
 * ---------------------------------------------------------------------------------------------- */

/**
 * Append one CONTENT-FREE lifecycle line to `<home>/routing/<key>.log`.
 *
 * The gateway used to spawn with `stdio: "ignore"`, so a death left no trace of any kind and a
 * post-hoc investigation could not establish why it exited. This is that trace. It records
 * start/stop/signal/quarantine events only. No request or response byte, no header, no prompt, and
 * no credential may ever reach this file - a hard rail asserted by test.
 */
export function appendRoutingLog(key: string, line: string, env: ShimEnv = process.env): void {
  if (!isValidKey(key)) return;
  try {
    ensureRoutingDir(env);
    const target = routingSlotLogPath(key, env);
    try {
      if (statSync(target).size > ROUTING_LOG_MAX_BYTES) rmSync(target, { force: true });
    } catch {
      /* no log yet */
    }
    appendFileSync(target, `${new Date().toISOString()} ${line}\n`, { encoding: "utf8", mode: 0o600 });
    chmodSync(target, 0o600);
  } catch {
    /* observability is best-effort and never affects whether traffic flows */
  }
}
