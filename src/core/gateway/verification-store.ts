/**
 * Content-free LIVE-verification RESULT store (PUBLIC CLI/SDK code, engine-free).
 *
 * `compaction gateway verify-cache` runs a REAL provider cache verification (operator key required) and
 * records ONE content-free result here, the local, gitignored ground truth the capability matrix reads to
 * flip `liveVerified` for a provider (see `capability-matrix.ts`). A record carries ONLY:
 *   provider id · the opaque proof-run id · a boolean · an optional percent NUMBER · an ISO timestamp ·
 *   an optional honest reason string.
 * It NEVER holds a provider key, a prompt/response, or any request/response content, the type is the
 * structural guarantee (there is no field that can carry content or a credential). Local-only under
 * `<cwd>/.compaction/gateway/` (the same gitignored dir as receipts).
 */
import { readFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_GATEWAY_RECEIPTS_DIR } from "./receipt.js";
import { LIVE_VERIFIED_REASON, type ProviderLiveVerification } from "./capability-matrix.js";

/** The local-only, gitignored verification-results file (JSONL: one content-free result per line). */
export const GATEWAY_VERIFICATIONS_FILE = "verifications.jsonl";

/**
 * ONE content-free live-verification result. `verified` is true ONLY when a real provider-reported cache was
 * observed and a fresh-input reduction was derivable (never fabricated). `fresh_input_reduction_percent` is
 * present ONLY on a passing result; `reason` is present on a failing result (the honest why).
 */
/**
 * The OPTIONAL content-free provider-priced API cost impact (Route B / api-billing), attached ONLY when a
 * live verification's paired receipts carry provider-reported usage AND the model is in the explicit price
 * table. It is NUMBERS + a version string + enum LABELS only, NO key, NO content. It is an ESTIMATE basis
 * (`provider-usage-and-published-price`), NEVER invoice-confirmed. Absent when not computable (never a
 * fabricated zero).
 */
export interface ProviderPricedCostImpact {
  baseline_usd: number;
  warm_usd: number;
  /** baseline − warm (positive = warm cost less). */
  delta_usd: number;
  delta_pct: number;
  /** The pinned price-table version the figure was computed against (estimate basis). */
  pricing_version: string;
  cost_basis: "provider-usage-and-published-price";
  proof_level: "provider-priced-api";
}

export interface GatewayCacheVerification {
  provider: string;
  /** The opaque client-set proof-run id that paired the two receipts (a grouping label, not content). */
  proof_run_id: string;
  verified: boolean;
  /** Provider-reported fresh/billed input reduction percent, ONLY on a passing result. */
  fresh_input_reduction_percent?: number;
  /** ISO timestamp the verification was recorded. */
  observed_at: string;
  /** Honest reason a verification did NOT pass (present on a failing result; never a fabricated success). */
  reason?: string;
  /**
   * OPTIONAL content-free provider-priced API cost impact (Route B). Present ONLY when the paired receipts
   * carried provider usage + a priced model; an ESTIMATE basis, NEVER invoice-confirmed. Numbers + a version
   * string + labels only, no key, no content.
   */
  provider_priced_cost_impact?: ProviderPricedCostImpact;
}

function verificationsPath(cwd: string): string {
  return path.join(cwd, DEFAULT_GATEWAY_RECEIPTS_DIR, GATEWAY_VERIFICATIONS_FILE);
}

/** Append ONE content-free verification result to the local-only JSONL store. Returns the file path. */
export function writeVerification(rec: GatewayCacheVerification, cwd: string = process.cwd()): string {
  const dir = path.join(cwd, DEFAULT_GATEWAY_RECEIPTS_DIR);
  mkdirSync(dir, { recursive: true });
  const file = verificationsPath(cwd);
  appendFileSync(file, `${JSON.stringify(rec)}\n`, "utf8");
  return file;
}

/** Read every content-free verification result (each line is a GatewayCacheVerification). Never throws. */
export function readVerifications(cwd: string = process.cwd()): GatewayCacheVerification[] {
  const p = verificationsPath(cwd);
  if (!existsSync(p)) return [];
  try {
    return p
      ? readFileSync(p, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l) as GatewayCacheVerification)
      : [];
  } catch {
    return [];
  }
}

/** The LATEST recorded verification for a provider (by observed_at), or undefined if none. Pure over input. */
export function latestVerification(
  provider: string,
  cwd: string = process.cwd()
): GatewayCacheVerification | undefined {
  const matching = readVerifications(cwd).filter((v) => v.provider === provider);
  if (matching.length === 0) return undefined;
  return matching.reduce((a, b) => (b.observed_at >= a.observed_at ? b : a));
}

/**
 * Map the stored results into the PURE per-provider live-verification input the capability matrix consumes.
 * A provider is `liveVerified:true` ONLY when its LATEST record passed - a later failing run correctly
 * un-verifies it. This is the IO seam; `computeCapabilityMatrix` itself stays pure (it just receives this).
 */
export function liveVerificationsForMatrix(cwd: string = process.cwd()): ProviderLiveVerification[] {
  const byProvider = new Map<string, GatewayCacheVerification>();
  for (const v of readVerifications(cwd)) {
    const cur = byProvider.get(v.provider);
    if (!cur || v.observed_at >= cur.observed_at) byProvider.set(v.provider, v);
  }
  return [...byProvider.values()].map((v) => ({
    providerId: v.provider,
    liveVerified: v.verified === true,
    ...(v.verified ? { note: LIVE_VERIFIED_REASON } : {})
  }));
}
