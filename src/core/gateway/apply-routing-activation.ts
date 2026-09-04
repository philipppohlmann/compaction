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
 *   0. ENGINE CAPABLE   - an adaptive engine actually RESOLVES on this device (verified install, an
 *                          explicit override, or a dev build). The live apply path is the engine IPC
 *                          seam, so with no runnable engine apply could never change a byte no matter
 *                          what the user opted into; engaging would make every downstream surface
 *                          overclaim. Asked via the shared `fullOptimizationReachable` predicate.
 *   1. CREDENTIALED     - the run has a credential that entitles gateway apply, which is EITHER
 *                          `ANTHROPIC_API_KEY` set (presence only; the VALUE is never read) OR a
 *                          verified Community-or-better entitlement lease on this device. The lease
 *                          arm reads the SAME local, signed, device-bound lease `server.ts` already
 *                          verifies (`readLeaseVerdict`): signature against the pinned root, device
 *                          binding, current period, not expired. It is synchronous and local-disk
 *                          only - no per-run network call, no new auth mechanism. Entitlement ONLY:
 *                          a spent metered balance still satisfies this condition, because the
 *                          allowance is a per-request CEILING enforced by the server, not an
 *                          activation switch (an exhausted period must still route through the same
 *                          gateway so the user sees the ceiling instead of silently losing apply).
 *                          With neither credential the guard stays dormant and a subscription that
 *                          never activated remains on the output-shaping-only path.
 *   2. INPUT OPT chosen  - the persisted onboarding mode is `cache-plus-context` (the explicit
 *                          input-optimization choice). Plain `cache` keeps model-visible bytes unchanged.
 *   3. STORED AUTH       - an enabled, narrow-scoped `auto-when-gates-pass` deterministic-dedupe
 *                          authorization for the `claude-code` workflow exists in the DEVICE policy store
 *                          (`~/.compaction`, `COMPACTION_CONFIG_DIR`-overridable) - the ONLY store this
 *                          guard reads. Scope is the record's own (`tool`, `policy_type`, and `repo`
 *                          when pinned), never the directory the shim happened to launch from, and no
 *                          file under a working directory can create or broaden it.
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
import { fullOptimizationReachable } from "../engine-availability.js";
import { findStoredAuthorization } from "./apply-eligibility.js";
import { readOptimizationMode, readConnectedWorkflows } from "../onboarding-preferences.js";
import { isShapingStopped } from "../subscription-shaping-state.js";
import { readLeaseVerdict } from "../entitlement/lease-store.js";

/**
 * The apply-routing activation version label. Records WHICH activation posture is live so an auditor can
 * tell exactly what gate a build enforces. Bump only with an intentional posture change.
 */
export const APPLY_ROUTING_ACTIVATION_VERSION = "apply-routing-entitled-inputopt-engine-2026-08-31" as const;

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
  /**
   * The working directory this ensure runs for. It does NOT participate in the authorization decision
   * (that is device-scoped); it is retained because callers identify the run by it and a future
   * condition may legitimately need it. Nothing under it can grant apply.
   */
  cwd: string;
  /** Environment: presence of `ANTHROPIC_API_KEY` (never its value) + the config dir the lease is read from. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

/** True only when `ANTHROPIC_API_KEY` is present + non-empty. The value itself is never read. */
function anthropicKeyPresent(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.ANTHROPIC_API_KEY && env.ANTHROPIC_API_KEY.trim() !== "");
}

/**
 * The lease arm of condition 1: the verdict of the SAME local signed lease the gateway server verifies
 * per request (`readLeaseVerdict`, `server.ts`). Synchronous, local-disk only, no network. Returns the
 * verdict label rather than a boolean so a dormant decision can name WHY (absent / wrong device / wrong
 * period / expired) instead of collapsing four distinct states into "no lease".
 *
 * Entitlement only, deliberately: `lease-valid` is answered even when the metered balance is spent,
 * mirroring `hasValidFullApplyLease`. A spent allowance is a per-request ceiling the server enforces,
 * not an activation switch - dropping to a record-only gateway on exhaustion would hide the ceiling.
 */
function leaseVerdictLabel(env: NodeJS.ProcessEnv): string {
  return readLeaseVerdict(env).label;
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

    // 0. RUNTIME CAPABILITY - an adaptive engine must actually RESOLVE on this device, because the
    //    live apply path is the engine IPC seam (`engine-ipc/engine-apply-seam.ts` ->
    //    `src/engine/native/apply-pipeline.ts`). The other five guards ask whether the user opted in;
    //    this one asks whether anything can do the work at all, and can only ever NARROW activation.
    //
    //    THIS GUARD USED TO PROBE `isInputCompactionAvailable()` - the presence of
    //    `dist/core/gateway/apply-policy.js`. The published package excludes that module BY NAME
    //    (`package.json` files: `!dist/core/gateway/apply-policy.*`), so on every npm install the probe
    //    answered false, `gateway ensure` spawned `--workflow none`, and plain `claude` was permanently
    //    record-only - with a valid lease, `mode full`, remaining allowance and a verified engine all
    //    in place. It tested a module the open-core boundary deliberately removes instead of the
    //    capability the runtime actually uses. Ask the SAME question every other full-optimization
    //    surface asks (`compaction init`, `compaction mode`, `compaction lease` all call this), so
    //    routing and user-facing copy cannot diverge again. Do not reintroduce a packaged-module probe
    //    here: the public package is defined by what it EXCLUDES, so module presence can never stand in
    //    for runtime capability.
    //
    //    Still fail-closed, and deliberately `"present"`-only: an `"installable"` build (trust root
    //    pinned, no engine fetched yet) and an installed-but-UNVERIFIED artifact BOTH stay dormant, so
    //    the guard keeps failing honestly whenever apply is not genuinely runnable.
    if (!(await fullOptimizationReachable(env))) {
      return dormant("no adaptive engine resolves on this device (absent, not installed, or failed verify-before-run) - apply cannot change model-visible input; record-only");
    }

    // 5. NOT STOPPED - the unified `compaction stop` disables apply routing too (record-only, no mutation).
    if (isShapingStopped(env as Record<string, string | undefined>)) {
      return dormant("compaction is stopped (`compaction stop`) - apply routing is disabled; record-only");
    }

    // 1. CREDENTIALED - an API key (presence only; never read) OR a verified entitlement lease.
    //    Either credential entitles the workflow-scoped gateway; NEITHER ⇒ dormant. The lease arm is
    //    what lets a normal `claude` run on an ACTIVATED Community device reach the same apply path as
    //    the explicit `gateway run` command: activation is proven by a signed, device-bound lease this
    //    machine already holds, not by an environment variable a subscription user never sets.
    if (!anthropicKeyPresent(env)) {
      const leaseLabel = leaseVerdictLabel(env);
      if (leaseLabel !== "lease-valid") {
        return dormant(`no ANTHROPIC_API_KEY and no verified entitlement lease (${leaseLabel}) - apply routing needs one of the two; record-only`);
      }
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
    // DEVICE-scoped, and only device-scoped: the same opt-in is seen from `$HOME`, from an arbitrary
    // repo and from a nested subdirectory, while nothing under the working directory can supply one.
    // `params.cwd` is deliberately NOT passed — a checked-out `.compaction/policy-preferences.json`
    // must never be able to arm mutation on a device whose owner never authorized it.
    const authorization = await findStoredAuthorization({ scope: { tool: APPLY_ROUTING_WORKFLOW }, env });
    if (!authorization) {
      return dormant("no stored auto-apply authorization for claude-code on this device - record-only (authorize with `compaction init --authorize-auto-apply claude-code`)");
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
