import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { writeJsonArtifact, writeTextArtifact } from "../../core/artifact-writer.js";
import { ClaudeCodeAdapter, PRIVACY_WARNING } from "../../core/adapters/claude-code-adapter.js";
import { discoverClaudeCodeSessions, DISCOVERY_PRIVACY_NOTE } from "../../core/adapters/claude-code-discovery.js";
import { recordCaptureContentFree, writeCaptureUsageSidecar } from "../../core/capture-record.js";
import { buildRunFlowTokenReport, formatRunFlowTokenReport } from "../../core/run-flow-report.js";
import { buildRunCrossSurfaceEvent } from "../../core/cross-surface-event.js";
import { buildMeasureOnlyActivityEvent, computeActivityEventId, type ActivityEvent } from "../../core/activity-event.js";
import {
  appendActivityEvent,
  readActivityEvents,
  validateActivityEventForStore,
  DEFAULT_ACTIVITY_DIRECTORY
} from "../../core/activity-store.js";
import {
  claudeLogicalRunIdentity,
  claudeLogicalSessionId,
  validClaudeLogicalRunId,
  type ClaudeLogicalRunIdentity
} from "../../core/claude-logical-run-id.js";
import {
  buildClaudeStopActivityEvent,
  buildClaudeTranscriptStopActivityEvent,
  claudeStopOutputCalibrationQuery,
  claudeTranscriptOutputCalibrationQuery,
  type ClaudeTranscriptUsageBaseline
} from "../../core/claude-stop-activity.js";
import {
  exactPriorClaudeHookRecord,
  loadHookUsageRecords
} from "../../core/hook-usage-aggregate.js";
import { settledStopLineFromActivityEvent } from "../../core/settled-stop-activity.js";
import { communityInviteLine } from "../../core/community-graduation.js";
import { readStoredCredentials } from "../../core/auth/credentials.js";
import { detectAvoidableContext } from "../../core/before-call.js";
import { parseUserPromptSubmitPayload, buildClaudeCodeBeforeCallEvent } from "../../core/claude-code-before-call.js";
import { decideShaping } from "../../core/subscription-shaping-runtime.js";
import { invalidateShapingTurnRecord, lastTurnShapingOutcome, recordShapingOutcome } from "../../core/output-shaping-turn-state.js";
import type { ShapingTurnScope } from "../../core/output-shaping-turn-state.js";
import { isShapingHooksActivated } from "../../core/output-shaping-hook-activation.js";
import {
  activateSharedOutputCalibration,
  estimatePerTurnOutputSaved,
  loadCalibrationReduction,
  loadOutputCalibrationResolver
} from "../../core/output-shaping-savings.js";
import { outputCalibrationQuery, type OutputShapingCalibrationQuery } from "../../core/output-shaping-calibration-store.js";
import { buildOutputShapingPolicy } from "../../core/output-shaping.js";
import { resolveOpenTier } from "../../core/onboarding-preferences.js";
import {
  readGatewayReceiptTailWindow,
  readLatestGatewayReceipt,
  type GatewayReceipt,
  type GatewayReceiptTailWindow
} from "../../core/gateway/receipt.js";
import {
  isReceiptLineEnabled,
  communityFullApplyReceiptLine,
  receiptLineFromGatewayReceipt,
  receiptLineOutputOnly,
  openLineForTurn,
  receiptCeiling,
  type OpenLineRendering
} from "../../core/gateway/receipt-line.js";
import { resolveApiConfig } from "../../core/api-client/index.js";
import { claudePromptCorrelationId, sessionCorrelationId } from "../../core/gateway/session-correlation.js";
import {
  claudeProvisionalPending,
  commitClaudePositiveSettlement,
  completedUserRuns,
  completeClaudePositiveSettlement,
  endClaudeUserRun,
  projectClaudePositiveSettlement,
  startClaudeUserRun
} from "../../core/gateway/run-boundary.js";
import type { ClaudeSettledProvisionalPending } from "../../core/gateway/run-boundary.js";
import { hasClaudeTaskNotificationEvidence } from "../../core/claude-code-run-continuation.js";
import { hostedConfigured } from "./optimize-hosted.js";
import type { UsageMetadata } from "../../core/usage-metadata.js";
import {
  CLAUDE_CODE_HOOK_RECORD_SCHEMA,
  buildClaudeCodeHookRecord,
  computeDedupKey,
  emptyLedger,
  isAlreadyRecorded,
  parseStopPayload,
  resolveTranscriptPath,
  type ClaudeCodeHookLedger,
  type ClaudeCodeHookRecord
} from "../../core/claude-code-hook-record.js";

/**
 * Does this Stop payload come from something OTHER than Claude Code?
 *
 * Exported so the guard is testable on its own: it is the single thing standing between a Cursor turn
 * and a `surface=claude_code`, `source=provider-reported` record. See the call site for why that
 * collision happens at all (shared `.claude/settings.json`).
 *
 * Deliberately conservative — it answers `true` only on POSITIVE evidence of another tool, so it can
 * never start rejecting genuine Claude Code traffic if that payload gains or loses fields.
 */
export function isForeignStopPayload(payload: unknown): boolean {
  if (payload === null || typeof payload !== "object") return false;
  const record = payload as Record<string, unknown>;
  // Cursor stamps its own version onto every hook payload; Claude Code has no such field.
  if (typeof record.cursor_version === "string" && record.cursor_version !== "") return true;
  // Cursor's event is lowercase `stop`; Claude Code's is `Stop`. An ABSENT field is not evidence.
  const event = record.hook_event_name;
  if (typeof event === "string" && event !== "" && event !== "Stop") return true;
  return false;
}

interface DiscoverClaudeCodeOptions {
  projectsDir?: string;
}

interface CaptureClaudeCodeOptions {
  session: string;
  out?: string;
  maxToolResultChars?: string;
  includeSubagents?: boolean;
}

function buildOutputDir(sessionPath: string, out?: string): string {
  if (out) return out;
  // Default: .compaction/runs/<session-id-prefix>/
  const sessionFileName = sessionPath.split("/").pop() ?? "session";
  const sessionIdPrefix = sessionFileName.replace(/\.jsonl$/, "").slice(0, 8);
  return `.compaction/runs/${sessionIdPrefix}`;
}

function buildMarkdownReport(sessionPath: string, outDir: string, provenance: import("../../core/capture-adapter.js").CaptureProvenance, usage: import("../../core/usage-metadata.js").UsageMetadata): string {
  const lines: string[] = [
    "# Capture Report",
    "",
    `**Session:** ${sessionPath}`,
    `**Captured at:** ${provenance.capturedAt}`,
    `**Adapter:** ${provenance.captureAdapter}`,
    `**Session ID:** ${provenance.sessionId ?? "unknown"}`,
    "",
    "## Usage",
    "",
    `- Input tokens: ${usage.input_tokens ?? "unknown"}`,
    `- Output tokens: ${usage.output_tokens ?? "unknown"}`,
    `- Cache read tokens: ${usage.cache_read_input_tokens ?? 0}`,
    `- Cache creation tokens: ${usage.cache_creation_input_tokens ?? 0}`,
    `- Total tokens: ${usage.total_tokens ?? "unknown"}`,
    `- Token-count source: ${usage.provider_reported_tokens ? "provider-reported (Claude Code session usage fields) - NOT billing-confirmed" : usage.estimated_tokens ? "locally estimated (chars/4) - NOT provider-reported" : "missing / unknown"}`,
    `- Provider reported: ${usage.provider_reported_tokens}`,
    `- Cost source: ${usage.cost_source}`,
    `- Cost confidence: ${usage.cost_confidence}`,
    "",
    "## Distinctness",
    "",
    ...(provenance.traceFingerprint
      ? [
          `- Trace fingerprint (${provenance.traceFingerprint.algorithm}): ${provenance.traceFingerprint.content_sha256}`,
          `- Messages hashed: ${provenance.traceFingerprint.message_count}`,
          "- This is a one-way SHA-256 DIGEST over the canonical normalized trace content - NOT raw",
          "  messages/prompts/tool-output. It is a per-run distinctness proof: re-capturing the same",
          "  session yields the same fingerprint, so re-captures are NOT counted as new sessions.",
          "  Matching aggregate metrics alone do NOT prove two sessions are the same - only a matching",
          "  fingerprint does."
        ]
      : [
          "- Trace fingerprint: not available - distinctness is `not_verified` for this run.",
          "  Without a fingerprint this run must NOT be counted as a distinct session."
        ]),
    "",
    "## Warnings",
    "",
    ...provenance.warnings.map((w) => `- ${w}`),
    "",
    "## Limitations",
    "",
    ...provenance.limitations.map((l) => `- ${l}`),
    "",
    "## Artifacts",
    "",
    `- \`${outDir}/captured-trace.json\` - AgentTrace (source: real_captured)`,
    `- \`${outDir}/capture-report.json\` - CapturedRun metadata`,
    `- \`${outDir}/capture-report.md\` - this file`,
    ""
  ];
  return lines.join("\n");
}

export async function captureClaudeCodeCommand(options: CaptureClaudeCodeOptions): Promise<void> {
  const maxToolResultChars = options.maxToolResultChars !== undefined
    ? parseInt(options.maxToolResultChars, 10)
    : 32_000;

  const includeSubagents = options.includeSubagents === true;

  // 1. Print privacy warning
  console.log(PRIVACY_WARNING);
  console.log();

  const adapter = new ClaudeCodeAdapter();

  // 2. Print reading session
  console.log(`Reading session: ${options.session}`);

  const capturedRun = await adapter.normalize({
    sourcePath: options.session,
    options: { maxToolResultChars, includeSubagents }
  });

  const { trace, usage, provenance } = capturedRun;

  // 3. Print entry counts (from limitations field)
  const assistantLine = provenance.limitations.find((l) => l.startsWith("Assistant entries:"));
  const userLine = provenance.limitations.find((l) => l.startsWith("User entries:"));
  const otherLine = provenance.limitations.find((l) => l.startsWith("Other/excluded entries:"));
  const assistantCount = assistantLine ? assistantLine.replace("Assistant entries: ", "") : "?";
  const userCount = userLine ? userLine.replace("User entries: ", "") : "?";
  const otherCount = otherLine ? otherLine.replace("Other/excluded entries: ", "") : "?";
  console.log(`Entries: ${assistantCount} assistant, ${userCount} user, ${otherCount} other`);

  // 4. Print thinking blocks excluded
  const thinkingLine = provenance.limitations.find((l) => l.startsWith("Thinking blocks excluded:"));
  const thinkingCount = thinkingLine ? thinkingLine.replace("Thinking blocks excluded: ", "") : "0";
  console.log(`Thinking blocks excluded: ${thinkingCount}`);

  // 4b. Print subagents included (when --include-subagents was passed)
  if (includeSubagents && provenance.subagents !== undefined) {
    console.log(`Subagents included: ${provenance.subagents.length}`);
  }

  // 5. Print messages extracted
  console.log(`Messages extracted: ${trace.messages.length}`);

  // 6. Print token totals (cache counts from structured usage fields)
  console.log(
    `Token totals: input=${usage.input_tokens ?? 0}, output=${usage.output_tokens ?? 0}, cache_creation=${usage.cache_creation_input_tokens ?? 0}, cache_read=${usage.cache_read_input_tokens ?? 0}`
  );

  // 6b. Label the token-count source honestly: provider-reported vs locally estimated.
  // Claude Code session files embed provider usage, so these are typically provider-reported;
  // never present an estimate as provider-reported.
  const tokenSourceLabel = usage.provider_reported_tokens
    ? "provider-reported (from the Claude Code session usage fields) - NOT billing-confirmed"
    : usage.estimated_tokens
      ? "locally estimated (chars/4) - NOT provider-reported, NOT billing-confirmed"
      : "missing / unknown (not invented)";
  console.log(`Token-count source: ${tokenSourceLabel}`);

  // 6b-ii. Set expectations honestly for the downstream commands. The totals above are
  // SESSION-LEVEL provider-reported figures (from the session's own API usage metadata). The
  // per-message / policy before-after figures that `spend` and `compact` compute are deterministic
  // LOCAL ESTIMATES (chars/4) - a different measurement - and are labeled as such there. This is the
  // repo's standing discipline (session totals provider-reported; per-message figures chars/4
  // estimates), not a defect: the two are not conflated, and neither is billing-confirmed.
  if (usage.provider_reported_tokens) {
    console.log(
      "Note: the totals above are SESSION-LEVEL provider-reported counts. The per-message before/after"
    );
    console.log(
      "      figures shown by 'spend' and 'compact' are deterministic LOCAL ESTIMATES (chars/4) - a"
    );
    console.log(
      "      different measurement, labeled there as local estimates; neither figure is billing-confirmed."
    );
  }

  // 6b-iii. Shared UNIFIED-FLOW honest token report: the SAME
  // block that `run codex` / `run cursor` print, so all three tools present ONE honest `token_source`
  // summary. Claude Code usage is PROVIDER-REPORTED and whole (no per-field unavailable split, like
  // Codex), so outputStatus is "present"; when a session lacks provider usage the shared builder honestly
  // downgrades to local-estimate / unavailable - it never labels anything stronger than the evidence. This
  // is a reporting surface only: input/output are shown SEPARATELY with an explicit source, and output is
  // shown as TOKENS ONLY (never a saving). No logic, adapter, or record behavior changes here.
  const runFlowReport = buildRunFlowTokenReport({ tool: "claude-code", usage, outputStatus: "present" });
  for (const line of formatRunFlowTokenReport(runFlowReport)) console.log(line);

  // 6c. Per-run distinctness fingerprint (a one-way digest over canonical normalized
  // content - NOT raw content). Lets a re-capture of the same session be told apart
  // from a genuinely new one; when unavailable, distinctness is `not_verified`.
  if (provenance.traceFingerprint) {
    console.log(
      `Trace fingerprint (distinctness, digest only - NOT raw content): ${provenance.traceFingerprint.content_sha256}`
    );
  } else {
    console.log("Trace fingerprint: not available - distinctness not_verified (do not count as distinct).");
  }

  // Write artifacts
  const outDir = buildOutputDir(options.session, options.out);

  const capturedRunArtifact = { trace, usage, provenance };
  const markdownReport = buildMarkdownReport(options.session, outDir, provenance, usage);

  await writeJsonArtifact(outDir, "captured-trace.json", trace);
  await writeJsonArtifact(outDir, "capture-report.json", capturedRunArtifact);
  await writeTextArtifact(outDir, "capture-report.md", markdownReport);

  // 7. Print artifacts written
  console.log(`Artifacts written to: ${outDir}/`);

  // Content-free A/B evidence sidecar (provider-reported counts + honest source) for
  // `output-shaping-ab add`. No policy attribution here: Claude Code output-shaping is attached by the
  // UserPromptSubmit hook (a separate process/surface), not by this capture call site, and there is no
  // truthful per-session record of which policy names applied to THIS session's turns to attach without
  // inventing one - so `outputShaping` is omitted rather than fabricated.
  const usagePath = await writeCaptureUsageSidecar(outDir, "claude-code", usage);
  console.log(`Wrote ${usagePath}`);

  // Unified flow: content-free record (input/output separate +
  // honest source) when hosted-configured. No default network call - only when COMPACTION_API_URL +
  // COMPACTION_API_KEY are set. Claude Code session usage is provider-reported.
  if (hostedConfigured()) {
    const rec = await recordCaptureContentFree(resolveApiConfig(), {
      usage,
      tool: "claude-code",
      reference: `${outDir}/captured-trace.json`
    });
    console.log(rec.recorded ? `Recorded content-free usage (tool=claude-code, source=${rec.source}).` : `Not recorded: ${rec.reason}.`);
  } else {
    console.log("Not recorded (set COMPACTION_API_URL + COMPACTION_API_KEY to record content-free usage).");
  }

  // 8. Print next step - chain into the verified strong-MVP Claude Code flow:
  //    spend (where the spend goes) → compact --eval (compaction + strong apply-readiness:
  //    deterministic recoverability + commitment-preservation + fixture task-check + token/cost).
  //    `analyze` remains available for a quick read-only estimate, but the strong flow is `spend`
  //    then `compact --eval`, so point the user there.
  console.log("");
  console.log("Next (Claude Code strong flow):");
  console.log(`  1. compaction spend ${outDir}/captured-trace.json            # where the tokens/cost go (local estimate)`);
  console.log(`  2. compaction compact ${outDir}/captured-trace.json --eval --out <dir>`);
  console.log("     # compaction + strong apply-readiness: deterministic recoverability, commitment-preservation,");
  console.log("     # fixture task-check, and token/cost accounting - nothing is applied automatically.");
  console.log(`  (or: compaction analyze ${outDir}/captured-trace.json   for a quick read-only estimate)`);
}

/* ----------------------------- Stop-hook capture (--from-hook) ----------------------------- */

/** A normalized usage summary for the hook path - usage + a content-free fingerprint + message count. */
interface HookNormalizeResult {
  usage: UsageMetadata;
  messageCount: number;
  fingerprint?: string;
}

export interface FromHookDeps {
  readStdin?: () => Promise<string>;
  normalize?: (transcriptPath: string) => Promise<HookNormalizeResult>;
  cwd?: string;
  now?: () => string;
  hostedConfigured?: () => boolean;
  /** Read the latest gateway receipt for the per-turn line (injectable for tests). */
  readLatestGatewayReceipt?: (cwd: string) => Promise<GatewayReceipt | undefined>;
  /** Read the bounded gateway window used to freeze an exact whole-run Stop event. */
  readGatewayReceipts?: (cwd: string) => Promise<GatewayReceiptTailWindow>;
  /** Activity append seam, injectable for persistence-failure recovery tests. */
  appendActivity?: typeof appendActivityEvent;
  /** Run-store settlement seam, injectable only to prove the pre-persistence failure barrier. */
  endClaudeRun?: typeof endClaudeUserRun;
  /** Atomic positive-collapse + frozen-event seam, injectable for exact crash-boundary tests. */
  commitClaudeSettlement?: typeof commitClaudePositiveSettlement;
  /** Frozen settlement cleanup seam, injectable for exact crash-boundary tests. */
  completeClaudeSettlement?: typeof completeClaudePositiveSettlement;
  /** Sink for the per-turn receipt line (defaults to console.log; injectable for tests). */
  printReceiptLine?: (line: string) => void;
  /** Env for the kill-switch read (injectable for tests). */
  env?: NodeJS.ProcessEnv;
}

export interface FromHookOptions {
  dryRun?: boolean;
}

async function readAllStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function defaultHookNormalize(transcriptPath: string): Promise<HookNormalizeResult> {
  const adapter = new ClaudeCodeAdapter();
  const { trace, usage, provenance } = await adapter.normalize({ sourcePath: transcriptPath });
  return {
    usage,
    messageCount: trace.messages.length,
    ...(provenance.traceFingerprint ? { fingerprint: provenance.traceFingerprint.content_sha256 } : {})
  };
}

function hookDir(cwd: string): string {
  return path.join(cwd, ".compaction", "hooks", "claude-code");
}

async function loadLedger(cwd: string): Promise<ClaudeCodeHookLedger> {
  try {
    const raw = await readFile(path.join(hookDir(cwd), "ledger.json"), "utf8");
    const parsed = JSON.parse(raw) as ClaudeCodeHookLedger;
    return Array.isArray(parsed.entries) ? parsed : emptyLedger();
  } catch {
    return emptyLedger();
  }
}

async function loadHookRecord(cwd: string, dedupKey: string): Promise<ClaudeCodeHookRecord | undefined> {
  if (!/^[0-9a-f]{32}$/.test(dedupKey)) return undefined;
  try {
    const parsed = JSON.parse(
      await readFile(path.join(hookDir(cwd), "records", `${dedupKey}.json`), "utf8")
    ) as ClaudeCodeHookRecord;
    return parsed?.schema === CLAUDE_CODE_HOOK_RECORD_SCHEMA &&
      parsed.tool === "claude-code" &&
      parsed.dedupKey === dedupKey
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

function frozenClaudeStopEvent(
  record: ClaudeCodeHookRecord | undefined,
  expected: { rawSessionId: string; hashedSessionId: string }
): ActivityEvent | undefined {
  const event = record?.settledActivityEvent;
  return record?.sessionId === expected.rawSessionId &&
    validClaudeLogicalRunId(record.logicalRunId) &&
    event?.activity_kind === "claude-stop" &&
    event.session_id === expected.hashedSessionId &&
    event.run_id === record.logicalRunId &&
    event.activity_event_id === computeActivityEventId(event) &&
    validateActivityEventForStore(event).problems.length === 0
    ? event
    : undefined;
}

/**
 * Append ONE metrics-only activity event for a Stop-hook capture (the always-on bridge). Builds the
 * `claude_code` cross-surface event from the SAME honest token report the record uses, then the
 * measure-only activity extension, and appends it to `.compaction/activity/` under the hook's cwd
 * (so tmp-cwd tests and real projects both scope correctly). Content-free and best-effort: any
 * local failure is swallowed here so it can NEVER break the fail-open hook.
 */
async function appendClaudeCodeHookActivity(input: {
  cwd: string;
  usage: UsageMetadata;
  dedupKey: string;
  sessionId?: string;
  logicalIdentity?: ClaudeLogicalRunIdentity;
  settledEvent?: ActivityEvent;
  appendEvent?: typeof appendActivityEvent;
}): Promise<"appended" | "duplicate" | "failed"> {
  try {
    if (input.settledEvent) {
      const result = await (input.appendEvent ?? appendActivityEvent)(
        input.settledEvent,
        path.join(input.cwd, ".compaction", "activity")
      );
      if (result.appended) return "appended";
      return result.reason.includes("duplicate activity_event_id") ? "duplicate" : "failed";
    }
    // outputStatus "present": buildRunFlowTokenReport honestly downgrades a missing output axis to
    // unavailable - a genuinely-absent field is never labeled provider-reported (no silent zero).
    const tokenReport = buildRunFlowTokenReport({ tool: "claude-code", usage: input.usage, outputStatus: "present" });
    const crossSurfaceEvent = buildRunCrossSurfaceEvent("claude_code", {
      // run_id is the deterministic content-free dedup key → deterministic activity_event_id → the
      // store dedupes a re-captured session (same state = one event).
      runId: input.logicalIdentity?.runId ?? `claude-code-${input.dedupKey}`,
      tokenReport,
      reasons: {
        input: "the Claude Code session usage did not report input tokens for this session state",
        output: "the Claude Code session usage did not report output tokens for this session state"
      },
      ...(input.usage.model ? { modelLabel: input.usage.model } : {})
    });
    // session_id rides on the event too (content-free identity), when the Stop payload carried one.
    const eventWithSession = input.logicalIdentity
      ? { ...crossSurfaceEvent, session_id: input.logicalIdentity.sessionId }
      : input.sessionId
        ? { ...crossSurfaceEvent, session_id: input.sessionId }
      : crossSurfaceEvent;
    // Measurement only: nothing was applied or retained by Compaction, so original_retained=false.
    const activityEvent = buildMeasureOnlyActivityEvent(eventWithSession, { original_retained: false });
    const result = await (input.appendEvent ?? appendActivityEvent)(
      activityEvent,
      path.join(input.cwd, ".compaction", "activity")
    );
    console.log(
      result.appended
        ? `compaction hook: recorded metrics-only activity (surface=claude_code, id ${result.activity_event_id.slice(0, 12)}…) - see 'compaction activity'.`
        : `compaction hook: activity not appended (${result.reason}).`
    );
    if (result.appended) return "appended";
    return result.reason.includes("duplicate activity_event_id") ? "duplicate" : "failed";
  } catch {
    // Best-effort local append - never fail the fail-open hook on a filesystem/store error.
    return "failed";
  }
}

/**
 * Print the SINGLE canonical per-turn receipt line for a Claude Code Stop-hook turn. If a gateway
 * receipt exists for this session (the run went through the local Gateway), print its input+output
 * line; otherwise print the OUTPUT-ONLY hook line (no input clause, no reduction % - input compaction
 * is gateway-only). Content-free by construction (only counts + labels + source + short id ride on the
 * line). Honors the `COMPACTION_RECEIPT_LINE=0` kill switch. FAIL-OPEN: any error prints nothing and is
 * swallowed here so it can NEVER break the fail-open hook.
 */
async function printPerTurnReceiptLine(input: {
  cwd: string;
  usage: UsageMetadata;
  readReceipt: (cwd: string) => Promise<GatewayReceipt | undefined>;
  print: (line: string) => void;
  env: NodeJS.ProcessEnv;
  /**
   * WHOSE turn this line describes. The shaping evidence is keyed by Claude Code's own `session_id`, so
   * a Stop hook can only ever read the decision ITS session recorded. Undefined (no `session_id` on the
   * payload) fails closed: the line still prints, with no shaping label and no output arrow.
   */
  shapingScope: ShapingTurnScope | undefined;
}): Promise<void> {
  try {
    if (!isReceiptLineEnabled(input.env)) return;
    // The device's CURRENT tier — which selects the BUILDER and carries the ceiling reason the clamp
    // would otherwise swallow (a spent period allowance resolves to `observe`, which alone would read
    // as a silent tier downgrade). It is NOT the source of the Open tier label; that comes from the
    // turn's own evidence below.
    // Reads local disk only (lease, credentials, local usage journal) — no account/entitlement/
    // usage-service or network call, and fail-open by construction.
    const { tier: productTier, allowanceResetsOn } = await resolveOpenTier(input.env);
    // CALIBRATION FIRST, before the gateway branch. This used to load
    // only on the hook-only path below, so a turn WITH a gateway receipt returned before it ran and the
    // apply lines could never carry the output arrow — the strongest line on the strongest route was
    // the one that never showed a saving. The read is local, content-free and fail-open.
    //
    // The RATE is loaded here; the per-turn COUNT is derived at each use site from THAT line's own
    // output. `input.usage.output_tokens` is the SESSION-WIDE sum
    // — the adapter adds up every request — while a gateway line reports ONE request. Pairing a
    // session-sized saving with a single-request output produced absurd arrows (ten 400-token requests
    // at a 40% rate rendered `3,067→400 (−87%)` instead of `667→400 (−40%)`).
    // GATED ON THE TURN, NOT ON ACTIVATION. `isShapingHooksActivated`
    // reports the kill switch and `compaction stop` state only — it is true on a planning turn the task
    // gate HELD, and on a fail-open turn. Drawing the arrow off it claimed a saving on turns where
    // nothing was injected. `lastTurnWasShaped` reads what the prompt hook actually decided, and is
    // false whenever that cannot be confirmed.
    const outputTokensNow = typeof input.usage.output_tokens === "number" ? input.usage.output_tokens : undefined;
    const hookOutcome = await lastTurnShapingOutcome(input.shapingScope, input.env);
    const hookShapedTurn = hookOutcome === "shape" || hookOutcome === "shape-basic";
    const hookQuery = hookShapedTurn
      ? outputCalibrationQuery({
        policyVersion: buildOutputShapingPolicy().policyVersion,
        provider: input.usage.provider,
        model: input.usage.model,
        ...(hookOutcome === "shape" ? { regime: "default-shapeable" } : {})
      })
      : undefined;
    const reductionNow = hookShapedTurn
      ? await loadCalibrationReduction(input.env, hookQuery)
      : undefined;

    const receipt = await input.readReceipt(input.cwd);
    if (receipt) {
      // FULL tier (valid entitlement lease): a REAL full-apply receipt renders the `full apply` line
      // via the community builder; a non-apply turn falls back to the honest Open observe line — and
      // that fallback carries the ceiling, since those are the turns a spent allowance produces.
      // Derived from THIS RECEIPT's output, not the session total.
      const gatewayShaped =
        receipt.output_shaping_state === "attached-this-pass" || receipt.output_shaping_state === "already-active";
      const query = outputCalibrationQuery({
        policyVersion: receipt.output_shaping_policy_version,
        provider: receipt.provider,
        model: receipt.model,
        regime: receipt.output_shaping_regime
      });
      const receiptReduction = gatewayShaped
        ? await loadCalibrationReduction(input.env, query)
        : hookShapedTurn
          ? reductionNow
          : undefined;
      const savedForReceipt = receiptReduction
        ? estimatePerTurnOutputSaved(receiptReduction, receipt.tokens?.output)
        : undefined;
      // THE LABEL DESCRIBES THE TURN, NOT THE SETTING. It used to be the stored product mode, so a
      // `basic` user read `basic shaping` on turns nothing had shaped, and an `observe` user read
      // `apply off` on turns the gateway had genuinely mutated. Only two things may name it: what
      // THIS receipt records, and — this being the just-finished turn — whether the prompt hook
      // shaped it, the same evidence the output arrow beside it uses. Unprovable ⇒ unlabelled.
      const openLine: OpenLineRendering = openLineForTurn(receipt, hookShapedTurn);
      // THIS TURN's ceiling, from the receipt, over the session-level one: `resolveOpenTier` fires only
      // at `remaining <= 0`, while the receipt also records the `insufficient` pause — allowance left,
      // but less than this turn needed — which session state cannot express at all.
      const ceiling = receiptCeiling(receipt, input.env);
      const line =
        productTier === "full"
          ? (communityFullApplyReceiptLine(receipt, savedForReceipt, ceiling) ??
            receiptLineFromGatewayReceipt(receipt, openLine, allowanceResetsOn, savedForReceipt, ceiling))
          : receiptLineFromGatewayReceipt(receipt, openLine, allowanceResetsOn, savedForReceipt, ceiling);
      if (line) input.print(line);
      await printCommunityInviteIfDue(input, productTier);
      return;
    }

    // Hook-only (subscription) path: no gateway receipt this turn. Output shaping is the only apply lever
    // here, so the per-turn label reflects the ACTUAL turn: `basic shaping` iff shaping was active this
    // turn (not killed, not `compaction stop`-ed), else `apply off`. When shaping is active the line also
    // opts into the estimated-output-saved arrow — a LOCAL ESTIMATE derived from the measured shaping A/B
    // reduction rate × this turn's output. With no applicable calibration the clause explicitly keeps
    // the unknown counterfactual as `output N/A→N (N/A%, est.)`, never a fabricated number.
    const outputTokens = outputTokensNow;
    const providerReported = input.usage.provider_reported_tokens === true;
    // The TIER LABEL still rides activation: `basic shaping` describes the posture the user chose, which
    // is true even on a turn the gate held. Only the SAVING claim needs per-turn evidence.
    const shapingActive = isShapingHooksActivated(input.env);
    // Honest per-turn label: shaping active ⇒ basic shaping happened this turn; otherwise no mutation.
    const hookTier: "observe" | "basic" = shapingActive ? "basic" : "observe";
    // Hook-only turn: no gateway receipt, so the session usage IS this turn's output.
    const estimatedSaved = reductionNow ? estimatePerTurnOutputSaved(reductionNow, outputTokens) : undefined;
    const line = receiptLineOutputOnly({
      ...(outputTokens !== undefined ? { outputTokens } : {}),
      providerReported,
      shapingActive,
      tier: hookTier,
      ...(estimatedSaved ? { estimatedSaved } : {}),
      ...(allowanceResetsOn ? { allowanceResetsOn } : {})
    });
    if (line) input.print(line);
    await printCommunityInviteIfDue(input, productTier);
  } catch {
    // FAIL-OPEN: the per-turn line is display-only; never let it break the hook.
  }
}

/**
 * The OPEN → COMMUNITY invitation, printed ADJACENT to the receipt line and never inside it.
 *
 * Separate on purpose. The receipt is an evidence surface; folding a call to action into its grammar
 * would make every future reading of that line partly an advertisement. This is one line, after it,
 * pointing at the activation command that already exists.
 *
 * `core/community-graduation.ts` owns the whole decision AND its bookkeeping, so this call site cannot
 * show the line without also consuming one of its lifetime slots. It is silent on all but a handful of
 * turns in a device's life: Open only, no account, at least 25 recorded turns, at most 3 times ever, at
 * least a week apart.
 *
 * Best-effort and fail-silent, like the line above it: an invitation is never worth a broken hook.
 */
async function printCommunityInviteIfDue(
  input: { cwd: string; print: (line: string) => void; env: NodeJS.ProcessEnv },
  tier: "observe" | "basic" | "full"
): Promise<void> {
  try {
    // The local, content-free activity log is the evidence that the product has DONE something on this
    // machine. It is the same store the Ready screen's honest metric reads, so "value demonstrated"
    // means the same thing on both surfaces.
    //
    // READ THE STORE THIS HOOK WRITES. `readActivityEvents()`'s default directory is RELATIVE, so an
    // argument-less read resolves against `process.cwd()` — but `appendClaudeCodeHookActivity` writes
    // under the hook's INJECTED `cwd`, precisely so a tmp-cwd caller and a real project each scope to
    // their own store. The difference was real in both directions: the invitation's "value
    // demonstrated" evidence came from wherever the process happened to be started rather than from
    // this hook's root, and the repo's own activity log accumulated past the invitation threshold
    // during test runs, so the invite appeared beside receipt lines in tests that had nothing to do
    // with it. The turns that count toward an invitation are the turns of the project the receipt is for.
    const { events } = await readActivityEvents(path.join(input.cwd, DEFAULT_ACTIVITY_DIRECTORY));
    const invite = communityInviteLine(
      {
        tier,
        hasAccount: readStoredCredentials(input.env) !== undefined,
        turnsRecorded: events.length
      },
      input.env
    );
    if (invite) input.print(invite);
  } catch {
    /* display-only: never break the hook over an invitation */
  }
}

/**
 * `compaction capture claude-code --from-hook`. Reads the Stop payload from stdin, resolves the session
 * JSONL via `transcript_path`, and records CONTENT-FREE usage only - never message content, never
 * `last_assistant_message`. Idempotent via a content-free dedup ledger. FAIL-OPEN by contract: any error is
 * swallowed and the process exits 0 so the hook can never break Claude Code.
 */
export async function captureClaudeCodeFromHook(options: FromHookOptions = {}, deps: FromHookDeps = {}): Promise<void> {
  const cwd = deps.cwd ?? process.cwd();
  const now = deps.now ?? (() => new Date().toISOString());
  const readStdin = deps.readStdin ?? readAllStdin;
  const normalize = deps.normalize ?? defaultHookNormalize;
  const hostedIsConfigured = deps.hostedConfigured ?? hostedConfigured;
  const readReceipt = deps.readLatestGatewayReceipt ?? readLatestGatewayReceipt;
  const readReceiptWindow = deps.readGatewayReceipts ?? readGatewayReceiptTailWindow;
  const appendActivity = deps.appendActivity ?? appendActivityEvent;
  const endClaudeRun = deps.endClaudeRun ?? endClaudeUserRun;
  const commitClaudeSettlement = deps.commitClaudeSettlement ?? commitClaudePositiveSettlement;
  const completeClaudeSettlement = deps.completeClaudeSettlement ?? completeClaudePositiveSettlement;
  const printReceiptLine = deps.printReceiptLine ?? ((line: string) => console.log(line));
  const env = deps.env ?? process.env;

  try {
    const stdinText = await readStdin();
    const payload = parseStopPayload(stdinText);

    // FOREIGN-TOOL GUARD. This handler attributes every turn it records to `surface: "claude_code"`
    // with `source: provider-reported`, unconditionally — so it must refuse anything that is not
    // actually a Claude Code Stop payload.
    //
    // This is not hypothetical. Compaction installs the Claude Code Stop hook into
    // `.claude/settings.json`, and CURSOR READS THAT SAME FILE (its config discovery covers
    // `.claude/settings.json` and `.claude/settings.local.json`, and it maps its own `stop` event onto
    // Claude Code's `Stop`). So in any project where a user connected Claude Code and also uses
    // Cursor, Cursor fires this command with ITS stop payload — which carries a `transcript_path`, the
    // only thing this path used to gate on. Reproduced by feeding a Cursor-shaped payload to the built
    // CLI: it recorded `surface=claude_code`, `source=provider-reported`, and printed a per-turn line.
    //
    // Both labels are wrong, and the second is forbidden outright: `cursor` is in
    // `NEVER_PROVIDER_REPORTED_SURFACES` precisely because Compaction never sees a provider response
    // for it. A single mis-attributed turn silently contaminates the repo's cleanest evidence tier.
    //
    // The test is POSITIVE evidence of a foreign tool, never a whitelist of Claude Code's fields, so a
    // future Claude Code payload change cannot make this reject real traffic:
    //   · `cursor_version` — present on every Cursor hook payload, absent from Claude Code's.
    //   · `hook_event_name` present but not exactly `Stop` — Cursor sends lowercase `stop`. When the
    //     field is absent entirely we proceed, because older Claude Code payloads omit it.
    if (isForeignStopPayload(payload)) {
      console.log(
        "compaction hook: this Stop payload did not come from Claude Code (it looks like Cursor, which " +
          "also reads .claude/settings.json) - nothing recorded, because attributing it to Claude Code " +
          "would misstate both the surface and the token source."
      );
      return;
    }

    const transcriptPath = resolveTranscriptPath(payload);
    if (!transcriptPath) {
      console.log("compaction hook: no transcript_path in the Stop payload - nothing recorded (content-free).");
      return;
    }

    const sessionId = typeof payload?.session_id === "string" ? payload.session_id : undefined;
    // RUN END. `Stop` closes the run this session opened. One exact provisional successor may collapse
    // into its predecessor only after this transcript exposes the structured task-notification row;
    // every absent, malformed, foreign, or ambiguous case remains a separate run.
    //
    // NOT ON A DRY RUN. `--dry-run` promises "nothing written", and the run store is a write: closing
    // the live run from a diagnostic invocation would exclude every receipt that lands afterwards from
    // the run the user is actually in. The run-membership timestamp is the request's arrival at the
    // gateway (`request_started_at`), so closing at this instant cannot drop the response this `Stop`
    // is reporting on, however late its receipt is appended.
    const correlationId = sessionId ? sessionCorrelationId(sessionId, env) : undefined;
    let logicalIdentity: ClaudeLogicalRunIdentity | undefined;
    let settledRun: import("../../core/gateway/run-boundary.js").UserRun | undefined;
    let settledActivityEvent: ActivityEvent | undefined;
    let settledCalibrationQuery: OutputShapingCalibrationQuery | undefined;
    let settledPending: ClaudeSettledProvisionalPending | undefined;
    let normalized: HookNormalizeResult | undefined;
    let dedupKey: string | undefined;
    let positiveSettlementEvidenceInsufficient = false;
    const stopAt = now();
    if (correlationId && !options.dryRun) {
      const pending = claudeProvisionalPending(correlationId, env);
      const taskNotification = pending
        ? await hasClaudeTaskNotificationEvidence(stdinText, pending.prompt_correlation_id, env)
        : false;
      if (pending?.phase === "settled") {
        normalized = await normalize(transcriptPath);
        dedupKey = computeDedupKey({
          sessionId,
          fingerprint: normalized.fingerprint,
          messageCount: normalized.messageCount,
          inputTokens: typeof normalized.usage.input_tokens === "number" ? normalized.usage.input_tokens : null,
          outputTokens: typeof normalized.usage.output_tokens === "number" ? normalized.usage.output_tokens : null
        });
        if (!taskNotification || dedupKey !== pending.dedup_key) {
          console.log("compaction hook: frozen Claude settlement did not match this exact Stop - nothing recorded.");
          return;
        }
        settledPending = pending;
        settledActivityEvent = pending.event;
        logicalIdentity = { runId: pending.event.run_id!, sessionId: pending.event.session_id! };
      } else if (pending?.phase === "open" && taskNotification) {
        const projected = projectClaudePositiveSettlement(correlationId, stopAt, pending, env);
        normalized = await normalize(transcriptPath);
        dedupKey = computeDedupKey({
          sessionId,
          fingerprint: normalized.fingerprint,
          messageCount: normalized.messageCount,
          inputTokens: typeof normalized.usage.input_tokens === "number" ? normalized.usage.input_tokens : null,
          outputTokens: typeof normalized.usage.output_tokens === "number" ? normalized.usage.output_tokens : null
        });
        if (projected) {
          try {
            const window = await readReceiptWindow(cwd);
            settledActivityEvent = buildClaudeStopActivityEvent({
              run: projected,
              window,
              calibrationResolver: await loadOutputCalibrationResolver(env)
            });
            settledCalibrationQuery = settledActivityEvent
              ? claudeStopOutputCalibrationQuery({ run: projected, window })
              : undefined;
          } catch {
            // Without exact frozen bytes, a positive pair may not collapse into unrecoverable state.
          }
          if (!settledActivityEvent) {
            const priorRun = completedUserRuns(correlationId, env)
              .find((run) => run.run_seq === projected.run_seq - 1);
            const priorIdentity = priorRun ? claudeLogicalRunIdentity(priorRun) : undefined;
            let baseline: ClaudeTranscriptUsageBaseline | undefined;
            if (priorIdentity && sessionId) {
              const priorRecord = exactPriorClaudeHookRecord(
                await loadHookUsageRecords(hookDir(cwd)),
                {
                  sessionId,
                  logicalRunId: priorIdentity.runId,
                  before: projected.started_at
                }
              );
              if (
                priorRecord &&
                (priorRecord.tokenSource === "provider-reported" || priorRecord.tokenSource === "local-estimate")
              ) {
                baseline = {
                  inputTokens: priorRecord.inputTokens,
                  outputTokens: priorRecord.outputTokens,
                  cacheReadInputTokens: priorRecord.cacheReadInputTokens,
                  cacheCreationInputTokens: priorRecord.cacheCreationInputTokens,
                  tokenSource: priorRecord.tokenSource
                };
              }
            }
            const shapingOutcome = sessionId
              ? await lastTurnShapingOutcome(
                  { tool: "claude-code", sessionId },
                  env,
                  () => new Date(stopAt)
                )
              : undefined;
            const positiveShapingOutcome = shapingOutcome === "shape" || shapingOutcome === "shape-basic"
              ? shapingOutcome
              : undefined;
            const calibrationResolver = await loadOutputCalibrationResolver(env);
            settledActivityEvent = buildClaudeTranscriptStopActivityEvent({
              run: projected,
              usage: normalized.usage,
              ...(positiveShapingOutcome ? { shapingOutcome: positiveShapingOutcome } : {}),
              calibrationResolver,
              ...(baseline ? { baseline } : {})
            });
            settledCalibrationQuery = settledActivityEvent
              ? claudeTranscriptOutputCalibrationQuery({
                  usage: normalized.usage,
                  ...(positiveShapingOutcome ? { shapingOutcome: positiveShapingOutcome } : {})
                })
              : undefined;
            positiveSettlementEvidenceInsufficient = settledActivityEvent === undefined;
          }
        }
        settledPending = projected && settledActivityEvent
          ? commitClaudeSettlement(correlationId, stopAt, pending, dedupKey, settledActivityEvent, env)
          : undefined;
        if (!settledPending) {
          console.log(
            positiveSettlementEvidenceInsufficient
              ? "compaction hook: the final Claude transcript did not carry usable token axes for exact continuation settlement - nothing recorded."
              : projected
              ? "compaction hook: exact Claude continuation settlement was not durable - retrying the same Stop is safe."
              : "compaction hook: Claude continuation evidence did not resolve one exact run pair - nothing recorded."
          );
          return;
        }
        settledRun = projected;
        logicalIdentity = projected ? claudeLogicalRunIdentity(projected) : undefined;
      } else {
        settledRun = endClaudeRun(
          correlationId,
          stopAt,
          pending?.phase === "open" ? { expected: pending, taskNotification } : undefined,
          env
        );
        logicalIdentity = settledRun ? claudeLogicalRunIdentity(settledRun) : undefined;
      }
    }
    normalized ??= await normalize(transcriptPath);
    const { usage, messageCount, fingerprint } = normalized;
    dedupKey ??= computeDedupKey({
      sessionId,
      fingerprint,
      messageCount,
      inputTokens: typeof usage.input_tokens === "number" ? usage.input_tokens : null,
      outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : null
    });

    const ledger = await loadLedger(cwd);
    const existingRecord = await loadHookRecord(cwd, dedupKey);
    const hashedSessionId = correlationId ? claudeLogicalSessionId(correlationId) : undefined;
    const frozen = sessionId && hashedSessionId
      ? frozenClaudeStopEvent(existingRecord, { rawSessionId: sessionId, hashedSessionId })
      : undefined;
    if (
      settledPending &&
      existingRecord &&
      (!frozen || frozen.activity_event_id !== settledPending.event.activity_event_id)
    ) {
      // The run-store settlement is the first frozen authority. A pre-existing malformed or
      // conflicting per-dedup record may never replace it, be overwritten, or trigger cleanup.
      console.log("compaction hook: frozen Claude settlement conflicted with its hook record - nothing recorded.");
      return;
    }
    if (frozen && existingRecord) {
      // RECORD-BEFORE-LEDGER CRASH RECOVERY. The per-dedup record is written first so the immutable
      // event survives a process exit or ledger-write failure. If the ledger entry is absent, restore
      // only that entry from the validated record before attempting the activity append. Never rebuild
      // the event from receipts/calibration/tier state after its run has already closed.
      if (!isAlreadyRecorded(ledger, dedupKey)) {
        const dir = hookDir(cwd);
        await mkdir(path.join(dir, "records"), { recursive: true });
        ledger.entries.push({
          dedupKey,
          ...(sessionId ? { sessionId } : {}),
          recordedAt: existingRecord.recordedAt
        });
        await writeFile(path.join(dir, "ledger.json"), `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
      }
      const replay = await appendClaudeCodeHookActivity({
        cwd,
        usage,
        dedupKey,
        ...(sessionId ? { sessionId } : {}),
        settledEvent: frozen,
        appendEvent: appendActivity
      });
      if (replay === "appended") {
        const line = settledStopLineFromActivityEvent(frozen);
        if (line && isReceiptLineEnabled(env)) printReceiptLine(line);
      }
      if (settledPending && replay !== "failed") {
        completeClaudeSettlement(correlationId!, settledPending, env);
      }
      console.log(`compaction hook: already recorded this session state (dedup ${dedupKey.slice(0, 8)}…) - skipped.`);
      return;
    }
    if (isAlreadyRecorded(ledger, dedupKey)) {
      // Legacy or malformed recorded state has no validated immutable whole-run event to replay.
      // Preserve the historical dedup behavior; never reconstruct authority from changed receipts,
      // calibration, tier, or a run which may already be closed.
      console.log(`compaction hook: already recorded this session state (dedup ${dedupKey.slice(0, 8)}…) - skipped.`);
      return;
    }

    if (!settledActivityEvent && settledRun && logicalIdentity) {
      try {
        const window = await readReceiptWindow(cwd);
        settledActivityEvent = buildClaudeStopActivityEvent({
          run: settledRun,
          window,
          calibrationResolver: await loadOutputCalibrationResolver(env)
        });
        settledCalibrationQuery = settledActivityEvent
          ? claudeStopOutputCalibrationQuery({ run: settledRun, window })
          : undefined;
      } catch {
        // Exact gateway settlement is additive. Any read/validation failure retains the legacy
        // transcript snapshot and never guesses a whole-run event.
      }
    }
    const record = buildClaudeCodeHookRecord({
      usage,
      ...(sessionId ? { sessionId } : {}),
      ...(logicalIdentity ? { logicalRunId: logicalIdentity.runId } : {}),
      ...(settledActivityEvent ? { settledActivityEvent } : {}),
      messageCount,
      dedupKey,
      recordedAt: now()
    });

    if (options.dryRun) {
      console.log("compaction hook --dry-run: would record (content-free, nothing written):");
      console.log(JSON.stringify(record, null, 2));
      return;
    }

    const dir = hookDir(cwd);
    await mkdir(path.join(dir, "records"), { recursive: true });
    await writeFile(path.join(dir, "records", `${dedupKey}.json`), `${JSON.stringify(record, null, 2)}\n`, "utf8");
    ledger.entries.push({ dedupKey, ...(sessionId ? { sessionId } : {}), recordedAt: record.recordedAt });
    await writeFile(path.join(dir, "ledger.json"), `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
    console.log(`compaction hook: recorded content-free usage (source=${record.tokenSource}, dedup ${dedupKey.slice(0, 8)}…).`);

    // ALWAYS-ON BRIDGE: the Stop hook runs this command at session end,
    // so the SAME content-free usage ALSO appends ONE metrics-only activity event to the local
    // activity store (.compaction/activity/). THIS is what makes a subsequent Claude Code session
    // appear in `compaction activity` with NO manual import. Honesty: surface "claude_code",
    // provider "anthropic", token axes copied VERBATIM from the SAME token report (provider-reported
    // where the session usage carried them, else unavailable-with-reason - never a silent zero);
    // measure-only, so approval "not-required", auto_apply OFF (not eligible, "ask-each-time",
    // applied_automatically false - this capture-only path never applies), sync "local-only", recovery
    // original_retained=false (measurement only - Compaction modified/retained nothing). The event
    // id is DETERMINISTIC from session state (run_id = the content-free dedup key), so a re-captured
    // session yields the SAME id and the store dedupes it. Best-effort + content-free; a local
    // filesystem failure here never breaks the hook.
    const activityResult = await appendClaudeCodeHookActivity({
      cwd,
      usage,
      dedupKey,
      ...(sessionId ? { sessionId } : {}),
      ...(logicalIdentity ? { logicalIdentity } : {}),
      ...(settledActivityEvent ? { settledEvent: settledActivityEvent } : {}),
      appendEvent: appendActivity
    });
    if (activityResult === "appended" && settledCalibrationQuery) {
      try {
        await activateSharedOutputCalibration(settledCalibrationQuery, env);
      } catch {
        // The settled event is authoritative; optional local calibration remains fail-open.
      }
    }
    if (settledPending && activityResult !== "failed") {
      completeClaudeSettlement(correlationId!, settledPending, env);
    }

    // PER-TURN RECEIPT LINE: the single canonical content-free line for this turn. Input+output when a
    // gateway receipt exists this session (the run routed through the local Gateway), else the
    // output-only hook line. Display only - it never changes what was recorded above, is silenced by
    // COMPACTION_RECEIPT_LINE=0, and is fully fail-open (prints nothing on any error).
    // SCOPED TO THIS SESSION. `sessionId` is Claude Code's own `session_id` from the Stop payload, the
    // same identifier its `UserPromptSubmit` payload and its status-line stdin carry — so this hook reads
    // the decision ITS session recorded and can never pick up a concurrent session's. Absent ⇒ no scope ⇒
    // no shaping claim on this line.
    const shapingScope: ShapingTurnScope | undefined = sessionId ? { tool: "claude-code", sessionId } : undefined;
    if (settledActivityEvent) {
      // A gateway-backed run has ONE durable shared line. Do not print a false final if persistence
      // failed; replay of the same Stop will append and print the frozen event exactly once.
      if (activityResult !== "failed" && isReceiptLineEnabled(env)) {
        const line = settledStopLineFromActivityEvent(settledActivityEvent);
        if (line) printReceiptLine(line);
      }
    } else {
      await printPerTurnReceiptLine({ cwd, usage, readReceipt, print: printReceiptLine, env, shapingScope });
    }

    // THE RECORD DELIBERATELY SURVIVES THIS HOOK. Stop used to delete it here, one line after printing
    // the receipt line above — but Claude Code swallows hook stdout, so that line is invisible and the
    // status line is what the user actually reads. The status line renders AGAIN once the turn is
    // final, and with the record gone it found no evidence and redrew the finished turn as a bare
    // `input N · output M`, dropping the reduction and the `basic shaping` label it had been showing
    // throughout. The next `UserPromptSubmit` overwrites the record with its own turn's decision —
    // unconditionally, for every outcome — so ending it here bought nothing and cost the turn its line.

    if (hostedIsConfigured()) {
      const rec = await recordCaptureContentFree(resolveApiConfig(), { usage, tool: "claude-code", reference: `hook:${dedupKey}` });
      console.log(rec.recorded ? `compaction hook: also recorded to hosted (source=${rec.source}).` : `compaction hook: hosted not recorded: ${rec.reason}.`);
    }
  } catch (error) {
    // FAIL-OPEN: never propagate - the hook must not break Claude Code.
    const message = error instanceof Error ? error.message : String(error);
    console.log(`compaction hook: skipped (non-fatal: ${message}).`);
  }
}

/* --------------------------- Before-call recommendation (--from-prompt-hook) --------------------------- */

export interface FromPromptHookDeps {
  readStdin?: () => Promise<string>;
  cwd?: string;
}

/**
 * `compaction capture claude-code --from-prompt-hook` - the BEFORE-CALL recommendation path. The Claude
 * Code **UserPromptSubmit** hook runs this BEFORE the model processes the prompt (a genuine pre-call event
 * - NOT the post-session Stop hook). It reads the UserPromptSubmit
 * payload from stdin, analyzes the pending PROMPT for avoidable duplicated context IN-PROCESS
 * (content-free), and - when present - records ONE metrics-only `claude_code` before-call RECOMMENDATION
 * activity event so it appears in `compaction activity`. Apply is a PROVEN BLOCKER on this surface (no
 * hook can reduce the model's context; hooks are non-interactive) → recommendation-only; the original
 * prompt ALWAYS runs UNCHANGED.
 *
 * CRITICAL: this path writes NOTHING to stdout - on UserPromptSubmit, a hook's stdout is ADDED to the
 * model's context, so injecting anything would be both intrusive and self-defeating for a compaction
 * tool. It is silent and transparent; the recommendation lives in `compaction activity`. FAIL-OPEN +
 * CONTENT-FREE: any error is swallowed and the process exits 0; the prompt text is never persisted.
 */
export async function captureClaudeCodeFromPromptHook(deps: FromPromptHookDeps = {}): Promise<void> {
  const readStdin = deps.readStdin ?? readAllStdin;
  try {
    const payload = parseUserPromptSubmitPayload(await readStdin());
    if (!payload) return; // malformed/absent payload → nothing recorded (fail-open)
    const result = detectAvoidableContext(payload.prompt);
    if (!result.has_avoidable_context) return; // honest no-op → no activity noise, no stdout
    const cwd = payload.cwd ?? deps.cwd ?? process.cwd();
    const event = buildClaudeCodeBeforeCallEvent(result, payload.sessionId ? { sessionId: payload.sessionId } : {});
    await appendActivityEvent(event, path.join(cwd, ".compaction", "activity"));
    // No stdout (would inject into the model context); the recommendation is in `compaction activity`.
  } catch {
    // FAIL-OPEN: never propagate - the before-call hook must not break Claude Code.
  }
}

/* ----------------------------- Before-call SHAPING (--shape-prompt-hook) ----------------------------- */

export interface ShapePromptHookDeps {
  readStdin?: () => Promise<string>;
  /** Injectable environment (defaults to process.env) so the kill-switch + stop-state are testable. */
  env?: NodeJS.ProcessEnv;
  /** Where the injection JSON is written (defaults to process.stdout). */
  write?: (text: string) => void;
  /** Injectable clock for run-boundary tests. */
  now?: () => string;
}

/**
 * The shaping scope for a Claude Code hook payload: its own `session_id`, or `undefined` when the payload
 * has none (or is unparseable). Parsed defensively and separately from `decideShaping` so a malformed
 * payload costs the turn its shaping CLAIM, never its shaping — the decision still stands, it simply is
 * not attributable to a session and so is not recorded.
 *
 * Content-free: only `session_id` is read; the prompt text is never touched here.
 */
function claudeCodeScopeFromHookStdin(
  stdinText: string
): Extract<ShapingTurnScope, { tool: "claude-code" }> | undefined {
  try {
    const payload = JSON.parse(stdinText) as { session_id?: unknown } | null;
    const sessionId = typeof payload?.session_id === "string" ? payload.session_id : undefined;
    return sessionId ? { tool: "claude-code", sessionId } : undefined;
  } catch {
    return undefined;
  }
}

/** The session's working directory as Claude Code reports it on the hook payload, else this process's. */
function claudeCwdFromHookStdin(stdinText: string): string {
  try {
    const payload = JSON.parse(stdinText) as { cwd?: unknown } | null;
    return typeof payload?.cwd === "string" && payload.cwd.trim() !== "" ? payload.cwd : process.cwd();
  } catch {
    return process.cwd();
  }
}

/**
 * Repair the session's existing route before its next provider call. The hook is bounded and
 * fail-open; an unrouted session or failed repair leaves the turn untouched.
 */
async function reviveRoutingEndpointBeforeTurn(stdinText: string): Promise<void> {
  try {
    const { reviveRoutingGatewayIfDown, REVIVAL_BUDGET_MS } = await import("../../core/gateway/routing-revival.js");
    const cwd = claudeCwdFromHookStdin(stdinText);
    await Promise.race([
      reviveRoutingGatewayIfDown(cwd, { wait: true, budgetMs: REVIVAL_BUDGET_MS }),
      new Promise((resolve) => setTimeout(resolve, REVIVAL_BUDGET_MS + 200))
    ]);
  } catch {
    /* FAIL-OPEN: a repair that cannot run must never cost the user their turn. */
  }
}

function claudePromptIdFromHookStdin(stdinText: string): string | undefined {
  try {
    const payload = JSON.parse(stdinText) as { prompt_id?: unknown } | null;
    return typeof payload?.prompt_id === "string" ? payload.prompt_id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `compaction capture claude-code --shape-prompt-hook` - the SUBSCRIPTION OUTPUT-SHAPING before-call path.
 * The Claude Code **UserPromptSubmit** hook runs this BEFORE the model processes the prompt (a genuine
 * pre-call event - NOT the post-session Stop hook). Unlike the RECOMMENDATION path above, this path DOES
 * emit to stdout: on a shapeable turn it prints `{ hookSpecificOutput: { hookEventName: "UserPromptSubmit",
 * additionalContext } }`, which Claude Code wraps in a system reminder and adds to the model's context for
 * THIS turn only - biasing the response toward shorter output. This is the one apply lever available on a
 * subscription (the API-key input-compaction gateway is not).
 *
 * DELEGATES the whole decision to the shared, PURE `decideShaping("claude-code", …)` so all four invariants
 * are enforced in one place and shared with Codex:
 *  - DORMANT/STOP: env kill-switch (`COMPACTION_SHAPING_HOOKS=0`) OR persisted `compaction stop` → emit
 *    NOTHING (the prompt runs unchanged).
 *  - CLASSIFIER-HOLD wherever the task gate is present: planning/reasoning/extended-thinking turns HOLD
 *    (emit nothing) - never shaped. The classifier is PUBLIC and SHIPS, so
 *    a normal install HAS the gate and holds planning turns; a build WITHOUT it degrades to the public
 *    BLANKET method (`shape-basic`) rather than holding every turn.
 *  - CONTENT-FREE: prompt bytes are read ONLY to classify locally; the emitted instruction is a fixed
 *    generic block that carries no request content, and nothing is persisted or logged.
 *  - FAIL-OPEN: any parse/shape error → emit nothing. A broken hook never breaks Claude Code (exit 0).
 */
export async function captureClaudeCodeShapeFromPromptHook(deps: ShapePromptHookDeps = {}): Promise<void> {
  const readStdin = deps.readStdin ?? readAllStdin;
  const write = deps.write ?? ((text: string) => process.stdout.write(text));
  try {
    const stdinText = await readStdin();
    const env = deps.env ?? process.env;
    const now = deps.now ?? (() => new Date().toISOString());
    // FIRST, before any shaping work: put the routing endpoint back if it died while the session was
    // idle. This turn's provider call has not been issued yet, which is the only moment at which the
    // repair can still save it. Bounded and fail-open - see `reviveRoutingEndpointBeforeTurn`.
    await reviveRoutingEndpointBeforeTurn(stdinText);
    // See `hooks shape`: the status line needs to know whether THIS turn was shaped, and only the
    // decision itself knows that. Recorded UNDER THIS SESSION'S ID, taken from the same payload the
    // decision was made from, so the status line and Stop hook for THIS session — and no other — can
    // read it. No `session_id` ⇒ no scope ⇒ nothing recorded and nothing later claimed.
    const scope = claudeCodeScopeFromHookStdin(stdinText);
    // RUN START. `UserPromptSubmit` is the only deterministic beginning of one user request, and this
    // hook is the one that ALWAYS runs on it (the recommendation hook returns early when a prompt has
    // no avoidable context, so it cannot mark boundaries). Marking it here lets the status line
    // describe the whole run instead of whichever provider call landed last.
    //
    // Keyed by the SAME session correlation the gateway writes on each receipt — a device-local keyed
    // hash, never the session id — so membership is `same session AND inside this run's interval`, and
    // two concurrent sessions in one directory cannot mix. Best-effort: a device with no run marker
    // simply keeps the per-receipt rendering it had before.
    if (scope?.sessionId) {
      const correlationId = sessionCorrelationId(scope.sessionId, env);
      if (correlationId) {
        const pending = claudeProvisionalPending(correlationId, env);
        const taskNotification = pending?.phase === "open"
          ? await hasClaudeTaskNotificationEvidence(stdinText, pending.prompt_correlation_id, env)
          : false;
        const promptId = claudePromptIdFromHookStdin(stdinText);
        startClaudeUserRun(
          correlationId,
          promptId === undefined
            ? undefined
            : claudePromptCorrelationId(scope.sessionId, promptId, env),
          now(),
          pending?.phase === "open" ? { expected: pending, taskNotification } : undefined,
          env
        );
      }
    }
    // DROP THE PREVIOUS TURN'S RECORD **BEFORE** THE FALLIBLE DECISION, not after it. `decideShaping`
    // can THROW: `classifyShapingTask` deliberately re-raises everything that is not a module-absence
    // error, so a runtime fault inside the classifier — or a missing dependency OF the classifier —
    // propagates here and lands in the fail-open catch below, skipping the write entirely. A record
    // now outlives Stop by design, so that turn would inherit the PREVIOUS turn's `shape` and the
    // status line would draw `basic shaping` and an estimated reduction for a turn on which this hook
    // emitted nothing at all — a savings claim for shaping that never happened, which is the exact
    // class of defect this record exists to prevent.
    //
    // Invalidating first makes that inheritance impossible: from this line on, the worst case is a
    // plain count. The success path records the real decision one await later, and the gap between
    // the two is the very start of a turn, before the model has produced any output.
    await invalidateShapingTurnRecord(scope, env);
    const decision = await decideShaping("claude-code", stdinText, env);
    await recordShapingOutcome(scope, decision.outcome, env);
    if (decision.stdout !== "") write(decision.stdout);
    // Non-shape outcomes (dormant/stopped, planning-hold, parse error) emit NOTHING: the prompt runs unchanged.
  } catch {
    // FAIL-OPEN: never propagate - the before-call hook must not break Claude Code.
  }
}

/**
 * Discover local Claude Code sessions (metadata only) and print, for each, the
 * ready-to-run `capture claude-code --session <path>` command (guided capture).
 *
 * Local and read-only: scans the projects directory only, makes no network call
 * and no upload, and never prints session message content - metadata only.
 */
export async function discoverClaudeCodeCommand(options: DiscoverClaudeCodeOptions): Promise<void> {
  // 1. Privacy / scope note (one line, consistent with capture warnings).
  console.log(DISCOVERY_PRIVACY_NOTE);
  console.log();

  const { projectsDir, projectsDirExists, sessions } = await discoverClaudeCodeSessions({
    projectsDir: options.projectsDir
  });

  console.log(`Scanning Claude Code projects directory: ${projectsDir}`);

  if (!projectsDirExists) {
    console.log("No Claude Code projects directory found at that path. Nothing to discover.");
    return;
  }

  if (sessions.length === 0) {
    console.log("No Claude Code sessions discovered.");
    return;
  }

  console.log(`Discovered ${sessions.length} session(s):`);
  console.log();

  for (const s of sessions) {
    const timestamp = s.lastTimestamp ?? s.firstTimestamp ?? "unknown";
    console.log(`- session: ${s.sessionId ?? "unknown"}`);
    console.log(`  project:        ${s.projectSlug}${s.projectDir ? ` (${s.projectDir})` : ""}`);
    console.log(`  timestamp:      ${timestamp}`);
    console.log(`  messages:       ${s.messageCount}`);
    console.log(`  subagents:      ${s.subagentCount}`);
    console.log(`  provider usage: ${s.providerReportedUsagePresent ? "present" : "absent"}`);
    console.log(`  run: compaction capture claude-code --session ${s.sessionPath}`);
    console.log();
  }

  console.log("Sessions are listed newest-first. Longer sessions (more messages / subagents) are the most");
  console.log("likely to contain avoidable repeated or stale tool output, so they tend to show the clearest");
  console.log("before/after delta; a short session may legitimately have little or nothing to compact.");
  console.log();
  console.log("Pick one session above and run its 'compaction capture claude-code --session <path>' command,");
  console.log("then run 'compaction spend' followed by 'compaction compact --eval' on the resulting");
  console.log("captured-trace.json (the strong flow: spend, then compaction + apply-readiness eval).");
}
