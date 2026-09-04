/** Shared truthful semantics for durable whole-run Stop activity events. */
import type { ActivityEvent } from "./activity-event.js";
import { validateActivityEventForStore } from "./activity-store.js";
import type { CalibrationState } from "./output-shaping-calibration-store.js";
import { outputCalibrationQuery } from "./output-shaping-calibration-store.js";
import type { OutputCalibrationResolver, PerTurnEstimatedSaved } from "./output-shaping-savings.js";
import type { GatewayReceipt } from "./gateway/receipt.js";
import { runAggregateLine } from "./gateway/receipt-line.js";
import type { RunAggregate } from "./gateway/run-aggregate.js";

const INPUT_COMPONENTS = new Set(["lcm-compaction", "deterministic-compaction"]);

function inputComponent(receipt: GatewayReceipt): boolean {
  return receipt.applied_components?.some((component) => INPUT_COMPONENTS.has(component)) === true;
}

/**
 * Resolve posture only from exact receipts. Stored authorized input reduction is full; public
 * explicit input apply remains deliberately unlabelled; otherwise positive shaping is basic.
 */
export function settledRunApplyPosture(
  receipts: readonly GatewayReceipt[],
  aggregate: RunAggregate
): "basic" | "full" | undefined {
  const inputReduced = aggregate.input !== undefined && aggregate.input.after < aggregate.input.before;
  const storedFull = inputReduced && receipts.some(
    (receipt) => receipt.approval_status === "auto-applied-by-policy" && inputComponent(receipt)
  );
  if (storedFull) return "full";
  // A measured input apply without stored authorization is either the public explicit deterministic
  // path or an older/ambiguous receipt. Both keep the exact arrow, but neither may borrow a tier label
  // from current config. The public route remains unmetered; absence of component provenance does not
  // license us to relabel an unexplained reduction as output-only `basic` shaping.
  if (inputReduced) return undefined;
  return aggregate.shapedCallCount > 0 ? "basic" : undefined;
}

/** Exact-key output estimate state for one already-aggregated run; never falls back to a prior. */
export function settledRunOutputEstimate(
  aggregate: RunAggregate,
  receipts: readonly GatewayReceipt[],
  resolver: OutputCalibrationResolver
): PerTurnEstimatedSaved {
  const output = aggregate.output;
  if (output?.counterfactualAvailable === true && output.before > output.after) {
    return {
      calibrated: true,
      tokensSaved: output.before - output.after,
      basis: "measured",
      state: "calibrated"
    };
  }
  const states = receipts
    .filter((receipt) =>
      receipt.output_shaping_state === "attached-this-pass" ||
      receipt.output_shaping_state === "already-active"
    )
    .map((receipt) => outputCalibrationQuery({
      policyVersion: receipt.output_shaping_policy_version,
      provider: receipt.provider,
      model: receipt.model,
      regime: receipt.output_shaping_regime
    }))
    .map((query) => query ? resolver(query).state : undefined);
  const state: CalibrationState =
    states.length > 0 && states.every((candidate) => candidate === "measured-no-effect")
      ? "measured-no-effect"
      : states.some((candidate) => candidate === "calibrating")
        ? "calibrating"
        : "unseeded";
  return { calibrated: false, state };
}

/** One canonical renderer for both persisted Codex and Claude whole-run Stop events. */
export function settledStopLineFromActivityEvent(event: ActivityEvent): string | undefined {
  if (
    (event.activity_kind !== "codex-stop" && event.activity_kind !== "claude-stop") ||
    validateActivityEventForStore(event).problems.length > 0
  ) return undefined;
  const actualInput = typeof event.input_after === "number" ? event.input_after : event.input_before;
  const actualOutput = event.output_after;
  const saved = event.estimated_output_tokens_saved;
  const shaped = event.output_shaping_state === "active";
  const line = runAggregateLine({
    aggregate: {
      callCount: 1,
      ...(typeof actualInput === "number"
        ? { input: { before: event.input_before ?? actualInput, after: actualInput } }
        : {}),
      ...(typeof actualOutput === "number"
        ? {
            output: {
              before: actualOutput + (typeof saved === "number" ? saved : 0),
              after: actualOutput,
              counterfactualAvailable: typeof saved === "number"
            }
          }
        : {}),
      shapedCallCount: shaped ? 1 : 0
    },
    ...(event.apply_posture ? { tier: event.apply_posture } : {}),
    ...(event.output_estimate_basis === "measured" && typeof saved === "number"
      ? { outputBasis: "measured" as const }
      : {}),
    ...(shaped && event.output_estimate_state
      ? { outputState: event.output_estimate_state }
      : shaped
        ? { outputState: "unseeded" as const }
        : {})
  });
  return line &&
    event.activity_kind === "claude-stop" &&
    event.measurement_source === "claude-transcript" &&
    event.claim_scope === "workflow-scoped"
    ? line.replace("compaction · ", "compaction · session cumulative · ")
    : line;
}
