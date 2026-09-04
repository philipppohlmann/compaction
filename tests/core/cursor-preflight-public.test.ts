import { describe, expect, it } from "vitest";
import {
  classifyCursorPreflight,
  runCursorPreflight,
  CURSOR_CLI_KNOWN_MACOS_PATH,
  CURSOR_EXAMPLE_RUN_COMMAND,
  type CursorProbe,
  type CursorProbeResult
} from "../../src/core/cursor-preflight.js";
import { isSafeProbeArgs } from "../../src/core/cursor-preflight-probe.js";

/** Public, synthetic verification of the safe Cursor preflight contract. */
const CAPABLE_HELP = [
  "Usage: cursor agent [options] [prompt]",
  "Options:",
  "  -p, --print            print result and exit (non-interactive)",
  "  --output-format <fmt>  text | json | stream-json",
  "  -h, --help             display help"
].join("\n");

const LAUNCHER_HELP = [
  "Usage: cursor [options] [paths...]",
  "  -v, --version   print version",
  "  -h, --help      print help"
].join("\n");

function probeResult(candidate: string, over: Partial<CursorProbeResult> = {}): CursorProbeResult {
  return { candidate, resolved: true, helpText: "", exitCode: 0, ...over };
}

describe("classifyCursorPreflight public contract", () => {
  it("marks a present capable CLI ready without claiming authentication", () => {
    const report = classifyCursorPreflight([probeResult("cursor-agent", { helpText: CAPABLE_HELP })]);
    expect(report.cliResolvable).toBe(true);
    expect(report.capabilityPresent).toBe(true);
    expect(report.ready).toBe(true);
    expect(report.resolvedCli).toBe("cursor-agent");
    expect(report.authState).toBe("not-checked");
    const guidance = report.guidance.join("\n");
    expect(guidance).toContain("Auth: NOT checked here");
    expect(guidance).toContain("cursor-agent status");
    expect(guidance).toContain("cursor agent login");
    expect(guidance).toContain("CURSOR_API_KEY");
    expect(guidance).toContain(CURSOR_EXAMPLE_RUN_COMMAND);
    expect(guidance).toMatch(/LOCAL-ESTIMATE only/);
  });

  it("distinguishes the editor launcher from a headless-capable CLI", () => {
    const report = classifyCursorPreflight([probeResult("cursor", { helpText: LAUNCHER_HELP })]);
    expect(report.cliResolvable).toBe(true);
    expect(report.capabilityPresent).toBe(false);
    expect(report.ready).toBe(false);
    expect(report.resolvedCli).toBe("cursor");
    expect(report.guidance.join("\n")).toContain("did not advertise the headless flags");
  });

  it("reports an absent CLI without inferring authentication", () => {
    const report = classifyCursorPreflight([
      probeResult("cursor-agent", { resolved: false, exitCode: null }),
      probeResult("cursor", { resolved: false, exitCode: null }),
      probeResult(CURSOR_CLI_KNOWN_MACOS_PATH, { resolved: false, exitCode: null })
    ]);
    expect(report.cliResolvable).toBe(false);
    expect(report.capabilityPresent).toBe(false);
    expect(report.ready).toBe(false);
    expect(report.authState).toBe("not-checked");
    const guidance = report.guidance.join("\n");
    expect(guidance).toContain("Cursor headless CLI was not found");
    expect(guidance).toContain(CURSOR_CLI_KNOWN_MACOS_PATH);
  });

  it("prefers a capable candidate over a resolved launcher", () => {
    const report = classifyCursorPreflight([
      probeResult("cursor", { helpText: LAUNCHER_HELP }),
      probeResult("cursor-agent", { helpText: CAPABLE_HELP })
    ]);
    expect(report.ready).toBe(true);
    expect(report.resolvedCli).toBe("cursor-agent");
  });

  it("requires both headless capability flags", () => {
    expect(classifyCursorPreflight([probeResult("cursor-agent", { helpText: "-p, --print" })]).capabilityPresent).toBe(false);
    expect(classifyCursorPreflight([probeResult("cursor-agent", { helpText: "--output-format json" })]).capabilityPresent).toBe(false);
  });

  it("guidance never performs login or prints a credential value", () => {
    const guidance = classifyCursorPreflight([
      probeResult("cursor-agent", { helpText: CAPABLE_HELP })
    ]).guidance.join("\n");
    expect(guidance).toContain("Cursor's normal authentication flow");
    expect(guidance).not.toMatch(/logging in|logged you in|authenticated automatically/i);
    expect(guidance).not.toMatch(/CURSOR_API_KEY\s*=/);
    expect(guidance).not.toMatch(/spending call/i);
  });
});

describe("runCursorPreflight public safe-probe contract", () => {
  it("uses help-only probe arguments and classifies the capable candidate", async () => {
    const seen: Array<{ candidate: string; args: string[] }> = [];
    const probe: CursorProbe = async (candidate, args) => {
      seen.push({ candidate, args });
      if (candidate !== "cursor-agent") {
        return probeResult(candidate, { resolved: false, exitCode: null });
      }
      return probeResult(candidate, { helpText: args.includes("agent") ? "reduced help" : CAPABLE_HELP });
    };
    const report = await runCursorPreflight(probe, ["cursor-agent", "cursor"]);
    expect(report.ready).toBe(true);
    for (const call of seen) {
      expect([["agent", "--help"], ["--help"]]).toContainEqual(call.args);
      expect(call.args).not.toContain("-p");
      expect(call.args).not.toContain("login");
      expect(call.args).not.toContain("--output-format");
    }
  });

  it("includes the known macOS app path as a fallback", async () => {
    const seen: string[] = [];
    const probe: CursorProbe = async (candidate) => {
      seen.push(candidate);
      return probeResult(candidate, { resolved: false, exitCode: null });
    };
    await runCursorPreflight(probe);
    expect(seen).toContain(CURSOR_CLI_KNOWN_MACOS_PATH);
  });
});

describe("isSafeProbeArgs public guard", () => {
  it("accepts only recognized help/version probes", () => {
    expect(isSafeProbeArgs(["agent", "--help"])).toBe(true);
    expect(isSafeProbeArgs(["--help"])).toBe(true);
    expect(isSafeProbeArgs(["-v"])).toBe(true);
    expect(isSafeProbeArgs(["agent", "--version"])).toBe(true);
  });

  it("refuses real-run and credential-bearing commands", () => {
    expect(isSafeProbeArgs(["agent", "-p", "do X"])).toBe(false);
    expect(isSafeProbeArgs(["agent", "login"])).toBe(false);
    expect(isSafeProbeArgs(["agent", "--output-format", "json"])).toBe(false);
    expect(isSafeProbeArgs([])).toBe(false);
    expect(isSafeProbeArgs(["agent", "--help", "; rm -rf /"])).toBe(false);
  });
});
