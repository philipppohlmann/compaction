import chalk from "chalk";
import { Command } from "commander";
import {
  authorizationStoreDirectory,
  disablePolicyPreference,
  findPolicyPreference,
  explainPolicyPreference,
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
    // THE EMPTY STATE IS WHERE THE EXPLANATION IS NEEDED. An authorization is stored per device; before
    // 0.6.7 it was written into whatever directory `init --authorize-auto-apply` ran in. A user who
    // authorized that way sees apply stop after upgrading and comes here to find out why — standing in
    // the very project whose `.compaction/policy-preferences.json` is still on disk. "Nothing saved" is
    // true and useless to them: it neither explains the file they can see nor names the one command
    // that fixes it. The device-scope note belongs on THIS branch at least as much as on the populated
    // one, so say it here and name the command.
    return [
      "No auto-apply preferences saved on this device. The default is ask-each-time - Compaction asks",
      "before applying anything.",
      "",
      `Authorizations are stored per DEVICE, in ${authorizationStoreDirectory()} - not in your project.`,
      "A .compaction/policy-preferences.json inside a project grants nothing, so if you authorized from",
      "inside a project before v0.6.7, authorize once more and it will apply in every directory:",
      "",
      "  compaction init --authorize-auto-apply claude-code"
    ].join("\n");
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
    ``,
    // Same answer from every directory, and it says WHY: these are the device's authorizations, held in
    // one place. A preference file inside a project is not one of them and never authorizes anything.
    // Scope, not activation: this says WHERE an authorization counts, never that apply will happen -
    // the gate sentence above already governs that, and every other condition (mode, lease, engine,
    // `compaction stop`) is checked per request.
    `Stored per DEVICE, in ${authorizationStoreDirectory()} - their scope is not limited to`,
    `one directory; a repo-pinned scope narrows one to a single repo. A .compaction/`,
    `policy-preferences.json inside a project grants nothing.`,
    ``
  ];
  const lines = [pad(header), pad(header.map((_, col) => "-".repeat(widths[col]))), ...rows.map(pad)];
  return [...preamble, ...lines, ``, `Explain one:  compaction policies explain <id>`, `Turn one off: compaction policies disable <id>`].join("\n");
}

/**
 * The ONE store `policies` manages: the device authorization store, the same and only store the apply
 * guard reads. Management must not be wider OR narrower than enforcement — an authorization you cannot
 * list is one you cannot disable, and a listing that changes with your cwd cannot be reasoned about.
 * Naming the path in the output is what makes the answer identical, and legible, from every directory.
 */
const authorizationStore = (): string => authorizationStoreDirectory();

export function registerPoliciesCommand(program: Command): void {
  const policies = program
    .command("policies")
    .description("View and disable this DEVICE's stored auto-apply preferences (read-only + safe disable; no enable, no apply).");

  policies
    .command("list")
    .description("List saved auto-apply preferences (id, scope, policy, preference, enabled, gates_required).")
    .action(async () => {
      const { preferences } = await readPolicyPreferences(authorizationStore());
      console.log(chalk.cyan(formatPreferencesList(preferences)));
    });

  policies
    .command("disable <id>")
    .description("Disable a saved preference by id (always safe - never enables, never applies).")
    .action(async (id: string) => {
      const result = await disablePolicyPreference(id, authorizationStore());
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
      const preference = await findPolicyPreference(id, authorizationStore());
      if (!preference) {
        console.error(chalk.red(`No preference with id "${id}" - run "compaction policies list" to see saved ids.`));
        process.exitCode = 1;
        return;
      }
      console.log(chalk.cyan(explainPolicyPreference(preference)));
    });
}
