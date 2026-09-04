/**
 * `compaction savings` - the honest, A/B-backed view of what output shaping actually saved (PUBLIC CLI,
 * engine-free, content-free, local-first).
 *
 * Output shaping biases the request toward shorter output; whether that REDUCED output tokens is a MEASURED
 * question, so this command reports ONLY measured, labeled figures from a real output-shaping A/B experiment
 * file (produced by `compaction output-shaping-ab`, see that command). It NEVER invents a percentage:
 *  - No experiment / no provider-reported sample yet → `unavailable-until-measured` with the exact next step.
 *  - A measured sample → the OBSERVED per-turn output-token reduction (means, %, per-arm N, confidence).
 *    This is provider-reported, NOT billing-confirmed.
 *  - With `--plan-output-budget <N>` → additionally a plan-lifetime "extended by ~X tokens / ~Y turns"
 *    figure, explicitly labeled a Route A INFERENCE (projected, not directly observed, not billing-confirmed).
 *
 * Boundary: this shows the OBSERVED A/B only; a CONFIRMED output-savings number is produced solely by the
 * private engine gate (measured ±2·SE criterion + short-but-sufficient + reduction). No network, no credential.
 */
import { readFile } from "node:fs/promises";
import chalk from "chalk";
import { Command } from "commander";
import { summarizeOutputShapingAb, type OutputShapingAbExperiment } from "../../core/output-shaping-ab.js";
import {
  measuredPerTurnReduction,
  planLifetimeProjection
} from "../../core/output-shaping-savings.js";
import {
  loadNetBilledCalibration,
  netBilledRate,
  type NetBilledRate
} from "../../core/gateway/net-billed-calibration-store.js";

const PRIVACY_NOTE =
  "Local-first: no network, no credential. Figures come from YOUR output-shaping A/B artifact. This shows the " +
  "OBSERVED reduction (provider-reported, NOT billing-confirmed); a CONFIRMED savings number is an engine step.";

/** Round a number to at most one decimal, dropping a trailing `.0`. */
function pct(value: number): string {
  const r = Math.round(value * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

function group(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

interface SavingsOptions {
  experiment?: string;
  planOutputBudget?: string;
}

/**
 * Render the NET-BILLED input section: the provider-CONFIRMED net-of-provider-cache fresh-billed input
 * reduction, accumulated from real A/B proof runs (baseline no-apply vs compacted apply, same proof-run id)
 * fed in by the key-gated operator path (`compaction gateway verify-cache`). This is provider-reported and
 * scoped, explicitly NOT billing-confirmed (published token counts, never an invoice). It is surfaced with
 * its true SIGN:
 *  - no real A/B yet → `unavailable-until-measured` (never a fabricated %);
 *  - a positive net reduction → the measured `-PP%` with its sample count;
 *  - ZERO or NEGATIVE → the honest "apply did not help / raised net-billed input on cached traffic" outcome
 *    (never floored to a positive), because applying compaction can bust the provider cache.
 */
function renderNetBilledSection(rate: NetBilledRate): void {
  console.log(chalk.cyan("  Net-billed input reduction (provider-reported net-of-cache A/B, NOT billing-confirmed):"));
  if (!rate.measured || rate.rate === undefined || rate.absoluteTokens === undefined) {
    console.log(chalk.yellow("    Net-billed input reduction: unavailable-until-measured."));
    console.log(chalk.dim("    No real net-billed A/B has been recorded yet. The per-turn apply line's input `-PP%` is a"));
    console.log(chalk.dim("    GROSS model-visible estimate, not a net-of-provider-cache fresh-billed figure. Confirm the"));
    console.log(chalk.dim("    net-billed reduction with a real A/B using YOUR provider key (no key → no call is made):"));
    console.log(chalk.dim("      ANTHROPIC_API_KEY=... compaction gateway verify-cache --provider anthropic"));
    console.log(chalk.dim("      OPENAI_API_KEY=...    compaction gateway verify-cache --provider openai"));
    return;
  }
  const signedPct = pct(rate.rate * 100);
  const baseline = group(rate.baselineFreshInputTokens ?? 0);
  const compacted = group(rate.compactedFreshInputTokens ?? 0);
  const n = rate.sampleCount;
  const runs = `${n} A/B proof run${n === 1 ? "" : "s"}`;
  if (rate.rate > 0) {
    console.log(
      chalk.green(
        `    ${baseline} → ${compacted} fresh-billed input tokens (−${signedPct}%, ${group(rate.absoluteTokens)} fewer) across ${runs}.`
      )
    );
    console.log(chalk.dim("    Provider-reported net-of-cache fresh-billed input, scoped to these A/B runs. NOT billing-confirmed."));
  } else if (rate.rate === 0) {
    console.log(chalk.yellow(`    ${baseline} → ${compacted} fresh-billed input tokens (0%): apply did NOT change net-billed input across ${runs}.`));
    console.log(chalk.dim("    Provider-reported, scoped, NOT billing-confirmed."));
  } else {
    console.log(
      chalk.red(
        `    ${baseline} → ${compacted} fresh-billed input tokens (+${pct(Math.abs(rate.rate) * 100)}%, ${group(Math.abs(rate.absoluteTokens))} MORE) across ${runs}.`
      )
    );
    console.log(chalk.dim("    Apply RAISED net-billed input on this cached traffic (it busted the provider cache). This is a real,"));
    console.log(chalk.dim("    honest outcome — not floored to zero. Provider-reported, scoped, NOT billing-confirmed."));
  }
}

export async function runSavings(options: SavingsOptions): Promise<void> {
  console.log(chalk.cyan("compaction savings"));
  console.log(chalk.dim(`  ${PRIVACY_NOTE}`));
  console.log();

  // NET-BILLED input section first: the provider-CONFIRMED net-of-cache fresh-billed A/B figure (or an honest
  // unavailable-until-measured). Read-only + best-effort: a local store IO error never breaks the view.
  try {
    renderNetBilledSection(netBilledRate(await loadNetBilledCalibration()));
  } catch {
    // Best-effort: never let the net-billed read break the output-shaping savings view.
  }
  console.log();

  // No experiment file yet → honest unavailable-until-measured (never a fabricated %).
  if (!options.experiment) {
    console.log(chalk.yellow("  Output-shaping savings: unavailable-until-measured."));
    console.log(chalk.dim("  No A/B experiment supplied. Shaping biases the request shorter, but the output-token reduction"));
    console.log(chalk.dim("  is only known once measured on a real provider-reported A/B. Produce one, then pass it here:"));
    console.log(chalk.dim("    compaction output-shaping-ab init   --experiment <id> --out ab.json"));
    console.log(chalk.dim("    compaction output-shaping-ab add    --experiment ab.json --arm control   --usage <capture-usage.json>"));
    console.log(chalk.dim("    compaction output-shaping-ab add    --experiment ab.json --arm treatment --usage <capture-usage.json> --eval-pass"));
    console.log(chalk.dim("    compaction savings --experiment ab.json [--plan-output-budget <N>]"));
    return;
  }

  let experiment: OutputShapingAbExperiment;
  try {
    experiment = JSON.parse(await readFile(options.experiment, "utf8")) as OutputShapingAbExperiment;
  } catch (error) {
    console.error(chalk.red(`  Could not read the experiment file '${options.experiment}': ${error instanceof Error ? error.message : String(error)}`));
    process.exitCode = 1;
    return;
  }

  const summary = summarizeOutputShapingAb(experiment);
  const reduction = measuredPerTurnReduction(summary);

  if (reduction.availability === "unavailable") {
    console.log(chalk.yellow("  Measured per-turn reduction: unavailable-until-measured."));
    console.log(chalk.dim(`    ${reduction.reason}`));
    for (const r of summary.reasons) console.log(chalk.dim(`    - ${r}`));
    return;
  }

  console.log(chalk.green("  Measured per-turn output-token reduction (OBSERVED, provider-reported, NOT billing-confirmed):"));
  console.log(
    `    ${group(reduction.meanControlOutputTokens)} → ${group(reduction.meanTreatmentOutputTokens)} output tokens/turn ` +
      `(−${pct(reduction.reductionPct)}%, mean saving ${group(reduction.meanOutputTokenReduction)}/turn)`
  );
  console.log(chalk.dim(`    denominators: control N=${reduction.nControl}, treatment N=${reduction.nTreatment}   ·   confidence: ${reduction.confidence}`));

  const budget = options.planOutputBudget !== undefined ? Number(options.planOutputBudget) : undefined;
  const projection = planLifetimeProjection(reduction, budget);
  console.log();
  if (projection.availability === "unavailable") {
    console.log(chalk.dim(`  Plan-lifetime projection: unavailable. ${projection.reason}`));
    return;
  }
  console.log(chalk.green("  Plan-lifetime projection (INFERENCE):"));
  console.log(
    `    at a ${group(projection.planOutputBudgetTokens)}-output-token plan budget, shaping effectively extends it by ` +
      `~${group(projection.extendedByTokens)} output tokens (~${group(projection.extendedByTurns)} more shaped turns).`
  );
  console.log(chalk.yellow(`    ${projection.label}.`));
}

export function registerSavingsCommand(program: Command): void {
  program
    .command("savings")
    .description(
      "Show the MEASURED output-shaping savings from a real A/B artifact (provider-reported, NOT billing-confirmed): " +
        "per-turn output-token reduction with per-arm N, and an optional Route-A INFERENCE plan-lifetime projection. " +
        "No artifact yet → unavailable-until-measured (never a fabricated %). Local-first, content-free."
    )
    .option("--experiment <file>", "Path to an output-shaping A/B experiment file (from `compaction output-shaping-ab`).")
    .option("--plan-output-budget <N>", "Your plan's output-token budget; adds a Route-A INFERENCE plan-lifetime projection.")
    .action(async (options: SavingsOptions) => {
      await runSavings(options);
    });
}
