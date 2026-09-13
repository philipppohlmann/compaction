import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { perTurnLineFromReceipt } from "../../src/core/gateway/server.js";
import { receiptLinesFromJsonl } from "../../src/cli/commands/watch.js";
import { buildGatewayReceipt } from "../../src/core/gateway/receipt.js";
import { buildApplyReceipt } from "../../src/core/gateway/apply-receipt.js";
import type { ApplyActivation } from "../../src/core/gateway/apply-receipt.js";
import type { DedupePlan } from "../../src/core/gateway/request-shape.js";
import type { OpenAiUsageBreakdown } from "../../src/core/gateway/usage.js";
import { provisionValidLease } from "../helpers/lease-fixture.js";
import { seedOutputCalibration, TEST_OUTPUT_POLICY_VERSION } from "../helpers/output-calibration-fixture.js";
import { loadOutputCalibrationResolver } from "../../src/core/output-shaping-savings.js";

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
  estTokensBefore: 12_000,
  estTokensAfter: 9_000,
  reductionPercent: 47
};

/**
 * A real Community full-apply turn. `route` is the UPSTREAM BILLING ROUTE the gateway forwarded on and
 * defaults to the user's own API key, because that is the route every pre-existing assertion here was
 * written against. Pass `"subscription"` to exercise the flat-fee route, where no per-token amount is
 * billed and the list-price cost clause therefore has nothing to describe.
 */
function realApplyReceipt(outputTokens = 512, route: "api-key" | "subscription" = "api-key") {
  const usage: OpenAiUsageBreakdown = { present: true, promptInputTokens: 50, outputTokens, model: "gpt-4o" };
  return {
    ...buildApplyReceipt({
    provider: "openai",
    endpoint: "/v1/chat/completions",
    upstreamStatus: 200,
    usage,
    activation: applyActivation,
    plan,
    applied: true,
    authorizationId: "pref-1234567890abcdef12345678",
    appliedComponents: ["lcm-compaction"],
    composedInputEstimate: { before: 12_000, after: 9_000 },
    outputShapingState: "already-active",
    outputShapingPolicyVersion: TEST_OUTPUT_POLICY_VERSION,
    outputShapingRegime: "default-shapeable",
    upstreamRouteType: route,
    id: fixedId,
    now: fixedNow
    }),
    approval_status: "auto-applied-by-policy" as const
  };
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
async function writeCalibration(controlTokens: number, treatmentTokens: number): Promise<void> {
  await seedOutputCalibration(env(), {
    provider: "openai",
    model: "gpt-4o",
    regime: "default-shapeable",
    control: [controlTokens, controlTokens, controlTokens],
    treatment: [treatmentTokens, treatmentTokens, treatmentTokens]
  });
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
    expect(line).toContain("input 12,000→9,000 (−25%)");
    expect(line).toContain("full apply");
    expect(line).toContain("id 8f4c2f6e");
  });

  /**
   * THE HALF THAT WAS MISSING. The input arrow survived the old path (the Open renderer prints it); the
   * `full apply` label and the OUTPUT arrow did not. The output before is reconstructed from the
   * calibrated rate, so it must carry an estimate label and never the bare measured `(−PP%)` the input
   * arrow uses.
   */
  it("carries the OUTPUT arrow too, on a DEVICE-CALIBRATED rate", async () => {
    writeFullTierDevice();
    await writeCalibration(1000, 790); // a measured 21% reduction on THIS device
    const line = await perTurnLineFromReceipt(realApplyReceipt(512), { entitlementEnv: env() });
    expect(line).toMatch(/output [\d,]+→512 \(−\d+%, est\.\)/);
    expect(line).not.toContain("default prior");
    expect(line).toContain("full apply");
    // The input arrow stays UNLABELLED: it is a real before→after, not a reconstruction.
    expect(line).toContain("input 12,000→9,000 (−25%)");
  });

  /**
   * PRESENCE, not provenance — the axis this case was decided on twice, differently. It used to render
   * the shipped prior's arrow with an `est. · default prior` qualifier, on the reasoning that a
   * disclosed prior is an honest estimate. It is honest about WHOSE number it is and silent about the
   * fact that nothing on this device was counted, which a reconstructed numerical arrow would imply.
   *
   * So a device with no A/B renders NO output FIGURE — while the INPUT arrow beside it survives
   * untouched, because that one has two measured endpoints on this very receipt. That contrast is the
   * rule in one line: measured axes render, reconstructed-from-a-prior axes do not.
   *
   * The axis itself is not deleted, though. Shaping ran on this turn, and a plain `output 512` is the
   * same clause an unshaped turn prints — so the unknown is stated as unknown. `N/A` is not a value,
   * cannot be read as a count, and cannot be arithmetic'd back into one.
   */
  it("with no calibration on this device: an UNKNOWN output before, and the measured input arrow is untouched", async () => {
    writeFullTierDevice();
    const line = await perTurnLineFromReceipt(realApplyReceipt(512), { entitlementEnv: env() });
    expect(line).toContain("output N/A→512 (N/A%, est.)");
    expect(line, "no reconstruction without this device's own measurement").not.toMatch(/output [\d,]+→/);
    expect(line, "the prior's reconstructed before must not appear in any form").not.toContain("966");
    // The MEASURED input arrow is untouched, and its unlabelled `−47%` is not confused with the
    // output axis's absent one — the two axes are independently evidenced on the same line.
    expect(line).toContain("input 12,000→9,000 (−25%)");
    expect(line).toContain("full apply");
  });

  it("keeps the shaped output axis N/A when legacy receipt metadata cannot form an exact key", async () => {
    writeFullTierDevice();
    await writeCalibration(1000, 600);
    const receipt = realApplyReceipt(512);
    delete receipt.output_shaping_policy_version;
    const line = await perTurnLineFromReceipt(receipt, { entitlementEnv: env() });
    expect(line).toContain("output N/A→512 (N/A%, est.)");
    expect(line).not.toMatch(/output [\d,]+→512/);
    expect(line).toContain("full apply");
  });

  it.each(["missing", "absent"] as const)(
    "keeps output as the plain actual when shaping provenance is %s, even with calibration",
    async (provenance) => {
      writeFullTierDevice();
      await writeCalibration(1000, 790);
      const receipt = realApplyReceipt(512);
      delete receipt.output_shaping_policy_version;
      delete receipt.output_shaping_regime;
      if (provenance === "missing") delete receipt.output_shaping_state;
      else receipt.output_shaping_state = "absent";

      const line = await perTurnLineFromReceipt(receipt, { entitlementEnv: env() });
      expect(line).toContain("output 512");
      expect(line).not.toContain("→512");
      expect(line).not.toContain("est.");
      expect(line).toContain("input 12,000→9,000 (−25%)");
      expect(line).toContain("full apply");
    }
  );

  it.each([
    { name: "applicable calibration", receipt: () => realApplyReceipt(512) },
    {
      name: "proven shaping without an exact calibration key",
      receipt: () => {
        const receipt = realApplyReceipt(512);
        delete receipt.output_shaping_regime;
        return receipt;
      }
    }
  ])("matches `compaction watch` for $name", async ({ receipt: makeReceipt }) => {
    writeFullTierDevice();
    await writeCalibration(1000, 790);
    const receipt = makeReceipt();
    const inline = await perTurnLineFromReceipt(receipt, { entitlementEnv: env() });
    const calibrationResolver = await loadOutputCalibrationResolver(env());
    const [watched] = receiptLinesFromJsonl(`${JSON.stringify(receipt)}\n`, {
      productTier: "full",
      calibrationResolver,
      env: env()
    });

    expect(inline).toBe(watched);
    if (receipt.output_shaping_regime) expect(inline).toContain("output 648→512 (−21%, est.)");
    else expect(inline).toContain("output N/A→512 (N/A%, est.)");
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
      authorizationId: "pref-1234567890abcdef12345678",
      appliedComponents: ["lcm-compaction"],
      composedInputEstimate: { before: 12_000, after: 9_000 },
      upstreamRouteType: "api-key",
      id: fixedId,
      now: fixedNow
    });
    receipt.approval_status = "auto-applied-by-policy";
    const line = await perTurnLineFromReceipt(receipt, { entitlementEnv: env() });
    expect(line).not.toMatch(/output [\d,]+→/);
    expect(line).toContain("input 12,000→9,000 (−25%)");
    expect(line).toContain("full apply");
  });

  /**
   * THE CANONICAL FULL LINE, pinned end to end in the order the grammar specifies. A per-field test can
   * pass while the fields are assembled in a shape no design doc describes; this is the one assertion
   * that would catch that.
   */
  it("renders the canonical grammar, in order", async () => {
    writeFullTierDevice();
    // CALIBRATED, so every clause of the grammar is present at once. The output arrow is now the one
    // clause that requires this device's own evidence, so an uncalibrated device no longer renders the
    // full line at all - and a pin taken there would silently stop covering the output clause.
    await writeCalibration(1000, 790);
    const line = await perTurnLineFromReceipt(realApplyReceipt(512), { entitlementEnv: env() });
    expect(line).toBe(
      "compaction · input 12,000→9,000 (−25%) · output 648→512 (−21%, est.) · " +
        "−$0.01 (list price) · full apply · id 8f4c2f6e"
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
    expect(line).toContain("input 12,000→9,000 (−25%)");
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
