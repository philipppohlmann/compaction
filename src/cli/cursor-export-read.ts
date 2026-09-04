/**
 * Honest `--export <file>` read for the Cursor commands (`capture cursor` / `run cursor`).
 *
 * Wraps the read so a missing / unreadable / directory / too-large export produces an
 * ACTIONABLE, honest error instead of a raw Node errno line: what failed, on which path, and
 * what a valid Cursor export is, then exit code 1.
 *
 * Invariant: a failed read NEVER fabricates a trace or token
 * counts, nothing is written, nothing is counted, no silent zeros. Tokens on the Cursor path
 * remain LOCAL-ESTIMATE / unavailable-with-reason because Compaction does not ingest Cursor's
 * conditional `result.usage` fields.
 */
import { readFile } from "node:fs/promises";

export type CursorExportRead = { ok: true; rawOutput: string } | { ok: false; errorLines: string[] };

/** One-line errno-ish reason without the raw stack/prefix noise. */
function readFailureReason(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  switch (code) {
    case "ENOENT":
      return "file not found";
    case "EACCES":
    case "EPERM":
      return "permission denied";
    case "EISDIR":
      return "path is a directory, not a file";
    case "EFBIG":
    case "ERR_FS_FILE_TOO_LARGE":
      return "file is too large to read into memory";
    default:
      return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Read a saved Cursor headless output for `--export`. On failure returns honest, actionable
 * error lines for the caller to print (stderr) alongside `process.exitCode = 1`, never a throw,
 * never a stack trace, never a fabricated capture.
 */
export async function readCursorExportFile(exportPath: string): Promise<CursorExportRead> {
  try {
    return { ok: true, rawOutput: await readFile(exportPath, "utf8") };
  } catch (error) {
    return {
      ok: false,
      errorLines: [
        `error: could not read --export file '${exportPath}': ${readFailureReason(error)}.`,
        "  Expected a saved Cursor headless output file: the stdout of `cursor agent -p \"…\" --output-format json` (or stream-json).",
        "  Nothing was captured or counted (no artifacts written). Fix the path/file and retry,",
        "  or run the LIVE path instead (preflight included): compaction run cursor --out <dir> -- cursor agent -p \"…\" --output-format json"
      ]
    };
  }
}
