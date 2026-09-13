import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import { render } from "ink-testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  App,
  type OnboardingResult,
  type OnboardingAppProps
} from "../../src/cli/onboarding/OnboardingTui.js";
import { READY_METRIC_NO_DATA_LINE } from "../../src/cli/onboarding/ready-metrics.js";
import { FULL_APPLY_PENDING_REASONS, FULL_APPLY_REQUIREMENT_LINE } from "../../src/cli/onboarding/model.js";
import type {
  ConnectDetection,
  ReadyToolKey,
  EnableResult,
  OptimizationModeKey,
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
  cursor: "found"
};

const HEALTHY_STATUS: OnboardingReadyStatus = {
  healthy: true,
  headline: "Compaction is active for Claude Code",
  launcher: "active · fail-open",
  gateway: "running (http://127.0.0.1:8787)",
  auth: "subscription / plan auth (output shaping; input compaction needs an API key)"
};

const NO_DATA_METRIC = { state: "no-data" as const, line: READY_METRIC_NO_DATA_LINE, recordedRuns: 0 };

const mounted: Array<{ unmount: () => void }> = [];
afterEach(() => {
  for (const m of mounted.splice(0)) m.unmount();
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
  hookDisclosure?: OnboardingAppProps["hookDisclosure"];
  readyStatusFor?: OnboardingAppProps["readyStatusFor"];
  readyMetric?: OnboardingAppProps["readyMetric"];
  readyRouting?: OnboardingAppProps["readyRouting"];
  onDone?: (r: OnboardingResult) => void;
}
function mount(opts: MountOpts = {}) {
  const props: OnboardingAppProps = {
    version: "9.9.9",
    detection: opts.detection ?? foundDetection,
    ...(opts.readyRouting ? { readyRouting: opts.readyRouting } : {}),
    readyMetric: opts.readyMetric ?? NO_DATA_METRIC,
    readyStatusFor: opts.readyStatusFor ?? (async () => HEALTHY_STATUS),
    onEnable: opts.onEnable ?? (async () => ({ connected: ["claude-code"], failed: [] })),
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
    ...(opts.hookDisclosure ? { hookDisclosure: opts.hookDisclosure } : {}),
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
    expect(frame).toContain("Choose the workflows you want to connect.");
    expect(frame).toContain("All detected tools are selected by default");
    expect(frame).toContain("Claude Code");
    expect(frame).toContain("Codex CLI");
    expect(frame).toContain("Cursor");
    expect(frame.match(/\[x\]/g)).toHaveLength(3);
    expect(frame).toContain("Space select/deselect");
    expect(frame).not.toMatch(/\b1\. Claude Code|1\/2\/3 · Enter continue/);
    // Rendering discovery/target writes nothing.
    expect(onEnable).not.toHaveBeenCalled();
    // No overclaim on the first screen.
    expect(frame).not.toMatch(/-?\d+%/);
    expect(frame).not.toMatch(/billing-confirmed|cost saved|\$/i);
  });

  it("preselects every detected tool and enables the selected found set only after explicit confirmation", async () => {
    const onEnable = vi.fn(async (keys: ReadyToolKey[]): Promise<EnableResult> => ({ connected: keys, failed: [] }));
    const a = mount({ onEnable, onCommunityAuth: null });
    await settle();
    a.stdin.write("\r"); // selected set → mode
    await settle();
    a.stdin.write("\r"); // mode → plan
    await settle();
    a.stdin.write("\r"); // plan → review
    await settle();
    expect(onEnable).not.toHaveBeenCalled();
    expect(a.lastFrame() ?? "").toContain("Enable Compaction for the selected tools?");
    a.stdin.write("\r"); // explicit confirmation = first write
    await settle();
    expect(onEnable).toHaveBeenCalledTimes(1);
    expect(onEnable).toHaveBeenCalledWith(["claude-code", "codex", "cursor"]);
    const ready = a.lastFrame() ?? "";
    for (const tool of ["Claude Code", "Codex", "Cursor"]) expect(ready).toContain(`✓ ${tool}`);
  });

  it("counts selected ready tools without reinstalling and discloses preference writes before confirmation", async () => {
    const onEnable = vi.fn(async (): Promise<EnableResult> => ({ connected: [], failed: [] }));
    const onPersistMode = vi.fn(async (): Promise<void> => {});
    const onPersistPlan = vi.fn(async (): Promise<"basic"> => "basic");
    const a = mount({
      detection: { claude: { detected: true, sessionCount: 1, hookReady: true }, codex: "active", cursor: "active" },
      onEnable,
      onPersistMode,
      onPersistPlan,
      onCommunityAuth: null
    });
    await settle();
    for (const key of ["\r", "\r", "\r"]) {
      a.stdin.write(key);
      await settle();
    }
    expect(onEnable).not.toHaveBeenCalled();
    expect(onPersistMode).not.toHaveBeenCalled();
    expect(onPersistPlan).not.toHaveBeenCalled();
    const review = plain(a.lastFrame());
    expect(review).toContain("Confirm settings for the selected ready tools?");
    expect(review).toContain('remember "Output only" as the device-wide preference for future runs');
    expect(review).toContain("set your mode to basic shaping");
    expect(review).toContain("No launcher or hook bundle will be reinstalled");
    a.stdin.write("\r");
    await settle();
    expect(onEnable).not.toHaveBeenCalled();
    expect(onPersistMode).toHaveBeenCalledWith("cache-optimize", ["claude-code", "codex", "cursor"]);
    expect(onPersistPlan).toHaveBeenCalledWith("open");
    const ready = a.lastFrame() ?? "";
    for (const tool of ["Claude Code", "Codex", "Cursor"]) expect(ready).toContain(`✓ ${tool}`);
  });

  it("ready-only Full + Cursor discloses the device-wide preference and Cursor's Output-only effective mode", async () => {
    const onEnable = vi.fn(async (): Promise<EnableResult> => ({ connected: [], failed: [] }));
    const onPersistMode = vi.fn(async (): Promise<void> => {});
    const a = mount({
      detection: { claude: { detected: false, sessionCount: 0 }, codex: "active", cursor: "active" },
      onEnable,
      onPersistMode,
      onCommunityAuth: null
    });
    await settle();
    a.stdin.write("\r"); // selected ready Codex + Cursor → mode
    await settle();
    a.stdin.write("2"); // Full
    await settle(40);
    a.stdin.write("\r"); // → plan
    await settle();
    a.stdin.write("\r"); // → review
    await settle();
    const review = plain(a.lastFrame());
    expect(review).toContain('remember "Full optimization" as the device-wide preference for future runs');
    expect(review).toContain('Full optimization applies only where supported; Cursor remains "Output only"');
    expect(onEnable).not.toHaveBeenCalled();
    expect(onPersistMode).not.toHaveBeenCalled();
    a.stdin.write("\r");
    await settle();
    expect(onEnable).not.toHaveBeenCalled();
    expect(onPersistMode).toHaveBeenCalledWith("cache-context-optimize", ["codex", "cursor"]);
  });

  it("respects deselection: a detected found tool is neither enabled nor listed ready", async () => {
    const onEnable = vi.fn(async (keys: ReadyToolKey[]): Promise<EnableResult> => ({ connected: keys, failed: [] }));
    const a = mount({ onEnable, onCommunityAuth: null });
    await settle();
    a.stdin.write("\u001b[B"); // Codex row
    await settle(20);
    a.stdin.write(" "); // deselect Codex
    a.stdin.write("\r");
    await settle();
    for (const key of ["\r", "\r", "\r"]) {
      a.stdin.write(key);
      await settle();
    }
    expect(onEnable).toHaveBeenCalledWith(["claude-code", "cursor"]);
    const ready = a.lastFrame() ?? "";
    expect(ready).toContain("✓ Claude Code");
    expect(ready).toContain("✓ Cursor");
    expect(ready).not.toContain("✓ Codex");
    expect(ready).toContain("Codex CLI");
    expect(plain(ready)).toContain("remain untouched until you connect them by name");
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
    expect(a.lastFrame() ?? "").toContain("Choose the workflows you want to connect.");
    expect(onEnable).not.toHaveBeenCalled();
    expect(onPersistMode).not.toHaveBeenCalled();
    expect(onPersistPlan).not.toHaveBeenCalled();
  });

  it("Claude path: target → mode → review → (real onEnable + onPersistMode) → ready; onEnable called ONCE", async () => {
    const onEnable = vi.fn(async (_keys: ReadyToolKey[]): Promise<EnableResult> => ({ connected: ["claude-code"], failed: [] }));
    const onPersistMode = vi.fn(async (_m: OptimizationModeKey): Promise<void> => {});
    let done: OnboardingResult | null = null;
    const a = mount({ onEnable, onPersistMode, onDone: (r) => (done = r) });
    await settle();

    // Keep only Claude Code selected, then continue to the mode screen.
    await selectOnly(a, "claude-code");
    expect(a.lastFrame() ?? "").toContain("Choose how Compaction should optimize Claude Code.");
    expect(onEnable).not.toHaveBeenCalled(); // navigating target/mode wrote nothing

    // Mode: default is "Output only" (recommended). Enter → review.
    expect(a.lastFrame() ?? "").toContain("Output only");
    expect(a.lastFrame() ?? "").toContain("Full optimization");
    a.stdin.write("\r");
    await settle();

    // Plan: the TWO free options. Open is the default; nothing has been written yet.
    const plan = a.lastFrame() ?? "";
    expect(plan).toContain("Choose how Compaction runs for you. Open and Community are free; Pro is a waitlist.");
    expect(plan).toContain("Open");
    expect(plan).toContain("Community");
    expect(plan).toContain("Nothing is written until you confirm on the next screen.");
    expect(onEnable).not.toHaveBeenCalled();
    a.stdin.write("\r");
    await settle();
    const review = a.lastFrame() ?? "";
    expect(review).toContain("Enable Compaction for Claude Code?");
    expect(review).toContain("install a reversible, fail-open launcher/shim");
    expect(review).toContain("› Enable Compaction");
    expect(onEnable).not.toHaveBeenCalled(); // review wrote nothing

    // Review: Enter is the FIRST write, the real installers + mode persistence.
    a.stdin.write("\r");
    await settle();
    expect(onEnable).toHaveBeenCalledTimes(1);
    expect(onEnable).toHaveBeenCalledWith(["claude-code"]);
    expect(onPersistMode).toHaveBeenCalledTimes(1);
    // "Output only" maps to the existing cache-optimize key.
    expect(onPersistMode).toHaveBeenCalledWith("cache-optimize", ["claude-code"]);

    const ready = a.lastFrame() ?? "";
    expect(ready).toContain("Plan       Open (no account)");
    expect(ready).toContain("Per turn   basic shaping");
    expect(ready).toContain("Compaction is active for Claude Code");
    expect(ready).toContain("Launcher   active · fail-open");
    expect(ready).toContain("Gateway    running");
    expect(ready).toContain("Auth       subscription / plan auth");

    // Enter finishes.
    a.stdin.write("\r");
    await settle();
    expect(done).not.toBeNull();
    expect((done as unknown as OnboardingResult).completed).toBe(true);
    expect((done as unknown as OnboardingResult).enabled).toEqual(["claude-code"]);
    expect((done as unknown as OnboardingResult).mode).toBe("cache-optimize");
  });

  it("METRICS HONESTY: at first install the ready screen shows the unavailable-until-measured state, never a fake number", async () => {
    const a = mount({ readyMetric: NO_DATA_METRIC });
    await settle();
    await selectOnly(a, "claude-code");
    a.stdin.write("\r"); // mode → plan
    await settle();
    a.stdin.write("\r"); // plan (Open, default) → review
    await settle();
    a.stdin.write("\r"); // review → enable → ready
    await settle();
    const ready = a.lastFrame() ?? "";
    expect(ready).toContain("unavailable until measured");
    expect(ready).toContain("Measured activity (none yet)");
    // The forbidden simulated figure must never appear ANYWHERE (a fabricated measured savings figure).
    expect(ready).not.toContain("out -45%");
    expect(ready).not.toContain("742→408");

    // The MEASURED-ACTIVITY region (up to the per-turn receipt-line description below it) must carry no
    // number/percentage/dollar figure, it is the honest unavailable-until-measured state, never a
    // fabricated figure. The canonical receipt-line EXAMPLE that follows is a labeled illustration of the
    // print format (it legitimately shows the apply value clause `−$0.14 (est)` — a labeled estimate); the
    // guard applies to the measured region only.
    const measuredRegion = ready.slice(
      ready.indexOf("Measured activity"),
      ready.indexOf("After each turn")
    );
    expect(measuredRegion.length).toBeGreaterThan(0);
    expect(measuredRegion).not.toMatch(/[−-]?\d+%/);
    expect(measuredRegion).not.toMatch(/\$\d/);
    // And the per-turn description IS present and honest, and TOOL-SCOPED: with only Claude Code
    // enabled it shows Claude Code's lines and NOT the Cursor session-level-only line; it never
    // attaches a percentage to output.
    expect(ready).toContain("After each turn you'll see one content-free receipt line:");
    expect(ready).toMatch(/Claude Code \(Gateway route\)/);
    expect(ready).toMatch(/Claude Code \(hook only, no Gateway\)/);
    expect(ready).not.toMatch(/Cursor: no inline line/);
    expect(ready).not.toMatch(/output[^\n·]*%/);
  });

  /**
   * THE PER-TURN BLOCK ON THE READY SCREEN FOLLOWS THE CONFIRMED HOOK STATE.
   *
   * `readyPerTurnLinesForTools` used to take only the enabled set, so the Codex block asserted "hook
   * installed" for every enable — including one whose hook install was refused, failed its verify
   * re-read, or never ran because shaping is switched off. `onEnable` already reports what it CONFIRMED
   * on disk (`shapingHooksInstalled`); this pins that the screen actually consumes it.
   */
  async function readyFrameFor(shapingHooksInstalled: ReadyToolKey[]): Promise<string> {
    const a = mount({
      onEnable: async (): Promise<EnableResult> => ({ connected: ["codex"], failed: [], shapingHooksInstalled })
    });
    await settle();
    await selectOnly(a, "codex");
    for (const key of ["\r", "\r", "\r", "\r"]) {
      a.stdin.write(key);
      await settle();
    }
    return a.lastFrame() ?? "";
  }

  it("hooks CONFIRMED ⇒ the Codex per-turn block says the hook is installed", async () => {
    const ready = await readyFrameFor(["codex"]);
    expect(ready).toContain("hook installed");
    expect(ready).not.toContain("NOT confirmed on disk");
  });

  it("hooks NOT confirmed ⇒ the SAME screen must not claim the hook (no contradiction with the routing lines)", async () => {
    const ready = await readyFrameFor([]);
    expect(ready).not.toContain("hook installed");
    expect(ready).toContain("NOT confirmed on disk");
    // The routing subsection beside it says the same thing from the same axis; that pairing is pinned
    // against real on-disk state in init-ready-summary-hook-state.test.ts (this mount injects no
    // `readyRouting`, so the routing lines are absent here rather than contradicting).
    expect(ready).not.toContain("attached before generation");
  });

  it("fresh Codex hooks configured on disk remain distinct from native-active across both Ready sections", async () => {
    const a = mount({
      readyRouting: {
        matrix: [],
        providerCaps: [],
        routeCommands: { codex: "compaction gateway run -- codex" },
        codexShapingState: "not-installed"
      },
      onEnable: async (): Promise<EnableResult> => ({
        connected: ["codex"],
        failed: [],
        shapingHooksInstalled: [],
        codexShapingState: "configured"
      })
    });
    await settle();
    await selectOnly(a, "codex");
    for (const key of ["\r", "\r", "\r", "\r"]) {
      a.stdin.write(key);
      await settle();
    }
    const ready = plain(a.lastFrame());
    expect(ready).toContain("output shaping is configured for Codex");
    expect(ready).toContain("hooks are configured on disk");
    expect(ready).toContain("depends on its one-time hook approval");
    expect(ready).toContain("do not need reinstalling");
    expect(ready).not.toContain("NOT confirmed on disk");
    expect(ready).not.toContain("Install or retry them");
    expect(ready).not.toContain("a concise-response instruction is attached before generation");
  });

  it("Full optimization maps to the existing cache-context-optimize key (input side gated on an API key)", async () => {
    const onPersistMode = vi.fn(async (_m: OptimizationModeKey): Promise<void> => {});
    const a = mount({ onPersistMode });
    await settle();
    await selectOnly(a, "claude-code");
    a.stdin.write("2"); // choose "Full optimization"
    await settle(40);
    a.stdin.write("\r"); // → plan
    await settle();
    a.stdin.write("\r"); // plan (Open, default) → review
    await settle();
    expect(a.lastFrame() ?? "").toContain("Enable Compaction for Claude Code?");
    a.stdin.write("\r"); // enable
    await settle();
    expect(onPersistMode).toHaveBeenCalledWith("cache-context-optimize", ["claude-code"]);
  });

  /**
   * THE DEAD END THIS REPLACES. `limited` used to be a TERMINAL screen: its only affordance was
   * "Press Enter to go back", so a user whose current workflow was Codex or Cursor could never
   * complete setup at all. The pin is REWRITTEN rather than deleted — the no-write half of the old
   * assertion still holds (the screen is informational), and the forward half is now the point.
   */
  it("Cursor path: target → limited is a FORWARD step (never a dead end), and still writes nothing", async () => {
    const onEnable = vi.fn(async (): Promise<EnableResult> => ({ connected: [], failed: [] }));
    const a = mount({ onEnable });
    await settle();
    await selectOnly(a, "cursor");
    const limited = a.lastFrame() ?? "";
    expect(limited).toContain("Cursor");
    expect(limited).toContain("session-level instruction");
    // Cursor is honestly local-estimate / no-Gateway; input compaction needs a key and is not available.
    expect(limited).toContain("not available for Cursor");
    // The screen offers a way ONWARD, and no longer offers "go back" as its only outcome.
    expect(limited).toContain("Continue setting up Cursor");
    expect(limited).not.toContain("Press Enter to go back");
    expect(onEnable).not.toHaveBeenCalled();
  });

  it("Cursor path: limited → plan (mode picker SKIPPED: Cursor has one mode, so a picker would be a fake choice)", async () => {
    const a = mount();
    await settle();
    await selectOnly(a, "cursor");
    a.stdin.write("\r"); // continue
    await settle();
    const next = a.lastFrame() ?? "";
    expect(next).toContain("Choose how Compaction runs for you. Open and Community are free; Pro is a waitlist."); // the PLAN screen
    expect(next).not.toContain("Choose how Compaction should optimize");
  });

  it("Cursor path: back from plan returns to `limited` (the forward step stays reachable, not one-way)", async () => {
    const a = mount();
    await settle();
    await selectOnly(a, "cursor");
    a.stdin.write("\r"); // limited → plan
    await settle();
    a.stdin.write(""); // Esc → back
    await settle();
    const back = a.lastFrame() ?? "";
    expect(back).toContain("Continue setting up Cursor");
    // And back again reaches the workflow list, so nothing is stranded.
    a.stdin.write("");
    await settle();
    expect(a.lastFrame() ?? "").toContain("Choose the workflows you want to connect.");
  });

  it("Cursor path: completes through review → enable → ready (a supported target can finish setup)", async () => {
    const onEnable = vi.fn(async (_keys: ReadyToolKey[]): Promise<EnableResult> => ({ connected: ["cursor"], failed: [] }));
    let done: OnboardingResult | null = null;
    const a = mount({ onEnable, onDone: (r) => (done = r), onCommunityAuth: null });
    await settle();
    await selectOnly(a, "cursor");
    a.stdin.write("\r"); // limited → plan
    await settle();
    a.stdin.write("\r"); // plan (Open) → review
    await settle();
    expect(a.lastFrame() ?? "").toContain("Enable Compaction for Cursor?");
    a.stdin.write("\r"); // enable
    await settle();
    expect(onEnable).toHaveBeenCalledTimes(1);
    expect(onEnable).toHaveBeenCalledWith(["cursor"]);
    const ready = a.lastFrame() ?? "";
    expect(ready).toContain("✓ Cursor");
    a.stdin.write("\r");
    await settle();
    expect(done).not.toBeNull();
    expect((done as unknown as OnboardingResult).completed).toBe(true);
    expect((done as unknown as OnboardingResult).enabled).toEqual(["cursor"]);
  });

  it("Codex limited screen names the API-key path for full optimization (subscription = output shaping only)", async () => {
    const a = mount();
    await settle();
    await selectOnly(a, "codex");
    const limited = a.lastFrame() ?? "";
    expect(limited).toContain("Codex CLI");
    expect(limited).toContain("ChatGPT plan or an OpenAI API key");
    expect(limited).toContain("full optimization");
    expect(limited).not.toMatch(/\$\d/); // no dollar-savings claim
    expect(limited).toContain("Continue setting up Codex CLI");
  });

  /**
   * Codex KEEPS the mode screen: it is `supportsFullOptimization: true` and its own limited copy
   * advertises the API-key/full-optimization path, so skipping the picker would advertise a choice and
   * then silently persist one. And the screen must name CODEX's auth — telling a Codex user that a
   * Claude subscription is how Codex authenticates is simply false.
   */
  it("Codex path: limited → mode, with per-tool copy (never Claude Code's auth), then plan → review → ready", async () => {
    const onEnable = vi.fn(async (_keys: ReadyToolKey[]): Promise<EnableResult> => ({ connected: ["codex"], failed: [] }));
    const a = mount({ onEnable, onCommunityAuth: null });
    await settle();
    await selectOnly(a, "codex");
    a.stdin.write("\r"); // limited → mode
    await settle();
    const mode = a.lastFrame() ?? "";
    expect(mode).toContain("Choose how Compaction should optimize Codex CLI.");
    expect(mode).toContain("Your ChatGPT plan (or OpenAI API key) remains how Codex authenticates.");
    expect(mode).not.toContain("Your Claude subscription");
    expect(mode).not.toContain("optimize Claude Code");
    // Back from mode lands on `limited`, not on the target list (the forward step is not one-way).
    a.stdin.write("");
    await settle();
    expect(a.lastFrame() ?? "").toContain("Continue setting up Codex CLI");
    a.stdin.write("\r"); // limited → mode again
    await settle();
    a.stdin.write("\r"); // mode → plan
    await settle();
    expect(a.lastFrame() ?? "").toContain("Choose how Compaction runs for you. Open and Community are free; Pro is a waitlist.");
    a.stdin.write("\r"); // plan → review
    await settle();
    expect(a.lastFrame() ?? "").toContain("Enable Compaction for Codex CLI?");
    a.stdin.write("\r"); // enable
    await settle();
    expect(onEnable).toHaveBeenCalledWith(["codex"]);
    expect(a.lastFrame() ?? "").toContain("✓ Codex");
  });

  /**
   * THE FIRST-WRITE DISCLOSURE. The review screen is the consent gate; a hook config that attaches an
   * instruction to what the model sees may not be written without being named there first.
   */
  it("review names the hooks file, its backup, and every entry BEFORE the write (Codex)", async () => {
    const a = mount({
      hookDisclosure: (key) =>
        key === "codex"
          ? {
              file: "/tmp/fake-home/.codex/hooks.json",
              backupPath: "/tmp/fake-home/.codex/hooks.json.compaction.bak",
              entries: [
                { event: "UserPromptSubmit", command: "compaction hooks shape codex", effect: "attaches a concise-response instruction to what the model sees, before generation" },
                { event: "Stop", command: "compaction hooks line codex", effect: "returns settled content-free receipt evidence as `systemMessage` when recorded" }
              ]
            }
          : undefined
    });
    await settle();
    await selectOnly(a, "codex");
    a.stdin.write("\r"); // → mode
    await settle();
    a.stdin.write("\r"); // → plan
    await settle();
    a.stdin.write("\r"); // → review
    await settle();
    const review = a.lastFrame() ?? "";
    expect(review).toContain("/tmp/fake-home/.codex/hooks.json");
    expect(review).toContain("hooks.json.compaction.bak");
    expect(review).toContain("UserPromptSubmit");
    expect(review).toContain("compaction hooks shape codex");
    expect(review).toContain("compaction hooks line codex");
    expect(review).toContain("what the model sees");
  });

  it("review says NO hook config will be written when shaping is switched off (no disclosure injected)", async () => {
    const a = mount(); // no hookDisclosure → init.ts would inject none when `compaction stop` is set
    await settle();
    await selectOnly(a, "cursor");
    a.stdin.write("\r"); // → plan
    await settle();
    a.stdin.write("\r"); // → review
    await settle();
    const review = a.lastFrame() ?? "";
    expect(review).toContain("Output shaping is currently switched off");
    expect(review).not.toContain("hooks.json");
  });

  it("Cursor review states its effective supported mode without inventing a choice", async () => {
    const a = mount();
    await settle();
    await selectOnly(a, "cursor");
    a.stdin.write("\r"); // → plan
    await settle();
    a.stdin.write("\r"); // → review
    await settle();
    const review = a.lastFrame() ?? "";
    expect(review).toContain('effective mode for Cursor: "Output only"');
    expect(review).not.toContain("the only mode available for Cursor");
    expect(review).not.toContain("remember \"Output only\" as your default");
  });

  it("mixed Full + Cursor keeps the shared preference but renders Cursor's effective mode as Output only", async () => {
    const onPersistMode = vi.fn(async (): Promise<void> => {});
    const onEnable = vi.fn(async (keys: ReadyToolKey[]): Promise<EnableResult> => ({ connected: keys, failed: [] }));
    const a = mount({ onEnable, onPersistMode, onCommunityAuth: null });
    await settle();
    a.stdin.write("\r"); // all detected selected → mode
    await settle();
    a.stdin.write("2"); // shared Full preference
    await settle(40);
    a.stdin.write("\r"); // → plan
    await settle();
    a.stdin.write("\r"); // → review
    await settle();
    const review = plain(a.lastFrame());
    expect(review).toContain('effective mode for Cursor: "Output only"');
    expect(review).toContain('device-wide "Full optimization" preference is remembered for future runs');
    expect(review).toContain("applies only where supported");
    expect(review).not.toContain('use "Full optimization" as the default for future runs (the only mode available for Cursor)');
    a.stdin.write("\r");
    await settle();
    expect(onPersistMode).toHaveBeenCalledWith("cache-context-optimize", ["claude-code", "codex", "cursor"]);
  });

  it("ready names the OTHER detected workflows so automatic shaping is never read as covering them", async () => {
    const onEnable = vi.fn(async (): Promise<EnableResult> => ({ connected: ["cursor"], failed: [] }));
    const a = mount({ onEnable, onCommunityAuth: null });
    await settle();
    await selectOnly(a, "cursor");
    a.stdin.write("\r"); // → plan
    await settle();
    a.stdin.write("\r"); // → review
    await settle();
    a.stdin.write("\r"); // enable
    await settle();
    const ready = a.lastFrame() ?? "";
    expect(ready).toContain("Also detected, not configured:");
    expect(ready).toContain("Claude Code");
    expect(ready).toContain("Codex CLI");
    expect(plain(ready)).toContain("remain untouched until you connect them by name");
  });

  /**
   * "NOT CONFIGURED" MUST MEAN NOT CONFIGURED. `state === "ready"` is a workflow that IS connected
   * from an earlier run; listing it told a user their working Claude Code setup was unconfigured — a
   * false statement about their own machine, on the line whose entire job is scoping the
   * automatic-behavior promise honestly.
   */
  it("does NOT list an ALREADY-CONNECTED workflow as unconfigured", async () => {
    const onEnable = vi.fn(async (): Promise<EnableResult> => ({ connected: ["cursor"], failed: [] }));
    const a = mount({
      onEnable,
      onCommunityAuth: null,
      // claude READY (hook verified from a previous run) · codex FOUND · cursor FOUND.
      detection: { claude: { detected: true, sessionCount: 3, hookReady: true }, codex: "found", cursor: "found" }
    });
    await settle();
    await selectOnly(a, "cursor");
    a.stdin.write("\r"); // → plan
    await settle();
    a.stdin.write("\r"); // → review
    await settle();
    a.stdin.write("\r"); // enable
    await settle();
    const ready = a.lastFrame() ?? "";
    const uncovered = ready.slice(ready.indexOf("Also detected, not configured:"));
    expect(ready).toContain("Also detected, not configured:");
    expect(uncovered).toContain("Codex CLI");
    expect(uncovered.split("\n")[0]).not.toContain("Claude Code");
  });

  /**
   * A MODE THE USER PICKED FOR ANOTHER TOOL MUST NOT FOLLOW THEM. Choosing "Full optimization" on
   * Codex, backing out, then choosing Cursor left the index at 1 — so the review read
   * `use "Full optimization" as the default … (the only mode available for Cursor)` and the enable
   * persisted `cache-context-optimize` for a `supportsFullOptimization: false` workflow.
   */
  it("resets the mode when switching to a target that has no mode picker", async () => {
    const onPersistMode = vi.fn(async (_m: OptimizationModeKey): Promise<void> => {});
    const onEnable = vi.fn(async (): Promise<EnableResult> => ({ connected: ["cursor"], failed: [] }));
    const a = mount({ onEnable, onPersistMode, onCommunityAuth: null });
    await settle();
    await selectOnly(a, "codex");
    a.stdin.write("\r"); // limited → mode
    await settle();
    a.stdin.write("2"); // choose "Full optimization"
    await settle(40);
    a.stdin.write("\u001B"); // Esc → back to limited
    await settle();
    a.stdin.write("\u001B"); // Esc → back to the target list
    await settle();
    // Selection is Codex-only and the cursor is on Cursor: add Cursor, remove Codex.
    a.stdin.write(" ");
    await settle(20);
    a.stdin.write("\u001b[A");
    await settle(20);
    a.stdin.write(" ");
    await settle(20);
    a.stdin.write("\r");
    await settle();
    a.stdin.write("\r"); // limited → plan
    await settle();
    a.stdin.write("\r"); // plan → review
    await settle();
    const review = a.lastFrame() ?? "";
    expect(review).toContain('effective mode for Cursor: "Output only"');
    expect(review).not.toContain("Full optimization");
    a.stdin.write("\r"); // enable
    await settle();
    expect(onPersistMode).toHaveBeenCalledWith("cache-optimize", ["cursor"]);
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
      cursor: "absent" // Cursor not found
    };
    const a = mount({ detection });
    await settle();
    // Move to Cursor and try to select it; not-found is disabled, so the toggle is a no-op.
    a.stdin.write("\u001b[B");
    a.stdin.write("\u001b[B");
    a.stdin.write(" ");
    await settle();
    expect(a.lastFrame() ?? "").toContain("Choose the workflows you want to connect.");
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
    a.stdin.write("\r"); // target → mode
    await settle();
    a.stdin.write("\r"); // mode → plan
    await settle();
    a.stdin.write("\r"); // plan (Open, default) → review
    await settle();
    a.stdin.write("\r"); // enable → ready
    await settle();
    const ready = a.lastFrame() ?? "";
    expect(ready).toContain("could not be verified");
    expect(ready).toContain("Launcher   not active");
    expect(ready).not.toContain("active · fail-open");
  });
});

describe("OnboardingTui <App> - plan choice (the 'authorize' step) and Community activation", () => {
  /** target → mode → plan. Returns the harness sitting on the plan screen. */
  async function toPlan(opts: MountOpts = {}) {
    const a = mount(opts);
    await settle();
    a.stdin.write("\r"); // target → mode
    await settle();
    a.stdin.write("\r"); // mode → plan
    await settle();
    return a;
  }

  it("offers exactly THREE options — Open, Community, Pro — and no fourth", async () => {
    const a = await toPlan();
    const plan = a.lastFrame() ?? "";
    // The canonical journey names three choices. Assert the numbered ROWS, not bare words: the
    // header mentions Community and Pro by name, so a whole-frame substring proves nothing about
    // what is selectable.
    expect(plan).toContain("1. Open");
    expect(plan).toContain("2. Community");
    expect(plan).toContain("3. Pro");
    expect(plan).not.toContain("4. ");
    // TEAM IS NOT IN ONBOARDING. The canonical journey does not name it, and a fourth waitlist row
    // would be padding rather than a choice.
    expect(plan).not.toMatch(/\bTeam\b/);
    // The digit hint must match what is actually selectable, or "3" is a key that does nothing.
    expect(plan).toContain("1/2/3");
  });

  it("PRO IS A HANDOFF, NOT A SALE: the picker names no price, no purchase, and no URL", async () => {
    const a = await toPlan();
    a.stdin.write("3"); // select Pro so its effect bullets render
    await settle();
    const plan = a.lastFrame() ?? "";
    // What the option must SAY, in the words that stop the misreading: chosen ≠ bought, and
    // chosen ≠ entitled.
    const flat = plain(plan);
    expect(flat).toContain("Pro is not enabled here and no Pro entitlement is created");
    expect(flat).toContain("Nothing is purchased");
    expect(flat).toContain("no card is asked for");
    // What it must NOT say. A price or a checkout word on a waitlist row is a claim about a service
    // that cannot be bought; a URL belongs on the handoff screen, not in a picker.
    expect(plan).not.toMatch(/\$\d/);
    expect(plan).not.toMatch(/monthly|per month|checkout|subscribe/i);
    expect(plan).not.toMatch(/https?:\/\//);
    // Free is still stated for the two plans it is true of.
    expect(plan).toContain("Open and Community are free");
  });

  it("CONSENT: the Open option states what it does, what it does not do, and how to turn it off BEFORE anything is written", async () => {
    const onPersistPlan = vi.fn(async () => "basic" as const);
    const a = await toPlan({ onPersistPlan });
    // Ink hard-wraps to the terminal width, so assert on the SUBSTANCE with whitespace collapsed
    // rather than on line-exact strings (a wrap point is not a copy change).
    const plan = (a.lastFrame() ?? "").replace(/\s+/g, " ");
    // Exactly what changes: an instruction attached BEFORE generation.
    expect(plan).toContain("concise-response instruction is attached to supported requests before they are generated");

    // WHAT IT DOES NOT DO — both halves. This assertion used to pin only "Never changes the input you
    // wrote", which is true in isolation and misleading beside it: an instruction block IS added to
    // what the model sees. The consent screen has to say both, or the user reads "nothing is added to
    // my prompt".
    expect(plan).toContain("your own words are never edited");
    expect(plan, "the screen must admit the model sees more than the user typed").toContain(
      "Adds that instruction to what the model sees"
    );

    // THE REVERSAL MUST NAME A SWITCH THAT WORKS. This test previously pinned `compaction mode
    // observe` — and that command does NOT stop shaping: `decideShaping` reads only the kill switch
    // and the persisted stop-state, and nothing in the hook path reads `product_mode`. So the test was
    // actively enforcing a false statement in a consent screen. It now pins the switch that works, and
    // asserts the false one is absent so it cannot come back.
    expect(plan).toContain("compaction stop");
    expect(plan, "a consent screen must not name an off switch that does nothing").not.toContain(
      "compaction mode observe"
    );

    // And it is stated BEFORE the write: the plan screen has persisted nothing.
    expect(onPersistPlan).not.toHaveBeenCalled();
  });

  it("Open path: persists the Open floor, makes NO activation call, and the ready screen says so", async () => {
    const onPersistPlan = vi.fn(async () => "basic" as const);
    const onCommunityAuth = vi.fn(async () => ({ ok: true as const, alreadyLoggedIn: false, effectiveMode: "full" as const }));
    const a = await toPlan({ onPersistPlan, onCommunityAuth });
    a.stdin.write("\r"); // plan (Open) → review
    await settle();
    a.stdin.write("\r"); // enable
    await settle();
    expect(onPersistPlan).toHaveBeenCalledWith("open");
    expect(onCommunityAuth).not.toHaveBeenCalled();
    const ready = a.lastFrame() ?? "";
    expect(ready).toContain("Plan       Open (no account)");
    expect(ready).toContain("Per turn   basic shaping");
  });

  it("Community path: the Open floor is persisted BEFORE activation runs (an abandoned auth still leaves a working setup)", async () => {
    const calls: string[] = [];
    const onPersistPlan = vi.fn(async () => {
      calls.push("persist");
      return "basic" as const;
    });
    const onCommunityAuth = vi.fn(async () => {
      calls.push("auth");
      return { ok: true as const, alreadyLoggedIn: false, effectiveMode: "full" as const };
    });
    const a = await toPlan({ onPersistPlan, onCommunityAuth });
    a.stdin.write("2"); // choose Community
    await settle(40);
    a.stdin.write("\r"); // → review
    await settle();
    a.stdin.write("\r"); // enable → activation
    await settle();
    a.stdin.write("a"); // accept the Engine agreement
    await settle();
    expect(onPersistPlan).toHaveBeenCalledWith("community");
    expect(calls).toEqual(["persist", "auth"]);
    const ready = a.lastFrame() ?? "";
    expect(ready).toContain("Plan       Community");
    expect(ready).toContain("Per turn   full apply");
  });

  it("Community WITHOUT a lease lands on `basic`, never `observe` — a Community chooser is never left below Open", async () => {
    const onCommunityAuth = vi.fn(async () => ({
      ok: true as const,
      alreadyLoggedIn: false,
      effectiveMode: "basic" as const,
      fullApplyPendingReason: "lease-invalid"
    }));
    const a = await toPlan({ onCommunityAuth });
    a.stdin.write("2");
    await settle(40);
    a.stdin.write("\r");
    await settle();
    a.stdin.write("\r");
    await settle();
    a.stdin.write("a"); // accept the Engine agreement
    await settle();
    const ready = a.lastFrame() ?? "";
    expect(ready).toContain("Per turn   basic shaping");
    expect(ready).not.toContain("Per turn   apply off");
    // And it SAYS full apply is not on, with the content-free reason — never a silent downgrade.
    expect(ready).toContain("Full apply is not active on this device yet (lease-invalid)");
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
    await settle();
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
    expect(ready).toContain("Plan       Open (no account)");
    expect(ready).toContain("Per turn   basic shaping");
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
    a.stdin.write("\r"); // enable → activation (fails)
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
    a.stdin.write("\r"); // enable → activation (hangs)
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
  it("a pending LOCAL gate renders `basic shaping` plus what full apply requires — and no upsell", async () => {
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
    a.stdin.write("\r");
    await settle();
    a.stdin.write("a"); // accept the Engine agreement
    await settle();
    const ready = a.lastFrame() ?? "";
    expect(ready).toContain("Plan       Community");
    expect(ready).toContain("Per turn   basic shaping");
    expect(ready).not.toContain("Per turn   full apply");
    expect(ready).toContain("the optimization mode is Output only");
    expect(ready).toContain(FULL_APPLY_REQUIREMENT_LINE);
    // Informative, not a funnel. Asserted on the two lines this change adds (the surrounding screen
    // has always carried an example receipt line, which is not what is under test here).
    for (const line of [FULL_APPLY_REQUIREMENT_LINE, FULL_APPLY_PENDING_REASONS.optimizationMode]) {
      expect(line).not.toMatch(/\$\d/);
      expect(line).not.toMatch(/upgrade|purchase|buy|checkout|monthly|per month|\bPro\b|\bTeam\b/i);
      expect(line).not.toMatch(/https?:\/\//);
      // No imperative: it states a requirement, it does not ask the user to do anything.
      expect(line).not.toMatch(/\b(run|switch|choose|enable|set)\b/i);
    }
  });

  it("the requirement line is NOT shown when the gap is the entitlement (a different problem, a different sentence)", async () => {
    const onCommunityAuth = vi.fn(async () => ({
      ok: true as const,
      alreadyLoggedIn: false,
      effectiveMode: "basic" as const,
      fullApplyPendingReason: "lease-invalid"
    }));
    const a = await toPlan({ onCommunityAuth });
    a.stdin.write("2");
    await settle(40);
    a.stdin.write("\r");
    await settle();
    a.stdin.write("\r");
    await settle();
    a.stdin.write("a"); // accept the Engine agreement
    await settle();
    const ready = a.lastFrame() ?? "";
    expect(ready).toContain("Full apply is not active on this device yet (lease-invalid)");
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
    a.stdin.write("\r"); // enable → activation (hangs until aborted)
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
    const plan = a.lastFrame() ?? "";
    expect(plan).toContain("1. Open");
    // Assert the ROW, not the word: the header names Community, so a whole-frame substring would
    // fail on copy that is not a picker entry — and would have passed for the wrong reason before.
    expect(plan).not.toMatch(/\d\. Community/);
  });

  it("with NO waitlist handoff injected, Pro is not offered at all (the same rule, applied to Pro)", async () => {
    const a = await toPlan({ onOpenWaitlist: null });
    const plan = a.lastFrame() ?? "";
    expect(plan).toContain("1. Open");
    expect(plan).toContain("2. Community");
    expect(plan).not.toMatch(/\d\. Pro/);
    // And the digit hint shrinks with it — offering a key that selects nothing is the same defect.
    expect(plan).toContain("1/2");
    expect(plan).not.toContain("1/2/3");
  });

  it("selecting Pro opens the canonical waitlist URL and creates no entitlement", async () => {
    const onOpenWaitlist = vi.fn(async () => "https://example.test/waitlist?plan=pro");
    const onPersistPlan = vi.fn(async () => "basic" as const);
    const onCommunityAuth = vi.fn(async () => ({ ok: true as const, alreadyLoggedIn: false, effectiveMode: "basic" as const }));
    const a = await toPlan({ onOpenWaitlist, onPersistPlan, onCommunityAuth });
    a.stdin.write("3"); // Pro
    await settle();
    a.stdin.write("\r"); // → review
    await settle();
    // The consent screen names the handoff AND the non-write before anything lands on disk.
    const review = plain(a.lastFrame());
    expect(review).toContain("join the Pro waitlist");
    expect(review).toContain("nothing is purchased and no Pro entitlement is created");
    a.stdin.write("\r"); // enable
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
    a.stdin.write("\r");
    await settle();
    expect(a.lastFrame() ?? "").toContain("https://staging.example.test/wl?plan=pro&from=init");
  });

  it("RETRY: pressing 1 opens the waitlist again; 2 continues to a Ready state that is already valid", async () => {
    const onOpenWaitlist = vi.fn(async () => "https://example.test/waitlist?plan=pro");
    const a = await toPlan({ onOpenWaitlist });
    a.stdin.write("3");
    await settle();
    a.stdin.write("\r");
    await settle();
    a.stdin.write("\r"); // enable → waitlist screen
    await settle();
    expect(onOpenWaitlist).toHaveBeenCalledTimes(1);
    a.stdin.write("1"); // retry the browser open
    await settle();
    expect(onOpenWaitlist).toHaveBeenCalledTimes(2);
    a.stdin.write("2"); // continue
    await settle();
    // A NON-PRO STATE THAT WORKS. The enable and the Open floor already landed before this screen,
    // so continuing past a browser that never opened lands on the normal healthy Ready screen.
    expect(a.lastFrame() ?? "").not.toContain("Join the Pro waitlist");
    expect(a.lastFrame() ?? "").toContain("Launcher");
  });

  it("q on the waitlist screen FINISHES the setup that already landed — it does not report a quit", async () => {
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
    a.stdin.write("\r"); // → review
    await settle();
    a.stdin.write("\r"); // enable → waitlist screen
    await settle();
    expect(a.lastFrame() ?? "").toContain("Join the Pro waitlist");
    expect(onEnable).toHaveBeenCalledTimes(1);

    a.stdin.write("q");
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
    a.stdin.write("\r"); // enable
    await settle();
    // The Open floor was still persisted, and the run did not stall on a screen with nothing to show.
    expect(onPersistPlan).toHaveBeenCalledWith("pro");
    expect(a.lastFrame() ?? "").not.toContain("Join the Pro waitlist");
    expect(a.lastFrame() ?? "").toContain("Launcher");
  });

  it("Open and Community are untouched by the third option: neither routes to the waitlist", async () => {
    const onOpenWaitlist = vi.fn(async () => "https://example.test/waitlist?plan=pro");
    const onCommunityAuth = vi.fn(async () => ({ ok: true as const, alreadyLoggedIn: false, effectiveMode: "basic" as const }));

    // Open (default selection) → Ready, no handoff, no activation.
    const open = await toPlan({ onOpenWaitlist, onCommunityAuth });
    open.stdin.write("\r");
    await settle();
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
    const frame = a.lastFrame() ?? "";
    // Label on the Community row (identity only — no valid lease).
    expect(frame).toMatch(/Community\s+·\s+free account, 1 device\s+·\s+signed in/);
    expect(frame).not.toMatch(/Community\s+·\s+free account, 1 device\s+·\s+Community active/);
  });

  it("a device with a valid Community lease is labeled Community active", async () => {
    const a = await toPlan({ signedIn: true, communityAuthorized: true });
    a.stdin.write("2"); // highlight Community
    await settle(40);
    const frame = a.lastFrame() ?? "";
    expect(frame).toMatch(/Community\s+·\s+free account, 1 device\s+·\s+Community active/);
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
      a.stdin.write("\r"); // → review
      await settle();
      a.stdin.write("\r"); // enable → the agreement, NOT the acquisition
      await settle();

      const licence = plain(a.lastFrame() ?? "");
      expect(licence).toContain("Compaction Engine License Agreement");
      expect(licence).toContain("a accept");
      expect(onCommunityAuth, "nothing may be acquired before the agreement is accepted").not.toHaveBeenCalled();

      // ENTER IS THE KEY EVERY PRECEDING SCREEN ADVANCED ON. If it accepted here too, agreeing to a
      // licence would be the side effect of continuing rather than a decision, which is the whole
      // reason the agreement got a screen of its own. So it must do nothing at all.
      a.stdin.write("\r");
      await settle();
      expect(onCommunityAuth, "Enter must not stand in for agreement").not.toHaveBeenCalled();
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
});
