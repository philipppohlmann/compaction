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
    cursor: { desktopDetected: false, hookReady: false, cli: "absent" },
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
      det({ claude: { detected: true, sessionCount: 5, hookReady: true }, codex: "active", cursor: { desktopDetected: false, hookReady: true, cli: "active" } })
    );
    const keys = rows.map((r) => r.key);
    expect(keys).not.toContain("openai-agents");
    expect(keys).not.toContain("browser");
    expect(keys).not.toContain("gateway");
    expect(rows).toHaveLength(3);
  });
});

describe("deriveDiscovery - presence and readiness stay separate", () => {
  it("requires each tool's verified integration facts before rendering ready", () => {
    const rows = (detection: ConnectDetection): Record<WorkflowDiscovery["key"], DiscoveryState> =>
      Object.fromEntries(deriveDiscovery(detection).map((row) => [row.key, row.state])) as Record<
        WorkflowDiscovery["key"],
        DiscoveryState
      >;

    expect(rows(det({ claude: { detected: true, sessionCount: 1, hookReady: true } }))["claude-code"]).toBe("ready");
    expect(rows(det({ claude: { detected: true, sessionCount: 1, hookReady: false } }))["claude-code"]).toBe("found");

    expect(rows(det({ codex: "active", codexHooksInstalled: true, codexHookReady: true })).codex).toBe("ready");
    expect(rows(det({ codex: "active", codexHooksInstalled: false, codexHookReady: false })).codex).toBe("found");

    expect(rows(det({ cursor: { desktopDetected: true, hookReady: true, cli: "absent" } })).cursor).toBe("ready");
    expect(rows(det({ cursor: { desktopDetected: true, hookReady: false, cli: "absent" } })).cursor).toBe("found");
    expect(rows(det()).cursor).toBe("not-found");
  });
});

describe("deriveDiscovery - Codex states", () => {
  for (const v of CODEX_CURSOR_VALUES) {
    const expected = v === "active" ? "ready" : expectedShimState(v);
    it(`codex=${v} with the native hook bundle -> ${expected}`, () => {
      const row = byKey(deriveDiscovery(det({ codex: v, codexHooksInstalled: true })), "codex");
      expect(row.state).toBe(expected);
      expect(row.foundMeaning).toBe(CODEX_DISCOVERY_COPY.foundMeaning);
      expect(row.readyMeaning).toBe(CODEX_DISCOVERY_COPY.readyMeaning);
      expect(row.enableAction).toBe(CODEX_DISCOVERY_COPY.enableAction);
    });
  }

  it("keeps an active routing shim in found when the native hook bundle is missing", () => {
    expect(byKey(deriveDiscovery(det({ codex: "active", codexHooksInstalled: false })), "codex").state).toBe("found");
  });

  it("treats an omitted hook-bundle result conservatively", () => {
    expect(byKey(deriveDiscovery(det({ codex: "active" })), "codex").state).toBe("found");
  });
});

describe("deriveDiscovery - Cursor desktop, hook, and optional CLI axes", () => {
  it("finds desktop-only Cursor without a CLI", () => {
    const row = byKey(deriveDiscovery(det({
      cursor: { desktopDetected: true, hookReady: false, cli: "absent" }
    })), "cursor");
    expect(row.state).toBe("found");
  });

  it("is ready only when the native hook is verified", () => {
    const row = byKey(deriveDiscovery(det({
      cursor: { desktopDetected: true, hookReady: true, cli: "absent" }
    })), "cursor");
    expect(row.state).toBe("ready");
  });

  it("keeps CLI-only Cursor found until its hook is verified", () => {
    expect(byKey(deriveDiscovery(det({
      cursor: { desktopDetected: false, hookReady: false, cli: "active" }
    })), "cursor").state).toBe("found");
    expect(byKey(deriveDiscovery(det({
      cursor: { desktopDetected: false, hookReady: true, cli: "active" }
    })), "cursor").state).toBe("ready");
  });

  it("is not found when desktop and CLI are both absent", () => {
    const row = byKey(deriveDiscovery(det()), "cursor");
    expect(row.state).toBe("not-found");
    expect(row.foundMeaning).toBe(CURSOR_DISCOVERY_COPY.foundMeaning);
    expect(row.readyMeaning).toBe(CURSOR_DISCOVERY_COPY.readyMeaning);
    expect(row.enableAction).toBe(CURSOR_DISCOVERY_COPY.enableAction);
  });
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
      det({ claude: { detected: true, sessionCount: 1, hookReady: true }, codex: "active", codexHooksInstalled: true, cursor: { desktopDetected: false, hookReady: true, cli: "active" } })
    );
    expect(discoveryNeedsEnable(allReady)).toBe(false);

    const allAbsent = deriveDiscovery(det());
    expect(discoveryNeedsEnable(allAbsent)).toBe(false);

    const mixedReadyAndNotFound = deriveDiscovery(
      det({ claude: { detected: false, sessionCount: 0 }, codex: "active", codexHooksInstalled: true, cursor: { desktopDetected: false, hookReady: false, cli: "absent" } })
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
