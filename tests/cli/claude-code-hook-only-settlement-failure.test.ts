import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Every calibration load fails, as with an unreadable calibration store.
vi.mock("../../src/core/output-shaping-savings.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/core/output-shaping-savings.js")>()),
  loadOutputCalibrationResolver: async () => { throw new Error("calibration store unreadable"); }
}));

const { captureClaudeCodeFromHook, captureClaudeCodeShapeFromPromptHook } = await import("../../src/cli/commands/capture-claude-code.js");
const { readActivityEvents } = await import("../../src/core/activity-store.js");
const { createUsageMetadata } = await import("../../src/core/usage-metadata.js");
const { provisionValidLease } = await import("../helpers/lease-fixture.js");

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe("Claude hook-only settlement failure", () => {
  it("a failing transcript settlement keeps the legacy hook record and event", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "claude-settle-fail-"));
    const configDir = await mkdtemp(join(tmpdir(), "claude-settle-fail-config-"));
    dirs.push(cwd, configDir);
    const transcript = join(cwd, "session.jsonl");
    await writeFile(transcript, "", "utf8");
    const env = provisionValidLease(configDir, { COMPACTION_SHAPING_HOOKS: "0" }, { productMode: "full" });
    await captureClaudeCodeShapeFromPromptHook({
      env, now: () => "2026-09-04T10:00:00.000Z", write: () => undefined,
      readStdin: async () => JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "s", transcript_path: transcript,
        prompt_id: "p1", prompt: "x" })
    });
    await captureClaudeCodeFromHook({}, {
      cwd, env, now: () => "2026-09-04T10:01:00.000Z",
      readStdin: async () => JSON.stringify({ hook_event_name: "Stop", session_id: "s", transcript_path: transcript }),
      normalize: async () => ({ usage: createUsageMetadata({ inputTokens: 1_900, outputTokens: 180, totalTokens: 2_080,
        providerReportedTokens: true, estimatedTokens: false, provider: "anthropic", model: "claude-opus-5" }),
        messageCount: 2, fingerprint: "f1" }),
      readLatestGatewayReceipt: async () => undefined,
      readGatewayReceipts: async () => ({ receipts: [], truncated: false }),
      printReceiptLine: () => undefined,
      hostedConfigured: () => false
    });
    const events = (await readActivityEvents(join(cwd, ".compaction", "activity"))).events;
    expect(events).toHaveLength(1);
    expect(events[0].activity_kind).toBeUndefined();
  });
});
