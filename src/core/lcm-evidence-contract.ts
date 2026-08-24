/**
 * LCM CONTENT-FREE EVIDENCE CONTRACT (PUBLIC CLI/SDK code, engine-free, ships in the npm package).
 *
 * The ONLY LCM-related type that may reach a dashboard/API surface. It mirrors the role of
 * `dashboard-contract.ts`: a schema-versioned, content-free projection carrying ONLY counts, enum
 * labels, versions, per-dimension pass/fail/uncertain/not_computed results, outcomes, class ids,
 * latency/cost numbers, and recovery-EXISTENCE (a boolean, never recovery content).
 *
 * OPEN-CORE BOUNDARY: this module imports NOTHING (no `src/engine/**`, no runtime dependency). The
 * private evaluation internals live in `src/engine/lcm/**` (npm-excluded; only the open-core hybrid
 * slice ships); the engine imports THIS module's label vocabulary, never the reverse.
 * `npm run boundary:engine` asserts the CLI static graph reaches zero engine modules.
 *
 * CONTENT-FREE BY CONSTRUCTION, THREE LAYERS:
 *   1. The type has no field that can carry prompt/response/tool/system/source/candidate text -
 *      sections and capsule refs are projected to COUNTS; the recovery pointer becomes a boolean.
 *   2. `toContentFreeLcmEvidence` builds the output from EXPLICIT field picks (never a spread of the
 *      private input), so unknown private fields, including any content-bearing candidate text -
 *      can never ride along.
 *   3. `scanContentFreeLcmEvidence` (same fail-closed pattern as the ingest scanner in
 *      `apps/api/src/ingest.ts`) re-scans the BUILT output and rejects any content-shaped key
 *      (`prompt`/`response`/`messages`/`content`/`candidateText`/`sourceText`/…), any
 *      credential-looking `sk-…` value, and any string too long or multi-line to be a label.
 *
 * PROVENANCE HONESTY (structural): a `traceSource`/`evidenceSource` of `synthetic-fixture` or
 * `benchmark-fixture` can NEVER carry `liveVerified: true`, the `LcmProvenanceLabels` union makes
 * that state unrepresentable, and the projector additionally REFUSES (throws, never silently
 * downgrades) an input claiming it. Fixture evidence is never rendered live.
 */

/** Pinned contract version for the content-free LCM evidence document. */
export const LCM_EVIDENCE_CONTRACT_VERSION = "1";

/** Where the underlying trace/evidence came from. Fixtures are NEVER renderable as live. */
export const LCM_SOURCE_LABELS = ["real-local", "synthetic-fixture", "benchmark-fixture"] as const;
export type LcmSourceLabel = (typeof LCM_SOURCE_LABELS)[number];
export type LcmFixtureSourceLabel = "synthetic-fixture" | "benchmark-fixture";

/** The evaluation dimensions an LCM candidate is judged on (results only, never judged content). */
export const LCM_EVIDENCE_DIMENSIONS = [
  "taskCriticalState",
  "commitmentPreservation",
  "constraintPreservation",
  "instructionPreservation",
  "unresolvedBlocker",
  "sourcePointer",
  "continuationReplay",
  "outputSufficiency",
  "behavioralRegression",
  "recovery",
  "explainability"
] as const;
export type LcmEvidenceDimension = (typeof LCM_EVIDENCE_DIMENSIONS)[number];

export const LCM_DIMENSION_RESULTS = ["pass", "fail", "uncertain", "not_computed"] as const;
export type LcmDimensionResult = (typeof LCM_DIMENSION_RESULTS)[number];

/**
 * The five promotion outcomes. The decision logic and the profile VALUES live in the private engine
 * (`src/engine/lcm/promotion-profile.ts`, which imports THIS vocabulary); only the outcome label is
 * public. There is no outcome that promotes on token reduction alone.
 */
export const LCM_PROMOTION_OUTCOME_LABELS = [
  "promote_approval_gated_beta",
  "baseline_remains_default",
  "insufficient_evidence",
  "candidate_rejected",
  "evaluation_invalid"
] as const;
export type LcmPromotionOutcomeLabel = (typeof LCM_PROMOTION_OUTCOME_LABELS)[number];

export const LCM_CANDIDATE_KIND_LABELS = [
  "deterministic-baseline",
  "lcm-candidate",
  "no-candidate",
  "rejected-candidate"
] as const;
export type LcmCandidateKindLabel = (typeof LCM_CANDIDATE_KIND_LABELS)[number];

export const LCM_GENERATION_STATUS_LABELS = ["generated", "unavailable"] as const;
export type LcmGenerationStatusLabel = (typeof LCM_GENERATION_STATUS_LABELS)[number];

export type LcmEvaluatorTypeLabel = "deterministic" | "model-judge";

/**
 * Provenance labels with the fixture-never-live invariant encoded in the type: `liveVerified` may be
 * a free boolean ONLY when BOTH sources are `real-local`; any fixture on either side forces the
 * literal `false`. `{ traceSource: "synthetic-fixture", …, liveVerified: true }` does not type-check.
 */
export type LcmProvenanceLabels =
  | { traceSource: "real-local"; evidenceSource: "real-local"; liveVerified: boolean }
  | { traceSource: LcmSourceLabel; evidenceSource: LcmFixtureSourceLabel; liveVerified: false }
  | { traceSource: LcmFixtureSourceLabel; evidenceSource: LcmSourceLabel; liveVerified: false };

/** Counts only, section/capsule LISTS from the private record are projected down to counts. */
export interface ContentFreeLcmCounts {
  inputTokensBefore: number;
  tokensAfter: number;
  absoluteReduction: number;
  reductionPercent: number;
  modelVisibleByteDelta: number;
  sectionsRetainedCount: number;
  sectionsRemovedCount: number;
  stateCapsuleRefCount: number;
}

/** Coverage ratios in [0, 1], computed privately; only the numbers cross the boundary. */
export interface ContentFreeLcmCoverage {
  sourcePointerCoverage: number;
  commitmentCoverage: number;
  instructionCoverage: number;
  blockerCoverage: number;
}

/**
 * The full content-free LCM evidence document, the ONLY LCM shape that may ship publicly.
 * Intersected with `LcmProvenanceLabels` so fixture-as-live is unrepresentable here too.
 */
export type ContentFreeLcmEvidence = {
  contract_version: string;
  /** The narrowly identified workflow/policy class the evidence applies to, a class id, not content. */
  workflowClassId: string;
  workflow: string;
  provider: string;
  model: string;
  endpoint: string;
  deterministicPolicyVersion: string;
  lcmCandidateVersion: string;
  evalProfileVersion: string;
  candidateKind: LcmCandidateKindLabel;
  generationStatus: LcmGenerationStatusLabel;
  counts: ContentFreeLcmCounts;
  coverage: ContentFreeLcmCoverage;
  /** Recovery EXISTENCE only, whether a recovery pointer exists, never what it points at. */
  recoveryPointerPresent: boolean;
  generationLatencyMs: number;
  inferenceCostEstimateUsd: number;
  dimensions: Record<LcmEvidenceDimension, LcmDimensionResult>;
  evaluatorType: LcmEvaluatorTypeLabel;
  promotionOutcome: LcmPromotionOutcomeLabel;
} & LcmProvenanceLabels;

/* ------------------------------------------------------------------------------------------------
 * Deep content scanner (fail-closed backstop behind the pick-only projector).
 * ---------------------------------------------------------------------------------------------- */

/** Key comparison is over a normalized form (lowercase, alphanumerics only): `candidate_text` ≡ `candidateText`. */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Content-shaped keys that are NEVER accepted anywhere in a content-free LCM tree (normalized forms). */
const FORBIDDEN_CONTENT_KEYS: ReadonlySet<string> = new Set([
  "prompt",
  "response",
  "messages",
  "content",
  "choices",
  "candidatetext",
  "sourcetext",
  "proposedbody",
  "requestbody",
  "responsebody",
  "systemprompt",
  "apikey",
  "authorization"
]);

/** Credential-looking value pattern (e.g. an OpenAI-style `sk-…` key) with a left boundary. */
const CREDENTIAL_LOOKING_VALUE = /(^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}/;

/** Labels/versions/ids are short single-line strings; anything longer or multi-line is content-shaped. */
export const LCM_MAX_LABEL_LENGTH = 200;

const MAX_SCAN_DEPTH = 32;

export type LcmContentScanResult =
  | { ok: true }
  | { ok: false; reason: "content_key" | "content_value"; path: string };

/**
 * Recursively scan keys + string values. Returns the FIRST violation with its key path (keys only -
 * the offending VALUE is never echoed into the result, an error message, or a log).
 */
export function scanContentFreeLcmEvidence(node: unknown, path = "$", depth = 0): LcmContentScanResult {
  if (depth > MAX_SCAN_DEPTH) return { ok: false, reason: "content_key", path: `${path} (too deep)` };

  if (typeof node === "string") {
    if (CREDENTIAL_LOOKING_VALUE.test(node)) return { ok: false, reason: "content_value", path };
    if (node.length > LCM_MAX_LABEL_LENGTH) return { ok: false, reason: "content_value", path };
    if (node.includes("\n")) return { ok: false, reason: "content_value", path };
    return { ok: true };
  }
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i += 1) {
      const result = scanContentFreeLcmEvidence(node[i], `${path}[${i}]`, depth + 1);
      if (!result.ok) return result;
    }
    return { ok: true };
  }
  if (node !== null && typeof node === "object") {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const childPath = `${path}.${key}`;
      if (FORBIDDEN_CONTENT_KEYS.has(normalizeKey(key))) {
        return { ok: false, reason: "content_key", path: childPath };
      }
      const result = scanContentFreeLcmEvidence(value, childPath, depth + 1);
      if (!result.ok) return result;
    }
    return { ok: true };
  }
  return { ok: true };
}

/* ------------------------------------------------------------------------------------------------
 * Projection: private evidence -> content-free document (pick-only, fail-closed).
 * ---------------------------------------------------------------------------------------------- */

/** Thrown whenever an input would violate the content-free or provenance-honesty contract. */
export class LcmEvidenceContractViolation extends Error {
  constructor(message: string) {
    super(`lcm-evidence-contract: ${message}`);
    this.name = "LcmEvidenceContractViolation";
  }
}

/**
 * The STRUCTURAL shape the projector reads from a private record. Declared here (not imported from
 * the engine - the boundary points the other way); the private `LcmCandidateRecord` satisfies it
 * structurally. Extra private fields (however content-bearing) are invisible to the projector.
 */
export interface LcmEvidenceProjectionInput {
  input: {
    workflow: string;
    provider: string;
    model: string;
    endpoint: string;
    traceSource: LcmSourceLabel;
    deterministicPolicyVersion: string;
    lcmCandidateVersion: string;
    evalProfileVersion: string;
  };
  candidate: {
    kind: LcmCandidateKindLabel;
    generationStatus: LcmGenerationStatusLabel;
  };
  evidence: {
    inputTokensBefore: number;
    tokensAfter: number;
    absoluteReduction: number;
    reductionPercent: number;
    modelVisibleByteDelta: number;
    sectionsRetained: readonly string[];
    sectionsRemoved: readonly string[];
    stateCapsuleRefs: readonly string[];
    sourcePointerCoverage: number;
    commitmentCoverage: number;
    instructionCoverage: number;
    blockerCoverage: number;
    recoveryPointer: string;
    generationLatencyMs: number;
    inferenceCostEstimateUsd: number;
    evidenceSource: LcmSourceLabel;
  };
  evaluation?: {
    dimensions: Record<string, string>;
    evaluatorType: LcmEvaluatorTypeLabel;
    promotionOutcome: LcmPromotionOutcomeLabel;
  };
  provenance: { traceSource: LcmSourceLabel; evidenceSource: LcmSourceLabel; liveVerified: boolean };
  /** Narrow class id when a profile evaluation assigned one; falls back to `input.workflow`. */
  workflowClassId?: string;
}

function isFixture(source: string): source is LcmFixtureSourceLabel {
  return source === "synthetic-fixture" || source === "benchmark-fixture";
}

function assertLabel(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new LcmEvidenceContractViolation(`${path} must be a non-empty string label`);
  }
  if (value.length > LCM_MAX_LABEL_LENGTH || value.includes("\n")) {
    throw new LcmEvidenceContractViolation(`${path} is content-shaped (too long or multi-line), refused`);
  }
  if (CREDENTIAL_LOOKING_VALUE.test(value)) {
    throw new LcmEvidenceContractViolation(`${path} carries a credential-looking value, refused`);
  }
  return value;
}

function assertMember<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  const label = assertLabel(value, path);
  if (!(allowed as readonly string[]).includes(label)) {
    throw new LcmEvidenceContractViolation(`${path} has unsupported label - refused, never silently accepted`);
  }
  return label as T;
}

function assertFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new LcmEvidenceContractViolation(`${path} must be a finite number`);
  }
  return value;
}

function assertNonNegativeNumber(value: unknown, path: string): number {
  const n = assertFiniteNumber(value, path);
  if (n < 0) throw new LcmEvidenceContractViolation(`${path} must be >= 0`);
  return n;
}

function assertRatio(value: unknown, path: string): number {
  const n = assertFiniteNumber(value, path);
  if (n < 0 || n > 1) throw new LcmEvidenceContractViolation(`${path} must be in [0, 1]`);
  return n;
}

function labelCount(values: readonly unknown[], path: string): number {
  if (!Array.isArray(values)) throw new LcmEvidenceContractViolation(`${path} must be an array`);
  return values.length; // entries themselves are NEVER copied - count only.
}

/**
 * Project private LCM evidence to the content-free public document. PICK-ONLY (never spreads the
 * input), fail-closed (throws `LcmEvidenceContractViolation` instead of silently accepting or
 * silently downgrading), and re-scanned by the deep content scanner before returning.
 */
export function toContentFreeLcmEvidence(privateEvidence: LcmEvidenceProjectionInput): ContentFreeLcmEvidence {
  if (privateEvidence === null || typeof privateEvidence !== "object") {
    throw new LcmEvidenceContractViolation("input must be an object");
  }
  const { input, candidate, evidence, evaluation, provenance } = privateEvidence;
  if (!input || !candidate || !evidence || !provenance) {
    throw new LcmEvidenceContractViolation("input/candidate/evidence/provenance groups are all required");
  }

  // Provenance honesty first: fixture evidence can NEVER be rendered live - refuse, never downgrade.
  const traceSource = assertMember(provenance.traceSource, LCM_SOURCE_LABELS, "provenance.traceSource");
  const evidenceSource = assertMember(provenance.evidenceSource, LCM_SOURCE_LABELS, "provenance.evidenceSource");
  if ((isFixture(traceSource) || isFixture(evidenceSource)) && provenance.liveVerified === true) {
    throw new LcmEvidenceContractViolation(
      "fixture-sourced evidence claiming liveVerified: true - refused (fixture evidence is never live)"
    );
  }
  if (input.traceSource !== traceSource) {
    throw new LcmEvidenceContractViolation("provenance.traceSource must mirror input.traceSource");
  }
  if (evidence.evidenceSource !== evidenceSource) {
    throw new LcmEvidenceContractViolation("provenance.evidenceSource must mirror evidence.evidenceSource");
  }

  // Per-dimension results: unknown dimension keys are refused (never silently accepted or dropped).
  const dimensions = {} as Record<LcmEvidenceDimension, LcmDimensionResult>;
  for (const dim of LCM_EVIDENCE_DIMENSIONS) dimensions[dim] = "not_computed";
  if (evaluation !== undefined) {
    for (const key of Object.keys(evaluation.dimensions)) {
      if (!(LCM_EVIDENCE_DIMENSIONS as readonly string[]).includes(key)) {
        throw new LcmEvidenceContractViolation(`evaluation.dimensions.${normalizeKey(key)} is not a known dimension - refused`);
      }
      dimensions[key as LcmEvidenceDimension] = assertMember(
        evaluation.dimensions[key],
        LCM_DIMENSION_RESULTS,
        `evaluation.dimensions.${key}`
      );
    }
  }

  const provenanceLabels: LcmProvenanceLabels = isFixture(evidenceSource)
    ? { traceSource, evidenceSource, liveVerified: false }
    : isFixture(traceSource)
      ? { traceSource, evidenceSource, liveVerified: false }
      : { traceSource: "real-local", evidenceSource: "real-local", liveVerified: provenance.liveVerified === true };

  const document: ContentFreeLcmEvidence = {
    contract_version: LCM_EVIDENCE_CONTRACT_VERSION,
    workflowClassId: assertLabel(privateEvidence.workflowClassId ?? input.workflow, "workflowClassId"),
    workflow: assertLabel(input.workflow, "input.workflow"),
    provider: assertLabel(input.provider, "input.provider"),
    model: assertLabel(input.model, "input.model"),
    endpoint: assertLabel(input.endpoint, "input.endpoint"),
    deterministicPolicyVersion: assertLabel(input.deterministicPolicyVersion, "input.deterministicPolicyVersion"),
    lcmCandidateVersion: assertLabel(input.lcmCandidateVersion, "input.lcmCandidateVersion"),
    evalProfileVersion: assertLabel(input.evalProfileVersion, "input.evalProfileVersion"),
    candidateKind: assertMember(candidate.kind, LCM_CANDIDATE_KIND_LABELS, "candidate.kind"),
    generationStatus: assertMember(candidate.generationStatus, LCM_GENERATION_STATUS_LABELS, "candidate.generationStatus"),
    counts: {
      inputTokensBefore: assertNonNegativeNumber(evidence.inputTokensBefore, "evidence.inputTokensBefore"),
      tokensAfter: assertNonNegativeNumber(evidence.tokensAfter, "evidence.tokensAfter"),
      absoluteReduction: assertFiniteNumber(evidence.absoluteReduction, "evidence.absoluteReduction"),
      reductionPercent: assertFiniteNumber(evidence.reductionPercent, "evidence.reductionPercent"),
      modelVisibleByteDelta: assertFiniteNumber(evidence.modelVisibleByteDelta, "evidence.modelVisibleByteDelta"),
      sectionsRetainedCount: labelCount(evidence.sectionsRetained, "evidence.sectionsRetained"),
      sectionsRemovedCount: labelCount(evidence.sectionsRemoved, "evidence.sectionsRemoved"),
      stateCapsuleRefCount: labelCount(evidence.stateCapsuleRefs, "evidence.stateCapsuleRefs")
    },
    coverage: {
      sourcePointerCoverage: assertRatio(evidence.sourcePointerCoverage, "evidence.sourcePointerCoverage"),
      commitmentCoverage: assertRatio(evidence.commitmentCoverage, "evidence.commitmentCoverage"),
      instructionCoverage: assertRatio(evidence.instructionCoverage, "evidence.instructionCoverage"),
      blockerCoverage: assertRatio(evidence.blockerCoverage, "evidence.blockerCoverage")
    },
    recoveryPointerPresent: typeof evidence.recoveryPointer === "string" && evidence.recoveryPointer.length > 0,
    generationLatencyMs: assertNonNegativeNumber(evidence.generationLatencyMs, "evidence.generationLatencyMs"),
    inferenceCostEstimateUsd: assertNonNegativeNumber(evidence.inferenceCostEstimateUsd, "evidence.inferenceCostEstimateUsd"),
    dimensions,
    evaluatorType:
      evaluation !== undefined
        ? assertMember(evaluation.evaluatorType, ["deterministic", "model-judge"] as const, "evaluation.evaluatorType")
        : "deterministic",
    promotionOutcome:
      evaluation !== undefined
        ? assertMember(evaluation.promotionOutcome, LCM_PROMOTION_OUTCOME_LABELS, "evaluation.promotionOutcome")
        : "insufficient_evidence",
    ...provenanceLabels
  };

  // Fail-closed tripwire: re-scan the BUILT document. Pick-only construction should make this
  // unreachable; if any content-shaped key or value survived, refuse to emit the document.
  const scan = scanContentFreeLcmEvidence(document);
  if (!scan.ok) {
    throw new LcmEvidenceContractViolation(`content-shaped ${scan.reason} at ${scan.path} in projected output - refused`);
  }
  return document;
}
