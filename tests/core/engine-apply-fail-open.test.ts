/**
 * FAIL-OPEN via the real engine seam — when the private native engine is unavailable, refuses,
 * no-ops, crashes, or errors, the gateway forwards the ORIGINAL request bytes unchanged and records
 * an honest receipt. A Compaction failure NEVER blocks the workflow and NEVER emits an unrecoverable
 * mutation.
 *
 * These tests run the REAL gateway (`createGatewayServer`) against a local fake upstream, with a
 * stored auto-apply authorization and Full optimization mode active — the exact conditions that WOULD
 * apply — but point the engine at a path that cannot resolve/answer, proving the whole path degrades
 * fail-open. Byte-safety: the upstream receives the original bytes verbatim; the receipt is honest.
 */
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGatewayServer } from "../../src/core/gateway/server.js";
import { AUTO_APPLY_ELIGIBILITY_GATES, savePolicyPreference } from "../../src/core/policy-preferences.js";
import { DEDUPE_POLICY } from "../../src/core/gateway/request-shape.js";
import { ENGINE_PATH_ENV } from "../../src/core/gateway/engine-ipc/supervisor.js";

const BIG = "R".repeat(700);
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function harness() {
  const cwd = mkdtempSync(join(tmpdir(), "engine-fail-open-"));
  // The DEVICE store, deliberately NOT under `cwd`: the gateway reads the authorization from the
  // device environment alone, so a fixture that wrote it into the working directory would now be
  // asserting the very thing that must not work (repository content granting apply).
  const deviceDir = mkdtempSync(join(tmpdir(), "engine-fail-open-device-"));
  let received = "";
  const upstream = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      received = Buffer.concat(chunks).toString("utf8");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ usage: { input_tokens: 100, output_tokens: 20 } }));
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = (upstream.address() as { port: number }).port;

  await savePolicyPreference(
    {
      scope: { tool: "codex", policy_type: DEDUPE_POLICY },
      preference: "auto-when-gates-pass",
      gates_required: [...AUTO_APPLY_ELIGIBILITY_GATES]
    },
    deviceDir
  );

  const gateway = createGatewayServer({
    provider: "openai",
    upstream: `http://127.0.0.1:${upstreamPort}`,
    mode: "record",
    workflow: "codex",
    optimizationMode: "cache-plus-context",
    cwd,
    entitlementEnv: { COMPACTION_CONFIG_DIR: deviceDir }
  });
  await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  const gatewayPort = (gateway.address() as { port: number }).port;
  cleanups.push(async () => {
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  const post = (path: string, body: string) =>
    new Promise<void>((resolve, reject) => {
      const req = http.request(
        { hostname: "127.0.0.1", port: gatewayPort, path, method: "POST", headers: { "content-type": "application/json" } },
        (res) => {
          res.on("data", () => {});
          res.on("end", () => resolve());
        }
      );
      req.on("error", reject);
      req.end(body);
    });

  return { cwd, post, received: () => received };
}

describe("fail-open — engine unavailable → gateway forwards the original unchanged", () => {
  it("engine-absent (unresolvable path) → the upstream receives the ORIGINAL bytes verbatim", async () => {
    const prev = process.env[ENGINE_PATH_ENV];
    // Point the engine at a path that cannot resolve → every plan_and_apply degrades engine-absent.
    process.env[ENGINE_PATH_ENV] = join(tmpdir(), "definitely-not-an-engine-" + Date.now() + ".js");
    try {
      const h = await harness();
      const original = JSON.stringify({ input: `${BIG}\n\n${BIG}` }); // a request that WOULD dedupe
      await h.post("/v1/responses", original);
      // Fail-open: no mutation was applied; the upstream got the original request byte-for-byte.
      expect(h.received()).toBe(original);
    } finally {
      if (prev === undefined) delete process.env[ENGINE_PATH_ENV];
      else process.env[ENGINE_PATH_ENV] = prev;
    }
  });

  it("engine that always errors → gateway still forwards the original unchanged", async () => {
    // A tiny engine that answers every request with result:"error" (a refusal class). The seam maps
    // engine-result:error → forward-original.
    const prev = process.env[ENGINE_PATH_ENV];
    const dir = mkdtempSync(join(tmpdir(), "err-engine-"));
    const enginePath = join(dir, "err-engine.mjs");
    const script = `
      let pending = Buffer.alloc(0); let len = null;
      process.stdin.on("data", (chunk) => {
        pending = Buffer.concat([pending, chunk]);
        for (;;) {
          if (len === null) { if (pending.length < 4) break; len = pending.readUInt32BE(0); pending = pending.subarray(4); }
          if (pending.length < len) break;
          const req = JSON.parse(pending.subarray(0, len).toString("utf8")); pending = pending.subarray(len); len = null;
          const body = Buffer.from(JSON.stringify({ protocol_version: 1, request_id: req.request_id, result: "error", applied_components: [], recovery_required: false, failure_reason: "test-error" }), "utf8");
          const pre = Buffer.allocUnsafe(4); pre.writeUInt32BE(body.length, 0);
          process.stdout.write(Buffer.concat([pre, body]));
        }
      });
    `;
    const { writeFileSync } = await import("node:fs");
    writeFileSync(enginePath, script, "utf8");
    process.env[ENGINE_PATH_ENV] = enginePath;
    try {
      const h = await harness();
      const original = JSON.stringify({ input: `${BIG}\n\n${BIG}` });
      await h.post("/v1/responses", original);
      expect(h.received()).toBe(original);
    } finally {
      if (prev === undefined) delete process.env[ENGINE_PATH_ENV];
      else process.env[ENGINE_PATH_ENV] = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
