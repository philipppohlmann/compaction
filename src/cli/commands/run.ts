import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import chalk from "chalk";
import { Command } from "commander";
import { parseRunCommand, executeLocalCommand, persistLocalCommandRun } from "../../core/command-runner.js";
import { writeJsonArtifact, writeTextArtifact } from "../../core/artifact-writer.js";
import { formatCompactionMarkdownReport, withSavingsEvidence, withTraceFingerprint } from "../../core/report-generator.js";
import { localCommandRunToAgentTrace } from "../../core/run-trace-converter.js";
import { runEngineCommand } from "../engine-degrade.js";
import type { CompactionArtifactsContract } from "../../core/lazy-module-contracts.js";

/** Loaded lazily; the public package degrades honestly when it is absent. */
const COMPACTION_ARTIFACTS_MODULE = "../../core/compaction-artifacts.js";
import { CODEX_UNKNOWN_MODEL, captureCodexCommand, captureCodexExport, type CodexCaptureResult } from "../../core/codex-capture.js";
import { captureCursorCommand, captureCursorExport, type CursorCaptureResult } from "../../core/cursor-capture.js";
import { gateCursorLiveRun } from "../cursor-live-preflight.js";
import { readCursorExportFile } from "../cursor-export-read.js";
import { buildRunFlowTokenReport, formatRunFlowTokenReport, type RunFlowOutputStatus } from "../../core/run-flow-report.js";
import { buildLocalRunTokenRecord, writeLocalRunTokenRecord } from "../../core/local-run-record.js";
import { buildRunCrossSurfaceEvent, type RunRecordEventSurface } from "../../core/cross-surface-event.js";
import { buildMeasureOnlyActivityEvent } from "../../core/activity-event.js";
import { appendActivityEvent } from "../../core/activity-store.js";
import { createUsageMetadata, type UsageMetadata } from "../../core/usage-metadata.js";
import { estimateTraceTokens } from "../../core/token-estimator.js";
import type { AgentTrace } from "../../core/types.js";
import type { ToolName } from "../../core/api-client/index.js";

/**
 * The exact honest reason bare-run OUTPUT tokens are unavailable, shared VERBATIM by the printed
 * limitation note and the cross-surface event's output axis, so the reason can never diverge
 * between what the operator reads and what the record carries.
 */
const BARE_RUN_OUTPUT_UNAVAILABLE_REASON =
  "a raw command's captured stdout/stderr is not safely separable as genuine model output";

export function registerRunCommand(program: Command): void {
  const run = program
    .command("run")
    .description(
      "Unified capture→compact→report flow. Bare `run -- <cmd>` wraps any local command (local-estimate). " +
        "Per-tool front-ends: `run codex -- …` (provider-reported) and `run cursor -- …` (local-estimate/unavailable)."
    )
    .argument("[commandParts...]", "Command and arguments to execute after --")
    .allowUnknownOption(true)
    .action(async (commandParts: string[]) => {
     await runEngineCommand(async () => {
      // `run`'s value IS the compaction report it produces, which needs the proprietary engine.
      // Lazy-load it FIRST so a public install degrades immediately, before spawning the child
      // command, rather than running the command and then failing to compact.
      const { writeCompactionArtifacts } = (await import(COMPACTION_ARTIFACTS_MODULE)) as CompactionArtifactsContract;

      const command = parseRunCommand(commandParts);

      console.log(chalk.cyan("compaction run"));
      console.log("Running local command and capturing stdout/stderr locally. Child output is not printed by compaction.");

      const runResult = await executeLocalCommand(command);
      const persistedRun = await persistLocalCommandRun(runResult);
      const trace = localCommandRunToAgentTrace(runResult);
      const tracePath = await writeJsonArtifact(persistedRun.outputDirectory, "trace.json", trace);

      // Shared HONEST token report, the SAME block the per-tool front-ends print, so output is
      // consistent across every `run` path (unified-run-flow D1/D2). A bare wrapped command is an
      // UNKNOWN tool with NO provider usage, so tokens are LOCAL-ESTIMATE (chars/4), like Cursor.
      // Genuine model output is NOT safely separable from a raw command's captured stdout/stderr
      // (those are tool-role lines counted as input; the trace's single assistant message is a
      // compaction-synthesized summary, not the command's output), so output is `unavailable` with
      // a reason, never a silent zero, never provider-reported. Output is shown as TOKENS ONLY,
      // NEVER a saving; the input before/after reduction below is the real (estimate-labeled) saving.
      // Input is estimated locally (chars/4) from the trace; output is intentionally NOT carried so no
      // synthesized-summary count is ever surfaced as if it were the command's model output.
      const bareUsage: UsageMetadata = createUsageMetadata({
        inputTokens: estimateTraceTokens(trace).inputTokens,
        providerReportedTokens: false,
        estimatedTokens: true,
        model: trace.model,
        limitations: [
          "Bare `run -- <cmd>` wraps an arbitrary command with no provider usage; input is a local chars/4 estimate.",
          `Output tokens are unavailable: ${BARE_RUN_OUTPUT_UNAVAILABLE_REASON}.`
        ]
      });
      const bareTokenReport = buildRunFlowTokenReport({ tool: "command", usage: bareUsage, outputStatus: "unavailable" });
      for (const line of formatRunFlowTokenReport(bareTokenReport)) console.log(line);
      // LOCAL record step (unified-run-flow, local layer): persist the SAME honest token report as a
      // content-free local record - counts + token_source only, no content, no savings figure - so runs
      // accumulate under .compaction/run-records and `compaction summary` can roll them up per tool.
      // Local file writes only; no hosted config read, no network.
      // Cross-surface writers: the bare-run record additionally carries the ADDITIVE optional
      // `cross_surface_event` -
      // surface "cli", provider "other" (no observable provider), input LOCAL-ESTIMATE, output
      // UNAVAILABLE with the exact command-surface reason above, cost UNAVAILABLE (no billing
      // surface). Axes are copied VERBATIM from the SAME token report the record embeds. Record
      // file content only - zero stdout change.
      const bareCrossSurfaceEvent = buildRunCrossSurfaceEvent("cli", {
        runId: runResult.runId,
        tokenReport: bareTokenReport,
        reasons: { output: BARE_RUN_OUTPUT_UNAVAILABLE_REASON }
      });
      const bareRecordPaths = await writeLocalRunTokenRecord(
        buildLocalRunTokenRecord({
          runId: runResult.runId,
          tokenReport: bareTokenReport,
          crossSurfaceEvent: bareCrossSurfaceEvent
        }),
        persistedRun.outputDirectory
      );
      // ACTIVITY step (shared activity/event model): the SAME
      // cross-surface event, extended measure-only, appends ONE metrics-only activity event to
      // the local store (.compaction/activity/activity.jsonl). Measure-only honesty: nothing was
      // applied, so approval_status "not-required"; auto_apply not eligible + default
      // "ask-each-time" + applied_automatically false (this measure-only path never applies);
      // sync_status "local-only"; recovery = the trace artifact just written (what the record
      // honestly knows). Best-effort local append - never fails the run, ZERO stdout change.
      try {
        await appendActivityEvent(
          buildMeasureOnlyActivityEvent(bareCrossSurfaceEvent, { original_retained: true, location: tracePath })
        );
      } catch {
        // A local filesystem failure here must never fail the user's run (record-only step).
      }
      const artifacts = await writeCompactionArtifacts(trace, persistedRun.outputDirectory, runResult.runId);
      // Attribution/integrity + per-run evidence label (V0.2 savings-evidence): re-persist
      // report.json with the trace fingerprint (attribution/dedup) and the composed
      // `savings_evidence` record (per-run label). `run` figures are local estimates (chars/4) -
      // `local_estimate` rung 1. Additive; no existing report field/label changes.
      const evidenceReport = withSavingsEvidence(withTraceFingerprint(artifacts.report, trace), {
        costSource: "local_estimate"
      });
      await writeJsonArtifact(persistedRun.outputDirectory, "report.json", evidenceReport);
      // Re-render report.md from the ENRICHED report so the per-run savings_evidence record
      // appears in the human-readable artifact too (engine rendered it from the base report).
      await writeTextArtifact(
        persistedRun.outputDirectory,
        "report.md",
        formatCompactionMarkdownReport(evidenceReport, artifacts.policy)
      );

      console.log(`Exit code: ${runResult.exitCode ?? "none"}`);
      console.log(`Signal: ${runResult.signal ?? "none"}`);
      console.log(`Duration: ${runResult.durationMs} ms`);
      console.log(chalk.green(`Wrote ${persistedRun.stdoutPath}`));
      console.log(chalk.green(`Wrote ${persistedRun.stderrPath}`));
      console.log(chalk.green(`Wrote ${persistedRun.rawOutputPath}`));
      console.log(chalk.green(`Wrote ${persistedRun.metadataPath}`));
      console.log(chalk.green(`Wrote ${tracePath}`));
      console.log(artifacts.consoleReport);
      console.log(chalk.green(`Wrote ${artifacts.paths.reportPath}`));
      console.log(chalk.green(`Wrote ${artifacts.paths.markdownReportPath}`));
      console.log(chalk.green(`Wrote ${artifacts.paths.policyPath}`));
      console.log(chalk.green(`Wrote ${artifacts.paths.capsulePath}`));
      console.log(chalk.green(`Wrote ${artifacts.paths.compactedTracePath}`));
      console.log(chalk.green(`Wrote ${artifacts.paths.safetyReportPath}`));
      console.log(chalk.green(`Wrote ${artifacts.paths.safetyMarkdownReportPath}`));
      console.log(chalk.green(`Wrote ${artifacts.paths.prCommentReportPath}`));
      console.log(chalk.green(`Wrote ${bareRecordPaths.artifactPath}`));
      console.log(
        `  Local run record accumulated at ${bareRecordPaths.accumulatedPath} (content-free: token counts + sources only). ` +
          "Roll runs up per tool with `compaction summary`."
      );

      if (runResult.exitCode !== 0 && runResult.exitCode !== null) {
        process.exitCode = runResult.exitCode;
      }
     });
    });

  registerRunToolFrontEnds(run);
}

interface RunToolOptions {
  out?: string;
  export?: string;
}

/**
 * Register the per-tool front-ends of the unified flow (accepted design D1: unify the back half with
 * per-tool front-ends). `run codex` / `run cursor` route to the EXISTING capture code (no duplication),
 * then compact via the SAME engine artifact writer as bare `run`, then print the shared HONEST token
 * report (`token_source` explicit; input/output SEPARATE; output as tokens, NEVER a saving).
 *
 * Local-only: no record wiring is added here (that is roadmap item 5 / `/app`, separately gated). Hosted
 * recording remains on the `capture codex` / `capture cursor` commands, gated on URL+key as before.
 */
function registerRunToolFrontEnds(run: Command): void {
  run
    .command("codex")
    .description(
      "Unified flow for Codex: wrap a LIVE `codex exec --json` run (or --export a saved one), compact, and " +
        "report. Tokens are PROVIDER-REPORTED (turn.completed.usage). Local only - no upload, no proxying."
    )
    .requiredOption("--out <dir>", "Output directory for capture + compaction artifacts")
    .option("--export <file>", "Read a saved `codex exec --json` JSONL export instead of running a command")
    .argument("[commandParts...]", 'Command and args after -- (e.g. -- codex exec --json "do X")')
    .allowUnknownOption(true)
    .action(async (commandParts: string[], options: RunToolOptions) => {
      await runToolFrontEnd({
        tool: "codex",
        label: "compaction run codex",
        intro:
          "Capturing a live codex exec --json run, then compacting + reporting. No upload, no proxying. " +
          "Review artifacts before sharing (they may contain code/output).",
        options,
        commandParts,
        capture: async () => {
          const result: CodexCaptureResult = options.export
            ? captureCodexExport(await readFile(options.export, "utf8"))
            : await captureCodexCommand(commandParts);
          return {
            trace: result.trace,
            usage: result.usageMetadata,
            // Codex has no per-field "unavailable" output split; provider-reported usage is whole.
            outputStatus: "present",
            warnings: result.warnings,
            exitCode: result.commandRun?.exitCode
          };
        }
      });
    });

  run
    .command("cursor")
    .description(
      "Unified flow for Cursor: wrap a LIVE Cursor headless run (or --export saved output), compact, and " +
        "report. Tokens are LOCAL-ESTIMATE only because Compaction does not ingest Cursor's conditional result.usage; output is counted where separable " +
        "(use --output-format json), else UNAVAILABLE. Local only - no upload, no SQLite."
    )
    .requiredOption("--out <dir>", "Output directory for capture + compaction artifacts")
    .option("--export <file>", "Read saved Cursor headless output (json / stream-json) instead of running a command")
    .argument("[commandParts...]", 'Command and args after -- (e.g. -- cursor agent -p "do X" --output-format json)')
    .allowUnknownOption(true)
    .action(async (commandParts: string[], options: RunToolOptions) => {
      // LIVE path (no --export) with a command to run: run the SAFE preflight FIRST (CLI-presence +
      // capability only; never a real prompt, never login, never a CURSOR_API_KEY read). If the CLI is
      // missing/incapable, print guidance and STOP before spawning - the operator sees exact next steps,
      // not an opaque failure. (A bare `run cursor` with no command + no --export falls through to the
      // existing usage error inside runToolFrontEnd.)
      if (!options.export && commandParts.length > 0) {
        console.log(chalk.cyan("compaction run cursor"));
        console.log(
          "Preflight for a LIVE Cursor headless run. LOCAL-ESTIMATE tokens only because Compaction does not ingest Cursor's conditional result.usage."
        );
        const ready = await gateCursorLiveRun();
        if (!ready) {
          process.exitCode = 1;
          return;
        }
      }
      // Export path: read the saved output HONESTLY up front - a missing/unreadable --export file is an
      // actionable error (what failed, which path, what a valid export is), exit 1; never a raw errno,
      // never a fabricated capture, no artifacts written.
      let exportRawOutput: string | undefined;
      if (options.export) {
        const exportRead = await readCursorExportFile(options.export);
        if (!exportRead.ok) {
          console.log(chalk.cyan("compaction run cursor"));
          for (const line of exportRead.errorLines) console.error(line);
          process.exitCode = 1;
          return;
        }
        exportRawOutput = exportRead.rawOutput;
      }
      await runToolFrontEnd({
        tool: "cursor",
        label: "compaction run cursor",
        intro:
          "Capturing a live Cursor headless run, then compacting + reporting. LOCAL-ESTIMATE tokens only because " +
          "Compaction does not ingest Cursor's conditional result.usage. No upload, no SQLite. Review artifacts before sharing.",
        options,
        commandParts,
        capture: async () => {
          const result: CursorCaptureResult = exportRawOutput !== undefined
            ? captureCursorExport(exportRawOutput, commandParts.length > 0 ? commandParts : undefined)
            : await captureCursorCommand(commandParts);
          return {
            trace: result.trace,
            usage: result.usageMetadata,
            outputStatus: result.outputStatus,
            // TRUE per-axis unavailability reasons (e.g. export-only input) so the printed token lines
            // say WHY an axis is unavailable - never a bare "unavailable" with a generic guess.
            inputUnavailableReason: result.inputUnavailableReason,
            outputUnavailableReason: result.outputUnavailableReason,
            warnings: result.warnings,
            exitCode: result.commandRun?.exitCode
          };
        }
      });
    });
}

interface FrontEndCaptureResult {
  trace: AgentTrace;
  usage: UsageMetadata;
  outputStatus: RunFlowOutputStatus;
  /** TRUE per-run reason input tokens are unavailable (printed on the token line when set). */
  inputUnavailableReason?: string;
  /** TRUE per-run reason output tokens are unavailable (printed on the token line when set). */
  outputUnavailableReason?: string;
  warnings: string[];
  exitCode?: number | null;
}

interface RunToolFrontEndParams {
  tool: ToolName;
  label: string;
  intro: string;
  options: RunToolOptions;
  commandParts: string[];
  capture: () => Promise<FrontEndCaptureResult>;
}

/**
 * Shared per-tool front-end body: capture (existing code) → compact (existing engine writer) → HONEST
 * report. The engine is lazy-loaded through `runEngineCommand` so a public (engine-free) install degrades
 * with the sanctioned boundary message instead of crashing - identical posture to bare `run`.
 */
async function runToolFrontEnd(params: RunToolFrontEndParams): Promise<void> {
  await runEngineCommand(async () => {
    const { writeCompactionArtifacts } = (await import(COMPACTION_ARTIFACTS_MODULE)) as CompactionArtifactsContract;

    console.log(chalk.cyan(params.label));
    console.log(params.intro);

    if (!params.options.export && params.commandParts.length === 0) {
      console.error("error: provide a command after -- or use --export <file>.");
      process.exitCode = 1;
      return;
    }

    const captured = await params.capture();

    const outDir = params.options.out as string;
    await mkdir(outDir, { recursive: true });
    const tracePath = path.join(outDir, "captured-trace.json");
    await writeFile(tracePath, JSON.stringify(captured.trace, null, 2), "utf8");
    console.log(chalk.green(`Wrote ${tracePath}`));

    // Shared HONEST token report: token_source explicit per field; input/output SEPARATE; output as
    // tokens only (NEVER a saving). This is printed for every tool front-end.
    const tokenReport = buildRunFlowTokenReport({ tool: params.tool, usage: captured.usage, outputStatus: captured.outputStatus });
    const unavailableReasons = { input: captured.inputUnavailableReason, output: captured.outputUnavailableReason };
    for (const line of formatRunFlowTokenReport(tokenReport, { reasons: unavailableReasons })) console.log(line);
    for (const warning of captured.warnings) console.log(chalk.yellow(`  ! ${warning}`));

    const runId = `${params.tool}-${Date.now()}`;
    // LOCAL record step (unified-run-flow, local layer): persist the SAME honest token report as a
    // content-free local record (counts + per-field token_source only - no prompt/output text, no
    // savings figure). One copy stays with the run's --out artifacts; one accumulates under
    // .compaction/run-records so `compaction summary` rolls runs up per tool. Local writes only -
    // this is NOT the hosted record step (that stays on `capture <tool>`, gated on URL+key).
    // Cross-surface event writers: every
    // `run` front-end record additionally carries the ADDITIVE optional `cross_surface_event`,
    // built from the SAME token report so per-axis sources/reasons can never diverge. Axis
    // sources are copied VERBATIM (never laundered); cost_source is UNAVAILABLE with the exact
    // per-surface reason on every `run` path (no billing data exists here). Record file content
    // only - zero stdout change.
    const eventSurface: RunRecordEventSurface | undefined =
      params.tool === "codex" ? "codex" : params.tool === "cursor" ? "cursor" : undefined;
    const crossSurfaceEvent =
      eventSurface !== undefined
        ? buildRunCrossSurfaceEvent(eventSurface, {
            runId,
            tokenReport,
            reasons: unavailableReasons,
            // model_label only where the capture HONESTLY knows the model: the codex event stream
            // may report one; codex's "codex-unknown-model" placeholder maps to the contract's
            // canonical "unknown" (unknown stays unknown - a placeholder is not a model id).
            // Cursor stays "unknown" (never inferred).
            ...(params.tool === "codex" &&
            captured.usage.model !== undefined &&
            captured.usage.model !== CODEX_UNKNOWN_MODEL
              ? { modelLabel: captured.usage.model }
              : {})
          })
        : undefined;
    const recordPaths = await writeLocalRunTokenRecord(
      buildLocalRunTokenRecord({ runId, tokenReport, ...(crossSurfaceEvent !== undefined ? { crossSurfaceEvent } : {}) }),
      outDir
    );
    // ACTIVITY step (shared activity/event model): every front-end
    // that builds a cross-surface event (codex/cursor) also appends ONE metrics-only activity event
    // to the local store - measure-only, so approval_status "not-required", auto_apply not eligible
    // + default "ask-each-time" + applied_automatically false (this measure-only path never applies),
    // sync_status "local-only", recovery = the captured-trace artifact written above (what the
    // record honestly knows). Best-effort local append - never fails the run, ZERO stdout change.
    if (crossSurfaceEvent !== undefined) {
      try {
        await appendActivityEvent(
          buildMeasureOnlyActivityEvent(crossSurfaceEvent, { original_retained: true, location: tracePath })
        );
      } catch {
        // A local filesystem failure here must never fail the user's run (record-only step).
      }
    }
    console.log(chalk.green(`Wrote ${recordPaths.artifactPath}`));
    console.log(
      `  Local run record accumulated at ${recordPaths.accumulatedPath} (content-free: token counts + sources only). ` +
        "Roll runs up per tool with `compaction summary`."
    );

    // Compact via the SAME engine artifact writer as bare `run` (input reduction = the REAL saving).
    const artifacts = await writeCompactionArtifacts(captured.trace, outDir, runId);
    console.log(artifacts.consoleReport);
    console.log(
      `Input reduction above is ${tokenReport.input_reduction_label} (input before/after - a real compaction saving). ` +
        "No output-token savings is shown (gated on measured + eval-confirmed output-shaping)."
    );
    console.log(chalk.green(`Wrote ${artifacts.paths.reportPath}`));
    console.log(chalk.green(`Wrote ${artifacts.paths.markdownReportPath}`));
    console.log(chalk.green(`Wrote ${artifacts.paths.policyPath}`));
    console.log(chalk.green(`Wrote ${artifacts.paths.capsulePath}`));
    console.log(chalk.green(`Wrote ${artifacts.paths.compactedTracePath}`));
    console.log(chalk.green(`Wrote ${artifacts.paths.safetyReportPath}`));
    console.log(chalk.green(`Wrote ${artifacts.paths.safetyMarkdownReportPath}`));
    console.log(chalk.green(`Wrote ${artifacts.paths.prCommentReportPath}`));

    // Local-only: this front-end does NOT record to the hosted control-plane (roadmap item 5, gated).
    // The run record written above is LOCAL accumulation only - never an upload.
    console.log(
      `  Not recorded to the hosted control-plane from \`run\` (local-only). To record content-free usage there, ` +
        `use \`capture ${params.tool}\` with COMPACTION_API_URL + COMPACTION_API_KEY set.`
    );
    console.log(`  Next: compaction compact ${tracePath} --eval --out <dir>`);

    if (typeof captured.exitCode === "number" && captured.exitCode !== 0) process.exitCode = captured.exitCode;
  });
}
