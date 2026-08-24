import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { perTurnLineFromReceipt } from "../../src/core/gateway/server.js";
import { buildGatewayReceipt } from "../../src/core/gateway/receipt.js";
import { buildApplyReceipt } from "../../src/core/gateway/apply-receipt.js";
import type { ApplyActivation } from "../../src/core/gateway/apply-receipt.js";
import type { DedupePlan } from "../../src/core/gateway/request-shape.js";
import type { OpenAiUsageBreakdown } from "../../src/core/gateway/usage.js";
import { provisionValidLease } from "../helpers/lease-fixture.js";
import {
  OUTPUT_SHAPING_CALIBRATION_SCHEMA,
  calibrationStorePath,
  type OutputShapingCalibration
} from "../../src/core/output-shaping-calibration-store.js";

/**
 * THE GATEWAY MUST DESCRIBE A TURN THE SAME WAY EVERY OTHER SURFACE DOES.
 *
 * `watch`, `compaction statusline` and the Claude Code Stop hook all route a full-tier device's REAL
 * apply through `communityFullApplyReceiptLine`. The gateway's own inline line did not: it fell through
 * to the unlabelled Open rendering, so the process that PERFORMED the apply said the least about it -
 * no `full apply` label, no output arrow - while three replay surfaces rendered the same receipt in
 * full. One receipt, two descriptions, and the weaker one came from the strongest evidence.
 *
 * These drive the renderer directly. Reaching a real full apply through `createGatewayServer` needs the
 * private engine and a valid lease, so an end-to-end test could only exercise the Open branch - the one
 * that already worked.
 */

const fixedId = () => "8f4c2f6e-0000-0000-0000-000000000000";
const fixedNow = () => "2026-07-29T00:00:00.000Z";

const applyActivation: ApplyActivation = {
  mode: "apply",
  requested: true,
  activation: "explicit-mode",
  policy: "deterministic-dedupe"
};

const plan: DedupePlan = {
  policy: "deterministic-dedupe",
  shape: "chat-messages",
  supported: true,
  changed: true,
  removedBlocks: 1,
  charsBefore: 164840,
  charsAfter: 87504,
  estTokensBefore: 41210,
  estTokensAfter: 21876,
  reductionPercent: 47
};

function realApplyReceipt(outputTokens = 512) {
  const usage: OpenAiUsageBreakdown = { present: true, promptInputTokens: 50, outputTokens, model: "gpt-4o" };
  return buildApplyReceipt({
    provider: "openai",
    endpoint: "/v1/chat/completions",
    upstreamStatus: 200,
    usage,
    activation: applyActivation,
    plan,
    applied: true,
    id: fixedId,
    now: fixedNow
  });
}

let configDir: string;

/**
 * A device genuinely on the `full` tier: a dev-signed, device-bound, in-period lease PLUS the persisted
 * product mode - the same three-condition state the real apply gate requires. `full` is not a
 * preference a device can simply assert; `clampTier` demotes a `full` mode with no valid lease to
 * `observe`, so writing the mode alone would leave this test asserting nothing about entitlement.
 */
function writeFullTierDevice(): void {
  provisionValidLease(configDir, {}, { productMode: "full" });
}

/** Entitled the same way, but the user chose `basic`: the label is not theirs to print. */
function writeBasicTierDevice(): void {
  provisionValidLease(configDir, {}, { productMode: "basic" });
}

/**
 * A measured output-shaping calibration, so the output arrow has an honest rate behind it. Without one
 * the line correctly degrades to a plain `output N` - which is the point of the "no estimate" case
 * below, and the reason this fixture is opt-in rather than always present.
 */
function writeCalibration(controlTokens: number, treatmentTokens: number, turns: number): void {
  const calibration: OutputShapingCalibration = {
    schema: OUTPUT_SHAPING_CALIBRATION_SCHEMA,
    sampleCount: 3,
    totalControlOutputTokens: controlTokens,
    totalTreatmentOutputTokens: treatmentTokens,
    totalTurns: turns,
    experimentIds: ["exp-a", "exp-b", "exp-c"],
    updatedAt: "2026-07-29T00:00:00.000Z"
  };
  writeFileSync(calibrationStorePath(env()), `${JSON.stringify(calibration, null, 2)}\n`, "utf8");
}

function env(): NodeJS.ProcessEnv {
  return { ...process.env, COMPACTION_CONFIG_DIR: configDir, COMPACTION_HOME: configDir };
}

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "compaction-gw-fullapply-"));
  mkdirSync(configDir, { recursive: true });
});
afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

describe("gateway inline line - a REAL full apply renders the canonical full line", () => {
  it("carries the input arrow, the `full apply` label and the receipt id", async () => {
    writeFullTierDevice();
    const line = await perTurnLineFromReceipt(realApplyReceipt(), { entitlementEnv: env() });
    expect(line).toContain("input 41,210→21,876 (−47%)");
    expect(line).toContain("full apply");
    expect(line).toContain("id 8f4c2f6e");
  });

  /**
   * THE HALF THAT WAS MISSING. The input arrow survived the old path (the Open renderer prints it); the
   * `full apply` label and the OUTPUT arrow did not. The output before is reconstructed from the
   * calibrated rate, so it must carry an estimate label and never the bare measured `(−PP%)` the input
   * arrow uses.
   */
  it("carries the OUTPUT arrow too, and a DEVICE-CALIBRATED rate drops the `default prior` qualifier", async () => {
    writeFullTierDevice();
    writeCalibration(1000, 790, 40); // a measured 21% reduction on THIS device
    const line = await perTurnLineFromReceipt(realApplyReceipt(512), { entitlementEnv: env() });
    expect(line).toMatch(/output [\d,]+→512 \(−\d+%, est\.\)/);
    expect(line).not.toContain("default prior");
    expect(line).toContain("full apply");
    // The input arrow stays UNLABELLED: it is a real before→after, not a reconstruction.
    expect(line).toContain("input 41,210→21,876 (−47%)");
  });

  /**
   * PROVENANCE, not presence. With no A/B on this device the rate is the SHIPPED DEFAULT PRIOR, which is
   * an honest estimate - so the arrow still renders, but it must say whose evidence backs it. The
   * difference between this case and the one above is the whole point of the two labels: `est. · default
   * prior` is the shipped starting figure, `est.` is what THIS device measured.
   */
  it("with no calibration on this device: the arrow rides the default prior, and says so", async () => {
    writeFullTierDevice();
    const line = await perTurnLineFromReceipt(realApplyReceipt(512), { entitlementEnv: env() });
    expect(line).toMatch(/output [\d,]+→512 \(−\d+%, est\. · default prior\)/);
    expect(line).toContain("full apply");
  });

  /**
   * NEVER FABRICATE A BEFORE. The output before is always DERIVED, so with no output count at all there
   * is nothing to derive it from and no arrow may appear - the receipt's real input reduction still
   * renders, because that half was measured.
   */
  it("with no output count at all: no output clause, no invented before, input reduction intact", async () => {
    writeFullTierDevice();
    const usage: OpenAiUsageBreakdown = { present: true, promptInputTokens: 50, model: "gpt-4o" };
    const receipt = buildApplyReceipt({
      provider: "openai",
      endpoint: "/v1/chat/completions",
      upstreamStatus: 200,
      usage,
      activation: applyActivation,
      plan,
      applied: true,
      id: fixedId,
      now: fixedNow
    });
    const line = await perTurnLineFromReceipt(receipt, { entitlementEnv: env() });
    expect(line).not.toMatch(/output [\d,]+→/);
    expect(line).toContain("input 41,210→21,876 (−47%)");
    expect(line).toContain("full apply");
  });

  /**
   * THE CANONICAL FULL LINE, pinned end to end in the order the grammar specifies. A per-field test can
   * pass while the fields are assembled in a shape no design doc describes; this is the one assertion
   * that would catch that.
   */
  it("renders the canonical grammar, in order", async () => {
    writeFullTierDevice();
    const line = await perTurnLineFromReceipt(realApplyReceipt(512), { entitlementEnv: env() });
    expect(line).toBe(
      "compaction · input 41,210→21,876 (−47%) · output 966→512 (−47%, est. · default prior) · " +
        "−$0.05 (list price) · full apply · id 8f4c2f6e"
    );
  });

  /**
   * `full apply` is an ENTITLEMENT statement. A device that is not on the full tier may not print it,
   * even holding a receipt that carries a real apply - the label would assert an entitlement the device
   * does not have. The measured reduction the receipt DOES carry still renders.
   */
  it("a non-full device never prints `full apply`, but keeps the measured input reduction", async () => {
    writeBasicTierDevice();
    const line = await perTurnLineFromReceipt(realApplyReceipt(), { entitlementEnv: env() });
    expect(line).not.toContain("full apply");
    expect(line).toContain("input 41,210→21,876 (−47%)");
  });

  /**
   * The builder's own refusal must survive being called from here: a record receipt on a full-tier
   * device must not acquire a `full apply` label from the gateway any more than from `watch`.
   */
  it("a RECORD receipt on a full-tier device is never labelled `full apply`", async () => {
    writeFullTierDevice();
    const usage: OpenAiUsageBreakdown = { present: true, promptInputTokens: 100, outputTokens: 412, model: "gpt-4o" };
    const receipt = buildGatewayReceipt({
      provider: "openai",
      endpoint: "/v1/chat/completions",
      mode: "record",
      upstreamStatus: 200,
      usage,
      id: fixedId,
      now: fixedNow
    });
    const line = await perTurnLineFromReceipt(receipt, { entitlementEnv: env() });
    expect(line ?? "").not.toContain("full apply");
  });

  /**
   * An apply that ran but mutated NOTHING (a no-op / dry-run-shaped receipt) is not a full apply. It
   * carries no before→after, so there is nothing to label and nothing to reduce.
   */
  it("an apply that did not mutate is never labelled `full apply`", async () => {
    writeFullTierDevice();
    const usage: OpenAiUsageBreakdown = { present: true, promptInputTokens: 50, outputTokens: 20, model: "gpt-4o" };
    const receipt = buildApplyReceipt({
      provider: "openai",
      endpoint: "/v1/chat/completions",
      upstreamStatus: 200,
      usage,
      activation: applyActivation,
      applied: false,
      id: fixedId,
      now: fixedNow
    });
    const line = await perTurnLineFromReceipt(receipt, { entitlementEnv: env() });
    expect(line ?? "").not.toContain("full apply");
  });
});
