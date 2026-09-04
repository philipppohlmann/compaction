/**
 * THE COLD-START OUTPUT AXIS: what the output clause says on a device that has measured nothing.
 *
 * The history this file guards is a pair of opposite failures, and the rule sits between them.
 *
 *  1. The shipped 0.47 prior rendered `output 777→412 (−47%, est. · default prior)` on turn one of a
 *     fresh install. A specific before, after and percentage read as counted whatever label stands
 *     beside them, and nothing on that device had been counted. WITHDRAWN.
 *  2. Withdrawing it left a bare `output 412` — the exact clause an UNSHAPED turn prints. The axis
 *     disappeared while shaping was running, so the surface stopped distinguishing "Compaction did
 *     nothing here" from "Compaction ran and cannot yet size what it removed".
 *
 * The resolution states the unknown instead of filling it or hiding it: `output N/A→412 (N/A%, est.)`.
 * `N/A` is not a value and no arithmetic recovers one from it.
 *
 * AND THE UNKNOWN IS NOT THE ONLY NO-FIGURE STATE. A device whose own folded A/B says shaping does not
 * reduce its output has an ANSWER, not a gap, and must not have that answer overwritten by our
 * uncertainty — the same substitution, in the same direction, that (1) was withdrawn for. Those two
 * render differently, and that asymmetry is the single most load-bearing assertion here.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_OUTPUT_SHAPING_RATE,
  bestApplicableOutputCalibration,
  loadCalibration
} from "../../src/core/output-shaping-calibration-store.js";
import { estimatePerTurnOutputSaved, loadCalibrationReduction } from "../../src/core/output-shaping-savings.js";
import {
  formatReceiptLine,
  receiptLineFromGatewayReceipt,
  receiptLineOutputOnly,
  runAggregateLine,
  type ReceiptLineFields
} from "../../src/core/gateway/receipt-line.js";
import { receiptLinesFromJsonl } from "../../src/cli/commands/watch.js";
import type { GatewayReceipt } from "../../src/core/gateway/receipt.js";
import {
  TEST_OUTPUT_POLICY_VERSION,
  seedOutputCalibration
} from "../helpers/output-calibration-fixture.js";

/** The 47% prior's reconstruction of a 412-token turn: 412/(1−0.47) ≈ 777. The number that must never appear. */
const PRIOR_RECONSTRUCTED_BEFORE = Math.round(412 / (1 - DEFAULT_OUTPUT_SHAPING_RATE));

let dir: string;
const env = (): NodeJS.ProcessEnv => ({ COMPACTION_CONFIG_DIR: dir });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cold-start-axis-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const QUERY = {
  policyVersion: TEST_OUTPUT_POLICY_VERSION,
  provider: "anthropic",
  model: "claude-opus-5"
} as const;

describe("the exact shared calibration resolver", () => {
  it("has no record on cold start and never returns the generic prior", async () => {
    const match = bestApplicableOutputCalibration(await loadCalibration(env()), QUERY);
    expect(match).toBeUndefined();
    expect(DEFAULT_OUTPUT_SHAPING_RATE).toBe(0.47);
  });

  it("returns only an engine-confirmed exact cohort", async () => {
    await seedOutputCalibration(env(), {
      provider: QUERY.provider,
      model: QUERY.model,
      control: [1000, 1000, 1000],
      treatment: [600, 600, 600]
    });
    const match = bestApplicableOutputCalibration(await loadCalibration(env()), QUERY);
    expect(match?.rate).toBeCloseTo(0.4, 10);
    expect(bestApplicableOutputCalibration(await loadCalibration(env()), { ...QUERY, model: "other" })).toBeUndefined();
  });
});

describe("the lifecycle survives the whole loader → estimator → formatter chain", () => {
  it("a device with NO store loads as `unseeded` (not as an unreadable-store blank)", async () => {
    // The cold-start case must reach the renderer as a KNOWN state. `loadCalibration` absorbs the
    // missing file itself, so this is the real fresh-install path and not an error path.
    const reduction = await loadCalibrationReduction(env(), QUERY);
    expect(reduction.availability).toBe("unavailable");
    expect(reduction.state).toBe("unseeded");
  });

  it("a mismatched cohort loads as unavailable instead of borrowing", async () => {
    await seedOutputCalibration(env(), { provider: QUERY.provider, model: "other" });
    const reduction = await loadCalibrationReduction(env(), QUERY);
    expect(reduction.availability).toBe("unavailable");
    expect(reduction.state).toBe("unseeded");
  });

  it("the estimator forwards the state on every refusal, so the formatter is never left guessing", async () => {
    const unseeded = await loadCalibrationReduction(env(), QUERY);
    const est = estimatePerTurnOutputSaved(unseeded, 412);
    expect(est.calibrated).toBe(false);
    expect(est.tokensSaved).toBeUndefined();
    expect(est.state).toBe("unseeded");
  });
});

/** A shaped Open turn as the renderers see it, with the caller's proof that shaping ran this turn. */
function shapedTurn(over: Partial<ReceiptLineFields> = {}): ReceiptLineFields {
  return { tier: "basic", outputTokens: 412, estimatedOutputSavedRequested: true, estimatedOutputSavedCalibrated: false, ...over };
}

describe("outputClause: four states, three renderings", () => {
  it("UNSEEDED + shaping proven ⇒ the axis is present with an explicitly unknown before", () => {
    const line = formatReceiptLine(shapedTurn({ estimatedOutputSavedState: "unseeded" }));
    expect(line).toContain("output N/A→412 (N/A%, est.)");
  });

  it("CALIBRATING renders the same unknown axis (evidence exists, an answer does not yet)", () => {
    const line = formatReceiptLine(shapedTurn({ estimatedOutputSavedState: "calibrating" }));
    expect(line).toContain("output N/A→412 (N/A%, est.)");
  });

  /**
   * THE ASYMMETRY THIS WHOLE CHANGE TURNS ON. Both states show no percentage; that is all they share.
   * If these two ever render alike, our silence is impersonating the device's own null result.
   */
  it("MEASURED-NO-EFFECT renders a PLAIN count — the device's own answer, not our uncertainty", () => {
    const line = formatReceiptLine(shapedTurn({ estimatedOutputSavedState: "measured-no-effect" }));
    expect(line).toContain("output 412");
    expect(line).not.toContain("N/A");
  });

  it("`unseeded` and `measured-no-effect` are NOT the same line", () => {
    const a = formatReceiptLine(shapedTurn({ estimatedOutputSavedState: "unseeded" }));
    const b = formatReceiptLine(shapedTurn({ estimatedOutputSavedState: "measured-no-effect" }));
    expect(a).not.toBe(b);
  });

  it("a CALIBRATED turn is completely unchanged: the arrow its own A/B earned", () => {
    const line = formatReceiptLine({
      tier: "basic",
      outputTokens: 771,
      estimatedOutputSavedRequested: true,
      estimatedOutputSavedCalibrated: true,
      estimatedOutputTokensSaved: 249,
      estimatedOutputSavedBasis: "measured",
      estimatedOutputSavedState: "calibrated"
    });
    expect(line).toContain("output 1,020→771 (−24%, est.)");
    expect(line).not.toContain("N/A");
  });

  it("an UNSHAPED turn keeps its plain count: nothing ran, so no measurement is missing", () => {
    // `estimatedOutputSavedRequested` unset is how every caller says "this turn was not shaped".
    const line = formatReceiptLine({ tier: "observe", outputTokens: 412, estimatedOutputSavedState: "unseeded" });
    expect(line).toContain("output 412");
    expect(line).not.toContain("N/A");
  });

  it("an ABSENT state fails CLOSED to a plain count — we do not guess which unavailable it is", () => {
    const line = formatReceiptLine(shapedTurn());
    expect(line).toContain("output 412");
    expect(line).not.toContain("N/A");
  });
});

describe("falsification: what must NEVER appear", () => {
  it("the shipped prior cannot leak into the unknown axis, in any slot", () => {
    const line = formatReceiptLine(shapedTurn({ estimatedOutputSavedState: "unseeded" }));
    expect(line).not.toContain(String(PRIOR_RECONSTRUCTED_BEFORE));
    expect(line).not.toContain("47");
    expect(line).not.toContain("default prior");
  });

  it("no digit reaches the BEFORE slot of an unknown axis (a fake before cannot be reconstructed)", () => {
    for (const state of ["unseeded", "calibrating"] as const) {
      const line = formatReceiptLine(shapedTurn({ estimatedOutputSavedState: state }))!;
      expect(line).not.toMatch(/output [\d,]+→/);
      // Nor via the percentage: `N/A%` is the only thing in that slot.
      expect(line).not.toMatch(/output N\/A→[\d,]+ \(−/);
    }
  });

  /**
   * A SAVED COUNT WITHOUT A CALIBRATED BASIS IS NOT EVIDENCE. Even handed a specific `tokensSaved`,
   * an unseeded device may not spend it — the number's existence is not its justification.
   */
  it("a supplied tokensSaved cannot buy an arrow while the state says unmeasured", () => {
    const line = formatReceiptLine(shapedTurn({ estimatedOutputTokensSaved: 365, estimatedOutputSavedState: "unseeded" }));
    expect(line).toContain("output N/A→412 (N/A%, est.)");
    expect(line).not.toContain("777");
  });

  it("a `default-prior` BASIS still suppresses the figure even when marked calibrated", () => {
    // #951's gate, unchanged and re-asserted: the prior is unrenderable through every caller.
    const line = formatReceiptLine({
      tier: "basic",
      outputTokens: 412,
      estimatedOutputSavedRequested: true,
      estimatedOutputSavedCalibrated: true,
      estimatedOutputTokensSaved: 365,
      estimatedOutputSavedBasis: "default-prior",
      estimatedOutputSavedState: "unseeded"
    });
    expect(line).not.toContain("777");
    expect(line).not.toContain("−47%");
    // It falls through to the unknown axis, which is the honest description of that same device.
    expect(line).toContain("output N/A→412 (N/A%, est.)");
  });
});

describe("the hook-only path carries the state (the line a fresh subscription install sees FIRST)", () => {
  it("renders the unknown axis when shaping was active this turn", () => {
    const line = receiptLineOutputOnly({
      outputTokens: 412,
      providerReported: true,
      shapingActive: true,
      tier: "basic",
      estimatedSaved: { calibrated: false, state: "unseeded" }
    });
    expect(line).toContain("output N/A→412 (N/A%, est.)");
  });

  it("renders a plain count when shaping was NOT active, whatever the state says", () => {
    // A stopped or killed turn was not shaped, so it has no missing measurement to report.
    const line = receiptLineOutputOnly({
      outputTokens: 412,
      providerReported: true,
      shapingActive: false,
      tier: "observe",
      estimatedSaved: { calibrated: false, state: "unseeded" }
    });
    expect(line).toContain("output 412");
    expect(line).not.toContain("N/A");
  });

  it("keeps a measured device's arrow (this path must not have been narrowed by the rewire)", () => {
    const line = receiptLineOutputOnly({
      outputTokens: 771,
      providerReported: true,
      shapingActive: true,
      tier: "basic",
      estimatedSaved: { calibrated: true, tokensSaved: 249, basis: "measured", state: "calibrated" }
    });
    expect(line).toContain("output 1,020→771 (−24%, est.)");
  });

  it("distinguishes measured-no-effect from unseeded here too", () => {
    const noEffect = receiptLineOutputOnly({
      outputTokens: 412, providerReported: true, shapingActive: true, tier: "basic",
      estimatedSaved: { calibrated: false, state: "measured-no-effect" }
    });
    expect(noEffect).toContain("output 412");
    expect(noEffect).not.toContain("N/A");
  });
});

describe("the RUN line applies the same rule to summed tokens", () => {
  const shapedRun = { callCount: 3, output: { before: 900, after: 900 }, shapedCallCount: 3 };

  it("shaped calls with no defensible counterfactual ⇒ the run's unknown axis, not a plain total", () => {
    const line = runAggregateLine({ aggregate: shapedRun, tier: "basic", outputState: "unseeded" });
    expect(line).toContain("output N/A→900 (N/A%, est.)");
    // NEVER `−0%`: a zero would claim this device measured a null it has not measured.
    expect(line).not.toContain("−0%");
  });

  it("NO shaped call ⇒ a plain total with NO `N/A` (nothing ran, so nothing is missing)", () => {
    const line = runAggregateLine({
      aggregate: { callCount: 2, output: { before: 900, after: 900 }, shapedCallCount: 0 },
      tier: "basic",
      outputState: "unseeded"
    });
    expect(line).toContain("output 900");
    expect(line).not.toContain("N/A");
  });

  it("a measured-no-effect run reads as a plain total, distinct from the unseeded run", () => {
    const noEffect = runAggregateLine({ aggregate: shapedRun, tier: "basic", outputState: "measured-no-effect" });
    const unseeded = runAggregateLine({ aggregate: shapedRun, tier: "basic", outputState: "unseeded" });
    expect(noEffect).toContain("output 900");
    expect(noEffect).not.toContain("N/A");
    expect(noEffect).not.toBe(unseeded);
  });

  /**
   * AN ARROW NEEDS AN EXPLICIT BASIS. This used to pass `calibrated: true` unconditionally and merely
   * spread `basis` when it happened to be defined — safe only because the single caller set the rate
   * and the basis together. That coupling was an invariant nothing enforced. A summed `before` proves
   * arithmetic happened, not that a defensible rate produced it.
   */
  it("a summed reduction with NO outputBasis draws no arrow", () => {
    const line = runAggregateLine({
      aggregate: { callCount: 2, output: { before: 1200, after: 900 }, shapedCallCount: 2 },
      tier: "basic",
      outputState: "unseeded"
    });
    expect(line).not.toContain("output 1,200→900");
    expect(line).toContain("output N/A→900 (N/A%, est.)");
  });

  it("with the basis supplied the measured run arrow renders exactly as before", () => {
    const line = runAggregateLine({
      aggregate: { callCount: 2, output: { before: 1200, after: 900 }, shapedCallCount: 2 },
      tier: "basic",
      outputBasis: "measured",
      outputState: "calibrated"
    });
    expect(line).toContain("output 1,200→900 (−25%, est.)");
    expect(line).not.toContain("N/A");
  });

  it("`incomplete` still suppresses BOTH axes to plain totals, N/A included", () => {
    // A partial read cannot support a rate; it equally cannot support a claim about what is missing.
    const line = runAggregateLine({ aggregate: shapedRun, tier: "basic", outputState: "unseeded", incomplete: true });
    expect(line).toContain("output 900");
    expect(line).not.toContain("N/A");
  });
});

/**
 * ONE DECISION, EVERY SURFACE. The cold-start axis is decided in `outputClause` and reached by five
 * entry points; a rule that holds on the gateway's own line and not on the replay a user checks
 * afterwards is the exact defect class #951 was fixing (`watch` rendering a bare count for a turn the
 * gateway had just described in full). These drive the remaining surfaces the cases above do not.
 */
describe("every render surface agrees in the cold-start state", () => {
  const UNSEEDED = { calibrated: false, state: "unseeded" as const };

  /** A turn the gateway shaped: the durable `output_shaping_state` the arrow's gate reads. */
  function shapedReceipt(): GatewayReceipt {
    return {
      receipt_id: "5f5399781111222233334444555566ff",
      captured_at: "2026-07-30T10:00:00.000Z",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      endpoint: "/v1/messages",
      mode: "apply",
      upstream_status: 200,
      request_mutated: true,
      model_visible_bytes_changed: true,
      approval_status: "auto-applied-by-policy",
      recovery_id: "rec-1",
      applied_components: ["output-shaping"],
      output_shaping_state: "attached-this-pass",
      output_shaping_policy_version: TEST_OUTPUT_POLICY_VERSION,
      tokens: { prompt_input: 22012, output: 412 },
      fresh_billed_input_reduction: { available: false, note: "x" },
      token_source: "provider-reported",
      cache_source: "unavailable",
      cost_source: "unavailable",
      reasons: { cost: "x" },
      claim_scope: "run-scoped",
      sync_status: "local-only",
      content_uploaded: false,
      label: "x"
    };
  }

  it("the REPLAY renderer (`watch`, `watch --once`, `status` Last turns) shows the same unknown axis", () => {
    const chunk = JSON.stringify(shapedReceipt()) + "\n";
    const [line] = receiptLinesFromJsonl(chunk, {
      productTier: "basic",
      shapedEvidence: true,
      calibrationResolver: () => ({ availability: "unavailable", reason: "no fold yet", state: "unseeded" })
    });
    expect(line).toContain("output N/A→412 (N/A%, est.)");
  });

  it("watch keeps the shaped axis explicitly unavailable when the resolver itself is unavailable", () => {
    const receipt = shapedReceipt();
    const [watchLine] = receiptLinesFromJsonl(JSON.stringify(receipt) + "\n", {
      productTier: "basic",
      shapedEvidence: true
    });
    expect(watchLine).toContain("output N/A→412 (N/A%, est.)");
  });

  it("the GATEWAY per-receipt builder shows it", () => {
    const line = receiptLineFromGatewayReceipt(shapedReceipt(), "basic", undefined, UNSEEDED);
    expect(line).toContain("output N/A→412 (N/A%, est.)");
  });

  it("the direct receipt builder infers the unknown axis from durable shaping provenance", () => {
    const line = receiptLineFromGatewayReceipt(shapedReceipt(), "basic");
    expect(line).toContain("output N/A→412 (N/A%, est.)");
  });

  it("the HOOK-ONLY builder shows it", () => {
    const line = receiptLineOutputOnly({ outputTokens: 412, providerReported: true, shapingActive: true, tier: "basic", estimatedSaved: UNSEEDED });
    expect(line).toContain("output N/A→412 (N/A%, est.)");
  });

  it("the RUN aggregate shows it", () => {
    const line = runAggregateLine({ aggregate: { callCount: 1, output: { before: 412, after: 412 }, shapedCallCount: 1 }, tier: "basic", outputState: "unseeded" });
    expect(line).toContain("output N/A→412 (N/A%, est.)");
  });

  /**
   * AND THEY AGREE ON THE OTHER SIDE TOO. A surface that showed the unknown axis for a measured null
   * would be overwriting the device's finding on that surface alone, which is worse than disagreeing
   * about a gap — so the no-effect rendering is checked across the same builders, not just the gap one.
   */
  it("none of them draws the unknown axis for a MEASURED-NO-EFFECT device", () => {
    const noEffect = { calibrated: false, state: "measured-no-effect" as const };
    const lines = [
      receiptLineFromGatewayReceipt(shapedReceipt(), "basic", undefined, noEffect),
      receiptLineOutputOnly({ outputTokens: 412, providerReported: true, shapingActive: true, tier: "basic", estimatedSaved: noEffect }),
      runAggregateLine({ aggregate: { callCount: 1, output: { before: 412, after: 412 }, shapedCallCount: 1 }, tier: "basic", outputState: "measured-no-effect" }),
      receiptLinesFromJsonl(JSON.stringify(shapedReceipt()) + "\n", {
        productTier: "basic",
        shapedEvidence: true,
        calibrationResolver: () => ({ availability: "unavailable", reason: "measured null", state: "measured-no-effect" })
      })[0]
    ];
    for (const line of lines) {
      expect(line).toContain("output 412");
      expect(line).not.toContain("N/A");
    }
  });
});
