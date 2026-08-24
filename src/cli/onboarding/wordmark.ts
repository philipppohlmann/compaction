/**
 * Deterministic, dependency-free framed-outline block wordmark for the
 * COMPACTION TUI hero.
 *
 * This restores the earlier "framed-outline / inline-outline" 3D treatment: the
 * exact glyph art of figlet's "ANSI Shadow" font for the fixed word COMPACTION,
 * BAKED IN as a constant (no figlet dependency, lean, deterministic, testable).
 * Each glyph is a solid '█' fill framed by box-drawing outline strokes
 * (     ) that give the inline 3D depth, NOT a separate offset shadow,
 * NOT a dotted/ghost backdrop.
 *
 * The component paints the FILL with a restrained 2-3 shade Compaction-blue
 * vertical gradient and the OUTLINE strokes with one darker brand-blue tone.
 */

export type Layer = "fill" | "outline" | "empty";
export interface Segment {
  text: string;
  layer: Layer;
}

// Baked "ANSI Shadow" rendering of COMPACTION (figlet). Do not hand-edit the
// box-drawing characters; regenerate from figlet if the word ever changes.
const LINES: string[] = [
  " ██████╗ ██████╗ ███╗   ███╗██████╗  █████╗  ██████╗████████╗██╗ ██████╗ ███╗   ██╗",
  "██╔════╝██╔═══██╗████╗ ████║██╔══██╗██╔══██╗██╔════╝╚══██╔══╝██║██╔═══██╗████╗  ██║",
  "██║     ██║   ██║██╔████╔██║██████╔╝███████║██║        ██║   ██║██║   ██║██╔██╗ ██║",
  "██║     ██║   ██║██║╚██╔╝██║██╔═══╝ ██╔══██║██║        ██║   ██║██║   ██║██║╚██╗██║",
  "╚██████╗╚██████╔╝██║ ╚═╝ ██║██║     ██║  ██║╚██████╗   ██║   ██║╚██████╔╝██║ ╚████║",
  " ╚═════╝ ╚═════╝ ╚═╝     ╚═╝╚═╝     ╚═╝  ╚═╝ ╚═════╝   ╚═╝   ╚═╝ ╚═════╝ ╚═╝  ╚═══╝"
];

const FILL = "█";
const BLOCK_W = 83;
const SPACED = "C O M P A C T I O N";

// Classify each cell: solid fill, outline frame stroke, or empty.
function buildGrid(): Segment[][] {
  return LINES.map((line) => {
    const padded = line.padEnd(BLOCK_W, " ");
    const segs: Segment[] = [];
    let cur: Segment | null = null;
    for (const ch of padded) {
      const layer: Layer = ch === " " ? "empty" : ch === FILL ? "fill" : "outline";
      if (cur && cur.layer === layer) cur.text += ch;
      else {
        cur = { layer, text: ch };
        segs.push(cur);
      }
    }
    return segs;
  });
}

const BLOCK = buildGrid();

export interface Wordmark {
  rows: Segment[][];
  /** "block" (framed-outline glyphs) or "text" (spaced fallback for narrow terminals). */
  kind: "block" | "text";
  width: number;
  height: number;
}

export function renderWordmark(maxWidth: number): Wordmark {
  if (maxWidth >= BLOCK_W) {
    return { rows: BLOCK, kind: "block", width: BLOCK_W, height: BLOCK.length };
  }
  return {
    rows: [[{ text: SPACED, layer: "fill" }]],
    kind: "text",
    width: SPACED.length,
    height: 1
  };
}

// Restrained blue-only vertical gradient for the FILL, at most three
// blue/indigo shades, no teal/cyan. One hex per row, sampled to the row count.
const BLUE_RAMP = ["#6d6bff", "#4f46e5", "#3231cd"];

export function fillGradient(rowCount: number): string[] {
  if (rowCount <= 1) return [BLUE_RAMP[0]];
  const out: string[] = [];
  for (let i = 0; i < rowCount; i++) {
    const t = i / (rowCount - 1);
    const idx = Math.min(BLUE_RAMP.length - 1, Math.round(t * (BLUE_RAMP.length - 1)));
    out.push(BLUE_RAMP[idx]);
  }
  return out;
}
