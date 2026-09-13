/**
 * `compaction hooks install|uninstall|status|shape`, consented Claude Code Stop-hook management, native
 * Codex/Cursor output-shaping hook management, the runtime shaping command, and a content-free source-status
 * view of the records the Claude Code hook produces (PUBLIC CLI).
 *
 * Consent + safety: running install/uninstall IS the consent, it prints exactly what it will write and
 * where, MERGES (never replaces) existing settings, is idempotent, supports `--dry-run` (writes nothing),
 * backs up before writing the Codex/Cursor config, and only ever removes Compaction's own hook on uninstall.
 * `init` may suggest these commands but must never write settings silently. `status` is read-only,
 * local-first, content-free.
 *
 * The Codex/Cursor shaping hooks are AUTO-APPLY (default-ON) once installed: they run
 * `compaction hooks shape <tool>`, which shapes by default and holds planning/reasoning/extended-thinking
 * turns via the classifier (see `output-shaping-hook-activation.ts`). Set `COMPACTION_SHAPING_HOOKS=0` to
 * disable (kill-switch). Content-free and fail-open regardless.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { claudeSettingsPathForScope } from "../../core/claude-code-connect.js";
import { homedir } from "node:os";
import path from "node:path";
import chalk from "chalk";
import { Command } from "commander";
import {
  CLAUDE_CODE_HOOK_COMMAND,
  CLAUDE_CODE_BEFORE_CALL_HOOK_COMMAND,
  installStopHook,
  installBeforeCallHook,
  uninstallStopHook,
  uninstallBeforeCallHook,
  uninstallShapingHook,
  uninstallStatusLine,
  type ClaudeSettings
} from "../../core/claude-code-hooks.js";
import {
  shapingHookCommand,
  type SubscriptionHookTool
} from "../../core/subscription-shaping-hooks.js";
import {
  installSubscriptionHooks,
  subscriptionHookConfigPath,
  uninstallSubscriptionHooks
} from "../../core/subscription-hooks-install.js";
import { decideShaping } from "../../core/subscription-shaping-runtime.js";
import { isShapingTaskClassifierPresent } from "../../core/gateway/task-awareness-seam.js";
import { invalidateShapingTurnRecord, recordShapingOutcome } from "../../core/output-shaping-turn-state.js";
import type { ShapingTurnScope, ShapingTurnTool } from "../../core/output-shaping-turn-state.js";
import { codexTurnLineCommand, codexTurnLineStdout } from "../../core/codex-turn-line-hook.js";
import { beginCodexTurn, settleCodexStop } from "../../core/codex-stop-usage.js";
import { SHAPING_HOOKS_ENV } from "../../core/output-shaping-hook-activation.js";
import {
  aggregateHookUsageRecords,
  loadHookUsageRecords,
  type HookUsageAggregate
} from "../../core/hook-usage-aggregate.js";

interface HooksScopeOptions {
  settings?: string;
  local?: boolean;
  user?: boolean;
  dryRun?: boolean;
  beforeCall?: boolean;
  /** Explicit project scope (advanced): `<cwd>/.claude/settings.json`. */
  project?: boolean;
}

/**
 * Resolve the target settings file from the scope flags.
 *
 * DEFAULT IS USER/GLOBAL — Compaction is install-once, so `hooks install` and `init --connect` must
 * land in the same place and stay effective in every directory. `--project` / `--local` remain the
 * explicit, advanced project-scoped overrides.
 */
function resolveSettingsPath(options: HooksScopeOptions): string {
  if (options.settings) return options.settings;
  if (options.local) return claudeSettingsPathForScope("project-local");
  if (options.project) return claudeSettingsPathForScope("project");
  return claudeSettingsPathForScope("user"); // `--user` is now the default; the flag stays accepted.
}

async function readSettings(file: string): Promise<{ settings: ClaudeSettings; existed: boolean }> {
  try {
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw) as ClaudeSettings;
    return { settings: parsed && typeof parsed === "object" ? parsed : {}, existed: true };
  } catch {
    return { settings: {}, existed: false };
  }
}

async function writeSettings(file: string, settings: ClaudeSettings): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

/* ---------------------------- Codex / Cursor native shaping hooks ---------------------------- */

/** The tool a `hooks install --tool` targets. `claude-code` keeps the existing Stop/before-call flow. */
type HookTargetTool = "claude-code" | SubscriptionHookTool;

/**
 * Resolve the on-disk config path for a subscription (Codex/Cursor) hook. Delegates to the shared
 * resolver the installer uses, so uninstall can never target a file install would not have written.
 */
function resolveSubscriptionConfigPath(tool: SubscriptionHookTool, options: HooksScopeOptions): string {
  return subscriptionHookConfigPath(tool, {
    ...(options.settings ? { file: options.settings } : {}),
    ...(options.local ? { local: true } : {})
  });
}

async function installSubscriptionShapingHook(tool: SubscriptionHookTool, options: HooksScopeOptions): Promise<void> {
  console.log(chalk.cyan(`compaction hooks install --tool ${tool}`));
  // THE SHARED install path — the SAME one `compaction init`'s enable step uses, so the two can never
  // wire different entries into the same file (Codex needs BOTH the shaping hook and the Stop per-turn
  // line; a second implementation would eventually ship only one of them).
  const result = await installSubscriptionHooks(tool, {
    ...(options.settings ? { file: options.settings } : {}),
    ...(options.local ? { local: true } : {}),
    ...(options.dryRun ? { dryRun: true } : {})
  });
  const file = result.file;
  const existed = result.existed;

  if (result.status === "error") {
    console.error(chalk.red(`  Not installed: ${result.error ?? "unknown error"}`));
    process.exitCode = 1;
    return;
  }

  const event = tool === "codex" ? "UserPromptSubmit (per-prompt)" : "sessionStart (session-level)";
  console.log(`  target config:   ${file}${existed ? "" : " (will be created)"}`);
  console.log(`  shaping hook:    ${shapingHookCommand(tool)}  (${event})`);
  if (tool === "codex") {
    console.log(`  Stop line:       ${codexTurnLineCommand()}  (settled evidence only when recorded; otherwise no message)`);
  }
  console.log("  posture:         content-free; fail-open (never breaks the tool); merge-not-replace; AUTO-APPLY (default-on).");
  // Report what THIS build's hook actually does, for THIS tool, and promise nothing beyond it.
  //
  // Two ways to get this wrong, both found in review. (1) The hold depends on whether the task
  // classifier is REACHABLE IN THIS BUILD, and that is a per-build fact, not a per-tier one. It is NOT
  // a paid capability: `output-shaping-task-classifier.ts` is classified `public-basic-optimizer` /
  // `visibility: public`, ships in the npm
  // tarball, and is asserted NOT-excluded by `mirror-export.test.ts`. So an account does not unlock the
  // hold and never did — the hook consults no entitlement and no engine IPC, it resolves the gate by a
  // relative import. What the probe answers is "can THIS build hold a turn", which a stripped or
  // partial build can still answer no. Saying an account unlocks it would sell something that is not
  // wired on this route for any tier. (2) The gate is irrelevant to Cursor either way —
  // `decideShaping("cursor", …)` returns the session-level instruction before any classification runs,
  // so a per-turn claim is wrong there even in a build that HAS the classifier.
  // Probe the CLASSIFIER's presence, not `resolveTaskAwareGate()`: that helper also returns undefined
  // when `COMPACTION_OUTPUT_SHAPING_TASK_AWARE=0` disables the GATEWAY gate, but that switch never
  // reaches `classifyShapingTask`, so under the override the hook still holds planning turns while
  // the banner would have claimed it does not. The banner must answer the hook's own question.
  const perTurnHold = tool === "codex" && (await isShapingTaskClassifierPresent());
  const killSwitch = `Disable anytime: ${SHAPING_HOOKS_ENV}=0 (kill-switch).`;
  console.log(
    chalk.gray(
      tool === "cursor"
        ? `  Shaping applies by default, once per session. ${killSwitch}`
        : perTurnHold
          ? `  Shaping applies by default and holds planning/reasoning/thinking turns. ${killSwitch}`
          : `  Shaping applies by default, to every turn - this build has no per-turn hold on planning/reasoning turns. ${killSwitch}`
    )
  );
  if (tool === "cursor") {
    console.log(chalk.gray("  Cursor limit:    session-level only - one coarse instruction per session; no per-turn hold on planning turns."));
  }

  if (result.status === "already-present") {
    console.log(chalk.green("  Already installed - no change (idempotent)."));
    return;
  }
  if (result.status === "dry-run") {
    console.log(chalk.yellow("  --dry-run: NOT written. Resulting config would be:"));
    console.log(JSON.stringify(result.wouldWrite, null, 2));
    return;
  }
  if (result.status === "verify-failed") {
    // NEVER claim installed on an unconfirmed write: re-reading the file did not find our entries.
    console.error(chalk.red("  Write attempted but re-reading the config did not confirm the hook - NOT installed."));
    console.error(chalk.gray(`  Check permissions on ${file} and re-run.`));
    process.exitCode = 1;
    return;
  }
  console.log(chalk.green(`  Installed.${result.backupPath ? ` Backup: ${result.backupPath}` : ""}`));
  console.log(chalk.gray(`  Uninstall anytime: compaction hooks uninstall --tool ${tool}${options.settings ? ` --settings ${file}` : options.local && tool === "codex" ? " --local" : ""}`));
}

async function uninstallSubscriptionShapingHook(tool: SubscriptionHookTool, options: HooksScopeOptions): Promise<void> {
  console.log(chalk.cyan(`compaction hooks uninstall --tool ${tool}`));
  // THE SHARED uninstall path - the SAME one `compaction init --disconnect` uses, and the same
  // read-safety: a config we cannot read or parse is refused, never rewritten from a guess.
  const result = await uninstallSubscriptionHooks(tool, {
    ...(options.settings ? { file: options.settings } : {}),
    ...(options.local ? { local: true } : {}),
    ...(options.dryRun ? { dryRun: true } : {})
  });
  if (result.status === "no-config") {
    console.log(`  No config file at ${result.file} - nothing to uninstall.`);
    return;
  }
  console.log(`  target config:   ${result.file}`);
  if (result.status === "error") {
    console.error(chalk.red(`  Not uninstalled: ${result.error ?? "unknown error"}`));
    process.exitCode = 1;
    return;
  }
  if (result.status === "not-present") {
    console.log("  No Compaction shaping hook present - no change.");
    return;
  }
  if (result.status === "dry-run") {
    console.log(chalk.yellow(`  --dry-run: NOT written. Would remove ${result.removedCount} hook entr(y/ies). Resulting config:`));
    console.log(JSON.stringify(result.wouldWrite, null, 2));
    return;
  }
  console.log(chalk.green(`  Removed ${result.removedCount} Compaction shaping hook entr(y/ies).${result.backupPath ? ` Backup: ${result.backupPath}` : ""} Other config preserved.`));
}

async function readAllStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

export function registerHooksCommand(program: Command): void {
  const hooks = program
    .command("hooks")
    .description(
      "Manage the Claude Code Stop hook that records CONTENT-FREE usage via `capture claude-code --from-hook`. " +
        "Consented, merge-not-replace, idempotent, dry-run supported. Never writes settings without you running it."
    );

  hooks
    .command("install")
    .description(
      "Install a Compaction hook (merge-not-replace, idempotent). Default --tool claude-code installs the " +
        "Stop measurement hook (add --before-call for the UserPromptSubmit recommendation hook). " +
        "--tool codex|cursor installs the native output-shaping hook (AUTO-APPLY; disable with COMPACTION_SHAPING_HOOKS=0)."
    )
    .option("--tool <tool>", "Which tool to install for: claude-code (default) | codex | cursor.", "claude-code")
    .option("--settings <path>", "Explicit settings/config file to edit (overrides --local/--user).")
    .option("--local", "Target project-local config (Claude Code .claude/settings.local.json; Codex .codex/hooks.json).")
    .option("--user", "Default. Target ~/.claude/settings.json so the hook stays installed in every project.")
    .option("--project", "Advanced: target this project's .claude/settings.json instead.")
    .option("--before-call", "ALSO install the UserPromptSubmit before-call RECOMMENDATION hook (a genuine pre-call event; content-free, fail-open, silent; recommendation-only - apply is a proven blocker on Claude Code hooks).")
    .option("--dry-run", "Print the resulting settings/config without writing anything.")
    .action(async (options: HooksScopeOptions & { tool?: string }) => {
      const tool = (options.tool ?? "claude-code") as HookTargetTool;
      if (tool === "codex" || tool === "cursor") {
        await installSubscriptionShapingHook(tool, options);
        return;
      }
      if (tool !== "claude-code") {
        console.error(chalk.red(`  Unknown --tool "${options.tool}". Use claude-code | codex | cursor.`));
        process.exitCode = 1;
        return;
      }
      console.log(chalk.cyan("compaction hooks install"));
      const file = resolveSettingsPath(options);
      const { settings, existed } = await readSettings(file);
      let result;
      try {
        result = installStopHook(settings);
        // The before-call hook merges on TOP of the Stop result (both merge-not-replace, both idempotent).
        if (options.beforeCall) result = installBeforeCallHook(result.settings);
      } catch (error) {
        console.error(chalk.red(`  Not installed: ${error instanceof Error ? error.message : String(error)}`));
        process.exitCode = 1;
        return;
      }

      console.log(`  target settings: ${file}${existed ? "" : " (will be created)"}`);
      console.log(`  Stop hook:       ${CLAUDE_CODE_HOOK_COMMAND}  (measurement, content-free, post-session)`);
      if (options.beforeCall) {
        console.log(`  before-call:     ${CLAUDE_CODE_BEFORE_CALL_HOOK_COMMAND}  (UserPromptSubmit; recommendation-only, content-free, silent)`);
      }
      console.log("  posture:         content-free; fail-open (never breaks Claude Code); merge-not-replace; nothing is applied to your prompts.");

      // `result.settings` reflects the FULL merge; `changed` reflects whether the last merge changed
      // anything. Recompute "did anything change" honestly across both hooks by comparing to the read.
      const changed = JSON.stringify(result.settings) !== JSON.stringify(settings);
      if (!changed) {
        console.log(chalk.green("  Already installed - no change (idempotent)."));
        return;
      }
      if (options.dryRun) {
        console.log(chalk.yellow("  --dry-run: NOT written. Resulting settings would be:"));
        console.log(JSON.stringify(result.settings, null, 2));
        return;
      }
      await writeSettings(file, result.settings);
      console.log(chalk.green(`  Installed. Open Claude Code's /hooks once (or restart) to load it.`));
      console.log(chalk.gray("  Uninstall anytime: compaction hooks uninstall" + (options.settings ? ` --settings ${file}` : options.user ? " --user" : options.local ? " --local" : "")));
    });

  hooks
    .command("uninstall")
    .description("Remove ONLY Compaction's own hooks (preserves all other settings/hooks). Default --tool claude-code removes the Stop + before-call hooks; --tool codex|cursor removes the native shaping hook.")
    .option("--tool <tool>", "Which tool to uninstall for: claude-code (default) | codex | cursor.", "claude-code")
    .option("--settings <path>", "Explicit settings/config file to edit (overrides --local/--user).")
    .option("--local", "Target project-local config (Claude Code .claude/settings.local.json; Codex .codex/hooks.json).")
    .option("--user", "Default. Target ~/.claude/settings.json.")
    .option("--project", "Advanced: target this project's .claude/settings.json instead.")
    .option("--dry-run", "Print the resulting settings/config without writing anything.")
    .action(async (options: HooksScopeOptions & { tool?: string }) => {
      const tool = (options.tool ?? "claude-code") as HookTargetTool;
      if (tool === "codex" || tool === "cursor") {
        await uninstallSubscriptionShapingHook(tool, options);
        return;
      }
      if (tool !== "claude-code") {
        console.error(chalk.red(`  Unknown --tool "${options.tool}". Use claude-code | codex | cursor.`));
        process.exitCode = 1;
        return;
      }
      console.log(chalk.cyan("compaction hooks uninstall"));
      const file = resolveSettingsPath(options);
      const { settings, existed } = await readSettings(file);
      if (!existed) {
        console.log(`  No settings file at ${file} - nothing to uninstall.`);
        return;
      }
      // Remove ALL THREE Compaction hooks (only ours; each is scoped to its own event + command identity)
      // AND the compaction status line we added (a user's own status line is never touched).
      const stop = uninstallStopHook(settings);
      const beforeCall = uninstallBeforeCallHook(stop.settings);
      const shaping = uninstallShapingHook(beforeCall.settings);
      const statusLine = uninstallStatusLine(shaping.settings);
      const removedCount = stop.removedCount + beforeCall.removedCount + shaping.removedCount;
      const finalSettings = statusLine.settings;
      const totalRemoved = removedCount + (statusLine.removed ? 1 : 0);
      console.log(`  target settings: ${file}`);
      if (totalRemoved === 0) {
        console.log("  No Compaction hooks present - no change.");
        return;
      }
      if (options.dryRun) {
        console.log(chalk.yellow(`  --dry-run: NOT written. Would remove ${totalRemoved} Compaction entr(y/ies). Resulting settings:`));
        console.log(JSON.stringify(finalSettings, null, 2));
        return;
      }
      await writeSettings(file, finalSettings);
      const statusNote = statusLine.removed ? " + status line" : "";
      console.log(chalk.green(`  Removed ${totalRemoved} Compaction entr(y/ies) (Stop + before-call + shaping${statusNote}). Other settings preserved.`));
    });

  hooks
    .command("shape <tool>")
    .description(
      "RUNTIME hook the installed Codex/Cursor shaping hook calls - reads the tool's hook JSON on stdin and " +
        "prints a content-free output-shaping instruction to inject before generation. AUTO-APPLY (default-ON); " +
        "holds planning/reasoning/thinking turns in builds that include the task-aware gate. " +
        `Disable with ${SHAPING_HOOKS_ENV}=0. Content-free, fail-open, no network. Not for manual use.`
    )
    .action(async (tool: string) => {
      // Fail-open by contract: this runs INSIDE the tool's hook pipeline, so it must never throw and must
      // never print anything but the (optional) injection JSON. Any unexpected condition → emit nothing.
      try {
        if (tool !== "codex" && tool !== "cursor") return; // unknown tool → hold (emit nothing)
        const stdinText = await readAllStdin();
        // Codex names the exact session+turn on both lifecycle hooks. Validate before shaping, hash
        // before persistence, and open the existing run-boundary store at UserPromptSubmit. Cursor's
        // sessionStart surface remains tool-scoped.
        const codexScope = tool === "codex" ? beginCodexTurn(stdinText) : undefined;
        if (tool === "codex" && !codexScope) return;
        const scope: ShapingTurnScope = tool === "codex"
          ? codexScope!
          : { tool: tool as Exclude<ShapingTurnTool, "codex" | "claude-code"> };
        // Drop the previous turn's record before the fallible decision — same ordering, same reason, as
        // the Claude Code prompt hook (see `captureClaudeCodeShapeFromPromptHook`). `decideShaping` can
        // throw out of the classifier seam into the fail-open catch below, and a record now outlives
        // the turn that wrote it, so recording only on success would let the previous turn's `shape`
        // ride a turn this hook held. The real decision is recorded one await later.
        await invalidateShapingTurnRecord(scope);
        const decision = await decideShaping(tool as SubscriptionHookTool, stdinText);
        await recordShapingOutcome(scope, decision.outcome);
        if (decision.stdout !== "") process.stdout.write(decision.stdout);
      } catch {
        // Fail-open: swallow everything, emit nothing, leave the prompt unchanged.
      }
    });

  hooks
    .command("line <tool>")
    .description(
      "RUNTIME hook the installed Codex `Stop` hook calls - reads the turn payload on stdin and returns " +
        "settled content-free receipt evidence as `systemMessage` when recorded; otherwise returns no message. " +
        "Codex's own `[tui] status_line` selects built-in segments only and takes no external command, so " +
        "this hook is the Codex channel for settled lines. Content-free, fail-open, no network. Not for manual use."
    )
    .action(async (tool: string) => {
      // FAIL-OPEN by contract: this runs inside Codex's hook pipeline. Never throw, never print anything
      // but valid hook JSON. Any unexpected condition emits `{}` — no message, turn untouched.
      try {
        if (tool !== "codex") {
          process.stdout.write("{}\n");
          return;
        }
        const stdinText = await readAllStdin();
        const settled = await settleCodexStop(stdinText);
        process.stdout.write(codexTurnLineStdout(settled?.line));
      } catch {
        process.stdout.write("{}\n");
      }
    });

  hooks
    .command("status")
    .description(
      "Source-status view of the CONTENT-FREE usage records produced by `capture claude-code --from-hook`. " +
        "Aggregates by tool over your local records (by source/session/time). Read-only, local-first, no network. " +
        "Distinguishes provider-reported usage from unavailable; makes NO savings claim."
    )
    .option("--records-dir <dir>", "Base directory holding hook records", ".compaction/hooks")
    .option("--since <iso>", "Only include records recorded at or after this ISO timestamp (time window).")
    .option("--json", "Print the raw content-free aggregate JSON instead of the table.")
    .action(async (options: { recordsDir?: string; since?: string; json?: boolean }) => {
      const records = await loadHookUsageRecords(options.recordsDir ?? ".compaction/hooks");
      const aggregate = aggregateHookUsageRecords(records, options.since ? { since: options.since } : {});
      if (options.json) {
        console.log(JSON.stringify(aggregate, null, 2));
        return;
      }
      console.log(chalk.cyan("compaction hooks status"));
      console.log("  Local, content-free source status from Claude Code Stop-hook records. No content; no savings claim.");
      console.log(printHookUsageAggregate(aggregate));
    });
}

const dash = chalk.gray("-");
function tok(value: number | null): string {
  return value === null ? chalk.gray("unavailable") : String(value);
}

/** Render the content-free source-status aggregate as a readable block (provider-reported vs unavailable). */
export function printHookUsageAggregate(aggregate: HookUsageAggregate): string {
  const lines: string[] = [];
  lines.push(`  records: ${aggregate.dedupedRecords} (deduped from ${aggregate.totalRecords})${aggregate.since ? ` · since ${aggregate.since}` : ""}`);
  if (aggregate.tools.length === 0) {
    lines.push(chalk.gray("  No hook records yet. Install the hook and let a Claude Code turn finish:"));
    lines.push(chalk.gray("    compaction hooks install   →   (run Claude Code)   →   compaction hooks status"));
    return lines.join("\n");
  }
  for (const t of aggregate.tools) {
    // Headline never overstates: full provider-reported only when EVERY event is; mixed says "partial".
    const status =
      t.providerReportedEvents === t.events && t.events > 0
        ? chalk.green("live · provider-reported")
        : t.providerReportedEvents > 0
          ? chalk.yellow("live · provider-reported (partial)")
          : t.unavailableEvents === t.events
            ? chalk.gray("usage unavailable")
            : chalk.yellow(t.tokenSources.join(" / ") || "recorded");
    lines.push("");
    lines.push(`  ${chalk.bold(t.tool)} - ${status}`);
    lines.push(`    events:        ${t.events}   sessions: ${t.sessions}`);
    lines.push(`    input tokens:  ${tok(t.inputTokens)}`);
    lines.push(`    output tokens: ${tok(t.outputTokens)}${t.outputRecorded < t.events ? chalk.gray(`  (${t.events - t.outputRecorded} record(s) without output)`) : ""}`);
    lines.push(`    reasoning:     ${chalk.gray("unavailable (Claude Code session usage does not report it separately)")}`);
    lines.push(`    token source:  ${t.tokenSources.length ? t.tokenSources.join(" / ") : dash}`);
    lines.push(`    provider/model:${t.providers.length || t.models.length ? ` ${[t.providers.join(", "), t.models.join(", ")].filter(Boolean).join(" · ")}` : ` ${dash}`}`);
    lines.push(`    provider-reported / unavailable: ${t.providerReportedEvents} / ${t.unavailableEvents}`);
    lines.push(`    window:        ${t.firstRecordedAt ?? dash} → ${t.lastRecordedAt ?? dash}`);
  }
  return lines.join("\n");
}
