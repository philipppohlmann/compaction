/**
 * Report-only auto-apply gate check.
 *
 * `evaluateAutoApplyGates(context)` is a pure verdict function: it maps boolean safety facts to
 * per-gate pass/fail verdicts plus an `allPassed` roll-up, and does nothing else. It performs no
 * I/O, imports nothing that mutates a session/trace/run record/file, exports no apply function,
 * and never invokes the apply engine (src/engine/**). `allPassed: true` does not cause anything
 * to be applied, it only tells a gated caller that the safety gates are satisfied.
 *
 * Fail-closed: every gate defaults to FAILED and passes only when its context field is exactly
 * boolean `true` (missing/null/undefined/non-`true` fails, never "assumed pass"). `allPassed`
 * requires every gate, including `explicit-opt-in`, so an empty or partial context is always
 * `false`.
 *
 * The gate list matches the stored-preference contract (`DEFAULT_GATES_REQUIRED` in
 * policy-preferences.ts).
 */

/** The ordered auto-apply gate names. `explicit-opt-in` is first, it is the whole precondition. */
export const AUTO_APPLY_GATE_NAMES = [
  "explicit-opt-in",
  "scope-match",
  "original-retained",
  "capsule-provenance",
  "recoverability-pass",
  "reduction-threshold",
  "risk-checks",
  "evidence-label-emitted",
  "rollback-path"
] as const;

export type AutoApplyGateName = (typeof AUTO_APPLY_GATE_NAMES)[number];

/**
 * Inputs to "may this be auto-applied?". Every field is optional and defaults to FAILED, a caller
 * must positively assert each `true`. All fields are content-free boolean safety facts.
 */
export interface AutoApplyGateContext {
  /** An ENABLED `auto-when-gates-pass` preference exists for this exact scope (the opt-in). */
  explicitOptIn?: boolean;
  /** The run's inferred scope (tool + repo? + policy type) matches the stored preference's scope. */
  scopeMatches?: boolean;
  /** The un-compacted original is retained and locatable. */
  originalRetained?: boolean;
  /** Capsule / source-pointer provenance is present for what would change. */
  capsuleProvenancePresent?: boolean;
  /** A recoverability check passed (the change can be reversed). */
  recoverabilityPassed?: boolean;
  /** The reduction threshold was met (enough avoidable context to be worth applying). */
  reductionThresholdMet?: boolean;
  /** Risk checks passed (no risky content class flagged). */
  riskChecksPassed?: boolean;
  /** An evidence label was emitted for the change. */
  evidenceLabelPresent?: boolean;
  /** A rollback / undo path is present. */
  rollbackPathPresent?: boolean;
}

/** One gate's verdict. `passed` is REPORT-ONLY; `reason` explains a fail (fail-closed) or a pass. */
export interface AutoApplyGateVerdict {
  name: AutoApplyGateName;
  passed: boolean;
  reason: string;
}

/** The whole verdict. `allPassed` is true ONLY when every gate passed. Applies nothing. */
export interface AutoApplyGateReport {
  allPassed: boolean;
  gates: AutoApplyGateVerdict[];
}

/** Map each gate to the context field it reads and the human reason strings. */
const GATE_CHECKS: ReadonlyArray<{
  name: AutoApplyGateName;
  read: (context: AutoApplyGateContext) => unknown;
  passReason: string;
  failReason: string;
}> = [
  {
    name: "explicit-opt-in",
    read: (c) => c.explicitOptIn,
    passReason: "an enabled auto-when-gates-pass preference exists for this scope",
    failReason: "no explicit opt-in - the user has not chosen auto-apply for this scope (default: ask each time)"
  },
  {
    name: "scope-match",
    read: (c) => c.scopeMatches,
    passReason: "the run's inferred scope matches the stored preference's scope",
    failReason: "the run's scope does not match a stored preference (never applies cross-scope)"
  },
  {
    name: "original-retained",
    read: (c) => c.originalRetained,
    passReason: "the un-compacted original is retained and locatable",
    failReason: "the original is not confirmed retained - cannot proceed without a retained original"
  },
  {
    name: "capsule-provenance",
    read: (c) => c.capsuleProvenancePresent,
    passReason: "capsule / source-pointer provenance is present",
    failReason: "capsule / source-pointer provenance is missing"
  },
  {
    name: "recoverability-pass",
    read: (c) => c.recoverabilityPassed,
    passReason: "a recoverability check passed",
    failReason: "the recoverability check did not pass"
  },
  {
    name: "reduction-threshold",
    read: (c) => c.reductionThresholdMet,
    passReason: "the reduction threshold was met",
    failReason: "the reduction threshold was not met"
  },
  {
    name: "risk-checks",
    read: (c) => c.riskChecksPassed,
    passReason: "risk checks passed",
    failReason: "risk checks did not pass"
  },
  {
    name: "evidence-label-emitted",
    read: (c) => c.evidenceLabelPresent,
    passReason: "an evidence label was emitted",
    failReason: "no evidence label was emitted"
  },
  {
    name: "rollback-path",
    read: (c) => c.rollbackPathPresent,
    passReason: "a rollback / undo path is present",
    failReason: "no rollback / undo path is present"
  }
];

/**
 * Pure, report-only. Fail-closed: a gate passes only when its field is exactly `true`; every other
 * value fails that gate. The returned report is this function's only effect.
 */
export function evaluateAutoApplyGates(context: AutoApplyGateContext = {}): AutoApplyGateReport {
  const gates: AutoApplyGateVerdict[] = GATE_CHECKS.map((gate) => {
    const passed = gate.read(context) === true;
    return { name: gate.name, passed, reason: passed ? gate.passReason : gate.failReason };
  });
  return { allPassed: gates.every((gate) => gate.passed), gates };
}
