/**
 * Structural contracts for the modules the public tree loads LAZILY.
 *
 * Several public CLI commands and seams reach a capability that is not part of the public package by
 * `await import(...)`ing it and degrading honestly when it is absent (see `module-absence.ts`). The
 * import is deliberately dynamic, but the BINDING still has to have a type, and naming the private
 * module in a `import type` or in a literal `import("./x.js")` makes the public tree fail to compile
 * on its own.
 *
 * So each such module gets a contract here: the smallest shape its public callers actually consume,
 * expressed in public types. Public code imports the contract and asserts the dynamic import against
 * it; the private module keeps its own richer types and simply satisfies this one (a private
 * conformance check fails the in-repo build if it ever stops doing so). Members are declared with
 * METHOD syntax on purpose - the bivariance that gives is what lets a precisely-typed private
 * function satisfy a deliberately looser public parameter.
 *
 * This is a type surface only. It describes what callers already read; it does not widen the runtime
 * boundary, and nothing here changes which modules ship.
 */
import type { AgentTrace, CompactionPolicy, CompactionReport, StateCapsule } from "./types.js";
import type { PolicyMiddlewareResult } from "./policy-types.js";
import type { ApplyReport, RecommendationMode, RecommendationReport } from "./report-types.js";
import type { ReviewerType, SafetyReport } from "./safety-report.js";
import type { TokenAccounting } from "./token-accounting.js";
import type { WasteFinding } from "./types.js";

/** Written artifacts are reported to the user by path; every producer returns a bag of them. */
type ArtifactPath = string;

/* ---------------------------------------------------------------- policy + compaction artifacts */

export interface PolicyMiddlewareContract {
  applyCompactionPolicy(input: { trace: AgentTrace; compactSkillInjections?: boolean }): PolicyMiddlewareResult;
}

export interface CompactionArtifactPathsView {
  reportPath: ArtifactPath;
  markdownReportPath: ArtifactPath;
  policyPath: ArtifactPath;
  capsulePath: ArtifactPath;
  compactedTracePath: ArtifactPath;
  safetyReportPath: ArtifactPath;
  safetyMarkdownReportPath: ArtifactPath;
  prCommentReportPath: ArtifactPath;
}

export interface SkillInjectionCompactionView {
  compacted_count: number;
  estimated_tokens_removed: number;
  estimate_label: string;
}

export interface CompactionArtifactResultView {
  report: CompactionReport;
  policy: CompactionPolicy;
  capsule: StateCapsule;
  compactedTrace: AgentTrace;
  consoleReport: string;
  safetyReport: SafetyReport;
  skillInjectionCompaction: SkillInjectionCompactionView;
  paths: CompactionArtifactPathsView;
}

export interface CompactionArtifactsContract {
  writeCompactionArtifacts(
    trace: AgentTrace,
    outputDirectory: string,
    runId: string,
    providedPolicyResult?: PolicyMiddlewareResult,
    generatedAt?: string,
    options?: { reviewerType?: ReviewerType; reviewSummaryPresent?: boolean; approveSkillInjectionPolicy?: boolean }
  ): Promise<CompactionArtifactResultView>;
}

/* --------------------------------------------------------------------------- recommend + apply */

export interface RecommendationContract {
  isRecommendationMode(value: string): value is RecommendationMode;
  createRecommendation(input: {
    trace: AgentTrace;
    policyResult: PolicyMiddlewareResult;
    generatedAt?: string;
    safetyReport?: SafetyReport;
    findings?: WasteFinding[];
  }): RecommendationReport;
}

export interface RecommendationArtifactsContract {
  formatFutureModesNotice(): string;
  writeRecommendationArtifacts(recommendation: RecommendationReport): Promise<{
    paths: { recommendationJsonPath: ArtifactPath; recommendationMarkdownPath: ArtifactPath };
  }>;
}

export interface ApplyModeContract {
  writeApplyArtifacts(input: {
    trace: AgentTrace;
    policy: { name: string; isLocal: boolean; isDeterministic: boolean };
    requireSafetyPass: boolean;
    generatedAt?: string;
    recommendationMode?: RecommendationMode;
  }): Promise<{
    report: ApplyReport;
    paths: { appliedTracePath: ArtifactPath; applyReportJsonPath: ArtifactPath; applyReportMarkdownPath: ArtifactPath };
  }>;
}

/* ------------------------------------------------------------------------ in-workflow apply */

export interface InWorkflowApplyContract {
  IN_WORKFLOW_APPLY_ARTIFACT_ROOT: string;
  runInWorkflowApply(input: {
    trace: AgentTrace;
    outputDirectory: string;
    approveInWorkflowUse: boolean;
    approveSkillInjectionPolicy: boolean;
    generatedAt?: string;
  }): Promise<{
    consoleSummary: string;
    outputDirectory: string;
    approvedContextEmitted: boolean;
    /** Opaque here: the CLI only tests it for presence and hands it straight back below. */
    approvalRecord?: unknown;
    review: { policies_applied: string[] };
    paths: {
      preApplyReviewJsonPath: ArtifactPath;
      preApplyReviewMarkdownPath: ArtifactPath;
      retainedOriginalPath: ArtifactPath;
      approvedContextPath?: ArtifactPath;
      applyApprovalRecordPath?: ArtifactPath;
    };
  }>;
  recordOperatorAttestation(input: {
    outputDirectory: string;
    applyApprovalRecord: unknown;
    applyApprovalRecordPath: string;
    generatedAt?: string;
    operatorNote?: string;
  }): Promise<{ record: { provenance_label: string }; path: ArtifactPath }>;
}

/* --------------------------------------------------------------------------- approve + review */

export interface OptimizationApprovalContract {
  approveOptimization(input: {
    optimizationId: string;
    requireSafetyPass: boolean;
    approveSkillInjectionPolicy: boolean;
  }): Promise<ApprovalArtifactsView>;
}

export interface ApprovalArtifactsView {
  terminalSummary: string;
  outputDirectory: string;
  report: { approved: boolean };
  paths: {
    approvalReportJsonPath: ArtifactPath;
    approvalReportMarkdownPath: ArtifactPath;
    approvedTracePath?: ArtifactPath;
  };
}

export interface PreApplyApprovalViewContract {
  buildPreApplyApprovalView(input: {
    optimizationId: string;
    requireSafetyPass: boolean;
    includeSkillInjectionPolicy: boolean;
  }): Promise<{
    terminalSummary: string;
    outputDirectory: string;
    report: { approval_readiness: string };
    paths: { preApplyReportJsonPath: ArtifactPath; preApplyReportMarkdownPath: ArtifactPath };
  }>;
}

export interface OptimizationReviewContract {
  createOptimizationReview(input: {
    sourceArtifactPath: string;
    requireSafetyPass: boolean;
    approvalRequested: boolean;
    approvalConfirmed: boolean;
  }): Promise<{
    terminalSummary: string;
    outputDirectory: string;
    summary: { approval_decision: string };
    approvalArtifacts?: ApprovalArtifactsView;
    paths: { reviewSummaryJsonPath?: ArtifactPath; reviewSummaryMarkdownPath?: ArtifactPath };
  }>;
}

/* -------------------------------------------------------------------------------------- evals */

/** The recoverability eval fields the CLI prints. The verdicts stay strings: the CLI only echoes them. */
export interface EvalResultView {
  recoverability: string;
  recoverability_reason: string;
  recoverability_checks: ReadonlyArray<{ status: string; label: string }>;
  evidence_source: string;
  evidence_source_type: string;
  real_captured: boolean;
  semantic_preservation: string;
  commitment_preservation: string;
}

export interface StrongEvalResultView {
  commitment_preservation: {
    status: string;
    reason: string;
    commitment_count: number;
    retained_count: number;
    recoverable_count: number;
    missing_count: number;
    details: ReadonlyArray<{ recoverability: string; category: string; text: string }>;
  };
  task_check: { status: string; workflow: string; reason: string };
  token_accounting: TokenAccounting;
  readiness: { readiness: string; reason: string; checks: ReadonlyArray<{ status: string; axis: string; reason: string }> };
}

export interface EvalHarnessContract {
  evaluateCompactionResult(trace: AgentTrace, policyResult: PolicyMiddlewareResult, runId: string): EvalResultView;
  evaluateStrongCompactionResult(input: {
    originalTrace: AgentTrace;
    policyResult: PolicyMiddlewareResult;
    runId: string;
    reviewerType?: ReviewerType;
    reviewSummaryPresent?: boolean;
  }): StrongEvalResultView;
  formatStrongEvalMarkdownReport(strong: unknown): string;
}

export interface EvalFixturesContract {
  evaluateFixtureFile(fixturePath: string, generatedAt?: string): Promise<EvalResultView>;
  evaluateFixtureDirectory(inputPath: string): Promise<{
    trace_count: number;
    recoverability_rollup: { passed: number; failed: number; not_computed: number };
    recoverability_pass_rate: number | null;
    real_captured_count: number;
  }>;
  writeEvalArtifacts(
    result: unknown,
    outputDirectory: string
  ): Promise<{ evalReportJsonPath: ArtifactPath; evalReportMarkdownPath: ArtifactPath }>;
  writeCorpusEvalArtifacts(
    corpus: unknown,
    outputDirectory: string
  ): Promise<{ evalReportJsonPath: ArtifactPath; evalReportMarkdownPath: ArtifactPath }>;
}

/* --------------------------------------------------------------------------- audits + capture */

export interface AdapterAuditContract {
  runAdapterAudit(
    inputDirectory: string,
    adapterId: string
  ): Promise<{
    consoleSummary: string;
    paths: { adapterAuditSummaryJsonPath: ArtifactPath; adapterAuditSummaryMarkdownPath: ArtifactPath };
  }>;
}

export interface PilotAuditContract {
  runLocalTraceAuditPilot(
    inputDirectory: string,
    source: string
  ): Promise<{
    consoleSummary: string;
    paths: { pilotSummaryJsonPath: ArtifactPath; pilotSummaryMarkdownPath: ArtifactPath };
  }>;
}

export interface IntegrationsContract {
  runIntegration(input: { integrationId: string; outRoot?: string; commandParts: string[] }): Promise<{
    terminalSummary: string;
    outputDirectory: string;
    paths: { normalizedTracePath: ArtifactPath; reportJsonPath: ArtifactPath; reportMarkdownPath: ArtifactPath };
  }>;
}

export interface OpenAIAgentsOptimizationContract {
  optimizeOpenAIAgents(input: { outRoot?: string; commandParts: string[] }): Promise<{
    terminalSummary: string;
    outputDirectory: string;
    usedLocalFixture: boolean;
    summary: { status: string };
    paths: {
      capturedTracePath: ArtifactPath;
      optimizationSummaryJsonPath: ArtifactPath;
      optimizationSummaryMarkdownPath: ArtifactPath;
    };
  }>;
}

/* --------------------------------------------------------------- treatment-session setup (Lane B) */

/** Both launcher steps refuse the same way: nothing written, reasons printed, non-zero exit. */
interface Refusal {
  refused: true;
  reasons: string[];
}

export interface SessionSeedExportContract {
  exportSessionSeed(
    input: { applyDir: string; outFile?: string }
  ): Promise<Refusal | { refused: false; consoleSummary: string; seedPath: ArtifactPath }>;
}

export interface TreatmentSessionLauncherContract {
  prepareTreatmentSessionLauncher(input: {
    applyDir: string;
    outScript?: string;
    seedFile?: string;
    projectDir?: string;
  }): Promise<Refusal | { refused: false; consoleSummary: string; scriptPath: ArtifactPath }>;
}
