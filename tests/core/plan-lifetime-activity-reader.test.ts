import { describe, it, expect } from "vitest";
import {
  buildPlanLifetimeImpactsFromActivity,
  PLAN_AUTH_WORKFLOWS,
  QUOTA_NOT_OBSERVABLE_REASON
} from "../../src/core/plan-lifetime.js";
import { buildMeasureOnlyActivityEvent } from "../../src/core/activity-event.js";
import type { ActivityEvent } from "../../src/core/activity-event.js";
import type { StandardCrossSurfaceEvent } from "../../src/core/cross-surface-event.js";

/**
 * The CONTENT-FREE plan-lifetime activity reader. It maps already-content-free
 * activity events → the pure model, ALWAYS emitting one honest record per plan-auth workflow. It never
 * fabricates a count or a quota; a workflow with no usable observed before/after gets the not-observable
 * default. Cursor is never laundered to provider-reported.
 */

function event(
  surface: StandardCrossSurfaceEvent["surface"],
  provider: StandardCrossSurfaceEvent["provider"],
  inputSource: "provider-reported" | "local-estimate",
  before: number,
  after: number
): ActivityEvent {
  const base: StandardCrossSurfaceEvent = {
    surface,
    provider,
    model_label: "unknown",
    run_id: `${surface}-1751600000001`,
    token_source: {
      input: { source: inputSource },
      output: { source: "unavailable", unavailable_reason: "not separable" }
    },
    input_before: before,
    input_after: after,
    cost_source: "unavailable",
    cost_unavailable_reason: "no cost data",
    claim_scope: "run-scoped"
  };
  return buildMeasureOnlyActivityEvent(base, { original_retained: true, location: "out/x.json" }) as ActivityEvent;
}

describe("buildPlanLifetimeImpactsFromActivity", () => {
  it("always emits one honest record per plan-auth workflow, even with no activity", () => {
    const records = buildPlanLifetimeImpactsFromActivity([]);
    expect(records.map((r) => r.workflow).sort()).toEqual([...PLAN_AUTH_WORKFLOWS].sort());
    for (const r of records) {
      expect(r.auth_mode).toBe("plan-auth");
      expect(r.plan_quota_signal).toBe("not-observable");
      expect(r.plan_lifetime_impact).toBe("unavailable"); // no counts → unavailable, honest reason.
      expect(r.token_source).toBe("unavailable");
      expect(r.reason).toContain(QUOTA_NOT_OBSERVABLE_REASON);
    }
  });

  it("a REAL provider-reported before>after reduction for codex → likely-extended (inference, not quota)", () => {
    const records = buildPlanLifetimeImpactsFromActivity([
      event("codex", "openai", "provider-reported", 1000, 600)
    ]);
    const codex = records.find((r) => r.workflow === "codex");
    expect(codex?.input_tokens_reduced).toBe("yes");
    expect(codex?.token_source).toBe("provider-reported");
    expect(codex?.plan_lifetime_impact).toBe("likely-extended");
    // Quota is STILL not-observable - the upgrade is from token reduction, never a quota reading.
    expect(codex?.plan_quota_signal).toBe("not-observable");
    // Untouched workflows stay at the honest default.
    expect(records.find((r) => r.workflow === "cursor")?.plan_lifetime_impact).toBe("unavailable");
  });

  it("Cursor is never laundered to provider-reported (forced local-estimate even if the event claims otherwise)", () => {
    const records = buildPlanLifetimeImpactsFromActivity([
      // Even though the (malformed) event claims provider-reported, Cursor is a never-provider-reported surface.
      event("cursor", "cursor", "provider-reported", 800, 500)
    ]);
    const cursor = records.find((r) => r.workflow === "cursor");
    expect(cursor?.token_source).toBe("local-estimate");
    expect(cursor?.plan_lifetime_impact).toBe("likely-extended"); // real reduction, but estimate-basis.
  });

  it("an event whose input source is unavailable yields no usable counts (honest not-observable)", () => {
    const bad = event("codex", "openai", "local-estimate", 1000, 600);
    // Force the input axis unavailable - no usable source → the reader must not use the counts.
    (bad.token_source as { input: { source: string } }).input.source = "unavailable";
    const records = buildPlanLifetimeImpactsFromActivity([bad]);
    const codex = records.find((r) => r.workflow === "codex");
    expect(codex?.plan_lifetime_impact).toBe("unavailable");
    expect(codex?.token_source).toBe("unavailable");
  });
});
