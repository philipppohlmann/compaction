import chalk from "chalk";
import { Command } from "commander";
import { createSafetyReport } from "../../core/safety-report.js";
import { parseTraceFile } from "../../core/trace-parser.js";
import { detectWaste } from "../../core/waste-detector.js";
import { runEngineCommand } from "../engine-degrade.js";
import type {
  PolicyMiddlewareContract,
  RecommendationArtifactsContract,
  RecommendationContract
} from "../../core/lazy-module-contracts.js";

/** Loaded lazily; the public package degrades honestly when they are absent. */
const POLICY_MIDDLEWARE_MODULE = "../../core/policy-middleware.js";
const RECOMMENDATION_MODULE = "../../engine/recommendation.js";
const RECOMMENDATION_ARTIFACTS_MODULE = "../../engine/recommendation-artifacts.js";
// The report SHAPE comes from the PUBLIC seam: a type-only engine import creates no runtime edge, but
// it would still be emitted into this module's shipped `.d.ts`, which cannot resolve `dist/engine/**`.
import type { RecommendationReport } from "../../core/report-types.js";

function formatNullable(value: string | null): string {
  return value ?? "None";
}

export function formatRecommendationConsoleSummary(recommendation: RecommendationReport, futureModesNotice: string): string {
  return [
    `Trace id: ${recommendation.trace_id}`,
    `Recommended mode: ${recommendation.recommended_mode}`,
    `Policy name: ${formatNullable(recommendation.policy_name)}`,
    `Policy-level tokens saved: ${recommendation.tokens_saved} (${recommendation.percent_reduction}% reduction), $${recommendation.saving_per_run} per run.`,
    `Safety status: ${recommendation.safety_status}`,
    `Risk level: ${recommendation.risk_level}`,
    `Required next step: ${recommendation.required_next_step}`,
    "Future modes notice:",
    futureModesNotice
  ].join("\n");
}

export function registerRecommendCommand(program: Command): void {
  program
    .command("recommend")
    .argument("<trace-file>", "Path to a local agent trace JSON file")
    .description("Recommend an advisory local compaction mode and write recommendation artifacts.")
    .action(async (traceFile: string) => {
      await runEngineCommand(async () => {
        // Lazy-load the proprietary engine: present in-repo/API, excluded from the public package.
        // When absent, runEngineCommand prints the boundary message and exits cleanly (no stack trace).
        const { applyCompactionPolicy } = (await import(POLICY_MIDDLEWARE_MODULE)) as PolicyMiddlewareContract;
        const { createRecommendation } = (await import(RECOMMENDATION_MODULE)) as RecommendationContract;
        const { formatFutureModesNotice, writeRecommendationArtifacts } = (await import(
          RECOMMENDATION_ARTIFACTS_MODULE
        )) as RecommendationArtifactsContract;

        const trace = await parseTraceFile(traceFile);
        const findings = detectWaste(trace);
        const policyResult = applyCompactionPolicy({ trace });
        const safetyReport = createSafetyReport({
          runId: trace.id,
          generatedAt: trace.generatedAt,
          originalTrace: trace,
          compactedMessages: policyResult.compactedMessages,
          stateCapsules: policyResult.stateCapsules,
          compactedMessageIds: policyResult.compactedMessageIds,
          tokensSaved: policyResult.tokensSaved,
          policyName: policyResult.appliedPolicyName
        });
        const recommendation = createRecommendation({
          trace,
          policyResult,
          generatedAt: trace.generatedAt,
          safetyReport,
          findings
        });
        const artifacts = await writeRecommendationArtifacts(recommendation);

        console.log(chalk.cyan("compaction recommend"));
        console.log(formatRecommendationConsoleSummary(recommendation, formatFutureModesNotice()));
        console.log(chalk.green(`Wrote ${artifacts.paths.recommendationJsonPath}`));
        console.log(chalk.green(`Wrote ${artifacts.paths.recommendationMarkdownPath}`));

        // Exact next command to continue the loop (chaining), with the trace path the user passed.
        console.log("");
        console.log(chalk.bold("Next: produce the before/after delta + named policy + safety report:"));
        console.log(`  compaction compact ${traceFile} --out <dir>`);
      });
    });
}
