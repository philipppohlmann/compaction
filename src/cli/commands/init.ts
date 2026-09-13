import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import chalk from "chalk";
import { Command } from "commander";
import { defaultProjectsDir, discoverClaudeCodeSessions } from "../../core/adapters/claude-code-discovery.js";
import {
  connectClaudeCodeHook,
  connectClaudeCodeShapingHook,
  connectClaudeCodeStatusLine,
  disconnectClaudeCodeShapingHook,
  disconnectClaudeCodeStatusLine,
  claudeSettingsPathForScope,
  claudeSettingsReadPaths,
  isShapingHookInstalled,
  isStopHookInstalled,
  migrateProjectScopeClaudeSettings,
  type ConnectClaudeCodeResult,
  type ConnectShapingHookResult,
  type ConnectStatusLineResult
} from "../../core/claude-code-connect.js";
import { isShapingHooksActivated } from "../../core/output-shaping-hook-activation.js";
import {
  areSubscriptionHooksInstalled,
  installSubscriptionHooks,
  subscriptionHookConfigPath,
  subscriptionHookEntries,
  uninstallSubscriptionHooks,
  type SubscriptionHookInstallOutcome,
  type SubscriptionHookTool,
  type SubscriptionHookUninstallOutcome
} from "../../core/subscription-hooks-install.js";
import {
  CODEX_TRUST_ACTION_COMMAND,
  CODEX_TRUST_ACTION_CONTROL,
  CODEX_TRUST_ACTION_HEADING,
  codexShapingHookTrust
} from "../../core/codex-hook-trust.js";
import { isShapingTaskClassifierPresent } from "../../core/gateway/task-awareness-seam.js";
import { fullOptimizationReachable } from "../../core/engine-availability.js";
import {
  SHIM_TOOLS,
  installToolShim,
  uninstallToolShim,
  verifyShimActive,
  resolveExecutableOnPath,
  writeShellConfigPathLine,
  removeShellConfigPathLine,
  isShellConfigPathLinePresent,
  shellConfigWriteIsSupported,
  type ShimTool,
  type CaptureShimTool,
  type InstallShimResult,
  type WriteShellConfigResult
} from "../../core/tool-shim.js";
import {
  clearPendingConsent,
  isCarryableConsentWorkflow,
  recordPendingConsent,
  type CarryableConsentWorkflow
} from "../../core/pending-authorizations.js";
import { stopTransparentRoutingGateway } from "../../core/gateway/ensure.js";
import {
  resolveApplyRoutingActivation,
  APPLY_ROUTING_PROVIDER,
  type ApplyRoutingDecision
} from "../../core/gateway/apply-routing-activation.js";
import { isReceiptLineEnabled } from "../../core/gateway/receipt-line.js";
import {
  BRAND_HEX,
  VALUE_PROMISE,
  INSTALL_TAGLINE,
  STATUS_PILLS,
  PRIMARY,
  SECONDARY,
  FOOTER_LINES,
  ALL_WORKFLOW_KEYS,
  CONNECT_SURFACES,
  CONNECT_MENU,
  GATEWAY_INFRA_LINES,
  AFTER_CONNECT_LINE,
  MANUAL_TOOLS_LINE,
  deriveDiscovery,
  shortLabel,
  DISCOVERY_FOUND_LABEL,
  DISCOVERY_READ_ONLY_LINE,
  DISCOVERY_HEADER,
  OPTIMIZATION_MODES,
  OPTIMIZATION_MODE_HEADER,
  OPTIMIZATION_MODE_FOOTER,
  READY_HEADER,
  READY_TOOL_COPY,
  buildReadySummaryLines,
  deriveReadyRouting,
  type ConnectDetection,
  type WorkflowDiscovery,
  type OptimizationMode,
  type OptimizationModeKey,
  type ReadyToolKey,
  type EnableResult,
  type ReadyRoutingInputs
} from "../onboarding/model.js";
import { decideInteractiveTuiFromProcess } from "../onboarding/should-use-tui.js";
import { deriveReadyMetric, READY_METRIC_SURFACES, readyPerTurnLinesForTools, type ReadyMetric } from "../onboarding/ready-metrics.js";
import { readActivityEvents } from "../../core/activity-store.js";
import { buildActivityRows } from "../../core/activity-view.js";
import { getGatewayStatus } from "../../core/gateway/status.js";
import { READY_ROUTE_PROVIDER, type OnboardingReadyStatus } from "../onboarding/model.js";
import {
  ONBOARDING_AUTH_FALLBACK_LINES,
  FULL_APPLY_REQUIREMENT_LINE,
  isLocalFullApplyGateReason,
  onboardingAuthFailureLines,
  type OnboardingAuthOutcome,
  type OnboardingAuthProgress
} from "../onboarding/model.js";
import { runThroughGateway, ROUTE_COMMANDS, type RunThroughGatewayOptions } from "./dev.js";
import { computeCapabilityMatrix, deriveProviderCapabilities } from "../../core/gateway/capability-matrix.js";
import { ADAPTERS } from "../../core/gateway/provider-adapter.js";
import { liveVerificationsForMatrix } from "../../core/gateway/verification-store.js";
import { customAppGatewayRunLine } from "../onboarding/model.js";
import { planGatewayConfigure, formatConfigurePlan } from "../../core/gateway/configure.js";
import {
  isOptimizationModePreference,
  writeOptimizationMode,
  fromModelOptimizationModeKey,
  preferencesPath,
  addConnectedWorkflows,
  removeConnectedWorkflow,
  isConnectedRoutableWorkflow,
  OPTIMIZATION_MODE_PREFERENCE_LABELS,
  OPTIMIZATION_MODE_PREFERENCES,
  writeProductMode,
  type OptimizationModePreference
} from "../../core/onboarding-preferences.js";
import { applyModeSelection } from "./mode.js";
import { readStoredCredentials } from "../../core/auth/credentials.js";
import { performDeviceLogin, type DeviceLoginProgress } from "../../core/auth/device-login.js";
import { ensureCommunityRuntime, engineBlockedReason } from "../../core/entitlement/community-runtime.js";
import { openBrowser } from "./login.js";
import { proUrl } from "./pro.js";
import {
  AUTO_APPLY_ELIGIBILITY_GATES,
  authorizationStoreDirectory,
  disablePolicyPreference,
  readPolicyPreferences,
  savePolicyPreference
} from "../../core/policy-preferences.js";
import { DEDUPE_POLICY } from "../../core/gateway/request-shape.js";

/**
 * `compaction init`, first-run terminal onboarding.
 *
 * A real interactive terminal gets the Ink TUI chooser; everywhere else (pipes, CI, NO_COLOR,
 * dumb terminals, `--static`, `--path <focus>`) gets the byte-stable static screen. Both
 * surfaces share one model (`../onboarding/model`) so they always show the same workflows and
 * claim labels.
 *
 * Invariants on every default path (static and TUI): writes nothing, makes no network call,
 * reads no provider credential, needs no repo access. The TUI is a chooser, not an agent, no
 * text input, no model call, no upload. Only the explicit `--connect` / enable-consent paths
 * write. Claim boundaries (provider-reported vs local-estimate labels, no savings claim until
 * measured) live in the shared model's copy constants.
 */

// Brand accent. chalk.hex degrades gracefully: on a non-color / non-truecolor
// terminal chalk down-samples or no-ops, so the text is never lost.
const ACCENT = chalk.hex(BRAND_HEX);

// Spaced wordmark reads as a premium brand mark at any terminal width.
const WORDMARK = ACCENT.bold("C O M P A C T I O N");
const RULE = chalk.dim("─".repeat(58));

async function readPackageVersion(): Promise<string> {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    // dist/cli/commands -> dist -> package root
    const pkgPath = path.resolve(here, "..", "..", "..", "package.json");
    const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as { version?: string };
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

interface DetectionState {
  claudeDetected: boolean;
  sessionCount: number;
  projectsDir: string;
}

async function detectClaudeCode(projectsDir: string): Promise<DetectionState> {
  let claudeDetected = false;
  let sessionCount = 0;
  if (existsSync(projectsDir)) {
    try {
      const discovery = await discoverClaudeCodeSessions({ projectsDir });
      sessionCount = discovery.sessions.length;
      claudeDetected = sessionCount > 0;
    } catch {
      claudeDetected = false; // detection is best-effort; onboarding never fails on it
    }
  }
  return { claudeDetected, sessionCount, projectsDir };
}

// ---------------------------------------------------------------------------
// Static screen (the universal fallback). Output is intentionally byte-stable:
// scripts, snapshots, and smoke tests depend on it.
// ---------------------------------------------------------------------------

function header(text: string): string {
  return chalk.bold(text);
}

function footerBlock(): string[] {
  return FOOTER_LINES.map((l) => chalk.dim(l));
}

/**
 * The static (non-TTY / `--static`) first screen, the same connect-once model as the TUI:
 * detection + status + the named "Enable Compaction for" commands
 * (nothing is written until the user runs it). A `--path` focus adds that surface's one manual
 * capture/import command.
 */
function buildStaticScreen(version: string, focus: string | undefined, detection: ConnectDetection): string {
  const lines: string[] = [];

  // 1. Wordmark + tagline + status + install promise.
  lines.push("");
  lines.push(`  ${WORDMARK}`);
  lines.push(`  ${chalk.dim(`compaction - ${INSTALL_TAGLINE}`)}`);
  lines.push("");
  lines.push(`  ${chalk.dim(`v${version} · ${STATUS_PILLS.join(" · ")}`)}`);
  lines.push("");
  lines.push(`  ${VALUE_PROMISE}`);
  lines.push("");
  lines.push(RULE);
  lines.push("");

  // 2. Detection + the connect-once menu (the install-once experience).
  lines.push(...connectDetectionBlock(detection));
  lines.push("");
  lines.push(...connectMenuBlock());
  lines.push("");
  lines.push(chalk.dim("  Nothing is written until you run one of these commands."));
  lines.push("");

  // 3. Gateway as the underlying byte-safe routing layer (infra, not a peer card).
  for (const [i, l] of GATEWAY_INFRA_LINES.entries()) {
    lines.push(i === 0 ? chalk.dim(`  ${l}`) : `  ${ACCENT(l.trim())}`);
  }
  lines.push("");
  lines.push(`  ${chalk.dim(AFTER_CONNECT_LINE)}`);
  lines.push(`  ${chalk.dim(MANUAL_TOOLS_LINE)}`);

  // 3b. Optimization mode (Page 3) - the two honest context-handling modes + exact commands (informational).
  lines.push("");
  lines.push(...optimizationModeBlock());

  // Optional --path focus: the one manual capture/import command for that surface.
  if (focus) {
    const p = focus === "claude-code" ? PRIMARY : SECONDARY.find((s) => s.key === focus);
    if (p) {
      lines.push("");
      lines.push(header(`Manual: ${p.title}`));
      lines.push(`    ${ACCENT(p.command)}`);
    }
  }

  lines.push("");
  lines.push(RULE);
  lines.push("");

  // 4. What connect does + local-first footer.
  lines.push(...activationCopyBlock());
  lines.push("");
  lines.push(...footerBlock());
  lines.push("");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Connect-once menu. Invariant: "connected" is only ever claimed on a verified write -
// Claude Code installs the merge-not-replace Stop hook and re-reads the settings file;
// Codex/Cursor install reversible PATH shims and count as connected only after resolution
// verifies them. The browser is detection-only; Compaction never scans Chrome profiles.
// ---------------------------------------------------------------------------

type ConnectChoice = "claude-code" | "codex" | "cursor" | "all" | "skip";

/** Human labels + the honest per-tool token-source line shown in the capture-shim connect block. */
const SHIM_TOOL_LABELS: Record<CaptureShimTool, { title: string; connectName: string; measurableForm: string; tokenNote: string }> = {
  codex: {
    title: "Codex",
    connectName: "codex",
    measurableForm: "codex exec --json",
    tokenNote: "provider-reported tokens (codex exec --json turn.completed.usage) - NOT billing-confirmed"
  },
  cursor: {
    title: "Cursor",
    connectName: "cursor",
    measurableForm: "cursor-agent … --output-format json",
    tokenNote: "LOCAL-ESTIMATE tokens only because Compaction does not ingest Cursor's conditional result.usage - never provider-reported; output unavailable when the result is not separable"
  }
};

/**
 * The honest "what happens to invocations outside the measurable batch form" line, per tool. Codex's
 * PATH shim is a GATEWAY-ROUTE (`kind: "gateway-route"`, `src/core/tool-shim.ts`): EVERY normal
 * invocation, interactive included, is routed through the local Gateway. Receipt evidence is shown
 * only when a settled artifact exists -
 * UNLESS Compaction detects the user's OWN route already declared (an env override; an argv
 * `-c`/`--config`, selected profile, or local-provider flag; a top-level `model_provider` already set
 * in the base or selected profile config; or an OpenAI API key present), in which case that run falls
 * back to the same measurable-batch-form-only capture Cursor always uses and is NOT measured. Cursor
 * has no Gateway route at all, so its line never changes.
 */
export function interactiveInvocationsLine(tool: CaptureShimTool, shimName: string): string {
  if (tool === "codex") {
    return `Every other ${shimName} invocation - interactive included - also routes through the local Gateway unless Compaction detects your own model-provider route (env, -c/--config, -p/--profile, --oss/--local-provider, or Codex config) or an OpenAI API key already configured, in which case it passes through untouched. Settled receipt evidence is shown only when recorded; nothing is inferred for a request without one.`;
  }
  return `Interactive / other ${shimName} invocations pass through untouched and are NOT measured (never faked).`;
}

const CONNECT_ALIASES: Record<string, ConnectChoice> = {
  "1": "claude-code",
  "2": "codex",
  "3": "cursor",
  "4": "all",
  "5": "skip",
  "claude-code": "claude-code",
  codex: "codex",
  cursor: "cursor",
  all: "all",
  skip: "skip"
};

/** The connect note (right-hand "→ …" text) for a surface, from the shared model. */
function connectNoteFor(key: string): string {
  return CONNECT_SURFACES.find((s) => s.key === key)?.connectNote ?? "";
}

function detectRow(sym: string, title: string, status: string, note: string, color: "green" | "yellow" | "dim"): string {
  const paint = color === "green" ? chalk.green : color === "yellow" ? chalk.yellow : chalk.dim;
  return `    ${paint(sym)} ${title.padEnd(14)} ${status.padEnd(30)} ${chalk.dim(`→ ${note}`)}`;
}

/**
 * One discovery row. The state word comes from the shared model (`shortLabel`); `found` never
 * implies active. Colour: green = ready, yellow = found (enable available), dim = not found.
 */
function discoveryRow(w: WorkflowDiscovery): string {
  const sym = w.state === "not-found" ? "[ ]" : "[x]";
  const color: "green" | "yellow" | "dim" = w.state === "ready" ? "green" : w.state === "found" ? "yellow" : "dim";
  const label = shortLabel(w.state, DISCOVERY_FOUND_LABEL[w.key]);
  return detectRow(sym, w.title, label, connectNoteFor(w.key), color);
}

/**
 * The "Found on this machine:" block. Rows come from `deriveDiscovery`; `ready` requires a
 * verified hook/shim, never mere session discovery. Strictly read-only, nothing is written
 * until an explicit enable/connect.
 */
function connectDetectionBlock(detection: ConnectDetection): string[] {
  return [
    header(DISCOVERY_HEADER),
    "",
    chalk.dim(`  ${DISCOVERY_READ_ONLY_LINE}`),
    "",
    ...deriveDiscovery(detection).map(discoveryRow),
    "",
    chalk.dim("  Codex and Cursor enable via a reversible Compaction-owned PATH shim (verified by resolving the tool name)."),
    chalk.dim("  Custom OpenAI-compatible apps: use the Gateway below (Advanced). Compaction never scans your browser.")
  ];
}

function connectMenuBlock(): string[] {
  return [
    header("Enable Compaction for:"),
    "",
    ...CONNECT_MENU.map((m) => `    ${ACCENT(m.command)}   ${chalk.dim(`# ${m.label}`)}`)
  ];
}

/**
 * Optimization-mode section - informational on both surfaces; rendering it writes nothing.
 * The modes map to existing capabilities (record+proof / deterministic apply); running the
 * Mode-2 command is the explicit consent that stores narrow authorization.
 */
function optimizationModeRow(m: OptimizationMode, i: number): string[] {
  const tag = m.recommended ? chalk.green("  (recommended · default)") : chalk.dim("  (opt-in)");
  // INPUT axis, stated as such. "model-visible bytes changed: no" was an axis error: output shaping
  // attaches an instruction to what the model sees on both modes, so only the input claim is true.
  const inputAxis = m.meaning.inputBytesChanged
    ? "your input is compacted before sending: yes (deterministic dedupe)"
    : "your input is compacted or edited: no";
  const approval = m.meaning.approvalRequired ? "approval required: yes" : "approval required: no";
  return [
    `    ${chalk.bold(`[${i + 1}] ${m.title}`)}${tag}`,
    `        ${m.oneLine}`,
    `        ${chalk.dim(`${inputAxis}   ·   ${approval}`)}`,
    ...m.meaning.mapsTo.map((l) => `        ${chalk.dim(l)}`),
    `        ${chalk.dim("Run:")}  ${ACCENT(m.command)}`
  ];
}

function optimizationModeBlock(): string[] {
  const lines: string[] = [header(OPTIMIZATION_MODE_HEADER), ""];
  for (const [i, m] of OPTIMIZATION_MODES.entries()) {
    lines.push(...optimizationModeRow(m, i), "");
  }
  lines.push(chalk.dim(`  ${OPTIMIZATION_MODE_FOOTER}`));
  return lines;
}

function shimInstallVerified(result: InstallShimResult): boolean {
  return result.status === "installed-active" || result.status === "already-active" || result.status === "installed-not-on-path";
}

function shellConfigStatusLine(result: WriteShellConfigResult): string {
  return result.status === "already-present"
    ? `    PATH: already set up - your shell config (${result.rcPath}) already carries the Compaction PATH line.`
    : `    PATH: added to your shell config - wrote ${result.rcPath}` +
        (result.backupPath ? ` (backup: ${result.backupPath}).` : " (new file; no backup needed).");
}

function shellConfigWriteFailureLines(exportLine: string): string[] {
  return [
    chalk.yellow("    PATH persistence: your shell config could not be updated. This shell remains active."),
    chalk.dim("    To keep Compaction active in future shells, add this ONE line yourself:"),
    `      ${ACCENT(exportLine)}`
  ];
}

function shellConfigOptOutLines(exportLine: string, unsupportedShell?: string): string[] {
  return [
    chalk.dim("    PATH persistence: --no-write-shell-config left your shell config untouched. This shell remains active."),
    unsupportedShell === undefined
      ? chalk.dim("    To keep Compaction active in future shells, add this ONE line yourself:")
      : chalk.dim(
          `    To keep Compaction active in future shells, add an equivalent PATH entry using ${unsupportedShell} syntax (the line below is POSIX shell syntax):`
        ),
    `      ${ACCENT(exportLine)}`
  ];
}

function unsupportedShellConfigLines(shell: string, exportLine: string): string[] {
  return [
    chalk.dim(`    PATH persistence: Compaction only edits zsh and bash startup files, and your shell is ${shell}, so nothing was written. This shell remains active.`),
    chalk.dim("    To keep Compaction active in future shells, add an equivalent PATH entry in your shell's syntax (the line below is POSIX shell syntax):"),
    `      ${ACCENT(exportLine)}`
  ];
}

function activeShellConfigLines(
  exportLine: string,
  state: { rc?: WriteShellConfigResult; writeFailed?: boolean; optedOut: boolean; unsupportedShell?: string }
): string[] {
  if (state.rc && !state.optedOut) return [chalk.green(shellConfigStatusLine(state.rc))];
  if (state.writeFailed) return shellConfigWriteFailureLines(exportLine);
  if (state.optedOut) return shellConfigOptOutLines(exportLine, state.unsupportedShell);
  if (state.unsupportedShell !== undefined) return unsupportedShellConfigLines(state.unsupportedShell, exportLine);
  return [];
}

function pendingShellConfigLines(
  state: { optedOut: boolean; writeFailed?: boolean; unsupportedShell?: string }
): string[] {
  const reason = state.optedOut
    ? "--no-write-shell-config: your shell config was NOT touched."
    : state.unsupportedShell !== undefined
      ? `Compaction only edits zsh and bash startup files, and your shell is ${state.unsupportedShell}, so nothing was written.`
      : state.writeFailed
        ? "Your shell config could not be updated."
        : "Your shell config was not updated.";
  return [
    chalk.dim(`    ${reason}`),
    state.unsupportedShell === undefined
      ? chalk.dim("    Add this ONE line yourself, then re-run to verify:")
      : chalk.dim(`    Add an equivalent PATH entry using ${state.unsupportedShell} syntax (the line below is POSIX shell syntax), then re-run to verify:`)
  ];
}

/**
 * The Codex/Cursor PATH-shim install-result block. Claims "connected" only when the shim is
 * verified active on PATH; installed-but-not-on-PATH prints the one export line and "not yet
 * active". "Measured automatically" is scoped to the measurable batch form. The real binary is
 * never replaced.
 */
function shimConnectBlock(
  result: InstallShimResult,
  wroteShellConfig?: WriteShellConfigResult,
  optedOut = false,
  /** The user's `$SHELL` when Compaction cannot write a startup file it will load; undefined otherwise. */
  unsupportedShell?: string,
  shellConfigWriteFailed = false
): string[] {
  const meta = SHIM_TOOL_LABELS[result.tool as CaptureShimTool];
  const title = meta.title;

  if (result.status === "installed-active" || result.status === "already-active") {
    const lines = [
      `  ${chalk.bold("▸ " + title)} ${chalk.green("- connected")}`,
      "",
      chalk.green(`    Compaction is now active for ${title} (PATH shim: ${result.shimPath} → real ${result.shimName}: ${result.realBin ?? "recorded"}).`),
      ...activeShellConfigLines(result.exportLine, {
        optedOut,
        ...(wroteShellConfig ? { rc: wroteShellConfig } : {}),
        ...(shellConfigWriteFailed ? { writeFailed: true } : {}),
        ...(unsupportedShell !== undefined ? { unsupportedShell } : {})
      }),
      result.tool === "codex"
        ? `    From now on, ${chalk.bold(meta.measurableForm)} runs route automatically - recorded evidence needs no manual import.`
        : `    From now on, ${chalk.bold(meta.measurableForm)} runs are measured automatically - no manual import needed.`,
      chalk.dim(`    ${interactiveInvocationsLine(result.tool as CaptureShimTool, result.shimName)}`),
      chalk.dim(`    Token source: ${meta.tokenNote}.`),
      chalk.dim("    Metrics-only; no prompt or response content is stored or uploaded."),
      "",
      chalk.dim("    See your runs anytime:  compaction activity"),
      chalk.dim(`    Fallback/debug (per-invocation, not needed once connected):  compaction run ${result.tool} -- <cmd>`),
      chalk.dim(`    Disconnect (reversible):  compaction init --disconnect ${meta.connectName}`)
    ];
    return lines;
  }

  if (result.status === "installed-not-on-path") {
    const resolved = result.verification.resolvedPath;
    if (wroteShellConfig && !optedOut) {
      // DEFAULT PATH: the rc line was written (or was already there). Set-up is COMPLETE - the only
      // thing left is a new shell, which is not a command the user has to discover. Announce exactly
      // what was written and where the backup is, and never claim this shell is routed. Deliberately
      // NO "then re-run `compaction init --connect N` to verify" step: a second Compaction command is
      // a hidden second set-up, and there is nothing left to set up.
      return [
        `  ${chalk.bold("▸ " + title)} ${chalk.green("- installed; active in new shells")}`,
        "",
        chalk.green(`    The shim is installed at ${result.shimPath}.`),
        chalk.green(shellConfigStatusLine(wroteShellConfig)),
        `      ${ACCENT(result.exportLine)}`,
        `    Open a NEW shell (or \`source ${wroteShellConfig.rcPath}\`) - from then on ${chalk.bold(meta.measurableForm)} runs`,
        result.tool === "codex"
          ? "    route automatically; only recorded evidence is reported. No manual steps."
          : "    are measured automatically. No manual steps.",
        chalk.dim(`    ${interactiveInvocationsLine(result.tool as CaptureShimTool, result.shimName)}`),
        chalk.dim(`    This shell still resolves \`${result.shimName}\` to ${resolved ?? "the real binary"}; nothing is captured here until a new shell picks up the PATH.`),
        chalk.dim("    Metrics-only; no prompt or response content is stored or uploaded."),
        chalk.dim(`    Manage PATH yourself instead?  compaction init --connect ${meta.connectName} --no-write-shell-config`),
        "",
        chalk.dim("    See your runs anytime:  compaction activity"),
        chalk.dim(`    Disconnect (reversible):  compaction init --disconnect ${meta.connectName}`)
      ];
    }
    return [
      `  ${chalk.bold("▸ " + title)} ${chalk.yellow("- installed, NOT yet active")}`,
      "",
      chalk.yellow(`    The shim is installed at ${result.shimPath}, but its directory is not on your PATH yet,`),
      chalk.yellow(`    so \`${result.shimName}\` still resolves to ${resolved ?? "the real binary"} - NOT the shim.`),
      ...pendingShellConfigLines({
        optedOut,
        writeFailed: shellConfigWriteFailed,
        ...(unsupportedShell !== undefined ? { unsupportedShell } : {})
      }),
      `      ${ACCENT(result.exportLine)}`,
      `      ${ACCENT(`compaction init --connect ${meta.connectName}`)}`
    ];
  }

  if (result.status === "no-real-binary") {
    return [
      `  ${chalk.bold("▸ " + title)} ${chalk.dim("- not found")}`,
      "",
      chalk.dim(`    No \`${result.shimName}\` binary was found on your PATH, so there is nothing to measure yet.`),
      chalk.dim(`    Install ${title} first, then re-run \`compaction init --connect ${meta.connectName}\`. Nothing was written.`)
    ];
  }

  // verify-failed, NEVER claim connected.
  return [
    `  ${chalk.bold("▸ " + title)} ${chalk.red("- NOT connected")}`,
    "",
    chalk.red(`    A shim write to ${result.shimPath} was attempted but re-reading it did not confirm the shim.`),
    "    Nothing is claimed connected. Check permissions on the Compaction shim directory and re-run."
  ];
}

/**
 * What `--connect 2|3 --dry-run` shows instead of an install result: the two writes that were skipped,
 * named. The counterpart of the Claude Code branch's `--dry-run` line, and the reason this branch can
 * honestly stand behind the flag's "write nothing" promise - which previously it could not, because it
 * installed the shim AND (once the rc line became the default) edited the user's shell startup file.
 */
function shimDryRunBlock(tool: ShimTool): string[] {
  const meta = SHIM_TOOL_LABELS[tool as CaptureShimTool];
  return [
    `  ${chalk.bold("▸ " + meta.title)} ${chalk.dim("- dry run")}`,
    "",
    chalk.dim("    --dry-run: nothing was written. Without it this would install the shim into your"),
    chalk.dim("    Compaction shim directory and append the PATH line to your zsh/bash startup file (backed up first)."),
    chalk.dim(`    Run it for real:  compaction init --connect ${meta.connectName}`)
  ];
}

/**
 * The honest apply-routing posture line for the Claude Code routing blocks, rendered from the SAME
 * resolver the runtime consults (`resolveApplyRoutingActivation`) so the copy can never diverge from
 * what the next `claude` run actually does. Passing the already-resolved decision (rather than
 * resolving here) lets the caller resolve it AFTER this run's connect/mode writes have landed, so the
 * posture describes the state the NEXT `claude` run will read.
 *
 *  - APPLY ENGAGED (every guard satisfied): state honestly that the request is compacted before the
 *    call (deterministic dedupe of exact-duplicate blocks), the original is retained locally and
 *    recoverable, the response is forwarded byte-for-byte, and it is reversible with `compaction stop`.
 *    No "next increment" framing; no magnitude / net-billed / savings claim (the per-turn receipt line's
 *    `(est)` caveat is the only place magnitude is expressed).
 *  - DORMANT (any guard missing): the byte-safe RECORD posture - request and response forwarded
 *    byte-for-byte, nothing the model sees is mutated in THIS posture - AND the honest note that apply
 *    engages only under the explicit guards (API key + Cache + context mode + a stored claude-code
 *    authorization). The resolver's reason names the specific missing guard so the user knows what would
 *    turn apply on. No blanket "nothing is EVER mutated / cache+context is the next increment" claim.
 */
function claudeRoutingPostureLines(decision: ApplyRoutingDecision): string[] {
  if (decision.engage) {
    return [
      "    Apply mode is ON for your next `claude` run: your request is compacted before the call (deterministic dedupe of",
      "    exact-duplicate blocks); the original is retained locally and recoverable; the response is forwarded byte-for-byte.",
      chalk.dim("    Start a new `claude` session for this to take effect - an already-running session keeps its original route until restarted."),
      chalk.dim("    Reversible any time:  compaction stop  (record-only, no mutation).")
    ];
  }
  return [
    "    RECORD mode: request and response are forwarded byte-for-byte - nothing the model sees is mutated in this posture.",
    chalk.dim(`    Apply mode (compacting the request before the call) engages only under the explicit guards: an API key + the`),
    chalk.dim(`    Full optimization mode + a stored claude-code authorization. Not engaged now - ${decision.reason}.`)
  ];
}

/**
 * Resolve the apply-routing posture for the Claude Code routing blocks using the runtime resolver.
 * Never throws: the resolver itself fail-closes to a dormant decision on any error, and this wrapper
 * defaults `provider`/`cwd` exactly as the runtime `gateway ensure` path does (env defaults to
 * process.env inside the resolver). Call this AFTER this run's connect/mode writes so the posture
 * reflects what the next `claude` run will read.
 */
async function resolveClaudeRoutingPosture(): Promise<ApplyRoutingDecision> {
  return resolveApplyRoutingActivation({ provider: APPLY_ROUTING_PROVIDER, cwd: process.cwd() });
}

/** The shared "runs continuously / stop anytime" closing lines for the Claude Code routing blocks. */
function claudeContinuousStopLines(): string[] {
  return [
    chalk.dim("    Compaction runs continuously until you stop it:  compaction gateway stop   ·   Disconnect (removes the shim + the PATH line it wrote):  compaction init --disconnect claude-code"),
    chalk.dim("    See routed traffic:  compaction gateway status")
  ];
}

/**
 * The Claude Code transparent-routing shim install-result block (RECORD-only; fail-open). Claims
 * "routing active" only when the shim is verified active on PATH (same resolve-verification bar as
 * the capture shims); an rc write is announced with the file + backup path and never claimed as
 * current-shell activation. The Stop hook block above it remains the measurement surface; this shim
 * adds byte-safe gateway routing for normal `claude` runs - it never mutates a request.
 */
function claudeRoutingShimBlock(
  result: InstallShimResult,
  posture: ApplyRoutingDecision,
  shellConfig?: { optedOut: boolean; rc?: WriteShellConfigResult; writeFailed?: boolean; unsupportedShell?: string }
): string[] {
  if (result.status === "installed-active" || result.status === "already-active") {
    const rc = shellConfig?.rc;
    return [
      `  ${chalk.bold("▸ Claude Code routing")} ${chalk.green("- active")}`,
      "",
      chalk.green("    You're set - just use `claude` normally. Runs are routed through the local Compaction gateway and captured automatically and continuously."),
      chalk.green(`    PATH: on-PATH ✓ - \`claude\` resolves to the Compaction shim (${result.shimPath} → real claude: ${result.realBin ?? "recorded"}).`),
      ...activeShellConfigLines(result.exportLine, {
        optedOut: shellConfig?.optedOut ?? false,
        ...(rc ? { rc } : {}),
        ...(shellConfig?.writeFailed ? { writeFailed: true } : {}),
        ...(shellConfig?.unsupportedShell !== undefined ? { unsupportedShell: shellConfig.unsupportedShell } : {})
      }),
      ...claudeRoutingPostureLines(posture),
      chalk.dim("    Your credential (API key or saved login) rides through to Anthropic untouched - never read, stored, or logged."),
      chalk.dim("    Fail-open: if the gateway cannot start or answer, `claude` runs unchanged. Receipts are content-free (token/cache counts only)."),
      "",
      ...claudeContinuousStopLines()
    ];
  }

  if (result.status === "installed-not-on-path") {
    const resolved = result.verification.resolvedPath;
    const rc = shellConfig?.rc;
    if (rc && !shellConfig?.optedOut) {
      // Default path: the PATH line was written (or already present) - announce exactly what was
      // written and where the backup is; routing activates in NEW shells (this one is unchanged).
      return [
        `  ${chalk.bold("▸ Claude Code routing")} ${chalk.green("- installed; active in new shells")}`,
        "",
        chalk.green(`    The routing shim is installed at ${result.shimPath}.`),
        chalk.green(shellConfigStatusLine(rc)),
        `      ${ACCENT(rc.exportLine)}`,
        `    Open a NEW shell (or \`source ${rc.rcPath}\`) - from then on normal \`claude\` runs are`,
        "    routed through the local Compaction gateway and captured automatically and continuously. No manual steps.",
        ...claudeRoutingPostureLines(posture),
        chalk.dim(`    This shell still resolves \`claude\` to ${resolved ?? "the real binary"}; nothing is routed here until a new shell picks up the PATH.`),
        chalk.dim("    Manage PATH yourself instead?  compaction init --connect claude-code --no-write-shell-config"),
        "",
        ...claudeContinuousStopLines()
      ];
    }
    return [
      `  ${chalk.bold("▸ Claude Code routing")} ${chalk.yellow("- installed, NOT yet active")}`,
      "",
      chalk.yellow(`    The routing shim is installed at ${result.shimPath}, but its directory is not on your PATH yet,`),
      chalk.yellow(`    so \`claude\` still resolves to ${resolved ?? "the real binary"} - NOT the shim (nothing is routed).`),
      ...pendingShellConfigLines(shellConfig ?? { optedOut: false }),
      `      ${ACCENT(result.exportLine)}`,
      `      ${ACCENT("compaction init --connect claude-code")}`
    ];
  }

  if (result.status === "no-real-binary") {
    return [
      `  ${chalk.bold("▸ Claude Code routing")} ${chalk.dim("- skipped (no claude binary found on PATH)")}`,
      "",
      chalk.dim("    No `claude` binary was found on your PATH, so no routing shim was written. The consented"),
      chalk.dim("    Stop hook above still measures sessions. Re-run `compaction init --connect claude-code` once the claude CLI is available.")
    ];
  }

  // verify-failed - NEVER claim active.
  return [
    `  ${chalk.bold("▸ Claude Code routing")} ${chalk.red("- NOT active")}`,
    "",
    chalk.red(`    A shim write to ${result.shimPath} was attempted but re-reading it did not confirm the shim.`),
    "    Nothing is claimed active; no `claude` run is routed. Check permissions on the Compaction shim directory and re-run."
  ];
}

/**
 * READ-ONLY Claude Code routing status for the already-connected path (counted-ready re-runs write
 * nothing). Same resolve-verification bar: "active" only when `claude` resolves to our shim; an
 * installed-but-inactive shim shows its honest PATH status and the exact next step.
 */
function claudeRoutingStatusBlock(posture: ApplyRoutingDecision): string[] {
  const v = verifyShimActive("claude-code");
  if (v.active) {
    return [
      `  ${chalk.bold("▸ Claude Code routing")} ${chalk.green("- active")}`,
      "",
      chalk.green("    You're set - just use `claude` normally. Runs are routed through the local Compaction gateway and captured automatically and continuously."),
      chalk.green(`    PATH: on-PATH ✓ - \`claude\` resolves to the Compaction shim (${v.shimPath}).`),
      ...claudeRoutingPostureLines(posture),
      chalk.dim("    Your credential (API key or saved login) rides through to Anthropic untouched - never read, stored, or logged."),
      chalk.dim("    Fail-open: if the gateway cannot start or answer, `claude` runs unchanged. Receipts are content-free (token/cache counts only)."),
      "",
      ...claudeContinuousStopLines()
    ];
  }
  if (v.installed) {
    const configured = isShellConfigPathLinePresent();
    return [
      `  ${chalk.bold("▸ Claude Code routing")} ${chalk.yellow(configured ? "- installed; active in new shells" : "- installed, NOT yet active")}`,
      "",
      configured
        ? chalk.green("    PATH: your shell config carries the Compaction PATH line - open a NEW shell and normal `claude` runs are routed through the local Compaction gateway and captured automatically and continuously.")
        : chalk.yellow("    PATH: not set up - add this ONE line to your shell config, then re-run to verify:"),
      ...(configured
        ? claudeRoutingPostureLines(posture)
        : [`      ${ACCENT(v.exportLine)}`, `      ${ACCENT("compaction init --connect claude-code")}`]),
      "",
      ...claudeContinuousStopLines()
    ];
  }
  return [
    `  ${chalk.bold("▸ Claude Code routing")} ${chalk.yellow("- not installed")}`,
    "",
    chalk.yellow("    The transparent routing shim is not installed, so normal `claude` runs are not captured continuously."),
    `    Install it (reversible):  ${ACCENT("compaction init --connect claude-code")}`
  ];
}

/**
 * Self-heal: when Claude Code routing is present but this run did NOT go through the enable branch
 * that wires the status line (an already-routed re-run, or routing installed by an older build that
 * predated the status line), register the per-turn VISIBLE status line so a routed Claude Code is
 * never silent. This is the ONLY per-turn visible surface (the Stop hook records receipts but its
 * stdout is invisible in Claude Code).
 *
 * Consent + safety, identical to the enable path:
 *  - Runs ONLY inside an explicit user action (`compaction init` / onboarding / connect) - never from
 *    a transparent per-run shim or `gateway ensure` (those never write settings).
 *  - Additive + single-slot-safe: `connectClaudeCodeStatusLine` NEVER clobbers a user's own status
 *    line (`user-owned` is guidance, not a failure); idempotent (`already-present` when it is ours).
 *  - Honors the `COMPACTION_RECEIPT_LINE=0` kill switch exactly as `compaction statusline` does:
 *    when the line is silenced, nothing is wired and nothing is claimed.
 *  - FAIL-OPEN + display-only: any failure returns no lines and NEVER un-connects routing.
 *
 * Returns the render lines to append (empty when routing is absent, the kill switch is set, or the
 * write fails) so callers just spread the result. Never throws.
 */
async function ensureRoutedClaudeStatusLine(options: ConnectRunOptions): Promise<string[]> {
  try {
    if (!verifyShimActive("claude-code").installed) return []; // no routing → nothing to self-heal.
    const settingsPath = claudeSettingsPathForScope(options.project ? "project" : "user");
    const lines: string[] = [];
    // Per-turn VISIBLE surface (honors the receipt-line kill switch: silence → wire nothing).
    if (isReceiptLineEnabled()) {
      const statusLine = await connectClaudeCodeStatusLine({ settingsPath, ...(options.dryRun ? { dryRun: true } : {}) });
      lines.push(...claudeStatusLineBlock(statusLine));
    }
    // SUBSCRIPTION apply lever: an already-routed Claude Code (or one connected by a build that predated
    // shaping) must not be left un-shaped. Self-heal the before-call SHAPING hook when shaping is globally
    // enabled. Additive + idempotent + fail-open: a failure never un-connects anything.
    if (isShapingHooksActivated()) {
      try {
        const shaping = await connectClaudeCodeShapingHook({ settingsPath, ...(options.dryRun ? { dryRun: true } : {}) });
        lines.push(...claudeShapingHookBlock(shaping, await isShapingTaskClassifierPresent()));
      } catch {
        /* fail-open: display-only self-heal; never break the already-connected surface */
      }
    }
    // MIGRATION on the ALREADY-CONNECTED path too. Migration used to run only when connect ENABLED a
    // tool, but a user who is already globally connected takes this self-heal branch instead — so
    // running connect inside an old project-local install left Compaction's hooks in BOTH scopes
    // forever. Claude Code merges hooks additively, so that is a permanent double capture and double
    // shaping, hidden behind the single-slot status line. Found by a real fresh-install acceptance,
    // not by a unit test.
    if (!options.project) {
      try {
        const migrated = await migrateProjectScopeClaudeSettings({ ...(options.dryRun ? { dryRun: true } : {}) });
        if (migrated.cleaned.length > 0) {
          lines.push(
            options.dryRun
              ? `    Would migrate ${migrated.removedHooks} project-local Compaction hook entr${migrated.removedHooks === 1 ? "y" : "ies"} into the global install (preview - nothing written).`
              : `    Migrated ${migrated.removedHooks} project-local Compaction hook entr${migrated.removedHooks === 1 ? "y" : "ies"} into the global install (one integration, no double shaping).`
          );
        }
      } catch {
        /* fail-open: a migration failure never un-connects the global install */
      }
    }
    return lines;
  } catch {
    return []; // display-only: a failure never breaks the already-connected surface.
  }
}

/** The reversible disconnect block for a Codex/Cursor shim. */
function shimDisconnectBlock(tool: CaptureShimTool, removed: boolean, shimPath: string, rc?: { status: string; rcPath: string; backupRestored?: string }): string[] {
  const meta = SHIM_TOOL_LABELS[tool];
  const lines = [
    `  ${chalk.bold("▸ " + meta.title)} ${chalk.green("- disconnected")}`,
    "",
    removed
      ? chalk.green(`    Removed the ${meta.title} shim (${shimPath}). The real ${SHIM_TOOLS[tool].shimName} binary was never touched.`)
      : chalk.dim(`    No ${meta.title} shim was installed (${shimPath}); nothing to remove.`)
  ];
  if (rc && rc.status === "removed") {
    lines.push(
      chalk.green(
        `    Reverted the shell-rc PATH line in ${rc.rcPath}` + (rc.backupRestored ? ` (restored from ${rc.backupRestored}).` : ".")
      )
    );
  }
  lines.push(chalk.dim("    Open a new shell so the PATH change takes effect."));
  return lines;
}

/**
 * The hook-removal half of a Codex/Cursor disconnect. Printed with the shim block so "disconnected"
 * is a complete statement: the word must never stand alone while a model-visible hook keeps firing.
 */
function subscriptionHooksDisconnectBlock(result: SubscriptionHookUninstallOutcome): string[] {
  if (result.status === "removed") {
    return [
      chalk.green(`    Removed ${result.removedCount} Compaction hook entr(y/ies) from ${result.file} - output shaping is off for ${result.tool}.`),
      chalk.dim(`    Other hooks in that file are preserved.${result.backupPath ? ` Backup: ${result.backupPath}` : ""}`)
    ];
  }
  if (result.status === "not-present" || result.status === "no-config") {
    return [chalk.dim(`    No Compaction hook was installed in ${result.file}; nothing to remove.`)];
  }
  // error - NEVER let "disconnected" imply the hook is gone when it is not.
  return [
    chalk.yellow(`    Could not remove the Compaction hook from ${result.file} (${result.error ?? "unknown error"}).`),
    chalk.yellow(`    Output shaping may still run for ${result.tool}. Remove it with:  compaction hooks uninstall --tool ${result.tool}`)
  ];
}

function skipBlock(): string[] {
  return [
    header("Skipped"),
    "",
    chalk.dim("  Nothing was installed or changed. Run `compaction init --connect claude-code` anytime to"),
    chalk.dim("  connect Claude Code, or `compaction hooks install` to install the Stop hook directly.")
  ];
}

/**
 * The Claude Code install-result block. Says "now active" only when a re-read verified the hook
 * landed; a failed/unverified install never claims connected and prints the one manual command
 * instead. Scope (project vs user) is stated explicitly.
 */
function claudeInstallBlock(result: ConnectClaudeCodeResult, user: boolean): string[] {
  const scopeParenthetical = user ? "all your projects" : "this project";
  const scopeSuffix = user ? "in any project" : "in this project";
  const manualCmd = `compaction hooks install${user ? " --user" : ""}`;

  if (result.status === "installed" || result.status === "already-present") {
    const headline =
      result.status === "already-present"
        ? `    Compaction is already active for Claude Code (${scopeParenthetical}: ${result.settingsPath}).`
        : `    Compaction is now active for Claude Code (${scopeParenthetical}: ${result.settingsPath}).`;
    return [
      `  ${chalk.bold("▸ Claude Code")} ${chalk.green("- connected")}`,
      "",
      chalk.green(headline),
      `    From now on, supported Claude Code sessions ${scopeSuffix} are measured automatically -`,
      "    no manual import needed. Reload Claude Code once (open /hooks or restart) to load the hook.",
      chalk.dim("    Metrics-only; no prompt or response content is stored or uploaded."),
      "",
      chalk.dim("    See your runs anytime:  compaction activity")
    ];
  }

  if (result.status === "dry-run") {
    return [
      `  ${chalk.bold("▸ Claude Code")} ${chalk.yellow("- dry run (nothing written)")}`,
      "",
      chalk.yellow(`    --dry-run: the hook was NOT installed. It would be merged into ${result.settingsPath}:`),
      chalk.dim(JSON.stringify(result.wouldWrite ?? {}, null, 2)),
      "",
      chalk.dim("    Re-run without --dry-run to connect.")
    ];
  }

  // verify-failed | error - NEVER claim connected. Print the one exact manual command.
  const why =
    result.status === "error"
      ? `Could not install safely: ${result.error ?? "unknown error"}. Nothing was written.`
      : `A write to ${result.settingsPath} was attempted but re-reading it did not find the hook.`;
  return [
    `  ${chalk.bold("▸ Claude Code")} ${chalk.red("- NOT connected")}`,
    "",
    chalk.red(`    ${why}`),
    "    Nothing is claimed connected. Install it yourself, then re-run to verify:",
    `      ${ACCENT(manualCmd)}`
  ];
}

/**
 * Render the status-line install outcome. The Stop hook records the content-free receipts but its
 * stdout is invisible in Claude Code; the `statusLine` is the ONLY per-turn VISIBLE surface, so this
 * makes the receipt line actually show at the bottom of the UI. Single-slot-safe: a user's own status
 * line is never overwritten (we print honest guidance instead).
 */
function claudeStatusLineBlock(result: ConnectStatusLineResult): string[] {
  if (result.status === "installed" || result.status === "already-present") {
    return [
      chalk.green(
        result.status === "installed"
          ? "    Status line: added - the per-turn receipt now shows at the bottom of Claude Code (content-free)."
          : "    Status line: already active - the per-turn receipt shows at the bottom of Claude Code (content-free)."
      ),
      chalk.dim("    Counts/labels/source only; no prompt, path, or response. Reload Claude Code once to see it.")
    ];
  }
  if (result.status === "user-owned") {
    return [
      chalk.yellow("    Status line: you already have your own - left untouched (Claude Code allows only one)."),
      chalk.dim(`    To also show the per-turn receipt, add this to your existing status line:  ${result.statusLineCommand}`)
    ];
  }
  if (result.status === "dry-run") {
    return [chalk.dim("    Status line: --dry-run - not written.")];
  }
  // verify-failed - never claim it landed; the Stop hook still records receipts regardless.
  return [
    chalk.yellow("    Status line: write attempted but not verified - the receipt line may not show."),
    chalk.dim(`    Add it yourself:  set settings.json "statusLine" to  {"type":"command","command":"${result.statusLineCommand}"}`)
  ];
}

/**
 * Render the before-call SHAPING hook install outcome. This is the SUBSCRIPTION apply lever: it injects a
 * content-free output-shaping instruction BEFORE generation to bias the response shorter, holding
 * planning/reasoning/extended-thinking turns. Honest boundary: it SHAPES the request (makes NO claim that
 * output tokens were reduced - that needs a measured A/B, see `compaction savings`), is content-free, and
 * is disabled anytime by `compaction stop` (or COMPACTION_SHAPING_HOOKS=0). A shaping-hook failure never
 * un-connects the Stop hook / status line (it is reported here, additively).
 */
function claudeShapingHookBlock(result: ConnectShapingHookResult, perTurnHold: boolean): string[] {
  if (result.status === "installed" || result.status === "already-present") {
    return [
      chalk.green(
        result.status === "installed"
          ? "    Output shaping: on - a content-free shaping instruction is injected before each shapeable turn to bias shorter output (subscription apply lever)."
          : "    Output shaping: already on - a content-free shaping instruction is injected before each shapeable turn (subscription apply lever)."
      ),
      // The hold is the private task gate. Claiming it in a build without the classifier describes a
      // safety property the hook does not have — `decideShaping` returns `shape-basic` for EVERY
      // prompt there, planning turns included.
      chalk.dim(
        perTurnHold
          ? "    Planning/reasoning/extended-thinking turns are held (never shaped). Shapes the REQUEST; no output-token reduction is claimed (measure it with `compaction savings`)."
          : "    Every turn is shaped - this build has no per-turn hold on planning/reasoning turns. Shapes the REQUEST; no output-token reduction is claimed (measure it with `compaction savings`)."
      ),
      chalk.dim("    Turn it off anytime:  compaction stop   ·   back on:  compaction start   ·   see measured effect:  compaction savings")
    ];
  }
  if (result.status === "dry-run") {
    return [chalk.dim("    Output shaping: --dry-run - the before-call shaping hook was NOT written.")];
  }
  // verify-failed | error - never claim it landed; the Stop hook + status line are unaffected.
  return [
    chalk.yellow("    Output shaping: write attempted but not verified - shaping may not run this session (the Stop hook + status line are unaffected)."),
    chalk.dim(`    Install it yourself:  add a UserPromptSubmit hook running  ${result.hookCommand}`)
  ];
}

/**
 * Render the Codex/Cursor native hook install outcome. This is what makes "Enabled" true for those
 * workflows: the PATH shim only CAPTURES a batch run, the hooks are the lever that actually shapes what
 * the model is asked to produce. Naming the target file, the backup, and each entry is not decoration -
 * onboarding must never write a file it did not disclose, and this block is that disclosure on the
 * non-interactive surface (the TUI review screen carries the same list before the write).
 *
 * Honest boundaries, per tool:
 *  - Codex: per-prompt shaping + a `Stop` per-turn line whose RENDERING is unproven (the schema accepts
 *    `systemMessage`; only a live run proves Codex displays it), so it is never promised as a line the
 *    user will see. The planning/reasoning HOLD is claimed only when the classifier is actually present.
 *  - Cursor: SESSION-LEVEL, once per session - never "per turn" / "per prompt".
 * No savings, cost, or output-token-reduction figure appears here.
 *
 * `codexTrust` is Codex's OWN answer about whether it will run what we just wrote (see
 * `core/codex-hook-trust.ts`). It exists because a written-and-verified `hooks.json` is NOT sufficient
 * on Codex: an untrusted hook is silently inert, so claiming "output shaping: on" off the write alone
 * asserted a model-visible mutation that was not happening. When it says `approval-required` this block
 * reports the enable as INCOMPLETE and names the one-time native action; `undefined` (Cursor, dry-run)
 * and `unknown` leave the pre-existing wording untouched rather than invent a state.
 */
/**
 * The one-time Codex trust continuation, in ONE place because it has to render identically on the two
 * onboarding surfaces. The static/non-TTY path reaches it through `subscriptionHooksBlock`; the TUI path
 * prints it to durable scrollback after the ready screen, because `tuiEnable` discards `actionLines` and
 * the TUI was therefore saying "hook installed" without ever naming the step that makes the hook run.
 *
 * ONLY on the run that WROTE the hook. An `already-present` run changed no hash, so Codex's per-hash trust
 * may already be granted and repeating this would nag on every `init` - which is the opposite requirement.
 * It also states only what this process KNOWS: onboarding never asks Codex (that would mean spawning it),
 * but a newly written entry has a new hash, and a hash Codex has never seen has never been approved.
 */
export function codexTrustContinuationLines(indent: string): string[] {
  return [
    chalk.yellow(
      `${indent}Output shaping: configured for codex, NOT yet running - this hook is new to Codex, and Codex does not run a hook until you approve it once.`
    ),
    chalk.cyan(
      `${indent}One time, to finish: run \`${CODEX_TRUST_ACTION_COMMAND}\`, and at "${CODEX_TRUST_ACTION_HEADING}" choose "${CODEX_TRUST_ACTION_CONTROL}".`
    ),
    chalk.dim(
      `${indent}After that, normal \`codex\` use is shaped automatically - no per-session or per-turn Compaction command. Check with: compaction status`
    )
  ];
}

function subscriptionHooksBlock(result: SubscriptionHookInstallOutcome, perTurnHold: boolean): string[] {
  const tool = result.tool;
  const scope =
    tool === "cursor"
      ? "one session-level instruction per session"
      : perTurnHold
        ? "on each shapeable turn (planning/reasoning/extended-thinking turns are held)"
        : "on every prompt - this build has no per-turn hold on planning/reasoning turns";

  if (result.status === "dry-run") {
    return [chalk.dim(`    Output shaping: --dry-run - ${result.file} was NOT written.`)];
  }
  if (result.status === "error" || result.status === "verify-failed") {
    // NEVER claim a hook that is not confirmed on disk. The shim stays connected either way (fail-open).
    return [
      chalk.yellow(`    Output shaping: not installed for ${tool} (${result.status === "error" ? result.error ?? "write failed" : "re-reading the config did not confirm it"}).`),
      chalk.dim(`    The PATH shim above is unaffected. Install it yourself:  compaction hooks install --tool ${tool}`)
    ];
  }

  // NOT YET ON. Codex has the hook and will not run it until the user trusts it natively, so the only
  // true sentence here is that the setup is one step short - and that the step is a single one-time
  // action inside Codex, not a Compaction command and not something to repeat per session.
  const approvalPending = tool === "codex" && result.status === "installed";
  const lines = approvalPending
    ? [
        // "Codex reports ..." would be a lie here: this block does not ask Codex (see the note above on
        // why onboarding spawns nothing). It states only what it actually knows - the entry is new, and
        // Codex's trust is per-hook-hash, so an entry it has never seen has never been approved.
        ...codexTrustContinuationLines("    "),
        chalk.dim(`    Config: ${result.file}${result.backupPath ? `  (backup: ${result.backupPath})` : ""}`)
      ]
    : tool === "codex"
      ? [
          // `already-present`: this run changed nothing, so Codex's per-hash trust may already be
          // granted. We did not ask (that would cost a subprocess on the onboarding path), so this
          // claims neither state and names the surface that does ask.
          chalk.green(`    Output shaping: configured for ${tool} - the instruction is attached ${scope}, once Codex is running this hook.`),
          chalk.dim(`    Whether Codex is running it depends on its one-time hook approval:  compaction status`),
          chalk.dim(`    Config: ${result.file}${result.backupPath ? `  (backup: ${result.backupPath})` : ""}`)
        ]
      : [
          chalk.green(
            result.status === "installed"
              ? `    Output shaping: on for ${tool} - a content-free concise-response instruction is attached to what the model sees, ${scope}.`
              : `    Output shaping: already on for ${tool} - a content-free concise-response instruction is attached to what the model sees, ${scope}.`
          ),
          chalk.dim(`    Config: ${result.file}${result.backupPath ? `  (backup: ${result.backupPath})` : ""}`)
        ];
  for (const entry of result.entries) {
    lines.push(chalk.dim(`      ${entry.event}: ${entry.command} - ${entry.effect}`));
  }
  if (tool === "codex") {
    lines.push(
      chalk.dim("    The Stop line is installed - if your Codex build displays hook `systemMessage`, it shows settled evidence when recorded."),
      // `watch` reads settled Gateway receipts, including those from normal interactive Codex
      // sessions routed by the installed shim. A user-declared provider route stays outside
      // Compaction and a routed request without settled evidence is not claimed.
      chalk.dim("    `compaction watch` shows settled Gateway evidence when recorded, including interactive Codex sessions.")
    );
  } else {
    lines.push(
      chalk.dim("    Compaction has no verified Cursor per-turn parser or Gateway route; output effect is not yet measured on Cursor."),
      chalk.dim("    `compaction watch` shows `cursor-agent … --output-format json` runs; an IDE session is shaped by this hook but is not measured.")
    );
  }
  lines.push(
    chalk.dim("    Shapes the REQUEST; no output-token reduction is claimed (measure it with `compaction savings`)."),
    chalk.dim(`    Turn it off anytime:  compaction stop   ·   remove the hook:  compaction hooks uninstall --tool ${tool}`)
  );
  return lines;
}

/**
 * Activation copy - the capability summary. `before-call` compaction is hedged "where supported"
 * because the Claude Code Stop hook is a post-session event.
 * Auto-apply is off by default.
 *
 * The authorization boundary is stated on the INPUT axis (F65). A flat "nothing is ever changed without
 * your explicit authorization" is false on the default connect, which installs output shaping without a
 * separate prompt - and on the non-interactive `--connect` path the user never reaches the plan-consent
 * screen that would otherwise have corrected it. What IS unconditionally true is that input compaction
 * stays authorization-gated, so that is what this says.
 */
function activationCopyBlock(): string[] {
  return [
    header("What Compaction does once connected"),
    "",
    "    - report observed input/output tokens when a recorded source carries them (metrics-only)",
    "    - detect avoidable context",
    "    - recommend safe compaction before the call where supported",
    "    - ask before applying",
    "    - remember auto-apply preferences only after explicit approval",
    "    - record metrics-only activity for history (compaction activity)",
    "",
    chalk.dim("  Metrics only. No prompt or response content is stored or uploaded."),
    chalk.dim("  Your input is never compacted or edited without your explicit authorization. Auto-apply is off by default,"),
    chalk.dim("  always scoped to one workflow, recoverable, and disabled anytime (compaction policies disable <id>).")
  ];
}

/**
 * The "Ready" closing summary after a successful connect (also the TUI completion path). All
 * copy comes from the shared model; only the header is emphasised, and every string stays
 * byte-identical to `buildReadySummaryLines` so the model remains authoritative.
 *
 * EVERY VOLATILE INPUT IS RE-READ HERE, not by the caller. `routingInputs` is computed once, before
 * anything is written, so it describes the machine as it was; each caller that then had to remember
 * to refresh it was one caller away from a stale claim, and the durable post-TUI summary was exactly
 * that caller — it re-rendered from the pre-install inputs, so after a SUCCESSFUL interactive Codex
 * enable the scrollback said output shaping is NOT active while the screen the user had just left
 * said the opposite. Doing both refreshes inside the one renderer makes that class of mistake
 * unreachable: whatever a caller passes for the shim and hook axes is overwritten by a fresh check.
 *
 * Exported for the tests that pin exactly this (a pre-install `routingInputs` must still render the
 * post-install truth).
 */
export async function readySummaryBlock(
  enabled: readonly ReadyToolKey[],
  modeKey?: OptimizationModeKey,
  routingInputs?: ReadyRoutingInputs
): Promise<string[]> {
  const refreshed = routingInputs
    ? {
        ...routingInputs,
        claudeRouting: computeClaudeRoutingState(),
        shapingHooksInstalled: await confirmedShapingHooks(enabled),
        codexShapingState: await codexReadyShapingState()
      }
    : undefined;
  const routing = refreshed ? deriveReadyRouting(enabled, refreshed) : undefined;
  return buildReadySummaryLines(enabled, modeKey, routing).map((l) => (l === READY_HEADER ? chalk.bold(l) : l));
}

/**
 * Compute the content-free Ready-summary routing inputs (capability matrix + provider caps +
 * `ROUTE_COMMANDS`, with real verify-cache records so `liveVerified` reflects actual evidence).
 * Reads only the local, gitignored verifications file - safe on the read-only onboarding paths.
 */
/**
 * Verified Claude Code routing-shim state (resolve-check + shell-rc read only - no writes):
 * drives the honest transparent-routing/continuous connection label in the Ready summary.
 */
function computeClaudeRoutingState(): NonNullable<ReadyRoutingInputs["claudeRouting"]> {
  const claudeShim = verifyShimActive("claude-code");
  return {
    installed: claudeShim.installed,
    onPath: claudeShim.active,
    shellConfigured: isShellConfigPathLinePresent(),
    exportLine: claudeShim.exportLine
  };
}

async function computeReadyRoutingInputs(): Promise<ReadyRoutingInputs> {
  const verifications = liveVerificationsForMatrix(process.cwd());
  return {
    matrix: computeCapabilityMatrix({ verifications }),
    providerCaps: deriveProviderCapabilities(ADAPTERS, verifications),
    routeCommands: ROUTE_COMMANDS,
    claudeRouting: computeClaudeRoutingState(),
    // PROBED, never assumed. The per-turn hold is a real safety property performed by a classifier that
    // is PUBLIC and ships in the npm package - so this is a per-build question, not a per-tier one, and
    // an account changes nothing. The ready screen may claim the hold only when this build can actually
    // reach it, and must then say the same thing `compaction hooks install --tool codex` says.
    shapingPerTurnHold: await isShapingTaskClassifierPresent(),
    shapingHooksInstalled: await confirmedShapingHooks(WORKFLOW_ORDER),
    codexShapingState: await codexReadyShapingState()
  };
}

/**
 * The HONEST ready-screen metric, read from the local, content-free activity receipts. At first
 * install there is no data, so the state is `no-data` (the "unavailable until measured" line) -
 * never a simulated number. Read-only; a missing store is "no activity yet" (not an error).
 */
async function computeReadyMetric(): Promise<ReadyMetric> {
  try {
    const { events } = await readActivityEvents();
    // Only count onboarding-tool surfaces; the ready screen is about the connected workflows.
    const relevant = events.filter((e) => (READY_METRIC_SURFACES as readonly string[]).includes(e.surface));
    const rows = buildActivityRows(relevant);
    return deriveReadyMetric(rows);
  } catch {
    // Fail-open to the honest no-data state - never fabricate a number when the read fails.
    return deriveReadyMetric([]);
  }
}

/** True when SOME provider key is present in the environment (the VALUE is never read). Read-only. */
function providerKeyPresent(provider: string | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  if (provider === "anthropic") return Boolean(env.ANTHROPIC_API_KEY && env.ANTHROPIC_API_KEY.trim());
  if (provider === "openai") return Boolean((env.OPENAI_API_KEY && env.OPENAI_API_KEY.trim()) || (env.OPENAI_KEY && env.OPENAI_KEY.trim()));
  return false;
}

/**
 * Compute the REAL verified ready-status rows for the onboarding ready screen AFTER an enable:
 *  - launcher = the resolve-verified shim/hook state (never "active" unless a real resolve/re-read confirms it);
 *  - gateway  = the real `getGatewayStatus` (running / on-demand);
 *  - auth     = read-only env presence (subscription vs API key) - the key VALUE is never read.
 * Healthy only when the enabled workflow's launcher is verified active. Never invents a stronger
 * state than the real checks support. Read-only (no writes).
 *
 * Exported for the tests that assert the PATH-pending state is REACHABLE: this is the only renderer of
 * the "installed · waiting for a new shell" copy, and a fresh Codex/Cursor install that never reached
 * `enabled` rendered "No workflow was enabled" over that copy instead. A test drives it against real
 * on-disk state produced by a real CLI run, so the reachability claim is not asserted against a fake.
 */
export async function computeOnboardingReadyStatus(
  enabled: readonly ReadyToolKey[],
  mode: OptimizationModePreference
): Promise<OnboardingReadyStatus> {
  const primary = enabled[0];
  // Launcher verification: Claude Code and Codex use their routing shim; Cursor uses its capture shim.
  const shimTool: ShimTool | undefined = primary === undefined ? undefined : (primary as ShimTool);
  const launcherState = shimTool ? verifyShimActive(shimTool) : undefined;
  const launcherActive = launcherState?.active === true;
  const launcherInstalled = launcherState?.installed === true;
  const launcher = !shimTool
    ? "not installed (no workflow enabled)"
    : launcherActive
      ? "active · fail-open"
      : launcherInstalled
        ? "installed · waiting for a new shell (PATH not active yet)"
        : "not active";

  const gw = await getGatewayStatus(process.cwd());
  const gateway = gw.running
    ? `running (${gw.base ?? "127.0.0.1"})`
    : "starts on demand when the workflow needs routing";

  const provider = primary ? READY_ROUTE_PROVIDER[primary] : undefined;
  const hasKey = providerKeyPresent(provider);
  // "full optimization available" is only true if the engine can actually run. An API key alone
  // changes nothing about input: the engine is delivered separately and must be installed on THIS
  // device. (This used to read "with no signed engine distributed" — a claim about the world that a
  // published release made false, while the device-level statement stayed true.)
  const engineReachable = await fullOptimizationReachable();
  const auth = hasKey
    ? engineReachable
      ? "API key present (full optimization available on supported requests)"
      : "API key present (output shaping; input compaction needs the engine, not installed on this device yet)"
    : engineReachable
      ? "subscription / plan auth (output shaping; input compaction needs an API key)"
      : "subscription / plan auth (output shaping; input compaction needs the engine, not installed on this device yet)";

  const healthy = launcherActive;
  const headline = !shimTool
    ? "No workflow was enabled"
    : launcherActive
      ? `Compaction is active for ${READY_TOOL_COPY[primary].label}`
      : launcherInstalled
        ? `Compaction is installed for ${READY_TOOL_COPY[primary].label}, but not active in this shell yet`
        : `Compaction setup for ${READY_TOOL_COPY[primary].label} could not be verified`;
  const nextAction = launcherActive || !shimTool
    ? undefined
    : launcherInstalled
      ? "Open a new terminal (or `source` your shell config), then run your workflow normally."
      : "Re-run `compaction init` to complete setup, or run `compaction status` for the failed check.";
  // `mode` is carried for parity with the persisted default; it does not change the verified status.
  void mode;

  return { healthy, headline, launcher, gateway, auth, ...(nextAction ? { nextAction } : {}) };
}

/**
 * The LOCAL gates between a valid entitlement lease and a real full apply. MOVED, not changed, to
 * `./full-apply-gate.js`: `mode.ts` has to ask the same question this screen asks, and its Open static
 * import graph may not reach the device-login client this file imports. Re-exported so this module
 * stays the import site it has always been for the onboarding path and its tests.
 */
import { pendingFullApplyGate } from "./full-apply-gate.js";
export { pendingFullApplyGate };

/**
 * Why full apply is not live yet, when the engine is the thing missing — read from the attempt that
 * just ran rather than stated. Content-free: a coded reason or a fixed sentence, never server text.
 */
/**
 * COMMUNITY ACTIVATION — the implementation behind the stepper's injected `onCommunityAuth`.
 *
 * This function is the ONLY place the account exists during onboarding. The TUI renders; this
 * performs. Nothing secret crosses back: the progress it forwards carries a verification URL and a
 * user code (both meant for the user to read), and the outcome carries at most an email plus the
 * posture the next turn will actually have. The device token, device id, and private key stay inside
 * the credentials store and are never returned, logged, or rendered.
 *
 * It does BOTH halves of activation, deliberately: sign in AND acquire the entitlement lease. Signing
 * in without a lease would clamp the user to `observe` — strictly WORSE than the Open they were
 * offered — which is the one outcome this flow must never produce silently.
 *
 * `workflows` are the workflows this run actually enabled; they are what the authorization gate is
 * checked against. Passing none is honest and handled (nothing enabled ⇒ nothing to apply to).
 *
 * Exported so the activation seam can be exercised directly against a real service; the stepper
 * reaches it only through the injected `onCommunityAuth` callback.
 */
export async function runCommunityActivation(
  onProgress: (progress: OnboardingAuthProgress) => void,
  signal: AbortSignal,
  workflows: readonly ReadyToolKey[] = []
): Promise<OnboardingAuthOutcome> {
  const login = await performDeviceLogin(
    { openBrowser: (url: string) => openBrowser(url, process.env), signal },
    (progress: DeviceLoginProgress) => onProgress(progress),
    process.env
  );
  if (!login.ok) {
    return {
      ok: false,
      reason: login.reason,
      ...(login.serviceStatus === undefined ? {} : { serviceStatus: login.serviceStatus })
    };
  }

  // The entitlement lease AND the signed engine, in the SAME step. A failure in either is NOT an
  // activation failure: the account is real and signed in, so the honest result is "signed in, full
  // apply not active yet" with the content-free reason — never a rollback of a login that genuinely
  // happened.
  //
  // Both halves are here because the journey says a user who chose Community then works normally.
  // The lease alone used to be acquired here, which left the engine to a command (`compaction engine
  // install`) the user is never told about and should not have to know exists. `ensureCommunityRuntime`
  // does only the work that is missing, so this costs two local reads on a device that already has
  // both.
  //
  // THE SIGNAL GOES IN. The stepper renders "Esc / Ctrl-C to stop and continue on Open" for exactly
  // this wait, and the same `signal` the device login already honours now reaches lease acquisition
  // and the engine download too. Without it the keypress moved the screen on while the transfer kept
  // running underneath — the one place in onboarding where the offer of cancellation was not real.
  const runtime = await ensureCommunityRuntime(
    process.env,
    (step) => {
      onProgress({ kind: "provisioning", step });
    },
    { signal, engineIntent: "explicit" }
  );
  const leaseReason = runtime.lease === "unavailable" ? (runtime.reason ?? "entitlement service unreachable") : undefined;

  // ENGINE FIRST, exactly as `compaction mode full` does. The
  // picker has already removed "Full optimization" on an engine-free build, and the plan step has
  // persisted `basic`. Calling `applyModeSelection("full")` anyway would overwrite that `basic` the
  // moment a valid lease arrives, so `effectiveOpenTier()` would resolve `full` and the gateway would
  // take the full-tier path — for a user the review screen just promised basic shaping. A valid lease
  // is exactly the case where this bites, which is why the lease gate below is not enough on its own.
  if (!(await fullOptimizationReachable(process.env))) {
    writeProductMode("basic", process.env);
    return {
      ok: true,
      alreadyLoggedIn: login.alreadyLoggedIn,
      ...(login.email ? { email: login.email } : {}),
      effectiveMode: "basic",
      // Derived from the attempt that just ran, not asserted. "No release has been distributed" was
      // a fixed sentence, and it is only one of the reasons an engine can be missing — since the
      // install is attempted here, the honest report is what the attempt actually hit.
      fullApplyPendingReason: engineBlockedReason(runtime)
    };
  }

  // THE SEAM: `applyModeSelection` already encodes the lease gate — it persists `full` only against a
  // lease that actually verifies, and preserves the Open mode otherwise. Re-deriving that decision
  // here would be a second copy of the rule that could disagree with the gate.
  const outcome = applyModeSelection("full", process.env);
  if (outcome.persisted && outcome.effective === "full") {
    // The entitlement is real, so `full` persisted above. Whether the NEXT TURN is a full apply is a
    // separate question — the remaining gates are the gateway's — so ask them before the screen
    // promises something the first request would refuse.
    const pending = await pendingFullApplyGate(workflows);
    if (pending === undefined) {
      return {
        ok: true,
        alreadyLoggedIn: login.alreadyLoggedIn,
        ...(login.email ? { email: login.email } : {}),
        effectiveMode: "full"
      };
    }
    // A GATE IS PENDING, so the screen reports `basic` — and the PERSISTED posture must say the same
    // thing. Leaving `full` on disk while rendering `basic` is the split this guards against: the
    // commonest case is a user who picked the recommended
    // "Output only" mode and then activated Community, whose own choice would be silently overwritten
    // by a valid lease. `effectiveOpenTier()` would resolve `full`, gateway traffic would enter the
    // full-apply path only to exit at the optimization-mode gate, and the promised basic posture would
    // run nowhere. The entitlement is not lost — it is on disk in the lease, so `compaction mode full`
    // enables it the moment the user actually asks for it.
    writeProductMode("basic", process.env);
    return {
      ok: true,
      alreadyLoggedIn: login.alreadyLoggedIn,
      ...(login.email ? { email: login.email } : {}),
      effectiveMode: "basic",
      fullApplyPendingReason: pending
    };
  }

  // NEVER BELOW THE OPEN FLOOR. The clamp preserves whatever was persisted, and the plan step already
  // wrote `basic` — but a user who chose Community must not end up at `observe` under any ordering, so
  // this asserts the floor rather than assuming it.
  if (outcome.effective !== "basic") writeProductMode("basic", process.env);
  return {
    ok: true,
    alreadyLoggedIn: login.alreadyLoggedIn,
    ...(login.email ? { email: login.email } : {}),
    effectiveMode: "basic",
    fullApplyPendingReason: leaseReason ?? outcome.leaseVerdict ?? "no entitlement lease on this device"
  };
}

/** The static header (wordmark + detection + menu) shown above the per-choice action block. */
function connectHeaderLines(detection: ConnectDetection): string[] {
  return [
    "",
    `  ${WORDMARK}`,
    "",
    `  ${VALUE_PROMISE}`,
    "",
    RULE,
    "",
    ...connectDetectionBlock(detection),
    "",
    ...connectMenuBlock(),
    "",
    RULE,
    ""
  ];
}

/**
 * Content-free connect detection for the onboarding surfaces. Claude Code is `ready` only when
 * the whole promised connection is active: the Stop hook, the before-call shaping hook, and the
 * transparent-routing shim resolving before the real binary. All checks are read-only.
 */
async function computeConnectDetection(det: DetectionState): Promise<ConnectDetection> {
  const shimStatus = (tool: ShimTool): "active" | "installed" | "found" | "absent" => {
    const v = verifyShimActive(tool);
    if (v.active) return "active";
    if (v.installed) return "installed";
    const real = resolveExecutableOnPath(SHIM_TOOLS[tool].shimName, process.env, [v.shimDir]);
    return real ? "found" : "absent";
  };
  const claudeStatus = shimStatus("claude-code");
  // Same resolver as every write path and as readiness, so the onboarding TUI can never disagree
  // with `compaction status` about where the integration lives. Also covers `settings.local.json`,
  // which the previous hand-rolled pair missed: Claude Code fires a hook installed there.
  const stopHookChecks = await Promise.all(claudeSettingsReadPaths().map((file) => isStopHookInstalled(file)));
  const stopHookReady = stopHookChecks.some(Boolean);
  const hookReady = stopHookReady && (await isClaudeShapingActive()) && verifyShimActive("claude-code").active;
  return {
    claude: {
      detected: det.claudeDetected || claudeStatus !== "absent",
      sessionCount: det.sessionCount,
      hookReady
    },
    codex: shimStatus("codex"),
    cursor: shimStatus("cursor")
  };
}

interface ConnectRunOptions {
  user?: boolean;
  /** Explicit PROJECT scope (advanced). Default is user/global — Compaction is install-once. */
  project?: boolean;
  dryRun?: boolean;
  writeShellConfig?: boolean;
}

/**
 * A resolved connect selection. `enableKeys` = workflows to attempt to enable this run;
 * `countReadyKeys` = already-`ready` workflows counted in the Ready summary without being
 * re-enabled; `skip` enables nothing. Both lists are honoured in the stable Page-1 order.
 */
interface ConnectSelection {
  skip: boolean;
  enableKeys: ReadyToolKey[];
  countReadyKeys: ReadyToolKey[];
}

/** The three real workflow keys, in the stable Page-1 render order. */
const WORKFLOW_ORDER: ReadyToolKey[] = ["claude-code", "codex", "cursor"];

/** Validate + normalise a workflow token used in a `--connect` comma-list. */
const COMMA_LIST_WORKFLOWS: Record<string, ReadyToolKey> = {
  "claude-code": "claude-code",
  codex: "codex",
  cursor: "cursor"
};

/**
 * Resolve a `--connect <spec>` into a `ConnectSelection`, or a one-line error. Grammar:
 *  - named single token, with numeric compatibility aliases retained only by the parser;
 *  - `detected` → enable every `found` workflow; already-`ready` ones are counted, not re-enabled;
 *  - `none` → skip (a `--mode` may still be set);
 *  - comma-list of workflow names → enable exactly those (ready names counted, not re-enabled).
 * Read-only: this only computes the intended set; nothing is written here.
 */
function resolveConnectSelection(spec: string, detection: ConnectDetection): { selection?: ConnectSelection; error?: string } {
  const raw = spec.trim().toLowerCase();

  if (raw === "none") return { selection: { skip: true, enableKeys: [], countReadyKeys: [] } };

  // Preserve the shipped numeric interface strictly as an undocumented parser compatibility path.
  // Unlike the canonical named commands below, these aliases retain their original explicit-choice
  // semantics so existing scripts do not acquire a new discovery precondition.
  if (/^[1-5]$/.test(raw)) {
    const legacy = CONNECT_ALIASES[raw];
    if (legacy === "skip") {
      return { selection: { skip: true, enableKeys: [], countReadyKeys: [] } };
    }
    return {
      selection: {
        skip: false,
        enableKeys: legacy === "all" ? [...WORKFLOW_ORDER] : legacy ? [legacy] : [],
        countReadyKeys: []
      }
    };
  }

  const discovery = deriveDiscovery(detection);
  const stateOf = (key: ReadyToolKey): WorkflowDiscovery["state"] | undefined =>
    discovery.find((d) => d.key === key)?.state;

  // `all` means every tool actually detected on this machine. Numeric `4` remains a parser-only
  // compatibility alias for the same behavior; it is never rendered in help or onboarding copy.
  if (raw === "all" || raw === "detected") {
    const enableKeys = discovery.filter((d) => d.state === "found").map((d) => d.key) as ReadyToolKey[];
    const countReadyKeys = discovery.filter((d) => d.state === "ready").map((d) => d.key) as ReadyToolKey[];
    return { selection: { skip: false, enableKeys, countReadyKeys } };
  }

  // Single named choices and their parser-only numeric compatibility aliases require a detected
  // workflow. Validation happens before every write, so an absent target fails cleanly.
  const single = CONNECT_ALIASES[raw];
  if (single) {
    if (single === "skip") {
      return { selection: { skip: true, enableKeys: [], countReadyKeys: [] } };
    }
    if (single !== "all" && stateOf(single) === "not-found") {
      return {
        error: `${single} was not detected on this machine; nothing was changed. Install or expose the tool, then run compaction init --connect ${single}.`
      };
    }
    if (single !== "all" && stateOf(single) === "ready") {
      return { selection: { skip: false, enableKeys: [], countReadyKeys: [single] } };
    }
    return { selection: { skip: false, enableKeys: single === "all" ? [] : [single], countReadyKeys: [] } };
  }

  // Comma-list of explicit workflow names.
  const parts = raw
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const validList = "claude-code | codex | cursor | all";
  if (parts.length === 0) {
    return { error: `empty --connect '${spec}'. Valid: ${validList}` };
  }
  const enableKeys: ReadyToolKey[] = [];
  const countReadyKeys: ReadyToolKey[] = [];
  const unknown: string[] = [];
  const absent: ReadyToolKey[] = [];
  for (const part of parts) {
    const key = COMMA_LIST_WORKFLOWS[part];
    if (!key) {
      unknown.push(part);
      continue;
    }
    if (stateOf(key) === "not-found") {
      if (!absent.includes(key)) absent.push(key);
    } else if (stateOf(key) === "ready") {
      if (!countReadyKeys.includes(key)) countReadyKeys.push(key);
    } else if (!enableKeys.includes(key)) {
      enableKeys.push(key);
    }
  }
  if (unknown.length > 0) {
    return { error: `unknown --connect workflow name(s): ${unknown.join(", ")}. Valid: ${validList}` };
  }
  if (absent.length > 0) {
    return {
      error: `${absent.join(", ")} ${absent.length === 1 ? "was" : "were"} not detected on this machine; nothing was changed.`
    };
  }
  return { selection: { skip: false, enableKeys, countReadyKeys } };
}

/**
 * The single reversible enable path - installs the requested workflows via the verified
 * installers (Claude Code merge-not-replace Stop hook; Codex/Cursor PATH shim) and returns the
 * outcome without printing. `connected` = verified active this run; `failed` = attempted but
 * unverified (non-zero exit set here); `actionLines` = the per-workflow render for the
 * non-interactive surface. Both `runConnectSelection` and the TUI's `onEnable` route through
 * this one function, so there is no duplicate install logic. Stable Page-1 order.
 */
/**
 * Which workflows' native shaping hooks are CONFIRMED on disk right now.
 *
 * Deliberately a re-read of the tool's own config rather than a memo of what an install reported: it
 * is the same file the tool will read, so it answers correctly for a fresh install, an idempotent
 * re-run, a workflow that was already connected on a previous run, AND a failed install. The ready
 * screen used to state the shaping effect unconditionally, so a run whose hook install had failed
 * printed the failure and then, twenty-five lines later, claimed the instruction was attached.
 *
 * Fail-open and conservative: anything unreadable answers "not installed", which understates.
 *
 * Claude Code is answered here too. It used to be skipped outright, so
 * `shapingHooksInstalled` could never contain it and its ready line was forced down an unconditional
 * "nothing the model sees is mutated" fallthrough - on the very flow whose default connect installs the
 * `UserPromptSubmit` shaping hook. Its config is a different file with a different writer, so it uses
 * the Claude-side read-only probe rather than the Codex/Cursor one.
 */
async function confirmedShapingHooks(keys: readonly ReadyToolKey[]): Promise<ReadyToolKey[]> {
  const out: ReadyToolKey[] = [];
  for (const key of keys) {
    try {
      if (key === "claude-code") {
        if (await isClaudeShapingActive()) out.push(key);
        continue;
      }
      if (key !== "codex" && key !== "cursor") continue;
      if (!(await areSubscriptionHooksInstalled(key))) continue;
      if (key === "codex") {
        const trust = await codexShapingHookTrust({ env: process.env, cwd: process.cwd() });
        if (trust.state === "active") out.push(key);
        continue;
      }
      out.push(key);
    } catch {
      /* fail-open: an unreadable config is reported as "not installed", never as installed */
    }
  }
  return out;
}

async function codexReadyShapingState(): Promise<NonNullable<ReadyRoutingInputs["codexShapingState"]>> {
  if (!(await areSubscriptionHooksInstalled("codex"))) return "not-installed";
  try {
    return (await codexShapingHookTrust({ env: process.env, cwd: process.cwd() })).state === "active"
      ? "active"
      : "configured";
  } catch {
    return "configured";
  }
}

/**
 * Whether Claude Code output shaping is actually in force right now. Pure reads only - the same class
 * of settings/env read `status` already performs for the Stop hook and the status line.
 *
 * BOTH halves must hold, because install is not activation: the hook has to be on disk in a file Claude
 * Code will read (project settings OR user settings, matching how the Stop hook is probed), AND the
 * global switch has to be clear (`compaction stop` / `COMPACTION_SHAPING_HOOKS=0` suppress shaping while
 * leaving the hook entry in place). A hook present behind a thrown kill-switch attaches nothing, so
 * claiming shaping there would be exactly the overclaim this fix removes.
 */
async function isClaudeShapingActive(): Promise<boolean> {
  if (!isShapingHooksActivated()) return false;
  const checks = await Promise.all(claudeSettingsReadPaths().map((file) => isShapingHookInstalled(file)));
  return checks.some(Boolean);
}

async function enableWorkflowSelection(
  enableKeys: readonly ReadyToolKey[],
  options: ConnectRunOptions,
  mode?: OptimizationModePreference
): Promise<{
  connected: ReadyToolKey[];
  failed: ReadyToolKey[];
  actionLines: string[];
  codexHookNewlyInstalled: boolean;
}> {
  const actionLines: string[] = [];
  // Set ONLY by the installer answering `installed` (it wrote the entry) - not by re-reading the config
  // afterwards, which cannot tell a hook this run created from one that was already there. That
  // distinction is the entire difference between a one-time continuation and a nag.
  let codexHookNewlyInstalled = false;
  const connected: ReadyToolKey[] = [];
  const failed: ReadyToolKey[] = [];
  // The claude-code transparent-routing shim block is rendered LAST (after the connect/mode writes
  // below land) so its apply-routing posture line reflects the state the next `claude` run will
  // read - resolved from the SAME resolver the runtime uses, never a stale blanket claim.
  let claudeRouting:
    | { shim: InstallShimResult; optedOut: boolean; rc?: WriteShellConfigResult; writeFailed?: boolean; unsupportedShell?: string }
    | undefined;
  let claudeRoutingDryRun = false;
  for (const key of WORKFLOW_ORDER) {
    if (!enableKeys.includes(key)) continue;
    if (key === "claude-code") {
      // INSTALL-ONCE: user/global by default so the connect survives new repos, worktrees and shells.
      const settingsPath = claudeSettingsPathForScope(options.project ? "project" : "user");
      const result = await connectClaudeCodeHook({ settingsPath, ...(options.dryRun ? { dryRun: true } : {}) });
      // Report the scope ACTUALLY used. This used to pass `options.user`, which is undefined on a
      // plain `init --connect claude-code` — so the flagship success line said "this project" while
      // the install had correctly gone to ~/.claude/settings.json. It misreported the exact property
      // this release fixes.
      actionLines.push(...claudeInstallBlock(result, !options.project));
      // Per-turn VISIBLE surface: also configure the status line (the Stop hook records receipts, but its
      // stdout is invisible in Claude Code). Additive + single-slot-safe: a user's own status line is
      // never clobbered. A status-line failure never un-connects the hook (it is display-only). Honors
      // the COMPACTION_RECEIPT_LINE=0 kill switch exactly as `compaction statusline` does: when the line
      // is silenced, it is not wired (nothing else about the connect changes).
      if (isReceiptLineEnabled()) {
        const statusLine = await connectClaudeCodeStatusLine({ settingsPath, ...(options.dryRun ? { dryRun: true } : {}) });
        actionLines.push(...claudeStatusLineBlock(statusLine));
      }
      // SUBSCRIPTION apply lever: ALSO install the before-call SHAPING hook (UserPromptSubmit) so a
      // subscriber's real Claude Code traffic is actually shaped, not just observed. Additive + merge-not-
      // clobber + idempotent + verify-by-reread + reversible on --disconnect 1. A shaping-hook failure
      // NEVER un-connects the Stop hook / status line (it is reported additively; connected still stands).
      // Install only when shaping is globally enabled (kill-switch clear AND not `compaction stop`-ed) so
      // we never wire a hook the user has turned off; the hook ALSO honors that state at runtime (fail-open).
      if (isShapingHooksActivated()) {
        try {
          const shaping = await connectClaudeCodeShapingHook({ settingsPath, ...(options.dryRun ? { dryRun: true } : {}) });
          actionLines.push(...claudeShapingHookBlock(shaping, await isShapingTaskClassifierPresent()));
        } catch {
          /* fail-open: a shaping-hook install failure never breaks or un-connects the rest of the connect */
        }
      }
      // MIGRATION (install-once): a user connected the OLD project-local way would now carry Compaction
      // entries in BOTH scopes. Claude Code merges `hooks` ADDITIVELY — a project hook does not suppress
      // a user hook — so Stop and UserPromptSubmit would fire TWICE per turn: double capture, double
      // shaping. `statusLine` is a single slot where the highest-precedence definition wins, so the
      // duplication would render as ONE line while two hooks ran behind it. Strip our own entries from
      // THIS directory's project settings (never a scan of other projects, never a foreign entry).
      if (!options.project) {
        try {
          const migrated = await migrateProjectScopeClaudeSettings({
            ...(options.dryRun ? { dryRun: true } : {})
          });
          if (migrated.cleaned.length > 0) {
            actionLines.push(
              options.dryRun
                ? `  Would migrate ${migrated.removedHooks} project-local Compaction hook entr${migrated.removedHooks === 1 ? "y" : "ies"} into the global install (preview - nothing written).`
                : `  Migrated ${migrated.removedHooks} project-local Compaction hook entr${migrated.removedHooks === 1 ? "y" : "ies"} into the global install (one integration, no double shaping).`
            );
          }
        } catch {
          /* fail-open: a migration failure never un-connects the global install */
        }
      }
      if (result.status === "installed" || result.status === "already-present") connected.push("claude-code");
      if (result.status === "verify-failed" || result.status === "error") {
        failed.push("claude-code");
        process.exitCode = 1;
      }
      // Transparent routing shim (RECORD-only, fail-open) - additive to the Stop hook, never a
      // substitute: the hook stays the activity/measurement source; the shim routes normal `claude`
      // runs through the byte-safe record gateway (content-free receipts). A shim that cannot be
      // installed (no binary / not on PATH) does not un-connect the hook - reported honestly above.
      // Enabling sets up PATH too: the shell-config PATH line is written BY DEFAULT (backup first,
      // idempotent, announced with the file + backup path, reversed by --disconnect 1);
      // --no-write-shell-config opts out and prints the one manual line instead.
      if (options.dryRun) {
        claudeRoutingDryRun = true;
      } else {
        const shim = installToolShim("claude-code");
        const optedOut = options.writeShellConfig === false;
        const unsupportedShell = shellConfigWriteIsSupported() ? undefined : (process.env.SHELL ?? "").trim();
        let rc: WriteShellConfigResult | undefined;
        let writeFailed = false;
        if (!optedOut && unsupportedShell === undefined && shimInstallVerified(shim)) {
          try {
            rc = writeShellConfigPathLine();
          } catch {
            writeFailed = true;
          }
        }
        // Capture the shim inputs; the routing block (with its resolver-driven posture line) is
        // built AFTER the connect/mode writes below, so the posture is not stale.
        claudeRouting = {
          shim,
          optedOut,
          ...(rc ? { rc } : {}),
          ...(writeFailed ? { writeFailed: true } : {}),
          ...(unsupportedShell !== undefined ? { unsupportedShell } : {})
        };
        if (shim.status === "verify-failed") process.exitCode = 1;
      }
    } else {
      const shimTool = key as ShimTool;
      // --DRY-RUN WRITES NOTHING HERE EITHER. `--dry-run` promises "write nothing", and the Claude Code
      // branch above keeps that promise by skipping its shim install outright. This branch installed the
      // shim anyway and - once the rc line became the default - also edited ~/.bashrc or ~/.zshrc, so an
      // observational flag silently changed every future shell. The tool's own hook installer below is
      // already dry-run aware, so the preview survives; only the two real writes are skipped.
      const install = options.dryRun ? undefined : installToolShim(shimTool);
      // PATH SET-UP IS PART OF THE ONE ENABLE ACTION, exactly as it is for Claude Code above: the
      // shell-rc line is written BY DEFAULT (backup first, idempotent, announced with the file +
      // backup path, reversed by --disconnect 2/3), and `--no-write-shell-config` opts out and
      // prints the one manual line instead.
      //
      // It used to be opt-IN here while Claude Code's was opt-OUT, and on a fresh machine that
      // asymmetry was the whole failure: the shim landed `installed-not-on-path`, the rc line that
      // would activate it was never written, and the flow had no way to reach an active state from
      // inside itself. The review screen has always disclosed this write for EVERY workflow ("add
      // its launcher directory to your shell PATH"), so for Codex/Cursor that promise was simply
      // never kept. Fail-open like Claude Code's: an rc write that throws leaves the manual
      // one-line instruction as the printed fallback rather than failing the enable.
      const shimOptedOut = options.writeShellConfig === false;
      // ONLY WRITE A STARTUP FILE THE SHELL WILL ACTUALLY LOAD. The rc resolver falls back to
      // `~/.bashrc` for any non-zsh shell, so under fish it would write a file fish never reads, in a
      // syntax fish cannot parse - and this block would then report "installed; active in new shells".
      // Detect and degrade honestly instead: no write, no activation claim, the manual PATH instruction.
      // NOT fish support - Compaction still edits zsh/bash only.
      const unsupportedShell = shellConfigWriteIsSupported() ? undefined : (process.env.SHELL ?? "").trim();
      let wroteShellConfig: WriteShellConfigResult | undefined;
      let shellConfigWriteFailed = false;
      if (install && !shimOptedOut && unsupportedShell === undefined && shimInstallVerified(install)) {
        try {
          wroteShellConfig = writeShellConfigPathLine();
        } catch {
          shellConfigWriteFailed = true;
        }
      }
      actionLines.push(
        ...(install
          ? shimConnectBlock(install, wroteShellConfig, shimOptedOut, unsupportedShell, shellConfigWriteFailed)
          : shimDryRunBlock(shimTool)),
        ""
      );
      // WHAT "ENABLED" ACTUALLY REQUIRES. The PATH shim only CAPTURES a measurable batch run; it changes
      // nothing about what the model is asked to produce. The tool's native hooks are the lever, and they
      // used to be reachable only by discovering `compaction hooks install --tool codex` afterwards - so a
      // workflow enabled here was never actually shaped. Installed through the SAME shared installer the
      // `hooks` command uses (merge-not-replace, backed up, verified by re-read, idempotent).
      //
      // GATED ON THE SAME SWITCH AS THE CLAUDE CODE SHAPING HOOK: a user who ran `compaction stop` or set
      // COMPACTION_SHAPING_HOOKS=0 must never get a shaping hook wired behind their back. And ADDITIVE /
      // FAIL-OPEN exactly like it: a hook-install failure never un-connects the shim above.
      //
      // `no-real-binary` is skipped deliberately - that block says "Nothing was written", and writing a
      // hook config for a tool that is not installed would make that line false.
      const hookTool: SubscriptionHookTool | undefined = key === "codex" || key === "cursor" ? key : undefined;
      // Under --dry-run there is no install result to consult; the installer is dry-run aware and writes
      // nothing, so the preview still runs (that is the whole point of the flag).
      if (hookTool && isShapingHooksActivated() && install?.status !== "no-real-binary") {
        try {
          const hooks = await installSubscriptionHooks(hookTool, { ...(options.dryRun ? { dryRun: true } : {}) });
          actionLines.push(
            ...subscriptionHooksBlock(hooks, hookTool === "codex" && (await isShapingTaskClassifierPresent()))
          );
          if (hookTool === "codex" && hooks.status === "installed") codexHookNewlyInstalled = true;
        } catch {
          /* fail-open: a hook-install failure never breaks or un-connects the rest of the connect */
        }
      }
      actionLines.push("");
      // CONFIGURED, not ACTIVE - the same bar Claude Code uses above. A shim that is written and
      // re-read but whose directory the CURRENT shell does not yet carry on PATH is a completed
      // set-up waiting on a new shell, not a failed one: the tool's own shaping hooks do not depend on
      // PATH at all (the tool reads them directly - though on Codex they additionally wait on that
      // tool's own one-time trust, which the hook block above reports), and the rc line that activates capture has
      // just been written. Excluding it made a fresh machine - where every install necessarily
      // lands here - report "No workflow was enabled" over a directory full of files this run had
      // written. Downstream, membership here is what lets `computeOnboardingReadyStatus` render the
      // honest "installed · waiting for a new shell (PATH not active yet)" state it already carries;
      // that function still verifies PATH itself, so nothing is claimed active by this push.
      //
      // The PATH-pending case counts ONLY when this run put the shared PATH line in place. Under
      // `--no-write-shell-config` it did not: the user kept that edit for themselves, so a real step is
      // still outstanding, the block above correctly says "installed, NOT yet active" with the one line
      // to add, and a Ready summary claiming "✓ Codex - run your workflows normally" would contradict
      // it on the same screen. That opt-out therefore keeps the pre-existing not-connected treatment,
      // which is exactly the honest rendering for a set-up the user chose to finish by hand.
      if (
        install &&
        (install.status === "installed-active" ||
          install.status === "already-active" ||
          (install.status === "installed-not-on-path" && wroteShellConfig !== undefined))
      ) {
        connected.push(shimTool);
      }
      if (install?.status === "verify-failed") {
        failed.push(shimTool);
        process.exitCode = 1;
      }
    }
  }
  // Persist the verified-connected routable workflows (enum-only, content-free) so gateway
  // commands can default their `--workflow` identity. Every apply eligibility gate still
  // evaluates per request; a preferences write failure never fails the connect (fail-open).
  const routable = connected.filter(isConnectedRoutableWorkflow);
  if (routable.length > 0) {
    try {
      addConnectedWorkflows(routable);
    } catch {
      /* fail-open: connect stands; the workflow default simply stays unset */
    }
  }

  // Now that this run's connect (and, for cache-plus-context, its narrow authorizations) is
  // persisted, render the claude-code routing block LAST with an apply-routing posture resolved
  // from the SAME resolver the runtime uses - so the copy describes exactly what the next `claude`
  // run will do (apply engaged vs record-only) and can never diverge from behavior. The narrow
  // claude-code authorization is persisted here first (idempotent upsert) so guard #3 is on disk
  // before we resolve; its display lines are surfaced by the caller's `saveModeAuthorizations`, so
  // they are intentionally discarded here (persist-only, no duplicate output).
  if (claudeRoutingDryRun) {
    actionLines.push("", chalk.dim("    --dry-run: the claude transparent-routing shim was NOT installed (nothing written)."), "");
  } else if (claudeRouting) {
    if (mode === "cache-plus-context" && connected.includes("claude-code")) {
      try {
        await saveModeAuthorizations(["claude-code"]);
      } catch {
        /* fail-open: a failed authorization save simply leaves apply dormant; the resolver reports it honestly */
      }
    }
    const posture = await resolveClaudeRoutingPosture();
    const { shim, optedOut, rc, writeFailed, unsupportedShell } = claudeRouting;
    actionLines.push(
      "",
      ...claudeRoutingShimBlock(shim, posture, {
        optedOut,
        ...(rc ? { rc } : {}),
        ...(writeFailed ? { writeFailed: true } : {}),
        ...(unsupportedShell !== undefined ? { unsupportedShell } : {})
      }),
      ""
    );
  }
  return { connected, failed, actionLines, codexHookNewlyInstalled };
}

/**
 * The TUI's injected enable callback - a thin wrapper over `enableWorkflowSelection` returning
 * only the content-free `EnableResult`; the TUI renders Page-2/Page-4 from that actual state.
 */
async function tuiEnable(
  enableKeys: readonly ReadyToolKey[],
  options: ConnectRunOptions,
  mode?: OptimizationModePreference
): Promise<EnableResult & { codexHookNewlyInstalled: boolean }> {
  const { connected, failed, codexHookNewlyInstalled } = await enableWorkflowSelection(enableKeys, options, mode);
  // Checked AFTER the install, from the tool's own config, so the ready screen describes the shaping
  // effect that is actually wired rather than the one the flow intended to wire.
  const shapingHooksInstalled = await confirmedShapingHooks(connected);
  const codexShapingState = connected.includes("codex") ? await codexReadyShapingState() : undefined;
  return {
    connected,
    failed,
    shapingHooksInstalled,
    codexHookNewlyInstalled,
    ...(codexShapingState ? { codexShapingState } : {})
  };
}

async function runConnectSelection(
  selection: ConnectSelection,
  options: ConnectRunOptions,
  detection: ConnectDetection,
  prefaceLines: string[] = [],
  routingInputs?: ReadyRoutingInputs,
  mode?: OptimizationModePreference
): Promise<void> {
  let actionLines: string[] = [];
  let connected: ReadyToolKey[] = [];
  let countedReadyClaudeStatus = false;
  if (selection.skip) {
    actionLines = [...skipBlock()];
  } else {
    const enabled = await enableWorkflowSelection(selection.enableKeys, options, mode);
    actionLines = enabled.actionLines;
    connected = enabled.connected;
    // Already-connected Claude Code (counted ready, not re-enabled) still shows the honest routing +
    // PATH status (read-only). Its block is rendered BELOW, after this run's authorizations persist,
    // so its apply-routing posture line is resolved against the state the next `claude` run will read.
    countedReadyClaudeStatus =
      selection.countReadyKeys.includes("claude-code") && !selection.enableKeys.includes("claude-code");

    // A counted-ready Codex shim is deliberately not reinstalled, but the hook axis still needs an
    // honest read-only status. Hook bytes on disk are not enough: Codex may still be withholding its
    // native per-hash trust, so never let the Ready summary imply the instruction is active unless
    // Codex itself reports that state.
    if (selection.countReadyKeys.includes("codex") && !selection.enableKeys.includes("codex")) {
      if (!(await areSubscriptionHooksInstalled("codex"))) {
        actionLines.push(
          chalk.yellow("    Output shaping: not installed for codex (the hook config is not verified on disk)."),
          chalk.dim("    The active PATH shim is unaffected. Install the hook:  compaction hooks install --tool codex"),
          ""
        );
      } else {
        const trust = await codexShapingHookTrust({ env: process.env, cwd: process.cwd() });
        if (trust.state === "active") {
          actionLines.push(chalk.green("    Output shaping: on for codex - Codex reports the configured hook active."), "");
        } else {
          actionLines.push(
            chalk.dim("    Output shaping is configured for codex."),
            chalk.dim("    Whether Codex is running it depends on its one-time hook approval:  compaction status"),
            ""
          );
        }
      }
    }
  }
  // Ready summary set = verified-connected THIS run ∪ already-ready (counted, not re-enabled). De-duped;
  // `buildReadySummaryLines` renders in the stable order, so set order here does not matter.
  const readySet: ReadyToolKey[] = [...new Set([...connected, ...selection.countReadyKeys])];
  const authorizationLines = mode === "cache-plus-context"
    ? await saveModeAuthorizations(readySet)
    : [];
  // Now that any narrow authorization for a counted-ready claude-code is persisted, render its
  // read-only routing status block (with a resolver-driven, non-stale apply-routing posture) + the
  // self-healed per-turn status line. Additive, single-slot-safe, kill-switch-honoring, fail-open.
  if (countedReadyClaudeStatus) {
    const posture = await resolveClaudeRoutingPosture();
    actionLines.push(...claudeRoutingStatusBlock(posture), ...(await ensureRoutedClaudeStatusLine(options)), "");
  }
  // The ready summary describes state AFTER this run's installs; `readySummaryBlock` re-reads the
  // shim and hook axes itself, so the pre-connect `routingInputs` are passed through as-is.
  const readyLines =
    readySet.length > 0 ? ["", RULE, "", ...(await readySummaryBlock(readySet, undefined, routingInputs))] : [];
  console.log(
    [
      ...connectHeaderLines(detection),
      ...prefaceLines,
      ...actionLines,
      RULE,
      "",
      ...activationCopyBlock(),
      ...authorizationLines,
      ...readyLines,
      ""
    ].join("\n")
  );
}

/** Save one narrow authorization per routed workflow selected in the same Mode-2 confirmation. */
async function saveModeAuthorizations(workflows: readonly ReadyToolKey[]): Promise<string[]> {
  const lines: string[] = [];
  // Probed once for the loop: what the authorization can actually compose today.
  const engineReachableForAuthorization = await fullOptimizationReachable();
  for (const workflow of workflows) {
    if (!AUTHORIZE_AUTO_APPLY_WORKFLOWS.includes(workflow as AuthorizeAutoApplyWorkflow)) continue;
    // AUTO-APPLY KEEPS ITS OWN, STRICTER BAR. Counting a PATH-pending capture shim as configured is a
    // truthfulness fix about SET-UP state; it must not silently also widen the conditions under which a
    // narrow auto-apply authorization is stored. Codex therefore still requires a resolve-VERIFIED
    // active shim here, exactly as it did before. Claude Code is deliberately excluded from this check:
    // its authorization has always been stored on the installed (PATH-pending) bar, and nothing about
    // its behavior changes.
    if (workflow !== "claude-code") {
      const shim = verifyShimActive(workflow as ShimTool);
      if (!shim.active) {
        // ...BUT A CONSENT IS NOT DISCARDED FOR FAILING IT. The bar above is about WHEN the
        // authorization may exist, not about whether the user gave it. On a fresh machine the shim is
        // necessarily PATH-pending in the shell that ran onboarding, so skipping outright meant the
        // user consented, was told no further command was needed, and got nothing - for good, because
        // nothing reruns this. When the shim is INSTALLED (something real will activate it), carry the
        // consent instead: it is redeemed automatically the first time Compaction runs with the shim
        // verified active, against this very check. A shim that is not installed has nothing to wait
        // for, so it keeps the pre-existing silent skip.
        if (shim.installed && isCarryableConsentWorkflow(workflow)) {
          try {
            await recordPendingConsent(workflow);
            lines.push(...deferredAuthorizationLines(workflow));
          } catch {
            /* fail-open: no record, no claim - the lines below are only pushed on a successful record */
          }
        }
        continue;
      }
    }
    const result = await savePolicyPreference({
      scope: { tool: workflow, policy_type: DEDUPE_POLICY },
      preference: "auto-when-gates-pass",
      enabled: true,
      gates_required: [...AUTO_APPLY_ELIGIBILITY_GATES]
    });
    if (!result.saved) {
      throw new Error(`could not save the narrow ${workflow} Full optimization authorization: ${result.problems.join("; ")}`);
    }
    lines.push(
      "",
      chalk.green(`  Full optimization authorization saved for ${workflow} (${result.preference.id}).`),
      chalk.dim(
        engineReachableForAuthorization
          ? "    Matching supported requests may compose deterministic input compaction and pre-generation output shaping."
          : "    Output shaping applies now; the input-compaction half needs the adaptive engine, which is not released yet - until then these requests pass through unchanged on the input side."
      ),
      chalk.dim("    Original retained before mutation; fail-open; response unchanged; disable takes effect on the next request."),
      `    ${ACCENT(`compaction policies disable ${result.preference.id}`)}`
    );
  }
  return lines;
}

/**
 * The honest rendering of a CARRIED consent - the state between "you confirmed it" and "it is stored".
 *
 * Deliberately never says "saved": nothing is on disk yet that any request will read, and the whole
 * defect this replaces was a screen implying otherwise. It also names no command to run, because there
 * is none - a `compaction …` line here would reintroduce the hidden second set-up step the enable
 * screen went out of its way to remove. The one command it does print is the WITHDRAWAL, which the user
 * needs precisely because the effect is deferred.
 */
function deferredAuthorizationLines(workflow: CarryableConsentWorkflow): string[] {
  const meta = SHIM_TOOL_LABELS[workflow as CaptureShimTool];
  return [
    "",
    chalk.yellow(`  Full optimization authorization for ${workflow}: confirmed, not stored yet.`),
    chalk.dim(`    The ${meta.title} shim is installed, but this shell's PATH does not resolve it yet, and`),
    chalk.dim("    an authorization is only stored against a verified-active shim."),
    chalk.dim("    Compaction stores it by itself the first time it runs with that shim active - opening a new"),
    chalk.dim("    shell is enough. There is no command to run, and nothing is applied until it is stored."),
    chalk.dim(`    Changed your mind?  ${`compaction init --disconnect ${meta.connectName}`} (or set the mode back to Output only) drops it unstored.`)
  ];
}

/**
 * The persisted optimization-mode confirmation. Cache is measurement-only. Cache + context also
 * stores narrow authorization for verified-ready routed workflows; the Gateway still evaluates all
 * mutation and recovery gates per request. The preference store remains content-free (enum-only).
 */
function modePreferenceBlock(mode: OptimizationModePreference): string[] {
  const label = OPTIMIZATION_MODE_PREFERENCE_LABELS[mode];
  const lines = [
    header("Optimization mode (recorded default)"),
    "",
    `  ${chalk.green(`Saved default: ${label} (${mode}).`)}`,
    chalk.dim(
      mode === "cache-plus-context"
        ? "    With selected routed workflows, this confirmation also stores one narrow authorization; nothing is changed during onboarding."
        : "    Measurement only; model-visible bytes remain unchanged."
    )
  ];
  if (mode === "cache-plus-context") {
    lines.push(
      chalk.dim("    Matching Claude Code/Codex Gateway requests use the existing scoped, recoverable apply path."),
      chalk.dim("    Unsupported or uncertain requests pass through unchanged; Cursor remains measurement-only.")
    );
  }
  lines.push(chalk.dim(`    Stored content-free (optimization_mode only) at ${preferencesPath()}.`));
  return lines;
}


/**
 * A resolved Advanced custom-app setup. The TUI cannot run an interactive child process inside
 * the Ink alt-screen, so it resolves with the entered argv + action and hands off here after
 * the wizard exits.
 */
export interface CustomAppResult {
  command: string[];
  action: "run" | "print";
}

/** Injectable seam for `handleCustomAppResult` (tests spy the runner + the printer; nothing else). */
export interface CustomAppHandlerDeps {
  runGateway?: (command: string[], options: RunThroughGatewayOptions, label?: string) => Promise<void>;
  print?: (line: string) => void;
}

/**
 * Handle a TUI `customApp` result. `run` reuses the existing `runThroughGateway` (record mode
 * only, no key read/injected); `print` writes the durable command line to normal scrollback and
 * runs nothing. The entered command is never persisted. Returns true iff handled (caller skips
 * the Ready-summary path). Injectable so it is unit-testable without a TTY.
 */
export async function handleCustomAppResult(
  customApp: CustomAppResult | undefined,
  deps: CustomAppHandlerDeps = {}
): Promise<boolean> {
  if (!customApp) return false;
  const runGateway = deps.runGateway ?? runThroughGateway;
  const print = deps.print ?? ((line: string) => console.log(line));
  const commandLine = customAppGatewayRunLine(customApp.command.join(" "));
  if (customApp.action === "print") {
    print(`\n  ${commandLine}\n`);
    return true;
  }
  // Reuse the existing gateway-run behavior verbatim; defaults mirror `compaction gateway run`.
  await runGateway(customApp.command, {}, "compaction gateway run");
  return true;
}

/**
 * The workflows a stored auto-apply authorization can cover: the two that route to an
 * apply-capable provider shape. Cursor is structurally excluded (no Gateway routing), and there
 * is deliberately no "all"/global choice - an authorization is always one workflow.
 */
const AUTHORIZE_AUTO_APPLY_WORKFLOWS = ["claude-code", "codex"] as const;
type AuthorizeAutoApplyWorkflow = (typeof AUTHORIZE_AUTO_APPLY_WORKFLOWS)[number];

/**
 * `init --authorize-auto-apply <workflow>` - the one explicit, informed, scoped authorization
 * required before anything is applied automatically; running the flag is the opt-in gesture.
 * Default off (no path arms this without the flag; choosing an optimization mode does not) and
 * never global: one workflow, one policy type; the store rejects global/all scopes.
 */
async function runAuthorizeAutoApply(rawWorkflow: string): Promise<void> {
  const workflow = rawWorkflow.trim().toLowerCase();
  if (workflow === "cursor") {
    console.error(
      "Auto-apply cannot be authorized for Cursor: Compaction has no verified Cursor Gateway route, so no request ever reaches the deterministic apply policy. Nothing was written."
    );
    process.exitCode = 1;
    return;
  }
  if (!AUTHORIZE_AUTO_APPLY_WORKFLOWS.includes(workflow as AuthorizeAutoApplyWorkflow)) {
    console.error(
      `unknown --authorize-auto-apply workflow '${rawWorkflow}'. Valid: ${AUTHORIZE_AUTO_APPLY_WORKFLOWS.join(" | ")} (one workflow - an authorization is never global).`
    );
    process.exitCode = 1;
    return;
  }
  const result = await savePolicyPreference({
    scope: { tool: workflow, policy_type: DEDUPE_POLICY },
    preference: "auto-when-gates-pass",
    enabled: true,
    gates_required: [...AUTO_APPLY_ELIGIBILITY_GATES]
  });
  if (!result.saved) {
    console.error(`Could not save the authorization - nothing was written:\n  ${result.problems.join("\n  ")}`);
    process.exitCode = 1;
    return;
  }
  // Backward-compatible explicit command: it now establishes the same persisted Mode-2 state as
  // the integrated onboarding confirmation, so the authorization is not left dormant by default.
  writeOptimizationMode("cache-plus-context");
  const id = result.preference.id;
  const lines = [
    "",
    header("Auto-apply authorized (explicit, scoped)"),
    "",
    chalk.green(`  Saved policy ${id}: deterministic context apply for the "${workflow}" workflow (policy ${DEDUPE_POLICY}).`),
    `  Visible and editable anytime:  ${ACCENT(`compaction policies list`)}   ·   ${ACCENT(`compaction policies explain ${id}`)}`,
    "",
    "  What you authorized - all of this holds on every application:",
    `    - Future eligible ${workflow} requests routed through the local Gateway (started with`,
    `      ${ACCENT(`compaction gateway start --workflow ${workflow}`)}) have exact-duplicate large blocks`,
    "      in your own request text removed automatically - no per-run ask.",
    `    - ONLY when every safety gate passes on that request: ${AUTO_APPLY_ELIGIBILITY_GATES.join(", ")}.`,
    "      Unsupported, uncertain, out-of-scope, or failing requests are forwarded UNCHANGED.",
    "    - The exact original request is retained locally BEFORE any change and is byte-exact",
    `      recoverable:  ${ACCENT("compaction gateway recover <recovery_id>")}`,
    `    - Every automatic application is recorded content-free:  ${ACCENT("compaction activity")}`,
    "    - Provider responses are never modified. A Compaction failure never blocks your workflow.",
    `    - Scope is exactly this one workflow ("${workflow}") - never global, never another tool.`,
    "    - No output-token, cost, or billing claim is made; reductions are labeled local estimates.",
    "",
    "  Turn it off anytime (takes effect on the very next run):",
    `    ${ACCENT(`compaction policies disable ${id}`)}`,
    ""
  ];
  console.log(lines.join("\n"));
}

/**
 * Disable any stored auto-apply authorization for a workflow being disconnected, a disconnected
 * tool must not keep a live authorization behind it. Best-effort and always safe (disable only).
 */
async function disableAutoApplyAuthorizationsFor(tool: string): Promise<string[]> {
  const disabled: string[] = [];
  try {
    // The device store - the one place an authorization can live, so disconnecting cannot leave a live
    // one behind somewhere the disconnect did not look.
    const store = authorizationStoreDirectory();
    const { preferences } = await readPolicyPreferences(store);
    for (const preference of preferences) {
      if (preference.scope.tool === tool && preference.enabled) {
        const result = await disablePolicyPreference(preference.id, store);
        if (result.disabled) disabled.push(preference.id);
      }
    }
  } catch {
    // Unreadable store → nothing to disable safely; the disconnect itself still proceeds.
  }
  return disabled;
}

export function registerInitCommand(program: Command): void {
  program
    // isDefault: bare `compaction` (no subcommand) opens onboarding, the connect-once install screen
    // (tool detection + "Enable Compaction for" menu) in a real terminal (TUI), or the same connect-once
    // model as a static screen elsewhere. `--help` still shows help, and a mistyped subcommand
    // (`compaction statsu`) still fails as an unknown command: default-command dispatch bypasses
    // commander's unknown-command error, so the action below restores it for default-dispatched operands.
    .command("init", { isDefault: true })
    .description(
      "First-run onboarding: the connect-once install screen (detect supported AI tools + enable " +
        "Compaction once) in a real terminal (TUI), or the same connect-once model as a static screen " +
        "elsewhere. The default screen writes NOTHING (read-only local detection, no network, no " +
        "credentials). All detected tools are preselected in the TUI; one explicit confirmation enables " +
        "the selected set. Use the named --connect commands for non-interactive setup."
    )
    .option("--path <path>", "Focus one input path: claude-code | openai-agents | codex | import")
    .option(
      "--connect <choice>",
      "Connect once by name: claude-code | codex | cursor | all. `all` includes detected tools only. Named workflows install and verify their supported hook/shim bundle. Every workflow sets up PATH by default (announced, backed up, idempotent; opt out with --no-write-shell-config); readiness is never claimed without verification."
    )
    .option(
      "--mode <mode>",
      "Persist your DEFAULT optimization mode (recorded preference only - enables no apply/auto-apply, changes nothing model-visible): cache | cache-plus-context. `cache` = record + provider-side cache proof where supported; `cache-plus-context` = additionally the EXISTING approval-gated apply mode you still start explicitly. Stored content-free (optimization_mode only) at ~/.compaction/preferences.json."
    )
    .option(
      "--disconnect <choice>",
      "Reversibly disconnect by name: claude-code | codex | cursor. Claude Code and Codex remove their routing shim (and shared PATH line when unused); Cursor removes its capture shim; Codex/Cursor also remove native Compaction hooks. Stored auto-apply authorization for that tool is disabled. The real binary is never touched."
    )
    .option(
      "--authorize-auto-apply <workflow>",
      "EXPLICIT scoped opt-in (off by default; running this flag IS the authorization): store one enabled policy so future ELIGIBLE <workflow> requests (claude-code | codex) through the local Gateway are deterministically deduped automatically - only when every safety gate passes; original always retained + recoverable; every application recorded content-free; disable anytime with `compaction policies disable <id>`. Never global; choosing an optimization mode does NOT arm this."
    )
    .option(
      "--write-shell-config",
      "Append the shim PATH line to your shell rc (zsh/bash), writing a reversible .bak backup first. This is already the DEFAULT for every workflow, so the flag is only useful to state it explicitly; see --no-write-shell-config to opt out."
    )
    .option(
      "--no-write-shell-config",
      "Do NOT touch your shell config - print the one PATH line to add yourself instead. Without this flag, connecting ANY workflow (Claude Code, Codex, Cursor) appends the shim PATH line to your shell rc (announced, backed up to .compaction.bak, idempotent, removed again by the matching --disconnect)."
    )
    .option("--user", "Default. Install the Claude Code integration into ~/.claude/settings.json so it stays connected in every project.")
    .option("--project", "Advanced: scope the Claude Code integration to this project's .claude/settings.json instead of your user settings.")
    .option("--dry-run", "With --connect: show what the Claude Code hook install would write, but write nothing.")
    .option(
      "--projects-dir <dir>",
      "Claude Code projects directory to detect against (default: the standard local location)"
    )
    .option("--interactive", "prefer the interactive TUI; if no TTY is available, show the static screen and why")
    .option("--static", "always show the plain static screen (no TUI)")
    .action(
      async (options: {
        path?: string;
        connect?: string;
        mode?: string;
        disconnect?: string;
        authorizeAutoApply?: string;
        writeShellConfig?: boolean;
        user?: boolean;
        dryRun?: boolean;
        projectsDir?: string;
        interactive?: boolean;
        static?: boolean;
      },
      command: Command
      ) => {
        // Reached via default-command dispatch (bare `compaction …`, not `compaction init …`),
        // a positional operand is a mistyped subcommand, not init input. Default-command
        // dispatch bypasses commander's unknown-command error, which would silently swallow
        // the typo into the onboarding screen with exit 0, fail exactly as a program without
        // a default command would (unknown-command message + suggestion, exit 1) instead.
        // Explicit `compaction init …` is unaffected: operands there stay ignored.
        if (process.argv[2] !== "init" && command.args.length > 0) {
          // `unknownCommand` is commander-internal but the only renderer of the canonical
          // message including the "(Did you mean …?)" suggestion; the public error() below is
          // the same-message fallback should a future commander version remove it.
          const parent = command.parent as (Command & { unknownCommand?: () => never }) | null;
          if (parent && typeof parent.unknownCommand === "function") parent.unknownCommand();
          (parent ?? command).error(`error: unknown command '${command.args[0]}'`, {
            code: "commander.unknownCommand"
          });
        }
        // Backward-compatible explicit authorization command. Normal onboarding stores this same
        // narrow authorization as part of the Cache + context confirmation.
        if (options.authorizeAutoApply !== undefined) {
          await runAuthorizeAutoApply(options.authorizeAutoApply);
          return;
        }
        // Validate --path early so the error stays a clean one-liner.
        if (options.path && !ALL_WORKFLOW_KEYS.includes(options.path)) {
          console.error(`unknown --path '${options.path}'. Valid: ${ALL_WORKFLOW_KEYS.join(" | ")}`);
          process.exitCode = 1;
          return;
        }

        // Version read at runtime so it always matches the installed package.
        const version = await readPackageVersion();

        // Read-only local detection (no writes, no network); carries the verified hook/shim
        // state that drives the found/ready/not-found rows on both surfaces.
        const projectsDir = options.projectsDir ?? defaultProjectsDir();
        const det = await detectClaudeCode(projectsDir);
        const detection = await computeConnectDetection(det);
        const readyRoutingInputs = await computeReadyRoutingInputs();

        // --disconnect: reversibly remove a named workflow shim.
        if (options.disconnect !== undefined) {
          const choice = CONNECT_ALIASES[options.disconnect.trim().toLowerCase()];
          if (choice === "claude-code") {
            // Reversible routing disconnect: remove the claude shim and stop THIS project's
            // transparent-routing gateway (only the exact plain-record shape ensure starts; a
            // workflow-scoped or apply-mode gateway the user started explicitly is left running).
            // The consented Stop hook is deliberately untouched (it is the measurement surface,
            // removed via `compaction hooks uninstall`), and stored policy authorizations are not
            // changed: the record-only shim never used them.
            const uninstalled = uninstallToolShim("claude-code");
            const gw = stopTransparentRoutingGateway(process.cwd(), "anthropic");
            // Remove ONLY the compaction status line we added (a user's own is left untouched). Same
            // settings scope the connect used (--user → ~/.claude, else project .claude). Fail-open.
            // SYMMETRY: connect may have written user scope (today's default) or project scope (an
            // older install, or --project). Disconnect must clear BOTH, or a disconnect run from one
            // directory silently strands a still-firing integration in the other scope.
            const disconnectPaths = claudeSettingsReadPaths();
            let statusLineRemoved = false;
            for (const settingsFile of disconnectPaths) {
              try {
                if ((await disconnectClaudeCodeStatusLine(settingsFile)).removed) statusLineRemoved = true;
              } catch {
                /* fail-open: the routing disconnect still stands */
              }
            }
            // Remove ONLY Compaction's before-call SHAPING hook (the subscription apply lever connect wired);
            // the Stop hook is deliberately left (measurement, removed via `hooks uninstall`). Fail-open.
            let shapingHookRemoved = false;
            for (const settingsFile of disconnectPaths) {
              try {
                if ((await disconnectClaudeCodeShapingHook(settingsFile)).removed) shapingHookRemoved = true;
              } catch {
                /* fail-open: the routing disconnect still stands */
              }
            }
            const lines = [
              `  ${chalk.bold("▸ Claude Code")} ${chalk.green("- routing disconnected")}`,
              "",
              uninstalled.status === "removed"
                ? chalk.green(`    Removed the claude routing shim (${uninstalled.shimPath}). The real claude binary was never touched.`)
                : chalk.dim(`    No claude routing shim was installed (${uninstalled.shimPath}); nothing to remove.`),
              gw.stopped
                ? chalk.green(
                    `    Removed the routing slot and stopped the routing gateway (pid ${gw.pid}). Nothing revives it.`
                  )
                : chalk.dim(`    Routing gateway: ${gw.reason ?? "not running"}.`),
              statusLineRemoved
                ? chalk.green("    Removed the compaction status line from your Claude Code settings (any status line of your own was left untouched).")
                : chalk.dim("    No compaction status line to remove (a status line of your own is never touched)."),
              shapingHookRemoved
                ? chalk.green("    Removed the before-call output-shaping hook from your Claude Code settings (your prompts are no longer shaped; other hooks untouched).")
                : chalk.dim("    No before-call output-shaping hook to remove (only Compaction's own is ever touched)."),
              chalk.dim("    The consented Stop hook (post-session measurement) is unchanged - remove it with:  compaction hooks uninstall"),
              chalk.dim("    Open a new shell so the PATH change takes effect.")
            ];
            // The shell-rc PATH line is shared by all Compaction shims: restore it ONLY when no
            // other shim remains installed (never deactivate a still-connected Codex/Cursor shim).
            if (!verifyShimActive("codex").installed && !verifyShimActive("cursor").installed) {
              const rc = removeShellConfigPathLine();
              if (rc.status === "removed") {
                lines.push(
                  chalk.green(
                    `    Reverted the shell-rc PATH line in ${rc.rcPath}` + (rc.backupRestored ? ` (restored from ${rc.backupRestored}).` : ".")
                  )
                );
              }
            }
            // ...and stop driving the gateway's `--workflow`/provider defaults. Fail-open (best-effort).
            try {
              removeConnectedWorkflow("claude-code");
            } catch {
              /* fail-open: the disconnect itself still stands */
            }
            console.log([...connectHeaderLines(detection), ...lines, "", RULE, ""].join("\n"));
            return;
          }
          const shimTool: CaptureShimTool | undefined = choice === "codex" ? "codex" : choice === "cursor" ? "cursor" : undefined;
          if (!shimTool) {
            console.error(`unknown --disconnect '${options.disconnect}'. Valid: claude-code | codex | cursor`);
            process.exitCode = 1;
            return;
          }
          const uninstalled = uninstallToolShim(shimTool);
          // THE SHELL-RC PATH LINE IS SHARED BY EVERY COMPACTION SHIM - the same guard Claude Code's
          // `--disconnect 1` applies a few lines above. Removing it unconditionally here deactivated a
          // sibling shim that is still installed: `--connect all` followed by `--disconnect 2` stripped
          // the PATH line while the Cursor shim remained, silently ending Cursor capture in every new
          // shell. Now that the line is written by DEFAULT, that is the ordinary case rather than an
          // edge one. Only the last shim out takes the shared line with it.
          const shimsRemaining = (Object.keys(SHIM_TOOLS) as ShimTool[]).filter((t) => verifyShimActive(t).installed);
          const rc = shimsRemaining.length === 0 ? removeShellConfigPathLine() : undefined;
          const lines = shimDisconnectBlock(shimTool, uninstalled.status === "removed", uninstalled.shimPath, rc);
          // AND THE NATIVE HOOKS. Connect installs them, so disconnect has to take them out: removing
          // only the PATH shim left a model-visible shaping hook firing on every turn under the word
          // "disconnected". Claude Code's `--disconnect 1` already removes its own shaping hook; this
          // is the same promise for the other two. Only OUR entries are removed, the file is backed up
          // first, and a failure is reported rather than thrown (the shim disconnect still stands).
          try {
            lines.push(...subscriptionHooksDisconnectBlock(await uninstallSubscriptionHooks(shimTool)));
          } catch {
            /* fail-open: the shim disconnect stands; the hook removal is reported by its own block */
          }
          // A disconnected tool must not keep a live auto-apply authorization behind it.
          const disabledAuthorizations = await disableAutoApplyAuthorizationsFor(shimTool);
          for (const id of disabledAuthorizations) {
            lines.push(chalk.green(`    Disabled the stored auto-apply authorization ${id} for ${shimTool} (nothing is applied automatically under it).`));
          }
          // ...nor an UNREDEEMED one. A consent carried to activation is the one authorization state a
          // user cannot revoke by id, because no id exists yet; disconnecting is how they take it back,
          // and a consent that outlived that would be a consent they could not withdraw.
          if (isCarryableConsentWorkflow(shimTool)) {
            try {
              await clearPendingConsent(shimTool);
            } catch {
              /* fail-open: the shim is gone either way, so nothing can redeem it */
            }
          }
          // ...and must not keep driving the gateway's `--workflow` default. Fail-open (best-effort).
          if (isConnectedRoutableWorkflow(shimTool)) {
            try {
              removeConnectedWorkflow(shimTool);
            } catch {
              /* fail-open: the disconnect itself still stands */
            }
          }
          console.log([...connectHeaderLines(detection), ...lines, "", RULE, ""].join("\n"));
          return;
        }

        // Headless setup (`--connect` and/or `--mode`): validate, persist the mode default,
        // enable via the real reversible installers, and print the Ready summary from actual
        // state. No TUI. Nothing has been written until this block runs.
        if (options.connect !== undefined || options.mode !== undefined) {
          // Validate --mode before any write.
          if (options.mode !== undefined && !isOptimizationModePreference(options.mode.trim())) {
            console.error(
              `unknown --mode '${options.mode}'. Valid: ${OPTIMIZATION_MODE_PREFERENCES.join(" | ")}`
            );
            process.exitCode = 1;
            return;
          }

          // Resolve + validate the --connect selection before any write.
          let selection: ConnectSelection | undefined;
          if (options.connect !== undefined) {
            const resolvedSelection = resolveConnectSelection(options.connect, detection);
            if (resolvedSelection.error || !resolvedSelection.selection) {
              console.error(resolvedSelection.error ?? `unknown --connect '${options.connect}'.`);
              process.exitCode = 1;
              return;
            }
            selection = resolvedSelection.selection;
          }

          // Persist the mode first. Cache changes no request; cache-plus-context is paired below
          // with narrow authorizations only for workflows that actually verify ready.
          let prefaceLines: string[] = [];
          if (options.mode !== undefined) {
            const mode = options.mode.trim() as OptimizationModePreference;
            writeOptimizationMode(mode);
            prefaceLines = [...modePreferenceBlock(mode), ""];
          }

          // Enable the selection (if any); else mode-only screen.
          if (selection) {
            await runConnectSelection(
              selection,
              options,
              detection,
              prefaceLines,
              readyRoutingInputs,
              options.mode?.trim() as OptimizationModePreference | undefined
            );
          } else {
            console.log([...connectHeaderLines(detection), ...prefaceLines, RULE, ""].join("\n"));
          }
          return;
        }

        // Decide static vs interactive. A focused path (--path) or --static always
        // serves static; --interactive forces the TUI iff a TTY is present;
        // otherwise auto-detect.
        // Note: --interactive cannot conjure a TTY (raw-mode keyboard nav needs
        // one), so it does not override the TTY check; it only documents intent.
        // When asked for but unavailable, we fall back to static with a reason.
        const focus = options.path;
        const ttyDecision = decideInteractiveTuiFromProcess();
        const wantTui = !focus && !options.static && ttyDecision.useTui;

        if (wantTui) {
          // Dynamic import keeps Ink/React off non-TTY paths. The production onboarding flow drives
          // the SAME real enable engine via injected callbacks (`onEnable` is the only write, on the
          // review Enable consent); `onPersistMode` persists the chosen mode + any narrow apply
          // authorization. The ready screen shows the REAL verified status and the HONEST metric
          // (from local receipts, or "unavailable until measured" at first install) - never a
          // simulated number. The durable Ready summary is re-printed here because the alt-screen is
          // wiped on exit.
          const { runOnboardingTui } = await import("../onboarding/OnboardingTui.js");
          const readyMetric = await computeReadyMetric();
          // Captured so the recovery guidance can be RE-PRINTED to normal scrollback below: the
          // alt screen is wiped on exit, so anything the activation screen said is gone by then.
          let communityOutcome: OnboardingAuthOutcome | undefined;
          // Same reason: the Pro handoff URL is on the alt screen, which is wiped on exit. A user
          // whose browser never opened would otherwise be left with no link and no way back to one.
          let proWaitlistUrl: string | undefined;
          // What `onEnable` actually connected. Activation needs it to answer "will the next turn be
          // a full apply?" — the authorization gate is per workflow — and only this closure knows it
          // without widening the content-free activation seam.
          let enabledWorkflows: ReadyToolKey[] = [];
          // Did this run put ANYTHING on disk? Set by the write callbacks themselves, so it can only
          // ever be true when a write actually ran. The closing line below is otherwise free to tell a
          // user "nothing was written" over a preferences file (and, on a failed-verify install, a shim)
          // this very run had just created - a user who quits BEFORE the Enable consent still reaches
          // none of these callbacks, so the honest "nothing was written" line stays reachable for them.
          let wroteToDisk = false;
          // Did THIS run write the Codex hook? The alt-screen ready page is wiped on exit and cannot
          // carry an action item, so the one-time trust continuation is re-printed to scrollback below.
          let codexTrustPending = false;
          // Silent renew for a returning signed-in device BEFORE the plan screen renders, so
          // "Community active" reflects a refreshed lease rather than expired authorization while
          // onboarding still correctly reports that the user is signed in.
          if (readStoredCredentials(process.env) !== undefined) {
            try {
              await ensureCommunityRuntime(process.env, () => {}, { leaseOnly: true });
            } catch {
              // Best-effort: the plan screen still distinguishes identity from authorization.
            }
          }
          const { hasValidFullApplyLease } = await import("../../core/entitlement/lease-store.js");
          const result = await runOnboardingTui({
            version,
            detection,
            readyRouting: readyRoutingInputs,
            readyMetric,
            readyStatusFor: (enabled, modeKey) =>
              computeOnboardingReadyStatus(enabled, fromModelOptimizationModeKey(modeKey)),
            onEnable: async (keys) => {
              const enabled = await tuiEnable(keys, options);
              enabledWorkflows = enabled.connected;
              codexTrustPending = enabled.codexHookNewlyInstalled;
              // A verify-failed install still ATTEMPTED a shim write, so it counts as touching disk
              // even though it is never counted as connected.
              if (enabled.connected.length > 0 || enabled.failed.length > 0) wroteToDisk = true;
              return enabled;
            },
            onPersistMode: async (modeKey, workflows) => {
              // `workflows` is the TUI's final verified set: newly connected plus selected tools that
              // were already ready. Community activation must evaluate that whole set rather than
              // treating a read-only re-run as if no workflow were connected.
              enabledWorkflows = workflows;
              const mode = fromModelOptimizationModeKey(modeKey);
              writeOptimizationMode(mode);
              wroteToDisk = true;
              if (mode === "cache-plus-context") await saveModeAuthorizations(workflows);
            },
            // The plan's apply posture. ALL THREE plans persist the Open floor (`basic`) here, before
            // any account or browser step: a Community user who abandons the confirmation, and a Pro
            // user whose browser never opens, are both left with a working Open setup rather than
            // below one. Pro in particular writes NOTHING of its own — there is no Pro entitlement,
            // no Pro flag, and no local record that Pro was chosen, because none of those would be
            // true of the device.
            onPersistPlan: async (plan) => {
              writeProductMode("basic");
              wroteToDisk = true;
              void plan;
              return "basic";
            },
            fullOptimizationReachable: await fullOptimizationReachable(),
            onCommunityAuth: async (onProgress, signal) => {
              const outcome = await runCommunityActivation(onProgress, signal, enabledWorkflows);
              communityOutcome = outcome;
              return outcome;
            },
            // THE PRO HANDOFF. Reuses `proUrl` — the same resolver `compaction upgrade` uses, honoring
            // the same `COMPACTION_PRO_URL` / `COMPACTION_WEB_ORIGIN` overrides — so onboarding is a
            // second DOOR to the one Pro path, never a second Pro path. Records the URL so it can be
            // re-printed to durable scrollback after the alt screen is torn down.
            onOpenWaitlist: async () => {
              const url = proUrl(process.env);
              proWaitlistUrl = url;
              openBrowser(url, process.env);
              return url;
            },
            // Identity vs authorization: credentials prove signed-in; a verified lease proves Community.
            // The stepper uses signedIn only to skip a second browser round trip; it must never see credentials.
            signedIn: readStoredCredentials(process.env) !== undefined,
            communityAuthorized: hasValidFullApplyLease(process.env),
            // THE FIRST-WRITE DISCLOSURE. The review screen is the consent gate, so it must name every
            // file the enable touches - including the tool's own hooks config, which is what actually
            // attaches an instruction to what the model sees. Resolved HERE from the real installer
            // (path + entry list), so the screen can never describe a different write than the one that
            // runs. Returns undefined when nothing will be written: the tool has no hook config, or
            // shaping is switched off (`compaction stop` / COMPACTION_SHAPING_HOOKS=0) and the same
            // gate below will skip the install. Read fresh per render so a switch flipped mid-flow is
            // honored by the screen, not just by the installer.
            hookDisclosure: (key) => {
              if (key !== "codex" && key !== "cursor") return undefined;
              if (!isShapingHooksActivated()) return undefined;
              const file = subscriptionHookConfigPath(key);
              return { file, backupPath: `${file}.compaction.bak`, entries: subscriptionHookEntries(key) };
            }
          });
          // Re-print the Community outcome to durable scrollback. The alt screen took the activation
          // screen with it, so a user whose confirmation failed would otherwise be left with a
          // working install and no idea what happened to the account they asked for.
          if (communityOutcome && !communityOutcome.ok) {
            const { headline, detail } = onboardingAuthFailureLines(
              communityOutcome.reason,
              communityOutcome.serviceStatus
            );
            console.log(
              ["", chalk.yellow(`Community was not activated: ${headline}`), chalk.dim(`  ${detail}`),
                ...ONBOARDING_AUTH_FALLBACK_LINES.map((l) => chalk.dim(`  ${l}`))].join("\n")
            );
          } else if (communityOutcome && communityOutcome.ok && communityOutcome.effectiveMode !== "full") {
            console.log(
              ["", chalk.dim(`Community account active. Full apply is not enabled on this device yet ` +
                `(${communityOutcome.fullApplyPendingReason ?? "no entitlement lease"}); you are on Open basic shaping.`),
                // Only when the entitlement is fine and the gap is the user's own local configuration:
                // state what full apply requires, once. Never an instruction, a price, or a URL.
                ...(isLocalFullApplyGateReason(communityOutcome.fullApplyPendingReason)
                  ? [chalk.dim(FULL_APPLY_REQUIREMENT_LINE)]
                  : [])].join("\n")
            );
          }
          // THE PRO RETRY PATH, in durable scrollback. The waitlist screen carried the link and the
          // alt screen took it away on exit. This is the whole recovery for "the browser never
          // opened": the URL, and the fact that nothing is broken without it.
          if (proWaitlistUrl !== undefined) {
            console.log(
              ["", chalk.dim("Pro waitlist (nothing was purchased and no Pro entitlement was created):"),
                chalk.dim(`  ${proWaitlistUrl}`),
                chalk.dim("  This device is set up and running on Open shaping either way; `compaction upgrade` reopens this.")
              ].join("\n")
            );
          }
          if (result.enabled.length > 0) {
            // POST-INSTALL truth, re-read here. `readyRoutingInputs` was computed before the enable
            // ran, so both halves of this durable summary resolve the hook axis from the tool's own
            // config now: the summary block does it internally, and the per-turn block is given the
            // same `confirmedShapingHooks` answer. Anything else re-prints the machine as it was.
            const confirmedHooks = await confirmedShapingHooks(result.enabled);
            console.log(
              [
                "",
                RULE,
                "",
                ...(await readySummaryBlock(result.enabled, result.mode, readyRoutingInputs)),
                "",
                ...readyPerTurnLinesForTools(result.enabled, confirmedHooks).map((l) => chalk.dim(l)),
                // Directly after the Codex per-turn line, which says "hook installed" - true, and not yet
                // sufficient. This is the last thing printed because it is the only thing left to do.
                ...(codexTrustPending ? ["", ...codexTrustContinuationLines("  ")] : []),
                ""
              ].join("\n")
            );
          } else if (wroteToDisk) {
            // NOTHING ENABLED, BUT THE DISK WAS TOUCHED. "Nothing was written" is a promise about the
            // machine, and this run kept files on it (at minimum the preferences the mode/plan steps
            // persist). Saying otherwise is not a tone problem - it sends the user away believing there
            // is nothing to undo. Name the reversal instead of the falsehood.
            console.log(
              chalk.dim(
                "\nNo workflow was enabled, so nothing is being measured or shaped yet. Your saved preferences remain in " +
                  `${preferencesPath()}; use \`compaction init --disconnect <tool-name>\` to reverse a workflow connection. ` +
                  "Run `compaction` anytime.\n"
              )
            );
          } else {
            console.log(chalk.dim("\nNothing enabled - nothing was written. Run `compaction` anytime.\n"));
          }
          return;
        }

        // If the user explicitly asked for --interactive but we are not in a TTY,
        // tell them why we fell back, then serve the static screen.
        if (options.interactive && !ttyDecision.useTui) {
          console.error(
            chalk.dim(`(interactive TUI unavailable here: ${ttyDecision.reason}; showing static screen)`)
          );
        }

        console.log(buildStaticScreen(version, focus, detection));
      }
    );
}
