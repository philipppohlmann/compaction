/**
 * LOCAL, CONTENT-FREE API EXPORT for dashboard/app ingestion (PUBLIC CLI/SDK code, engine-free).
 *
 * Emits ONE typed, content-free JSON document so the dashboard/app can consume the SAME truth the CLI
 * already shows (`gateway status` / `gateway proof` / `gateway capabilities` / `activity`), WITHOUT any
 * duplicate interpretation logic that could drift from the Gateway state. Every field is produced by
 * CALLING an EXISTING reader/summarizer; this module recomputes NOTHING (no token math, no capability logic).
 *
 * CONTENT-FREE BY CONSTRUCTION: it only READS the already-content-free local `.compaction/*` stores
 *   - receipts + gateway status + cache summary (`status.ts` / `cache-proof.ts`, counts/labels only),
 *   - metrics-only activity events (`activity-store.ts`, write-time allowlisted, string-bounded),
 *   - content-free live-verification records (`verification-store.ts`, provider id / boolean / percent),
 * and computes the capability matrix (`capability-matrix.ts`, booleans / honesty labels / reasons only).
 * There is NO field on this document that can carry prompt/response/tool content or a credential, the type
 * is the structural guarantee. It is a PURE export/print: it makes NO network call, performs NO upload/
 * telemetry, and writes NOTHING (the CLI's optional `--out` writes only to the operator-specified path).
 *
 * Claim boundary: this document only carries the honesty-labeled fields the stores already hold
 * (`token_source`, `cache_source`, `liveVerified`, `bestReduction` availability/reason, capability
 * `reasons`, etc.). It makes NO billing-confirmed / invoice / cost / output-token / semantic / all-provider
 * claim, and no savings projection, it adds no interpretation of its own.
 *
 * TWO ECONOMIC PROOF ROUTES, STRUCTURALLY SEPARATE. The document CALLS the pure derivers (no recomputation):
 *   • `proof_scopes`, `deriveProofScopes(capabilities)`: the shared, content-free per-workflow proof
 *     vocabulary (economic_route / auth_mode / proof_level / cost_basis / billing_source /
 *     plan_lifetime_impact). Route A (`plan-lifetime`) and Route B (`api-billing`) are separate records.
 *   • `plan_lifetime`, Route A ONLY (`buildPlanLifetimeImpactsFromActivity(activity)`): the honest
 *     token-load / plan-quota story for the plan-auth workflows. Quota is `not-observable`; a record is
 *     `likely-extended` ONLY on a REAL observed token reduction (honestly labeled), never a quota reading.
 *   • Route B's provider-priced API cost impact rides on the EXISTING `verifications[]` records (each
 *     `GatewayCacheVerification` may carry `provider_priced_cost_impact`, an ESTIMATE basis pinned to a
 *     pricing version, NEVER invoice-confirmed). The export surfaces it as-is (no restatement).
 * Route A never carries a provider-priced / plan-quota / invoice figure; Route B never carries a
 * plan-lifetime / plan-quota figure. `invoice-confirmed` is unreachable by construction (no evidence).
 * LOCAL EXPORT ONLY: no network, no upload, no telemetry, the dashboard reads the exported file / the
 * typed `dashboard-contract.ts` contract; a live sync/API server is a clearly-scoped future step.
 */
import { getGatewayStatus, readReceipts, type GatewayStatus } from "./gateway/status.js";
import { summarizeCacheProof, type CacheProofSummary } from "./gateway/cache-proof.js";
import type { GatewayReceipt } from "./gateway/receipt.js";
import {
  computeCapabilityMatrix,
  type WorkflowProviderCapability
} from "./gateway/capability-matrix.js";
import {
  liveVerificationsForMatrix,
  readVerifications,
  type GatewayCacheVerification
} from "./gateway/verification-store.js";
import { readActivityEvents, DEFAULT_ACTIVITY_DIRECTORY } from "./activity-store.js";
import type { ActivityEvent } from "./activity-event.js";
import { deriveProofScopes, type ProofScope } from "./gateway/proof-scope.js";
import { buildPlanLifetimeImpactsFromActivity, type PlanLifetimeImpactRecord } from "./plan-lifetime.js";
import { join } from "node:path";

/**
 * Pinned schema version so the dashboard can pin/detect the document shape. Bump on any field change.
 * v2 added `proof_scopes` (Route A + B shared vocabulary) and `plan_lifetime` (Route A); the Route-B
 * `provider_priced_cost_impact` flows through on `verifications[]`.
 */
export const API_EXPORT_SCHEMA_VERSION = "2";

/**
 * The ONE typed, content-free export document. Every member is the OUTPUT of an existing reader/summarizer -
 * no field is computed here beyond assembling them. The dashboard reads exactly what the CLI shows.
 */
export interface ApiExportDocument {
  /** Pinned document-shape version (see `API_EXPORT_SCHEMA_VERSION`). */
  schema_version: string;
  /** ISO timestamp the document was generated (a stamp only, no telemetry, no identity). */
  generated_at: string;
  /** From `getGatewayStatus`, running flag + content-free receipt rollup (includes `summary`). */
  gateway_status: GatewayStatus;
  /** From `summarizeCacheProof(receipts)`, the same content-free cache-proof summary `gateway proof` uses. */
  cache_summary: CacheProofSummary;
  /** From `readReceipts`, the raw content-free receipts (counts/labels only; no content, no keys). */
  receipts: GatewayReceipt[];
  /** From `readActivityEvents`, metrics-only activity events (write-time allowlisted, content-free). */
  activity: ActivityEvent[];
  /**
   * From `readVerifications`, content-free live-verification records (provider/boolean/percent/reason).
   * ROUTE B: each record MAY carry `provider_priced_cost_impact` (provider-priced API cost impact, an
   * ESTIMATE basis pinned to a pricing version, NEVER invoice-confirmed). Surfaced as-is (no restatement).
   */
  verifications: GatewayCacheVerification[];
  /** From `computeCapabilityMatrix({verifications: liveVerificationsForMatrix(cwd)})`, same as `capabilities`. */
  capabilities: WorkflowProviderCapability[];
  /**
   * From `deriveProofScopes(capabilities)`, the shared, content-free per-workflow proof vocabulary. Each
   * scope names its `economicRoute` (`plan-lifetime` = Route A, `api-billing` = Route B), `authMode`,
   * `proofLevel`, `costBasis`, `billingSource`, and `planLifetimeImpact`. The two routes are SEPARATE
   * records, a plan-lifetime scope can never carry a provider-priced / plan-quota / invoice level. No
   * recomputation: derived purely from the SAME `capabilities` matrix above.
   */
  proof_scopes: ProofScope[];
  /**
   * ROUTE A ONLY. From `buildPlanLifetimeImpactsFromActivity(activity)`, one honest plan-lifetime record
   * per plan-auth workflow (codex / claude-code / cursor). `plan_quota_signal` is ALWAYS `not-observable`
   * (no vendor exposes a readable quota signal); `plan_lifetime_impact` is `likely-extended` ONLY on a REAL
   * observed token reduction (an inference from token counts, honestly labeled, never a quota reading),
   * else the honest not-observable default. Carries NO provider-priced / invoice / cost figure.
   */
  plan_lifetime: PlanLifetimeImpactRecord[];
}

/** Options for `buildApiExport`, injectable clock only (default `Date.now`-based ISO). Pure otherwise. */
export interface BuildApiExportOptions {
  /** Injectable stamp for deterministic tests; default `new Date().toISOString()`. */
  now?: () => string;
}

/**
 * Assemble the content-free export document by CALLING the existing readers/summarizers for `cwd`. Recomputes
 * nothing: `cache_summary` is `summarizeCacheProof` over the SAME receipts `gateway proof`/`status` use, and
 * `capabilities` is the SAME `computeCapabilityMatrix(...)` call `gateway capabilities` makes, so the
 * document can never diverge from the CLI. Local read-only; no network; writes nothing. Never throws on empty
 * stores (each reader returns an empty-but-typed value), yielding a valid empty-but-typed document.
 */
export async function buildApiExport(
  cwd: string = process.cwd(),
  options: BuildApiExportOptions = {}
): Promise<ApiExportDocument> {
  const now = options.now ?? (() => new Date().toISOString());

  // Reuse the exact readers/summarizers the CLI surfaces already use (no recomputation, no divergence).
  const receipts = readReceipts(cwd);
  const gateway_status = await getGatewayStatus(cwd);
  const cache_summary = summarizeCacheProof(receipts);
  const { events: activity } = await readActivityEvents(join(cwd, DEFAULT_ACTIVITY_DIRECTORY));
  const verifications = readVerifications(cwd);
  const capabilities = computeCapabilityMatrix({ verifications: liveVerificationsForMatrix(cwd) });
  // The shared proof vocabulary + Route-A plan-lifetime, both by CALLING the pure derivers over data we
  // already read (no recomputation, no divergence). Route B rides on `verifications[]` (each may carry
  // `provider_priced_cost_impact`), no separate assembly here.
  const proof_scopes = deriveProofScopes(capabilities);
  const plan_lifetime = buildPlanLifetimeImpactsFromActivity(activity);

  return {
    schema_version: API_EXPORT_SCHEMA_VERSION,
    generated_at: now(),
    gateway_status,
    cache_summary,
    receipts,
    activity,
    verifications,
    capabilities,
    proof_scopes,
    plan_lifetime
  };
}
