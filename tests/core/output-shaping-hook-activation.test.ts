import { describe, expect, it } from "vitest";
import {
  SHAPING_HOOKS_ACTIVATION_VERSION,
  SHAPING_HOOKS_ENV,
  isShapingHooksActivated
} from "../../src/core/output-shaping-hook-activation.js";

describe("output-shaping hook activation (auto-apply, default-ON with kill-switch)", () => {
  it("carries a non-empty versioned activation label", () => {
    expect(typeof SHAPING_HOOKS_ACTIVATION_VERSION).toBe("string");
    expect(SHAPING_HOOKS_ACTIVATION_VERSION.length).toBeGreaterThan(0);
    expect(SHAPING_HOOKS_ENV).toBe("COMPACTION_SHAPING_HOOKS");
  });

  it("is ACTIVE by default (env absent)", () => {
    expect(isShapingHooksActivated({})).toBe(true);
  });

  it("stays ACTIVE for any non-kill-switch value (never accidentally opts out)", () => {
    // Auto-apply is the default; only the explicit kill-switch values disable it. Anything else
    // (including junk, empty string, and stray affirmatives) leaves shaping active.
    for (const on of ["1", "true", "TRUE", "True", "yes", "on", "", "2", " true ", "enabled"]) {
      expect(isShapingHooksActivated({ [SHAPING_HOOKS_ENV]: on })).toBe(true);
    }
  });

  it("DISABLES only on explicit kill-switch values (case-insensitive)", () => {
    for (const off of ["0", "false", "off", "no", "FALSE", "Off", "NO"]) {
      expect(isShapingHooksActivated({ [SHAPING_HOOKS_ENV]: off })).toBe(false);
    }
  });
});
