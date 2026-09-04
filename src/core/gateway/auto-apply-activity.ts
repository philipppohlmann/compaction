/**
 * Content-free activity record for ONE automatic application under a STORED scoped authorization
 * (PUBLIC CLI/SDK core, engine-free).
 *
 * The product contract requires every automatic application to be user-inspectable on seven facts:
 *   1. what was optimized            → `policy_used` + estimated input before/after + removed-block count
 *                                       (a shaping-only application states that no input component ran
 *                                       rather than reporting a zero-removal input plan)
 *   2. why it was eligible           → `auto_apply.gates_passed` (every eligibility gate that passed)
 *   3. what evidence/status backs it → `evidence_level` (local-estimate, run-scoped, no cost/output claim)
 *   4. which policy authorized it    → the preference id + scope in `caveats`
 *   5. where the original is retained→ `recovery.location` (a path pointer, never content)
 *   6. how to recover                → the exact `compaction gateway recover <id>` command in `caveats`
 *   7. how to disable                → the exact `compaction policies disable <id>` command in `caveats`
 *
 * Everything below is counts, ids, labels, and exact commands, the metrics-only activity store
 * (`src/core/activity-store.ts`) rejects anything else at write time (fail-closed). Appending is
 * best-effort from the gateway: a failure here never touches the forwarded request or the response.
 */
import { join } from "node:path";
import { DEFAULT_ACTIVITY_DIRECTORY, appendActivityEvent, type AppendActivityEventResult } from "../activity-store.js";
import type { ActivityEvent } from "../activity-event.js";
import type { CrossSurfaceProvider, CrossSurfaceSurface } from "../cross-surface-event.js";
import { GATEWAY_RECOVERY_DIR } from "./recovery.js";
import { DEDUPE_POLICY, type DedupePlan } from "./request-shape.js";

/** Surface/provider identity per auto-apply tool (mirrors the routed families in apply-eligibility). */
const TOOL_EVENT_IDENTITY: Readonly<Record<string, { surface: CrossSurfaceSurface; provider: CrossSurfaceProvider }>> = {
  "claude-code": { surface: "claude_code", provider: "anthropic" },
  codex: { surface: "codex", provider: "openai" }
};

export interface AutoApplyActivityParams {
  cwd: string;
  /** The workflow/tool the gateway connection serves (the authorization's scope tool). */
  workflow: string;
  /** Content-free model label from the request, when known. */
  requestModel?: string;
  /**
   * The deterministic INPUT plan, present whenever an input component ran.
   *
   * ABSENT on the gateway's in-process shaping-only fallback (Community at its optimized-input
   * ceiling on an engine that cannot emit the shaping-only degradation itself): no input component
   * ran there, so there is no plan to report and no input delta to state. Such a record still carries
   * the recovery pointer and the recover/disable commands, which is the whole reason it is written.
   */
  plan?: DedupePlan;
  recoveryId: string;
  authorizationId: string;
  /** The authorization's scope, rendered content-free (tool + optional repo id). */
  authorizationScopeLine: string;
  /** Every eligibility gate that passed (non-empty, an application with zero gates cannot exist). */
  gatesPassed: string[];
  appliedComponents?: Array<"lcm-compaction" | "deterministic-compaction" | "output-shaping">;
  composedInputEstimate?: { before: number; after: number };
}

/** Build the metrics-only event (exported for tests; the store validates it again at write time). */
export function buildAutoApplyActivityEvent(params: AutoApplyActivityParams): ActivityEvent {
  const identity = TOOL_EVENT_IDENTITY[params.workflow] ?? { surface: "cli" as const, provider: "other" as const };
  const gatesPassed = params.gatesPassed;
  if (gatesPassed.length === 0) {
    // Unreachable by construction (the eligibility engine passes every gate before applying), and
    // unrepresentable downstream: the applied auto_apply arm requires a non-empty gates_passed.
    throw new Error("an automatic application with zero passed gates is invalid");
  }
  const recoveryLocation = `${GATEWAY_RECOVERY_DIR}/${params.recoveryId}.json`;
  const components = params.appliedComponents ?? ["deterministic-compaction"];
  const outputShapingApplied = components.includes("output-shaping");
  const inputPlan = params.plan;
  if (!inputPlan && !outputShapingApplied) {
    // Unrepresentable: an application with neither an input plan nor an output component applied
    // nothing, and an activity record describing no treatment is worse than none.
    throw new Error("an automatic application with no input plan and no output shaping is invalid");
  }
  // INPUT COUNTS ARE OMITTED WHEN NO INPUT COMPONENT RAN. `input_before`/`input_after` are optional on
  // the cross-surface event and the readers render an absent pair as `-`; that is the honest reading of
  // a shaping-only fallback, whose input the gateway forwarded on the model-visible basis it arrived
  // on. Inventing a pair here would have to pick a basis (transport vs model-visible) that this public
  // module cannot measure, and the two are deliberately not interchangeable.
  // The deterministic plan measures ONE layer. When the LCM compactor ran first it is handed LCM's
  // OUTPUT, so `estTokensBefore` is already post-mutation and this event would state a reduction of
  // zero on a turn that really reduced. The composed estimate is the end-to-end pair the apply path
  // meters from; use it whenever a layer other than deterministic dedupe contributed.
  const composedBasis = outputShapingApplied || components.includes("lcm-compaction");
  const inputBefore = inputPlan ? (composedBasis ? params.composedInputEstimate?.before : inputPlan.estTokensBefore) : undefined;
  const inputAfter = inputPlan ? (composedBasis ? params.composedInputEstimate?.after : inputPlan.estTokensAfter) : undefined;
  if (inputPlan && (inputBefore === undefined || inputAfter === undefined)) {
    throw new Error("a composed (LCM or output-shaping) application requires a composed input estimate");
  }
  return {
    surface: identity.surface,
    provider: identity.provider,
    model_label: params.requestModel ?? "unknown",
    policy_used: outputShapingApplied ? "cache-context-optimize" : DEDUPE_POLICY,
    ...(inputBefore !== undefined ? { input_before: inputBefore } : {}),
    ...(inputAfter !== undefined ? { input_after: inputAfter } : {}),
    token_source: {
      input: { source: "local-estimate" },
      output: {
        source: "unavailable",
        unavailable_reason: "the apply path acts on the request; output tokens ride on the gateway receipt, not this event"
      }
    },
    cost_source: "unavailable",
    cost_unavailable_reason: "the gateway observes provider tokens, not billing; no cost figure exists on this path",
    claim_scope: "run-scoped",
    evidence_level: !inputPlan
      ? "pre-generation output-shaping treatment applied; no input component ran, so no input delta is claimed; output delta unavailable pending provider-reported A/B and sufficiency evaluation"
      : outputShapingApplied
        ? "pre-generation output-shaping treatment applied; composed changed-input delta is local-estimate (chars/4); output delta unavailable pending provider-reported A/B and sufficiency evaluation"
        : "local-estimate model-visible input reduction (chars/4); run-scoped; no output-token, cost, or billing claim",
    caveats: [
      `authorized by stored preference ${params.authorizationId} (scope: ${params.authorizationScopeLine}; policy ${inputPlan ? DEDUPE_POLICY : "cache-context-optimize"})`,
      `applied components: ${components.join(", ")}`,
      // Only stated when the input component actually ran. "removed 0 exact-duplicate block(s)" reads
      // as "it ran and found nothing", which is a different fact from "it never ran".
      ...(inputPlan
        ? [
            `deterministic input component: removed ${inputPlan.removedBlocks} exact-duplicate block(s); est. supported-field input ${inputPlan.estTokensBefore} -> ${inputPlan.estTokensAfter} tokens (local estimate)`
          ]
        : ["no input component ran on this request; the input was forwarded unchanged"]),
      ...(outputShapingApplied
        ? [
            ...(inputBefore !== undefined && inputAfter !== undefined
              ? [`composed changed-input estimate: ${inputBefore} -> ${inputAfter} tokens (chars/4; includes attached instructions)`]
              : []),
            "output-shaping component: attached before generation; provider output usage is recorded on the gateway receipt; no output reduction claimed without A/B plus sufficiency evaluation"
          ]
        : []),
      `eligible because all gates passed: ${gatesPassed.join(", ")}`,
      `recover the exact original: compaction gateway recover ${params.recoveryId}`,
      `disable future automatic application: compaction policies disable ${params.authorizationId}`
    ],
    approval_status: "auto-applied-by-policy",
    auto_apply: {
      eligible: true,
      preference: "auto-when-gates-pass",
      applied_automatically: true,
      gates_passed: gatesPassed as [string, ...string[]]
    },
    recovery: { original_retained: true, location: recoveryLocation },
    sync_status: "local-only"
  };
}

/**
 * Append the record to the local metrics-only activity store. Never throws (the gateway must stay
 * fail-open); a rejected/duplicate append is reported in the result, not raised.
 */
export async function appendAutoApplyActivityEvent(params: AutoApplyActivityParams): Promise<AppendActivityEventResult> {
  try {
    const event = buildAutoApplyActivityEvent(params);
    return await appendActivityEvent(event, join(params.cwd, DEFAULT_ACTIVITY_DIRECTORY));
  } catch (error) {
    return { appended: false, reason: `activity append failed: ${(error as Error).message}` };
  }
}
