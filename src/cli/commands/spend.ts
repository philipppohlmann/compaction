import chalk from "chalk";
import { Command } from "commander";
import { writeSpendArtifacts, loadEngineOptimizationDeltaProvider } from "../../core/spend-attribution.js";

interface SpendOptions {
  out: string;
}

export function registerSpendCommand(program: Command): void {
  program
    .command("spend")
    .description("Summarize local context spend attribution and optimization delta for a trace or optimization summary.")
    .argument("<trace-or-optimization-path>", "Path to a local agent trace JSON or optimization-summary.json")
    .option("--out <dir>", "Output root directory for spend artifacts", ".compaction/spend")
    .action(async (inputPath: string, options: SpendOptions) => {
      // `spend` is a FREE command: local token/cost attribution + waste/skill-injection always work
      // WITHOUT the engine. The engine optimization-delta provider is loaded only if a private engine
      // build is present; in a public install it resolves to null and the optimization-delta section
      // degrades honestly (no policy candidate, no synthetic saving). The command never crashes here.
      console.log(chalk.cyan("compaction spend"));
      console.log("Summarizing local context spend attribution. No provider APIs, billing lookup, auto mode, model routing, or hosted dashboard is used.");

      const optimizationDeltaProvider = (await loadEngineOptimizationDeltaProvider()) ?? undefined;
      const artifacts = await writeSpendArtifacts(inputPath, options.out, undefined, optimizationDeltaProvider);
      console.log(artifacts.terminalSummary);
      console.log(chalk.green(`Wrote ${artifacts.paths.spendSummaryJsonPath}`));
      console.log(chalk.green(`Wrote ${artifacts.paths.spendSummaryMarkdownPath}`));
      console.log(chalk.green(`Evidence directory: ${artifacts.outputDirectory}`));
    });
}
