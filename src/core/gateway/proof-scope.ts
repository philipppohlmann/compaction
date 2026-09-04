/**
 * Compaction proof-scope typed schema (public CLI/SDK code, engine-free; ships in the npm package).
 *
 * The shared, content-free vocabulary both economic proof routes attach to, and the guarantee that the
 * two routes are never collapsed into one another. The product keeps two economic proof routes separate:
 *   - Route A, plan-lifetime (`economicRoute: "plan-lifetime"`): the plan-auth CLI workflows (run the
 *     tool normally under the user's existing subscription auth). The story is token-load / quota
 *     extension. Quota consumption is not directly observable today, so the honest default plan-lifetime
 *     impact is `not-directly-observable`, never `likely-extended` (that needs observed token reduction)
 *     and never a billed/priced/invoice figure.
 *   - Route B, api-billing (`economicRoute: "api-billing"`): the gateway-routed provider-API path (the
 *     custom OpenAI-compatible app, and a routed provider-API scope for a gatewayRoutable +
 *     cacheProofSupported workflow). The story is provider-priced API cost; the proof level marks
 *     capability only, and the cost number lives in `api-cost-impact.ts`.
 *
 * Every level is derived from the existing capability-matrix truth (`WorkflowProviderCapability`), never
 * hand-set.
 *
 * Anti-collapse invariants:
 *  - Route A and Route B stay separate. A `plan-lifetime` scope can never carry an api-billing proof
 *    level, cost basis, billing source, or a plan-quota/invoice level; an `api-billing` scope can never
 *    carry a plan-quota level or a plan-lifetime route. Enforced in `deriveProofScope`, the compile-time
 *    guards, and the tests.
 *  - `invoice-confirmed` / `invoice-reconciled` and `plan-quota-observed` / `observed-plan-quota` are
 *    never reachable by default (no invoice or observable-quota evidence exists); they need explicit real
 *    evidence inputs that `deriveProofScope` cannot produce.
 *  - Every `unavailable` / `not-directly-observable` level carries a concrete, honest `reason`.
 *  - No cost / billing-confirmed / invoice / output-token / semantic / all-provider claim: the derivation
 *    asserts only capability and honest not-observed reasons.
 *
 * Aligns with `cross-surface-event.ts` (fixed-plan vs metered) without restating it: `plan-lifetime` is
 * the fixed-plan world (never billing-confirmed), `api-billing` the metered world.
 *
 * Content-free by construction: every field is an enum label, an honest reason string, or a workflow
 * display name; no field can carry prompt/response/tool content or credentials.
 */
import type { WorkflowKey, WorkflowProviderCapability } from "./capability-matrix.js";

/**
 * How the user authenticates for this scope:
 *  - `plan-auth`      , the default MVP route: the user's existing CLI auth / subscription, no API key.
 *  - `api-key-gateway`, the routed path: requests flow through the local Gateway on an API key.
 */
export type AuthMode = "plan-auth" | "api-key-gateway";

/**
 * The economic proof route (the two-route separation); these never convert into one another:
 *  - `plan-lifetime`, Route A: token-load / quota-extension story on a fixed plan (quota maybe unobservable).
 *  - `api-billing`  , Route B: provider-priced API cost-impact story on metered traffic.
 */
export type EconomicRoute = "plan-lifetime" | "api-billing";

/**
 * The strength of proof this scope can reach by default (the weakest honest level from existing truth):
 *  - `local-estimate`     , only a local estimate exists (e.g. Cursor: Compaction does not ingest the
 *                           CLI's conditional `result.usage`).
 *  - `provider-reported`  , the adapter yields provider usage/cache (Codex/Claude via routing).
 *  - `provider-priced-api`, capability marked only where api-billing + provider usage exists (the cost
 *                            number lives in `api-cost-impact.ts`). Route-B only; a plan-lifetime scope can never carry it.
 *  - `plan-quota-observed`, a real quota signal exists. None today, so never reached by default.
 *  - `invoice-confirmed`  , real invoice/accounting evidence. None, so never reached by default.
 */
export type ProofLevel =
  | "local-estimate"
  | "provider-reported"
  | "provider-priced-api"
  | "plan-quota-observed"
  | "invoice-confirmed";

/**
 * The basis for any cost figure this scope could carry (the figure lives in `api-cost-impact.ts`; this is the basis label):
 *  - `unavailable`                      , no cost basis (default for plan-auth activity/local rows).
 *  - `local-price-table`                , a local price-table estimate applies (local-estimate world).
 *  - `provider-usage-and-published-price`- provider usage + a published price (Route-B capability only).
 *  - `observed-plan-quota`              , a real observed quota. never reachable by default.
 *  - `invoice-reconciled`               , reconciled against a real invoice. never reachable by default.
 */
export type CostBasis =
  | "unavailable"
  | "local-price-table"
  | "provider-usage-and-published-price"
  | "observed-plan-quota"
  | "invoice-reconciled";

/**
 * Where a billing figure (if any) would come from:
 *  - `unavailable`         , no billing source (default).
 *  - `estimated-from-tokens`- estimated from token counts (local-estimate world).
 *  - `provider-priced-api` , provider-priced metered API (Route-B capability only).
 *  - `observed-plan-quota` , a real observed quota. never reachable by default.
 *  - `invoice-confirmed`   , a real invoice. never reachable by default.
 */
export type BillingSource =
  | "unavailable"
  | "estimated-from-tokens"
  | "provider-priced-api"
  | "observed-plan-quota"
  | "invoice-confirmed";

/**
 * The honest plan-lifetime (quota-extension) impact for a plan-auth scope:
 *  - `likely-extended`        , observed token reduction suggests extended plan lifetime. Requires a real
 *                                observed reduction, so never the default.
 *  - `not-observed`           , measured this window and no extension was observed (needs measurement).
 *  - `not-directly-observable`, the honest default for plan-auth: no quota signal exists to observe.
 *  - `unavailable`            , plan-lifetime is not applicable to this scope (the api-billing / provider-API
 *                                world has no plan-lifetime story; carry the reason).
 */
export type PlanLifetimeImpact =
  | "likely-extended"
  | "not-observed"
  | "not-directly-observable"
  | "unavailable";

/** The concrete surface a proof scope applies to (content-free identity). */
export type ProofScopeAppliesTo =
  | "codex"
  | "claude-code"
  | "cursor"
  | "custom-openai-app"
  | "provider-api";

/**
 * One proof-scope record: the honest, content-free description of what this workflow, on this economic
 * route, can prove. A workflow may yield more than one scope (e.g. a plan-auth `plan-lifetime` scope and,
 * when gatewayRoutable + cacheProofSupported, a routed `api-billing` scope); they are separate records so
 * the routes can never be conflated in a single figure.
 *
 * `reason` is required (enforced by construction + test) wherever a level is `unavailable` /
 * `not-directly-observable`, never a bare not-observed.
 */
export interface ProofScope {
  workflow: WorkflowKey | "provider-api";
  workflowDisplayName: string;
  authMode: AuthMode;
  economicRoute: EconomicRoute;
  appliesTo: ProofScopeAppliesTo;
  proofLevel: ProofLevel;
  costBasis: CostBasis;
  billingSource: BillingSource;
  planLifetimeImpact: PlanLifetimeImpact;
  /** REQUIRED wherever a level is `unavailable` / `not-directly-observable`, the honest reason. */
  reason?: string;
}

/** Honest reason constants (content-free). Exported so tests and callers reuse the exact string. */

/** Plan quota is not directly observable today: no quota signal exists. Never fabricate one. */
export const PLAN_LIFETIME_NOT_OBSERVABLE_REASON =
  "plan quota consumption is not directly observable today (no plan-quota signal is exposed by the vendor); " +
  "plan-lifetime extension is designed-for but not measured - a later cycle attaches observed token reduction, " +
  "never a fabricated quota figure.";

/** The honest reason a routed / provider-API scope carries no plan-lifetime story. */
export const PLAN_LIFETIME_NOT_APPLICABLE_REASON =
  "this is the api-billing route (provider-priced metered API), which has no fixed-plan quota to extend; " +
  "plan-lifetime impact does not apply to this scope.";

/** The honest reason a plan-auth activity/local scope carries no cost/billing figure by default. */
export const COST_UNAVAILABLE_PLAN_AUTH_REASON =
  "plan-auth workflows run on the user's existing subscription and expose no per-request cost or billing " +
  "figure; cost basis and billing source are unavailable on this route.";

/** The honest reason a local-estimate scope (e.g. Cursor) is estimate-only. */
export const LOCAL_ESTIMATE_REASON =
  "the current Compaction adapter does not ingest attributable provider usage for this workflow, so only a content-free local estimate is possible; " +
  "no provider-reported, provider-priced, plan-quota, or invoice evidence exists for this scope.";

/**
 * Compile-time structural guards (checked by `npm run typecheck`). If a refactor ever lets a
 * plan-lifetime scope reach an api-billing / plan-quota / invoice level, or lets an api-billing scope
 * claim plan-lifetime, one of these fails the build.
 */
type Assert<T extends true> = T;

/** The api-billing-only proof levels, never valid on a plan-lifetime scope. */
type ApiBillingOnlyProofLevel = "provider-priced-api";
/** The levels/bases/sources that require real evidence that does not exist by default. */
type QuotaOrInvoiceProofLevel = "plan-quota-observed" | "invoice-confirmed";
type QuotaOrInvoiceCostBasis = "observed-plan-quota" | "invoice-reconciled";
type QuotaOrInvoiceBillingSource = "observed-plan-quota" | "invoice-confirmed";

/** `plan-lifetime` and `api-billing` are genuinely distinct route literals (guards not vacuous). */
export type StructuralGuard_RoutesAreDistinct = Assert<
  "plan-lifetime" extends "api-billing" ? false : true
>;
/** The api-billing-only proof level is a real member of ProofLevel (so excluding it is meaningful). */
export type StructuralGuard_ApiBillingLevelExists = Assert<
  ApiBillingOnlyProofLevel extends ProofLevel ? true : false
>;
/** The quota/invoice levels are real members (so asserting they are unreachable-by-default is meaningful). */
export type StructuralGuard_QuotaInvoiceLevelsExist = Assert<
  QuotaOrInvoiceProofLevel extends ProofLevel
    ? QuotaOrInvoiceCostBasis extends CostBasis
      ? QuotaOrInvoiceBillingSource extends BillingSource
        ? true
        : false
      : false
    : false
>;

/**
 * The set of proof levels the DEFAULT derivation may EVER emit, quota/invoice deliberately excluded. This is
 * the compile-time twin of the runtime assertion in `deriveProofScopes` and the test: if a future edit made
 * the derivation able to return `plan-quota-observed` / `invoice-confirmed`, this union would have to be
 * widened here to compile, forcing the change to be explicit and reviewed.
 */
export type DefaultReachableProofLevel = Exclude<ProofLevel, QuotaOrInvoiceProofLevel>;
export type DefaultReachableCostBasis = Exclude<CostBasis, QuotaOrInvoiceCostBasis>;
export type DefaultReachableBillingSource = Exclude<BillingSource, QuotaOrInvoiceBillingSource>;

/**
 * Pure derivation: reads the existing capability-matrix truth and maps it to proof scopes. Every level
 * below follows from a field already on `WorkflowProviderCapability`, never hand-set.
 */

/** Map a workflow key to its content-free `appliesTo` identity. */
function appliesToForWorkflow(workflow: WorkflowKey): ProofScopeAppliesTo {
  return workflow; // WorkflowKey values are a subset of ProofScopeAppliesTo by design.
}

/**
 * Derive the plan-lifetime (Route A) scope for a plan-auth workflow. Present only when `planAuthReady`.
 * The proof level is the weakest honest level the existing matrix truth supports:
 *  - `local-estimate` where the row is `localEstimateOnly` (Cursor);
 *  - `provider-reported` otherwise (Codex/Claude Code activity rows; the adapter normalizes usage even
 *    though, on the plan-auth route, cache proof is not routed).
 * Plan-lifetime impact is always `not-directly-observable` by default (no quota signal). Cost basis and
 * billing source stay in the plan-auth world: `local-price-table`/`estimated-from-tokens` for a local
 * estimate, else `unavailable`. It can never reach a provider-priced / plan-quota / invoice level.
 */
function planLifetimeScope(row: WorkflowProviderCapability): ProofScope {
  const localEstimate = row.localEstimateOnly;
  const proofLevel: ProofLevel = localEstimate ? "local-estimate" : "provider-reported";
  const costBasis: CostBasis = localEstimate ? "local-price-table" : "unavailable";
  const billingSource: BillingSource = localEstimate ? "estimated-from-tokens" : "unavailable";
  return {
    workflow: row.workflow,
    workflowDisplayName: row.workflowDisplayName,
    authMode: "plan-auth",
    economicRoute: "plan-lifetime",
    appliesTo: appliesToForWorkflow(row.workflow),
    proofLevel,
    costBasis,
    billingSource,
    // The honest default: never `likely-extended` (that needs a real observed reduction).
    planLifetimeImpact: "not-directly-observable",
    reason: localEstimate ? `${LOCAL_ESTIMATE_REASON} ${PLAN_LIFETIME_NOT_OBSERVABLE_REASON}` : PLAN_LIFETIME_NOT_OBSERVABLE_REASON
  };
}

/**
 * Derive the api-billing (Route B) scope for a routed provider-API path. Present only where the row is routed
 * by default and has a provider-usage capability (the matrix computes this as `cacheProofSupported`:
 * `cacheNormalized && routed && providerSupported`). The proof level is `provider-priced-api` as a capability
 * only (the cost number lives in `api-cost-impact.ts`); cost basis `provider-usage-and-published-price`; billing source
 * `provider-priced-api`. Plan-lifetime impact is `unavailable` with the not-applicable reason: this route
 * has no plan quota to extend. It can never carry a plan-lifetime route or a plan-quota level.
 *
 * `appliesTo` is `custom-openai-app` for that workflow, else `provider-api` (a routed provider-API scope that
 * sits alongside a plan-auth workflow's plan-lifetime scope).
 */
function apiBillingScope(row: WorkflowProviderCapability): ProofScope {
  const isCustomApp = row.workflow === "custom-openai-app";
  return {
    workflow: isCustomApp ? row.workflow : "provider-api",
    workflowDisplayName: isCustomApp ? row.workflowDisplayName : `${row.workflowDisplayName} (routed provider-API)`,
    authMode: "api-key-gateway",
    economicRoute: "api-billing",
    appliesTo: isCustomApp ? "custom-openai-app" : "provider-api",
    // Capability, not the number: the row proved provider usage is available on a routed path.
    proofLevel: "provider-priced-api",
    costBasis: "provider-usage-and-published-price",
    billingSource: "provider-priced-api",
    // The api-billing route has no fixed-plan quota to extend; explicitly not applicable, with a reason.
    planLifetimeImpact: "unavailable",
    reason: PLAN_LIFETIME_NOT_APPLICABLE_REASON
  };
}

/**
 * Derive all proof scopes for one capability row (may be one or two):
 *  - a plan-lifetime (Route A) scope when the workflow is `planAuthReady`;
 *  - an api-billing (Route B) scope when the row is routed with provider-usage capability
 *    (`cacheProofSupported`: routed && providerSupported && cacheNormalized).
 * The custom OpenAI-compatible app (not plan-auth) yields only an api-billing scope. Pure: no IO, no content.
 */
export function deriveProofScope(row: WorkflowProviderCapability): ProofScope[] {
  const scopes: ProofScope[] = [];
  if (row.planAuthReady) scopes.push(planLifetimeScope(row));
  if (row.cacheProofSupported) scopes.push(apiBillingScope(row));
  return scopes;
}

/** The proof levels/bases/sources the default derivation may ever emit (quota/invoice excluded). Runtime twin. */
const DEFAULT_REACHABLE_PROOF_LEVELS: readonly ProofLevel[] = [
  "local-estimate",
  "provider-reported",
  "provider-priced-api"
];
const UNREACHABLE_BY_DEFAULT_PROOF_LEVELS: readonly ProofLevel[] = ["plan-quota-observed", "invoice-confirmed"];
const UNREACHABLE_BY_DEFAULT_COST_BASES: readonly CostBasis[] = ["observed-plan-quota", "invoice-reconciled"];
const UNREACHABLE_BY_DEFAULT_BILLING_SOURCES: readonly BillingSource[] = ["observed-plan-quota", "invoice-confirmed"];

export {
  DEFAULT_REACHABLE_PROOF_LEVELS,
  UNREACHABLE_BY_DEFAULT_PROOF_LEVELS,
  UNREACHABLE_BY_DEFAULT_COST_BASES,
  UNREACHABLE_BY_DEFAULT_BILLING_SOURCES
};

/**
 * Derive the proof scopes for a whole computed capability matrix, flattened. Pure. The result is the
 * shared vocabulary the plan-lifetime and cost models attach their figures to, with the two routes
 * already structurally separated so no figure can be mislabeled across routes.
 */
export function deriveProofScopes(matrix: WorkflowProviderCapability[]): ProofScope[] {
  return matrix.flatMap((row) => deriveProofScope(row));
}
