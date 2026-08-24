import chalk from "chalk";
import { Command } from "commander";
import { runEngineCommand } from "../engine-degrade.js";
import { hostedConfigured, runHostedOptimizeOpenAIAgents } from "./optimize-hosted.js";
import type { OpenAIAgentsOptimizationContract } from "../../core/lazy-module-contracts.js";

/** Loaded lazily; the public package degrades honestly when it is absent. */
const OPENAI_AGENTS_OPTIMIZATION_MODULE = "../../engine/openai-agents-optimization.js";

interface OpenAIAgentsOptimizeOptions {
  out: string;
}

export function registerOptimizeCommand(program: Command): void {
  const optimize = program.command("optimize").description("Run local trace optimization loops for supported integrations.");

  optimize
    .command("openai-agents")
    .description("Capture and optimize a local OpenAI Agents SDK trace without applying changes.")
    .requiredOption("--out <dir>", "Output root directory for optimization artifacts")
    .argument("[commandParts...]", "Command and arguments to execute after --")
    .allowUnknownOption(true)
    .action(async (commandParts: string[], options: OpenAIAgentsOptimizeOptions) => {
      // UPGRADE PATH: only when BOTH COMPACTION_API_URL + COMPACTION_API_KEY are set, route through
      // the pure-HTTP api-client to the hosted Compaction API (no engine, no default network). When
      // unconfigured, the original local-engine-or-degrade path below runs BYTE-IDENTICALLY.
      if (hostedConfigured()) {
        await runHostedOptimizeOpenAIAgents({ out: options.out, commandParts });
        return;
      }
      await runEngineCommand(async () => {
        // Lazy-load the proprietary engine: present in-repo/API, excluded from the public package.
        // When absent, runEngineCommand prints the boundary message and exits cleanly (no stack trace).
        const { optimizeOpenAIAgents } = (await import(
          OPENAI_AGENTS_OPTIMIZATION_MODULE
        )) as OpenAIAgentsOptimizationContract;

        console.log(chalk.cyan("compaction optimize openai-agents"));
        console.log("Running a local OpenAI Agents SDK optimization loop. No auto-apply, ChatGPT scraping, production proxying, or hosted upload is performed.");

        const artifacts = await optimizeOpenAIAgents({ outRoot: options.out, commandParts });
        if (artifacts.usedLocalFixture) {
          console.log("Using local fixture because provider credentials are not configured.");
        }
        console.log(artifacts.terminalSummary);
        console.log(chalk.green(`Wrote ${artifacts.paths.capturedTracePath}`));
        console.log(chalk.green(`Wrote ${artifacts.paths.optimizationSummaryJsonPath}`));
        console.log(chalk.green(`Wrote ${artifacts.paths.optimizationSummaryMarkdownPath}`));
        console.log(chalk.green(`Evidence directory: ${artifacts.outputDirectory}`));

        if (artifacts.summary.status === "fail") {
          process.exitCode = 1;
        }
      });
    });
}
