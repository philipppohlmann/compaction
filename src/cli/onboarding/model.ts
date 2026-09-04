/**
 * Shared onboarding model, the single source of truth for both the static
 * `compaction init` screen and the interactive Ink TUI.
 *
 * Data and pure logic only (no chalk, no React): both render surfaces must show the
 * same workflows, follow-ups, and claim labels, so all copy and state derivation live here.
 *
 * Scope invariant: onboarding features only the free, local-first commands. The opt-in
 * engine commands (recommend / compact / inspect / approve / apply-context) are
 * deliberately absent from this model on every surface.
 */

// Brand accent. Used by both surfaces; chalk/ink down-sample or no-op it on
// terminals without truecolor, so the text is never lost.
export const BRAND_HEX = "#3231cd";

// Connect-once install promise. `compaction` is an install-once instrumentation
// surface, NOT a one-off capture/import workflow picker.
export const VALUE_PROMISE =
  "Install once. Make supported AI workflows context-aware, measured, and reviewable - locally.";

/** The connect-once first-screen tagline + the detection line shown while scanning. */
export const INSTALL_TAGLINE = "context under control";
export const DETECT_LINE = "Detecting AI tools on this machine…";

/** After a tool is connected, supported runs are measured automatically; the manual tools stay available. */
export const AFTER_CONNECT_LINE = "After connect: supported runs are measured automatically.";
export const MANUAL_TOOLS_LINE = "Manual tools: capture · import · analyze · spend · feedback --redact";

/**
 * The Gateway is infrastructure, not a peer first-run card: surfaced as the underlying
 * byte-safe routing layer plus a manual/advanced route, never one more workflow to pick.
 */
export const GATEWAY_INFRA_LINES = [
  "Gateway: local byte-safe routing layer for compatible OpenAI-style traffic.",
  "  Use manually:  compaction gateway run -- <command>",
  "  Status:        compaction gateway status"
] as const;

/**
 * The supported connect-once surfaces, in display order. `path` is the current connect
 * mechanism, never a claim of gateway routing unless that boundary is verified.
 */
export interface ConnectSurface {
  key: "claude-code" | "codex" | "cursor" | "openai-agents" | "browser";
  title: string;
  /** The short right-hand connect note shown on the detection row. */
  connectNote: string;
  /** The honest current connect mechanism (capture/wrapper), shown in the per-surface detail. */
  path: string;
  /** Whether this surface has a working connect option in the [1..] menu (browser/agents are guidance). */
  connectable: boolean;
}

export const CONNECT_SURFACES: ConnectSurface[] = [
  {
    key: "claude-code",
    title: "Claude Code",
    connectNote: "connect: transparent routing + consented Stop hook",
    path: "Claude Code: transparent routing (record-only, fail-open) + consented Stop hook",
    connectable: true
  },
  {
    key: "codex",
    title: "Codex CLI",
    connectNote: "connect: Compaction wrapper / gateway where verified",
    path: "Codex: live wrapper around `codex exec --json` where available",
    connectable: true
  },
  {
    key: "cursor",
    title: "Cursor",
    connectNote: "connect where possible: local-estimate only",
    path: "Cursor: live wrapper / local-estimate where available",
    connectable: true
  },
  {
    key: "openai-agents",
    title: "OpenAI Agents",
    connectNote: "connect where possible when detected",
    path: "OpenAI Agents: command wrapper / local export",
    connectable: false
  },
  {
    key: "browser",
    title: "Browser",
    connectNote: "optional - local alpha / extension path",
    path: "Browser: optional local alpha / extension path",
    connectable: false
  }
];

/** Content-free detection status passed from init.ts (which does the IO) to the pure onboarding surfaces. */
export interface ConnectDetection {
  claude: {
    detected: boolean;
    sessionCount: number;
    /**
     * Whether the local Compaction hook is installed AND verified for Claude Code.
     * OPTIONAL and defaults to false/undefined: mere detection of local sessions is
     * never enough to be `ready`. Only set true when the hook is confirmed active.
     */
    hookReady?: boolean;
  };
  /** Codex/Cursor shim status: connected (active) / installed-not-active / real binary found / absent. */
  codex: "active" | "installed" | "found" | "absent";
  cursor: "active" | "installed" | "found" | "absent";
}

/**
 * Discovery state vocabulary shared by both onboarding surfaces:
 * - `found`    , read-only discovery located the workflow; never implies Compaction is active.
 * - `ready`    , hook/shim verified active. Active-for-recording only; says nothing about savings.
 * - `not-found`, discovery did not find the workflow.
 * `enable` is the action (not a state) that moves `found` → `ready`; it is the first write -
 * discovery itself is strictly read-only.
 */
export type DiscoveryState = "found" | "ready" | "not-found";

/** The per-workflow discovery row, in the Page-1 order (Codex, Claude Code, Cursor). */
export interface WorkflowDiscovery {
  /** Stable surface key (matches the ConnectSurface / workflow vocabulary). */
  key: "codex" | "claude-code" | "cursor";
  /** Human-facing workflow title. */
  title: string;
  /** The derived discovery state for this workflow. */
  state: DiscoveryState;
  /** Honest copy: what having FOUND this workflow means (read-only discovery; not active). */
  foundMeaning: string;
  /** Honest copy: what being READY means (active-for-recording; no savings implication). */
  readyMeaning: string;
  /** Honest copy: the enable ACTION that moves `found` -> `ready` (the first, reversible write). */
  enableAction: string;
}

/**
 * Per-workflow discovery copy, shared by render surfaces and tests. These strings make no
 * savings claim; `found` never implies active. Wording is test-pinned, do not reword.
 */
export const CODEX_DISCOVERY_COPY = {
  foundMeaning: "codex binary found on PATH",
  readyMeaning: "Compaction shim runs before the real Codex binary",
  enableAction: "Install reversible Compaction shim. The real Codex binary is never replaced."
} as const;

export const CLAUDE_CODE_DISCOVERY_COPY = {
  foundMeaning: "local Claude Code sessions found",
  readyMeaning: "Compaction hook installed and verified; sessions appear in Compaction activity",
  enableAction:
    "Install transparent routing (record-only, fail-open) + local hook; sets up PATH so normal `claude` runs are captured continuously. Reversible."
} as const;

export const CURSOR_DISCOVERY_COPY = {
  foundMeaning: "cursor binary found on PATH",
  readyMeaning: "Compaction shim is active",
  enableAction: "Install reversible Compaction shim."
} as const;

/**
 * The found-column noun per workflow (feeds `shortLabel`'s `foundLabel`), e.g.
 * `[x] Codex, installed · enable Compaction`. Describes discovery only, never implies
 * Compaction is active.
 */
export const DISCOVERY_FOUND_LABEL: Record<WorkflowDiscovery["key"], string> = {
  codex: "installed",
  "claude-code": "sessions found",
  cursor: "installed"
};

/** The line shown above the discovery rows on both surfaces. Test-pinned, do not reword. */
export const DISCOVERY_READ_ONLY_LINE = "Discovery is read-only. Enabling is the first write.";

/**
 * Page-2 consent notice shown when enabling Claude Code: enabling sets up PATH (shell-config write)
 * as part of the one enable action. Names the consequence, the backup, and the opt-out, the
 * explicit Enable gesture plus this notice is the consent for the write.
 */
export const ENABLE_PATH_SETUP_NOTICE =
  "Enabling Claude Code also adds the Compaction shim directory to your shell PATH (announced; shell config backed up; reversible via disconnect; opt out: --no-write-shell-config).";

/** The header shown above the discovery rows on both surfaces (found→enable framing). */
export const DISCOVERY_HEADER = "Found on this machine:";

/**
 * The right-column label for a discovery state. `foundLabel` supplies the per-workflow noun
 * while the "· enable Compaction" tail stays shared. Pure.
 */
export function shortLabel(state: DiscoveryState, foundLabel: string): string {
  switch (state) {
    case "ready":
      return "ready";
    case "not-found":
      return "not found";
    case "found":
    default:
      return `${foundLabel} · enable Compaction`;
  }
}

/**
 * Map the content-free `ConnectDetection` into per-workflow discovery states. Pure.
 * Page-1 order: Codex, Claude Code, Cursor. OpenAI Agents, Browser, and Gateway are
 * deliberately not discovery rows (infra / Advanced-only / not implemented).
 */
export function deriveDiscovery(det: ConnectDetection): WorkflowDiscovery[] {
  // Codex: found = binary on PATH (active|installed|found); ready = shim active; not-found = absent.
  const codexState: DiscoveryState =
    det.codex === "absent" ? "not-found" : det.codex === "active" ? "ready" : "found";

  // Claude Code: found = local sessions/settings exist; ready = hook installed AND verified.
  // Without a verified hook bit, Claude Code is at most `found`, never `ready`.
  const claudeState: DiscoveryState = !det.claude.detected
    ? "not-found"
    : det.claude.hookReady === true
      ? "ready"
      : "found";

  // Cursor: found = cursor/cursor-agent binary on PATH; ready = shim active; not-found = absent.
  const cursorState: DiscoveryState =
    det.cursor === "absent" ? "not-found" : det.cursor === "active" ? "ready" : "found";

  return [
    {
      key: "codex",
      title: "Codex",
      state: codexState,
      foundMeaning: CODEX_DISCOVERY_COPY.foundMeaning,
      readyMeaning: CODEX_DISCOVERY_COPY.readyMeaning,
      enableAction: CODEX_DISCOVERY_COPY.enableAction
    },
    {
      key: "claude-code",
      title: "Claude Code",
      state: claudeState,
      foundMeaning: CLAUDE_CODE_DISCOVERY_COPY.foundMeaning,
      readyMeaning: CLAUDE_CODE_DISCOVERY_COPY.readyMeaning,
      enableAction: CLAUDE_CODE_DISCOVERY_COPY.enableAction
    },
    {
      key: "cursor",
      title: "Cursor",
      state: cursorState,
      foundMeaning: CURSOR_DISCOVERY_COPY.foundMeaning,
      readyMeaning: CURSOR_DISCOVERY_COPY.readyMeaning,
      enableAction: CURSOR_DISCOVERY_COPY.enableAction
    }
  ];
}

/**
 * True if any workflow is `found` (discovered but not yet `ready`) - i.e. there is
 * something to enable, so the enable page should be shown. Pure.
 */
export function discoveryNeedsEnable(discovery: WorkflowDiscovery[]): boolean {
  return discovery.some((d) => d.state === "found");
}

/**
 * Wizard state machine - pure functions (no React, no IO) driving the 4-page onboarding TUI;
 * the Ink component is a thin renderer over these. State is a `Set<WorkflowKey>` of selected
 * workflows plus the read-only `WorkflowDiscovery[]`. Selecting/toggling writes nothing; the
 * only write is the explicit Page-2 enable consent, routed through the injected engine callback.
 */
export type WorkflowKey = WorkflowDiscovery["key"];

/** True iff the workflow row is selectable. A `not-found` workflow can NEVER be selected. Pure. */
export function isWorkflowSelectable(key: WorkflowKey, discovery: WorkflowDiscovery[]): boolean {
  const row = discovery.find((d) => d.key === key);
  return row !== undefined && row.state !== "not-found";
}

/** Page-1 initial multi-select: preselect every `found` and `ready` workflow; never `not-found`. Pure. */
export function initialSelection(discovery: WorkflowDiscovery[]): Set<WorkflowKey> {
  return new Set(discovery.filter((d) => d.state === "found" || d.state === "ready").map((d) => d.key));
}

/** Toggle a workflow's selection; toggling a non-selectable (`not-found`) row is a no-op. Pure. */
export function toggleSelection(
  sel: ReadonlySet<WorkflowKey>,
  key: WorkflowKey,
  discovery: WorkflowDiscovery[]
): Set<WorkflowKey> {
  const next = new Set(sel);
  if (!isWorkflowSelectable(key, discovery)) return next; // not-found -> no-op
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

/**
 * The selected `found` subset - exactly what Page-2 installs, in the stable Page-1 order.
 * `ready` workflows are never re-enabled. Pure.
 */
export function workflowsToEnable(sel: ReadonlySet<WorkflowKey>, discovery: WorkflowDiscovery[]): WorkflowKey[] {
  return discovery.filter((d) => d.state === "found" && sel.has(d.key)).map((d) => d.key);
}

/**
 * True iff Page-2 (the explicit enable / first-write page) must be shown: at least one selected
 * workflow is `found`. A ready-only or empty selection skips Page-2. Pure.
 */
export function needsEnablePage(sel: ReadonlySet<WorkflowKey>, discovery: WorkflowDiscovery[]): boolean {
  return workflowsToEnable(sel, discovery).length > 0;
}

/**
 * The selected workflows already `ready` - counted in the Page-4 Ready summary without being
 * re-enabled. Stable Page-1 order. Pure.
 */
export function selectedReadyWorkflows(sel: ReadonlySet<WorkflowKey>, discovery: WorkflowDiscovery[]): WorkflowKey[] {
  return discovery.filter((d) => d.state === "ready" && sel.has(d.key)).map((d) => d.key);
}

/**
 * Optimization-mode model (Page 3). Invariant: neither mode introduces a new optimizer -
 * both map to existing capabilities.
 *  - `cache-optimize` (default) = Gateway record + `gateway proof`. No model-visible change,
 *    no approval needed; the provider does the caching, Compaction measures and proves it.
 *  - `cache-context-optimize` = record + the existing stored-authorization deterministic apply
 *    path. Model-visible change, approval required (the onboarding confirmation is that consent);
 *    original retained locally and recoverable.
 * Confirming mode 2 stores one narrow authorization per selected routed workflow - never global,
 * Cursor excluded, no active request changed. Copy describes mechanism, never a savings guarantee.
 */
export type OptimizationModeKey = "cache-optimize" | "cache-context-optimize";

export interface OptimizationModeMeaning {
  /**
   * Whether running this mode compacts or edits the user's INPUT before it is sent.
   *
   * Deliberately the input axis, not "model-visible": output shaping attaches an instruction to what
   * the model sees on BOTH modes, so a `false` here never meant "the model sees nothing new" - and
   * rendering it as "model-visible bytes changed: no" told the user something untrue (F65).
   */
  inputBytesChanged: boolean;
  /** Whether an explicit approval is required BEFORE any model-visible change. */
  approvalRequired: boolean;
  /** Honest lines describing exactly what this maps to today (no overclaim). */
  mapsTo: string[];
}

export interface OptimizationMode {
  key: OptimizationModeKey;
  title: string;
  /** Mode 1 is the recommended default; mode 2 is opt-in. */
  recommended: boolean;
  /** The EXACT honest one-line description shown on both surfaces. */
  oneLine: string;
  meaning: OptimizationModeMeaning;
  /** The exact copy-pasteable command a user runs to USE this mode. */
  command: string;
}

// Framing: deterministic exact-duplicate compaction is the BYTE-SAFE BASELINE that apply uses today.
// The primary compaction direction is the on-device HYBRID compactor (atoms locked verbatim; a local
// model summarizes only old history), currently evaluated in LOCAL SHADOW - content-free, measured
// against this baseline, never applied. This copy stays accurate to what apply does now (the baseline).
export const OPTIMIZATION_MODES: OptimizationMode[] = [
  {
    key: "cache-optimize",
    title: "Output only",
    recommended: true,
    oneLine: "Asks for shorter responses. Your input is sent exactly as written.",
    meaning: {
      inputBytesChanged: false,
      approvalRequired: false,
      mapsTo: [
        "Gateway record mode (default) - byte-safe, content-free receipts; your input is not compacted or edited on this route.",
        "Where the provider caches (OpenAI-compatible traffic through the local Gateway), `gateway proof` surfaces the provider-reported fresh input reduction - the provider does the caching; Compaction records and proves it."
      ]
    },
    command: "compaction gateway proof --proof-run <id>"
  },
  {
    key: "cache-context-optimize",
    title: "Full optimization",
    recommended: false,
    oneLine: "Compact input and shape output on supported requests. Confirm once for selected workflows.",
    meaning: {
      inputBytesChanged: true,
      approvalRequired: true,
      mapsTo: [
        "The final onboarding confirmation stores one narrow authorization for each selected Claude Code/Codex workflow.",
        "Deterministic exact-duplicate input compaction (the byte-safe baseline) + pre-generation output shaping; original retained and recoverable; unsupported requests pass through unchanged."
      ]
    },
    command: "compaction init --connect <workflow> --mode cache-plus-context"
  }
];

/** The recommended DEFAULT optimization mode. Pure. */
export function defaultOptimizationMode(): OptimizationModeKey {
  return "cache-optimize";
}

/** Look up an optimization mode by key. */
export function findOptimizationMode(key: string): OptimizationMode | undefined {
  return OPTIMIZATION_MODES.find((m) => m.key === key);
}

/** The header shown above the optimization-mode section on both surfaces. */
export const OPTIMIZATION_MODE_HEADER = "Optimization mode (how context is handled for supported runs):";

/**
 * Footer under the two modes. Invariant: the mode screen writes nothing and choosing a mode
 * never enables automatic application - that exists only under a separate explicit scoped
 * stored authorization.
 */
export const OPTIMIZATION_MODE_FOOTER =
  "Default: Output only. This read-only screen writes nothing. Running the Full optimization command is the one explicit scoped confirmation for selected routed workflows; disable anytime. Nothing changes during onboarding.";

/**
 * Page-4 "Ready" closing summary - the end-state display after a successful connect, reused by
 * the TUI completion path. Claim boundary: the default mode records content-free receipts and
 * surfaces provider-reported reduction where the provider caches - never a claim that Compaction
 * itself reduces input, and no billing/cost/output-token/semantic/auto-apply claim. Only
 * workflows that verified-connected this run are listed as Enabled. Rendering writes nothing.
 */
export type ReadyToolKey = "claude-code" | "codex" | "cursor";

/**
 * Result of the Page-2 enable consent (returned by the injected `onEnable` callback).
 * `connected` = installs that verified active this run; `failed` = attempted but unverified.
 * Content-free (keys only); the wizard renders Page-4 from actual `connected`.
 */
export interface EnableResult {
  connected: ReadyToolKey[];
  failed: ReadyToolKey[];
  /**
   * The workflows whose native shaping hooks are CONFIRMED present on disk after this enable. Keys
   * only, like the rest of this result. Separate from `connected` on purpose: a hook failure must
   * NEVER un-connect the shim (the capture half really did land, and it is fail-open), but the ready
   * screen must not then describe a shaping effect that is not there.
   */
  shapingHooksInstalled?: ReadyToolKey[];
}

/** Per-tool Ready-summary copy: the Enabled label + the EXACT command the user runs the tool with. */
export const READY_TOOL_COPY: Record<ReadyToolKey, { label: string; runCommand: string }> = {
  "claude-code": { label: "Claude Code", runCommand: "claude" },
  codex: { label: "Codex", runCommand: "codex" },
  cursor: { label: "Cursor", runCommand: "cursor-agent" }
};

/** The Ready-summary section strings, kept here so both onboarding surfaces render identical copy. */
export const READY_HEADER = "Compaction is ready.";
export const READY_MODE_LABEL = "Output only";
export const READY_MODE_LINE = `Optimization: ${READY_MODE_LABEL} (default)`;
export const READY_ENABLED_HEADER = "Enabled:";
export const READY_RUN_HEADER = "Run your workflows normally:";
export const READY_WILL_HEADER = "Compaction will:";

/**
 * "Compaction will:" mechanism bullets. ✓ = default mode; ○ = opt-in only. Never implies
 * Compaction changes model-visible bytes in the default mode.
 */
export const READY_WILL_BULLETS = [
  "✓ record usage (content-free token/cache receipts)",
  "✓ show provider-reported proof when the provider caches and fresh input drops (compaction gateway proof)",
  "○ ask before any context compaction - only if you start apply mode (compaction gateway start --mode apply)"
] as const;

export const READY_ACTIVITY_LABEL = "View activity:";
export const READY_ACTIVITY_COMMAND = "compaction activity";
export const READY_ROUTING_LABEL = "Explicit routing (when a workflow needs it):";
/** The REAL routing command (verified in src/cli/commands/gateway.ts - `gateway run -- <command>`). */
export const READY_ROUTING_COMMAND = "compaction gateway run -- <your-command>";

/**
 * The concise enable-screen per-workflow header. The enable screen shows only WHAT was enabled and
 * the one honest boundary; the full detail (keyless subscription route, Optional-Advanced provider
 * cache proof + verify-cache boundary, Cache+context apply, not-yet-live-proven) lives in
 * `compaction status`. Keyless/plan-auth default is stated once here.
 */
export const READY_ENABLE_WORKFLOW_HEADER =
  "Per workflow - enabled on the plan-auth default (no API key):";
/**
 * The Claude Code per-workflow boundary line for the state where output shaping is NOT active.
 *
 * The boundary is stated on the INPUT axis, which is the axis the record route actually guarantees:
 * the user's input is forwarded as written. It deliberately does NOT say "nothing the model sees is
 * mutated" - that is a claim about the whole model-visible payload, and it is false the moment a
 * shaping instruction is attached, so it cannot be the unconditional fallthrough for this workflow.
 */
export const READY_ENABLE_RECORD_ONLY_LINE =
  "Routed automatically through the local gateway; content-free receipts; Record-only - your input is not compacted or edited.";
/**
 * The same line for the state where Claude Code output shaping IS active (the default: connecting
 * installs the `UserPromptSubmit` shaping hook). It names the thing that IS attached and, in the same
 * breath, the thing that is NOT touched. The two clauses are load-bearing and separate:
 *   - output shaping ATTACHES a content-free instruction to what the model sees;
 *   - input compaction/editing does NOT happen on this route.
 * Collapsing them back into one "nothing the model sees changes" sentence is the F65 defect.
 */
export const READY_ENABLE_SHAPING_ON_LINE =
  "Routed automatically through the local gateway; content-free receipts; Output shaping: on - a concise-response instruction is attached before each shapeable turn. Your input is not compacted or edited.";
/** The single pointer that carries the moved advanced detail to `compaction status`. */
export const READY_ENABLE_ADVANCED_POINTER =
  "Advanced routing, cache proof, and per-workflow detail:  compaction status";

/**
 * The two separate auth modes. Plan-auth is the keyless default (onboarding never requests or
 * stores an API key); API-key provider mode is the optional Advanced path used only for
 * `verify-cache`, and the key is never stored or logged.
 */
export const PLAN_AUTH_MODE_LABEL = "Plan-auth mode";
export const PLAN_AUTH_MODE_LINE =
  "A. Plan-auth mode (default): run your workflows normally with your existing CLI auth / subscription; Compaction records content-free usage. No API key is requested or stored.";
export const API_KEY_MODE_LABEL = "API-key provider mode";
export const API_KEY_MODE_LINE =
  "B. API-key provider mode (optional, Advanced): only for provider live cache verification (compaction gateway verify-cache). Never required for basic setup; your provider API key is used for that check and never stored or logged.";
/** Both mode lines, in order - surfaced together so the keyless default is always stated before the optional key path. */
export const ONBOARDING_MODES = [PLAN_AUTH_MODE_LINE, API_KEY_MODE_LINE] as const;

/**
 * The provider each routable workflow's `ROUTE_COMMANDS` entry targets (mirrors `injectionEnv` /
 * `defaultUpstreamFor` in dev.ts). Drives the verify-cache step and the provider-capability
 * lookup. A workflow absent here (Cursor) has no cache-proof route.
 */
export const READY_ROUTE_PROVIDER: Partial<Record<ReadyToolKey, string>> = {
  codex: "openai",
  "claude-code": "anthropic"
};

/**
 * The routed providers whose request shape the deterministic-dedupe apply policy understands
 * (see apply-policy.ts; both fail closed on tool-bearing / block-array / complex shapes).
 * A workflow supports context apply only when it has a route command AND routes to one of these
 * shapes - so Cursor (no route command) can never render an apply line; the blocker is structural.
 */
export const APPLY_CAPABLE_PROVIDERS: readonly string[] = ["openai", "anthropic"];

/** True iff `provider` is a routed provider whose traffic shape the deterministic-dedupe apply policy supports. */
export function isApplyCapableProvider(provider: string | undefined): boolean {
  return provider !== undefined && APPLY_CAPABLE_PROVIDERS.includes(provider);
}

/**
 * One workflow's resolved routing/cache-proof state for the Ready summary - pure and
 * content-free (no field can carry a key or prompt/response content). `routeCommand` /
 * `verifyProvider` are set only for a routable workflow; the *Only/unavailableReason fields
 * describe the limited state (Cursor).
 */
export interface ReadyRoutingCapability {
  key: ReadyToolKey;
  /** The exact routed command from `ROUTE_COMMANDS`; undefined for a workflow with no cache-proof route (Cursor). */
  routeCommand?: string;
  /** The provider id for the verify-cache step (`openai`/`anthropic`); undefined when not routable. */
  verifyProvider?: string;
  /** The routed provider's display name (from the adapter registry); undefined when not routable. */
  providerDisplayName?: string;
  /** True iff the routed provider's adapter normalizes a cache-HIT field (so the pipeline can produce cache proof). */
  cacheProofAvailable: boolean;
  /**
   * True iff deterministic context apply is supported: a route command AND an apply-capable
   * provider shape (`APPLY_CAPABLE_PROVIDERS`). Distinct from `cacheProofAvailable` and
   * `liveVerified`.
   */
  contextApplySupported: boolean;
  /** True iff a REAL passing `verify-cache` record exists for the routed provider (never fabricated). */
  liveVerified: boolean;
  /** True when the workflow only records session ACTIVITY (no gateway routing) - honest limited state. */
  activityOnly: boolean;
  /** True when the current Compaction integration can produce only a LOCAL ESTIMATE - e.g. Cursor. */
  localEstimateOnly: boolean;
  /** The concrete honest reason (from the matrix) that cache proof is unavailable - shown for non-routable rows. */
  unavailableReason?: string;
  /**
   * How the selected workflow is connected today. A shim/hook captures activity but does not
   * silently reroute the user's normal command; routable workflows expose the Gateway as an
   * explicit manual next step, while vendor-blocked workflows remain activity-only.
   */
  connectionLabel: string;
  /** Whether this build's shaping hooks hold planning/reasoning turns (probed by the caller, never assumed). */
  shapingPerTurnHold?: boolean;
  /** Whether this workflow's native shaping hooks are CONFIRMED on disk (checked after the enable). */
  shapingHooksInstalled?: boolean;
}

/** Shared, content-free connection labels rendered by both the headless and TUI Ready surfaces. */
export const READY_CONNECTION_MANUAL_LABEL =
  "Connection: capture/activity-only; Gateway routing is a manual next step (run the route command explicitly).";
export const READY_CONNECTION_CURSOR_LABEL =
  "Connection: capture/activity-only; Gateway routing unavailable (vendor gap); local-estimate only.";

/**
 * The Claude Code transparent-routing shim's verified state, passed content-free from the caller
 * (which does the resolve-verification IO) into the pure Ready model. `onPath` may only be set from
 * a real resolve-check; `shellConfigured` only from reading the user's shell rc for the marked line.
 */
export interface ClaudeRoutingState {
  installed: boolean;
  onPath: boolean;
  shellConfigured: boolean;
  exportLine: string;
}

/** The stop/disconnect tail shared by every routed-connection label (fix-the-loop honesty: how to stop). */
const CLAUDE_ROUTED_STOP_TAIL =
  "Stop anytime: compaction gateway stop · disconnect: compaction init --disconnect 1.";

/**
 * The boundary tail shared by every routed-connection label: this route captures, it does not optimize.
 *
 * Two forms, because output shaping is a real model-visible attachment and the tail must not deny it
 *. Both forms keep the input-axis guarantee the route genuinely provides - the
 * user's input is not compacted or edited - and neither claims an output effect.
 */
const CLAUDE_ROUTED_RECORD_TAIL =
  "Record-only: your input is not compacted or edited; Full optimization is the next increment.";
const CLAUDE_ROUTED_SHAPING_TAIL =
  "Output shaping: on - a concise-response instruction is attached before each shapeable turn. Your input is not compacted or edited; Full optimization is the next increment.";

/**
 * The honest Claude Code connection label for the Ready summary, from the VERIFIED routing-shim
 * state. Continuous-capture language appears only when the shim is installed (active now, or active
 * in new shells once PATH is picked up / configured); an absent shim keeps the manual-route label.
 * Boundary: the transparent route captures - it never claims optimization, savings, or billing; cache
 * + context application is stated as the NEXT increment, not a current behavior.
 *
 * `shapingOn` is the CONFIRMED-ON-DISK shaping state (same answer the per-workflow boundary line uses),
 * so this label and that line can never disagree inside one screen. Defaulting it to false understates.
 */
export function claudeRoutedConnectionLabel(
  routing: ClaudeRoutingState | undefined,
  shapingOn = false
): string {
  if (!routing || !routing.installed) return READY_CONNECTION_MANUAL_LABEL;
  const boundary = shapingOn ? CLAUDE_ROUTED_SHAPING_TAIL : CLAUDE_ROUTED_RECORD_TAIL;
  if (routing.onPath) {
    return (
      "Connection: transparent routing active - normal `claude` runs are routed through the local Compaction gateway " +
      `and captured automatically and continuously. ${boundary} ${CLAUDE_ROUTED_STOP_TAIL}`
    );
  }
  if (routing.shellConfigured) {
    return (
      "Connection: transparent routing installed - PATH line added to your shell config; open a NEW shell and normal " +
      "`claude` runs are routed through the local Compaction gateway and captured automatically and continuously. " +
      `${boundary} ${CLAUDE_ROUTED_STOP_TAIL}`
    );
  }
  return (
    "Connection: transparent routing installed - NOT yet on PATH. Add this one line, then normal `claude` runs are " +
    "routed through the local Compaction gateway and captured automatically and continuously:  " +
    `${routing.exportLine}  ${boundary} ${CLAUDE_ROUTED_STOP_TAIL}`
  );
}

/** Minimal structural shape of a capability-matrix row this model reads (kept local so model.ts stays pure). */
interface MatrixRowLike {
  workflow: string;
  activityOnly: boolean;
  localEstimateOnly: boolean;
  routingNote: string;
  reasons: Record<string, string>;
}

/** Minimal structural shape of a per-provider capability this model reads (from `deriveProviderCapabilities`). */
interface ProviderCapLike {
  providerId: string;
  displayName: string;
  cacheNormalized: boolean;
  liveVerified: boolean;
}

/**
 * Content-free inputs for the per-workflow routing/cache-proof lines: real capability-matrix
 * rows, per-provider capabilities, and the `ROUTE_COMMANDS` map. The caller computes these once
 * (with real verify-cache records) so the pure model never does IO; structural types avoid a
 * runtime dependency on the core matrix.
 */
export interface ReadyRoutingInputs {
  matrix: readonly MatrixRowLike[];
  providerCaps: readonly ProviderCapLike[];
  routeCommands: Readonly<Record<string, string>>;
  /** Verified Claude Code routing-shim state (resolve-checked by the caller); absent → manual-route label. */
  claudeRouting?: ClaudeRoutingState;
  /**
   * Whether THIS build's shaping hooks hold planning/reasoning/extended-thinking turns — i.e. whether
   * the task classifier is actually reachable. PROBED by the caller (`isShapingTaskClassifierPresent`),
   * never assumed. The classifier is PUBLIC and ships in the npm package
   * (`commercial-module-classification.json`: `public-basic-optimizer`, and `mirror-export.test.ts`
   * asserts it is not excluded), so this is not a tier question and an account changes nothing; it is
   * a per-build fact, and a build that cannot reach it shapes every turn. Absent ⇒ no hold, which is
   * the safe default: it understates the safety property rather than claiming one that is not there.
   */
  shapingPerTurnHold?: boolean;
  /**
   * The workflows whose native shaping hooks are CONFIRMED present on disk, checked by the caller
   * AFTER the enable ran. Absent from this list ⇒ shaping is NOT active for that workflow, whatever
   * the install attempt reported.
   *
   * This exists because the ready screen used to state the shaping effect unconditionally: a run whose
   * hook install had FAILED printed the honest failure in the connect block and then, twenty-five
   * lines later, told the user on the screen they keep that a concise-response instruction is attached
   * before generation. One uninterrupted run, two contradictory claims — the exact defect this whole
   * change exists to remove, arriving from the other direction.
   */
  shapingHooksInstalled?: readonly ReadyToolKey[];
}

/**
 * Derive the per-workflow routing/cache-proof state for the enabled set - pure, stable Page-1
 * order. Routable = has both a `ROUTE_COMMANDS` entry and a target provider; anything else
 * (Cursor) is activity-only/local-estimate with the matrix's own reason and no route command.
 * Never invents a stronger state than the inputs.
 */
export function deriveReadyRouting(
  enabled: readonly ReadyToolKey[],
  inputs: ReadyRoutingInputs
): ReadyRoutingCapability[] {
  const order: ReadyToolKey[] = ["claude-code", "codex", "cursor"];
  const out: ReadyRoutingCapability[] = [];
  for (const key of order) {
    if (!enabled.includes(key)) continue;
    const row = inputs.matrix.find((r) => r.workflow === key);
    const provider = READY_ROUTE_PROVIDER[key];
    const routeCommand = inputs.routeCommands[key];
    if (provider && routeCommand) {
      const pc = inputs.providerCaps.find((p) => p.providerId === provider);
      out.push({
        key,
        routeCommand,
        verifyProvider: provider,
        ...(pc ? { providerDisplayName: pc.displayName } : {}),
        cacheProofAvailable: pc?.cacheNormalized === true,
        contextApplySupported: isApplyCapableProvider(provider),
        liveVerified: pc?.liveVerified === true,
        activityOnly: false,
        localEstimateOnly: false,
        // Claude Code carries the VERIFIED routing-shim state (transparent + continuous when
        // installed); other routable workflows keep the explicit manual-route label.
        connectionLabel:
          key === "claude-code"
            ? claudeRoutedConnectionLabel(inputs.claudeRouting, inputs.shapingHooksInstalled?.includes(key) === true)
            : READY_CONNECTION_MANUAL_LABEL,
        ...(inputs.shapingPerTurnHold === true ? { shapingPerTurnHold: true } : {}),
        ...(inputs.shapingHooksInstalled?.includes(key) === true ? { shapingHooksInstalled: true } : {})
      });
    } else {
      // Not routable (Cursor): activity-only / local-estimate, with the matrix's own reason.
      out.push({
        key,
        cacheProofAvailable: false,
        contextApplySupported: false,
        liveVerified: false,
        activityOnly: row?.activityOnly === true,
        localEstimateOnly: row?.localEstimateOnly === true,
        connectionLabel: READY_CONNECTION_CURSOR_LABEL,
        ...(inputs.shapingPerTurnHold === true ? { shapingPerTurnHold: true } : {}),
        ...(inputs.shapingHooksInstalled?.includes(key) === true ? { shapingHooksInstalled: true } : {}),
        ...(row ? { unavailableReason: row.reasons.cacheProofSupported ?? row.routingNote } : {})
      });
    }
  }
  return out;
}

/**
 * Render one workflow's concise enable-screen lines: what was enabled (plan-auth default) + the run
 * command, then ONE honest Record-only boundary line. The advanced detail (keyless subscription
 * route, Optional-Advanced provider cache proof + verify-cache available-vs-live boundary,
 * Cache+context apply, not-yet-live-proven) is NOT inlined here - it lives in `compaction status`,
 * pointed to once by the section. Pure; never asks for a key (plan-auth is keyless). Both routable
 * and non-routable (Cursor) workflows use the same concise shape.
 */
export function readyRoutingWorkflowLines(cap: ReadyRoutingCapability): string[] {
  const label = READY_TOOL_COPY[cap.key].label;
  const runCommand = READY_TOOL_COPY[cap.key].runCommand;
  return [
    `    ${label} → ✓ Enabled (plan-auth, default):  ${runCommand}`,
    `      ${readyEnableBoundaryLine(cap.key, cap.shapingPerTurnHold === true, cap.shapingHooksInstalled === true)}`
  ];
}

/**
 * The Codex/Cursor honest per-workflow boundary line. `READY_ENABLE_RECORD_ONLY_LINE` cannot be used
 * for them: BOTH of its clauses are false on the setup this flow produces. There is no gateway route
 * for Codex or Cursor here (the connect installs a capture shim plus the tool's native hooks), and the
 * hooks exist precisely to attach an instruction to what the model sees - so a user who read the plan
 * consent copy ("Adds that instruction to what the model sees") and pressed Enable would land two
 * screens later on a line denying it, inside one uninterrupted flow.
 *
 * Cursor is SESSION-LEVEL - once per session, never "per turn"/"per prompt"
 * (`core/subscription-shaping-hooks.ts` is the authority) - and local-estimate only.
 *
 * Claude Code now takes the same shape: `READY_ENABLE_RECORD_ONLY_LINE` is the
 * shaping-OFF form only, and `READY_ENABLE_SHAPING_ON_LINE` is the shaping-ON form. It used to be the
 * unconditional fallthrough for this key, so the default connect - which installs the shaping hook -
 * printed "Output shaping: on" and then, forty lines later, denied it on the final screen.
 */
export const READY_ENABLE_CODEX_LINE =
  "Captured locally (content-free receipts); a concise-response instruction is attached before generation, every prompt. No Gateway route from this setup.";
/**
 * The same line for a build whose task classifier IS reachable. The hold is a real safety property, so
 * it may be stated only when the classifier that performs it is actually present — a PER-BUILD fact,
 * not a per-tier one (the classifier is public and ships in the npm package). Both forms exist so the
 * ready screen can never disagree with what `compaction hooks install --tool codex` prints about the
 * very same hook.
 */
export const READY_ENABLE_CODEX_HOLD_LINE =
  "Captured locally (content-free receipts); a concise-response instruction is attached before generation on each shapeable turn (planning/reasoning/extended-thinking turns are held). No Gateway route from this setup.";
export const READY_ENABLE_CURSOR_LINE =
  "Captured locally (content-free, local-estimate only); ONE session-level instruction per session - not per turn. No Gateway route, no input compaction, no per-turn control. Output effect is not yet measured on Cursor.";

/**
 * The lines for a workflow whose shaping hooks are NOT confirmed on disk. The capture half of the
 * connect still stands (the shim is installed and fail-open), so these say exactly that and nothing
 * about an instruction that is not attached to anything.
 */
export const READY_ENABLE_CODEX_NO_SHAPING_LINE =
  "Captured locally (content-free receipts); output shaping is NOT active for Codex - the hook config was not installed, so nothing is attached to what the model sees. No Gateway route from this setup. Retry:  compaction hooks install --tool codex";
export const READY_ENABLE_CURSOR_NO_SHAPING_LINE =
  "Captured locally (content-free, local-estimate only); output shaping is NOT active for Cursor - the hook config was not installed, so nothing is attached to what the model sees. No Gateway route, no input compaction, no per-turn control. Retry:  compaction hooks install --tool cursor";

/**
 * The honest per-workflow boundary line for the enable screen. Pure.
 *
 * `perTurnHold` is the PROBED answer for this build (never a guess): Cursor ignores it entirely,
 * because `decideShaping("cursor", …)` returns the session-level instruction before any classification
 * runs, so a per-turn hold claim would be wrong there even in a build that has the classifier.
 *
 * `hooksInstalled` is CONFIRMED-ON-DISK, checked after the enable, not what an install reported.
 * Defaulting it to false is deliberate: an unknown state understates the effect rather than promising
 * one. The shim/capture claim is unaffected either way — a hook failure never un-connects the shim.
 */
export function readyEnableBoundaryLine(key: ReadyToolKey, perTurnHold = false, hooksInstalled = false): string {
  if (key === "codex") {
    if (!hooksInstalled) return READY_ENABLE_CODEX_NO_SHAPING_LINE;
    return perTurnHold ? READY_ENABLE_CODEX_HOLD_LINE : READY_ENABLE_CODEX_LINE;
  }
  if (key === "cursor") return hooksInstalled ? READY_ENABLE_CURSOR_LINE : READY_ENABLE_CURSOR_NO_SHAPING_LINE;
  return hooksInstalled ? READY_ENABLE_SHAPING_ON_LINE : READY_ENABLE_RECORD_ONLY_LINE;
}

/**
 * The concise per-workflow enable section - or [] when no routing was supplied. Shows, per enabled
 * workflow, only the enabled line + the one Record-only boundary; a single pointer moves the
 * advanced routing / cache-proof / per-workflow detail to `compaction status`. Pure.
 */
export function readyRoutingSectionLines(
  routing: readonly ReadyRoutingCapability[]
): string[] {
  if (routing.length === 0) return [];
  const lines: string[] = [`  ${READY_ENABLE_WORKFLOW_HEADER}`];
  for (const cap of routing) lines.push(...readyRoutingWorkflowLines(cap));
  lines.push(`  ${READY_ENABLE_ADVANCED_POINTER}`);
  return lines;
}

/**
 * The Page-4 "Optimization:" line. NOT the plan/apply-posture line: the plan cards one screen
 * earlier speak of "basic shaping" (Open's apply posture), and calling BOTH "Mode" made adjacent
 * screens read as if they described the same setting. This line names the optimization mode only.
 * With no explicit mode it falls back to the recommended-default line,
 * preserving the non-interactive `--connect` surface's byte-stable output; with a mode key it
 * shows that mode's title. Pure.
 */
export function readyModeLine(modeKey?: OptimizationModeKey): string {
  if (!modeKey) return READY_MODE_LINE;
  const mode = findOptimizationMode(modeKey);
  return `Optimization: ${mode ? mode.title : READY_MODE_LABEL}`;
}

/**
 * Build the Page-4 Ready summary as plain (colour-free) lines from the tools that actually
 * connected this run. Pure: no IO, no chalk; stable Page-1 order; returns [] when nothing
 * connected. When `routing` is supplied, the plan-auth-first per-workflow section is inserted
 * after the bare run commands (see `readyRoutingWorkflowLines` for the per-workflow rules);
 * without it the output is byte-identical to the pre-section format.
 */
export function buildReadySummaryLines(
  enabled: readonly ReadyToolKey[],
  modeKey?: OptimizationModeKey,
  routing?: readonly ReadyRoutingCapability[]
): string[] {
  const order: ReadyToolKey[] = ["claude-code", "codex", "cursor"];
  const tools = order.filter((k) => enabled.includes(k));
  if (tools.length === 0) return [];

  const lines: string[] = [];
  lines.push(READY_HEADER);
  lines.push("");
  lines.push(`  ${READY_ENABLED_HEADER}`);
  for (const k of tools) lines.push(`    ✓ ${READY_TOOL_COPY[k].label}`);
  lines.push("");
  lines.push(`  ${readyModeLine(modeKey)}`);
  lines.push("");
  lines.push(`  ${READY_RUN_HEADER}`);
  for (const k of tools) lines.push(`    ${READY_TOOL_COPY[k].runCommand}`);
  const routingSection = routing ? readyRoutingSectionLines(routing) : [];
  if (routingSection.length > 0) {
    lines.push("");
    lines.push(...routingSection);
  }
  lines.push("");
  lines.push(`  ${READY_WILL_HEADER}`);
  for (const b of READY_WILL_BULLETS) lines.push(`    ${b}`);
  lines.push("");
  lines.push(`  ${READY_ACTIVITY_LABEL}  ${READY_ACTIVITY_COMMAND}`);
  lines.push("");
  lines.push(`  ${READY_ROUTING_LABEL}  ${READY_ROUTING_COMMAND}`);
  return lines;
}

/** The connect-once menu shown on the first screen (both surfaces). */
export const CONNECT_MENU: Array<{ num: string; label: string }> = [
  { num: "1", label: "Claude Code" },
  { num: "2", label: "Codex" },
  { num: "3", label: "Cursor" },
  { num: "4", label: "All supported" },
  { num: "5", label: "Skip" }
];

// The three short status pills shown under the wordmark on both surfaces.
export const STATUS_PILLS = ["local-first", "no prompt or code telemetry", "no upload by default"] as const;

export interface WorkflowCard {
  key: string;
  title: string;
  /** The exact, copy-pasteable next command for this workflow. */
  command: string;
  /** One-line description of what running this workflow gets you. */
  blurb: string;
}

// Real-workflow paths only. compaction operates on the user's OWN agent
// workflow; there is no demo / synthetic first-value path here.
export const PRIMARY: WorkflowCard = {
  key: "claude-code",
  title: "Claude Code",
  command: "compaction capture claude-code --discover",
  blurb: "Capture a local Claude Code session (recommended first run)."
};

export const SECONDARY: WorkflowCard[] = [
  {
    key: "openai-agents",
    title: "OpenAI Agents SDK",
    command: "compaction capture openai-agents --out ./my-trace -- <your-command>",
    blurb: "Capture an OpenAI Agents SDK run."
  },
  {
    key: "codex",
    title: "Codex / local import",
    command:
      "codex exec --json '<task>' > run.jsonl  &&  compaction import run.jsonl --source codex-exec-jsonl --out ./my-trace",
    blurb: "Import a Codex exec JSONL export."
  },
  {
    key: "import",
    title: "Local trace import",
    command: "compaction import --list-sources   # then: import <file> --source <source> --out ./my-trace",
    blurb: "Import any local trace / JSONL you already have."
  }
];

/**
 * The Gateway setup card. Selecting it opens the guided setup flow (`GatewayTui`) rather than
 * printing a command - the caller routes on `key === "gateway"`. Local-first: a localhost
 * byte-safe proxy; the provider key rides through and is never stored.
 */
export const GATEWAY_CARD: WorkflowCard = {
  key: "gateway",
  title: "Gateway setup",
  command: "compaction gateway start",
  blurb: "Run the local Compaction Gateway - byte-safe proxy; content-free token/cache receipts."
};

/** Gateway providers offered in the guided flow. OpenAI-compatible only today (record mode). */
export const GATEWAY_PROVIDERS = [
  { key: "openai", label: "OpenAI (openai-compatible)", upstream: "https://api.openai.com/v1", available: true }
] as const;

/** Gateway modes. RECORD ships today; cache/apply are separately-gated future modes (shown disabled). */
export const GATEWAY_MODES = [
  { key: "record", label: "Record - byte-safe; content-free receipts", available: true },
  { key: "cache", label: "Cache - coming soon", available: false },
  { key: "apply", label: "Apply - coming soon", available: false }
] as const;

/** The default local listen address surfaced by the guided flow (editable only via Advanced CLI flags). */
export const GATEWAY_DEFAULT_LISTEN = "http://127.0.0.1:8787";

/**
 * The manual/advanced workflow cards (capture/import trace tools) - reached only from the
 * "Manual & advanced" path, never the first-run chooser. The Gateway is deliberately not a peer
 * card here (see `GATEWAY_INFRA_LINES`).
 */
export const WORKFLOW_CARDS: WorkflowCard[] = [PRIMARY, ...SECONDARY];

/** Lookup a card by key (used by `--path` focus and TUI selection). */
export function findWorkflow(key: string): WorkflowCard | undefined {
  return WORKFLOW_CARDS.find((c) => c.key === key);
}

export const ALL_WORKFLOW_KEYS: string[] = WORKFLOW_CARDS.map((c) => c.key);

/**
 * Advanced / manual routes panel - shared read-only copy for the wizard's Page-1 `a` affordance,
 * matching the static `init` screen. Display-only on every surface: writes nothing, changes no
 * selection. The custom OpenAI-compatible app lives behind Advanced only, and the Gateway stays
 * infrastructure, never a peer card. Copy is composed from the same shared constants the static
 * screen uses, so there is no duplicated wording and no new claim.
 */
export interface AdvancedRoute {
  /** The section heading for this advanced route. */
  title: string;
  /** The honest body lines; a leading-space line is a copy-pasteable command / detail. */
  lines: string[];
}

/** The Advanced panel heading (read-only info view). */
export const ADVANCED_HEADER = "Advanced - manual & custom routes (read-only)";

/**
 * The custom OpenAI-compatible app route - Advanced-only; the only place the custom app appears.
 * Uses the real routing command (`READY_ROUTING_COMMAND`; see src/cli/commands/gateway.ts).
 */
export const ADVANCED_CUSTOM_APP: AdvancedRoute = {
  title: "Custom OpenAI-compatible app",
  lines: [
    "Route your own OpenAI-compatible app/command through Compaction via the local Gateway:",
    `  ${READY_ROUTING_COMMAND}`,
    "Advanced only - the custom app is never a first-run workflow lane."
  ]
};

/** Manual capture / import trace tools - the existing `WORKFLOW_CARDS` pointers, reused verbatim. */
export const ADVANCED_MANUAL_TRACE: AdvancedRoute = {
  title: "Manual capture / import (trace tools)",
  lines: WORKFLOW_CARDS.flatMap((c) => [c.blurb, `  ${c.command}`])
};

/** The Gateway framed as infrastructure (the local byte-safe routing layer) - `GATEWAY_INFRA_LINES`, reused. */
export const ADVANCED_GATEWAY_INFRA: AdvancedRoute = {
  title: "Gateway (infrastructure - not a workflow)",
  lines: [...GATEWAY_INFRA_LINES]
};

/** The three Advanced routes, in the order the panel shows them. */
export const ADVANCED_ROUTES: AdvancedRoute[] = [ADVANCED_CUSTOM_APP, ADVANCED_MANUAL_TRACE, ADVANCED_GATEWAY_INFRA];

/** The one honest closing note: these are advanced/manual routes; the main flow covers the common case. */
export const ADVANCED_NOTE =
  "These are advanced / manual routes - the main flow (Pages 1-4) covers the common case.";

/**
 * All Advanced-panel copy as one plain string - the single source both the renderer and the
 * forbidden-claim substring guard read, so the panel can never drift into an unreviewed claim.
 */
export function advancedPanelText(): string {
  return [ADVANCED_HEADER, ...ADVANCED_ROUTES.flatMap((r) => [r.title, ...r.lines]), ADVANCED_NOTE].join("\n");
}

/**
 * Interactive custom-app setup copy - the guided sub-flow behind the Advanced custom-app entry.
 * The user types the command they normally run, reviews the exact `compaction gateway run --
 * <command>`, and chooses Run now / Print command / Back. Display-only and mechanism-scoped:
 * no cost/billing/output-token/savings/semantic/all-provider claim; the entered command is never
 * persisted (memory only).
 */
export const CUSTOM_APP_INPUT_PROMPT =
  "Enter the command you normally run. Compaction will route it through the local Gateway.";

/** Example command hints shown under the text input (illustrative only; nothing is pre-filled or stored). */
export const CUSTOM_APP_COMMAND_HINTS = ["node agent.js", "npm run dev", "python scripts/agent.py"] as const;

/** The review-screen heading + the "This will:" sub-heading. Test-pinned - do not reword. */
export const CUSTOM_APP_REVIEW_HEADER = "Compaction will run:";
export const CUSTOM_APP_REVIEW_EFFECTS_HEADER = "This will:";

/**
 * The review-screen effect bullets. Test-pinned - do not reword. ✓ = default record path;
 * ○ = explicit non-action. Conditional only - no savings/cost/output-token/semantic/all-provider claim.
 */
export const CUSTOM_APP_REVIEW_BULLETS = [
  "✓ start or reuse the local Gateway",
  "✓ route supported OpenAI-compatible requests through Compaction",
  "✓ record content-free usage receipts",
  "✓ show provider-reported proof where available",
  "○ not store prompt or response content",
  "○ not ask for API keys"
] as const;

/** The exact `compaction gateway run -- <command>` line the setup will run/print for an entered command. */
export function customAppGatewayRunLine(command: string): string {
  return `compaction gateway run -- ${command}`;
}

/**
 * The full review-screen copy as plain lines, for an entered command string. The command line and the
 * effect bullets are indented two spaces (test-pinned block). Pure - no React, no IO.
 */
export function customAppReviewLines(command: string): string[] {
  return [
    CUSTOM_APP_REVIEW_HEADER,
    "",
    `  ${customAppGatewayRunLine(command)}`,
    "",
    CUSTOM_APP_REVIEW_EFFECTS_HEADER,
    ...CUSTOM_APP_REVIEW_BULLETS.map((b) => `  ${b}`)
  ];
}

/** The review-screen options, in menu order. `run` reuses `gateway run`; `print` emits the durable line. */
export const CUSTOM_APP_OPTIONS = ["Run now", "Print command", "Back"] as const;

/**
 * Split an entered command string into argv. Whitespace split only - no shell operators,
 * quoting, globbing, or pipes; the parts go straight to the `gateway run` runner, which spawns
 * without a shell. Pure.
 */
export function parseCustomAppCommand(input: string): string[] {
  return input.trim().split(/\s+/).filter((p) => p.length > 0);
}

/**
 * All custom-app setup copy as one plain string - read by the forbidden-claim guard (alongside
 * `advancedPanelText()`) so the sub-flow cannot drift into an unreviewed claim. Placeholder
 * command keeps the string stable.
 */
export function customAppSetupText(): string {
  return [
    CUSTOM_APP_INPUT_PROMPT,
    ...CUSTOM_APP_COMMAND_HINTS,
    ...customAppReviewLines("<your-command>"),
    ...CUSTOM_APP_OPTIONS
  ].join("\n");
}

// The follow-up sequence once a trace exists - FREE commands only.
export const FREE_FLOW: Array<{ command: string; desc: string }> = [
  { command: "compaction analyze", desc: "input/output tokens + estimated spend, with honest labels" },
  { command: "compaction spend", desc: "where the context spend came from (attribution)" },
  { command: "compaction summary", desc: "roll up your local runs" },
  { command: "compaction feedback --redact", desc: "build a redacted, local-only share bundle (never uploaded)" }
];

// Honest claim labels, shown verbatim on both surfaces.
export const HONESTY_LINES = [
  "Token counts are provider-reported when the run carries usage metadata,",
  "otherwise a local estimate (chars/4) - labeled as such. Cost is a",
  "price-table estimate; nothing is called a saving until it is measured.",
  "Optimization & verification are the opt-in Compaction API - not in the",
  "free CLI and not a hosted service yet. The free CLI measures and reports."
] as const;

export const FOOTER_LINES = [
  "Local-first: no network, no credentials, no repo access for any of the above.",
  "A provider credential is only ever used if YOU explicitly run",
  "`compaction capture provider-usage` or enter operator-run records."
] as const;

/* ================================================================================================
 * Production onboarding flow model (target → mode/limited → review → ready).
 *
 * The interactive `compaction init` walks the user through: (1) pick a detected workflow to
 * connect; (2) choose how Compaction optimizes it (full / output-only) - Claude Code only, since
 * the other tools are output-shaping-only or session-level; (3) review exactly what enabling does;
 * (4) run the REAL installers; (5) an honest ready screen with a REAL measured metric (or the
 * "unavailable until measured" state). All copy here is data-only (no React/chalk); the TUI is a
 * thin renderer, and every write routes through the same injected engine callbacks the static and
 * headless surfaces use.
 *
 * Per-tool / per-auth honesty (the claim boundary this model carries):
 *  - All three tools get OUTPUT-SHAPING (shorter responses) on a plan/subscription - no API key.
 *  - FULL optimization = output-shaping PLUS input compaction; the input side needs an API key /
 *    the Gateway route (an apply-capable provider). Off by default; approval-gated.
 *  - Cursor is session-level output-shaping + a LOCAL ESTIMATE only (Compaction does not ingest its
 *    conditional `result.usage`); input savings need an API key and are not measured on Cursor.
 *  - A subscription buys output-shaping + headroom (more useful work per plan window), NEVER a
 *    dollar-savings claim.
 * ============================================================================================== */

/** The auth Compaction detected for a workflow's provider - read-only (a key's VALUE is never read). */
export type OnboardingAuthState = "api-key" | "subscription";

/** Per-tool onboarding copy: title, availability tag, and the honest per-auth capability lines. */
export interface OnboardingToolCopy {
  key: ReadyToolKey;
  title: string;
  /** The detection/availability tag shown next to the title (e.g. "detected · recommended"). */
  availabilityTag: string;
  /** One honest line describing what this tool gets, per auth (no savings/cost claim). */
  capability: string;
  /** The honest "with an API key you additionally get…" line, or the vendor-gap note for Cursor. */
  fullOptimizationNote: string;
  /** True iff full optimization (input compaction via the Gateway) is even possible for this tool. */
  supportsFullOptimization: boolean;
}

/**
 * Per-tool onboarding copy, in the flow's display order (Claude Code recommended first). Wording is
 * test-pinned. No tool line makes a dollar-savings or output-token-savings claim; input compaction
 * is always gated on an API key / Gateway route, and Cursor is honestly local-estimate/session-level.
 */
export const ONBOARDING_TOOLS: OnboardingToolCopy[] = [
  {
    key: "claude-code",
    title: "Claude Code",
    availabilityTag: "recommended",
    capability: "Shorter responses on your Claude subscription or an Anthropic API key - no key needed for output shaping.",
    fullOptimizationNote: "Add an Anthropic API key (Gateway route) for full optimization: deterministic input compaction on supported requests.",
    supportsFullOptimization: true
  },
  {
    key: "codex",
    title: "Codex CLI",
    availabilityTag: "output shaping (subscription) · full optimization (API key)",
    capability: "Shorter responses on your ChatGPT plan or an OpenAI API key - no key needed for output shaping.",
    fullOptimizationNote: "Add an OpenAI API key (Gateway route) for full optimization: deterministic input compaction on supported requests.",
    supportsFullOptimization: true
  },
  {
    key: "cursor",
    title: "Cursor",
    availabilityTag: "output only · local estimate",
    capability: "Shorter responses via a session-level instruction; Compaction records a content-free local estimate.",
    fullOptimizationNote: "Input compaction and per-turn control need an API key and are not available for Cursor (no Gateway route; vendor gap). Output effect is not yet measured on Cursor.",
    supportsFullOptimization: false
  }
];

/** Look up a tool's onboarding copy by key. Pure. */
export function findOnboardingTool(key: ReadyToolKey): OnboardingToolCopy | undefined {
  return ONBOARDING_TOOLS.find((t) => t.key === key);
}

/**
 * The discovery rows re-ordered into the onboarding target order (recommended Claude Code first),
 * distinct from `deriveDiscovery`'s Page-1 order. A workflow absent from `ONBOARDING_TOOLS` is
 * dropped (there are none today). Pure - the production onboarding target picker renders this.
 */
export function orderedOnboardingDiscovery(discovery: readonly WorkflowDiscovery[]): WorkflowDiscovery[] {
  const out: WorkflowDiscovery[] = [];
  for (const tool of ONBOARDING_TOOLS) {
    const row = discovery.find((d) => d.key === tool.key);
    if (row) out.push(row);
  }
  return out;
}

/**
 * The honest "you configured ONE workflow" line for the ready screen, or undefined when there is
 * nothing left to say. Onboarding configures exactly one target per run — no multi-select; the user
 * configures the workflow they are currently in. That means a machine with
 * Claude Code AND Codex detected finishes with one of them silently uncovered — and since the whole
 * promise of this flow is that eligible future sessions run automatically, an unqualified "you're set"
 * would read as covering tools it does not. Naming the others is what keeps that promise scoped.
 *
 * Pure; `discovery` is the same real detection the target picker rendered, `enabled` is what actually
 * verified-connected this run.
 */
export function onboardingUncoveredWorkflowsLine(
  discovery: readonly WorkflowDiscovery[],
  enabled: readonly ReadyToolKey[]
): string | undefined {
  // `state === "ready"` means ALREADY CONNECTED (from an earlier run) - it is not an uncovered
  // workflow, and saying so tells a user their working setup is not configured. Only `found`
  // (detected, never connected) belongs in this line. `not-found` is not on the machine at all.
  const others = discovery
    .filter((d) => d.state === "found" && !enabled.includes(d.key as ReadyToolKey))
    .map((d) => findOnboardingTool(d.key as ReadyToolKey)?.title ?? d.title);
  if (others.length === 0) return undefined;
  return `Also detected, not configured: ${others.join(", ")}. Automatic shaping covers only the workflow you just set up - re-run \`compaction\` to configure another.`;
}

/** The header shown above the target picker. */
export const ONBOARDING_TARGET_HEADER = "Choose the workflow you want to connect.";
/** The read-only, honest sub-line under the target header (the caller injects the real detected list). */
export const ONBOARDING_TARGET_READONLY = "Discovery is read-only. Enabling a workflow is the first write.";

/**
 * The "limited" screen copy for a non-Claude tool: an honest per-tool + per-auth summary before the
 * user commits, and the exact honest note about what an API key would add. Pure; derived from the
 * per-tool copy so there is no second source of truth. Availability is INJECTED, like the mode
 * options — this module does no probing.
 *
 * `fullOptimizationReachable` false replaces the "add an API key for full optimization" note with the
 * reason it would not help: with no engine running, a key buys output shaping and nothing on the
 * input side, and telling the user otherwise sends them to fetch a key for a capability that will
 * pass their requests straight through.
 *
 * Cursor is unaffected either way: its note is already a vendor-gap statement, not an offer.
 */
export function onboardingLimitedLines(key: ReadyToolKey, fullOptimizationReachable = true): string[] {
  const tool = findOnboardingTool(key);
  if (!tool) return [];
  if (fullOptimizationReachable || !tool.supportsFullOptimization) return [tool.capability, tool.fullOptimizationNote];
  return [
    tool.capability,
    "Input compaction needs the adaptive engine, which is not released yet - an API key would add " +
      "nothing on the input side today. Output shaping works now, on your plan, with no key."
  ];
}

/**
 * The two optimization modes shown for Claude Code, mapped to the existing `OptimizationModeKey`
 * values so persistence stays on the ONE existing enum/writer (no new preference type):
 *  - `full`   → `cache-context-optimize`: output shaping + deterministic input compaction on
 *               supported requests (input side needs the Gateway/API-key route); approval-gated,
 *               original retained + recoverable.
 *  - `output` → `cache-optimize`: shorter responses only; input is sent exactly as written; works
 *               on the subscription with no model-visible change.
 * The reframed titles are the product vocabulary; the mapped key is what is persisted.
 */
export interface OnboardingModeOption {
  /** The reframed product key shown in the flow. */
  key: "full" | "output";
  title: string;
  description: string;
  /** The existing persisted optimization-mode key this maps to (no new enum introduced). */
  mapsToModeKey: OptimizationModeKey;
  recommended: boolean;
  /**
   * Whether this build can actually deliver the mode. Set by `onboardingModeOptions`; absent on the
   * raw `ONBOARDING_MODE_OPTIONS` constant, which describes the modes as designed, not as shipped.
   * A renderer MUST NOT let the user select an option with `available: false`.
   */
  available?: boolean;
}

export const ONBOARDING_MODE_OPTIONS: OnboardingModeOption[] = [
  {
    key: "output",
    title: "Output only",
    description: "Asks for shorter responses; your input is sent exactly as written - works on your subscription, no API key.",
    mapsToModeKey: "cache-optimize",
    recommended: true
  },
  {
    key: "full",
    title: "Full optimization",
    description: "Shorter responses, plus input compaction on supported requests. Needs an API key (the Gateway route); approval-gated, and the original is always recoverable.",
    mapsToModeKey: "cache-context-optimize",
    recommended: false
  }
];

/**
 * The mode options as this build can actually deliver them. Callers pass the answer from
 * `core/engine-availability.ts` (`fullOptimizationReachable`) — this module stays pure and does no
 * filesystem probing of its own.
 *
 * When the engine is unreachable — the published package excludes `dist/engine/**`, so a device
 * that has not installed a signed release has nothing to run — "Full optimization" is marked
 * UNAVAILABLE rather than offered: selecting it would take a real authorization for input
 * compaction that then never runs, and the user's requests would pass through while the flow said
 * otherwise.
 *
 * The REASON shown changed when the production release was published. "No signed engine has been
 * distributed yet" was a claim about the world; it is now false, and the true statement is about
 * THIS DEVICE — the engine is delivered separately and is not installed here yet. The predicate
 * (`fullOptimizationReachable`, which is `"present"`-only) is unchanged; only the explanation is.
 *
 * The option is still SHOWN, with the reason, rather than hidden — a user comparing modes should see
 * that the capability exists and is not released, not silently get a one-option picker.
 */
export function onboardingModeOptions(fullOptimizationReachable: boolean): OnboardingModeOption[] {
  if (fullOptimizationReachable) return ONBOARDING_MODE_OPTIONS.map((option) => ({ ...option, available: true }));
  return ONBOARDING_MODE_OPTIONS.map((option) =>
    option.key === "full"
      ? {
          ...option,
          available: false,
          description:
            "Shorter responses, plus input compaction on supported requests - not available on this device yet, " +
            "because the adaptive engine that performs it is delivered separately and is not installed here. " +
            "Activating Community installs it for you. Selecting it today would change nothing about your requests."
        }
      : { ...option, available: true }
  );
}

/** The header shown above the Claude Code mode picker (kept for the Claude Code default). */
export const ONBOARDING_MODE_HEADER = "Choose how Compaction should optimize Claude Code.";
/** The honest sub-lines under the Claude Code mode header (auth stays the user's; Compaction runs locally). */
export const ONBOARDING_MODE_SUBLINES = [
  "Your Claude subscription (or API key) remains how Claude Code authenticates.",
  "Compaction runs locally between the Claude launcher and supported traffic."
] as const;

/**
 * The mode screen is reachable for every tool that HAS two modes, so its copy must name the tool the
 * user is actually configuring and the credential that tool actually authenticates with. Hardcoding
 * Claude Code told a Codex user that a Claude subscription authenticates Codex, which is simply false.
 * Pure; derived per key so there is no second source of truth.
 */
export function onboardingModeHeader(key: ReadyToolKey): string {
  const title = findOnboardingTool(key)?.title ?? key;
  return `Choose how Compaction should optimize ${title}.`;
}

/** The honest per-tool sub-lines under the mode header. Names the tool's OWN auth, never Claude's. */
export function onboardingModeSublines(key: ReadyToolKey): readonly string[] {
  if (key === "codex") {
    return [
      "Your ChatGPT plan (or OpenAI API key) remains how Codex authenticates.",
      "Compaction runs locally between the Codex launcher and supported traffic."
    ];
  }
  if (key === "cursor") {
    return [
      "Your Cursor plan (or API key) remains how Cursor authenticates.",
      "Compaction runs locally alongside Cursor; it never proxies your Cursor session."
    ];
  }
  return ONBOARDING_MODE_SUBLINES;
}

/** Map a reframed onboarding mode key to the existing persisted optimization-mode key. Pure. */
export function onboardingModeToOptimizationKey(key: "full" | "output"): OptimizationModeKey {
  return key === "full" ? "cache-context-optimize" : "cache-optimize";
}

/**
 * ONE hook entry enabling will write, described content-free. INJECTED by init.ts from the REAL
 * installer (`core/subscription-hooks-install.ts`), never re-derived here: this module must stay pure,
 * and a second hand-maintained copy of the entry list would drift from what is actually written.
 */
export interface OnboardingHookDisclosure {
  /** The exact config file enabling will write (e.g. `~/.codex/hooks.json`). */
  file: string;
  /** Where an existing file is backed up before it is modified. */
  backupPath: string;
  /** Every entry that write adds, in write order. */
  entries: readonly { event: string; command: string; effect: string }[];
}

export interface OnboardingReviewOptions {
  /** The chosen plan, listed with the other real effects so it never happens quietly between screens. */
  plan?: OnboardingPlanKey;
  /**
   * The hook config write this enable will perform (Codex/Cursor). ABSENT means no hook config will be
   * written — either the tool has none, or output shaping is switched off (`compaction stop` /
   * COMPACTION_SHAPING_HOOKS=0), in which case the review says so rather than staying silent.
   */
  hooks?: OnboardingHookDisclosure;
}

/** The review screen's three regions: the ask, the exact effects, and the honest closing boundaries. */
export interface OnboardingReviewContent {
  headline: string;
  bullets: string[];
  notes: string[];
}

/**
 * The review screen content for enabling a workflow - the exact, honest set of real effects the REAL
 * installers perform. This screen is the documented FIRST-WRITE gate, so every file the enable touches
 * has to be named here: onboarding must not write a file it never disclosed. For Codex/Cursor that
 * includes the tool's own hooks config, the backup, and each hook entry, because those entries attach
 * an instruction to what the model sees — the very thing the plan screen asked consent for.
 *
 * No savings/cost claim. Pure; the tool, mode, plan, and hook entries are all named so the copy is
 * concrete and can never describe a different write than the one that follows.
 */
export function onboardingReviewContent(
  key: ReadyToolKey,
  modeKey: "full" | "output",
  options: OnboardingReviewOptions = {}
): OnboardingReviewContent {
  const tool = findOnboardingTool(key);
  const modeTitle = ONBOARDING_MODE_OPTIONS.find((m) => m.key === modeKey)?.title ?? "Output only";
  const bullets = [
    "  • install a reversible, fail-open launcher/shim (the real binary is never replaced)",
    "  • add its launcher directory to your shell PATH (announced, backed up, reversible)"
  ];
  // Cursor has no Gateway route at all (no ROUTE_COMMANDS entry), so promising an on-demand Gateway
  // there would describe routing that cannot happen.
  if (key !== "cursor") {
    bullets.push("  • start the local Gateway on demand when the workflow needs routing");
  }
  if (options.hooks) {
    bullets.push(
      `  • write ${options.hooks.file} - MERGED, never replaced (any existing file is backed up to ${options.hooks.backupPath}):`
    );
    for (const entry of options.hooks.entries) {
      bullets.push(`      - ${entry.event}: \`${entry.command}\` - ${entry.effect}`);
    }
  }
  // A mode the user never picked is stated as THE default, not as their choice (Cursor has one mode,
  // so it gets no picker; claiming they chose it would assert a decision that never happened).
  bullets.push(
    tool?.supportsFullOptimization === false
      ? `  • use "${modeTitle}" as the default for future runs (the only mode available for ${tool?.title ?? key})`
      : `  • remember "${modeTitle}" as your default for future runs`
  );
  if (options.plan) bullets.push(onboardingPlanReviewLine(options.plan));

  const notes = ["No API key is requested for the subscription (output-shaping) path."];
  if (!options.hooks && (key === "codex" || key === "cursor")) {
    notes.push(
      "Output shaping is currently switched off (`compaction stop` / COMPACTION_SHAPING_HOOKS=0), so no hook config will be written."
    );
  }
  notes.push(
    "Disable anytime restores the previous PATH configuration; nothing model-visible changes without approval."
  );
  return { headline: `Enable Compaction for ${tool?.title ?? key}? Compaction will:`, bullets, notes };
}

/** The review content as flat lines (headline, then effects, then the closing boundaries). Pure. */
export function onboardingReviewLines(
  key: ReadyToolKey,
  modeKey: "full" | "output",
  options: OnboardingReviewOptions = {}
): string[] {
  const content = onboardingReviewContent(key, modeKey, options);
  return [content.headline, ...content.bullets, ...content.notes];
}

/**
 * The honest ready-screen setup rows, derived from REAL verified state passed in by the caller
 * (never a simulated scenario). `launcher`/`gateway`/`auth` are content-free status strings the
 * caller computes from `verifyShimActive` / `getGatewayStatus` / auth detection. Pure.
 */
export interface OnboardingReadyStatus {
  /** True only when the launcher/shim is verified active AND (for routed traffic) the gateway is reachable or on-demand-ready. */
  healthy: boolean;
  /** Honest headline reflecting the verified state (active / installed-not-active / verification pending). */
  headline: string;
  /** Content-free launcher status string (from real shim verification). */
  launcher: string;
  /** Content-free gateway status string (from real `getGatewayStatus`). */
  gateway: string;
  /** Content-free auth label (subscription vs API key), from read-only env presence - the VALUE is never read. */
  auth: string;
  /** The exact next action when not yet healthy (e.g. open a new shell); undefined when healthy. */
  nextAction?: string;
}

// ---------------------------------------------------------------------------
// PLAN — the open-core choice the stepper offers, and the Community activation
// seam. This is the "authorize" step of the canonical flow (connect → mode →
// authorize → a line every turn).
// ---------------------------------------------------------------------------

/**
 * The open-core apply posture a stepper run can land on. Structurally identical to core's
 * `ProductMode`; kept as its own alias so nothing under `src/cli/onboarding/**` has to reach into the
 * preference store to talk about the outcome. (init.ts performs; this module only describes.)
 */
export type OnboardingProductMode = "observe" | "basic" | "full";

/**
 * The THREE selectable plans: two that provision, and one that hands off.
 *
 * PRO IS SELECTABLE BUT NOT PURCHASABLE, and that distinction is the whole design. Pro is still
 * waitlist-only — no purchase, no entitlement issued — so choosing
 * it CANNOT enrol anyone, and this module never says it has. What choosing it does is open the one
 * canonical waitlist surface (`/waitlist?plan=pro`, owned by `src/cli/commands/pro.ts`) and leave the
 * device on the Open floor. That is a real destination doing a real thing, which is what makes the
 * option honest to show; the earlier objection to listing it — that a picker entry implies a
 * selectability that does not exist — is answered by naming the handoff instead of implying a sale.
 *
 * TEAM IS STILL ABSENT. The canonical journey names three choices (Open / Community / Pro) and only
 * three; Team has no seat in it, and adding a fourth entry that also just opens a waitlist would be
 * padding the picker rather than serving the flow.
 *
 * Nothing here names a price. `compaction upgrade` remains the surface that explains conversion; this
 * is a door to the same page, not a second Pro path.
 */
export type OnboardingPlanKey = "open" | "community" | "pro";

export interface OnboardingPlanOption {
  key: OnboardingPlanKey;
  title: string;
  /** One-line summary shown next to the title. */
  summary: string;
  /** The exact effects, stated BEFORE anything is persisted. */
  effects: readonly string[];
  recommended: boolean;
}

/**
 * CONSENT COPY — load-bearing, not decoration.
 *
 * Choosing Open persists `product_mode: "basic"`, which attaches a concise-response instruction to
 * supported requests BEFORE they are generated. That is a model-visible change to what the assistant
 * is asked to do, so the user is told exactly what it does, what it does NOT do, and how to turn it
 * off — on the screen where they choose it, before the write. Previously onboarding wrote no product
 * mode at all, which left every user at `observe` while the per-turn line claimed nothing; stating
 * the effect and then honoring it is the honest version of that.
 *
 * No savings figure appears here. The output-shaping reduction that HAS been measured was measured on
 * a different surface, and a per-run counterfactual for this user does not exist.
 */
export const ONBOARDING_PLAN_OPTIONS: readonly OnboardingPlanOption[] = [
  {
    key: "open",
    title: "Open",
    summary: "no account, works offline",
    effects: [
      "Asks for shorter answers: a concise-response instruction is attached to supported requests before they are generated.",
      // "Never changes the input you wrote" is true and, on its own, misleading:
      // an instruction block IS added to what the model sees. Saying both halves is the honest form.
      "Adds that instruction to what the model sees; your own words are never edited, nothing is uploaded, and no network call is made.",
      // THE OFF SWITCH MUST BE ONE THAT WORKS. This line used to say
      // "Turn it off anytime with `compaction mode observe`". It is false: `decideShaping` reads only
      // the kill switch and the persisted stop-state, and NOTHING in the hook path reads `product_mode`
      // (grep: zero references). Telling a user in the consent screen that a command turns shaping off
      // when it does not is a defect, not a wording preference — so it is corrected rather than
      // referred. `compaction stop` is the switch that actually works, and it stays true whichever way
      // open decision D2 goes.
      "Your per-turn line will read `basic shaping` on turns that are shaped. Turn shaping off anytime with `compaction stop`."
    ],
    recommended: true
  },
  {
    key: "community",
    title: "Community",
    summary: "free account, 1 device",
    effects: [
      "Everything in Open, plus this device is registered to a free Community account and gets its entitlement.",
      "One browser confirmation now — you come back already signed in, with nothing left to run.",
      "Free, 1 device, no card and no payment. Community adds the private adaptive engine where it is available to you; until then you stay on Open shaping and this screen says so."
    ],
    recommended: false
  },
  {
    // THE HONEST SHAPE OF THIS OPTION: it sets the device up as Open and opens a waitlist. Every
    // line below exists to stop a user believing they bought, enabled, or queued for something they
    // did not — the failure mode a selectable-but-unpurchasable entry invites.
    key: "pro",
    title: "Pro",
    summary: "waitlist — not yet purchasable",
    effects: [
      "Sets this device up exactly like Open (basic shaping). Pro is not enabled here and no Pro entitlement is created.",
      "Opens your browser once to join the Pro waitlist. Nothing is purchased, no card is asked for, and no payment details are collected.",
      "You stay on Open shaping until Pro is available and you are invited. Want the free account and its entitlement now? Choose Community instead."
    ],
    recommended: false
  }
] as const;

/**
 * The header above the plan picker. "Both options are free" was true of two options and is false of
 * three, so it names which ones are free rather than dropping the fact — Pro's price is not the point
 * here, its unavailability is.
 */
export const ONBOARDING_PLAN_HEADER =
  "Choose how Compaction runs for you. Open and Community are free; Pro is a waitlist.";

/** The honest sub-lines under the plan header. */
export const ONBOARDING_PLAN_SUBLINES = [
  "Nothing is written until you confirm on the next screen.",
  "You can change this later with `compaction mode`."
] as const;

/** Look up a plan option by key. Pure. */
export function findOnboardingPlan(key: OnboardingPlanKey): OnboardingPlanOption | undefined {
  return ONBOARDING_PLAN_OPTIONS.find((p) => p.key === key);
}

/**
 * The extra review-screen line naming what the CHOSEN plan will persist. It rides with the existing
 * effect bullets so the plan is never something that happened quietly between screens.
 */
export function onboardingPlanReviewLine(plan: OnboardingPlanKey): string {
  if (plan === "community") {
    return "  • set your mode to basic shaping, then open your browser once to activate your free Community account";
  }
  if (plan === "pro") {
    // Names the write AND the non-write. The consent gate is the last screen before anything lands on
    // disk, so "no Pro entitlement is created" belongs here and not only on the picker.
    return "  • set your mode to basic shaping, then open your browser once to join the Pro waitlist (nothing is purchased and no Pro entitlement is created)";
  }
  return "  • set your mode to basic shaping (concise-response instruction attached before generation)";
}

/**
 * THE PRO HANDOFF SCREEN — the copy, kept here so it is pure and testable and so the TUI holds no
 * strings of its own.
 *
 * WHY THE URL IS ALWAYS RENDERED, never only on failure. `openBrowser` is fire-and-forget: it spawns
 * an opener and unrefs it, so it cannot report whether a browser actually appeared, and on a headless
 * or SSH shell (or with `COMPACTION_NO_BROWSER=1`) nothing happens at all. A screen that said "your
 * browser is opening" and nothing else would strand exactly those users. Printing the link
 * unconditionally is the same choice the device-login screen already makes, for the same reason.
 *
 * WHAT THIS SCREEN IS NOT: a wizard step. It has no input to collect and no state to advance — the
 * signup happens in the browser, on the page that owns it. It exists to name the destination, to give
 * a retry that is one keypress, and to say plainly that the setup is already finished and valid
 * without it.
 */
export const ONBOARDING_PRO_WAITLIST_HEADLINE = "Join the Pro waitlist";

/** The handoff body. `url` is the resolved canonical waitlist URL. Pure. */
export function onboardingProWaitlistLines(url: string): readonly string[] {
  return [
    "Your setup is already complete and this device is on Open shaping — that does not depend on the waitlist.",
    "No Pro entitlement was created, nothing was purchased, and no payment details were collected.",
    "",
    `Opening: ${url}`,
    "If your browser did not open, use that link.",
    "",
    "1  open it again   ·   2  continue"
  ];
}

// --- The Community activation seam -----------------------------------------
//
// The TUI RENDERS; init.ts PERFORMS. This callback is the entire boundary between them.
//
// WHAT CROSSES IT — a CLOSED LIST. Everything the seam may carry is named here; anything not on this
// list does not cross, and adding to it is a deliberate act (the field set is pinned by
// `tests/security/onboarding-tui-purity.test.ts`, so a widening fails a test rather than needing to
// be noticed in review).
//
//   progress  · `kind`            — which phase activation is in
//             · `userCode`        — the confirmation code, meant to be read aloud off the screen
//             · `verificationUri` — the page the user opens; on a headless/SSH shell it is the only
//                                   way through, because the browser open silently no-ops
//             · `step`            — DELIBERATELY ADDED. A two-value enum, `"lease" | "engine"`, that
//                                   says WHICH of the two automatic setup steps the screen is waiting
//                                   on. It is a constant chosen by the code, not read from the device,
//                                   the account or the service, so it can carry nothing about the
//                                   user; it exists because these are the two moments that take a
//                                   visible pause and an unexplained pause reads as a hang.
//   success   · `ok`, `alreadyLoggedIn`
//             · `email`           — INTENTIONALLY ON THIS LIST. It is the user's own address, which
//                                   they just typed into the browser themselves; showing it back
//                                   ("signed in as …") is the confirmation that the right account was
//                                   connected. It is identity, not a secret, and it authorizes nothing.
//             · `effectiveMode`   — the posture that actually persisted
//             · `fullApplyPendingReason` — a fixed content-free label (e.g. `lease-invalid`)
//   failure   · `ok`, `reason`    — one of seven fixed coded reasons
//             · `serviceStatus`   — DELIBERATELY ADDED (F67). The HTTP status that came back,
//                                   present only on the two ANSWERED reasons (`endpoint_not_found`,
//                                   `service_error`). A bare integer off the response line: it says
//                                   nothing about the user, and it is the one detail that tells a
//                                   service that refused apart from a server that is not the
//                                   Compaction API apart from a service that was never reached —
//                                   three states the screen used to render as one.
//
// The device token, the device id, and the locally-generated private key are NOT on the list. They
// go from the device-flow client straight to the 0600 credentials store and are never returned to a
// caller, so the component cannot render or leak what it never receives.

/** Content-free progress while activation runs. `awaiting-browser` carries the two things the user
 *  must be able to read — on a headless/SSH shell the browser open silently no-ops. */
export type OnboardingAuthProgress =
  | { kind: "starting" }
  | { kind: "awaiting-browser"; userCode: string; verificationUri: string }
  | { kind: "polling" }
  // AFTER the browser confirmation: the entitlement and the private engine are being set up. Not a
  // step the user takes and not a question — the screen says what it is waiting on, because these
  // are the two things that can take a visible moment and silence there reads as a hang.
  | { kind: "provisioning"; step: "lease" | "engine" };

/**
 * Why activation did not complete. SEVEN reasons, rendered as seven different messages: being
 * offline is not the same story as being declined in the browser, nor as a service that answered
 * and could not sign the device in, nor as a URL that reaches a server which is not the Compaction
 * API, and one generic failure message would be wrong for most users who see it.
 *
 * Mirrors `DeviceLoginFailureReason` — init.ts passes the login's reason straight through.
 */
export type OnboardingAuthFailureReason =
  | "denied"
  | "expired"
  | "timeout"
  | "unreachable"
  | "endpoint_not_found"
  | "service_error"
  | "cancelled";

export interface OnboardingAuthSuccess {
  ok: true;
  /** True when the device was ALREADY signed in — no browser round trip happened. */
  alreadyLoggedIn: boolean;
  /** The account's own email, so the ready screen can confirm WHICH account was connected. Identity,
   *  not a secret: the user typed it into the browser a moment ago, and it authorizes nothing. */
  email?: string;
  /**
   * The posture the NEXT TURN will actually have — which is what the Ready screen renders, under the
   * heading `Per turn`.
   *
   * `full` requires EVERY gate the Gateway itself checks before a full apply: a valid entitlement
   * lease on this device, the `cache-plus-context` optimization mode, AND a stored apply
   * authorization for an enabled workflow. A valid lease alone is NOT enough — with the default
   * Output-only mode every request stays on the non-apply path, so reporting `full` off the lease
   * announced a capability the very next request would refuse. Anything short of all the gates
   * reports `basic`, the Open floor, plus the reason below. It is never `observe`: leaving someone
   * who chose Community below what Open would have given them is the one outcome this flow must never
   * produce.
   */
  effectiveMode: OnboardingProductMode;
  /** Content-free label for why full apply is not active yet, when it is not (e.g. `lease-invalid`,
   *  or one of `FULL_APPLY_PENDING_REASONS`). */
  fullApplyPendingReason?: string;
}

export type OnboardingAuthOutcome =
  | OnboardingAuthSuccess
  | {
      ok: false;
      reason: OnboardingAuthFailureReason;
      /** The status that came back. Present only on the two ANSWERED reasons —
       *  `endpoint_not_found` and `service_error`. */
      serviceStatus?: number;
    };

/**
 * The injected Community-activation callback — the fourth injected side-effecting dependency,
 * exactly parallel to `readyStatusFor`. Implemented in init.ts (browser device flow + lease acquire
 * + mode persistence); the component only calls it and renders what comes back.
 */
export type CommunityAuthFn = (
  onProgress: (progress: OnboardingAuthProgress) => void,
  signal: AbortSignal
) => Promise<OnboardingAuthOutcome>;

/**
 * The two LOCAL gates that can hold full apply back even with a perfectly valid entitlement lease.
 * Both are the user's own configuration, both are checked by the Gateway on every request, and
 * neither was visible on the Ready screen before — which is how the screen came to announce `full
 * apply` for a default Output-only user whose every request stays on the non-apply path.
 *
 * Fixed, content-free strings: they name a setting, never a path, an id, or a count.
 */
export const FULL_APPLY_PENDING_REASONS = {
  /** The persisted optimization mode is `cache` — the stepper's recommended "Output only". */
  optimizationMode: "the optimization mode is Output only",
  /** No stored `auto-when-gates-pass` authorization covers an enabled workflow. */
  applyAuthorization: "no apply authorization for this workflow yet"
} as const;

/** Whether a pending reason is one of the two LOCAL gates (as opposed to an entitlement problem). */
export function isLocalFullApplyGateReason(reason: string | undefined): boolean {
  return reason !== undefined && (Object.values(FULL_APPLY_PENDING_REASONS) as string[]).includes(reason);
}

/**
 * The ONE sentence the Ready screen adds when only a local gate is missing — a statement of what full
 * apply requires, in the same words the stepper's own mode picker used ("Full optimization").
 *
 * Deliberately NOT a call to action: no imperative, no command, no price, no URL. The user is already
 * on Community and owes nothing; what they lack is information about their own earlier choice, and
 * turning that into a prompt to change it would make an honest correction into a sales line.
 */
export const FULL_APPLY_REQUIREMENT_LINE =
  "Full apply runs on the Full optimization mode with an apply authorization for the workflow.";

/**
 * The message for each activation failure. Every branch says the same three things, because all three
 * are what stops this being a dead end: what happened, that Open IS active and persisted (so the
 * install is working, not broken), and the ONE command that finishes Community later.
 *
 * `retryable` drives whether "try again" is offered — retrying a denial that a human just refused in
 * the browser only makes sense after they change their mind, whereas retrying an unreachable service
 * is the obvious move.
 */
export function onboardingAuthFailureLines(
  reason: OnboardingAuthFailureReason,
  serviceStatus?: number
): {
  headline: string;
  detail: string;
  retryable: boolean;
} {
  switch (reason) {
    case "denied":
      return {
        headline: "The browser request was declined.",
        detail: "No account was created and nothing about your setup changed.",
        retryable: true
      };
    case "expired":
      return {
        headline: "The confirmation code expired before it was approved.",
        detail: "Codes are short-lived; a retry issues a fresh one.",
        retryable: true
      };
    case "timeout":
      return {
        headline: "Timed out waiting for the browser confirmation.",
        detail: "Nothing was created. You can finish this whenever the browser step is convenient.",
        retryable: true
      };
    case "unreachable":
      return {
        headline: "Could not reach the Compaction service.",
        detail: "This is a connection problem, not a rejection — the service may be offline, or this machine may be.",
        retryable: true
      };
    case "endpoint_not_found":
      // A server answered, but not as the device-authorization endpoint — what a wrong host or base
      // path looks like from here. This is the ONE answered failure that keeps the URL remedy,
      // because the configured URL is the thing the user can change. It names the setting, not the
      // URL: the seam does not carry the resolved URL and does not need to in order to say this.
      return {
        headline: `A server answered, but not as the Compaction device sign-in endpoint${
          serviceStatus === undefined ? "" : ` (HTTP ${serviceStatus})`
        }.`,
        detail:
          "Nothing was created. Check the service URL — COMPACTION_API_URL, or `compaction login --api-url <url>`.",
        retryable: true
      };
    case "service_error":
      // The endpoint was there and ANSWERED, so this branch must not send the user to their network
      // or to their URL — there is nothing on their side to fix. The status is named, never
      // interpreted.
      return {
        headline: `The Compaction service answered, but could not sign this device in${
          serviceStatus === undefined ? "" : ` (HTTP ${serviceStatus})`
        }.`,
        detail: "This is a problem on the service side, not your connection. Nothing was created.",
        retryable: true
      };
    case "cancelled":
      return {
        headline: "Cancelled.",
        detail: "Nothing was created.",
        retryable: true
      };
  }
}

/**
 * The three lines shown when a user leaves activation and continues on Open. Said together and in the
 * same breath, deliberately: "Open is on" without "Community was not activated" reads as success, and
 * either without the finishing command leaves the user with no way back.
 */
export const ONBOARDING_AUTH_FALLBACK_LINES = [
  "Open is active and saved — your setup works right now.",
  "Community was NOT activated: no account was created and no device was registered.",
  "To finish Community later, run `compaction` again and choose Community."
] as const;
