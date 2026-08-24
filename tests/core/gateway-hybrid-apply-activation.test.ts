import { describe, expect, it } from "vitest";
import {
  HYBRID_APPLY_ACTIVATION_VERSION,
  HYBRID_APPLY_ENV,
  isHybridApplyActivated
} from "../../src/core/gateway/hybrid-apply-activation.js";

describe("hybrid apply activation (the reachability switch)", () => {
  it("is DORMANT by default - ships off, opt-in required", () => {
    expect(HYBRID_APPLY_ACTIVATION_VERSION.length).toBeGreaterThan(0);
    expect(isHybridApplyActivated({})).toBe(false);
  });

  it("only an explicit opt-in enables it; anything else stays dormant", () => {
    expect(isHybridApplyActivated({ [HYBRID_APPLY_ENV]: "1" })).toBe(true);
    expect(isHybridApplyActivated({ [HYBRID_APPLY_ENV]: "true" })).toBe(true);
    expect(isHybridApplyActivated({ [HYBRID_APPLY_ENV]: "TRUE" })).toBe(true);
    expect(isHybridApplyActivated({ [HYBRID_APPLY_ENV]: "0" })).toBe(false);
    expect(isHybridApplyActivated({ [HYBRID_APPLY_ENV]: "false" })).toBe(false);
    expect(isHybridApplyActivated({ [HYBRID_APPLY_ENV]: "" })).toBe(false);
    expect(isHybridApplyActivated({ [HYBRID_APPLY_ENV]: "yes" })).toBe(false);
  });
});
