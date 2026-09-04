/**
 * Compaction PLAN-LIFETIME impact model (PUBLIC CLI/SDK code, engine-free, ships in the npm package).
 *
 * ROUTE A ONLY. This is the honest, content-free answer to the plan-auth user's question:
 *   "Am I getting more out of my existing Codex / Claude Code / Cursor plan because Compaction reduces
 *    the input/output token load I put through it?"
 *
 * It is the PLAN-LIFETIME route (`economicRoute: "plan-lifetime"`, `authMode: "plan-auth"` in
 * `proof-scope.ts`): the user runs the tool NORMALLY on their existing subscription auth, NO API key is
 * required, requested, or stored. This module is NEVER the api-billing route (`proof-scope.ts` Route B):
 * it carries no provider-priced / invoice / billing-confirmed / cost / output-token-savings figure, and a
 * plan-lifetime result can NEVER be inferred from an API-key Gateway proof. The two routes stay separate.
 *
 * The honest quota answer:
 *   Codex CLI, Claude Code, and Cursor expose NO locally-observable quota / remaining-limit / plan-status
 *   signal on the plan-auth path. There is no existing reader to reuse and none is invented here (no
 *   private-dashboard scraping, no guessed quotas, no credentials beyond normal plan auth). Therefore
 *   `plan_quota_signal` is `not-observable` for ALL THREE workflows, carrying the reason
 *   `QUOTA_NOT_OBSERVABLE_REASON`. Never fabricate a quota figure.
 *
 * What `likely-extended` means (the ONE case that upgrades from the proof-scope default
 * `not-directly-observable`): it is an INFERENCE FROM OBSERVED TOKEN-LOAD REDUCTION, a real before/after
 * token count where Compaction reduced the input and/or output load, NOT a quota reading (there is none).
 * It is honestly labeled as such in the `reason`. It is NEVER "your plan is extended by X%": no exact plan
 * extension is claimed because none is observable.
 *
 * TOKEN SOURCE per workflow (from the repo's tier truth, `cross-surface-event.ts`
 * `NEVER_PROVIDER_REPORTED_SURFACES`): Codex / Claude Code prefer PROVIDER-REPORTED usage; Cursor is
 * LOCAL-ESTIMATE ONLY, clearly labeled (Compaction does not ingest or attribute Cursor's conditional
 * `result.usage`, so its current events cannot be provider-reported). Content-free by construction:
 * every field is a number (token COUNT only), an enum label, or an honest reason string, no field can
 * carry prompt/response/tool content or credentials.
 *
 * PURE: a function of content-free observed usage handed to it; no IO, no cost math.
 */
import type { PlanLifetimeImpact as ProofScopePlanLifetimeImpact } from "./gateway/proof-scope.js";
import { NEVER_PROVIDER_REPORTED_SURFACES } from "./cross-surface-event.js";
import type { ActivityEvent } from "./activity-event.js";

/** The plan-auth workflows Route A applies to (content-free identity; a subset of the tier surfaces). */
export type PlanAuthWorkflow = "codex" | "claude-code" | "cursor";

/** Three-valued axis for a token reduction: measured-and-reduced / measured-no-reduction / no data. */
export type TokenReductionAxis = "yes" | "no" | "unavailable";

/** Whether a specific reduction kind was really observed, or no such evidence exists. */
export type ObservedOrUnavailable = "observed" | "unavailable";

/**
 * The honest quota-signal axis. `not-observable` for ALL plan-auth workflows today, no vendor
 * exposes a locally-readable quota / remaining-limit signal. `observed` is reserved for a real, safe,
 * read-only quota signal that DOES NOT EXIST today (never fabricated).
 */
export type PlanQuotaSignal = "observed" | "not-observable";

/**
 * The honest token source for this workflow's counts (mirrors `RunFlowTokenSource` / the tier table):
 * `provider-reported` for Codex / Claude Code where real provider usage was captured; `local-estimate`
 * for Cursor (whose current Compaction reader does not ingest conditional vendor usage) or any workflow
 * whose counts are only a local estimate; `unavailable` when no counts exist at all.
 */
export type PlanLifetimeTokenSource = "provider-reported" | "local-estimate" | "unavailable";

/**
 * The plan-lifetime impact enum, the SAME four values as `proof-scope.ts` `PlanLifetimeImpact`, reused so
 * the model can never drift from the shared proof vocabulary:
 *  - `likely-extended`        , observed token-load reduction (real before/after) suggests more work per
 *                                fixed plan. INFERENCE FROM TOKEN REDUCTION, never a quota reading.
 *  - `not-observed`           , measured this window and NO reduction was observed.
 *  - `not-directly-observable`, no quota signal AND no measured reduction (the honest default).
 *  - `unavailable`            , no data at all for this workflow.
 */
export type PlanLifetimeImpact = ProofScopePlanLifetimeImpact;

/**
 * One PLAN-LIFETIME impact record for one plan-auth workflow.
 * Content-free: token COUNTS, enum labels, and honest reasons only. `reason` is REQUIRED whenever any axis
 * is `unavailable` / `not-observable` (enforced by construction + test).
 */
export interface PlanLifetimeImpactRecord {
  workflow: PlanAuthWorkflow;
  /** Always `plan-auth`, Route A never uses an API key / gateway. */
  auth_mode: "plan-auth";
  input_tokens_before?: number;
  input_tokens_after?: number;
  input_tokens_reduced: TokenReductionAxis;
  output_tokens_before?: number;
  output_tokens_after?: number;
  output_tokens_reduced: TokenReductionAxis;
  /** `observed` ONLY where a real provider-reported fresh-input (cache) reduction exists; else `unavailable`. */
  cache_fresh_input_reduction: ObservedOrUnavailable;
  /** `observed` where a deterministic-apply model-visible input reduction was recorded; else `unavailable`. */
  compaction_input_reduction: ObservedOrUnavailable;
  /** `not-observable` for ALL plan-auth workflows today (no vendor exposes a quota signal). */
  plan_quota_signal: PlanQuotaSignal;
  plan_lifetime_impact: PlanLifetimeImpact;
  token_source: PlanLifetimeTokenSource;
  /** REQUIRED when any axis is `unavailable` / `not-observable`. The honest reason (content-free). */
  reason?: string;
}

/* ------------------------------------------------------------------------------------------------
 * Honest reason constants (content-free). Exported so tests + future surfaces reuse the EXACT string.
 * ---------------------------------------------------------------------------------------------- */

/**
 * The quota-unavailable label. Used verbatim wherever the quota answer is surfaced (test-pinned, do not
 * reword). No workflow exposes a locally-observable quota / remaining-limit signal on the plan-auth path.
 */
export const QUOTA_NOT_OBSERVABLE_REASON =
  "Plan quota impact not directly observable - workflow does not expose quota/remaining-limit signal.";

/** The honest reason there is no token data at all for a workflow (never a fake zero). */
export const NO_TOKEN_DATA_REASON =
  "no before/after token counts were observed for this workflow, so token-load reduction cannot be measured; " +
  "no counts are fabricated.";

/** The honest reason Cursor (and any local-estimate workflow) is estimate-only, never provider-reported. */
export const CURSOR_LOCAL_ESTIMATE_REASON =
  "Compaction does not ingest or attribute Cursor's conditional result.usage fields, so its token counts are a content-free LOCAL ESTIMATE only - never " +
  "provider-reported, never provider-priced, never a quota reading.";

/** How `likely-extended` is honestly framed: an inference from observed token reduction, not a quota reading. */
export const LIKELY_EXTENDED_INFERENCE_REASON =
  "observed token-load reduction (real before/after counts) suggests more work fits in the same fixed plan; " +
  "this is an INFERENCE from token reduction, not a plan-quota reading (no quota signal is observable).";

/** The honest reason for `not-observed`: measured this window and no reduction was seen. */
export const NOT_OBSERVED_REASON =
  "before/after token counts were observed but showed no input or output reduction this window; " +
  "no plan-lifetime extension is inferred, and no quota signal is observable to confirm one either way.";

/** The honest reason for the `not-directly-observable` default: no measured reduction AND no quota signal. */
export const NOT_DIRECTLY_OBSERVABLE_REASON =
  "no measured token reduction is available AND no plan-quota signal is observable; plan-lifetime extension " +
  "is designed-for but not measured this window - never a fabricated quota figure.";

/* ------------------------------------------------------------------------------------------------
 * Compile-time / runtime tier guard: Cursor is a never-provider-reported surface, so its plan-lifetime
 * token source can never be `provider-reported`. This runtime set is derived from the shared tier truth
 * (`NEVER_PROVIDER_REPORTED_SURFACES`) so the two can never diverge.
 * ---------------------------------------------------------------------------------------------- */

/** Plan-auth workflows whose token source can NEVER be provider-reported (Cursor). */
export const LOCAL_ESTIMATE_ONLY_WORKFLOWS: readonly PlanAuthWorkflow[] = (
  ["codex", "claude-code", "cursor"] as const
).filter((w) => (NEVER_PROVIDER_REPORTED_SURFACES as readonly string[]).includes(w));

function isLocalEstimateOnly(workflow: PlanAuthWorkflow): boolean {
  return LOCAL_ESTIMATE_ONLY_WORKFLOWS.includes(workflow);
}

/* ------------------------------------------------------------------------------------------------
 * Content-free INPUT to the pure model. This is exactly the observed, content-free evidence a reader
 * pulls from receipts / activity / before-after pairs (never prompt/response/tool content, never keys).
 * Every field is optional: a genuinely-absent axis stays absent (no silent zero).
 * ---------------------------------------------------------------------------------------------- */

/** One observed before/after token pair (content-free counts only). */
export interface ObservedTokenPair {
  before?: number;
  after?: number;
}

/**
 * The content-free observed inputs for ONE plan-auth workflow. A reader assembles this from existing
 * content-free usage (receipts / activity / capture before-after), this model does NO IO itself (pure).
 *
 * `tokenSourceObserved` is the HONEST source the reader saw for the counts:
 *  - `provider-reported`, real provider usage (Codex / Claude Code). Ignored (forced to `local-estimate`)
 *    for a never-provider-reported workflow (Cursor), the model never launders a Cursor count into
 *    provider-reported.
 *  - `local-estimate`   , a content-free local estimate (Cursor, or an estimate for any workflow).
 *  - omitted            , no counts observed at all → `unavailable`.
 */
export interface PlanLifetimeWorkflowInput {
  workflow: PlanAuthWorkflow;
  /** Observed input before/after token counts (content-free). Absent axes stay absent. */
  input?: ObservedTokenPair;
  /** Observed output before/after token counts (content-free). Absent axes stay absent. */
  output?: ObservedTokenPair;
  /** The honest source the reader observed for these counts. Omitted → no counts (`unavailable`). */
  tokenSourceObserved?: "provider-reported" | "local-estimate";
  /**
   * TRUE only where a real PROVIDER-REPORTED fresh-input (cache) reduction was recorded on a routed path.
   * On the plan-auth route this is normally absent (no routing) → `unavailable`. Never inferred.
   */
  cacheFreshInputReductionObserved?: boolean;
  /**
   * TRUE only where a deterministic-apply model-visible input reduction was really recorded. Absent →
   * `unavailable` (never fabricated).
   */
  compactionInputReductionObserved?: boolean;
}

/* ------------------------------------------------------------------------------------------------
 * PURE model. No IO, no content, no keys, no cost, no quota fabrication.
 * ---------------------------------------------------------------------------------------------- */

/** A finite, non-negative count, else undefined (never a silent zero-as-missing). */
function cleanCount(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Reduce a before/after pair to the three-valued axis + carried counts:
 *  - `unavailable` when either count is missing (no fabricated zero);
 *  - `yes` when after < before (a real reduction);
 *  - `no` when after >= before (measured, no reduction).
 */
function reduceAxis(pair: ObservedTokenPair | undefined): {
  reduced: TokenReductionAxis;
  before?: number;
  after?: number;
  reducedBy: number;
} {
  const before = cleanCount(pair?.before);
  const after = cleanCount(pair?.after);
  if (before === undefined || after === undefined) {
    return { reduced: "unavailable", reducedBy: 0, ...(before !== undefined ? { before } : {}), ...(after !== undefined ? { after } : {}) };
  }
  const reducedBy = before - after;
  return { reduced: reducedBy > 0 ? "yes" : "no", before, after, reducedBy };
}

/**
 * The honest token source for this workflow's record, given what the reader observed and the tier truth:
 *  - a never-provider-reported workflow (Cursor) is ALWAYS `local-estimate` when any counts exist (its
 *    observed source can never be laundered to provider-reported);
 *  - otherwise the reader's observed source;
 *  - `unavailable` when no counts were observed.
 */
function tokenSourceFor(input: PlanLifetimeWorkflowInput, hasAnyCounts: boolean): PlanLifetimeTokenSource {
  if (!hasAnyCounts || input.tokenSourceObserved === undefined) return "unavailable";
  if (isLocalEstimateOnly(input.workflow)) return "local-estimate";
  return input.tokenSourceObserved;
}

/**
 * Build ONE plan-lifetime impact record for one plan-auth workflow from content-free observed inputs.
 *
 * Rails (all honest, none fabricated):
 *  - input/output reduced: from real observed before/after; else `unavailable` + reason (never fake zero).
 *  - token_source: provider-reported preferred for Codex / Claude Code; Cursor forced local-estimate.
 *  - cache_fresh_input_reduction: `observed` ONLY on a real recorded provider-reported fresh-input
 *    reduction; else `unavailable`.
 *  - compaction_input_reduction: `observed` ONLY on a real recorded model-visible input reduction; else
 *    `unavailable`.
 *  - plan_quota_signal: ALWAYS `not-observable` (no quota signal exists) + the reason.
 *  - plan_lifetime_impact: `likely-extended` ONLY when a REAL observed input OR output reduction > 0 exists
 *    (inference from token reduction, honestly labeled, NOT a quota reading); `not-observed` when measured
 *    but no reduction; `not-directly-observable` when no measured reduction AND no quota signal; `unavailable`
 *    when no data at all. Each carries a reason.
 */
export function buildPlanLifetimeImpact(input: PlanLifetimeWorkflowInput): PlanLifetimeImpactRecord {
  const inputAxis = reduceAxis(input.input);
  const outputAxis = reduceAxis(input.output);
  const hasAnyCounts =
    inputAxis.reduced !== "unavailable" || outputAxis.reduced !== "unavailable";
  const tokenSource = tokenSourceFor(input, hasAnyCounts);

  const cacheFresh: ObservedOrUnavailable = input.cacheFreshInputReductionObserved ? "observed" : "unavailable";
  const compactionInput: ObservedOrUnavailable = input.compactionInputReductionObserved ? "observed" : "unavailable";

  // No vendor exposes a locally-observable quota signal, ALWAYS not-observable, with the pinned reason.
  const planQuotaSignal: PlanQuotaSignal = "not-observable";

  // A REAL observed token reduction on EITHER axis (measured before/after with after < before).
  const hasRealReduction =
    (inputAxis.reduced === "yes" && inputAxis.reducedBy > 0) ||
    (outputAxis.reduced === "yes" && outputAxis.reducedBy > 0);
  const measured = inputAxis.reduced !== "unavailable" || outputAxis.reduced !== "unavailable";

  let impact: PlanLifetimeImpact;
  const reasonParts: string[] = [];

  if (hasRealReduction) {
    // The ONE upgrade from the proof-scope default, inference from token reduction, never a quota reading.
    impact = "likely-extended";
    reasonParts.push(LIKELY_EXTENDED_INFERENCE_REASON);
  } else if (measured) {
    impact = "not-observed";
    reasonParts.push(NOT_OBSERVED_REASON);
  } else {
    impact = "not-directly-observable";
    reasonParts.push(NOT_DIRECTLY_OBSERVABLE_REASON);
  }

  // No data at all → the whole record is unavailable (never a fake zero, never a fabricated quota).
  if (!hasAnyCounts) {
    impact = "unavailable";
    reasonParts.length = 0;
    reasonParts.push(NO_TOKEN_DATA_REASON);
  }

  // Cursor is always estimate-only, say so explicitly wherever it has counts.
  if (isLocalEstimateOnly(input.workflow) && hasAnyCounts) {
    reasonParts.push(CURSOR_LOCAL_ESTIMATE_REASON);
  }

  // The verbatim quota answer rides on EVERY record (quota is never observable on any of the three).
  reasonParts.push(QUOTA_NOT_OBSERVABLE_REASON);

  const record: PlanLifetimeImpactRecord = {
    workflow: input.workflow,
    auth_mode: "plan-auth",
    input_tokens_reduced: inputAxis.reduced,
    output_tokens_reduced: outputAxis.reduced,
    cache_fresh_input_reduction: cacheFresh,
    compaction_input_reduction: compactionInput,
    plan_quota_signal: planQuotaSignal,
    plan_lifetime_impact: impact,
    token_source: tokenSource,
    reason: reasonParts.join(" "),
    ...(inputAxis.before !== undefined ? { input_tokens_before: inputAxis.before } : {}),
    ...(inputAxis.after !== undefined ? { input_tokens_after: inputAxis.after } : {}),
    ...(outputAxis.before !== undefined ? { output_tokens_before: outputAxis.before } : {}),
    ...(outputAxis.after !== undefined ? { output_tokens_after: outputAxis.after } : {})
  };
  return record;
}

/** Build plan-lifetime impact records for many workflows. Pure, no IO, no content, no keys. */
export function buildPlanLifetimeImpacts(inputs: PlanLifetimeWorkflowInput[]): PlanLifetimeImpactRecord[] {
  return inputs.map((i) => buildPlanLifetimeImpact(i));
}

/* ------------------------------------------------------------------------------------------------
 * CONTENT-FREE READER: assemble plan-lifetime inputs from the already-content-free activity events.
 * This is the ONLY seam that reads observed data; it does NO cost math and NO quota fabrication, it
 * hands content-free before/after COUNTS to the pure model above. It never invents a count: a
 * plan-auth workflow with no usable before/after activity yields the honest not-observable record.
 * ---------------------------------------------------------------------------------------------- */

/** The plan-auth workflows Route A covers, in a stable order (always emitted, one record each). */
export const PLAN_AUTH_WORKFLOWS: readonly PlanAuthWorkflow[] = ["codex", "claude-code", "cursor"];

/**
 * The cross-surface `surface` value (underscore naming) for each plan-auth workflow. The activity store
 * uses the contract's underscore surface enum (`claude_code`); Route A uses the dash workflow id
 * (`claude-code`). This mapping is the ONLY place the two namings meet, it is pure, content-free.
 */
const ACTIVITY_SURFACE_FOR_WORKFLOW: Record<PlanAuthWorkflow, string> = {
  codex: "codex",
  "claude-code": "claude_code",
  cursor: "cursor"
};

/** A number only when it is a finite, non-negative count (never a silent zero-as-missing). */
function countOrUndefined(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Map the HONEST cross-surface input-axis source label to the model's `tokenSourceObserved`. A
 * plan-auth activity event carries `token_source.input.source` ∈ provider-reported | local-estimate |
 * unavailable. Only the first two are usable counts; `unavailable` (or missing) → undefined (no
 * counts). The model still forces Cursor to local-estimate, this reader never launders that.
 */
function observedSourceFor(event: ActivityEvent): "provider-reported" | "local-estimate" | undefined {
  const source = event.token_source?.input?.source;
  if (source === "provider-reported" || source === "local-estimate") return source;
  return undefined;
}

/**
 * Build the content-free plan-lifetime input for ONE plan-auth workflow from its activity events. Uses
 * the MOST RECENT event by append-recency that carries BOTH input_before and
 * input_after (a real observed reshaping) with a usable input source, else the workflow has no usable
 * observed reduction and the input is empty (→ the pure model emits the honest not-observable record).
 * Content-free: only COUNTS + an honest source label cross this seam; never content, never keys.
 */
function planLifetimeInputForWorkflow(
  workflow: PlanAuthWorkflow,
  events: ActivityEvent[]
): PlanLifetimeWorkflowInput {
  const surface = ACTIVITY_SURFACE_FOR_WORKFLOW[workflow];
  // Newest first (the store appends chronologically; the last line is most recent).
  for (const event of [...events].reverse()) {
    if (event.surface !== surface) continue;
    const before = countOrUndefined(event.input_before);
    const after = countOrUndefined(event.input_after);
    const source = observedSourceFor(event);
    // A usable observed reduction needs BOTH counts and a usable source (never a fabricated axis).
    if (before === undefined || after === undefined || source === undefined) continue;
    return { workflow, input: { before, after }, tokenSourceObserved: source };
  }
  // No usable observed before/after for this workflow → empty input → honest not-observable record.
  return { workflow };
}

/**
 * Build the Route-A plan-lifetime impact records for ALL plan-auth workflows from content-free activity
 * events. ALWAYS emits one record per plan-auth workflow (codex / claude-code / cursor): where activity
 * carries a usable observed before/after it is fed to the model (which may infer `likely-extended` from a
 * REAL reduction, honestly labeled); where none exists the record is the honest `not-directly-observable`
 * / `unavailable` default with its reason. Pure over the passed events, no IO, no content, no cost, no
 * quota fabrication. This is what `buildApiExport` calls (Route A of the export document).
 */
export function buildPlanLifetimeImpactsFromActivity(events: ActivityEvent[]): PlanLifetimeImpactRecord[] {
  return PLAN_AUTH_WORKFLOWS.map((workflow) =>
    buildPlanLifetimeImpact(planLifetimeInputForWorkflow(workflow, events))
  );
}
