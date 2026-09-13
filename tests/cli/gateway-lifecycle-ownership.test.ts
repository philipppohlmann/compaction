import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";

let nextPort = 41000;
vi.mock("../../src/core/gateway/server.js", () => ({
  startGatewayServer: vi.fn(async () => {
    const server = new EventEmitter();
    return {
    server,
    address: { host: "127.0.0.1", port: nextPort++ },
    close: vi.fn(async () => { server.emit("close"); })
  }; })
}));

import { runGatewayStart, type RunningGateway } from "../../src/cli/commands/gateway.js";
import { readGatewayPid, writeGatewayPid, type GatewayPidRecord } from "../../src/core/gateway/status.js";

describe("transient Gateway lifecycle ownership", () => {
  let cwd = "";
  const running: RunningGateway[] = [];

  afterEach(async () => {
    await Promise.all(running.splice(0).map((gateway) => gateway.close().catch(() => undefined)));
    if (cwd) rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    cwd = "";
  });

  it("concurrent transient runners neither replace nor remove the shared persistent lifecycle record", async () => {
    cwd = mkdtempSync(join(tmpdir(), "gw-lifecycle-owner-"));
    const persistent: GatewayPidRecord = {
      pid: 424242,
      host: "127.0.0.1",
      port: 8787,
      upstream: "https://api.openai.com/v1",
      provider: "openai",
      mode: "record",
      workflow: "codex",
      startedAt: "2026-07-16T00:00:00.000Z"
    };
    writeGatewayPid(persistent, cwd);

    const configs = ["codex", "claude-code"] as const;
    const gateways = await Promise.all(
      configs.map((workflow) =>
        runGatewayStart({
          provider: workflow === "codex" ? "openai" : "anthropic",
          upstream: workflow === "codex" ? "http://127.0.0.1:9/v1" : "http://127.0.0.1:9",
          mode: "record",
          workflow,
          host: "127.0.0.1",
          port: 0,
          cwd,
          installSignals: false,
          persistLifecycle: false,
          log: () => undefined
        })
      )
    );
    running.push(...gateways);

    expect(readGatewayPid(cwd)).toEqual(persistent);
    await running.shift()!.close();
    expect(readGatewayPid(cwd)).toEqual(persistent);
    await running.shift()!.close();
    expect(readGatewayPid(cwd)).toEqual(persistent);
  });
});
