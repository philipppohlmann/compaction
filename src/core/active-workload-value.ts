/**
 * Run-scoped estimate of equivalent active agent time preserved.
 *
 * This is not a provider quota or subscription-extension estimate. It divides tokens avoided on one
 * completed run by that same run's observed token-consumption rate:
 *
 *   avoided tokens / (actual consumed tokens / active run minutes)
 *
 * Input avoidance is the measured before/after delta already shown on the proof line. Output
 * avoidance is included only when an exact-key empirical calibration produced the line's estimated
 * output counterfactual. The whole hook-opened run is the observation window; missing, non-positive,
 * or non-displayable results are omitted rather than replaced with a fixed tokens/minute assumption.
 */

export interface ActiveWorkloadValueInput {
  inputBefore?: number;
  inputAfter?: number;
  outputAfter?: number;
  estimatedOutputTokensAvoided?: number;
  runStartedAt?: string;
  runEndedAt?: string;
}

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function canonicalTime(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) return undefined;
  return parsed;
}

/** Positive minutes at hundredth precision, retaining a thousandth below 0.01m. */
export function estimateEquivalentActiveMinutes(input: ActiveWorkloadValueInput): number | undefined {
  if (!count(input.inputBefore) || !count(input.inputAfter) || input.inputAfter > input.inputBefore) {
    return undefined;
  }
  if (!count(input.outputAfter)) return undefined;
  if (
    input.estimatedOutputTokensAvoided !== undefined &&
    (!count(input.estimatedOutputTokensAvoided) || input.estimatedOutputTokensAvoided <= 0)
  ) return undefined;

  const startedAt = canonicalTime(input.runStartedAt);
  const endedAt = canonicalTime(input.runEndedAt);
  if (startedAt === undefined || endedAt === undefined || endedAt <= startedAt) return undefined;

  const avoidedInput = input.inputBefore - input.inputAfter;
  const avoidedOutput = input.estimatedOutputTokensAvoided ?? 0;
  const avoidedTokens = avoidedInput + avoidedOutput;
  const consumedTokens = input.inputAfter + input.outputAfter;
  if (avoidedTokens <= 0 || consumedTokens <= 0) return undefined;

  const activeMinutes = (endedAt - startedAt) / 60_000;
  const observedTokensPerMinute = consumedTokens / activeMinutes;
  if (!Number.isFinite(observedTokensPerMinute) || observedTokensPerMinute <= 0) return undefined;

  const estimatedMinutes = avoidedTokens / observedTokensPerMinute;
  if (!Number.isFinite(estimatedMinutes) || estimatedMinutes <= 0) return undefined;
  const precision = estimatedMinutes < 0.01 ? 1_000 : 100;
  const rounded = Math.round(estimatedMinutes * precision) / precision;
  return Number.isFinite(rounded) && rounded > 0 ? rounded : undefined;
}
