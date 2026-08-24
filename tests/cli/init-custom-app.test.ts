import { describe, expect, it, vi } from "vitest";
import { handleCustomAppResult } from "../../src/cli/commands/init.js";

/**
 * init.ts handoff for the Advanced "Custom OpenAI-compatible app" setup.
 *
 * The interactive TUI cannot run an interactive child inside the Ink alt-screen, so it resolves with the
 * entered argv + a chosen action and `init.ts` acts on it AFTER the wizard exits. This unit test pins the
 * pure handoff (`handleCustomAppResult`) via injected fakes, no TTY, no real gateway, no child process:
 *  - `run`   REUSES the existing `runThroughGateway` with the parsed command (no new routing).
 *  - `print` emits the durable `compaction gateway run -- <command>` line and runs NOTHING.
 *  - the command is never persisted (there is no writer here to call) and no key is ever asked.
 */
describe("handleCustomAppResult - Advanced custom-app handoff", () => {
  it("action 'run' reuses the gateway runner with the parsed command (and does not print)", async () => {
    const runGateway = vi.fn(async () => {});
    const print = vi.fn();
    const handled = await handleCustomAppResult({ command: ["npm", "run", "dev"], action: "run" }, { runGateway, print });
    expect(handled).toBe(true);
    expect(runGateway).toHaveBeenCalledTimes(1);
    // The EXACT reuse: parsed argv, default options, the public gateway-run label.
    expect(runGateway).toHaveBeenCalledWith(["npm", "run", "dev"], {}, "compaction gateway run");
    expect(print).not.toHaveBeenCalled();
  });

  it("action 'print' prints the durable command line and does NOT run the gateway", async () => {
    const runGateway = vi.fn(async () => {});
    const print = vi.fn();
    const handled = await handleCustomAppResult({ command: ["node", "agent.js"], action: "print" }, { runGateway, print });
    expect(handled).toBe(true);
    expect(runGateway).not.toHaveBeenCalled();
    expect(print).toHaveBeenCalledTimes(1);
    expect(print.mock.calls[0][0]).toContain("compaction gateway run -- node agent.js");
  });

  it("an undefined customApp is a no-op: returns false, nothing runs or prints", async () => {
    const runGateway = vi.fn(async () => {});
    const print = vi.fn();
    const handled = await handleCustomAppResult(undefined, { runGateway, print });
    expect(handled).toBe(false);
    expect(runGateway).not.toHaveBeenCalled();
    expect(print).not.toHaveBeenCalled();
  });
});
