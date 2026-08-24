/**
 * `compaction output-shaping-ab`, the operator-run path to produce + ingest a real provider-reported A/B
 * comparison for the output-shaping policy family (increment 4). Mirrors the `billing-delta` harness:
 * local-first, content-free, no network, no credentials.
 *
 *   compaction output-shaping-ab init   --experiment <id> --out <file> [--task-shape <label>]
 *   compaction output-shaping-ab add    --experiment <file> --arm control|treatment --usage <capture-usage.json>
 *                                       [--eval-pass | --eval-fail] [--truncated] [--refused]
 *   compaction output-shaping-ab status --experiment <file>
 *
 * Honesty (binding): this PUBLIC CLI shows only the OBSERVED measurement + a conservative confidence
 * (unavailable / review_required / observed_not_confirmed / eligible_for_engine_confirmation). It NEVER
 * shows a confirmed output-savings number, that is produced solely by the private engine gate. A/B arms
 * without provider-reported output tokens (e.g. Cursor) stay `unavailable`.
 */
import { readFile, writeFile } from "node:fs/promises";
import chalk from "chalk";
import { Command } from "commander";
import {
  addOutputShapingAbRun,
  initOutputShapingAbExperiment,
  summarizeOutputShapingAb,
  type CaptureUsageSidecar,
  type OutputShapingAbArm,
  type OutputShapingAbExperiment,
  type OutputShapingAbRun
} from "../../core/output-shaping-ab.js";

const PRIVACY_NOTE =
  "Operator-run, local-first. compaction.dev makes NO provider call, reads NO credential, and has NO network access. " +
  "Token counts come from YOUR capture artifacts. This CLI shows the OBSERVED A/B only - a CONFIRMED output-savings " +
  "number is produced solely by the engine gate (provider-reported, measured criterion, short-but-sufficient, reduction).";

async function loadExperiment(file: string): Promise<OutputShapingAbExperiment> {
  return JSON.parse(await readFile(file, "utf8")) as OutputShapingAbExperiment;
}

async function saveExperiment(file: string, experiment: OutputShapingAbExperiment): Promise<void> {
  await writeFile(file, JSON.stringify(experiment, null, 2), "utf8");
}

interface InitOptions {
  experiment: string;
  out: string;
  taskShape?: string;
}

interface AddOptions {
  experiment: string;
  arm: string;
  usage: string;
  evalPass?: boolean;
  evalFail?: boolean;
  truncated?: boolean;
  refused?: boolean;
}

interface StatusOptions {
  experiment: string;
}

function resolveArm(arm: string): OutputShapingAbArm {
  if (arm !== "control" && arm !== "treatment") {
    throw new Error('--arm must be "control" or "treatment".');
  }
  return arm;
}

/** Operator-recorded sufficiency outcome: --eval-pass → true, --eval-fail → false, neither → undefined. */
function resolveEval(options: AddOptions): boolean | undefined {
  if (options.evalPass && options.evalFail) throw new Error("pass --eval-pass OR --eval-fail, not both.");
  if (options.evalPass) return true;
  if (options.evalFail) return false;
  return undefined;
}

export function registerOutputShapingAbCommand(program: Command): void {
  const ab = program
    .command("output-shaping-ab")
    .description(
      "Operator-run, content-free output-shaping A/B harness: link a control arm (no shaping) and a " +
        "treatment arm (--output-shaping) of Codex captures and show the OBSERVED provider-reported output-token " +
        "delta. Shows confirmed savings NEVER - the engine gate does that."
    );

  ab.command("init")
    .description("Create a new output-shaping A/B experiment file.")
    .requiredOption("--experiment <id>", "Experiment id (a short label, not content).")
    .requiredOption("--out <file>", "Path to write the experiment JSON.")
    .option("--task-shape <label>", "Short generic label of the shared task/prompt SHAPE (not prompt content).", "unspecified-task-shape")
    .action(async (options: InitOptions) => {
      console.log(chalk.cyan("compaction output-shaping-ab init"));
      console.log(PRIVACY_NOTE);
      const experiment = initOutputShapingAbExperiment({ experimentId: options.experiment, taskShape: options.taskShape ?? "unspecified-task-shape" });
      await saveExperiment(options.out, experiment);
      console.log(chalk.green(`Wrote ${options.out}`));
      console.log("  Next: run both arms, then `output-shaping-ab add` each capture-usage.json.");
      console.log('    control:   compaction capture codex --out runs/a1 -- codex exec --json "TASK"');
      console.log('    treatment: compaction capture codex --output-shaping --out runs/b1 -- codex exec --json "TASK"');
    });

  ab.command("add")
    .description("Ingest a capture-usage.json sidecar into an A/B arm (provider-reported tokens + policy names).")
    .requiredOption("--experiment <file>", "Path to the experiment JSON (from `init`).")
    .requiredOption("--arm <arm>", 'Which arm: "control" (no shaping) or "treatment" (--output-shaping).')
    .requiredOption("--usage <file>", "Path to a capture-usage.json sidecar written by `compaction capture`.")
    .option("--eval-pass", "Record that the treatment output preserved all required task-outcome markers (short-but-sufficient).")
    .option("--eval-fail", "Record that the treatment output dropped a required marker (shorter-but-lossy - not a saving).")
    .option("--truncated", "Record that the answer was truncated/incomplete (not a saving).")
    .option("--refused", "Record that the model refused (not a saving).")
    .action(async (options: AddOptions) => {
      console.log(chalk.cyan("compaction output-shaping-ab add"));
      const arm = resolveArm(options.arm);
      const evalOutcome = resolveEval(options);
      const sidecar = JSON.parse(await readFile(options.usage, "utf8")) as CaptureUsageSidecar;

      if (arm === "treatment" && (!sidecar.outputShaping || sidecar.outputShaping.policyNames.length === 0)) {
        console.log(chalk.yellow("  ! warning: treatment arm but this capture has no output-shaping attribution (was --output-shaping used?)."));
      }
      if (arm === "control" && sidecar.outputShaping && sidecar.outputShaping.policyNames.length > 0) {
        console.log(chalk.yellow("  ! warning: control arm but this capture HAS output-shaping attribution - control should be the no-shaping arm."));
      }

      const run: OutputShapingAbRun = {
        arm,
        outputTokens: sidecar.outputTokens,
        inputTokens: sidecar.inputTokens,
        providerReported: sidecar.providerReported === true,
        tokenSource: sidecar.tokenSource,
        ...(arm === "treatment" && sidecar.outputShaping
          ? { policyFamily: sidecar.outputShaping.policyFamily, policyNames: sidecar.outputShaping.policyNames }
          : {}),
        ...(arm === "treatment" ? { evalMarkersPreserved: evalOutcome ?? null } : {}),
        ...(options.truncated ? { truncated: true } : {}),
        ...(options.refused ? { refused: true } : {}),
        reference: options.usage
      };

      const experiment = addOutputShapingAbRun(await loadExperiment(options.experiment), run);
      await saveExperiment(options.experiment, experiment);
      const src = run.providerReported ? chalk.green("provider-reported") : chalk.yellow(`${run.tokenSource} (not provider-reported)`);
      console.log(`  Added ${chalk.bold(arm)} run: output=${run.outputTokens ?? "unavailable"} tokens, source=${src}.`);
      if (!run.providerReported) console.log(chalk.yellow("  ! this arm is not provider-reported → it can never produce a confirmed output-savings number."));
    });

  ab.command("status")
    .description("Show the OBSERVED A/B measurement + conservative confidence (never a confirmed savings number).")
    .requiredOption("--experiment <file>", "Path to the experiment JSON.")
    .action(async (options: StatusOptions) => {
      console.log(chalk.cyan("compaction output-shaping-ab status"));
      console.log(PRIVACY_NOTE);
      const summary = summarizeOutputShapingAb(await loadExperiment(options.experiment));
      const fmt = (n: number | null, unit = "") => (n === null ? chalk.gray("unavailable") : `${Math.round(n)}${unit}`);

      console.log(`  experiment:                 ${summary.experimentId}`);
      console.log(`  N (control / treatment):    ${summary.nControl} / ${summary.nTreatment}`);
      console.log(`  output_tokens_before:       ${fmt(summary.outputTokensBefore)}`);
      console.log(`  output_tokens_after:        ${fmt(summary.outputTokensAfter)}`);
      console.log(`  output_token_delta:         ${fmt(summary.outputTokenDelta)}  ${chalk.gray("(observed, not confirmed)")}`);
      console.log(`  output_token_reduction_pct: ${summary.outputTokenReductionPct === null ? chalk.gray("unavailable") : `${summary.outputTokenReductionPct.toFixed(1)}%`}  ${chalk.gray("(observed)")}`);
      console.log(`  token_source:               ${summary.tokenSource}`);
      console.log(`  policy family / names:      ${summary.policyFamily ?? chalk.gray("none")} / ${summary.policyNames.length ? summary.policyNames.join(", ") : chalk.gray("none")}`);
      console.log(`  eval (short-but-sufficient):${summary.evalStatus}`);
      // `eligible_for_engine_confirmation` is a PRECONDITION, not a confirmation - keep it amber, not green,
      // so the public status is never mistaken for a confirmed saving. `unavailable` is gray; the rest amber.
      const conf = summary.confidence === "unavailable" ? chalk.gray(summary.confidence) : chalk.yellow(summary.confidence);
      console.log(`  confidence:                 ${conf}`);
      console.log(`  confirmed output savings:   ${chalk.gray("unavailable in the public CLI - the engine gate produces a confirmed number.")}`);
      for (const reason of summary.reasons) console.log(chalk.gray(`    • ${reason}`));
    });
}
