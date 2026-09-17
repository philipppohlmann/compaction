import { describe, expect, it } from "vitest";
import {
  deriveDiscovery,
  initialSelection,
  toggleSelection,
  isWorkflowSelectable,
  workflowsToEnable,
  needsEnablePage,
  selectedReadyWorkflows,
  readyModeLine,
  buildReadySummaryLines,
  READY_MODE_LINE,
  type ConnectDetection,
  type WorkflowKey
} from "../../src/cli/onboarding/model.js";

/**
 * Fixture-only unit tests for the PURE wizard state machine.
 * No React, no IO, no keys, every input is a hand-built ConnectDetection turned into discovery rows.
 * These pin the page-flow decisions the Ink component is a thin renderer over.
 */

function det(overrides: Partial<ConnectDetection> = {}): ConnectDetection {
  return { claude: { detected: false, sessionCount: 0 }, codex: "absent", cursor: { desktopDetected: false, hookReady: false, cli: "absent" }, ...overrides };
}

// All three FOUND (discovered-but-not-ready): codex binary on PATH, claude sessions no hook, cursor binary.
const allFound = deriveDiscovery(det({ claude: { detected: true, sessionCount: 3 }, codex: "found", cursor: { desktopDetected: false, hookReady: false, cli: "found" } }));
// Mixed: codex ACTIVE (ready), claude FOUND, cursor ABSENT (not-found).
const mixed = deriveDiscovery(det({ claude: { detected: true, sessionCount: 1 }, codex: "active", codexHooksInstalled: true, cursor: { desktopDetected: false, hookReady: false, cli: "absent" } }));
// Ready-only selection source: codex active (ready), claude ready (verified hook), cursor absent.
const allReady = deriveDiscovery(
  det({ claude: { detected: true, sessionCount: 1, hookReady: true }, codex: "active", codexHooksInstalled: true, cursor: { desktopDetected: false, hookReady: false, cli: "absent" } })
);

describe("initialSelection - preselect found + ready, never not-found (tests 2/3/4)", () => {
  it("(3) preselects found-but-not-ready workflows for enable", () => {
    const sel = initialSelection(allFound);
    expect([...sel].sort()).toEqual(["claude-code", "codex", "cursor"]);
  });

  it("(2) preselects ready workflows", () => {
    const sel = initialSelection(allReady);
    // codex ready + claude ready selected; cursor not-found NOT selected.
    expect(sel.has("codex")).toBe(true);
    expect(sel.has("claude-code")).toBe(true);
    expect(sel.has("cursor")).toBe(false);
  });

  it("(4) never preselects a not-found workflow", () => {
    const sel = initialSelection(mixed);
    expect(sel.has("cursor")).toBe(false); // cursor absent -> not-found
    expect(sel.has("codex")).toBe(true); // ready
    expect(sel.has("claude-code")).toBe(true); // found
  });
});

describe("isWorkflowSelectable + toggleSelection - not-found is non-selectable (no-op)", () => {
  it("a not-found workflow is not selectable", () => {
    expect(isWorkflowSelectable("cursor", mixed)).toBe(false);
    expect(isWorkflowSelectable("codex", mixed)).toBe(true);
  });

  it("toggling a not-found workflow is a no-op and never mutates the input set", () => {
    const before = initialSelection(mixed);
    const after = toggleSelection(before, "cursor", mixed);
    expect(after.has("cursor")).toBe(false);
    expect([...after].sort()).toEqual([...before].sort());
    expect(after).not.toBe(before); // returns a fresh copy
  });

  it("toggling a selectable workflow off then on returns a new set each time", () => {
    const start = initialSelection(allFound);
    const off = toggleSelection(start, "codex", allFound);
    expect(off.has("codex")).toBe(false);
    expect(start.has("codex")).toBe(true); // input unchanged
    const on = toggleSelection(off, "codex", allFound);
    expect(on.has("codex")).toBe(true);
  });
});

describe("workflowsToEnable - selected found subset in stable order", () => {
  it("returns only selected found (not ready, not not-found), in Page-1 order", () => {
    const sel = initialSelection(mixed); // {codex(ready), claude(found)}
    expect(workflowsToEnable(sel, mixed)).toEqual(["claude-code"]); // only the found one
  });

  it("all-found selection enables all three in order", () => {
    const sel = initialSelection(allFound);
    expect(workflowsToEnable(sel, allFound)).toEqual(["codex", "claude-code", "cursor"]);
  });

  it("deselecting a found workflow drops it from the enable set", () => {
    const sel = toggleSelection(initialSelection(allFound), "codex", allFound);
    expect(workflowsToEnable(sel, allFound)).toEqual(["claude-code", "cursor"]);
  });
});

describe("needsEnablePage - Page-2 gating (tests 5/6)", () => {
  it("(5) true when at least one selected workflow is found-but-not-ready", () => {
    expect(needsEnablePage(initialSelection(allFound), allFound)).toBe(true);
    expect(needsEnablePage(initialSelection(mixed), mixed)).toBe(true); // claude found
  });

  it("(6) false when everything selected is already ready (Page-2 skipped)", () => {
    const sel = initialSelection(allReady); // {codex ready, claude ready}
    expect(needsEnablePage(sel, allReady)).toBe(false);
  });

  it("(6) false for an empty selection", () => {
    expect(needsEnablePage(new Set<WorkflowKey>(), allFound)).toBe(false);
  });
});

describe("selectedReadyWorkflows - already-ready workflows counted without re-enabling", () => {
  it("returns the selected ready subset in order", () => {
    expect(selectedReadyWorkflows(initialSelection(allReady), allReady)).toEqual(["codex", "claude-code"]);
  });

  it("excludes found and not-found workflows", () => {
    expect(selectedReadyWorkflows(initialSelection(mixed), mixed)).toEqual(["codex"]); // codex ready; claude found excluded
  });
});

describe("readyModeLine - Page-4 mode line reflects the chosen mode (lane-5 follow-up)", () => {
  it("no mode -> the recommended-default line (byte-stable non-interactive surface)", () => {
    expect(readyModeLine()).toBe(READY_MODE_LINE);
    expect(readyModeLine()).toBe("Optimization: Output only (default)");
  });

  it("cache-optimize -> the chosen Output only title", () => {
    expect(readyModeLine("cache-optimize")).toBe("Optimization: Output only");
  });

  it("cache-context-optimize -> the chosen Full optimization title", () => {
    expect(readyModeLine("cache-context-optimize")).toBe("Optimization: Full optimization");
  });
});

describe("buildReadySummaryLines - (9) shows only actually-ready workflows + the chosen mode", () => {
  it("lists only the enabled tools and reflects the chosen mode", () => {
    const lines = buildReadySummaryLines(["codex"], "cache-context-optimize");
    const text = lines.join("\n");
    expect(text).toContain("Compaction is ready.");
    expect(text).toContain("✓ Codex");
    expect(text).not.toContain("✓ Claude Code");
    expect(text).not.toContain("✓ Cursor");
    expect(text).toContain("Optimization: Full optimization");
  });

  it("returns [] when nothing enabled (no false 'ready' header)", () => {
    expect(buildReadySummaryLines([], "cache-optimize")).toEqual([]);
  });
});
