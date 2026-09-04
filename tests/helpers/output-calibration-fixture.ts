import {
  OUTPUT_SHAPING_CALIBRATION_CONFIRMATION_SCHEMA,
  outputCalibrationConfirmationId,
  updateCalibrationFromConfirmation,
  type OutputShapingCalibrationConfirmation,
  type OutputShapingCalibrationRegime
} from "../../src/core/output-shaping-calibration-store.js";
import { buildOutputShapingPolicy } from "../../src/core/output-shaping.js";

export const TEST_OUTPUT_POLICY_VERSION = buildOutputShapingPolicy().policyVersion;

export function confirmedOutputCalibration(input: {
  provider?: string;
  model?: string;
  regime?: OutputShapingCalibrationRegime;
  control?: number[];
  treatment?: number[];
  confirmedAt?: string;
} = {}): OutputShapingCalibrationConfirmation {
  const control = input.control ?? [1000, 1000, 1000];
  const treatment = input.treatment ?? [600, 600, 600];
  const meanControl = control.reduce((sum, value) => sum + value, 0) / control.length;
  const meanTreatment = treatment.reduce((sum, value) => sum + value, 0) / treatment.length;
  const delta = meanControl - meanTreatment;
  const numeric = {
    policyVersion: TEST_OUTPUT_POLICY_VERSION,
    provider: input.provider ?? "anthropic",
    model: input.model ?? "claude-opus-5",
    ...(input.regime !== undefined ? { regime: input.regime } : {}),
    nControl: control.length,
    nTreatment: treatment.length,
    totalControlOutputTokens: control.reduce((sum, value) => sum + value, 0),
    totalTreatmentOutputTokens: treatment.reduce((sum, value) => sum + value, 0),
    intervalLow: delta,
    intervalHigh: delta
  };
  return {
    schema: OUTPUT_SHAPING_CALIBRATION_CONFIRMATION_SCHEMA,
    confirmation: "engine-confirmed",
    confirmationId: outputCalibrationConfirmationId(numeric),
    providerReported: true,
    ...numeric,
    evalOrder: "control-first",
    controlFullContentSufficiency: "pass",
    treatmentFullContentSufficiency: "pass",
    truncated: false,
    refused: false,
    confirmedAt: input.confirmedAt ?? "2026-09-03T00:00:00.000Z"
  };
}

export async function seedOutputCalibration(
  env: NodeJS.ProcessEnv,
  input: Parameters<typeof confirmedOutputCalibration>[0] = {}
): Promise<void> {
  await updateCalibrationFromConfirmation(confirmedOutputCalibration(input), env);
}
