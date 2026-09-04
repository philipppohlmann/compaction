/**
 * THE RUN AGGREGATE — what the user's whole task saved, derived from the per-call receipt ledger.
 *
 * THE UNIT THE USER THINKS IN IS THE PROMPT, NOT THE PROVIDER CALL. One request sends Claude Code
 * through many model calls, tool calls and continuations, including auxiliary calls it makes on its
 * own behalf. Rendering whichever receipt landed last made the persistent line flicker
 * `full apply → apply off → full apply` inside a single task, because an interleaved record-mode
 * `claude-sonnet-5` title call mutates nothing. Those are micro-events, not changes in what Compaction
 * is doing. Receipts remain the evidence ledger; this is the derived view over them.
 *
 * ACCOUNTING RULES, all from totals and never from per-call percentages:
 *
 * INPUT. Every call contributes, including calls nothing optimized — dropping them from the
 * denominator would inflate the rate by shrinking the base. A call with a current-build before/after
 * pair contributes that pair (both LOCAL-ESTIMATE model-visible counts). A call without one — a
 * record-mode call, or a historical receipt whose pair came from an incompatible basis (see
 * `compatibleInputPair`) — contributes `before = after = tokens.prompt_input`, the PROVIDER-REPORTED
 * input, as an honest zero-delta. THE TWO BASES ARE MIXED, DELIBERATELY AND IN ONE DIRECTION: the
 * filler adds equal amounts to both sides, so it can only dilute the rate, never inflate it, and the
 * alternative (excluding those calls) would shrink the base and overstate the run. The absolute
 * totals are therefore a sum of local estimates and provider counts, not one measurement; the
 * percentage is what the mixing keeps conservative.
 *
 * OUTPUT. `after` is always the provider-reported output. `before` is a COUNTERFACTUAL and is only
 * reconstructed where `output_shaping_state` durably proves shaping was active on that call's final
 * model-visible request — `attached-this-pass` or `already-active`. `absent` contributes
 * `before = after`. A LEGACY receipt with no state FAILS CLOSED and also contributes `before = after`:
 * the final request is not retained, so it cannot be classified afterwards, and an unknown must never
 * manufacture a saving.
 *
 * ALLOWANCE is a level, not a flow: the run shows the ENDING state, never a sum. That state is
 * whichever allowance event came LAST in the run — a debit snapshot (the countdown) or a pause (the
 * ceiling). The `insufficient` pause in particular cannot be reconstructed from a balance: tokens
 * remained, and one call was simply larger than they covered. It is retained from the call that
 * recorded it, exactly as the per-receipt line reads it off that call.
 *
 * The percentage is computed once, from the totals, by the renderer. Nothing here rounds.
 *
 * WHAT THIS MODULE DOES NOT DECIDE: which receipts are in `receipts`. Membership is the caller's
 * (`run-boundary.ts`, session correlation + interval), and the caller's READ is bounded — the status
 * line feeds a tail window of ONE working directory's ledger, so the denominator is what that window
 * held. A window known to have cut the run off is rendered without a rate (see `runAggregateLine`).
 */
import type { GatewayReceipt } from "./receipt.js";
import { outputCalibrationQuery } from "../output-shaping-calibration-store.js";
import type { OutputCalibrationResolver } from "../output-shaping-savings.js";

export interface RunAggregate {
  /** Calls that belonged to this run (the aggregate's denominator, including no-op calls). */
  callCount: number;
  /** Summed model-visible input before/after. Absent when no call carried a compatible pair. */
  input?: { before: number; after: number };
  /** Summed output: `after` provider-reported, `before` the counterfactual where evidence allows. */
  output?: { before: number; after: number; counterfactualAvailable: boolean };
  /** Calls on which output shaping was durably proven ACTIVE — a count of evidence, whether or not a rate existed to reconstruct a counterfactual from it. */
  shapedCallCount: number;
  /** The LAST allowance snapshot seen in the run — a level, never summed. Absent once a later pause. */
  allowance?: { remaining_tokens: number; period_total_tokens: number };
  /**
   * The call that recorded the run's ending allowance PAUSE, when the last allowance event was a pause:
   * exactly the fields `receiptCeiling` reads, so the run line renders the pause reason, reset date and
   * conversion path from the same evidence the per-receipt line would. Absent once a later debit.
   */
  pausedCall?: Pick<GatewayReceipt, "allowance_pause" | "output_shaping_state" | "applied_components">;
}

/**
 * Is this receipt's input pair usable in a run total?
 *
 * A pair is only comparable to other calls when both ends measure the same thing. Receipts written
 * before the engine reported an END-TO-END model-visible pair carry a deterministic-only basis, and on
 * one device 18 such receipts recorded `before === after` while genuinely compacting input. Mixing
 * bases understates the run, so an incompatible receipt contributes its plain input count on both
 * sides instead of a false zero-delta.
 */
function compatibleInputPair(receipt: GatewayReceipt): { before: number; after: number } | undefined {
  const before = receipt.estimated_input_tokens_before;
  const after = receipt.estimated_input_tokens_after;
  if (typeof before !== "number" || typeof after !== "number") return undefined;
  // A pair that claims a component compacted input while reporting no reduction is the incompatible
  // historical basis, not a truthful zero: a real no-change apply does not carry `lcm-compaction`.
  const compactedInput = receipt.applied_components?.some(
    (c) => c === "lcm-compaction" || c === "deterministic-compaction"
  );
  if (compactedInput === true && before === after) return undefined;
  return { before, after };
}

/** Was output shaping durably proven ACTIVE on this call's final model-visible request? */
function shapingProvenActive(receipt: GatewayReceipt): boolean {
  const state = receipt.output_shaping_state;
  return state === "attached-this-pass" || state === "already-active";
}

export interface RunAggregateOptions {
  /**
   * Shared exact-key calibration resolver. Each shaped call resolves from its own policy/provider/model/
   * regime metadata; unshaped calls contribute zero savings. Omitted or unmatched shaped evidence makes
   * the whole run counterfactual unavailable.
   */
  outputCalibrationResolver?: OutputCalibrationResolver;
}

/** Fold the receipts that belong to one run into its aggregate. Pure; order-independent except allowance. */
export function aggregateRun(receipts: GatewayReceipt[], options: RunAggregateOptions = {}): RunAggregate {
  let inputBefore = 0;
  let inputAfter = 0;
  let sawInput = false;
  let outputBefore = 0;
  let outputAfter = 0;
  let sawOutput = false;
  let outputCounterfactualAvailable = true;
  let actualOutputComplete = true;
  let shapedCallCount = 0;
  let allowance: RunAggregate["allowance"];
  let pausedCall: RunAggregate["pausedCall"];

  for (const receipt of receipts) {
    // INPUT — every call contributes; a call with no usable pair contributes an honest zero-delta.
    const pair = compatibleInputPair(receipt);
    const promptInput = receipt.tokens?.prompt_input;
    if (pair) {
      inputBefore += pair.before;
      inputAfter += pair.after;
      sawInput = true;
    } else if (typeof promptInput === "number") {
      inputBefore += promptInput;
      inputAfter += promptInput;
      sawInput = true;
    }

    // OUTPUT — `after` is what the provider reported; `before` is only ever reconstructed on proof.
    // The count is of PROOF, not of reconstruction: it says how many calls shaping was active on, and
    // must not read zero on a device that merely has no measured rate yet.
    const shaped = shapingProvenActive(receipt);
    if (shaped) shapedCallCount++;
    const output = receipt.tokens?.output;
    if (typeof output === "number") {
      outputAfter += output;
      sawOutput = true;
      const query = shaped
        ? outputCalibrationQuery({
            policyVersion: receipt.output_shaping_policy_version,
            provider: receipt.provider,
            model: receipt.model,
            regime: receipt.output_shaping_regime
          })
        : undefined;
      const reduction = query && options.outputCalibrationResolver
        ? options.outputCalibrationResolver(query)
        : undefined;
      const rate = reduction?.availability === "measured" ? reduction.reductionPct / 100 : undefined;
      if (shaped && rate !== undefined && rate > 0 && rate < 1) {
        // Accumulated UNROUNDED and rounded once by the caller-visible total below: rounding each
        // call and then summing compounds up to half a token of error per call across a long run.
        outputBefore += output / (1 - rate);
      } else {
        // `absent`, or legacy `undefined` (fail closed), or no rate to reconstruct with.
        outputBefore += output;
        if (shaped) outputCounterfactualAvailable = false;
      }
    } else {
      // A call belonged to the run but exposed no actual output count. Any run-level output total is
      // therefore incomplete, so no counterfactual percentage may be presented over the known subset.
      outputCounterfactualAvailable = false;
      actualOutputComplete = false;
    }

    // ALLOWANCE — a level. The last allowance EVENT in the run wins and nothing is summed. A debit
    // snapshot and a pause are mutually exclusive on one call (a paused call debited nothing), and they
    // stay mutually exclusive on the run: the later one replaces the earlier, as the ending state.
    const snapshot = receipt.allowance_snapshot;
    if (snapshot !== undefined) {
      allowance = { remaining_tokens: snapshot.remaining_tokens, period_total_tokens: snapshot.period_total_tokens };
      pausedCall = undefined;
    }
    if (receipt.allowance_pause !== undefined) {
      pausedCall = {
        allowance_pause: receipt.allowance_pause,
        ...(receipt.output_shaping_state !== undefined ? { output_shaping_state: receipt.output_shaping_state } : {}),
        ...(receipt.applied_components !== undefined ? { applied_components: receipt.applied_components } : {})
      };
      allowance = undefined;
    }
  }

  return {
    callCount: receipts.length,
    ...(sawInput ? { input: { before: inputBefore, after: inputAfter } } : {}),
    ...(sawOutput && actualOutputComplete
      ? { output: { before: Math.round(outputBefore), after: outputAfter, counterfactualAvailable: outputCounterfactualAvailable } }
      : {}),
    shapedCallCount,
    ...(allowance ? { allowance } : {}),
    ...(pausedCall ? { pausedCall } : {})
  };
}
