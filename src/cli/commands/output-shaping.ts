import chalk from "chalk";
import { Command } from "commander";
import {
  buildOutputShapingPolicy,
  OUTPUT_SHAPING_POLICIES,
  OUTPUT_SHAPING_HONESTY_NOTE
} from "../../core/output-shaping.js";

interface OutputShapingOptions {
  budget?: string;
  policies?: string;
  list?: boolean;
}

/**
 * `compaction output-shaping`, print the deterministic output-shaping instruction block to attach to a
 * request BEFORE generation. Local, content-free; emits NO output-savings number (savings require a
 * measured before/after + eval-confirmed sufficiency, the private/gated verification).
 */
export function registerOutputShapingCommand(program: Command): void {
  program
    .command("output-shaping")
    .description(
      "Print a deterministic output-shaping instruction block to attach to your request BEFORE generation " +
        "(the only mechanism that reduces provider output tokens). Local, content-free; no savings claimed."
    )
    .option("--budget <tokens>", "Soft verbosity budget in output tokens (used by the verbosity-budget policy)")
    .option("--policies <names>", "Comma-separated policy names to apply (default: the default-on set)")
    .option("--list", "List the available output-shaping policies and exit")
    .action((options: OutputShapingOptions) => {
      if (options.list) {
        console.log(chalk.cyan("Output-shaping policies (deterministic, rule-based):"));
        for (const p of OUTPUT_SHAPING_POLICIES) {
          console.log(`  ${p.policy_name} [risk: ${p.risk_level}${p.defaultOn ? ", default-on" : ", off by default"}] - ${p.description}`);
        }
        console.log(chalk.gray(`\n${OUTPUT_SHAPING_HONESTY_NOTE}`));
        return;
      }

      const budget = options.budget !== undefined ? Number.parseInt(options.budget, 10) : undefined;
      const policies = options.policies ? options.policies.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
      const result = buildOutputShapingPolicy({
        ...(budget !== undefined && Number.isFinite(budget) ? { verbosityBudgetTokens: budget } : {}),
        ...(policies ? { policies } : {})
      });

      if (result.instructions === "") {
        console.error("error: no matching output-shaping policies (use --list to see available policy names).");
        process.exitCode = 1;
        return;
      }

      console.log(chalk.cyan("compaction output-shaping"));
      console.log(result.instructions);
      console.log("");
      console.log(chalk.gray(`Applied: ${result.applied.map((a) => a.policy_name).join(", ")}`));
      console.log(chalk.gray(OUTPUT_SHAPING_HONESTY_NOTE));
    });
}
