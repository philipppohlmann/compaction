/**
 * Compaction Gateway APPLY activation resolver (PUBLIC CLI/SDK core, engine-free).
 *
 * Apply mode is OPT-IN and EXPLICIT. It activates only through explicit user intent, the gateway's
 * `--mode apply --policy deterministic-dedupe` OR the per-request headers `x-compaction-mode: apply` +
 * `x-compaction-policy: deterministic-dedupe`. When the server's configured intent and the request
 * headers CONFLICT, this resolver FAILS CLOSED (falls back to record, records the reason). Default is
 * always record (byte-safe, no mutation).
 */
import { DEDUPE_POLICY, type ApplyPolicyName } from "./request-shape.js";
import type { LcmApplyPolicyName } from "./lcm-apply-policy-name.js";
// TYPE-ONLY, so nothing is imported at runtime and the value-level dependency stays one-way
// (`apply-receipt` -> `apply-activation`). The Open-basic output policy is a policy this activation
// can legitimately name: the gateway's shaping-only degradation applies exactly that public plan, and
// the receipt's `policy` has to match the recovery record written for the same turn.
import type { OPEN_BASIC_OUTPUT_POLICY } from "./apply-receipt.js";

export type GatewayEffectiveMode = "record" | "apply" | "dry-run";

export interface ApplyActivation {
  /** The mode the server will actually execute. Forced to "record" whenever we fail closed. */
  mode: GatewayEffectiveMode;
  /** True when apply OR dry-run was requested (by server config or header), even if we fail closed. */
  requested: boolean;
  /**
   * The resolved policy. `resolveApplyActivation` (explicit per-call intent) only ever produces
   * `deterministic-dedupe`; the LCM policy name exists ONLY for the stored-authorization boundary
   * path (`lcm-apply-boundary.ts`). The invariant here is about REQUESTABILITY, not reachability:
   * the LCM policy can never be selected via `--policy` or a header (unknown values fail closed to
   * record), whatever qualifies a class on that path. `open-basic-output-apply` is here for the same
   * reason: the gateway's shaping-only degradation (Community at its input ceiling) applies the public
   * Open-basic plan, so that is the policy its receipt and its recovery record both have to name.
   */
  policy?: ApplyPolicyName | LcmApplyPolicyName | typeof OPEN_BASIC_OUTPUT_POLICY;
  /**
   * Content-free label for the receipt's approval_status / activation source. `stored-authorization`
   * is never produced by `resolveApplyActivation` (which resolves only EXPLICIT per-call intent) -
   * it is constructed by the gateway's stored-authorization path when a persisted, enabled,
   * narrow-scoped `auto-when-gates-pass` preference passes every eligibility gate.
   */
  activation:
    | "record"
    | "explicit-mode"
    | "explicit-header"
    | "dry-run-mode"
    | "dry-run-header"
    | "stored-authorization"
    /**
     * Open `basic` output shaping at the gateway.
     * Like `stored-authorization` this is never produced by `resolveApplyActivation` — it is
     * constructed by the gateway's Open-basic path when the user's persisted `product_mode` is
     * `basic`, shaping is not switched off, and the body is not already shaped. The governing
     * "authorization" is the mode preference itself, so there is no `authorization_id`.
     */
    | "open-basic-mode"
    | "fail-closed";
  /** Set when apply/dry-run was requested but we fell back to record (conflict / unknown policy). */
  failClosedReason?: string;
}

/** Normalize a mode string to a known effective mode, or undefined when unset/unknown. */
function normalizeMode(v: string | undefined): GatewayEffectiveMode | "unknown" | undefined {
  if (v === undefined) return undefined;
  const s = v.trim().toLowerCase();
  if (s === "") return undefined;
  if (s === "record" || s === "apply" || s === "dry-run") return s;
  return "unknown";
}

/** A mutating intent is apply or dry-run; record is the non-mutating default. */
function isMutating(m: GatewayEffectiveMode | "unknown" | undefined): m is "apply" | "dry-run" {
  return m === "apply" || m === "dry-run";
}

function record(): ApplyActivation {
  return { mode: "record", requested: false, activation: "record" };
}

function failClosed(reason: string): ApplyActivation {
  return { mode: "record", requested: true, activation: "fail-closed", failClosedReason: reason };
}

/**
 * Resolve the effective apply activation from the server config + request headers. PURE.
 *
 * Precedence + conflict rules (fail closed on any disagreement):
 *  - Default server mode `record` carries no mutating intent → a header alone may activate apply/dry-run.
 *  - If BOTH the server AND a header express a mutating intent and they DIFFER (mode or policy) → conflict.
 *  - An explicit header `record` is an opt-OUT → record (never a conflict).
 *  - Apply/dry-run requires the known policy `deterministic-dedupe`; anything else fails closed.
 *  - An unknown mode value fails closed.
 */
export function resolveApplyActivation(params: {
  serverMode: string;
  serverPolicy?: string;
  headerMode?: string;
  headerPolicy?: string;
}): ApplyActivation {
  const serverMode = normalizeMode(params.serverMode);
  const headerMode = normalizeMode(params.headerMode);

  if (serverMode === "unknown") return failClosed(`unknown gateway --mode '${params.serverMode}'`);
  if (headerMode === "unknown") return failClosed(`unknown x-compaction-mode header '${params.headerMode}'`);

  // Explicit header opt-out → record, no matter the server mode.
  if (headerMode === "record") return record();

  const serverIntent = isMutating(serverMode) ? serverMode : undefined; // record server → no intent
  const headerIntent = isMutating(headerMode) ? headerMode : undefined;

  // No mutating intent anywhere → plain record.
  if (!serverIntent && !headerIntent) return record();

  const serverPolicy = params.serverPolicy?.trim() || undefined;
  const headerPolicy = params.headerPolicy?.trim() || undefined;

  // Conflict: both sides express a mutating intent and disagree on mode or policy.
  if (serverIntent && headerIntent) {
    if (serverIntent !== headerIntent) {
      return failClosed(`gateway --mode '${serverIntent}' conflicts with x-compaction-mode '${headerIntent}' - fail closed`);
    }
    if (serverPolicy && headerPolicy && serverPolicy !== headerPolicy) {
      return failClosed(`gateway --policy '${serverPolicy}' conflicts with x-compaction-policy '${headerPolicy}' - fail closed`);
    }
  }

  const mode = (headerIntent ?? serverIntent) as "apply" | "dry-run";
  const policy = headerPolicy ?? serverPolicy;

  if (policy !== DEDUPE_POLICY) {
    return failClosed(
      policy === undefined
        ? `${mode} requested without a policy - apply requires policy '${DEDUPE_POLICY}'`
        : `unknown policy '${policy}' - apply requires policy '${DEDUPE_POLICY}'`
    );
  }

  const bySource: "explicit-header" | "explicit-mode" | "dry-run-header" | "dry-run-mode" =
    mode === "apply"
      ? headerIntent
        ? "explicit-header"
        : "explicit-mode"
      : headerIntent
        ? "dry-run-header"
        : "dry-run-mode";

  return { mode, requested: true, policy: DEDUPE_POLICY, activation: bySource };
}
