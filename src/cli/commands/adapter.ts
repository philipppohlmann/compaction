import chalk from "chalk";
import { Command } from "commander";
import { validateAdapterFixtureFile } from "../../core/adapter-validation.js";
import { listTraceAdapters } from "../../core/trace-adapters.js";

interface AdapterValidateOptions {
  source?: string;
}

function printSupportedAdapters(): void {
  console.log(chalk.cyan("compaction adapter sources"));
  for (const adapter of listTraceAdapters()) {
    console.log(`- ${adapter.id}: ${adapter.displayName}`);
    console.log(`  ${adapter.description}`);
  }
  console.log("Adapter Fixture Harness v0 is local and file-based only; live provider/runtime integrations are future work.");
}

export function registerAdapterCommand(program: Command): void {
  const adapter = program.command("adapter").description("Validate local adapter fixtures without live provider integrations.");

  adapter.command("list").description("List local trace adapters available to the fixture harness.").action(() => {
    printSupportedAdapters();
  });

  adapter
    .command("validate")
    .argument("<fixture-file>", "Path to a local adapter fixture JSON or JSONL file")
    .requiredOption("--source <source>", "Input source from the local adapter registry")
    .description("Validate a local fixture through adapter canHandle and normalize.")
    .action(async (fixtureFile: string, options: AdapterValidateOptions) => {
      if (!options.source) {
        throw new Error("Missing required option --source <source>.");
      }

      const artifacts = await validateAdapterFixtureFile(fixtureFile, options.source);

      console.log(chalk.cyan("compaction adapter validate"));
      console.log(`Status: ${artifacts.report.status}`);
      console.log(`Validation ID: ${artifacts.report.validation_id}`);
      console.log(`Source: ${artifacts.report.source}`);
      console.log(`Adapter: ${artifacts.report.adapter_id}`);
      console.log(`Supported format detected: ${artifacts.report.supported_format_detected ? "yes" : "no"}`);
      console.log(`Messages: ${artifacts.report.message_count}`);
      console.log(chalk.green(`Wrote ${artifacts.paths.validationReportJsonPath}`));
      console.log(chalk.green(`Wrote ${artifacts.paths.validationReportMarkdownPath}`));

      if (artifacts.normalizedTrace) {
        console.log(chalk.green(`Wrote ${artifacts.paths.normalizedTracePath}`));
        console.log(`Recommended next command: ${artifacts.report.recommended_next_command}`);
      } else {
        console.log(chalk.red("No normalized trace was generated."));
        for (const failure of artifacts.report.failures) {
          console.log(chalk.red(`Failure: ${failure}`));
        }
        process.exitCode = 1;
      }
    });
}
