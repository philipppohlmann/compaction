import chalk from "chalk";
import { Command } from "commander";
import { runEngineCommand } from "../engine-degrade.js";
import type { IntegrationsContract } from "../../core/lazy-module-contracts.js";

/** Loaded lazily; the public package degrades honestly when it is absent. */
const INTEGRATIONS_MODULE = "../../core/integrations.js";

interface IntegrationRunOptions {
  out: string;
}

export function registerIntegrationsCommand(program: Command): void {
  const integrations = program.command("integrations").description("Run real local integration capture workflows.");

  integrations
    .command("run")
    .description("Run a supported integration capture and feed it through optimize/spend/review evidence generation.")
    .argument("<integration-id>", "Integration id to run, for example openai-agents")
    .requiredOption("--out <dir>", "Output root directory for integration artifacts")
    .argument("[commandParts...]", "Command and arguments to execute after --")
    .allowUnknownOption(true)
    .action(async (integrationId: string, commandParts: string[], options: IntegrationRunOptions) => {
     await runEngineCommand(async () => {
      // The integration workflow drives the proprietary optimize/review engine. Lazy-load the core
      // integrations module (which statically imports the engine); when the engine build is excluded
      // this dynamic import fails and runEngineCommand prints the boundary message and exits cleanly.
      const { runIntegration } = (await import(INTEGRATIONS_MODULE)) as IntegrationsContract;

      console.log(chalk.cyan(`compaction integrations run ${integrationId}`));
      console.log("Running a local integration capture. No scraping, hosted service, auth, billing workflow, model routing, provider switching, or auto mode is used.");

      const artifacts = await runIntegration({ integrationId, outRoot: options.out, commandParts });
      console.log(artifacts.terminalSummary);
      console.log(chalk.green(`Wrote ${artifacts.paths.normalizedTracePath}`));
      console.log(chalk.green(`Wrote ${artifacts.paths.reportJsonPath}`));
      console.log(chalk.green(`Wrote ${artifacts.paths.reportMarkdownPath}`));
      console.log(chalk.green(`Evidence directory: ${artifacts.outputDirectory}`));
     });
    });
}
