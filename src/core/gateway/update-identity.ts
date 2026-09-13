/** Content-free, capability-authenticated local Gateway update control. No process signals. */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { ENGINE_IPC_PROTOCOL_VERSION } from "./engine-ipc/protocol.js";
import { isProcessAlive, readGatewayPid, type GatewayPidRecord } from "./status.js";
import { findUnregisteredGatewayProcess } from "../update/process-identity.js";

export const GATEWAY_CONTROL_PATH = "/.compaction/control/v1";
export type GatewayControlRecord = Pick<GatewayPidRecord, "pid" | "host" | "port" | "release">;
export interface GatewayReleaseIdentity {
  instanceId: string;
  controlCapability: string;
  cliVersion: string;
  protocolVersion: number;
  pairId: string;
}
export interface GatewayUpdateState {
  activeRequests: number;
  pendingBookkeeping: number;
  unsettledRuns: number;
  unsettledCodex: number;
  unsettledClaude: number;
  settlementUnknown: boolean;
}
export type GatewayIdentityStatus = Omit<GatewayReleaseIdentity, "controlCapability"> & GatewayUpdateState & {
  pid: number;
  draining: boolean;
};

export function gatewayCliVersion(): string {
  try {
    const value = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { version?: unknown };
    return typeof value.version === "string" ? value.version : "unknown";
  } catch { return "unknown"; }
}

export function createGatewayReleaseIdentity(pairId = `external:${gatewayCliVersion()}`): GatewayReleaseIdentity {
  return {
    instanceId: randomBytes(24).toString("hex"),
    controlCapability: randomBytes(32).toString("hex"),
    cliVersion: gatewayCliVersion(),
    protocolVersion: ENGINE_IPC_PROTOCOL_VERSION,
    pairId
  };
}

export function isGatewayReleaseIdentity(value: unknown): value is GatewayReleaseIdentity {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return typeof r.instanceId === "string" && /^[0-9a-f]{48}$/.test(r.instanceId) &&
    typeof r.controlCapability === "string" && /^[0-9a-f]{64}$/.test(r.controlCapability) &&
    typeof r.cliVersion === "string" && Number.isSafeInteger(r.protocolVersion) &&
    typeof r.pairId === "string" && r.pairId.length > 0;
}

export function gatewayQuiescent(state: GatewayUpdateState): boolean {
  return !state.settlementUnknown && state.activeRequests === 0 && state.pendingBookkeeping === 0 &&
    state.unsettledRuns === 0 && state.unsettledCodex === 0 && state.unsettledClaude === 0;
}

/** Reuse requires the authenticated listener's release to match the admitted session exactly. */
export function gatewayReleaseMatches(
  identity: GatewayIdentityStatus | undefined,
  pairId = `external:${gatewayCliVersion()}`
): boolean {
  if (gatewayCliVersion() === "unknown") return false;
  return !!identity && !identity.draining && identity.pairId === pairId &&
    identity.cliVersion === gatewayCliVersion() && identity.protocolVersion === ENGINE_IPC_PROTOCOL_VERSION;
}

function proof(capability: string, text: string): string {
  return createHmac("sha256", capability).update(text).digest("hex");
}

function equalProof(actual: unknown, expected: string): boolean {
  return typeof actual === "string" && /^[0-9a-f]{64}$/.test(actual) &&
    timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

/** Called before routing. Check-and-close is synchronous: no new request can cross the drain check. */
export function gatewayControlHandler(
  identity: GatewayReleaseIdentity,
  state: () => GatewayUpdateState,
  server: () => http.Server
): (req: http.IncomingMessage, res: http.ServerResponse) => boolean {
  let draining = false;
  return (req, res) => {
    if (req.url !== GATEWAY_CONTROL_PATH) {
      if (!draining) return false;
      res.writeHead(503, { connection: "close" });
      res.end();
      return true;
    }
    const nonce = req.headers["x-compaction-nonce"];
    const address = req.socket.remoteAddress;
    const authorized = (address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1") &&
      typeof nonce === "string" && /^[0-9a-f]{48}$/.test(nonce) &&
      equalProof(req.headers["x-compaction-control"], proof(identity.controlCapability, `${req.method}:${identity.instanceId}:${nonce}`)) &&
      req.headers["x-compaction-instance"] === identity.instanceId && !req.headers.origin;
    if (!authorized || (req.method !== "GET" && req.method !== "POST")) {
      req.resume();
      res.writeHead(404, { connection: "close" });
      res.end();
      return true;
    }
    const snapshot = state();
    const { controlCapability: _capability, ...publicIdentity } = identity;
    const status: GatewayIdentityStatus = { ...publicIdentity, ...snapshot, pid: process.pid, draining };
    const reply = (code: number): void => {
      const body = JSON.stringify(status);
      res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store", connection: "close",
        "x-compaction-proof": proof(identity.controlCapability, `${nonce}:${body}`) });
      res.end(body);
    };
    if (req.method === "POST") {
      if (draining || !gatewayQuiescent(snapshot)) {
        reply(409);
        return true;
      }
      draining = true;
      server().close();
      server().closeIdleConnections();
      status.draining = true;
    }
    req.resume();
    reply(200);
    return true;
  };
}

/** Proves the listener owns this exact recorded instance; a live PID/TCP port alone proves nothing. */
export function queryGatewayIdentity(rec: GatewayControlRecord, drain = false): Promise<GatewayIdentityStatus | undefined> {
  const identity = rec.release;
  if (!isGatewayReleaseIdentity(identity) || !["127.0.0.1", "::1"].includes(rec.host) ||
    !Number.isSafeInteger(rec.port) || rec.port <= 0 || rec.port > 65535) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const nonce = randomBytes(24).toString("hex");
    const method = drain ? "POST" : "GET";
    let finished = false;
    const finish = (value?: GatewayIdentityStatus): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(value);
    };
    const req = http.request({ hostname: rec.host, port: rec.port, path: GATEWAY_CONTROL_PATH,
      method, agent: false,
      headers: { "x-compaction-control": proof(identity.controlCapability, `${method}:${identity.instanceId}:${nonce}`),
        "x-compaction-instance": identity.instanceId, "x-compaction-nonce": nonce }
    }, (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf8");
        if (body.length > 8192) { req.destroy(); finish(); }
      });
      res.on("error", () => finish());
      res.on("end", () => {
        try {
          if (!equalProof(res.headers["x-compaction-proof"], proof(identity.controlCapability, `${nonce}:${body}`))) return finish();
          const r = JSON.parse(body) as GatewayIdentityStatus;
          const counters = [r.activeRequests, r.pendingBookkeeping, r.unsettledRuns, r.unsettledCodex, r.unsettledClaude];
          if (res.statusCode !== 200 || r.pid !== rec.pid || r.instanceId !== identity.instanceId ||
            r.cliVersion !== identity.cliVersion || r.protocolVersion !== identity.protocolVersion || r.pairId !== identity.pairId ||
            typeof r.draining !== "boolean" || typeof r.settlementUnknown !== "boolean" ||
            counters.some((n) => !Number.isSafeInteger(n) || n < 0)) return finish();
          finish(r);
        } catch { finish(); }
      });
    });
    const timer = setTimeout(() => { req.destroy(); finish(); }, 1000);
    req.on("error", () => finish());
    req.end();
  });
}

export function registerGatewayInstance(root: string, rec: GatewayControlRecord): () => void {
  if (!isGatewayReleaseIdentity(rec.release)) throw new Error("Gateway release identity missing");
  const directory = path.join(root, "gateways");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const target = path.join(directory, `${rec.release.instanceId}.json`);
  // The global inventory needs no route URL (which can contain userinfo or query credentials).
  const record: GatewayControlRecord = { pid: rec.pid, host: rec.host, port: rec.port, release: rec.release };
  writeFileSync(target, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: "wx" });
  chmodSync(target, 0o600);
  return () => { rmSync(target, { force: true }); };
}

/** Called UNDER the managed activation lock, after all admitted tool leases have cleared. */
export async function gatewayBarrier(root: string, _currentPairId: string): Promise<{ ok: boolean; reason?: string }> {
  const directory = path.join(root, "gateways");
  let names: string[];
  try { names = readdirSync(directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { ok: false, reason: "gateway-registry-unreadable" };
    names = [];
  }
  const idle: GatewayControlRecord[] = [];
  const registeredPids = new Set<number>();
  for (const name of names) {
    try {
      if (!/^[0-9a-f]{48}\.json$/.test(name)) return { ok: false, reason: "gateway-registry-unknown" };
      const target = path.join(directory, name);
      const stat = lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) return { ok: false, reason: "gateway-registry-unsafe" };
      const rec = JSON.parse(readFileSync(target, "utf8")) as GatewayControlRecord;
      if (!isGatewayReleaseIdentity(rec.release) || `${rec.release.instanceId}.json` !== name || !Number.isSafeInteger(rec.pid) || rec.pid <= 0)
        return { ok: false, reason: "gateway-identity-unknown" };
      try { process.kill(rec.pid, 0); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") { rmSync(target); continue; }
        return { ok: false, reason: "gateway-process-unknown" };
      }
      const status = await queryGatewayIdentity(rec);
      if (!status) return { ok: false, reason: "gateway-identity-unverified" };
      if (!gatewayQuiescent(status) || status.draining) return { ok: false, reason: "gateway-busy-or-unsettled" };
      idle.push(rec);
      registeredPids.add(rec.pid);
    } catch { return { ok: false, reason: "gateway-registry-unreadable" }; }
  }
  const project = readGatewayPid();
  if (project && Number.isSafeInteger(project.pid) && project.pid > 0 && isProcessAlive(project.pid) &&
    !idle.some((rec) => rec.release?.instanceId === project.release?.instanceId && rec.pid === project.pid)) {
    return { ok: false, reason: "gateway-project-identity-unverified-stop-old-gateway" };
  }
  const unregistered = findUnregisteredGatewayProcess(registeredPids);
  if (unregistered !== false) return { ok: false, reason: unregistered === "unknown"
    ? "gateway-process-inventory-unknown" : "gateway-unregistered-stop-old-gateway" };
  for (const rec of idle) {
    const result = await queryGatewayIdentity(rec, true);
    if (!result?.draining) return { ok: false, reason: "gateway-drain-deferred" };
  }
  return { ok: true };
}
