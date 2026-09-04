import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import chalk from "chalk";
import { Command } from "commander";
import { captureOpenAIAgentsCommand, captureOpenAIAgentsExport } from "../../core/openai-agents-capture.js";
import { captureCodexCommand, captureCodexExport } from "../../core/codex-capture.js";
import { captureCursorCommand, captureCursorExport, type CursorCaptureResult } from "../../core/cursor-capture.js";
import { gateCursorLiveRun } from "../cursor-live-preflight.js";
import { readCursorExportFile } from "../cursor-export-read.js";
import { buildRunFlowTokenReport, formatRunFlowTokenReport } from "../../core/run-flow-report.js";
import { recordCaptureContentFree, captureTokenSource } from "../../core/capture-record.js";
import { attachOutputShapingToCommand } from "../../core/output-shaping-attach.js";
import { OUTPUT_SHAPING_HONESTY_NOTE } from "../../core/output-shaping.js";
import { buildCaptureUsageSidecar } from "../../core/output-shaping-ab.js";
import { resolveApiConfig, type ToolName } from "../../core/api-client/index.js";
import type { UsageMetadata } from "../../core/usage-metadata.js";
import { hostedConfigured } from "./optimize-hosted.js";
import { describeTokenMetadata } from "../../core/usage-metadata.js";
import { captureClaudeCodeCommand, captureClaudeCodeFromHook, captureClaudeCodeFromPromptHook, captureClaudeCodeShapeFromPromptHook, discoverClaudeCodeCommand } from "./capture-claude-code.js";
import { captureProviderUsageCommand } from "./capture-provider-usage.js";
import { bridgeCodexShimActivity, bridgeCursorShimActivity } from "../../core/shim-capture-bridge.js";
import { DEFAULT_CREDENTIAL_ENV_VAR } from "../../core/provider-usage/provider-usage-adapter.js";

interface OpenAIAgentsCaptureOptions {
  out: string;
  export?: string;
}

interface CodexCaptureOptions {
  out?: string;
  export?: string;
  fromShim?: string;
  outputShaping?: boolean;
  verbosityBudget?: string;
  outputShapingPolicies?: string;
}

interface CursorCaptureOptions {
  out?: string;
  export?: string;
  fromShim?: string;
  outputShaping?: boolean;
  verbosityBudget?: string;
  outputShapingPolicies?: string;
}

/**
 * Shared content-free `--from-shim` handler (the PATH-shim always-on bridge).
 * Reads the shim's temp copy of the tool's OWN stdout, appends ONE metrics-only activity event, writes
 * NO trace artifact and NO content. Best-effort + fail-open: a bad/missing file is a non-fatal skip so
 * the transparent shim can never break the wrapped command. `commandParts` (Cursor only) carries the
 * ORIGINAL invocation so input can be locally estimated (counted, never stored).
 */
async function handleCaptureFromShim(
  tool: "codex" | "cursor",
  fromShimPath: string,
  commandParts: string[]
): Promise<void> {
  let rawOutput: string;
  try {
    rawOutput = await readFile(fromShimPath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`compaction shim: skipped (non-fatal: could not read the captured output - ${message}).`);
    return;
  }
  try {
    if (tool === "codex") {
      const { result, tokenMetadataStatus } = await bridgeCodexShimActivity({ rawOutput, cwd: process.cwd() });
      const label = tokenMetadataStatus === "present" ? "provider-reported" : "usage unavailable (not invented)";
      console.log(
        result.appended
          ? `compaction shim: recorded metrics-only activity (surface=codex, ${label}, id ${result.activity_event_id.slice(0, 12)}…) - see 'compaction activity'.`
          : `compaction shim: activity not appended (${result.reason}).`
      );
    } else {
      const { result, outputStatus } = await bridgeCursorShimActivity({
        rawOutput,
        commandParts: commandParts.length > 0 ? commandParts : undefined,
        cwd: process.cwd()
      });
      const label = `local-estimate; output ${outputStatus === "present" ? "local-estimate" : "unavailable"}`;
      console.log(
        result.appended
          ? `compaction shim: recorded metrics-only activity (surface=cursor, ${label}, id ${result.activity_event_id.slice(0, 12)}…) - see 'compaction activity'.`
          : `compaction shim: activity not appended (${result.reason}).`
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`compaction shim: skipped (non-fatal: ${message}).`);
  }
}

/**
 * Apply the opt-in output-shaping flag to a wrapped command BEFORE generation (increment 3). Returns the
 * (possibly modified) commandParts + console lines. Surfaces NO output-savings number - a savings figure
 * requires the private measured-A/B + short-but-sufficient eval gate. Original command is never mutated.
 */
function applyOutputShapingFlag(
  commandParts: string[],
  options: { outputShaping?: boolean; verbosityBudget?: string; outputShapingPolicies?: string }
): { commandParts: string[]; lines: string[]; policyNames: string[]; policyVersion?: string } {
  if (!options.outputShaping) return { commandParts, lines: [], policyNames: [] };
  const budget = options.verbosityBudget !== undefined ? Number.parseInt(options.verbosityBudget, 10) : undefined;
  const policies = options.outputShapingPolicies
    ? options.outputShapingPolicies.split(",").map((s) => s.trim()).filter(Boolean)
    : undefined;
  const att = attachOutputShapingToCommand(commandParts, {
    ...(budget !== undefined && Number.isFinite(budget) ? { verbosityBudgetTokens: budget } : {}),
    ...(policies ? { policies } : {})
  });
  const lines = att.attached
    ? [
        chalk.green(`  Attached output-shaping policy to the prompt BEFORE generation: ${att.applied.map((a) => a.policy_name).join(", ")}`),
        chalk.gray(`  ${OUTPUT_SHAPING_HONESTY_NOTE}`)
      ]
    : [chalk.yellow(`  Output-shaping NOT attached: ${att.reason}.`)];
  return {
    commandParts: att.commandParts,
    lines,
    policyNames: att.applied.map((a) => a.policy_name),
    ...(att.policyVersion !== undefined ? { policyVersion: att.policyVersion } : {})
  };
}

/**
 * Write a content-free `capture-usage.json` sidecar next to the capture artifact (operator-side evidence).
 * It carries provider-reported token counts + honest source + (treatment) output-shaping policy names so a
 * later `compaction output-shaping-ab add` can link this run into an A/B arm. NO content is written.
 */
async function writeCaptureUsageSidecar(
  outDir: string,
  tool: ToolName,
  usage: UsageMetadata,
  policyNames: string[],
  policyVersion?: string
): Promise<string> {
  const sidecar = buildCaptureUsageSidecar({
    tool,
    ...(usage.provider ? { provider: usage.provider } : {}),
    ...(usage.model ? { model: usage.model } : {}),
    ...(typeof usage.input_tokens === "number" ? { inputTokens: usage.input_tokens } : {}),
    ...(typeof usage.output_tokens === "number" ? { outputTokens: usage.output_tokens } : {}),
    providerReported: usage.provider_reported_tokens === true,
    tokenSource: captureTokenSource(usage),
    tokenMetadataStatus: usage.provider_reported_tokens === true ? "present" : "missing",
    ...(policyNames.length > 0 && policyVersion ? { policyNames, policyVersion } : {})
  });
  const sidecarPath = path.join(outDir, "capture-usage.json");
  await writeFile(sidecarPath, JSON.stringify(sidecar, null, 2), "utf8");
  return sidecarPath;
}

interface ClaudeCodeCaptureOptions {
  session?: string;
  out?: string;
  maxToolResultChars?: string;
  includeSubagents?: boolean;
  discover?: boolean;
  projectsDir?: string;
  fromHook?: boolean;
  fromPromptHook?: boolean;
  shapePromptHook?: boolean;
  dryRun?: boolean;
}

interface ProviderUsageCaptureOptions {
  endpoint: string;
  credentialEnvVar?: string;
  windowStart?: string;
  windowEnd?: string;
  label?: string;
  out?: string;
}

export function registerCaptureCommand(program: Command): void {
  const capture = program.command("capture").description("Capture local integration traces into compaction.dev AgentTrace format.");

  capture
    .command("openai-agents")
    .description("Capture OpenAI Agents SDK-style local trace events from a command wrapper or local export.")
    .requiredOption("--out <dir>", "Output root directory for capture artifacts")
    .option("--export <file>", "Read a local OpenAI Agents SDK-style JSONL trace/span export instead of running a command")
    .argument("[commandParts...]", "Command and arguments to execute after --")
    .allowUnknownOption(true)
    .action(async (commandParts: string[], options: OpenAIAgentsCaptureOptions) => {
      console.log(chalk.cyan("compaction capture openai-agents"));
      console.log("Capturing local OpenAI Agents SDK-style events. No ChatGPT scraping, provider proxying, or upload is performed.");

      const artifacts = options.export
        ? await captureOpenAIAgentsExport(options.export, options.out)
        : await captureOpenAIAgentsCommand(commandParts, options.out);

      console.log(artifacts.terminalSummary);
      console.log(chalk.green(`Wrote ${artifacts.paths.capturedTracePath}`));
      console.log(chalk.green(`Wrote ${artifacts.paths.captureReportJsonPath}`));
      console.log(chalk.green(`Wrote ${artifacts.paths.captureReportMarkdownPath}`));

      if (artifacts.report.status === "fail") {
        process.exitCode = 1;
      }
    });

  capture
    .command("codex")
    .description(
      "Capture a LIVE `codex exec --json` run (or a saved export) into AgentTrace - no manual import. " +
        "Provider-reported tokens from turn.completed.usage; local only, no upload, no proxying."
    )
    .option("--out <dir>", "Output directory for capture artifacts")
    .option("--export <file>", "Read a saved `codex exec --json` JSONL export instead of running a command")
    .option("--from-shim <file>", "INTERNAL (used by the connect-once PATH shim): read a captured `codex exec --json` output copy and append ONE metrics-only, CONTENT-FREE activity event (no trace artifact, no content). Fail-open.")
    .option("--output-shaping", "Attach the output-shaping policy to the prompt BEFORE generation (opt-in; no savings claimed)")
    .option("--verbosity-budget <tokens>", "Soft output-token budget for the output-shaping policy")
    .option("--output-shaping-policies <names>", "Comma-separated output-shaping policy names (default: the default-on set)")
    .argument("[commandParts...]", 'Command and args to execute after -- (e.g. -- codex exec --json "do X")')
    .allowUnknownOption(true)
    .action(async (commandPartsRaw: string[], options: CodexCaptureOptions) => {
      // Always-on shim bridge: content-free, writes only a metrics-only activity event. Handled first,
      // before any artifact-writing path, and before the "provide a command" guard.
      if (options.fromShim) {
        await handleCaptureFromShim("codex", options.fromShim, commandPartsRaw);
        return;
      }

      console.log(chalk.cyan("compaction capture codex"));
      console.log("Capturing a local codex exec --json run. No upload, no proxying. Review the artifact before sharing (it may contain code/output).");

      if (!options.out) {
        console.error("error: --out <dir> is required (except with --from-shim).");
        process.exitCode = 1;
        return;
      }
      if (!options.export && commandPartsRaw.length === 0) {
        console.error('error: provide a command after -- (e.g. -- codex exec --json "do X") or use --export <file>.');
        process.exitCode = 1;
        return;
      }

      const outDir = options.out;

      // Opt-in: attach the output-shaping policy to the prompt BEFORE generation (no savings claimed).
      const shaped = applyOutputShapingFlag(commandPartsRaw, options);
      for (const line of shaped.lines) console.log(line);

      const result = options.export
        ? captureCodexExport(await readFile(options.export, "utf8"))
        : await captureCodexCommand(shaped.commandParts);

      await mkdir(outDir, { recursive: true });
      const tracePath = path.join(outDir, "captured-trace.json");
      await writeFile(tracePath, JSON.stringify(result.trace, null, 2), "utf8");

      // Honest token labels: provider-reported (from turn.completed.usage) or honest missing - never invented.
      for (const line of describeTokenMetadata(result.usageMetadata)) console.log(`  ${line}`);
      for (const warning of result.warnings) console.log(chalk.yellow(`  ! ${warning}`));
      console.log(chalk.green(`Wrote ${tracePath}`));

      // Content-free A/B evidence sidecar (provider-reported counts + policy names) for output-shaping-ab.
      const usagePath = await writeCaptureUsageSidecar(outDir, "codex", result.usageMetadata, shaped.policyNames, shaped.policyVersion);
      console.log(chalk.green(`Wrote ${usagePath}`));

      // Unified flow: content-free record (input/output separate + honest source) when hosted-configured.
      // No default network call - only when the user has set COMPACTION_API_URL + COMPACTION_API_KEY.
      if (hostedConfigured()) {
        const rec = await recordCaptureContentFree(resolveApiConfig(), { usage: result.usageMetadata, tool: "codex", reference: tracePath });
        console.log(rec.recorded ? chalk.green(`  Recorded content-free usage (tool=codex, source=${rec.source}).`) : chalk.yellow(`  Not recorded: ${rec.reason}.`));
      } else {
        console.log("  Not recorded (set COMPACTION_API_URL + COMPACTION_API_KEY to record content-free usage).");
      }
      console.log(`  Next: compaction compact ${tracePath} --eval --out <dir>`);

      const exitCode = result.commandRun?.exitCode;
      if (typeof exitCode === "number" && exitCode !== 0) process.exitCode = exitCode;
    });

  capture
    .command("cursor")
    .description(
      "Capture a LIVE Cursor headless CLI run (or saved output) into AgentTrace - no manual import. " +
        "LOCAL-ESTIMATE tokens only because Compaction does not ingest Cursor's conditional result.usage; output counted from the result field where " +
        "separable (use --output-format json), else marked unavailable. Local only, no upload, no SQLite."
    )
    .option("--out <dir>", "Output directory for capture artifacts")
    .option("--export <file>", "Read saved Cursor headless output (json / stream-json) instead of running a command")
    .option("--from-shim <file>", "INTERNAL (used by the connect-once PATH shim): read a captured Cursor headless output copy and append ONE metrics-only, CONTENT-FREE activity event (local-estimate only, no trace artifact, no content). Fail-open.")
    .option("--output-shaping", "Attach the output-shaping policy to the prompt BEFORE generation (opt-in; Cursor output is local-estimate, no savings)")
    .option("--verbosity-budget <tokens>", "Soft output-token budget for the output-shaping policy")
    .option("--output-shaping-policies <names>", "Comma-separated output-shaping policy names (default: the default-on set)")
    .argument("[commandParts...]", 'Command and args after -- (e.g. -- cursor agent -p "do X" --output-format json)')
    .allowUnknownOption(true)
    .action(async (commandPartsRaw: string[], options: CursorCaptureOptions) => {
      // Always-on shim bridge: content-free, writes only a metrics-only activity event (local-estimate).
      // Handled first; the ORIGINAL invocation after -- lets input be locally estimated (counted, not stored).
      if (options.fromShim) {
        await handleCaptureFromShim("cursor", options.fromShim, commandPartsRaw);
        return;
      }

      console.log(chalk.cyan("compaction capture cursor"));
      console.log("Capturing a local Cursor headless run. LOCAL-ESTIMATE tokens only because Compaction does not ingest Cursor's conditional result.usage. No upload, no SQLite. Review the artifact before sharing.");

      if (!options.out) {
        console.error("error: --out <dir> is required (except with --from-shim).");
        process.exitCode = 1;
        return;
      }
      if (!options.export && commandPartsRaw.length === 0) {
        console.error('error: provide a command after -- (e.g. -- cursor agent -p "do X" --output-format json) or use --export <file>.');
        process.exitCode = 1;
        return;
      }

      // LIVE path (no --export): run the SAFE preflight FIRST (CLI-presence + capability only; never a
      // real prompt, never `cursor agent login`, never a CURSOR_API_KEY read). If the CLI is missing or
      // not capable, print exact guidance and STOP before spawning - no opaque failure, no crash.
      if (!options.export) {
        const ready = await gateCursorLiveRun();
        if (!ready) {
          process.exitCode = 1;
          return;
        }
      }

      // Opt-in: attach the output-shaping policy to the prompt BEFORE generation. Cursor output stays
      // local-estimate (no provider usage) → shaping never yields a savings number for Cursor.
      const shaped = applyOutputShapingFlag(commandPartsRaw, options);
      for (const line of shaped.lines) console.log(line);

      // Export path: read the saved output HONESTLY (a missing/unreadable file is an actionable error,
      // never a raw errno, never a fabricated capture). Pass the RAW declared command (if the operator
      // provided one after --) so the LOCAL-ESTIMATE input count matches `run cursor --export` exactly;
      // shaped parts are NOT used here - nothing was executed, so no shaping was actually attached.
      let result: CursorCaptureResult;
      if (options.export) {
        const exportRead = await readCursorExportFile(options.export);
        if (!exportRead.ok) {
          for (const line of exportRead.errorLines) console.error(line);
          process.exitCode = 1;
          return;
        }
        result = captureCursorExport(exportRead.rawOutput, commandPartsRaw.length > 0 ? commandPartsRaw : undefined);
      } else {
        result = await captureCursorCommand(shaped.commandParts);
      }

      const outDir = options.out;
      await mkdir(outDir, { recursive: true });
      const tracePath = path.join(outDir, "captured-trace.json");
      await writeFile(tracePath, JSON.stringify(result.trace, null, 2), "utf8");

      // Print the SAME honest per-field token block `run cursor` prints (input/output SEPARATE, source
      // explicit, an unavailable axis carries its TRUE per-run reason) - never a bare
      // "input tokens: unknown" with no reason, never a fabricated count, never provider-reported.
      const cursorTokenReport = buildRunFlowTokenReport({
        tool: "cursor",
        usage: result.usageMetadata,
        outputStatus: result.outputStatus
      });
      const cursorReasons = { input: result.inputUnavailableReason, output: result.outputUnavailableReason };
      // `capture` does not compact - no input-reduction figures follow, so that line is omitted.
      const cursorTokenLines = formatRunFlowTokenReport(cursorTokenReport, {
        reasons: cursorReasons,
        inputReductionFollows: false
      });
      for (const line of cursorTokenLines) console.log(`  ${line}`);
      for (const warning of result.warnings) console.log(chalk.yellow(`  ! ${warning}`));
      console.log(chalk.green(`Wrote ${tracePath}`));

      // Content-free sidecar. Cursor is local-estimate (providerReported=false) → A/B treats it as
      // unavailable for a provider-reported savings number; it can never produce a confirmed claim.
      const usagePath = await writeCaptureUsageSidecar(outDir, "cursor", result.usageMetadata, shaped.policyNames, shaped.policyVersion);
      console.log(chalk.green(`Wrote ${usagePath}`));

      if (hostedConfigured()) {
        const rec = await recordCaptureContentFree(resolveApiConfig(), { usage: result.usageMetadata, tool: "cursor", reference: tracePath });
        console.log(rec.recorded ? chalk.green(`  Recorded content-free usage (tool=cursor, source=${rec.source}).`) : chalk.yellow(`  Not recorded: ${rec.reason}.`));
      } else {
        console.log("  Not recorded (set COMPACTION_API_URL + COMPACTION_API_KEY to record content-free usage).");
      }
      console.log(`  Next: compaction compact ${tracePath} --eval --out <dir>`);

      const exitCode = result.commandRun?.exitCode;
      if (typeof exitCode === "number" && exitCode !== 0) process.exitCode = exitCode;
    });

  capture
    .command("claude-code")
    .description("Capture a Claude Code session JSONL file into compaction.dev AgentTrace format (source: real_captured). Local only - no network calls, no upload.")
    .option("--session <path>", "Path to the Claude Code session JSONL file (e.g. ~/.claude/projects/<slug>/<session-id>.jsonl)")
    .option("--discover", "List discoverable local Claude Code sessions (metadata only) and print the ready-to-run --session command for each. Local, read-only.")
    .option("--projects-dir <path>", "Override the Claude Code projects root to scan with --discover (default: ~/.claude/projects). Read-only.")
    .option("--out <dir>", "Output directory for captured artifacts (default: .compaction/runs/<session-id-prefix>/)")
    .option("--max-tool-result-chars <N>", "Maximum characters to extract from each tool result before truncation (default: 32000)")
    .option("--include-subagents", "Include subagent JSONL files from <session-id>/subagents/ directory, merging their messages and usage into the captured trace")
    .option("--from-hook", "Read a Claude Code Stop payload from stdin and record CONTENT-FREE usage via its transcript_path (used by `compaction hooks install`). Fail-open, idempotent.")
    .option("--from-prompt-hook", "Read a Claude Code UserPromptSubmit payload from stdin and record a CONTENT-FREE before-call RECOMMENDATION (used by the UserPromptSubmit hook). Recommendation-only (no mutation on this surface); the prompt runs unchanged. Fail-open, silent (no stdout).")
    .option("--shape-prompt-hook", "Read a Claude Code UserPromptSubmit payload from stdin and, on a shapeable turn, inject a CONTENT-FREE output-shaping instruction via hookSpecificOutput.additionalContext (the SUBSCRIPTION output-shaping surface, installed by connecting Claude Code). Holds planning/reasoning/thinking turns where the task-aware gate is part of the build; disabled by COMPACTION_SHAPING_HOOKS=0 or `compaction stop`. Content-free, fail-open. Not for manual use.")
    .option("--dry-run", "With --from-hook: print what would be recorded without writing anything.")
    .action(async (options: ClaudeCodeCaptureOptions) => {
      if (options.shapePromptHook) {
        await captureClaudeCodeShapeFromPromptHook();
        return;
      }
      if (options.fromPromptHook) {
        await captureClaudeCodeFromPromptHook();
        return;
      }
      if (options.fromHook) {
        await captureClaudeCodeFromHook({ dryRun: options.dryRun });
        return;
      }
      if (options.discover) {
        await discoverClaudeCodeCommand({ projectsDir: options.projectsDir });
        return;
      }
      if (!options.session) {
        console.error("error: either --session <path> or --discover is required.");
        console.error("Run 'compaction capture claude-code --discover' to list local sessions.");
        process.exitCode = 1;
        return;
      }
      await captureClaudeCodeCommand({
        session: options.session,
        out: options.out,
        maxToolResultChars: options.maxToolResultChars,
        includeSubagents: options.includeSubagents
      });
    });

  capture
    .command("provider-usage")
    .description(
      "Read-only, aggregate-only provider usage/cost capture (Option A). Reads aggregate token/cost only - NO prompt/completion content. The credential is read from an environment variable (never a flag value), used only for the single read-only request, and never logged or written to any artifact. Local only - the only egress is the configured provider endpoint."
    )
    .requiredOption("--endpoint <url>", "Provider usage/cost reporting endpoint to read (non-secret).")
    .option(
      "--credential-env-var <name>",
      `Name of the environment variable to read the read-only credential from (default: ${DEFAULT_CREDENTIAL_ENV_VAR}). This NAMES the env var only - it never carries the secret value.`,
      DEFAULT_CREDENTIAL_ENV_VAR
    )
    .option("--window-start <iso>", "Reporting window start (ISO 8601).")
    .option("--window-end <iso>", "Reporting window end (ISO 8601).")
    .option("--label <label>", "Human-readable label for the captured run/window.")
    .option("--out <dir>", "Output directory for captured artifacts (default: .compaction/runs/provider-usage/).")
    .action(async (options: ProviderUsageCaptureOptions) => {
      await captureProviderUsageCommand({
        endpoint: options.endpoint,
        credentialEnvVar: options.credentialEnvVar,
        windowStart: options.windowStart,
        windowEnd: options.windowEnd,
        label: options.label,
        out: options.out
      });
    });
}
