import path from "node:path";
import chalk from "chalk";
import { Command, Option } from "commander";
import { writeJsonArtifact, writeTextArtifact } from "../../core/artifact-writer.js";
import { formatCompactionMarkdownReport, withSavingsEvidence, withTraceFingerprint } from "../../core/report-generator.js";
import { describeTokenAccounting } from "../../core/token-accounting.js";
import type { ReviewerType } from "../../core/safety-report.js";
import { parseTraceFile } from "../../core/trace-parser.js";
import { buildRunLabelsFile, hasAnyLabel, type RunLabels } from "../../core/run-labels.js";
import { runEngineCommand } from "../engine-degrade.js";
// The runtime functions (writeCompactionArtifacts, applyCompactionPolicy, the eval-harness) are
// lazy-loaded inside the handler so a public install degrades instead of crashing at load time,
// and their shapes come from the public contract seam rather than from the private modules.
import type {
  CompactionArtifactsContract,
  EvalHarnessContract,
  EvalResultView,
  PolicyMiddlewareContract,
  StrongEvalResultView
} from "../../core/lazy-module-contracts.js";

/** Loaded lazily; the public package degrades honestly when they are absent. */
const COMPACTION_ARTIFACTS_MODULE = "../../core/compaction-artifacts.js";
const POLICY_MIDDLEWARE_MODULE = "../../core/policy-middleware.js";
const EVAL_HARNESS_MODULE = "../../engine/eval-harness.js";

const VALID_REVIEWER_TYPES = ["human", "automated", "none"] as const;
type CliReviewerType = (typeof VALID_REVIEWER_TYPES)[number];

interface CompactOptions {
  out: string;
  reviewer: CliReviewerType;
  reviewSummary?: string;
  approveSkillInjectionPolicy?: boolean;
  eval?: boolean;
  project?: string;
  workflow?: string;
  provider?: string;
  userLabel?: string;
  session?: string;
}

/**
 * Print the combined compaction→eval summary for `compact --eval`. The five signals are kept
 * STRICTLY SEPARATE and each carries its honest label, so the strong deterministic recoverability
 * fact is never blurred with the weak local token/cost estimate:
 *   1. token/cost, local estimate (chars/4 + price-table), NOT billing-confirmed, NOT realized savings.
 *   2. deterministic recoverability, passed/failed/not_computed + the recoverability check counts.
 *   3. evidence tier, fixture / imported / real_captured, derived at the weakest honest level from
 *      the trace source (a fixture/imported trace can never be reported as real_captured).
 *   4. semantic_preservation, always not_evaluated (never scored).
 *   5. commitment_preservation, always not_evaluated (never scored).
 * `recoverability: passed` means byte/hash/source-pointer recoverability ONLY.
 */
function printCombinedEvalSummary(result: EvalResultView): void {
  const checks = result.recoverability_checks;
  const passedChecks = checks.filter((c) => c.status === "pass").length;

  console.log("");
  console.log(chalk.bold("Recoverability eval (--eval): deterministic, in-process - no hand-assembled bundle"));

  // 1. token/cost estimate, local estimate ONLY.
  console.log(chalk.bold("[1] Token/cost estimate (local estimate):"));
  console.log(
    "  Locally estimated (chars/4 trace tokens + price-table cost) - NOT provider-reported, " +
      "NOT billing-confirmed, NOT realized savings. See compaction report above for the before/after figures."
  );

  // 2. deterministic recoverability result + counts.
  console.log(chalk.bold("[2] Deterministic recoverability:"));
  console.log(`  ${result.recoverability.toUpperCase()} (byte/hash/source-pointer recoverability ONLY)`);
  console.log(`  ${result.recoverability_reason}`);
  console.log(`  Recoverability checks: ${passedChecks}/${checks.length} passed`);
  for (const check of checks) {
    console.log(`    [${check.status}] ${check.label}`);
  }

  // 3. evidence tier (derived from trace source; never elevated).
  console.log(chalk.bold("[3] Evidence tier:"));
  console.log(
    `  ${result.evidence_source} (from ${result.evidence_source_type}); real_captured=${result.real_captured}`
  );

  // 4 + 5. preservation axes - always not_evaluated.
  console.log(chalk.bold("[4] Semantic preservation:"));
  console.log(`  ${result.semantic_preservation} (NOT scored by this harness)`);
  console.log(chalk.bold("[5] Commitment preservation:"));
  console.log(`  ${result.commitment_preservation} (NOT scored by this harness)`);
  console.log(
    "  A passing recoverability verdict is byte/hash/source-pointer recoverability ONLY - " +
      "it is NOT a meaning-preservation or task-critical-commitment claim."
  );
}

/**
 * Print the STRONG eval summary for `compact --eval` (Strong-MVP Tracks B/C/D): the deterministic
 * commitment-preservation recoverability check, the fixture-based task-check, the token/cost
 * accounting (each figure labeled provider-reported vs local estimate), and the composed strong
 * apply-readiness verdict with a per-axis reason. Every label is the weakest honest level:
 * commitment-preservation and task-check are RECOVERABILITY checks, NOT semantic/meaning guarantees,
 * and the task-check is fixture-based, NOT real model replay.
 */
function printStrongEvalSummary(strong: StrongEvalResultView): void {
  console.log("");
  console.log(chalk.bold("Strong apply-readiness eval (Tracks B/C/D): deterministic, in-process"));

  // [6] commitment preservation (recoverability of extracted task-critical items - NOT semantic).
  const c = strong.commitment_preservation;
  console.log(chalk.bold("[6] Commitment preservation (deterministic recoverability check, NOT semantic):"));
  console.log(`  ${c.status.toUpperCase()} - ${c.reason}`);
  console.log(
    `  commitments=${c.commitment_count} (retained=${c.retained_count}, recoverable=${c.recoverable_count}, missing=${c.missing_count})`
  );
  for (const detail of c.details) {
    console.log(`    [${detail.recoverability}] ${detail.category}: ${detail.text}`);
  }

  // [7] fixture-based task-check (NOT real model replay).
  const t = strong.task_check;
  console.log(chalk.bold("[7] Task-check (fixture-based, NOT real model replay):"));
  console.log(`  ${t.status.toUpperCase()} (workflow=${t.workflow}) - ${t.reason}`);

  // [8] token & cost accounting (each figure labeled).
  console.log(chalk.bold("[8] Token & cost accounting:"));
  for (const line of describeTokenAccounting(strong.token_accounting)) {
    console.log(`  ${line}`);
  }

  // [9] strong apply-readiness verdict (per-axis reasons).
  const r = strong.readiness;
  console.log(chalk.bold(`[9] Strong apply-readiness: ${r.readiness.toUpperCase()}`));
  console.log(`  ${r.reason}`);
  for (const check of r.checks) {
    console.log(`    [${check.status}] ${check.axis}: ${check.reason}`);
  }
}

function runIdFromOutputDirectory(outputDirectory: string): string {
  return path.basename(path.resolve(outputDirectory));
}

export function registerCompactCommand(program: Command): void {
  program
    .command("compact")
    .argument("<trace-file>", "Path to a local agent trace JSON file")
    .requiredOption("--out <dir>", "Directory where compaction artifacts should be written")
    .addOption(
      new Option("--reviewer <type>", "Reviewer type for approval readiness signal")
        .choices(VALID_REVIEWER_TYPES)
        .default("none")
    )
    .option("--review-summary <text>", "Review summary text (presence sets review_summary_present: true)")
    .addOption(
      new Option(
        "--approve-skill-injection-policy",
        "Approve and apply the byte-identical same-skill skill-injection compaction policy (default: off; nothing compacted unless provided)"
      )
    )
    .option(
      "--eval",
      "After compacting, run the deterministic byte/hash/source-pointer recoverability eval on the SAME " +
        "in-process compaction (no hand-assembled bundle) and print a combined summary. Exits non-zero if " +
        "recoverability fails (fail-closed). Recoverability is byte/hash/source-pointer only - NOT semantic " +
        "or commitment preservation, and NOT a savings claim."
    )
    .option("--project <name>", "Local-only label: tag this run's project (for the multi-session aggregate; never uploaded)")
    .option("--workflow <name>", "Local-only label: tag this run's workflow (for the aggregate; never uploaded)")
    .option("--provider <name>", "Local-only label: tag this run's provider/runtime (operator-asserted, NOT provider-verified)")
    .option("--user-label <text>", "Local-only free-form label for this run (for the aggregate; never uploaded)")
    .option("--session <id>", "Local-only session id: group this run with others under one session in the aggregate")
    .description("Compact a trace and write local artifacts.")
    .action(async (traceFile: string, options: CompactOptions) => {
     await runEngineCommand(async () => {
      // Basic deterministic compaction is PUBLIC (src/core): the transform + policy application +
      // artifact writing ship in the npm package, so `compact` works without the Hybrid Engine.
      // Only `--eval` (deterministic recoverability/strong eval) lazy-loads the private engine below;
      // when the engine is absent, runEngineCommand prints the boundary message and exits cleanly.
      const { writeCompactionArtifacts } = (await import(COMPACTION_ARTIFACTS_MODULE)) as CompactionArtifactsContract;
      const { applyCompactionPolicy } = (await import(POLICY_MIDDLEWARE_MODULE)) as PolicyMiddlewareContract;

      const trace = await parseTraceFile(traceFile);
      const reviewerType: ReviewerType = options.reviewer;
      const reviewSummaryPresent = typeof options.reviewSummary === "string" && options.reviewSummary.length > 0;
      const approveSkillInjectionPolicy = options.approveSkillInjectionPolicy === true;
      const runId = runIdFromOutputDirectory(options.out);
      // Run the compaction policy ONCE, in-process, and reuse the SAME in-memory result for both the
      // persisted artifacts and (when --eval) the recoverability eval. No disk round-trip, no
      // hand-assembled bundle - the eval consumes the identical PolicyMiddlewareResult.
      const policyResult = applyCompactionPolicy({ trace, compactSkillInjections: approveSkillInjectionPolicy });
      const artifacts = await writeCompactionArtifacts(
        trace,
        options.out,
        runId,
        policyResult,
        undefined,
        { reviewerType, reviewSummaryPresent, approveSkillInjectionPolicy }
      );
      // Attribution/integrity + per-run evidence label (V0.2 savings-evidence): re-persist
      // report.json with (1) the content-addressed trace fingerprint so `aggregate`/`summary` can
      // attribute each saving to a verifiable run and de-duplicate a run rolled up twice, and
      // (2) the composed `savings_evidence` record stating the per-run label explicitly. The
      // compact path's figures are local estimates (chars/4) - `local_estimate` rung 1; never
      // billing-confirmed, never semantic. Additive, backward-compatible; changes no existing field.
      const evidenceReport = withSavingsEvidence(withTraceFingerprint(artifacts.report, trace), {
        costSource: "local_estimate"
      });
      await writeJsonArtifact(options.out, "report.json", evidenceReport);
      // Re-render report.md from the ENRICHED report so the per-run savings_evidence record
      // appears in the human-readable artifact too (the engine rendered report.md from the base
      // report before the CLI added the public-layer fingerprint/evidence enrichment).
      await writeTextArtifact(options.out, "report.md", formatCompactionMarkdownReport(evidenceReport, artifacts.policy));

      console.log(chalk.cyan("compaction compact"));
      console.log(artifacts.consoleReport);
      // Operator-visible only when the approval gesture was given; default output is unchanged.
      if (approveSkillInjectionPolicy) {
        const summary = artifacts.skillInjectionCompaction;
        console.log(
          chalk.cyan(
            `Skill-injection policy (approved): compacted ${summary.compacted_count} byte-identical same-skill skill injection(s); ` +
              `est ${summary.estimated_tokens_removed} tokens removed (${summary.estimate_label})`
          )
        );
      }
      // Token-count source label (honest): the compaction report's before/after token figures
      // are locally estimated (chars/4), never provider-reported. Stating this prevents an
      // estimate from being read as a billing-confirmed count.
      console.log("Token-count source: locally estimated (chars/4) - NOT provider-reported, NOT billing-confirmed");

      // Safety + recoverability linkage (safety-report.json fields), so the compaction value and
      // its reversibility/risk evidence are visible together, not split across files.
      const safety = artifacts.safetyReport;
      console.log(`Risk level: ${safety.risk_level} (safety-report.json risk_level)`);
      console.log(
        `Source recoverability: ${safety.source_recoverability} ` +
          "(source pointers + content hashes + state capsules recorded; original trace retained)"
      );
      console.log(`Approval readiness: ${safety.approval_readiness_status}`);
      console.log(
        "Approval requirement: nothing is applied to your workflow automatically. " +
          "apply-context emits an approved context ONLY with the explicit --approve-in-workflow-use gesture (no auto-apply)."
      );

      console.log(chalk.green(`Wrote ${artifacts.paths.reportPath}`));
      console.log(chalk.green(`Wrote ${artifacts.paths.markdownReportPath}`));
      console.log(chalk.green(`Wrote ${artifacts.paths.policyPath}`));
      console.log(chalk.green(`Wrote ${artifacts.paths.capsulePath}`));
      console.log(chalk.green(`Wrote ${artifacts.paths.compactedTracePath}`));
      console.log(chalk.green(`Wrote ${artifacts.paths.safetyReportPath}`));
      console.log(chalk.green(`Wrote ${artifacts.paths.safetyMarkdownReportPath}`));
      console.log(chalk.green(`Wrote ${artifacts.paths.prCommentReportPath}`));

      // Optional LOCAL-ONLY labels: tag this run for the multi-session aggregate. Written
      // to run-labels.json in the run directory; never uploaded, carries no trace content.
      const suppliedLabels: RunLabels = {
        project: options.project,
        workflow: options.workflow,
        provider: options.provider,
        user_label: options.userLabel,
        session: options.session
      };
      if (hasAnyLabel(suppliedLabels)) {
        const labelsPath = await writeJsonArtifact(options.out, "run-labels.json", buildRunLabelsFile(suppliedLabels));
        console.log(chalk.green(`Wrote ${labelsPath} (local-only labels; never uploaded)`));
      }

      // Exact next command to continue the loop (chaining), with the trace path the user passed.
      console.log("");
      console.log(chalk.bold("Next: review the compaction and emit an approved context (review-only by default):"));
      console.log(`  compaction apply-context ${traceFile} --out <dir>`);
      console.log("  (add --approve-in-workflow-use once you have reviewed the safety report to emit the approved context)");

      // --eval: run the deterministic recoverability eval on the SAME in-memory compaction result
      // (no disk round-trip, no hand-assembled bundle) and print the combined summary. Fail closed:
      // a failing recoverability verdict exits non-zero, identical to standalone `compaction eval`.
      if (options.eval === true) {
        // The recoverability/strong eval stays PRIVATE (src/engine): lazy-loaded only when --eval is
        // requested, so basic compaction above never needs the engine. Absent engine ⇒ clean degrade.
        const { evaluateCompactionResult, evaluateStrongCompactionResult, formatStrongEvalMarkdownReport } = (await import(
          EVAL_HARNESS_MODULE
        )) as EvalHarnessContract;
        const evalResult = evaluateCompactionResult(trace, policyResult, runId);
        printCombinedEvalSummary(evalResult);
        // Strong eval (Tracks B/C/D): commitment-preservation recoverability + fixture task-check +
        // token/cost accounting + the composed strong apply-readiness gate. Fails closed: recoverability
        // `failed` OR strong readiness `not_ready` exits non-zero.
        // Thread the SAME --reviewer/--review-summary evidence the persisted safety-report
        // artifacts already received (above) into the strong-eval recompute, so a real_captured
        // trace WITH valid recoverability + commitment + task-check + reviewer + summary can
        // legitimately reach `ready`. Fail-closed: missing/invalid review evidence still caps at
        // `conditional` (the safety-report apply-readiness gate is unchanged).
        const strong = evaluateStrongCompactionResult({
          originalTrace: trace,
          policyResult,
          runId,
          reviewerType,
          reviewSummaryPresent
        });
        printStrongEvalSummary(strong);
        const strongJsonPath = await writeJsonArtifact(options.out, "strong-eval.json", strong);
        const strongMarkdownPath = await writeTextArtifact(options.out, "strong-eval.md", formatStrongEvalMarkdownReport(strong));
        console.log(chalk.green(`Wrote ${strongJsonPath}`));
        console.log(chalk.green(`Wrote ${strongMarkdownPath}`));
        if (evalResult.recoverability === "failed" || strong.readiness.readiness === "not_ready") {
          process.exitCode = 1;
        }
      }
     });
    });
}
