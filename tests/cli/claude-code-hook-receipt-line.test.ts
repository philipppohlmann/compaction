import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { recordShapingOutcome } from "../../src/core/output-shaping-turn-state.js";
import { describe, expect, it } from "vitest";
import { captureClaudeCodeFromHook } from "../../src/cli/commands/capture-claude-code.js";
import { createUsageMetadata } from "../../src/core/usage-metadata.js";
import { buildGatewayReceipt, type GatewayReceipt } from "../../src/core/gateway/receipt.js";
import { RECEIPT_LINE_ENV } from "../../src/core/gateway/receipt-line.js";
import { updateCalibrationFromAbSummary } from "../../src/core/output-shaping-calibration-store.js";
import { stopShaping } from "../../src/core/subscription-shaping-state.js";
import {
  addOutputShapingAbRun,
  initOutputShapingAbExperiment,
  summarizeOutputShapingAb,
  type OutputShapingAbRun
} from "../../src/core/output-shaping-ab.js";
import type { OpenAiUsageBreakdown } from "../../src/core/gateway/openai-usage.js";

/** Fold a real provider-reported output-shaping A/B into the LEARNING calibration store in a temp config dir. */
async function writeCalibration(configDir: string, controlOut: number, treatmentOut: number): Promise<void> {
  const run = (arm: "control" | "treatment", outputTokens: number): OutputShapingAbRun => ({
    arm,
    outputTokens,
    inputTokens: 1000,
    providerReported: true,
    tokenSource: "provider-reported",
    ...(arm === "treatment"
      ? { policyFamily: "output_shaping" as const, policyNames: ["concise_response"], evalMarkersPreserved: true }
      : {})
  });
  let exp = initOutputShapingAbExperiment({ experimentId: "cal", taskShape: "code" });
  for (const r of [run("control", controlOut), run("treatment", treatmentOut)]) exp = addOutputShapingAbRun(exp, r);
  await updateCalibrationFromAbSummary(summarizeOutputShapingAb(exp), { COMPACTION_CONFIG_DIR: configDir } as NodeJS.ProcessEnv);
}

/**
 * The Claude Code Stop hook prints the SINGLE canonical per-turn receipt line: input+output when a
 * gateway receipt exists this session, else the output-only hook line; the kill switch silences both.
 */
async function tempCwd(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "cc-hook-line-"));
}

const NOW = () => "2026-07-29T00:00:00.000Z";
const noHosted = () => false;

const providerUsage = createUsageMetadata({
  inputTokens: 1000,
  outputTokens: 412,
  totalTokens: 1412,
  providerReportedTokens: true,
  estimatedTokens: false,
  model: "claude-x",
  provider: "anthropic"
});

const stopPayload = (sessionId: string) =>
  JSON.stringify({ session_id: sessionId, transcript_path: "/x/y.jsonl", hook_event_name: "Stop" });

function gatewayReceiptWithCache(): GatewayReceipt {
  const usage: OpenAiUsageBreakdown = {
    present: true,
    promptInputTokens: 100,
    cachedInputTokens: 5,
    billedFreshInputTokens: 95,
    outputTokens: 412,
    model: "gpt-5"
  };
  return buildGatewayReceipt({
    provider: "openai",
    endpoint: "/v1/chat/completions",
    mode: "record",
    upstreamStatus: 200,
    usage,
    id: () => "8f4c2f6e-1111-1111-1111-111111111111",
    now: NOW
  });
}

describe("Claude Code Stop hook - per-turn receipt line", () => {
  it("with a gateway receipt this session → prints the input+output canonical line", async () => {
    const cwd = await tempCwd();
    const lines: string[] = [];
    await captureClaudeCodeFromHook(
      {},
      {
        cwd,
        now: NOW,
        hostedConfigured: noHosted,
        readStdin: async () => stopPayload("s-gw"),
        normalize: async () => ({ usage: providerUsage, messageCount: 5, fingerprint: "fp-gw" }),
        readLatestGatewayReceipt: async () => gatewayReceiptWithCache(),
        printReceiptLine: (l) => lines.push(l),
        // An EMPTY env is not an isolated one: `compactionConfigDir({})` falls through to
        // `homedir()/.compaction`, so this case used to resolve the tier, the shaped-turn record and
        // the calibration off the developer's REAL install — which is what made it read
        // `output 777→412 (−47%, est. · default prior) · basic shaping` on a dogfooding machine and
        // the asserted line everywhere else. The assertion below describes a device with nothing on
        // disk, so give it exactly that.
        env: { COMPACTION_CONFIG_DIR: await mkdtemp(path.join(tmpdir(), "cc-hook-gw-")) }
      }
    );
    const canonical = lines.filter((l) => l.startsWith("compaction · "));
    expect(canonical).toHaveLength(1);
    // Open-core grammar: the gateway record line reads `observed input N` (Open never compacts input).
    // NO tier label — the receipt records no mutation and no shaped turn is on disk, and the label used
    // to be read off the stored product mode rather than off the turn. Provider prompt-cache is a
    // provider fact, NOT surfaced on this line; NO minus sign anywhere.
    expect(canonical[0]).toBe("compaction · observed input 100 · output 412 · id 8f4c2f6e");
    expect(canonical[0]).not.toContain("provider-cached");
    expect(canonical[0]).not.toContain("−");
    expect(canonical[0]).not.toContain("→");
  });

  it("without a gateway receipt, shaping OFF → the plain OUTPUT-ONLY hook line (no input clause, no %, no saved clause)", async () => {
    const cwd = await tempCwd();
    const lines: string[] = [];
    await captureClaudeCodeFromHook(
      {},
      {
        cwd,
        now: NOW,
        hostedConfigured: noHosted,
        readStdin: async () => stopPayload("s-hook"),
        normalize: async () => ({ usage: providerUsage, messageCount: 5, fingerprint: "fp-hook" }),
        readLatestGatewayReceipt: async () => undefined,
        printReceiptLine: (l) => lines.push(l),
        // Shaping kill-switch thrown → the hook does NOT opt into the estimated-saved clause; plain line.
        env: { COMPACTION_SHAPING_HOOKS: "0" }
      }
    );
    const canonical = lines.filter((l) => l.startsWith("compaction · "));
    expect(canonical).toHaveLength(1);
    // Open-core grammar: the output-only line is a plain output count. Shaping is OFF (kill-switch), so the
    // honest per-turn label is `apply off` (no shaping happened), NO out-saved clause, no false marker.
    expect(canonical[0]).toBe("compaction · output 412 · apply off");
    expect(canonical[0]).not.toContain("basic shaping");
    expect(canonical[0]).not.toContain("input");
    expect(canonical[0]).not.toContain("%");
    expect(canonical[0]).not.toContain("saved");
  });

  it("kill switch COMPACTION_RECEIPT_LINE=0 → no per-turn line on either path", async () => {
    const cwd = await tempCwd();
    const lines: string[] = [];
    await captureClaudeCodeFromHook(
      {},
      {
        cwd,
        now: NOW,
        hostedConfigured: noHosted,
        readStdin: async () => stopPayload("s-off"),
        normalize: async () => ({ usage: providerUsage, messageCount: 5, fingerprint: "fp-off" }),
        readLatestGatewayReceipt: async () => gatewayReceiptWithCache(),
        printReceiptLine: (l) => lines.push(l),
        env: { [RECEIPT_LINE_ENV]: "0" }
      }
    );
    expect(lines.filter((l) => l.startsWith("compaction · "))).toHaveLength(0);
  });

  it("fail-open: a throwing receipt reader never breaks the hook and prints no line", async () => {
    const cwd = await tempCwd();
    const lines: string[] = [];
    await expect(
      captureClaudeCodeFromHook(
        {},
        {
          cwd,
          now: NOW,
          hostedConfigured: noHosted,
          readStdin: async () => stopPayload("s-throw"),
          normalize: async () => ({ usage: providerUsage, messageCount: 5, fingerprint: "fp-throw" }),
          readLatestGatewayReceipt: async () => {
            throw new Error("disk gone");
          },
          printReceiptLine: (l) => lines.push(l),
          env: {}
        }
      )
    ).resolves.toBeUndefined();
    expect(lines.filter((l) => l.startsWith("compaction · "))).toHaveLength(0);
  });

  it("shaping ACTIVE + a real calibration artifact → output before→after with a labeled percent", async () => {
    const cwd = await tempCwd();
    const configDir = await mkdtemp(path.join(tmpdir(), "cc-hook-cal-"));
    // control 1000 / treatment 600 → r=0.4; this turn's output is 412 → saved = round(412*0.4/0.6)=275.
    await writeCalibration(configDir, 1000, 600);
    // The arrow now requires PER-TURN evidence that this turn was shaped, not just an active hook.
    await recordShapingOutcome("shape", { COMPACTION_CONFIG_DIR: configDir } as NodeJS.ProcessEnv);
    const lines: string[] = [];
    await captureClaudeCodeFromHook(
      {},
      {
        cwd,
        now: NOW,
        hostedConfigured: noHosted,
        readStdin: async () => stopPayload("s-shaped"),
        normalize: async () => ({ usage: providerUsage, messageCount: 5, fingerprint: "fp-shaped" }),
        readLatestGatewayReceipt: async () => undefined,
        printReceiptLine: (l) => lines.push(l),
        env: { COMPACTION_CONFIG_DIR: configDir } // shaping active (no kill switch, no stop)
      }
    );
    const canonical = lines.filter((l) => l.startsWith("compaction · "));
    expect(canonical).toHaveLength(1);
    // Shaping active this turn ⇒ the honest per-turn label is `basic shaping`, after the est-saved clause.
    // 412 real output + 275 estimated saved = a 687 derived before, on the OUTPUT clause.
    // 412 real output + 275 estimated saved = a 687 derived before; 275/687 = 40%.
    expect(canonical[0]).toBe("compaction · output 687→412 (−40%, est.) · basic shaping");
    expect(canonical[0], "an output percent must always carry `est`").not.toMatch(/−\d+%(?!, est)/);
  });

  /**
   * THE BUG THIS GATE EXISTS FOR. A planning turn the task gate HELD was still
   * shown an estimated output saving, because the line was gated on `isShapingHooksActivated` — which
   * reports the kill switch, not what happened this turn. `hold-planning` is the COMMON case: it fires
   * on every planning/reasoning turn the gate protects.
   */
  it("a turn the task gate HELD shows no arrow, even with a calibration artifact present", async () => {
    const cwd = await tempCwd();
    const configDir = await mkdtemp(path.join(tmpdir(), "cc-hook-held-"));
    await writeCalibration(configDir, 1000, 600);
    await recordShapingOutcome("hold-planning", { COMPACTION_CONFIG_DIR: configDir } as NodeJS.ProcessEnv);
    const lines: string[] = [];
    await captureClaudeCodeFromHook(
      {},
      {
        cwd,
        now: NOW,
        hostedConfigured: noHosted,
        readStdin: async () => stopPayload("s-held"),
        normalize: async () => ({ usage: providerUsage, messageCount: 5, fingerprint: "fp-held" }),
        readLatestGatewayReceipt: async () => undefined,
        printReceiptLine: (l) => lines.push(l),
        env: { COMPACTION_CONFIG_DIR: configDir }
      }
    );
    const canonical = lines.filter((l) => l.startsWith("compaction · "));
    expect(canonical[0], "a held turn must not claim a saving").toBe("compaction · output 412 · basic shaping");
    expect(canonical[0]).not.toContain("→");
  });

  it("no per-turn record at all → no arrow (absence is not evidence of shaping)", async () => {
    const cwd = await tempCwd();
    const configDir = await mkdtemp(path.join(tmpdir(), "cc-hook-norec-"));
    await writeCalibration(configDir, 1000, 600);
    const lines: string[] = [];
    await captureClaudeCodeFromHook(
      {},
      {
        cwd,
        now: NOW,
        hostedConfigured: noHosted,
        readStdin: async () => stopPayload("s-norec"),
        normalize: async () => ({ usage: providerUsage, messageCount: 5, fingerprint: "fp-norec" }),
        readLatestGatewayReceipt: async () => undefined,
        printReceiptLine: (l) => lines.push(l),
        env: { COMPACTION_CONFIG_DIR: configDir }
      }
    );
    const canonical = lines.filter((l) => l.startsWith("compaction · "));
    expect(canonical[0]).toBe("compaction · output 412 · basic shaping");
  });

  it("shaping ACTIVE + NO calibration artifact → a plain count, never a fabricated before", async () => {
    const cwd = await tempCwd();
    const configDir = await mkdtemp(path.join(tmpdir(), "cc-hook-nocal-"));
    const lines: string[] = [];
    await captureClaudeCodeFromHook(
      {},
      {
        cwd,
        now: NOW,
        hostedConfigured: noHosted,
        readStdin: async () => stopPayload("s-uncal"),
        normalize: async () => ({ usage: providerUsage, messageCount: 5, fingerprint: "fp-uncal" }),
        readLatestGatewayReceipt: async () => undefined,
        printReceiptLine: (l) => lines.push(l),
        env: { COMPACTION_CONFIG_DIR: configDir }
      }
    );
    const canonical = lines.filter((l) => l.startsWith("compaction · "));
    expect(canonical).toHaveLength(1);
    expect(canonical[0]).toBe("compaction · output 412 · basic shaping");
    expect(canonical[0]).not.toMatch(/~\d/); // no bare number when uncalibrated
  });

  it("shaping STOPPED (compaction stop) → no est-saved clause even with a calibration artifact present", async () => {
    const cwd = await tempCwd();
    const configDir = await mkdtemp(path.join(tmpdir(), "cc-hook-stopped-"));
    await writeCalibration(configDir, 1000, 600);
    // Persist the stopped run-state the way `compaction stop` does (real writer, correct version).
    stopShaping({ COMPACTION_CONFIG_DIR: configDir } as NodeJS.ProcessEnv);
    const lines: string[] = [];
    await captureClaudeCodeFromHook(
      {},
      {
        cwd,
        now: NOW,
        hostedConfigured: noHosted,
        readStdin: async () => stopPayload("s-stopped"),
        normalize: async () => ({ usage: providerUsage, messageCount: 5, fingerprint: "fp-stopped" }),
        readLatestGatewayReceipt: async () => undefined,
        printReceiptLine: (l) => lines.push(l),
        env: { COMPACTION_CONFIG_DIR: configDir }
      }
    );
    const canonical = lines.filter((l) => l.startsWith("compaction · "));
    expect(canonical).toHaveLength(1);
    // Shaping stopped ⇒ no shaping happened this turn ⇒ honest label is `apply off`, no est-saved clause.
    expect(canonical[0]).toBe("compaction · output 412 · apply off");
    expect(canonical[0]).not.toContain("saved");
    expect(canonical[0]).not.toContain("basic shaping");
  });

  it("kill switch COMPACTION_RECEIPT_LINE=0 → no line at all, even on the shaped path", async () => {
    const cwd = await tempCwd();
    const configDir = await mkdtemp(path.join(tmpdir(), "cc-hook-killed-"));
    await writeCalibration(configDir, 1000, 600);
    const lines: string[] = [];
    await captureClaudeCodeFromHook(
      {},
      {
        cwd,
        now: NOW,
        hostedConfigured: noHosted,
        readStdin: async () => stopPayload("s-killed"),
        normalize: async () => ({ usage: providerUsage, messageCount: 5, fingerprint: "fp-killed" }),
        readLatestGatewayReceipt: async () => undefined,
        printReceiptLine: (l) => lines.push(l),
        env: { COMPACTION_CONFIG_DIR: configDir, [RECEIPT_LINE_ENV]: "0" }
      }
    );
    expect(lines.filter((l) => l.startsWith("compaction · "))).toHaveLength(0);
  });
});

/**
 * FOREIGN-TOOL GUARD on the Claude Code Stop hook.
 *
 * Compaction installs that hook into `.claude/settings.json`, and Cursor's config discovery reads the
 * SAME file — mapping its own `stop` event onto Claude Code's `Stop`. So in any project where a user
 * connected Claude Code and also uses Cursor, Cursor fires this command with its own payload.
 *
 * The handler attributes everything it records to `surface: "claude_code"` with
 * `source: provider-reported`, unconditionally. Both are wrong for Cursor, and the second is
 * forbidden outright — `cursor` is in `NEVER_PROVIDER_REPORTED_SURFACES` because Compaction never sees
 * a provider response for it. Reproduced against the built CLI before the guard existed: a
 * Cursor-shaped payload produced `surface=claude_code`, `source=provider-reported`, and a per-turn line.
 */
import { isForeignStopPayload } from "../../src/cli/commands/capture-claude-code.js";

describe("Claude Code Stop hook — foreign-tool guard", () => {
  it("rejects a Cursor stop payload (it stamps cursor_version; Claude Code does not)", () => {
    expect(
      isForeignStopPayload({
        session_id: "s1",
        hook_event_name: "stop",
        cursor_version: "1.7.0",
        transcript_path: "/x/y.jsonl",
        input_tokens: 1200,
        output_tokens: 340
      })
    ).toBe(true);
  });

  it("rejects on the event name alone — Cursor's is lowercase `stop`, Claude Code's is `Stop`", () => {
    expect(isForeignStopPayload({ hook_event_name: "stop", transcript_path: "/x/y.jsonl" })).toBe(true);
    expect(isForeignStopPayload({ hook_event_name: "SubagentStop" })).toBe(true);
  });

  it("accepts a genuine Claude Code payload", () => {
    expect(isForeignStopPayload({ session_id: "s1", hook_event_name: "Stop", transcript_path: "/x/y.jsonl" })).toBe(false);
  });

  it("is POSITIVE-evidence only: an absent hook_event_name is not foreign", () => {
    // Older Claude Code payloads omit the field. The guard must never start rejecting real traffic
    // because a field disappeared — it is not a whitelist of Claude Code's shape.
    expect(isForeignStopPayload({ session_id: "s1", transcript_path: "/x/y.jsonl" })).toBe(false);
    expect(isForeignStopPayload({})).toBe(false);
    expect(isForeignStopPayload(null)).toBe(false);
    expect(isForeignStopPayload("not an object")).toBe(false);
  });
});
