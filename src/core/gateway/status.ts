/**
 * Gateway lifecycle status + local pidfile (PUBLIC CLI/SDK code, engine-free).
 *
 * Supports `compaction gateway status|stop` and the guided onboarding. CONTENT-FREE: the pidfile holds
 * only the process id + listen/upstream metadata (host/port/provider/mode/timestamps), never any
 * request/response content; the receipts it reads are already content-free. Local-only under
 * `<cwd>/.compaction/gateway/` (gitignored).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { DEFAULT_GATEWAY_RECEIPTS_DIR, GATEWAY_RECEIPTS_FILE, type GatewayReceipt } from "./receipt.js";
import { summarizeCacheProof, type CacheProofSummary } from "./cache-proof.js";

export const GATEWAY_PID_FILE = "gateway.json";

/** Content-free record of a running gateway (no request/response content). */
export interface GatewayPidRecord {
  pid: number;
  host: string;
  port: number;
  upstream: string;
  provider: string;
  mode: string;
  /** Optional narrow workflow scope. Absent on legacy and generic Gateway records. */
  workflow?: "codex" | "claude-code";
  startedAt: string;
}

function pidPath(cwd: string): string {
  return path.join(cwd, DEFAULT_GATEWAY_RECEIPTS_DIR, GATEWAY_PID_FILE);
}

export function writeGatewayPid(rec: GatewayPidRecord, cwd: string = process.cwd()): void {
  mkdirSync(path.join(cwd, DEFAULT_GATEWAY_RECEIPTS_DIR), { recursive: true });
  writeFileSync(pidPath(cwd), `${JSON.stringify(rec, null, 2)}\n`, "utf8");
}

export function readGatewayPid(cwd: string = process.cwd()): GatewayPidRecord | null {
  try {
    const r = JSON.parse(readFileSync(pidPath(cwd), "utf8")) as Record<string, unknown>;
    if (!r || typeof r.pid !== "number") return null;
    const workflow = r.workflow === "codex" || r.workflow === "claude-code" ? r.workflow : undefined;
    return {
      pid: r.pid,
      host: r.host as string,
      port: r.port as number,
      upstream: r.upstream as string,
      provider: r.provider as string,
      mode: r.mode as string,
      ...(workflow ? { workflow } : {}),
      startedAt: r.startedAt as string
    };
  } catch {
    return null;
  }
}

export function removeGatewayPid(cwd: string = process.cwd()): void {
  try {
    rmSync(pidPath(cwd), { force: true });
  } catch {
    /* best-effort */
  }
}

/** True if a process with `pid` is alive (signal 0). EPERM means it exists but is owned by another user. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Probe whether something is listening on host:port (TCP connect, short timeout). Never throws. */
export function probeListening(host: string, port: number, timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    let done = false;
    const finish = (v: boolean): void => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(timeoutMs);
    sock.on("connect", () => finish(true));
    sock.on("timeout", () => finish(false));
    sock.on("error", () => finish(false));
  });
}

/** Read the local-only content-free receipts (each line is a GatewayReceipt). */
export function readReceipts(cwd: string = process.cwd()): GatewayReceipt[] {
  const p = path.join(cwd, DEFAULT_GATEWAY_RECEIPTS_DIR, GATEWAY_RECEIPTS_FILE);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as GatewayReceipt);
}

export interface GatewayStatus {
  running: boolean;
  pid?: number;
  base?: string;
  provider?: string;
  mode?: string;
  /** Optional narrow workflow scope. Absent for legacy and generic Gateway records. */
  workflow?: "codex" | "claude-code";
  /** Total local receipts (= requests observed through the gateway in this project). */
  receiptsCount: number;
  /** ISO timestamp of the most recent request observed, when any. */
  lastRequestAt?: string;
  /** True when ANY observed request reported provider cached input tokens. */
  cachedObserved: boolean;
  /** When a `since` is given: were any requests observed at/after it (this-session traffic)? */
  observedSince?: boolean;
  /** Content-free summary over the local receipts (best provider-backed fresh/billed input reduction). */
  summary: CacheProofSummary;
}

/**
 * Resolve the current gateway status: running (pidfile present + process alive + port listening),
 * plus a content-free rollup of the local receipts. When `since` (ISO) is given, `observedSince`
 * reports whether any request was observed at/after it (for "traffic observed this session"). Never throws.
 */
export async function getGatewayStatus(cwd: string = process.cwd(), since?: string): Promise<GatewayStatus> {
  const rec = readGatewayPid(cwd);
  let running = false;
  let base: string | undefined;
  if (rec) {
    const alive = isProcessAlive(rec.pid);
    const listening = await probeListening(rec.host, rec.port);
    running = alive && listening;
    base = `http://${rec.host}:${rec.port}`;
  }
  const receipts = readReceipts(cwd);
  const times = receipts.map((r) => r.captured_at).filter((t): t is string => typeof t === "string").sort();
  const lastRequestAt = times.length > 0 ? times[times.length - 1] : undefined;
  const cachedObserved = receipts.some((r) => typeof r.tokens?.cached_input === "number" && r.tokens.cached_input > 0);
  const observedSince = since ? receipts.some((r) => typeof r.captured_at === "string" && r.captured_at >= since) : undefined;
  return {
    running,
    ...(rec
      ? {
          pid: rec.pid,
          provider: rec.provider,
          mode: rec.mode,
          ...(rec.workflow ? { workflow: rec.workflow } : {})
        }
      : {}),
    ...(base ? { base } : {}),
    receiptsCount: receipts.length,
    ...(lastRequestAt ? { lastRequestAt } : {}),
    cachedObserved,
    ...(observedSince !== undefined ? { observedSince } : {}),
    summary: summarizeCacheProof(receipts)
  };
}
