import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  LCM_EVIDENCE_CONTRACT_VERSION,
  LCM_EVIDENCE_DIMENSIONS,
  LcmEvidenceContractViolation,
  scanContentFreeLcmEvidence,
  toContentFreeLcmEvidence,
  type LcmEvidenceProjectionInput
} from "../../src/core/lcm-evidence-contract.js";

const CONTRACT_SOURCE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../src/core/lcm-evidence-contract.ts"
);

function projectionInput(): LcmEvidenceProjectionInput {
  return {
    input: {
      workflow: "claude-code",
      provider: "openai-compatible",
      model: "gpt-x",
      endpoint: "/v1/responses",
      traceSource: "real-local",
      deterministicPolicyVersion: "dedupe-v1",
      lcmCandidateVersion: "lcm-0.0.1",
      evalProfileVersion: "2026-07-12.1"
    },
    candidate: { kind: "lcm-candidate", generationStatus: "generated" },
    evidence: {
      inputTokensBefore: 10_000,
      tokensAfter: 2_000,
      absoluteReduction: 8_000,
      reductionPercent: 80,
      modelVisibleByteDelta: -32_000,
      sectionsRetained: ["system", "recent-turns"],
      sectionsRemoved: ["stale-tool-output"],
      stateCapsuleRefs: ["capsule-1"],
      sourcePointerCoverage: 1,
      commitmentCoverage: 0.98,
      instructionCoverage: 1,
      blockerCoverage: 1,
      recoveryPointer: "recovery/req-1",
      generationLatencyMs: 400,
      inferenceCostEstimateUsd: 0.003,
      evidenceSource: "real-local"
    },
    evaluation: {
      dimensions: { commitmentPreservation: "pass", recovery: "uncertain" },
      evaluatorType: "deterministic",
      promotionOutcome: "baseline_remains_default"
    },
    provenance: { traceSource: "real-local", evidenceSource: "real-local", liveVerified: true },
    workflowClassId: "claude-code/responses-string/dedupe-class-a"
  };
}

describe("public-contract cleanliness", () => {
  it("imports nothing - no engine edge, no runtime dependency", () => {
    const source = readFileSync(CONTRACT_SOURCE, "utf8");
    expect(source).not.toMatch(/from\s+["'][^"']*engine/);
    // Zero imports at all: the contract must stay dependency-light and engine-free.
    expect(source).not.toMatch(/^\s*import\s/m);
  });
});

describe("toContentFreeLcmEvidence", () => {
  it("projects to counts, labels, versions, and results only", () => {
    const doc = toContentFreeLcmEvidence(projectionInput());
    expect(doc.contract_version).toBe(LCM_EVIDENCE_CONTRACT_VERSION);
    expect(doc.workflowClassId).toBe("claude-code/responses-string/dedupe-class-a");
    expect(doc.counts).toEqual({
      inputTokensBefore: 10_000,
      tokensAfter: 2_000,
      absoluteReduction: 8_000,
      reductionPercent: 80,
      modelVisibleByteDelta: -32_000,
      sectionsRetainedCount: 2,
      sectionsRemovedCount: 1,
      stateCapsuleRefCount: 1
    });
    expect(doc.recoveryPointerPresent).toBe(true);
    expect(doc.liveVerified).toBe(true);
    // No section text, no pointers, no content-shaped field anywhere.
    const flat = JSON.stringify(doc);
    expect(flat).not.toContain("recent-turns");
    expect(flat).not.toContain("recovery/req-1");
  });

  it("fills unevaluated dimensions with not_computed and copies provided results", () => {
    const doc = toContentFreeLcmEvidence(projectionInput());
    expect(doc.dimensions.commitmentPreservation).toBe("pass");
    expect(doc.dimensions.recovery).toBe("uncertain");
    expect(doc.dimensions.continuationReplay).toBe("not_computed");
    expect(Object.keys(doc.dimensions).sort()).toEqual([...LCM_EVIDENCE_DIMENSIONS].sort());
  });

  it("a record with no evaluation is honest: all not_computed, insufficient_evidence", () => {
    const input = projectionInput();
    delete input.evaluation;
    const doc = toContentFreeLcmEvidence(input);
    expect(doc.dimensions.commitmentPreservation).toBe("not_computed");
    expect(doc.promotionOutcome).toBe("insufficient_evidence");
  });

  it("refuses an unknown dimension key instead of silently accepting it", () => {
    const input = projectionInput();
    input.evaluation!.dimensions["madeUpDimension"] = "pass";
    expect(() => toContentFreeLcmEvidence(input)).toThrow(LcmEvidenceContractViolation);
  });

  it("refuses fixture evidence claiming liveVerified: true (never downgrades silently)", () => {
    const input = projectionInput();
    input.input.traceSource = "synthetic-fixture";
    input.provenance = { traceSource: "synthetic-fixture", evidenceSource: "real-local", liveVerified: true };
    expect(() => toContentFreeLcmEvidence(input)).toThrow(/never live/);
  });

  it("fixture evidence projects with liveVerified: false", () => {
    const input = projectionInput();
    input.input.traceSource = "benchmark-fixture";
    input.evidence.evidenceSource = "benchmark-fixture";
    input.provenance = { traceSource: "benchmark-fixture", evidenceSource: "benchmark-fixture", liveVerified: false };
    const doc = toContentFreeLcmEvidence(input);
    expect(doc.traceSource).toBe("benchmark-fixture");
    expect(doc.liveVerified).toBe(false);
  });

  it("refuses provenance that does not mirror the input/evidence sources", () => {
    const input = projectionInput();
    input.provenance = { traceSource: "synthetic-fixture", evidenceSource: "real-local", liveVerified: false };
    expect(() => toContentFreeLcmEvidence(input)).toThrow(/mirror/);
  });

  it("refuses out-of-range and non-finite numbers", () => {
    const bad = projectionInput();
    bad.evidence.commitmentCoverage = 1.5;
    expect(() => toContentFreeLcmEvidence(bad)).toThrow(/\[0, 1\]/);

    const nan = projectionInput();
    nan.evidence.inputTokensBefore = Number.NaN;
    expect(() => toContentFreeLcmEvidence(nan)).toThrow(/finite/);
  });

  it("the projected document always passes its own content scanner", () => {
    const doc = toContentFreeLcmEvidence(projectionInput());
    expect(scanContentFreeLcmEvidence(doc)).toEqual({ ok: true });
  });
});

describe("scanContentFreeLcmEvidence", () => {
  it("rejects content-shaped keys wherever they hide", () => {
    for (const key of ["prompt", "response", "messages", "content", "candidateText", "source_text"]) {
      const scan = scanContentFreeLcmEvidence({ nested: [{ [key]: "anything" }] });
      expect(scan.ok).toBe(false);
      if (!scan.ok) expect(scan.reason).toBe("content_key");
    }
  });

  it("rejects credential-looking values without echoing them", () => {
    const scan = scanContentFreeLcmEvidence({
      label: "sk-FAKE0000000000000000000000" // FAKE_MARKER: fake, non-functional pattern
    });
    expect(scan.ok).toBe(false);
    if (!scan.ok) {
      expect(scan.reason).toBe("content_value");
      expect(JSON.stringify(scan)).not.toContain("sk-FAKE");
    }
  });

  it("rejects long and multi-line strings as content-shaped", () => {
    expect(scanContentFreeLcmEvidence({ label: "x".repeat(500) }).ok).toBe(false);
    expect(scanContentFreeLcmEvidence({ label: "line one\nline two" }).ok).toBe(false);
    expect(scanContentFreeLcmEvidence({ label: "an-ordinary-label" }).ok).toBe(true);
  });
});
