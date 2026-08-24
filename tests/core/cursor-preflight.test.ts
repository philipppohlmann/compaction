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

/**
 * Cursor LIVE-PREP preflight. Exercises the PURE
 * classifier + injectable-probe runner against SYNTHETIC probe outputs, NO live `cursor agent` call.
 *
 * Defining safety rails asserted here: CLI-presence + capability detection ONLY; auth is NEVER checked
 * (authState always "not-checked"); guidance always tells the operator to `cursor agent login` or set
 * CURSOR_API_KEY and retry; nothing prints/reads a credential; the exact live command is surfaced.
 */

// Synthetic help text that DOES advertise the headless capability (present + capable).
const CAPABLE_HELP = [
  "Usage: cursor agent [options] [prompt]",
  "Options:",
  "  -p, --print            print result and exit (non-interactive)",
  "  --output-format <fmt>  text | json | stream-json",
  "  -h, --help             display help"
].join("\n");

// Synthetic help text for the Cursor EDITOR launcher (resolves, but NO headless flags).
const LAUNCHER_HELP = ["Usage: cursor [options] [paths...]", "  -v, --version   print version", "  -h, --help      print help"].join("\n");

function probeResult(candidate: string, over: Partial<CursorProbeResult> = {}): CursorProbeResult {
  return { candidate, resolved: true, helpText: "", exitCode: 0, ...over };
}

describe("classifyCursorPreflight - present + capable / launcher-only / absent (synthetic probes)", () => {
  it("present + capable: ready, capability yes, resolvedCli set, auth NOT checked", () => {
    const report = classifyCursorPreflight([probeResult("cursor-agent", { helpText: CAPABLE_HELP })]);
    expect(report.cliResolvable).toBe(true);
    expect(report.capabilityPresent).toBe(true);
    expect(report.ready).toBe(true);
    expect(report.resolvedCli).toBe("cursor-agent");
    // Auth is NEVER inferred, even when everything else is ready.
    expect(report.authState).toBe("not-checked");
    const g = report.guidance.join("\n");
    expect(g).toContain("Auth: NOT checked here");
    expect(g).toContain("cursor agent login");
    expect(g).toContain("CURSOR_API_KEY");
    expect(g).toContain(CURSOR_EXAMPLE_RUN_COMMAND);
    // Honesty binding is restated: local-estimate only, no savings.
    expect(g).toMatch(/LOCAL-ESTIMATE only/);
  });

  it("CLI resolves but is the launcher (no headless flags): resolvable yes, capability NO, not ready", () => {
    const report = classifyCursorPreflight([probeResult("cursor", { helpText: LAUNCHER_HELP })]);
    expect(report.cliResolvable).toBe(true);
    expect(report.capabilityPresent).toBe(false);
    expect(report.ready).toBe(false);
    expect(report.resolvedCli).toBe("cursor");
    const g = report.guidance.join("\n");
    expect(g).toContain("did not advertise the headless flags");
    expect(g).toContain("cursor agent login");
    expect(g).toContain(CURSOR_EXAMPLE_RUN_COMMAND);
  });

  it("absent: no candidate resolved → not resolvable, not ready, install guidance + macOS path", () => {
    const report = classifyCursorPreflight([
      probeResult("cursor-agent", { resolved: false, exitCode: null, helpText: "" }),
      probeResult("cursor", { resolved: false, exitCode: null, helpText: "" }),
      probeResult(CURSOR_CLI_KNOWN_MACOS_PATH, { resolved: false, exitCode: null, helpText: "" })
    ]);
    expect(report.cliResolvable).toBe(false);
    expect(report.capabilityPresent).toBe(false);
    expect(report.ready).toBe(false);
    expect(report.resolvedCli).toBeUndefined();
    const g = report.guidance.join("\n");
    expect(g).toContain("Cursor headless CLI was not found");
    expect(g).toContain(CURSOR_CLI_KNOWN_MACOS_PATH);
    expect(g).toContain("cursor agent login");
    expect(g).toContain("CURSOR_API_KEY");
    expect(g).toContain(CURSOR_EXAMPLE_RUN_COMMAND);
    // authState stays not-checked even when the CLI is absent.
    expect(report.authState).toBe("not-checked");
  });

  it("prefers a resolved+capable candidate over a resolved-but-incapable one", () => {
    const report = classifyCursorPreflight([
      probeResult("cursor", { helpText: LAUNCHER_HELP }), // resolves, not capable
      probeResult("cursor-agent", { helpText: CAPABLE_HELP }) // resolves AND capable
    ]);
    expect(report.ready).toBe(true);
    expect(report.resolvedCli).toBe("cursor-agent");
  });

  it("a capability signal requires BOTH -p/--print AND --output-format (not just one)", () => {
    const onlyPrint = classifyCursorPreflight([probeResult("cursor-agent", { helpText: "  -p, --print   run" })]);
    expect(onlyPrint.capabilityPresent).toBe(false);
    const onlyFormat = classifyCursorPreflight([probeResult("cursor-agent", { helpText: "  --output-format json" })]);
    expect(onlyFormat.capabilityPresent).toBe(false);
  });

  it("guidance NEVER instructs an automatic login or prints a credential value", () => {
    const g = classifyCursorPreflight([probeResult("cursor-agent", { helpText: CAPABLE_HELP })]).guidance.join("\n");
    // It tells the OPERATOR to log in; it never claims the tool did it.
    expect(g).toMatch(/run `cursor agent login`|Authenticate: run `cursor agent login`/);
    expect(g).not.toMatch(/logging in|logged you in|authenticated automatically/i);
    // It never echoes an API key value (only the env var NAME).
    expect(g).not.toMatch(/CURSOR_API_KEY\s*=/);
  });
});

describe("runCursorPreflight - SAFE probe args only, never a real prompt", () => {
  it("probes each candidate with SAFE help args ONLY (no -p, no login) and classifies", async () => {
    const seen: Array<{ candidate: string; args: string[] }> = [];
    const probe: CursorProbe = async (candidate, args) => {
      seen.push({ candidate, args });
      // Only the headless binary resolves + is capable (capability on its top-level --help).
      if (candidate !== "cursor-agent") return probeResult(candidate, { resolved: false, exitCode: null, helpText: "" });
      return probeResult(candidate, { helpText: args.includes("agent") ? "reduced help" : CAPABLE_HELP });
    };
    const report = await runCursorPreflight(probe, ["cursor-agent", "cursor"]);
    expect(report.ready).toBe(true);
    // Every probe used ONLY safe help args, never a prompt, never `login`, never `-p`, never a real-run flag.
    const ALLOWED = new Set(["agent", "--help"]);
    for (const call of seen) {
      for (const a of call.args) expect(ALLOWED.has(a)).toBe(true);
      expect(call.args).not.toContain("-p");
      expect(call.args).not.toContain("login");
      expect(call.args).not.toContain("--output-format");
    }
    // Both help forms were attempted per candidate (subcommand + top-level).
    expect(seen.filter((c) => c.candidate === "cursor-agent").map((c) => c.args)).toEqual([["agent", "--help"], ["--help"]]);
  });

  it("default candidate list includes the known macOS app path as a fallback", async () => {
    const seen: string[] = [];
    const probe: CursorProbe = async (candidate) => {
      seen.push(candidate);
      return probeResult(candidate, { resolved: false, exitCode: null, helpText: "" });
    };
    await runCursorPreflight(probe);
    expect(seen).toContain(CURSOR_CLI_KNOWN_MACOS_PATH);
  });
});

describe("isSafeProbeArgs - the defense-in-depth guard in the real probe adapter", () => {
  it("accepts ONLY recognized help/version probes", () => {
    expect(isSafeProbeArgs(["agent", "--help"])).toBe(true);
    expect(isSafeProbeArgs(["--help"])).toBe(true);
    expect(isSafeProbeArgs(["-v"])).toBe(true);
    expect(isSafeProbeArgs(["agent", "--version"])).toBe(true);
  });

  it("REFUSES anything that could be a real run or a credential surface", () => {
    expect(isSafeProbeArgs(["agent", "-p", "do X"])).toBe(false); // a real prompt
    expect(isSafeProbeArgs(["agent", "login"])).toBe(false); // login
    expect(isSafeProbeArgs(["agent", "--output-format", "json"])).toBe(false); // real-run flag
    expect(isSafeProbeArgs([])).toBe(false); // empty is not a valid probe
    expect(isSafeProbeArgs(["agent", "--help", "; rm -rf /"])).toBe(false); // injected token
  });
});
