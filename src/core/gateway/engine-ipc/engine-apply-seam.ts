/**
 * Native-engine apply seam (PUBLIC) — the thin boundary function the gateway apply path can call to
 * consult the supervised native engine, with safe degradation baked in.
 *
 * This is the seam the gateway apply path is routed through. It does not replace the existing
 * `lcm-apply-boundary.ts` path; both coexist.
 *
 * Degradation order: when the engine is unavailable/degraded, or when
 * it returns a refusal/no-op/error, this seam yields a `forward-original` decision — the caller
 * forwards the ORIGINAL request bytes unchanged. Only an `applied` engine result with a real,
 * changed `mutated_request_body` AND `recovery_required` honored by the caller yields an `apply`
 * decision. Basic public output shaping (if enabled + safe) is the caller's responsibility BEFORE
 * this seam; this seam covers the engine → forward-original steps. An honest receipt is ALWAYS
 * the caller's responsibility regardless of the decision here.
 *
 * Byte-safety + recovery: this seam never mutates a body itself and never returns a mutation
 * without an accompanying `recovery_required` flag from the engine; the caller must have retained
 * the original before using any mutation. On any degrade the original is preserved by construction.
 *
 * Content-free out: the decision carries counts/labels/ids and (only on `apply`) the replacement
 * body as a transport field, the same class of data the gateway already forwards upstream.
 */
import type {
  EngineIpcOutputShapingState,
  EngineIpcReceiptArtifacts,
  EngineIpcUsageDebit
} from "./protocol.js";
import type { EngineRequestInput, EngineSupervisor } from "./supervisor.js";

/** The seam's decision for one request. `forward-original` is the safe-degradation default. */
export type EngineApplyDecision =
  | {
      decision: "forward-original";
      /** Fixed label: why the original is forwarded (degrade reason or engine result class). */
      reason: string;
      /**
       * WHY LCM DID OR DID NOT CONTRIBUTE, when the engine ran the pipeline and no-opped. A fact about
       * the request the caller's receipt should still carry; fixed vocabulary, content-free. Absent on a
       * degrade, a refusal, or an older engine (unknown, no claim).
       */
      lcmOutcome?: { kind: string; reason: string };
      /** Provenance for the unchanged body when the engine pipeline produced a no-op. */
      outputShapingState?: EngineIpcOutputShapingState;
      /** Exact identity paired with the no-op's already-active provenance, when known. */
      outputShapingPolicyVersion?: string;
    }
  | {
      decision: "apply";
      /** Transport-only replacement body for the caller to forward upstream. */
      mutatedRequestBody: string;
      /** The engine flagged that a byte-exact recovery path must exist before use. Always true here. */
      recoveryRequired: true;
      appliedComponents: string[];
      meterVersion?: string;
      meteredOptimizedInputTokens?: number;
      estimatedInputTokensBefore?: number;
      estimatedInputTokensAfter?: number;
      /**
       * The engine's usage-debit descriptor (ids + count) for a metered apply. Forwarded so the
       * gateway metering hook can reconcile the engine's `event_id` with the client-minted chain id;
       * the CLIENT id remains authoritative for the signed journal. Content-free (ids + count only).
       */
      usageDebit?: EngineIpcUsageDebit;
      /** Content-free receipt artifacts for the caller's public receipt/activity record. */
      receiptArtifacts?: EngineIpcReceiptArtifacts;
      /**
       * This apply is the engine's OWN allowance-ceiling degradation (output shaping only, metered
       * zero) rather than a turn that merely had no input to compact. Carried up so the caller can
       * state the pause on the receipt instead of silently shipping a shaping-only turn that looks
       * healthy. Absent from an older engine ⇒ `undefined` ⇒ no pause claimed.
       */
      quotaDegraded?: boolean;
    };

/**
 * Consult the supervised engine for one request and return a safe-degradation decision. Never
 * throws. When the engine is absent/degraded, refuses, no-ops, errors, or returns an apply without
 * a real body change, the decision is `forward-original` — the caller forwards the original bytes
 * unchanged and writes an honest receipt.
 */
export async function decideEngineApply(
  supervisor: EngineSupervisor,
  input: EngineRequestInput
): Promise<EngineApplyDecision> {
  const outcome = await supervisor.request(input);

  if (outcome.status === "degraded") {
    return { decision: "forward-original", reason: `engine-degraded:${outcome.reason}` };
  }

  const response = outcome.response;
  if (response.result !== "applied") {
    // refused | noop | error → forward the original unchanged (honest receipt is the caller's job).
    // A no-op the pipeline produced still says why LCM did not contribute; carry that fact out.
    return {
      decision: "forward-original",
      reason: `engine-result:${response.result}`,
      ...(response.lcm_outcome !== undefined ? { lcmOutcome: response.lcm_outcome } : {}),
      ...(response.result === "noop" && response.output_shaping_state !== undefined
        ? {
          outputShapingState: response.output_shaping_state,
          ...(response.output_shaping_policy_version
            ? { outputShapingPolicyVersion: response.output_shaping_policy_version }
            : {})
        }
        : {})
    };
  }

  const mutated = response.mutated_request_body;
  // An "applied" result must carry a real, changed body AND require recovery — otherwise fail-open.
  if (typeof mutated !== "string" || mutated.length === 0 || mutated === input.request_body || response.recovery_required !== true) {
    return { decision: "forward-original", reason: "engine-apply-unusable" };
  }

  return {
    decision: "apply",
    mutatedRequestBody: mutated,
    recoveryRequired: true,
    appliedComponents: response.applied_components,
    meterVersion: response.meter_version,
    meteredOptimizedInputTokens: response.metered_optimized_input_tokens,
    estimatedInputTokensBefore: response.estimated_input_tokens_before,
    estimatedInputTokensAfter: response.estimated_input_tokens_after,
    ...(response.usage_debit ? { usageDebit: response.usage_debit } : {}),
    ...(response.receipt_artifacts ? { receiptArtifacts: response.receipt_artifacts } : {}),
    ...(response.quota_degraded === true ? { quotaDegraded: true } : {})
  };
}
