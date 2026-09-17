import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import { render } from "ink-testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  App,
  type OnboardingResult,
  type OnboardingAppProps
} from "../../src/cli/onboarding/OnboardingTui.js";
import { FULL_APPLY_PENDING_REASONS, FULL_APPLY_REQUIREMENT_LINE } from "../../src/cli/onboarding/model.js";
import type {
  ConnectDetection,
  ReadyToolKey,
  EnableResult,
  OptimizationModeKey,
  OnboardingPlanKey,
  OnboardingReadyStatus
} from "../../src/cli/onboarding/model.js";

const settle = (ms = 120): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * A frame as the USER reads it: colour codes removed, then whitespace collapsed.
 *
 * Both halves are required and the order matters. Ink hard-wraps to the terminal width AND paints
 * every line with its own colour codes, so a sentence that wraps arrives as `…no Pro <ESC>[39m\n
 * <ESC>[38;2;…m entitlement…`. Collapsing whitespace alone leaves the escapes sitting between the
 * words, and a substring assertion on the sentence fails while the screen is perfectly correct.
 */
const plain = (frame: string | undefined): string =>
  // eslint-disable-next-line no-control-regex
  (frame ?? "").replace(/\u001b\[[0-9;]*m/g, "").replace(/\s+/g, " ");

// claude FOUND (sessions, no verified hook) · codex FOUND · cursor FOUND.
const foundDetection: ConnectDetection = {
  claude: { detected: true, sessionCount: 3 },
  codex: "found",
  cursor: { desktopDetected: false, hookReady: false, cli: "found" }
};

const HEALTHY_STATUS: OnboardingReadyStatus = {
  healthy: true,
  headline: "Compaction is active for Claude Code",
  launcher: "active · fail-open",
  gateway: "running (http://127.0.0.1:8787)",
  auth: "subscription / plan auth (output shaping; input compaction needs an API key)"
};

const mounted: Array<{ unmount: () => void }> = [];
let isolatedConfigDir: string;
let previousConfigDir: string | undefined;
beforeEach(() => {
  isolatedConfigDir = mkdtempSync(join(tmpdir(), "onboarding-tui-config-"));
  previousConfigDir = process.env.COMPACTION_CONFIG_DIR;
  process.env.COMPACTION_CONFIG_DIR = isolatedConfigDir;
});
afterEach(() => {
  for (const m of mounted.splice(0)) m.unmount();
  if (previousConfigDir === undefined) delete process.env.COMPACTION_CONFIG_DIR;
  else process.env.COMPACTION_CONFIG_DIR = previousConfigDir;
  rmSync(isolatedConfigDir, { recursive: true, force: true });
});

interface MountOpts {
  detection?: ConnectDetection;
  onEnable?: OnboardingAppProps["onEnable"];
  onPersistMode?: OnboardingAppProps["onPersistMode"];
  onPersistPlan?: OnboardingAppProps["onPersistPlan"];
  /** `null` = mount WITHOUT an activation implementation (Community must then not be offered). */
  onCommunityAuth?: OnboardingAppProps["onCommunityAuth"] | null;
  /** `null` = mount WITHOUT a waitlist handoff (Pro must then not be offered). */
  onOpenWaitlist?: OnboardingAppProps["onOpenWaitlist"] | null;
  signedIn?: boolean;
  communityAuthorized?: boolean;
  /** null mounts a fresh device with a capability-derived default. */
  initialPlan?: OnboardingPlanKey | null;
  initialOptimizationMode?: OptimizationModeKey;
  initialProductMode?: OnboardingAppProps["initialProductMode"];
  readyStatusFor?: OnboardingAppProps["readyStatusFor"];
  onDone?: (r: OnboardingResult) => void;
}
function mount(opts: MountOpts = {}) {
  const props: OnboardingAppProps = {
    version: "9.9.9",
    detection: opts.detection ?? foundDetection,
    readyStatusFor: opts.readyStatusFor ?? (async () => HEALTHY_STATUS),
    onEnable: opts.onEnable ?? (async (keys) => ({
      connected: keys,
      failed: [],
      shapingHooksInstalled: keys.filter((key) => key !== "codex"),
      ...(keys.includes("codex") ? { codexShapingState: "configured" as const } : {})
    })),
    onPersistMode: opts.onPersistMode ?? (async () => {}),
    onPersistPlan: opts.onPersistPlan ?? (async () => "basic"),
    // Production ALWAYS injects an activation implementation, so the default mount does too — a mount
    // without one is the deliberate "Community not offered" case, exercised in its own test.
    ...(opts.onCommunityAuth === null
      ? {}
      : {
          onCommunityAuth:
            opts.onCommunityAuth ?? (async () => ({ ok: true as const, alreadyLoggedIn: false, effectiveMode: "basic" as const }))
        }),
    // Same rule for the Pro handoff: production always injects one, so the default mount does too.
    // The URL is the seam's to resolve — the TUI must never build one — so the fake returns a marker
    // the assertions can pin without depending on the deployed origin.
    ...(opts.onOpenWaitlist === null
      ? {}
      : { onOpenWaitlist: opts.onOpenWaitlist ?? (async () => "https://example.test/waitlist?plan=pro") }),
    signedIn: opts.signedIn ?? false,
    communityAuthorized: opts.communityAuthorized ?? false,
    ...(opts.initialPlan === null ? {} : { initialPlan: opts.initialPlan ?? "open" }),
    initialOptimizationMode: opts.initialOptimizationMode ?? "cache-optimize",
    initialProductMode: opts.initialProductMode ?? "basic",
    onDone: opts.onDone ?? (() => {})
  };
  const inst = render(React.createElement(App, props));
  mounted.push(inst);
  return inst;
}

/** Page-1 multi-select helper: all found tools begin selected; keep exactly one, then continue. */
async function selectOnly(a: ReturnType<typeof mount>, target: ReadyToolKey): Promise<void> {
  const order: ReadyToolKey[] = ["claude-code", "codex", "cursor"];
  for (const [index, key] of order.entries()) {
    if (key !== target) a.stdin.write(" ");
    if (index < order.length - 1) a.stdin.write("\u001b[B");
    await settle(20);
  }
  a.stdin.write("\r");
  await settle();
}

describe("OnboardingTui <App> - production flow wired to the real backend", () => {
  it("target screen shows the welcome header (badge + wordmark + DEV + version line), honest per-tool availability, and read-only framing (no writes)", () => {
    const onEnable = vi.fn(async (): Promise<EnableResult> => ({ connected: [], failed: [] }));
    const frame = mount({ onEnable }).lastFrame() ?? "";
    // The bordered welcome badge.
    expect(frame).toContain("✦ Welcome to Compaction");
    // The wordmark + DEV stack (the test terminal is short, so the compact
    // spaced form renders; the block art is the tall-terminal variant).
    expect(frame).toContain("C O M P A C T I O N");
    expect(frame).toContain("D E V");
    // The version line uses the real injected version, not a hardcoded one.
    expect(frame).toContain("v9.9.9 compaction: context optimization for AI agents.");
    expect(frame).toContain("Choose your tools");
    expect(frame).toContain("Detected tools are selected. Nothing changes until you continue.");
    expect(frame).toContain("Claude Code");
    expect(frame).toContain("Codex");
    expect(frame).toContain("Cursor");
    expect(plain(frame)).toContain("Claude Code · detected · Input + output token reduction · Subscription or API key · Results: status line");
    expect(plain(frame)).toContain("Codex · detected · Input + output token reduction · Subscription or API key · Results: Compaction hook");
    expect(plain(frame)).toContain("Cursor · detected · Output token reduction · Session-level hook · No input reduction");
    expect(frame).not.toContain("recommended");
    expect(frame.match(/\[x\]/g)).toHaveLength(3);
    expect(frame).toContain("↑/↓ Move   Space Select/deselect   Enter Continue with all detected   Esc Exit");
    expect(frame).not.toMatch(/\b1\. Claude Code|1\/2\/3 · Enter continue/);
    // Rendering discovery/target writes nothing.
    expect(onEnable).not.toHaveBeenCalled();
    // No overclaim on the first screen.
    expect(frame).not.toMatch(/-?\d+%/);
    expect(frame).not.toMatch(/billing-confirmed|cost saved/i);
  });

  it("preselects every detected tool and enables the selected found set only after explicit confirmation", async () => {
    const onEnable = vi.fn(async (keys: ReadyToolKey[]): Promise<EnableResult> => ({ connected: keys, failed: [] }));
    const a = mount({ onEnable, onCommunityAuth: null });
    await settle();
    a.stdin.write("\r"); // selected set → plan
    await settle();
    const plan = plain(a.lastFrame());
    expect(plan).toContain("Selected: Claude Code, Codex, Cursor");
    expect(plan).toContain("Enter Set up Open for 3 selected tools");
    expect(onEnable).not.toHaveBeenCalled();
    a.stdin.write("\r"); // plan confirmation = first write
    await settle();
    expect(onEnable).toHaveBeenCalledTimes(1);
    expect(onEnable).toHaveBeenCalledWith(["claude-code", "codex", "cursor"]);
    const ready = a.lastFrame() ?? "";
    expect(ready).toContain("Claude Code   Output token reduction not verified");
    expect(ready).toContain("Codex   Output token reduction not verified");
    expect(ready).toContain("Cursor   Output token reduction not verified");
  });

  it("counts selected ready tools without reinstalling and discloses preference writes before confirmation", async () => {
    const onEnable = vi.fn(async (): Promise<EnableResult> => ({ connected: [], failed: [] }));
    const onPersistMode = vi.fn(async (): Promise<void> => {});
    const onPersistPlan = vi.fn(async (): Promise<"basic"> => "basic");
    const a = mount({
      detection: { claude: { detected: true, sessionCount: 1, hookReady: true }, codex: "active", codexHooksInstalled: true, cursor: { desktopDetected: false, hookReady: true, cli: "active" } },
      onEnable,
      onPersistMode,
      onPersistPlan,
      onCommunityAuth: null
    });
    await settle();
    a.stdin.write("\r");
    await settle();
    expect(onEnable).not.toHaveBeenCalled();
    expect(onPersistMode).not.toHaveBeenCalled();
    expect(onPersistPlan).not.toHaveBeenCalled();
    const plan = plain(a.lastFrame());
    expect(plan).toContain("Selected: Claude Code, Codex, Cursor");
    expect(plan).toContain("Enter Set up Open for 3 selected tools");
    a.stdin.write("\r");
    await settle();
    expect(onEnable).not.toHaveBeenCalled();
    expect(onPersistMode).toHaveBeenCalledWith("cache-optimize", ["claude-code", "codex", "cursor"]);
    expect(onPersistPlan).toHaveBeenCalledWith("open");
    const ready = a.lastFrame() ?? "";
    expect(ready).toContain("Claude Code   Output token reduction · Results: Claude status line");
    expect(ready).toContain("Codex   Output token reduction · one step remaining");
    expect(ready).toContain("Cursor   Output token reduction · Session hook");
  });

  it("respects deselection: a detected found tool is neither enabled nor listed ready", async () => {
    const onEnable = vi.fn(async (keys: ReadyToolKey[]): Promise<EnableResult> => ({ connected: keys, failed: [] }));
    const a = mount({ onEnable, onCommunityAuth: null });
    await settle();
    a.stdin.write("\u001b[B"); // Codex row
    await settle(20);
    a.stdin.write(" "); // deselect Codex
    await settle(20);
    expect(a.lastFrame() ?? "").toContain("Enter Continue with 2 selected");
    a.stdin.write("\r");
    await settle();
    a.stdin.write("\r");
    await settle();
    expect(onEnable).toHaveBeenCalledWith(["claude-code", "cursor"]);
    const ready = a.lastFrame() ?? "";
    expect(ready).toContain("Claude Code   Output token reduction not verified");
    expect(ready).toContain("Cursor   Output token reduction not verified");
    expect(ready).not.toContain("Codex   ");
  });

  it("repairs an active Codex routing shim whose native hook bundle is missing", async () => {
    const onEnable = vi.fn(async (keys: ReadyToolKey[]): Promise<EnableResult> => ({
      connected: keys,
      failed: [],
      shapingHooksInstalled: keys
    }));
    const a = mount({
      detection: {
        claude: { detected: false, sessionCount: 0 },
        codex: "active",
        codexHooksInstalled: false,
        codexHookReady: false,
        cursor: { desktopDetected: false, hookReady: false, cli: "absent" }
      },
      onEnable,
      onCommunityAuth: null
    });
    await settle();
    for (const key of ["\r", "\r"]) {
      a.stdin.write(key);
      await settle();
    }
    expect(onEnable).toHaveBeenCalledTimes(1);
    expect(onEnable).toHaveBeenCalledWith(["codex"]);
    expect(a.lastFrame() ?? "").toContain("Codex   Output token reduction");
  });

  it("retains Codex routing but reports setup incomplete when native hook setup fails", async () => {
    const onEnable = vi.fn(async (): Promise<EnableResult> => ({
      connected: ["codex"],
      failed: ["codex"],
      shapingHooksInstalled: []
    }));
    const a = mount({
      detection: {
        claude: { detected: false, sessionCount: 0 },
        codex: "active",
        codexHooksInstalled: false,
        codexHookReady: false,
        cursor: { desktopDetected: false, hookReady: false, cli: "absent" }
      },
      onEnable,
      onCommunityAuth: null
    });
    await settle();
    for (const key of ["\r", "\r"]) {
      a.stdin.write(key);
      await settle();
    }
    const ready = a.lastFrame() ?? "";
    expect(ready).toContain("Setup incomplete");
    expect(ready).toContain("Codex   Output token reduction not verified");
    expect(ready).toContain("Codex   Output token reduction not verified");
    expect(ready).toContain("Retry: compaction init --connect codex");
  });

  it("an empty selection stays read-only and cannot advance to confirmation", async () => {
    const onEnable = vi.fn(async (): Promise<EnableResult> => ({ connected: [], failed: [] }));
    const onPersistMode = vi.fn(async (): Promise<void> => {});
    const onPersistPlan = vi.fn(async (): Promise<"basic"> => "basic");
    const a = mount({ onEnable, onPersistMode, onPersistPlan });
    await settle();
    for (let index = 0; index < 3; index += 1) {
      a.stdin.write(" ");
      if (index < 2) a.stdin.write("\u001b[B");
      await settle(20);
    }
    a.stdin.write("\r");
    await settle();
    expect(a.lastFrame() ?? "").toContain("Choose your tools");
    expect(onEnable).not.toHaveBeenCalled();
    expect(onPersistMode).not.toHaveBeenCalled();
    expect(onPersistPlan).not.toHaveBeenCalled();
  });

  it("Claude path: target → plan → setup → ready; Plan Enter is the first write", async () => {
    let resolveEnable: ((result: EnableResult) => void) | undefined;
    const onEnable = vi.fn((_keys: ReadyToolKey[]) => new Promise<EnableResult>((resolve) => {
      resolveEnable = resolve;
    }));
    const onPersistMode = vi.fn(async (_m: OptimizationModeKey): Promise<void> => {});
    let done: OnboardingResult | null = null;
    const a = mount({ onEnable, onPersistMode, onDone: (r) => (done = r) });
    await settle();

    // Keep only Claude Code selected, then continue to the sole plan decision.
    await selectOnly(a, "claude-code");
    const plan = a.lastFrame() ?? "";
    expect(plan).toContain("Choose your plan");
    expect(plan).toContain("Open");
    expect(plan).toContain("Community");
    expect(plan).toContain("Use your existing provider login.");
    expect(onEnable).not.toHaveBeenCalled();
    a.stdin.write("\r"); // Plan confirmation is the first write.
    await settle();
    expect(onEnable).toHaveBeenCalledTimes(1);
    expect(onEnable).toHaveBeenCalledWith(["claude-code"]);
    const setup = plain(a.lastFrame());
    expect(setup).toContain("Setting up Compaction");
    expect(setup).toContain("Open · Output token reduction");
    expect(setup).toContain("Claude Code");
    expect(setup).toContain("Connecting selected tools and verifying setup");
    expect(setup).not.toContain("Review your setup");
    resolveEnable?.({ connected: ["claude-code"], failed: [], shapingHooksInstalled: ["claude-code"] });
    await settle();
    expect(onPersistMode).toHaveBeenCalledTimes(1);
    // Open maps to the existing cache-optimize key.
    expect(onPersistMode).toHaveBeenCalledWith("cache-optimize", ["claude-code"]);

    const ready = a.lastFrame() ?? "";
    expect(ready).toContain("Compaction is ready");
    expect(ready).toContain("Claude Code   Output token reduction · Results: Claude status line");
    expect(ready).toContain("Plan: Open");
    expect(ready).toContain("compaction status     Check setup");
    expect(ready).toContain("compaction activity   See recent results");
    expect(ready).toContain("compaction init       Reconfigure");
    expect(ready).toContain("compaction stop       Disable");
    expect(ready).toContain("Enter Finish   Esc Exit");
    expect(ready).not.toContain("Measured activity");
    expect(ready).not.toContain("After each turn");

    // Esc exits honestly after setup has completed.
    a.stdin.write("\u001B");
    await settle();
    expect(done).not.toBeNull();
    expect((done as unknown as OnboardingResult).completed).toBe(true);
    expect((done as unknown as OnboardingResult).enabled).toEqual(["claude-code"]);
    expect((done as unknown as OnboardingResult).mode).toBe("cache-optimize");
  });

  it("fresh Claude or Codex selection recommends and selects Community", async () => {
    for (const target of ["claude-code", "codex"] as const) {
      const a = mount({ initialPlan: null });
      await settle();
      await selectOnly(a, target);
      const plan = plain(a.lastFrame());
      expect(plan).toContain("Choose your plan");
      expect(plan).toMatch(/Community.*\(recommended\)/);
      expect(plan).toContain("› Community");
      expect(plan).toContain("Free account · Input + output token reduction · 2M optimized input/month Existing subscription or API key · estimated minutes or $ saved");
      a.unmount();
    }
  });

  it("fresh Cursor-only selection recommends and selects Open", async () => {
    const a = mount({ initialPlan: null });
    await settle();
    await selectOnly(a, "cursor");
    const plan = plain(a.lastFrame());
    expect(plan).toMatch(/› Open.*\(recommended\)/);
    expect(plan).toContain("No account · Output token reduction · Local · Nothing metered");
    expect(plan).toContain("Input + output token reduction · 2M optimized input/month");
    expect(plan).toContain("Selected: Cursor");
  });

  it("routes every tool directly from selection to plan and back with the left arrow", async () => {
    for (const target of ["claude-code", "codex", "cursor"] as const) {
      const a = mount();
      await settle();
      await selectOnly(a, target);
      expect(a.lastFrame() ?? "").toContain("Choose your plan");
      a.stdin.write("\u001b[D");
      await settle();
      expect(a.lastFrame() ?? "").toContain("Choose your tools");
      a.unmount();
    }
  });

  it("Esc exits from the tool and plan screens", async () => {
    for (const fromPlan of [false, true]) {
      let done: OnboardingResult | null = null;
      const a = mount({ onDone: (result) => { done = result; } });
      await settle();
      if (fromPlan) {
        a.stdin.write("\r");
        await settle();
      }
      a.stdin.write("\u001B");
      await settle();
      expect((done as unknown as OnboardingResult).quit).toBe(true);
      expect((done as unknown as OnboardingResult).completed).toBe(false);
    }
  });

  it("normal flow has no per-tool optimization or implementation-detail screen", async () => {
    let resolveEnable: ((result: EnableResult) => void) | undefined;
    const a = mount({
      onEnable: () => new Promise<EnableResult>((resolve) => { resolveEnable = resolve; })
    });
    await settle();
    await selectOnly(a, "codex");
    a.stdin.write("\r");
    await settle();
    const setup = plain(a.lastFrame());
    expect(setup).toContain("Setting up Compaction");
    expect(setup).toContain("Open · Output token reduction");
    expect(setup).toContain("Codex");
    expect(setup).not.toMatch(/Review your setup|Output only|Choose how|hooks\.json|compaction hooks|backup/i);
    resolveEnable?.({ connected: ["codex"], failed: [], codexShapingState: "configured" });
    await settle();
  });

  it("setup names the chosen plan and its supported token reduction", async () => {
    const pendingEnable = (): Promise<EnableResult> => new Promise(() => {});

    const community = mount({ initialPlan: null, onEnable: pendingEnable });
    await settle();
    await selectOnly(community, "claude-code");
    community.stdin.write("\r");
    await settle();
    community.stdin.write("a");
    await settle();
    expect(plain(community.lastFrame())).toContain("Community · Input + output token reduction Claude Code");
    community.unmount();

    const cursorCommunity = mount({ initialPlan: "community", onEnable: pendingEnable });
    await settle();
    await selectOnly(cursorCommunity, "cursor");
    cursorCommunity.stdin.write("\r");
    await settle();
    expect(plain(cursorCommunity.lastFrame())).toContain("Community · Output token reduction Cursor");
    cursorCommunity.unmount();

    const pro = mount({ initialPlan: "pro", onEnable: pendingEnable });
    await settle();
    pro.stdin.write("\r");
    await settle();
    pro.stdin.write("\r");
    await settle();
    expect(plain(pro.lastFrame())).toContain("Pro waitlist · Open setup · Output token reduction");
    pro.unmount();
  });

  it("ready is compact and omits metric, per-turn, and routing detail", async () => {
    const a = mount();
    await settle();
    await selectOnly(a, "claude-code");
    a.stdin.write("\r");
    await settle();
    const ready = a.lastFrame() ?? "";
    expect(ready).toContain("Compaction is ready");
    expect(ready).toContain("Claude Code   Output token reduction · Results: Claude status line");
    expect(ready).toContain("compaction status     Check setup");
    expect(ready).toContain("compaction activity   See recent results");
    expect(ready).toContain("compaction init       Reconfigure");
    expect(ready).toContain("compaction stop       Disable");
    expect(ready).not.toContain("Measured activity");
    expect(ready).not.toContain("After each turn");
    expect(ready).not.toContain("Gateway");
    expect(ready).not.toContain("Illustrative examples, not your activity:");
  });

  it("Cursor ready copy stays output-only and names the IDE measurement boundary", async () => {
    const onEnable = vi.fn(async (): Promise<EnableResult> => ({
      connected: ["cursor"],
      failed: [],
      shapingHooksInstalled: ["cursor"]
    }));
    const a = mount({ onEnable, initialPlan: null });
    await settle();
    await selectOnly(a, "cursor");
    a.stdin.write("\r");
    await settle();
    const ready = plain(a.lastFrame());
    expect(ready).toContain("Cursor Output token reduction · Session hook");
    expect(ready).not.toContain("Input + output token reduction");
    expect(ready).not.toContain("Illustrative examples, not your activity:");
  });

  it("Community examples stay hidden for Cursor-only and Codex trust-pending setups", async () => {
    const cursorOnly = mount({
      detection: {
        claude: { detected: false, sessionCount: 0 },
        codex: "absent",
        cursor: { desktopDetected: true, hookReady: true, cli: "absent" }
      },
      initialPlan: "community",
      initialOptimizationMode: "cache-context-optimize",
      initialProductMode: "full",
      signedIn: true,
      communityAuthorized: true
    });
    await settle();
    cursorOnly.stdin.write("\r");
    await settle();
    cursorOnly.stdin.write("\r");
    await settle();
    const cursorReady = plain(cursorOnly.lastFrame());
    expect(cursorReady).toContain("Community active");
    expect(cursorReady).toContain("Cursor Output token reduction · Session hook");
    expect(cursorReady).not.toContain("Illustrative examples, not your activity:");

    const codexPending = mount({
      detection: {
        claude: { detected: false, sessionCount: 0 },
        codex: "found",
        cursor: { desktopDetected: false, hookReady: false, cli: "absent" }
      },
      initialPlan: "community",
      initialOptimizationMode: "cache-context-optimize",
      initialProductMode: "full",
      signedIn: true,
      communityAuthorized: true,
      onEnable: async () => ({
        connected: ["codex"],
        failed: [],
        shapingHooksInstalled: [],
        codexShapingState: "configured"
      })
    });
    await settle();
    codexPending.stdin.write("\r");
    await settle();
    codexPending.stdin.write("\r");
    await settle();
    const codexReady = plain(codexPending.lastFrame());
    expect(codexReady).toContain("Community active");
    expect(codexReady).toContain("Codex Output token reduction · one step remaining");
    expect(codexReady).toContain("Run codex. At “Hooks need review,” choose “Trust all and continue”.");
    expect(codexReady).not.toContain("Illustrative examples, not your activity:");
  });

  it("mixed success and failure stays incomplete while preserving successful tools", async () => {
    const onEnable = vi.fn(async (): Promise<EnableResult> => ({
      connected: ["claude-code"],
      failed: ["codex"]
    }));
    const a = mount({ onEnable, onCommunityAuth: null });
    await settle();
    a.stdin.write("\r");
    await settle();
    a.stdin.write("\r");
    await settle();
    const ready = a.lastFrame() ?? "";
    expect(ready).toContain("Setup incomplete");
    expect(ready).not.toContain("Compaction is ready");
    expect(ready).toContain("Claude Code   Output token reduction not verified");
    expect(ready).toContain("Codex   Setup incomplete");
    expect(ready).toContain("Retry: compaction init --connect codex");
  });

  it("mixed Community failure never shows illustrative examples", async () => {
    const onEnable = vi.fn(async (): Promise<EnableResult> => ({
      connected: ["claude-code"],
      failed: ["codex"],
      shapingHooksInstalled: ["claude-code"]
    }));
    const a = mount({
      detection: {
        claude: { detected: true, sessionCount: 1 },
        codex: "found",
        cursor: { desktopDetected: false, hookReady: false, cli: "absent" }
      },
      initialPlan: "community",
      initialOptimizationMode: "cache-context-optimize",
      initialProductMode: "full",
      signedIn: true,
      communityAuthorized: true,
      onEnable
    });
    await settle();
    for (const key of ["\r", "\r"]) {
      a.stdin.write(key);
      await settle();
    }
    const ready = plain(a.lastFrame());
    expect(ready).toContain("Setup incomplete");
    expect(ready).toContain("Claude Code Input + output token reduction · Results: Claude status line");
    expect(ready).toContain("Codex Setup incomplete");
    expect(ready).toContain("Retry: compaction init --connect codex");
    expect(ready).not.toContain("Illustrative examples, not your activity:");
  });

  it("q quits from the target screen → completed:false, quit:true, nothing enabled, no write", async () => {
    const onEnable = vi.fn(async (): Promise<EnableResult> => ({ connected: [], failed: [] }));
    let done: OnboardingResult | null = null;
    const a = mount({ onEnable, onDone: (r) => (done = r) });
    await settle();
    a.stdin.write("q");
    await settle();
    expect(onEnable).not.toHaveBeenCalled();
    expect((done as unknown as OnboardingResult).quit).toBe(true);
    expect((done as unknown as OnboardingResult).completed).toBe(false);
    expect((done as unknown as OnboardingResult).enabled).toEqual([]);
  });

  it("a not-found workflow cannot be selected as a target", async () => {
    const detection: ConnectDetection = {
      claude: { detected: true, sessionCount: 1 },
      codex: "found",
      cursor: { desktopDetected: false, hookReady: false, cli: "absent" } // Cursor not found
    };
    const a = mount({ detection });
    await settle();
    // Move to Cursor and try to select it; not-found is disabled, so the toggle is a no-op.
    a.stdin.write("\u001b[B");
    a.stdin.write("\u001b[B");
    a.stdin.write(" ");
    await settle();
    expect(a.lastFrame() ?? "").toContain("Choose your tools");
    expect(a.lastFrame() ?? "").toContain("[-] Cursor");
    expect(a.lastFrame() ?? "").toContain("not found");
  });

  it("a failed enable never claims active: ready status is driven by the real readyStatusFor result", async () => {
    const onEnable = vi.fn(async (): Promise<EnableResult> => ({ connected: [], failed: ["claude-code"] }));
    const unhealthy: OnboardingReadyStatus = {
      healthy: false,
      headline: "Compaction setup for Claude Code could not be verified",
      launcher: "not active",
      gateway: "starts on demand when the workflow needs routing",
      auth: "subscription / plan auth (output shaping; input compaction needs an API key)",
      nextAction: "Re-run `compaction init` to complete setup, or run `compaction status` for the failed check."
    };
    const a = mount({ onEnable, readyStatusFor: async () => unhealthy });
    await settle();
    a.stdin.write("\r"); // target → plan
    await settle();
    a.stdin.write("\r"); // plan confirmation → setup → ready
    await settle();
    const ready = a.lastFrame() ?? "";
    expect(ready).toContain("Setup incomplete");
    expect(ready).toContain("Configured: none");
    expect(ready).toContain("Claude Code   Setup incomplete");
    expect(ready).toContain("Retry: compaction init --connect claude-code");
    expect(ready).not.toContain("Compaction setup for Claude Code could not be verified");
    expect(ready).not.toContain("Compaction is ready");
  });

  it("reports a completed setup when only shell activation remains", async () => {
    const detection: ConnectDetection = {
      claude: { detected: true, sessionCount: 1 },
      codex: "absent",
      cursor: { desktopDetected: false, hookReady: false, cli: "absent" }
    };
    const status: OnboardingReadyStatus = {
      healthy: false,
      headline: "Compaction is installed but not active in this shell yet",
      launcher: "installed · waiting for a new shell (PATH not active yet)",
      gateway: "starts on demand",
      auth: "subscription / plan auth",
      nextAction: "Open a new terminal, or reload your shell config."
    };
    const a = mount({
      detection,
      onCommunityAuth: null,
      onEnable: async () => ({
        connected: ["claude-code"],
        failed: [],
        shapingHooksInstalled: ["claude-code"]
      }),
      readyStatusFor: async () => status
    });
    await settle();
    a.stdin.write("\r");
    await settle();
    a.stdin.write("\r");
    await settle();
    const ready = a.lastFrame() ?? "";
    expect(ready).toContain("✓ Compaction is ready");
    expect(ready).toContain("Claude Code   Output token reduction · new terminal required");
    expect(ready).toContain("Open a new terminal, or reload your shell config.");
    expect(ready).not.toContain("Setup incomplete");
    expect(ready).not.toContain("Illustrative examples, not your activity:");
  });
});

describe("OnboardingTui <App> - plan choice (the 'authorize' step) and Community activation", () => {
  /** target → plan. Returns the harness sitting on the plan screen. */
  async function toPlan(opts: MountOpts = {}) {
    const a = mount(opts);
    await settle();
    a.stdin.write("\r"); // target → plan
    await settle();
    return a;
  }

  it("offers exactly three unnumbered options and labels Pro as a waitlist", async () => {
    const a = await toPlan();
    const plan = a.lastFrame() ?? "";
    expect(plan).toContain("› Open");
    expect(plan).toMatch(/Community\s+\(recommended\)/);
    expect(plan).toContain("Pro · waitlist");
    expect(plan).not.toMatch(/[123]\. (Open|Community|Pro)/);
    // TEAM IS NOT IN ONBOARDING. The canonical journey does not name it, and a fourth waitlist row
    // would be padding rather than a choice.
    expect(plan).not.toMatch(/\bTeam\b/);
    expect(plan).toContain("↑/↓ Choose");
    expect(plan).not.toContain("1/2/3");
  });

  it("PRO IS A HANDOFF, NOT A SALE: the picker names no price, no purchase, and no URL", async () => {
    const a = await toPlan();
    a.stdin.write("3"); // select Pro so its effect bullets render
    await settle();
    const plan = a.lastFrame() ?? "";
    const flat = plain(plan);
    expect(flat).toContain("Input + output token reduction · 500M optimized input/month · up to 3 devices");
    expect(flat).toContain("Enter Join Pro waitlist");
    // What it must NOT say. A price or a checkout word on a waitlist row is a claim about a service
    // that cannot be bought; a URL belongs on the handoff screen, not in a picker.
    expect(plan).not.toMatch(/\$\d/);
    expect(plan).not.toMatch(/monthly|per month|checkout|subscribe/i);
    expect(plan).not.toMatch(/https?:\/\//);
    expect(plan).toContain("Choose your plan");
  });

  it("the plan screen stays concise and writes nothing", async () => {
    const onPersistPlan = vi.fn(async () => "basic" as const);
    const a = await toPlan({ onPersistPlan });
    const plan = plain(a.lastFrame());
    expect(plan).toContain("Choose your plan");
    expect(plan).toContain("Open No account · Output token reduction · Local · Nothing metered");
    expect(plan).toContain("Community (recommended) Free account · Input + output token reduction · 2M optimized input/month Existing subscription or API key · estimated minutes or $ saved");
    expect(plan).toContain("Pro · waitlist Input + output token reduction · 500M optimized input/month · up to 3 devices");
    expect(plan).toContain("Selected: Claude Code, Codex, Cursor");
    expect(plan).toContain("Enter Set up Open for 3 selected tools");
    expect(onPersistPlan).not.toHaveBeenCalled();
  });

  it("Open path: persists the Open floor, makes NO activation call, and the ready screen says so", async () => {
    const onPersistPlan = vi.fn(async () => "basic" as const);
    const onCommunityAuth = vi.fn(async () => ({ ok: true as const, alreadyLoggedIn: false, effectiveMode: "full" as const }));
    const a = await toPlan({ onPersistPlan, onCommunityAuth });
    a.stdin.write("\r"); // plan confirmation → setup → ready
    await settle();
    expect(onPersistPlan).toHaveBeenCalledWith("open");
    expect(onCommunityAuth).not.toHaveBeenCalled();
    const ready = a.lastFrame() ?? "";
    expect(ready).toContain("Plan: Open");
    expect(ready).toContain("Compaction is ready");
  });

  it("existing authorized Community keeps full mode without reinstalling or browser activation", async () => {
    const onEnable = vi.fn(async (): Promise<EnableResult> => ({ connected: [], failed: [] }));
    const onPersistMode = vi.fn(async (): Promise<void> => {});
    const onPersistPlan = vi.fn(async () => "basic" as const);
    const onCommunityAuth = vi.fn(async () => ({
      ok: true as const,
      alreadyLoggedIn: true,
      effectiveMode: "full" as const
    }));
    let done: OnboardingResult | null = null;
    const a = mount({
      detection: {
        claude: { detected: true, sessionCount: 1, hookReady: true },
        codex: "active",
        codexHooksInstalled: true,
        cursor: { desktopDetected: true, hookReady: true, cli: "absent" }
      },
      initialPlan: "community",
      initialOptimizationMode: "cache-context-optimize",
      initialProductMode: "full",
      signedIn: true,
      communityAuthorized: true,
      onEnable,
      onPersistMode,
      onPersistPlan,
      onCommunityAuth,
      onDone: (result) => { done = result; }
    });
    await settle();
    a.stdin.write("\r");
    await settle();
    expect(plain(a.lastFrame())).toContain("› Community");
    a.stdin.write("\r");
    await settle();
    expect(onEnable).not.toHaveBeenCalled();
    expect(onPersistMode).not.toHaveBeenCalled();
    expect(onPersistPlan).not.toHaveBeenCalled();
    expect(onCommunityAuth).not.toHaveBeenCalled();
    expect(a.lastFrame() ?? "").toContain("Community active");
    a.stdin.write("\r");
    await settle();
    expect((done as unknown as OnboardingResult).mode).toBe("cache-context-optimize");
  });

  it("Community path: the Open floor is persisted BEFORE activation runs (an abandoned auth still leaves a working setup)", async () => {
    const calls: string[] = [];
    const onPersistMode = vi.fn(async (mode: OptimizationModeKey) => {
      calls.push(`mode:${mode}`);
    });
    const onPersistPlan = vi.fn(async () => {
      calls.push("persist");
      return "basic" as const;
    });
    const onCommunityAuth = vi.fn(async () => {
      calls.push("auth");
      return { ok: true as const, alreadyLoggedIn: false, effectiveMode: "full" as const };
    });
    const onEnable = vi.fn(async (): Promise<EnableResult> => ({
      connected: ["claude-code"],
      failed: [],
      shapingHooksInstalled: ["claude-code"]
    }));
    const a = await toPlan({ onEnable, onPersistMode, onPersistPlan, onCommunityAuth });
    a.stdin.write("2"); // choose Community
    await settle(40);
    const plan = plain(a.lastFrame());
    expect(plan).toContain("Selected: Claude Code, Codex, Cursor");
    expect(plan).toContain("Enter Set up Community for 3 selected tools");
    a.stdin.write("\r"); // confirmation → license
    await settle();
    a.stdin.write("a"); // accept the Engine agreement
    await settle();
    expect(onPersistPlan).toHaveBeenCalledWith("community");
    expect(calls).toEqual(["mode:cache-optimize", "persist", "auth", "mode:cache-context-optimize"]);
    const ready = a.lastFrame() ?? "";
    expect(ready).toContain("Community active");
    expect(ready).toContain("Compaction is ready");
    expect(ready).toContain("Claude Code   Input + output token reduction · Results: Claude status line");
    const renderedReady = plain(ready);
    expect(renderedReady).toContain("Illustrative examples, not your activity:");
    expect(renderedReady).toContain("Subscription: compaction · input 8,388,356→7,212,095 (−14%) · output 14,393→10,795 (−25%, est.) · +~3.08m");
    expect(renderedReady).toContain("API key: compaction · input 91,472→74,769 (−18%) · output 857→463 (−46%, est.) · −$0.05 (list price)");
  });

  it("Community WITHOUT a lease lands on `basic`, never `observe` — a Community chooser is never left below Open", async () => {
    const onPersistMode = vi.fn(async () => {});
    const onCommunityAuth = vi.fn(async () => ({
      ok: true as const,
      alreadyLoggedIn: false,
      effectiveMode: "basic" as const,
      fullApplyPendingReason: "lease-invalid"
    }));
    const a = await toPlan({ onCommunityAuth, onPersistMode });
    a.stdin.write("2");
    await settle(40);
    a.stdin.write("\r");
    await settle();
    a.stdin.write("a"); // accept the Engine agreement
    await settle();
    const ready = a.lastFrame() ?? "";
    expect(ready).toContain("Community active");
    expect(ready).not.toContain("Input compaction enabled");
    expect(ready).not.toContain("Input + output token reduction ·");
    expect(ready).not.toContain("Illustrative examples, not your activity:");
    expect(ready).not.toContain("Per turn");
    expect(ready).not.toContain("lease-invalid");
    expect(onPersistMode).toHaveBeenCalledTimes(1);
    expect(onPersistMode).toHaveBeenCalledWith("cache-optimize", ["claude-code", "codex", "cursor"]);
  });

  it("renders the verification URL and code itself (a browser open silently no-ops on a headless shell)", async () => {
    const onCommunityAuth = vi.fn(async (onProgress: (p: never) => void) => {
      (onProgress as unknown as (p: unknown) => void)({
        kind: "awaiting-browser",
        userCode: "WXYZ-1234",
        verificationUri: "http://127.0.0.1:8080/device?code=WXYZ-1234"
      });
      await settle(200);
      return { ok: true as const, alreadyLoggedIn: false, effectiveMode: "full" as const };
    });
    const a = await toPlan({ onCommunityAuth: onCommunityAuth as never });
    a.stdin.write("2");
    await settle(40);
    a.stdin.write("\r");
    await settle(80);
    a.stdin.write("a"); // accept the Engine agreement
    await settle(80);
    const auth = a.lastFrame() ?? "";
    expect(auth).toContain("http://127.0.0.1:8080/device?code=WXYZ-1234");
    expect(auth).toContain("WXYZ-1234");
    expect(auth).toContain("Esc / Ctrl-C to stop and continue on Open");
    await settle(250);
  });

  it.each([
    ["denied", "The browser request was declined."],
    ["expired", "The confirmation code expired before it was approved."],
    ["timeout", "Timed out waiting for the browser confirmation."],
    ["unreachable", "Could not reach the Compaction service."],
    ["cancelled", "Cancelled."]
  ])("activation failure %s gets its OWN message and offers retry / continue-on-Open / quit (never a dead end)", async (reason, headline) => {
    const onCommunityAuth = vi.fn(async () => ({ ok: false as const, reason: reason as never }));
    const a = await toPlan({ onCommunityAuth });
    a.stdin.write("2");
    await settle(40);
    a.stdin.write("\r");
    await settle();
    a.stdin.write("a"); // accept the Engine agreement
    await settle();
    const failed = a.lastFrame() ?? "";
    expect(failed).toContain(headline);
    // The three things said together: Open works, Community did NOT happen, and how to finish later.
    expect(failed).toContain("Open is active and saved");
    expect(failed).toContain("Community was NOT activated");
    expect(failed).toContain("run `compaction` again and choose Community");
    // A real choice, not a dead end.
    expect(failed).toContain("1. Try again");
    expect(failed).toContain("2. Continue on Open");
    expect(failed).toContain("3. Quit");
  });

  /**
   * F67 on the onboarding surface. Split from the table above on purpose: the table pins one exact
   * headline per reason, and the thing that matters here is a NEGATIVE property — a service that
   * answered must not be reported as a connection problem. Asserted in its own test so a wording
   * change to the headline cannot fail first and leave the property untested.
   */
  it("a service that ANSWERED (503) is named as a service-side failure, not a connection problem", async () => {
    const onCommunityAuth = vi.fn(async () => ({ ok: false as const, reason: "service_error" as const, serviceStatus: 503 }));
    const a = await toPlan({ onCommunityAuth });
    a.stdin.write("2");
    await settle(40);
    a.stdin.write("\r");
    await settle();
    a.stdin.write("a"); // accept the Engine agreement
    await settle();
    const failed = a.lastFrame() ?? "";
    expect(failed).not.toMatch(/connection problem/i);
    expect(failed).not.toMatch(/could not reach/i);
    expect(failed).toMatch(/service side/i);
    expect(failed).toContain("HTTP 503");
    // The escape hatches are unchanged — this is still not a dead end.
    expect(failed).toContain("Open is active and saved");
    expect(failed).toContain("1. Try again");
    expect(failed).toContain("2. Continue on Open");
    expect(failed).toContain("3. Quit");
  });

  /**
   * The same split on the onboarding surface. Opposite property: a 404 means some
   * server answered but is not serving device auth there, which is what a wrong `COMPACTION_API_URL`
   * looks like — so this branch must KEEP the URL remedy that `service_error` deliberately withholds.
   */
  it("a 404 keeps the URL remedy instead of reporting a service-side failure", async () => {
    const onCommunityAuth = vi.fn(async () => ({
      ok: false as const,
      reason: "endpoint_not_found" as const,
      serviceStatus: 404
    }));
    const a = await toPlan({ onCommunityAuth });
    a.stdin.write("2");
    await settle(40);
    a.stdin.write("\r");
    await settle();
    a.stdin.write("a"); // accept the Engine agreement
    await settle();
    const failed = a.lastFrame() ?? "";
    expect(failed).toContain("COMPACTION_API_URL");
    expect(failed).toContain("--api-url");
    expect(failed).not.toMatch(/service side/i);
    expect(failed).not.toMatch(/connection problem/i);
    expect(failed).not.toMatch(/could not reach/i);
    // Still not a dead end.
    expect(failed).toContain("Open is active and saved");
    expect(failed).toContain("1. Try again");
    expect(failed).toContain("2. Continue on Open");
    expect(failed).toContain("3. Quit");
  });

  it("names the status it got back, without saying whose fault it was", async () => {
    const onCommunityAuth = vi.fn(async () => ({
      ok: false as const,
      reason: "endpoint_not_found" as const,
      serviceStatus: 404
    }));
    const a = await toPlan({ onCommunityAuth });
    a.stdin.write("2");
    await settle(40);
    a.stdin.write("\r");
    await settle();
    a.stdin.write("a"); // accept the Engine agreement
    await settle();
    const failed = a.lastFrame() ?? "";
    expect(failed).toContain("HTTP 404");
    expect(failed).not.toMatch(/wrong url|incorrect url|url is wrong|invalid url|you (mis)?typed/i);
  });

  it("retry re-runs activation; continue-on-Open lands on the honest ready screen", async () => {
    let attempt = 0;
    const onCommunityAuth = vi.fn(async () => {
      attempt += 1;
      return { ok: false as const, reason: "unreachable" as const };
    });
    const a = await toPlan({ onCommunityAuth });
    a.stdin.write("2");
    await settle(40);
    a.stdin.write("\r");
    await settle();
    a.stdin.write("a"); // accept the Engine agreement
    await settle();
    expect(attempt).toBe(1);
    a.stdin.write("1"); // retry
    await settle();
    expect(attempt).toBe(2);
    a.stdin.write("2"); // continue on Open
    await settle();
    const ready = a.lastFrame() ?? "";
    expect(ready).toContain("Plan: Open");
    expect(ready).toContain("Compaction is ready");
  });

  /**
   * FINDING 4 — "Try again" could start a SECOND device-code flow beside a live one.
   *
   * Two presses land inside one render frame, so both see the `failed` phase and both call the
   * activation implementation; the second overwrote `authAbortRef` without aborting what it replaced.
   * Two device flows then polled and wrote `credentials.json` over each other, and the loser kept
   * running with nothing left to receive it. The invariant is one attempt at a time.
   */
  it("a double-pressed retry starts exactly ONE activation (no two device flows racing the credential store)", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let started = 0;
    let release: (() => void) | undefined;
    const onCommunityAuth = vi.fn(async () => {
      started += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      if (started === 1) {
        inFlight -= 1;
        return { ok: false as const, reason: "unreachable" as const };
      }
      // The retry hangs, so a second concurrent attempt would be observable rather than serialized.
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      inFlight -= 1;
      return { ok: false as const, reason: "unreachable" as const };
    });
    const a = await toPlan({ onCommunityAuth });
    a.stdin.write("2");
    await settle(40);
    a.stdin.write("\r");
    await settle();
    a.stdin.write("a"); // accept the Engine agreement
    await settle();
    expect(started).toBe(1);

    a.stdin.write("1"); // retry
    a.stdin.write("1"); // ...and again, before the first retry can finish
    await settle(60);
    expect(started).toBe(2);
    expect(maxInFlight).toBe(1);
    release?.();
    await settle();
  });

  it("aborting, then retrying, does not leave the cancelled attempt able to clobber the new one", async () => {
    const signals: AbortSignal[] = [];
    let attempt = 0;
    const onCommunityAuth = vi.fn(
      (_onProgress: (p: never) => void, signal: AbortSignal) =>
        new Promise<{ ok: false; reason: "cancelled" }>((resolve) => {
          attempt += 1;
          signals.push(signal);
          signal.addEventListener("abort", () => resolve({ ok: false, reason: "cancelled" }));
        })
    );
    const a = await toPlan({ onCommunityAuth: onCommunityAuth as never });
    a.stdin.write("2");
    await settle(40);
    a.stdin.write("\r");
    await settle();
    a.stdin.write("a"); // accept the Engine agreement
    await settle();
    a.stdin.write("\u001B"); // Esc → abort attempt 1, land on failed
    await settle();
    expect(attempt).toBe(1);

    a.stdin.write("1"); // retry → a NEW controller, and the old one stays aborted
    await settle();
    expect(attempt).toBe(2);
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
    a.stdin.write("\u001B");
    await settle();
  });

  /**
   * FINDING 1 — the Ready screen must not announce a capability the gateway will refuse. The
   * activation implementation reports the posture the NEXT TURN will have; the screen renders it and
   * names what is missing, without turning that into a prompt to change plan.
   */
  it("ready keeps Community results compact when full apply has a pending gate", async () => {
    const onCommunityAuth = vi.fn(async () => ({
      ok: true as const,
      alreadyLoggedIn: false,
      effectiveMode: "basic" as const,
      fullApplyPendingReason: FULL_APPLY_PENDING_REASONS.optimizationMode
    }));
    const a = await toPlan({ onCommunityAuth });
    a.stdin.write("2");
    await settle(40);
    a.stdin.write("\r");
    await settle();
    a.stdin.write("a");
    await settle();
    const ready = a.lastFrame() ?? "";
    expect(ready).toContain("Community active");
    expect(ready).toContain("Compaction is ready");
    expect(ready).not.toContain("Input compaction enabled");
    expect(ready).not.toContain("Input + output token reduction ·");
    expect(ready).not.toContain("Illustrative examples, not your activity:");
    expect(ready).not.toContain("Per turn");
    expect(ready).not.toContain(FULL_APPLY_PENDING_REASONS.optimizationMode);
    expect(ready).not.toContain(FULL_APPLY_REQUIREMENT_LINE);
  });

  it("Esc during a long approval ABORTS the poll (the signal fires) instead of leaving the user stuck", async () => {
    let aborted = false;
    const onCommunityAuth = vi.fn(
      (_onProgress: (p: never) => void, signal: AbortSignal) =>
        new Promise<{ ok: false; reason: "cancelled" }>((resolve) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            resolve({ ok: false, reason: "cancelled" });
          });
        })
    );
    const a = await toPlan({ onCommunityAuth: onCommunityAuth as never });
    a.stdin.write("2");
    await settle(40);
    a.stdin.write("\r");
    await settle();
    a.stdin.write("a"); // accept the Engine agreement
    await settle();
    expect(aborted).toBe(false);
    a.stdin.write("\u001B"); // Esc
    await settle();
    expect(aborted).toBe(true);
    expect(a.lastFrame() ?? "").toContain("Cancelled.");
  });

  it("Ctrl-C during a long approval aborts the poll too (not just an unmount that would leak the request)", async () => {
    let aborted = false;
    const onCommunityAuth = vi.fn(
      (_onProgress: (p: never) => void, signal: AbortSignal) =>
        new Promise<{ ok: false; reason: "cancelled" }>((resolve) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            resolve({ ok: false, reason: "cancelled" });
          });
        })
    );
    const a = await toPlan({ onCommunityAuth: onCommunityAuth as never });
    a.stdin.write("2");
    await settle(40);
    a.stdin.write("\r");
    await settle();
    a.stdin.write("a"); // accept the Engine agreement
    await settle();
    a.stdin.write("\u0003"); // Ctrl-C
    await settle();
    expect(aborted).toBe(true);
  });

  it("with NO activation implementation injected, Community is not offered at all (never a choice that cannot work)", async () => {
    const a = await toPlan({ onCommunityAuth: null });
    const plan = plain(a.lastFrame());
    expect(plan).toContain("› Open");
    expect(plan).not.toContain("Community (recommended)");
  });

  it("with NO waitlist handoff injected, Pro is not offered at all (the same rule, applied to Pro)", async () => {
    const a = await toPlan({ onOpenWaitlist: null });
    const plan = plain(a.lastFrame());
    expect(plan).toContain("› Open");
    expect(plan).toContain("Community (recommended)");
    expect(plan).not.toContain("Pro · waitlist");
    expect(plan).not.toContain("1/2/3");
  });

  it("selecting Pro opens the canonical waitlist URL and creates no entitlement", async () => {
    const onOpenWaitlist = vi.fn(async () => "https://example.test/waitlist?plan=pro");
    const onPersistPlan = vi.fn(async () => "basic" as const);
    const onCommunityAuth = vi.fn(async () => ({ ok: true as const, alreadyLoggedIn: false, effectiveMode: "basic" as const }));
    const a = await toPlan({ onOpenWaitlist, onPersistPlan, onCommunityAuth });
    a.stdin.write("3"); // Pro
    await settle();
    expect(plain(a.lastFrame())).toContain("Enter Join Pro waitlist");
    a.stdin.write("\r"); // plan confirmation → setup → waitlist
    await settle();
    // ROUTED TO THE WAITLIST, NOT TO ACTIVATION. Choosing Pro must never start a device-code flow:
    // that would register the device to a Community account nobody asked for.
    expect(onOpenWaitlist).toHaveBeenCalledTimes(1);
    expect(onCommunityAuth).not.toHaveBeenCalled();
    // The plan the TUI reports is the one the user picked — no quiet rewrite to "open".
    expect(onPersistPlan).toHaveBeenCalledWith("pro");
    const waitlist = a.lastFrame() ?? "";
    expect(waitlist).toContain("Join the Pro waitlist");
    // The URL is rendered whether or not a browser appeared: `openBrowser` is fire-and-forget and a
    // headless shell gets nothing, so the link is the only thing that always works.
    expect(waitlist).toContain("https://example.test/waitlist?plan=pro");
    expect(waitlist).toContain("No Pro entitlement was created");
    expect(waitlist).toContain("Open output token reduction");
    expect(waitlist).not.toMatch(/Full optimization|Output shaping|basic shaping|full apply/i);
  });

  it("the Pro handoff builds no URL of its own — it renders exactly what the seam returned", async () => {
    // The one Pro path lives in `compaction upgrade`'s resolver. If the TUI ever grew its own
    // builder, this override would stop being honored and a second Pro destination would exist.
    const onOpenWaitlist = vi.fn(async () => "https://staging.example.test/wl?plan=pro&from=init");
    const a = await toPlan({ onOpenWaitlist });
    a.stdin.write("3");
    await settle();
    a.stdin.write("\r");
    await settle();
    expect(a.lastFrame() ?? "").toContain("https://staging.example.test/wl?plan=pro&from=init");
  });

  it("O opens the waitlist again, Enter continues, and numeric controls do nothing", async () => {
    const onOpenWaitlist = vi.fn(async () => "https://example.test/waitlist?plan=pro");
    const a = await toPlan({ onOpenWaitlist });
    a.stdin.write("3");
    await settle();
    a.stdin.write("\r");
    await settle();
    expect(onOpenWaitlist).toHaveBeenCalledTimes(1);
    a.stdin.write("1");
    await settle();
    expect(onOpenWaitlist).toHaveBeenCalledTimes(1);
    expect(a.lastFrame() ?? "").toContain("Join the Pro waitlist");
    a.stdin.write("2");
    await settle();
    expect(a.lastFrame() ?? "").toContain("Join the Pro waitlist");
    a.stdin.write("O");
    await settle();
    expect(onOpenWaitlist).toHaveBeenCalledTimes(2);
    a.stdin.write("\r");
    await settle();
    // A NON-PRO STATE THAT WORKS. The enable and the Open floor already landed before this screen,
    // so continuing past a browser that never opened lands on the normal healthy Ready screen.
    expect(a.lastFrame() ?? "").not.toContain("Join the Pro waitlist");
    expect(a.lastFrame() ?? "").toContain("Compaction is ready");
    expect(a.lastFrame() ?? "").not.toContain("Illustrative examples, not your activity:");
  });

  it("Esc on the waitlist screen finishes the setup that already landed", async () => {
    // THE SCREEN'S OWN FIRST LINE is "Your setup is already complete", and it is true: `doEnable` has
    // installed the workflow, persisted the mode and the Open floor, and filled `finalEnabled` before
    // this screen ever renders. `q` used to fall through to the global quit branch and report
    // `completed: false, quit: true, enabled: []` — telling the user no workflow was enabled while
    // their workflow sat installed on disk, and contradicting the line above their cursor.
    //
    // The Pro handoff is a browser tab, not a step of the setup. Leaving it is finishing.
    const onEnable = vi.fn(async (): Promise<EnableResult> => ({ connected: ["claude"], failed: [] }));
    const onOpenWaitlist = vi.fn(async () => "https://example.test/waitlist?plan=pro");
    let done: OnboardingResult | null = null;
    const a = await toPlan({ onEnable, onOpenWaitlist, onDone: (r) => (done = r) });
    a.stdin.write("3"); // Pro
    await settle();
    a.stdin.write("\r"); // plan confirmation → setup → waitlist
    await settle();
    expect(a.lastFrame() ?? "").toContain("Join the Pro waitlist");
    expect(onEnable).toHaveBeenCalledTimes(1);

    a.stdin.write("\u001B");
    await settle();
    const r = done as unknown as OnboardingResult;
    expect(r.quit).toBe(false);
    expect(r.completed).toBe(true);
    // The work that actually happened is reported, not erased.
    expect(r.enabled).toEqual(["claude"]);
  });

  it("Ctrl-C on the waitlist screen finishes it too — the same decision, a different key", async () => {
    const onEnable = vi.fn(async (): Promise<EnableResult> => ({ connected: ["claude"], failed: [] }));
    const onOpenWaitlist = vi.fn(async () => "https://example.test/waitlist?plan=pro");
    let done: OnboardingResult | null = null;
    const a = await toPlan({ onEnable, onOpenWaitlist, onDone: (r) => (done = r) });
    a.stdin.write("3");
    await settle();
    a.stdin.write("\r");
    await settle();
    a.stdin.write("\u0003"); // Ctrl-C
    await settle();
    const r = done as unknown as OnboardingResult;
    expect(r.completed).toBe(true);
    expect(r.quit).toBe(false);
    expect(r.enabled).toEqual(["claude"]);
  });

  it("a waitlist handoff that THROWS still lands the user on Ready (a browser is never a blocker)", async () => {
    const onOpenWaitlist = vi.fn(async () => {
      throw new Error("no opener on this host");
    });
    const onPersistPlan = vi.fn(async () => "basic" as const);
    const a = await toPlan({ onOpenWaitlist, onPersistPlan });
    a.stdin.write("3");
    await settle();
    a.stdin.write("\r");
    await settle();
    // The Open floor was still persisted, and the run did not stall on a screen with nothing to show.
    expect(onPersistPlan).toHaveBeenCalledWith("pro");
    expect(a.lastFrame() ?? "").not.toContain("Join the Pro waitlist");
    expect(a.lastFrame() ?? "").toContain("Compaction is ready");
  });

  it("Open and Community are untouched by the third option: neither routes to the waitlist", async () => {
    const onOpenWaitlist = vi.fn(async () => "https://example.test/waitlist?plan=pro");
    const onCommunityAuth = vi.fn(async () => ({ ok: true as const, alreadyLoggedIn: false, effectiveMode: "basic" as const }));

    // Open (default selection) → Ready, no handoff, no activation.
    const open = await toPlan({ onOpenWaitlist, onCommunityAuth });
    open.stdin.write("\r");
    await settle();
    expect(onOpenWaitlist).not.toHaveBeenCalled();
    expect(onCommunityAuth).not.toHaveBeenCalled();

    // Community → activation, still no handoff.
    const community = await toPlan({ onOpenWaitlist, onCommunityAuth });
    community.stdin.write("2");
    await settle();
    community.stdin.write("\r");
    await settle();
    community.stdin.write("a"); // accept the Engine agreement
    await settle();
    expect(onCommunityAuth).toHaveBeenCalledTimes(1);
    expect(onOpenWaitlist).not.toHaveBeenCalled();
  });

  it("a device that is already signed in is labeled as signed in — not as Community active without a lease", async () => {
    const a = await toPlan({ signedIn: true, communityAuthorized: false });
    a.stdin.write("2"); // highlight Community
    await settle(40);
    const frame = plain(a.lastFrame());
    expect(frame).toContain("Community (recommended) · signed in");
    expect(frame).not.toContain("Community active");
  });

  it("a device with a valid Community lease is labeled Community active", async () => {
    const a = await toPlan({ signedIn: true, communityAuthorized: true });
    a.stdin.write("2"); // highlight Community
    await settle(40);
    const frame = plain(a.lastFrame());
    expect(frame).toContain("Community (recommended) · Community active");
  });

  it("the Engine agreement is its own screen on the Community path, and ONLY `a` accepts it", async () => {
    // A FRESH DEVICE, EXPLICITLY. Acceptance is recorded per config dir, and the hermetic setup file
    // gives the whole test FILE one dir — so by the time this test runs, an earlier Community test
    // has already accepted and the screen would never appear. The isolation has to be per-test here
    // or the assertion silently measures nothing.
    const configDir = mkdtempSync(join(tmpdir(), "eula-screen-"));
    const previous = process.env.COMPACTION_CONFIG_DIR;
    process.env.COMPACTION_CONFIG_DIR = configDir;
    try {
      const onCommunityAuth = vi.fn(async () => ({
        ok: true as const,
        alreadyLoggedIn: false,
        effectiveMode: "full" as const
      }));
      const a = await toPlan({ onCommunityAuth });
      a.stdin.write("2"); // Community
      await settle(40);
      a.stdin.write("\r"); // plan confirmation → agreement, before acquisition
      await settle();

      const licence = plain(a.lastFrame() ?? "");
      expect(licence).toContain("Compaction Engine License Agreement");
      expect(licence).toContain("a Accept ← Back Esc Exit");
      expect(onCommunityAuth, "nothing may be acquired before the agreement is accepted").not.toHaveBeenCalled();

      // ENTER IS THE KEY EVERY PRECEDING SCREEN ADVANCED ON. If it accepted here too, agreeing to a
      // licence would be the side effect of continuing rather than a decision, which is the whole
      // reason the agreement got a screen of its own. So it must do nothing at all.
      a.stdin.write("\r");
      await settle();
      expect(onCommunityAuth, "Enter must not stand in for agreement").not.toHaveBeenCalled();
      expect(plain(a.lastFrame() ?? "")).toContain("Compaction Engine License Agreement");

      a.stdin.write("\u001b[D");
      await settle();
      expect(plain(a.lastFrame() ?? "")).toContain("Choose your plan");
      a.stdin.write("\r");
      await settle();
      expect(plain(a.lastFrame() ?? "")).toContain("Compaction Engine License Agreement");

      a.stdin.write("a");
      await settle();
      expect(onCommunityAuth).toHaveBeenCalledTimes(1);
    } finally {
      if (previous === undefined) delete process.env.COMPACTION_CONFIG_DIR;
      else process.env.COMPACTION_CONFIG_DIR = previous;
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it("Esc exits the Engine agreement without accepting or activating", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "eula-exit-"));
    const previous = process.env.COMPACTION_CONFIG_DIR;
    process.env.COMPACTION_CONFIG_DIR = configDir;
    try {
      const onCommunityAuth = vi.fn(async () => ({
        ok: true as const,
        alreadyLoggedIn: false,
        effectiveMode: "full" as const
      }));
      let done: OnboardingResult | null = null;
      const a = await toPlan({ onCommunityAuth, onDone: (result) => { done = result; } });
      a.stdin.write("2");
      await settle(40);
      a.stdin.write("\r");
      await settle();
      a.stdin.write("\u001B");
      await settle();
      expect(onCommunityAuth).not.toHaveBeenCalled();
      expect((done as unknown as OnboardingResult).quit).toBe(true);
      expect((done as unknown as OnboardingResult).completed).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.COMPACTION_CONFIG_DIR;
      else process.env.COMPACTION_CONFIG_DIR = previous;
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});
