/**
 * Package-shipped, content-free output-calibration confirmations.
 *
 * This registry is intentionally empty until the private operator gate produces genuine confirmed
 * evidence. `scripts/output-calibration.mjs register` is the only repo-native writer. Every entry is
 * still revalidated and exact-matched by the public loader; this file never carries raw prompts/output
 * content, session ids, credentials, or local paths.
 */
import type { OutputShapingCalibrationConfirmation } from "./output-shaping-calibration-store.js";

export const SHARED_OUTPUT_CALIBRATION_CONFIRMATIONS = [] as const satisfies
  readonly OutputShapingCalibrationConfirmation[];
