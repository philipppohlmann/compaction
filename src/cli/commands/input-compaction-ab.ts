/**
 * `compaction input-compaction-ab`, the operator-run path to produce + ingest a real provider-reported
 * INPUT-compaction A/B for Codex (control = full input context, treatment = Compaction-compacted context),
 * gated for a confirmed claim on a CONTEXT-PRESERVATION eval.
 * Mirrors `output-shaping-ab` but for INPUT tokens with a different (context-preservation) eval.
 *
 *   compaction input-compaction-ab init   --experiment <id> --out <file> [--task-shape <label>]
 *   compaction input-compaction-ab add    --experiment <file> --arm control|treatment --usage <capture-usage.json>
 *                                         [treatment: --context-preserved <yes|no> --task-solved <yes|no>
 *                                          --source-recoverable <yes|no> --commitment-preserved <yes|no>
 *                                          --context-complete <yes|no>]   // --context-complete = no material loss
 *   compaction input-compaction-ab status --experiment <file>
 *
 * Honesty (binding): this PUBLIC CLI shows the OBSERVED input-token delta + a conservative confidence; it
 * NEVER shows a confirmed input-savings number (the engine gate does). Output-token delta is shown as
 * secondary only. Input eval = context-preservation (NOT short-but-sufficient).
 */
import { readFile, writeFile } from "node:fs/promises";
import chalk from "chalk";
import { Command } from "commander";
import {
  addInputCompactionAbRun,
  initInputCompactionAbExperiment,
  runFromSidecar,
  summarizeInputCompactionAb,
  type EvalOutcome,
  type InputCompactionAbArm,
  type InputCompactionAbExperiment,
  type InputCompactionAbSummary
} from "../../core/input-compaction-ab.js";
import type { CaptureUsageSidecar } from "../../core/output-shaping-ab.js";

const PRIVACY_NOTE =
  "Operator-run, local-first. compaction.dev makes NO provider call, reads NO credential, and has NO network access. " +
  "Token counts come from YOUR capture artifacts. This CLI shows the OBSERVED input-token A/B only - a CONFIRMED " +
  "input-savings number is produced solely by the engine gate (provider-reported, measured criterion, context-preservation pass).";

async function loadExperiment(file: string): Promise<InputCompactionAbExperiment> {
  return JSON.parse(await readFile(file, "utf8")) as InputCompactionAbExperiment;
}
async function saveExperiment(file: string, experiment: InputCompactionAbExperiment): Promise<void> {
  await writeFile(file, JSON.stringify(experiment, null, 2), "utf8");
}

function resolveArm(arm: string): InputCompactionAbArm {
  if (arm !== "control" && arm !== "treatment") throw new Error('--arm must be "control" or "treatment".');
  return arm;
}

/** Parse a yes/no flag into a tri-state outcome: "yes"→true, "no"→false, absent→null (not evaluated). */
function yesNo(value: string | undefined, flag: string): EvalOutcome {
  if (value === undefined) return null;
  const v = value.toLowerCase();
  if (v === "yes" || v === "true" || v === "pass") return true;
  if (v === "no" || v === "false" || v === "fail") return false;
  throw new Error(`${flag} must be "yes" or "no".`);
}

interface InitOptions { experiment: string; out: string; taskShape?: string }
interface AddOptions {
  experiment: string;
  arm: string;
  usage: string;
  contextPreserved?: string;
  taskSolved?: string;
  sourceRecoverable?: string;
  commitmentPreserved?: string;
  contextComplete?: string;
}
interface StatusOptions { experiment: string }

export function registerInputCompactionAbCommand(program: Command): void {
  const ab = program
    .command("input-compaction-ab")
    .description(
      "Operator-run, content-free INPUT-compaction A/B harness: link a control arm (full context) and a " +
        "treatment arm (Compaction-compacted context) of Codex captures and show the OBSERVED provider-reported " +
        "INPUT-token delta, gated for a confirmed claim on a CONTEXT-PRESERVATION eval (NOT output sufficiency). " +
        "Shows confirmed savings NEVER - the engine gate does that."
    );

  ab.command("init")
    .description("Create a new input-compaction A/B experiment file.")
    .requiredOption("--experiment <id>", "Experiment id (a short label, not content).")
    .requiredOption("--out <file>", "Path to write the experiment JSON.")
    .option("--task-shape <label>", "Short generic label of the shared task/context SHAPE (not prompt content).", "unspecified-task-shape")
    .action(async (options: InitOptions) => {
      console.log(chalk.cyan("compaction input-compaction-ab init"));
      console.log(PRIVACY_NOTE);
      const experiment = initInputCompactionAbExperiment({ experimentId: options.experiment, taskShape: options.taskShape ?? "unspecified-task-shape" });
      await saveExperiment(options.out, experiment);
      console.log(chalk.green(`Wrote ${options.out}`));
      console.log("  Next: run both arms (full vs Compaction-compacted context), then `add` each capture-usage.json.");
      console.log("    1. compaction compact <trace> --eval --out <dir>            # context-preservation eval");
      console.log("    2. compaction apply-context <trace> --approve-in-workflow-use --out <dir>   # compacted context");
      console.log('    control:   compaction capture codex --out runs/c1 -- codex exec --json "<task> + FULL context"');
      console.log('    treatment: compaction capture codex --out runs/t1 -- codex exec --json "<task> + COMPACTED context"');
    });

  ab.command("add")
    .description("Ingest a capture-usage.json into an arm. For treatment, record the context-preservation outcome.")
    .requiredOption("--experiment <file>", "Path to the experiment JSON (from `init`).")
    .requiredOption("--arm <arm>", 'Which arm: "control" (full context) or "treatment" (compacted context).')
    .requiredOption("--usage <file>", "Path to a capture-usage.json sidecar written by `compaction capture codex`.")
    .option("--context-preserved <yes|no>", "Treatment: task-critical context preserved?")
    .option("--task-solved <yes|no>", "Treatment: did the treatment output still solve the same task?")
    .option("--source-recoverable <yes|no>", "Treatment: source recoverability preserved (from `compact --eval`)?")
    .option("--commitment-preserved <yes|no>", "Treatment: instruction/commitment preservation (from `compact --eval`)?")
    .option("--context-complete <yes|no>", "Treatment: no material context loss (the compacted context is complete for the task)?")
    .action(async (options: AddOptions) => {
      console.log(chalk.cyan("compaction input-compaction-ab add"));
      const arm = resolveArm(options.arm);
      const sidecar = JSON.parse(await readFile(options.usage, "utf8")) as CaptureUsageSidecar;
      const run = runFromSidecar(
        arm,
        sidecar,
        arm === "treatment"
          ? {
              contextPreserved: yesNo(options.contextPreserved, "--context-preserved"),
              taskSolved: yesNo(options.taskSolved, "--task-solved"),
              sourceRecoverability: yesNo(options.sourceRecoverable, "--source-recoverable"),
              commitmentPreservation: yesNo(options.commitmentPreserved, "--commitment-preserved"),
              noMaterialLoss: yesNo(options.contextComplete, "--context-complete")
            }
          : {},
        options.usage
      );
      const experiment = addInputCompactionAbRun(await loadExperiment(options.experiment), run);
      await saveExperiment(options.experiment, experiment);
      const src = run.providerReported ? chalk.green("provider-reported") : chalk.yellow(`${run.tokenSource} (not provider-reported)`);
      console.log(`  Added ${chalk.bold(arm)} run: input=${run.inputTokens ?? "unavailable"} output=${run.outputTokens ?? "unavailable"} tokens, source=${src}.`);
      if (!run.providerReported) console.log(chalk.yellow("  ! this arm is not provider-reported → it can never produce a confirmed input-savings number."));
    });

  ab.command("status")
    .description("Show the OBSERVED input-token A/B + conservative confidence (never a confirmed savings number).")
    .requiredOption("--experiment <file>", "Path to the experiment JSON.")
    .action(async (options: StatusOptions) => {
      console.log(chalk.cyan("compaction input-compaction-ab status"));
      console.log(PRIVACY_NOTE);
      const s: InputCompactionAbSummary = summarizeInputCompactionAb(await loadExperiment(options.experiment));
      const fmt = (n: number | null) => (n === null ? chalk.gray("unavailable") : `${Math.round(n)}`);
      console.log(`  experiment:                 ${s.experimentId}`);
      console.log(`  N (control / treatment):    ${s.nControl} / ${s.nTreatment}`);
      console.log(`  input_tokens_before:        ${fmt(s.inputTokensBefore)}`);
      console.log(`  input_tokens_after:         ${fmt(s.inputTokensAfter)}`);
      console.log(`  input_token_delta:          ${fmt(s.inputTokenDelta)}  ${chalk.gray("(observed, not confirmed)")}`);
      console.log(`  input_token_reduction_pct:  ${s.inputTokenReductionPct === null ? chalk.gray("unavailable") : `${s.inputTokenReductionPct.toFixed(1)}%`}  ${chalk.gray("(observed)")}`);
      console.log(`  output_token_delta:         ${fmt(s.outputTokenDelta)}  ${chalk.gray("(observed, SECONDARY - not the input claim)")}`);
      console.log(`  token_source:               ${s.tokenSource}`);
      console.log(`  context-preservation eval:  ${s.contextPreservation}  ${chalk.gray("(recoverability + commitment + no-material-loss + task-solved; NOT short-but-sufficient)")}`);
      console.log(`  semantic eval:              ${s.semanticEval}`);
      const conf = s.confidence === "unavailable" ? chalk.gray(s.confidence) : chalk.yellow(s.confidence);
      console.log(`  confidence:                 ${conf}`);
      console.log(`  confirmed input savings:    ${chalk.gray("unavailable in the public CLI - the engine gate produces a confirmed number.")}`);
      for (const reason of s.reasons) console.log(chalk.gray(`    • ${reason}`));
    });
}
