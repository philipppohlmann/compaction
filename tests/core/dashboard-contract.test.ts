import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  toDashboardContract,
  DASHBOARD_CONTRACT_VERSION,
  DASHBOARD_TIER_LIVE,
  DASHBOARD_TIER_ESTIMATED,
  DASHBOARD_INGESTION_NOTE
} from "../../src/core/dashboard-contract.js";
import { buildApiExport, type ApiExportDocument } from "../../src/core/api-export.js";
import { writeVerification } from "../../src/core/gateway/verification-store.js";

/**
 * The typed dashboard-contract adapter. Proves it is a PURE, label-preserving map:
 *  (1) it maps proof scopes onto the /app tiers WITHOUT upgrading a label (provider-priced CAPABILITY alone
 *      is `estimated`; only a REAL live-verified provider-priced scope is `live`);
 *  (2) it keeps Route A and Route B separate (economic route carried through unchanged);
 *  (3) it carries the Route-B provider-priced cost impact through unchanged, never invoice-confirmed;
 *  (4) it never reinterprets, every label comes from the source document.
 */

let cwd: string;
function tmp(): string {
  cwd = mkdtempSync(join(tmpdir(), "dash-contract-"));
  return cwd;
}
function cleanup(): void {
  if (cwd) rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

const RECEIPT_A = {
  receipt_id: "r-1",
  captured_at: "2026-07-09T00:00:00.000Z",
  provider: "openai",
  model: "gpt-4o-mini",
  endpoint: "/v1/chat/completions",
  mode: "record",
  upstream_status: 200,
  model_visible_bytes_changed: false,
  tokens: { prompt_input: 1000, cached_input: 400, billed_fresh_input: 600, output: 20 },
  fresh_billed_input_reduction: { available: true, pct: 40, note: "provider-reported" },
  token_source: "provider-reported",
  cache_source: "provider-reported",
  cost_source: "unavailable",
  reasons: { cost: "provider reports tokens, not billing" },
  claim_scope: "run-scoped",
  approval_status: "not-required",
  sync_status: "local-only",
  content_uploaded: false,
  label: "content-free receipt"
};

function writeReceipts(dir: string, lines: object[]): void {
  const gw = join(dir, ".compaction", "gateway");
  mkdirSync(gw, { recursive: true });
  writeFileSync(gw + "/receipts.jsonl", lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
}

describe("toDashboardContract - pure, label-preserving map to /app tiers", () => {
  it("carries schema + contract version, the ingestion note, and every scope's economic route unchanged", async () => {
    const dir = tmp();
    try {
      const doc = await buildApiExport(dir, { now: () => "2026-07-09T12:00:00.000Z" });
      const contract = toDashboardContract(doc);
      expect(contract.schema_version).toBe(doc.schema_version);
      expect(contract.contract_version).toBe(DASHBOARD_CONTRACT_VERSION);
      expect(contract.generated_at).toBe("2026-07-09T12:00:00.000Z");
      expect(contract.ingestion_note).toBe(DASHBOARD_INGESTION_NOTE);
      // Every scope row's economic route + honest labels are COPIED from the source scope (no reinterpretation).
      expect(contract.proof_scopes.length).toBe(doc.proof_scopes.length);
      for (let i = 0; i < doc.proof_scopes.length; i++) {
        const src = doc.proof_scopes[i];
        const row = contract.proof_scopes[i];
        expect(row.economicRoute).toBe(src.economicRoute);
        expect(row.proofLevel).toBe(src.proofLevel);
        expect(row.costBasis).toBe(src.costBasis);
        expect(row.billingSource).toBe(src.billingSource);
        expect(row.planLifetimeImpact).toBe(src.planLifetimeImpact);
      }
      // Route A records carried through unchanged.
      expect(contract.plan_lifetime).toEqual(doc.plan_lifetime);
    } finally {
      cleanup();
    }
  });

  it("provider-priced CAPABILITY without a live verification → `estimated`, NEVER `live`", async () => {
    const dir = tmp();
    try {
      writeReceipts(dir, [RECEIPT_A]);
      const doc = await buildApiExport(dir, { now: () => "2026-07-09T12:00:00.000Z" });
      // No verification recorded → custom-openai-app is NOT live-verified.
      expect(doc.capabilities.find((c) => c.workflow === "custom-openai-app")?.liveVerified).toBe(false);
      const contract = toDashboardContract(doc);
      const apiBilling = contract.proof_scopes.filter((r) => r.economicRoute === "api-billing");
      expect(apiBilling.length).toBeGreaterThan(0);
      for (const row of apiBilling) {
        expect(row.tier).toBe("estimated"); // capability alone is estimated, never upgraded to live.
        expect(row.tierLabel).toBe(DASHBOARD_TIER_ESTIMATED);
      }
    } finally {
      cleanup();
    }
  });

  it("a REAL live verification → the routed provider-priced scope maps to `live`, and its cost impact rides through", async () => {
    const dir = tmp();
    try {
      writeReceipts(dir, [RECEIPT_A]);
      writeVerification(
        {
          provider: "openai",
          proof_run_id: "p-1",
          verified: true,
          fresh_input_reduction_percent: 40,
          observed_at: "2026-07-09T00:01:00.000Z",
          provider_priced_cost_impact: {
            baseline_usd: 0.02,
            warm_usd: 0.012,
            delta_usd: 0.008,
            delta_pct: 40,
            pricing_version: "test-pricing-v1",
            cost_basis: "provider-usage-and-published-price",
            proof_level: "provider-priced-api"
          }
        },
        dir
      );
      const doc = await buildApiExport(dir, { now: () => "2026-07-09T12:00:00.000Z" });
      expect(doc.capabilities.find((c) => c.workflow === "custom-openai-app")?.liveVerified).toBe(true);
      const contract = toDashboardContract(doc);
      const custom = contract.proof_scopes.find((r) => r.workflow === "custom-openai-app");
      expect(custom?.tier).toBe("live");
      expect(custom?.tierLabel).toBe(DASHBOARD_TIER_LIVE);
      // Route-B provider-priced cost impact copied through unchanged (estimate basis, never invoice-confirmed).
      expect(custom?.providerPricedCostImpact?.delta_usd).toBe(0.008);
      expect(custom?.providerPricedCostImpact?.cost_basis).toBe("provider-usage-and-published-price");
    } finally {
      cleanup();
    }
  });

  it("Route A (plan-lifetime) scopes never receive a provider-priced cost impact or a live tier", async () => {
    const dir = tmp();
    try {
      const doc = await buildApiExport(dir, { now: () => "2026-07-09T12:00:00.000Z" });
      const contract = toDashboardContract(doc);
      for (const row of contract.proof_scopes.filter((r) => r.economicRoute === "plan-lifetime")) {
        expect(row.providerPricedCostImpact).toBeUndefined();
        expect(row.tier).not.toBe("live"); // plan-auth has no routed live cache-proof path.
      }
    } finally {
      cleanup();
    }
  });

  it("never emits an invoice-confirmed figure anywhere in the serialized contract", async () => {
    const dir = tmp();
    try {
      const doc: ApiExportDocument = await buildApiExport(dir, { now: () => "2026-07-09T12:00:00.000Z" });
      const serialized = JSON.stringify(toDashboardContract(doc));
      // No invoice-confirmed FIGURE/LABEL VALUE is emitted. (The ingestion note carries the honest negation
      // "...no figure is invoice-confirmed", the same allowed pattern as the source-status contract's
      // "never billing-confirmed"; so we forbid the string only as a JSON VALUE, not inside prose.)
      expect(serialized).not.toContain(':"invoice-confirmed"');
      expect(serialized).not.toContain(':"invoice_confirmed"');
    } finally {
      cleanup();
    }
  });
});
