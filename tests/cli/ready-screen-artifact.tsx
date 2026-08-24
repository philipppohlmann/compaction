/**
 * ARTIFACT SCRIPT (not a test, not shipped): renders the REAL Ready screen of the onboarding TUI for
 * the states this change is about, and prints each frame verbatim so the per-turn block can be read
 * as a user would see it. Run with:  npx tsx tests/cli/ready-screen-artifact.tsx
 */
import React from "react";
import { render } from "ink-testing-library";
import { App, type OnboardingAppProps } from "../../src/cli/onboarding/OnboardingTui.js";
import { READY_METRIC_NO_DATA_LINE } from "../../src/cli/onboarding/ready-metrics.js";
import type { ConnectDetection, EnableResult, ReadyToolKey } from "../../src/cli/onboarding/model.js";

const settle = (ms = 150): Promise<void> => new Promise((r) => setTimeout(r, ms));

const detection: ConnectDetection = { claude: { detected: true, sessionCount: 3 }, codex: "found", cursor: "found" };

async function readyFrame(connected: ReadyToolKey[], shapingHooksInstalled: ReadyToolKey[], keys: string[]): Promise<string> {
  const props: OnboardingAppProps = {
    version: "9.9.9",
    detection,
    readyMetric: { state: "no-data", line: READY_METRIC_NO_DATA_LINE, recordedRuns: 0 },
    readyStatusFor: async () => ({
      healthy: true,
      headline: `Compaction is active for ${connected.join(", ")}`,
      launcher: "active · fail-open",
      gateway: "not running",
      auth: "subscription / plan auth (output shaping)"
    }),
    onEnable: async (): Promise<EnableResult> => ({ connected, failed: [], shapingHooksInstalled }),
    onPersistMode: async () => {},
    onPersistPlan: async () => "basic",
    onCommunityAuth: async () => ({ ok: true as const, alreadyLoggedIn: false, effectiveMode: "basic" as const }),
    signedIn: false,
    onDone: () => {}
  };
  const app = render(React.createElement(App, props));
  await settle();
  for (const key of keys) {
    app.stdin.write(key);
    await settle();
  }
  const frame = app.lastFrame() ?? "";
  app.unmount();
  return frame;
}

const CASES: { label: string; connected: ReadyToolKey[]; hooks: ReadyToolKey[]; keys: string[] }[] = [
  // Claude Code is the default target selection; "2"/"3" move to Codex/Cursor. Then Enter through
  // mode/plan/review into Ready.
  { label: "CLAUDE CODE ONLY - the one workflow with an unhedged per-turn line", connected: ["claude-code"], hooks: ["claude-code"], keys: ["\r", "\r", "\r", "\r"] },
  { label: "CODEX ONLY, hooks CONFIRMED - installed, but rendering is unproven", connected: ["codex"], hooks: ["codex"], keys: ["2", "\r", "\r", "\r", "\r"] },
  { label: "CODEX ONLY, hooks SUPPRESSED (shaping switched off / install unverified)", connected: ["codex"], hooks: [], keys: ["2", "\r", "\r", "\r", "\r"] },
  { label: "CURSOR ONLY (session hook confirmed) - Cursor can never print an inline line", connected: ["cursor"], hooks: ["cursor"], keys: ["3", "\r", "\r", "\r", "\r"] },
  { label: "CURSOR ONLY (session hook NOT confirmed)", connected: ["cursor"], hooks: [], keys: ["3", "\r", "\r", "\r", "\r"] },
  { label: "MIXED: Claude Code + Cursor - Claude Code prints one, Cursor never can", connected: ["claude-code", "cursor"], hooks: ["cursor"], keys: ["\r", "\r", "\r", "\r"] }
];

/** The per-turn block verbatim: from its header line through the silence line that always closes it. */
function perTurnBlock(frame: string): string {
  const lines = frame.split("\n");
  const start = lines.findIndex((l) => /receipt line/.test(l));
  const end = lines.findIndex((l) => l.includes("COMPACTION_RECEIPT_LINE=0"));
  return start < 0 || end < start ? "(per-turn block not found)" : lines.slice(start, end + 1).join("\n");
}

for (const c of CASES) {
  const frame = await readyFrame(c.connected, c.hooks, c.keys);
  console.log(`\n===== ${c.label} =====`);
  console.log(perTurnBlock(frame));
  const promised = frame.includes("After each turn you'll see one content-free receipt line:");
  const denied = /no per-turn receipt line|no inline line|if your Codex build displays it/.test(frame);
  console.log(`  [check] unscoped promise header present: ${promised} · body denies or hedges a per-turn line: ${denied} · CONTRADICTION: ${promised && denied}`);
}
