/**
 * Package-shipped, content-free output-calibration confirmations.
 *
 * Generated only by scripts/output-calibration.mjs after the private confirmation gate passes.
 * Every entry is revalidated and exact-matched by the public loader.
 */
import type {
  OutputShapingCalibrationConfirmation,
  OutputShapingFamilyCalibrationRecord
} from "./output-shaping-calibration-store.js";

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

/**
 * Package-shipped family evidence is distinct from exact-carrier confirmations: it carries the
 * calibrated N=8 posterior and artifact digests, never fabricated arm totals or task content.
 */
export const SHARED_OUTPUT_FAMILY_CALIBRATIONS = [
  {
    schema: "output-shaping.family-calibration.v1",
    calibration: "family-calibrated",
    treatmentFamilyVersion:
      "output-shaping.family.v1.sha256.d326ef20760ad30142e0b4bc37fcb55a4a8fade7c9964f90158fdbafb49e0f83",
    provider: "openai",
    model: "gpt-5.6-sol",
    regime: "default-shapeable",
    rate: 0.1833079692514799,
    validPairCount: 8,
    sourceEvidencePolicyVersion:
      "output-shaping.v1.sha256.18ed526481a63fc7d7c596b3622b22d106ea906a33b58125e2a36233f25b8775",
    evidenceId:
      "output-shaping.evidence.v1.sha256.abbbd05b65f4a55579a6100c1c6a2875bc16e02d549a2811884600382131da4b",
    evidenceDigest: "abbbd05b65f4a55579a6100c1c6a2875bc16e02d549a2811884600382131da4b",
    methodDigest: "dd9da3afb4ba31a9545981ea9f7e039031fd5bf19774a2dd6835aba47a762dcc",
    provenance: "hierarchical-family-calibration",
    confirmedAt: "2026-10-04T17:18:03.000Z"
  }
] as const satisfies readonly OutputShapingFamilyCalibrationRecord[];
