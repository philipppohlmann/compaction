/**
 * WHY LCM DID OR DID NOT CONTRIBUTE — a content-free, fixed-vocabulary record.
 *
 * WHY THIS EXISTS. The engine already computes a precise reason for every LCM outcome and then throws
 * it away: `apply-pipeline.ts` reads only `outcome.proposedBodyText` from the candidate source, and its
 * `catch` swallows the error class entirely. So on the PRIMARY optimization path there was no way to
 * answer "why didn't LCM help?" from anything a device retains.
 *
 * FIXED VOCABULARY, NEVER FREE TEXT. Every value below is a closed enum. Model output, prompt text,
 * validator violation strings (which quote source tokens), and `Error.message` are NEVER recorded —
 * an exception contributes only `unexpected-error`. This is the same content-free bar the rest of the
 * receipt holds, and it is why this can ship on the public receipt at all.
 *
 * NOT A CLAIM ABOUT SAVINGS. This says what the optimizer did, not what it saved. The metered debit
 * and the receipt's token axes remain the only sources for that.
 */

/** What happened to the LCM candidate on this request. */
export type LcmOutcomeKind =
  | "contributed"
  | "no-candidate"
  | "rejected"
  | "unavailable"
  | "not-attempted"
  | "construction-failed"
  | "error";

/**
 * The stable reason, derived from the outcomes the engine actually implements today. Grouped by the
 * stage that produces them so a reader can tell a config refusal from a model refusal from a
 * body-construction refusal without consulting the code.
 */
export type LcmOutcomeReason =
  // not-attempted — the pipeline never consulted the candidate source (`apply-pipeline.ts`).
  | "input-compaction-disabled"
  | "hybrid-not-activated"
  | "empty-workflow"
  // unavailable — the local summarizer could not be used for this request (`local-model-client.ts`).
  | "no-obsolete-history"
  | "prefix-exceeds-local-context"
  | "warming-cache"
  | "model-not-ready"
  | "local-model-call-disabled-in-ci"
  // no-candidate — the model was reached but produced nothing usable (`candidate-generator.ts`).
  | "model-refusal"
  | "model-error"
  | "unsupported-request-shape"
  | "empty-summary"
  // rejected — a candidate was produced and the safety validator declined it.
  | "validation-unsourced"
  | "validation-over-compression"
  // construction-failed — validated candidate, but no safe body could be built.
  | "unsupported-apply-shape"
  | "body-construction-failed"
  | "reconstructed-body-not-smaller"
  | "candidate-identical-to-original"
  // contributed / catch-all.
  | "applied"
  | "unexpected-error";

export interface LcmOutcome {
  kind: LcmOutcomeKind;
  reason: LcmOutcomeReason;
}

/**
 * Map one engine reason string to the fixed vocabulary. The engine's strings are stable literals in
 * its own source, but this mapping is deliberately TOTAL: anything unrecognised becomes
 * `unexpected-error`, never the raw string, so a future engine reason cannot leak text onto a receipt.
 *
 * NEVER `contributed`. Contribution is a fact about the forwarded body — LCM contributed iff the
 * pipeline applied an LCM body, i.e. iff `lcm-compaction` is in `applied_components` — and only the
 * pipeline knows that. This function is consulted for the outcomes that produced NO applied body, so
 * a validated candidate that arrives here (`lcm-candidate` with an empty summary or an apply shape
 * the body builder does not support) is classified by what stopped it, never as applied.
 */
export function classifyLcmReason(kind: string, reason: string | undefined): LcmOutcome {
  const r = (reason ?? "").toLowerCase();
  const has = (needle: string): boolean => r.includes(needle);

  if (kind === "lcm-candidate") {
    if (has("empty-summary")) return { kind: "no-candidate", reason: "empty-summary" };
    if (has("unsupported-apply-shape")) return { kind: "construction-failed", reason: "unsupported-apply-shape" };
    return { kind: "construction-failed", reason: "body-construction-failed" };
  }

  if (kind === "rejected-candidate") {
    if (has("over-compression")) return { kind: "rejected", reason: "validation-over-compression" };
    return { kind: "rejected", reason: "validation-unsourced" };
  }

  // `no-candidate` covers both "the local client refused" and "the model produced nothing".
  if (has("no-obsolete-history")) return { kind: "unavailable", reason: "no-obsolete-history" };
  if (has("prefix-exceeds-local-context")) return { kind: "unavailable", reason: "prefix-exceeds-local-context" };
  if (has("warming-cache")) return { kind: "unavailable", reason: "warming-cache" };
  if (has("disabled-in-ci")) return { kind: "unavailable", reason: "local-model-call-disabled-in-ci" };
  // `local-model-unavailable: <provisioner reason>` — the daemon/model could not be readied.
  if (has("local-model-unavailable") || has("not-ready") || has("provision")) {
    return { kind: "unavailable", reason: "model-not-ready" };
  }
  if (has("empty-summary")) return { kind: "no-candidate", reason: "empty-summary" };
  if (has("unsupported-request-shape")) return { kind: "no-candidate", reason: "unsupported-request-shape" };
  // `model-client-error: <ErrorClass>` (generator) and `local-model-error: <ErrorClass>` (the local
  // hybrid transport: timeout / connection failure). Both carry only an error CLASS, and neither
  // reaches the receipt: the prefix selects the reason, the class name is dropped here.
  if (has("model-client-error") || has("local-model-error")) return { kind: "no-candidate", reason: "model-error" };
  if (has("refus") || has("no-proposal")) return { kind: "no-candidate", reason: "model-refusal" };
  return { kind: "no-candidate", reason: "unexpected-error" };
}
