import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGatewayServer } from "../../src/core/gateway/server.js";
import { RECEIPT_LINE_ENV } from "../../src/core/gateway/receipt-line.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  delete process.env[RECEIPT_LINE_ENV];
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
}

/** A fake OpenAI upstream that reports usage (with a cached-input portion). */
function usageUpstream(): http.Server {
  return http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        model: "gpt-5",
        usage: {
          prompt_tokens: 100,
          completion_tokens: 412,
          prompt_tokens_details: { cached_tokens: 5 }
        }
      })
    );
  });
}

function post(port: number, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const rq = http.request(
      { hostname: "127.0.0.1", port, path, method: "POST", headers: { "content-type": "application/json" } },
      (rs) => {
        rs.on("data", () => {});
        rs.on("end", () => resolve());
      }
    );
    rq.on("error", reject);
    rq.end("{}");
  });
}

describe("gateway inline log emits the canonical per-turn receipt line", () => {
  it("a routed record-mode call logs exactly one canonical line (provider cache delta surfaced)", async () => {
    const upstream = usageUpstream();
    const upstreamPort = await listen(upstream);
    const cwd = mkdtempSync(join(tmpdir(), "gw-line-"));
    const logs: string[] = [];
    const gw = createGatewayServer({
      provider: "openai",
      upstream: `http://127.0.0.1:${upstreamPort}`,
      mode: "record",
      cwd,
      log: (line) => logs.push(line)
    });
    const gwPort = await listen(gw);
    cleanups.push(async () => {
      await new Promise<void>((r) => gw.close(() => r()));
      await new Promise<void>((r) => upstream.close(() => r()));
      rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    });

    await post(gwPort, "/v1/chat/completions");
    // The receipt append is best-effort/async after the response; give it a tick.
    await new Promise((r) => setTimeout(r, 50));

    const canonical = logs.filter((l) => l.startsWith("compaction · "));
    expect(canonical).toHaveLength(1);
    // Record mode is a plain input+output count. Provider prompt-cache is a provider
    // fact, NOT surfaced on this line; no standalone mode/source label; id is 8 hex chars.
    expect(canonical[0]).toMatch(/^compaction · input 100 · output 412 · id [0-9a-f]{8}$/);
    // A record-mode line NEVER carries a minus sign, a provider-cached clause, or a mode label.
    expect(canonical[0]).not.toContain("−");
    expect(canonical[0]).not.toContain("provider-cached");
    expect(canonical[0]).not.toContain("record");
  });

  it("the kill switch COMPACTION_RECEIPT_LINE=0 silences the line (receipt still recorded)", async () => {
    process.env[RECEIPT_LINE_ENV] = "0";
    const upstream = usageUpstream();
    const upstreamPort = await listen(upstream);
    const cwd = mkdtempSync(join(tmpdir(), "gw-line-off-"));
    const logs: string[] = [];
    let receiptSeen = false;
    const gw = createGatewayServer({
      provider: "openai",
      upstream: `http://127.0.0.1:${upstreamPort}`,
      mode: "record",
      cwd,
      log: (line) => logs.push(line),
      onReceipt: () => {
        receiptSeen = true;
      }
    });
    const gwPort = await listen(gw);
    cleanups.push(async () => {
      await new Promise<void>((r) => gw.close(() => r()));
      await new Promise<void>((r) => upstream.close(() => r()));
      rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    });

    await post(gwPort, "/v1/chat/completions");
    await new Promise((r) => setTimeout(r, 50));

    expect(logs.filter((l) => l.startsWith("compaction · "))).toHaveLength(0);
    expect(receiptSeen).toBe(true); // the receipt is still built/recorded; only the display line is silenced
  });
});
