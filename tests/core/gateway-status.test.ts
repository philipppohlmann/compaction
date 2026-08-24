import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeGatewayPid,
  readGatewayPid,
  removeGatewayPid,
  isProcessAlive,
  getGatewayStatus,
  GATEWAY_PID_FILE
} from "../../src/core/gateway/status.js";

/**
 * Gateway lifecycle status + pidfile. Content-free: the pidfile holds only pid + listen
 * metadata; the receipts read are already content-free. `running` requires a live pid AND a listening port.
 */

let cwd: string;
afterEach(() => {
  if (cwd) rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});
function tmp(): string {
  cwd = mkdtempSync(join(tmpdir(), "gw-status-"));
  return cwd;
}
function writeReceipts(dir: string, lines: object[]): void {
  const gw = join(dir, ".compaction", "gateway");
  mkdirSync(gw, { recursive: true });
  writeFileSync(join(gw, "receipts.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
}

describe("gateway pidfile + isProcessAlive", () => {
  it("write → read → remove round-trips a content-free record", () => {
    const dir = tmp();
    writeGatewayPid({ pid: 4242, host: "127.0.0.1", port: 8787, upstream: "https://api.openai.com/v1", provider: "openai", mode: "record", startedAt: "t" }, dir);
    expect(existsSync(join(dir, ".compaction", "gateway", GATEWAY_PID_FILE))).toBe(true);
    expect(readGatewayPid(dir)?.pid).toBe(4242);
    removeGatewayPid(dir);
    expect(readGatewayPid(dir)).toBeNull();
  });

  it("persists an optional narrow workflow identity while legacy records remain readable", () => {
    const dir = tmp();
    const base = { pid: 4242, host: "127.0.0.1", port: 8787, upstream: "https://api.openai.com/v1", provider: "openai", mode: "record", startedAt: "t" };
    writeGatewayPid({ ...base, workflow: "codex" }, dir);
    expect(readGatewayPid(dir)?.workflow).toBe("codex");
    writeGatewayPid(base, dir);
    expect(readGatewayPid(dir)?.workflow).toBeUndefined();
  });

  it("drops arbitrary or control-bearing persisted workflow values at the read boundary", () => {
    const dir = tmp();
    const gatewayDir = join(dir, ".compaction", "gateway");
    mkdirSync(gatewayDir, { recursive: true });
    writeFileSync(
      join(gatewayDir, GATEWAY_PID_FILE),
      JSON.stringify({
        pid: 4242,
        host: "127.0.0.1",
        port: 8787,
        upstream: "https://api.openai.com/v1",
        provider: "openai",
        mode: "record",
        workflow: "codex\nUNTRUSTED_CONTROL",
        startedAt: "t"
      }),
      "utf8"
    );
    const record = readGatewayPid(dir);
    expect(record?.pid).toBe(4242);
    expect(record?.workflow).toBeUndefined();
    expect(JSON.stringify(record)).not.toContain("UNTRUSTED_CONTROL");
  });

  it("isProcessAlive: true for this process, false for a very unlikely pid", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(2_147_483_646)).toBe(false);
  });
});

describe("getGatewayStatus", () => {
  it("no pidfile → not running; receipts counted; summary present", async () => {
    const dir = tmp();
    writeReceipts(dir, [
      { tokens: { prompt_input: 100, cached_input: 40, billed_fresh_input: 60, output: 20 }, token_source: "provider-reported", model_visible_bytes_changed: false },
      { tokens: { prompt_input: 100, output: 10 }, token_source: "provider-reported", model_visible_bytes_changed: false }
    ]);
    const s = await getGatewayStatus(dir);
    expect(s.running).toBe(false);
    expect(s.receiptsCount).toBe(2);
    expect(s.summary.bestReduction.available).toBe(true); // 40/100 → 40%
    expect(s.summary.bestReduction.pct).toBe(40);
  });

  it("stale pidfile (dead pid) → not running, pid surfaced", async () => {
    const dir = tmp();
    writeGatewayPid({ pid: 2_147_483_646, host: "127.0.0.1", port: 65000, upstream: "u", provider: "openai", mode: "record", startedAt: "t" }, dir);
    const s = await getGatewayStatus(dir);
    expect(s.running).toBe(false);
    expect(s.pid).toBe(2_147_483_646);
  });

  it("live pid + a listening port → running", async () => {
    const dir = tmp();
    const server = http.createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    try {
      writeGatewayPid({ pid: process.pid, host: "127.0.0.1", port, upstream: "https://example.test/v1", provider: "openai", mode: "record", workflow: "codex", startedAt: "t" }, dir);
      const s = await getGatewayStatus(dir);
      expect(s.running).toBe(true);
      expect(s.base).toBe(`http://127.0.0.1:${port}`);
      expect(s.workflow).toBe("codex");
      expect(s).not.toHaveProperty("upstream");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
