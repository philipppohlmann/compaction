import { describe, it, expect } from "vitest";
import {
  buildPlanLifetimeImpact,
  buildPlanLifetimeImpacts,
  QUOTA_NOT_OBSERVABLE_REASON,
  LIKELY_EXTENDED_INFERENCE_REASON,
  NO_TOKEN_DATA_REASON,
  CURSOR_LOCAL_ESTIMATE_REASON,
  LOCAL_ESTIMATE_ONLY_WORKFLOWS,
  type PlanAuthWorkflow,
  type PlanLifetimeImpactRecord,
  type PlanLifetimeWorkflowInput
} from "../../src/core/plan-lifetime.js";

/**
 * PLAN-LIFETIME impact model, ROUTE A. These tests pin the honest boundaries:
 *  (1) Codex / Claude Code with observed provider-reported before/after reduction → reduced=yes,
 *      token_source=provider-reported, likely-extended (from token reduction, labeled), quota not-observable
 *      with the verbatim reason.
 *  (2) Cursor with a local-estimate before/after → token_source=local-estimate, reduction reflected, quota
 *      not-observable.
 *  (3) No data → all axes unavailable / not-observable with reasons (never a fake zero, never a fake quota).
 *  (4) plan_quota_signal is not-observable for ALL THREE (verbatim label).
 *  (5) Anti-collapse: no record carries provider-priced / invoice / api-billing labels; likely-extended is
 *      only from observed token reduction, never from a quota reading.
 *  (6) Content-free: the serialized record carries no keys / content, only counts, labels, reasons.
 */

const ALL: PlanAuthWorkflow[] = ["codex", "claude-code", "cursor"];

describe("plan-lifetime - Route A model", () => {
  describe("(1) Codex / Claude Code - observed provider-reported before/after reduction", () => {
    for (const workflow of ["codex", "claude-code"] as const) {
      it(`${workflow}: reduced=yes, provider-reported, likely-extended from token reduction, quota not-observable`, () => {
        const rec = buildPlanLifetimeImpact({
          workflow,
          input: { before: 12000, after: 4000 },
          output: { before: 800, after: 600 },
          tokenSourceObserved: "provider-reported",
          compactionInputReductionObserved: true
        });
        expect(rec.workflow).toBe(workflow);
        expect(rec.auth_mode).toBe("plan-auth");
        expect(rec.input_tokens_before).toBe(12000);
        expect(rec.input_tokens_after).toBe(4000);
        expect(rec.input_tokens_reduced).toBe("yes");
        expect(rec.output_tokens_reduced).toBe("yes");
        expect(rec.token_source).toBe("provider-reported");
        expect(rec.compaction_input_reduction).toBe("observed");
        // The ONE upgrade - inference from token reduction, honestly labeled, NEVER a quota reading.
        expect(rec.plan_lifetime_impact).toBe("likely-extended");
        expect(rec.reason).toContain(LIKELY_EXTENDED_INFERENCE_REASON);
        expect(rec.reason).toContain("INFERENCE from token reduction");
        // Quota never observable, verbatim reason present.
        expect(rec.plan_quota_signal).toBe("not-observable");
        expect(rec.reason).toContain(QUOTA_NOT_OBSERVABLE_REASON);
      });
    }

    it("cache_fresh_input_reduction is observed ONLY when a real provider-reported fresh-input reduction is recorded", () => {
      const withCache = buildPlanLifetimeImpact({
        workflow: "codex",
        input: { before: 9000, after: 3000 },
        tokenSourceObserved: "provider-reported",
        cacheFreshInputReductionObserved: true
      });
      expect(withCache.cache_fresh_input_reduction).toBe("observed");
      const withoutCache = buildPlanLifetimeImpact({
        workflow: "codex",
        input: { before: 9000, after: 3000 },
        tokenSourceObserved: "provider-reported"
      });
      expect(withoutCache.cache_fresh_input_reduction).toBe("unavailable");
    });
  });

  describe("(2) Cursor - local-estimate only", () => {
    it("reduction reflected, token_source=local-estimate (never provider-reported), quota not-observable", () => {
      // Even if a reader wrongly claimed provider-reported, Cursor is forced to local-estimate.
      const rec = buildPlanLifetimeImpact({
        workflow: "cursor",
        input: { before: 5000, after: 2000 },
        tokenSourceObserved: "provider-reported"
      });
      expect(rec.token_source).toBe("local-estimate");
      expect(rec.input_tokens_reduced).toBe("yes");
      expect(rec.plan_lifetime_impact).toBe("likely-extended");
      expect(rec.plan_quota_signal).toBe("not-observable");
      expect(rec.reason).toContain(CURSOR_LOCAL_ESTIMATE_REASON);
      expect(rec.reason).toContain(QUOTA_NOT_OBSERVABLE_REASON);
    });

    it("cursor is the local-estimate-only workflow derived from the shared tier truth", () => {
      expect(LOCAL_ESTIMATE_ONLY_WORKFLOWS).toContain("cursor");
      expect(LOCAL_ESTIMATE_ONLY_WORKFLOWS).not.toContain("codex");
      expect(LOCAL_ESTIMATE_ONLY_WORKFLOWS).not.toContain("claude-code");
    });
  });

  describe("(3) No data - everything unavailable / not-observable, never a fake zero or quota", () => {
    for (const workflow of ALL) {
      it(`${workflow}: unavailable axes with reasons, no fabricated counts`, () => {
        const rec = buildPlanLifetimeImpact({ workflow });
        expect(rec.input_tokens_reduced).toBe("unavailable");
        expect(rec.output_tokens_reduced).toBe("unavailable");
        expect(rec.token_source).toBe("unavailable");
        expect(rec.plan_lifetime_impact).toBe("unavailable");
        expect(rec.plan_quota_signal).toBe("not-observable");
        // No fabricated zero counts.
        expect(rec.input_tokens_before).toBeUndefined();
        expect(rec.input_tokens_after).toBeUndefined();
        expect(rec.output_tokens_before).toBeUndefined();
        expect(rec.output_tokens_after).toBeUndefined();
        // Reasons present (never bare).
        expect(rec.reason).toContain(NO_TOKEN_DATA_REASON);
        expect(rec.reason).toContain(QUOTA_NOT_OBSERVABLE_REASON);
      });
    }

    it("measured but no reduction → not-observed (not likely-extended, not a fake zero)", () => {
      const rec = buildPlanLifetimeImpact({
        workflow: "claude-code",
        input: { before: 4000, after: 4000 },
        tokenSourceObserved: "provider-reported"
      });
      expect(rec.input_tokens_reduced).toBe("no");
      expect(rec.plan_lifetime_impact).toBe("not-observed");
      expect(rec.plan_quota_signal).toBe("not-observable");
    });

    it("output-only reduction still yields likely-extended (either axis counts)", () => {
      const rec = buildPlanLifetimeImpact({
        workflow: "codex",
        output: { before: 900, after: 300 },
        tokenSourceObserved: "provider-reported"
      });
      expect(rec.output_tokens_reduced).toBe("yes");
      expect(rec.input_tokens_reduced).toBe("unavailable");
      expect(rec.plan_lifetime_impact).toBe("likely-extended");
    });
  });

  describe("(4) plan_quota_signal is not-observable for ALL THREE (verbatim label)", () => {
    it("every workflow carries not-observable + the exact verbatim reason string", () => {
      const recs = buildPlanLifetimeImpacts(
        ALL.map((workflow) => ({
          workflow,
          input: { before: 8000, after: 3000 },
          tokenSourceObserved: workflow === "cursor" ? "local-estimate" : "provider-reported"
        }))
      );
      expect(recs).toHaveLength(3);
      for (const rec of recs) {
        expect(rec.plan_quota_signal).toBe("not-observable");
        expect(rec.reason).toContain(QUOTA_NOT_OBSERVABLE_REASON);
      }
      // The verbatim, exact label.
      expect(QUOTA_NOT_OBSERVABLE_REASON).toBe(
        "Plan quota impact not directly observable - workflow does not expose quota/remaining-limit signal."
      );
    });
  });

  describe("(5) Anti-collapse - Route A never carries Route-B labels; likely-extended never from a quota reading", () => {
    const cases: PlanLifetimeWorkflowInput[] = [
      { workflow: "codex", input: { before: 10000, after: 2000 }, tokenSourceObserved: "provider-reported" },
      { workflow: "claude-code", input: { before: 7000, after: 7000 }, tokenSourceObserved: "provider-reported" },
      { workflow: "cursor", input: { before: 6000, after: 2000 }, tokenSourceObserved: "local-estimate" },
      { workflow: "codex" }
    ];
    const BANNED = [
      "api-billing",
      "provider-priced",
      "invoice",
      "billing-confirmed",
      "provider-priced-api",
      "plan-quota-observed",
      "api-key",
      "gateway"
    ];
    for (const input of cases) {
      it(`${input.workflow} (${input.tokenSourceObserved ?? "no-data"}) carries no Route-B / billing / quota-observed label`, () => {
        const rec = buildPlanLifetimeImpact(input);
        // Anti-collapse applies to the LABEL FIELDS (enum values), not the prose reason - an honest
        // reason legitimately NAMES a Route-B term to DISAVOW it ("never provider-priced"). So check the
        // field values, excluding `reason`.
        const { reason: _reason, ...fields } = rec;
        const serializedFields = JSON.stringify(fields).toLowerCase();
        for (const banned of BANNED) {
          expect(serializedFields).not.toContain(banned);
        }
        // The reason, where it mentions a Route-B term, only ever DISAVOWS it (prefixed by "never"/"not").
        if (rec.reason) {
          const lower = rec.reason.toLowerCase();
          for (const banned of ["provider-priced", "invoice", "billing-confirmed"]) {
            if (lower.includes(banned)) {
              expect(lower).toMatch(new RegExp(`(never|not|no)[^.]*${banned}`));
            }
          }
        }
        expect(rec.auth_mode).toBe("plan-auth");
        // token_source is only one of the three honest plan-lifetime sources.
        expect(["provider-reported", "local-estimate", "unavailable"]).toContain(rec.token_source);
        // A quota signal is never `observed` (no quota reading exists) - so likely-extended is never from one.
        expect(rec.plan_quota_signal).toBe("not-observable");
      });
    }

    it("likely-extended is reachable ONLY via observed token reduction, never via a quota signal", () => {
      // No token reduction, no data → never likely-extended (there is no quota path to it).
      const noData = buildPlanLifetimeImpact({ workflow: "codex" });
      expect(noData.plan_lifetime_impact).not.toBe("likely-extended");
      // A reduction is the only route in.
      const reduced = buildPlanLifetimeImpact({
        workflow: "codex",
        input: { before: 5000, after: 1000 },
        tokenSourceObserved: "provider-reported"
      });
      expect(reduced.plan_lifetime_impact).toBe("likely-extended");
    });
  });

  describe("(6) Content-free - no keys / prompt / response content, only counts + labels + reasons", () => {
    it("serializes to counts, enum labels, and reason strings only", () => {
      const rec: PlanLifetimeImpactRecord = buildPlanLifetimeImpact({
        workflow: "claude-code",
        input: { before: 9000, after: 3000 },
        output: { before: 700, after: 500 },
        tokenSourceObserved: "provider-reported",
        compactionInputReductionObserved: true,
        cacheFreshInputReductionObserved: true
      });
      const serialized = JSON.stringify(rec).toLowerCase();
      // No credential-ish or content-ish keys.
      for (const forbidden of ["apikey", "api_key", "sk-", "prompt", "response", "content", "message", "secret", "token=", "bearer"]) {
        expect(serialized).not.toContain(forbidden);
      }
      // Only the expected top-level keys are present.
      const keys = Object.keys(rec).sort();
      expect(keys).toEqual(
        [
          "auth_mode",
          "cache_fresh_input_reduction",
          "compaction_input_reduction",
          "input_tokens_after",
          "input_tokens_before",
          "input_tokens_reduced",
          "output_tokens_after",
          "output_tokens_before",
          "output_tokens_reduced",
          "plan_lifetime_impact",
          "plan_quota_signal",
          "reason",
          "token_source",
          "workflow"
        ].sort()
      );
    });
  });
});
