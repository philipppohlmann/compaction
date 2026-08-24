/**
 * Compact terminal brand mark for CLI headers.
 *
 * MIRROR of the canonical strings in `scripts/render-terminal-logo.mjs` (the
 * single design source for the terminal mark). This mirror exists because
 * TypeScript cannot import from scripts/ (tsconfig rootDir is src/) and
 * scripts/ is not packaged into dist/. `tests/cli/terminal-logo.test.ts`
 * enforces byte-equality between this module and the script, so the two
 * cannot drift, change the script first, then this mirror.
 *
 * Derivation (see docs/brand/terminal-logo.md): the mark is a derived
 * rendering of `apps/web/src/assets/compaction-mark.svg`, three compression
 * bars (16u / 10u / 16u, middle inset 3u) at 1 SVG unit = 1 column, one
 * U+2580 UPPER HALF BLOCK row per bar. The canonical SVG is unchanged.
 */

const BAR = "▀";

/** Compact lockup, plain (no escape codes). Must byte-match the script's COMPACT_PLAIN. */
export const COMPACT_PLAIN = [
  `${BAR.repeat(16)}`,
  `   ${BAR.repeat(10)}      compaction`,
  `${BAR.repeat(16)}`
].join("\n");

/** Brand-blue ramp, identical to src/cli/onboarding/wordmark.ts BLUE_RAMP. */
export const BLUE_RAMP = ["#6d6bff", "#4f46e5", "#3231cd"] as const;

const RESET = "\u001b[0m";
const BOLD = "\u001b[1m";

function fg(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `\u001b[38;2;${(n >> 16) & 0xff};${(n >> 8) & 0xff};${n & 0xff}m`;
}

/** Compact lockup, colored. Must byte-match the script's COMPACT_COLOR. */
export const COMPACT_COLOR = COMPACT_PLAIN.split("\n")
  .map((line, i) => {
    let out = line.replace(new RegExp(`${BAR}+`), (run) => `${fg(BLUE_RAMP[i])}${run}${RESET}`);
    if (out.includes("compaction")) out = out.replace("compaction", `${BOLD}compaction${RESET}`);
    return out;
  })
  .join("\n");

/**
 * The compact mark for a help banner on the given stream: colored only when
 * the stream is a TTY and NO_COLOR is unset (degrades to plain glyphs in
 * pipes, files, CI, and color-hostile terminals).
 */
export function compactMarkFor(stream: NodeJS.WriteStream): string {
  const useColor = stream.isTTY === true && process.env.NO_COLOR === undefined;
  return useColor ? COMPACT_COLOR : COMPACT_PLAIN;
}
