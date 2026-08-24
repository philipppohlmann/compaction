export type TraceRole = "system" | "user" | "assistant" | "tool" | "stdout" | "stderr";

// `codex_import` is an additive source for traces produced by importing a real,
// user-supplied local `codex exec --json` JSONL export (the import/adapter path),
// distinct from a hand-authored `manual` fixture. It maps to the `imported_local`
// evidence tier, stronger than `fixture`, but strictly BELOW `real_captured`, so it
// can never unlock the `ready` approval rung. It is intentionally EXCLUDED from
// `isCommandTrace` (it carries no command/exitCode/durationMs provenance), so it is
// not subject to command-trace validation.
//
// `cursor_import` mirrors `codex_import` EXACTLY: a trace produced by importing a real,
// user-EXPORTED Cursor session (the import/adapter path), maps to the `imported_local`
// evidence tier, strictly BELOW `real_captured`, never unlocks `ready`. The normalizer that
// PRODUCES it is gated on a verified real Cursor export; this value is the format-independent
// groundwork.
export type TraceSource =
  | "manual"
  | "cli_wrapper"
  | "local_command"
  | "demo"
  | "real_captured"
  | "provider_usage"
  | "codex_import"
  | "cursor_import";

export interface TraceCommandMetadata {
  command: string;
  args: string[];
  cwd?: string;
  shell?: string;
}

export interface TraceMessage {
  id: string;
  role: TraceRole;
  content: string;
  timestamp: string;
  toolName?: string;
  metadata?: Record<string, unknown>;
}

export interface AgentTrace {
  id: string;
  title: string;
  artifactVersion: string;
  source: TraceSource;
  createdAt: string;
  generatedAt: string;
  model: string;
  command?: TraceCommandMetadata;
  durationMs?: number;
  exitCode?: number;
  messages: TraceMessage[];
}

export interface TokenEstimate {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface CostEstimate {
  model: string;
  inputCostUsd: number;
  outputCostUsd: number;
  /** Present only when cache_read_input_tokens > 0 and priced at ~10% of standard input rate (estimated). */
  cacheReadCostUsd?: number;
  /** Present only when cache_creation_input_tokens > 0 and priced at ~125% of standard input rate (estimated). */
  cacheCreationCostUsd?: number;
  totalCostUsd: number;
}

export interface WasteFinding {
  /**
   * `superseded_same_source_read` (input-compaction category 1): the SAME source was read multiple
   * times and a LATER read is authoritative; an EARLIER full copy whose content GENUINELY DIFFERS (whitespace-
   * normalized) from the latest can be replaced by a recoverable pointer to the retained original.
   * ADDITIVE to `repeated_tool_output` (which handles identical-up-to-whitespace repeats) and never
   * weakens it: an identical earlier copy is LEFT to `repeated_tool_output`, never category-1-compacted.
   * Convention for this category's `messageIds`: `[0]` = the KEPT latest authoritative read (verbatim),
   * `[1..]` = the earlier superseded reads to compact (each recoverable from the retained original).
   */
  category:
    | "repeated_tool_output"
    | "stale_context"
    | "verbose_observation"
    | "repeated_skill_injection"
    | "superseded_same_source_read";
  messageIds: string[];
  summary: string;
  estimatedTokens: number;
}

export interface StateCapsuleProvenanceEntry {
  source_trace_id?: string;
  source_message_id?: string;
  source_pointer?: string;
  source_hash?: string;
  source_hash_algorithm?: "sha256";
  source_excerpt_preview?: string;
  source_recoverable: boolean | "unknown";
  source_recovery_path?: string;
  original_payload_token_count?: number;
  capsule_token_count?: number;
  compacted_message_ids?: string[];
  replacement_mode?: string;
}

export interface StateCapsule {
  traceId: string;
  source_trace_id?: string;
  source_message_id?: string;
  source_pointer?: string;
  source_hash?: string;
  source_hash_algorithm?: "sha256";
  source_excerpt_preview?: string;
  source_recoverable?: boolean | "unknown";
  source_recovery_path?: string;
  original_payload_token_count?: number;
  capsule_token_count?: number;
  preserved_commitments?: string[];
  omitted_or_unknown_commitments?: string[];
  unsupported_additions_check?: string;
  provenance_limitations?: string[];
  provenance_entries?: StateCapsuleProvenanceEntry[];
  retainedFacts: string[];
  openQuestions: string[];
  safetyNotes: string[];
}

export type ApprovalReadinessStatus = "not_ready" | "conditional" | "ready";

/**
 * Report-only advisory for repeated byte-identical, same-skill role:user skill injections.
 * Detection/reporting ONLY: nothing in this advisory is compacted, removed, or applied.
 * All token figures are estimated (chars/4), not billing-confirmed, not realized savings.
 */
export interface SkillInjectionAdvisorySummary {
  report_only: true;
  skills: {
    skill_name: string;
    redundant_byte_identical_copies: number;
    estimated_tokens: number;
    redundant_copy_message_ids: string[];
  }[];
  total_redundant_byte_identical_copies: number;
  total_addressable_estimated_tokens: number;
  /** Price-table est cost equivalent of the addressable token volume (advisory, not realized). */
  estimated_cost_equivalent_usd: number;
  first_copy_count: number;
  estimate_label: string;
  recommendation: string;
}

/**
 * Value-proof classification of the report's token/cost deltas against the four
 * ROADMAP "MVP value path" claims (strongest last, never conflated). This object
 * does NOT introduce new numbers, it classifies the already-computed
 * tokens_saved / cost deltas into their honest tier and states plainly which
 * stronger claims are NOT made by this artifact.
 *
 * - Tier 1 (trace-token reduction): the local-estimate token reduction. CLAIMED.
 * - Tier 2 (estimated provider cost reduction): price-table estimate from the token
 *   delta, NOT billing-confirmed. CLAIMED as an estimate only.
 * - Tier 3 (billing-confirmed savings): a measured provider usage/billing delta.
 *   NOT claimed here, no provider usage/billing delta is measured.
 * - Tier 4 (fixed-plan workflow-extension value): more work under a fixed-price cap.
 *   NOT quantified here.
 */
export interface ValueProof {
  /** Tier 1, fewer tokens in the persisted/compacted trace (local estimate). */
  trace_token_reduction: {
    claim: "trace-token reduction (estimated, local heuristic)";
    tier: 1;
    estimated: true;
    tokens_saved: number;
    percent_reduction: number;
  };
  /** Tier 2, price-table estimate from the token delta, NOT billing-confirmed. */
  estimated_provider_cost_reduction: {
    claim: "estimated provider cost reduction (price-table estimate, NOT billing-confirmed)";
    tier: 2;
    estimated: true;
    billing_confirmed: false;
    saving_per_run_usd: number;
  };
  /** Tier 3, measured provider usage/billing delta. NOT claimed here. */
  billing_confirmed_savings: {
    claim: "billing-confirmed savings (measured provider usage/billing delta)";
    tier: 3;
    claimed: false;
    billing_confirmed: false;
    note: string;
  };
  /** Tier 4, more useful work under a fixed-price cap. NOT quantified here. */
  fixed_plan_workflow_extension_value: {
    claim: "fixed-plan workflow-extension value";
    tier: 4;
    quantified: false;
    note: string;
  };
}

/**
 * Concise "where spend came from" summary surfaced in the compaction report
 * (additive, optional, backward-compatible). Built by REUSING the spend-attribution
 * computation (buildSpendSummaryFromTrace), it does not reimplement attribution.
 *
 * All figures are LOCAL ESTIMATES: tokens are a chars/4 trace-token heuristic and
 * costs are price-table estimates. These describe WHERE estimated context spend
 * comes from. They are NOT billing-confirmed and NOT realized/applied savings.
 */
export interface SpendBySourceSummary {
  estimated: true;
  billing_confirmed: false;
  /** Human label clarifying the estimate basis. */
  estimate_label: string;
  /** Top role/category buckets by estimated tokens. */
  top_roles: { name: string; estimated_tokens: number; estimated_cost_usd: number }[];
  /** Top repeated tool-output buckets by estimated tokens. */
  top_tool_outputs: { tool_name: string; estimated_tokens: number; repeated_count: number; estimated_cost_usd: number }[];
  /** Top policy candidate by estimated tokens saved, if any (null when none). */
  top_policy_candidate: { policy_name: string; estimated_tokens_saved: number; estimated_saving_per_run_usd: number } | null;
}

export interface CompactionReport {
  run_id: string;
  trace_title: string;
  model: string;
  original_input_tokens: number;
  compacted_input_tokens: number;
  tokens_saved: number;
  percent_reduction: number;
  savings_scope?: string;
  cost_before_per_run: number;
  cost_after_per_run: number;
  saving_per_run: number;
  policy_name: string;
  waste_pattern: WasteFinding["category"] | null;
  source_message_id: string | null;
  repeated_count: number;
  compacted_message_ids: string[];
  artifact_version: string;
  created_at: string;
  generated_at: string;
  approval_readiness_status: ApprovalReadinessStatus;
  approval_readiness_reason: string;
  /**
   * Value-proof tier classification of the token/cost deltas above (additive,
   * backward-compatible). Classifies existing numbers only; makes no new claim.
   */
  value_proof?: ValueProof;
  /**
   * Report-only advisory section (repeated_skill_injection). Distinct from the actual
   * compaction summary above. Detection/reporting only, nothing here is compacted.
   */
  skill_injection_advisory?: SkillInjectionAdvisorySummary;
  /**
   * Concise "where spend came from" summary (additive, optional, backward-compatible).
   * Reuses the spend-attribution computation. Figures are local estimates (chars/4 /
   * price-table), NOT billing-confirmed and NOT realized savings.
   */
  spend_by_source?: SpendBySourceSummary;
  /**
   * Content-addressed per-run distinctness fingerprint of the source trace (additive,
   * OPTIONAL, backward-compatible). When present, it lets the aggregate attribute this
   * run's savings to a verifiable run identity and de-duplicate a run captured/aggregated
   * twice (same fingerprint → counted once) so the headline savings are never inflated.
   *
   * Older reports omit this field; a run WITHOUT a fingerprint cannot be de-duplicated and
   * is treated as distinct (you cannot dedup what you cannot identify) and noted honestly.
   *
   * Privacy: this is a one-way SHA-256 digest plus non-sensitive structural counts, NO
   * message/prompt/tool-output text. Structurally matches `TraceFingerprint` from
   * `src/core/trace-fingerprint.ts` (kept inline here so `types.ts` stays import-free).
   * This is an attribution/integrity signal, NOT a billing, provider, or semantic claim.
   */
  trace_fingerprint?: {
    /** Algorithm + canonicalization version (e.g. `sha256-canonical-content-v1`). */
    algorithm: string;
    /** Hex SHA-256 digest over the canonical normalized trace content (one-way; never raw content). */
    content_sha256: string;
    /** Non-sensitive structural count: number of messages hashed. */
    message_count: number;
  };
  /**
   * Composed per-run SAVINGS EVIDENCE record (additive, OPTIONAL, backward-compatible) -
   * the V0.2 "evidence labels per result" surface. Older reports omit it. See
   * `SavingsEvidence`. Composes EXISTING report numbers; makes no new/stronger claim.
   */
  savings_evidence?: SavingsEvidence;
}

/**
 * Composed, per-run savings-evidence record (V0.2 "evidence labels per result"). Ties the
 * evidence chain into ONE place and states, per run, the cost-source label, the
 * recoverability/semantic status, and exactly which `claims-and-evidence-ladder` rung the
 * figure stands on, so no consumer reads a stronger claim than the evidence supports.
 *
 * A single run is rung 1 (local estimate). The measured rung 1.5
 * (`measured_caveated_estimate_delta`) is produced ONLY by the aggregate increment across
 * N≥3 distinct runs, NEVER here. `billing_confirmed` is ALWAYS false; `semantic_preservation`
 * is ALWAYS `not_evaluated` (never auto-certified).
 */
export interface SavingsEvidence {
  /** Is the run attributable to a verifiable identity (trace fingerprint present)? */
  trace_identity: "fingerprinted" | "unidentified";
  /** Honest cost-source label for this run's figures (mirrors `CostSource`). */
  cost_source: "provider_reported" | "price_table_estimate" | "local_estimate" | "missing" | "unknown";
  /** Deterministic recoverability status when an eval ran (`compact --eval`); else `not_evaluated`. */
  recoverability: "passed" | "failed" | "not_computed" | "not_evaluated";
  /** Semantic / meaning preservation is NEVER auto-certified, always `not_evaluated`. */
  semantic_preservation: "not_evaluated";
  /** Which claims-and-evidence-ladder rung this single-run figure stands on. */
  evidence_rung: "local_estimate_single_run";
  /** No v0 per-run figure is billing-confirmed. Always `false`. */
  billing_confirmed: false;
  /** One-line honest label (never asserts a stronger claim than the rung). */
  label: string;
}

export interface CompactionPolicy {
  policy_name: string;
  policy_version: string;
  trigger: string;
  condition: string;
  action: string;
  safety_guarantees: string[];
  expected_savings: string;
  risk_notes: string[];
}
