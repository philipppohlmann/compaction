/**
 * Content-free activity record for ONE automatic application under a STORED scoped authorization
 * (PUBLIC CLI/SDK core, engine-free).
 *
 * The product contract requires every automatic application to be user-inspectable on seven facts:
 *   1. what was optimized            → `policy_used` + estimated input before/after + removed-block count
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
  plan: DedupePlan;
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
  const inputBefore = outputShapingApplied ? params.composedInputEstimate?.before : params.plan.estTokensBefore;
  const inputAfter = outputShapingApplied ? params.composedInputEstimate?.after : params.plan.estTokensAfter;
  if (inputBefore === undefined || inputAfter === undefined) {
    throw new Error("a shaping application requires a composed input estimate");
  }
  return {
    surface: identity.surface,
    provider: identity.provider,
    model_label: params.requestModel ?? "unknown",
    policy_used: outputShapingApplied ? "cache-context-optimize" : DEDUPE_POLICY,
    input_before: inputBefore,
    input_after: inputAfter,
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
    evidence_level: outputShapingApplied
      ? "pre-generation output-shaping treatment applied; composed changed-input delta is local-estimate (chars/4); output delta unavailable pending provider-reported A/B and sufficiency evaluation"
      : "local-estimate model-visible input reduction (chars/4); run-scoped; no output-token, cost, or billing claim",
    caveats: [
      `authorized by stored preference ${params.authorizationId} (scope: ${params.authorizationScopeLine}; policy ${DEDUPE_POLICY})`,
      `applied components: ${components.join(", ")}`,
      `deterministic input component: removed ${params.plan.removedBlocks} exact-duplicate block(s); est. supported-field input ${params.plan.estTokensBefore} -> ${params.plan.estTokensAfter} tokens (local estimate)`,
      ...(outputShapingApplied
        ? [
            `composed changed-input estimate: ${inputBefore} -> ${inputAfter} tokens (chars/4; includes attached instructions)`,
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
