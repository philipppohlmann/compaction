import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const fixture = fileURLToPath(new URL("../fixtures/gateway-cancelled-response.mjs", import.meta.url));
const gatewayModule = fileURLToPath(new URL("../../dist/core/gateway/server.js", import.meta.url));

describe("Gateway downstream cancellation in a standalone process", () => {
  it.each(["ordinary-response", "ordinary-error", "support-response", "support-error"])(
    "survives %s after the client disconnects, then streams the next response unchanged",
    async (scenario) => {
      const directory = mkdtempSync(path.join(tmpdir(), "gateway-cancelled-"));
      try {
        const { stdout, stderr } = await run(process.execPath, [fixture, gatewayModule, scenario], {
          cwd: directory, timeout: 10_000,
          env: { PATH: process.env.PATH, COMPACTION_CONFIG_DIR: path.join(directory, "config") }
        });
        expect(stderr).toBe("");
        expect(JSON.parse(stdout)).toEqual({ scenario, lateWrites: 0, upstreamCalls: 2,
          receiptCount: scenario.startsWith("support-") ? 0 : 1, nextResponseBytes: 9, nextResponseStatus: 207, closed: true });
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  );
});
