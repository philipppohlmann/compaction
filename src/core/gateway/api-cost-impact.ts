/**
 * Compaction PROVIDER-PRICED API COST-IMPACT model (PUBLIC CLI/SDK code, engine-free, ships in the npm
 * package).
 *
 * ROUTE B ONLY (`economic_route: "api-billing"`). This answers ONE question, honestly:
 *   "Did I reduce my PAID API cost through provider cache/compaction on API/Gateway traffic routed through
 *    `compaction gateway` (my own OpenAI/Anthropic key)?"
 * It computes a PROVIDER-PRICED API COST IMPACT = (provider-reported token usage) × (explicit published
 * price). That is a labeled ESTIMATE basis (`provider-usage-and-published-price`), pinned to an explicit
 * `pricing_version`. It is **NEVER invoice-confirmed**, `invoice_confirmed` is a frozen `"unavailable"`
 * literal here; no invoice/accounting evidence exists. It reuses the EXISTING price table + `calculateCost`
 * (it does NOT rebuild pricing).
 *
 * Claim boundary (enforced by construction + tests):
 *  - Route B ≠ Route A. This function takes ONLY Gateway receipts (the api-billing route) and emits ONLY
 *    `economic_route: "api-billing"`. There is NO field on the result that can carry a plan-lifetime /
 *    plan-quota / plan-auth figure. It can NEVER be generalized to Codex / Claude Code / Cursor plan-auth
 *    usage. The types are the structural guarantee.
 *  - `invoice_confirmed` is ALWAYS `"unavailable"`. Provider-priced ≠ invoice-confirmed. Never claim a
 *    billing-confirmed / invoice savings figure from token receipts.
 *  - Missing provider usage / cache / pricing / model → the WHOLE cost impact is `unavailable` WITH a
 *    concrete `reason`, NEVER a fabricated zero.
 *  - CONTENT-FREE: every field is a number, an enum LABEL, a version string, or an honest reason string.
 *    No field can carry prompt/response/tool content or a credential.
 */
import { calculateCost } from "../cost-calculator.js";
import { getModelPricing, hasModelPricing, PRICING_VERSION } from "../pricing.js";
import type { GatewayReceipt } from "./receipt.js";

const TOKENS_PER_MILLION = 1_000_000;

/**
 * The provider-PRICED cost reduction (USD) of an APPLY receipt's model-visible input compaction, for the
 * per-turn receipt line's `−$X (est)` value clause. It is COMPUTED, never hardcoded:
 *
 *   costReductionUsd = (estimated_input_tokens_before − estimated_input_tokens_after) / 1e6 × inputPerMillionUsd(model)
 *
 * i.e. the receipt's own model-visible before→after input-token delta (a chars/4 LOCAL ESTIMATE, the same
 * number the line's `−PP%` renders) priced at the explicit published INPUT rate from the versioned price
 * table (`pricing.ts`). Change the price table → this number changes (proved by a test), so it can never be
 * a hardcoded constant.
 *
 * Honesty / claim boundary (matches the `(est)` label the line renders):
 *  - This is an ESTIMATE basis: the token delta is a local chars/4 estimate and the price is a published
 *    list price, NOT an invoice. The un-compacted request was ALSO never actually sent (no per-turn
 *    counterfactual), so this is what the applied reduction WOULD save at list price — never billing-confirmed.
 *  - Returns `undefined` (⇒ the line OMITS the clause) whenever any input is missing: the request was not
 *    actually mutated, the before/after model-visible estimates are absent, the model is not in the price
 *    table, or the delta is not a positive number. NEVER a fabricated `−$0`.
 *
 * Content-free: consumes only the receipt's numeric before/after and the content-free model label.
 */
export function applyInputCostReductionUsd(receipt: GatewayReceipt): number | undefined {
  if (receipt.request_mutated !== true) return undefined;
  const before = receipt.estimated_input_tokens_before;
  const after = receipt.estimated_input_tokens_after;
  if (typeof before !== "number" || typeof after !== "number") return undefined;
  if (!Number.isFinite(before) || !Number.isFinite(after)) return undefined;
  const deltaTokens = before - after;
  if (deltaTokens <= 0) return undefined;
  // No honest published-price basis for an unknown model → OMIT (never a fabricated zero).
  if (!hasModelPricing(receipt.model)) return undefined;
  const inputPerMillionUsd = getModelPricing(receipt.model).inputPerMillionUsd;
  const usd = (deltaTokens / TOKENS_PER_MILLION) * inputPerMillionUsd;
  if (!Number.isFinite(usd) || usd <= 0) return undefined;
  return usd;
}

/** The two paired Gateway receipts of one proof run (same `proof_run_id`): a cold baseline + a warm repeat. */
export interface ApiCostImpactInput {
  /** The COLD baseline gateway receipt (nothing served from the provider cache). */
  baseline: GatewayReceipt;
  /** The WARM/compacted gateway receipt (part of the input served from the provider prompt cache). */
  warm: GatewayReceipt;
  /** The request model label (content-free metadata) used to price both receipts against the SAME model. */
  requestModel: string;
}

/**
 * The provider-priced API cost-impact result. Undefined numeric axes mean UNAVAILABLE (never a silent zero);
 * whenever any axis is unavailable a `reason` is present. `invoice_confirmed` is ALWAYS `"unavailable"`.
 */
export interface ApiCostImpact {
  provider: string;
  model: string;
  /** This model runs ONLY on the routed API-key path. */
  auth_mode: "api-key-gateway";
  /** ROUTE B. Never plan-lifetime. */
  economic_route: "api-billing";
  /** The traffic this figure applies to, API/Gateway only. */
  traffic_path: "compaction-gateway";
  token_source: "provider-reported" | "unavailable";
  cache_source: "provider-reported" | "unavailable";
  /** Present ONLY when provider-reported. `undefined` = unavailable (never a silent zero). */
  input_tokens?: number;
  cached_input_tokens?: number;
  cache_write_tokens?: number;
  output_tokens?: number;
  /** The pinned price-table version the cost figure was computed against (estimate basis). */
  pricing_version: string;
  cost_basis: "provider-usage-and-published-price" | "unavailable";
  baseline_cost_usd?: number;
  warm_cost_usd?: number;
  /** baseline − warm. Positive = warm cost less. `undefined` = unavailable (never a fabricated zero). */
  provider_priced_api_cost_impact_usd?: number;
  provider_priced_api_cost_impact_pct?: number;
  proof_level: "provider-priced-api" | "unavailable";
  billing_source: "provider-priced-api" | "unavailable";
  /** ALWAYS `"unavailable"`, provider-priced is NOT invoice-confirmed. Frozen literal; never computed. */
  invoice_confirmed: "unavailable";
  /** REQUIRED whenever any axis is unavailable, the honest why (never a bare unavailable). */
  reason?: string;
}

/**
 * The single unavailable-with-reason result. Route B labels are preserved (economic_route/auth_mode/
 * traffic_path/pricing_version) so a downstream reader always sees this is the api-billing route, but every
 * cost/token axis is honestly unavailable and `invoice_confirmed` stays the frozen `"unavailable"` literal.
 */
function unavailable(provider: string, model: string, reason: string): ApiCostImpact {
  return {
    provider,
    model,
    auth_mode: "api-key-gateway",
    economic_route: "api-billing",
    traffic_path: "compaction-gateway",
    token_source: "unavailable",
    cache_source: "unavailable",
    pricing_version: PRICING_VERSION,
    cost_basis: "unavailable",
    proof_level: "unavailable",
    billing_source: "unavailable",
    invoice_confirmed: "unavailable",
    reason
  };
}

/**
 * Price ONE gateway receipt against `model` using the EXISTING `calculateCost` (no rebuilt pricing).
 * Maps the content-free provider-reported receipt axes to the cost calculator:
 *   - `input_tokens`  = billed_fresh_input if reported, else (prompt_input − cached_input), the input NOT
 *      served from the provider prompt cache, priced at the standard input rate.
 *   - cache-READ tokens = cached_input, the portion served from the provider prompt cache, priced at the
 *      cache-read rate (10% of input by convention when a model has no explicit cache-read price).
 *   - `output_tokens` = output.
 * The record-mode receipt carries NO cache-CREATION (write) axis, so cache_write is undefined (not zero).
 */
function receiptCost(receipt: GatewayReceipt, model: string): {
  totalCostUsd: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
} {
  const promptInput = receipt.tokens.prompt_input ?? 0;
  const cachedInput = receipt.tokens.cached_input ?? 0;
  const output = receipt.tokens.output ?? 0;
  const freshInput =
    receipt.tokens.billed_fresh_input !== undefined
      ? receipt.tokens.billed_fresh_input
      : Math.max(0, promptInput - cachedInput);

  const cost = calculateCost(
    model,
    { inputTokens: freshInput, outputTokens: output, totalTokens: freshInput + output },
    { cacheReadTokens: cachedInput }
  );
  return {
    totalCostUsd: cost.totalCostUsd,
    inputTokens: freshInput,
    cachedInputTokens: cachedInput,
    outputTokens: output
  };
}

/** True only when a receipt carries provider-reported token usage AND a provider-reported cache axis. */
function receiptUsable(r: GatewayReceipt): boolean {
  return r.token_source === "provider-reported" && r.cache_source === "provider-reported";
}

/**
 * Compute the PROVIDER-PRICED API cost impact for one proof run from its paired Gateway receipts.
 *
 * Returns the full impact ONLY when: BOTH receipts are provider-reported (usage + cache) AND they share the
 * SAME `proof_run_id` AND the model is in the explicit price table. Any of those missing → `unavailable`
 * WITH a concrete reason (never a fabricated zero). Route B only; the result can carry NOTHING plan-auth.
 */
export function computeApiCostImpact(input: ApiCostImpactInput): ApiCostImpact {
  const { baseline, warm, requestModel } = input;
  const provider = baseline.provider ?? warm.provider ?? "unknown";
  const model = requestModel;

  // The two receipts must belong to the SAME proof run (structurally pair a cold baseline + warm repeat).
  if (
    baseline.proof_run_id === undefined ||
    warm.proof_run_id === undefined ||
    baseline.proof_run_id !== warm.proof_run_id
  ) {
    return unavailable(
      provider,
      model,
      "provider-priced API cost impact unavailable: the baseline and warm receipts are not paired by a single proof-run id."
    );
  }

  // Both receipts must carry provider-reported usage, a local estimate is NOT priceable as provider cost.
  if (!receiptUsable(baseline) || !receiptUsable(warm)) {
    return unavailable(
      provider,
      model,
      "provider-priced API cost impact unavailable: one or both receipts lack provider-reported token/cache usage (the provider did not report usage/cache), so no provider-priced cost can be computed."
    );
  }

  // The model must be in the explicit price table, otherwise there is no honest published-price basis.
  if (!hasModelPricing(model)) {
    return unavailable(
      provider,
      model,
      `provider-priced API cost impact unavailable: model '${model}' is not in the explicit price table (pricing version ${PRICING_VERSION}), so no published-price basis exists - no fabricated cost is emitted.`
    );
  }

  const base = receiptCost(baseline, model);
  const warmCost = receiptCost(warm, model);
  const deltaUsd = base.totalCostUsd - warmCost.totalCostUsd;
  const deltaPct = base.totalCostUsd > 0 ? Math.round((deltaUsd / base.totalCostUsd) * 1000) / 10 : 0;

  return {
    provider,
    model,
    auth_mode: "api-key-gateway",
    economic_route: "api-billing",
    traffic_path: "compaction-gateway",
    token_source: "provider-reported",
    cache_source: "provider-reported",
    input_tokens: warmCost.inputTokens,
    cached_input_tokens: warmCost.cachedInputTokens,
    // The record-mode receipt carries no cache-creation (write) axis, honestly undefined, not a zero.
    cache_write_tokens: undefined,
    output_tokens: warmCost.outputTokens,
    pricing_version: PRICING_VERSION,
    cost_basis: "provider-usage-and-published-price",
    baseline_cost_usd: base.totalCostUsd,
    warm_cost_usd: warmCost.totalCostUsd,
    provider_priced_api_cost_impact_usd: deltaUsd,
    provider_priced_api_cost_impact_pct: deltaPct,
    proof_level: "provider-priced-api",
    billing_source: "provider-priced-api",
    // ALWAYS unavailable, provider-priced is an ESTIMATE basis, never invoice-confirmed.
    invoice_confirmed: "unavailable"
  };
}
