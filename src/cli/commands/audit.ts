import chalk from "chalk";
import { Command } from "commander";
// FREE: the default `audit` package path uses only public core (engine refs in audit-report are
// type-only). The `--traces` / `--adapter` pilot paths run the proprietary engine and are lazy-loaded
// in their branches below, degrading honestly when the engine build is excluded from the package.
import { writeAuditArtifacts } from "../../core/audit-report.js";
import type { TraceIntakeSource } from "../../core/trace-intake.js";
import { runEngineCommand } from "../engine-degrade.js";
import type { AdapterAuditContract, PilotAuditContract } from "../../core/lazy-module-contracts.js";

/** Loaded lazily; the public package degrades honestly when they are absent. */
const ADAPTER_AUDIT_MODULE = "../../core/adapter-audit.js";
const PILOT_AUDIT_MODULE = "../../core/pilot-audit.js";

interface AuditOptions {
  traces?: string;
  source?: string;
  adapter?: string;
}

function formatCurrency(value: number): string {
  return `$${value.toFixed(6)}`;
}

const supportedPilotSources: TraceIntakeSource[] = ["agent-trace", "messages", "unknown"];

function parsePilotSource(source: string): TraceIntakeSource {
  if (supportedPilotSources.includes(source as TraceIntakeSource)) {
    return source as TraceIntakeSource;
  }

  throw new Error(`Unsupported source "${source}". Supported sources: ${supportedPilotSources.join(", ")}.`);
}

export function registerAuditCommand(program: Command): void {
  program
    .command("audit")
    .description("Package local compaction artifacts or run a local trace audit pilot folder.")
    .option("--traces <dir>", "Directory of local trace files to audit")
    .option("--adapter <adapter-id>", "Adapter registry id for the adapter audit workflow")
    .option("--source <source>", "Pilot input source: agent-trace, messages, or unknown", "unknown")
    .action(async (options: AuditOptions) => {
      if (options.traces && options.adapter) {
        await runEngineCommand(async () => {
          // Engine-backed adapter audit (compaction + recommendation over each trace). Lazy-load;
          // degrades honestly when the engine build is excluded from the package.
          const { runAdapterAudit } = (await import(ADAPTER_AUDIT_MODULE)) as AdapterAuditContract;
          const result = await runAdapterAudit(options.traces!, options.adapter!);
          console.log(chalk.cyan("compaction audit"));
          console.log(result.consoleSummary);
          console.log(chalk.green(`Wrote ${result.paths.adapterAuditSummaryJsonPath}`));
          console.log(chalk.green(`Wrote ${result.paths.adapterAuditSummaryMarkdownPath}`));
        });
        return;
      }

      if (options.traces) {
        await runEngineCommand(async () => {
          // Engine-backed local trace audit pilot (compaction + recommendation over a folder of traces).
          // Lazy-load; degrades honestly when the engine build is excluded from the package.
          const { runLocalTraceAuditPilot } = (await import(PILOT_AUDIT_MODULE)) as PilotAuditContract;
          const result = await runLocalTraceAuditPilot(options.traces!, parsePilotSource(options.source ?? "unknown"));
          console.log(chalk.cyan("compaction audit"));
          console.log(result.consoleSummary);
          console.log(chalk.green(`Wrote ${result.paths.pilotSummaryJsonPath}`));
          console.log(chalk.green(`Wrote ${result.paths.pilotSummaryMarkdownPath}`));
        });
        return;
      }

      const artifacts = await writeAuditArtifacts();

      console.log(chalk.cyan("compaction audit"));
      console.log(`Audit id: ${artifacts.audit.audit_id}`);
      console.log(`Runs summarized: ${artifacts.audit.total_runs}`);
      console.log(
        `Savings: ${artifacts.audit.total_tokens_saved} input tokens saved, ${formatCurrency(
          artifacts.audit.total_saving_per_run
        )} estimated saving per run, summed over ${artifacts.audit.total_runs} recorded run${artifacts.audit.total_runs === 1 ? "" : "s"}.`
      );
      console.log(`Recommendation artifacts: ${artifacts.audit.recommendation_summary.total_recommendations}`);
      console.log(`Apply artifacts: ${artifacts.audit.apply_summary?.total_apply_reports ?? 0}`);
      console.log("Local-only audit package; no provider calls or hosted services are used.");
      console.log(chalk.green(`Wrote ${artifacts.paths.auditJsonPath}`));
      console.log(chalk.green(`Wrote ${artifacts.paths.auditMarkdownPath}`));
    });
}
