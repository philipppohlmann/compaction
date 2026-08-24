/**
 * Compaction DASHBOARD DATA CONTRACT (PUBLIC CLI/SDK code, engine-free, ships in the npm package).
 *
 * The SMALLEST coherent dashboard ingestion path. A PURE, content-free adapter that maps
 * the v2 `ApiExportDocument` (the local `compaction api export` output) onto the ACCEPTED `/app`
 * source-status tiers, `live (provider-reported)` | `estimated (local-estimate)` | fallback, plus the
 * two-route economic-proof distinction. The dashboard consumes THIS typed contract instead of
 * reinterpreting the raw stores, so the CLI and the dashboard show the SAME content-free truth and can
 * never drift. The boundary is the schema-versioned typed contract; there is NO live API server, NO
 * upload, and NO telemetry (that would be a separate, clearly-scoped future step).
 *
 * NO REINTERPRETATION: every field is COPIED from an honesty label the source models already produced
 * (`ProofScope.economicRoute` / `proofLevel` / `costBasis` / `billingSource` / `planLifetimeImpact`;
 * `PlanLifetimeImpactRecord`; `WorkflowProviderCapability.liveVerified`; `ProviderPricedCostImpact`). It
 * runs NO token math, NO cost math, NO capability logic, and NEVER UPGRADES a label, a `local-estimate`
 * source is never rendered `provider-reported`; a `not-directly-observable` plan-lifetime impact is never
 * rendered `live`; `invoice-confirmed` is never emitted (the sources never produce it).
 *
 * WHY REPO-SIDE (not `apps/web`): `apps/web/src/lib/source-status.ts` is the typed `/app` contract but the
 * `apps/web` tree is Lovable-managed (overwrite risk). This adapter lives on the repo core side (in the
 * compiled npm package) so the mapping is versioned + tested here; wiring it into `apps/web` is
 * coordination-gated (Lovable) and is a deliberate NON-GOAL of this cycle. The tier vocabulary below
 * MIRRORS the binding app source-status contract verbatim, it does not weaken it.
 *
 * CONTENT-FREE BY CONSTRUCTION: `ApiExportDocument` is content-free (see `api-export.ts`); this adapter
 * only reads its labels and counts and emits enum labels + honest reasons. No field can carry
 * prompt/response/tool content or a credential.
 */
import type { ApiExportDocument } from "./api-export.js";
import type { ProofScope, EconomicRoute } from "./gateway/proof-scope.js";
import type { PlanLifetimeImpactRecord } from "./plan-lifetime.js";
import type { ProviderPricedCostImpact } from "./gateway/verification-store.js";

/** Pinned contract version. Tracks the `ApiExportDocument` schema it consumes (v2). */
export const DASHBOARD_CONTRACT_VERSION = "2";

/**
 * The `/app` source-status integration tier (verbatim from `app-source-status-contract.md`):
 *  - `live`     , real provider-reported usage (a live-verified provider-priced/reported scope);
 *  - `estimated`, a content-free local estimate / provider-reported-but-not-live scope exists;
 *  - `fallback` , no records / not integrated (never rendered as live).
 * Mirrored here (NOT imported from `apps/web`, which is Lovable-managed) so the repo owns + tests it.
 */
export type DashboardIntegrationTier = "live" | "estimated" | "fallback";

/** The exact copy-spec tier strings (mirror of `app-source-status-contract.md`; do NOT reword). */
export const DASHBOARD_TIER_LIVE = "live (provider-reported)";
export const DASHBOARD_TIER_ESTIMATED = "estimated (local-estimate)";
export const DASHBOARD_TIER_FALLBACK = "no records yet / not integrated";

/** The tier chip string for a tier (the same three copy-spec strings the `/app` view renders). */
export function dashboardTierLabel(tier: DashboardIntegrationTier): string {
  if (tier === "live") return DASHBOARD_TIER_LIVE;
  if (tier === "estimated") return DASHBOARD_TIER_ESTIMATED;
  return DASHBOARD_TIER_FALLBACK;
}

/**
 * ONE dashboard-consumable proof-scope row. Every field is COPIED from the source `ProofScope` + the
 * capability row's `liveVerified`, no field is recomputed. `tier` is the `/app` integration tier this
 * scope maps to; the economic-route labels are carried through UNCHANGED so the dashboard keeps Route A
 * and Route B separate exactly as the CLI does.
 */
export interface DashboardProofScopeRow {
  workflow: string;
  workflowDisplayName: string;
  appliesTo: string;
  /** Route A (`plan-lifetime`) vs Route B (`api-billing`), carried through, never conflated. */
  economicRoute: EconomicRoute;
  authMode: string;
  /** The `/app` tier this scope maps to (never upgraded past the scope's honest proof level). */
  tier: DashboardIntegrationTier;
  tierLabel: string;
  /** The scope's honest labels, copied verbatim (no reinterpretation). */
  proofLevel: string;
  costBasis: string;
  billingSource: string;
  planLifetimeImpact: string;
  reason?: string;
  /**
   * ROUTE B ONLY. The provider-priced API cost impact copied from the matching verification record (an
   * ESTIMATE basis, NEVER invoice-confirmed). Absent on Route A and where no verification carried one.
   */
  providerPricedCostImpact?: ProviderPricedCostImpact;
}

/** The full typed contract the dashboard ingests, the SAME content-free truth the CLI shows. */
export interface DashboardContract {
  /** Mirrors the source `ApiExportDocument.schema_version` (v2). */
  schema_version: string;
  contract_version: string;
  generated_at: string;
  /** Per-scope rows (Route A + Route B, kept separate). Reuses the export's `proof_scopes`. */
  proof_scopes: DashboardProofScopeRow[];
  /** ROUTE A plan-lifetime records, carried through UNCHANGED (already dashboard-ready honest labels). */
  plan_lifetime: PlanLifetimeImpactRecord[];
  /**
   * The honest boundary statement the dashboard should surface: this is a LOCAL export only (content-free,
   * no upload/telemetry); the dashboard reads the exported file / this typed contract.
   */
  ingestion_note: typeof DASHBOARD_INGESTION_NOTE;
}

/** The honest local-export-only boundary note (surfaced by the CLI + carried into the contract). */
export const DASHBOARD_INGESTION_NOTE =
  "Local export only: this content-free document is produced by `compaction api export` on the operator's " +
  "machine. There is no upload, no telemetry, and no live API server - the dashboard reads the exported " +
  "file / this typed contract. Route A (plan-lifetime) and Route B (api-billing provider-priced) stay " +
  "separate; no figure is invoice-confirmed.";

/**
 * Map ONE proof scope to its `/app` integration tier WITHOUT upgrading its honest level:
 *  - `live`     , the scope reached a provider-priced-API proof level AND the workflow is live-verified
 *                  (a REAL passing verification recorded provider-reported cache). Provider-priced
 *                  CAPABILITY alone (no live verification) is NOT rendered live.
 *  - `estimated`, a provider-reported / local-estimate scope exists but is not live-verified.
 *  - `fallback` , the scope carries no usable evidence (should not occur for a derived scope, but the
 *                  honest default if the labels ever say so).
 */
function tierForScope(scope: ProofScope, liveVerified: boolean): DashboardIntegrationTier {
  if (scope.proofLevel === "provider-priced-api" && liveVerified) return "live";
  if (scope.proofLevel === "provider-reported" || scope.proofLevel === "provider-priced-api") return "estimated";
  if (scope.proofLevel === "local-estimate") return "estimated";
  return "fallback";
}

/**
 * Is the workflow behind this scope live-verified? Copied from the SAME capability matrix the export
 * carries, the api-billing scope's `custom-openai-app` maps to its capability row; a routed
 * `provider-api` scope maps to whichever capability row is `cacheProofSupported && liveVerified`.
 */
function scopeIsLiveVerified(scope: ProofScope, doc: ApiExportDocument): boolean {
  if (scope.economicRoute !== "api-billing") return false; // Route A is never live-verified (no routing).
  if (scope.workflow === "custom-openai-app") {
    return doc.capabilities.some((c) => c.workflow === "custom-openai-app" && c.liveVerified === true);
  }
  // A routed provider-API scope sits alongside a plan-auth workflow; it is live only if SOME routed row
  // is live-verified (the export's capability matrix is the single source of that truth).
  return doc.capabilities.some((c) => c.cacheProofSupported && c.liveVerified === true);
}

/**
 * Find the Route-B provider-priced cost impact (if any) for an api-billing scope, copied from the
 * verification records the export already carries. Returns the LATEST record's impact for a verified
 * provider; absent when none was recorded (never fabricated). Route A never receives one.
 */
function providerPricedImpactForScope(
  scope: ProofScope,
  doc: ApiExportDocument
): ProviderPricedCostImpact | undefined {
  if (scope.economicRoute !== "api-billing") return undefined;
  const withImpact = doc.verifications
    .filter((v) => v.provider_priced_cost_impact !== undefined)
    .sort((a, b) => (a.observed_at < b.observed_at ? -1 : 1));
  const latest = withImpact[withImpact.length - 1];
  return latest?.provider_priced_cost_impact;
}

/**
 * Adapt a v2 `ApiExportDocument` into the typed dashboard contract. PURE: it copies honest labels and
 * counts and derives only the `/app` tier from the scope's already-honest proof level + the export's own
 * live-verification truth. It NEVER upgrades a label, NEVER recomputes a metric, and NEVER emits an
 * invoice-confirmed figure. Route A and Route B stay separate exactly as in the export.
 */
export function toDashboardContract(doc: ApiExportDocument): DashboardContract {
  const proof_scopes: DashboardProofScopeRow[] = doc.proof_scopes.map((scope) => {
    const liveVerified = scopeIsLiveVerified(scope, doc);
    const tier = tierForScope(scope, liveVerified);
    const providerPriced = providerPricedImpactForScope(scope, doc);
    return {
      workflow: String(scope.workflow),
      workflowDisplayName: scope.workflowDisplayName,
      appliesTo: scope.appliesTo,
      economicRoute: scope.economicRoute,
      authMode: scope.authMode,
      tier,
      tierLabel: dashboardTierLabel(tier),
      proofLevel: scope.proofLevel,
      costBasis: scope.costBasis,
      billingSource: scope.billingSource,
      planLifetimeImpact: scope.planLifetimeImpact,
      ...(scope.reason !== undefined ? { reason: scope.reason } : {}),
      ...(providerPriced !== undefined ? { providerPricedCostImpact: providerPriced } : {})
    };
  });

  return {
    schema_version: doc.schema_version,
    contract_version: DASHBOARD_CONTRACT_VERSION,
    generated_at: doc.generated_at,
    proof_scopes,
    // Route A records are already dashboard-ready honest labels, carried through unchanged.
    plan_lifetime: doc.plan_lifetime,
    ingestion_note: DASHBOARD_INGESTION_NOTE
  };
}
