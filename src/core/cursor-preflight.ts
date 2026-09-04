/**
 * Cursor LIVE-PREP preflight/diagnostics (PUBLIC CLI code, engine-free, ships in the npm package).
 *
 * A content-free readiness check surfaced when a LIVE `run cursor` / `capture cursor` is requested
 * (no `--export`). It answers two questions and prints exact actionable guidance so a live Cursor run
 * validates cleanly once the operator authenticates, WITHOUT this tool ever authenticating or spending:
 *
 *   1. **CLI resolvable?**  Is a Cursor headless CLI binary on PATH (`cursor` / `cursor-agent`) or at a
 *      known macOS app path (`/Applications/Cursor.app/Contents/Resources/app/bin/cursor`)?
 *   2. **Capability present?**  Does `<cli> agent --help` (or `--help`) advertise the headless flags we
 *      need (`-p`/`--print` + `--output-format`)?
 *
 * HARD SAFETY RAILS (the defining constraints of this module):
 * - **SAFE probes only.** Probing is limited to `--help` / `-v` / `--version` style invocations. This
 *   module NEVER runs a real `-p` prompt, NEVER runs `cursor agent login`, and NEVER reads, sets, or
 *   prints `CURSOR_API_KEY`.
 * - **Auth-state is NOT checked here.** Cursor exposes a read-only `status|whoami` command, but this
 *   preflight deliberately limits itself to help/version capability probes. It points the operator to
 *   `cursor-agent status` and Cursor's normal authentication flow; it never guesses "authenticated".
 * - **Fail friendly.** A probe that errors/crashes is treated as "not detectable", never a thrown
 *   exception, the pure logic here is total over its synthetic inputs.
 * - **Content-free.** No prompt, no output, no credential value is ever read or emitted.
 *
 * Token-source invariant: Cursor = LOCAL-ESTIMATE only; provider-reported UNAVAILABLE; never a
 * savings claim. This module surfaces none of those figures, it is a readiness check + guidance only.
 */

/** Candidate CLI locations, in probe order. Kept as data so the pure logic is fully testable. */
export const CURSOR_CLI_PATH_CANDIDATES = ["cursor-agent", "cursor"] as const;
export const CURSOR_CLI_KNOWN_MACOS_PATH = "/Applications/Cursor.app/Contents/Resources/app/bin/cursor";

/** The exact command an operator runs once authed (surfaced verbatim in the guidance). */
export const CURSOR_EXAMPLE_RUN_COMMAND =
  'compaction run cursor --out <dir> -- cursor agent -p "<your prompt>" --output-format json';

/**
 * Result of a single SAFE probe of one candidate binary. `helpText` comes from a `--help`/`-v`-style
 * invocation only. `resolved` is false when the binary could not be spawned at all (ENOENT / not
 * executable). This is the ONLY input the pure classifier consumes, so tests can feed synthetic probe
 * outputs with no live `cursor agent` call.
 */
export interface CursorProbeResult {
  /** The candidate that was probed (a PATH name or an absolute path). */
  candidate: string;
  /** True when the binary spawned (even if it exited non-zero); false on ENOENT / spawn failure. */
  resolved: boolean;
  /** Combined help/version text observed from the SAFE probe (stdout + stderr). Content-free (help text). */
  helpText: string;
  /** Exit code of the SAFE probe, or null if it never ran. */
  exitCode: number | null;
}

/**
 * A probe function: given a candidate + safe args, returns what the SAFE probe observed. Injected so
 * the classifier is pure/testable; the real adapter (`createSafeCursorProbe`) spawns `--help`/`-v` only.
 */
export type CursorProbe = (candidate: string, args: string[]) => Promise<CursorProbeResult>;

export interface CursorPreflightReport {
  /** Whether a Cursor CLI binary could be resolved (PATH or known macOS app path). */
  cliResolvable: boolean;
  /** The resolved binary path/name, if any. */
  resolvedCli?: string;
  /** Whether the resolved CLI advertises the headless capability (`-p`/`--print` + `--output-format`). */
  capabilityPresent: boolean;
  /**
   * Auth is intentionally NEVER probed by this help-only preflight. Always "not-checked" so no caller
   * can mistake CLI capability for an "authenticated" signal.
   */
  authState: "not-checked";
  /** Overall readiness of the LOCAL PREP surface: ready = CLI resolvable AND capability present. */
  ready: boolean;
  /** Human-readable, content-free diagnostic + guidance lines (safe to print to stdout). */
  guidance: string[];
}

/** True when help text advertises the headless print flag (`-p` or `--print`). */
function hasPrintFlag(helpText: string): boolean {
  return /(^|\s)-p(\s|,|$)/.test(helpText) || /--print\b/.test(helpText);
}
/** True when help text advertises `--output-format` (the flag that makes output separable). */
function hasOutputFormatFlag(helpText: string): boolean {
  return /--output-format\b/.test(helpText);
}

/**
 * PURE classifier: given the SAFE probe results for the CLI candidates, decide resolvable/capable and
 * build the exact guidance. No I/O, no spawning, no env reads, this is what the tests target directly.
 *
 * A candidate is "capable" when its help text advertises BOTH `-p`/`--print` AND `--output-format`.
 */
export function classifyCursorPreflight(probes: CursorProbeResult[]): CursorPreflightReport {
  const resolvedProbes = probes.filter((p) => p.resolved);
  const cliResolvable = resolvedProbes.length > 0;
  // Prefer a resolved candidate that ALSO shows the capability; else the first resolved one.
  const capableProbe = resolvedProbes.find((p) => hasPrintFlag(p.helpText) && hasOutputFormatFlag(p.helpText));
  const resolvedCli = capableProbe?.candidate ?? resolvedProbes[0]?.candidate;
  const capabilityPresent = capableProbe !== undefined;
  const ready = cliResolvable && capabilityPresent;

  const guidance: string[] = [];
  guidance.push("Cursor live-run preflight (content-free; no prompt run, no login, no API key read):");
  guidance.push(`  - CLI resolvable: ${cliResolvable ? `yes (${resolvedCli})` : "no"}`);
  guidance.push(
    `  - Headless capability (-p/--print + --output-format): ${
      capabilityPresent ? "yes" : cliResolvable ? "not detected in --help" : "n/a (CLI not resolved)"
    }`
  );
  // Auth is deliberately NOT probed - say so explicitly so nobody reads readiness as "authenticated".
  guidance.push(
    "  - Auth: NOT checked here. Check with `cursor-agent status`; if signed out, use Cursor's normal authentication flow (`cursor-agent login`, or `cursor agent login` from the editor launcher) and retry."
  );

  if (!cliResolvable) {
    guidance.push("");
    guidance.push("Next steps - the Cursor headless CLI was not found:");
    guidance.push(
      "  1. Install / locate it: install the Cursor CLI (see cursor.com docs), or if the Cursor app is installed on macOS it ships at:"
    );
    guidance.push(`       ${CURSOR_CLI_KNOWN_MACOS_PATH}`);
    guidance.push("     Ensure `cursor` or `cursor-agent` is on your PATH (the `agent` subcommand provides `-p`/`--output-format`).");
    guidance.push("  2. Authenticate (does NOT happen automatically here): run `cursor agent login`, OR export CURSOR_API_KEY in your shell.");
    guidance.push("  3. Then run the live flow:");
    guidance.push(`       ${CURSOR_EXAMPLE_RUN_COMMAND}`);
  } else if (!capabilityPresent) {
    guidance.push("");
    guidance.push(
      `Next steps - a Cursor CLI was found (${resolvedCli}) but its --help did not advertise the headless flags (-p/--print + --output-format):`
    );
    guidance.push(
      "  - This may be the Cursor editor launcher rather than the headless agent CLI. Install/verify the headless `cursor agent` CLI, then retry."
    );
    guidance.push("  - Authenticate first (not done here): `cursor agent login`, OR set CURSOR_API_KEY.");
    guidance.push("  - Then run the live flow:");
    guidance.push(`       ${CURSOR_EXAMPLE_RUN_COMMAND}`);
  } else {
    guidance.push("");
    guidance.push("The Cursor headless CLI is present and capable. This preflight does not check auth:");
    guidance.push("  1. Check auth: run `cursor-agent status`. If signed out, use Cursor's normal authentication flow (`cursor-agent login`, or `cursor agent login` from the editor launcher), OR export CURSOR_API_KEY.");
    guidance.push("  2. Then run the live flow:");
    guidance.push(`       ${CURSOR_EXAMPLE_RUN_COMMAND}`);
    guidance.push(
      "  Note: Cursor tokens are LOCAL-ESTIMATE only because Compaction does not ingest Cursor's conditional result.usage fields - no provider-reported tokens or savings are claimed."
    );
  }

  return {
    cliResolvable,
    ...(resolvedCli !== undefined ? { resolvedCli } : {}),
    capabilityPresent,
    authState: "not-checked",
    ready,
    guidance
  };
}

/**
 * Run the preflight using an injectable probe. Tries each candidate with a SAFE capability probe
 * (`agent --help`), then classifies. Pure over `probe` - the default real adapter
 * (`createSafeCursorProbe`) is the only place a child process is spawned, and only with `--help`-style
 * args. The candidate order puts the known macOS app path LAST as a fallback when PATH names miss.
 */
export async function runCursorPreflight(
  probe: CursorProbe,
  candidates: readonly string[] = [...CURSOR_CLI_PATH_CANDIDATES, CURSOR_CLI_KNOWN_MACOS_PATH]
): Promise<CursorPreflightReport> {
  const probes: CursorProbeResult[] = [];
  for (const candidate of candidates) {
    // SAFE capability probes ONLY. Never a real prompt, never `login`. We try BOTH help forms because
    // the flags live under different help surfaces across shapes: the standalone `cursor-agent` binary
    // IS the agent (headless flags on its top-level `--help`), while the editor `cursor` launcher
    // exposes them under the `agent` subcommand (`cursor agent --help`). A candidate that resolves in
    // EITHER probe counts as resolved; its help text is the one that best advertises the capability.
    const subcommandHelp = await probe(candidate, ["agent", "--help"]);
    const topLevelHelp = await probe(candidate, ["--help"]);
    probes.push(mergeCandidateProbes(candidate, [subcommandHelp, topLevelHelp]));
  }
  return classifyCursorPreflight(probes);
}

/** Merge the help forms tried for one candidate: resolved if EITHER spawned; keep the help text that
 *  advertises the capability (so a candidate is judged capable if ANY safe help form shows the flags). */
function mergeCandidateProbes(candidate: string, forms: CursorProbeResult[]): CursorProbeResult {
  const resolved = forms.some((f) => f.resolved);
  const capableForm = forms.find((f) => f.resolved && hasPrintFlag(f.helpText) && hasOutputFormatFlag(f.helpText));
  const chosen = capableForm ?? forms.find((f) => f.resolved) ?? forms[0];
  return { candidate, resolved, helpText: chosen?.helpText ?? "", exitCode: chosen?.exitCode ?? null };
}
