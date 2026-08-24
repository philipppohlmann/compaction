import chalk from "chalk";
import { Command } from "commander";
import { runEngineCommand } from "../engine-degrade.js";
import type { OptimizationApprovalContract, PreApplyApprovalViewContract } from "../../core/lazy-module-contracts.js";

/** Loaded lazily; the public package degrades honestly when they are absent. */
const OPTIMIZATION_APPROVAL_MODULE = "../../engine/optimization-approval.js";
const PRE_APPLY_APPROVAL_VIEW_MODULE = "../../engine/pre-apply-approval-view.js";

interface ApproveOptions {
  requireSafetyPass?: boolean;
  approveSkillInjectionPolicy?: boolean;
  preApply?: boolean;
}

export function registerApproveCommand(program: Command): void {
  program
    .command("approve")
    .description("Approve and locally apply a reviewed optimization recommendation to a captured trace copy.")
    .argument("<optimization-id>", "Optimization ID produced by compaction optimize openai-agents")
    .option("--require-safety-pass", "Refuse approval unless safety status is pass")
    .option(
      "--approve-skill-injection-policy",
      "EXPLICITLY also authorize the approval-required repeated_skill_injection_to_state_capsule policy to compact byte-identical same-skill role:user skill injections. Approval-gated; default off; no auto-apply."
    )
    .option(
      "--pre-apply",
      "READ-ONLY pre-apply view: show before/after input tokens, estimated cost, recoverability, evidence tier, and approval_readiness (not_ready/conditional/ready) WITHOUT applying anything or emitting an approved trace. No auto-apply."
    )
    .action(async (optimizationId: string, options: ApproveOptions) => {
     await runEngineCommand(async () => {
      // Lazy-load the proprietary engine: present in-repo/API, excluded from the public package.
      // When absent, runEngineCommand prints the boundary message and exits cleanly (no stack trace).
      const { approveOptimization } = (await import(OPTIMIZATION_APPROVAL_MODULE)) as OptimizationApprovalContract;
      const { buildPreApplyApprovalView } = (await import(PRE_APPLY_APPROVAL_VIEW_MODULE)) as PreApplyApprovalViewContract;

      if (options.preApply) {
        console.log(chalk.cyan("compaction approve --pre-apply"));
        console.log(
          "Read-only pre-apply view. NOTHING is applied; no approved trace is emitted. No provider APIs, live workflow mutation, production proxying, auto mode, model routing, or hosted dashboard is performed."
        );

        const view = await buildPreApplyApprovalView({
          optimizationId,
          requireSafetyPass: Boolean(options.requireSafetyPass),
          includeSkillInjectionPolicy: Boolean(options.approveSkillInjectionPolicy)
        });
        console.log(view.terminalSummary);
        console.log(chalk.green(`Wrote ${view.paths.preApplyReportJsonPath}`));
        console.log(chalk.green(`Wrote ${view.paths.preApplyReportMarkdownPath}`));
        console.log(chalk.green(`Evidence directory: ${view.outputDirectory}`));

        // Read-only: never apply. Exit non-zero only when apply would be blocked, so scripts can gate.
        if (view.report.approval_readiness === "not_ready") {
          process.exitCode = 1;
        }
        return;
      }

      console.log(chalk.cyan("compaction approve"));
      console.log("Running explicit local approval only. No provider APIs, live workflow mutation, production proxying, auto mode, model routing, or hosted dashboard is performed.");

      const artifacts = await approveOptimization({
        optimizationId,
        requireSafetyPass: Boolean(options.requireSafetyPass),
        approveSkillInjectionPolicy: Boolean(options.approveSkillInjectionPolicy)
      });
      console.log(artifacts.terminalSummary);
      console.log(chalk.green(`Wrote ${artifacts.paths.approvalReportJsonPath}`));
      console.log(chalk.green(`Wrote ${artifacts.paths.approvalReportMarkdownPath}`));
      if (artifacts.paths.approvedTracePath) {
        console.log(chalk.green(`Wrote ${artifacts.paths.approvedTracePath}`));
      }
      console.log(chalk.green(`Evidence directory: ${artifacts.outputDirectory}`));

      if (!artifacts.report.approved) {
        process.exitCode = 1;
      }
     });
    });
}
