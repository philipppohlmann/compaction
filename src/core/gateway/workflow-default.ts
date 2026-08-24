/**
 * Workflow auto-wiring for `gateway start` / `gateway run` (PUBLIC CLI core, engine-free).
 *
 * Resolves the source of the `--workflow` identity when the flag is omitted (or given as `auto`), from
 * the connect-once choice persisted by `compaction init` (`~/.compaction/preferences.json`,
 * `connected_workflows`, enum-only, content-free). This changes only where the value comes from:
 * the stored-authorization lookup, the eligibility gates, and every apply safety rail downstream are
 * untouched and still evaluate the same narrow tool identity per request.
 *
 * Fail-safe rules (never guess a scope):
 *  - An explicit `--workflow codex|claude-code` always wins. `--workflow none` disables any default.
 *  - Auto resolution is deterministic and provider-matched: each provider has exactly one routable
 *    workflow (openai → codex, anthropic → claude-code), so there is never an ambiguous pick.
 *  - The provider-matched workflow is used only if it was persisted at connect time; otherwise the
 *    gateway runs with no workflow identity (record semantics, stored authorizations are never consulted).
 *  - `gateway run` additionally requires the launched executable to BE that workflow's tool binary
 *    (`codex` / `claude`); a generic app never inherits a workflow identity.
 */
import path from "node:path";
import { readConnectedWorkflows, type ConnectedRoutableWorkflow } from "../onboarding-preferences.js";
import type { EnvLike } from "../api-client/config.js";

/** How the effective workflow identity was chosen (surfaced honestly in CLI output). */
export type WorkflowResolutionSource = "explicit" | "auto-connected" | "disabled" | "unset";

export interface ResolvedWorkflow {
  workflow?: ConnectedRoutableWorkflow;
  source: WorkflowResolutionSource;
}

/** The single routable workflow established for a provider route (deterministic; never ambiguous). */
export function workflowForProvider(provider: string): ConnectedRoutableWorkflow | undefined {
  if (provider === "openai") return "codex";
  if (provider === "anthropic") return "claude-code";
  return undefined;
}

/** The provider a routable workflow's traffic targets (the inverse of `workflowForProvider`). */
export function providerForWorkflow(workflow: string): string | undefined {
  if (workflow === "codex") return "openai";
  if (workflow === "claude-code") return "anthropic";
  return undefined;
}

/** How the effective upstream provider was chosen (surfaced honestly in CLI output). */
export type ProviderResolutionSource = "explicit" | "workflow" | "connected" | "fallback";

export interface ResolvedProvider {
  provider: string;
  source: ProviderResolutionSource;
  /** The workflow that drove a `workflow`/`connected` inference (for the honest CLI note). */
  workflow?: ConnectedRoutableWorkflow;
}

/**
 * Resolve the upstream provider for `gateway start` when `--provider` is omitted. Deterministic,
 * never a guess:
 *  - an explicit `--provider` always wins;
 *  - `--workflow claude-code|codex` implies its one provider (anthropic|openai), a Claude Code
 *    gateway must never silently point at the OpenAI upstream;
 *  - otherwise, EXACTLY ONE connected routable workflow (`compaction init`) implies its provider;
 *    zero or several connected workflows are ambiguous and fall through;
 *  - last resort: `openai` (the historical default, unchanged when nothing indicates otherwise).
 */
export function resolveProviderForGatewayStart(input: {
  explicitProvider?: string;
  explicitWorkflow?: string;
  env?: EnvLike;
}): ResolvedProvider {
  const explicitProvider = input.explicitProvider?.trim();
  if (explicitProvider !== undefined && explicitProvider !== "") {
    return { provider: explicitProvider, source: "explicit" };
  }
  const workflow = normalizeExplicit(input.explicitWorkflow);
  if (workflow === "codex" || workflow === "claude-code") {
    return { provider: providerForWorkflow(workflow)!, source: "workflow", workflow };
  }
  const connected = readConnectedWorkflows(input.env ?? process.env);
  if (connected.length === 1) {
    return { provider: providerForWorkflow(connected[0])!, source: "connected", workflow: connected[0] };
  }
  return { provider: "openai", source: "fallback" };
}

/** The honest one-line note printed when the provider was inferred (never printed for explicit/fallback). */
export function providerInferenceNote(resolved: ResolvedProvider): string {
  if (resolved.source === "connected") {
    return (
      `provider '${resolved.provider}' selected from your connected '${resolved.workflow}' workflow ` +
      `(compaction init; ~/.compaction/preferences.json). Explicit --provider overrides.`
    );
  }
  return `provider '${resolved.provider}' selected for --workflow ${resolved.workflow}. Explicit --provider overrides.`;
}

/** The tool binaries whose launch may carry the matching workflow identity on `gateway run`. */
const WORKFLOW_EXECUTABLES: Record<ConnectedRoutableWorkflow, readonly string[]> = {
  codex: ["codex", "codex.exe"],
  "claude-code": ["claude", "claude.exe"]
};

function normalizeExplicit(explicit: string | undefined): string | undefined {
  const v = explicit?.trim().toLowerCase();
  return v === "" ? undefined : v;
}

/**
 * Resolve the workflow identity for `gateway start`. Throws on an unknown explicit value (the caller
 * reports it as a clean flag error).
 */
export function resolveWorkflowForGatewayStart(input: {
  explicit?: string;
  provider: string;
  env?: EnvLike;
}): ResolvedWorkflow {
  const explicit = normalizeExplicit(input.explicit);
  if (explicit === "none") return { source: "disabled" };
  if (explicit === "codex" || explicit === "claude-code") return { workflow: explicit, source: "explicit" };
  if (explicit !== undefined && explicit !== "auto") {
    throw new Error(`--workflow '${input.explicit}' is not implemented (codex | claude-code | auto | none)`);
  }
  const candidate = workflowForProvider(input.provider);
  if (candidate === undefined) return { source: "unset" };
  const connected = readConnectedWorkflows(input.env ?? process.env);
  return connected.includes(candidate) ? { workflow: candidate, source: "auto-connected" } : { source: "unset" };
}

/**
 * Resolve the workflow identity for `gateway run` / `dev`. Same rules as `gateway start`, plus the
 * executable gate: the auto default applies only when the launched command is that workflow's own tool
 * binary, otherwise it fails safe to no workflow (record; no stored authorization is ever consulted).
 */
export function resolveWorkflowForGatewayRun(input: {
  explicit?: string;
  provider: string;
  command: readonly string[];
  env?: EnvLike;
}): ResolvedWorkflow {
  const resolved = resolveWorkflowForGatewayStart(input);
  if (resolved.source !== "auto-connected" || resolved.workflow === undefined) return resolved;
  const executable = input.command.length > 0 ? path.basename(input.command[0]).toLowerCase() : "";
  if (!WORKFLOW_EXECUTABLES[resolved.workflow].includes(executable)) return { source: "unset" };
  return resolved;
}

/** The honest one-line note printed when a workflow identity was auto-selected (shared copy). */
export function autoWorkflowNote(workflow: ConnectedRoutableWorkflow): string {
  return (
    `workflow '${workflow}' selected automatically from your connected setup ` +
    `(compaction init; ~/.compaction/preferences.json). Explicit --workflow <tool> overrides; --workflow none disables.`
  );
}
