#!/usr/bin/env node
/**
 * Deterministic terminal rendering of the Compaction brand mark.
 *
 * CANONICAL STRING SOURCE for the terminal mark. The CLI helper
 * `src/cli/terminal-logo.ts` mirrors these strings (TypeScript cannot import
 * from scripts/ — tsconfig rootDir is src/ — and scripts/ is not packaged into
 * dist/), and `tests/cli/terminal-logo.test.ts` enforces byte-equality between
 * the two so they cannot drift. Change the mark HERE first; the parity test
 * fails until the mirror is updated.
 *
 * DERIVATION (not a redesign): every measurement comes from the canonical SVG
 * `apps/web/src/assets/compaction-mark.svg` (32x32 viewBox; blue #3231cd
 * rounded square rx=7; three white bars y=8/14.5/21, each 3u tall; top+bottom
 * bars x=8..24 = 16u wide; middle bar x=11..21 = 10u wide, inset 3u per side).
 *
 *   - Horizontal scale: 1 SVG unit = 1 character column (exact). Bars are
 *     16 and 10 columns; the middle inset is exactly 3 columns.
 *   - Bar glyph: U+2580 UPPER HALF BLOCK (top half of the cell filled). One
 *     row per bar reproduces the SVG's thin-band rhythm (3u bar : 3.5u gap
 *     ~ 1:1.17; the half block gives 1:1) with no blank rows in the compact
 *     variant.
 *   - Rounded field (rx=7): expanded variant frames the bars with rounded
 *     box-drawing corners (U+256D/256E/2570/256F) at the full 32-column
 *     viewBox width; the 7-space side margins ARE the SVG's 7u bar margins.
 *     The compact variant drops the field (inverse-mark treatment) and the
 *     field's brand blue transfers to the bars.
 *   - Color: the brand-blue ramp #6d6bff -> #4f46e5 -> #3231cd (same ramp as
 *     the init TUI wordmark) top-to-bottom across the three bars — the
 *     darkening reads as compression. Frame/dim text uses ANSI dim; wordmark
 *     text uses bold. Plain output (no escape codes) when --no-color is
 *     passed or the NO_COLOR env var is set. Renders correctly without any
 *     color support.
 *
 * The canonical SVG geometry is UNCHANGED by this file; this is a derived
 * rendering, not a second logo.
 *
 * Usage: node scripts/render-terminal-logo.mjs [--variant compact|expanded] [--no-color]
 * Zero dependencies. Deterministic output.
 */

const BAR = "▀"; // ▀ UPPER HALF BLOCK

/** Compact lockup (3 lines, <=5 required): mark bands + wordmark, for CLI headers. */
export const COMPACT_PLAIN = [
  `${BAR.repeat(16)}`,
  `   ${BAR.repeat(10)}      compaction`,
  `${BAR.repeat(16)}`
].join("\n");

/** Expanded mark (README hero): full 32-column viewBox with rounded field. */
export const EXPANDED_PLAIN = [
  `╭${"─".repeat(30)}╮`,
  `│${" ".repeat(30)}│`,
  `│       ${BAR.repeat(16)}       │`,
  `│${" ".repeat(30)}│`,
  `│          ${BAR.repeat(10)}          │`,
  `│${" ".repeat(30)}│`,
  `│       ${BAR.repeat(16)}       │`,
  `│${" ".repeat(30)}│`,
  `╰${"─".repeat(30)}╯`,
  "",
  `${" ".repeat(11)}compaction`
].join("\n");

// Brand-blue ramp (identical to src/cli/onboarding/wordmark.ts BLUE_RAMP):
// top -> bottom bar, darkening toward the canonical field blue #3231cd.
export const BLUE_RAMP = ["#6d6bff", "#4f46e5", "#3231cd"];

const RESET = "\u001b[0m";
const BOLD = "\u001b[1m";
const DIM = "\u001b[2m";

/** 24-bit ANSI foreground from a #rrggbb hex string. */
function fg(hex) {
  const n = parseInt(hex.slice(1), 16);
  return `\u001b[38;2;${(n >> 16) & 0xff};${(n >> 8) & 0xff};${n & 0xff}m`;
}

/**
 * Colorize a plain variant: bar runs take the ramp color for their bar index
 * (counted top to bottom), frame glyphs are dim, the wordmark text is bold.
 * Works on both variants because it only recognizes the four glyph classes.
 */
function colorize(plain) {
  let barIndex = 0;
  return plain
    .split("\n")
    .map((line) => {
      if (!line.includes(BAR)) {
        // Frame / blank / caption line: dim any frame glyphs, bold the caption.
        if (/[─│╭╮╰╯]/.test(line)) {
          return `${DIM}${line}${RESET}`;
        }
        return line.includes("compaction") ? line.replace("compaction", `${BOLD}compaction${RESET}`) : line;
      }
      const color = fg(BLUE_RAMP[Math.min(barIndex, BLUE_RAMP.length - 1)]);
      barIndex += 1;
      let out = line.replace(new RegExp(`${BAR}+`), (run) => `${color}${run}${RESET}`);
      if (out.includes("compaction")) out = out.replace("compaction", `${BOLD}compaction${RESET}`);
      // Dim frame glyphs on bar lines (expanded variant's │ borders).
      out = out.replace(/^│/, `${DIM}│${RESET}`).replace(/│$/, `${DIM}│${RESET}`);
      return out;
    })
    .join("\n");
}

export const COMPACT_COLOR = colorize(COMPACT_PLAIN);
export const EXPANDED_COLOR = colorize(EXPANDED_PLAIN);

/**
 * Render a variant. Color defaults ON; disabled by opts.color === false.
 * (The CLI entrypoint below also honors NO_COLOR and --no-color.)
 */
export function renderTerminalLogo(variant = "compact", opts = {}) {
  const useColor = opts.color !== false;
  if (variant === "expanded") return useColor ? EXPANDED_COLOR : EXPANDED_PLAIN;
  if (variant === "compact") return useColor ? COMPACT_COLOR : COMPACT_PLAIN;
  throw new Error(`unknown variant: ${variant} (expected "compact" or "expanded")`);
}

// CLI entrypoint: node scripts/render-terminal-logo.mjs --variant compact|expanded [--no-color]
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const vIdx = args.indexOf("--variant");
  const variant = vIdx !== -1 ? args[vIdx + 1] : "compact";
  const color = !args.includes("--no-color") && process.env.NO_COLOR === undefined;
  try {
    process.stdout.write(`${renderTerminalLogo(variant, { color })}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
