import { describe, expect, it } from "vitest";
import type { GatewayReceipt } from "../../src/core/gateway/receipt.js";
import { aggregateRun } from "../../src/core/gateway/run-aggregate.js";
import { runAggregateLine } from "../../src/core/gateway/receipt-line.js";
import {
  emptyCalibration,
  foldCalibrationConfirmation
} from "../../src/core/output-shaping-calibration-store.js";
import { outputCalibrationResolver } from "../../src/core/output-shaping-savings.js";
import {
  TEST_OUTPUT_POLICY_VERSION,
  confirmedOutputCalibration
} from "../helpers/output-calibration-fixture.js";
import { buildHookOutputShapingTreatment } from "../../src/core/output-shaping.js";

function receipt(input: {
  id: string;
  model: string;
  output?: number;
  state?: GatewayReceipt["output_shaping_state"];
  regime?: GatewayReceipt["output_shaping_regime"];
  policyVersion?: string;
}): GatewayReceipt {
  return {
    receipt_id: input.id,
    captured_at: "2026-09-03T00:00:00.000Z",
    provider: "openai",
    model: input.model,
    endpoint: "/v1/responses",
    mode: "record",
    upstream_status: 200,
    model_visible_bytes_changed: false,
    tokens: input.output !== undefined ? { output: input.output } : {},
    fresh_billed_input_reduction: { available: false, note: "none" },
    token_source: input.output !== undefined ? "provider-reported" : "unavailable",
    cache_source: "unavailable",
    cost_source: "unavailable",
    reasons: { cost: "unavailable" },
    claim_scope: "run-scoped",
    approval_status: "not-required",
    sync_status: "local-only",
    content_uploaded: false,
    label: "test",
    ...(input.state ? { output_shaping_state: input.state } : {}),
    ...(input.state === "attached-this-pass" || input.state === "already-active"
      ? { output_shaping_policy_version: input.policyVersion ?? TEST_OUTPUT_POLICY_VERSION }
      : {}),
    ...(input.regime ? { output_shaping_regime: input.regime } : {})
  };
}

describe("run output calibration resolves per call and aggregates token quantities", () => {
  it("different exact per-call rates aggregate counterfactual token quantities, not percentages", () => {
    let store = emptyCalibration();
    store = foldCalibrationConfirmation(store, confirmedOutputCalibration({
      provider: "openai", model: "model-a", control: [1000, 1000, 1000], treatment: [600, 600, 600]
    }));
    store = foldCalibrationConfirmation(store, confirmedOutputCalibration({
      provider: "openai", model: "model-b", control: [1000, 1000, 1000], treatment: [800, 800, 800]
    }));
    const aggregate = aggregateRun([
      receipt({ id: "a", model: "model-a", output: 60, state: "already-active" }),
      receipt({ id: "b", model: "model-b", output: 800, state: "attached-this-pass" })
    ], { outputCalibrationResolver: outputCalibrationResolver(store) });
    expect(aggregate.output).toEqual({ before: 1100, after: 860, counterfactualAvailable: true });
    const line = runAggregateLine({ aggregate, outputBasis: "measured", outputState: "calibrated" });
    expect(line).toContain("output 1,100→860 (−21.8%, est.)");
  });

  it("one uncalibrated shaped call makes the whole run counterfactual N/A", () => {
    const store = foldCalibrationConfirmation(emptyCalibration(), confirmedOutputCalibration({
      provider: "openai", model: "model-a"
    }));
    const aggregate = aggregateRun([
      receipt({ id: "a", model: "model-a", output: 600, state: "already-active" }),
      receipt({ id: "b", model: "model-unsupported", output: 200, state: "attached-this-pass" })
    ], { outputCalibrationResolver: outputCalibrationResolver(store) });
    expect(aggregate.output).toEqual({ before: 1200, after: 800, counterfactualAvailable: false });
    const line = runAggregateLine({ aggregate, outputState: "unseeded" });
    expect(line).toContain("output N/A→800 (N/A%, est.)");
    expect(line).not.toMatch(/output [\d,]+→/);
  });

  it("reconstructs a compatible Run-1 hook counterfactual from the family prior deterministically", () => {
    const receipts = [receipt({
      id: "hook",
      model: "gpt-5.6-sol",
      output: 100,
      state: "already-active",
      regime: "default-shapeable",
      policyVersion: buildHookOutputShapingTreatment().policyVersion
    })];
    const resolver = outputCalibrationResolver(emptyCalibration());
    const first = aggregateRun(receipts, { outputCalibrationResolver: resolver });
    const second = aggregateRun(receipts, { outputCalibrationResolver: resolver });
    expect(first).toEqual(second);
    // The family posterior is 18.33%; this run is ONE short, terse shaped turn, so the refinement shrinks
    // it toward the low end of the evidence corpus (confidence 1/6 at a single shaped call) and the run
    // renders its own figure rather than the posterior verbatim. Pinned exactly because the whole point
    // is determinism: the same receipts must always produce this number.
    expect(first.output).toEqual({ before: 119, after: 100, counterfactualAvailable: true });
    expect(runAggregateLine({
      aggregate: first,
      outputBasis: "family-calibrated",
      outputState: "calibrated"
    })).toContain("output 119→100 (−16.0%, est.)");
  });

  it("held/unshaped calls contribute actual before=after and zero claimed saving", () => {
    const aggregate = aggregateRun([
      receipt({ id: "held", model: "model-a", output: 250, state: "absent" }),
      receipt({ id: "legacy", model: "model-a", output: 50 })
    ], { outputCalibrationResolver: outputCalibrationResolver(emptyCalibration()) });
    expect(aggregate.shapedCallCount).toBe(0);
    expect(aggregate.output).toEqual({ before: 300, after: 300, counterfactualAvailable: true });
    expect(runAggregateLine({ aggregate })).toContain("output 300");
    expect(runAggregateLine({ aggregate })).not.toContain("N/A");
  });

  it("suppresses the run output total when any call has no actual output count", () => {
    const aggregate = aggregateRun([
      receipt({ id: "known", model: "model-a", output: 600, state: "already-active" }),
      receipt({ id: "missing", model: "model-a", state: "already-active" })
    ], { outputCalibrationResolver: outputCalibrationResolver(emptyCalibration()) });
    expect(aggregate.output).toBeUndefined();
    expect(runAggregateLine({ aggregate })).toBeUndefined();
  });
});
