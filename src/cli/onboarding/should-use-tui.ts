/**
 * Decide whether `compaction init` should launch the interactive Ink TUI or
 * fall back to the plain static screen.
 *
 * The TUI is a progressive enhancement: it renders only in a real interactive
 * terminal. Everywhere else, pipes, CI, NO_COLOR, dumb terminals, the test
 * runner, or when the operator opts out, we serve the byte-stable static
 * screen so scripts, snapshots, and smoke tests never see a control sequence.
 *
 * Pure function over an explicit environment snapshot so it is trivially unit
 * testable without touching the real process.
 */
export interface TuiEnv {
  stdoutIsTTY: boolean;
  stdinIsTTY: boolean;
  env: NodeJS.ProcessEnv;
}

export interface TuiDecision {
  useTui: boolean;
  /** Machine-readable reason the TUI was declined (for tests / --help intuition). */
  reason:
    | "ok"
    | "not-a-tty"
    | "no-color"
    | "ci"
    | "dumb-term"
    | "opted-out"
    | "test-env";
}

export function decideInteractiveTui(e: TuiEnv): TuiDecision {
  // Raw-mode keyboard navigation requires BOTH a TTY stdin and stdout.
  if (!e.stdoutIsTTY || !e.stdinIsTTY) return { useTui: false, reason: "not-a-tty" };

  // Honor NO_COLOR (no-color.org): present, regardless of value → plain output.
  if (e.env.NO_COLOR != null) return { useTui: false, reason: "no-color" };

  // CI systems are non-interactive even when a pseudo-TTY is attached.
  if (e.env.CI != null && e.env.CI !== "" && e.env.CI !== "false" && e.env.CI !== "0") {
    return { useTui: false, reason: "ci" };
  }

  // Terminals that cannot render cursor movement / styling.
  if (e.env.TERM === "dumb") return { useTui: false, reason: "dumb-term" };

  // Test runner, keep first-value output deterministic for snapshots.
  if (e.env.VITEST != null || e.env.NODE_ENV === "test") {
    return { useTui: false, reason: "test-env" };
  }

  // Explicit operator escape hatch. Accept any truthy value (1/true/yes/…),
  // matching the lenient CI convention; "0"/"false"/"" do not opt out.
  const optOut = e.env.COMPACTION_NO_TUI;
  if (optOut != null && optOut !== "" && optOut !== "0" && optOut !== "false") {
    return { useTui: false, reason: "opted-out" };
  }

  return { useTui: true, reason: "ok" };
}

/** Convenience wrapper over the live process. */
export function decideInteractiveTuiFromProcess(): TuiDecision {
  return decideInteractiveTui({
    stdoutIsTTY: Boolean(process.stdout.isTTY),
    stdinIsTTY: Boolean(process.stdin.isTTY),
    env: process.env
  });
}
