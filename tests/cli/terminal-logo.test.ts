import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

// The canonical string source (design lives here)…
import {
  COMPACT_COLOR as SCRIPT_COMPACT_COLOR,
  COMPACT_PLAIN as SCRIPT_COMPACT_PLAIN,
  EXPANDED_COLOR as SCRIPT_EXPANDED_COLOR,
  EXPANDED_PLAIN as SCRIPT_EXPANDED_PLAIN,
  renderTerminalLogo
  // eslint-disable-next-line import/no-relative-packages
} from "../../scripts/render-terminal-logo.mjs";
// …and the packaged CLI mirror that must byte-match it.
import { COMPACT_COLOR as CLI_COMPACT_COLOR, COMPACT_PLAIN as CLI_COMPACT_PLAIN } from "../../src/cli/terminal-logo.js";
import { createRequire } from "node:module";

const pkgVersion: string = createRequire(import.meta.url)("../../package.json").version;

const exec = promisify(execFile);
const CLI = path.resolve("dist/cli/index.js");
const SCRIPT = path.resolve("scripts/render-terminal-logo.mjs");
const BAR = "▀";

/**
 * Snapshot + parity guard for the terminal brand mark (derived rendering of
 * apps/web/src/assets/compaction-mark.svg, see docs/brand/terminal-logo.md).
 * The geometry assertions encode the SVG derivation (16u/10u bars, 3u middle
 * inset, 32u viewBox width) so an accidental "redesign" fails loudly.
 */

describe("terminal logo renderer (scripts/render-terminal-logo.mjs)", () => {
  it("compact plain variant is the exact 3-line lockup", () => {
    expect(SCRIPT_COMPACT_PLAIN).toBe(
      [`${BAR.repeat(16)}`, `   ${BAR.repeat(10)}      compaction`, `${BAR.repeat(16)}`].join("\n")
    );
  });

  it("expanded plain variant is the exact framed mark + caption", () => {
    expect(SCRIPT_EXPANDED_PLAIN).toBe(
      [
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
      ].join("\n")
    );
  });

  it("encodes the SVG geometry: 16u/10u bars, 3u middle inset, 32u frame width", () => {
    const [top, middle, bottom] = SCRIPT_COMPACT_PLAIN.split("\n");
    expect(top).toBe(BAR.repeat(16)); // top bar x=8..24 -> 16 columns
    expect(bottom).toBe(BAR.repeat(16)); // bottom bar x=8..24 -> 16 columns
    expect(middle.startsWith(`   ${BAR.repeat(10)}`)).toBe(true); // middle x=11..21 -> inset 3, width 10
    for (const line of SCRIPT_EXPANDED_PLAIN.split("\n").slice(0, 9)) {
      expect([...line].length).toBe(32); // expanded frame = the 32u viewBox width
    }
  });

  it("colored variants wrap bars in the brand-blue ramp and reset cleanly", () => {
    for (const colored of [SCRIPT_COMPACT_COLOR, SCRIPT_EXPANDED_COLOR]) {
      expect(colored).toContain("\u001b[38;2;109;107;255m"); // #6d6bff (top bar)
      expect(colored).toContain("\u001b[38;2;79;70;229m"); // #4f46e5 (middle bar)
      expect(colored).toContain("\u001b[38;2;50;49;205m"); // #3231cd (bottom bar / field blue)
      expect(colored).toContain("\u001b[1mcompaction\u001b[0m"); // bold wordmark
      // Stripping escape codes recovers the plain variant exactly (no glyph drift).
      // eslint-disable-next-line no-control-regex
      expect(colored.replace(/\u001b\[[0-9;]*m/g, "")).toBe(
        colored === SCRIPT_COMPACT_COLOR ? SCRIPT_COMPACT_PLAIN : SCRIPT_EXPANDED_PLAIN
      );
    }
  });

  it("renderTerminalLogo selects variants and rejects unknown ones", () => {
    expect(renderTerminalLogo("compact", { color: false })).toBe(SCRIPT_COMPACT_PLAIN);
    expect(renderTerminalLogo("expanded", { color: false })).toBe(SCRIPT_EXPANDED_PLAIN);
    expect(renderTerminalLogo("compact", { color: true })).toBe(SCRIPT_COMPACT_COLOR);
    expect(renderTerminalLogo("expanded", { color: true })).toBe(SCRIPT_EXPANDED_COLOR);
    expect(() => renderTerminalLogo("mega")).toThrow(/unknown variant/);
  });

  it("script CLI prints the plain variants with --no-color and honors NO_COLOR", async () => {
    const env = { ...process.env };
    delete env.NO_COLOR;
    const compact = await exec("node", [SCRIPT, "--variant", "compact", "--no-color"], { env });
    expect(compact.stdout).toBe(`${SCRIPT_COMPACT_PLAIN}\n`);
    const expanded = await exec("node", [SCRIPT, "--variant", "expanded", "--no-color"], { env });
    expect(expanded.stdout).toBe(`${SCRIPT_EXPANDED_PLAIN}\n`);
    const colored = await exec("node", [SCRIPT, "--variant", "compact"], { env });
    expect(colored.stdout).toBe(`${SCRIPT_COMPACT_COLOR}\n`);
    const noColorEnv = await exec("node", [SCRIPT, "--variant", "compact"], { env: { ...env, NO_COLOR: "1" } });
    expect(noColorEnv.stdout).toBe(`${SCRIPT_COMPACT_PLAIN}\n`);
  });
});

describe("CLI mirror parity (src/cli/terminal-logo.ts vs canonical script)", () => {
  it("compact strings are byte-identical (mirror cannot drift from the design source)", () => {
    expect(CLI_COMPACT_PLAIN).toBe(SCRIPT_COMPACT_PLAIN);
    expect(CLI_COMPACT_COLOR).toBe(SCRIPT_COMPACT_COLOR);
  });
});

describe("compaction --help banner", () => {
  it("top-level --help opens with the plain compact mark (non-TTY -> no escape codes), then Usage", async () => {
    const { stdout } = await exec("node", [CLI, "--help"]);
    expect(stdout.startsWith(`${SCRIPT_COMPACT_PLAIN}\n\n`)).toBe(true);
    expect(stdout).not.toContain("\u001b["); // piped output stays escape-free
    expect(stdout).toContain("Usage: compaction");
  });

  it("subcommand help and --version stay banner-free", async () => {
    const analyze = await exec("node", [CLI, "analyze", "--help"]);
    expect(analyze.stdout).not.toContain(BAR);
    const version = await exec("node", [CLI, "--version"]);
    expect(version.stdout.trim()).toBe(pkgVersion);
    expect(version.stdout).not.toContain(BAR);
  });
});
