/**
 * Deterministic input-compaction seam (PUBLIC) — the thin boundary a public caller uses to ask for a
 * model-visible INPUT mutation plan, with safe degradation baked in.
 *
 * Model-visible input compaction is a private capability; its algorithm
 * (`apply-policy.ts`) is reached ONLY through the lazy dynamic `import()` below, never by a static
 * import. That is what lets the module be excluded from a public build without breaking the CLI at
 * module-load time — the same construction `engine-degrade.ts` uses for engine-backed commands and
 * `engine-apply-seam.ts` uses for the native engine.
 *
 * ABSENT-IMPLEMENTATION SEMANTICS — fail CLOSED for mutation, fail OPEN for the workflow:
 * when the compactor module is absent (or throws), this seam returns a `supported: false` plan with a
 * fixed, content-free reason. Every caller already treats an unsupported plan as "forward the ORIGINAL
 * bytes unchanged and record the reason", so the request still completes; nothing is ever applied on
 * the strength of an absent compactor, and no surface may describe such a turn as an apply.
 *
 * The request-shape VALIDATOR is deliberately NOT behind this seam: it is public
 * (`request-shape.ts`), because public output shaping needs the same fail-closed shape boundary and
 * must keep working with no private module present.
 */
import { isModuleAbsentError } from "../module-absence.js";
import { DEDUPE_POLICY, classifyRequestShape, type DedupePlan } from "./request-shape.js";

/**
 * The specifier the lazy `import()`s below use, declared so the absence check can be scoped to THIS
 * module. Every use reads this ONE constant, so the import target and the absence check cannot drift;
 * `private-boundary-seams.test.ts` asserts the value, and a drift would in any case fail toward
 * PROPAGATING the error rather than degrading silently. Naming the target in a constant rather than
 * inline is also what lets the public tree compile without the private module present - the loader
 * resolves it at runtime exactly as it would a literal.
 */
const APPLY_POLICY_SPECIFIER = "./apply-policy.js";

/** The one function this seam calls, typed in public terms so the private module can stay absent. */
export interface ApplyPolicyContract {
  planDeterministicDedupe(endpoint: string, bodyText: string, opts?: { minBlockChars?: number }): DedupePlan;
}

/**
 * The fixed reason reported when the deterministic input compactor is not part of this build. Content-
 * free and stated as a capability fact, never as a request-shape refusal (the shape may well have been
 * fine — we simply have nothing that mutates input).
 */
export const INPUT_COMPACTION_ABSENT_REASON =
  "deterministic input compaction is not available in this build - original forwarded unchanged";

/** A fail-closed plan carrying `reason`. Shaped exactly like a refusal from the real planner. */
function absentPlan(endpoint: string, bodyText: string, reason: string): DedupePlan {
  // Report the shape the public validator sees, so receipts stay as informative as they were, while
  // `supported: false` keeps the caller on the forward-original path.
  const classification = classifyRequestShape(endpoint, bodyText);
  return {
    policy: DEDUPE_POLICY,
    shape: classification.shape,
    supported: false,
    changed: false,
    failClosedReason: reason,
    removedBlocks: 0,
    charsBefore: 0,
    charsAfter: 0,
    estTokensBefore: 0,
    estTokensAfter: 0,
    reductionPercent: 0
  };
}

/**
 * Is the deterministic input compactor part of THIS build?
 *
 * `planInputCompaction` already degrades correctly without this — but it only answers per request,
 * after one has arrived. Startup banners have to describe the capability BEFORE any request exists,
 * and a surface that guesses gets it wrong: the public build has no `apply-policy.js`, so an apply-mode
 * banner that unconditionally promised "changes model-visible input; the original is retained locally"
 * described something that build can never do. This probe is how such a surface
 * asks instead of assuming.
 *
 * Deliberately conservative: ANY failure to load reports `false`. A surface's job here is to avoid
 * OVERclaiming, and an unexpected error means the capability cannot be relied on either way — whereas
 * `planInputCompaction` still rethrows non-absence errors, because a request must never be silently
 * treated as compacted when the compactor is present but broken.
 */
export async function isInputCompactionAvailable(): Promise<boolean> {
  try {
    const mod = (await import(APPLY_POLICY_SPECIFIER)) as Partial<ApplyPolicyContract>;
    return typeof mod.planDeterministicDedupe === "function";
  } catch {
    return false;
  }
}

/**
 * Plan a deterministic input compaction for one request. When the private compactor is present this is
 * exactly `planDeterministicDedupe`; when it is ABSENT the returned plan is `supported: false` with
 * `INPUT_COMPACTION_ABSENT_REASON`, which every caller already handles by forwarding the original
 * request unchanged. A real error raised from INSIDE a present compactor propagates unchanged — and so
 * does a module-not-found naming anything OTHER than this seam's own target, which is a packaging
 * defect rather than an excluded capability. Only THIS module's absence degrades.
 */
export async function planInputCompaction(
  endpoint: string,
  bodyText: string,
  opts: { minBlockChars?: number } = {}
): Promise<DedupePlan> {
  let plan: ApplyPolicyContract["planDeterministicDedupe"];
  try {
    ({ planDeterministicDedupe: plan } = (await import(APPLY_POLICY_SPECIFIER)) as ApplyPolicyContract);
  } catch (error) {
    if (!isModuleAbsentError(error, { specifier: APPLY_POLICY_SPECIFIER, importerUrl: import.meta.url })) throw error;
    return absentPlan(endpoint, bodyText, INPUT_COMPACTION_ABSENT_REASON);
  }
  return plan(endpoint, bodyText, opts);
}
