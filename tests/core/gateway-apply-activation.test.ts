import { describe, expect, it } from "vitest";
import { resolveApplyActivation } from "../../src/core/gateway/apply-activation.js";

/**
 * Apply activation. Apply is OPT-IN + EXPLICIT. Default is record. A server-config vs
 * request-header conflict FAILS CLOSED (record). These tests pin the precedence + fail-closed rules.
 */
const DEDUPE = "deterministic-dedupe";

describe("resolveApplyActivation - default is record", () => {
  it("plain record server, no headers → record, not requested", () => {
    const a = resolveApplyActivation({ serverMode: "record" });
    expect(a.mode).toBe("record");
    expect(a.requested).toBe(false);
  });

  it("an explicit header `record` is an opt-out even when the server is apply", () => {
    const a = resolveApplyActivation({ serverMode: "apply", serverPolicy: DEDUPE, headerMode: "record" });
    expect(a.mode).toBe("record");
    expect(a.requested).toBe(false);
  });
});

describe("resolveApplyActivation - explicit activation", () => {
  it("server --mode apply --policy deterministic-dedupe → apply via explicit-mode", () => {
    const a = resolveApplyActivation({ serverMode: "apply", serverPolicy: DEDUPE });
    expect(a.mode).toBe("apply");
    expect(a.requested).toBe(true);
    expect(a.policy).toBe(DEDUPE);
    expect(a.activation).toBe("explicit-mode");
  });

  it("header-alone activation on a record-default server → apply via explicit-header", () => {
    const a = resolveApplyActivation({ serverMode: "record", headerMode: "apply", headerPolicy: DEDUPE });
    expect(a.mode).toBe("apply");
    expect(a.activation).toBe("explicit-header");
  });

  it("dry-run via header → mode dry-run", () => {
    const a = resolveApplyActivation({ serverMode: "record", headerMode: "dry-run", headerPolicy: DEDUPE });
    expect(a.mode).toBe("dry-run");
    expect(a.activation).toBe("dry-run-header");
  });
});

describe("resolveApplyActivation - FAIL CLOSED", () => {
  it("apply requested with no policy → fail closed", () => {
    const a = resolveApplyActivation({ serverMode: "apply" });
    expect(a.mode).toBe("record");
    expect(a.requested).toBe(true);
    expect(a.failClosedReason).toMatch(/requires policy/i);
  });

  it("apply requested with an unknown policy → fail closed", () => {
    const a = resolveApplyActivation({ serverMode: "apply", serverPolicy: "magic-summarizer" });
    expect(a.mode).toBe("record");
    expect(a.failClosedReason).toMatch(/unknown policy/i);
  });

  it("server apply(policy A) vs header apply(policy B) → conflict fail closed", () => {
    const a = resolveApplyActivation({ serverMode: "apply", serverPolicy: DEDUPE, headerMode: "apply", headerPolicy: "other-policy" });
    expect(a.mode).toBe("record");
    expect(a.failClosedReason).toMatch(/conflict/i);
  });

  it("server apply vs header dry-run → mode conflict fail closed", () => {
    const a = resolveApplyActivation({ serverMode: "apply", serverPolicy: DEDUPE, headerMode: "dry-run", headerPolicy: DEDUPE });
    expect(a.mode).toBe("record");
    expect(a.failClosedReason).toMatch(/conflict/i);
  });

  it("server dry-run vs header apply → no header escalation past the server ceiling (conflict)", () => {
    const a = resolveApplyActivation({ serverMode: "dry-run", serverPolicy: DEDUPE, headerMode: "apply", headerPolicy: DEDUPE });
    expect(a.mode).toBe("record");
    expect(a.failClosedReason).toMatch(/conflict/i);
  });

  it("an unknown mode value fails closed", () => {
    const a = resolveApplyActivation({ serverMode: "record", headerMode: "obliterate" });
    expect(a.mode).toBe("record");
    expect(a.failClosedReason).toMatch(/unknown x-compaction-mode/i);
  });
});
