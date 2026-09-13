/**
 * Package-shipped, content-free output-calibration confirmations.
 *
 * Generated only by scripts/output-calibration.mjs after the private confirmation gate passes.
 * Every entry is revalidated and exact-matched by the public loader.
 */
import type { OutputShapingCalibrationConfirmation } from "./output-shaping-calibration-store.js";

export const SHARED_OUTPUT_CALIBRATION_CONFIRMATIONS = [
  {
    "schema": "output-shaping.calibration-confirmation.v1",
    "confirmation": "engine-confirmed",
    "confirmationId": "a1afd6e947d584507a1b0dd0a3f1f1ef825f2481b83ca7f55c3049baf05f2aa2",
    "providerReported": true,
    "policyVersion": "output-shaping.v1.sha256.d326ef20760ad30142e0b4bc37fcb55a4a8fade7c9964f90158fdbafb49e0f83",
    "provider": "openai",
    "model": "gpt-5.6-sol",
    "regime": "default-shapeable",
    "nControl": 3,
    "nTreatment": 3,
    "totalControlOutputTokens": 288,
    "totalTreatmentOutputTokens": 216,
    "intervalLow": 20.944949536696107,
    "intervalHigh": 27.055050463303893,
    "evalOrder": "control-first",
    "controlFullContentSufficiency": "pass",
    "treatmentFullContentSufficiency": "pass",
    "truncated": false,
    "refused": false,
    "confirmedAt": "2026-09-05T08:20:25Z"
  }
] as const satisfies
  readonly OutputShapingCalibrationConfirmation[];
