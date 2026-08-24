/**
 * Gateway receipt, the content-free ground-truth record of one gateway pass (public CLI/SDK code -
 * engine-free). A receipt carries only counts /
 * structure / labels, never messages, completions, tool outputs, or any request/response content.
 *
 * Record mode forwards request and response byte-for-byte (`mode: "record"`,
 * `model_visible_bytes_changed: false`): it describes the provider's own reported token/cache usage honestly
 * and asserts no reduction. Cost is always `unavailable` (the provider reports tokens, not a billing figure).
 */
import type { AllowancePauseScope } from "../onboarding-preferences.js";
import type { AllowancePauseReason } from "../upgrade-cta.js";
import { randomUUID } from "node:crypto";
import { mkdir, appendFile, readFile, open, stat } from "node:fs/promises";
import path from "node:path";
import type { OpenAiUsageBreakdown } from "./openai-usage.js";
import type { OptimizationPlan } from "./optimization-planner.js";

/** The gateway modes (only `record` is implemented). */
export type GatewayMode = "record" | "cache" | "apply";

/** Per-axis honesty label, mirrors the cross-surface `token_source` discipline. */
export type SourceLabel = "provider-reported" | "local-estimate" | "unavailable";

/** The default local-only receipts location (gitignored, never committed, never uploaded). */
export const DEFAULT_GATEWAY_RECEIPTS_DIR = ".compaction/gateway";
export const GATEWAY_RECEIPTS_FILE = "receipts.jsonl";

/**
 * The content-free claim-boundary label on every record-mode receipt.
 *
 * Claim boundary: a provider-backed fresh/billed input-token reduction MAY be displayed when the provider
 * reports cached input tokens (part of the input served from prompt cache → fewer fresh-billed input tokens,
 * model-visible bytes unchanged). NOT claimed: any model-visible input reduction, output-token reduction, or
 * cost-savings figure (cost is unavailable, the provider reports tokens, not billing).
 */
export const GATEWAY_RECORD_LABEL =
  "record mode: request and response forwarded BYTE-FOR-BYTE (model-visible bytes unchanged). Provider-backed " +
  "fresh/billed input reduction may be displayed when the provider reports cached input tokens; no model-visible " +
  "input reduction, output-token reduction, or cost-savings claim is made (cost is unavailable on this path).";

/** A provider-backed fresh/billed input-token reduction, or an honest unavailable (never a zero savings). */
export interface FreshBilledInputReduction {
  available: boolean;
  /** Percent of input tokens the provider served from cache (= cached / prompt · 100), when available. */
  pct?: number;
  /** Honest basis (available) or reason (unavailable). */
  note: string;
}

/**
 * Compute the provider-backed fresh/billed input reduction. Available only when the provider reported both
 * TOTAL prompt input tokens (> 0) and cached input tokens (> 0): the cached portion was not billed fresh, so
 * fresh/billed input is reduced by `cached / prompt` (the percent of the TOTAL prompt input served from
 * cache). Otherwise unavailable-with-reason, never a zero savings.
 *
 * `promptInputTokens` MUST be the TOTAL prompt input (cached ⊆ prompt), so `pct` is a sane provider fact in
 * [0, 100]. If the numbers are inconsistent (cached > prompt) the result is UNAVAILABLE-with-reason rather
 * than a garbage percentage - a fail-open honesty guard, never a fabricated or out-of-range figure.
 */
export function freshBilledInputReduction(usage: {
  promptInputTokens?: number;
  cachedInputTokens?: number;
}): FreshBilledInputReduction {
  const prompt = usage.promptInputTokens;
  const cached = usage.cachedInputTokens;
  if (prompt !== undefined && prompt > 0 && cached !== undefined && cached > 0) {
    // Fail open to unavailable if the provider counts are inconsistent (cached must be a subset of the
    // TOTAL prompt input). Never emit a percentage above 100 or below 0.
    if (cached > prompt) {
      return {
        available: false,
        note:
          "the provider reported more cached input tokens than total prompt input (inconsistent counts) - fresh/billed input reduction unavailable"
      };
    }
    const pct = Math.round((cached / prompt) * 1000) / 10; // one decimal place, bounded to [0, 100]
    return {
      available: true,
      pct,
      note: "provider-reported cached input tokens → fresh/billed input reduced; model-visible bytes unchanged"
    };
  }
  return {
    available: false,
    note:
      cached === undefined || cached === 0
        ? "the provider reported no cached input tokens for this request - fresh/billed input reduction unavailable"
        : "the provider reported no prompt input tokens - fresh/billed input reduction unavailable"
  };
}

/** The compact display string per the claim boundary (allowed forms only). */
export function formatFreshBilledInputReduction(r: FreshBilledInputReduction): string {
  return r.available ? `-${r.pct}% fresh/billed input` : "fresh/billed input reduction: unavailable";
}

export interface GatewayReceipt {
  /** Content-free unique id (random UUID - never derived from content). */
  receipt_id: string;
  /** ISO timestamp the receipt was recorded. */
  captured_at: string;
  provider: string;
  /** Model label the provider echoed, or "unknown" (never inferred). */
  model: string;
  /** The request path (e.g. `/v1/chat/completions`) - an endpoint label, not content. */
  endpoint: string;
  mode: GatewayMode;
  /** The upstream HTTP status code. */
  upstream_status: number;
  /** record mode never changes model-visible bytes (always false). */
  model_visible_bytes_changed: boolean;
  /** Per-axis token COUNTS (only present axes ride here - never a silent zero). */
  tokens: {
    prompt_input?: number;
    cached_input?: number;
    billed_fresh_input?: number;
    output?: number;
    reasoning?: number;
  };
  /**
   * Provider-backed fresh/billed input-token reduction (allowed claim): available ONLY when the provider
   * reported cached input tokens; otherwise unavailable-with-reason (never a zero savings). This is the
   * ONLY reduction this record-mode receipt asserts - never model-visible input, output, or cost.
   */
  fresh_billed_input_reduction: FreshBilledInputReduction;
  /** Where the token counts came from. */
  token_source: SourceLabel;
  /** Where the cache-token count came from (provider-reported only when the response exposed cached_tokens). */
  cache_source: SourceLabel;
  /** Cost is always unavailable on this path (provider reports tokens, not billing). */
  cost_source: "unavailable";
  /** Honest per-axis reasons for any unavailable axis (never a bare "unavailable"). */
  reasons: { token?: string; cache?: string; cost: string };
  /** Single request → run-scoped, never generalized. */
  claim_scope: "run-scoped";
  /**
   * record mode applies nothing → nothing to approve. Apply/dry-run receipts carry the explicit
   * source; `auto-applied-by-policy` marks an application under a STORED scoped authorization
   * (the preference id rides in `authorization_id`).
   */
  approval_status: "not-required" | "explicit-mode" | "explicit-header" | "explicit-dry-run" | "auto-applied-by-policy";
  /** Local-only by default; nothing is uploaded. */
  sync_status: "local-only";
  content_uploaded: false;
  /**
   * Optional CLIENT-SET proof-run id (an opaque grouping label, NOT content) - present only when the
   * client sent an `x-compaction-proof-run` header. The gateway only READS it (never injects/mutates the
   * request), and it is used purely to pair receipts of a manual proof run. Content-free by construction.
   */
  proof_run_id?: string;
  /** Optional CLIENT-SET content-free proof variant label from x-compaction-proof-variant. */
  proof_variant?: "baseline" | "compacted";
  /** The honest content-free label (never upgraded to a saving/cost claim). */
  label: string;

  // --- APPLY-mode fields (present ONLY on apply / dry-run receipts) -----------------------------------
  /** The deterministic policy that ran (e.g. `deterministic-dedupe`). */
  policy?: string;
  /** True ONLY when apply actually changed the request body (before/after evidence exists via recovery). */
  request_mutated?: boolean;
  /** The gateway NEVER changes the response. Always false when present. */
  response_mutated?: boolean;
  /** dry-run: a safe mutation was possible but NOT applied (the original was forwarded unchanged). */
  candidate_available?: boolean;
  /** LOCAL-ESTIMATE (chars/4) model-visible input over the safe text fields - never provider-reported. */
  estimated_input_tokens_before?: number;
  estimated_input_tokens_after?: number;
  /** Estimated model-visible input reduction percent over the safe fields (apply/dry-run candidate). */
  estimated_model_visible_input_reduction_percent?: number;
  /** Where the before/after ESTIMATES came from (always local-estimate - chars/4). */
  token_source_before?: SourceLabel;
  /** Where the AFTER token counts came from (provider-reported when the call returned usage, else local). */
  token_source_after?: SourceLabel;
  /** Pointer to the locally-retained original request body (content lives in the recovery store, not here). */
  recovery_id?: string;
  /** The stored policy-preference id that authorized an automatic application (content-free id). */
  authorization_id?: string;
  /** Why apply did NOT change the request (fail-closed shape, conflict, or no safe duplicate found). */
  fail_closed_reason?: string;
  /** The honest apply claim string (only asserts a model-visible reduction when request_mutated is true). */
  apply_label?: string;
  /** Content-free planner facts for apply decisions; no candidate/request content is recorded. */
  optimization_plan?: {
    selected_method: OptimizationPlan["selectedMethod"];
    selected_reason: string;
    rejected_methods: Array<{ method: Exclude<OptimizationPlan["selectedMethod"], "no-op">; reason: string }>;
    evidence_label: OptimizationPlan["evidenceLabel"];
    approval_requirement: OptimizationPlan["approvalRequirement"];
    approval_source: OptimizationPlan["approvalSource"];
    cache_evidence: OptimizationPlan["cacheEvidence"];
    composable_methods: OptimizationPlan["composableMethods"];
    expected_input_token_delta?: number;
    expected_output_token_delta?: number;
  };
  /** Content-free components actually attached/applied on this request. */
  applied_components?: Array<"lcm-compaction" | "deterministic-compaction" | "output-shaping">;
  /**
   * WHY input optimization did not run on this turn, when the reason was the Community optimized-input
   * ALLOWANCE rather than a fail-closed gate. Content-free: a reason enum and a UTC calendar date, no
   * remaining/consumed figure (those stay in the lease and the local journal).
   *
   * WHY IT IS ON THE RECEIPT. The per-turn line, `watch`, and `status` all render from receipts, and
   * the pause is a fact about THIS TURN. Re-deriving it at render time from current device state gets
   * the `insufficient` case wrong in both directions: the session resolver only knows `remaining <= 0`,
   * so it under-reports a turn that was too large for what was left, and it would stamp today's ceiling
   * onto a replayed receipt from a turn that was never refused. Recorded once, where it happened.
   *
   * ABSENT ON A HEALTHY TURN, which is what keeps the conversion CTA off every Community line.
   */
  allowance_pause?: {
    reason: AllowancePauseReason;
    /**
     * The allowance PERIOD (`YYYY-MM`) this pause belongs to.
     *
     * WHY IT IS RECORDED. A pause is a fact about one turn inside one period, and it stops being true
     * the moment that period rolls over — the allowance is replenished and nothing is paused any more.
     * Without this stamp a reader has only the reset DATE to reason from, and a receipt written in July
     * kept every surface claiming a ceiling (and showing the conversion CTA) through August. Binding the
     * pause to its period lets a reader promote it to CURRENT state only while it is still current.
     *
     * Optional because receipts written before this field exists must still parse; readers fall back to
     * the reset date for those (see `lastTurnAllowancePause`).
     */
    period_id?: string;
    /** The UTC date (`YYYY-MM-DD`) the allowance resets, when the lease carries a usable period. */
    resets_on?: string;
    /** Which traffic the pause covers; `api-key-route` when only metered traffic stopped. */
    scope?: AllowancePauseScope;
  };
}

const COST_UNAVAILABLE_REASON =
  "the provider response reports token usage but no cost or billing figure; no cost data exists on the gateway record path";

/**
 * Build ONE content-free gateway receipt from the request metadata + the provider's reported usage.
 * `now`/`id` are injectable for deterministic tests. CONTENT-FREE: only `usage`'s numeric fields, the
 * model label, the endpoint path, and the status ride on the receipt.
 */
export function buildGatewayReceipt(params: {
  provider: string;
  endpoint: string;
  mode: GatewayMode;
  upstreamStatus: number;
  usage: OpenAiUsageBreakdown;
  /** Model from the request (content-free metadata), used only if the response did not echo one. */
  requestModel?: string;
  /** Optional client-set proof-run id (from an `x-compaction-proof-run` header) - an opaque grouping label. */
  proofRunId?: string;
  /** Optional content-free variant label (baseline | compacted) from x-compaction-proof-variant. */
  proofVariant?: "baseline" | "compacted";
  now?: () => string;
  id?: () => string;
}): GatewayReceipt {
  const now = params.now ?? (() => new Date().toISOString());
  const id = params.id ?? (() => randomUUID());
  const u = params.usage;
  const model = u.model ?? params.requestModel ?? "unknown";

  const tokens: GatewayReceipt["tokens"] = {
    ...(u.promptInputTokens !== undefined ? { prompt_input: u.promptInputTokens } : {}),
    ...(u.cachedInputTokens !== undefined ? { cached_input: u.cachedInputTokens } : {}),
    ...(u.billedFreshInputTokens !== undefined ? { billed_fresh_input: u.billedFreshInputTokens } : {}),
    ...(u.outputTokens !== undefined ? { output: u.outputTokens } : {}),
    ...(u.reasoningTokens !== undefined ? { reasoning: u.reasoningTokens } : {})
  };

  const tokenSource: SourceLabel = u.present ? "provider-reported" : "unavailable";
  const cacheSource: SourceLabel = u.cachedInputTokens !== undefined ? "provider-reported" : "unavailable";
  const reduction = freshBilledInputReduction({
    ...(u.promptInputTokens !== undefined ? { promptInputTokens: u.promptInputTokens } : {}),
    ...(u.cachedInputTokens !== undefined ? { cachedInputTokens: u.cachedInputTokens } : {})
  });

  return {
    receipt_id: id(),
    captured_at: now(),
    provider: params.provider,
    model,
    endpoint: params.endpoint,
    mode: params.mode,
    upstream_status: params.upstreamStatus,
    model_visible_bytes_changed: false,
    tokens,
    fresh_billed_input_reduction: reduction,
    token_source: tokenSource,
    cache_source: cacheSource,
    cost_source: "unavailable",
    reasons: {
      ...(u.present ? {} : { token: u.unavailableReason ?? "no usage reported by the provider" }),
      ...(cacheSource === "unavailable"
        ? { cache: "the provider response did not report cached input tokens for this request" }
        : {}),
      cost: COST_UNAVAILABLE_REASON
    },
    claim_scope: "run-scoped",
    approval_status: "not-required",
    sync_status: "local-only",
    content_uploaded: false,
    ...(params.proofRunId ? { proof_run_id: params.proofRunId } : {}),
    ...(params.proofVariant ? { proof_variant: params.proofVariant } : {}),
    label: GATEWAY_RECORD_LABEL
  };
}

/** Append a receipt to the local-only JSONL store under `<cwd>/.compaction/gateway/`. Content-free. */
export async function appendGatewayReceipt(receipt: GatewayReceipt, cwd: string = process.cwd()): Promise<string> {
  const dir = path.join(cwd, DEFAULT_GATEWAY_RECEIPTS_DIR);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, GATEWAY_RECEIPTS_FILE);
  await appendFile(file, `${JSON.stringify(receipt)}\n`, "utf8");
  return file;
}

/**
 * Read the LATEST gateway receipt from the local-only JSONL store, or `undefined` when the store is
 * absent/empty/unparseable. Best-effort and read-only: any error resolves to `undefined` (the caller -
 * the fail-open Stop hook - must never throw). Reads only the last non-empty JSONL line. Content-free:
 * the store itself only ever holds content-free receipts.
 */
export async function readLatestGatewayReceipt(cwd: string = process.cwd()): Promise<GatewayReceipt | undefined> {
  try {
    const raw = await readFile(path.join(cwd, DEFAULT_GATEWAY_RECEIPTS_DIR, GATEWAY_RECEIPTS_FILE), "utf8");
    return parseLastReceiptLine(raw);
  } catch {
    return undefined;
  }
}

/** Parse the LAST non-empty JSONL line of a receipts blob into a receipt, or undefined. Never throws. */
function parseLastReceiptLine(raw: string): GatewayReceipt | undefined {
  try {
    const lines = raw.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
    const last = lines[lines.length - 1];
    if (!last) return undefined;
    const parsed = JSON.parse(last) as GatewayReceipt;
    return typeof parsed?.receipt_id === "string" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read the LATEST gateway receipt reading ONLY the tail of `receipts.jsonl` (bounded) - for surfaces
 * that run constantly and must stay fast even when the store has grown large (the Claude Code status
 * line). Reads at most the final `tailBytes` of the file, then parses the last complete JSONL line in
 * that window. Best-effort and read-only: any error resolves to `undefined` (the caller must never
 * throw). Content-free: the store only ever holds content-free receipts.
 */
export async function readLatestGatewayReceiptTail(
  cwd: string = process.cwd(),
  tailBytes = 64 * 1024
): Promise<GatewayReceipt | undefined> {
  const file = path.join(cwd, DEFAULT_GATEWAY_RECEIPTS_DIR, GATEWAY_RECEIPTS_FILE);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const info = await stat(file);
    if (info.size === 0) return undefined;
    const start = Math.max(0, info.size - tailBytes);
    const length = info.size - start;
    handle = await open(file, "r");
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    return parseLastReceiptLine(buffer.toString("utf8"));
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => {});
  }
}
