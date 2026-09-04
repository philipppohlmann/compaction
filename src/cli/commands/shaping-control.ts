/**
 * `compaction stop` / `compaction start` - the user-facing on/off switch for the WHOLE Compaction
 * optimization (PUBLIC CLI, engine-free, content-free).
 *
 * These toggle a small PERSISTED run-state (`~/.compaction/shaping-state.json`, see
 * `subscription-shaping-state.ts`) that BOTH optimization levers HONOR:
 *  - OUTPUT SHAPING: every installed before-call shaping hook (Claude Code / Codex). While stopped, the
 *    next shapeable turn emits NOTHING, so the prompt runs UNCHANGED.
 *  - APPLY ROUTING: the transparent Claude Code gateway apply path. While stopped, the routing ensure
 *    declines to engage the workflow-scoped gateway AND the server's stored-authorization apply path holds,
 *    so a routed `claude` run is RECORD-ONLY (no request mutation).
 *
 * So:
 *  - `compaction stop`  → persists `stopped`; from the next turn, shaping emits nothing AND apply routing
 *    is disabled (record-only). Fail-open: while stopped, neither lever runs.
 *  - `compaction start` → persists `active`; both levers resume from the next turn (shaping still subject to
 *    the planning-hold classifier + env kill-switch; apply routing still subject to its full dormant guard -
 *    API key + input-opt + stored authorization + explicit init).
 *
 * Distinct from `gateway stop` (which manages the ROUTING gateway's PROCESS lifecycle) and from
 * `init --disconnect` (the full, wiring-removing uninstall): `compaction stop` is a REVERSIBLE flag - the
 * hooks and shim stay installed, it just holds both levers until `compaction start`.
 *
 * Subscription honesty: a subscription/saved-login session has NO gateway apply lever (that path needs an
 * API key), so on subscription `stop` disables output shaping only - the copy says so.
 *
 * Honesty: shaping SHAPES the request (biases shorter output); it makes NO output-token savings claim (see
 * `compaction savings` for the measured, labeled effect). Toggling writes only the content-free run-state.
 */
import chalk from "chalk";
import { Command } from "commander";
import {
  startShaping,
  stopShaping,
  type ShapingStateChange
} from "../../core/subscription-shaping-state.js";
import { SHAPING_HOOKS_ENV } from "../../core/output-shaping-hook-activation.js";
import { isShapingTaskClassifierPresent } from "../../core/gateway/task-awareness-seam.js";
import { hasValidFullApplyLease } from "../../core/entitlement/lease-store.js";

/** True when the env kill-switch is thrown (so `start` can honestly warn it is still overridden by env). */
function killSwitchThrown(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[SHAPING_HOOKS_ENV];
  return typeof raw === "string" && ["0", "false", "off", "no"].includes(raw.toLowerCase());
}

/**
 * Whether the gateway APPLY-ROUTING lever is even available to this session. It needs a credential that
 * entitles apply, which is EITHER the API-key path (`ANTHROPIC_API_KEY`, presence only - the value is
 * never read) OR a verified entitlement lease on this device. Mirrors condition 1 of the apply-routing
 * dormant guard exactly, so `stop`/`start` never claim to have switched a lever the user does not have -
 * and, since an activated Community device DOES have it, never omit one they do.
 */
function applyRoutingLeverAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.ANTHROPIC_API_KEY && env.ANTHROPIC_API_KEY.trim() !== "") return true;
  return hasValidFullApplyLease(env);
}

/**
 * The honest name(s) of the lever(s) this session's `stop`/`start` covers, given the API-key presence,
 * plus the singular/plural verb so the copy reads grammatically (one lever → "is", two → "are").
 */
function leversLine(env: NodeJS.ProcessEnv): { levers: string; verb: "is" | "are"; subscriptionNote?: string } {
  if (applyRoutingLeverAvailable(env)) {
    return { levers: "Output shaping AND Claude Code apply routing", verb: "are" };
  }
  return {
    levers: "Output shaping",
    verb: "is",
    subscriptionNote:
      "  (no API key and no verified entitlement lease: this session has only the output-shaping lever.)"
  };
}

function printStopResult(change: ShapingStateChange, env: NodeJS.ProcessEnv = process.env): void {
  const { levers, verb, subscriptionNote } = leversLine(env);
  console.log(chalk.cyan("compaction stop"));
  if (change.changed) {
    console.log(chalk.green(`  ${levers} ${verb} now OFF. Your prompts run UNCHANGED and nothing is applied from the next turn.`));
  } else {
    console.log(chalk.dim(`  ${levers} ${verb === "are" ? "were" : "was"} already off - no change (idempotent).`));
  }
  if (subscriptionNote) console.log(chalk.dim(subscriptionNote));
  console.log(chalk.dim(`  Persisted content-free run-state: ${change.path}`));
  console.log(chalk.dim("  Turn it back on anytime:  compaction start   ·   Full uninstall (removes wiring):  compaction init --disconnect 1"));
}

async function printStartResult(change: ShapingStateChange, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const { levers, verb, subscriptionNote } = leversLine(env);
  console.log(chalk.cyan("compaction start"));
  if (change.changed) {
    const holdNote = (await isShapingTaskClassifierPresent())
      ? "shaping holds planning/reasoning turns"
      : "shaping applies to every turn - this build has no per-turn hold";
    console.log(chalk.green(`  ${levers} ${verb} now ON from the next turn (${holdNote}; apply routing still requires its full guard: API key + input-opt + stored authorization + connect).`));
  } else {
    console.log(chalk.dim(`  ${levers} ${verb === "are" ? "were" : "was"} already on - no change (idempotent).`));
  }
  if (subscriptionNote) console.log(chalk.dim(subscriptionNote));
  // Honest: `start` clears only the PERSISTED stop; the env kill-switch (if set) still overrides shaping.
  if (killSwitchThrown(env)) {
    console.log(
      chalk.yellow(
        `  NOTE: ${SHAPING_HOOKS_ENV} is set to a disabling value, which STILL overrides this and holds output shaping. ` +
          `Unset ${SHAPING_HOOKS_ENV} to let shaping run (apply routing is unaffected by that env).`
      )
    );
  }
  console.log(chalk.dim(`  Persisted content-free run-state: ${change.path}`));
  console.log(chalk.dim("  See the measured effect:  compaction savings   ·   Turn it off:  compaction stop"));
}

export function registerStopCommand(program: Command): void {
  program
    .command("stop")
    .description(
      "Turn Compaction OFF (persisted, reversible): disables BOTH output shaping and Claude Code apply routing. " +
        "Installed shaping hooks then emit nothing (prompts run unchanged) and routed `claude` runs stay record-only " +
        "(no request mutation). On a subscription (no API key) only output shaping applies. Distinct from `gateway stop` " +
        "(routing process) and `init --disconnect` (full uninstall). Re-enable with `compaction start`."
    )
    .action(() => {
      printStopResult(stopShaping());
    });
}

export function registerStartCommand(program: Command): void {
  program
    .command("start")
    .description(
      "Turn Compaction back ON (persisted) after `compaction stop`: re-enables BOTH output shaping and Claude Code " +
        "apply routing from the next turn (apply routing still requires its full guard: API key + input-opt + stored " +
        "authorization + connect). If COMPACTION_SHAPING_HOOKS is set to disable, that still overrides output shaping."
    )
    .action(async () => {
      const change = startShaping();
      await printStartResult(change);
    });
}
