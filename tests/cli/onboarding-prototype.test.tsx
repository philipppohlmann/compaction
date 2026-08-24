import React from "react";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { App } from "../../src/cli/onboarding-prototype/App.js";
import { renderWordmark } from "../../src/cli/onboarding/wordmark.js";
import { renderPrototypeWordmark } from "../../src/cli/onboarding-prototype/Wordmark.js";
import { parseScenario, statusForScenario } from "../../src/cli/onboarding-prototype/model.js";

describe("onboarding prototype", () => {
  // The UI intentionally looks production-faithful for internal dogfood. Isolation and
  // simulation honesty are enforced in source/package tests rather than with an in-UI banner.
  it("starts with the existing onboarding wordmark and honest provider choices", () => {
    const view = render(<App scenario="happy" />);
    expect(view.lastFrame()).toContain("C O M P A C T I O N");
    expect(view.lastFrame()).toContain("D E V");
    expect(view.lastFrame()).toContain("Welcome to Compaction");
    expect(view.lastFrame()).toContain("v0.5.0 compaction: context optimization for AI agents.");
    expect(view.lastFrame()).not.toContain("Connect Claude Code with your subscription");
    expect(view.lastFrame()).not.toContain("ONBOARDING PROTOTYPE");
    expect(view.lastFrame()).toContain("shorter responses on both");
    expect(view.lastFrame()).toContain("Codex CLI");
    expect(view.lastFrame()).toContain("Cursor");
    expect(view.lastFrame()).toContain("output only");
    // Regression guard: the falsified cache/input framing must not return.
    expect(view.lastFrame()).not.toContain("measurement only");
    expect(view.lastFrame()).not.toContain("API key required");
    expect(view.lastFrame()).not.toContain("Cache");
    expect(view.lastFrame()?.split("\n").length).toBeLessThanOrEqual(24);
  });

  it("uses the repository's exact responsive onboarding wordmark renderer", () => {
    const wide = renderWordmark(96);
    const stacked = renderPrototypeWordmark(96, false);
    const narrow = renderWordmark(72);
    expect(wide.kind).toBe("block");
    expect(wide.width).toBe(83);
    expect(wide.height).toBe(6);
    expect(wide.rows.flat().map((segment) => segment.text).join("")).toContain("█");
    expect(stacked).toHaveLength(12);
    expect(stacked.flat().map((segment) => segment.text).join("")).toContain("██████╗ ███████╗██╗   ██╗");
    expect(narrow.kind).toBe("text");
    expect(narrow.rows[0][0].text).toBe("C O M P A C T I O N");
  });

  it("models recovery states without calling them ready", () => {
    expect(statusForScenario("new-shell", "full").healthy).toBe(false);
    expect(statusForScenario("verification-failed", "output").headline).toContain("could not be verified");
  });

  it("falls back to the happy scenario", () => {
    expect(parseScenario("unknown")).toBe("happy");
  });

  it("lets the user go back from the final ready screen", async () => {
    const view = render(<App scenario="happy" />);
    const settle = (ms = 150): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
    await settle();
    view.stdin.write("\r");
    await settle();
    expect(view.lastFrame()).toContain("Choose how Compaction should optimize");
    expect(view.lastFrame()).not.toContain("Welcome to Compaction");
    view.stdin.write("\r");
    await settle();
    expect(view.lastFrame()).toContain("Enable Compaction for Claude Code?");
    view.stdin.write("1");
    await settle();
    expect(view.lastFrame()).toContain("Setting up Claude Code");
    await settle(3_000);
    expect(view.lastFrame()).toContain("←/esc review setup");
    view.stdin.write("\u001b[D");
    await settle();
    expect(view.lastFrame()).toContain("Enable Compaction for Claude Code?");
    view.unmount();
  });

  it("keeps one visible review action and uses left arrow for back", async () => {
    const view = render(<App scenario="happy" />);
    const settle = (ms = 150): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
    await settle();
    view.stdin.write("\r");
    await settle();
    view.stdin.write("\r");
    await settle();
    expect(view.lastFrame()).toContain("Enable Compaction for Claude Code?");
    expect(view.lastFrame()).toContain("› Enable Compaction");
    expect(view.lastFrame()).not.toContain("2. Go back");
    expect(view.lastFrame()).toContain("enter enable · ←/esc back");
    view.stdin.write("\u001b[D");
    await settle();
    expect(view.lastFrame()).toContain("Choose how Compaction should optimize Claude Code");
    view.unmount();
  });

  it("shows an installed-management view instead of a fake in-session typebar", () => {
    const view = render(<App scenario="already-installed" />);
    expect(view.lastFrame()).toContain("Compaction is active for Claude Code");
    expect(view.lastFrame()).toContain("compaction status");
    expect(view.lastFrame()).toContain("compaction activity");
    expect(view.lastFrame()).not.toContain("Type /status");
    view.unmount();
  });
});
