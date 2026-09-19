#!/usr/bin/env node
import { Command } from "commander";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { registerAnalyzeCommand } from "./commands/analyze.js";
import { registerActivityCommand } from "./commands/activity.js";
import { registerAdapterCommand } from "./commands/adapter.js";
import { registerAggregateCommand } from "./commands/aggregate.js";
import { registerAuditCommand } from "./commands/audit.js";
import { registerApplyCommand } from "./commands/apply.js";
import { registerApplyContextCommand } from "./commands/apply-context.js";
import { registerApproveCommand } from "./commands/approve.js";
import { registerApiCommand } from "./commands/api.js";
import { registerInitCommand } from "./commands/init.js";
import { registerCaptureCommand } from "./commands/capture.js";
import { registerCompactCommand } from "./commands/compact.js";
import { registerContextCommand } from "./commands/context.js";
import { registerEngineCommand } from "./commands/engine.js";
import { registerEvalCommand } from "./commands/eval.js";
import { registerDevCommand } from "./commands/dev.js";
import { registerExportSessionSeedCommand } from "./commands/export-session-seed.js";
import { registerFeedbackCommand } from "./commands/feedback.js";
import { registerGatewayCommand } from "./commands/gateway.js";
import { registerHooksCommand } from "./commands/hooks.js";
import { registerImportCommand } from "./commands/import.js";
import { registerInputCompactionAbCommand } from "./commands/input-compaction-ab.js";
import { registerIntegrationsCommand } from "./commands/integrations.js";
import { registerLaunchTreatmentSessionCommand } from "./commands/launch-treatment-session.js";
import { registerLoginCommand, registerLogoutCommand, registerDevicesCommand } from "./commands/login.js";
import { registerModeCommand } from "./commands/mode.js";
import { registerProCommand, runPro } from "./commands/pro.js";
import { registerLeaseCommand } from "./commands/lease.js";
import { registerOptimizeCommand } from "./commands/optimize.js";
import { registerRecommendCommand } from "./commands/recommend.js";
import { registerReviewCommand } from "./commands/review.js";
import { registerOutputShapingCommand } from "./commands/output-shaping.js";
import { registerOutputShapingAbCommand } from "./commands/output-shaping-ab.js";
import { registerPoliciesCommand } from "./commands/policies.js";
import { registerPrecallCommand } from "./commands/precall.js";
import { registerRunCommand } from "./commands/run.js";
import { registerSpendCommand } from "./commands/spend.js";
import { registerStatuslineCommand } from "./commands/statusline.js";
import { registerStopCommand, registerStartCommand } from "./commands/shaping-control.js";
import { registerSavingsCommand } from "./commands/savings.js";
import { registerSummaryCommand } from "./commands/summary.js";
import { registerWatchCommand } from "./commands/watch.js";
import { registerLegacyUpgradeAlias, registerStatusCommand } from "./commands/upgrade-status.js";
import { registerUsageCommand } from "./commands/usage.js";
import { registerUpdateCommand } from "./commands/update.js";
import { redeemPendingConsentsQuietly } from "../core/pending-authorizations.js";
import { compactMarkFor } from "./terminal-logo.js";
import { convergeOfficialNpmGlobalInvocation } from "../core/update/npm-global-adoption.js";

function cliPackageVersion(): string {
  // dist/cli/index.js -> ../../package.json (same layout init.ts relies on). Fallback keeps --version working.
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(path.resolve(here, "..", "..", "package.json"), "utf8")) as { version?: string };
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

const program = new Command();

program
  .name("compaction")
  .description(
    // Describes what THIS package does. Input compaction lives in the separately delivered engine, so
    // advertising it here would promise the one thing a no-account install refuses (`compact` exits
    // non-zero with the engine-boundary message).
    "Install once and route Claude Code, Codex, or Cursor through a local, byte-safe Gateway - " +
      "measure token & cache usage with content-free receipts and shape responses before generation " +
      "for shorter output. Local-first, no account required, no prompt or code telemetry. Adaptive input compaction needs a " +
      "free account and the separately delivered engine."
  )
  .version(cliPackageVersion());

// Brand mark above the TOP-LEVEL help only (`compaction --help`). Bare `compaction`
// no longer shows help, it launches onboarding via the `init` default command.
// Derived rendering of apps/web/src/assets/compaction-mark.svg, see
// docs/brand/terminal-logo.md. Colored only on a TTY with NO_COLOR unset; plain
// glyphs otherwise. Adds three lines before "Usage:"; no command output,
// subcommand help, exit code, or --version behavior changes.
program.addHelpText("before", ({ error }) => {
  return `${compactMarkFor(error ? process.stderr : process.stdout)}\n`;
});

// CONSENT CARRIED TO ACTIVATION. Onboarding's Cache + context confirmation cannot store a narrow
// auto-apply authorization for a capture shim that the CURRENT shell does not resolve yet - the
// verified-active bar is not negotiable - so on a fresh machine it records the consent instead and
// this hook redeems it the first time ANY Compaction process runs with that shim genuinely active.
// The shim's own `compaction capture <tool> --from-shim` bridge is one such process, which is what
// makes "opening a new shell is the only step left" true without a second command to discover.
//
// It authorizes NOTHING on its own: `redeemPendingConsents` re-runs the same resolve verification and
// re-reads the recorded optimization mode before storing anything (see pending-authorizations.ts).
// Silent and fail-open by construction - no command's output or exit code changes because of it.
program.hook("preAction", async () => {
  await redeemPendingConsentsQuietly();
});

registerActivityCommand(program);
registerAnalyzeCommand(program);
registerAdapterCommand(program);
registerAggregateCommand(program);
registerAuditCommand(program);
registerApplyCommand(program);
registerApplyContextCommand(program);
registerApproveCommand(program);
registerApiCommand(program);
registerInitCommand(program);
registerCaptureCommand(program);
registerCompactCommand(program);
registerContextCommand(program);
registerEngineCommand(program);
registerEvalCommand(program);
registerDevCommand(program);
registerExportSessionSeedCommand(program);
registerFeedbackCommand(program);
registerGatewayCommand(program);
registerHooksCommand(program);
registerImportCommand(program);
registerInputCompactionAbCommand(program);
registerIntegrationsCommand(program);
registerLaunchTreatmentSessionCommand(program);
registerLoginCommand(program);
registerLogoutCommand(program);
registerDevicesCommand(program);
registerModeCommand(program);
registerProCommand(program);
// `upgrade` without flags == `pro`; with --key it forwards to `api connect` (deprecated spelling).
registerLegacyUpgradeAlias(program, runPro);
registerLeaseCommand(program);
registerOptimizeCommand(program);
registerOutputShapingCommand(program);
registerOutputShapingAbCommand(program);
registerPoliciesCommand(program);
registerPrecallCommand(program);
registerRecommendCommand(program);
registerReviewCommand(program);
registerRunCommand(program);
registerSpendCommand(program);
registerStatuslineCommand(program);
registerStopCommand(program);
registerStartCommand(program);
registerSavingsCommand(program);
registerSummaryCommand(program);
registerWatchCommand(program);
registerStatusCommand(program);
registerUsageCommand(program);
registerUpdateCommand(program);

// Clean default `--help` surface (v0.1.2): show ONLY the free, local-first commands
// that work without the private engine / Compaction API. Everything else (engine-gated,
// API-adjacent, and internal/operator commands) is HIDDEN from the top-level command
// list - NOT removed. Hidden commands remain fully registered and invokable by name
// (e.g. `compaction compact …`), preserving backward compatibility; engine-gated ones
// still degrade gracefully with the sanctioned message when the engine is absent.
const PUBLIC_COMMANDS = new Set([
  "init",
  "mode",
  "login",
  "logout",
  "devices",
  "engine",
  "update",
  "capture",
  "import",
  "analyze",
  "context",
  "spend",
  "summary",
  "aggregate",
  "feedback",
  "activity",
  "policies",
  "watch",
  "stop",
  "start",
  "savings",
  "upgrade",
  "status",
  "usage"
]);
for (const cmd of program.commands) {
  if (cmd.name() === "help" || PUBLIC_COMMANDS.has(cmd.name())) continue;
  // commander hides a command from help via its internal `_hidden` flag; the command
  // stays parseable/runnable. (No public setter exists for an already-created command.)
  (cmd as unknown as { _hidden: boolean })._hidden = true;
}

async function main(): Promise<void> {
  const convergence = await convergeOfficialNpmGlobalInvocation(process.argv[1], process.argv.slice(2), process.env,
    { notice: process.stderr.isTTY ? (message) => process.stderr.write(`compaction: ${message}\n`) : undefined });
  if (convergence.handled) {
    if (convergence.signal) {
      try { process.kill(process.pid, convergence.signal); }
      catch { process.exitCode = convergence.signal === "SIGINT" ? 130 : convergence.signal === "SIGTERM" ? 143 : 1; }
    } else process.exitCode = convergence.code ?? 1;
    return;
  }
  await program.parseAsync(process.argv);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
