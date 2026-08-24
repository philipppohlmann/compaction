/**
 * LCM QUALIFIED-CLASS REGISTRY (PUBLIC CLI/SDK core, engine-free, content-free).
 *
 * Answers ONE question, fail-closed: has this workflow class passed the pre-registered LCM
 * evidence bar, so that an LCM apply candidate may even be CONSIDERED for it? The answer is
 * NO for every class, the registry is EMPTY BY CONSTRUCTION, on two independent rails:
 *
 *   1. EVIDENCE RAIL, a class counts as qualified only when accompanied by a VALID promotion
 *      evidence record: the content-free evidence document (`lcm-evidence-contract.ts`) with
 *      promotion outcome `promote_approval_gated_beta` under the frozen profile version, on
 *      real-local, live-verified evidence, every evaluated dimension `pass`, and exactly two
 *      distinct independent evidence runs. A fixture-sourced or `insufficient_evidence` record
 *      can NEVER qualify a class (the provenance union already makes fixture-as-live
 *      unrepresentable; this module re-checks it anyway). No such record exists: the current
 *      product decision is `insufficient_evidence` for every class.
 *   2. ACTIVATION RAIL (dormant-machinery rule), even a structurally perfect record must name
 *      an activation version present in `LCM_APPLY_ACTIVATION_VERSIONS`, which is EMPTY and may
 *      gain an entry ONLY through an explicit, human-approved, tested activation change that
 *      accompanies a real promotion (the operator evidence-execution path). Shipping this
 *      module activates nothing.
 *
 * A class is therefore NEVER added by editing a list: qualification is (valid real promotion
 * evidence record) AND (explicitly activated version), and both are absent today.
 *
 * CONTENT-FREE + ENGINE-FREE: this module imports no engine code, stores no thresholds, prompts,
 * rubrics, or candidate text, and every record it reads is re-scanned by the content scanner -
 * a content-shaped record is rejected, never surfaced.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  LCM_EVIDENCE_CONTRACT_VERSION,
  LCM_EVIDENCE_DIMENSIONS,
  scanContentFreeLcmEvidence,
  type ContentFreeLcmEvidence
} from "../lcm-evidence-contract.js";
import { REJECTED_GLOBAL_TOOL_VALUES } from "../policy-preferences.js";

/**
 * The content-free policy label an LCM application would run under. It exists so an LCM apply can
 * NEVER be recorded under the deterministic policy's name — receipts stay honest whichever rail
 * qualified the class.
 */
export const LCM_APPLY_POLICY = "lcm-context-optimize" as const;
export type LcmApplyPolicyName = typeof LCM_APPLY_POLICY;

/**
 * VERSIONED ACTIVATION WHITELIST, the dormant-machinery gate. EMPTY: no LCM apply activation
 * exists. An entry is added ONLY by an explicit, human-approved, tested activation change that
 * ships with a real, evidence-backed class promotion (never by a data file alone). While this
 * list is empty, `isClassQualifiedForLcmApply` is FALSE for every class regardless of any record
 * on disk.
 *
 * THAT IS A STATEMENT ABOUT THIS RAIL ONLY. The apply boundary also qualifies a class via the
 * hybrid activation (`hybrid-apply-activation.ts`), which never consults this registry — so an
 * empty list here does not by itself make LCM apply unreachable.
 */
export const LCM_APPLY_ACTIVATION_VERSIONS: readonly string[] = Object.freeze([]);

/**
 * The frozen promotion-profile version a qualifying record must have been decided under. Pinned
 * PUBLICLY by value (the version label is already public on every content-free evidence document);
 * the profile's gate structure and thresholds remain private to the engine. Changing the bar means
 * committing a new profile version first, this pin makes a silently re-versioned record invalid.
 */
export const LCM_APPLY_FROZEN_PROFILE_VERSION = "2026-07-12.1";

/** Schema tag for one class-promotion record (a JSONL line in the local promotion store). */
export const LCM_CLASS_PROMOTION_SCHEMA = "lcm-class-promotion/1";

/** Local promotion store the operator evidence-execution path writes. Absent today (no promotion). */
export const LCM_CLASS_PROMOTIONS_FILE = ".compaction/lcm/class-promotions.jsonl";

/** The promotion outcome a qualifying record must carry, nothing weaker ever qualifies. */
export const QUALIFYING_PROMOTION_OUTCOME = "promote_approval_gated_beta";

/**
 * One class-promotion record, as the operator evidence-execution path would write it. Everything
 * on it is content-free: labels, the projected evidence document, and run ids.
 */
export interface LcmClassPromotionRecord {
  schema: typeof LCM_CLASS_PROMOTION_SCHEMA;
  /** Must name a version present in `LCM_APPLY_ACTIVATION_VERSIONS` (empty today → never valid). */
  activationVersion: string;
  workflowClassId: string;
  /** The content-free promotion evidence document for exactly this class. */
  evidence: ContentFreeLcmEvidence;
  /** The two independent evidence runs the promotion rests on (distinct run ids). */
  evidenceRunIds: [string, string];
}

export type LcmClassQualificationCheck =
  | { qualified: true; workflowClassId: string }
  | { qualified: false; reason: string };

/** Short single-line content-free label (same bound the evidence contract enforces). */
function isLabel(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 200 && !value.includes("\n");
}

function fail(reason: string): LcmClassQualificationCheck {
  return { qualified: false, reason };
}

/**
 * Validate ONE promotion record fail-closed. Every check must pass; the first failure is the
 * honest reason. The ACTIVATION check runs LAST so that even a record passing every evidence
 * check is reported against the dormant-machinery gate, the gate that keeps this registry
 * empty by construction today.
 */
export function validateLcmClassPromotionRecord(record: unknown): LcmClassQualificationCheck {
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    return fail("promotion record must be an object");
  }
  const r = record as Partial<LcmClassPromotionRecord> & Record<string, unknown>;
  if (r.schema !== LCM_CLASS_PROMOTION_SCHEMA) {
    return fail(`unknown promotion record schema - expected ${LCM_CLASS_PROMOTION_SCHEMA}`);
  }
  if (!isLabel(r.workflowClassId)) return fail("workflowClassId must be a content-free class-id label");
  if (REJECTED_GLOBAL_TOOL_VALUES.includes(r.workflowClassId.trim().toLowerCase())) {
    return fail("global/cross-tool class ids can never qualify - a promotion is always one narrow class");
  }

  // Content tripwire over the WHOLE record: a content-shaped promotion record is rejected outright.
  const scan = scanContentFreeLcmEvidence(record);
  if (!scan.ok) return fail(`promotion record is content-shaped (${scan.reason} at ${scan.path}) - rejected`);

  const evidence = r.evidence as ContentFreeLcmEvidence | undefined;
  if (evidence === null || typeof evidence !== "object") return fail("promotion evidence document is required");
  if (evidence.contract_version !== LCM_EVIDENCE_CONTRACT_VERSION) {
    return fail("promotion evidence does not carry the pinned evidence-contract version");
  }
  if (evidence.workflowClassId !== r.workflowClassId) {
    return fail("promotion evidence is for a different workflow class - a promotion covers exactly one class");
  }
  if (evidence.evalProfileVersion !== LCM_APPLY_FROZEN_PROFILE_VERSION) {
    return fail(
      `promotion evidence was not decided under the frozen profile ${LCM_APPLY_FROZEN_PROFILE_VERSION} - a re-versioned or older bar never qualifies`
    );
  }
  if (evidence.promotionOutcome !== QUALIFYING_PROMOTION_OUTCOME) {
    return fail(
      `promotion outcome '${String(evidence.promotionOutcome)}' does not qualify - only ${QUALIFYING_PROMOTION_OUTCOME} ever does (insufficient_evidence and every other outcome never qualifies)`
    );
  }
  // Fixture evidence can NEVER qualify (mirror of the fixture-never-promotable guard; the
  // provenance union already makes fixture + liveVerified:true unrepresentable - re-checked anyway).
  if (evidence.traceSource !== "real-local" || evidence.evidenceSource !== "real-local") {
    return fail("fixture-sourced evidence can never qualify a class for apply");
  }
  if (evidence.liveVerified !== true) return fail("promotion evidence must be live-verified real-local evidence");
  if (evidence.candidateKind !== "lcm-candidate" || evidence.generationStatus !== "generated") {
    return fail("promotion evidence must describe a generated, validated lcm-candidate");
  }
  for (const dimension of LCM_EVIDENCE_DIMENSIONS) {
    if (evidence.dimensions?.[dimension] !== "pass") {
      return fail(`evaluation dimension '${dimension}' is not 'pass' - a partially evaluated record never qualifies`);
    }
  }

  const runIds = r.evidenceRunIds;
  if (!Array.isArray(runIds) || runIds.length !== 2 || !runIds.every(isLabel) || runIds[0] === runIds[1]) {
    return fail("exactly two DISTINCT independent evidence run ids are required (two-run reproduction)");
  }

  // LAST - the dormant-machinery gate: qualification additionally requires an explicitly
  // activated version. The whitelist is EMPTY, so no record qualifies today, by construction.
  if (!isLabel(r.activationVersion) || !LCM_APPLY_ACTIVATION_VERSIONS.includes(r.activationVersion)) {
    return fail(
      "no LCM apply activation version is enabled in this build - activation requires an explicit, versioned, tested activation change (dormant-machinery rule); nothing qualifies until then"
    );
  }
  return { qualified: true, workflowClassId: r.workflowClassId };
}

/**
 * Read the local promotion store and return the class ids with a VALID promotion record.
 * Fail-closed everywhere: no file → empty; an unparseable or invalid line is skipped (it can only
 * ever REDUCE what qualifies - never widen it). EMPTY today: no store exists, and even a
 * hand-crafted record fails the activation gate.
 */
export function readQualifiedLcmClasses(cwd: string): { qualifiedClassIds: string[]; rejectedRecordCount: number } {
  let raw: string;
  try {
    raw = readFileSync(join(cwd, LCM_CLASS_PROMOTIONS_FILE), "utf8");
  } catch {
    return { qualifiedClassIds: [], rejectedRecordCount: 0 }; // absent/unreadable store = nothing qualifies
  }
  const qualified = new Set<string>();
  let rejected = 0;
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      rejected += 1;
      continue;
    }
    const check = validateLcmClassPromotionRecord(parsed);
    if (check.qualified) qualified.add(check.workflowClassId);
    else rejected += 1;
  }
  return { qualifiedClassIds: [...qualified].sort(), rejectedRecordCount: rejected };
}

/**
 * THE class-qualification gate: may an LCM apply candidate even be considered for this workflow
 * class? FALSE for every class today (empty registry + empty activation whitelist). Fail-closed:
 * empty/global/unknown classes and ANY internal error are false. Read fresh on every call - a
 * store change (like a disable) is honored on the very next request.
 */
export function isClassQualifiedForLcmApply(workflowClass: string, cwd: string = process.cwd()): boolean {
  try {
    const classId = workflowClass?.trim();
    if (!classId || classId.length > 200) return false;
    if (REJECTED_GLOBAL_TOOL_VALUES.includes(classId.toLowerCase())) return false;
    return readQualifiedLcmClasses(cwd).qualifiedClassIds.includes(classId);
  } catch {
    return false; // any uncertainty is "not qualified"
  }
}
