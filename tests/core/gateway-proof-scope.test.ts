import { describe, it, expect } from "vitest";
import {
  computeCapabilityMatrix,
  capabilityForWorkflow,
  type WorkflowKey,
  type WorkflowProviderCapability
} from "../../src/core/gateway/capability-matrix.js";
import {
  deriveProofScope,
  deriveProofScopes,
  UNREACHABLE_BY_DEFAULT_PROOF_LEVELS,
  UNREACHABLE_BY_DEFAULT_COST_BASES,
  UNREACHABLE_BY_DEFAULT_BILLING_SOURCES,
  DEFAULT_REACHABLE_PROOF_LEVELS,
  type ProofScope
} from "../../src/core/gateway/proof-scope.js";

/**
 * PROOF-SCOPE typed schema, ANTI-COLLAPSE.
 * These tests pin: (1) each workflow derives the right authMode / economicRoute /
 * appliesTo / proofLevel; (2) plan-auth workflows are ALWAYS Route A (`plan-lifetime`) with
 * `planLifetimeImpact: "not-directly-observable"` + a reason; Cursor is `local-estimate`; Codex/Claude Code
 * activity rows are `provider-reported`; (3) Route A and Route B never collapse, a plan-lifetime scope can
 * never be provider-priced/plan-quota/invoice, an api-billing scope can never be plan-quota/plan-lifetime;
 * (4) `invoice-confirmed` + `plan-quota-observed` are unreachable by default; (5) every `unavailable` /
 * `not-directly-observable` carries a non-empty reason; (6) the whole model is content-free. Pure, derived
 * from the computed capability matrix (fixtures only, no live provider calls).
 */

function matrix(): WorkflowProviderCapability[] {
  return computeCapabilityMatrix();
}

function scopesFor(workflow: WorkflowKey): ProofScope[] {
  const row = capabilityForWorkflow(matrix(), workflow);
  if (!row) throw new Error(`no capability row for ${workflow}`);
  return deriveProofScope(row);
}

function planLifetime(scopes: ProofScope[]): ProofScope | undefined {
  return scopes.find((s) => s.economicRoute === "plan-lifetime");
}
function apiBilling(scopes: ProofScope[]): ProofScope | undefined {
  return scopes.find((s) => s.economicRoute === "api-billing");
}

describe("plan-auth workflows derive a plan-lifetime (Route A) scope", () => {
  it("Codex and Claude Code plan-lifetime scopes are plan-auth + provider-reported + not-directly-observable", () => {
    for (const wf of ["codex", "claude-code"] as const) {
      const pl = planLifetime(scopesFor(wf));
      expect(pl, `${wf} plan-lifetime scope`).toBeDefined();
      expect(pl!.authMode).toBe("plan-auth");
      expect(pl!.economicRoute).toBe("plan-lifetime");
      expect(pl!.appliesTo).toBe(wf);
      expect(pl!.proofLevel).toBe("provider-reported");
      expect(pl!.planLifetimeImpact).toBe("not-directly-observable");
      expect(pl!.reason && pl!.reason.trim().length).toBeGreaterThan(0);
    }
  });

  it("Cursor plan-lifetime scope is local-estimate (Compaction parser gap) but still plan-lifetime + not-directly-observable", () => {
    const pl = planLifetime(scopesFor("cursor"));
    expect(pl).toBeDefined();
    expect(pl!.authMode).toBe("plan-auth");
    expect(pl!.economicRoute).toBe("plan-lifetime");
    expect(pl!.appliesTo).toBe("cursor");
    expect(pl!.proofLevel).toBe("local-estimate");
    expect(pl!.costBasis).toBe("local-price-table");
    expect(pl!.billingSource).toBe("estimated-from-tokens");
    expect(pl!.planLifetimeImpact).toBe("not-directly-observable");
    expect(pl!.reason && pl!.reason.trim().length).toBeGreaterThan(0);
  });

  it("plan-lifetime impact is NEVER `likely-extended` by default (needs observed reduction)", () => {
    for (const pl of deriveProofScopes(matrix()).filter((s) => s.economicRoute === "plan-lifetime")) {
      expect(pl.planLifetimeImpact).not.toBe("likely-extended");
      expect(pl.planLifetimeImpact).toBe("not-directly-observable");
    }
  });
});

describe("routed provider-API path derives an api-billing (Route B) scope", () => {
  it("the custom OpenAI-compatible app yields ONLY an api-billing scope (not plan-auth)", () => {
    const scopes = scopesFor("custom-openai-app");
    expect(planLifetime(scopes)).toBeUndefined();
    const ab = apiBilling(scopes);
    expect(ab).toBeDefined();
    expect(ab!.authMode).toBe("api-key-gateway");
    expect(ab!.economicRoute).toBe("api-billing");
    expect(ab!.appliesTo).toBe("custom-openai-app");
    expect(ab!.proofLevel).toBe("provider-priced-api");
    expect(ab!.costBasis).toBe("provider-usage-and-published-price");
    expect(ab!.billingSource).toBe("provider-priced-api");
    // No plan-lifetime story on the api-billing route - explicitly unavailable with a reason.
    expect(ab!.planLifetimeImpact).toBe("unavailable");
    expect(ab!.reason && ab!.reason.trim().length).toBeGreaterThan(0);
  });

  it("an api-billing scope is present exactly where the row is cacheProofSupported", () => {
    for (const row of matrix()) {
      const ab = apiBilling(deriveProofScope(row));
      expect(Boolean(ab), `api-billing scope for ${row.workflow}`).toBe(row.cacheProofSupported);
    }
  });
});

describe("ANTI-COLLAPSE: Route A and Route B are structurally separate", () => {
  const all = deriveProofScopes(matrix());

  it("a plan-lifetime scope can NEVER be provider-priced-api / plan-quota-observed / invoice-confirmed", () => {
    for (const s of all.filter((x) => x.economicRoute === "plan-lifetime")) {
      expect(s.proofLevel).not.toBe("provider-priced-api");
      expect(s.proofLevel).not.toBe("plan-quota-observed");
      expect(s.proofLevel).not.toBe("invoice-confirmed");
      expect(s.costBasis).not.toBe("provider-usage-and-published-price");
      expect(s.costBasis).not.toBe("observed-plan-quota");
      expect(s.costBasis).not.toBe("invoice-reconciled");
      expect(s.billingSource).not.toBe("provider-priced-api");
      expect(s.billingSource).not.toBe("observed-plan-quota");
      expect(s.billingSource).not.toBe("invoice-confirmed");
      expect(s.authMode).toBe("plan-auth");
    }
  });

  it("an api-billing scope can NEVER be plan-quota-observed and NEVER imply plan-lifetime", () => {
    for (const s of all.filter((x) => x.economicRoute === "api-billing")) {
      expect(s.economicRoute).not.toBe("plan-lifetime");
      expect(s.proofLevel).not.toBe("plan-quota-observed");
      expect(s.costBasis).not.toBe("observed-plan-quota");
      expect(s.billingSource).not.toBe("observed-plan-quota");
      // The api-billing route carries no plan-lifetime extension by default.
      expect(s.planLifetimeImpact).not.toBe("likely-extended");
      expect(s.authMode).toBe("api-key-gateway");
    }
  });

  it("every scope has exactly one of the two economic routes, never both", () => {
    for (const s of all) {
      expect(["plan-lifetime", "api-billing"]).toContain(s.economicRoute);
    }
  });
});

describe("invoice-confirmed and plan-quota-observed are unreachable by default", () => {
  const all = deriveProofScopes(matrix());

  it("no derived scope carries a quota/invoice proof level, cost basis, or billing source", () => {
    for (const s of all) {
      expect(UNREACHABLE_BY_DEFAULT_PROOF_LEVELS).not.toContain(s.proofLevel);
      expect(UNREACHABLE_BY_DEFAULT_COST_BASES).not.toContain(s.costBasis);
      expect(UNREACHABLE_BY_DEFAULT_BILLING_SOURCES).not.toContain(s.billingSource);
    }
  });

  it("every derived proof level is in the default-reachable set (quota/invoice excluded)", () => {
    for (const s of all) {
      expect(DEFAULT_REACHABLE_PROOF_LEVELS).toContain(s.proofLevel);
    }
    // The unreachable levels are genuinely defined (guard is not vacuous).
    expect(UNREACHABLE_BY_DEFAULT_PROOF_LEVELS).toEqual(["plan-quota-observed", "invoice-confirmed"]);
  });
});

describe("honesty: every unavailable / not-directly-observable level carries a non-empty reason", () => {
  it("holds for all derived scopes", () => {
    for (const s of deriveProofScopes(matrix())) {
      const needsReason =
        s.planLifetimeImpact === "unavailable" ||
        s.planLifetimeImpact === "not-directly-observable" ||
        s.costBasis === "unavailable" ||
        s.billingSource === "unavailable";
      if (needsReason) {
        expect(s.reason, `reason for ${s.workflow}/${s.economicRoute}`).toBeDefined();
        expect(s.reason!.trim().length).toBeGreaterThan(0);
      }
    }
  });
});

describe("content-free by construction", () => {
  it("serialized scopes carry only enums/labels/reasons - no content, no keys", () => {
    const serialized = JSON.stringify(deriveProofScopes(matrix()));
    // No credential-shaped or content-shaped fields.
    for (const banned of ["apiKey", "api_key", "prompt", "response", "messages", "authorization", "Bearer ", "sk-"]) {
      expect(serialized.toLowerCase()).not.toContain(banned.toLowerCase());
    }
    // The only object keys present are the known ProofScope keys.
    const allowedKeys = new Set([
      "workflow",
      "workflowDisplayName",
      "authMode",
      "economicRoute",
      "appliesTo",
      "proofLevel",
      "costBasis",
      "billingSource",
      "planLifetimeImpact",
      "reason"
    ]);
    for (const s of deriveProofScopes(matrix())) {
      for (const key of Object.keys(s)) {
        expect(allowedKeys.has(key), `unexpected key ${key}`).toBe(true);
      }
    }
  });

  it("makes no billing-confirmed / cost-savings / output-token / semantic / all-provider claim", () => {
    const serialized = JSON.stringify(deriveProofScopes(matrix())).toLowerCase();
    for (const banned of ["billing-confirmed", "invoice-confirmed", "saves ", "savings", "output-token", "% cheaper", "guaranteed"]) {
      expect(serialized).not.toContain(banned);
    }
  });
});
