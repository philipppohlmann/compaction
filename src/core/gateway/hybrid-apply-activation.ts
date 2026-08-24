/**
 * HYBRID APPLY ACTIVATION (PUBLIC CLI/SDK core, engine-free, content-free).
 *
 * The explicit, versioned activation switch that makes the on-device HYBRID
 * compaction apply path REACHABLE. It is the simplified activation chosen over the research-grade
 * promotion fortress (`lcm-qualified-classes.ts`): instead of requiring per-class, live-verified,
 * two-run promotion evidence before a class may be considered, the apply boundary now considers any
 * non-global class when this activation is on, while the per-request SAFETY NET (apply-boundary
 * GATES 2-7: active stored authorization → narrow non-global scope → source-validated candidate →
 * content-free evidence → a real body change → the original retained for byte-exact recovery) is
 * UNCHANGED. Turning apply on does NOT bypass any of those gates; it only replaces GATE 1's
 * qualification source.
 *
 * DORMANT-MACHINERY DISCIPLINE (dormant BY DEFAULT): the mutation path ships OFF and is reachable
 * ONLY when a deployment EXPLICITLY opts in via `COMPACTION_HYBRID_APPLY=1` (or `true`). It is NEVER
 * enabled-by-default and NEVER an opt-out, a gateway with an existing stored authorization does not
 * silently start mutating requests just because this code shipped. The version label records WHICH
 * activation an operator is opting into; the fortress path (`lcm-qualified-classes.ts`) remains
 * available and dormant-by-construction alongside this.
 */

/** The activation version label, records which activation an explicit opt-in enables. */
export const HYBRID_APPLY_ACTIVATION_VERSION = "hybrid-apply-2026-07-24";

/** Explicit opt-in env: set to `1`/`true` to enable hybrid apply. Absent/anything else = dormant. */
export const HYBRID_APPLY_ENV = "COMPACTION_HYBRID_APPLY";

/**
 * Whether the hybrid apply path is active. DORMANT BY DEFAULT, true ONLY when the deployment has
 * explicitly opted in (`COMPACTION_HYBRID_APPLY=1|true`). Read fresh so a change is honored on the
 * very next request. Never throws.
 */
export function isHybridApplyActivated(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[HYBRID_APPLY_ENV];
  return raw === "1" || (typeof raw === "string" && raw.toLowerCase() === "true");
}
