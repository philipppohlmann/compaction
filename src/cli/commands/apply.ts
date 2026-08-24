import { readFile } from "node:fs/promises";
import chalk from "chalk";
import { Command } from "commander";
// PUBLIC constant from the policy-types module (Phase 1a), no engine runtime edge.
import { COMPACTION_POLICY_NAME } from "../../core/policy-types.js";
import { parseTraceFile } from "../../core/trace-parser.js";
import { runEngineCommand } from "../engine-degrade.js";
// Type-only engine import, erased at compile time, no runtime edge to the engine.
import type { RecommendationMode } from "../../core/report-types.js";
import type { ApplyModeContract, RecommendationContract } from "../../core/lazy-module-contracts.js";

/** Loaded lazily; the public package degrades honestly when they are absent. */
const RECOMMENDATION_MODULE = "../../engine/recommendation.js";
const APPLY_MODE_MODULE = "../../engine/apply-mode.js";

interface ApplyOptions {
  policy: string;
  requireSafetyPass?: boolean;
}

async function readRecommendationMode(
  traceId: string,
  isRecommendationMode: (value: string) => value is RecommendationMode
): Promise<RecommendationMode | undefined> {
  const recommendationPath = `.compaction/recommendations/${traceId}/recommendation.json`;

  try {
    const recommendation = JSON.parse(await readFile(recommendationPath, "utf8")) as { recommended_mode?: unknown };
    return typeof recommendation.recommended_mode === "string" && isRecommendationMode(recommendation.recommended_mode)
      ? recommendation.recommended_mode
      : undefined;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return undefined;
    }

    throw error;
  }
}

export function registerApplyCommand(program: Command): void {
  program
    .command("apply")
    .argument("<trace-file>", "Path to a local agent trace JSON file")
    .requiredOption("--policy <name>", "Reviewed deterministic local policy to apply")
    .option("--require-safety-pass", "Refuse apply unless the deterministic local safety report passes")
    .description("Apply a reviewed local deterministic compaction policy and write apply artifacts.")
    .action(async (traceFile: string, options: ApplyOptions) => {
     await runEngineCommand(async () => {
      // Lazy-load the proprietary engine: present in-repo/API, excluded from the public package.
      // When absent, runEngineCommand prints the boundary message and exits cleanly (no stack trace).
      const { isRecommendationMode } = (await import(RECOMMENDATION_MODULE)) as RecommendationContract;
      const { writeApplyArtifacts } = (await import(APPLY_MODE_MODULE)) as ApplyModeContract;

      const trace = await parseTraceFile(traceFile);
      const recommendationMode = await readRecommendationMode(trace.id, isRecommendationMode);
      const artifacts = await writeApplyArtifacts({
        trace,
        policy: {
          name: options.policy,
          isLocal: options.policy === COMPACTION_POLICY_NAME,
          isDeterministic: options.policy === COMPACTION_POLICY_NAME
        },
        requireSafetyPass: options.requireSafetyPass === true,
        generatedAt: trace.generatedAt,
        recommendationMode
      });

      console.log(chalk.cyan("compaction apply"));
      console.log(`Trace id: ${artifacts.report.trace_id}`);
      console.log(`Policy name: ${artifacts.report.policy_name}`);
      console.log(`Safety status: ${artifacts.report.safety_status}`);
      console.log(`Risk level: ${artifacts.report.risk_level}`);
      console.log(`Applied: ${artifacts.report.applied}`);
      console.log(`Refusal reason: ${artifacts.report.refusal_reason ?? "None"}`);
      console.log(`Required next step: ${artifacts.report.required_next_step}`);
      console.log(chalk.green(`Wrote ${artifacts.paths.appliedTracePath}`));
      console.log(chalk.green(`Wrote ${artifacts.paths.applyReportJsonPath}`));
      console.log(chalk.green(`Wrote ${artifacts.paths.applyReportMarkdownPath}`));

      if (!artifacts.report.applied) {
        process.exitCode = 1;
      }
     });
    });
}
