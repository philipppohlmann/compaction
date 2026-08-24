import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeVerification,
  readVerifications,
  latestVerification,
  liveVerificationsForMatrix,
  type GatewayCacheVerification
} from "../../src/core/gateway/verification-store.js";
import {
  computeCapabilityMatrix,
  capabilityForWorkflow,
  LIVE_UNVERIFIED_REASON,
  LIVE_VERIFIED_REASON
} from "../../src/core/gateway/capability-matrix.js";

/**
 * Verification store + capability-matrix wiring. Proves: the store round-trips a
 * content-free result; `liveVerified` in the matrix is DERIVED from a passing record (never hardcoded true);
 * with NO record the matrix is byte-identical to before (false everywhere); an absent/failing record never
 * yields liveVerified:true. Pure/hermetic, a tmp cwd, no live calls.
 */

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "verify-store-"));
}

describe("verification store - content-free round-trip", () => {
  it("writes/reads only the allowed content-free fields and picks the latest per provider", () => {
    const cwd = tmp();
    try {
      const pass: GatewayCacheVerification = { provider: "openai", proof_run_id: "verify-openai-1", verified: true, fresh_input_reduction_percent: 75, observed_at: "2026-07-09T10:00:00.000Z" };
      const fail: GatewayCacheVerification = { provider: "anthropic", proof_run_id: "verify-anthropic-1", verified: false, observed_at: "2026-07-09T10:01:00.000Z", reason: "no provider-reported cache observed - live verification not confirmed" };
      writeVerification(pass, cwd);
      writeVerification(fail, cwd);
      const all = readVerifications(cwd);
      expect(all).toHaveLength(2);
      const allowed = new Set(["provider", "proof_run_id", "verified", "fresh_input_reduction_percent", "observed_at", "reason"]);
      for (const r of all) for (const k of Object.keys(r)) expect(allowed.has(k), k).toBe(true);
      expect(latestVerification("openai", cwd)!.verified).toBe(true);
      expect(latestVerification("gemini", cwd)).toBeUndefined();
    } finally {
      rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it("a later FAILING record un-verifies a provider (latest wins)", () => {
    const cwd = tmp();
    try {
      writeVerification({ provider: "openai", proof_run_id: "a", verified: true, fresh_input_reduction_percent: 40, observed_at: "2026-07-09T10:00:00.000Z" }, cwd);
      writeVerification({ provider: "openai", proof_run_id: "b", verified: false, observed_at: "2026-07-09T11:00:00.000Z", reason: "cache no longer observed" }, cwd);
      const forMatrix = liveVerificationsForMatrix(cwd);
      expect(forMatrix.find((v) => v.providerId === "openai")!.liveVerified).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
});

describe("capability matrix liveVerified is derived from real verification evidence (default false)", () => {
  it("with NO verifications, the matrix is byte-identical to today (false everywhere + reason)", () => {
    const bare = computeCapabilityMatrix();
    const explicitEmpty = computeCapabilityMatrix({ verifications: [] });
    expect(JSON.stringify(bare)).toBe(JSON.stringify(explicitEmpty));
    for (const row of bare) {
      expect(row.liveVerified).toBe(false);
      expect(row.reasons.liveVerified).toBe(LIVE_UNVERIFIED_REASON);
      expect(row.liveUnverifiedReason).toBe(LIVE_UNVERIFIED_REASON);
    }
  });

  it("with a PASSING openai record, the openai-routed row is liveVerified:true (no bare-false reason)", () => {
    const matrix = computeCapabilityMatrix({ verifications: [{ providerId: "openai", liveVerified: true, note: LIVE_VERIFIED_REASON }] });
    const row = capabilityForWorkflow(matrix, "custom-openai-app")!;
    expect(row.providerId).toBe("openai");
    expect(row.liveVerified).toBe(true);
    expect(row.reasons.liveVerified).toBeUndefined(); // reasons hold reasons for FALSE capabilities only
    expect(row.liveUnverifiedReason).toBe(LIVE_VERIFIED_REASON);
    // A non-openai / non-routed row is NOT flipped by an openai record.
    expect(capabilityForWorkflow(matrix, "claude-code")!.liveVerified).toBe(false);
    expect(capabilityForWorkflow(matrix, "cursor")!.liveVerified).toBe(false);
    // Codex routes to openai by DEFAULT but is only `if-configured` (not actually routed through the Gateway
    // by default), so a passing openai record must NOT flip its liveVerified, it has no cache-proof path yet.
    const codex = capabilityForWorkflow(matrix, "codex")!;
    expect(codex.liveVerified).toBe(false);
    expect(codex.reasons.liveVerified).toBe(LIVE_UNVERIFIED_REASON);
  });

  it("a FAILING (liveVerified:false) or ABSENT record never yields liveVerified:true", () => {
    const failing = computeCapabilityMatrix({ verifications: [{ providerId: "openai", liveVerified: false }] });
    expect(capabilityForWorkflow(failing, "custom-openai-app")!.liveVerified).toBe(false);
    const absent = computeCapabilityMatrix({ verifications: [{ providerId: "mistral", liveVerified: true }] });
    // A record for an unrelated provider never flips the openai row.
    expect(capabilityForWorkflow(absent, "custom-openai-app")!.liveVerified).toBe(false);
  });

  it("end-to-end via the store: a passing record on disk drives the matrix through liveVerificationsForMatrix", () => {
    const cwd = tmp();
    try {
      writeVerification({ provider: "openai", proof_run_id: "e2e", verified: true, fresh_input_reduction_percent: 60, observed_at: "2026-07-09T12:00:00.000Z" }, cwd);
      const matrix = computeCapabilityMatrix({ verifications: liveVerificationsForMatrix(cwd) });
      expect(capabilityForWorkflow(matrix, "custom-openai-app")!.liveVerified).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
});
