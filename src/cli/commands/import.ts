import chalk from "chalk";
import { Command } from "commander";
import { listTraceAdapters } from "../../core/trace-adapters.js";
import { importTraceFile } from "../../core/trace-intake.js";

interface ImportOptions {
  source?: string;
  out?: string;
  listSources?: boolean;
  operatorExport?: boolean;
}

function printSupportedSources(): void {
  console.log(chalk.cyan("compaction import sources"));
  for (const adapter of listTraceAdapters()) {
    console.log(`- ${adapter.id}: ${adapter.displayName}`);
    console.log(`    readiness: ${adapter.readiness}`);
  }
  console.log(
    "All sources are local file import (no live integration). Readiness above is an honest integration-readiness " +
      "label + validation status - not a stronger integration claim than the evidence supports."
  );
}

export function registerImportCommand(program: Command): void {
  program
    .command("import")
    .argument("[trace-file]", "Path to a local trace JSON, messages JSON, or supported JSONL file")
    .option("--source <source>", "Input source: agent-trace, messages, codex-exec-jsonl, or unknown")
    .option("--out <dir>", "Directory where normalized intake artifacts should be written")
    .option(
      "--operator-export",
      "Assert this file is your own real `codex exec --json` export (operator provenance). " +
        "Without this flag, imports default to the weakest honest evidence tier (fixture). " +
        "With it, a Codex JSONL import is labeled imported_local - still below real_captured and capped at conditional."
    )
    .option("--list-sources", "List local trace adapter sources supported by import v0")
    .description("Import a local trace file into the internal AgentTrace format.")
    .action(async (traceFile: string | undefined, options: ImportOptions) => {
      if (options.listSources) {
        printSupportedSources();
        return;
      }

      if (!traceFile) {
        throw new Error("Missing trace-file. Provide a local JSON file path or run compaction import --list-sources.");
      }

      if (!options.source) {
        throw new Error("Missing required option --source <source>.");
      }

      if (!options.out) {
        throw new Error("Missing required option --out <dir>.");
      }

      const artifacts = await importTraceFile(traceFile, options.source, options.out, {
        operatorExport: options.operatorExport === true
      });

      console.log(chalk.cyan("compaction import"));
      console.log(`Status: ${artifacts.report.status}`);
      console.log(`Source: ${artifacts.report.source}`);
      console.log(`Adapter: ${artifacts.report.adapter_id}`);
      console.log(`Messages: ${artifacts.report.message_count}`);
      console.log(chalk.green(`Wrote ${artifacts.paths.intakeReportJsonPath}`));
      console.log(chalk.green(`Wrote ${artifacts.paths.intakeReportMarkdownPath}`));

      if (artifacts.normalizedTrace) {
        console.log(chalk.green(`Wrote ${artifacts.paths.normalizedTracePath}`));
        console.log("");
        console.log(chalk.bold("Next: analyze the imported trace to see waste attribution:"));
        console.log(`  ${artifacts.report.recommended_next_command}`);
      } else {
        console.log(chalk.red("No normalized trace was generated."));
        console.log(
          "The input did not normalize to an AgentTrace. See intake-report.md for the per-line reasons, " +
            "then re-run with the correct --source (compaction import --list-sources)."
        );
        process.exitCode = 1;
      }
    });
}
