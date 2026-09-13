/**
 * Gateway-native "run a workflow through the gateway" runner (PUBLIC CLI).
 *
 * The public gateway-native entry point is `compaction gateway run -- <command>`. `compaction dev -- …`
 * remains as a hidden compatibility alias (same behavior). Both call `runThroughGateway`.
 *
 * Runs any command with its OpenAI base URL pointed at the local Compaction Gateway, so an
 * OpenAI-compatible app/SDK routes through Compaction with NO manual baseURL copy-paste:
 *   compaction gateway run -- npm run dev
 *   compaction gateway run -- node app.js
 *
 * Behavior: start (or REUSE) the local gateway → inject the gateway endpoint env into the child (never a
 * key) → run the child with stdio inherited (stdout/stderr/stdin pass through UNCHANGED) → exit with the
 * child's exit code → print a content-free "traffic observed" summary (receipts recorded during this run).
 * It NEVER reads/stores a provider key and NEVER mutates files. Default RECORD mode never mutates
 * requests/responses; explicit `--mode apply --policy deterministic-dedupe` starts the SAME gated
 * deterministic apply gateway as `gateway start --mode apply` (same eligibility gates, receipts,
 * original-retention, and recovery, nothing reimplemented here).
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { Command } from "commander";
import { runGatewayStart, parseListen } from "./gateway.js";
import { DEDUPE_POLICY } from "../../core/gateway/request-shape.js";
import { autoWorkflowNote, resolveWorkflowForGatewayRun } from "../../core/gateway/workflow-default.js";
import { getGatewayStatus, readGatewayPid, readReceipts } from "../../core/gateway/status.js";
import { summarizeCacheProof } from "../../core/gateway/cache-proof.js";
import { formatFreshBilledInputReduction, type GatewayReceipt } from "../../core/gateway/receipt.js";
import { gatewayQuiescent, gatewayReleaseMatches, queryGatewayIdentity } from "../../core/gateway/update-identity.js";
import { defaultManagedRoot } from "../../core/update/ownership.js";
import { resolveSessionPin } from "../../core/update/sessions.js";

export type RoutedWorkflowIdentity = "codex" | "claude-code";

export interface RunThroughGatewayOptions {
  provider?: string;
  upstream?: string;
  listen?: string;
  workflow?: string;
  /**
   * EXPLICIT saved-login subscription route (`--subscription`; OpenAI/Codex or Anthropic/Claude Code).
   * Routes the exact supported tool through an ephemeral local gateway under the user's saved login: credential-free
   * (the saved-login credential rides through untouched, never read, stored, or logged), byte-safe,
   * pinned to the matching first-party upstream, and fail-open before the child starts.
   */
  subscription?: boolean;
  /** Pre-promotion internal spelling for the SAME transport; kept for compatibility, never a separate behavior. */
  internalClaudeSubscription?: boolean;
  /**
   * Gateway mode for the ephemeral gateway this run starts: `record` (default, byte-safe, no mutation)
   * or `apply` (EXPERIMENTAL, the same gated deterministic apply as `gateway start --mode apply`,
   * requires `policy`). The mode is passed through to the existing gateway-start path unchanged.
   */
  mode?: string;
  /** Deterministic apply policy (required for `mode: "apply"`). Only `deterministic-dedupe` is implemented. */
  policy?: string;
}

/** The exact tool binaries accepted by each saved-login route. */
const CLAUDE_EXECUTABLES = new Set(["claude", "claude.exe"]);
const CODEX_EXECUTABLES = new Set(["codex", "codex.exe"]);

/** Flags under which the Claude Code CLI does NOT need an interactive terminal. */
const CLAUDE_NON_INTERACTIVE_FLAGS = new Set(["-p", "--print", "-h", "--help", "-v", "--version"]);

/**
 * True when the launched command is the Claude Code CLI in its interactive form: flag-only args with no
 * one-shot/introspection flag. A positional arg may be a subcommand (`claude mcp list`) or a prompt -
 * ambiguous, so those are never blocked (a piped positional prompt still hits the vendor error; accepted
 * limitation in favor of never blocking a legitimate non-interactive subcommand).
 */
export function isBareInteractiveClaude(parts: string[]): boolean {
  if (parts.length === 0 || !CLAUDE_EXECUTABLES.has(path.basename(parts[0]).toLowerCase())) return false;
  const args = parts.slice(1);
  if (args.some((a) => !a.startsWith("-"))) return false;
  return !args.some((a) => CLAUDE_NON_INTERACTIVE_FLAGS.has(a));
}

export function parseRoutedWorkflowIdentity(value: string | undefined): RoutedWorkflowIdentity | undefined {
  if (value === undefined) return undefined;
  if (value === "codex" || value === "claude-code") return value;
  throw new Error(`--workflow '${value}' is not implemented (codex | claude-code)`);
}

/** The two trusted workflow identities are valid only on their established provider route. */
export function validateRoutedWorkflowProvider(workflow: RoutedWorkflowIdentity | undefined, provider: string): void {
  if (workflow === "codex" && provider !== "openai") {
    throw new Error(`workflow 'codex' requires provider 'openai' (received '${provider}')`);
  }
  if (workflow === "claude-code" && provider !== "anthropic") {
    throw new Error(`workflow 'claude-code' requires provider 'anthropic' (received '${provider}')`);
  }
}

/** Normalize equivalent upstream URLs before deciding whether a running Gateway is reusable. */
export function normalizeEffectiveUpstream(value: string): string {
  const url = new URL(value);
  url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.toString();
}

/**
 * The base-url env var(s) the client reads, per provider. We set ONLY the base URL, never a key.
 *
 * - `openai` (default, OpenAI-compatible): OpenAI SDKs read `OPENAI_BASE_URL` / `OPENAI_API_BASE` and
 *   append the request path (`/chat/completions`, …) themselves, so the base MUST carry the `/v1` suffix.
 * - `anthropic`: Claude Code / the Anthropic SDK honor `ANTHROPIC_BASE_URL` and append `/v1/messages`
 *   THEMSELVES, so the base MUST NOT carry a `/v1` suffix (unlike OpenAI). Pointing this at the gateway
 *   routes Claude Code's Anthropic traffic through Compaction → the Anthropic adapter records real
 *   provider-reported token/cache receipts.
 *
 * Any other provider id falls back to the OpenAI-compatible injection (documented), we never GUESS a
 * base-url env var name we are not certain of. Content-free: no key is ever placed in the returned env.
 */
export function injectionEnv(base: string, provider = "openai"): Record<string, string> {
  if (provider === "anthropic") {
    // NO `/v1`, Claude Code appends `/v1/messages` itself.
    return { ANTHROPIC_BASE_URL: base };
  }
  const v1 = `${base}/v1`;
  return { OPENAI_BASE_URL: v1, OPENAI_API_BASE: v1 };
}

/**
 * Add the supported Codex CLI's ephemeral top-level base URL override for this process only.
 *
 * Codex does not reliably route from `OPENAI_BASE_URL` alone. Its supported CLI configuration surface
 * is `-c key=value`, where the value is TOML. We retain the env injection for SDK compatibility and add
 * this override only when the explicitly scoped workflow actually launches a `codex` executable. No
 * user config file is read or changed. The subscription form uses a fresh custom provider whose
 * `requires_openai_auth` setting asks Codex to attach its existing ChatGPT login to the loopback route.
 */
export function routedCommand(
  parts: string[],
  base: string,
  workflow?: RoutedWorkflowIdentity,
  subscription = false
): string[] {
  if (workflow !== "codex" || parts.length === 0) return [...parts];
  const executable = path.basename(parts[0]).toLowerCase();
  if (executable !== "codex" && executable !== "codex.exe") return [...parts];
  if (subscription) {
    const provider = "compaction_subscription";
    return [
      parts[0],
      "-c", `model_provider=${JSON.stringify(provider)}`,
      "-c", `model_providers.${provider}.name=${JSON.stringify("Compaction ChatGPT subscription")}`,
      "-c", `model_providers.${provider}.base_url=${JSON.stringify(base)}`,
      "-c", `model_providers.${provider}.wire_api=${JSON.stringify("responses")}`,
      "-c", `model_providers.${provider}.requires_openai_auth=true`,
      ...parts.slice(1)
    ];
  }
  const openaiBaseUrl = `${base}/v1`;
  return [parts[0], "-c", `openai_base_url=${JSON.stringify(openaiBaseUrl)}`, ...parts.slice(1)];
}

/** The public API base-url used as the upstream default per provider (only its ORIGIN selects the adapter). */
export function defaultUpstreamFor(provider = "openai"): string {
  // Anthropic upstream is the bare origin so the Anthropic adapter is selected by host; OpenAI keeps `/v1`.
  return provider === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com/v1";
}

/** The provider key env var name we NAME in the honest "child still needs its key" note (we never read it). */
function providerKeyEnvName(provider: string): string {
  return provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
}

/** True when SOME provider key is present in the environment (we never read its value). */
function hasProviderKey(env: NodeJS.ProcessEnv, provider = "openai"): boolean {
  if (provider === "anthropic") {
    return Boolean(env.ANTHROPIC_API_KEY && env.ANTHROPIC_API_KEY.trim());
  }
  return Boolean((env.OPENAI_API_KEY && env.OPENAI_API_KEY.trim()) || (env.OPENAI_KEY && env.OPENAI_KEY.trim()));
}

/**
 * Exact per-workflow route commands - ONE obvious command per tool, no manual env vars. Exposed so the
 * Ready / onboarding surface can render them verbatim. Workflow identity is explicit and is never inferred
 * from arbitrary command text; the existing TUI/onboarding sequence and copy remain unchanged.
 * Codex routes via the OpenAI-compatible injection; Claude Code via `--provider anthropic` (Anthropic base
 * URL + Anthropic upstream → real provider-reported cache receipts). Cursor is deliberately absent: it has
 * no supported local-capture/base-url route (documented vendor gap) - it stays local-estimate/activity-only.
 */
export const ROUTE_COMMANDS = {
  codex: 'compaction gateway run --provider openai --workflow codex --subscription -- codex exec "<task>"',
  "claude-code": "compaction gateway run --provider anthropic --workflow claude-code -- claude"
} as const;

/**
 * Run `command` through the local Compaction Gateway. Shared by `gateway run` (the public gateway-native
 * form) and the hidden `dev` compatibility alias - `label` only changes the message prefix + usage hint.
 * Calls `process.exit(code)` with the child's exit code (so it is a terminal action).
 */
export async function runThroughGateway(
  command: string[],
  options: RunThroughGatewayOptions,
  label = "compaction gateway run"
): Promise<void> {
  const parts = command ?? [];
  if (parts.length === 0) {
    console.error(`error: no command given. Usage: ${label} -- <command>   (e.g. ${label} -- npm run dev)`);
    process.exitCode = 1;
    return;
  }
  const cwd = process.cwd();
  const provider = options.provider ?? "openai";
  const subscriptionTransport = options.subscription === true || options.internalClaudeSubscription === true;
  // Mode selection is WIRING only: `apply` here starts the SAME gated apply gateway as
  // `gateway start --mode apply` (identical gates/policy/receipts/recovery). Fail closed on every
  // impossible combination BEFORE anything starts - never silently downgrade to record.
  const mode: "record" | "apply" = options.mode === undefined || options.mode === "record" ? "record" : "apply";
  if (options.mode !== undefined && options.mode !== "record" && options.mode !== "apply") {
    console.error(
      `error: ${label} --mode '${options.mode}' is not supported (record | apply). ` +
        "Preview-only dry-run is available on 'compaction gateway start --mode dry-run'."
    );
    process.exitCode = 1;
    return;
  }
  if (options.policy !== undefined && options.policy !== DEDUPE_POLICY) {
    console.error(`error: --policy '${options.policy}' is not implemented (only ${DEDUPE_POLICY}).`);
    process.exitCode = 1;
    return;
  }
  if (mode === "apply" && options.policy !== DEDUPE_POLICY) {
    console.error(
      `error: --mode apply requires --policy ${DEDUPE_POLICY} (the only deterministic policy implemented). ` +
        "Apply is deterministic-only - no semantic compaction, no LCM."
    );
    process.exitCode = 1;
    return;
  }
  if (mode === "apply" && subscriptionTransport) {
    console.error(
      "error: --mode apply is not available with --subscription because the gateway-wide apply flag is not " +
        "transported by this capability route. Use record mode; stored Community authorization is evaluated " +
        "independently on eligible turns."
    );
    process.exitCode = 1;
    return;
  }
  if (subscriptionTransport) {
    if (provider !== "anthropic" && provider !== "openai") {
      console.error(
        "error: --subscription supports only OpenAI/Codex and Anthropic/Claude Code."
      );
      process.exitCode = 1;
      return;
    }
    const executable = path.basename(parts[0]).toLowerCase();
    const expected = provider === "openai" ? CODEX_EXECUTABLES : CLAUDE_EXECUTABLES;
    const workflowForProvider: RoutedWorkflowIdentity = provider === "openai" ? "codex" : "claude-code";
    if (!expected.has(executable)) {
      console.error(
        `error: --subscription with --provider ${provider} routes the ${workflowForProvider} binary only; ` +
          `'${parts[0]}' is not that binary.`
      );
      process.exitCode = 1;
      return;
    }
    const explicitWorkflow = options.workflow?.trim().toLowerCase();
    if (explicitWorkflow !== undefined && explicitWorkflow !== "" && explicitWorkflow !== "auto" && explicitWorkflow !== workflowForProvider) {
      console.error(
        `error: --subscription with --provider ${provider} requires workflow '${workflowForProvider}'; ` +
          `--workflow '${options.workflow}' is not compatible.`
      );
      process.exitCode = 1;
      return;
    }
  }
  // Resolve only the SOURCE of the workflow identity (explicit > auto-from-connect > none). Auto applies
  // ONLY when the connected workflow's own tool binary is being launched AND the provider route matches -
  // a generic command never inherits an identity, and every apply gate downstream is unchanged.
  // `--subscription` fixes the identity to the exact provider-supported tool validated above.
  let workflow: RoutedWorkflowIdentity | undefined;
  try {
    const resolution = resolveWorkflowForGatewayRun({
      provider,
      command: parts,
      ...(subscriptionTransport
        ? { explicit: provider === "openai" ? "codex" : "claude-code" }
        : options.workflow !== undefined
          ? { explicit: options.workflow }
          : {})
    });
    workflow = resolution.workflow;
    if (resolution.source === "auto-connected" && workflow) {
      console.error(`${label}: ${autoWorkflowNote(workflow)}`);
    }
    validateRoutedWorkflowProvider(workflow, provider);
  } catch (err) {
    console.error(`error: ${(err as Error).message}.`);
    process.exitCode = 1;
    return;
  }
  // Backstop rails (unreachable via the validated public path above, kept fail-closed on purpose).
  if (subscriptionTransport &&
      !((workflow === "claude-code" && provider === "anthropic") || (workflow === "codex" && provider === "openai"))) {
    console.error("error: the subscription route requires a matching OpenAI/Codex or Anthropic/Claude Code workflow.");
    process.exitCode = 1;
    return;
  }
  if (subscriptionTransport && options.upstream !== undefined) {
    console.error("error: the subscription route pins its provider upstream; --upstream is not accepted.");
    process.exitCode = 1;
    return;
  }
  // Provider-aware upstream default: when --provider anthropic and no explicit --upstream, point at
  // api.anthropic.com so the gateway selects the Anthropic adapter (real cache receipts). OpenAI unchanged.
  const upstream = options.upstream ?? defaultUpstreamFor(provider);
  try {
    normalizeEffectiveUpstream(upstream);
  } catch {
    console.error(`error: --upstream '${upstream}' is not a valid URL.`);
    process.exitCode = 1;
    return;
  }
  // TTY hardening (after all usage validation, before anything starts): interactive Claude Code cannot
  // run without a terminal on stdin - say so plainly instead of surfacing the vendor's opaque
  // --print/no-prompt error. A real terminal is unaffected.
  if (!process.stdin.isTTY && isBareInteractiveClaude(parts)) {
    console.error(
      "error: interactive Claude Code needs a terminal, but stdin is not a TTY here. " +
        `Run this in your shell, or pass -p "<prompt>" for a one-shot run:  ${label} [options] -- claude -p "<prompt>"`
    );
    process.exitCode = 1;
    return;
  }

  const sessionToken = process.env.COMPACTION_SESSION_PIN;
  const sessionPair = sessionToken ? resolveSessionPin(defaultManagedRoot(), sessionToken) : undefined;
  if (sessionToken && !sessionPair) {
    console.error("error: managed Gateway session pin is invalid or no longer active.");
    process.exitCode = 1;
    return;
  }
  // Generic/custom commands retain their route checks. Explicit workflow routes require an exact,
  // content-free identity match so stored authorization cannot silently widen across routes.
  const status = await getGatewayStatus(cwd);
  let base: string;
  let ownGateway: { close: () => Promise<void> } | null = null;
  const routeCapability = subscriptionTransport ? randomBytes(32).toString("base64url") : undefined;
  let reuse = !subscriptionTransport && status.running && !!status.base;
  if (reuse) {
    if (workflow) {
      // Reuse compatibility needs the private persisted upstream, but public GatewayStatus deliberately
      // omits it because URLs may contain userinfo or query credentials.
      const persisted = readGatewayPid(cwd);
      const sameProcess = persisted?.pid === status.pid;
      const sameWorkflow = persisted?.workflow === workflow;
      const sameProvider = persisted?.provider === provider;
      let persistedUpstream: string | undefined;
      try {
        persistedUpstream = typeof persisted?.upstream === "string" ? normalizeEffectiveUpstream(persisted.upstream) : undefined;
      } catch {
        persistedUpstream = undefined;
      }
      const sameUpstream = persistedUpstream === normalizeEffectiveUpstream(upstream);
      if (!sameProcess || !sameWorkflow || !sameProvider || !sameUpstream) {
        console.error(
          `error: the gateway already running at ${status.base} does not match the requested workflow/provider/upstream for '${workflow}'. ` +
            "Run 'compaction gateway stop' and retry; Compaction will start a correctly scoped gateway. " +
              "(That stops this project's gateway only - it never touches the transparent-routing endpoint a " +
              "connected Claude Code session is using.)"
        );
        process.exitCode = 1;
        return;
      }
    }
    // `--mode apply` never silently reuses a gateway in a different mode: apply must actually be on.
    if (mode === "apply" && status.mode !== "apply") {
      console.error(
        `error: --mode apply was requested, but the gateway already running at ${status.base} is in '${status.mode ?? "unknown"}' mode. ` +
          "Run 'compaction gateway stop' and retry (Compaction will start an apply-mode gateway), or drop --mode apply to use it as-is. " +
            "(That stops this project's gateway only - it never touches the transparent-routing endpoint a connected Claude Code session is using.)"
      );
      process.exitCode = 1;
      return;
    }
    if (!gatewayReleaseMatches(status.releaseIdentity, sessionPair?.id)) {
      const persisted = readGatewayPid(cwd);
      const identity = persisted && persisted.pid === status.pid ? await queryGatewayIdentity(persisted) : undefined;
      if (!identity || !gatewayQuiescent(identity)) {
        console.error("error: running Gateway release is unverified or has active/unsettled work; replacement deferred.");
        process.exitCode = 1;
        return;
      }
      if (!(await queryGatewayIdentity(persisted!, true))?.draining) {
        console.error("error: running Gateway could not safely drain; replacement deferred.");
        process.exitCode = 1;
        return;
      }
      reuse = false;
    }
  }
  if (reuse) {
    base = status.base!;
    console.error(`${label}: reusing the running gateway at ${base}${mode === "apply" ? " (apply mode, as requested)" : ""}`);
    // Honest note: a default (record) run that reuses a gateway the user explicitly started in a mutating
    // mode says so plainly (it does not silently change that mode).
    if (mode === "record" && status.mode && status.mode !== "record") {
      console.error(`${label}: note - the reused gateway is running in '${status.mode}' mode (you started it explicitly); this is not changing that.`);
    }
  } else {
    const port = options.listen ? parseListen(options.listen).port : 0; // 0 → ephemeral (no port conflicts)
    try {
      const g = await runGatewayStart({
        provider,
        upstream,
        mode,
        ...(mode === "apply" && options.policy ? { policy: options.policy } : {}),
        ...(workflow ? { workflow } : {}),
        host: "127.0.0.1",
        port,
        cwd,
        installSignals: false,
        persistLifecycle: false,
        ...(routeCapability && provider === "anthropic" ? { claudeSubscription: { capability: routeCapability } } : {}),
        ...(routeCapability && provider === "openai" ? { codexSubscription: { capability: routeCapability } } : {}),
        log: () => {}
      });
      base = g.base;
      ownGateway = g;
      console.error(
        mode === "apply"
          ? `${label}: started a local gateway at ${base} (APPLY mode - EXPERIMENTAL; policy ${options.policy}; deterministic, known-safe shapes only; ` +
              `unknown shapes fail closed; originals retained - 'compaction gateway recover <id>'; content-free receipts${workflow ? `; workflow ${workflow}` : ""})`
          : subscriptionTransport
            ? `${label}: started a local gateway at ${base} (subscription transport; credential and response-stream transit is byte-safe; ` +
              `stored Community authorization may evaluate and apply input optimization; content-free receipts${workflow ? `; workflow ${workflow}` : ""})`
          : `${label}: started a local gateway at ${base} (record mode; byte-safe; content-free receipts${workflow ? `; workflow ${workflow}` : ""})`
      );
    } catch (err) {
      if (subscriptionTransport) {
        const toolName = provider === "anthropic" ? "Claude Code" : "Codex";
        console.error(
          `${label}: local subscription route could not start; running the original ${toolName} command unchanged - ${(err as Error).message}`
        );
        const fallbackCode = await runChildCommand(parts, process.env, cwd, label);
        process.exit(fallbackCode);
        return;
      }
      console.error(`error: could not start a local gateway - ${(err as Error).message}`);
      process.exitCode = 1;
      return;
    }
  }

  const childBase = routeCapability
    ? provider === "openai"
      ? `${base}/__compaction/codex/${routeCapability}/backend-api/codex`
      : `${base}/__compaction/claude/${routeCapability}`
    : base;
  const injected = subscriptionTransport && provider === "openai" ? {} : injectionEnv(childBase, provider);
  const childEnv = { ...process.env, ...injected };
  if (subscriptionTransport) {
    console.error(
      `${label}: routing ${workflow === "codex" ? "Codex" : "Claude Code"} through an ephemeral local subscription route under your saved login ` +
        "(credential-free: your login credential rides through untouched - never read, stored, or logged; " +
        "credential and response-stream transit is byte-safe; stored Community authorization may evaluate and apply input optimization; " +
        `pinned to ${provider === "openai" ? "chatgpt.com" : "api.anthropic.com"}; fail-open)`
    );
  } else {
    const routeLine = Object.entries(injected)
      .map(([k, v]) => `${k}=${v}`)
      .join("  ");
    console.error(`${label}: routing → ${routeLine}  (your provider key stays on the child; the gateway never stores it)`);
  }
  if (!subscriptionTransport && !hasProviderKey(process.env, provider)) {
    console.error(`${label}: Gateway is ready, but the child process still needs its provider API key (e.g. ${providerKeyEnvName(provider)}). Compaction never injects or stores keys.`);
  }

  // Snapshot receipts so we can report ONLY the traffic observed during this run (content-free).
  const before = new Set(readReceipts(cwd).map((r) => r.receipt_id));

  const routedParts = routedCommand(parts, childBase, workflow, subscriptionTransport);
  let code = 127;
  try {
    code = await runChildCommand(routedParts, childEnv, cwd, label);
  } finally {
    if (ownGateway) {
      try {
        await ownGateway.close();
      } catch {
        /* best-effort */
      }
    }
  }

  // Content-free traffic summary: only the receipts recorded during this run.
  const observed: GatewayReceipt[] = readReceipts(cwd).filter((r) => !before.has(r.receipt_id));
  console.error("");
  if (observed.length > 0) {
    const summary = summarizeCacheProof(observed);
    console.error(`${label}: ✓ traffic observed through Compaction - ${observed.length} request(s) this run.`);
    console.error(`  best provider-backed fresh/billed input reduction:  ${formatFreshBilledInputReduction(summary.bestReduction)}`);
    console.error("  run 'compaction gateway status' for the full content-free rollup.");
  } else {
    console.error(`${label}: ○ no requests were observed through Compaction this run.`);
    console.error("  If your app has its own OpenAI base URL configured, it may have bypassed OPENAI_BASE_URL.");
    console.error("  Point your client at the injected base URL, or use 'compaction gateway configure' to set it.");
  }

  process.exit(code);
}

function runChildCommand(parts: string[], env: NodeJS.ProcessEnv, cwd: string, label: string): Promise<number> {
  const child = spawn(parts[0], parts.slice(1), { stdio: "inherit", env, cwd });
  return new Promise((resolve) => {
    child.on("exit", (code, signal) => resolve(typeof code === "number" ? code : signal ? 1 : 0));
    child.on("error", (err) => {
      console.error(`${label}: failed to run '${parts[0]}' - ${(err as Error).message}`);
      resolve(127);
    });
  });
}

/**
 * Register the hidden `dev` compatibility alias. The PUBLIC gateway-native form is `gateway run`
 * (registered in gateway.ts); `dev` is kept for backward compatibility and hidden from top-level help.
 */
export function registerDevCommand(program: Command): void {
  program
    .command("dev")
    .description(
      "Compatibility alias for 'compaction gateway run -- <command>'. Runs a command with its OpenAI base " +
        "URL pointed at the local Compaction Gateway (starts/reuses the gateway, injects the endpoint - never " +
        "a key, streams output unchanged, preserves the exit code, prints a content-free traffic summary)."
    )
    .option("--provider <name>", "Provider to route: openai (default, OpenAI-compatible) | anthropic (Claude Code). Any other id uses OpenAI-compatible injection.", "openai")
    .option("--upstream <url>", "Upstream provider base URL (default: the provider's public API - OpenAI, or Anthropic when --provider anthropic).")
    .option("--listen <url>", "Local listen address when starting a gateway (default: an ephemeral local port).")
    .option("--workflow <tool>", "Routed workflow identity: codex | claude-code | auto | none. Omitted (or `auto`): defaults ONLY when the launched command is the connected workflow's own tool binary on its matching provider route; `none` disables; an explicit tool always wins.")
    .option(
      "--subscription",
      "EXPLICIT saved-login route for OpenAI/Codex or Anthropic/Claude Code - same flag as 'gateway run --subscription'."
    )
    .argument("[command...]", "The command to run through the gateway (after --), e.g. -- npm run dev")
    .allowUnknownOption(true)
    .action(async (command: string[], options: RunThroughGatewayOptions) => {
      await runThroughGateway(command, options, "compaction dev");
    });
}
