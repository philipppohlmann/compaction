/**
 * TRANSPARENT APPLY-ROUTING ACTIVATION (PUBLIC CLI/SDK core, engine-free, content-free).
 *
 * The versioned, fail-closed guard that decides whether the transparent Claude Code routing gateway
 * (`compaction gateway ensure`, called by the `claude` PATH shim before every normal `claude` run) is
 * spawned WORKFLOW-SCOPED so the server's existing stored-authorization path may upgrade eligible
 * requests to deterministic APPLY - versus the default plain `--workflow none --mode record` gateway,
 * which is structurally byte-safe and can never mutate a request.
 *
 * This governs a BEFORE-CALL REQUEST mutation on the user's real Claude Code traffic, so it is
 * DEFAULT OFF and dormant unless EVERY one of these independent conditions holds (the DORMANT GUARD):
 *
 *   0. BUILD CAPABLE    - this build actually contains the deterministic input compactor. A public
 *                          build excludes it, so apply could never change a byte no matter what the
 *                          user opted into; engaging would make every downstream surface overclaim.
 *   1. API KEY present   - `ANTHROPIC_API_KEY` is set (presence only; the VALUE is never read).
 *                          Subscription/saved-login traffic has no API key here, so this condition
 *                          structurally keeps subscription on the output-shaping-only path: gateway
 *                          apply NEVER engages for a subscription (there is no `--subscription` route
 *                          through `ensure`, and no key means this guard stays dormant regardless).
 *   2. INPUT OPT chosen  - the persisted onboarding mode is `cache-plus-context` (the explicit
 *                          input-optimization choice). Plain `cache` keeps model-visible bytes unchanged.
 *   3. STORED AUTH       - an enabled, narrow-scoped `auto-when-gates-pass` deterministic-dedupe
 *                          authorization for the `claude-code` workflow exists in the local policy store.
 *   4. EXPLICIT INIT     - `claude-code` is in the persisted connect-once `connected_workflows` set,
 *                          which is written ONLY by an explicit `compaction init --connect` (never by a
 *                          transparent per-run shim, never off an unrelated flag).
 *   5. NOT STOPPED       - the user has not run `compaction stop` (the unified on/off switch also
 *                          disables apply routing; a stopped session routes record-only, no mutation).
 *
 * ANY condition false, or ANY error while evaluating them, resolves to `route-record` (the default,
 * unchanged, byte-safe `--workflow none` gateway). This resolver NEVER throws and NEVER blocks: it is
 * consulted on the fail-open ensure path, so on any doubt the tool runs through a plain record gateway
 * (and, if even that fails, the shim runs `claude` entirely unrouted). The resolver decides only WHICH
 * gateway shape to ensure; the server's own fail-closed eligibility gates + original-retention still run
 * per request before any byte is mutated, and the response is always forwarded byte-for-byte.
 *
 * VERSIONED ACTIVATION: the posture carries an explicit version label (mirrors
 * `output-shaping-hook-activation.ts` / `subscription-shaping-state.ts`) so the active apply-routing
 * posture is auditable and can never silently widen. Bump ONLY with an intentional posture change.
 */
import { DEDUPE_POLICY } from "./request-shape.js";
import { isInputCompactionAvailable } from "./input-compaction-seam.js";
import { findStoredAuthorization } from "./apply-eligibility.js";
import { readOptimizationMode, readConnectedWorkflows } from "../onboarding-preferences.js";
import { isShapingStopped } from "../subscription-shaping-state.js";

/**
 * The apply-routing activation version label. Records WHICH activation posture is live so an auditor can
 * tell exactly what gate a build enforces. Bump only with an intentional posture change.
 */
export const APPLY_ROUTING_ACTIVATION_VERSION = "apply-routing-keyed-inputopt-capable-2026-08-17" as const;

/** The single workflow this slice may route under apply. Anthropic/Claude Code only; never global. */
export const APPLY_ROUTING_WORKFLOW = "claude-code" as const;

/** The provider whose transparent routing this guard governs. */
export const APPLY_ROUTING_PROVIDER = "anthropic" as const;

/**
 * The decision. `route-record` = the default, unchanged, byte-safe `--workflow none` record gateway
 * (no mutation possible). `route-apply-workflow` = spawn/reuse a `--workflow claude-code` record gateway
 * so the server's stored-authorization path may upgrade eligible POSTs to deterministic apply (still
 * fail-closed + original-retained per request). Every not-engaged decision carries an honest reason.
 */
export type ApplyRoutingDecision =
  | { engage: false; reason: string; version: typeof APPLY_ROUTING_ACTIVATION_VERSION }
  | { engage: true; workflow: typeof APPLY_ROUTING_WORKFLOW; version: typeof APPLY_ROUTING_ACTIVATION_VERSION };

function dormant(reason: string): ApplyRoutingDecision {
  return { engage: false, reason, version: APPLY_ROUTING_ACTIVATION_VERSION };
}

export interface ResolveApplyRoutingParams {
  /** The provider the shim asked ensure to route (only `anthropic` may ever engage apply routing). */
  provider: string;
  /** Working directory whose local policy store is consulted for the stored authorization. */
  cwd: string;
  /** Environment (presence of `ANTHROPIC_API_KEY` only; the value is never read). Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

/** True only when `ANTHROPIC_API_KEY` is present + non-empty. The value itself is never read. */
function anthropicKeyPresent(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.ANTHROPIC_API_KEY && env.ANTHROPIC_API_KEY.trim() !== "");
}

/**
 * Resolve whether the transparent Claude Code routing gateway should engage the workflow-scoped apply
 * path for THIS ensure. Fail-closed to `route-record` on any missing condition or any error. Never
 * throws. Consulted by `ensureGateway` (via the `gateway ensure` CLI action) on the fail-open shim path.
 *
 * The five dormant-guard conditions are evaluated in cheap-to-costly order; the FIRST that fails
 * short-circuits to a dormant decision with an honest reason (a real gateway is still ensured - record).
 */
export async function resolveApplyRoutingActivation(
  params: ResolveApplyRoutingParams
): Promise<ApplyRoutingDecision> {
  try {
    const env = params.env ?? process.env;

    // Provider gate: only the Anthropic/Claude Code route may ever engage apply routing.
    if (params.provider !== APPLY_ROUTING_PROVIDER) {
      return dormant(`provider '${params.provider}' is not the apply-routing provider '${APPLY_ROUTING_PROVIDER}'`);
    }

    // 0. BUILD CAPABILITY - this build must actually CONTAIN the deterministic input compactor.
    //    The other five guards are all about whether the user opted in; this one is about whether the
    //    binary can do the thing at all. A public build excludes `apply-policy.ts` by the open-core
    //    boundary, so every request fails closed and is forwarded unchanged — correct behaviour, but
    //    without this guard the resolver still answered `engage: true`, and `compaction init` therefore
    //    told the user "Apply mode is ON ... the original is retained locally and recoverable" on a
    //    binary that can never retain one. Guarding here rather than in the copy
    //    fixes every surface that reads this resolver at once, and can only ever NARROW activation.
    if (!(await isInputCompactionAvailable())) {
      return dormant("this build has no deterministic input compactor - apply cannot change model-visible input; record-only");
    }

    // 5. NOT STOPPED - the unified `compaction stop` disables apply routing too (record-only, no mutation).
    if (isShapingStopped(env as Record<string, string | undefined>)) {
      return dormant("compaction is stopped (`compaction stop`) - apply routing is disabled; record-only");
    }

    // 1. API KEY present (presence only; never read). No key ⇒ dormant. This structurally keeps a
    //    subscription/saved-login session on the output-shaping-only path (no gateway apply).
    if (!anthropicKeyPresent(env)) {
      return dormant("no ANTHROPIC_API_KEY present - apply routing needs the API-key path (subscription stays output-shaping-only)");
    }

    // 2. INPUT OPT chosen - the explicit Cache + context optimization mode. Plain `cache` ⇒ dormant.
    if (readOptimizationMode(env) !== "cache-plus-context") {
      return dormant("optimization mode is not 'cache-plus-context' - input optimization was not selected; record-only");
    }

    // 4. EXPLICIT INIT - `claude-code` connected via `compaction init --connect` (persisted enum-only).
    if (!readConnectedWorkflows(env).includes(APPLY_ROUTING_WORKFLOW)) {
      return dormant("claude-code is not a connected workflow (`compaction init --connect 1`) - record-only");
    }

    // 3. STORED AUTH - an enabled, narrow-scoped auto-apply authorization for claude-code must exist.
    const authorization = await findStoredAuthorization({
      scope: { tool: APPLY_ROUTING_WORKFLOW },
      cwd: params.cwd
    });
    if (!authorization) {
      return dormant("no stored auto-apply authorization for claude-code - record-only (authorize with `compaction init --authorize-auto-apply claude-code`)");
    }
    if (authorization.scope.policy_type !== DEDUPE_POLICY) {
      return dormant(`stored authorization policy '${authorization.scope.policy_type}' is not the deterministic policy '${DEDUPE_POLICY}' - record-only`);
    }

    // Every condition holds: engage the workflow-scoped record gateway. The server's fail-closed
    // eligibility gates + original-retention still run per request before any mutation; the response
    // is always forwarded byte-for-byte.
    return { engage: true, workflow: APPLY_ROUTING_WORKFLOW, version: APPLY_ROUTING_ACTIVATION_VERSION };
  } catch (error) {
    // FAIL-CLOSED (and fail-open for the workflow): any error resolving the guard means the default
    // byte-safe record gateway is ensured; apply routing never engages off a broken read.
    return dormant(`apply-routing guard could not be evaluated (${(error as Error).message}) - record-only (fail-closed)`);
  }
}
