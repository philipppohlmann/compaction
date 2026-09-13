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
import type { OutputShapingCalibrationRegime } from "../output-shaping-calibration-store.js";

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
  /**
   * ISO timestamp the gateway RECEIVED the request this receipt describes. Recorded on every receipt,
   * both modes, because `captured_at` is assigned only after response EOF or authoritative Codex
   * terminal evidence and the usage window has been assembled — on a compressed response that is after
   * an asynchronous decompressor flush, and the client may already have acted on the response by then.
   * Run membership (`run-boundary.ts`) therefore reads THIS timestamp: a request the client sent inside
   * its run is provably inside the run, whatever the ledger append latency. Absent on receipts written before the
   * field existed; readers fall back to `captured_at`.
   */
  request_started_at?: string;
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
  /**
   * THE UPSTREAM BILLING ROUTE this turn was forwarded on — the user's own provider API key
   * (`api-key`) or a Claude Code subscription session (`subscription`). The same distinction the
   * usage event records; written here from the same expression so the two cannot drift.
   *
   * WHAT IT GATES: the per-turn line's `−$X (list price)` cost clause. That figure prices the
   * model-visible input delta at the provider's PUBLISHED per-token rate, which is a defensible
   * estimate of money only on a route where tokens are what gets billed. On a subscription session
   * the user pays a flat fee and is billed no per-token amount at all, so a list-price figure there
   * is not a smaller bill — it is a number with no basis. The clause is omitted instead.
   *
   * FAIL-CLOSED ON ABSENCE. A receipt written before this field existed records no route, and a
   * replay cannot recover one. `undefined` therefore suppresses the cost clause rather than assuming
   * the billed route: the alternative is to keep showing an unverifiable dollar figure for exactly
   * the receipts whose route is unknown.
   *
   * CONTENT-FREE: one of two fixed labels.
   */
  upstream_route_type?: "api-key" | "subscription";
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
   * WAS OUTPUT SHAPING ACTIVE ON THE FINAL MODEL-VISIBLE REQUEST this turn?
   *
   * NOT `applied_components`, AND THE TWO MUST NEVER BE READ AS EACH OTHER. That field answers "what did
   * THIS APPLY PASS mutate"; this one answers "what was true of the bytes we forwarded". They are
   * independent: the tool's own `UserPromptSubmit` hook attaches the same policy upstream, so the planner
   * correctly attaches nothing and correctly omits `output-shaping` — on a request the model still reads
   * the policy from.
   *
   *  - `attached-this-pass` — this pass attached it. Normally implies `applied_components` contains
   *    `output-shaping`.
   *  - `already-active` — the current policy was ALREADY at instruction level on the final request, so
   *    nothing was attached and no duplicate was created. `applied_components` does NOT contain
   *    `output-shaping`. This is the ordinary LCM case when the policy was attached upstream.
   *  - `absent` — the current policy is not at instruction level on the final request. Covers shaping
   *    disabled, the task-aware classifier hold, and fail-closed shapes.
   *
   * ABSENT FIELD MEANS UNKNOWN, NEVER `absent`. The final request is not retained anywhere (recovery
   * stores `original_body` only), so a receipt written before this field CANNOT be classified after the
   * fact. Readers fail closed and withhold the savings claim rather than guess.
   */
  output_shaping_state?: "attached-this-pass" | "already-active" | "absent";
  /** Exact identity of the model-visible shaping policy when state proves it active. */
  output_shaping_policy_version?: string;
  /** Fixed regime only when the task classifier positively observed it. */
  output_shaping_regime?: OutputShapingCalibrationRegime;
  /**
   * WHICH TOOL SESSION produced this call — a device-local keyed hash, never the session id itself
   * (see `session-correlation.ts`). Recorded on EVERY receipt, both modes, because only apply receipts
   * retain a body and record-mode is the large majority of traffic (counted in
   * `session-correlation.ts`); the session cannot be recovered afterwards.
   *
   * NOT A RUN ID. One session contains many user runs; run identity is the `UserPromptSubmit`→`Stop`
   * interval recorded separately (`run-boundary.ts`). Membership in a run needs BOTH this and that
   * interval — never the working directory, which cannot separate two concurrent sessions.
   */
  session_correlation_id?: string;
  /**
   * WHY LCM DID OR DID NOT CONTRIBUTE on this request — fixed vocabulary, content-free
   * (see `lcm-outcome.ts`). Absent on receipts written before this field, which are simply unknown.
   */
  lcm_outcome?: { kind: string; reason: string };
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
    /**
     * Which traffic the pause covers. Live pauses are `all-routes`: the allowance buys Hybrid input
     * optimization on every upstream route. `api-key-route` appears only on receipts persisted before
     * metering became route-independent.
     */
    scope?: AllowancePauseScope;
  };
  /**
   * The Community allowance countdown for THIS turn: what was left after this turn's debit, out of
   * the period's total. Present only on a turn that actually debited the allowance — a confirmed
   * Hybrid INPUT apply — and only when the entitlement lease carried a signed period total.
   *
   * WHY IT IS ON THE RECEIPT rather than read at render time: the same reason `allowance_pause` is
   * (see above). A per-turn line is a statement about the turn it belongs to, and re-deriving the
   * numbers when the line is rendered would stamp today's balance onto a replayed receipt from three
   * weeks ago. It also keeps the statusline render loop free of any lease read, journal read, or
   * network call — it renders what the turn recorded.
   *
   * ABSENT ON A PAUSED TURN. The pause clause owns that line: it is the state the user needs to act
   * on, and a countdown next to it would restate the same zero in weaker words.
   *
   * CONTENT-FREE: two token counts and a calendar month. `optimized_input_tokens` is a product
   * ALLOWANCE unit — never a provider bill, cost, or savings figure.
   */
  allowance_snapshot?: {
    /**
     * Allowance left for the period AFTER this turn's debit — the authoritative figure, measured
     * under the usage-journal append lock against the fresh tally the ceiling itself refuses on.
     */
    remaining_tokens: number;
    /**
     * The period's TOTAL allowance before any consumption — the denominator, carried in the signed
     * lease. Never the lease's `allowance_tokens`, which is already net of server-recorded
     * consumption and would render a permanently full tank.
     */
    period_total_tokens: number;
    /** The allowance PERIOD (`YYYY-MM`) both figures belong to, when the lease carried one. */
    period_id?: string;
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
  /** Device-local keyed hash of the tool session id (never the id itself). See `session-correlation.ts`. */
  sessionCorrelationId?: string;
  /** ISO timestamp the gateway received the request. See `request_started_at` on the receipt. */
  requestStartedAt?: string;
  /**
   * Fixed-vocabulary LCM outcome (content-free; see `lcm-outcome.ts`). A record receipt carries it when
   * the engine ran for this turn and applied nothing — the did-not-contribute turns are exactly the
   * ones whose reason was being lost.
   */
  lcmOutcome?: { kind: string; reason: string };
  /**
   * Output-shaping provenance for the bytes this turn FORWARDED. A record-mode turn mutates nothing,
   * which is NOT the same as a turn on which output shaping did not run: the tool's own
   * `UserPromptSubmit` hook routinely attaches the policy upstream, so the request arrives already
   * carrying it and reaches the model shaped while the gateway attaches nothing. Recording that fact
   * here is what lets the run aggregate account for shaping it did not itself perform.
   *
   * Set by the caller ONLY from the strict instruction-level predicate
   * (`outputShapingActiveOnRequest`), never from the broad skip guard — this field is what a receipt
   * durably CLAIMS, so it must not inherit the guard's deliberate false-positive bias.
   */
  outputShapingState?: "attached-this-pass" | "already-active" | "absent";
  /** Exact identity supplied by the component that inspected/attached the policy bytes. */
  outputShapingPolicyVersion?: string;
  outputShapingRegime?: OutputShapingCalibrationRegime;
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
  const shapingActive =
    params.outputShapingState === "attached-this-pass" || params.outputShapingState === "already-active";

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
    ...(params.requestStartedAt ? { request_started_at: params.requestStartedAt } : {}),
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
    ...(params.sessionCorrelationId ? { session_correlation_id: params.sessionCorrelationId } : {}),
    ...(params.lcmOutcome ? { lcm_outcome: params.lcmOutcome } : {}),
    ...(params.outputShapingState ? { output_shaping_state: params.outputShapingState } : {}),
    ...(shapingActive && params.outputShapingPolicyVersion
      ? { output_shaping_policy_version: params.outputShapingPolicyVersion }
      : {}),
    ...(shapingActive && params.outputShapingRegime ? { output_shaping_regime: params.outputShapingRegime } : {}),
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

/** The tail window: its receipts, and whether the ledger extends further back than the window read. */
export interface GatewayReceiptTailWindow {
  receipts: GatewayReceipt[];
  /** True when bytes of the ledger precede the window — older receipts exist that were NOT read. */
  truncated: boolean;
}

/**
 * Read the receipts in the tail window, newest last, WITH the fact of whether the window cut the
 * ledger off. The RUN AGGREGATE needs every receipt in the current run, not just the last one — a run
 * is many provider calls, and the interleaved record-mode calls are exactly the ones a per-receipt
 * read drops.
 *
 * Tail-bounded for the same reason `readLatestGatewayReceiptTail` is: the status line runs inside
 * Claude Code's render loop and must never scan a multi-megabyte ledger. A run longer than the window
 * aggregates only the part that fits, which under-reports rather than invents — and `truncated` is
 * how the caller can tell a partial total from a total instead of presenting one as the other.
 */
export const GATEWAY_RECEIPT_TAIL_BYTES = 512 * 1024;

/**
 * Hard ceiling on the run-covering escalation below. The status line runs inside Claude Code's render
 * loop, so the read must stay bounded even for a pathological ledger; past this the window reports
 * `truncated` honestly and the run line falls back to plain totals, exactly as before.
 */
export const GATEWAY_RECEIPT_TAIL_MAX_BYTES = 8 * 1024 * 1024;

export async function readGatewayReceiptTailWindow(
  cwd: string = process.cwd(),
  tailBytes = GATEWAY_RECEIPT_TAIL_BYTES,
  /**
   * COVER THIS RUN. The fixed byte tail is measured from the END of the ledger, which has nothing to
   * do with where a run begins — so a NORMAL long agent run (measured: 353 provider calls over a 2 MB
   * ledger) fell outside it, the window reported `truncated`, and the run line dropped BOTH axes to
   * plain totals. That turned the primary run-level surface into an ambiguous partial: it rendered
   * `output 137,697` where the same run read completely renders `output N/A→137,697 (N/A%, est.)`.
   *
   * Given the current run's `started_at`, the window now grows (doubling) until it reaches back past
   * that instant or hits `maxBytes`. A run that fits is COMPLETE and keeps its rate; only a run that
   * genuinely exceeds the ceiling still reports `truncated`. Cost is paid only when a run actually
   * extends beyond the first window, and the ledger is append-ordered so reaching an older receipt
   * proves the run is covered.
   */
  coverFrom?: string,
  maxBytes = GATEWAY_RECEIPT_TAIL_MAX_BYTES
): Promise<GatewayReceiptTailWindow> {
  const file = path.join(cwd, DEFAULT_GATEWAY_RECEIPTS_DIR, GATEWAY_RECEIPTS_FILE);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const info = await stat(file);
    if (info.size === 0) return { receipts: [], truncated: false };
    handle = await open(file, "r");
    // Clamp the FIRST read to the ceiling too. Only the escalation was bounded, so a caller passing
    // `tailBytes > maxBytes` would exceed the documented hard cap on its very first read — unreachable
    // today (both callers use the defaults), but the ceiling should hold by construction, not by luck.
    let want = Math.min(Math.max(1, tailBytes), Math.max(1, maxBytes));
    let out: GatewayReceipt[] = [];
    let start = 0;
    for (;;) {
      start = Math.max(0, info.size - want);
      const length = info.size - start;
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, start);
      out = [];
      for (const line of buffer.toString("utf8").split("\n")) {
        const trimmed = line.trim();
        if (trimmed === "") continue;
        try {
          const parsed = JSON.parse(trimmed) as GatewayReceipt;
          if (typeof parsed?.receipt_id === "string") out.push(parsed);
        } catch {
          // A partial first line from the byte window, or a corrupt row: skipped, never guessed at.
        }
      }
      if (start === 0 || coverFrom === undefined || want >= maxBytes) break;
      const oldest = out.reduce<string | undefined>(
        (min, r) => (typeof r.captured_at === "string" && (min === undefined || r.captured_at < min) ? r.captured_at : min),
        undefined
      );
      if (oldest !== undefined && oldest <= coverFrom) break; // reached past the run's start: covered
      want = Math.min(want * 2, maxBytes);
    }
    return { receipts: out, truncated: start > 0 };
  } catch {
    return { receipts: [], truncated: false };
  } finally {
    await handle?.close().catch(() => {});
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
