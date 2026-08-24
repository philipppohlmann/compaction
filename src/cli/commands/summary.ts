import chalk from "chalk";
import { Command } from "commander";
import { writeJsonArtifact, writeTextArtifact } from "../../core/artifact-writer.js";
import { createRunSummary, formatRunSummary, formatRunSummaryMarkdown } from "../../core/run-aggregator.js";

export function registerSummaryCommand(program: Command): void {
  program
    .command("summary")
    .description("Summarize local compaction run reports across .compaction/runs/*/report.json.")
    .action(async () => {
      const summary = await createRunSummary();
      const consoleSummary = formatRunSummary(summary);
      const markdownSummary = formatRunSummaryMarkdown(summary);

      const summaryJsonPath = await writeJsonArtifact(".compaction", "summary.json", summary);
      const summaryMarkdownPath = await writeTextArtifact(".compaction", "summary.md", markdownSummary);

      console.log(chalk.cyan(consoleSummary));
      console.log(chalk.green(`Wrote ${summaryJsonPath}`));
      console.log(chalk.green(`Wrote ${summaryMarkdownPath}`));
    });
}
