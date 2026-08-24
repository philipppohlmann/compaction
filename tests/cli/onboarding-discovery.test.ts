import { describe, expect, it } from "vitest";
import {
  deriveDiscovery,
  discoveryNeedsEnable,
  shortLabel,
  CODEX_DISCOVERY_COPY,
  CLAUDE_CODE_DISCOVERY_COPY,
  CURSOR_DISCOVERY_COPY,
  type ConnectDetection,
  type DiscoveryState,
  type WorkflowDiscovery
} from "../../src/cli/onboarding/model.js";

/**
 * Fixture-only tests for the pure discovery state model.
 * No IO, no network, no keys, every input is a hand-built ConnectDetection.
 */

type CodexCursor = ConnectDetection["codex"];
const CODEX_CURSOR_VALUES: CodexCursor[] = ["active", "installed", "found", "absent"];

/** Expected state for a codex/cursor-style shim status. */
function expectedShimState(v: CodexCursor): DiscoveryState {
  if (v === "absent") return "not-found";
  if (v === "active") return "ready";
  return "found";
}

function det(overrides: Partial<ConnectDetection> = {}): ConnectDetection {
  return {
    claude: { detected: false, sessionCount: 0 },
    codex: "absent",
    cursor: "absent",
    ...overrides
  };
}

function byKey(rows: WorkflowDiscovery[], key: WorkflowDiscovery["key"]): WorkflowDiscovery {
  const row = rows.find((r) => r.key === key);
  if (!row) throw new Error(`missing discovery row: ${key}`);
  return row;
}

describe("deriveDiscovery - order and membership", () => {
  it("returns exactly Codex, Claude Code, Cursor in that order", () => {
    const rows = deriveDiscovery(det());
    expect(rows.map((r) => r.key)).toEqual(["codex", "claude-code", "cursor"]);
    expect(rows.map((r) => r.title)).toEqual(["Codex", "Claude Code", "Cursor"]);
  });

  it("never includes OpenAI Agents, Browser, or Gateway as a discovery row", () => {
    const rows = deriveDiscovery(
      det({ claude: { detected: true, sessionCount: 5, hookReady: true }, codex: "active", cursor: "active" })
    );
    const keys = rows.map((r) => r.key);
    expect(keys).not.toContain("openai-agents");
    expect(keys).not.toContain("browser");
    expect(keys).not.toContain("gateway");
    expect(rows).toHaveLength(3);
  });
});

describe("deriveDiscovery - Codex states", () => {
  for (const v of CODEX_CURSOR_VALUES) {
    it(`codex=${v} -> ${expectedShimState(v)}`, () => {
      const row = byKey(deriveDiscovery(det({ codex: v })), "codex");
      expect(row.state).toBe(expectedShimState(v));
      expect(row.foundMeaning).toBe(CODEX_DISCOVERY_COPY.foundMeaning);
      expect(row.readyMeaning).toBe(CODEX_DISCOVERY_COPY.readyMeaning);
      expect(row.enableAction).toBe(CODEX_DISCOVERY_COPY.enableAction);
    });
  }
});

describe("deriveDiscovery - Cursor states", () => {
  for (const v of CODEX_CURSOR_VALUES) {
    it(`cursor=${v} -> ${expectedShimState(v)}`, () => {
      const row = byKey(deriveDiscovery(det({ cursor: v })), "cursor");
      expect(row.state).toBe(expectedShimState(v));
      expect(row.foundMeaning).toBe(CURSOR_DISCOVERY_COPY.foundMeaning);
      expect(row.readyMeaning).toBe(CURSOR_DISCOVERY_COPY.readyMeaning);
      expect(row.enableAction).toBe(CURSOR_DISCOVERY_COPY.enableAction);
    });
  }
});

describe("deriveDiscovery - Claude Code states (detected x hookReady x sessionCount)", () => {
  const hookReadyCases: Array<{ hookReady: boolean | undefined; label: string }> = [
    { hookReady: true, label: "true" },
    { hookReady: false, label: "false" },
    { hookReady: undefined, label: "undefined" }
  ];
  const sessionCounts = [0, 1, 42];

  it("not detected -> not-found regardless of hookReady/sessionCount", () => {
    for (const { hookReady } of hookReadyCases) {
      for (const sessionCount of sessionCounts) {
        const row = byKey(
          deriveDiscovery(det({ claude: { detected: false, sessionCount, hookReady } })),
          "claude-code"
        );
        expect(row.state).toBe("not-found");
      }
    }
  });

  it("detected + hookReady true -> ready (any sessionCount)", () => {
    for (const sessionCount of sessionCounts) {
      const row = byKey(
        deriveDiscovery(det({ claude: { detected: true, sessionCount, hookReady: true } })),
        "claude-code"
      );
      expect(row.state).toBe("ready");
    }
  });

  it("detected + hookReady false or undefined -> found, never ready (any sessionCount)", () => {
    for (const hookReady of [false, undefined] as const) {
      for (const sessionCount of sessionCounts) {
        const row = byKey(
          deriveDiscovery(det({ claude: { detected: true, sessionCount, hookReady } })),
          "claude-code"
        );
        expect(row.state).toBe("found");
        expect(row.state).not.toBe("ready");
      }
    }
  });

  it("carries the honest Claude Code copy on every row", () => {
    const row = byKey(deriveDiscovery(det({ claude: { detected: true, sessionCount: 3 } })), "claude-code");
    expect(row.foundMeaning).toBe(CLAUDE_CODE_DISCOVERY_COPY.foundMeaning);
    expect(row.readyMeaning).toBe(CLAUDE_CODE_DISCOVERY_COPY.readyMeaning);
    expect(row.enableAction).toBe(CLAUDE_CODE_DISCOVERY_COPY.enableAction);
  });
});

describe("discoveryNeedsEnable", () => {
  it("true when at least one workflow is found (discovered, not ready)", () => {
    const rows = deriveDiscovery(det({ codex: "installed" }));
    expect(discoveryNeedsEnable(rows)).toBe(true);
  });

  it("false when nothing is found (all ready and/or not-found)", () => {
    const allReady = deriveDiscovery(
      det({ claude: { detected: true, sessionCount: 1, hookReady: true }, codex: "active", cursor: "active" })
    );
    expect(discoveryNeedsEnable(allReady)).toBe(false);

    const allAbsent = deriveDiscovery(det());
    expect(discoveryNeedsEnable(allAbsent)).toBe(false);

    const mixedReadyAndNotFound = deriveDiscovery(
      det({ claude: { detected: false, sessionCount: 0 }, codex: "active", cursor: "absent" })
    );
    expect(discoveryNeedsEnable(mixedReadyAndNotFound)).toBe(false);
  });
});

describe("shortLabel", () => {
  it("ready -> 'ready'", () => {
    expect(shortLabel("ready", "installed")).toBe("ready");
  });
  it("not-found -> 'not found'", () => {
    expect(shortLabel("not-found", "installed")).toBe("not found");
  });
  it("found -> '<foundLabel> · enable Compaction'", () => {
    expect(shortLabel("found", "installed")).toBe("installed · enable Compaction");
    expect(shortLabel("found", "sessions found")).toBe("sessions found · enable Compaction");
  });
});

describe("claim boundaries - no forbidden claim substrings in any exported copy", () => {
  const forbidden = [
    "billing-confirmed",
    "invoice",
    "cost savings",
    "output-token savings",
    "semantic preservation",
    "no context lost",
    "learned-model superiority",
    "automatic optimization",
    "all-provider",
    // guard against generic savings/optimization language too
    "savings",
    "optimization",
    "optimize"
  ];

  const allCopy: string[] = [
    ...Object.values(CODEX_DISCOVERY_COPY),
    ...Object.values(CLAUDE_CODE_DISCOVERY_COPY),
    ...Object.values(CURSOR_DISCOVERY_COPY),
    shortLabel("found", "installed"),
    shortLabel("ready", "installed"),
    shortLabel("not-found", "installed")
  ];

  it("no exported discovery copy contains a forbidden substring (case-insensitive)", () => {
    for (const text of allCopy) {
      const lower = text.toLowerCase();
      for (const bad of forbidden) {
        expect(lower.includes(bad.toLowerCase()), `"${text}" must not contain "${bad}"`).toBe(false);
      }
    }
  });

  it("found copy never implies active / ready", () => {
    for (const copy of [CODEX_DISCOVERY_COPY, CLAUDE_CODE_DISCOVERY_COPY, CURSOR_DISCOVERY_COPY]) {
      const lower = copy.foundMeaning.toLowerCase();
      expect(lower.includes("active")).toBe(false);
      expect(lower.includes("ready")).toBe(false);
    }
  });
});
