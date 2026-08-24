import chalk from "chalk";
import { Command } from "commander";
import { writeJsonArtifact, writeTextArtifact } from "../../core/artifact-writer.js";
import { createAggregateReport, AGGREGATE_ARTIFACT_DIRECTORY } from "../../core/session-aggregate.js";
import {
  buildAggregateShareBundle,
  formatAggregateMarkdown,
  formatAggregateReport,
  formatShareBundleMarkdown
} from "../../core/aggregate-format.js";
import { normalizeRunLabels, type RunLabels } from "../../core/run-labels.js";

interface AggregateOptions {
  runs?: string;
  out?: string;
  share?: boolean;
  project?: string;
  workflow?: string;
  provider?: string;
  userLabel?: string;
  session?: string;
}

/** Collect ONLY the label fields that were actually supplied, so absent ≡ no filter. */
function suppliedLabels(options: AggregateOptions): RunLabels {
  return normalizeRunLabels({
    project: options.project,
    workflow: options.workflow,
    provider: options.provider,
    user_label: options.userLabel,
    session: options.session
  });
}

export function registerAggregateCommand(program: Command): void {
  program
    .command("aggregate")
    .description(
      "Roll up local compaction runs into per-session + cross-session token / cost / estimated-savings " +
        "and verification-outcome aggregates. LOCAL ONLY - reads .compaction/runs/*, makes NO network call, " +
        "writes only local files. No hosted dashboard."
    )
    .option("--runs <dir>", "Runs directory to aggregate", ".compaction/runs")
    .option("--out <dir>", "Directory for the aggregate artifacts", AGGREGATE_ARTIFACT_DIRECTORY)
    .option(
      "--share",
      "Also write a redacted, content-free AGGREGATE share bundle (aggregate numbers + labels + evidence " +
        "tiers, NOT raw traces) a developer can hand a teammate or admin. Local file only - never uploaded."
    )
    .option("--project <name>", "Local-only: roll up ONLY runs tagged with this project label")
    .option("--workflow <name>", "Local-only: roll up ONLY runs tagged with this workflow label")
    .option("--provider <name>", "Local-only: roll up ONLY runs tagged with this provider/runtime label (operator-asserted)")
    .option("--user-label <text>", "Local-only: roll up ONLY runs tagged with this free-form user label")
    .option("--session <id>", "Local-only: roll up ONLY runs tagged with this session id")
    .action(async (options: AggregateOptions) => {
      const filters = suppliedLabels(options);
      const runsDir = options.runs ?? ".compaction/runs";
      const outDir = options.out ?? AGGREGATE_ARTIFACT_DIRECTORY;

      const report = await createAggregateReport(runsDir, {
        filters,
        rollupLabels: filters
      });

      const consoleReport = formatAggregateReport(report);
      const markdown = formatAggregateMarkdown(report);

      const aggregateDir = `${outDir}/${report.aggregate_id}`;
      const jsonPath = await writeJsonArtifact(aggregateDir, "aggregate-report.json", report);
      const markdownPath = await writeTextArtifact(aggregateDir, "aggregate-report.md", markdown);

      console.log(chalk.cyan(consoleReport));
      console.log("");
      console.log(chalk.green(`Wrote ${jsonPath}`));
      console.log(chalk.green(`Wrote ${markdownPath}`));

      if (options.share === true) {
        const shareBundle = buildAggregateShareBundle(report);
        const shareJsonPath = await writeJsonArtifact(aggregateDir, "aggregate-share.json", shareBundle);
        const shareMarkdownPath = await writeTextArtifact(aggregateDir, "aggregate-share.md", formatShareBundleMarkdown(shareBundle));
        console.log("");
        console.log(
          chalk.bold(
            "Redacted aggregate share bundle (content-free): aggregate numbers + labels + evidence tiers only - " +
              "NO raw traces, run ids, or paths. Local file only; never uploaded."
          )
        );
        console.log(chalk.green(`Wrote ${shareJsonPath}`));
        console.log(chalk.green(`Wrote ${shareMarkdownPath}`));
      }
    });
}
