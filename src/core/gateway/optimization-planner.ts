/**
 * Typed selector for the existing Gateway runtime.
 *
 * This module only ranks facts already established by a caller. It never creates a
 * candidate, reads request content, or executes an optimization. Unknown facts stay
 * unavailable; they are never converted into a zero delta.
 */
import type { DedupePlan } from "./request-shape.js";

export type OptimizationMethod =
  | "deterministic-compaction"
  | "context-store-retrieval"
  | "output-shaping"
  | "cache-only"
  | "lcm"
  | "no-op";

/** Evidence labels are deliberately bounded and content-free. */
export type OptimizationEvidenceLabel =
  | "provider-capability"
  | "provider-reported"
  | "local-estimate"
  | "evaluated-candidate"
  | "unavailable";

export type ApprovalRequirement = "none" | "per-run-or-stored-authorization" | "build-activation-and-stored-authorization";
export type ApprovalSource = "none" | "stored-authorization" | "explicit-per-run" | "unavailable";

export interface PlannerAuthorizationFacts {
  /** True only when the runtime matched an enabled, narrow stored authorization. */
  storedAuthorization: boolean;
  /** True only when an explicit per-run approval has already passed. */
  explicitApproval?: boolean;
  /**
   * True only when this build carries an explicit, versioned activation for the method
   * (`hybrid-apply-activation.ts`). Reserved: false/absent keeps LCM unreachable.
   */
  buildActivationPassed?: boolean;
}

export interface PlannerCandidate {
  available: boolean;
  /** One-line content-free diagnostic; the planner bounds and sanitizes it before recording. */
  reason: string;
  /** A known, strictly negative input reduction is required for model-visible methods. */
  expectedInputTokenDelta?: number;
  /** A known, strictly negative output reduction is required for output shaping. */
  expectedOutputTokenDelta?: number;
  evidenceLabel: OptimizationEvidenceLabel;
  /** Deprecated compatibility field; selection derives approval from authorization facts. */
  approvalRequirement?: ApprovalRequirement;
}

export interface OutputShapingCandidate extends PlannerCandidate {
  preGeneration: boolean;
  /** The selected Mode-2 policy authorizes applying the treatment before outcome evidence exists. */
  applicationEligible?: boolean;
  /** Output reduction must come from the provider, not a local estimate. */
  outputDeltaEvidence?: "provider-reported";
  /** The existing runtime has evaluated that the response remains sufficient. */
  sufficiencyEvaluated?: boolean;
}

export interface OptimizationPlannerInput {
  deterministicPlan: DedupePlan;
  /** Compatibility input retained for callers; capability is not evidence of observed reduction. */
  providerCacheAvailable?: boolean;
  providerCache?: {
    capability: boolean;
    /** Present only after a provider-reported cache observation. */
    observedReduction?: boolean;
  };
  contextStore?: PlannerCandidate;
  outputShaping?: OutputShapingCandidate;
  /** LCM stays opaque and unreachable unless all runtime gates are explicitly supplied. */
  lcm?: PlannerCandidate & { classQualified?: boolean; approvalPassed?: boolean };
  authorization?: PlannerAuthorizationFacts;
}

export interface RejectedOptimizationMethod {
  method: Exclude<OptimizationMethod, "no-op">;
  reason: string;
}

export interface OptimizationPlan {
  selectedMethod: OptimizationMethod;
  selectedReason: string;
  rejectedMethods: RejectedOptimizationMethod[];
  expectedInputTokenDelta?: number;
  expectedOutputTokenDelta?: number;
  evidenceLabel: OptimizationEvidenceLabel;
  approvalRequirement: ApprovalRequirement;
  approvalSource: ApprovalSource;
  /** Capability and observed evidence remain separate in the record. */
  cacheEvidence: "provider-capability" | "provider-reported" | "unavailable";
  /** Methods that remain composable/observable even though one method was selected. */
  composableMethods: Exclude<OptimizationMethod, "no-op">[];
  deterministicPlan?: DedupePlan;
}

const MAX_REASON_LENGTH = 240;

function safeReason(reason: string, fallback: string): string {
  if (typeof reason !== "string") return fallback;
  const oneLine = reason.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  return oneLine.length > 0 ? oneLine.slice(0, MAX_REASON_LENGTH) : fallback;
}

function unavailable(reason: string): PlannerCandidate {
  return { available: false, reason, evidenceLabel: "unavailable" };
}

function cacheFacts(input: OptimizationPlannerInput): { capability: boolean; observed: boolean } {
  if (input.providerCache) return { capability: input.providerCache.capability === true, observed: input.providerCache.observedReduction === true };
  return { capability: input.providerCacheAvailable === true, observed: false };
}

function approvalFor(input: OptimizationPlannerInput, method: OptimizationMethod): { approvalRequirement: ApprovalRequirement; approvalSource: ApprovalSource } {
  if (method === "cache-only" || method === "no-op") return { approvalRequirement: "none", approvalSource: "none" };
  if (method === "lcm") {
    return input.authorization?.storedAuthorization
      ? { approvalRequirement: "build-activation-and-stored-authorization", approvalSource: "stored-authorization" }
      : { approvalRequirement: "build-activation-and-stored-authorization", approvalSource: "unavailable" };
  }
  if (input.authorization?.storedAuthorization) return { approvalRequirement: "per-run-or-stored-authorization", approvalSource: "stored-authorization" };
  if (input.authorization?.explicitApproval) return { approvalRequirement: "per-run-or-stored-authorization", approvalSource: "explicit-per-run" };
  return { approvalRequirement: "per-run-or-stored-authorization", approvalSource: "unavailable" };
}

function validNegative(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value < 0;
}

function reject(rejectedMethods: RejectedOptimizationMethod[], method: RejectedOptimizationMethod["method"], reason: string): void {
  rejectedMethods.push({ method, reason: safeReason(reason, "candidate unavailable") });
}

/** Select the safest proven candidate without inventing evidence or deltas. */
export function planBestSafeOptimization(input: OptimizationPlannerInput): OptimizationPlan {
  const rejectedMethods: RejectedOptimizationMethod[] = [];
  const contextStore = input.contextStore ?? unavailable("no context-store retrieval candidate is available on this request path");
  const outputShaping = input.outputShaping ?? { ...unavailable("no pre-generation output-shaping candidate is available on this request path"), preGeneration: false };
  const lcm = input.lcm ?? { ...unavailable("LCM is shadow-only: no qualified class or approval gate is available"), classQualified: false, approvalPassed: false };
  const cache = cacheFacts(input);
  const cacheEvidence = cache.observed ? "provider-reported" : cache.capability ? "provider-capability" : "unavailable";
  const outputTreatmentEligible =
    outputShaping.available &&
    outputShaping.preGeneration &&
    outputShaping.applicationEligible === true &&
    (input.authorization?.storedAuthorization === true || input.authorization?.explicitApproval === true);

  if (input.deterministicPlan.supported && input.deterministicPlan.changed && input.deterministicPlan.mutatedBody) {
    const delta = input.deterministicPlan.estTokensAfter - input.deterministicPlan.estTokensBefore;
    if (validNegative(delta)) {
      reject(rejectedMethods, "context-store-retrieval", safeReason(contextStore.reason, "context retrieval unavailable"));
      reject(rejectedMethods, "output-shaping", safeReason(outputShaping.reason, "output shaping unavailable"));
      reject(rejectedMethods, "lcm", "LCM is shadow-only and cannot be selected by this runtime");
      reject(rejectedMethods, "cache-only", cache.capability ? "cache measurement remains available as a composable provider capability" : "provider-cache capability is unavailable on this route");
      return {
        selectedMethod: "deterministic-compaction",
        selectedReason: "exact-duplicate deterministic compaction produced a safe recoverable candidate",
        rejectedMethods,
        expectedInputTokenDelta: delta,
        evidenceLabel: "local-estimate",
        ...approvalFor(input, "deterministic-compaction"),
        cacheEvidence,
        composableMethods: [
          ...(cache.capability ? (["cache-only"] as const) : []),
          ...(outputTreatmentEligible ? (["output-shaping"] as const) : [])
        ],
        deterministicPlan: input.deterministicPlan
      };
    }
  }

  reject(
    rejectedMethods,
    "deterministic-compaction",
    input.deterministicPlan.supported
      ? "deterministic compaction produced no strictly negative input delta"
      : input.deterministicPlan.failClosedReason ?? "request shape is unsupported for deterministic compaction"
  );

  if (contextStore.available && validNegative(contextStore.expectedInputTokenDelta)) {
    reject(rejectedMethods, "output-shaping", "a proven context candidate was selected; output shaping was not selected");
    reject(rejectedMethods, "lcm", "LCM is shadow-only and cannot be selected by this runtime");
    reject(rejectedMethods, "cache-only", cache.capability ? "cache measurement remains available as a composable provider capability" : "provider-cache capability is unavailable on this route");
    return {
      selectedMethod: "context-store-retrieval",
      selectedReason: safeReason(contextStore.reason, "validated context-store retrieval candidate selected"),
      rejectedMethods,
      expectedInputTokenDelta: contextStore.expectedInputTokenDelta,
      evidenceLabel: contextStore.evidenceLabel,
      ...approvalFor(input, "context-store-retrieval"),
      cacheEvidence,
      composableMethods: cache.capability ? ["cache-only"] : []
    };
  }
  reject(rejectedMethods, "context-store-retrieval", contextStore.available ? "context input delta is unavailable or not strictly negative" : contextStore.reason);

  const outputValid = outputShaping.available && outputShaping.preGeneration && validNegative(outputShaping.expectedOutputTokenDelta) && outputShaping.outputDeltaEvidence === "provider-reported" && outputShaping.sufficiencyEvaluated === true;
  if (outputValid) {
    reject(rejectedMethods, "lcm", "LCM is shadow-only and cannot be selected by this runtime");
    reject(rejectedMethods, "cache-only", cache.capability ? "cache measurement remains available as a composable provider capability" : "provider-cache capability is unavailable on this route");
    return {
      selectedMethod: "output-shaping",
      selectedReason: safeReason(outputShaping.reason, "validated pre-generation output candidate selected"),
      rejectedMethods,
      ...(validNegative(outputShaping.expectedInputTokenDelta) ? { expectedInputTokenDelta: outputShaping.expectedInputTokenDelta } : {}),
      expectedOutputTokenDelta: outputShaping.expectedOutputTokenDelta,
      evidenceLabel: "provider-reported",
      ...approvalFor(input, "output-shaping"),
      cacheEvidence,
      composableMethods: cache.capability ? ["cache-only"] : []
    };
  }
  if (outputTreatmentEligible) {
    reject(rejectedMethods, "lcm", "LCM is shadow-only and cannot be selected by this runtime");
    reject(rejectedMethods, "cache-only", cache.capability ? "cache measurement remains available as a composable provider capability" : "provider-cache capability is unavailable on this route");
    return {
      selectedMethod: "output-shaping",
      selectedReason: "pre-generation output-shaping treatment is enabled by the selected Cache + context mode; outcome evidence is recorded after generation",
      rejectedMethods,
      evidenceLabel: "unavailable",
      ...approvalFor(input, "output-shaping"),
      cacheEvidence,
      composableMethods: cache.capability ? ["cache-only"] : []
    };
  }
  reject(rejectedMethods, "output-shaping", outputShaping.available
    ? !outputShaping.preGeneration
      ? "output shaping is not proven to occur before generation"
      : outputShaping.outputDeltaEvidence !== "provider-reported"
        ? "output-token delta is not provider-reported"
        : outputShaping.sufficiencyEvaluated !== true
          ? "response sufficiency has not been evaluated"
          : "output-token delta is unavailable or not strictly negative"
    : outputShaping.reason);

  const lcmValid =
    lcm.available &&
    lcm.classQualified === true &&
    lcm.approvalPassed === true &&
    input.authorization?.storedAuthorization === true &&
    input.authorization.buildActivationPassed === true &&
    validNegative(lcm.expectedInputTokenDelta);
  if (lcmValid) {
    reject(rejectedMethods, "cache-only", cache.capability ? "cache measurement remains available as a composable provider capability" : "provider-cache capability is unavailable on this route");
    return {
      selectedMethod: "lcm",
      selectedReason: safeReason(lcm.reason, "qualified approval-passed LCM candidate selected"),
      rejectedMethods,
      expectedInputTokenDelta: lcm.expectedInputTokenDelta,
      ...(validNegative(lcm.expectedOutputTokenDelta) ? { expectedOutputTokenDelta: lcm.expectedOutputTokenDelta } : {}),
      evidenceLabel: lcm.evidenceLabel,
      ...approvalFor(input, "lcm"),
      cacheEvidence,
      composableMethods: cache.capability ? ["cache-only"] : []
    };
  }
  reject(
    rejectedMethods,
    "lcm",
    !lcm.classQualified
      ? "LCM workflow class is not qualified"
      : !lcm.approvalPassed || input.authorization?.storedAuthorization !== true || input.authorization.buildActivationPassed !== true
        ? "LCM approval gate has not passed"
        : "LCM input delta is unavailable or not strictly negative"
  );

  if (cache.capability) {
    return {
      selectedMethod: "cache-only",
      selectedReason: cache.observed
        ? "provider-reported cache reduction is available; no safe model-visible mutation was selected"
        : "provider cache capability is available; no observed reduction is claimed",
      rejectedMethods,
      evidenceLabel: cacheEvidence,
      ...approvalFor(input, "cache-only"),
      cacheEvidence,
      composableMethods: []
    };
  }
  reject(rejectedMethods, "cache-only", "provider-cache capability is not available on this route");
  return {
    selectedMethod: "no-op",
    selectedReason: "no safe supported optimization method is available",
    rejectedMethods,
    evidenceLabel: "unavailable",
    ...approvalFor(input, "no-op"),
    cacheEvidence: "unavailable",
    composableMethods: []
  };
}
