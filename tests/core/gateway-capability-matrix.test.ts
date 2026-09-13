import { describe, it, expect } from "vitest";
import {
  ADAPTERS,
  openAiAdapter,
  type ProviderAdapter
} from "../../src/core/gateway/provider-adapter.js";
import { mistralAdapter } from "../../src/core/gateway/provider-adapters-multi.js";
import {
  buildCapabilityRow,
  capabilityForWorkflow,
  computeCapabilityMatrix,
  deriveProviderCapabilities,
  LIVE_UNVERIFIED_REASON,
  REASONED_CAPABILITY_FIELDS,
  WORKFLOW_ROUTING,
  type ProviderCapability,
  type WorkflowProviderCapability
} from "../../src/core/gateway/capability-matrix.js";

/**
 * Capability matrix, ANTI-OVERCLAIM: the matrix must be GENERATED from the adapter registry + honest
 * workflow routing descriptors, NEVER a hardcoded optimism table. These tests pin the honesty
 * boundaries: Mistral has no cache
 * field (cache proof structurally unavailable); Claude Code is activity-only; Cursor is local-estimate; the
 * custom OpenAI-compatible app + OpenAI is cache-proof-SUPPORTED but NOT live-verified; Codex is routed
 * by its normal saved-login shim; `liveVerified` is false everywhere; every false capability carries a reason; the whole
 * model is content-free; and it is generated from `ADAPTERS` (remove an adapter → its rows decay). Pure -
 * fixtures only, no live provider calls.
 */

function mistral(matrix: WorkflowProviderCapability[]): WorkflowProviderCapability | undefined {
  return matrix.find((r) => r.providerId === "mistral");
}

function providerCap(caps: ProviderCapability[], id: string): ProviderCapability {
  const c = caps.find((p) => p.providerId === id);
  if (!c) throw new Error(`provider capability ${id} not found`);
  return c;
}

/** A synthetic routing that routes a workflow to a chosen provider - proves the routing→provider rule. */
function routingTo(provider: string) {
  return {
    workflow: "custom-openai-app" as const,
    displayName: "Synthetic routed app",
    gatewayRoutable: true as const,
    defaultProvider: provider,
    installable: false,
    planAuthReady: false,
    planAuthNote: "synthetic routed test workflow - not a plan-auth CLI workflow",
    activityOnly: false,
    localEstimateOnly: false,
    routingNote: "synthetic routed test workflow"
  };
}

describe("provider capabilities are derived from the adapter registry (not hardcoded)", () => {
  it("marks every registered adapter usageNormalized and liveVerified:false with a reason", () => {
    const caps = deriveProviderCapabilities();
    expect(caps.map((c) => c.providerId).sort()).toEqual(["anthropic", "gemini", "mistral", "openai"]);
    for (const c of caps) {
      expect(c.usageNormalized).toBe(true);
      expect(c.liveVerified).toBe(false);
      expect(c.liveUnverifiedReason).toBe(LIVE_UNVERIFIED_REASON);
      expect(c.liveUnverifiedReason.length).toBeGreaterThan(0);
    }
  });

  it("derives cacheNormalized from each adapter's own capabilities descriptor (adapter truth)", () => {
    const caps = deriveProviderCapabilities();
    expect(providerCap(caps, "openai").cacheNormalized).toBe(openAiAdapter.capabilities.reportsCacheHitField);
    expect(providerCap(caps, "mistral").cacheNormalized).toBe(mistralAdapter.capabilities.reportsCacheHitField);
    // OpenAI/Anthropic/Gemini normalize a cache-hit field; Mistral does not.
    expect(providerCap(caps, "openai").cacheNormalized).toBe(true);
    expect(providerCap(caps, "anthropic").cacheNormalized).toBe(true);
    expect(providerCap(caps, "gemini").cacheNormalized).toBe(true);
    expect(providerCap(caps, "mistral").cacheNormalized).toBe(false);
  });
});

describe("test 7 - Mistral: no cache field, so cannot render cache-proof-supported", () => {
  it("Mistral cacheNormalized is false with an honest reason", () => {
    const caps = deriveProviderCapabilities();
    const m = providerCap(caps, "mistral");
    expect(m.cacheNormalized).toBe(false);
    expect(m.cacheUnavailableReason && m.cacheUnavailableReason.length).toBeTruthy();
  });

  it("any workflow routing to Mistral is cacheProofSupported:false with a reason (even when routed)", () => {
    const caps = deriveProviderCapabilities();
    const row = buildCapabilityRow(routingTo("mistral"), providerCap(caps, "mistral"));
    // Routed + provider usage normalized, but NO cache field → cache proof structurally unavailable.
    expect(row.gatewayRoutable).toBe(true);
    expect(row.providerSupported).toBe(true);
    expect(row.canShowProviderReportedUsage).toBe(true);
    expect(row.cacheProofSupported).toBe(false);
    expect(row.canShowProviderReportedCacheTokens).toBe(false);
    expect(row.reasons.cacheProofSupported).toBe(caps.find((p) => p.providerId === "mistral")!.cacheUnavailableReason);
    expect(row.labels).not.toContain("cache-proof-supported");
  });
});

describe("Claude Code - activity-only, not routable", () => {
  it("is gatewayRoutable:false, activityOnly:true, cacheProofSupported:false with reasons", () => {
    const row = capabilityForWorkflow(computeCapabilityMatrix(), "claude-code")!;
    expect(row.gatewayRoutable).toBe(false);
    expect(row.activityOnly).toBe(true);
    expect(row.cacheProofSupported).toBe(false);
    expect(row.providerSupported).toBe(false);
    expect(row.canShowProviderReportedUsage).toBe(false);
    expect(row.reasons.cacheProofSupported.length).toBeGreaterThan(0);
    expect(row.labels).toEqual(["activity-only"]);
  });
});

describe("Cursor - local-estimate only", () => {
  it("is localEstimateOnly:true, cacheProofSupported:false with reasons", () => {
    const row = capabilityForWorkflow(computeCapabilityMatrix(), "cursor")!;
    expect(row.localEstimateOnly).toBe(true);
    expect(row.gatewayRoutable).toBe(false);
    expect(row.cacheProofSupported).toBe(false);
    expect(row.reasons.cacheProofSupported.length).toBeGreaterThan(0);
    expect(row.labels).toEqual(["local-estimate"]);
  });
});

describe("Cursor - NO live gateway apply", () => {
  // Cursor is plan-auth-ready + installable, but it does NOT route provider traffic through the Gateway
  // (vendor gap), so the deterministic apply-with-approval path CANNOT run live for Cursor. This guards
  // against ever falsely marking Cursor as having live gateway apply. The offline local trace estimate is
  // a SEPARATE thing and is NOT the same as live-workflow gateway apply.
  it("cursor is NOT gateway-routable and has NO live apply-with-approval path, with an honest reason", () => {
    const row = capabilityForWorkflow(computeCapabilityMatrix(), "cursor")!;
    // Live gateway apply requires routing through the Gateway - Cursor does not route.
    expect(row.gatewayRoutable).toBe(false);
    expect(row.contextOptimizeWithApprovalSupported).toBe(false);
    expect(row.reasons.contextOptimizeWithApprovalSupported.length).toBeGreaterThan(0);
    // Cursor stays plan-auth-ready + installable (its limitation is cache proof / live apply, NOT the workflow).
    expect(row.installable).toBe(true);
    expect(row.planAuthReady).toBe(true);
    // It carries NO cache-proof-supported / gateway-routable label (so no surface can imply live apply).
    expect(row.labels).not.toContain("gateway-routable");
    expect(row.labels).not.toContain("cache-proof-supported");
  });

  it("NO workflow that is not gateway-routable is ever marked contextOptimizeWithApprovalSupported (live apply)", () => {
    for (const row of computeCapabilityMatrix()) {
      if (row.gatewayRoutable !== true) {
        expect(row.contextOptimizeWithApprovalSupported, `${row.workflow} must not claim live apply without routing`).toBe(false);
      }
    }
  });
});

describe("custom OpenAI-compatible app + OpenAI - supported but NOT live-proven", () => {
  it("is gatewayRoutable:true, cacheProofSupported:true, yet liveVerified:false with a reason", () => {
    const row = capabilityForWorkflow(computeCapabilityMatrix(), "custom-openai-app")!;
    expect(row.gatewayRoutable).toBe(true);
    expect(row.providerId).toBe("openai");
    expect(row.providerSupported).toBe(true);
    expect(row.canRecordUsage).toBe(true);
    expect(row.canShowProviderReportedUsage).toBe(true);
    expect(row.canShowProviderReportedCacheTokens).toBe(true);
    expect(row.canDeriveFreshInputReduction).toBe(true);
    expect(row.cacheProofSupported).toBe(true);
    expect(row.contextOptimizeWithApprovalSupported).toBe(true);
    // Supported ≠ live-proven: liveVerified is false with a reason even where everything else is true.
    expect(row.liveVerified).toBe(false);
    expect(row.reasons.liveVerified).toBe(LIVE_UNVERIFIED_REASON);
    expect(row.labels).toEqual(["gateway-routable", "provider-reported", "cache-proof-supported"]);
  });
});

describe("Codex - normal saved-login shim route", () => {
  it("is gateway-routable by default without becoming activity-only or claiming live verification", () => {
    const row = capabilityForWorkflow(computeCapabilityMatrix(), "codex")!;
    expect(row.gatewayRoutable).toBe(true);
    expect(row.providerId).toBe("openai");
    expect(row.activityOnly).toBe(false);
    expect(row.canRecordUsage).toBe(true);
    expect(row.canShowProviderReportedUsage).toBe(true);
    expect(row.cacheProofSupported).toBe(true);
    expect(row.contextOptimizeWithApprovalSupported).toBe(true);
    expect(row.liveVerified).toBe(false);
    expect(row.routingNote).toMatch(/normal `codex` invocation.*existing ChatGPT login/i);
    expect(row.routingNote).not.toMatch(/capture\/activity|does NOT route|OPENAI_BASE_URL/);
  });
});

describe("plan-auth is the DEFAULT keyless path - separate from cache proof / live verification", () => {
  // detection/install/plan-auth need NO API key; a workflow is
  // NEVER unavailable merely because cache proof / live verification is not done.
  const CLI_WORKFLOWS = ["codex", "claude-code", "cursor"] as const;

  it("Codex/Claude Code/Cursor are detected + installable + planAuthReady with NO API key (liveVerified false)", () => {
    // No `verifications` supplied === no API-key live verification has run. Detection supplied via `found`.
    const matrix = computeCapabilityMatrix({ found: { codex: true, "claude-code": true, cursor: true } });
    for (const key of CLI_WORKFLOWS) {
      const row = capabilityForWorkflow(matrix, key)!;
      expect(row.workflowFound, `${key} detected`).toBe(true);
      expect(row.installable, `${key} installable`).toBe(true);
      expect(row.planAuthReady, `${key} planAuthReady`).toBe(true);
      expect(row.planAuthNote.length).toBeGreaterThan(0);
      // Only API-key live verification is blocked - NOT the workflow.
      expect(row.liveVerified, `${key} liveVerified`).toBe(false);
      // The row is NOT marked "unavailable" (that label only appears when a row has no other honest state).
      expect(row.labels, `${key} not unavailable`).not.toContain("unavailable");
    }
  });

  it("API-key/live verification being absent blocks ONLY liveVerified - plan-auth/installable are unaffected", () => {
    // Supply a PASSING openai record: it flips only the routed custom-app liveVerified, and touches NOTHING
    // about the CLI workflows' plan-auth/installable state (which are key-independent constants).
    const withRecord = computeCapabilityMatrix({ verifications: [{ providerId: "openai", liveVerified: true }] });
    const without = computeCapabilityMatrix();
    for (const key of CLI_WORKFLOWS) {
      const a = capabilityForWorkflow(withRecord, key)!;
      const b = capabilityForWorkflow(without, key)!;
      expect(a.planAuthReady).toBe(b.planAuthReady);
      expect(a.installable).toBe(b.installable);
      expect(a.planAuthReady).toBe(true);
      expect(a.installable).toBe(true);
    }
  });

  it("Cursor: cache proof honestly blocked by routing while Cursor stays installable + plan-auth-ready", () => {
    const row = capabilityForWorkflow(computeCapabilityMatrix(), "cursor")!;
    expect(row.installable).toBe(true);
    expect(row.planAuthReady).toBe(true);
    expect(row.cacheProofSupported).toBe(false);
    // The cache-proof reason reframes to being about CACHE PROOF, not the workflow being unavailable.
    expect(row.reasons.cacheProofSupported).toMatch(/cache proof is unavailable/i);
    expect(row.reasons.cacheProofSupported).toMatch(/workflow (itself )?is not unavailable/i);
    expect(row.reasons.cacheProofSupported).toMatch(/cannot be routed through the Gateway/);
    expect(row.reasons.cacheProofSupported).toMatch(/conditionally include result\.usage/);
    expect(row.reasons.cacheProofSupported).toMatch(/Compaction does not ingest or attribute/);
  });

  it("the custom OpenAI-compatible app is NOT a plan-auth workflow (routing path; no shim/hook)", () => {
    const row = capabilityForWorkflow(computeCapabilityMatrix(), "custom-openai-app")!;
    expect(row.planAuthReady).toBe(false);
    expect(row.installable).toBe(false);
    expect(row.planAuthNote.length).toBeGreaterThan(0);
  });

  it("planAuthNote never requests or stores an API key (keyless) for any workflow", () => {
    for (const row of computeCapabilityMatrix()) {
      // No `api-key`/`api_key`/`apikey` token; plan-auth is keyless by construction.
      expect(row.planAuthNote).not.toMatch(/api[_-]?key/i);
    }
  });
});

describe("liveVerified is false for ALL providers and rows this cycle", () => {
  it("no provider capability is live-verified", () => {
    for (const c of deriveProviderCapabilities()) expect(c.liveVerified).toBe(false);
  });
  it("no matrix row is live-verified", () => {
    for (const row of computeCapabilityMatrix()) {
      expect(row.liveVerified).toBe(false);
      expect(row.reasons.liveVerified).toBe(LIVE_UNVERIFIED_REASON);
    }
  });
});

describe("every false capability carries a non-empty reason (no bare false)", () => {
  it("each reasoned capability that is false has a reason; gatewayRoutable≠true has a note", () => {
    for (const row of computeCapabilityMatrix()) {
      for (const field of REASONED_CAPABILITY_FIELDS) {
        const value = row[field] as boolean;
        if (value === false) {
          expect(row.reasons[field], `${row.workflow}.${field}`).toBeTruthy();
          expect(row.reasons[field].length).toBeGreaterThan(0);
        }
      }
      if (row.gatewayRoutable !== true) {
        expect(row.reasons.gatewayRoutable, `${row.workflow}.gatewayRoutable`).toBeTruthy();
      }
    }
  });
});

describe("test 10 - content-free: only booleans, labels, and reason strings", () => {
  const allowedLabels = new Set([
    "provider-reported",
    "local-estimate",
    "unavailable",
    "activity-only",
    "gateway-routable",
    "cache-proof-supported"
  ]);

  it("serialized matrix carries no content/keys - only expected shapes", () => {
    const matrix = computeCapabilityMatrix();
    const serialized = JSON.stringify(matrix);
    // No credential-looking or content-looking substrings.
    expect(serialized).not.toMatch(/sk-[A-Za-z0-9]/);
    expect(serialized).not.toMatch(/api[_-]?key/i);
    expect(serialized.toLowerCase()).not.toContain("prompt_tokens\":"); // no raw provider body echoed

    const allowedTopKeys = new Set([
      "workflow",
      "workflowDisplayName",
      "providerId",
      "providerDisplayName",
      "workflowFound",
      "installable",
      "planAuthReady",
      "planAuthNote",
      "gatewayRoutable",
      "providerSupported",
      "canRecordUsage",
      "canShowProviderReportedUsage",
      "canShowProviderReportedCacheTokens",
      "canDeriveFreshInputReduction",
      "cacheProofSupported",
      "contextOptimizeWithApprovalSupported",
      "liveVerified",
      "localEstimateOnly",
      "activityOnly",
      "labels",
      "routingNote",
      "liveUnverifiedReason",
      "reasons"
    ]);
    for (const row of matrix) {
      for (const key of Object.keys(row)) expect(allowedTopKeys.has(key), key).toBe(true);
      for (const label of row.labels) expect(allowedLabels.has(label), label).toBe(true);
      // Every value is a boolean, a string label/reason, an array of labels, a string map, or the tri-state.
      for (const [key, value] of Object.entries(row)) {
        if (key === "labels") continue;
        if (key === "reasons") {
          for (const v of Object.values(value as Record<string, string>)) expect(typeof v).toBe("string");
          continue;
        }
        if (key === "gatewayRoutable") {
          expect(["boolean", "string"]).toContain(typeof value);
          continue;
        }
        expect(["boolean", "string", "undefined"]).toContain(typeof value);
      }
    }
  });
});

describe("test - the matrix is GENERATED from the adapter registry (not hardcoded)", () => {
  it("removing the OpenAI adapter decays the OpenAI-routed rows (cache proof no longer supported)", () => {
    const withoutOpenAi: ProviderAdapter[] = ADAPTERS.filter((a) => a.providerId !== "openai");
    const decayed = capabilityForWorkflow(computeCapabilityMatrix({ adapters: withoutOpenAi }), "custom-openai-app")!;
    // Baseline (full registry) is cache-proof-supported; without the adapter it MUST decay to false + reason.
    const baseline = capabilityForWorkflow(computeCapabilityMatrix(), "custom-openai-app")!;
    expect(baseline.cacheProofSupported).toBe(true);
    expect(decayed.providerSupported).toBe(false);
    expect(decayed.cacheProofSupported).toBe(false);
    expect(decayed.reasons.cacheProofSupported.length).toBeGreaterThan(0);
    expect(decayed.labels).not.toContain("cache-proof-supported");
  });

  it("dropping an adapter removes its provider capability row", () => {
    const withoutMistral = ADAPTERS.filter((a) => a.providerId !== "mistral");
    const caps = deriveProviderCapabilities(withoutMistral);
    expect(caps.find((c) => c.providerId === "mistral")).toBeUndefined();
  });
});

describe("optional caller detection stays machine-independent", () => {
  it("workflowFound is undefined by default and populated only from a found input", () => {
    const pure = computeCapabilityMatrix();
    for (const row of pure) expect(row.workflowFound).toBeUndefined();
    const withFound = capabilityForWorkflow(computeCapabilityMatrix({ found: { cursor: true } }), "cursor")!;
    expect(withFound.workflowFound).toBe(true);
  });
});

describe("workflow routing descriptors match the honest current integration", () => {
  it("exposes exactly the four workflows in the expected routing states", () => {
    const byKey = Object.fromEntries(WORKFLOW_ROUTING.map((r) => [r.workflow, r]));
    expect(byKey["custom-openai-app"].gatewayRoutable).toBe(true);
    expect(byKey["codex"].gatewayRoutable).toBe(true);
    expect(byKey["claude-code"].gatewayRoutable).toBe(false);
    expect(byKey["cursor"].gatewayRoutable).toBe(false);
    expect(byKey["mistral"]).toBeUndefined();
  });
});
