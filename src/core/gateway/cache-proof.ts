/**
 * Compaction Gateway cache-proof pairing/summary (public CLI/SDK core; engine-free).
 *
 * Pairs two or more content-free record-mode receipts from one manual proof run and surfaces the wedge:
 *   "Same model-visible bytes, provider-backed cached input tokens, lower fresh/billed input tokens."
 *
 * Content-free by construction: operates ONLY on receipts (counts/labels, never content). The fresh/billed
 * input reduction comes from the provider's own reported cached-input accounting. It makes NO cost-savings,
 * NO model-visible input reduction, and NO output-token reduction claim. When no receipt reports cached
 * tokens the reduction is UNAVAILABLE (never a zero "savings"). Reads receipts only; no cache injection.
 */
import type { GatewayReceipt } from "./receipt.js";
import { freshBilledInputReduction, type FreshBilledInputReduction } from "./receipt.js";

/** One request's content-free view for the proof table. */
export interface CacheProofRequest {
  promptInput?: number;
  cachedInput?: number;
  /** Fresh/billed input = prompt - cached (the receipt's billed_fresh_input). */
  freshInput?: number;
  output?: number;
  tokenSource: string;
  modelVisibleBytesChanged: boolean;
}

export interface CacheProofSummary {
  requests: CacheProofRequest[];
  /** True only when EVERY paired receipt left model-visible bytes unchanged (record mode always does). */
  modelVisibleBytesUnchanged: boolean;
  /** The BEST provider-backed fresh/billed input reduction across the requests, or unavailable. */
  bestReduction: FreshBilledInputReduction;
}

/** Filter receipts to one proof run (by the client-set `proof_run_id`). */
export function receiptsForProofRun(receipts: GatewayReceipt[], proofRunId: string): GatewayReceipt[] {
  return receipts.filter((r) => r.proof_run_id === proofRunId);
}

/**
 * Summarize a set of receipts into a cache proof. The best reduction is the largest provider-backed
 * fresh/billed input reduction among the requests (typically the cached request beats the cold one).
 */
export function summarizeCacheProof(receipts: GatewayReceipt[]): CacheProofSummary {
  const requests: CacheProofRequest[] = receipts.map((r) => ({
    ...(r.tokens.prompt_input !== undefined ? { promptInput: r.tokens.prompt_input } : {}),
    ...(r.tokens.cached_input !== undefined ? { cachedInput: r.tokens.cached_input } : {}),
    ...(r.tokens.billed_fresh_input !== undefined ? { freshInput: r.tokens.billed_fresh_input } : {}),
    ...(r.tokens.output !== undefined ? { output: r.tokens.output } : {}),
    tokenSource: r.token_source,
    modelVisibleBytesChanged: r.model_visible_bytes_changed
  }));

  const modelVisibleBytesUnchanged = receipts.length > 0 && receipts.every((r) => r.model_visible_bytes_changed === false);

  // Best = the highest available fresh/billed reduction across the receipts.
  let bestReduction: FreshBilledInputReduction = {
    available: false,
    note: "no receipt reported provider cached input tokens - fresh/billed input reduction unavailable"
  };
  for (const r of receipts) {
    const red = freshBilledInputReduction({
      ...(r.tokens.prompt_input !== undefined ? { promptInputTokens: r.tokens.prompt_input } : {}),
      ...(r.tokens.cached_input !== undefined ? { cachedInputTokens: r.tokens.cached_input } : {})
    });
    if (red.available && (!bestReduction.available || (red.pct ?? 0) > (bestReduction.pct ?? 0))) {
      bestReduction = red;
    }
  }
  return { requests, modelVisibleBytesUnchanged, bestReduction };
}

function n(value: number | undefined): string {
  return value === undefined ? "unavailable" : value.toLocaleString("en-US");
}

/**
 * Render the content-free proof table. Shows each request's provider-reported
 * breakdown, then the honest claim line. When cached tokens are absent the reduction line reads
 * "unavailable" with the reason, NEVER a zero "savings" presented as proof.
 */
export function formatCacheProof(summary: CacheProofSummary): string {
  const lines: string[] = ["COMPACTION CACHE PROOF", ""];
  summary.requests.forEach((req, i) => {
    lines.push(`request ${i + 1}`);
    lines.push(`  prompt input tokens   ${n(req.promptInput).padStart(12)}`);
    lines.push(`  cached input tokens   ${n(req.cachedInput).padStart(12)}`);
    lines.push(`  fresh input tokens    ${n(req.freshInput).padStart(12)}`);
    lines.push(`  output tokens         ${n(req.output).padStart(12)}`);
    lines.push("");
  });
  lines.push(summary.modelVisibleBytesUnchanged ? "model-visible bytes unchanged" : "model-visible bytes: (mixed - check receipts)");
  if (summary.bestReduction.available) {
    lines.push(`fresh/billed input reduction: -${summary.bestReduction.pct}%`);
    lines.push("claim: provider-backed cached-input accounting");
  } else {
    lines.push("fresh/billed input reduction: unavailable");
    lines.push("reason: provider did not report cached input tokens");
  }
  return lines.join("\n");
}
