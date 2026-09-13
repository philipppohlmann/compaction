import { describe, it, expect } from "vitest";
import {
  computeCapabilityMatrix,
  capabilityForWorkflow,
  LIVE_UNVERIFIED_REASON
} from "../../src/core/gateway/capability-matrix.js";
import {
  CAPABILITIES_LIVE_NOTE,
  formatCapabilityMatrix,
  formatCapabilityRow
} from "../../src/core/gateway/capability-view.js";

/**
 * Capability VIEW, anti-overclaim rendering.
 * The renderer must be a pure function of `computeCapabilityMatrix()`: it prints "cache proof: supported"
 * ONLY where the matrix says `cacheProofSupported:true` (always qualified live-unverified), prints the
 * matrix's own reason where false, and stays content-free + within the claim boundaries.
 */

describe("a cacheProofSupported:false row never shows supported and shows its reason", () => {
  it("Claude Code (activity-only) → not supported + reason, no cache-proof-supported label", () => {
    const row = capabilityForWorkflow(computeCapabilityMatrix(), "claude-code")!;
    const text = formatCapabilityRow(row).join("\n");
    expect(row.cacheProofSupported).toBe(false);
    expect(text).not.toMatch(/cache proof:\s*supported/);
    expect(text).toMatch(/cache proof:\s*not supported -/);
    // The row's OWN honest reason is rendered verbatim.
    expect(text).toContain(row.reasons.cacheProofSupported);
    expect(text).toContain("activity-only");
  });

  it("Cursor stays unsupported while Codex renders its normal Gateway route as supported but live-unverified", () => {
    const cursor = capabilityForWorkflow(computeCapabilityMatrix(), "cursor")!;
    const cursorText = formatCapabilityRow(cursor).join("\n");
    expect(cursor.cacheProofSupported).toBe(false);
    expect(cursorText).toMatch(/cache proof:\s*not supported -/);
    expect(cursorText).toContain(cursor.reasons.cacheProofSupported);
    // Honest labels are the row's own labels, not invented.
    expect(cursorText).toContain("local-estimate");

    const codex = capabilityForWorkflow(computeCapabilityMatrix(), "codex")!;
    const codexText = formatCapabilityRow(codex).join("\n");
    expect(codex.gatewayRoutable).toBe(true);
    expect(codex.cacheProofSupported).toBe(true);
    expect(codexText).toMatch(/routing:\s*gateway-routable/);
    expect(codexText).toMatch(/cache proof:\s*supported \(pipeline; live-unverified/);
  });
});

describe("a cacheProofSupported:true row is qualified live-unverified, never 'proven live'", () => {
  it("custom OpenAI-compatible app shows supported (pipeline; live-unverified), never proven/live-proven", () => {
    const row = capabilityForWorkflow(computeCapabilityMatrix(), "custom-openai-app")!;
    const text = formatCapabilityRow(row).join("\n");
    expect(row.cacheProofSupported).toBe(true);
    expect(row.liveVerified).toBe(false);
    expect(text).toMatch(/cache proof:\s*supported \(pipeline; live-unverified/);
    expect(text).not.toMatch(/proven|live-proven|verified live|ready live/i);
    expect(text).toContain("cache-proof-supported"); // the honest label from the matrix
  });
});

describe("plan-auth default - the surface reads READY via plan auth, cache proof optional (not key-required)", () => {
  it("every CLI workflow renders a plan-auth 'ready (default)' line and is not marked unavailable/key-required", () => {
    for (const key of ["codex", "claude-code", "cursor"] as const) {
      const row = capabilityForWorkflow(computeCapabilityMatrix(), key)!;
      const text = formatCapabilityRow(row).join("\n");
      expect(row.planAuthReady).toBe(true);
      expect(text).toMatch(/plan auth:\s*ready \(default\)/);
      expect(text).toContain("no API key");
      // The row is NOT presented as unavailable just because cache proof / live verification isn't done.
      expect(text).not.toMatch(/labels:.*\bunavailable\b/);
    }
  });

  it("the matrix block leads with the keyless plan-auth note (cache proof + live verification optional)", () => {
    const out = formatCapabilityMatrix(computeCapabilityMatrix());
    expect(out).toContain("Plan-auth (default)");
    expect(out).toContain("no API key requested or stored");
    expect(out).toMatch(/optional \(Advanced\)/);
  });
});

describe("the whole capability surface stays within the claim boundaries", () => {
  const out = formatCapabilityMatrix(computeCapabilityMatrix());

  it("carries the supported ≠ live-verified note and the live-unverified reason", () => {
    expect(out).toContain(CAPABILITIES_LIVE_NOTE);
    expect(out).toContain(LIVE_UNVERIFIED_REASON);
    expect(out).toMatch(/supported ≠ live-verified/);
  });

  it("makes no cost / billing / savings / output-token / semantic / live-proven claim", () => {
    expect(out).not.toMatch(/\bsaved\b|\bsavings\b|\$\d|\binvoice\b|\bbilling\b/i);
    expect(out).not.toMatch(/output[- ]token|semantic|proven live|live-proven|ready live|guaranteed/i);
    // "lower fresh input" must never be rendered as an ACHIEVED result on this surface.
    expect(out).not.toMatch(/lower fresh input|less fresh input|fresh input reduced/i);
  });
});

describe("content-free: no content or credentials in the rendered surface", () => {
  it("plain + JSON renderings carry no key/content-looking substrings", () => {
    const plain = formatCapabilityMatrix(computeCapabilityMatrix());
    const json = JSON.stringify(computeCapabilityMatrix());
    for (const s of [plain, json]) {
      expect(s).not.toMatch(/sk-[A-Za-z0-9]/);
      expect(s).not.toMatch(/api[_-]?key/i);
      expect(s.toLowerCase()).not.toContain("prompt_tokens\":");
    }
  });
});

describe("a live-verified row renders live-verified (only from real evidence)", () => {
  it("a passing openai verification renders 'supported (live-verified …)' for the custom-app row", () => {
    const verified = computeCapabilityMatrix({ verifications: [{ providerId: "openai", liveVerified: true }] });
    const row = capabilityForWorkflow(verified, "custom-openai-app")!;
    const text = formatCapabilityRow(row).join("\n");
    expect(row.liveVerified).toBe(true);
    expect(text).toMatch(/cache proof:\s*supported \(live-verified/);
    // Still no forbidden "proven live" phrasing.
    expect(text).not.toMatch(/proven live|live-proven|ready live/i);
  });

  it("with NO verification the same row stays live-unverified (default unchanged)", () => {
    const row = capabilityForWorkflow(computeCapabilityMatrix(), "custom-openai-app")!;
    expect(formatCapabilityRow(row).join("\n")).toMatch(/cache proof:\s*supported \(pipeline; live-unverified/);
  });
});

describe("the renderer is a pure function of the matrix (no duplicate capability logic)", () => {
  it("removing the OpenAI adapter decays the rendered custom-app row to not-supported", () => {
    const decayed = computeCapabilityMatrix({
      adapters: []
    });
    const row = capabilityForWorkflow(decayed, "custom-openai-app")!;
    const text = formatCapabilityRow(row).join("\n");
    // With no adapter the matrix marks it unsupported; the renderer follows without any of its own logic.
    expect(row.cacheProofSupported).toBe(false);
    expect(text).toMatch(/cache proof:\s*not supported -/);
  });
});
