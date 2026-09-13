/**
 * Compaction Gateway APPLY receipt builder (PUBLIC CLI/SDK core, engine-free).
 *
 * Builds the content-free before/after receipt for an apply / dry-run pass. It REUSES the record receipt
 * builder for the provider's after-call usage (provider-reported token/cache axis) and overlays the apply
 * axis: request_mutated, the LOCAL-ESTIMATE model-visible input before/after, the recovery pointer, and a
 * fail_closed_reason when nothing was applied. The model-visible-input reduction is claimed ONLY when the
 * request body was actually changed; otherwise no reduction is asserted. The response is NEVER changed.
 */
import { buildGatewayReceipt, type GatewayReceipt } from "./receipt.js";
import type { OpenAiUsageBreakdown } from "./openai-usage.js";
import type { DedupePlan } from "./request-shape.js";
import type { OptimizationPlan } from "./optimization-planner.js";
import type { ApplyActivation } from "./apply-activation.js";
import { LCM_APPLY_POLICY } from "./lcm-apply-policy-name.js";

export const applyLabelMutated = (pct: number): string =>
  `apply (deterministic-dedupe): model-visible input reduced by ${pct}% by a deterministic policy (exact-duplicate large blocks removed); the original request is retained locally. No output-token, cost, provider-billing, or semantic-compaction claim.`;

/**
 * Honest label for an application under the LCM policy (the stored-authorization boundary path in
 * `lcm-apply-boundary.ts`, which has no production caller today). It claims NO reduction percentage
 * (there is no deterministic plan) and no output/cost/billing effect.
 */
export const LCM_APPLY_LABEL_MUTATED =
  "apply (lcm-context-optimize): request body replaced by a qualified-class LCM candidate under a stored scoped authorization; the original request is retained locally and recoverable. No output-token, cost, provider-billing, or semantic-compaction claim.";

export const APPLY_LABEL_NOOP =
  "apply requested but the request was forwarded UNCHANGED (no safe duplicate to remove / fail closed). No model-visible input reduction is claimed.";

export const OUTPUT_SHAPING_APPLY_LABEL =
  "apply (cache + context optimize): deterministic pre-generation output-shaping instructions were attached under stored scoped authorization; the original request is retained locally and recoverable. Provider-reported output usage is recorded, but no output-token or cost reduction is claimed without a measured A/B and sufficiency evaluation.";

/**
 * The label for OPEN `basic` gateway shaping.
 *
 * Distinct from `OUTPUT_SHAPING_APPLY_LABEL` because that string makes two claims that are FALSE on this
 * path: there is no stored scoped authorization — the user's `product_mode`
 * preference is the authorization — and the user is very likely on `optimization_mode: cache` rather
 * than "cache + context optimize", since selecting `compaction mode basic` does not change it. The label
 * is persisted to `receipts.jsonl`, so it has to describe what actually happened.
 */
/**
 * WORDING NOTE.
 *
 * The first version of this label said "your model-visible INPUT was not changed". That is FALSE:
 * attaching the instruction block adds model-visible text — measured at +441 bytes on a 90-byte body —
 * and this file's own sibling field `model_visible_bytes_changed` is set to `true` on the same receipt.
 * One artifact contradicting itself is precisely the defect the label was rewritten to remove.
 *
 * What IS true, and what the sentence now says: the block is APPENDED, and the user's own messages are
 * left byte-exact. That is the real Open/Community line — Open adds an instruction, Community compacts
 * the conversation — and it is checkable against the receipt rather than contradicted by it.
 */
export const OPEN_BASIC_OUTPUT_SHAPING_APPLY_LABEL =
  "apply (open basic output shaping): the public deterministic output-shaping instruction was APPENDED before generation under your selected product mode `basic`. It adds model-visible instruction text; your own messages are left byte-exact and are never compacted. The original request is retained locally and recoverable, and this turn was not metered. Provider-reported output usage is recorded, but no output-token or cost reduction is claimed without a measured A/B.";

/** The receipt `policy` value for that path — the apply-mode name, matching the recovery record. */
export const OPEN_BASIC_OUTPUT_POLICY = "open-basic-output-apply";

export const COMBINED_APPLY_LABEL = (pct: number): string =>
  `apply (cache + context optimize): exact-duplicate context was reduced by ${pct}% over the supported input fields and deterministic pre-generation output shaping was attached; the original request is retained locally and recoverable. Provider-reported output usage is recorded, but no output-token or cost reduction is claimed without a measured A/B and sufficiency evaluation.`;

export const dryRunLabelCandidate = (pct: number): string =>
  `dry-run (deterministic-dedupe): a deterministic mutation is AVAILABLE (estimated -${pct}% model-visible input, local-estimate); the ORIGINAL request was forwarded unchanged. No applied-reduction claim is made.`;

export const DRYRUN_LABEL_NONE =
  "dry-run (deterministic-dedupe): no safe deterministic mutation is available for this request; the original was forwarded unchanged.";

/**
 * Build ONE content-free apply/dry-run receipt. `applied` is true only when the body was actually changed
 * (apply path); dry-run always forwards the original (applied=false, candidate flagged from the plan).
 */
export function buildApplyReceipt(params: {
  provider: string;
  endpoint: string;
  upstreamStatus: number;
  usage: OpenAiUsageBreakdown;
  requestModel?: string;
  proofRunId?: string;
  proofVariant?: "baseline" | "compacted";
  activation: ApplyActivation;
  plan?: DedupePlan;
  applied: boolean;
  recoveryId?: string;
  /** The stored policy-preference id, when the application ran under a stored authorization. */
  authorizationId?: string;
  failClosedReason?: string;
  optimizationPlan?: OptimizationPlan;
  appliedComponents?: Array<"lcm-compaction" | "deterministic-compaction" | "output-shaping">;
  /**
   * Output-shaping provenance for the FINAL forwarded request. Distinct from `appliedComponents`, which
   * records only what this pass mutated. See `GatewayReceipt.output_shaping_state`. Omitted ⇒ the receipt
   * carries no field and readers fail closed.
   */
  outputShapingState?: "attached-this-pass" | "already-active" | "absent";
  outputShapingPolicyVersion?: string;
  outputShapingRegime?: GatewayReceipt["output_shaping_regime"];
  /** Device-local keyed hash of the tool session id (never the id itself). See `session-correlation.ts`. */
  sessionCorrelationId?: string;
  /** ISO timestamp the gateway received the request. See `request_started_at` on `GatewayReceipt`. */
  requestStartedAt?: string;
  /** Fixed-vocabulary LCM outcome (content-free). See `lcm-outcome.ts`. */
  lcmOutcome?: { kind: string; reason: string };
  composedInputEstimate?: { before: number; after: number };
  /** Set when the Community optimized-input allowance is why input optimization did not run this turn. */
  allowancePause?: GatewayReceipt["allowance_pause"];
  /** Set on a turn that DEBITED the allowance: what was left afterwards, out of the period total. */
  allowanceSnapshot?: GatewayReceipt["allowance_snapshot"];
  /**
   * The upstream billing route this turn was forwarded on. Recorded because the per-turn line's
   * list-price cost clause is only defensible on the route that is billed per token; see
   * `upstream_route_type` on `GatewayReceipt`. Omitting it suppresses the clause (fail-closed).
   */
  upstreamRouteType?: GatewayReceipt["upstream_route_type"];
  now?: () => string;
  id?: () => string;
}): GatewayReceipt {
  const base = buildGatewayReceipt({
    provider: params.provider,
    endpoint: params.endpoint,
    mode: "apply",
    upstreamStatus: params.upstreamStatus,
    usage: params.usage,
    ...(params.outputShapingState ? { outputShapingState: params.outputShapingState } : {}),
    ...(params.outputShapingPolicyVersion ? { outputShapingPolicyVersion: params.outputShapingPolicyVersion } : {}),
    ...(params.outputShapingRegime ? { outputShapingRegime: params.outputShapingRegime } : {}),
    ...(params.requestModel ? { requestModel: params.requestModel } : {}),
    ...(params.requestStartedAt ? { requestStartedAt: params.requestStartedAt } : {}),
    ...(params.proofRunId ? { proofRunId: params.proofRunId } : {}),
    ...(params.proofVariant ? { proofVariant: params.proofVariant } : {}),
    ...(params.now ? { now: params.now } : {}),
    ...(params.id ? { id: params.id } : {})
  });

  const isDryRun = params.activation.mode === "dry-run";
  const plan = params.plan;

  // approval_status: reflects an ACTUAL apply + its source (explicit per-call gesture, or the stored
  // scoped authorization); dry-run is its own label; when nothing was applied nothing was
  // approved/executed → not-required (the fail_closed_reason carries the detail).
  let approval: GatewayReceipt["approval_status"] = "not-required";
  if (params.applied) {
    approval =
      // `open-basic-mode` shares `auto-applied-by-policy` with the stored-authorization path rather
      // than getting its own receipt value. Both ARE applications under a persisted local policy —
      // there, a scoped authorization; here, the `product_mode: basic` preference — and the receipt's
      // `approval_status` is a VALIDATED enum mirrored in `ACTIVITY_APPROVAL_STATUSES`
      // (`activity-event.ts`), so a new member is a schema change on a surface that rejects unknown
      // values outright. Reusing the accurate existing label costs nothing: the two are already
      // distinguishable on the receipt, because only the stored path carries an `authorization_id`.
      params.activation.activation === "stored-authorization" || params.activation.activation === "open-basic-mode"
        ? "auto-applied-by-policy"
        : params.activation.activation === "explicit-header"
          ? "explicit-header"
          : "explicit-mode";
  } else if (isDryRun) approval = "explicit-dry-run";

  // apply label - a model-visible reduction is asserted ONLY when the body actually changed.
  // An application under the LCM policy (no deterministic plan) gets its own honest label; it can
  // never fall through to the deterministic reduction claim or the "forwarded UNCHANGED" no-op.
  let applyLabel: string;
  if (params.applied && params.activation.policy === LCM_APPLY_POLICY) applyLabel = LCM_APPLY_LABEL_MUTATED;
  else if (params.applied && params.appliedComponents?.includes("output-shaping") && plan?.changed) {
    applyLabel = COMBINED_APPLY_LABEL(plan.reductionPercent);
  }
  else if (params.applied && params.appliedComponents?.includes("output-shaping"))
    applyLabel =
      params.activation.activation === "open-basic-mode"
        ? OPEN_BASIC_OUTPUT_SHAPING_APPLY_LABEL
        : OUTPUT_SHAPING_APPLY_LABEL;
  else if (params.applied && plan) applyLabel = applyLabelMutated(plan.reductionPercent);
  else if (isDryRun) applyLabel = plan?.changed ? dryRunLabelCandidate(plan.reductionPercent) : DRYRUN_LABEL_NONE;
  else applyLabel = APPLY_LABEL_NOOP;

  const failReason = params.failClosedReason ?? plan?.failClosedReason;
  const optimizationPlan = params.optimizationPlan;
  const shapingApplied = params.appliedComponents?.includes("output-shaping") === true;
  const lcmApplied = params.appliedComponents?.includes("lcm-compaction") === true;

  /**
   * WHICH MEASUREMENT IS THE INPUT BASIS.
   *
   * `plan` measures ONE layer: deterministic dedupe. On a turn where the LCM compactor ran first, the
   * deterministic layer is handed LCM's OUTPUT, so `plan.estTokensBefore` is a POST-mutation figure and
   * both ends of the receipt can describe the same already-compacted body, hiding the actual reduction.
   * The pipeline already computes the authoritative
   * end-to-end pair (pre-mutation model-visible input -> final forwarded body) in `composedInputEstimate`
   * and meters from it; the receipt was simply reading a different number than the meter.
   *
   * So: use the composed estimate whenever ANY layer other than deterministic dedupe contributed, and
   * the single-layer plan otherwise (where the two are identical anyway). This changes no metering
   * semantics and adds no parallel accounting — it points the receipt at the figure the apply path
   * already treats as authoritative.
   */
  const composedBasis = shapingApplied || lcmApplied;
  const inputBefore = composedBasis ? params.composedInputEstimate?.before : plan?.estTokensBefore;
  const inputAfter = composedBasis
    ? params.composedInputEstimate?.after
    : params.applied
      ? plan?.estTokensAfter
      : plan?.estTokensBefore;

  /**
   * The reduction percent must be derived from the SAME basis as before/after, or the receipt states a
   * percentage its own two numbers contradict. Output shaping still publishes none: it ADDS input
   * characters to buy output tokens, so a "model-visible input reduction" is not the fact it produced.
   */
  const composedReductionPercent =
    inputBefore !== undefined && inputAfter !== undefined && inputBefore > 0
      ? Math.round((1 - inputAfter / inputBefore) * 1000) / 10
      : 0;

  return {
    ...base,
    // Override the inherited record label: an apply receipt must NOT claim "forwarded byte-for-byte /
    // model-visible bytes unchanged" when it actually mutated. The apply label is the honest one here.
    label: applyLabel,
    model_visible_bytes_changed: params.applied, // TRUE only when the request body was actually changed
    approval_status: approval,
    // The Open-basic path carries no `activation.policy` and no `plan`, so the default would have
    // recorded `deterministic-dedupe` — a policy that did not run — while the recovery record for the
    // SAME turn says `open-basic-output-apply`. Two artifacts disagreeing about one turn is exactly the
    // provenance defect the receipt exists to prevent.
    policy:
      params.activation.activation === "open-basic-mode"
        ? OPEN_BASIC_OUTPUT_POLICY
        : (params.activation.policy ?? plan?.policy ?? "deterministic-dedupe"),
    request_mutated: params.applied,
    response_mutated: false,
    ...(isDryRun ? { candidate_available: Boolean(plan?.changed) } : {}),
    ...(inputBefore !== undefined && inputAfter !== undefined
      ? {
          estimated_input_tokens_before: inputBefore,
          estimated_input_tokens_after: inputAfter,
          ...(!shapingApplied
            ? {
                estimated_model_visible_input_reduction_percent:
                  params.applied || isDryRun ? (composedBasis ? composedReductionPercent : plan!.reductionPercent) : 0
              }
            : {}),
          token_source_before: "local-estimate",
          token_source_after: "local-estimate"
        }
      : {}),
    ...(params.recoveryId ? { recovery_id: params.recoveryId } : {}),
    ...(params.authorizationId ? { authorization_id: params.authorizationId } : {}),
    ...(params.appliedComponents ? { applied_components: params.appliedComponents } : {}),
    ...(params.outputShapingState ? { output_shaping_state: params.outputShapingState } : {}),
    ...(params.sessionCorrelationId ? { session_correlation_id: params.sessionCorrelationId } : {}),
    ...(params.lcmOutcome ? { lcm_outcome: params.lcmOutcome } : {}),
    ...(params.allowancePause ? { allowance_pause: params.allowancePause } : {}),
    ...(params.allowanceSnapshot ? { allowance_snapshot: params.allowanceSnapshot } : {}),
    ...(params.upstreamRouteType ? { upstream_route_type: params.upstreamRouteType } : {}),
    ...(failReason ? { fail_closed_reason: failReason } : {}),
    ...(optimizationPlan
      ? {
          optimization_plan: {
            selected_method: optimizationPlan.selectedMethod,
            selected_reason: optimizationPlan.selectedReason,
            rejected_methods: optimizationPlan.rejectedMethods,
            evidence_label: optimizationPlan.evidenceLabel,
            approval_requirement: optimizationPlan.approvalRequirement,
            approval_source: optimizationPlan.approvalSource,
            cache_evidence: optimizationPlan.cacheEvidence,
            composable_methods: optimizationPlan.composableMethods,
            ...(optimizationPlan.expectedInputTokenDelta !== undefined ? { expected_input_token_delta: optimizationPlan.expectedInputTokenDelta } : {}),
            ...(optimizationPlan.expectedOutputTokenDelta !== undefined ? { expected_output_token_delta: optimizationPlan.expectedOutputTokenDelta } : {})
          }
        }
      : {}),
    apply_label: applyLabel
  };
}
