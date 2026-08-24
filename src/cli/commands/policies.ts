import chalk from "chalk";
import { Command } from "commander";
import {
  disablePolicyPreference,
  explainPolicyPreference,
  findPolicyPreference,
  readPolicyPreferences,
  type PolicyPreference
} from "../../core/policy-preferences.js";

/**
 * `compaction policies`, READ-ONLY management of stored auto-apply PREFERENCES, plus the single
 * safe mutating verb `disable`. There is deliberately NO `enable` here: enabling a preference only
 * ever happens via the explicit, informed onboarding authorization (`compaction init
 * --authorize-auto-apply <workflow>`), never as a bare CLI toggle. Disabling can only ever REDUCE
 * what could apply, so it is always safe, and it takes effect on the very next request (the
 * gateway reads the preference file fresh each run).
 *
 * None of these commands apply anything themselves. An enabled `auto-when-gates-pass` preference
 * with engine-evaluable gates IS honored by the gateway's deterministic eligibility engine
 * (`src/core/gateway/apply-eligibility.ts`) on future eligible runs; `explain` states per
 * preference whether it is active, exactly which gates every application requires, and how to
 * recover/disable.
 */
function scopeLine(preference: PolicyPreference): string {
  return preference.scope.repo
    ? `${preference.scope.tool} (repo ${preference.scope.repo})`
    : preference.scope.tool;
}

function formatPreferencesList(preferences: PolicyPreference[]): string {
  if (preferences.length === 0) {
    return "No auto-apply preferences saved. The default is ask-each-time - Compaction asks before applying anything.";
  }
  const header = ["id", "scope", "policy", "preference", "enabled", "gates_required"];
  const rows = preferences.map((preference) => [
    preference.id,
    scopeLine(preference),
    preference.scope.policy_type,
    preference.preference,
    preference.enabled ? "yes" : "no",
    `${preference.gates_required.length} gate(s)`
  ]);
  const widths = header.map((cell, col) => Math.max(cell.length, ...rows.map((line) => line[col].length)));
  const pad = (cells: string[]): string => cells.map((cell, col) => cell.padEnd(widths[col])).join("  ");
  const preamble = [
    `Saved auto-apply preferences (${preferences.length}). An ENABLED auto-when-gates-pass preference is a`,
    `scoped authorization: eligible requests in its exact scope are applied automatically by the`,
    `deterministic policy ONLY when every safety gate passes; everything else is forwarded unchanged.`,
    `ask-each-time and disabled preferences never apply anything.`,
    ``
  ];
  const lines = [pad(header), pad(header.map((_, col) => "-".repeat(widths[col]))), ...rows.map(pad)];
  return [...preamble, ...lines, ``, `Explain one:  compaction policies explain <id>`, `Turn one off: compaction policies disable <id>`].join("\n");
}

export function registerPoliciesCommand(program: Command): void {
  const policies = program
    .command("policies")
    .description("View and disable stored auto-apply preferences (read-only + safe disable; no enable, no apply).");

  policies
    .command("list")
    .description("List saved auto-apply preferences (id, scope, policy, preference, enabled, gates_required).")
    .action(async () => {
      const { preferences } = await readPolicyPreferences();
      console.log(chalk.cyan(formatPreferencesList(preferences)));
    });

  policies
    .command("disable <id>")
    .description("Disable a saved preference by id (always safe - never enables, never applies).")
    .action(async (id: string) => {
      const result = await disablePolicyPreference(id);
      if (!result.disabled) {
        console.error(chalk.red(result.reason));
        process.exitCode = 1;
        return;
      }
      if (result.alreadyDisabled) {
        console.log(chalk.yellow(`Preference ${id} was already disabled - nothing changed.`));
        return;
      }
      console.log(chalk.green(`Disabled preference ${id}. Nothing is applied automatically under it from the very next run.`));
    });

  policies
    .command("explain <id>")
    .description("Explain in plain language what a saved preference means and how to disable it.")
    .action(async (id: string) => {
      const preference = await findPolicyPreference(id);
      if (!preference) {
        console.error(chalk.red(`No preference with id "${id}" - run "compaction policies list" to see saved ids.`));
        process.exitCode = 1;
        return;
      }
      console.log(chalk.cyan(explainPolicyPreference(preference)));
    });
}
