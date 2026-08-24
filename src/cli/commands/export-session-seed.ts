import chalk from "chalk";
import { Command } from "commander";
import { runEngineCommand } from "../engine-degrade.js";
import type { SessionSeedExportContract } from "../../core/lazy-module-contracts.js";

/** Loaded lazily; the public package degrades honestly when it is absent. */
const SESSION_SEED_EXPORT_MODULE = "../../engine/session-seed-export.js";

interface ExportSessionSeedOptions {
  applyDir?: string;
  out?: string;
}

/**
 * `compaction export-session-seed --apply-dir <dir> [--out <file>]`
 *
 * Turns an APPROVED `apply-context` artifacts directory into a pasteable Lane B treatment
 * session-seed prompt (FIXED-PLAN WORKFLOW-EFFICIENCY TREATMENT SETUP). Refusal-by-default:
 * requires a valid approval record (`approved_for_in_workflow_use`), a hash-matching approved
 * context, and a hash-matching retained original, otherwise it refuses, exits non-zero, and writes
 * NO seed. Strictly read-only over the apply artifacts. No provider call, no network, no auto-apply.
 */
export function registerExportSessionSeedCommand(program: Command): void {
  program
    .command("export-session-seed")
    .description(
      "Export a PASTEABLE Lane B treatment session-seed (TREATMENT SETUP, NOT billing-confirmed savings; operator-applied, NOT auto-apply) from an APPROVED apply-context artifacts dir. Refuses unless approved + hashes match. Read-only; no provider call."
    )
    .requiredOption("--apply-dir <dir>", "The apply-context artifacts directory (must contain an approval record)")
    .option("--out <file>", "Where to write the session seed (default: <apply-dir>/session-seed.md)")
    .action(async (options: ExportSessionSeedOptions) => {
     await runEngineCommand(async () => {
      // Lazy-load the proprietary engine: present in-repo/API, excluded from the public package.
      // When absent, runEngineCommand prints the boundary message and exits cleanly (no stack trace).
      const { exportSessionSeed } = (await import(SESSION_SEED_EXPORT_MODULE)) as SessionSeedExportContract;

      console.log(chalk.cyan("compaction export-session-seed (Lane B treatment setup)"));
      console.log(
        "Operator-applied, NOT auto-apply. compaction.dev starts no session and applies no context automatically. No provider call, no network."
      );

      const result = await exportSessionSeed({
        applyDir: options.applyDir!,
        outFile: options.out
      });

      if (result.refused) {
        console.error(chalk.red("Refused - no session seed written:"));
        for (const reason of result.reasons) {
          console.error(chalk.red(`- ${reason}`));
        }
        process.exitCode = 1;
        return;
      }

      console.log(result.consoleSummary);
      console.log(chalk.green(`Wrote ${result.seedPath}`));
     });
    });
}
