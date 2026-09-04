/**
 * Additive typed representation of the cross-surface evidence & reporting contract. One event model,
 * many surfaces: every surface reports the
 * same kind of event with different honest evidence tiers. This module is the contract/type level:
 *
 * - Additive: it does not change the existing `usage_event` wire shape (`src/core/capture-record.ts`), the
 *   local run record (`src/core/local-run-record.ts`), or any current writer/reader. No writer is required to
 *   populate these fields; the run local-run-record writers below are the first that do.
 * - The billing-confirmed guardrail is structural where TypeScript allows: `claim_scope:
 *   "billing-confirmed-workflow-scoped"` is only constructible on `surface: "api_metered"` with a
 *   provider-reported | operator-entered cost source, and a plan-efficiency payload excludes it
 *   (`plan_efficiency?: never` on that arm; `billing_confirmed: false` is a literal on the payload).
 * - Where the type system cannot enforce a rule on parsed/unknown data, the report-only validator
 *   `validateCrossSurfaceEvent` catches it: it returns problems and never throws.
 * - Per-axis `token_source` with `unavailable_reason` required when unavailable; never a silent
 *   zero (an unavailable axis carries no numeric count); input/output are independent axes; "generalized" is
 *   not a representable claim scope.
 *
 * Naming: contract `surface` values use underscores (`claude_code`); the wire `ToolName` enum uses dashes
 * (`claude-code`). `surfaceForToolName` maps between them without changing either.
 */
import type { ToolName } from "./api-client/index.js";
import type { RunFlowTokenReport } from "./run-flow-report.js";

/** Which Compaction surface produced the event (exact values, verbatim). */
export const CROSS_SURFACE_SURFACES = [
  "cli",
  "claude_code",
  "codex",
  "cursor",
  "browser_extension",
  "api_metered"
] as const;
export type CrossSurfaceSurface = (typeof CROSS_SURFACE_SURFACES)[number];

/** Whose model/service was used, distinct from `surface`. */
export const CROSS_SURFACE_PROVIDERS = ["anthropic", "openai", "cursor", "chatgpt", "other"] as const;
export type CrossSurfaceProvider = (typeof CROSS_SURFACE_PROVIDERS)[number];

/** Per-axis token source. Input and output are INDEPENDENT axes. */
export const CROSS_SURFACE_TOKEN_SOURCES = ["provider-reported", "local-estimate", "unavailable"] as const;
export type CrossSurfaceTokenSource = (typeof CROSS_SURFACE_TOKEN_SOURCES)[number];

/** How the cost figure (if any) is known. `operator-entered` is the billing-delta operator path. */
export const CROSS_SURFACE_COST_SOURCES = [
  "provider-reported",
  "operator-entered",
  "local-estimate",
  "unavailable"
] as const;
export type CrossSurfaceCostSource = (typeof CROSS_SURFACE_COST_SOURCES)[number];

/** The ONLY cost sources that can underwrite a billing-confirmed figure. */
export type BillingConfirmedCostSource = "provider-reported" | "operator-entered";

/**
 * What a figure may be scoped to, this run / workflow / conditions. A generalized claim is intentionally not
 * representable. `billing-confirmed-workflow-scoped` exists only on `BillingConfirmedCrossSurfaceEvent`.
 */
export const CROSS_SURFACE_CLAIM_SCOPES = [
  "run-scoped",
  "workflow-scoped",
  "conditions-scoped",
  "billing-confirmed-workflow-scoped"
] as const;
export type CrossSurfaceClaimScope = (typeof CROSS_SURFACE_CLAIM_SCOPES)[number];
/** Every claim scope EXCEPT billing-confirmed, the only scopes a standard event may carry. */
export type NonBillingClaimScope = Exclude<CrossSurfaceClaimScope, "billing-confirmed-workflow-scoped">;

/** Accepted/reverted, reverts are honest signal, never hidden. */
export type CrossSurfaceAcceptance = "accepted" | "reverted";

/** Result of the applicable eval gate, or `not_evaluated` (never auto-certified). */
export type CrossSurfaceEvalStatus = "passed" | "failed" | "not_computed" | "not_evaluated";

/** How the underlying product is billed. `fixed-plan` marks quota/subscription billing (D5). */
export type CrossSurfaceBillingModel = "fixed-plan" | "metered" | "unknown";

/**
 * One token axis: its honest source, plus the EXACT reason (and optional rerun guidance) when the
 * axis is `unavailable`: field-level unavailable WITH the exact reason.
 */
export interface CrossSurfaceTokenAxis {
  source: CrossSurfaceTokenSource;
  /** REQUIRED (validator-enforced) when `source` is "unavailable", the exact honest reason. */
  unavailable_reason?: string;
}

/** Per-axis token sources. Neither axis ever inherits the other's tier. */
export interface CrossSurfaceTokenSources {
  input: CrossSurfaceTokenAxis;
  output: CrossSurfaceTokenAxis;
}

/**
 * Plan-efficiency, an evidence type for fixed-plan products (quota-extension). Defined only; no claim may be
 * made from it. `billing_confirmed` is the literal `false`: a plan-efficiency figure is structurally incapable
 * of being billing-confirmed, however strong the measurement.
 */
export interface PlanEfficiencySignals {
  evidence_type: "plan-efficiency";
  /** Literal `false`, a fixed-plan figure can never be billing-confirmed. */
  billing_confirmed: false;
  /** Identity of the quota window the signals were observed in (content-free). */
  quota_window_id?: string;
  /** More useful work per quota window. */
  tasks_completed_in_window?: number | null;
  /** Fewer / later cap events. */
  cap_events_in_window?: number | null;
  /** Fewer visible tokens per task, LOCAL-ESTIMATE per the tier table. */
  visible_tokens_per_task_estimate?: number | null;
  /** More successful tasks before reset. */
  successful_tasks_before_reset?: number | null;
}

/**
 * Fields shared by every event arm. ALL fields are optional/additive ("a surface
 * omits what it genuinely cannot observe, with a reason"), the discriminating fields live on the
 * arms below. Counts may be `null` to mean "explicitly not counted" (never rendered as 0).
 */
export interface CrossSurfaceEventCommon {
  /** Existing user/team model (paid reporting aggregates by these). Free/local may omit (no sync). */
  user_id?: string;
  team_id?: string;
  /** Whose model/service was used, e.g. surface `browser_extension` + provider `chatgpt`. */
  provider?: CrossSurfaceProvider;
  /** The model as honestly known, `unknown` stays `unknown`, never inferred. */
  model_label?: string;
  /** Identity for rollup and A/B comparability (billing-delta requires pinned workflow identity). */
  workflow_id?: string;
  session_id?: string;
  run_id?: string;
  /** Input tokens before/after Compaction acted, counted per `token_source.input`. */
  input_before?: number | null;
  input_after?: number | null;
  /** Output tokens before/after (or estimate), counted per `token_source.output`. */
  output_before?: number | null;
  output_after?: number | null;
  /** An estimate is an estimate and says so, it never upgrades the axis tier. */
  output_estimate?: number | null;
  /** Per-axis honest sources. A numeric count without a labeled axis is a validator problem. */
  token_source?: CrossSurfaceTokenSources;
  /** Which deterministic policy acted (content-free identifier). */
  policy_used?: string;
  /** Whether the user kept or reverted the optimization. */
  acceptance?: CrossSurfaceAcceptance;
  /** Result of the applicable recoverability eval gate, or `not_evaluated`. */
  recoverability?: CrossSurfaceEvalStatus;
  /** Result of the applicable output eval gate (short-but-sufficient), or `not_evaluated`. */
  eval_status?: CrossSurfaceEvalStatus;
  /** The exact honest label for this event's figures, never stronger than the sources support. */
  evidence_level?: string;
  /** Per-surface honesty caveats carried WITH the event, never stripped in rollup. */
  caveats?: string[];
  /** Exact reason when `cost_source` is "unavailable". */
  cost_unavailable_reason?: string;
}

/**
 * The standard event arm: any surface, any honest cost source, any NON-billing-confirmed claim
 * scope. Fixed-plan surfaces and plan-efficiency events live here, and ONLY here.
 */
export interface StandardCrossSurfaceEvent extends CrossSurfaceEventCommon {
  surface: CrossSurfaceSurface;
  billing_model?: CrossSurfaceBillingModel;
  cost_source?: CrossSurfaceCostSource;
  /** Structurally excludes "billing-confirmed-workflow-scoped" (D5/D6). */
  claim_scope?: NonBillingClaimScope;
  /** Plan-efficiency signals (fixed-plan quota-extension), never on the billing-confirmed arm. */
  plan_efficiency?: PlanEfficiencySignals;
}

/**
 * The only arm that can carry a billing-confirmed claim: `api_metered` surface, provider-reported or
 * operator-entered cost, workflow-scoped only. A plan-efficiency payload is unrepresentable here (`never`),
 * and `billing_model` can never be "fixed-plan".
 */
export interface BillingConfirmedCrossSurfaceEvent extends CrossSurfaceEventCommon {
  surface: "api_metered";
  claim_scope: "billing-confirmed-workflow-scoped";
  cost_source: BillingConfirmedCostSource;
  billing_model?: "metered";
  plan_efficiency?: never;
}

/**
 * The cross-surface event. A discriminated union: constructing a fixed-plan / non-metered /
 * plan-efficiency event with a billing-confirmed claim scope is a TYPE ERROR, not just a
 * validator problem.
 */
export type CrossSurfaceEvent = StandardCrossSurfaceEvent | BillingConfirmedCrossSurfaceEvent;

/* ------------------------------------------------------------------------------------------------
 * Compile-time structural guards. These are checked by `npm run typecheck` (part of `verify`):
 * if a refactor ever loosens the union so a billing-confirmed claim could ride on a non-metered
 * surface, a weaker cost source, or a plan-efficiency payload, `tsc` fails the build.
 * ---------------------------------------------------------------------------------------------- */
type Assert<T extends true> = T;
type BillingConfirmedArm = Extract<CrossSurfaceEvent, { claim_scope: "billing-confirmed-workflow-scoped" }>;
/** The billing-confirmed arm exists (so the guards below can never pass vacuously via `never`). */
export type StructuralGuard_BillingConfirmedArmExists = Assert<[BillingConfirmedArm] extends [never] ? false : true>;
/** A billing-confirmed claim can ONLY exist on the api_metered surface. */
export type StructuralGuard_BillingConfirmedRequiresMeteredSurface = Assert<
  BillingConfirmedArm["surface"] extends "api_metered" ? true : false
>;
/** A billing-confirmed claim can ONLY carry provider-reported | operator-entered cost. */
export type StructuralGuard_BillingConfirmedCostSource = Assert<
  BillingConfirmedArm["cost_source"] extends BillingConfirmedCostSource ? true : false
>;
/** A billing-confirmed event can NEVER carry a plan-efficiency payload. */
export type StructuralGuard_BillingConfirmedExcludesPlanEfficiency = Assert<
  Required<BillingConfirmedArm>["plan_efficiency"] extends never ? true : false
>;
/** A plan-efficiency payload is structurally incapable of claiming billing_confirmed. */
export type StructuralGuard_PlanEfficiencyNeverBillingConfirmed = Assert<
  PlanEfficiencySignals["billing_confirmed"] extends false ? true : false
>;
/** A billing-confirmed event can never be marked fixed-plan. */
export type StructuralGuard_BillingConfirmedNeverFixedPlan = Assert<
  Required<BillingConfirmedArm>["billing_model"] extends "metered" ? true : false
>;

/* ------------------------------------------------------------------------------------------------
 * Surfaces ↔ existing wire ToolName mapping (additive helper; changes neither enum).
 * ---------------------------------------------------------------------------------------------- */

/**
 * Map the wire `ToolName` to the contract `surface` value:
 * - `claude-code` → `claude_code`, `codex` → `codex`, `cursor` → `cursor`;
 * - `other` (the bare `compaction run -- <cmd>` wrapper) → `cli`;
 * - `openai-agents` → `undefined`: the contract names no surface for it, and this helper never guesses.
 */
export function surfaceForToolName(tool: ToolName): CrossSurfaceSurface | undefined {
  switch (tool) {
    case "claude-code":
      return "claude_code";
    case "codex":
      return "codex";
    case "cursor":
      return "cursor";
    case "other":
      return "cli";
    case "openai-agents":
      return undefined;
  }
}

/* ------------------------------------------------------------------------------------------------
 * REPORT-ONLY validator. Returns problems; never throws. It exists for the states TypeScript
 * cannot police (parsed JSON, widened objects, wire data) and encodes the contract's honesty
 * rules as label-correctness checks.
 * ---------------------------------------------------------------------------------------------- */

/**
 * Surfaces whose current Compaction integration can never label tokens provider-reported: the Cursor
 * reader does not ingest or attribute its conditional `result.usage`, and the browser's visible surface
 * exposes no provider usage.
 */
export const NEVER_PROVIDER_REPORTED_SURFACES: readonly CrossSurfaceSurface[] = ["cursor", "browser_extension"];

export interface CrossSurfaceEventValidation {
  /** Empty when the event honors the contract. Report-only: nothing throws, nothing exits. */
  problems: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOneOf(value: unknown, allowed: readonly string[]): boolean {
  return typeof value === "string" && allowed.includes(value);
}

function isNonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim() !== "";
}

/** A count field may be absent, `null` (explicitly not counted), or a finite number ≥ 0. */
function countProblem(field: string, value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return undefined;
  return `${field}: must be a finite number >= 0, null, or absent`;
}

const INPUT_COUNT_FIELDS = ["input_before", "input_after"] as const;
const OUTPUT_COUNT_FIELDS = ["output_before", "output_after", "output_estimate"] as const;

function validateAxis(
  axisName: "input" | "output",
  axis: unknown,
  event: Record<string, unknown>,
  problems: string[]
): void {
  const countFields = axisName === "input" ? INPUT_COUNT_FIELDS : OUTPUT_COUNT_FIELDS;
  if (!isPlainObject(axis)) {
    problems.push(`token_source.${axisName}: must be an object with a per-axis source`);
    return;
  }
  if (!isOneOf(axis.source, CROSS_SURFACE_TOKEN_SOURCES)) {
    problems.push(
      `token_source.${axisName}.source: must be one of ${CROSS_SURFACE_TOKEN_SOURCES.join(" | ")} (exact)`
    );
    return;
  }
  if (axis.source === "unavailable") {
    // Contract: field-level unavailable WITH the exact reason - required per axis.
    if (!isNonEmptyString(axis.unavailable_reason)) {
      problems.push(
        `token_source.${axisName}.unavailable_reason: required when the ${axisName} axis is unavailable (the exact honest reason)`
      );
    }
    // Contract: never a silent zero - an unavailable axis never carries a numeric count
    // (a 0 here would dress a missing count as a real one).
    for (const field of countFields) {
      if (typeof event[field] === "number") {
        problems.push(
          `${field}: no silent zero - the ${axisName} axis is unavailable, so a numeric count (including 0) must not be present`
        );
      }
    }
  }
}

/**
 * Validate one parsed/unknown cross-surface event against the contract. Report-only: returns the list of
 * problems (empty = contract-honest) and never throws. Rules enforced here are exactly the ones the type
 * system cannot enforce on unknown data:
 *
 * 1. exact enums for surface / provider / token sources / cost source / claim scope;
 * 2. a fixed-plan or plan-efficiency event is never billing-confirmed;
 * 3. billing-confirmed requires surface api_metered + provider-reported|operator-entered cost;
 * 4. tier table: cursor and browser_extension events never carry provider-reported tokens;
 * 5. no silent zero: an unavailable axis never carries a numeric count;
 * 6. per-axis unavailable_reason required when an axis is unavailable;
 * 7. a numeric count requires its axis to be labeled (a count without a token_source is unlabeled).
 */
export function validateCrossSurfaceEvent(value: unknown): CrossSurfaceEventValidation {
  const problems: string[] = [];
  if (!isPlainObject(value)) {
    return { problems: ["event: must be a JSON object"] };
  }
  const event = value;

  // Rule 1 - exact enums.
  if (!isOneOf(event.surface, CROSS_SURFACE_SURFACES)) {
    problems.push(`surface: must be one of ${CROSS_SURFACE_SURFACES.join(" | ")} (exact)`);
  }
  if (event.provider !== undefined && !isOneOf(event.provider, CROSS_SURFACE_PROVIDERS)) {
    problems.push(`provider: must be one of ${CROSS_SURFACE_PROVIDERS.join(" | ")} (exact)`);
  }
  if (event.cost_source !== undefined && !isOneOf(event.cost_source, CROSS_SURFACE_COST_SOURCES)) {
    problems.push(`cost_source: must be one of ${CROSS_SURFACE_COST_SOURCES.join(" | ")} (exact)`);
  }
  if (event.claim_scope !== undefined && !isOneOf(event.claim_scope, CROSS_SURFACE_CLAIM_SCOPES)) {
    problems.push(`claim_scope: must be one of ${CROSS_SURFACE_CLAIM_SCOPES.join(" | ")} (exact; generalized claims are not representable)`);
  }
  if (event.cost_source === "unavailable" && !isNonEmptyString(event.cost_unavailable_reason)) {
    problems.push("cost_unavailable_reason: required when cost_source is unavailable (the exact honest reason)");
  }

  // Count fields are well-formed (absent | null | finite >= 0).
  for (const field of [...INPUT_COUNT_FIELDS, ...OUTPUT_COUNT_FIELDS]) {
    const problem = countProblem(field, event[field]);
    if (problem !== undefined) problems.push(problem);
  }

  // Rules 5-6 - per-axis honesty; rule 7 - counts require a labeled axis.
  const tokenSource = event.token_source;
  if (tokenSource !== undefined) {
    if (!isPlainObject(tokenSource)) {
      problems.push("token_source: must be an object with input and output axes");
    } else {
      validateAxis("input", tokenSource.input, event, problems);
      validateAxis("output", tokenSource.output, event, problems);
    }
  } else {
    for (const field of [...INPUT_COUNT_FIELDS, ...OUTPUT_COUNT_FIELDS]) {
      if (typeof event[field] === "number") {
        problems.push(`${field}: a numeric count requires token_source for its axis - an unlabeled count is not honest`);
      }
    }
  }

  // Rule 4 - tier ceilings (D3/D4): cursor + browser events never carry provider-reported tokens.
  if (
    isOneOf(event.surface, NEVER_PROVIDER_REPORTED_SURFACES as readonly string[]) &&
    isPlainObject(tokenSource)
  ) {
    for (const axisName of ["input", "output"] as const) {
      const axis = tokenSource[axisName];
      if (isPlainObject(axis) && axis.source === "provider-reported") {
        problems.push(
          `token_source.${axisName}.source: surface "${String(event.surface)}" can never be provider-reported (the current Compaction ingestion contract has no attributable provider-usage provenance for this surface)`
        );
      }
    }
  }

  // Rules 2-3 - the D5/D6 guardrail on unknown data.
  const planEfficiency = event.plan_efficiency;
  if (planEfficiency !== undefined) {
    if (!isPlainObject(planEfficiency)) {
      problems.push("plan_efficiency: must be an object");
    } else {
      if (planEfficiency.evidence_type !== "plan-efficiency") {
        problems.push('plan_efficiency.evidence_type: must be the literal "plan-efficiency"');
      }
      if (planEfficiency.billing_confirmed !== false) {
        problems.push(
          "plan_efficiency.billing_confirmed: must be the literal false - a fixed-plan figure can NEVER be billing-confirmed"
        );
      }
    }
  }

  const claimsBillingConfirmed = event.claim_scope === "billing-confirmed-workflow-scoped";
  const isFixedPlanEvent =
    event.billing_model === "fixed-plan" ||
    planEfficiency !== undefined ||
    isOneOf(event.surface, NEVER_PROVIDER_REPORTED_SURFACES as readonly string[]);

  if (claimsBillingConfirmed) {
    if (event.surface !== "api_metered") {
      problems.push(
        `claim_scope: billing-confirmed is only possible on surface "api_metered" - surface "${String(event.surface)}" can never be billing-confirmed`
      );
    }
    if (event.cost_source !== "provider-reported" && event.cost_source !== "operator-entered") {
      problems.push(
        "cost_source: a billing-confirmed claim requires provider-reported or operator-entered cost - never a price-table/local estimate relabeled"
      );
    }
    if (event.billing_model === "fixed-plan" || planEfficiency !== undefined) {
      problems.push(
        "claim_scope: a fixed-plan / plan-efficiency event can NEVER be billing-confirmed"
      );
    }
  }

  // Defensive label rule: an evidence label that SAYS billing-confirmed on a fixed-plan event is
  // the exact overclaim D5 forbids, whatever the claim_scope field says.
  if (
    typeof event.evidence_level === "string" &&
    event.evidence_level.toLowerCase().includes("billing-confirmed") &&
    isFixedPlanEvent
  ) {
    problems.push(
      "evidence_level: mentions billing-confirmed on a fixed-plan / plan-efficiency / never-provider-reported event - labels must make this impossible"
    );
  }

  return { problems };
}

/* ------------------------------------------------------------------------------------------------
 * Run-record event builders - the writers of the additive `cross_surface_event` field on `run` local run
 * records (cursor / codex / cli / claude_code). Every writer populates the event from the SAME
 * `RunFlowTokenReport` the record already embeds, so the two can never diverge, and per-axis sources are
 * copied verbatim (the builder never launders labels).
 * ---------------------------------------------------------------------------------------------- */

/** Generic honest fallback when an unavailable axis arrives without its true per-run reason. */
const AXIS_UNAVAILABLE_FALLBACK = "not safely separable / not reported";

/** One axis derived from the token report. Never relabels: a wrongly provider-reported source on a
 *  never-provider-reported surface (e.g. Cursor) passes through so `validateCrossSurfaceEvent` flags it. */
function axisFromReport(source: RunFlowTokenReport["input_token_source"], reason?: string): CrossSurfaceTokenAxis {
  if (source === "unavailable") {
    return { source, unavailable_reason: reason ?? AXIS_UNAVAILABLE_FALLBACK };
  }
  return { source };
}

/**
 * Per-surface constraints for the `run` local-run-record writers:
 * - `codex` - provider `openai`; token axes provider-reported where a `turn.completed.usage` block existed.
 *   Codex reports tokens but no cost/billing figure → cost unavailable with that reason.
 * - `cursor` - provider `cursor`; local-estimate/unavailable only because Compaction does not ingest or
 *   attribute the CLI's conditional `result.usage`; no cost data.
 * - `cli` - bare `run -- <cmd>`: provider `other` (no observable provider); input is a local chars/4
 *   estimate, output is unavailable with the command-surface reason, no billing surface.
 * - `claude_code` - the `capture claude-code --from-hook` path; provider `anthropic`; token axes
 *   provider-reported where the session usage fields carried them (missing axis stays
 *   unavailable-with-reason, never a silent zero). Not invented evidence: the Stop-hook capture reads the
 *   session's own provider usage metadata. Cost is unavailable (tokens but no billing figure).
 */
export const RUN_RECORD_EVENT_SURFACES = {
  codex: {
    surface: "codex",
    provider: "openai",
    cost_unavailable_reason:
      "codex exec --json reports token usage (turn.completed.usage) but no cost or billing figure; no cost data exists on this path"
  },
  claude_code: {
    surface: "claude_code",
    provider: "anthropic",
    cost_unavailable_reason:
      "Claude Code session usage reports provider tokens (input/output) but no cost or billing figure; no cost data exists on this path"
  },
  cursor: {
    surface: "cursor",
    provider: "cursor",
    cost_unavailable_reason:
      "Compaction does not ingest Cursor's conditional result.usage, and no per-run cost or billing figure is available; no cost figure exists for this run"
  },
  cli: {
    surface: "cli",
    provider: "other",
    cost_unavailable_reason:
      "a bare wrapped command has no provider usage or billing surface; no cost figure exists for this run"
  }
} as const satisfies Record<
  string,
  { surface: CrossSurfaceSurface; provider: CrossSurfaceProvider; cost_unavailable_reason: string }
>;

export type RunRecordEventSurface = keyof typeof RUN_RECORD_EVENT_SURFACES;

export interface RunCrossSurfaceEventParams {
  runId: string;
  tokenReport: RunFlowTokenReport;
  /** TRUE per-axis unavailability reasons from the capture (required content for unavailable axes). */
  reasons?: { input?: string; output?: string };
  /** The model as the capture HONESTLY knows it. Omitted → "unknown" (unknown stays unknown, never inferred). */
  modelLabel?: string;
}

/**
 * Build the honest cross-surface event for one `run` local run record:
 * - `surface`/`provider` fixed per surface; `model_label` only as honestly known, else `"unknown"`;
 * - per-axis `token_source` copied verbatim from the token report (input/output independent), with the
 *   capture's true per-run reason on any unavailable axis (never a bare "unavailable");
 * - counts only on available axes: `input_before` for the input; a provider-reported output is a count
 *   (`output_before`), a local-estimate output is an estimate (`output_estimate`); an unavailable axis
 *   carries no count (never a silent zero);
 * - `cost_source: "unavailable"` with the exact per-surface reason; `claim_scope: "run-scoped"`; caveats =
 *   the report's notes.
 *
 * Tier ceilings stay intact: the builder never SETS provider-reported (only copies the report's label), so a
 * wrongly-labeled never-provider-reported surface passes through for the validator to reject.
 */
export function buildRunCrossSurfaceEvent(
  surfaceKey: RunRecordEventSurface,
  params: RunCrossSurfaceEventParams
): StandardCrossSurfaceEvent {
  const spec = RUN_RECORD_EVENT_SURFACES[surfaceKey];
  const report = params.tokenReport;
  const input = axisFromReport(report.input_token_source, params.reasons?.input);
  const output = axisFromReport(report.output_token_source, params.reasons?.output);
  return {
    surface: spec.surface,
    provider: spec.provider,
    model_label: params.modelLabel ?? "unknown",
    run_id: params.runId,
    token_source: { input, output },
    // Counts ride ONLY on an available axis (never a silent zero on an unavailable one).
    ...(input.source !== "unavailable" && report.input_tokens !== undefined ? { input_before: report.input_tokens } : {}),
    ...(output.source === "provider-reported" && report.output_tokens !== undefined
      ? { output_before: report.output_tokens }
      : {}),
    ...(output.source === "local-estimate" && report.output_tokens !== undefined
      ? { output_estimate: report.output_tokens }
      : {}),
    cost_source: "unavailable",
    cost_unavailable_reason: spec.cost_unavailable_reason,
    claim_scope: "run-scoped",
    caveats: [...report.notes]
  };
}

/**
 * The Cursor writer - kept as the named entry point its call/test sites use; a thin delegate to the
 * generalized builder with the `cursor` constraints (`surface: "cursor"`, `provider: "cursor"`, model
 * unknown - the tier ceiling stays intact).
 */
export function buildCursorRunCrossSurfaceEvent(params: {
  runId: string;
  tokenReport: RunFlowTokenReport;
  /** TRUE per-axis unavailability reasons from the capture (required content for unavailable axes). */
  reasons?: { input?: string; output?: string };
}): StandardCrossSurfaceEvent {
  return buildRunCrossSurfaceEvent("cursor", params);
}
