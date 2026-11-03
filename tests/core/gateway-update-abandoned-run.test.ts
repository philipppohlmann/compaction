import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// The machine-wide scan for unregistered gateways would see any real gateway on the developer's
// machine; this file is about the registered instance's settlement state only.
vi.mock("../../src/core/update/process-identity.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/core/update/process-identity.js")>()),
  findUnregisteredGatewayProcess: () => false
}));

const { createGatewayReleaseIdentity, gatewayBarrier, gatewayQuiescent, queryGatewayIdentity, registerGatewayInstance } =
  await import("../../src/core/gateway/update-identity.js");
const { startGatewayServer } = await import("../../src/core/gateway/server.js");
const { RUN_BOUNDARY_SCHEMA } = await import("../../src/core/gateway/run-boundary.js");

let root: string;
const closers: Array<() => Promise<void>> = [];
beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), "gateway-abandoned-")); });
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  rmSync(root, { recursive: true, force: true });
});

async function gateway() {
  const release = createGatewayReleaseIdentity("pair-old");
  const started = await startGatewayServer({ provider: "openai", upstream: "http://127.0.0.1:9", mode: "record",
    host: "127.0.0.1", port: 0, cwd: root, entitlementEnv: { COMPACTION_CONFIG_DIR: root }, releaseIdentity: release });
  closers.push(async () => { started.server.closeIdleConnections(); await started.close(); });
  const rec = { pid: process.pid, host: "127.0.0.1", port: started.address.port, release };
  started.server.once("close", registerGatewayInstance(root, rec));
  return rec;
}

function writeStore(correlation: string, store: unknown): string {
  mkdirSync(path.join(root, "runs"), { recursive: true });
  const target = path.join(root, "runs", `${correlation}.json`);
  writeFileSync(target, JSON.stringify(store));
  return target;
}

describe("update drain and abandoned runs", () => {
  it("an abandoned open run and its open Claude pending no longer hold the drain", async () => {
    // Measured on a live device: a persistent routing gateway reported 56 open runs and 7 open Claude
    // provisional pendings from sessions that ended without a Stop, so every activation deferred.
    const rec = await gateway();
    const abandoned = "b".repeat(32);
    const target = writeStore(abandoned, { schema: RUN_BOUNDARY_SCHEMA, runs: [
      { session_correlation_id: abandoned, run_seq: 1, started_at: "2026-09-01T12:00:00.000Z", ended_at: "2026-09-01T12:05:00.000Z" },
      { session_correlation_id: abandoned, run_seq: 2, started_at: "2026-09-01T12:06:00.000Z" }],
      claude_provisional_pending: { schema: "compaction.claude-provisional-pending.v2", phase: "open",
        session_correlation_id: abandoned, prompt_correlation_id: "c".repeat(32), predecessor_run_seq: 1, provisional_run_seq: 2 } });
    const body = readFileSync(target, "utf8");
    const status = await queryGatewayIdentity(rec);
    expect(status).toMatchObject({ unsettledRuns: 1, unsettledCodex: 0, unsettledClaude: 0, settlementUnknown: false });
    // Session-start reuse still treats the open run as live work; only the update drain changed.
    expect(gatewayQuiescent(status!)).toBe(false);
    // A session-start supersede drain (ensure/dev: unscoped POST) is still refused while a run is open:
    // other sessions may be live beside it.
    expect(await queryGatewayIdentity(rec, true)).toBeUndefined();
    expect(await queryGatewayIdentity(rec)).toMatchObject({ draining: false });
    expect(await gatewayBarrier(root, "pair-old")).toEqual({ ok: true });
    expect(await queryGatewayIdentity(rec)).toBeUndefined();
    expect(readFileSync(target, "utf8")).toBe(body);
  });

  it("an owed publication still holds the drain", async () => {
    const rec = await gateway();
    const session = "d".repeat(32);
    writeStore(session, { schema: RUN_BOUNDARY_SCHEMA, runs: [
      { session_correlation_id: session, run_seq: 1, started_at: "2026-09-01T12:00:00.000Z", ended_at: "2026-09-01T12:05:00.000Z" }],
      claude_provisional_pending: { phase: "settled" } });
    expect(await gatewayBarrier(root, "pair-old")).toEqual({ ok: false, reason: "gateway-busy-or-unsettled" });
    expect(await queryGatewayIdentity(rec, true)).toBeUndefined();
    expect(await queryGatewayIdentity(rec)).toMatchObject({ draining: false, unsettledClaude: 1 });
  });

  it("a malformed pending that merely says phase open still blocks", async () => {
    const rec = await gateway();
    writeStore("e".repeat(32), { schema: RUN_BOUNDARY_SCHEMA, runs: [], claude_provisional_pending: { phase: "open" } });
    expect(await queryGatewayIdentity(rec)).toMatchObject({ unsettledRuns: 0, unsettledClaude: 1 });
    expect(await gatewayBarrier(root, "pair-old")).toEqual({ ok: false, reason: "gateway-busy-or-unsettled" });
  });
});
