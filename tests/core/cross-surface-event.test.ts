/**
 * Label-correctness guard tests for the cross-surface event contract
 * (typed in `src/core/cross-surface-event.ts`).
 *
 * Two enforcement layers, both exercised here:
 * 1. TYPE-LEVEL, the discriminated union makes fixed-plan-as-billing-confirmed unrepresentable.
 *    The `@ts-expect-error` constructions below prove it, and the "type-level guardrails compile"
 *    test spawns `tsc --noEmit` on THIS file so an unused `@ts-expect-error` (i.e. a loosened
 *    union) fails `npm test`, not just editor typechecking (the root tsconfig only checks src/).
 * 2. VALIDATOR-LEVEL, `validateCrossSurfaceEvent` (report-only: returns problems, never throws)
 *    catches the same states on parsed/unknown data where TypeScript cannot.
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  CROSS_SURFACE_CLAIM_SCOPES,
  CROSS_SURFACE_COST_SOURCES,
  CROSS_SURFACE_PROVIDERS,
  CROSS_SURFACE_SURFACES,
  NEVER_PROVIDER_REPORTED_SURFACES,
  RUN_RECORD_EVENT_SURFACES,
  buildCursorRunCrossSurfaceEvent,
  buildRunCrossSurfaceEvent,
  surfaceForToolName,
  validateCrossSurfaceEvent,
  type BillingConfirmedCrossSurfaceEvent,
  type CrossSurfaceEvent,
  type PlanEfficiencySignals,
  type StandardCrossSurfaceEvent
} from "../../src/core/cross-surface-event.js";
import {
  buildLocalRunTokenRecord,
  readLocalRunTokenRecords,
  validateLocalRunTokenRecord,
  writeLocalRunTokenRecord
} from "../../src/core/local-run-record.js";
import type { RunFlowTokenReport } from "../../src/core/run-flow-report.js";

/* ------------------------------------------------------------------------------------------------
 * TYPE-LEVEL guardrails (never executed, compiled only). Each @ts-expect-error line asserts that
 * the construction on the following line is a TYPE ERROR. If the union is ever loosened so one of
 * these compiles, tsc reports an UNUSED @ts-expect-error and the "type-level guardrails" test
 * below fails.
 * ---------------------------------------------------------------------------------------------- */
function typeLevelGuardrails(): void {
  // POSITIVE CONTROLS, the honest constructions must stay representable.
  const meteredBillingConfirmed: CrossSurfaceEvent = {
    surface: "api_metered",
    claim_scope: "billing-confirmed-workflow-scoped",
    cost_source: "operator-entered"
  };
  const cursorLocalEstimate: CrossSurfaceEvent = {
    surface: "cursor",
    claim_scope: "run-scoped",
    token_source: {
      input: { source: "local-estimate" },
      output: { source: "unavailable", unavailable_reason: "Cursor emits no provider usage; output not separable" }
    }
  };
  const browserPlanEfficiency: CrossSurfaceEvent = {
    surface: "browser_extension",
    provider: "chatgpt",
    billing_model: "fixed-plan",
    plan_efficiency: { evidence_type: "plan-efficiency", billing_confirmed: false }
  };

  // NOTE: each guarded construction is kept on ONE line, tsc reports property-level errors on
  // the property's line, and @ts-expect-error only covers the line immediately after it.

  // GUARDRAIL: a fixed-plan surface (browser_extension) can NEVER be billing-confirmed (D5).
  // @ts-expect-error browser_extension + billing-confirmed claim scope must not compile
  const browserBillingConfirmed: CrossSurfaceEvent = { surface: "browser_extension", claim_scope: "billing-confirmed-workflow-scoped", cost_source: "provider-reported" };

  // GUARDRAIL: cursor (subscription / fixed-plan surface) can NEVER be billing-confirmed (D5).
  // @ts-expect-error cursor + billing-confirmed claim scope must not compile
  const cursorBillingConfirmed: CrossSurfaceEvent = { surface: "cursor", claim_scope: "billing-confirmed-workflow-scoped", cost_source: "operator-entered" };

  // GUARDRAIL: billing-confirmed requires provider-reported | operator-entered cost (D6), a
  // local estimate can never be relabeled billing-confirmed.
  // @ts-expect-error api_metered + billing-confirmed + local-estimate cost must not compile
  const estimateRelabeled: CrossSurfaceEvent = { surface: "api_metered", claim_scope: "billing-confirmed-workflow-scoped", cost_source: "local-estimate" };

  // GUARDRAIL: a plan-efficiency payload structurally excludes billing-confirmed (D5).
  // @ts-expect-error plan_efficiency on the billing-confirmed arm must not compile
  const planEfficiencyBillingConfirmed: BillingConfirmedCrossSurfaceEvent = { surface: "api_metered", claim_scope: "billing-confirmed-workflow-scoped", cost_source: "provider-reported", plan_efficiency: { evidence_type: "plan-efficiency", billing_confirmed: false } };

  // GUARDRAIL: plan_efficiency.billing_confirmed is the LITERAL false (D5).
  // @ts-expect-error billing_confirmed: true must not compile on a plan-efficiency payload
  const planEfficiencyConfirmed: PlanEfficiencySignals = { evidence_type: "plan-efficiency", billing_confirmed: true };

  // GUARDRAIL: a billing-confirmed event can never be marked fixed-plan.
  // @ts-expect-error billing_model "fixed-plan" on the billing-confirmed arm must not compile
  const fixedPlanBillingConfirmed: BillingConfirmedCrossSurfaceEvent = { surface: "api_metered", claim_scope: "billing-confirmed-workflow-scoped", cost_source: "provider-reported", billing_model: "fixed-plan" };

  // GUARDRAIL: a GENERALIZED claim scope is not representable at all (D6).
  // @ts-expect-error "generalized" is not a claim scope
  const generalized: StandardCrossSurfaceEvent = { surface: "cli", claim_scope: "generalized" };

  // GUARDRAIL: surface and provider enums are exact, a provider value is not a surface.
  // @ts-expect-error "chatgpt" is a provider, never a surface
  const providerAsSurface: CrossSurfaceEvent = { surface: "chatgpt" };

  void [
    meteredBillingConfirmed,
    cursorLocalEstimate,
    browserPlanEfficiency,
    browserBillingConfirmed,
    cursorBillingConfirmed,
    estimateRelabeled,
    planEfficiencyBillingConfirmed,
    planEfficiencyConfirmed,
    fixedPlanBillingConfirmed,
    generalized,
    providerAsSurface
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

describe("validator: fixed-plan is NEVER billing-confirmed", () => {
  it("rejects a cursor event claiming billing-confirmed", () => {
    const { problems } = validateCrossSurfaceEvent({
      surface: "cursor",
      claim_scope: "billing-confirmed-workflow-scoped",
      cost_source: "operator-entered"
    });
    expect(problems.some((p) => p.includes('only possible on surface "api_metered"'))).toBe(true);
  });

  it("rejects a browser_extension event claiming billing-confirmed", () => {
    const { problems } = validateCrossSurfaceEvent({
      surface: "browser_extension",
      claim_scope: "billing-confirmed-workflow-scoped",
      cost_source: "provider-reported"
    });
    expect(problems.some((p) => p.includes('only possible on surface "api_metered"'))).toBe(true);
  });

  it("rejects billing-confirmed with a local-estimate cost source (estimate relabeled)", () => {
    const { problems } = validateCrossSurfaceEvent({
      surface: "api_metered",
      claim_scope: "billing-confirmed-workflow-scoped",
      cost_source: "local-estimate"
    });
    expect(problems.some((p) => p.includes("requires provider-reported or operator-entered cost"))).toBe(true);
  });

  it("rejects billing-confirmed on an explicitly fixed-plan event even on api_metered", () => {
    const { problems } = validateCrossSurfaceEvent({
      surface: "api_metered",
      claim_scope: "billing-confirmed-workflow-scoped",
      cost_source: "operator-entered",
      billing_model: "fixed-plan"
    });
    expect(problems.some((p) => p.includes("can NEVER be billing-confirmed"))).toBe(true);
  });

  it("rejects billing-confirmed on an event carrying plan-efficiency signals", () => {
    const { problems } = validateCrossSurfaceEvent({
      surface: "api_metered",
      claim_scope: "billing-confirmed-workflow-scoped",
      cost_source: "provider-reported",
      plan_efficiency: { evidence_type: "plan-efficiency", billing_confirmed: false }
    });
    expect(problems.some((p) => p.includes("can NEVER be billing-confirmed"))).toBe(true);
  });

  it("rejects plan_efficiency.billing_confirmed !== false on unknown data", () => {
    const { problems } = validateCrossSurfaceEvent({
      surface: "browser_extension",
      plan_efficiency: { evidence_type: "plan-efficiency", billing_confirmed: true }
    });
    expect(problems.some((p) => p.includes("plan_efficiency.billing_confirmed"))).toBe(true);
  });

  it("rejects an evidence_level that SAYS billing-confirmed on a fixed-plan surface", () => {
    const { problems } = validateCrossSurfaceEvent({
      surface: "cursor",
      evidence_level: "billing-confirmed savings"
    });
    expect(problems.some((p) => p.startsWith("evidence_level:"))).toBe(true);
  });

  it("accepts the honest billing-confirmed event: api_metered + operator-entered, workflow-scoped", () => {
    const { problems } = validateCrossSurfaceEvent({
      surface: "api_metered",
      claim_scope: "billing-confirmed-workflow-scoped",
      cost_source: "operator-entered",
      workflow_id: "wf-1"
    });
    expect(problems).toEqual([]);
  });

  it("accepts an honest fixed-plan plan-efficiency event (no billing claim anywhere)", () => {
    const { problems } = validateCrossSurfaceEvent({
      surface: "browser_extension",
      provider: "chatgpt",
      billing_model: "fixed-plan",
      claim_scope: "conditions-scoped",
      plan_efficiency: { evidence_type: "plan-efficiency", billing_confirmed: false }
    });
    expect(problems).toEqual([]);
  });
});

describe("validator: tier ceilings - cursor and browser events never carry provider-reported tokens (D3/D4)", () => {
  it.each(NEVER_PROVIDER_REPORTED_SURFACES)("rejects provider-reported input tokens on %s", (surface) => {
    const { problems } = validateCrossSurfaceEvent({
      surface,
      token_source: {
        input: { source: "provider-reported" },
        output: { source: "unavailable", unavailable_reason: "no provider usage on this surface" }
      }
    });
    expect(problems.some((p) => p.includes("can never be provider-reported"))).toBe(true);
  });

  it.each(NEVER_PROVIDER_REPORTED_SURFACES)("rejects provider-reported output tokens on %s", (surface) => {
    const { problems } = validateCrossSurfaceEvent({
      surface,
      token_source: {
        input: { source: "local-estimate" },
        output: { source: "provider-reported" }
      }
    });
    expect(problems.some((p) => p.includes("token_source.output.source") && p.includes("can never be provider-reported"))).toBe(true);
  });

  it("allows provider-reported tokens on claude_code / codex / api_metered", () => {
    for (const surface of ["claude_code", "codex", "api_metered"] as const) {
      const { problems } = validateCrossSurfaceEvent({
        surface,
        input_before: 1200,
        token_source: { input: { source: "provider-reported" }, output: { source: "provider-reported" } }
      });
      expect(problems).toEqual([]);
    }
  });
});

describe("validator: no silent zero + per-axis unavailable_reason", () => {
  it("rejects a numeric count (including 0) on an unavailable axis - never a silent zero", () => {
    const { problems } = validateCrossSurfaceEvent({
      surface: "cursor",
      output_before: 0,
      token_source: {
        input: { source: "local-estimate" },
        output: { source: "unavailable", unavailable_reason: "output not safely separable" }
      }
    });
    expect(problems.some((p) => p.includes("no silent zero"))).toBe(true);
  });

  it("accepts an unavailable axis whose counts are absent or null", () => {
    const { problems } = validateCrossSurfaceEvent({
      surface: "cursor",
      input_before: 800,
      output_before: null,
      token_source: {
        input: { source: "local-estimate" },
        output: { source: "unavailable", unavailable_reason: "output not safely separable" }
      }
    });
    expect(problems).toEqual([]);
  });

  it("requires unavailable_reason per axis when that axis is unavailable", () => {
    const { problems } = validateCrossSurfaceEvent({
      surface: "cli",
      token_source: { input: { source: "unavailable" }, output: { source: "unavailable" } }
    });
    expect(problems.some((p) => p.includes("token_source.input.unavailable_reason"))).toBe(true);
    expect(problems.some((p) => p.includes("token_source.output.unavailable_reason"))).toBe(true);
  });

  it("requires cost_unavailable_reason when cost_source is unavailable", () => {
    const { problems } = validateCrossSurfaceEvent({ surface: "cli", cost_source: "unavailable" });
    expect(problems.some((p) => p.includes("cost_unavailable_reason"))).toBe(true);
  });

  it("rejects a numeric count with no token_source axis to label it", () => {
    const { problems } = validateCrossSurfaceEvent({ surface: "cli", input_before: 400 });
    expect(problems.some((p) => p.includes("requires token_source"))).toBe(true);
  });
});

describe("validator: exact enums", () => {
  it("accepts every contract surface and provider value exactly", () => {
    for (const surface of CROSS_SURFACE_SURFACES) {
      expect(validateCrossSurfaceEvent({ surface }).problems).toEqual([]);
    }
    for (const provider of CROSS_SURFACE_PROVIDERS) {
      expect(validateCrossSurfaceEvent({ surface: "cli", provider }).problems).toEqual([]);
    }
  });

  it("rejects near-miss surface values (dash spelling, tool names, provider values)", () => {
    for (const wrong of ["claude-code", "browser", "chatgpt-web", "chatgpt", "openai_agents", "CLI", ""]) {
      const { problems } = validateCrossSurfaceEvent({ surface: wrong });
      expect(problems.some((p) => p.startsWith("surface:")), `surface "${wrong}" should be rejected`).toBe(true);
    }
  });

  it("rejects near-miss provider / cost_source / claim_scope values", () => {
    expect(validateCrossSurfaceEvent({ surface: "cli", provider: "OpenAI" }).problems.some((p) => p.startsWith("provider:"))).toBe(true);
    expect(
      validateCrossSurfaceEvent({ surface: "cli", cost_source: "billing-confirmed" }).problems.some((p) => p.startsWith("cost_source:"))
    ).toBe(true);
    expect(
      validateCrossSurfaceEvent({ surface: "cli", claim_scope: "generalized" }).problems.some((p) => p.startsWith("claim_scope:"))
    ).toBe(true);
  });

  it("keeps the enum constants aligned with the contract doc values", () => {
    expect([...CROSS_SURFACE_SURFACES]).toEqual(["cli", "claude_code", "codex", "cursor", "browser_extension", "api_metered"]);
    expect([...CROSS_SURFACE_PROVIDERS]).toEqual(["anthropic", "openai", "cursor", "chatgpt", "other"]);
    expect([...CROSS_SURFACE_COST_SOURCES]).toEqual(["provider-reported", "operator-entered", "local-estimate", "unavailable"]);
    expect([...CROSS_SURFACE_CLAIM_SCOPES]).toContain("billing-confirmed-workflow-scoped");
    expect(CROSS_SURFACE_CLAIM_SCOPES).not.toContain("generalized");
  });
});

describe("validator is report-only and never throws", () => {
  it.each([null, undefined, 42, "event", [], { surface: 7 }, { surface: "cursor", token_source: "provider-reported" }])(
    "returns problems (never throws) for malformed input %#",
    (input) => {
      const result = validateCrossSurfaceEvent(input);
      expect(Array.isArray(result.problems)).toBe(true);
      expect(result.problems.length).toBeGreaterThan(0);
    }
  );
});

describe("surfaceForToolName maps the existing wire enum honestly", () => {
  it("maps known tools and never guesses for openai-agents", () => {
    expect(surfaceForToolName("claude-code")).toBe("claude_code");
    expect(surfaceForToolName("codex")).toBe("codex");
    expect(surfaceForToolName("cursor")).toBe("cursor");
    expect(surfaceForToolName("other")).toBe("cli");
    expect(surfaceForToolName("openai-agents")).toBeUndefined();
  });
});

describe("backward compatibility: local-run-record carries the optional event untouched", () => {
  let recordsDir: string;
  let artifactsDir: string;

  afterEach(async () => {
    if (recordsDir !== undefined) await rm(recordsDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    if (artifactsDir !== undefined) await rm(artifactsDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  const tokenReport: RunFlowTokenReport = {
    tool: "cursor",
    input_token_source: "local-estimate",
    output_token_source: "unavailable",
    input_tokens: 900,
    input_reduction_label: "estimated",
    notes: ["output not safely separable"]
  };

  it("round-trips a record WITH a cross_surface_event through write and read", async () => {
    recordsDir = await mkdtemp(join(tmpdir(), "xse-records-"));
    artifactsDir = await mkdtemp(join(tmpdir(), "xse-artifacts-"));
    const event: CrossSurfaceEvent = {
      surface: "cursor",
      provider: "cursor",
      claim_scope: "run-scoped",
      token_source: {
        input: { source: "local-estimate" },
        output: { source: "unavailable", unavailable_reason: "output not safely separable" }
      }
    };
    const record = buildLocalRunTokenRecord({ runId: "run-xse-1", tokenReport, crossSurfaceEvent: event });
    await writeLocalRunTokenRecord(record, artifactsDir, recordsDir);
    const { records, skipped } = await readLocalRunTokenRecords(recordsDir);
    expect(skipped).toEqual([]);
    expect(records).toHaveLength(1);
    expect(records[0]?.record.cross_surface_event).toEqual(event);
    // The embedded token report is byte-identical semantics - the existing shape is unchanged.
    expect(records[0]?.record.token_report).toEqual(tokenReport);
  });

  it("records WITHOUT the new field validate exactly as before (no migration)", () => {
    const legacy = buildLocalRunTokenRecord({ runId: "run-legacy", tokenReport });
    expect("cross_surface_event" in legacy).toBe(false);
    const { record, reason } = validateLocalRunTokenRecord(JSON.parse(JSON.stringify(legacy)) as unknown);
    expect(reason).toBeUndefined();
    expect(record?.run_id).toBe("run-legacy");
  });

  it("an imperfect cross_surface_event never causes the RECORD to be skipped (report-only)", () => {
    const withBadEvent = {
      ...buildLocalRunTokenRecord({ runId: "run-bad-event", tokenReport }),
      cross_surface_event: { surface: "not-a-surface" }
    };
    const { record, reason } = validateLocalRunTokenRecord(JSON.parse(JSON.stringify(withBadEvent)) as unknown);
    expect(reason).toBeUndefined();
    expect(record?.run_id).toBe("run-bad-event");
    // …while the report-only cross-surface validator names the problem separately.
    expect(validateCrossSurfaceEvent(withBadEvent.cross_surface_event).problems.length).toBeGreaterThan(0);
  });
});

describe("buildCursorRunCrossSurfaceEvent - the first cross_surface_event writer (Cursor D3)", () => {
  const bothAvailable: RunFlowTokenReport = {
    tool: "cursor",
    input_token_source: "local-estimate",
    output_token_source: "local-estimate",
    input_tokens: 12,
    output_tokens: 34,
    input_reduction_label: "estimated",
    notes: ["Cursor CLI emits no provider usage; tokens are LOCAL-ESTIMATE only (chars/4)."]
  };
  const bothUnavailable: RunFlowTokenReport = {
    tool: "cursor",
    input_token_source: "unavailable",
    output_token_source: "unavailable",
    input_reduction_label: "estimated",
    notes: []
  };

  it("builds a cursor/cursor run-scoped event with per-axis local-estimate sources that validates CLEAN", () => {
    const event = buildCursorRunCrossSurfaceEvent({ runId: "run-d3-1", tokenReport: bothAvailable });
    expect(event.surface).toBe("cursor");
    expect(event.provider).toBe("cursor");
    expect(event.model_label).toBe("unknown"); // unknown stays unknown - never inferred
    expect(event.run_id).toBe("run-d3-1");
    expect(event.claim_scope).toBe("run-scoped");
    expect(event.token_source).toEqual({ input: { source: "local-estimate" }, output: { source: "local-estimate" } });
    // Available axes carry the honest counts: captured input as input_before, output as an ESTIMATE.
    expect(event.input_before).toBe(12);
    expect(event.output_estimate).toBe(34);
    expect(validateCrossSurfaceEvent(event).problems).toEqual([]);
  });

  it("unavailable axes carry the TRUE per-run reason and NO count (never a silent zero); still validates clean", () => {
    const event = buildCursorRunCrossSurfaceEvent({
      runId: "run-d3-2",
      tokenReport: bothUnavailable,
      reasons: {
        input: "a saved Cursor export does not contain the prompt, and no invocation was declared after --",
        output: "the Cursor headless output is empty (no output was captured/saved - nothing to count)"
      }
    });
    expect(event.token_source?.input).toEqual({
      source: "unavailable",
      unavailable_reason: "a saved Cursor export does not contain the prompt, and no invocation was declared after --"
    });
    expect(event.token_source?.output).toEqual({
      source: "unavailable",
      unavailable_reason: "the Cursor headless output is empty (no output was captured/saved - nothing to count)"
    });
    expect(event.input_before).toBeUndefined();
    expect(event.output_estimate).toBeUndefined();
    expect(validateCrossSurfaceEvent(event).problems).toEqual([]);
  });

  it("falls back to the generic honest reason when an unavailable axis arrives without one (validator still clean)", () => {
    const event = buildCursorRunCrossSurfaceEvent({ runId: "run-d3-3", tokenReport: bothUnavailable });
    expect(event.token_source?.input?.unavailable_reason).toBe("not safely separable / not reported");
    expect(event.token_source?.output?.unavailable_reason).toBe("not safely separable / not reported");
    expect(validateCrossSurfaceEvent(event).problems).toEqual([]);
  });

  it("cost is UNAVAILABLE with the exact reason (Cursor emits no cost data); caveats carry the report notes", () => {
    const event = buildCursorRunCrossSurfaceEvent({ runId: "run-d3-4", tokenReport: bothAvailable });
    expect(event.cost_source).toBe("unavailable");
    expect(event.cost_unavailable_reason).toBe("Cursor emits no usage or cost data; no cost figure exists for this run");
    expect(event.caveats).toEqual(bothAvailable.notes);
  });

  it("NEVER relabels: a (wrong) provider-reported source passes through and the validator REJECTS it", () => {
    const wrong: RunFlowTokenReport = { ...bothAvailable, input_token_source: "provider-reported" };
    const event = buildCursorRunCrossSurfaceEvent({ runId: "run-d3-5", tokenReport: wrong });
    // The builder does not launder the label…
    expect(event.token_source?.input?.source).toBe("provider-reported");
    // …the report-only validator names the D3 tier-ceiling violation.
    const { problems } = validateCrossSurfaceEvent(event);
    expect(problems.some((p) => p.includes('surface "cursor" can never be provider-reported'))).toBe(true);
  });

  it("is a thin delegate: identical output to the generalized builder with the cursor constraints", () => {
    const params = { runId: "run-d3-6", tokenReport: bothAvailable };
    expect(buildCursorRunCrossSurfaceEvent(params)).toEqual(buildRunCrossSurfaceEvent("cursor", params));
  });
});

describe("buildRunCrossSurfaceEvent - codex + cli writers complete the run surfaces (#582 residual #5)", () => {
  const codexReport: RunFlowTokenReport = {
    tool: "codex",
    input_token_source: "provider-reported",
    output_token_source: "provider-reported",
    input_tokens: 1500,
    output_tokens: 420,
    input_reduction_label: "measured",
    notes: ["Token usage is provider-reported from codex exec turn.completed.usage events."]
  };
  const cliReport: RunFlowTokenReport = {
    tool: "command",
    input_token_source: "local-estimate",
    output_token_source: "unavailable",
    input_tokens: 240,
    input_reduction_label: "estimated",
    notes: [
      "Bare `run -- <cmd>` wraps an arbitrary command with no provider usage; input is a local chars/4 estimate.",
      "Output tokens are unavailable: a raw command's captured stdout/stderr is not safely separable as genuine model output."
    ]
  };

  it("codex: openai provider, provider-reported axes copied VERBATIM, output as a COUNT (output_before); validates clean", () => {
    const event = buildRunCrossSurfaceEvent("codex", { runId: "codex-1", tokenReport: codexReport });
    expect(event.surface).toBe("codex");
    expect(event.provider).toBe("openai");
    expect(event.claim_scope).toBe("run-scoped");
    expect(event.run_id).toBe("codex-1");
    // VERBATIM copy of the report's per-axis sources - never laundered up or down.
    expect(event.token_source?.input?.source).toBe(codexReport.input_token_source);
    expect(event.token_source?.output?.source).toBe(codexReport.output_token_source);
    // A provider-reported output is a COUNT (output_before), not an estimate.
    expect(event.input_before).toBe(1500);
    expect(event.output_before).toBe(420);
    expect(event.output_estimate).toBeUndefined();
    // No billing data exists on the codex run path - cost is UNAVAILABLE with the exact reason.
    expect(event.cost_source).toBe("unavailable");
    expect(event.cost_unavailable_reason).toContain("no cost or billing figure");
    expect(event.caveats).toEqual(codexReport.notes);
    expect(validateCrossSurfaceEvent(event).problems).toEqual([]);
  });

  it("codex: model_label carries the honestly-known model when given, else the canonical unknown", () => {
    const withModel = buildRunCrossSurfaceEvent("codex", { runId: "codex-2", tokenReport: codexReport, modelLabel: "gpt-5.2-codex" });
    expect(withModel.model_label).toBe("gpt-5.2-codex");
    const without = buildRunCrossSurfaceEvent("codex", { runId: "codex-3", tokenReport: codexReport });
    expect(without.model_label).toBe("unknown");
  });

  it("cli: provider other, input LOCAL-ESTIMATE with input_before, output UNAVAILABLE with the exact reason and NO count", () => {
    const event = buildRunCrossSurfaceEvent("cli", {
      runId: "cmd-1",
      tokenReport: cliReport,
      reasons: { output: "a raw command's captured stdout/stderr is not safely separable as genuine model output" }
    });
    expect(event.surface).toBe("cli");
    expect(event.provider).toBe("other");
    expect(event.model_label).toBe("unknown"); // a bare wrapped command has no honestly-known model
    expect(event.token_source?.input).toEqual({ source: "local-estimate" });
    expect(event.input_before).toBe(240);
    expect(event.token_source?.output).toEqual({
      source: "unavailable",
      unavailable_reason: "a raw command's captured stdout/stderr is not safely separable as genuine model output"
    });
    // An unavailable axis carries NO count - never a silent zero.
    expect(event.output_before).toBeUndefined();
    expect(event.output_estimate).toBeUndefined();
    expect(event.cost_source).toBe("unavailable");
    expect(event.cost_unavailable_reason).toContain("no provider usage or billing surface");
    expect(validateCrossSurfaceEvent(event).problems).toEqual([]);
  });

  it("FORGED: a codex event relabeled billing-confirmed is REJECTED (surface is not api_metered)", () => {
    const event = buildRunCrossSurfaceEvent("codex", { runId: "codex-4", tokenReport: codexReport });
    const forged = { ...JSON.parse(JSON.stringify(event)), claim_scope: "billing-confirmed-workflow-scoped" } as unknown;
    const { problems } = validateCrossSurfaceEvent(forged);
    expect(problems.some((p) => p.includes('only possible on surface "api_metered"'))).toBe(true);
    // …and the honest cost source alone can't underwrite it either.
    expect(problems.some((p) => p.includes("requires provider-reported or operator-entered cost"))).toBe(true);
  });

  it("FORGED: a cli event given a numeric count on its unavailable output axis is REJECTED (no silent zero)", () => {
    const event = buildRunCrossSurfaceEvent("cli", { runId: "cmd-2", tokenReport: cliReport });
    const forged = { ...JSON.parse(JSON.stringify(event)), output_before: 0 } as unknown;
    const { problems } = validateCrossSurfaceEvent(forged);
    expect(problems.some((p) => p.includes("no silent zero"))).toBe(true);
  });

  it("the surface spec table stays exact: codex/openai, cursor/cursor, cli/other, claude_code/anthropic", () => {
    expect(RUN_RECORD_EVENT_SURFACES.codex.surface).toBe("codex");
    expect(RUN_RECORD_EVENT_SURFACES.codex.provider).toBe("openai");
    expect(RUN_RECORD_EVENT_SURFACES.cursor.surface).toBe("cursor");
    expect(RUN_RECORD_EVENT_SURFACES.cursor.provider).toBe("cursor");
    expect(RUN_RECORD_EVENT_SURFACES.cli.surface).toBe("cli");
    expect(RUN_RECORD_EVENT_SURFACES.cli.provider).toBe("other");
    // The always-on `capture claude-code --from-hook` path writes a
    // metrics-only activity event via this builder - provider-reported tokens (the session's OWN usage
    // metadata), never invented evidence. Provider is anthropic.
    expect(RUN_RECORD_EVENT_SURFACES.claude_code.surface).toBe("claude_code");
    expect(RUN_RECORD_EVENT_SURFACES.claude_code.provider).toBe("anthropic");
  });
});
