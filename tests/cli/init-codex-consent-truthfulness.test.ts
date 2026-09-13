import { describe, expect, it } from "vitest";
import { SHIM_TOOLS } from "../../src/core/tool-shim.js";
import { interactiveInvocationsLine } from "../../src/cli/commands/init.js";
import {
  READY_ENABLE_CODEX_CONFIGURED_LINE,
  READY_ENABLE_CODEX_HOLD_LINE,
  READY_ENABLE_CODEX_LINE,
  READY_ENABLE_CODEX_NO_SHAPING_LINE
} from "../../src/cli/onboarding/model.js";

/**
 * THE CONSENT SURFACE MUST DESCRIBE WHAT THE SHIM ACTUALLY DOES.
 *
 * Codex's PATH shim changed from `kind: "capture"` (measurable-batch-form-only, interactive invocations
 * pass through unmeasured) to `kind: "gateway-route"` (every normal invocation - interactive included -
 * is routed through the local Gateway and measured, unless the user's own route is detected). Seven
 * live strings on the connect/onboarding surface kept claiming the OLD behavior after that change
 * shipped - the defect this test exists to catch if it ever recurs.
 *
 * Split into two tests on purpose: an exact-string pin and a property assertion in the SAME test report
 * the string failure first and can leave the property dead. The FIRST test pins today's exact runtime
 * `kind` values (a string pin: fails loudly and immediately if the shim's kind ever changes). The
 * SECOND test asserts the PROPERTY - that the consent copy's claim direction agrees with whatever
 * `SHIM_TOOLS[tool].kind` says - independently, so it stays alive even if the first test's pin is
 * mid-failure for an unrelated reason.
 */
describe("Codex's consent copy agrees with its shim's runtime kind", () => {
  it("pins today's runtime kind for every shim tool (fails loudly if this ever changes silently)", () => {
    expect(SHIM_TOOLS.codex.kind).toBe("gateway-route");
    expect(SHIM_TOOLS.cursor.kind).toBe("capture");
    expect(SHIM_TOOLS["claude-code"].kind).toBe("gateway-route");
  });

  it("PROPERTY: a gateway-route tool's consent line claims interactive runs ARE routed/measured; a capture tool's claims they are NOT", () => {
    for (const tool of ["codex", "cursor"] as const) {
      const kind = SHIM_TOOLS[tool].kind;
      const line = interactiveInvocationsLine(tool, SHIM_TOOLS[tool].shimName);
      if (kind === "gateway-route") {
        expect(line, `${tool} is gateway-route but its consent line does not say so`).toMatch(
          /also routes through the local Gateway/
        );
        expect(line, `${tool} must not guarantee measurement without a settled receipt`).not.toMatch(/IS measured|produces a receipt/);
        expect(line, `${tool} is gateway-route but its consent line still makes the old blanket "pass through untouched ... NOT measured" claim`).not.toMatch(
          /^Interactive \/ other .+ invocations pass through untouched and are NOT measured \(never faked\)\.$/
        );
      } else {
        expect(line, `${tool} is capture-kind but its consent line does not say interactive runs pass through unmeasured`).toMatch(
          /pass through untouched and are NOT measured \(never faked\)/
        );
      }
    }
  });

  it("every Codex ready-state line agrees with the normal-invocation Gateway shim", () => {
    for (const line of [
      READY_ENABLE_CODEX_LINE,
      READY_ENABLE_CODEX_HOLD_LINE,
      READY_ENABLE_CODEX_NO_SHAPING_LINE,
      READY_ENABLE_CODEX_CONFIGURED_LINE
    ]) {
      expect(line).toContain("Routed automatically through the local Gateway");
      expect(line).not.toContain("No Gateway route from this setup");
    }
  });
});
