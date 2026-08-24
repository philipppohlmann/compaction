/**
 * Local readiness report for `compaction status` (PUBLIC CLI, engine-free).
 *
 * Answers one question honestly: "what can I actually run through Compaction on THIS machine right now,
 * and what is missing?" It reports detected tools + connect status, gateway health, local storage
 * readiness, credential PRESENCE, stored auto-apply authorizations, what routes vs what only measures,
 * and the exact next commands for the detected state.
 *
 * Invariants (hold on every path):
 *  - READ-ONLY: writes nothing, installs nothing, makes no network call (the gateway probe is a local
 *    TCP connect to a locally recorded port).
 *  - CONTENT-FREE: no prompt/response content is read or shown. Credentials are reported as SET/unset
 *    ONLY, a credential VALUE is never read beyond truthiness and never printed or serialized.
 *  - FAIL-OPEN: a section that cannot be computed reports "unknown" instead of failing the command;
 *    the report never fails the command (it is a report, not a gate).
 *  - HONEST LABELS: routing/receipts are fixture-tested in CI; live provider cache proof is key-gated
 *    and operator-run; nothing here is billing-confirmed; Cursor is measure-only (vendor gap); LCM is
 *    shadow-only; subscription routing is available ONLY as the explicit `--subscription` opt-in
 *    (keyless; credential-free; not yet live-proven, never auto-enabled).
 */
import { existsSync, accessSync, constants as fsConstants, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { defaultProjectsDir, discoverClaudeCodeSessions } from "../../core/adapters/claude-code-discovery.js";
import { isStopHookInstalled, isStatusLineInstalled, isShapingHookInstalled } from "../../core/claude-code-connect.js";
import { isShapingHooksActivated } from "../../core/output-shaping-hook-activation.js";
import { isSubscriptionShapingHookInstalled } from "../../core/subscription-hooks-install.js";
import {
  codexShapingHookTrust,
  type CodexHookTrustStatus,
  CODEX_TRUST_ACTION_COMMAND,
  CODEX_TRUST_ACTION_CONTROL,
  CODEX_TRUST_ACTION_HEADING,
  type CodexShapingHookState
} from "../../core/codex-hook-trust.js";
import type { SubscriptionHookTool } from "../../core/subscription-shaping-hooks.js";
import { isReceiptLineEnabled } from "../../core/gateway/receipt-line.js";
import { SHIM_TOOLS, verifyShimActive, resolveExecutableOnPath, type ShimTool } from "../../core/tool-shim.js";
import { getGatewayStatus, readReceipts } from "../../core/gateway/status.js";
import { GATEWAY_RECOVERY_DIR } from "../../core/gateway/recovery.js";
import { liveVerificationsForMatrix } from "../../core/gateway/verification-store.js";
import {
  readPolicyPreferences,
  gatesAreEngineEvaluable,
  DEFAULT_POLICY_PREFERENCES_DIRECTORY,
  POLICY_PREFERENCES_FILENAME
} from "../../core/policy-preferences.js";
import { DEDUPE_POLICY } from "../../core/gateway/request-shape.js";
import {
  readOptimizationMode,
  readConnectedWorkflows,
  type OptimizationModePreference
} from "../../core/onboarding-preferences.js";
import { DEFAULT_ACTIVITY_DIRECTORY, ACTIVITY_LOG_FILENAME } from "../../core/activity-store.js";

type Presence = "set" | "unset";

interface ShimConnectState {
  shim: "active" | "installed-not-on-path" | "not-installed";
  binaryFound: boolean;
  /**
   * Whether this tool's OWN native shaping hook is installed and the global switch is clear. Codex and
   * Cursor have their own hooks (`core/subscription-shaping-hooks.ts`), entirely separate from Claude
   * Code's - so a record-only claim that consulted only Claude Code told a Codex or Cursor user that
   * nothing is attached to what the model sees while their hook was attaching an instruction.
   *
   * For CODEX this additionally requires Codex's own NATIVE TRUST (`core/codex-hook-trust.ts`): a
   * configured-but-untrusted hook is SILENTLY inert, so config-on-disk alone is not evidence that
   * anything reaches the model. See `shapingState` for the state that distinguishes the two.
   */
  shapingActive: boolean;
  /**
   * The finer state behind `shapingActive`, present only for a tool that HAS a native gate beyond its
   * config file (today: Codex). `approval-required` is the state a one-time native approval resolves;
   * `unknown` means the question was not asked (the live probe is opt-in) OR could not be answered.
   */
  shapingState?: CodexShapingHookState;
  /**
   * Whether this tool's shaping hook is present ON DISK - a different question from whether the tool
   * will RUN it, and one this report can always answer for free. Kept separate so `unknown` trust does
   * not erase the fact that a config exists, which is what the user needs to be told about.
   */
  shapingConfigured?: boolean;
  /**
   * Whether the live trust probe was actually EXECUTED - never merely requested. Two things read it:
   * `unknown` has two causes that deserve different sentences ("we did not ask" vs "we asked and Codex
   * did not answer"), and the report header discloses that Codex was started. Setting it from the
   * requested option made both lie on a machine with no Codex hook configured, where `--check-codex`
   * starts nothing at all.
   */
  shapingTrustProbed?: boolean;
  /**
   * The trust status Codex itself reported, preserved so a `disabled` rendering can say whether trust
   * is ALSO missing. Dropping it made the combined state describe an untrusted hook as trusted.
   */
  shapingTrustStatus?: CodexHookTrustStatus;
}

interface StoredAuthorization {
  authorized: boolean;
  id?: string;
}

/** The full content-free report. Enum/boolean/count fields only, no content, no credential values. */
export interface ReadinessReport {
  tools: {
    claudeCode: {
      sessionsFound: number | "unknown";
      stopHookInstalled: boolean;
      connected: boolean;
      /** Transparent-routing (`claude`) shim state - resolve-verified, read-only. */
      routingShim: "active" | "installed-not-on-path" | "not-installed";
      /** Whether Compaction's per-turn VISIBLE status line is wired in the project or user settings. */
      statusLineInstalled: boolean;
      /**
       * Whether output shaping is actually in force for Claude Code: the `UserPromptSubmit` shaping hook
       * present in a settings file Claude Code reads AND the global switch clear. `status` used not to
       * carry this at all, which is why it could print a flat record-only boundary while the hook was
       * installed and attaching an instruction to every shapeable turn.
       */
      shapingActive: boolean;
    };
    codex: ShimConnectState;
    cursor: ShimConnectState;
  };
  gateway: {
    running: boolean;
    base?: string;
    pid?: number;
    provider?: string;
    mode?: string;
    workflow?: string;
    receiptsCount: number;
    lastRequestAt?: string;
  };
  storage: {
    root: string;
    writable: boolean;
    receipts: { present: boolean; count: number };
    recovery: { present: boolean };
    activity: { present: boolean; count: number };
    policies: { present: boolean; count: number };
  };
  credentials: {
    /** Presence only, the value is never read beyond truthiness and never printed. */
    ANTHROPIC_API_KEY: Presence;
    OPENAI_API_KEY: Presence;
    /** Availability label only, never a credential and never a live-proven claim. */
    subscriptionRouting: "available-explicit-opt-in";
  };
  optimizationMode: OptimizationModePreference;
  connectedWorkflows: string[];
  authorizations: { "claude-code": StoredAuthorization; codex: StoredAuthorization };
  routes: { "claude-code": "routable"; codex: "routable"; cursor: "measure-only"; lcm: "shadow-only" };
  liveVerifiedProviders: string[];
  /**
   * TRUE when Claude Code routing is present but the per-turn VISIBLE status line is not wired (and
   * the receipt-line kill switch is not set) - the honest "routed but silent" nudge condition.
   */
  claudeRoutedButLineUnwired: boolean;
  nextCommands: string[];
}

/**
 * The home directory THIS report is about, resolved from the environment it was handed.
 *
 * `runStatus({ env })` runs in-process with an injected environment, so every path this report derives
 * has to come from that env - reading the ambient `HOME` makes the report describe a different machine
 * state than the one it was asked about. Same `env.HOME` -> `homedir()` fallback semantics the shim
 * resolver already uses (`core/tool-shim.ts`), so an unset HOME behaves exactly as before.
 */
function reportHome(env: NodeJS.ProcessEnv): string {
  const fromEnv = (env.HOME ?? "").trim();
  return fromEnv !== "" ? fromEnv : homedir();
}

/**
 * The two settings files Claude Code actually reads, project first then user, for a given environment.
 * One helper so the Stop-hook, status-line, and shaping probes can never disagree about WHERE to look -
 * they answer three questions about the same two files.
 */
function claudeSettingsPaths(cwd: string, env: NodeJS.ProcessEnv): readonly string[] {
  return [path.join(cwd, ".claude", "settings.json"), path.join(reportHome(env), ".claude", "settings.json")];
}

/**
 * Whether a subscription tool's MODEL-VISIBLE shaping hook is installed, asked of the canonical per-tool
 * probe (`isSubscriptionShapingHookInstalled`) rather than a second, hand-rolled notion of "is shaping on
 * here".
 *
 * That probe, and not `areSubscriptionHooksInstalled`: the latter also demands Codex's model-invisible
 * `Stop` turn-line entry, so a config carrying only the shaping hook would answer `false` and print the
 * record-only claim over an instruction that IS being attached. A claim about what the model sees may
 * only be gated on the entry that changes what the model sees.
 *
 * Both the home and the cwd come from this report's environment, for the same reason every other path
 * on this surface does. Codex is checked at BOTH locations it actually reads - the user-level
 * `~/.codex/hooks.json` and the repo-local `.codex/hooks.json` - because "installed at only the local
 * one" is a real state, and answering `false` there would again print record-only over a live hook.
 * Never throws; unreadable answers false.
 */
async function subscriptionShapingInstalled(
  tool: SubscriptionHookTool,
  cwd: string,
  env: NodeJS.ProcessEnv
): Promise<boolean> {
  const home = reportHome(env);
  try {
    if (await isSubscriptionShapingHookInstalled(tool, { home, cwd })) return true;
    if (tool === "codex") return await isSubscriptionShapingHookInstalled(tool, { home, cwd, local: true });
    return false;
  } catch {
    return false;
  }
}

function shimState(
  tool: ShimTool,
  env: NodeJS.ProcessEnv,
  shapingActive: boolean,
  shapingState?: CodexShapingHookState,
  shapingConfigured?: boolean,
  shapingTrustProbed?: boolean,
  shapingTrustStatus?: CodexHookTrustStatus
): ShimConnectState {
  const extra = {
    ...(shapingState !== undefined ? { shapingState } : {}),
    ...(shapingConfigured !== undefined ? { shapingConfigured } : {}),
    ...(shapingTrustProbed !== undefined ? { shapingTrustProbed } : {}),
    ...(shapingTrustStatus !== undefined ? { shapingTrustStatus } : {})
  };
  try {
    // `env`, not the ambient one: this function is HANDED the environment, and `verifyShimActive`
    // resolves the shim dir from `COMPACTION_HOME`/`COMPACTION_SHIM_DIR`/`HOME`. Dropping it here made
    // the shim state describe the ambient machine while the rest of the row described the injected one.
    const v = verifyShimActive(tool, env);
    const shim = v.active ? "active" : v.installed ? "installed-not-on-path" : "not-installed";
    const binaryFound = Boolean(resolveExecutableOnPath(SHIM_TOOLS[tool].shimName, env, [v.shimDir]));
    return { shim, binaryFound, shapingActive, ...extra };
  } catch {
    return { shim: "not-installed", binaryFound: false, shapingActive, ...extra };
  }
}

/** Presence check ONLY: truthiness of the trimmed env var, the value itself is never propagated. */
function presence(env: NodeJS.ProcessEnv, name: string): Presence {
  return env[name] && String(env[name]).trim() !== "" ? "set" : "unset";
}

function isDirWritable(dir: string): boolean {
  try {
    accessSync(dir, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function countJsonlLines(file: string): number {
  try {
    if (!existsSync(file)) return 0;
    return readFileSync(file, "utf8").split("\n").filter((l) => l.trim() !== "").length;
  } catch {
    return 0;
  }
}

/** Collect the report. Every section is best-effort/fail-open; no section can throw out of here. */
/** Options that change what the report is allowed to DO, never what it is allowed to claim. */
export interface ReadinessOptions {
  /**
   * Ask Codex directly whether it will run our shaping hook (`core/codex-hook-trust.ts`).
   *
   * OFF BY DEFAULT, and that default is load-bearing. This report's first documented invariant is
   * READ-ONLY: writes nothing, installs nothing, makes no network call. Answering the trust question
   * means starting Codex's own app-server, and Codex is not a read-only program: on a home it has not
   * initialised it writes sqlite stores, an `installation_id`, a lock file and an extracted
   * `skills/.system/` tree (~70 files, measured), and it refreshes its model catalogue over the
   * network. A status command that did that would be violating its own headline promise to answer a
   * question about someone else's software - the exact shape of defect this report exists to prevent.
   *
   * So the live probe is something the user asks for. Unprobed, the state is `unknown`, which is the
   * literal truth (we did not ask) and never renders as active.
   */
  probeCodexTrust?: boolean;
}

export async function collectReadinessReport(
  cwd: string,
  env: NodeJS.ProcessEnv,
  projectsDir?: string,
  options: ReadinessOptions = {}
): Promise<ReadinessReport> {
  const probeCodexTrust = options.probeCodexTrust === true;
  // Tools, Claude Code sessions (count only) + verified Stop hook, Codex/Cursor shims.
  let sessionsFound: number | "unknown" = "unknown";
  try {
    const dir = projectsDir ?? defaultProjectsDir(env);
    sessionsFound = existsSync(dir) ? (await discoverClaudeCodeSessions({ projectsDir: dir })).sessions.length : 0;
  } catch {
    sessionsFound = "unknown";
  }
  // Every settings probe below reads the SAME two files, resolved from the injected environment. The
  // hook probes themselves take an explicit path and resolve no home of their own, so supplying the
  // right paths here is the whole of the fix - there is no second resolution hiding underneath.
  const settingsPaths = claudeSettingsPaths(cwd, env);
  const anySettings = async (probe: (p: string) => Promise<boolean>): Promise<boolean> => {
    for (const p of settingsPaths) if (await probe(p)) return true;
    return false;
  };
  let stopHookInstalled = false;
  try {
    stopHookInstalled = await anySettings(isStopHookInstalled);
  } catch {
    stopHookInstalled = false;
  }
  // Claude Code transparent-routing shim (resolve-verified) + the per-turn VISIBLE status line. These
  // drive the honest "routed but the per-turn line is not wired" nudge: routing can be present while
  // the status line is not (an older build installed the shim before the status line existed). READ-ONLY.
  let claudeRoutingShim: ReadinessReport["tools"]["claudeCode"]["routingShim"] = "not-installed";
  try {
    const v = verifyShimActive("claude-code", env);
    claudeRoutingShim = v.active ? "active" : v.installed ? "installed-not-on-path" : "not-installed";
  } catch {
    claudeRoutingShim = "not-installed";
  }
  let claudeStatusLineInstalled = false;
  try {
    claudeStatusLineInstalled = await anySettings(isStatusLineInstalled);
  } catch {
    claudeStatusLineInstalled = false;
  }
  // Output-shaping state for Claude Code. Read-only, and conservative in both directions: an unreadable
  // settings file answers "not active" (understates), and a thrown kill-switch / `compaction stop`
  // answers "not active" even with the hook on disk, because in that state it attaches nothing.
  //
  // BOTH halves are asked about `env`, never the ambient environment. The gate resolves the kill switch
  // (`COMPACTION_SHAPING_HOOKS`) and the persisted `compaction stop` state (via `COMPACTION_CONFIG_DIR`)
  // from the env it is handed; the hook is located under the home that same env names. Getting either
  // one from the ambient environment reports shaping ACTIVE for a hook that is dormant, or absent, under
  // the environment actually asked about - the same defect class this whole change exists to remove.
  //
  // Asked PER TOOL, because Codex and Cursor have their own shaping hooks with their own config files.
  // The global switch gates all three: `compaction stop` suppresses every hook at once.
  //
  // CODEX HAS A SECOND GATE, and it is not ours. Codex will not run a configured hook until the user
  // grants its NATIVE per-hash trust, and an untrusted hook is silently inert - the turn completes and
  // nothing is attached. So Codex's answer is the CONJUNCTION of our switch and Codex's own reported
  // trust (`core/codex-hook-trust.ts`, which asks Codex via `hooks/list` and never grants anything).
  // `unknown` - Codex unreachable or unparseable - is NOT active: we do not claim a mutation we cannot
  // confirm.
  let claudeShapingActive = false;
  let codexShapingActive = false;
  let cursorShapingActive = false;
  let codexShapingState: CodexShapingHookState = "unknown";
  let codexShapingConfigured = false;
  let codexShapingTrustStatus: CodexHookTrustStatus | undefined;
  // WHETHER THE PROBE ACTUALLY RAN, not whether it was requested. `--check-codex` on a machine with no
  // Codex hook configured takes the `not-installed` branch and starts nothing - so reporting the
  // request would have the header claim Codex was started and wrote state when it was never launched.
  let codexTrustProbeRan = false;
  try {
    const shapingSwitchOn = isShapingHooksActivated(env);
    claudeShapingActive = shapingSwitchOn && (await anySettings(isShapingHookInstalled));
    cursorShapingActive = shapingSwitchOn && (await subscriptionShapingInstalled("cursor", cwd, env));

    codexShapingConfigured = await subscriptionShapingInstalled("codex", cwd, env);
    if (!codexShapingConfigured) {
      // No config on disk: `not-installed` without asking Codex anything.
      codexShapingState = "not-installed";
    } else if (probeCodexTrust) {
      // OPT-IN ONLY. See `ReadinessOptions.probeCodexTrust` for why this cannot be the default.
      codexTrustProbeRan = true;
      const trust = await codexShapingHookTrust({ env, cwd });
      codexShapingState = trust.state;
      codexShapingTrustStatus = trust.trustStatus;
    } else {
      // Configured, but we have not asked Codex whether it will run it - and `unknown` is exactly that
      // statement. It never renders as active, so the record-only boundary stays honest either way.
      codexShapingState = "unknown";
    }
    codexShapingActive = shapingSwitchOn && codexShapingState === "active";
  } catch {
    claudeShapingActive = false;
    codexShapingActive = false;
    cursorShapingActive = false;
    codexShapingState = "unknown";
    codexShapingConfigured = false;
    codexShapingTrustStatus = undefined;
    // NOT reset: whether Codex was started is a fact about what this process DID, and a later failure
    // does not un-start it. The header must keep disclosing it.
  }

  // Gateway health (local pidfile + local port probe only).
  let gateway: ReadinessReport["gateway"] = { running: false, receiptsCount: 0 };
  try {
    const s = await getGatewayStatus(cwd);
    gateway = {
      running: s.running,
      ...(s.base ? { base: s.base } : {}),
      ...(s.pid !== undefined ? { pid: s.pid } : {}),
      ...(s.provider ? { provider: s.provider } : {}),
      ...(s.mode ? { mode: s.mode } : {}),
      ...(s.workflow ? { workflow: s.workflow } : {}),
      receiptsCount: s.receiptsCount,
      ...(s.lastRequestAt ? { lastRequestAt: s.lastRequestAt } : {})
    };
  } catch {
    /* fail-open: report stays "not running / 0" */
  }

  // Storage readiness under <cwd>/.compaction (all local, gitignored).
  const storageRoot = path.join(cwd, ".compaction");
  let receiptsCount = 0;
  try {
    receiptsCount = readReceipts(cwd).length;
  } catch {
    receiptsCount = 0;
  }
  let policiesCount = 0;
  let policiesPresent = false;
  try {
    policiesPresent = existsSync(path.join(cwd, DEFAULT_POLICY_PREFERENCES_DIRECTORY, POLICY_PREFERENCES_FILENAME));
    policiesCount = (await readPolicyPreferences(path.join(cwd, DEFAULT_POLICY_PREFERENCES_DIRECTORY))).preferences.length;
  } catch {
    policiesCount = 0;
  }
  const activityFile = path.join(cwd, DEFAULT_ACTIVITY_DIRECTORY, ACTIVITY_LOG_FILENAME);
  const storage: ReadinessReport["storage"] = {
    root: storageRoot,
    writable: existsSync(storageRoot) ? isDirWritable(storageRoot) : isDirWritable(cwd),
    receipts: { present: receiptsCount > 0, count: receiptsCount },
    recovery: { present: existsSync(path.join(cwd, GATEWAY_RECOVERY_DIR)) },
    activity: { present: existsSync(activityFile), count: countJsonlLines(activityFile) },
    policies: { present: policiesPresent, count: policiesCount }
  };

  // Stored auto-apply authorizations per routable workflow (enabled + engine-evaluable gates only).
  const authorizations: ReadinessReport["authorizations"] = {
    "claude-code": { authorized: false },
    codex: { authorized: false }
  };
  try {
    const { preferences } = await readPolicyPreferences(path.join(cwd, DEFAULT_POLICY_PREFERENCES_DIRECTORY));
    for (const tool of ["claude-code", "codex"] as const) {
      const match = preferences.find(
        (p) =>
          p.scope.tool === tool &&
          p.scope.policy_type === DEDUPE_POLICY &&
          p.enabled &&
          p.preference === "auto-when-gates-pass" &&
          gatesAreEngineEvaluable(p.gates_required)
      );
      if (match) authorizations[tool] = { authorized: true, id: match.id };
    }
  } catch {
    /* fail-open: reported as none */
  }

  let optimizationMode: OptimizationModePreference = "cache";
  let connectedWorkflows: string[] = [];
  try {
    optimizationMode = readOptimizationMode(env);
    connectedWorkflows = readConnectedWorkflows(env);
  } catch {
    /* fail-open: defaults */
  }

  let liveVerifiedProviders: string[] = [];
  try {
    liveVerifiedProviders = liveVerificationsForMatrix(cwd)
      .filter((v) => v.liveVerified)
      .map((v) => v.providerId);
  } catch {
    liveVerifiedProviders = [];
  }

  const report: ReadinessReport = {
    tools: {
      claudeCode: {
        sessionsFound,
        stopHookInstalled,
        connected: stopHookInstalled,
        routingShim: claudeRoutingShim,
        statusLineInstalled: claudeStatusLineInstalled,
        shapingActive: claudeShapingActive
      },
      codex: shimState("codex", env, codexShapingActive, codexShapingState, codexShapingConfigured, codexTrustProbeRan, codexShapingTrustStatus),
      cursor: shimState("cursor", env, cursorShapingActive)
    },
    gateway,
    storage,
    credentials: {
      ANTHROPIC_API_KEY: presence(env, "ANTHROPIC_API_KEY"),
      OPENAI_API_KEY: presence(env, "OPENAI_API_KEY"),
      subscriptionRouting: "available-explicit-opt-in"
    },
    optimizationMode,
    connectedWorkflows,
    authorizations,
    routes: { "claude-code": "routable", codex: "routable", cursor: "measure-only", lcm: "shadow-only" },
    liveVerifiedProviders,
    claudeRoutedButLineUnwired: false,
    nextCommands: []
  };
  report.claudeRoutedButLineUnwired = claudeRoutedButLineUnwired(report, env);
  report.nextCommands = deriveNextCommands(report);
  return report;
}

/**
 * True when Claude Code routing (the `claude` shim) is present but the per-turn VISIBLE status line
 * is NOT wired - so routed runs would record receipts silently. The nudge is suppressed when the
 * receipt-line kill switch (`COMPACTION_RECEIPT_LINE=0`) is set (the user chose silence). Read-only.
 */
function claudeRoutedButLineUnwired(r: ReadinessReport, env: NodeJS.ProcessEnv): boolean {
  if (!isReceiptLineEnabled(env)) return false;
  return r.tools.claudeCode.routingShim !== "not-installed" && !r.tools.claudeCode.statusLineInstalled;
}

/** The exact next commands for the detected state, copy-pasteable, never a credential value. */
function deriveNextCommands(r: ReadinessReport): string[] {
  const commands: string[] = [];
  if (r.claudeRoutedButLineUnwired) {
    commands.push(
      "compaction init --connect claude-code   # Claude Code is routed but the per-turn line is not wired - this adds it (reversible)"
    );
  }
  const claudeConnected = r.tools.claudeCode.connected || r.connectedWorkflows.includes("claude-code");
  const codexConnected = r.tools.codex.shim === "active" || r.connectedWorkflows.includes("codex");

  if (!claudeConnected && !codexConnected) {
    commands.push("compaction init --connect detected   # connect the tools found on this machine (reversible)");
  }
  if (claudeConnected) {
    if (r.credentials.ANTHROPIC_API_KEY === "unset") {
      commands.push("export ANTHROPIC_API_KEY=<your key>   # required for the Claude Code API-key route; Compaction never stores it");
    }
    commands.push("compaction gateway run --provider anthropic -- claude   # route a real Claude Code run (workflow auto-selected)");
    commands.push(
      "compaction gateway run --provider anthropic --subscription -- claude   # keyless: route Claude Code under your saved login (credential-free; not yet live-proven)"
    );
  }
  if (codexConnected) {
    if (r.credentials.OPENAI_API_KEY === "unset") {
      commands.push("export OPENAI_API_KEY=<your key>   # required for the Codex API-key route; Compaction never stores it");
    }
    commands.push(
      r.tools.codex.shim === "active"
        ? 'codex exec --json "<task>"   # measured automatically via the connected shim'
        : 'compaction gateway run -- codex exec --json "<task>"   # route a real Codex run (workflow auto-selected)'
    );
  }
  const wantsAuthorization = (["claude-code", "codex"] as const).filter(
    (tool) => (tool === "claude-code" ? claudeConnected : codexConnected) && !r.authorizations[tool].authorized
  );
  for (const tool of wantsAuthorization) {
    commands.push(`compaction init --authorize-auto-apply ${tool}   # optional: one narrow persistent apply authorization`);
  }
  const armed = (["claude-code", "codex"] as const).filter((tool) => r.authorizations[tool].authorized);
  if (armed.length > 0 && r.optimizationMode !== "cache-plus-context") {
    commands.push(
      "compaction init --mode cache-plus-context   # stored authorization present but mode is 'cache' - auto-apply will not compose until this is set"
    );
  }
  commands.push("compaction activity   # observe runs (content-free)");
  commands.push("compaction gateway status   # gateway health + receipt rollup");
  if (claudeConnected || codexConnected) {
    const provider = claudeConnected ? "anthropic" : "openai";
    commands.push(
      `compaction gateway verify-cache --provider ${provider}   # key-gated live cache proof (uses YOUR key; two small real requests)`
    );
  }
  if (armed.length > 0) {
    commands.push("compaction gateway recover <recovery_id>   # byte-exact original of any applied request");
    for (const tool of armed) {
      commands.push(`compaction policies disable ${r.authorizations[tool].id}   # turn off the ${tool} authorization anytime`);
    }
  }
  return commands;
}

function yesNo(v: boolean): string {
  return v ? "yes" : "no";
}

/** Render the human report. Plain text (no color) so it pastes verbatim into notes and issues. */
/**
 * The one honest shaping/record-only boundary for this machine, across EVERY workflow whose shaping
 * hook can be installed - not just Claude Code.
 *
 * The two clauses are fixed wording and are not restated per tool: what changes is only
 * WHICH workflows it is on for, and the attachment scope. Cursor is session-level - once per session,
 * never per turn (`core/subscription-shaping-hooks.ts` is the authority) - so a Cursor-only machine may
 * not be told an instruction is attached "before each shapeable turn"; the mixed case names both.
 */
function shapingBoundaryLine(r: ReadinessReport): string {
  const perTurn = [
    ...(r.tools.claudeCode.shapingActive ? ["Claude Code"] : []),
    ...(r.tools.codex.shapingActive ? ["Codex"] : [])
  ];
  const sessionLevel = r.tools.cursor.shapingActive;
  if (perTurn.length === 0 && !sessionLevel) return "  Record-only - your input is not compacted or edited.";
  const workflows = [...perTurn, ...(sessionLevel ? ["Cursor"] : [])].join(", ");
  const scope =
    perTurn.length === 0
      ? "attached once per session"
      : sessionLevel
        ? "attached before each shapeable turn (Cursor: once per session)"
        : "attached before each shapeable turn";
  return `  Output shaping: on (${workflows}) - a concise-response instruction is ${scope}. Your input is not compacted or edited.`;
}

/**
 * The Codex one-time-approval line, present ONLY while Codex's own trust gate is the thing standing
 * between an installed hook and a working one.
 *
 * This is not a warning decoration: `approval-required` is a state in which Compaction has done its
 * whole job and Codex is still attaching nothing, silently. Without this line the user reads
 * "Record-only" on a machine where they explicitly enabled Codex shaping, with no indication that one
 * native action completes it. The action is quoted from Codex's own review screen so it matches what is
 * actually on their terminal.
 *
 * `unknown` prints nothing: we could not establish the state, and inventing an instruction for a
 * condition we did not observe would be the same over-claiming in the other direction.
 */
function codexApprovalLine(r: ReadinessReport): string | undefined {
  const state = r.tools.codex.shapingState;
  // SWITCHED OFF. Enabling is necessary; whether it is SUFFICIENT depends on trust, and the reducer
  // preserves that cause precisely so this branch can say which. Describing an untrusted-and-disabled
  // hook as "trusted" would name a remedy that still leaves it unable to run - the same defect as the
  // approval-only message it replaced, pointing the other way.
  if (state === "disabled") {
    const alsoUntrusted = r.tools.codex.shapingTrustStatus === "untrusted" || r.tools.codex.shapingTrustStatus === "modified";
    if (alsoUntrusted) {
      return (
        `  Codex: output shaping is configured, but Codex reports the hook as DISABLED and NOT trusted, so it ` +
        `attaches nothing. BOTH are needed: re-enable the hook in Codex, and at "${CODEX_TRUST_ACTION_HEADING}" ` +
        `choose "${CODEX_TRUST_ACTION_CONTROL}".`
      );
    }
    return (
      `  Codex: output shaping is configured and trusted, but Codex reports the hook as DISABLED, so it ` +
      `attaches nothing. Re-approving trust will not change that - re-enable the hook in Codex.`
    );
  }
  // ASKED, and Codex said no. The only case that may assert what Codex reports.
  if (state === "approval-required") {
    return (
      `  Codex: output shaping is configured but NOT yet running - Codex reports this hook as untrusted, ` +
      `so it attaches nothing. One-time: run \`${CODEX_TRUST_ACTION_COMMAND}\`, and at "${CODEX_TRUST_ACTION_HEADING}" ` +
      `choose "${CODEX_TRUST_ACTION_CONTROL}". Nothing else is needed afterwards.`
    );
  }
  // NOT ASKED. The hook is on disk and Codex runs it only after its own one-time approval, but this
  // report did not start Codex to find out (see `ReadinessOptions.probeCodexTrust`: doing so would
  // write to the user's Codex home and hit the network, breaking this command's read-only promise).
  // State what is known, name the one-time step, and name the flag that checks it live.
  if (state === "unknown" && r.tools.codex.shapingConfigured === true) {
    const approval =
      `Codex runs a hook only after its own one-time approval (run \`${CODEX_TRUST_ACTION_COMMAND}\`, and at ` +
      `"${CODEX_TRUST_ACTION_HEADING}" choose "${CODEX_TRUST_ACTION_CONTROL}")`;
    // ASKED AND GOT NOTHING. Report ONLY that, and prescribe nothing: the hook may be trusted already,
    // or disabled, or awaiting approval, and we cannot tell which. Naming the approval step here would
    // turn "we could not establish the state" into a remedy the evidence does not support - and naming
    // the flag would tell the user to do what they just did.
    if (r.tools.codex.shapingTrustProbed === true) {
      return (
        `  Codex: output shaping is configured, but Codex did not answer when asked whether it will run ` +
        `the hook, so its state could not be established here.`
      );
    }
    return (
      `  Codex: output shaping is configured. ${approval}. ` +
      `Not checked here - \`compaction status --check-codex\` asks Codex directly (it starts Codex briefly).`
    );
  }
  return undefined;
}

export function renderReadinessReport(r: ReadinessReport): string {
  const lines: string[] = [];
  // THE HEADER DESCRIBES THIS INVOCATION, not the command in general. `--check-codex` deliberately
  // starts Codex, which writes to its own home and refreshes its model catalogue - so printing
  // "read-only" on that run would have the report contradict the very warning that gated it.
  lines.push(
    r.tools.codex.shapingTrustProbed === true
      ? "compaction status - dogfood readiness (local, content-free; --check-codex started Codex, which writes its own state)"
      : "compaction status - dogfood readiness (local, read-only, content-free)"
  );
  lines.push("");
  lines.push("Tools");
  lines.push(
    `  Claude Code   sessions found: ${r.tools.claudeCode.sessionsFound} · Stop hook: ${
      r.tools.claudeCode.stopHookInstalled ? "installed (verified)" : "not installed"
    } · routing: ${
      r.tools.claudeCode.routingShim === "active"
        ? "active"
        : r.tools.claudeCode.routingShim === "installed-not-on-path"
          ? "installed, NOT on PATH"
          : "not installed"
    } · per-turn line: ${r.tools.claudeCode.statusLineInstalled ? "wired" : "not wired"} · ${
      r.tools.claudeCode.connected ? "connected" : "not connected"
    }`
  );
  if (r.claudeRoutedButLineUnwired) {
    lines.push(
      "    Claude Code is routed but the per-turn line is not wired - run `compaction init --connect claude-code` to show it (reversible)."
    );
  }
  const shimLabel = (s: ShimConnectState): string =>
    `shim: ${s.shim === "active" ? "active (connected)" : s.shim === "installed-not-on-path" ? "installed, NOT on PATH" : "not installed"} · binary: ${
      s.binaryFound ? "found" : "not found"
    }`;
  lines.push(`  Codex         ${shimLabel(r.tools.codex)}`);
  lines.push(`  Cursor        ${shimLabel(r.tools.cursor)}   (measure-only - no provider route; vendor gap)`);
  lines.push("");
  lines.push("Gateway");
  if (r.gateway.running) {
    lines.push(
      `  running: yes  ${r.gateway.base ?? ""} (pid ${r.gateway.pid}) · provider ${r.gateway.provider} · mode ${r.gateway.mode} · workflow ${
        r.gateway.workflow ?? "none"
      }`
    );
  } else {
    lines.push("  running: no   (starts on demand via 'compaction gateway run', or: compaction gateway start)");
  }
  lines.push(`  requests observed here: ${r.gateway.receiptsCount} (content-free receipts)${r.gateway.lastRequestAt ? ` · last: ${r.gateway.lastRequestAt}` : ""}`);
  lines.push("");
  lines.push(`Storage (${r.storage.root} - local-only, gitignored)`);
  lines.push(`  writable: ${yesNo(r.storage.writable)}`);
  lines.push(`  receipts: ${r.storage.receipts.count} · recovery dir: ${r.storage.recovery.present ? "present" : "none yet"} · activity events: ${r.storage.activity.count} · stored policies: ${r.storage.policies.count}`);
  lines.push("");
  lines.push("Credentials (presence only - values are never read beyond set/unset, never shown)");
  lines.push(`  ANTHROPIC_API_KEY: ${r.credentials.ANTHROPIC_API_KEY.toUpperCase()}   (Claude Code API-key route)`);
  lines.push(`  OPENAI_API_KEY:    ${r.credentials.OPENAI_API_KEY.toUpperCase()}   (Codex API-key route)`);
  lines.push(
    "  subscription routing: available (explicit --subscription; keyless; credential-free; not yet live-proven)"
  );
  lines.push("    compaction gateway run --provider anthropic --subscription -- claude   # route Claude Code under your saved login - no API key");
  lines.push("");
  lines.push("Optimization setup");
  lines.push(`  mode (recorded default): ${r.optimizationMode}`);
  lines.push(`  connected workflows (gateway --workflow default): ${r.connectedWorkflows.length > 0 ? r.connectedWorkflows.join(", ") : "none persisted"}`);
  for (const tool of ["claude-code", "codex"] as const) {
    const a = r.authorizations[tool];
    lines.push(`  auto-apply authorization (${tool}): ${a.authorized ? `stored (${a.id})` : "none (default: ask)"}`);
  }
  lines.push("");
  lines.push("What routes vs what only measures");
  lines.push("  claude-code   ROUTABLE - API-key path through the local gateway (provider-reported receipts)");
  lines.push("  codex         ROUTABLE - API-key path (shim or gateway run; provider-reported receipts)");
  lines.push("  cursor        measure-only - no provider route (vendor gap); local-estimate tokens only");
  lines.push("  LCM           shadow-only - never model-visible");
  lines.push("");
  lines.push("Routing & apply boundary (the honest detail behind the concise enable screen)");
  lines.push("  plan-auth is the default: run your workflows with your existing subscription; No API key needed. Compaction records content-free usage.");
  // State-aware, because this section used to assert a flat record-only boundary while the Claude Code
  // shaping hook was installed and attaching an instruction to every shapeable turn (F65). Input axis and
  // output axis are reported separately and never collapsed.
  lines.push(
    shapingBoundaryLine(r)
  );
  const codexApproval = codexApprovalLine(r);
  if (codexApproval !== undefined) lines.push(codexApproval);
  lines.push("  No semantic-preservation claim.");
  lines.push("  keyless subscription route (explicit opt-in, never automatic; credential-free; not yet live-proven):");
  lines.push("    compaction gateway run --provider anthropic --subscription -- claude");
  lines.push("  Optional (Advanced) - provider cache proof: route through the Gateway, then verify-cache (uses your provider API key; never stored):");
  lines.push(
    `    cache proof ${
      r.liveVerifiedProviders.length > 0
        ? `live-verified for: ${r.liveVerifiedProviders.join(", ")}`
        : "available - run verify-cache to confirm live"
    }.`
  );
  lines.push("");
  lines.push("Next commands for this machine");
  for (const c of r.nextCommands) lines.push(`  ${c}`);
  lines.push("");
  lines.push("Evidence labels (honest):");
  lines.push("  - routing + receipts: fixture-tested in CI; live provider traffic requires YOUR key (key-gated).");
  lines.push(
    `  - live cache proof recorded in this project: ${r.liveVerifiedProviders.length > 0 ? r.liveVerifiedProviders.join(", ") : "none yet (run verify-cache with your key)"}.`
  );
  lines.push("  - cache reductions are provider-reported fresh/billed input token deltas - never a billing-confirmed or dollar-savings claim.");
  return lines.join("\n");
}
