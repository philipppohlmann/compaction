import path from "node:path";
import chalk from "chalk";
import { Command, Option } from "commander";
import {
  AUTO_APPLY_QUESTION_LINES,
  formatSavedPreferenceConfirmation,
  resolveAutoApplyOffer,
  type AutoApplyAnswer
} from "../../core/auto-apply-ask.js";
import { savePolicyPreference } from "../../core/policy-preferences.js";
import { parseTraceFile } from "../../core/trace-parser.js";
import { runEngineCommand } from "../engine-degrade.js";
import type { InWorkflowApplyContract } from "../../core/lazy-module-contracts.js";

/** Loaded lazily; the public package degrades honestly when it is absent. */
const IN_WORKFLOW_APPLY_MODULE = "../../engine/in-workflow-apply.js";

interface ApplyContextOptions {
  out?: string;
  approveInWorkflowUse?: boolean;
  approveSkillInjectionPolicy?: boolean;
  attestUsed?: boolean;
  attestNote?: string;
  offerAutoApply?: boolean;
  rememberAutoApply?: boolean;
  /** Set false by `--no-remember` (explicit no); the affirmative is `--remember-auto-apply`. */
  remember?: boolean;
  workflowTool?: string;
  workflowRepo?: string;
  policyType?: string;
}

function defaultOutputDir(artifactRoot: string, traceId: string): string {
  return path.join(artifactRoot, traceId);
}

/**
 * Infer the SAFEST workflow tool for the auto-apply preference scope. Prefers the explicit
 * `--workflow-tool` flag; otherwise maps an unambiguous trace source to its tool. Returns undefined
 * when it cannot infer safely (then the offer fails closed and saves nothing, never guesses global).
 */
function inferWorkflowTool(explicit: string | undefined, traceSource: string | undefined): string | undefined {
  if (explicit && explicit.trim() !== "") return explicit.trim();
  if (traceSource === "codex_import") return "codex";
  if (traceSource === "cursor_import") return "cursor";
  return undefined;
}

/**
 * `compaction apply-context <trace-file> --out <dir>`, LEVEL-5 IN-WORKFLOW APPLY, Form A.
 *
 * Operator-invoked, local-first. compaction.dev runs the existing compaction, the pre-apply safety
 * checks, ALWAYS retains the un-compacted original, and produces the original-vs-compacted review.
 * It emits the approved compacted context ONLY on the explicit per-application approval gesture
 * `--approve-in-workflow-use`. It makes NO live provider call, holds NO credential, runs no proxy /
 * hosted component, and performs no auto-apply. The unattended `apply` path is untouched and not
 * reachable from here.
 */
export function registerApplyContextCommand(program: Command): void {
  program
    .command("apply-context")
    .description(
      "Form A in-workflow apply: review original-vs-compacted, run pre-apply safety checks, and (only with explicit per-application approval) emit an approved compacted context for YOUR OWN next provider call. compaction.dev makes no live call and holds no credential."
    )
    .argument("<trace-file>", "Path to a local agent trace JSON file")
    .option("--out <dir>", "Directory where in-workflow-apply artifacts should be written")
    .addOption(
      new Option(
        "--approve-in-workflow-use",
        "EXPLICIT per-application approval gesture. Without it: review artifacts are produced and NO approved context is emitted. This records 'approved for in-workflow use' (NOT 'applied')."
      )
    )
    .addOption(
      new Option(
        "--approve-skill-injection-policy",
        "EXPLICITLY also authorize the approval-required repeated_skill_injection_to_state_capsule policy. Default off; no auto-apply."
      )
    )
    .addOption(
      new Option(
        "--attest-used",
        "OPTIONAL operator attestation: AFTER an approval, the operator records that they used the approved context in a live call. Stored as operator-ATTESTED provenance (the operator's own claim), never observed by compaction.dev."
      )
    )
    .option("--attest-note <text>", "Optional free-text note recorded with the operator attestation")
    .addOption(
      new Option(
        "--offer-auto-apply",
        "OPT-IN. AFTER an explicit approval, offer the ONE binary question 'apply this automatically next time when safety gates pass?' (default no). A saved preference can authorize matching supported Gateway requests in Full optimization mode; every request still passes the runtime safety and recovery gates."
      )
    )
    .addOption(
      new Option(
        "--remember-auto-apply",
        "Non-interactive answer YES to the auto-apply offer (requires --offer-auto-apply and a prior approval). Saves a preference for the inferred safest scope; applies nothing now."
      )
    )
    .addOption(new Option("--no-remember", "Non-interactive answer NO to the auto-apply offer (the default): save nothing, keep asking each time."))
    .option("--workflow-tool <tool>", "Tool/workflow to scope a saved auto-apply preference to (never global/cross-tool). Inferred from the trace source when omitted.")
    .option("--workflow-repo <repo>", "Optional content-free repo identifier to narrow a saved auto-apply preference's scope.")
    .option("--policy-type <type>", "Policy type a saved auto-apply preference concerns (defaults to the approved policy name).")
    .action(async (traceFile: string, options: ApplyContextOptions) => {
     await runEngineCommand(async () => {
      // Lazy-load the proprietary engine: present in-repo/API, excluded from the public package.
      // When absent, runEngineCommand prints the boundary message and exits cleanly (no stack trace).
      const { IN_WORKFLOW_APPLY_ARTIFACT_ROOT, recordOperatorAttestation, runInWorkflowApply } = (await import(
        IN_WORKFLOW_APPLY_MODULE
      )) as InWorkflowApplyContract;

      const trace = await parseTraceFile(traceFile);
      const outputDirectory = options.out ?? defaultOutputDir(IN_WORKFLOW_APPLY_ARTIFACT_ROOT, trace.id);

      console.log(chalk.cyan("compaction apply-context (Form A)"));
      console.log(
        "Operator-invoked, local-first. compaction.dev makes NO live provider call and holds NO provider credential. No proxy, no hosted component, no auto-apply."
      );

      const result = await runInWorkflowApply({
        trace,
        outputDirectory,
        approveInWorkflowUse: options.approveInWorkflowUse === true,
        approveSkillInjectionPolicy: options.approveSkillInjectionPolicy === true,
        generatedAt: trace.generatedAt
      });

      console.log(result.consoleSummary);
      console.log(chalk.green(`Wrote ${result.paths.preApplyReviewJsonPath}`));
      console.log(chalk.green(`Wrote ${result.paths.preApplyReviewMarkdownPath}`));
      console.log(chalk.green(`Wrote ${result.paths.retainedOriginalPath}`));
      if (result.paths.approvedContextPath) {
        console.log(chalk.green(`Wrote ${result.paths.approvedContextPath}`));
      }
      if (result.paths.applyApprovalRecordPath) {
        console.log(chalk.green(`Wrote ${result.paths.applyApprovalRecordPath}`));
      }

      // Optional operator attestation (only meaningful once an approval record exists).
      if (options.attestUsed === true) {
        if (result.approvalRecord && result.paths.applyApprovalRecordPath) {
          const { record, path: attestationPath } = await recordOperatorAttestation({
            outputDirectory,
            applyApprovalRecord: result.approvalRecord,
            applyApprovalRecordPath: result.paths.applyApprovalRecordPath,
            generatedAt: trace.generatedAt,
            operatorNote: options.attestNote
          });
          console.log(
            chalk.yellow(
              `Operator attestation recorded (operator-attested, NOT observed): ${record.provenance_label}`
            )
          );
          console.log(chalk.green(`Wrote ${attestationPath}`));
        } else {
          console.log(
            chalk.yellow(
              "--attest-used ignored: there is no approval record to attest against (approve in-workflow use first)."
            )
          );
        }
      }

      console.log(chalk.green(`Output directory: ${result.outputDirectory}`));

      // OPT-IN post-approval auto-apply OFFER. This offer is made ONLY after an
      // explicit in-workflow approval already emitted an approved context. It APPLIES NOTHING: on
      // yes it records a PREFERENCE (intent for the future gated slice) via the #598 store; on
      // no/default it saves nothing. It never touches apply execution semantics.
      if (options.offerAutoApply === true && result.approvedContextEmitted) {
        console.log("");
        for (const line of AUTO_APPLY_QUESTION_LINES) console.log(chalk.cyan(line));

        const answer: AutoApplyAnswer = options.rememberAutoApply === true ? "yes" : "no";
        const decision = resolveAutoApplyOffer({
          approvedInWorkflow: true,
          answer,
          scope: {
            tool: inferWorkflowTool(options.workflowTool, trace.source),
            repo: options.workflowRepo,
            policyType: options.policyType ?? result.review.policies_applied[0]
          }
        });

        if (decision.action === "save") {
          const saved = await savePolicyPreference({
            scope: decision.scope,
            preference: decision.preference,
            gates_required: decision.gatesRequired
          });
          if (saved.saved) {
            console.log("");
            console.log(chalk.green(formatSavedPreferenceConfirmation(saved.preference)));
          } else {
            console.log("");
            console.log(chalk.yellow("Preference NOT saved (fail-closed) - nothing was applied:"));
            for (const problem of saved.problems) console.log(chalk.yellow(`  - ${problem}`));
          }
        } else if (decision.action === "blocked") {
          console.log("");
          console.log(
            chalk.yellow("Preference NOT saved - could not infer a safe (non-global, non-cross-tool) scope. Nothing applied:")
          );
          for (const problem of decision.problems) console.log(chalk.yellow(`  - ${problem}`));
          console.log(chalk.dim("  Pass --workflow-tool <tool> (and optionally --policy-type / --workflow-repo) to record a preference."));
        } else {
          console.log(chalk.dim("No auto-apply preference saved - Compaction will keep asking each time (the default)."));
        }
      }

      // Exit non-zero when no approved context was emitted (refusal / review-only), mirroring apply/approve.
      if (!result.approvedContextEmitted) {
        process.exitCode = 1;
      }
     });
    });
}
