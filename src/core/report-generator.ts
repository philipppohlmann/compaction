import { calculateCost, type CacheTokenCounts } from "./cost-calculator.js";
import { isKnownModel } from "./pricing.js";
import type { SkillInjectionAdvisory } from "./skill-injection-detector.js";
import { computeTraceFingerprint } from "./trace-fingerprint.js";
import type { AgentTrace, CompactionPolicy, CompactionReport, CostEstimate, SavingsEvidence, TokenEstimate, WasteFinding } from "./types.js";
import type { UsageMetadata } from "./usage-metadata.js";

/**
 * Attach the content-addressed per-run trace fingerprint to a compaction report (PURE,
 * additive, backward-compatible). This is the report-generation attachment point that
 * threads trace identity into the savings-evidence pipeline so each per-run saving is
 * attributable to a verifiable run identity and a re-captured run can be de-duplicated in
 * the aggregate.
 *
 * It changes NO existing report field/label, it only sets the OPTIONAL `trace_fingerprint`
 * from `computeTraceFingerprint(trace)` (a one-way SHA-256 digest + structural counts; no
 * message content). Returns a new object; the input report is not mutated. This is an
 * attribution/integrity signal, NOT a billing, provider, or semantic-preservation claim.
 */
export function withTraceFingerprint(report: CompactionReport, trace: AgentTrace): CompactionReport {
  return { ...report, trace_fingerprint: computeTraceFingerprint(trace) };
}

/**
 * Attach the composed per-run SAVINGS EVIDENCE record to a compaction report (PURE,
 * additive, backward-compatible). V0.2 "evidence labels per result": it composes the
 * report's EXISTING numbers into ONE explicitly-labeled record and asserts the weakest
 * honest rung, a single run is rung 1 (local estimate). It makes NO new/stronger claim:
 * `billing_confirmed` is always false, `semantic_preservation` always `not_evaluated`, and
 * the measured rung 1.5 (`measured_caveated_estimate_delta`) is NEVER produced here (only by
 * the aggregate increment across N≥3 distinct runs).
 *
 * `costSource` defaults to the weakest honest label (`local_estimate`); pass a stronger
 * source ONLY when the run genuinely carries it. `recoverability` defaults to
 * `not_evaluated` (the eval is the separate `compact --eval` path); pass the eval result
 * when one ran. Returns a new object; the input report is not mutated.
 */
export function withSavingsEvidence(
  report: CompactionReport,
  opts: { costSource?: SavingsEvidence["cost_source"]; recoverability?: SavingsEvidence["recoverability"] } = {}
): CompactionReport {
  const cost_source = opts.costSource ?? "local_estimate";
  const recoverability = opts.recoverability ?? "not_evaluated";
  const savings_evidence: SavingsEvidence = {
    trace_identity: report.trace_fingerprint ? "fingerprinted" : "unidentified",
    cost_source,
    recoverability,
    semantic_preservation: "not_evaluated",
    evidence_rung: "local_estimate_single_run",
    billing_confirmed: false,
    label:
      `Per-run ${cost_source.replace(/_/g, " ")} delta (single run → local-estimate rung). ` +
      `Recoverability: ${recoverability}` +
      (recoverability === "not_evaluated" ? " (run `compact --eval`)" : "") +
      ". Semantic preservation: not_evaluated. NOT billing-confirmed, NOT realized savings, NOT extrapolated."
  };
  return { ...report, savings_evidence };
}

/** Render the composed per-run savings-evidence record for the markdown report. */
function formatSavingsEvidenceLines(report: CompactionReport): string[] {
  const se = report.savings_evidence;
  if (!se) {
    return [];
  }
  return [
    "",
    "## Savings Evidence (per-run, labeled)",
    "",
    `- Trace identity: ${se.trace_identity}`,
    `- Cost source: ${se.cost_source}`,
    `- Recoverability: ${se.recoverability}`,
    `- Semantic preservation: ${se.semantic_preservation}`,
    `- Evidence rung: ${se.evidence_rung}`,
    `- Billing-confirmed: ${se.billing_confirmed}`,
    `- ${se.label}`
  ];
}

function formatTokenBreakdown(tokens: TokenEstimate): string {
  return `${tokens.totalTokens} total (${tokens.inputTokens} input, ${tokens.outputTokens} output)`;
}

function formatFindings(findings: WasteFinding[]): string[] {
  if (findings.length === 0) {
    return ["Waste findings: none detected by the conservative v0 rules."];
  }

  return [
    `Waste findings: ${findings.length}`,
    ...findings.map(
      (finding, index) =>
        `${index + 1}. ${finding.category}: ${finding.summary} (${finding.estimatedTokens} estimated tokens; messages ${finding.messageIds.join(
          ", "
        )})`
    )
  ];
}

function placeholderPricingWarning(model: string): string | null {
  return isKnownModel(model) ? null : "Note: cost figures use placeholder pricing - model not in local price table.";
}

function sumWastedInputTokens(findings: WasteFinding[]): number {
  return findings.reduce((total, f) => total + f.estimatedTokens, 0);
}

function formatPostCompactionCostLines(
  model: string,
  tokens: TokenEstimate,
  cost: CostEstimate,
  findings: WasteFinding[],
  cache?: CacheTokenCounts
): string[] {
  if (findings.length === 0) {
    return [];
  }

  const wastedInputTokens = sumWastedInputTokens(findings);
  const postCompactionTokens: TokenEstimate = {
    inputTokens: Math.max(0, tokens.inputTokens - wastedInputTokens),
    outputTokens: tokens.outputTokens,
    totalTokens: Math.max(0, tokens.totalTokens - wastedInputTokens)
  };
  const postCompactionCost = calculateCost(model, postCompactionTokens, cache);
  const savingPerRun = cost.totalCostUsd - postCompactionCost.totalCostUsd;

  return [
    `Estimated cost after compaction: $${postCompactionCost.totalCostUsd.toFixed(6)} (estimated)`,
    `  Saving per run: $${savingPerRun.toFixed(6)} (estimated)`
  ];
}

function formatCacheAwareCostLines(cost: CostEstimate, tokens: TokenEstimate, usage?: UsageMetadata): string[] {
  const hasCacheRead = (usage?.cache_read_input_tokens ?? 0) > 0;
  const hasCacheCreation = (usage?.cache_creation_input_tokens ?? 0) > 0;
  const hasCacheData = hasCacheRead || hasCacheCreation;

  if (!hasCacheData) {
    return [`Estimated cost: $${cost.totalCostUsd.toFixed(6)} ($${cost.inputCostUsd.toFixed(6)} input, $${cost.outputCostUsd.toFixed(6)} output)`];
  }

  const lines: string[] = [];
  lines.push(`Estimated cost (cache-adjusted estimate): $${cost.totalCostUsd.toFixed(6)}`);
  // Use estimated input tokens from TokenEstimate - these match the cost figure.
  // usage.input_tokens is the provider-reported count (different from the estimated count used for cost).
  lines.push(`  Standard input: $${cost.inputCostUsd.toFixed(6)} (${tokens.inputTokens} estimated tokens at standard rate)`);
  lines.push(`  Output: $${cost.outputCostUsd.toFixed(6)}`);
  if (hasCacheRead && cost.cacheReadCostUsd !== undefined) {
    lines.push(`  Cache read: $${cost.cacheReadCostUsd.toFixed(6)} (${usage!.cache_read_input_tokens} tokens at ~10% of input rate - estimated)`);
  }
  if (hasCacheCreation && cost.cacheCreationCostUsd !== undefined) {
    lines.push(`  Cache creation: $${cost.cacheCreationCostUsd.toFixed(6)} (${usage!.cache_creation_input_tokens} tokens at ~125% of input rate - estimated)`);
  }
  return lines;
}

/**
 * Render the report-only skill-injection advisory section. This is ADVISORY: it is
 * distinct from the actual compaction summary and nothing is compacted. All token
 * figures are estimated (chars/4), not billing-confirmed, not realized, not applied.
 */
function formatSkillInjectionAdvisory(advisory?: SkillInjectionAdvisory): string[] {
  if (!advisory) {
    return [];
  }

  const lines: string[] = [
    "",
    "Skill-injection repetition (ADVISORY - report-only; nothing compacted)",
    `  Label: ${advisory.estimate_label}`
  ];

  if (advisory.skills.length === 0) {
    lines.push("  No repeated byte-identical same-skill role:user injections detected.");
    return lines;
  }

  lines.push(
    `  Retained first copies: ${advisory.first_copy_count}`,
    `  Redundant byte-identical copies: ${advisory.total_redundant_byte_identical_copies}`,
    `  Total addressable (est, chars/4): ${advisory.total_addressable_estimated_tokens} tokens`,
    "  Per-skill attribution (redundant byte-identical copies / est tokens):"
  );
  for (const skill of advisory.skills) {
    lines.push(`    - ${skill.skill_name}: ${skill.redundant_byte_identical_copies} copies, ${skill.estimated_tokens} est tokens`);
  }
  lines.push(`  Recommendation: ${advisory.recommendation}`);
  return lines;
}

export function formatAnalyzeReport(
  trace: AgentTrace,
  tokens: TokenEstimate,
  cost: CostEstimate,
  findings: WasteFinding[] = [],
  usage?: UsageMetadata,
  skillInjectionAdvisory?: SkillInjectionAdvisory
): string {
  return [
    `Trace: ${trace.title} (${trace.id})`,
    `Model: ${trace.model}`,
    `Source: ${trace.source}`,
    trace.command ? `Command: ${trace.command.command} ${trace.command.args.join(" ")}`.trim() : null,
    trace.durationMs === undefined ? null : `Duration: ${trace.durationMs} ms`,
    trace.exitCode === undefined ? null : `Exit code: ${trace.exitCode}`,
    `Messages: ${trace.messages.length}`,
    `Estimated tokens: ${formatTokenBreakdown(tokens)}`,
    placeholderPricingWarning(trace.model),
    ...formatCacheAwareCostLines(cost, tokens, usage),
    ...formatPostCompactionCostLines(trace.model, tokens, cost, findings, {
      cacheReadTokens: usage?.cache_read_input_tokens,
      cacheCreationTokens: usage?.cache_creation_input_tokens
    }),
    ...formatFindings(findings),
    "Suggested compaction: remove duplicate tool outputs only when an earlier identical copy remains in the trace.",
    ...formatSkillInjectionAdvisory(skillInjectionAdvisory)
  ].filter((line): line is string => line !== null).join("\n");
}

export function formatCompactionReport(report: CompactionReport): string {
  return [
    `Run: ${report.run_id}`,
    `Trace: ${report.trace_title}`,
    `Model: ${report.model}`,
    placeholderPricingWarning(report.model),
    `Original input tokens: ${report.original_input_tokens}`,
    `Compacted input tokens: ${report.compacted_input_tokens}`,
    `${report.savings_scope === "policy_level" ? "Policy-level tokens saved" : "Tokens saved"}: ${report.tokens_saved} (${report.percent_reduction.toFixed(2)}% reduction)`,
    `Cost before per run: $${report.cost_before_per_run.toFixed(6)} (estimated)`,
    `Cost after per run: $${report.cost_after_per_run.toFixed(6)} (estimated)`,
    `Savings per run: $${report.saving_per_run.toFixed(6)} (estimated)`,
    `Policy: ${report.policy_name}`,
    `Waste pattern: ${report.waste_pattern ?? "none"}`,
    `Compacted messages: ${report.compacted_message_ids.length === 0 ? "none" : report.compacted_message_ids.join(", ")}`
  ].filter((line): line is string => line !== null).join("\n");
}

/**
 * Render the value-proof tier classification for the human-facing report. This
 * classifies the already-reported token/cost deltas against the four ROADMAP
 * "MVP value path" claims (strongest last, never conflated). It adds no new
 * numbers and makes no new/stronger claim - it states plainly that tier 3
 * (billing-confirmed) is NOT claimed and tier 4 (fixed-plan) is NOT quantified.
 */
function formatValueProofLines(report: CompactionReport): string[] {
  const vp = report.value_proof;
  if (!vp) {
    return [];
  }
  return [
    "",
    "## Value Proof (ROADMAP tiers - strongest last, not conflated)",
    "",
    `- Tier 1 - ${vp.trace_token_reduction.claim}: ${vp.trace_token_reduction.tokens_saved} tokens (${vp.trace_token_reduction.percent_reduction.toFixed(2)}% reduction).`,
    `- Tier 2 - ${vp.estimated_provider_cost_reduction.claim}: $${vp.estimated_provider_cost_reduction.saving_per_run_usd.toFixed(6)}/run (estimated).`,
    `- Tier 3 - ${vp.billing_confirmed_savings.claim}: ${vp.billing_confirmed_savings.note}`,
    `- Tier 4 - ${vp.fixed_plan_workflow_extension_value.claim}: ${vp.fixed_plan_workflow_extension_value.note}`
  ];
}

/**
 * Render the concise "Where spend came from (estimated)" section for report.md. This
 * reuses the spend_by_source summary already computed via the spend-attribution module.
 * Figures are LOCAL ESTIMATES (chars/4 trace tokens / price-table cost) - clearly NOT
 * billing-confirmed and NOT realized savings. Consistent with the value-proof tiers
 * (tier-1 trace-token estimates / tier-2 price-table cost estimates).
 */
function formatSpendBySourceLines(report: CompactionReport): string[] {
  const spend = report.spend_by_source;
  if (!spend) {
    return [];
  }
  const roleRows =
    spend.top_roles.length === 0
      ? ["- No role/category spend attributed."]
      : spend.top_roles.map(
          (role) => `- ${role.name}: ${role.estimated_tokens} est tokens ($${role.estimated_cost_usd.toFixed(6)} est)`
        );
  const toolRows =
    spend.top_tool_outputs.length === 0
      ? ["- No repeated tool-output spend attributed."]
      : spend.top_tool_outputs.map(
          (tool) =>
            `- ${tool.tool_name}: ${tool.estimated_tokens} est tokens across ${tool.repeated_count} output(s) ($${tool.estimated_cost_usd.toFixed(6)} est)`
        );
  return [
    "",
    "## Where Spend Came From (estimated)",
    "",
    "> ESTIMATED: chars/4 trace-token heuristic and price-table cost. These show where estimated context spend comes from - NOT billing-confirmed, NOT realized savings.",
    "",
    "Top sources by est tokens - roles/categories:",
    ...roleRows,
    "",
    "Top sources by est tokens - repeated tool outputs:",
    ...toolRows,
    "",
    spend.top_policy_candidate
      ? `Top policy candidate: ${spend.top_policy_candidate.policy_name} (${spend.top_policy_candidate.estimated_tokens_saved} est tokens saved, $${spend.top_policy_candidate.estimated_saving_per_run_usd.toFixed(6)} est/run)`
      : "Top policy candidate: none"
  ];
}

export function formatCompactionMarkdownReport(report: CompactionReport, policy: CompactionPolicy): string {
  const pricingNote = placeholderPricingWarning(report.model);
  return [
    `# Compaction Report: ${report.trace_title}`,
    "",
    "## Summary",
    "",
    `- Run ID: ${report.run_id}`,
    `- Model: ${report.model}`,
    `- Artifact version: ${report.artifact_version}`,
    `- Created at: ${report.created_at}`,
    `- Generated at: ${report.generated_at}`,
    pricingNote ? `\n> ${pricingNote}` : null,
    "",
    "## Savings",
    "",
    `- Original input tokens: ${report.original_input_tokens}`,
    `- Compacted input tokens: ${report.compacted_input_tokens}`,
    `${report.savings_scope === "policy_level" ? "- Policy-level tokens saved" : "- Tokens saved"}: ${report.tokens_saved}`,
    `- Percent reduction: ${report.percent_reduction.toFixed(2)}%`,
    `- Cost before per run: $${report.cost_before_per_run.toFixed(6)} (estimated)`,
    `- Cost after per run: $${report.cost_after_per_run.toFixed(6)} (estimated)`,
    `- Saving per run: $${report.saving_per_run.toFixed(6)} (estimated)`,
    ...formatValueProofLines(report),
    ...formatSpendBySourceLines(report),
    ...formatSavingsEvidenceLines(report),
    "",
    "## Waste Pattern",
    "",
    `- Policy: ${report.policy_name}`,
    `- Pattern: ${report.waste_pattern ?? "none"}`,
    `- Source message: ${report.source_message_id ?? "none"}`,
    `- Repeated finding message count: ${report.repeated_count}`,
    `- Compacted messages: ${report.compacted_message_ids.length === 0 ? "none" : report.compacted_message_ids.join(", ")}`,
    "",
    "## Policy",
    "",
    `- Version: ${policy.policy_version}`,
    `- Trigger: ${policy.trigger}`,
    `- Condition: ${policy.condition}`,
    `- Action: ${policy.action}`,
    `- Expected savings: ${policy.expected_savings}`,
    "",
    "## Safety Guarantees",
    "",
    ...policy.safety_guarantees.map((guarantee) => `- ${guarantee}`),
    "",
    "## Risk Notes",
    "",
    ...policy.risk_notes.map((note) => `- ${note}`)
  ].filter((line): line is string => line !== null).join("\n");
}

export function formatPrCommentReport(report: CompactionReport, policy: CompactionPolicy, artifactNames: string[]): string {
  const riskOrSafetyNote =
    policy.risk_notes[0] ?? policy.safety_guarantees[0] ?? "Review the compacted trace before applying this policy.";
  const pricingNote = placeholderPricingWarning(report.model);

  return [
    "## compaction.dev summary",
    "",
    `Trace title: ${report.trace_title}`,
    `Model: ${report.model}`,
    pricingNote ? `> ${pricingNote}` : null,
    "",
    "### Token savings",
    "",
    `- Before input tokens: ${report.original_input_tokens}`,
    `- After input tokens: ${report.compacted_input_tokens}`,
    `${report.savings_scope === "policy_level" ? "- Policy-level tokens saved" : "- Tokens saved"}: ${report.tokens_saved}`,
    `- Percent reduction: ${report.percent_reduction.toFixed(2)}%`,
    "",
    "### Cost impact",
    "",
    `- Cost before per run: $${report.cost_before_per_run.toFixed(6)} (estimated)`,
    `- Cost after per run: $${report.cost_after_per_run.toFixed(6)} (estimated)`,
    `- Saving per run: $${report.saving_per_run.toFixed(6)} (estimated)`,
    ...(report.value_proof
      ? [
          "",
          "### Value-proof tiers (strongest last, not conflated)",
          "",
          `- Tier 1 - ${report.value_proof.trace_token_reduction.claim}.`,
          `- Tier 2 - ${report.value_proof.estimated_provider_cost_reduction.claim}.`,
          `- Tier 3 - billing-confirmed savings: NOT claimed (no provider usage/billing delta measured).`,
          `- Tier 4 - fixed-plan workflow-extension value: NOT quantified here.`
        ]
      : []),
    "",
    "### Policy and safety",
    "",
    `- Policy applied: ${policy.policy_name}`,
    `- Waste pattern: ${report.waste_pattern ?? "none"}`,
    `- Risk level or safety note: ${riskOrSafetyNote}`,
    "",
    "### Generated artifacts",
    "",
    ...artifactNames.map((artifactName) => `- ${artifactName}`)
  ].filter((line): line is string => line !== null).join("\n");
}
