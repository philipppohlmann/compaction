import chalk from "chalk";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { Command } from "commander";
import { calculateCost } from "../../core/cost-calculator.js";
import { formatAnalyzeReport } from "../../core/report-generator.js";
import { estimateTraceTokens } from "../../core/token-estimator.js";
import type { UsageMetadata } from "../../core/usage-metadata.js";
import { detectWaste, buildSkillInjectionAdvisory } from "../../core/waste-detector.js";
import { parseTraceFile } from "../../core/trace-parser.js";

/**
 * Try to load sibling capture-report.json from the same directory as the trace file.
 * Returns the usage metadata if found and valid, otherwise undefined.
 * Never throws, missing or malformed capture-report.json is silently ignored.
 */
async function tryLoadCaptureUsage(traceFile: string): Promise<UsageMetadata | undefined> {
  try {
    const dir = dirname(traceFile);
    const captureReportPath = join(dir, "capture-report.json");
    const raw = await readFile(captureReportPath, "utf8");
    const parsed = JSON.parse(raw) as { usage?: UsageMetadata };
    if (parsed.usage && typeof parsed.usage === "object") {
      return parsed.usage as UsageMetadata;
    }
  } catch {
    // No capture-report.json, or unreadable/malformed, silently ignore.
  }
  return undefined;
}

export function registerAnalyzeCommand(program: Command): void {
  program
    .command("analyze")
    .argument("<trace-file>", "Path to a local agent trace JSON file")
    .description("Analyze a trace and print token, cost, and waste estimates.")
    .action(async (traceFile: string) => {
      const trace = await parseTraceFile(traceFile);
      const tokens = estimateTraceTokens(trace);
      const findings = detectWaste(trace);
      // Report-only skill-injection advisory. Built from a SEPARATE detector; nothing is
      // compacted and it never affects `findings` / the tool-output compaction path.
      const skillInjectionAdvisory = buildSkillInjectionAdvisory(trace);

      // Load usage from sibling capture-report.json if available (provides cache token counts).
      const captureUsage = await tryLoadCaptureUsage(traceFile);
      const cost = calculateCost(
        trace.model,
        tokens,
        captureUsage
          ? { cacheReadTokens: captureUsage.cache_read_input_tokens, cacheCreationTokens: captureUsage.cache_creation_input_tokens }
          : undefined
      );

      console.log(chalk.cyan("compaction analyze"));
      console.log(formatAnalyzeReport(trace, tokens, cost, findings, captureUsage, skillInjectionAdvisory));

      // Exact next command to continue the loop (chaining), with the trace path the user passed.
      console.log("");
      console.log(chalk.bold("Next: see the recommended policy and estimated delta:"));
      console.log(`  compaction recommend ${traceFile}`);
      console.log(`  compaction compact ${traceFile} --out <dir>   # before/after delta + named policy + safety report`);
    });
}
