/**
 * CLI glue for the Cursor live-prep preflight. Surfaced before a LIVE `run cursor` / `capture cursor`
 * (no `--export`) so the operator gets a content-free readiness check + exact guidance instead of an
 * opaque "Authentication required" / missing-CLI failure.
 *
 * SAFETY (inherited from the core module): CLI-presence + capability probes ONLY (`--help`), never a
 * real `-p` prompt, never `cursor agent login`, never a CURSOR_API_KEY read. Fail-friendly.
 *
 * The gate is advisory-by-readiness: if the CLI is missing or not capable, the live run cannot succeed,
 * so we print guidance and DECLINE to spawn (returns false). If CLI+capability are present, auth is the
 * only remaining unknown, we cannot detect it safely, so we print a short auth reminder and PROCEED
 * (returns true); if the real run then fails auth, the wrapper's post-run guidance points back here.
 */
import chalk from "chalk";
import { runCursorPreflight, type CursorPreflightReport } from "../core/cursor-preflight.js";
import { createSafeCursorProbe } from "../core/cursor-preflight-probe.js";

/**
 * Run the preflight (safe probes) and return the report. Never throws.
 *
 * `COMPACTION_CURSOR_BIN` (optional): when set to a non-empty path, it is used as the SOLE candidate the
 * safe probe checks, instead of the default PATH names + the hardcoded macOS app path. This is (a) a real
 * operator override for a non-standard Cursor CLI location, and (b) what makes this path deterministic in
 * tests: pointing it at a non-existent binary makes the probe fail fast (ENOENT) so the CLI never spawns
 * the real, possibly-hanging Cursor binary. Still a `--help`/`-v` capability probe only, never `-p`,
 * never `login`, never a key read.
 */
export async function cursorLivePreflight(): Promise<CursorPreflightReport> {
  const override = process.env.COMPACTION_CURSOR_BIN?.trim();
  return runCursorPreflight(createSafeCursorProbe(), override ? [override] : undefined);
}

/**
 * Print the preflight guidance and decide whether the live run may proceed.
 * - CLI not resolvable OR capability absent → print guidance, return false (do NOT spawn a live run).
 * - CLI present + capable → print the auth reminder, return true (proceed; auth verified only by a real
 *   run the operator has authorized).
 */
export async function gateCursorLiveRun(): Promise<boolean> {
  const report = await cursorLivePreflight();
  for (const line of report.guidance) console.log(report.ready ? line : chalk.yellow(line));
  if (!report.ready) {
    console.log(
      chalk.yellow(
        "  Live Cursor run not started: fix the above, then retry. (Or use --export <saved output> to process a saved run offline.)"
      )
    );
  }
  return report.ready;
}
