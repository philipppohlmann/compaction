import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import chalk from "chalk";
import { Command } from "commander";
import { writeJsonArtifact, writeTextArtifact } from "../../core/artifact-writer.js";
import { readCompactionRunReports } from "../../core/run-aggregator.js";
import {
  buildFeedbackBundle,
  filterUsageMetadata,
  formatBundlePreview,
  renderBundleReadme,
  UNKNOWN,
  type AggregateRunSignals,
  type EvidenceLevel,
  type FeedbackBundleInput,
  type SuppliedSignals,
  type TriState,
  type WorkflowOutcome
} from "../../core/feedback-bundle.js";

interface FeedbackOptions {
  redact?: boolean;
  yes?: boolean;
  confirm?: boolean;
  out?: string;
  runs?: string;
  commandPath?: string;
  evidenceLevel?: string;
  recoverability?: string;
  appliedContext?: string;
  workflowOutcome?: string;
  missingContext?: string;
  provider?: string;
  model?: string;
  usageMetadata?: string;
  diagnosticsFile?: string;
}

const BUNDLE_DIR_DEFAULT = path.join(".compaction", "feedback-bundle");

async function readPackageVersion(): Promise<string> {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    // dist/cli/commands -> dist -> package root
    const pkgPath = path.resolve(here, "..", "..", "..", "package.json");
    const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as { version?: string };
    return typeof pkg.version === "string" ? pkg.version : UNKNOWN;
  } catch {
    return UNKNOWN;
  }
}

/** Best-effort install-method classification from argv0, NON-sensitive, no paths leaked. */
function detectInstallMethod(): string {
  const argv0 = process.argv[1] ?? "";
  if (argv0.includes(`${path.sep}_npx${path.sep}`) || argv0.includes(`${path.sep}npx${path.sep}`)) {
    return "npx";
  }
  if (argv0.includes(`${path.sep}node_modules${path.sep}.bin${path.sep}`)) {
    return "local-node_modules";
  }
  if (argv0.includes(`${path.sep}lib${path.sep}node_modules${path.sep}`) || argv0.includes(`${path.sep}global${path.sep}`)) {
    return "global-npm";
  }
  return UNKNOWN;
}

function parseTriState(value: string | undefined, flag: string): TriState | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "yes" || normalized === "no" || normalized === "unknown") {
    return normalized;
  }
  throw new Error(`Invalid value for ${flag}: "${value}". Expected one of: yes, no, unknown.`);
}

/**
 * Evidence levels this COMMAND accepts, weakest→strongest. `billing_confirmed` is
 * deliberately ABSENT: this flow collects no invoice/billing/export evidence, so it must
 * never be allowed to emit a billing-confirmed label. Supplying it is an explicit error.
 */
const ACCEPTED_EVIDENCE: readonly string[] = [
  "measured_input_token_reduction",
  "output_token_delta_observed",
  "recoverability_verified",
  "applied_context",
  "workflow_confirmed",
  "usage_confirmed"
];
const ACCEPTED_EVIDENCE_SET: ReadonlySet<string> = new Set([...ACCEPTED_EVIDENCE, "unknown"]);

function parseEvidenceLevel(value: string | undefined): EvidenceLevel | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "billing_confirmed") {
    throw new Error(
      'Invalid --evidence-level: "billing_confirmed" is not accepted by `feedback`. ' +
        "This command collects NO invoice/billing/export evidence, so it cannot emit a " +
        "billing-confirmed label. Use at most usage_confirmed (only with --usage-metadata)."
    );
  }
  if (!ACCEPTED_EVIDENCE_SET.has(normalized)) {
    throw new Error(
      `Invalid --evidence-level: "${value}". Allowed: ${[...ACCEPTED_EVIDENCE_SET].join(", ")}.`
    );
  }
  return normalized as EvidenceLevel;
}

/**
 * Cap a tester-supplied evidence level at what the inputs actually support - never emit a
 * label stronger than the evidence. `usage_confirmed` requires real usage metadata; without
 * it the strongest reachable rung is `workflow_confirmed`. Returns the (possibly lowered)
 * level plus a flag when it was capped, so stdout can explain the downgrade honestly.
 */
function capEvidenceLevel(
  level: EvidenceLevel | undefined,
  hasUsageMetadata: boolean
): { level: EvidenceLevel | undefined; capped: boolean } {
  if (level === undefined || level === "unknown") return { level, capped: false };
  if (level === "usage_confirmed" && !hasUsageMetadata) {
    // No usage metadata supplied → the strongest honest rung is workflow_confirmed.
    return { level: "workflow_confirmed", capped: true };
  }
  return { level, capped: false };
}

function parseWorkflowOutcome(value: string | undefined): WorkflowOutcome | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (["succeeded", "failed", "partial", "unknown"].includes(normalized)) {
    return normalized as WorkflowOutcome;
  }
  throw new Error(`Invalid --workflow-outcome: "${value}". Expected: succeeded, failed, partial, unknown.`);
}

async function readUsageMetadata(filePath: string | undefined): Promise<Record<string, unknown> | undefined> {
  if (!filePath) return undefined;
  const raw = await readFile(filePath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("--usage-metadata file must contain a JSON object of metadata fields.");
  }
  return parsed as Record<string, unknown>;
}

async function readDiagnostics(filePath: string | undefined): Promise<string | undefined> {
  if (!filePath) return undefined;
  return readFile(filePath, "utf8");
}

/** Aggregate INPUT-token signals from local run reports. Output-token delta stays unknown
 *  unless a report carries it (reports do not, so it remains unknown - honest by default). */
async function aggregateSignals(runsDir: string): Promise<AggregateRunSignals> {
  const { reports } = await readCompactionRunReports(runsDir);
  let originalInput = 0;
  let compactedInput = 0;
  let inputSaved = 0;
  let costDelta = 0;
  let costObserved = false;

  for (const { report } of reports) {
    originalInput += report.original_input_tokens;
    compactedInput += report.compacted_input_tokens;
    inputSaved += report.tokens_saved;
    if (Number.isFinite(report.saving_per_run)) {
      costDelta += report.saving_per_run;
      costObserved = true;
    }
  }

  return {
    run_count: reports.length,
    total_original_input_tokens: originalInput,
    total_compacted_input_tokens: compactedInput,
    total_input_tokens_saved: inputSaved,
    // Reports carry INPUT-token deltas only; output-token delta is not observable here.
    output_token_delta: UNKNOWN,
    estimated_cost_delta_usd: costObserved ? Math.round((costDelta + Number.EPSILON) * 1e6) / 1e6 : UNKNOWN
  };
}

async function confirmWrite(): Promise<boolean> {
  if (!input.isTTY) {
    // No interactive terminal and no explicit flag → fail closed.
    return false;
  }
  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question(
      "Write this feedback bundle locally? It will NOT be uploaded. Type yes to confirm: "
    );
    return answer.trim().toLowerCase() === "yes";
  } finally {
    rl.close();
  }
}

export function registerFeedbackCommand(program: Command): void {
  program
    .command("feedback")
    .description(
      "Build a REDACTED, privacy-safe feedback bundle (local file only - never uploaded) for the beta learning loop."
    )
    .option("--redact", "Build the redacted feedback bundle (default behavior; kept for explicitness)")
    .option("--yes", "Confirm writing the bundle without an interactive prompt (explicit gesture)")
    .option("--confirm", "Alias for --yes: explicitly confirm writing the bundle")
    .option("--out <dir>", "Output directory for the bundle", BUNDLE_DIR_DEFAULT)
    .option("--runs <dir>", "Compaction runs directory to aggregate", ".compaction/runs")
    .option("--command-path <name>", "Which compaction command produced the run (e.g. compact)")
    .option(
      "--evidence-level <level>",
      "Weakest-supported evidence label (billing_confirmed NOT accepted; usage_confirmed needs --usage-metadata)"
    )
    .option("--recoverability <status>", "Recoverability status string (e.g. verified, unverified)")
    .option("--applied-context <yes|no|unknown>", "Was compacted context applied to the workflow?")
    .option("--workflow-outcome <outcome>", "Workflow outcome: succeeded|failed|partial|unknown")
    .option("--missing-context <yes|no|unknown>", "Did the workflow report missing context?")
    .option("--provider <name>", "Provider name, IF you choose to supply it")
    .option("--model <name>", "Model name, IF you choose to supply it")
    .option("--usage-metadata <file>", "Path to a JSON file of provider usage metadata to include")
    .option("--diagnostics-file <file>", "Path to an error/log file to include AFTER best-effort redaction")
    .action(async (options: FeedbackOptions) => {
      console.log(chalk.cyan("compaction feedback"));
      console.log(
        "Local-first, fail-closed. NO network, NO upload, NO telemetry. Redaction is BEST-EFFORT, not perfect."
      );

      const usageMetadata = await readUsageMetadata(options.usageMetadata);
      // "Usage supplied" for capping = the allowlist keeps at least one non-sensitive
      // field; a file of only unrecognized keys does NOT support a usage_confirmed label.
      // It must carry at least one NUMERIC token count - `model`/`provider` strings
      // alone do not substantiate `usage_confirmed`.
      const filteredUsage = filterUsageMetadata(usageMetadata);
      const hasUsageMetadata = Boolean(
        filteredUsage &&
          Object.values(filteredUsage.kept).some((v) => typeof v === "number")
      );

      const requestedEvidence = parseEvidenceLevel(options.evidenceLevel);
      const { level: cappedEvidence, capped } = capEvidenceLevel(requestedEvidence, hasUsageMetadata);
      if (capped) {
        console.log(
          chalk.yellow(
            `Note: --evidence-level "${requestedEvidence}" exceeds the supported evidence ` +
              `(no usage metadata supplied); capped to "${cappedEvidence}". A label is never emitted above the evidence.`
          )
        );
      }

      const supplied: SuppliedSignals = {
        command_path: options.commandPath,
        evidence_level: cappedEvidence,
        recoverability_status: options.recoverability,
        applied_context: parseTriState(options.appliedContext, "--applied-context"),
        workflow_outcome: parseWorkflowOutcome(options.workflowOutcome),
        missing_context: parseTriState(options.missingContext, "--missing-context"),
        provider: options.provider,
        model: options.model,
        usage_metadata: usageMetadata,
        diagnostic_text: await readDiagnostics(options.diagnosticsFile)
      };

      const environment = {
        cli_version: await readPackageVersion(),
        os: `${os.platform()} ${os.release()}`,
        node_version: process.version,
        package_version: await readPackageVersion(),
        install_method: detectInstallMethod()
      };

      const aggregate = await aggregateSignals(options.runs ?? ".compaction/runs");

      const bundleInput: FeedbackBundleInput = { environment, aggregate, supplied };
      const bundle = buildFeedbackBundle(bundleInput);

      // PREVIEW EXACTLY what will be written - always, before any write.
      console.log("");
      console.log(formatBundlePreview(bundle));
      console.log("");

      // Explicit-confirm gate, fail-closed.
      const explicit = Boolean(options.yes) || Boolean(options.confirm);
      const confirmed = explicit || (await confirmWrite());

      if (!confirmed) {
        console.log(
          chalk.yellow(
            "Preview only - nothing written. Re-run with --yes (or --confirm) to write the bundle locally."
          )
        );
        return;
      }

      const outDir = options.out ?? BUNDLE_DIR_DEFAULT;
      const jsonPath = await writeJsonArtifact(outDir, "feedback-bundle.json", bundle);
      const readmePath = await writeTextArtifact(outDir, "README.md", renderBundleReadme(bundle));

      console.log(chalk.green(`Wrote ${jsonPath}`));
      console.log(chalk.green(`Wrote ${readmePath}`));
      console.log(
        "This bundle is LOCAL only - it was NOT uploaded. You choose whether to send it. Redaction is best-effort; inspect before sending."
      );
    });
}
