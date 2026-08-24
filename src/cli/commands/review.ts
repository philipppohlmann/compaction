import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import chalk from "chalk";
import { Command } from "commander";
import { runEngineCommand } from "../engine-degrade.js";
import type { OptimizationReviewContract } from "../../core/lazy-module-contracts.js";

/** Loaded lazily; the public package degrades honestly when it is absent. */
const OPTIMIZATION_REVIEW_MODULE = "../../engine/optimization-review.js";

interface ReviewOptions {
  requireSafetyPass?: boolean;
  approve?: boolean;
  yes?: boolean;
}

async function confirmApproval(): Promise<boolean> {
  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question("Approve this optimization? Type yes to approve: ");
    return answer.trim().toLowerCase() === "yes";
  } finally {
    rl.close();
  }
}

export function registerReviewCommand(program: Command): void {
  program
    .command("review")
    .description("Run a guided local optimization review with spend, safety, recommendation, and explicit approval decision.")
    .argument("<optimization-or-spend-path>", "Path to an optimization summary, spend summary, recommendation, or approval-ready artifact")
    .option("--require-safety-pass", "Refuse approval unless safety status is pass")
    .option("--approve", "Request explicit local approval from the guided review")
    .option("--yes", "Approve without an interactive confirmation prompt when all guardrails pass")
    .action(async (sourcePath: string, options: ReviewOptions) => {
     await runEngineCommand(async () => {
      // Lazy-load the proprietary engine BEFORE any interactive prompt: present in-repo/API, excluded
      // from the public package. When absent, runEngineCommand prints the boundary message and exits
      // cleanly (no stack trace) without ever prompting for approval.
      const { createOptimizationReview } = (await import(OPTIMIZATION_REVIEW_MODULE)) as OptimizationReviewContract;

      console.log(chalk.cyan("compaction review"));
      console.log("Guided local review only. No provider APIs, live provider mutation, production proxying, auto mode, model routing, hosted dashboard, auth, database, or billing workflow is used.");

      const approvalRequested = Boolean(options.approve);
      const approvalConfirmed = approvalRequested && (Boolean(options.yes) || (await confirmApproval()));
      const artifacts = await createOptimizationReview({
        sourceArtifactPath: sourcePath,
        requireSafetyPass: Boolean(options.requireSafetyPass),
        approvalRequested,
        approvalConfirmed
      });

      console.log(artifacts.terminalSummary);
      if (artifacts.paths.reviewSummaryJsonPath) {
        console.log(chalk.green(`Wrote ${artifacts.paths.reviewSummaryJsonPath}`));
      }
      if (artifacts.paths.reviewSummaryMarkdownPath) {
        console.log(chalk.green(`Wrote ${artifacts.paths.reviewSummaryMarkdownPath}`));
      }
      if (artifacts.approvalArtifacts) {
        console.log(chalk.green(`Wrote ${artifacts.approvalArtifacts.paths.approvalReportJsonPath}`));
        console.log(chalk.green(`Wrote ${artifacts.approvalArtifacts.paths.approvalReportMarkdownPath}`));
        if (artifacts.approvalArtifacts.paths.approvedTracePath) {
          console.log(chalk.green(`Wrote ${artifacts.approvalArtifacts.paths.approvedTracePath}`));
        }
      }
      console.log(chalk.green(`Evidence directory: ${artifacts.outputDirectory}`));

      if (approvalRequested && artifacts.summary.approval_decision !== "approved") {
        process.exitCode = 1;
      }
     });
    });
}
