/**
 * SAFE real probe adapter for the Cursor live-prep preflight (`cursor-preflight.ts`).
 *
 * This is the ONLY place the preflight spawns a child process, and it spawns ONLY a `--help`/`-v`-style
 * capability probe. Defense-in-depth: it hard-rejects any arg set that is not a recognized safe help
 * probe, so it can NEVER be coaxed into a real `-p` prompt, `cursor agent login`, or a credential read.
 *
 * - No stdin (closed): a probe never waits for input.
 * - stdout/stderr captured only to inspect for the headless flags in --help text (content-free).
 * - CURSOR_API_KEY is never read, set, or forwarded specially, the probe inherits the caller's env
 *   unchanged (we never touch the key), and never prints env values.
 * - Fail-friendly: an ENOENT / spawn error resolves to `resolved:false`, never a throw.
 */
import { spawn } from "node:child_process";
import type { CursorProbe, CursorProbeResult } from "./cursor-preflight.js";

/** Only these tokens may appear in a probe arg list. Anything else is refused (never spawned). */
const SAFE_PROBE_TOKENS = new Set(["agent", "--help", "-h", "--version", "-v"]);

/** True when EVERY arg is a recognized safe help/version token (no prompt, no `-p`, no `login`). */
export function isSafeProbeArgs(args: string[]): boolean {
  if (args.length === 0) return false;
  return args.every((a) => SAFE_PROBE_TOKENS.has(a));
}

/**
 * Create the real SAFE probe. The returned probe spawns `<candidate> <args>` ONLY when `args` is a
 * recognized safe help probe; otherwise it refuses (returns `resolved:false` without spawning).
 */
export function createSafeCursorProbe(timeoutMs = 5000): CursorProbe {
  return (candidate: string, args: string[]): Promise<CursorProbeResult> => {
    return new Promise((resolve) => {
      const notRun = (helpText: string): CursorProbeResult => ({ candidate, resolved: false, helpText, exitCode: null });

      // Defense-in-depth: refuse anything that is not a pure help/version probe.
      if (!isSafeProbeArgs(args)) {
        resolve(notRun("refused: non-help probe args (safety guard)"));
        return;
      }

      let helpText = "";
      let settled = false;
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(candidate, args, {
          shell: false,
          windowsHide: true,
          // Closed stdin so a probe never blocks waiting for input; capture stdout/stderr to read --help.
          stdio: ["ignore", "pipe", "pipe"]
        });
      } catch {
        resolve(notRun(""));
        return;
      }

      const finish = (result: CursorProbeResult): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
        // A hung help probe: treat as resolved (it spawned) but with whatever text we saw.
        finish({ candidate, resolved: true, helpText, exitCode: null });
      }, timeoutMs);
      timer.unref?.();

      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (c: string) => {
        helpText += c;
      });
      child.stderr?.on("data", (c: string) => {
        helpText += c;
      });

      child.on("error", () => {
        // ENOENT / not executable → the binary is not resolvable. Fail-friendly, never throw.
        clearTimeout(timer);
        finish(notRun(""));
      });

      child.on("close", (exitCode) => {
        clearTimeout(timer);
        finish({ candidate, resolved: true, helpText, exitCode: exitCode ?? null });
      });
    });
  };
}
