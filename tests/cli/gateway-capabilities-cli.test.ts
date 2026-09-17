import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import {
  ADVANCED_CUSTOM_APP,
  ADVANCED_ROUTES,
  CONNECT_MENU,
  deriveDiscovery,
  type ConnectDetection
} from "../../src/cli/onboarding/model.js";

/**
 * `compaction gateway capabilities` CLI (anti-overclaim wiring). The command renders the
 * capability matrix as an honest content-free table; `--json` prints the matrix. It never shows
 * cache-proof-supported where the matrix says false, always qualifies a supported row live-unverified, and
 * makes no cost/billing/savings/live-proven claim. Also pins tests 8/9: wiring did NOT leak the custom
 * OpenAI-compatible app or a provider into onboarding Page-1 (still exactly Codex/Claude Code/Cursor).
 */
const CLI = resolve("dist/cli/index.js");

function run(args: string[]): { stdout: string; stderr: string; code: number } {
  const r = spawnSync("node", [CLI, ...args], { encoding: "utf8" });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status ?? 0 };
}

describe("gateway capabilities - honest table rendered from the matrix", () => {
  it("prints Codex and the custom app as routed/supported, both qualified live-unverified", () => {
    const r = run(["gateway", "capabilities"]);
    expect(r.code).toBe(0);
    // Supported row is always qualified live-unverified; never presented as proven/live.
    expect(r.stdout).toMatch(/cache proof:\s*supported \(pipeline; live-unverified/);
    expect(r.stdout).not.toMatch(/proven live|live-proven|ready live/i);
    expect(r.stdout).toMatch(/Codex CLI[\s\S]*routing:\s*gateway-routable/);
    expect(r.stdout).toMatch(/Codex CLI[\s\S]*cache proof:\s*supported \(pipeline; live-unverified/);
    // Claude Code / Cursor remain not-supported with a reason.
    expect(r.stdout).toMatch(/Claude Code[\s\S]*cache proof:\s*not supported -/);
    expect(r.stdout).toMatch(/Cursor[\s\S]*cache proof:\s*not supported -/);
    const codexBlock = r.stdout.slice(r.stdout.indexOf("Codex CLI"), r.stdout.indexOf("Claude Code"));
    expect(codexBlock).not.toMatch(/capture\/activity|does NOT route/);
    expect(r.stdout).toMatch(/supported ≠ live-verified/);
  });

  it("--json prints the content-free matrix (no key/content substrings)", () => {
    const r = run(["gateway", "capabilities", "--json"]);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as Array<{ workflow: string; gatewayRoutable: boolean | string; activityOnly: boolean; cacheProofSupported: boolean }>;
    expect(parsed.map((row) => row.workflow).sort()).toEqual(
      ["claude-code", "codex", "cursor", "custom-openai-app"].sort()
    );
    expect(parsed.find((row) => row.workflow === "codex")).toMatchObject({
      gatewayRoutable: true,
      activityOnly: false,
      cacheProofSupported: true
    });
    expect(r.stdout).not.toMatch(/sk-[A-Za-z0-9]/);
    expect(r.stdout).not.toMatch(/api[_-]?key/i);
  });

  it("makes no cost/billing/savings/output-token claim on the surface", () => {
    const r = run(["gateway", "capabilities"]);
    expect(r.stdout).not.toMatch(/\bsaved\b|\bsavings\b|\$\d|\binvoice\b/i);
    expect(r.stdout).not.toMatch(/output[- ]token|lower fresh input|fresh input reduced/i);
  });
});

describe("tests 8/9 - wiring did not leak the custom app or a provider into onboarding Page-1", () => {
  const det: ConnectDetection = {
    claude: { detected: true },
    codex: "found",
    cursor: { desktopDetected: false, hookReady: false, cli: "found" }
  };

  it("Page-1 discovery stays exactly Codex, Claude Code, Cursor", () => {
    const keys = deriveDiscovery(det).map((d) => d.key);
    expect(keys).toEqual(["codex", "claude-code", "cursor"]);
    expect(keys).not.toContain("custom-openai-app");
    expect(keys).not.toContain("openai");
  });

  it("the named connect-once menu has no custom app / provider lane", () => {
    const labels = CONNECT_MENU.map((m) => m.label);
    expect(labels).toEqual(["Claude Code", "Codex", "Cursor", "All detected tools"]);
    expect(CONNECT_MENU.map((m) => m.command)).toEqual([
      "compaction init --connect claude-code",
      "compaction init --connect codex",
      "compaction init --connect cursor",
      "compaction init --connect all"
    ]);
  });

  it("the custom OpenAI-compatible app stays Advanced-only", () => {
    expect(ADVANCED_ROUTES).toContain(ADVANCED_CUSTOM_APP);
    expect(ADVANCED_CUSTOM_APP.lines.join(" ")).toMatch(/Advanced only/i);
  });
});
