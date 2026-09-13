# Compaction terminal mark — derived rendering of the brand SVG

Status: shipped (renderer + CLI top-level help banner).

## The rule

Canonical string source for the terminal rendering:
`scripts/render-terminal-logo.mjs` (zero-dependency, deterministic). The packaged CLI
mirror `src/cli/terminal-logo.ts` must stay byte-identical to it —
`tests/cli/terminal-logo.test.ts` enforces the parity, so the strings cannot drift.
(The mirror exists because tsconfig `rootDir` is `src/` and `scripts/` is not packaged
into `dist/`.)

## What the SVG mark is

`compaction-mark.svg`, 32×32 viewBox:

| Element | Geometry | Meaning |
| --- | --- | --- |
| Field | rounded square `x=1 y=1 w=30 h=30 rx=7`, brand blue `#3231cd` | the container / context window |
| Top bar | white, `x=8..24` (16u wide), `y=8`, 3u tall | uncompacted context |
| Middle bar | white, `x=11..21` (10u wide), `y=14.5`, 3u tall — inset exactly 3u per side | the compact center band |
| Bottom bar | white, `x=8..24` (16u wide), `y=21`, 3u tall | uncompacted context |

The motif: outer bars converge toward a compact center band — compression, folding,
context control. The derivation below preserves every one of those measurements.

## SVG → character mapping (the derivation, explicitly)

- **Horizontal scale: 1 SVG unit = 1 character column (exact).** Top/bottom bars are
  16 columns, the middle bar is 10 columns, and the middle inset is exactly
  3 columns per side (`11 − 8 = 3` in SVG units).
- **Bar glyph: `▀` U+2580 UPPER HALF BLOCK.** The SVG bars are thin bands: 3u tall on
  a 6.5u vertical rhythm (bar:gap ≈ 1:1.17). A row of `▀` fills the top half of the
  cell and leaves the bottom half empty (1:1) — three consecutive `▀` rows reproduce
  the band rhythm with no blank rows, which is what keeps the compact variant at
  3 lines.
- **Rounded field → rounded box drawing.** The `rx=7` corner radius becomes the
  rounded corners `╭ ╮ ╰ ╯` (U+256D/256E/2570/256F) with `─`/`│` edges. The expanded
  frame is exactly **32 columns = the viewBox width**, and the 7-space margins
  between frame and bars ARE the SVG's 7u bar margins (`8 − 1 = 7`, `31 − 24 = 7`).
- **Vertical compression (expanded variant).** Character cells are ~2× taller than
  wide, so the vertical axis uses one interior row per SVG gap instead of a 1:1 unit
  map (a literal 1u=1row square would be 16+ rows tall). The SVG's *even* 6.5u bar
  rhythm and *equal* top/bottom margins are preserved as even blank-row spacing and
  equal blank rows above/below the bars.
- **Field color transfer (compact variant).** The SVG is white-on-blue. A terminal
  cannot assume a background, so the compact variant drops the field (standard
  inverse-mark treatment) and the field's brand blue transfers to the bars.

Deliberately NOT used: figlet lettering (that is the init TUI *wordmark*, a separate
existing asset), shading blocks (`░▒▓`), slashes/pipes ASCII-art, or any glyph that
does not correspond to a shape in the SVG.

## Character palette

| Glyph | Codepoint | Derived from |
| --- | --- | --- |
| `▀` | U+2580 UPPER HALF BLOCK | the three 3u-tall white bars |
| `╭ ╮ ╰ ╯` | U+256D/256E/2570/256F | the `rx=7` rounded corners |
| `─` `│` | U+2500 / U+2502 | the field edges |

All are classic block/box-drawing characters with universal monospace and terminal
font coverage.

## Variants

Render with `node scripts/render-terminal-logo.mjs --variant compact|expanded
[--no-color]`.

### Compact (3 lines — CLI headers)

```text
▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
   ▀▀▀▀▀▀▀▀▀▀      compaction
▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
```

Bars 16/10/16 columns, middle inset 3 — the exact SVG widths.

### Expanded (README hero / docs)

```text
╭──────────────────────────────╮
│                              │
│       ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀       │
│                              │
│          ▀▀▀▀▀▀▀▀▀▀          │
│                              │
│       ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀       │
│                              │
╰──────────────────────────────╯

           compaction
```

Frame = 32 columns = the SVG viewBox; 7-column bar margins = the SVG's 7u margins.

## Color guidance (ANSI-safe, degrades to plain)

| Layer | Treatment | ANSI |
| --- | --- | --- |
| Bars, top → bottom | brand-blue ramp `#6d6bff → #4f46e5 → #3231cd` (identical to the init TUI wordmark ramp in `src/cli/onboarding/wordmark.ts`; the darkening toward the canonical field blue reads as compression) | 24-bit fg `38;2;R;G;B` |
| Frame (expanded) | dim default foreground | `2` |
| `compaction` wordmark | bold default foreground | `1` |

Degradation rules (all implemented in the renderer / CLI helper):

- `--no-color` or the `NO_COLOR` env var → plain glyphs, zero escape codes.
- CLI banner: color only when the target stream is a TTY — pipes, redirects, and CI
  always get plain glyphs.
- The glyphs alone carry the mark: stripping every escape code yields the plain
  variant byte-for-byte (asserted in the tests). No color support is ever required.
- No teal/cyan, no rainbow, no background fills — blue ramp + dim + bold only.

## Usage matrix

| Surface | Variant | Color | Status |
| --- | --- | --- | --- |
| CLI top-level help (`compaction --help`, bare `compaction`) | compact | TTY-only | shipped — `program.addHelpText("before", …)` in `src/cli/index.ts`; three lines above `Usage:`; no exit-code or command-output changes; subcommand help and `--version` untouched |
| `compaction init` TUI hero | (unchanged) | — | the existing figlet COMPACTION wordmark (`src/cli/onboarding/wordmark.ts`) remains the init hero; the compact mark does not replace it |
