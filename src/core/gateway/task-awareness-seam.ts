/**
 * Task-aware output-shaping seam (PUBLIC) — the contract + the thin boundary through which a public
 * caller may ask for the private adaptive shape-vs-hold gate.
 *
 * The classifier (`output-shaping-task-classifier.ts`) is PUBLIC and ships to every plan, and
 * callers that can import it statically do — `output-shaping-policy.ts` is one. This module exists
 * for the callers that cannot: it owns the CONTRACT the gate speaks in (the decision and the
 * content-free signal label that public receipts persist), and it reaches the classifier through a
 * lazy dynamic `import()` so an async caller keeps compiling and running against a build where the
 * module is absent. The types live here, on the public side, not behind the import.
 *
 * ABSENT-IMPLEMENTATION SEMANTICS. Every resolver below answers `undefined` for "not in this build",
 * and every caller reads that as BLANKET shaping, never as hold:
 *   - `classifyShapingTask` ⇒ the HOOK path shapes blanket (`shape-basic`). Holding on absence would
 *     leave the hook printing nothing at all.
 *   - `resolveTaskAwareGate` ⇒ a gate a caller can hand to `planGatewayOutputShaping`, whose absent
 *     branch is blanket. It ALSO returns `undefined` for the env kill switch, which is why a caller
 *     describing HOOK behavior must use `isShapingTaskClassifierPresent` instead (see below). No
 *     production caller uses it today — the gateway planner imports `taskAwareGate` statically; it
 *     remains the async form of the contract and is exercised by `private-boundary-seams.test.ts`.
 * A normal install has the classifier and holds planning turns on both the gateway and the hook; the
 * blanket path is the honest degrade, not a tier.
 */
import { isModuleAbsentError } from "../module-absence.js";

/**
 * The specifier the lazy `import()` below uses, declared so the absence check can be scoped to THIS
 * module. Kept literal in both places on purpose (a computed specifier defeats the loader's static
 * analysis); `private-boundary-seams.test.ts` asserts the two never drift, and a drift would in any
 * case fail toward PROPAGATING the error rather than degrading silently.
 */
const TASK_CLASSIFIER_SPECIFIER = "./output-shaping-task-classifier.js";

export type OutputShapingTaskDecision = "shape" | "hold";

/** Content-free label for WHY a turn was shaped or held. Persisted into public receipts. */
export type OutputShapingTaskSignal =
  | "extended-thinking"
  | "planning-request"
  | "default-shapeable";

export interface OutputShapingTaskClassification {
  decision: OutputShapingTaskDecision;
  /** Fixed label for why the decision was made, never contains request content. */
  signal: OutputShapingTaskSignal;
  /**
   * Human-readable reason. MUST be a hardcoded literal, never interpolate parsed request content
   * (prompt/response text). The gateway persists rejection reasons in the content-free receipt, so
   * the content-free guarantee depends on this field carrying no request bytes. The typed `signal`
   * enum is the machine-safe discriminator; prefer it wherever a value is persisted or reported.
   */
  reason: string;
}

/** The injected gate shape `planGatewayOutputShaping({ taskGate })` accepts. */
export type ResolvedTaskAwareGate = (
  endpoint: string,
  bodyText: string
) => { decision: OutputShapingTaskDecision; signal?: OutputShapingTaskSignal };

/**
 * Build the task-aware HOLD gate, or `undefined` when it is unavailable — either because the env kill
 * switch disabled it or because the classifier is not part of this build. Callers pass the result
 * straight into `planGatewayOutputShaping({ taskGate })`, whose `undefined` branch is blanket public
 * shaping. A real error from inside a present classifier propagates unchanged, including a
 * module-not-found for one of ITS dependencies (a packaging defect, not an excluded capability).
 */
export async function resolveTaskAwareGate(
  env: NodeJS.ProcessEnv = process.env
): Promise<ResolvedTaskAwareGate | undefined> {
  try {
    const { taskAwareGate } = await import("./output-shaping-task-classifier.js");
    return taskAwareGate(env);
  } catch (error) {
    if (!isModuleAbsentError(error, { specifier: TASK_CLASSIFIER_SPECIFIER, importerUrl: import.meta.url })) throw error;
    return undefined;
  }
}

/**
 * Whether the classifier is part of THIS build — the question `classifyShapingTask` answers, without
 * classifying anything and without consulting the env override.
 *
 * `resolveTaskAwareGate` is the wrong probe for a caller that wants to describe the HOOK's behavior:
 * it also returns `undefined` when `COMPACTION_OUTPUT_SHAPING_TASK_AWARE=0` disables the GATEWAY's
 * gate, but that switch does not reach `classifyShapingTask`, so the hook keeps holding planning
 * turns while the probe says it does not. Callers describing hook behavior use this instead.
 */
export async function isShapingTaskClassifierPresent(): Promise<boolean> {
  try {
    await import("./output-shaping-task-classifier.js");
    return true;
  } catch (error) {
    if (!isModuleAbsentError(error, { specifier: TASK_CLASSIFIER_SPECIFIER, importerUrl: import.meta.url })) throw error;
    return false;
  }
}

/**
 * Classify one turn, or `undefined` when the classifier is not part of this build. `undefined` means
 * "no task-aware gate here", NOT "hold": callers degrade to the public blanket method, which is what
 * the Open tier is entitled to. Only a `hold` DECISION suppresses shaping.
 */
export async function classifyShapingTask(
  endpoint: string,
  bodyText: string
): Promise<OutputShapingTaskClassification | undefined> {
  try {
    const { classifyOutputShapingTask } = await import("./output-shaping-task-classifier.js");
    return classifyOutputShapingTask(endpoint, bodyText);
  } catch (error) {
    if (!isModuleAbsentError(error, { specifier: TASK_CLASSIFIER_SPECIFIER, importerUrl: import.meta.url })) throw error;
    return undefined;
  }
}
