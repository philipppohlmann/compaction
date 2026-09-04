import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildApiExport,
  API_EXPORT_SCHEMA_VERSION,
  type ApiExportDocument
} from "../../src/core/api-export.js";
import { readReceipts } from "../../src/core/gateway/status.js";
import { summarizeCacheProof } from "../../src/core/gateway/cache-proof.js";
import { computeCapabilityMatrix } from "../../src/core/gateway/capability-matrix.js";
import { liveVerificationsForMatrix, writeVerification } from "../../src/core/gateway/verification-store.js";
import { appendActivityEvent, ACTIVITY_EVENT_ALLOWED_KEYS, readActivityEvents, DEFAULT_ACTIVITY_DIRECTORY } from "../../src/core/activity-store.js";
import { buildMeasureOnlyActivityEvent, computeActivityEventId, type ActivityEvent } from "../../src/core/activity-event.js";
import type { StandardCrossSurfaceEvent } from "../../src/core/cross-surface-event.js";
import { deriveProofScopes } from "../../src/core/gateway/proof-scope.js";
import { buildPlanLifetimeImpactsFromActivity } from "../../src/core/plan-lifetime.js";

/**
 * `buildApiExport`, the LOCAL, CONTENT-FREE dashboard-ingestion export. These tests
 * prove: (1) the document is assembled by REUSING the existing readers/summarizers (byte-equal to the CLI
 * surfaces, no divergence), (2) it is CONTENT-FREE (no prompt/response/key leaks, only typed schema fields),
 * (3) empty stores yield a valid empty-but-typed document (no crash).
 */

let cwd: string;
afterEach(() => {
  if (cwd) rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});
function tmp(): string {
  cwd = mkdtempSync(join(tmpdir(), "api-export-"));
  return cwd;
}

/** Write raw content-free receipts (as the gateway does, counts/labels only). */
function writeReceipts(dir: string, lines: object[]): void {
  const gw = join(dir, ".compaction", "gateway");
  mkdirSync(gw, { recursive: true });
  writeFileSync(gw + "/receipts.jsonl", lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
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

/** A valid metrics-only activity event (allowlisted / string-bounded / content-free). */
function seedActivity(dir: string, overrides: Partial<StandardCrossSurfaceEvent> = {}): Promise<unknown> {
  const base: StandardCrossSurfaceEvent = {
    surface: "cursor",
    provider: "cursor",
    model_label: "unknown",
    run_id: "cursor-1751600000001",
    token_source: {
      input: { source: "local-estimate" },
      output: { source: "unavailable", unavailable_reason: "no separable result field" }
    },
    input_before: 800,
    cost_source: "unavailable",
    cost_unavailable_reason: "Compaction does not ingest Cursor's conditional result.usage; no cost data is available",
    claim_scope: "run-scoped",
    ...overrides
  };
  const event = buildMeasureOnlyActivityEvent(base, { original_retained: true, location: "out/x.json" });
  return appendActivityEvent(event, join(dir, ".compaction", "activity"));
}

describe("buildApiExport - reuse (no divergence from the CLI surfaces)", () => {
  it("assembles the typed document from the existing readers/summarizers", async () => {
    const dir = tmp();
    writeReceipts(dir, [RECEIPT_A]);
    await seedActivity(dir);
    writeVerification(
      { provider: "openai", proof_run_id: "p-1", verified: true, fresh_input_reduction_percent: 40, observed_at: "2026-07-09T00:01:00.000Z" },
      dir
    );

    const doc = await buildApiExport(dir, { now: () => "2026-07-09T12:00:00.000Z" });

    expect(doc.schema_version).toBe(API_EXPORT_SCHEMA_VERSION);
    expect(API_EXPORT_SCHEMA_VERSION).toBe("2"); // v2: proof_scopes + plan_lifetime added.
    expect(doc.generated_at).toBe("2026-07-09T12:00:00.000Z");
    // cache_summary MUST equal the existing summarizer over the SAME receipts (proves no recomputation drift).
    expect(doc.cache_summary).toEqual(summarizeCacheProof(readReceipts(dir)));
    // capabilities MUST equal the SAME matrix call `gateway capabilities` makes (proves no divergence).
    const matrix = computeCapabilityMatrix({ verifications: liveVerificationsForMatrix(dir) });
    expect(doc.capabilities).toEqual(matrix);
    // proof_scopes MUST deep-equal the SAME deriver over the SAME matrix (no drift, no recomputation).
    expect(doc.proof_scopes).toEqual(deriveProofScopes(matrix));
    // plan_lifetime MUST deep-equal the SAME Route-A deriver over the SAME activity events (no drift).
    const { events } = await readActivityEvents(join(dir, DEFAULT_ACTIVITY_DIRECTORY));
    expect(doc.plan_lifetime).toEqual(buildPlanLifetimeImpactsFromActivity(events));
    // receipts / activity / verifications are the raw reader outputs.
    expect(doc.receipts).toEqual(readReceipts(dir));
    expect(doc.receipts).toHaveLength(1);
    expect(doc.activity).toHaveLength(1);
    expect(doc.verifications).toHaveLength(1);
    // gateway_status carries the reused rollup (not recomputed here).
    expect(doc.gateway_status.receiptsCount).toBe(1);
    expect(doc.gateway_status.summary).toEqual(doc.cache_summary);
    // A real verification flips liveVerified for the routed openai row (via the shared matrix path).
    const custom = doc.capabilities.find((c) => c.workflow === "custom-openai-app");
    expect(custom?.liveVerified).toBe(true);
  });

  it("empty stores → a valid, empty-but-typed document (no crash)", async () => {
    const dir = tmp();
    const doc = await buildApiExport(dir, { now: () => "2026-07-09T12:00:00.000Z" });
    expect(doc.schema_version).toBe(API_EXPORT_SCHEMA_VERSION);
    expect(doc.receipts).toEqual([]);
    expect(doc.activity).toEqual([]);
    expect(doc.verifications).toEqual([]);
    expect(doc.gateway_status.receiptsCount).toBe(0);
    expect(doc.cache_summary.requests).toEqual([]);
    // The capability matrix is always populated (generated from the adapter registry), never live-verified here.
    expect(doc.capabilities.length).toBeGreaterThan(0);
    expect(doc.capabilities.every((c) => c.liveVerified === false)).toBe(true);
    // v2: proof_scopes are derived from the (always-populated) matrix even with empty stores.
    expect(doc.proof_scopes.length).toBeGreaterThan(0);
    // v2: plan_lifetime ALWAYS has one honest record per plan-auth workflow (codex/claude-code/cursor),
    // even with no activity, the not-observable / unavailable default (never a fabricated count/quota).
    expect(doc.plan_lifetime.map((r) => r.workflow).sort()).toEqual(["claude-code", "codex", "cursor"]);
    for (const rec of doc.plan_lifetime) {
      expect(rec.plan_quota_signal).toBe("not-observable");
      expect(rec.plan_lifetime_impact).toBe("unavailable"); // no counts → unavailable, honest reason.
      expect(rec.reason && rec.reason.length).toBeGreaterThan(0);
    }
  });

  it("exports only the latest compatible cumulative Claude Stop snapshot", async () => {
    const dir = tmp();
    const snapshot = (input: number, output: number, recordedAt: string, final = false): ActivityEvent => {
      const base: ActivityEvent = {
        surface: "claude_code",
        provider: "anthropic",
        workflow_id: "claude-stop",
        session_id: `claude-session-${"a".repeat(32)}`,
        run_id: `claude-stop-${"b".repeat(32)}`,
        input_before: input,
        output_after: output,
        ...(final ? {} : { model_label: "claude-opus-5" }),
        token_source: {
          input: { source: final ? "local-estimate" : "provider-reported" },
          output: { source: "provider-reported" }
        },
        ...(final ? { apply_posture: "full" as const } : { policy_used: "output-shaping.v1.test", apply_posture: "basic" as const }),
        claim_scope: "run-scoped",
        evidence_level: "exact correlated gateway run",
        approval_status: "not-required",
        recovery: { original_retained: false },
        sync_status: "local-only",
        activity_kind: "claude-stop",
        recorded_at: recordedAt,
        run_started_at: "2026-07-09T00:00:00.000Z",
        measurement_source: "gateway-run"
      };
      return { ...base, activity_event_id: computeActivityEventId(base) };
    };
    await appendActivityEvent(
      snapshot(100, 20, "2026-07-09T00:01:00.000Z"),
      join(dir, DEFAULT_ACTIVITY_DIRECTORY)
    );
    await appendActivityEvent(
      snapshot(180, 35, "2026-07-09T00:02:00.000Z", true),
      join(dir, DEFAULT_ACTIVITY_DIRECTORY)
    );

    const doc = await buildApiExport(dir, { now: () => "2026-07-09T12:00:00.000Z" });
    expect(doc.activity).toHaveLength(1);
    expect(doc.activity[0]?.input_before).toBe(180);
    expect(doc.activity[0]?.output_after).toBe(35);
  });
});

describe("buildApiExport - Route A / Route B separation + provider-priced flow-through", () => {
  it("plan_lifetime carries no api-billing/plan-quota/invoice figure; proof_scopes keep the two routes apart", async () => {
    const dir = tmp();
    writeReceipts(dir, [RECEIPT_A]);
    await seedActivity(dir);
    const doc = await buildApiExport(dir, { now: () => "2026-07-09T12:00:00.000Z" });

    // Route A (plan_lifetime): plan-auth only, quota not-observable, no cost/billing/invoice field exists.
    for (const rec of doc.plan_lifetime) {
      expect(rec.auth_mode).toBe("plan-auth");
      expect(rec.plan_quota_signal).toBe("not-observable");
      // The type carries no provider-priced / invoice / cost axis, assert none leaked in as a stray key.
      expect(Object.keys(rec)).not.toContain("provider_priced_cost_impact");
      expect(Object.keys(rec)).not.toContain("invoice_confirmed");
    }

    // proof_scopes: plan-lifetime scopes never carry an api-billing proof level; api-billing scopes never
    // carry a plan-lifetime route or a plan-quota level (structural anti-collapse, surfaced in the export).
    for (const s of doc.proof_scopes) {
      if (s.economicRoute === "plan-lifetime") {
        expect(s.proofLevel).not.toBe("provider-priced-api");
        expect(s.costBasis).not.toBe("provider-usage-and-published-price");
        expect(["plan-quota-observed", "invoice-confirmed"]).not.toContain(s.proofLevel);
      }
      if (s.economicRoute === "api-billing") {
        expect(s.planLifetimeImpact).toBe("unavailable"); // not applicable on the metered route.
        expect(s.proofLevel).not.toBe("plan-quota-observed");
        expect(s.proofLevel).not.toBe("invoice-confirmed");
      }
    }
  });

  it("a verification's Route-B provider_priced_cost_impact flows through the export unchanged (never invoice-confirmed)", async () => {
    const dir = tmp();
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
    const impact = doc.verifications[0]?.provider_priced_cost_impact;
    expect(impact).toBeDefined();
    expect(impact?.delta_usd).toBe(0.008);
    expect(impact?.cost_basis).toBe("provider-usage-and-published-price");
    // Provider-priced is an ESTIMATE basis, the serialized export never claims invoice-confirmed anywhere.
    expect(JSON.stringify(doc)).not.toContain("invoice-confirmed");
    expect(JSON.stringify(doc)).not.toContain("invoice_confirmed");
  });
});

describe("buildApiExport - content-free guard", () => {
  // Fake marker per repo convention (keeps the no-committed-secrets scanner from tripping on this test file).
  const FAKE_SECRET = "FAKE-sk-live-0000-do-not-store";
  const FAKE_PROMPT = "fake-prompt-body-should-never-be-exported";

  it("a secret/prompt seeded in a NON-exported position never reaches the document", async () => {
    const dir = tmp();
    writeReceipts(dir, [RECEIPT_A]);
    await seedActivity(dir); // one VALID metrics-only event

    // Seed a fake secret + prompt in a NON-exported position: a raw activity line whose content-shaped keys
    // (`prompt`, `api_key`) are rejected by the metrics-only read-time validator → the whole line is SKIPPED,
    // so it can never surface in the export. This is the structural content-free guarantee under test.
    const activityLog = join(dir, ".compaction", "activity", "activity.jsonl");
    appendFileSync(
      activityLog,
      JSON.stringify({
        surface: "cli",
        activity_event_id: "leak-1",
        sync_status: "local-only",
        prompt: FAKE_PROMPT,
        api_key: FAKE_SECRET
      }) + "\n",
      "utf8"
    );

    const doc = await buildApiExport(dir, { now: () => "2026-07-09T12:00:00.000Z" });
    const serialized = JSON.stringify(doc);

    // 1. No forbidden content/key VALUE anywhere in the serialized document. (We assert the distinctive
    //    secret/prompt values, NOT bare "prompt", which legitimately appears in content-free COUNT field
    //    names like `prompt_input` / `promptInput`; those are labels, never content.)
    for (const forbidden of [FAKE_SECRET, FAKE_PROMPT, "sk-live", "do-not-store"]) {
      expect(serialized.includes(forbidden)).toBe(false);
    }

    // 2. The document emits NO field outside the typed schema (top-level key allow-list).
    const allowedDocKeys = new Set<keyof ApiExportDocument>([
      "schema_version",
      "generated_at",
      "gateway_status",
      "cache_summary",
      "receipts",
      "activity",
      "verifications",
      "capabilities",
      "proof_scopes",
      "plan_lifetime"
    ]);
    for (const key of Object.keys(doc)) {
      expect(allowedDocKeys.has(key as keyof ApiExportDocument)).toBe(true);
    }

    // 3. Every exported activity event carries only metrics-only allowlisted keys (no content-shaped key).
    for (const ev of doc.activity) {
      for (const key of Object.keys(ev)) {
        expect(ACTIVITY_EVENT_ALLOWED_KEYS.includes(key)).toBe(true);
      }
    }

    // 4. The valid event survived; only the content-carrying line was dropped.
    expect(doc.activity).toHaveLength(1);
  });
});
