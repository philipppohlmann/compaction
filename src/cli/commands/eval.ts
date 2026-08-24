import { stat } from "node:fs/promises";
import chalk from "chalk";
import { Command } from "commander";
import { runEngineCommand } from "../engine-degrade.js";
import type { EvalFixturesContract } from "../../core/lazy-module-contracts.js";

/** Loaded lazily; the public package degrades honestly when it is absent. */
const EVAL_FIXTURES_MODULE = "../../engine/eval-fixtures.js";

interface EvalOptions {
  out?: string;
}

export function registerEvalCommand(program: Command): void {
  program
    .command("eval")
    .description(
      "Run the deterministic recoverability eval over a compaction-input fixture/bundle (or a directory of them). " +
        "Proves byte/hash/source-pointer recoverability ONLY - semantic and commitment preservation are NOT evaluated."
    )
    .argument("<fixture-or-directory>", "Path to an eval fixture/bundle JSON file, or a directory of them")
    .option("--out <dir>", "Directory where eval report artifacts should be written")
    .action(async (inputPath: string, options: EvalOptions) => {
     await runEngineCommand(async () => {
      // The deterministic recoverability eval IS the proprietary methodology; the whole command is
      // engine-gated (no public structural part). Lazy-load the engine: present in-repo/API, excluded
      // from the public package. When absent, runEngineCommand prints the boundary message and exits
      // cleanly (no stack trace) before any filesystem access.
      const { evaluateFixtureDirectory, evaluateFixtureFile, writeCorpusEvalArtifacts, writeEvalArtifacts } = (await import(
        EVAL_FIXTURES_MODULE
      )) as EvalFixturesContract;

      console.log(chalk.cyan("compaction eval"));
      console.log(
        "Deterministic byte/hash/source-pointer recoverability check. " +
          "No model call, no fuzzy matching, no savings claim. " +
          "Semantic preservation and task-critical commitment preservation are NOT evaluated (reported as not_evaluated)."
      );

      const stats = await stat(inputPath);

      if (stats.isDirectory()) {
        const corpus = await evaluateFixtureDirectory(inputPath);
        console.log("");
        console.log(
          `Corpus: ${corpus.trace_count} trace(s) - ` +
            `recoverability passed=${corpus.recoverability_rollup.passed}, ` +
            `failed=${corpus.recoverability_rollup.failed}, ` +
            `not_computed(fail-closed)=${corpus.recoverability_rollup.not_computed}`
        );
        console.log(
          `Recoverability pass rate (over computed): ${
            corpus.recoverability_pass_rate === null ? "n/a" : `${(corpus.recoverability_pass_rate * 100).toFixed(1)}%`
          }`
        );
        console.log(`Real-captured results: ${corpus.real_captured_count}`);
        console.log("Semantic preservation: not_evaluated (never scored). Commitment preservation: not_evaluated (never scored).");
        if (options.out) {
          const paths = await writeCorpusEvalArtifacts(corpus, options.out);
          console.log(chalk.green(`Wrote ${paths.evalReportJsonPath}`));
          console.log(chalk.green(`Wrote ${paths.evalReportMarkdownPath}`));
        }
        // Non-zero exit if any trace failed recoverability (fail-closed signal for CI use).
        if (corpus.recoverability_rollup.failed > 0) {
          process.exitCode = 1;
        }
        return;
      }

      const result = await evaluateFixtureFile(inputPath);
      console.log("");
      console.log(`Recoverability: ${result.recoverability.toUpperCase()}`);
      console.log(`  ${result.recoverability_reason}`);
      console.log(`Evidence source: ${result.evidence_source} (from ${result.evidence_source_type})`);
      console.log(`Real captured: ${result.real_captured}`);
      console.log(
        `Semantic preservation: ${result.semantic_preservation} (NOT scored). ` +
          `Commitment preservation: ${result.commitment_preservation} (NOT scored).`
      );
      for (const check of result.recoverability_checks) {
        console.log(`  [${check.status}] ${check.label}`);
      }
      if (options.out) {
        const paths = await writeEvalArtifacts(result, options.out);
        console.log(chalk.green(`Wrote ${paths.evalReportJsonPath}`));
        console.log(chalk.green(`Wrote ${paths.evalReportMarkdownPath}`));
      }
      if (result.recoverability === "failed") {
        process.exitCode = 1;
      }
     });
    });
}
