import { describe, expect, it } from "vitest";
import { classifyLcmReason, type LcmOutcomeKind } from "../../src/core/gateway/lcm-outcome.js";

describe("classifyLcmReason — public fixed vocabulary", () => {
  const cases: Array<[string, string | undefined, LcmOutcomeKind, string]> = [
    ["lcm-candidate", "empty-summary", "no-candidate", "empty-summary"],
    ["lcm-candidate", "unsupported-apply-shape", "construction-failed", "unsupported-apply-shape"],
    ["lcm-candidate", undefined, "construction-failed", "body-construction-failed"],
    ["rejected-candidate", "over-compression: detail", "rejected", "validation-over-compression"],
    ["rejected-candidate", "unsourced content: detail", "rejected", "validation-unsourced"],
    ["no-candidate", "no-obsolete-history-to-compact", "unavailable", "no-obsolete-history"],
    ["no-candidate", "compaction-prefix-exceeds-local-context", "unavailable", "prefix-exceeds-local-context"],
    ["no-candidate", "compaction-warming-cache", "unavailable", "warming-cache"],
    ["no-candidate", "local-model-call-disabled-in-ci", "unavailable", "local-model-call-disabled-in-ci"],
    ["no-candidate", "local-model-unavailable: unavailable", "unavailable", "model-not-ready"],
    ["no-candidate", "local-model-empty-summary", "no-candidate", "empty-summary"],
    ["no-candidate", "unsupported-request-shape: tools", "no-candidate", "unsupported-request-shape"],
    ["no-candidate", "model-client-error: Error", "no-candidate", "model-error"],
    ["no-candidate", "local-model-error: Error", "no-candidate", "model-error"],
    ["no-candidate", "model-returned-no-proposal", "no-candidate", "model-refusal"]
  ];

  it("maps every public reason into the closed receipt vocabulary", () => {
    for (const [kind, reason, expectedKind, expectedReason] of cases) {
      expect(classifyLcmReason(kind, reason), `${kind}/${reason}`).toEqual({
        kind: expectedKind,
        reason: expectedReason
      });
    }
  });

  it("never infers contribution from a non-applied engine reason", () => {
    for (const [kind, reason] of cases) {
      expect(classifyLcmReason(kind, reason).kind).not.toBe("contributed");
    }
    expect(classifyLcmReason("lcm-candidate", "unknown").kind).not.toBe("contributed");
  });

  it("maps unknown or error-bearing text to fixed content-free values", () => {
    const unknown = classifyLcmReason("no-candidate", "unrecognized private detail");
    expect(unknown).toEqual({ kind: "no-candidate", reason: "unexpected-error" });

    for (const prefix of ["local-model-error", "model-client-error"]) {
      expect(classifyLcmReason("no-candidate", `${prefix}: PrivateDetail`)).toEqual({
        kind: "no-candidate",
        reason: "model-error"
      });
    }
  });
});
