/**
 * Additive activity extension of the cross-surface event. Extends the existing event union by
 * intersection so `cross-surface-event.ts` (the typed contract) stays untouched, same arms, same
 * guardrails, plus optional activity fields.
 *
 * Invariants:
 * - Auto-apply is opt-in only: `applied_automatically: true` is representable only with the
 *   explicit `"auto-when-gates-pass"` preference, `eligible: true`, and a non-empty
 *   `gates_passed`. Under the default `"ask-each-time"` it is a type error and a validator problem.
 * - `recovery` carries a content-free path/pointer to the retained original, never content.
 * - `sync_status` defaults to `local-only`; nothing syncs without explicit configuration.
 * - `activity_event_id` is deterministic and content-free (sha-256 over the canonicalized
 *   metrics-only fields), the dedupe key of the local activity store.
 */
import { createHash } from "node:crypto";
import {
  validateCrossSurfaceEvent,
  type CrossSurfaceEvent
} from "./cross-surface-event.js";

/** Whether/how the user approved what Compaction did on this run (exact values). */
export const ACTIVITY_APPROVAL_STATUSES = [
  "not-required",
  "asked-approved",
  "asked-declined",
  "auto-applied-by-policy",
  "not-asked"
] as const;
export type ActivityApprovalStatus = (typeof ACTIVITY_APPROVAL_STATUSES)[number];

/**
 * The binary auto-apply preference. `"ask-each-time"` is the default; `"auto-when-gates-pass"`
 * is only ever an explicit prior user opt-in. No preference storage exists in this module.
 */
export const AUTO_APPLY_PREFERENCES = ["ask-each-time", "auto-when-gates-pass"] as const;
export type AutoApplyPreference = (typeof AUTO_APPLY_PREFERENCES)[number];

/** Sync status. `local-only` is the default: nothing syncs without explicit config. */
export const ACTIVITY_SYNC_STATUSES = ["local-only", "metrics-synced", "hosted-private"] as const;
export type ActivitySyncStatus = (typeof ACTIVITY_SYNC_STATUSES)[number];
export const DEFAULT_ACTIVITY_SYNC_STATUS: ActivitySyncStatus = "local-only";

/** The not-applied arm: any preference, any eligibility, `applied_automatically` literally `false`. */
export interface AutoApplyNotApplied {
  /** Whether this run's change would even be a candidate for auto-apply (capability, not consent). */
  eligible: boolean;
  /** The user's stored binary preference. Default (and only honest value without stored opt-in): "ask-each-time". */
  preference: AutoApplyPreference;
  applied_automatically: false;
  /** Content-free gate identifiers (e.g. "recoverability-pass"), when gates were evaluated. */
  gates_passed?: string[];
  gates_failed?: string[];
}

/**
 * The applied arm. Structurally opt-in only: requires the explicit `"auto-when-gates-pass"`
 * preference, `eligible: true`, and a non-empty `gates_passed` tuple, the opt-in rule is a
 * type-system fact, not a convention.
 */
export interface AutoApplyApplied {
  eligible: true;
  preference: "auto-when-gates-pass";
  applied_automatically: true;
  /** Non-empty BY TYPE: an auto-apply with zero passed gates is unrepresentable. */
  gates_passed: [string, ...string[]];
  gates_failed?: string[];
}

export type ActivityAutoApply = AutoApplyNotApplied | AutoApplyApplied;

/** Whether the original was retained, and where (path/pointer, never content). */
export interface ActivityRecovery {
  original_retained: boolean;
  /** Content-free location of the retained original (a filesystem path or artifact pointer). */
  location?: string;
}

/** The additive activity fields. ALL optional on the event type (the STORE requires id + sync). */
export interface ActivityExtension {
  /** Deterministic content-free id, `act-` + 24 hex chars of sha-256 over the canonical event. */
  activity_event_id?: string;
  approval_status?: ActivityApprovalStatus;
  auto_apply?: ActivityAutoApply;
  recovery?: ActivityRecovery;
  /** Default: "local-only" (applied by the store when absent). */
  sync_status?: ActivitySyncStatus;
}

/**
 * One metrics-only activity event = the existing cross-surface event (same arms and guardrails -
 * the intersection distributes over the union) + the activity fields.
 */
export type ActivityEvent = CrossSurfaceEvent & ActivityExtension;

/* ------------------------------------------------------------------------------------------------
 * Compile-time structural guards (checked by `npm run typecheck`): if a refactor ever loosens the
 * auto-apply union so "applied automatically" could ride on the default preference, no consent,
 * or zero passed gates, tsc fails the build.
 * ---------------------------------------------------------------------------------------------- */
type Assert<T extends true> = T;
type AutoApplyAppliedArm = Extract<ActivityAutoApply, { applied_automatically: true }>;
/** The applied arm exists (so the guards below can never pass vacuously via `never`). */
export type StructuralGuard_AppliedArmExists = Assert<[AutoApplyAppliedArm] extends [never] ? false : true>;
/** Auto-apply is opt-in ONLY: the applied arm can only carry the explicit opt-in preference. */
export type StructuralGuard_AppliedRequiresOptInPreference = Assert<
  AutoApplyAppliedArm["preference"] extends "auto-when-gates-pass" ? true : false
>;
/** The applied arm requires eligibility. */
export type StructuralGuard_AppliedRequiresEligible = Assert<AutoApplyAppliedArm["eligible"] extends true ? true : false>;
/** The applied arm requires a NON-EMPTY gates_passed (an empty tuple is unrepresentable). */
export type StructuralGuard_AppliedRequiresNonEmptyGates = Assert<
  AutoApplyAppliedArm["gates_passed"] extends [string, ...string[]] ? true : false
>;
/** "Applied automatically under ask-each-time" is not a representable state at all. */
export type StructuralGuard_NoAutoApplyUnderAskEachTime = Assert<
  [Extract<ActivityAutoApply, { applied_automatically: true; preference: "ask-each-time" }>] extends [never]
    ? true
    : false
>;

/* ------------------------------------------------------------------------------------------------
 * Deterministic content-free id.
 * ---------------------------------------------------------------------------------------------- */

export const ACTIVITY_EVENT_ID_PATTERN = /^act-[0-9a-f]{24}$/;

/** Canonicalize: drop undefined, sort object keys recursively, same event, same bytes, same id. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, canonicalize(entry)])
    );
  }
  return value;
}

/**
 * Compute the deterministic content-free id: sha-256 over the canonicalized event EXCLUDING any
 * existing `activity_event_id` (so recomputing on a stored event reproduces the same id). The id
 * is derived only from the metrics-only fields the event already carries, no randomness, no
 * clock, no content.
 */
export function computeActivityEventId(event: CrossSurfaceEvent & ActivityExtension): string {
  const { activity_event_id: _existing, ...rest } = event;
  const digest = createHash("sha256").update(JSON.stringify(canonicalize(rest))).digest("hex");
  return `act-${digest.slice(0, 24)}`;
}

/* ------------------------------------------------------------------------------------------------
 * Report-only validator (mirrors `validateCrossSurfaceEvent`: returns problems, never throws).
 * Enforces on parsed/unknown data exactly what the type system enforces on constructed data.
 * ---------------------------------------------------------------------------------------------- */

export interface ActivityEventValidation {
  problems: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOneOf(value: unknown, allowed: readonly string[]): boolean {
  return typeof value === "string" && allowed.includes(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.trim() !== "");
}

function validateAutoApply(value: unknown, problems: string[]): void {
  if (value === undefined) return;
  if (!isPlainObject(value)) {
    problems.push("auto_apply: must be an object ({ eligible, preference, applied_automatically, gates_* })");
    return;
  }
  if (typeof value.eligible !== "boolean") problems.push("auto_apply.eligible: must be a boolean");
  if (!isOneOf(value.preference, AUTO_APPLY_PREFERENCES)) {
    problems.push(`auto_apply.preference: must be one of ${AUTO_APPLY_PREFERENCES.join(" | ")} (exact)`);
  }
  if (typeof value.applied_automatically !== "boolean") {
    problems.push("auto_apply.applied_automatically: must be a boolean");
  }
  for (const field of ["gates_passed", "gates_failed"] as const) {
    if (value[field] !== undefined && !isStringArray(value[field])) {
      problems.push(`auto_apply.${field}: must be an array of non-empty content-free gate identifiers`);
    }
  }
  // OFF-BY-DEFAULT rules (mirror of the type-level arm) - auto-apply is opt-in + gated, always.
  if (value.applied_automatically === true) {
    if (value.preference !== "auto-when-gates-pass") {
      problems.push(
        'auto_apply: applied_automatically=true under preference "ask-each-time" is invalid - auto-apply is OFF by default and only ever an explicit prior opt-in ("auto-when-gates-pass")'
      );
    }
    if (value.eligible !== true) {
      problems.push("auto_apply: applied_automatically=true requires eligible=true (an ineligible change can never be auto-applied)");
    }
    if (!isStringArray(value.gates_passed) || value.gates_passed.length === 0) {
      problems.push(
        "auto_apply: applied_automatically=true requires a NON-EMPTY gates_passed - an auto-apply with zero passed safety gates is invalid (fail-closed)"
      );
    }
  }
}

function validateRecovery(value: unknown, problems: string[]): void {
  if (value === undefined) return;
  if (!isPlainObject(value)) {
    problems.push("recovery: must be an object ({ original_retained, location? })");
    return;
  }
  if (typeof value.original_retained !== "boolean") {
    problems.push("recovery.original_retained: must be a boolean (honest - never assumed)");
  }
  if (value.location !== undefined) {
    if (typeof value.location !== "string" || value.location.trim() === "") {
      problems.push("recovery.location: must be a non-empty content-free path/pointer string when present");
    } else if (value.location.includes("\n")) {
      problems.push("recovery.location: must be a single-line path/pointer - multi-line values look like content, not a location");
    }
  }
}

/**
 * Validate one parsed/unknown activity event. Runs the cross-surface validator first (all its
 * rules stay binding), then the activity rules: exact enums; auto-apply off-by-default
 * (applied_automatically=true requires the opt-in preference, eligible=true, non-empty
 * gates_passed); recovery.location is a single-line content-free pointer; activity_event_id
 * matches the deterministic `act-<24 hex>` shape.
 */
export function validateActivityEvent(value: unknown): ActivityEventValidation {
  const problems = [...validateCrossSurfaceEvent(value).problems];
  if (!isPlainObject(value)) return { problems };
  const event = value;
  if (event.approval_status !== undefined && !isOneOf(event.approval_status, ACTIVITY_APPROVAL_STATUSES)) {
    problems.push(`approval_status: must be one of ${ACTIVITY_APPROVAL_STATUSES.join(" | ")} (exact)`);
  }
  if (event.sync_status !== undefined && !isOneOf(event.sync_status, ACTIVITY_SYNC_STATUSES)) {
    problems.push(`sync_status: must be one of ${ACTIVITY_SYNC_STATUSES.join(" | ")} (exact)`);
  }
  if (
    event.activity_event_id !== undefined &&
    (typeof event.activity_event_id !== "string" || !ACTIVITY_EVENT_ID_PATTERN.test(event.activity_event_id))
  ) {
    problems.push("activity_event_id: must match act-<24 hex chars> (the deterministic content-free id)");
  }
  validateAutoApply(event.auto_apply, problems);
  validateRecovery(event.recovery, problems);
  return { problems };
}

/**
 * Build the event for a measure-only `run` flow: it never modifies the session or applies
 * anything, so approval is "not-required", auto_apply is ineligible/default/not-applied, sync is
 * "local-only", and recovery points at the captured-trace artifact by path.
 */
export function buildMeasureOnlyActivityEvent(event: CrossSurfaceEvent, recovery: ActivityRecovery): ActivityEvent {
  const activity: ActivityEvent = {
    ...event,
    approval_status: "not-required",
    auto_apply: { eligible: false, preference: "ask-each-time", applied_automatically: false },
    recovery,
    sync_status: DEFAULT_ACTIVITY_SYNC_STATUS
  };
  return { ...activity, activity_event_id: computeActivityEventId(activity) };
}
