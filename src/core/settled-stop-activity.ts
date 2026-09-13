/** Shared truthful semantics for durable whole-run Stop activity events. */
import type { ActivityEvent } from "./activity-event.js";
import { validateActivityEventForStore } from "./activity-store.js";
import type { CalibrationState } from "./output-shaping-calibration-store.js";
import { outputCalibrationQuery } from "./output-shaping-calibration-store.js";
import type { OutputCalibrationResolver, PerTurnEstimatedSaved } from "./output-shaping-savings.js";
import type { GatewayReceipt } from "./gateway/receipt.js";
import { receiptProvesPrivateFullApply, runAggregateLine } from "./gateway/receipt-line.js";
import type { RunAggregate } from "./gateway/run-aggregate.js";

/**
 * Fields a settled claude-stop event describes THE SAME RUN by. All must agree across every event
 * in a candidate series, or the series is treated as describing different runs (fail closed).
 * `apply_posture`, `output_shaping_state` and the calibration fields are deliberately EXCLUDED: they
 * are per-call-derived and may legitimately evolve as later calls join one run (a later call may
 * prove shaping the earlier ones did not) - only the selected LATEST event's own values are ever
 * rendered, so an earlier event disagreeing on them is not a conflict.
 */
const CLAUDE_STOP_SERIES_IMMUTABLE_FIELDS = [
  "surface",
  "provider",
  "workflow_id",
  "claim_scope",
  "evidence_level",
  "measurement_source",
  "run_started_at"
] as const satisfies readonly (keyof ActivityEvent)[];

/** The cumulative counters a settled claude-stop series must never regress on. */
const CLAUDE_STOP_SERIES_MONOTONIC_FIELDS = ["input_before", "output_after"] as const satisfies readonly (keyof ActivityEvent)[];

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

/**
 * Select the ONE settled claude-stop event to render out of every event sharing one exact logical
 * run identity (same hashed session/run pair), or `undefined` when the set cannot be proven to
 * describe one consistent cumulative series.
 *
 * A single long-running Claude Code session settles more than once: the Stop hook writes a fresh
 * whole-run snapshot on every Stop, and every snapshot after the first carries the SAME logical run
 * identity with strictly larger cumulative counters (this is the writer's own
 * `"monotonic delta from exact prior Claude session transcript usage"` evidence level). Failing
 * closed whenever more than one event shares that identity therefore fails closed on every ordinary
 * long run - only a session that happened to settle exactly once could ever render a settled line.
 *
 * This picks the series' LATEST event - by `recorded_at`, which the monotonic check below also
 * proves is the maximal event on the cumulative counters - when, and only when, the whole set:
 *  - agrees on `CLAUDE_STOP_SERIES_IMMUTABLE_FIELDS` (same run, same measurement method);
 *  - carries a distinct, canonical `recorded_at` on every event (a tie is a conflict, not an order -
 *    it can never be resolved by "latest" without guessing which one actually happened last); and
 *  - is non-decreasing on `input_before` and `output_after` in that `recorded_at` order.
 *
 * Any violation - a backwards counter, a disagreeing `run_started_at`, a duplicate `recorded_at`, a
 * missing counter partway through - keeps the original fail-closed behavior: `undefined`, never a
 * guess at which event is authoritative.
 */
export function latestConsistentClaudeStopEvent(
  events: readonly ActivityEvent[]
): ActivityEvent | undefined {
  if (events.length === 0) return undefined;
  if (events.length === 1) return events[0];

  const first = events[0];
  const sameRunIdentity = CLAUDE_STOP_SERIES_IMMUTABLE_FIELDS.every((field) =>
    events.every((event) => event[field] === first[field])
  );
  if (!sameRunIdentity) return undefined;

  const sorted = [...events].sort((a, b) => {
    const at = typeof a.recorded_at === "string" ? a.recorded_at : "";
    const bt = typeof b.recorded_at === "string" ? b.recorded_at : "";
    return at < bt ? -1 : at > bt ? 1 : 0;
  });

  for (let index = 0; index < sorted.length; index += 1) {
    if (!canonicalTimestamp(sorted[index].recorded_at)) return undefined;
    if (index === 0) continue;
    const older = sorted[index - 1];
    const newer = sorted[index];
    if (newer.recorded_at === older.recorded_at) return undefined; // a tie is a conflict, not an order
    for (const field of CLAUDE_STOP_SERIES_MONOTONIC_FIELDS) {
      const before = older[field];
      const after = newer[field];
      if (typeof before !== "number" || typeof after !== "number" || after < before) return undefined;
    }
  }
  return sorted[sorted.length - 1];
}

/**
 * Resolve posture only from exact receipts. A successful stored-policy private Hybrid/LCM input
 * reduction is full; public deterministic or explicit input apply remains deliberately unlabelled;
 * otherwise positive shaping is basic.
 */
export function settledRunApplyPosture(
  receipts: readonly GatewayReceipt[],
  aggregate: RunAggregate
): "basic" | "full" | undefined {
  const inputReduced = aggregate.input !== undefined && aggregate.input.after < aggregate.input.before;
  const storedFull = inputReduced && receipts.some(receiptProvesPrivateFullApply);
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
        : {}),
    ...(event.activity_kind === "codex-stop" &&
    typeof event.run_started_at === "string" &&
    typeof event.recorded_at === "string"
      ? { activeWindow: { startedAt: event.run_started_at, endedAt: event.recorded_at } }
      : {})
  });
  return line &&
    event.activity_kind === "claude-stop" &&
    event.measurement_source === "claude-transcript" &&
    event.claim_scope === "workflow-scoped"
    ? line.replace("compaction · ", "compaction · session cumulative · ")
    : line;
}
