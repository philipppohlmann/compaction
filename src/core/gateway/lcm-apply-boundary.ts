/**
 * LCM apply boundary (public CLI/SDK core, engine-free static graph).
 *
 * A narrow seam through which the private LCM engine could contribute an apply candidate to the
 * context-optimization runtime.
 *
 * NOT ON THE LIVE GATEWAY PATH. `maybeGenerateLcmApplyCandidate` has no production caller: the
 * gateway routes apply through the IPC seam (`engine-ipc/engine-apply-seam.ts` →
 * `src/engine/native/apply-pipeline.ts`). This module is exercised by its own tests and supplies the
 * candidate-source TYPES the engine slice implements. Read it as a second, still-wired rail, not as
 * the thing that keeps LCM apply off.
 *
 * Class qualification is the first gate. Before any engine import, generation, or retention, a class
 * must qualify through the private policy or the independent Hybrid activation. Hybrid applies to a
 * non-global class while `COMPACTION_HYBRID_APPLY=1|true`; it does not depend on the private policy.
 * `shadow-only` remains the default outcome, while either rail uses the same per-request safety gates.
 *
 * For a qualified class, the boundary enforces the same fail-closed gate discipline as
 * the deterministic engine (`apply-eligibility.ts`): active narrow stored authorization, exact scope
 * and routed endpoint family, source-grounded validated candidate, content-free evidence projection,
 * a real body change, and last, actual retention of the original for byte-exact recovery. Any
 * failure, refusal, timeout, absent engine, or error is fail-open: a pass-through status, the caller
 * forwards the original request unchanged, and the workflow is never blocked.
 *
 * Content-free and engine-private: no prompt, rubric, threshold, violation detail, or candidate text
 * ever rides on a result. Statuses, fixed reason labels, gate names, counts, and the scanned
 * `ContentFreeLcmEvidence` projection only. The single exception is the `mutatedBodyText` transport
 * field on an `apply-candidate` (the replacement request body, the same class of data the gateway
 * already forwards): it exists only to be forwarded upstream, and `toRecordableLcmApplyBoundaryResult`
 * (the only shape that may be recorded or logged) is a pick-only projection that never includes it.
 * The engine is reached only via a lazy dynamic `import()` inside the qualified branch; the shipped
 * static graph never references `src/engine/**` (`npm run boundary:engine` keeps the CLI graph at
 * zero static engine edges, and the npm package ships only the open-core hybrid engine slice listed
 * in `package.json` `files`, never the private engine surface).
 */
import {
  scanContentFreeLcmEvidence,
  toContentFreeLcmEvidence,
  type ContentFreeLcmEvidence,
  type LcmEvidenceProjectionInput
} from "../lcm-evidence-contract.js";
import { REJECTED_GLOBAL_TOOL_VALUES, type PolicyPreference } from "../policy-preferences.js";
import { AUTO_APPLY_TOOL_ENDPOINT_FAMILIES } from "./apply-eligibility.js";
import { PRIVATE_ENGINE_TREE, isModuleAbsentError, isModuleTreeAbsentError } from "../module-absence.js";
import { DEDUPE_POLICY } from "./request-shape.js";
import { isHybridApplyActivated } from "./hybrid-apply-activation.js";

/** Bounded generation budget: a candidate still pending after this is abandoned fail-open. */
export const DEFAULT_LCM_APPLY_BOUNDARY_TIMEOUT_MS = 5_000;

/** Honest single-line label carried on every boundary result (label-length; scanner-enforced). */
export const LCM_APPLY_BOUNDARY_LABEL =
  "lcm apply boundary: no workflow class is qualified - shadow-only for every class; content-free statuses only; fail-open (a Compaction failure never blocks the workflow)";

/**
 * The gates the boundary evaluates for a qualified class, in order. `class-qualified` is first, so a
 * request that qualifies by neither rail reaches no other gate. `original-retainable` is last so a
 * request failing any earlier gate never writes a recovery file.
 */
export const LCM_APPLY_BOUNDARY_GATES = [
  "class-qualified",
  "authorization-active",
  "scope-match",
  "source-grounded-candidate",
  "content-free-evidence",
  "candidate-body-present",
  "original-retainable"
] as const;
export type LcmApplyBoundaryGate = (typeof LCM_APPLY_BOUNDARY_GATES)[number];
export type LcmApplyGateResults = Record<LcmApplyBoundaryGate, "pass" | "fail">;

/** Fail-open reason classes for an unavailable engine, fixed labels, never error text. */
export type LcmApplyEngineUnavailableReason = "engine-absent" | "timeout" | "engine-error";

/**
 * The boundary's content-free result. `applied` is always false: the boundary never mutates and
 * never forwards; even `apply-candidate` is only a proposal the caller may use under the stored
 * authorization.
 */
export type LcmApplyBoundaryResult =
  | {
      status: "shadow-only";
      workflowClass: string;
      applied: false;
      reason: string;
      label: string;
    }
  | {
      status: "ineligible" | "no-candidate";
      workflowClass: string;
      applied: false;
      reason: string;
      gateResults: LcmApplyGateResults;
      label: string;
    }
  | {
      status: "engine-unavailable";
      workflowClass: string;
      applied: false;
      reason: LcmApplyEngineUnavailableReason;
      label: string;
    }
  | {
      status: "apply-candidate";
      workflowClass: string;
      applied: false;
      evidence: ContentFreeLcmEvidence;
      gateResults: LcmApplyGateResults;
      recoveryId: string;
      authorizationId: string;
      /**
       * Transport only: the replacement request body, for the caller to forward upstream under the
       * stored authorization. Never recorded or logged: `toRecordableLcmApplyBoundaryResult` (the
       * only recordable shape) excludes it by construction.
       */
      mutatedBodyText: string;
      label: string;
    };

/**
 * The engine seam: one call producing at most one candidate outcome for one request. The private
 * record satisfies `LcmEvidenceProjectionInput` structurally; the only content the outcome may carry
 * is `proposedBodyText` (the would-be replacement body), which never leaves the boundary except as
 * the `apply-candidate` transport field.
 */
export interface GatewayLcmApplyCandidateOutcome {
  kind: "lcm-candidate" | "no-candidate" | "rejected-candidate";
  record: LcmEvidenceProjectionInput;
  proposedBodyText?: string;
  /** The generator's own fixed reason literal, for classification into the receipt vocabulary. */
  reason?: string;
  /** The body-construction refusal reason, when a validated candidate produced no safe body. */
  constructionReason?: string;
}
export type GatewayLcmApplyCandidateSource = (endpoint: string, bodyText: string) => Promise<GatewayLcmApplyCandidateOutcome>;

/** Public contract for the optional private class-qualification module. */
export interface LcmClassQualifierContract {
  isClassQualifiedForLcmApply(workflowClass: string, cwd?: string): boolean;
}

export interface LcmApplyBoundaryParams {
  endpoint: string;
  /** The original request body text. Read by the engine only; never logged or recorded here. */
  bodyText: string;
  /** The narrowly identified workflow class of this connection (content-free id). */
  workflowClass: string;
  /** The stored scoped authorization this application would run under. */
  storedAuthorization: PolicyPreference;
  /** The repo identity of this connection, when detectable (scope match only). */
  repo?: string;
  cwd?: string;
  timeoutMs?: number;
  /**
   * Performs the actual retention of the original request and returns the recovery id. Called only
   * when every other gate passed; an application without a retained original never happens.
   */
  retainOriginal?: () => { retained: true; recoveryId: string } | { retained: false; reason: string };
  /** Engine seam override (tests). Default: lazy dynamic import of the engine source. */
  candidateSource?: GatewayLcmApplyCandidateSource;
  /**
   * Test-only qualification stub used to exercise the qualified path. Production callers omit this
   * so the private qualification policy is used when present.
   */
  syntheticQualificationForTests?: (workflowClass: string, cwd: string) => boolean;
}

/** Sanitize the echoed class id into a guaranteed label (short, single-line). */
function classLabel(workflowClass: string): string {
  return (workflowClass ?? "").replace(/\s+/g, " ").trim().slice(0, 200) || "unknown";
}

function allFailGates(): LcmApplyGateResults {
  const gates = {} as LcmApplyGateResults;
  for (const gate of LCM_APPLY_BOUNDARY_GATES) gates[gate] = "fail";
  return gates;
}

function shadowOnly(workflowClass: string): LcmApplyBoundaryResult {
  return {
    status: "shadow-only",
    workflowClass: classLabel(workflowClass),
    applied: false,
    reason:
      "class not qualified under the pre-registered evidence bar - LCM stays shadow-only for this class; nothing is generated, nothing is applied",
    label: LCM_APPLY_BOUNDARY_LABEL
  };
}

function ineligible(workflowClass: string, reason: string, gateResults: LcmApplyGateResults): LcmApplyBoundaryResult {
  return { status: "ineligible", workflowClass: classLabel(workflowClass), applied: false, reason, gateResults, label: LCM_APPLY_BOUNDARY_LABEL };
}

function noCandidate(workflowClass: string, reason: string, gateResults: LcmApplyGateResults): LcmApplyBoundaryResult {
  return { status: "no-candidate", workflowClass: classLabel(workflowClass), applied: false, reason, gateResults, label: LCM_APPLY_BOUNDARY_LABEL };
}

function engineUnavailable(workflowClass: string, reason: LcmApplyEngineUnavailableReason): LcmApplyBoundaryResult {
  return { status: "engine-unavailable", workflowClass: classLabel(workflowClass), applied: false, reason, label: LCM_APPLY_BOUNDARY_LABEL };
}

/** The endpoint path (query stripped) ends with one of the tool's routed endpoint suffixes. */
function endpointMatchesTool(endpoint: string, tool: string): boolean {
  const suffixes = AUTO_APPLY_TOOL_ENDPOINT_FAMILIES[tool];
  if (!suffixes) return false;
  const path = endpoint.split("?")[0];
  return suffixes.some((suffix) => path.endsWith(suffix));
}

/** The optional private qualifier, loaded lazily so its absence cannot brick the public CLI. */
const LCM_QUALIFIER_SPECIFIER = "./lcm-qualified-classes.js";

async function loadLcmClassQualifier(): Promise<LcmClassQualifierContract["isClassQualifiedForLcmApply"] | undefined> {
  try {
    const mod = (await import(LCM_QUALIFIER_SPECIFIER)) as Partial<LcmClassQualifierContract>;
    if (typeof mod.isClassQualifiedForLcmApply !== "function") {
      throw new TypeError("LCM class-qualification module does not satisfy its public contract");
    }
    return mod.isClassQualifiedForLcmApply;
  } catch (error) {
    if (!isModuleAbsentError(error, { specifier: LCM_QUALIFIER_SPECIFIER, importerUrl: import.meta.url })) throw error;
    return undefined;
  }
}

/**
 * Lazily load the engine's default apply-candidate source via dynamic `import()` only. This call is
 * the single place this module touches the engine, and it is reached only past gate 1.
 */
const ENGINE_APPLY_CANDIDATE_SOURCE_MODULE = "../../engine/lcm/gateway-apply-candidate-source.js";

async function loadDefaultEngineCandidateSource(): Promise<GatewayLcmApplyCandidateSource> {
  const mod = (await import(ENGINE_APPLY_CANDIDATE_SOURCE_MODULE)) as {
    defaultGatewayLcmApplyCandidateSource: GatewayLcmApplyCandidateSource;
  };
  return mod.defaultGatewayLcmApplyCandidateSource;
}

/** Race `work` against the bounded budget; a late settle (either way) never becomes unhandled. */
async function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<{ timedOut: false; value: T } | { timedOut: true }> {
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
  });
  try {
    return await Promise.race([work.then((value) => ({ timedOut: false as const, value })), expiry]);
  } finally {
    clearTimeout(timer);
    work.catch(() => {});
  }
}

/**
 * The only recordable/loggable projection of a boundary result. Pick-only: it never includes the
 * `mutatedBodyText` transport field, so no shape derived from it can carry request/candidate
 * content. Scanned by the caller-independent tripwire inside `maybeGenerateLcmApplyCandidate`.
 */
export function toRecordableLcmApplyBoundaryResult(result: LcmApplyBoundaryResult): Record<string, unknown> {
  const base = {
    status: result.status,
    workflowClass: result.workflowClass,
    applied: result.applied,
    label: result.label
  };
  switch (result.status) {
    case "shadow-only":
    case "engine-unavailable":
      return { ...base, reason: result.reason };
    case "ineligible":
    case "no-candidate":
      return { ...base, reason: result.reason, gateResults: { ...result.gateResults } };
    case "apply-candidate":
      return {
        ...base,
        evidence: result.evidence,
        gateResults: { ...result.gateResults },
        recoveryId: result.recoveryId,
        authorizationId: result.authorizationId
      };
  }
}

/**
 * Evaluate whether one request may receive an LCM apply candidate. Never throws; any escape is a
 * fail-open `engine-unavailable` result (the caller forwards the original unchanged). The
 * qualification gate runs first, so a request qualifying by neither rail returns `shadow-only`
 * without the engine being imported at all.
 */
export async function maybeGenerateLcmApplyCandidate(params: LcmApplyBoundaryParams): Promise<LcmApplyBoundaryResult> {
  let result: LcmApplyBoundaryResult;
  try {
    result = await evaluateBoundary(params);
  } catch (error) {
    result = engineUnavailable(params.workflowClass, isModuleTreeAbsentError(error, PRIVATE_ENGINE_TREE) ? "engine-absent" : "engine-error");
  }
  // Fail-closed content tripwire: the recordable projection of every result must be content-free.
  // A violating result (e.g. a misbehaving injected source) is replaced, never returned.
  try {
    const scan = scanContentFreeLcmEvidence(toRecordableLcmApplyBoundaryResult(result));
    if (!scan.ok) return ineligible(params.workflowClass, "invalid-candidate - content-shaped result refused", allFailGates());
  } catch {
    return ineligible(params.workflowClass, "invalid-candidate - content-shaped result refused", allFailGates());
  }
  return result;
}

async function evaluateBoundary(params: LcmApplyBoundaryParams): Promise<LcmApplyBoundaryResult> {
  const cwd = params.cwd ?? process.cwd();
  const workflowClass = params.workflowClass?.trim() ?? "";

  // Gate 1, class qualification, first. A class qualifies through either the private policy or the
  // explicit Hybrid activation. A test stub, when provided, is the sole qualifier.
  const privateQualifier =
    params.syntheticQualificationForTests === undefined ? await loadLcmClassQualifier() : undefined;
  const qualifiedByPrivatePolicy =
    params.syntheticQualificationForTests?.(workflowClass, cwd) ?? privateQualifier?.(workflowClass, cwd) ?? false;
  const qualifiedByHybrid =
    params.syntheticQualificationForTests === undefined &&
    isHybridApplyActivated() &&
    !REJECTED_GLOBAL_TOOL_VALUES.includes(workflowClass.toLowerCase());
  if (workflowClass === "" || !(qualifiedByPrivatePolicy || qualifiedByHybrid)) {
    return shadowOnly(params.workflowClass);
  }
  const gateResults = allFailGates();
  gateResults["class-qualified"] = "pass";

  // Gate 2, the stored authorization must be active for automatic application: enabled,
  // `auto-when-gates-pass`, and the context-optimization policy type. Disable is honored on the
  // very next request (the caller reads the preference file fresh).
  const auth = params.storedAuthorization;
  if (!auth || auth.enabled !== true) {
    return ineligible(workflowClass, "stored authorization is missing or disabled - nothing is applied under it", gateResults);
  }
  if (auth.preference !== "auto-when-gates-pass") {
    return ineligible(workflowClass, "stored preference requires a per-run ask - nothing is applied automatically", gateResults);
  }
  if (auth.scope.policy_type !== DEDUPE_POLICY) {
    return ineligible(workflowClass, "stored authorization does not cover context optimization - fail closed", gateResults);
  }
  gateResults["authorization-active"] = "pass";

  // Gate 3, exact narrow scope, never global, and the endpoint family this tool actually routes.
  if (
    REJECTED_GLOBAL_TOOL_VALUES.includes(workflowClass.toLowerCase()) ||
    REJECTED_GLOBAL_TOOL_VALUES.includes(auth.scope.tool.trim().toLowerCase())
  ) {
    return ineligible(workflowClass, "global/cross-tool scopes are never valid - fail closed", gateResults);
  }
  if (auth.scope.tool !== workflowClass) {
    return ineligible(workflowClass, "scope mismatch - no application outside the stored authorization", gateResults);
  }
  if (auth.scope.repo !== undefined && auth.scope.repo !== params.repo) {
    return ineligible(workflowClass, "scope mismatch - authorization is pinned to a different repo, fail closed", gateResults);
  }
  if (!endpointMatchesTool(params.endpoint, workflowClass)) {
    return ineligible(workflowClass, "endpoint is not a routed endpoint family for this workflow - fail closed", gateResults);
  }
  gateResults["scope-match"] = "pass";

  // Engine, reached only here, only for a qualified class, only via lazy dynamic import.
  let source: GatewayLcmApplyCandidateSource;
  try {
    source = params.candidateSource ?? (await loadDefaultEngineCandidateSource());
  } catch (error) {
    return engineUnavailable(workflowClass, isModuleTreeAbsentError(error, PRIVATE_ENGINE_TREE) ? "engine-absent" : "engine-error");
  }
  const timeoutMs =
    params.timeoutMs !== undefined && Number.isFinite(params.timeoutMs) && params.timeoutMs > 0
      ? params.timeoutMs
      : DEFAULT_LCM_APPLY_BOUNDARY_TIMEOUT_MS;
  let outcome: GatewayLcmApplyCandidateOutcome;
  try {
    const raced = await withTimeout(source(params.endpoint, params.bodyText), timeoutMs);
    if (raced.timedOut) return engineUnavailable(workflowClass, "timeout");
    outcome = raced.value;
  } catch (error) {
    return engineUnavailable(workflowClass, isModuleTreeAbsentError(error, PRIVATE_ENGINE_TREE) ? "engine-absent" : "engine-error");
  }

  // Gate 4, only a source-grounded, validated candidate proceeds. Refusals and unsupported
  // shapes are honest no-candidates; a validation rejection is ineligible. Engine detail
  // (violations, reasons) is never copied out, fixed labels only.
  if (outcome.kind === "no-candidate") {
    return noCandidate(workflowClass, "engine produced no candidate (refusal, no model, or unsupported shape) - original forwarded unchanged", gateResults);
  }
  if (outcome.kind !== "lcm-candidate") {
    return ineligible(workflowClass, "candidate rejected by source-grounding validation - fail closed, original forwarded unchanged", gateResults);
  }
  gateResults["source-grounded-candidate"] = "pass";

  // Gate 5, the evidence must survive the pick-only content-free projection (throws on refusal).
  let evidence: ContentFreeLcmEvidence;
  try {
    evidence = toContentFreeLcmEvidence(outcome.record);
  } catch {
    return ineligible(workflowClass, "invalid-candidate - content-free evidence projection refused", gateResults);
  }
  gateResults["content-free-evidence"] = "pass";

  // Gate 6, a real, apply-able body change. No constructed body, or a no-op, is never an application.
  const proposed = outcome.proposedBodyText;
  if (typeof proposed !== "string" || proposed.length === 0 || proposed === params.bodyText) {
    return noCandidate(workflowClass, "no apply-able body change was produced - nothing to apply, original forwarded unchanged", gateResults);
  }
  gateResults["candidate-body-present"] = "pass";

  // Gate 7, last: actually retain the original before any mutation can be proposed to the caller.
  if (!params.retainOriginal) {
    return ineligible(workflowClass, "no retention path was provided - an application without a retained original never happens", gateResults);
  }
  const retention = params.retainOriginal();
  if (!retention.retained) {
    return ineligible(workflowClass, "could not retain the original for recovery - fail closed, original forwarded unchanged", gateResults);
  }
  gateResults["original-retainable"] = "pass";

  return {
    status: "apply-candidate",
    workflowClass: classLabel(workflowClass),
    applied: false,
    evidence,
    gateResults,
    recoveryId: retention.recoveryId,
    authorizationId: auth.id,
    mutatedBodyText: proposed,
    label: LCM_APPLY_BOUNDARY_LABEL
  };
}
