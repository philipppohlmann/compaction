import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";

/**
 * The allowance re-check is COMPILER-ENFORCED, not conventional.
 *
 * `appendUsageEvent` writes metered debits and nothing else, so every append must carry the ceiling
 * that is re-validated under the append lock. While `ceiling` was optional, the invariant was
 * enforced by type on the metering context and by convention here — the same asymmetry that let the
 * original check-then-debit race exist. A behaviour test cannot observe a missing field that
 * type-checks; this compiles a fixture and asserts the omission is a compile error.
 */
const journal = join(process.cwd(), "src", "core", "usage", "usage-journal.ts");
const event = join(process.cwd(), "src", "core", "usage", "usage-event.ts");

function compile(source: string): ts.Diagnostic[] {
  const dir = mkdtempSync(join(tmpdir(), "ceiling-required-"));
  dirs.push(dir);
  const file = join(dir, "fixture.ts");
  writeFileSync(file, source, "utf8");
  const program = ts.createProgram([file], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    noEmit: true,
    skipLibCheck: true
  });
  return [...program.getSemanticDiagnostics(program.getSourceFile(file))];
}

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

const PREAMBLE =
  `import { appendUsageEvent } from ${JSON.stringify(journal.replace(/\.ts$/, ".js"))};\n` +
  `import type { UsageEvent } from ${JSON.stringify(event.replace(/\.ts$/, ".js"))};\n` +
  "declare const event: UsageEvent;\n";

describe("appendUsageEvent requires the allowance ceiling", () => {
  it("an append WITHOUT a ceiling does not compile", () => {
    const diagnostics = compile(`${PREAMBLE}void appendUsageEvent(event, "sig", {});\n`);
    expect(diagnostics).toHaveLength(1);
    expect(ts.flattenDiagnosticMessageText(diagnostics[0].messageText, " ")).toContain("ceiling");
  });

  it("omitting the options argument entirely does not compile either (there is no default)", () => {
    const diagnostics = compile(`${PREAMBLE}void appendUsageEvent(event, "sig");\n`);
    expect(diagnostics).toHaveLength(1);
  });

  it("an append WITH a ceiling compiles (the requirement is the only thing being enforced)", () => {
    const diagnostics = compile(`${PREAMBLE}void appendUsageEvent(event, "sig", { ceiling: { allowanceTokens: 1 } });\n`);
    expect(diagnostics).toEqual([]);
  });

  it("the ceiling cannot restate the event's period or token count (no drift surface)", () => {
    const diagnostics = compile(
      `${PREAMBLE}void appendUsageEvent(event, "sig", { ceiling: { allowanceTokens: 1, periodId: "2026-07", tokens: 5 } });\n`
    );
    expect(diagnostics.length).toBeGreaterThan(0);
  });
});
