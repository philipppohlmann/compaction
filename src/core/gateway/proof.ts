/**
 * Gateway proof comparison, content-free before/after math over local receipts only.
 * OpenAI-only proof harness: compares two receipts with the same proof_run_id and variants
 * `baseline` and `compacted`, using provider-reported usage fields only.
 */
import type { GatewayReceipt } from "./receipt.js";

export type ProofVariant = "baseline" | "compacted";

export interface ProofReceiptSummary {
  proofRunId?: string;
  variant?: ProofVariant;
  inputTokens?: number;
  cachedTokens?: number;
  tokenSource?: string;
  cacheSource?: string;
}

export interface GatewayProofDelta {
  available: boolean;
  baselineFound: boolean;
  compactedFound: boolean;
  beforeInputTokens?: number;
  beforeCachedTokens?: number;
  beforeFreshInputTokens?: number;
  afterInputTokens?: number;
  afterCachedTokens?: number;
  afterFreshInputTokens?: number;
  freshInputReductionAbsolute?: number;
  freshInputReductionPercent?: number;
  reasons: string[];
}

export function proofSummaryFromReceipt(receipt: GatewayReceipt): ProofReceiptSummary {
  return {
    ...(receipt.proof_run_id ? { proofRunId: receipt.proof_run_id } : {}),
    ...(receipt.proof_variant === "baseline" || receipt.proof_variant === "compacted" ? { variant: receipt.proof_variant } : {}),
    ...(receipt.tokens?.prompt_input !== undefined ? { inputTokens: receipt.tokens.prompt_input } : {}),
    ...(receipt.tokens?.cached_input !== undefined ? { cachedTokens: receipt.tokens.cached_input } : {}),
    tokenSource: receipt.token_source,
    cacheSource: receipt.cache_source
  };
}

export function compareGatewayProof(params: {
  proofRunId: string;
  baseline?: ProofReceiptSummary;
  compacted?: ProofReceiptSummary;
}): GatewayProofDelta {
  const reasons: string[] = [];
  const before = params.baseline;
  const after = params.compacted;
  if (!before) reasons.push("baseline receipt not found");
  if (!after) reasons.push("compacted receipt not found");
  for (const [label, r] of [["baseline", before], ["compacted", after]] as const) {
    if (!r) continue;
    if (r.proofRunId !== params.proofRunId) reasons.push(`${label} proofRunId mismatch`);
    if (r.variant !== label) reasons.push(`${label} receipt variant missing or mismatched`);
    if (r.tokenSource !== "provider-reported" || r.inputTokens === undefined) reasons.push(`${label} provider did not return usage/input tokens`);
    if (r.cacheSource !== "provider-reported" || r.cachedTokens === undefined) reasons.push(`${label} provider did not return cached_tokens`);
  }
  const beforeFresh = before?.inputTokens !== undefined && before.cachedTokens !== undefined ? before.inputTokens - before.cachedTokens : undefined;
  const afterFresh = after?.inputTokens !== undefined && after.cachedTokens !== undefined ? after.inputTokens - after.cachedTokens : undefined;
  if (beforeFresh !== undefined && beforeFresh <= 0) reasons.push("baseline fresh input tokens must be greater than zero");
  const reduction = beforeFresh !== undefined && afterFresh !== undefined ? beforeFresh - afterFresh : undefined;
  const pct = reduction !== undefined && beforeFresh !== undefined && beforeFresh > 0 ? Math.round((reduction / beforeFresh) * 1000) / 10 : undefined;
  return {
    available: reasons.length === 0,
    baselineFound: Boolean(before),
    compactedFound: Boolean(after),
    ...(before?.inputTokens !== undefined ? { beforeInputTokens: before.inputTokens } : {}),
    ...(before?.cachedTokens !== undefined ? { beforeCachedTokens: before.cachedTokens } : {}),
    ...(beforeFresh !== undefined ? { beforeFreshInputTokens: beforeFresh } : {}),
    ...(after?.inputTokens !== undefined ? { afterInputTokens: after.inputTokens } : {}),
    ...(after?.cachedTokens !== undefined ? { afterCachedTokens: after.cachedTokens } : {}),
    ...(afterFresh !== undefined ? { afterFreshInputTokens: afterFresh } : {}),
    ...(reduction !== undefined ? { freshInputReductionAbsolute: reduction } : {}),
    ...(pct !== undefined ? { freshInputReductionPercent: pct } : {}),
    reasons
  };
}

export function receiptsForGatewayProof(receipts: GatewayReceipt[], proofRunId: string): { baseline?: GatewayReceipt; compacted?: GatewayReceipt } {
  const matching = receipts.filter((r) => r.proof_run_id === proofRunId);
  return {
    baseline: matching.find((r) => r.proof_variant === "baseline"),
    compacted: matching.find((r) => r.proof_variant === "compacted")
  };
}

function value(v: number | undefined): string {
  return v === undefined ? "unavailable" : v.toLocaleString("en-US");
}

/**
 * Model-visible / approval framing, derived ONLY from provider-reported TOTAL input tokens.
 *
 * There are two honest situations the proof must NOT conflate:
 *  - "provider-cache": total input tokens UNCHANGED (before === after) but the fresh/billed
 *    share dropped (cache share rose). The model saw the SAME bytes; only the provider-reported
 *    fresh split changed. This is the ONLY case that may say "Same context." /
 *    "Model-visible bytes changed: no" / "Approval required: no", and label the second row
 *    "cache-optimized:".
 *  - "reduced-input": total input tokens DROPPED (after < before). The model saw DIFFERENT
 *    (fewer) bytes - a context change, not pure caching. It must NOT say "Same context"; it says
 *    "Model-visible input changed: yes ..." / "Approval required: yes ..." and labels the second
 *    row "compacted:".
 * When we cannot cleanly tell (either side's total input unavailable, or after > before), we fall
 * back to neutral phrasing and do NOT guess "Same context".
 */
type ProofScenario = "provider-cache" | "reduced-input" | "indeterminate";

function proofScenario(delta: GatewayProofDelta): ProofScenario {
  if (delta.beforeInputTokens === undefined || delta.afterInputTokens === undefined) return "indeterminate";
  if (delta.afterInputTokens === delta.beforeInputTokens) return "provider-cache";
  if (delta.afterInputTokens < delta.beforeInputTokens) return "reduced-input";
  return "indeterminate";
}

export function formatGatewayProof(delta: GatewayProofDelta): string {
  const scenario = proofScenario(delta);
  const absolute = delta.available ? delta.freshInputReductionAbsolute ?? 0 : 0;
  const reductionShown = delta.available && absolute > 0;
  const secondRowLabel = scenario === "reduced-input" ? "compacted" : scenario === "provider-cache" ? "cache-optimized" : "after";
  const beforeRowLabel = secondRowLabel === "after" ? "before" : "baseline";

  const lines = ["COMPACTION GATEWAY PROOF", ""];
  lines.push("Proof complete.");
  lines.push("");
  // "Same context. Less fresh input." - only honest when the model saw the SAME total input
  // (provider-cache) AND fresh input actually dropped.
  if (scenario === "provider-cache" && reductionShown) {
    lines.push("Same context. Less fresh input.");
    lines.push("");
  }
  lines.push(`baseline receipt found: ${delta.baselineFound ? "yes" : "no"}`);
  lines.push(`compacted receipt found: ${delta.compactedFound ? "yes" : "no"}`);
  lines.push(`${beforeRowLabel} input tokens: ${value(delta.beforeInputTokens)}`);
  lines.push(`${beforeRowLabel} cached tokens: ${value(delta.beforeCachedTokens)}`);
  lines.push(`${beforeRowLabel} fresh input tokens: ${value(delta.beforeFreshInputTokens)}`);
  lines.push(`${secondRowLabel} input tokens: ${value(delta.afterInputTokens)}`);
  lines.push(`${secondRowLabel} cached tokens: ${value(delta.afterCachedTokens)}`);
  lines.push(`${secondRowLabel} fresh input tokens: ${value(delta.afterFreshInputTokens)}`);
  if (delta.available) {
    const pct = delta.freshInputReductionPercent ?? 0;
    if (absolute > 0) {
      lines.push(`provider-reported fresh input reduced by ${pct}%`);
    } else if (absolute === 0) {
      lines.push("provider-reported fresh input unchanged (0% reduction)");
    } else {
      lines.push(`provider-reported fresh input increased by ${Math.abs(pct)}% (no reduction)`);
    }
    lines.push(`fresh input reduction absolute: ${value(delta.freshInputReductionAbsolute)}`);
    // Derived model-visible / approval facts, from provider-reported TOTAL input tokens only.
    if (scenario === "provider-cache") {
      lines.push("Model-visible bytes changed: no");
      lines.push("Approval required: no");
    } else if (scenario === "reduced-input") {
      lines.push("Model-visible input changed: yes (fewer input tokens sent)");
      lines.push("Approval required: yes (model-visible context change)");
    }
    // Honest constant, printed ONLY when a fresh-input reduction is actually shown: name the axis,
    // disclaim billing. This is a NEGATIVE disclaimer, never a positive savings/invoice claim.
    if (reductionShown) {
      lines.push("Claim: fresh-input reduction, not billing-confirmed invoice savings.");
    }
  } else {
    lines.push(`reduction unavailable: ${delta.reasons.join("; ") || "provider did not return usage/cached tokens"}`);
  }
  return lines.join("\n");
}
