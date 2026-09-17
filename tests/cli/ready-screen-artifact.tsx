/**
 * ARTIFACT SCRIPT (not a test, not shipped): renders the real normal onboarding frames with injected
 * setup fakes, then prints each frame verbatim. Run with:
 * node --import tsx tests/cli/ready-screen-artifact.tsx
 */
import React from "react";
import { render } from "ink-testing-library";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App, type OnboardingAppProps } from "../../src/cli/onboarding/OnboardingTui.js";
import type {
  ConnectDetection,
  EnableResult,
  OnboardingPlanKey,
  OnboardingReadyStatus
} from "../../src/cli/onboarding/model.js";

const settle = (ms = 150): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const artifactConfigDir = mkdtempSync(join(tmpdir(), "onboarding-render-"));
const previousConfigDir = process.env.COMPACTION_CONFIG_DIR;
process.env.COMPACTION_CONFIG_DIR = artifactConfigDir;

const allFound: ConnectDetection = {
  claude: { detected: true, sessionCount: 3 },
  codex: "found",
  cursor: { desktopDetected: true, hookReady: false, cli: "absent" }
};

const codexOnly: ConnectDetection = {
  claude: { detected: false, sessionCount: 0 },
  codex: "found",
  cursor: { desktopDetected: false, hookReady: false, cli: "absent" }
};

const cursorOnly: ConnectDetection = {
  claude: { detected: false, sessionCount: 0 },
  codex: "absent",
  cursor: { desktopDetected: true, hookReady: false, cli: "absent" }
};

const healthy: OnboardingReadyStatus = {
  healthy: true,
  headline: "Compaction is active",
  launcher: "active · fail-open",
  gateway: "starts on demand",
  auth: "subscription / plan auth"
};

async function capture({
  detection,
  result,
  status = healthy,
  initialPlan
}: {
  detection: ConnectDetection;
  result: EnableResult;
  status?: OnboardingReadyStatus;
  initialPlan?: OnboardingPlanKey;
}): Promise<Record<string, string>> {
  let resolveEnable: ((value: EnableResult) => void) | undefined;
  const props: OnboardingAppProps = {
    version: "9.9.9",
    detection,
    readyStatusFor: async () => status,
    onEnable: () => new Promise<EnableResult>((resolve) => { resolveEnable = resolve; }),
    onPersistMode: async () => {},
    onPersistPlan: async () => "basic",
    onCommunityAuth: async () => ({ ok: true as const, alreadyLoggedIn: false, effectiveMode: "full" as const }),
    onOpenWaitlist: async () => "https://compaction.dev/waitlist?plan=pro",
    ...(initialPlan ? { initialPlan } : {}),
    initialOptimizationMode: "cache-optimize",
    initialProductMode: "basic",
    onDone: () => {}
  };
  const app = render(React.createElement(App, props));
  await settle();
  const frames: Record<string, string> = { TOOLS: app.lastFrame() ?? "" };
  app.stdin.write("\r");
  await settle();
  frames.PLAN = app.lastFrame() ?? "";
  app.stdin.write("\r");
  await settle();
  if (initialPlan === undefined) {
    frames.CONSENT = app.lastFrame() ?? "";
    app.stdin.write("a");
    await settle();
  }
  frames.SETUP = app.lastFrame() ?? "";
  resolveEnable?.(result);
  await settle();
  frames[initialPlan === "pro" ? "WAITLIST" : "READY"] = app.lastFrame() ?? "";
  app.unmount();
  return frames;
}

const freshCommunity = await capture({
  detection: allFound,
  result: {
    connected: ["claude-code", "codex", "cursor"],
    failed: [],
    shapingHooksInstalled: ["claude-code", "codex", "cursor"],
    codexShapingState: "active"
  }
});

for (const [screen, frame] of Object.entries(freshCommunity)) {
  console.log(`\n===== FRESH COMMUNITY: ${screen} =====`);
  console.log(frame);
}

const cursorOnlyCommunity = await capture({
  detection: cursorOnly,
  initialPlan: "community",
  result: { connected: ["cursor"], failed: [], shapingHooksInstalled: ["cursor"] }
});
console.log("\n===== CURSOR-ONLY COMMUNITY: SETUP =====");
console.log(cursorOnlyCommunity.SETUP);
console.log("\n===== CURSOR-ONLY COMMUNITY: READY =====");
console.log(cursorOnlyCommunity.READY);

const openSuccess = await capture({
  detection: allFound,
  initialPlan: "open",
  result: {
    connected: ["claude-code", "codex", "cursor"],
    failed: [],
    shapingHooksInstalled: ["claude-code", "codex", "cursor"],
    codexShapingState: "active"
  }
});
console.log("\n===== OPEN: PLAN =====");
console.log(openSuccess.PLAN);
console.log("\n===== OPEN: SETUP =====");
console.log(openSuccess.SETUP);
console.log("\n===== OPEN: READY =====");
console.log(openSuccess.READY);

const proWaitlist = await capture({
  detection: allFound,
  initialPlan: "pro",
  result: {
    connected: ["claude-code", "codex", "cursor"],
    failed: [],
    shapingHooksInstalled: ["claude-code", "codex", "cursor"],
    codexShapingState: "active"
  }
});
console.log("\n===== PRO: PLAN =====");
console.log(proWaitlist.PLAN);
console.log("\n===== PRO: SETUP =====");
console.log(proWaitlist.SETUP);
console.log("\n===== PRO: WAITLIST =====");
console.log(proWaitlist.WAITLIST);

const codexOneStep = await capture({
  detection: codexOnly,
  initialPlan: "open",
  result: { connected: ["codex"], failed: [], shapingHooksInstalled: [], codexShapingState: "configured" }
});
console.log("\n===== CODEX ONE STEP: READY =====");
console.log(codexOneStep.READY);

const codexCommunityPending = await capture({
  detection: codexOnly,
  initialPlan: "community",
  result: { connected: ["codex"], failed: [], shapingHooksInstalled: [], codexShapingState: "configured" }
});
console.log("\n===== COMMUNITY CODEX TRUST PENDING: READY =====");
console.log(codexCommunityPending.READY);

const shellFollowUp = await capture({
  detection: {
    claude: { detected: true, sessionCount: 1 },
    codex: "absent",
    cursor: { desktopDetected: false, hookReady: false, cli: "absent" }
  },
  initialPlan: "open",
  result: { connected: ["claude-code"], failed: [], shapingHooksInstalled: ["claude-code"] },
  status: {
    healthy: false,
    headline: "Compaction is installed but not active in this shell yet",
    launcher: "installed · waiting for a new shell (PATH not active yet)",
    gateway: "starts on demand",
    auth: "subscription / plan auth",
    nextAction: "Open a new terminal, or reload your shell config."
  }
});
console.log("\n===== GENUINE SHELL FOLLOW-UP: READY =====");
console.log(shellFollowUp.READY);

const isolatedHomeMismatch = await capture({
  detection: {
    claude: { detected: true, sessionCount: 1 },
    codex: "absent",
    cursor: { desktopDetected: false, hookReady: false, cli: "absent" }
  },
  initialPlan: "open",
  result: { connected: ["claude-code"], failed: [], shapingHooksInstalled: ["claude-code"] },
  status: {
    healthy: false,
    headline: "Compaction could not be resolved in the isolated environment",
    launcher: "not active",
    gateway: "starts on demand",
    auth: "subscription / plan auth",
    nextAction: "Check the isolated HOME and PATH fixture."
  }
});
console.log("\n===== ISOLATED-HOME SYNTHETIC MISMATCH: INCOMPLETE =====");
console.log(isolatedHomeMismatch.READY);

const failed = await capture({
  detection: allFound,
  initialPlan: "open",
  result: {
    connected: ["claude-code", "codex"],
    failed: ["codex"],
    shapingHooksInstalled: ["claude-code"],
    codexShapingState: "not-installed"
  },
  status: {
    healthy: false,
    headline: "Compaction setup for Codex could not be verified",
    launcher: "not active",
    gateway: "starts on demand",
    auth: "subscription / plan auth",
    nextAction: "Re-run `compaction init` to complete setup, or run `compaction status` for the failed check."
  }
});
console.log("\n===== REAL FAILURE: READY =====");
console.log(failed.READY);

if (previousConfigDir === undefined) delete process.env.COMPACTION_CONFIG_DIR;
else process.env.COMPACTION_CONFIG_DIR = previousConfigDir;
rmSync(artifactConfigDir, { recursive: true, force: true });
