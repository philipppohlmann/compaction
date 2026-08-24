import { randomUUID } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { writeJsonArtifact, writeTextArtifact } from "./artifact-writer.js";
import { calculateCost } from "./cost-calculator.js";
// PUBLIC constant, defined in the public policy-types module (Phase 1a), NOT the engine.
// spend-attribution is a FREE/public module and must not statically import `src/engine`.
import { isModuleAbsentError } from "./module-absence.js";

/**
 * The specifiers the lazy `import()`s below use, declared so the absence check can be scoped to THOSE
 * modules. The `import()` calls and this list read the SAME constants, so the two cannot drift;
 * `private-boundary-seams.test.ts` asserts the values, and a drift would in any case fail toward
 * PROPAGATING the error rather than degrading silently. The specifiers stay in named constants so the
 * public tree still compiles when the private modules are absent - the loader resolves them at
 * runtime exactly as it would a literal.
 */
const POLICY_MIDDLEWARE_MODULE = "./policy-middleware.js";
const RECOMMENDATION_MODULE = "../engine/recommendation.js";
const SPEND_ENGINE_SPECIFIERS = [POLICY_MIDDLEWARE_MODULE, RECOMMENDATION_MODULE, "./safety-report.js"] as const;
import type { PolicyMiddlewareContract, RecommendationContract } from "./lazy-module-contracts.js";
import { COMPACTION_POLICY_NAME } from "./policy-types.js";
import { estimateTextTokens, estimateTraceTokens } from "./token-estimator.js";
import { agentTraceSchema } from "./trace-parser.js";
import { detectWaste, buildSkillInjectionAdvisory } from "./waste-detector.js";
import type { MetadataStatus } from "./openai-agents-capture.js";
// The vocabulary comes from the PUBLIC seam, not `../engine/…`. A type-only engine import creates no
// RUNTIME edge, but `tsc` still emits it into this module's `.d.ts`, and `dist/engine/**` is excluded
// from the published package — a TypeScript consumer would hit TS2307 on a declaration it cannot
// resolve. The runtime values (`applyCompactionPolicy`, `createRecommendation`, `createSafetyReport`)
// are still supplied ONLY via the optional, lazily-loaded OptimizationDeltaProvider below; the free
// path never needs them.
import type {
  IntegrationWorkflowMetadata,
  RecommendationMode,
  RecommendationRiskLevel,
  RecommendationSafetyStatus
} from "./report-types.js";
import { describeCostMetadata, describeTokenMetadata, localEstimateUsageMetadata, type UsageMetadata } from "./usage-metadata.js";
import type { AgentTrace, TraceMessage, TraceRole, WasteFinding } from "./types.js";

/**
 * Engine-derived optimization-delta inputs for a trace. The PROPRIETARY part of a spend summary:
 * what a compaction policy would do (policy candidate, post-compaction tokens/cost, the recommendation
 * verdict, and safety/risk). The FREE local attribution (where spend comes from, by role, tool output,
 * waste pattern, skill-injection) does NOT depend on any of this and is always computed.
 *
 * In the in-repo / API build an engine-backed provider supplies this (see `engineOptimizationDeltaProvider`).
 * In a public install with the engine excluded, no provider is available and the optimization-delta fields
 * degrade honestly: `available: false`, no policy candidate, `safety_status: "missing"`, and ZERO synthetic
 * saving is shown, the formatters print the boundary clause instead of a misleading `$0.000000` saving.
 */
export interface TraceOptimizationDelta {
  available: boolean;
  policy_candidate: string | null;
  tokens_after: number;
  cost_after: number;
  tokens_saved: number;
  saving_per_run: number;
  safety_status: RecommendationSafetyStatus;
  risk_level: RecommendationRiskLevel;
  recommendation_mode: RecommendationMode;
  next_step: string;
}

/**
 * Optional provider that computes the engine-derived {@link TraceOptimizationDelta} for a trace.
 * Supplied by engine/API callers via lazy import; absent on the free path.
 */
export type OptimizationDeltaProvider = (
  trace: AgentTrace,
  before: { inputTokens: number; outputTokens: number },
  costBefore: number,
  generatedAt: string
) => Promise<TraceOptimizationDelta> | TraceOptimizationDelta;

const ENGINE_GATED_NEXT_STEP =
  "Optimization delta needs the Hybrid Engine, which is delivered separately and is installed for you " +
  "when you activate Community. Local spend attribution above is complete.";

/**
 * The honest free-tier optimization delta: no engine, so no policy candidate, no post-compaction
 * figures, and NO synthetic saving. Safety is `missing` (not evaluated), risk defaults to medium,
 * mode is observe. `available: false` tells the formatters to print the boundary clause.
 */
function unavailableOptimizationDelta(): TraceOptimizationDelta {
  return {
    available: false,
    policy_candidate: null,
    tokens_after: 0,
    cost_after: 0,
    tokens_saved: 0,
    saving_per_run: 0,
    safety_status: "missing",
    risk_level: "medium",
    recommendation_mode: "observe",
    next_step: ENGINE_GATED_NEXT_STEP
  };
}

/**
 * Lazily load the proprietary engine and build an OptimizationDeltaProvider from it. Used by the
 * `spend` CLI command so a real engine build produces the full optimization delta, while a public
 * install (engine excluded) falls back to {@link unavailableOptimizationDelta} WITHOUT crashing.
 * Returns `null` when the engine build is absent.
 */
export async function loadEngineOptimizationDeltaProvider(): Promise<OptimizationDeltaProvider | null> {
  try {
    const [{ applyCompactionPolicy }, { createRecommendation }, { createSafetyReport }] = await Promise.all([
      import(POLICY_MIDDLEWARE_MODULE) as Promise<PolicyMiddlewareContract>,
      import(RECOMMENDATION_MODULE) as Promise<RecommendationContract>,
      import("./safety-report.js")
    ]);
    return (trace, before, costBefore, generatedAt) => {
      const findings = detectWaste(trace);
      const policyResult = applyCompactionPolicy({ trace });
      const safetyReport = createSafetyReport({
        runId: trace.id,
        generatedAt,
        originalTrace: trace,
        compactedMessages: policyResult.compactedMessages,
        stateCapsules: policyResult.stateCapsules,
        compactedMessageIds: policyResult.compactedMessageIds,
        tokensSaved: policyResult.tokensSaved,
        policyName: policyResult.appliedPolicyName
      });
      const recommendation = createRecommendation({ trace, policyResult, generatedAt, safetyReport, findings });
      const costAfter = policyResult.costEstimateAfter.totalCostUsd;
      return {
        available: true,
        policy_candidate: recommendation.policy_name,
        tokens_after: policyResult.tokenEstimateAfter.inputTokens,
        cost_after: roundCurrency(costAfter),
        tokens_saved: Math.max(0, policyResult.tokensSaved),
        saving_per_run: roundCurrency(Math.max(0, costBefore - costAfter)),
        safety_status: recommendation.safety_status,
        risk_level: recommendation.risk_level,
        recommendation_mode: recommendation.recommended_mode,
        next_step: recommendation.required_next_step
      };
    };
  } catch (error) {
    // Only the ABSENCE OF ONE OF THESE THREE means "no engine here". A real error from a present
    // engine — including a module-not-found for one of THEIR dependencies, which is a packaging
    // defect and not an excluded capability — must propagate.
    const absent = SPEND_ENGINE_SPECIFIERS.some((specifier) =>
      isModuleAbsentError(error, { specifier, importerUrl: import.meta.url })
    );
    if (absent) return null;
    throw error;
  }
}

export const SPEND_ARTIFACT_ROOT = ".compaction/spend";

export const SPEND_LIMITATIONS = [
  "local estimates only when billing data is unavailable",
  "token/cost metadata may be partial",
  "not provider billing data unless explicitly captured",
  "no auto mode",
  "no model routing",
  "no hosted dashboard"
] as const;

type InputKind = "trace" | "optimization_summary" | "recommendation";

export interface SpendBucket {
  name: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  estimated_cost: number;
  message_count?: number;
}

export interface ToolSpendBucket extends SpendBucket {
  tool_name: string;
  repeated_count: number;
  message_ids: string[];
}

export interface WastePatternSpendBucket {
  pattern: WasteFinding["category"];
  estimated_tokens: number;
  estimated_cost: number;
  finding_count: number;
  message_ids: string[];
  summaries: string[];
}

export interface PolicyCandidateSpendBucket {
  policy_name: string;
  estimated_tokens_saved: number;
  estimated_saving_per_run: number;
  percent_reduction: number;
  safety_status: RecommendationSafetyStatus;
  risk_level: RecommendationRiskLevel;
  recommendation_mode: RecommendationMode;
}

/**
 * Per-skill skill-injection spend bucket (report-only). Attributes redundant
 * byte-identical role:user skill-injection volume by skill. Detection/reporting only -
 * nothing is compacted. `estimated_tokens` is chars/4, NOT realized savings.
 */
export interface SkillInjectionSpendBucket extends SpendBucket {
  skill_name: string;
  redundant_byte_identical_copies: number;
  redundant_copy_message_ids: string[];
}

export interface RepeatedContextSegmentSpend {
  segment_id: string;
  category: WasteFinding["category"];
  estimated_tokens: number;
  estimated_cost: number;
  message_ids: string[];
  summary: string;
}

export interface SpendSummary {
  trace_id: string;
  generated_at: string;
  integration: string | null;
  integration_workflow?: IntegrationWorkflowMetadata;
  token_metadata_status: MetadataStatus;
  cost_metadata_status: MetadataStatus;
  usage_metadata: UsageMetadata;
  spend_confidence: UsageMetadata["cost_confidence"];
  pricing_assumptions: string[];
  input_tokens_before: number;
  input_tokens_after: number;
  output_tokens_before?: number;
  output_tokens_after?: number;
  tokens_saved: number;
  percent_reduction: number;
  savings_scope: "policy_level";
  estimated_cost_before: number;
  estimated_cost_after: number;
  estimated_saving_per_run: number;
  spend_by_role: SpendBucket[];
  spend_by_tool_output: ToolSpendBucket[];
  spend_by_repeated_context_segment: RepeatedContextSegmentSpend[];
  spend_by_waste_pattern: WastePatternSpendBucket[];
  spend_by_policy_candidate: PolicyCandidateSpendBucket[];
  /** Report-only: per-skill redundant byte-identical skill-injection spend. Nothing compacted. */
  spend_by_skill_injection: SkillInjectionSpendBucket[];
  /** Report-only: total addressable est trace-token volume across skill injections (chars/4). */
  skill_injection_addressable_estimated_tokens: number;
  top_waste_patterns: WastePatternSpendBucket[];
  top_role_category: SpendBucket | null;
  top_repeated_tool_output: ToolSpendBucket | null;
  top_waste_pattern: WastePatternSpendBucket | null;
  top_policy_candidate: PolicyCandidateSpendBucket | null;
  policy_candidate: string | null;
  /**
   * Whether the proprietary optimization-delta engine was available for this summary. When false
   * (public install, engine excluded) the optimization-delta fields below are NOT engine-computed:
   * `policy_candidate` is null, `tokens_saved`/`estimated_saving_per_run` are 0 (NOT a real $0 saving
   *, the formatters print the boundary clause instead), and `safety_status` is `missing`. The FREE
   * local attribution (spend_by_role / _tool_output / _waste_pattern / _skill_injection) is unaffected.
   */
  optimization_delta_available: boolean;
  safety_status: RecommendationSafetyStatus;
  risk_level: RecommendationRiskLevel;
  recommendation_mode: RecommendationMode;
  approval_status?: string;
  next_step: string;
  limitations: string[];
  source_path: string;
  input_kind: InputKind;
}

export interface SpendArtifacts {
  summary: SpendSummary;
  outputDirectory: string;
  terminalSummary: string;
  paths: {
    spendSummaryJsonPath: string;
    spendSummaryMarkdownPath: string;
  };
}

interface OptimizationSummaryLike {
  optimization_id?: string;
  generated_at?: string;
  integration?: string;
  trace_id?: string;
  token_metadata_status?: MetadataStatus;
  cost_metadata_status?: MetadataStatus;
  usage_metadata?: UsageMetadata;
  spend_confidence?: UsageMetadata["cost_confidence"];
  pricing_assumptions?: string[];
  original_input_tokens?: number;
  compacted_input_tokens?: number;
  tokens_saved?: number;
  percent_reduction?: number;
  cost_before_per_run?: number;
  cost_after_per_run?: number;
  saving_per_run?: number;
  savings_scope?: "policy_level";
  policy_name?: string | null;
  safety_status?: RecommendationSafetyStatus;
  risk_level?: RecommendationRiskLevel;
  recommendation_mode?: RecommendationMode;
  recommended_next_step?: string;
  approval_status?: string;
  artifact_paths?: Record<string, string>;
  integration_workflow?: IntegrationWorkflowMetadata;
}

function createSpendRunId(now: Date = new Date()): string {
  return `spend-${now.toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
}

function roundCurrency(value: number): number {
  return Number(value.toFixed(6));
}

function percentReduction(before: number, saved: number): number {
  if (before <= 0) return 0;
  return Number(((saved / before) * 100).toFixed(2));
}

function formatCurrency(value: number | null | undefined): string {
  return typeof value === "number" ? `$${value.toFixed(6)}` : "unknown";
}

function numericMetadataValue(metadata: Record<string, unknown> | undefined, keys: string[]): number | undefined {
  if (!metadata) return undefined;
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  const usage = metadata.usage;
  if (typeof usage === "object" && usage !== null && !Array.isArray(usage)) {
    return numericMetadataValue(usage as Record<string, unknown>, keys);
  }
  return undefined;
}

function metadataStatusFor(trace: AgentTrace, kind: "token" | "cost"): MetadataStatus {
  if (trace.messages.length === 0) return "unknown";
  const presentCount = trace.messages.filter((message) => {
    if (kind === "token") {
      return numericMetadataValue(message.metadata, ["input_tokens", "inputTokens", "output_tokens", "outputTokens", "total_tokens", "totalTokens"]) !== undefined;
    }
    return numericMetadataValue(message.metadata, ["cost_usd", "costUsd", "totalCostUsd", "total_cost_usd"]) !== undefined;
  }).length;

  if (presentCount === 0) return "missing";
  if (presentCount === trace.messages.length) return "present";
  return "partial";
}

function messageInputTokens(message: TraceMessage): number {
  const metadataTokens = numericMetadataValue(message.metadata, ["input_tokens", "inputTokens"]);
  if (metadataTokens !== undefined) return metadataTokens;
  return message.role === "assistant" ? 0 : estimateTextTokens(message.content);
}

function messageOutputTokens(message: TraceMessage): number {
  const metadataTokens = numericMetadataValue(message.metadata, ["output_tokens", "outputTokens"]);
  if (metadataTokens !== undefined) return metadataTokens;
  return message.role === "assistant" ? estimateTextTokens(message.content) : 0;
}

function estimatedCostFor(model: string, inputTokens: number, outputTokens: number): number {
  return roundCurrency(calculateCost(model, { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens }).totalCostUsd);
}

function sortByTokens<T extends { total_tokens?: number; estimated_tokens?: number; estimated_tokens_saved?: number }>(items: T[]): T[] {
  return [...items].sort((first, second) => (second.total_tokens ?? second.estimated_tokens ?? second.estimated_tokens_saved ?? 0) - (first.total_tokens ?? first.estimated_tokens ?? first.estimated_tokens_saved ?? 0));
}

function spendByRole(trace: AgentTrace): SpendBucket[] {
  const byRole = new Map<TraceRole, SpendBucket>();
  for (const message of trace.messages) {
    const current = byRole.get(message.role) ?? { name: message.role, input_tokens: 0, output_tokens: 0, total_tokens: 0, estimated_cost: 0, message_count: 0 };
    const inputTokens = messageInputTokens(message);
    const outputTokens = messageOutputTokens(message);
    current.input_tokens += inputTokens;
    current.output_tokens += outputTokens;
    current.total_tokens += inputTokens + outputTokens;
    current.message_count = (current.message_count ?? 0) + 1;
    byRole.set(message.role, current);
  }

  return sortByTokens(
    [...byRole.values()].map((bucket) => ({ ...bucket, estimated_cost: estimatedCostFor(trace.model, bucket.input_tokens, bucket.output_tokens) }))
  );
}

function spendByToolOutput(trace: AgentTrace): ToolSpendBucket[] {
  const byToolOutput = new Map<string, ToolSpendBucket>();
  for (const message of trace.messages.filter((candidate) => candidate.role === "tool")) {
    const normalized = message.content.trim().replace(/\s+/g, " ");
    const key = `${message.toolName ?? "tool"}:${normalized}`;
    const current = byToolOutput.get(key) ?? {
      name: message.toolName ?? "tool",
      tool_name: message.toolName ?? "tool",
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      estimated_cost: 0,
      repeated_count: 0,
      message_ids: []
    };
    const inputTokens = messageInputTokens(message);
    current.input_tokens += inputTokens;
    current.total_tokens += inputTokens;
    current.repeated_count += 1;
    current.message_ids.push(message.id);
    byToolOutput.set(key, current);
  }

  return sortByTokens(
    [...byToolOutput.values()]
      .map((bucket) => ({ ...bucket, estimated_cost: estimatedCostFor(trace.model, bucket.input_tokens, bucket.output_tokens) }))
      .filter((bucket) => bucket.repeated_count > 1 || bucket.total_tokens > 0)
  );
}

function wastePatternBuckets(trace: AgentTrace, findings: WasteFinding[]): WastePatternSpendBucket[] {
  const byPattern = new Map<WasteFinding["category"], WastePatternSpendBucket>();
  for (const finding of findings) {
    const current = byPattern.get(finding.category) ?? {
      pattern: finding.category,
      estimated_tokens: 0,
      estimated_cost: 0,
      finding_count: 0,
      message_ids: [],
      summaries: []
    };
    current.estimated_tokens += finding.estimatedTokens;
    current.finding_count += 1;
    current.message_ids.push(...finding.messageIds);
    current.summaries.push(finding.summary);
    byPattern.set(finding.category, current);
  }

  return sortByTokens(
    [...byPattern.values()].map((bucket) => ({ ...bucket, estimated_cost: estimatedCostFor(trace.model, bucket.estimated_tokens, 0) }))
  );
}

/**
 * Per-skill skill-injection spend buckets (report-only). Built from the SEPARATE
 * skill-injection detector; never reuses the tool-output dedup map and never affects
 * compaction. Returns the buckets (sorted by est tokens desc) and the total addressable est.
 */
function skillInjectionBuckets(trace: AgentTrace): { buckets: SkillInjectionSpendBucket[]; addressableTokens: number } {
  const advisory = buildSkillInjectionAdvisory(trace);
  const buckets: SkillInjectionSpendBucket[] = advisory.skills.map((skill) => ({
    name: skill.skill_name,
    skill_name: skill.skill_name,
    input_tokens: skill.estimated_tokens,
    output_tokens: 0,
    total_tokens: skill.estimated_tokens,
    estimated_cost: estimatedCostFor(trace.model, skill.estimated_tokens, 0),
    message_count: skill.redundant_byte_identical_copies,
    redundant_byte_identical_copies: skill.redundant_byte_identical_copies,
    redundant_copy_message_ids: skill.redundant_copy_message_ids
  }));
  return { buckets: sortByTokens(buckets), addressableTokens: advisory.total_addressable_estimated_tokens };
}

function repeatedSegments(trace: AgentTrace, findings: WasteFinding[]): RepeatedContextSegmentSpend[] {
  return findings.map((finding, index) => ({
    segment_id: `segment_${index + 1}`,
    category: finding.category,
    estimated_tokens: finding.estimatedTokens,
    estimated_cost: estimatedCostFor(trace.model, finding.estimatedTokens, 0),
    message_ids: finding.messageIds,
    summary: finding.summary
  }));
}

/**
 * Resolve the optimization delta for a trace. Uses the supplied engine provider when present;
 * otherwise returns the honest engine-gated fallback (no policy candidate, no synthetic saving).
 */
async function resolveOptimizationDelta(
  trace: AgentTrace,
  before: { inputTokens: number; outputTokens: number },
  costBefore: number,
  generatedAt: string,
  provider?: OptimizationDeltaProvider
): Promise<TraceOptimizationDelta> {
  if (!provider) return unavailableOptimizationDelta();
  return provider(trace, before, costBefore, generatedAt);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

async function loadTraceFromOptimization(summary: OptimizationSummaryLike, sourcePath: string): Promise<AgentTrace | null> {
  const capturedTracePath = summary.artifact_paths?.captured_trace;
  if (capturedTracePath && (await fileExists(capturedTracePath))) {
    return agentTraceSchema.parse(await readJsonFile<unknown>(capturedTracePath));
  }

  const siblingTracePath = path.join(path.dirname(sourcePath), "captured-trace.json");
  if (await fileExists(siblingTracePath)) {
    return agentTraceSchema.parse(await readJsonFile<unknown>(siblingTracePath));
  }

  return null;
}

function policyCandidateBucket(summary: SpendSummary): PolicyCandidateSpendBucket[] {
  if (!summary.policy_candidate) return [];
  return [
    {
      policy_name: summary.policy_candidate,
      estimated_tokens_saved: summary.tokens_saved,
      estimated_saving_per_run: summary.estimated_saving_per_run,
      percent_reduction: summary.percent_reduction,
      safety_status: summary.safety_status,
      risk_level: summary.risk_level,
      recommendation_mode: summary.recommendation_mode
    }
  ];
}

async function buildTraceSpendSummary(input: {
  trace: AgentTrace;
  sourcePath: string;
  generatedAt: string;
  integration: string | null;
  optimizationDeltaProvider?: OptimizationDeltaProvider;
}): Promise<SpendSummary> {
  const { trace, generatedAt } = input;
  // FREE local attribution - no engine. Where spend comes from, by role / tool output / waste
  // pattern / skill injection, plus before-tokens and before-cost. Always computed.
  const findings = detectWaste(trace);
  const before = estimateTraceTokens(trace);
  const costBefore = calculateCost(trace.model, before);
  const usageMetadata = localEstimateUsageMetadata(trace);
  const pricingAssumptions = usageMetadata.pricing_assumption ? [usageMetadata.pricing_assumption] : [];
  const byRole = spendByRole(trace);
  const byToolOutput = spendByToolOutput(trace);
  const byWastePattern = wastePatternBuckets(trace, findings);
  const skillInjection = skillInjectionBuckets(trace);
  // PROPRIETARY optimization delta - engine-derived when a provider is supplied; otherwise the
  // honest engine-gated fallback (no policy candidate, no synthetic saving). Never crashes the free path.
  const delta = await resolveOptimizationDelta(trace, before, costBefore.totalCostUsd, generatedAt, input.optimizationDeltaProvider);
  const summaryBase: Omit<SpendSummary, "spend_by_policy_candidate" | "top_policy_candidate"> = {
    trace_id: trace.id,
    generated_at: generatedAt,
    integration: input.integration,
    token_metadata_status: metadataStatusFor(trace, "token"),
    cost_metadata_status: metadataStatusFor(trace, "cost"),
    usage_metadata: usageMetadata,
    spend_confidence: usageMetadata.cost_confidence,
    pricing_assumptions: pricingAssumptions,
    input_tokens_before: before.inputTokens,
    input_tokens_after: delta.available ? delta.tokens_after : before.inputTokens,
    output_tokens_before: before.outputTokens,
    output_tokens_after: before.outputTokens,
    tokens_saved: delta.tokens_saved,
    percent_reduction: percentReduction(before.inputTokens, delta.tokens_saved),
    savings_scope: "policy_level",
    estimated_cost_before: roundCurrency(costBefore.totalCostUsd),
    estimated_cost_after: delta.available ? roundCurrency(delta.cost_after) : roundCurrency(costBefore.totalCostUsd),
    estimated_saving_per_run: delta.saving_per_run,
    spend_by_role: byRole,
    spend_by_tool_output: byToolOutput,
    spend_by_repeated_context_segment: repeatedSegments(trace, findings),
    spend_by_waste_pattern: byWastePattern,
    spend_by_skill_injection: skillInjection.buckets,
    skill_injection_addressable_estimated_tokens: skillInjection.addressableTokens,
    top_waste_patterns: byWastePattern.slice(0, 3),
    top_role_category: byRole[0] ?? null,
    top_repeated_tool_output: byToolOutput.find((bucket) => bucket.repeated_count > 1) ?? byToolOutput[0] ?? null,
    top_waste_pattern: byWastePattern[0] ?? null,
    policy_candidate: delta.policy_candidate,
    optimization_delta_available: delta.available,
    safety_status: delta.safety_status,
    risk_level: delta.risk_level,
    recommendation_mode: delta.recommendation_mode,
    next_step: delta.next_step,
    limitations: [...SPEND_LIMITATIONS],
    source_path: input.sourcePath,
    input_kind: "trace"
  };
  const candidateBuckets = policyCandidateBucket({ ...summaryBase, spend_by_policy_candidate: [], top_policy_candidate: null });
  return { ...summaryBase, spend_by_policy_candidate: candidateBuckets, top_policy_candidate: candidateBuckets[0] ?? null };
}

async function buildOptimizationSpendSummary(input: {
  summary: OptimizationSummaryLike;
  sourcePath: string;
  generatedAt: string;
  optimizationDeltaProvider?: OptimizationDeltaProvider;
}): Promise<SpendSummary> {
  const trace = await loadTraceFromOptimization(input.summary, input.sourcePath);
  const traceSummary = trace
    ? await buildTraceSpendSummary({ trace, sourcePath: input.sourcePath, generatedAt: input.generatedAt, integration: input.summary.integration ?? null, optimizationDeltaProvider: input.optimizationDeltaProvider })
    : null;
  const byRole = traceSummary?.spend_by_role ?? [];
  const byToolOutput = traceSummary?.spend_by_tool_output ?? [];
  const byWastePattern = traceSummary?.spend_by_waste_pattern ?? [];
  const inputTokensBefore = input.summary.original_input_tokens ?? traceSummary?.input_tokens_before ?? 0;
  const inputTokensAfter = input.summary.compacted_input_tokens ?? traceSummary?.input_tokens_after ?? 0;
  const tokensSaved = input.summary.tokens_saved ?? Math.max(0, inputTokensBefore - inputTokensAfter);
  const policyCandidate = input.summary.policy_name ?? traceSummary?.policy_candidate ?? null;
  const safetyStatus = input.summary.safety_status ?? traceSummary?.safety_status ?? "missing";
  const riskLevel = input.summary.risk_level ?? traceSummary?.risk_level ?? "medium";
  const recommendationMode = input.summary.recommendation_mode ?? traceSummary?.recommendation_mode ?? "observe";
  const usageMetadata = input.summary.usage_metadata ?? traceSummary?.usage_metadata ?? (trace ? localEstimateUsageMetadata(trace) : { provider_reported_tokens: false, estimated_tokens: false, cost_source: "unknown" as const, cost_confidence: "unknown" as const, limitations: ["Usage metadata was not present on the source artifact."] });
  const pricingAssumptions = input.summary.pricing_assumptions ?? traceSummary?.pricing_assumptions ?? (usageMetadata.pricing_assumption ? [usageMetadata.pricing_assumption] : []);
  const summaryBase: Omit<SpendSummary, "spend_by_policy_candidate" | "top_policy_candidate"> = {
    trace_id: input.summary.trace_id ?? traceSummary?.trace_id ?? "unknown",
    generated_at: input.generatedAt,
    integration: input.summary.integration ?? traceSummary?.integration ?? null,
    ...(input.summary.integration_workflow ?? traceSummary?.integration_workflow ? { integration_workflow: input.summary.integration_workflow ?? traceSummary?.integration_workflow } : {}),
    token_metadata_status: input.summary.token_metadata_status ?? traceSummary?.token_metadata_status ?? "unknown",
    cost_metadata_status: input.summary.cost_metadata_status ?? traceSummary?.cost_metadata_status ?? "unknown",
    usage_metadata: usageMetadata,
    spend_confidence: input.summary.spend_confidence ?? usageMetadata.cost_confidence,
    pricing_assumptions: pricingAssumptions,
    input_tokens_before: inputTokensBefore,
    input_tokens_after: inputTokensAfter,
    ...(traceSummary?.output_tokens_before !== undefined ? { output_tokens_before: traceSummary.output_tokens_before } : {}),
    ...(traceSummary?.output_tokens_after !== undefined ? { output_tokens_after: traceSummary.output_tokens_after } : {}),
    tokens_saved: tokensSaved,
    percent_reduction: input.summary.percent_reduction ?? percentReduction(inputTokensBefore, tokensSaved),
    savings_scope: input.summary.savings_scope ?? "policy_level",
    estimated_cost_before: roundCurrency(input.summary.cost_before_per_run ?? traceSummary?.estimated_cost_before ?? 0),
    estimated_cost_after: roundCurrency(input.summary.cost_after_per_run ?? traceSummary?.estimated_cost_after ?? 0),
    estimated_saving_per_run: roundCurrency(input.summary.saving_per_run ?? traceSummary?.estimated_saving_per_run ?? 0),
    spend_by_role: byRole,
    spend_by_tool_output: byToolOutput,
    spend_by_repeated_context_segment: traceSummary?.spend_by_repeated_context_segment ?? [],
    spend_by_waste_pattern: byWastePattern,
    spend_by_skill_injection: traceSummary?.spend_by_skill_injection ?? [],
    skill_injection_addressable_estimated_tokens: traceSummary?.skill_injection_addressable_estimated_tokens ?? 0,
    top_waste_patterns: byWastePattern.slice(0, 3),
    top_role_category: byRole[0] ?? null,
    top_repeated_tool_output: byToolOutput.find((bucket) => bucket.repeated_count > 1) ?? byToolOutput[0] ?? null,
    top_waste_pattern: byWastePattern[0] ?? null,
    policy_candidate: policyCandidate,
    // The optimization summary is itself engine-produced evidence; the delta is "available" when the
    // summary carries policy/savings data OR the trace-level delta was engine-computed. Otherwise the
    // optimization-delta fields are the honest engine-gated fallback.
    optimization_delta_available:
      input.summary.policy_name != null ||
      input.summary.tokens_saved != null ||
      (traceSummary?.optimization_delta_available ?? false),
    safety_status: safetyStatus,
    risk_level: riskLevel,
    recommendation_mode: recommendationMode,
    ...(input.summary.approval_status ? { approval_status: input.summary.approval_status } : {}),
    next_step: input.summary.recommended_next_step ?? traceSummary?.next_step ?? "Review the spend summary and approve/apply only through an explicit local workflow.",
    limitations: [...SPEND_LIMITATIONS],
    source_path: input.sourcePath,
    input_kind: "optimization_summary"
  };
  const candidateBuckets = policyCandidateBucket({ ...summaryBase, spend_by_policy_candidate: [], top_policy_candidate: null });
  return { ...summaryBase, spend_by_policy_candidate: candidateBuckets, top_policy_candidate: candidateBuckets[0] ?? null };
}

function isOptimizationSummary(value: Record<string, unknown>): boolean {
  return typeof value.optimization_id === "string" || (typeof value.trace_id === "string" && typeof value.original_input_tokens === "number");
}

/**
 * Build a SpendSummary directly from an in-memory trace, reusing the exact same
 * attribution computation used by the `spend` CLI command (buildTraceSpendSummary).
 * Exposed so the compaction report can surface a concise spend-by-source summary
 * WITHOUT reimplementing attribution logic. Numbers are local estimates (chars/4 /
 * price-table), NOT billing-confirmed and NOT realized savings.
 */
export async function buildSpendSummaryFromTrace(
  trace: AgentTrace,
  generatedAt = new Date().toISOString(),
  integration: string | null = null,
  optimizationDeltaProvider?: OptimizationDeltaProvider
): Promise<SpendSummary> {
  return buildTraceSpendSummary({ trace, sourcePath: "in-memory-trace", generatedAt, integration, optimizationDeltaProvider });
}

export async function createSpendSummaryFromPath(
  sourcePath: string,
  generatedAt = new Date().toISOString(),
  optimizationDeltaProvider?: OptimizationDeltaProvider
): Promise<SpendSummary> {
  const raw = await readJsonFile<unknown>(sourcePath);
  const record = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  if (!record) {
    throw new Error(`Spend attribution input must be a JSON object: ${sourcePath}`);
  }

  if (isOptimizationSummary(record)) {
    return buildOptimizationSpendSummary({ summary: record as OptimizationSummaryLike, sourcePath, generatedAt, optimizationDeltaProvider });
  }

  const trace = agentTraceSchema.parse(record);
  return buildTraceSpendSummary({ trace, sourcePath, generatedAt, integration: null, optimizationDeltaProvider });
}

function describeBucket(bucket: SpendBucket | ToolSpendBucket | WastePatternSpendBucket | PolicyCandidateSpendBucket | null): string {
  if (!bucket) return "none";
  if ("pattern" in bucket) return `${bucket.pattern} (${bucket.estimated_tokens} tokens, ${formatCurrency(bucket.estimated_cost)})`;
  if ("policy_name" in bucket) return `${bucket.policy_name} (${bucket.estimated_tokens_saved} tokens saved, ${formatCurrency(bucket.estimated_saving_per_run)} per run)`;
  if ("tool_name" in bucket) return `${bucket.tool_name} (${bucket.total_tokens} tokens across ${bucket.repeated_count} output(s))`;
  return `${bucket.name} (${bucket.total_tokens} tokens, ${formatCurrency(bucket.estimated_cost)})`;
}

export function formatSpendConsoleSummary(summary: SpendSummary): string {
  return [
    "Context spend summary",
    `Trace id: ${summary.trace_id}`,
    `Integration: ${summary.integration ?? "unknown"}`,
    ...(summary.integration_workflow
      ? [
          `Integration workflow: Level ${summary.integration_workflow.readiness_level} ${summary.integration_workflow.capture_mode}`,
          `Real workflow status: ${summary.integration_workflow.real_workflow_status}`,
          `Provenance status: ${summary.integration_workflow.provenance_status}`
        ]
      : []),
    `Token metadata status: ${summary.token_metadata_status}`,
    `Cost metadata status: ${summary.cost_metadata_status}`,
    `Spend confidence: ${summary.spend_confidence}`,
    ...describeTokenMetadata(summary.usage_metadata),
    ...describeCostMetadata(summary.usage_metadata),
    `Input tokens before: ${summary.input_tokens_before} (local estimate)`,
    `Estimated cost before: ${formatCurrency(summary.estimated_cost_before)} (local estimate)`,
    ...(summary.optimization_delta_available
      ? [
          `Input tokens after optimization: ${summary.input_tokens_after}`,
          `Policy-level tokens saved: ${summary.tokens_saved}`,
          `Percent reduction: ${summary.percent_reduction}%`,
          `Estimated cost after: ${formatCurrency(summary.estimated_cost_after)}`,
          `Estimated saving per run: ${formatCurrency(summary.estimated_saving_per_run)}`
        ]
      : [`Optimization delta: ${ENGINE_GATED_NEXT_STEP}`]),
    "",
    "Where spend came from",
    `Top role/category: ${describeBucket(summary.top_role_category)}`,
    `Top repeated tool output: ${describeBucket(summary.top_repeated_tool_output)}`,
    `Top waste pattern: ${describeBucket(summary.top_waste_pattern)}`,
    ...(summary.optimization_delta_available ? [`Top policy candidate: ${describeBucket(summary.top_policy_candidate)}`] : []),
    "",
    "Optimization delta",
    ...(summary.optimization_delta_available
      ? [
          `Policy candidate: ${summary.policy_candidate ?? "none"}`,
          `Safety status: ${summary.safety_status}`,
          `Risk level: ${summary.risk_level}`,
          `Recommendation mode: ${summary.recommendation_mode}`,
          `Approval status: ${summary.approval_status ?? "unknown"}`,
          `Next step: ${summary.next_step}`
        ]
      : [ENGINE_GATED_NEXT_STEP]),
    "",
    "Limitations",
    ...summary.limitations.map((limitation) => `- ${limitation}`),
    "",
    "Skill-injection repetition (ADVISORY - report-only; nothing compacted)",
    `Total addressable (est, chars/4): ${summary.skill_injection_addressable_estimated_tokens} tokens - NOT billing-confirmed, NOT realized, NOT applied`,
    ...(summary.spend_by_skill_injection.length === 0
      ? ["No repeated byte-identical same-skill role:user injections detected."]
      : summary.spend_by_skill_injection.map(
          (bucket) => `- ${bucket.skill_name}: ${bucket.redundant_byte_identical_copies} redundant byte-identical copies, ${bucket.total_tokens} est tokens (${formatCurrency(bucket.estimated_cost)} est)`
        ))
  ].join("\n");
}

function markdownTable(rows: string[][]): string[] {
  if (rows.length === 0) return ["No local attribution available."];
  const header = rows[0].map((cell) => cell.replace(/\|/g, "\\|")).join(" | ");
  const separator = rows[0].map(() => "---").join(" | ");
  const body = rows.slice(1).map((row) => row.map((cell) => cell.replace(/\|/g, "\\|")).join(" | "));
  return [`| ${header} |`, `| ${separator} |`, ...body.map((row) => `| ${row} |`)];
}

export function formatSpendMarkdown(summary: SpendSummary): string {
  return [
    "# Context Spend Summary",
    "",
    "## Summary",
    `- Trace id: ${summary.trace_id}`,
    `- Integration: ${summary.integration ?? "unknown"}`,
    ...(summary.integration_workflow
      ? [
          `- Integration workflow: Level ${summary.integration_workflow.readiness_level} ${summary.integration_workflow.capture_mode}`,
          `- Real workflow status: ${summary.integration_workflow.real_workflow_status}`,
          `- Provenance status: ${summary.integration_workflow.provenance_status}`
        ]
      : []),
    `- Token metadata status: ${summary.token_metadata_status}`,
    `- Cost metadata status: ${summary.cost_metadata_status}`,
    `- Spend confidence: ${summary.spend_confidence}`,
    ...describeTokenMetadata(summary.usage_metadata).map((line) => `- ${line}`),
    ...describeCostMetadata(summary.usage_metadata).map((line) => `- ${line}`),
    `- Input tokens before: ${summary.input_tokens_before} (local estimate)`,
    `- Estimated cost before: ${formatCurrency(summary.estimated_cost_before)} (local estimate)`,
    ...(summary.optimization_delta_available
      ? [
          `- Input tokens after optimization: ${summary.input_tokens_after}`,
          `- Policy-level tokens saved: ${summary.tokens_saved}`,
          `- Percent reduction: ${summary.percent_reduction}%`,
          `- Estimated cost after: ${formatCurrency(summary.estimated_cost_after)}`,
          `- Estimated saving per run: ${formatCurrency(summary.estimated_saving_per_run)}`
        ]
      : [`- Optimization delta: ${ENGINE_GATED_NEXT_STEP}`]),
    "",
    "## Where Spend Came From",
    ...markdownTable([
      ["Category", "Top item"],
      ["Role/category", describeBucket(summary.top_role_category)],
      ["Repeated tool output", describeBucket(summary.top_repeated_tool_output)],
      ["Waste pattern", describeBucket(summary.top_waste_pattern)],
      ...(summary.optimization_delta_available ? [["Policy candidate", describeBucket(summary.top_policy_candidate)]] : [])
    ]),
    "",
    "## Optimization Delta",
    ...(summary.optimization_delta_available
      ? [
          `- Policy candidate: ${summary.policy_candidate ?? "none"}`,
          `- Policy-level tokens saved: ${summary.tokens_saved}`,
          `- Percent reduction: ${summary.percent_reduction}%`,
          `- Estimated saving per run: ${formatCurrency(summary.estimated_saving_per_run)}`,
          "",
          "## Safety",
          `- Safety status: ${summary.safety_status}`,
          `- Risk level: ${summary.risk_level}`,
          "",
          "## Recommendation",
          `- Recommendation mode: ${summary.recommendation_mode}`,
          `- Next step: ${summary.next_step}`,
          "",
          "## Approval Status",
          summary.approval_status ?? "unknown"
        ]
      : [`- ${ENGINE_GATED_NEXT_STEP}`]),
    "",
    "## Skill-Injection Repetition (Advisory - Report-Only)",
    "",
    "> Report-only: nothing is compacted. Figures are estimated (chars/4) trace-token volume - NOT billing-confirmed, NOT realized savings, NOT yet applied.",
    "",
    `- Total addressable (est): ${summary.skill_injection_addressable_estimated_tokens} tokens`,
    ...(summary.spend_by_skill_injection.length === 0
      ? ["- No repeated byte-identical same-skill role:user injections detected."]
      : markdownTable([
          ["Skill", "Redundant byte-identical copies", "Est tokens", "Est cost"],
          ...summary.spend_by_skill_injection.map((bucket) => [
            bucket.skill_name,
            String(bucket.redundant_byte_identical_copies),
            String(bucket.total_tokens),
            formatCurrency(bucket.estimated_cost)
          ])
        ])),
    "",
    "## Limitations",
    ...summary.limitations.map((limitation) => `- ${limitation}`),
    ""
  ].join("\n");
}

export async function writeSpendArtifacts(
  inputPath: string,
  outRoot = SPEND_ARTIFACT_ROOT,
  generatedAt = new Date().toISOString(),
  optimizationDeltaProvider?: OptimizationDeltaProvider
): Promise<SpendArtifacts> {
  const summary = await createSpendSummaryFromPath(inputPath, generatedAt, optimizationDeltaProvider);
  const outputDirectory = path.join(outRoot, createSpendRunId(new Date(generatedAt)));
  const spendSummaryJsonPath = await writeJsonArtifact(outputDirectory, "spend-summary.json", summary);
  const spendSummaryMarkdownPath = await writeTextArtifact(outputDirectory, "spend-summary.md", formatSpendMarkdown(summary));

  return {
    summary,
    outputDirectory,
    terminalSummary: formatSpendConsoleSummary(summary),
    paths: { spendSummaryJsonPath, spendSummaryMarkdownPath }
  };
}

export function defaultSpendPolicyName(): string {
  return COMPACTION_POLICY_NAME;
}
