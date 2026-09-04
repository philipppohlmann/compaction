import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { captureClaudeCodeFromHook } from "../../src/cli/commands/capture-claude-code.js";
import { computeStatusLine } from "../../src/cli/commands/statusline.js";
import { recordShapingOutcome } from "../../src/core/output-shaping-turn-state.js";
import { writeProductMode } from "../../src/core/onboarding-preferences.js";
import { createUsageMetadata } from "../../src/core/usage-metadata.js";
import { buildGatewayReceipt, type GatewayReceipt } from "../../src/core/gateway/receipt.js";
import type { OpenAiUsageBreakdown } from "../../src/core/gateway/openai-usage.js";

/**
 * THE STATUS LINE MUST NOT LOSE A FINISHED TURN'S EVIDENCE.
 *
 * Claude Code swallows hook stdout, so the line the Stop hook prints is invisible; the status line is the
 * only per-turn surface a user reads, and it renders AGAIN once the turn is final. Stop used to delete the
 * session's shaping record immediately after printing its own invisible line, so that last render found no
 * evidence and redrew the SAME receipt as a bare `input N · output M` — dropping the reduction and the
 * `basic shaping` label it had shown throughout the turn.
 *
 * Reproduced against the shipped 0.6.5 binary on a real record-mode receipt: `observed input 259,985 ·
 * output 2,853→1,512 (−47%, est. · default prior) · basic shaping · id b19dd99b` during the turn, and
 * `input 259,985 · output 1,512 · id b19dd99b` after Stop, from byte-identical status-line stdin. (The
 * repro's `−47%` came from the shipped default prior, which no longer renders a figure at all; the
 * lifecycle defect this file pins is independent of that. This hook-only receipt has no exact policy
 * applicability metadata, so the truthful result is the explicit N/A counterfactual.)
 *
 * These tests drive the two real commands in the real order, so they fail on the old lifecycle.
 */

const SESSION = "11111111-2222-4333-8444-555566667777";
const OTHER_SESSION = "99999999-8888-4777-8666-555544443333";
const NOW = () => "2026-08-26T17:54:53.240Z";

/** A record-mode receipt: forwarded byte-for-byte, so it carries NO shaping evidence of its own. */
function recordModeReceipt(): GatewayReceipt {
  const usage: OpenAiUsageBreakdown = {
    present: true,
    promptInputTokens: 259_985,
    cachedInputTokens: 259_983,
    billedFreshInputTokens: 2,
    outputTokens: 1_512,
    model: "claude-opus-5"
  };
  return buildGatewayReceipt({
    provider: "anthropic",
    endpoint: "/v1/messages",
    mode: "record",
    upstreamStatus: 200,
    usage,
    id: () => "b19dd99b-0c78-4ceb-8ec5-8551ad33eb08",
    now: NOW
  });
}

/** A `basic`-mode config dir: the product mode the regression was reported on. */
async function basicModeEnv(): Promise<NodeJS.ProcessEnv> {
  const configDir = await mkdtemp(path.join(tmpdir(), "per-turn-stop-"));
  const env = { COMPACTION_CONFIG_DIR: configDir } as NodeJS.ProcessEnv;
  writeProductMode("basic", env);
  return env;
}

/** Exactly what Claude Code puts on the status-line stdin. */
const statusStdin = (sessionId: string, cwd: string) => JSON.stringify({ session_id: sessionId, cwd });

const stopPayload = (sessionId: string) =>
  JSON.stringify({ session_id: sessionId, transcript_path: "/x/y.jsonl", hook_event_name: "Stop" });

const usage = createUsageMetadata({
  inputTokens: 259_985,
  outputTokens: 1_512,
  totalTokens: 261_497,
  providerReportedTokens: true,
  estimatedTokens: false,
  model: "claude-opus-5",
  provider: "anthropic"
});

/** Run the Stop hook the way Claude Code runs it, discarding the line it prints into the void. */
async function runStopHook(sessionId: string, cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  await captureClaudeCodeFromHook(
    {},
    {
      cwd,
      now: () => "2026-08-26T17:55:00.000Z",
      hostedConfigured: () => false,
      readStdin: async () => stopPayload(sessionId),
      normalize: async () => ({ usage, messageCount: 5, fingerprint: `fp-${sessionId}` }),
      readLatestGatewayReceipt: async () => recordModeReceipt(),
      printReceiptLine: () => {},
      env
    }
  );
}

describe("the per-turn status line across a top-level turn's Stop", () => {
  it("keeps the reduction and the label on the render AFTER Stop", async () => {
    const env = await basicModeEnv();
    const cwd = await mkdtemp(path.join(tmpdir(), "per-turn-cwd-"));
    const deps = { env, cwd, readReceipt: async () => recordModeReceipt() };
    await recordShapingOutcome({ tool: "claude-code", sessionId: SESSION }, "shape", env);

    const during = await computeStatusLine(statusStdin(SESSION, cwd), deps);
    expect(during, "the running turn shows what the hook decided").toContain("output N/A→1,512 (N/A%, est.)");
    expect(during).toContain("observed input 259,985");
    expect(during).toContain("basic shaping");

    await runStopHook(SESSION, cwd, env);

    // Byte-identical stdin, byte-identical receipt: nothing about the turn changed, so nothing about the
    // line may change either. This is the exact assertion the old lifecycle failed.
    const after = await computeStatusLine(statusStdin(SESSION, cwd), deps);
    expect(after, "the finished turn keeps the line it had").toBe(during);
    expect(after).not.toMatch(/^compaction · input 259,985 · output 1,512 · id /);
  });

  it("a subagent finishing cannot end the parent turn's evidence", async () => {
    const env = await basicModeEnv();
    const cwd = await mkdtemp(path.join(tmpdir(), "per-turn-sub-"));
    const deps = { env, cwd, readReceipt: async () => recordModeReceipt() };
    await recordShapingOutcome({ tool: "claude-code", sessionId: SESSION }, "shape", env);
    const during = await computeStatusLine(statusStdin(SESSION, cwd), deps);

    // Claude Code names a subagent's completion `SubagentStop`. Compaction installs no such hook, and the
    // Stop handler's foreign-payload guard rejects the event name outright — so a long agentic turn full
    // of subagents cannot finalize or strip the parent turn it runs inside.
    await captureClaudeCodeFromHook(
      {},
      {
        cwd,
        now: () => "2026-08-26T17:55:00.000Z",
        hostedConfigured: () => false,
        readStdin: async () => JSON.stringify({ session_id: SESSION, transcript_path: "/x/y.jsonl", hook_event_name: "SubagentStop" }),
        normalize: async () => ({ usage, messageCount: 5, fingerprint: "fp-sub" }),
        readLatestGatewayReceipt: async () => recordModeReceipt(),
        printReceiptLine: () => {},
        env
      }
    );

    expect(await computeStatusLine(statusStdin(SESSION, cwd), deps)).toBe(during);
  });

  it("one session's Stop leaves a concurrent session's turn alone", async () => {
    const env = await basicModeEnv();
    const cwd = await mkdtemp(path.join(tmpdir(), "per-turn-conc-"));
    const deps = { env, cwd, readReceipt: async () => recordModeReceipt() };
    await recordShapingOutcome({ tool: "claude-code", sessionId: SESSION }, "shape", env);
    await recordShapingOutcome({ tool: "claude-code", sessionId: OTHER_SESSION }, "shape", env);

    await runStopHook(SESSION, cwd, env);

    expect(await computeStatusLine(statusStdin(OTHER_SESSION, cwd), deps)).toContain("basic shaping");
  });

  it("a turn the gate HELD still draws no arrow, before or after Stop", async () => {
    const env = await basicModeEnv();
    const cwd = await mkdtemp(path.join(tmpdir(), "per-turn-held-"));
    const deps = { env, cwd, readReceipt: async () => recordModeReceipt() };
    await recordShapingOutcome({ tool: "claude-code", sessionId: SESSION }, "hold-planning", env);

    const during = await computeStatusLine(statusStdin(SESSION, cwd), deps);
    expect(during, "nothing was shaped, so nothing may be claimed").not.toMatch(/→/);
    expect(during).not.toContain("basic shaping");

    await runStopHook(SESSION, cwd, env);
    expect(await computeStatusLine(statusStdin(SESSION, cwd), deps)).toBe(during);
  });

  it("no session id on the stdin claims nothing, before or after Stop", async () => {
    const env = await basicModeEnv();
    const cwd = await mkdtemp(path.join(tmpdir(), "per-turn-anon-"));
    const deps = { env, cwd, readReceipt: async () => recordModeReceipt() };
    await recordShapingOutcome({ tool: "claude-code", sessionId: SESSION }, "shape", env);

    const anon = JSON.stringify({ cwd });
    const during = await computeStatusLine(anon, deps);
    expect(during, "an unnameable scope fails closed").not.toMatch(/→/);

    await runStopHook(SESSION, cwd, env);
    expect(await computeStatusLine(anon, deps)).toBe(during);
  });
});
