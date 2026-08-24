/**
 * NET-BILLED input calibration store (PUBLIC CLI/SDK core, engine-free, content-free, local-first).
 *
 * The per-turn apply line's `input B→A (−PP%)` is a GROSS model-visible estimate (chars/4). It is NOT a
 * net-of-provider-cache fresh-BILLED reduction: applying compaction to a provider-cached prefix can BUST the
 * cache and RAISE fresh-billed input even as model-visible bytes fall. The only provider-CONFIRMED net-billed
 * figure comes from a real A/B: run the SAME task twice — a `baseline` (no apply) arm and a `compacted`
 * (apply) arm under one `proof_run_id` — and compare the provider's fresh-billed input tokens. This store is
 * the running aggregate of those real A/B results:
 *
 *  - It ACCUMULATES real, provider-reported net-billed A/B measurements (each a baseline vs compacted
 *    fresh-billed input-token pair) into a single running aggregate.
 *  - It maintains a running net-billed reduction rate from accumulated baseline/compacted fresh-billed
 *    TOTALS, so a larger experiment pulls the estimate more, and the estimate converges as samples
 *    accumulate. It carries the sample count so a reader can refuse to over-trust a 1-sample rate.
 *  - It represents NON-POSITIVE results HONESTLY. On cache-busting traffic the net-billed reduction can be
 *    zero or NEGATIVE (apply raised fresh-billed input). The aggregate stores the raw fresh-billed totals and
 *    derives a signed rate, so it can say "apply did NOT help / HURT on cached traffic" — it never floors a
 *    negative delta to a positive, and it never fabricates a reduction.
 *  - It is CONTENT-FREE: only aggregate token totals, a sample count, an opaque proof-run-id set, and
 *    timestamps — never a prompt, response, or trace byte.
 *
 * A figure is produced ONLY from real measurements fed in via `updateNetBilledCalibrationFromDelta` (the
 * key-gated operator A/B path, e.g. `compaction gateway verify-cache`). Nothing here fabricates a
 * counterfactual: a single receipt with no baseline arm can never move the aggregate — only a real,
 * both-arms-provider-reported A/B does.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { GatewayProofDelta } from "./proof.js";
import { compactionConfigDir } from "../config-dir.js";

export const NET_BILLED_CALIBRATION_SCHEMA = "net-billed.calibration.v1" as const;

/**
 * The accumulated, content-free net-billed aggregate. Every field is a count, a total, an opaque id, or a
 * timestamp. `sampleCount` is the number of DISTINCT A/B proof runs folded in (a proof-run re-added by id is a
 * no-op — see `foldNetBilledDelta` — so re-running the same A/B does not double-count). The net-billed
 * reduction rate is DERIVED from the totals (signed), never stored as an independent number that could drift.
 */
export interface NetBilledCalibration {
  schema: typeof NET_BILLED_CALIBRATION_SCHEMA;
  /** Number of distinct provider-reported A/B proof runs folded into the aggregate. */
  sampleCount: number;
  /** Cumulative BASELINE (no-apply arm) provider-reported fresh-billed input tokens across folded A/Bs. */
  totalBaselineFreshInputTokens: number;
  /** Cumulative COMPACTED (apply arm) provider-reported fresh-billed input tokens across folded A/Bs. */
  totalCompactedFreshInputTokens: number;
  /** The opaque proof-run ids folded in (content-free labels), so a re-add is a no-op not a double-count. */
  proofRunIds: string[];
  updatedAt: string;
}

/** A fresh, empty aggregate (the net-billed figure is `unavailable` until the first real A/B is folded in). */
export function emptyNetBilledCalibration(now: () => string = () => new Date().toISOString()): NetBilledCalibration {
  return {
    schema: NET_BILLED_CALIBRATION_SCHEMA,
    sampleCount: 0,
    totalBaselineFreshInputTokens: 0,
    totalCompactedFreshInputTokens: 0,
    proofRunIds: [],
    updatedAt: now()
  };
}

/**
 * The current calibrated net-billed reduction from the aggregate, with the sign preserved.
 *  - `measured: false` when there is no folded sample yet OR the baseline fresh-billed total is non-positive
 *    (no honest denominator). No fabricated figure.
 *  - `measured: true` carries a SIGNED `rate` (baseline − compacted)/baseline. The rate is POSITIVE when apply
 *    lowered net-billed input, ZERO when unchanged, and NEGATIVE when apply RAISED net-billed input
 *    (cache-busting hurt) — the negative case is a real, honest outcome, never floored to zero.
 */
export interface NetBilledRate {
  measured: boolean;
  /** The sample-weighted SIGNED net-billed reduction fraction (baseline − compacted)/baseline, when measured. */
  rate?: number;
  /** The signed absolute net-billed reduction in tokens (baseline − compacted total), when measured. */
  absoluteTokens?: number;
  /** Cumulative baseline fresh-billed input tokens behind the rate (the denominator), when measured. */
  baselineFreshInputTokens?: number;
  /** Cumulative compacted fresh-billed input tokens behind the rate, when measured. */
  compactedFreshInputTokens?: number;
  /** How many distinct A/B proof runs back the figure (≥ 1 when measured). */
  sampleCount: number;
}

/**
 * Derive the current net-billed rate from an aggregate. Pure. A figure is `measured` only when at least one
 * A/B has been folded in AND the baseline fresh-billed total is strictly positive (a real denominator). The
 * rate keeps its SIGN: a non-positive result is surfaced honestly, never floored.
 */
export function netBilledRate(cal: NetBilledCalibration): NetBilledRate {
  const base = { sampleCount: cal.sampleCount };
  if (cal.sampleCount < 1) return { measured: false, ...base };
  if (!(cal.totalBaselineFreshInputTokens > 0)) return { measured: false, ...base };
  const absoluteTokens = cal.totalBaselineFreshInputTokens - cal.totalCompactedFreshInputTokens;
  const rate = absoluteTokens / cal.totalBaselineFreshInputTokens;
  if (!Number.isFinite(rate)) return { measured: false, ...base };
  return {
    measured: true,
    rate,
    absoluteTokens,
    baselineFreshInputTokens: cal.totalBaselineFreshInputTokens,
    compactedFreshInputTokens: cal.totalCompactedFreshInputTokens,
    ...base
  };
}

/**
 * Fold a MEASURED A/B proof delta into the aggregate, returning the NEW aggregate (pure; does no IO). Only a
 * proof delta whose BOTH arms are provider-reported (`delta.available === true`) AND that carries both
 * fresh-billed input totals contributes; anything weaker is ignored (returns the aggregate unchanged) — a
 * non-measured A/B can never move the figure.
 *
 * Contribution is the raw baseline/compacted fresh-billed TOTALS, so a larger experiment pulls the running
 * estimate more. The net delta (baseline − compacted) is intentionally NOT clamped: a NEGATIVE delta
 * (compacted > baseline, i.e. apply busted the cache and RAISED fresh-billed input) is accumulated with its
 * true sign so `netBilledRate` can report the honest non-positive outcome. Re-adding a proof-run id already
 * folded in is a NO-OP (the first fold wins), keeping the store idempotent by id and append-safe.
 */
export function foldNetBilledDelta(
  cal: NetBilledCalibration,
  params: { proofRunId: string; delta: GatewayProofDelta },
  now: () => string = () => new Date().toISOString()
): NetBilledCalibration {
  const { proofRunId, delta } = params;
  const baseline = delta.beforeFreshInputTokens;
  const compacted = delta.afterFreshInputTokens;
  // Only a real, both-arms-provider-reported A/B with both fresh-billed totals contributes.
  if (
    !delta.available ||
    baseline === undefined ||
    compacted === undefined ||
    !Number.isFinite(baseline) ||
    !Number.isFinite(compacted) ||
    baseline <= 0
  ) {
    return cal;
  }
  // Idempotent by proof-run id: a re-add of an already-folded A/B is a no-op (the first fold wins). No
  // per-run contribution is retained individually, so this keeps the store content-free and append-safe.
  if (cal.proofRunIds.includes(proofRunId)) return cal;

  return {
    schema: NET_BILLED_CALIBRATION_SCHEMA,
    sampleCount: cal.sampleCount + 1,
    totalBaselineFreshInputTokens: cal.totalBaselineFreshInputTokens + baseline,
    // Accumulated with its TRUE sign — a compacted arm LARGER than baseline (cache-bust) is not clamped.
    totalCompactedFreshInputTokens: cal.totalCompactedFreshInputTokens + compacted,
    proofRunIds: [...cal.proofRunIds, proofRunId],
    updatedAt: now()
  };
}

/**
 * The conventional local net-billed calibration artifact path. `COMPACTION_CONFIG_DIR` overrides
 * `~/.compaction` (mirrors the output-shaping calibration store), so tests and sandboxes point elsewhere.
 */
export function netBilledCalibrationStorePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(compactionConfigDir(env), "net-billed-calibration.json");
}

/**
 * Load the net-billed calibration aggregate from disk, or a fresh empty aggregate when the file is
 * absent/unreadable/malformed or is not the calibration schema. Total and fail-open: never throws.
 */
export async function loadNetBilledCalibration(
  env: NodeJS.ProcessEnv = process.env,
  readFileImpl: (p: string) => Promise<string> = (p) => readFile(p, "utf8")
): Promise<NetBilledCalibration> {
  try {
    const raw = await readFileImpl(netBilledCalibrationStorePath(env));
    const parsed = JSON.parse(raw) as Partial<NetBilledCalibration>;
    if (parsed?.schema !== NET_BILLED_CALIBRATION_SCHEMA) return emptyNetBilledCalibration();
    return {
      schema: NET_BILLED_CALIBRATION_SCHEMA,
      sampleCount: numberOr(parsed.sampleCount, 0),
      totalBaselineFreshInputTokens: numberOr(parsed.totalBaselineFreshInputTokens, 0),
      totalCompactedFreshInputTokens: numberOr(parsed.totalCompactedFreshInputTokens, 0),
      proofRunIds: Array.isArray(parsed.proofRunIds)
        ? parsed.proofRunIds.filter((s): s is string => typeof s === "string")
        : [],
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString()
    };
  } catch {
    return emptyNetBilledCalibration();
  }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Persist the net-billed calibration aggregate to the conventional path (creating the dir). Content-free. */
export async function saveNetBilledCalibration(cal: NetBilledCalibration, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const path = netBilledCalibrationStorePath(env);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(cal, null, 2)}\n`, "utf8");
  return path;
}

/**
 * The operator A/B learning hook: load the aggregate, fold in a completed net-billed A/B proof delta, and
 * persist the updated aggregate — so running more real A/Bs TIGHTENS the measured net-billed figure. Returns
 * the new aggregate and whether this fold actually changed it (a non-measured or already-folded A/B is a
 * no-op). Fail-open on IO is the caller's concern; this resolves normally.
 */
export async function updateNetBilledCalibrationFromDelta(
  params: { proofRunId: string; delta: GatewayProofDelta },
  env: NodeJS.ProcessEnv = process.env,
  now: () => string = () => new Date().toISOString()
): Promise<{ calibration: NetBilledCalibration; updated: boolean }> {
  const current = await loadNetBilledCalibration(env);
  const next = foldNetBilledDelta(current, params, now);
  const updated = next !== current;
  if (updated) await saveNetBilledCalibration(next, env);
  return { calibration: next, updated };
}
