import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderConciseStatus, runStatus, STATUS_VERBOSE_HINT, type AccountAccessState } from "../../src/cli/commands/upgrade-status.js";
import type { ReadinessReport } from "../../src/cli/commands/readiness.js";
import { provisionValidLease } from "../helpers/lease-fixture.js";

/**
 * The DEFAULT `compaction status` is a concise product summary; the diagnostic readiness report lives
 * behind `--verbose` (its wording is pinned by the status-readiness / account-access suites). These
 * tests pin that the summary claims a capability only from the same state the detailed report reads.
 */

const healthy: AccountAccessState = {
  connected: true, entitled: true, communityDevSigned: false, leaseLabel: "lease-valid", communityGap: "none",
  tier: "full", engineReady: true, inputCompactionUnsupported: false, stopped: false, localGateUnreadable: false,
  liveRecordOnlyRoutingGateway: false
};

function report(overrides: { codexShim?: string; codexState?: string; cursorShim?: string; claudeConnected?: boolean; codexAuthorized?: boolean;
  managed?: boolean; autoUpdates?: boolean; gatewayRunning?: boolean; claudeRoutingShim?: string; claudeShaping?: boolean; cursorShaping?: boolean } = {}): ReadinessReport {
  return {
    runtime: { managed: overrides.managed ?? true, autoUpdates: overrides.autoUpdates ?? true, launcherPath: "/opt/homebrew/bin/compaction",
      resolvedBinary: "/opt/homebrew/bin/compaction", reportingVersion: "0.6.11" },
    tools: {
      claudeCode: { sessionsFound: 3, stopHookInstalled: true, connected: overrides.claudeConnected ?? true, routingShim: overrides.claudeRoutingShim ?? "active",
        statusLineInstalled: true, shapingActive: overrides.claudeShaping ?? true },
      codex: { shim: overrides.codexShim ?? "active", binaryFound: true, shapingActive: overrides.codexState === "active",
        shapingState: overrides.codexState ?? "unknown", shapingConfigured: true, shapingTrustProbed: false },
      cursor: { shim: overrides.cursorShim ?? "active", binaryFound: true, shapingActive: overrides.cursorShaping ?? true }
    },
    gateway: { running: overrides.gatewayRunning ?? false, receiptsCount: 0 },
    routes: { "claude-code": "routable", codex: "routable", cursor: "measure-only", lcm: "shadow-only" },
    authorizations: { "claude-code": { authorized: true, id: "pref-a" }, codex: { authorized: overrides.codexAuthorized ?? true, id: "pref-b" } }
  } as unknown as ReadinessReport;
}

describe("concise default status (pure render)", () => {
  it("summarizes a healthy managed Community device in a few product-level lines", () => {
    const out = renderConciseStatus(report({ codexState: "active", autoUpdates: false }), healthy, "0.6.17");
    expect(out).toEqual([
      "Compaction 0.6.11 · managed (auto-updates off)",
      "",
      "Community       active",
      "Optimization    Full",
      "Engine          0.6.17 · ready",
      "",
      "Claude Code     connected · input + output",
      "Codex           connected · input + output",
      "Cursor          connected · output only",
      "",
      "Gateway         starts on demand",
      "",
      "Compaction is active.",
      "",
      STATUS_VERBOSE_HINT
    ]);
  });

  it("never claims input reduction when a gate the gateway checks is unmet", () => {
    const pending = renderConciseStatus(report({ codexState: "active" }), { ...healthy, fullApplyPendingReason: "Full is pending." }, "0.6.17");
    expect(pending).toContain("Claude Code     connected · output only");
    expect(pending).not.toContain("Compaction is active.");
    expect(pending).toContain("Full is pending.");
    const open = renderConciseStatus(report({ codexState: "active" }), { ...healthy, entitled: false, tier: "observe", communityGap: "needs-activation" }, undefined);
    expect(open.join("\n")).not.toContain("input");
    expect(open).not.toContain("Optimization    Full");
    const unauthorized = renderConciseStatus(report({ codexState: "active", codexAuthorized: false }), healthy, "0.6.17");
    expect(unauthorized).toContain("Codex           connected · output only");
  });

  it("never claims Claude Code input when its routing shim is not active (the Stop hook alone routes nothing)", () => {
    for (const shim of ["installed-not-on-path", "not-installed"]) {
      const out = renderConciseStatus(report({ codexState: "active", claudeRoutingShim: shim }), healthy, "0.6.17");
      expect(out).toContain("Claude Code     connected · output only");
    }
  });

  it("never claims input or the active footer while the allowance pauses every route", () => {
    const out = renderConciseStatus(report({ codexState: "active" }), healthy, "0.6.17", { reason: "exhausted", scope: "all-routes" });
    expect(out).toContain("Claude Code     connected · output only · input paused (allowance)");
    expect(out).toContain("Codex           connected · output only · input paused (allowance)");
    expect(out).toContain("Cursor          connected · output only");
    expect(out).not.toContain("Compaction is active.");
    const unrouted = renderConciseStatus(report({ codexState: "active", claudeRoutingShim: "not-installed" }), healthy, "0.6.17", { reason: "exhausted", scope: "all-routes" });
    expect(unrouted).toContain("Claude Code     connected · output only");
    const keyOnly = renderConciseStatus(report({ codexState: "active" }), healthy, "0.6.17", { reason: "exhausted", scope: "api-key-route" });
    expect(keyOnly).toContain("Claude Code     connected · input + output · API-key route paused (allowance)");
  });

  it("says auto-updates are off in this environment when a runtime opt-out disables them", () => {
    const r = report({ codexState: "active" });
    (r.runtime as { autoUpdatesEffective?: boolean }).autoUpdatesEffective = false;
    expect(renderConciseStatus(r, healthy, "0.6.17")[0]).toBe("Compaction 0.6.11 · managed (auto-updates off in this environment)");
  });

  it("never claims Compaction is active when no tool row gets input optimization", () => {
    const gone = renderConciseStatus(report({ codexShim: "inactive", cursorShim: "inactive", cursorShaping: false, claudeConnected: false,
      claudeRoutingShim: "not-installed", claudeShaping: false }), healthy, "0.6.17");
    expect(gone.join("\n")).not.toContain("Compaction is active.");
    expect(gone).toContain("Claude Code     not connected");
    // Output shaping alone is not the input optimization the footer asserts.
    const outputOnly = renderConciseStatus(report({ codexShim: "inactive", claudeRoutingShim: "not-installed" }), healthy, "0.6.17");
    expect(outputOnly.join("\n")).not.toContain("Compaction is active.");
  });

  it("never prints Optimization Full beside an Open plan (logged out with a lease left behind)", () => {
    const loggedOut = renderConciseStatus(report({ codexState: "active" }), { ...healthy, connected: false }, "0.6.17");
    expect(loggedOut).toContain("Plan            Open");
    expect(loggedOut.join("\n")).not.toMatch(/Optimization +Full|Compaction is active|input \+ output/);
  });

  it("states Codex hook trust it did not check as unchecked, and names an observed approval gap", () => {
    expect(renderConciseStatus(report(), healthy, "0.6.17")).toContain("Codex           connected · input only · output not checked (compaction status --check-codex)");
    expect(renderConciseStatus(report(), healthy, "0.6.17").join("\n")).not.toMatch(/Codex .*input \+ output/);
    expect(renderConciseStatus(report({ codexState: "approval-required" }), healthy, "0.6.17"))
      .toContain("Codex           connected · input only · output needs Codex hook approval");
  });

  it("never calls a tool disconnected while one of its capability axes is still active", () => {
    const partial = renderConciseStatus(report({ codexState: "active", cursorShim: "inactive", claudeConnected: false }), healthy, "0.6.17");
    // Stop hook missing, routing shim + shaping hook still active: still routed and shaped.
    expect(partial).toContain("Claude Code     partly connected · input + output");
    // Cursor shim gone, session shaping hook still active.
    expect(partial).toContain("Cursor          partly connected · output only");
    // Codex shim gone, only unapproved/unchecked hook config left: not an active capability.
    for (const codexState of ["unknown", "approval-required", "disabled"]) {
      expect(renderConciseStatus(report({ codexShim: "inactive", codexState }), healthy, "0.6.17")).toContain("Codex           not connected");
    }
  });

  it("reports stop, disconnected tools, and a running gateway plainly", () => {
    const stopped = renderConciseStatus(report({ cursorShim: "inactive", cursorShaping: false, claudeConnected: false,
      claudeRoutingShim: "not-installed", claudeShaping: false, gatewayRunning: true }), { ...healthy, stopped: true }, "0.6.17");
    expect(stopped).toContain("Claude Code     not connected");
    expect(stopped).toContain("Codex           connected · paused (compaction stop)");
    expect(stopped).toContain("Cursor          not connected");
    expect(stopped).toContain("Gateway         running");
    expect(stopped).not.toContain("Compaction is active.");
  });
});

describe("concise default status (CLI)", () => {
  let configDir: string;
  let cwd: string;
  let originalCwd: string;
  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "compaction-concise-cfg-"));
    cwd = mkdtempSync(join(tmpdir(), "compaction-concise-cwd-"));
    originalCwd = process.cwd();
    process.chdir(cwd);
  });
  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(configDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  async function status(verbose: boolean): Promise<string> {
    const engine = join(configDir, "engine-stub.js");
    writeFileSync(engine, "// stub\n");
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(" ")); });
    try {
      await runStatus({ verbose, version: "0.0.0-test", projectsDir: join(configDir, "none"), env: { ...process.env,
        COMPACTION_CONFIG_DIR: configDir, COMPACTION_ENGINE_PATH: engine, COMPACTION_API_URL: "", COMPACTION_API_KEY: "",
        ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "" } });
    } finally { vi.restoreAllMocks(); }
    return lines.join("\n");
  }

  it("prints the summary by default and keeps the full diagnostic report behind --verbose", async () => {
    provisionValidLease(configDir);
    const concise = await status(false);
    expect(concise).toContain("Community       active (DEV-SIGNED)");
    expect(concise).toContain("Gateway         starts on demand");
    expect(concise).toContain(STATUS_VERBOSE_HINT);
    for (const diagnostic of ["Credentials (presence only", "Storage (", "Next commands for this machine", "Evidence labels", "Routing & apply boundary", "Account & access"]) {
      expect(concise).not.toContain(diagnostic);
    }
    const verbose = await status(true);
    for (const diagnostic of ["Credentials (presence only", "Next commands for this machine", "Account & access", "Community: active (DEV-SIGNED)"]) {
      expect(verbose).toContain(diagnostic);
    }
    expect(verbose).not.toContain(STATUS_VERBOSE_HINT);
  });
});
