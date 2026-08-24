/**
 * Activity-event extension tests.
 *
 * Two enforcement layers, both exercised here, same pattern as
 * `tests/core/cross-surface-event.test.ts`:
 * 1. TYPE-LEVEL, auto-apply is structurally OFF BY DEFAULT: `applied_automatically: true` is
 *    only representable with the explicit opt-in preference ("auto-when-gates-pass"), with
 *    `eligible: true`, and with a NON-EMPTY `gates_passed`. The `@ts-expect-error` constructions
 *    below prove it, and the "type-level guardrails compile" test spawns `tsc --noEmit` on THIS
 *    file so an unused `@ts-expect-error` (a loosened union) fails `npm test`.
 * 2. VALIDATOR-LEVEL, `validateActivityEvent` (report-only; composes the existing cross-surface
 *    validator) catches the same states on parsed/unknown data.
 *
 * Plus: the deterministic content-free id (same event → same id; any field change → new id;
 * an existing id never feeds back into itself) and the measure-only builder's honest defaults.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ACTIVITY_APPROVAL_STATUSES,
  ACTIVITY_EVENT_ID_PATTERN,
  ACTIVITY_SYNC_STATUSES,
  AUTO_APPLY_PREFERENCES,
  DEFAULT_ACTIVITY_SYNC_STATUS,
  buildMeasureOnlyActivityEvent,
  computeActivityEventId,
  validateActivityEvent,
  type ActivityAutoApply,
  type ActivityEvent
} from "../../src/core/activity-event.js";
import type { StandardCrossSurfaceEvent } from "../../src/core/cross-surface-event.js";

/* ------------------------------------------------------------------------------------------------
 * TYPE-LEVEL guardrails (never executed, compiled only).
 * ---------------------------------------------------------------------------------------------- */
function typeLevelGuardrails(): void {
  // POSITIVE CONTROLS, the honest states must stay representable.
  const measureOnly: ActivityAutoApply = {
    eligible: false,
    preference: "ask-each-time",
    applied_automatically: false
  };
  const declinedButEligible: ActivityAutoApply = {
    eligible: true,
    preference: "ask-each-time",
    applied_automatically: false,
    gates_passed: ["recoverability-pass"]
  };
  // The applied arm IS representable, but ONLY in the fully-consented, fully-gated shape.
  const optedInAndGated: ActivityAutoApply = {
    eligible: true,
    preference: "auto-when-gates-pass",
    applied_automatically: true,
    gates_passed: ["recoverability-pass", "threshold-pass"]
  };
  const fullActivityEvent: ActivityEvent = {
    surface: "codex",
    provider: "openai",
    claim_scope: "run-scoped",
    approval_status: "not-required",
    auto_apply: measureOnly,
    recovery: { original_retained: true, location: ".compaction/runs/x/trace.json" },
    sync_status: "local-only",
    activity_event_id: "act-0123456789abcdef01234567"
  };

  // GUARDRAIL (the core off-by-default proof): auto-applied under the DEFAULT preference
  // ("ask-each-time") must not compile, auto-apply is only ever an explicit prior opt-in.
  // @ts-expect-error applied_automatically true with preference "ask-each-time" must not compile
  const appliedUnderDefault: ActivityAutoApply = {
    eligible: true,
    preference: "ask-each-time",
    applied_automatically: true,
    gates_passed: ["recoverability-pass"]
  };

  // GUARDRAIL: auto-applied with ZERO passed gates must not compile (fail-closed gating).
  // @ts-expect-error applied_automatically true with an empty gates_passed must not compile
  const appliedWithoutGates: ActivityAutoApply = {
    eligible: true,
    preference: "auto-when-gates-pass",
    applied_automatically: true,
    gates_passed: []
  };

  // GUARDRAIL: auto-applied with NO gates_passed field at all must not compile.
  // @ts-expect-error applied_automatically true without gates_passed must not compile
  const appliedGatesMissing: ActivityAutoApply = {
    eligible: true,
    preference: "auto-when-gates-pass",
    applied_automatically: true
  };

  // GUARDRAIL: auto-applied while ineligible must not compile.
  // @ts-expect-error applied_automatically true with eligible false must not compile
  const appliedIneligible: ActivityAutoApply = {
    eligible: false,
    preference: "auto-when-gates-pass",
    applied_automatically: true,
    gates_passed: ["recoverability-pass"]
  };

  // GUARDRAIL: the activity enums are exact.
  // @ts-expect-error "auto-approved" is not an approval status
  const badApproval: ActivityEvent = { surface: "cli", approval_status: "auto-approved" };
  // @ts-expect-error "synced" is not a sync status
  const badSync: ActivityEvent = { surface: "cli", sync_status: "synced" };

  // GUARDRAIL: the intersection preserves the EXISTING cross-surface guardrails (D5/D6), a
  // cursor activity event still cannot claim billing-confirmed.
  // @ts-expect-error cursor + billing-confirmed claim scope must not compile on the activity event either
  const cursorBillingConfirmed: ActivityEvent = {
    surface: "cursor",
    claim_scope: "billing-confirmed-workflow-scoped",
    approval_status: "not-required"
  };

  void [
    measureOnly,
    declinedButEligible,
    optedInAndGated,
    fullActivityEvent,
    appliedUnderDefault,
    appliedWithoutGates,
    appliedGatesMissing,
    appliedIneligible,
    badApproval,
    badSync,
    cursorBillingConfirmed
  ];
}
void typeLevelGuardrails;

/* ------------------------------------------------------------------------------------------------
 * Runtime tests.
 * ---------------------------------------------------------------------------------------------- */

describe("type-level guardrails are enforced by tsc (self-typecheck of this file)", () => {
  it("compiles this file with tsc --noEmit so every @ts-expect-error above is load-bearing", () => {
    const tscBin = join(process.cwd(), "node_modules", "typescript", "bin", "tsc");
    const result = spawnSync(
      process.execPath,
      [
        tscBin,
        "--noEmit",
        "--strict",
        "--target",
        "ES2022",
        "--module",
        "NodeNext",
        "--moduleResolution",
        "NodeNext",
        "--esModuleInterop",
        "--skipLibCheck",
        fileURLToPath(import.meta.url)
      ],
      { encoding: "utf8", timeout: 180_000 }
    );
    expect(result.status, `tsc failed:\n${result.stdout ?? ""}${result.stderr ?? ""}`).toBe(0);
  }, 180_000);
});

/** A minimal honest codex-run event to extend in the validator tests. */
const BASE_EVENT: StandardCrossSurfaceEvent = {
  surface: "codex",
  provider: "openai",
  model_label: "unknown",
  run_id: "codex-1751600000000",
  token_source: { input: { source: "provider-reported" }, output: { source: "provider-reported" } },
  input_before: 1500,
  output_before: 420,
  cost_source: "unavailable",
  cost_unavailable_reason: "codex reports token usage but no cost figure",
  claim_scope: "run-scoped"
};

describe("validator: auto-apply is OFF by default (mirror of the type-level arm)", () => {
  it("accepts the measure-only shape (not eligible, ask-each-time, not applied)", () => {
    const { problems } = validateActivityEvent({
      ...BASE_EVENT,
      approval_status: "not-required",
      auto_apply: { eligible: false, preference: "ask-each-time", applied_automatically: false },
      sync_status: "local-only"
    });
    expect(problems).toEqual([]);
  });

  it("accepts the fully-consented, fully-gated applied shape (the only valid applied state)", () => {
    const { problems } = validateActivityEvent({
      ...BASE_EVENT,
      approval_status: "auto-applied-by-policy",
      auto_apply: {
        eligible: true,
        preference: "auto-when-gates-pass",
        applied_automatically: true,
        gates_passed: ["recoverability-pass"]
      }
    });
    expect(problems).toEqual([]);
  });

  it('REJECTS applied_automatically=true under the default "ask-each-time" preference', () => {
    const { problems } = validateActivityEvent({
      ...BASE_EVENT,
      auto_apply: {
        eligible: true,
        preference: "ask-each-time",
        applied_automatically: true,
        gates_passed: ["recoverability-pass"]
      }
    });
    expect(problems.some((p) => p.includes("OFF by default"))).toBe(true);
  });

  it("REJECTS applied_automatically=true with zero / missing passed gates (fail-closed)", () => {
    const emptyGates = validateActivityEvent({
      ...BASE_EVENT,
      auto_apply: { eligible: true, preference: "auto-when-gates-pass", applied_automatically: true, gates_passed: [] }
    });
    expect(emptyGates.problems.some((p) => p.includes("NON-EMPTY gates_passed"))).toBe(true);
    const missingGates = validateActivityEvent({
      ...BASE_EVENT,
      auto_apply: { eligible: true, preference: "auto-when-gates-pass", applied_automatically: true }
    });
    expect(missingGates.problems.some((p) => p.includes("NON-EMPTY gates_passed"))).toBe(true);
  });

  it("REJECTS applied_automatically=true while ineligible", () => {
    const { problems } = validateActivityEvent({
      ...BASE_EVENT,
      auto_apply: {
        eligible: false,
        preference: "auto-when-gates-pass",
        applied_automatically: true,
        gates_passed: ["recoverability-pass"]
      }
    });
    expect(problems.some((p) => p.includes("requires eligible=true"))).toBe(true);
  });

  it("REJECTS bad enum values for approval_status / sync_status / preference", () => {
    const { problems } = validateActivityEvent({
      ...BASE_EVENT,
      approval_status: "auto-approved",
      sync_status: "synced",
      auto_apply: { eligible: false, preference: "always", applied_automatically: false }
    });
    expect(problems.some((p) => p.startsWith("approval_status:"))).toBe(true);
    expect(problems.some((p) => p.startsWith("sync_status:"))).toBe(true);
    expect(problems.some((p) => p.startsWith("auto_apply.preference:"))).toBe(true);
  });

  it("composes the EXISTING cross-surface validator: a forged billing-confirmed cursor activity event is rejected", () => {
    const { problems } = validateActivityEvent({
      surface: "cursor",
      claim_scope: "billing-confirmed-workflow-scoped",
      cost_source: "operator-entered",
      approval_status: "not-required"
    });
    expect(problems.some((p) => p.includes('only possible on surface "api_metered"'))).toBe(true);
  });
});

describe("validator: recovery is a content-free pointer", () => {
  it("accepts original_retained + a single-line location", () => {
    const { problems } = validateActivityEvent({
      ...BASE_EVENT,
      recovery: { original_retained: true, location: ".compaction/runs/x/trace.json" }
    });
    expect(problems).toEqual([]);
  });

  it("REJECTS a multi-line location (content-shaped, not a pointer)", () => {
    const { problems } = validateActivityEvent({
      ...BASE_EVENT,
      recovery: { original_retained: true, location: "line one\nline two of smuggled content" }
    });
    expect(problems.some((p) => p.includes("single-line path/pointer"))).toBe(true);
  });

  it("REJECTS a non-boolean original_retained (never assumed)", () => {
    const { problems } = validateActivityEvent({ ...BASE_EVENT, recovery: { original_retained: "yes" } });
    expect(problems.some((p) => p.startsWith("recovery.original_retained:"))).toBe(true);
  });
});

describe("deterministic content-free activity_event_id", () => {
  it("is stable: the same event always produces the same id, matching the act-<24 hex> shape", () => {
    const a = computeActivityEventId({ ...BASE_EVENT });
    const b = computeActivityEventId({ ...BASE_EVENT });
    expect(a).toBe(b);
    expect(a).toMatch(ACTIVITY_EVENT_ID_PATTERN);
  });

  it("is key-order independent (canonicalized) and undefined-insensitive", () => {
    const reordered = Object.fromEntries(Object.entries(BASE_EVENT).reverse()) as StandardCrossSurfaceEvent;
    expect(computeActivityEventId(reordered)).toBe(computeActivityEventId(BASE_EVENT));
    const withUndefined = { ...BASE_EVENT, user_id: undefined } as StandardCrossSurfaceEvent;
    expect(computeActivityEventId(withUndefined)).toBe(computeActivityEventId(BASE_EVENT));
  });

  it("changes when any metrics field changes", () => {
    expect(computeActivityEventId({ ...BASE_EVENT, input_before: 1501 })).not.toBe(computeActivityEventId(BASE_EVENT));
  });

  it("excludes any existing activity_event_id (recomputing on a stored event reproduces the id)", () => {
    const id = computeActivityEventId(BASE_EVENT);
    expect(computeActivityEventId({ ...BASE_EVENT, activity_event_id: id })).toBe(id);
  });
});

describe("buildMeasureOnlyActivityEvent - honest defaults for measure-only runs", () => {
  it("sets not-required / not-eligible / ask-each-time / not-applied / local-only + the given recovery", () => {
    const event = buildMeasureOnlyActivityEvent(BASE_EVENT, {
      original_retained: true,
      location: "out/captured-trace.json"
    });
    expect(event.approval_status).toBe("not-required");
    expect(event.auto_apply).toEqual({ eligible: false, preference: "ask-each-time", applied_automatically: false });
    expect(event.recovery).toEqual({ original_retained: true, location: "out/captured-trace.json" });
    expect(event.sync_status).toBe(DEFAULT_ACTIVITY_SYNC_STATUS);
    expect(event.activity_event_id).toMatch(ACTIVITY_EVENT_ID_PATTERN);
    // The underlying cross-surface fields ride through untouched.
    expect(event.surface).toBe("codex");
    expect(event.input_before).toBe(1500);
    expect(validateActivityEvent(event).problems).toEqual([]);
  });

  it("exports the exact enums, verbatim", () => {
    expect([...ACTIVITY_APPROVAL_STATUSES]).toEqual([
      "not-required",
      "asked-approved",
      "asked-declined",
      "auto-applied-by-policy",
      "not-asked"
    ]);
    expect([...AUTO_APPLY_PREFERENCES]).toEqual(["ask-each-time", "auto-when-gates-pass"]);
    expect([...ACTIVITY_SYNC_STATUSES]).toEqual(["local-only", "metrics-synced", "hosted-private"]);
    expect(DEFAULT_ACTIVITY_SYNC_STATUS).toBe("local-only");
  });
});
