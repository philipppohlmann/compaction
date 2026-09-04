/**
 * Shared output-shaping calibration store (PUBLIC, engine-free, content-free, local-first).
 *
 * The store accepts only confirmation artifacts produced after the private engine's statistical and
 * full-content quality gates pass. Records are keyed by the exact model-visible policy bytes plus the
 * provider/model cohort and, only when observed, a fixed regime. Resolution is exact on every key:
 * unknown metadata never borrows a nearby cohort and there is no policy-wide or generic-prior fallback.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { compactionConfigDir } from "./config-dir.js";

export const OUTPUT_SHAPING_CALIBRATION_SCHEMA = "output-shaping.calibration.v3" as const;
export const OUTPUT_SHAPING_CALIBRATION_CONFIRMATION_SCHEMA =
  "output-shaping.calibration-confirmation.v1" as const;

/** The only regime v1 can identify without retaining task content. */
export type OutputShapingCalibrationRegime = "default-shapeable";

export interface OutputShapingCalibrationQuery {
  policyVersion: string;
  provider: string;
  model: string;
  regime?: OutputShapingCalibrationRegime;
}

/**
 * Content-free handoff emitted by the private engine after all confirmation gates pass. The public
 * core validates this closed shape but never attempts to reproduce the private full-content eval.
 */
export interface OutputShapingCalibrationConfirmation extends OutputShapingCalibrationQuery {
  schema: typeof OUTPUT_SHAPING_CALIBRATION_CONFIRMATION_SCHEMA;
  confirmation: "engine-confirmed";
  confirmationId: string;
  providerReported: true;
  nControl: number;
  nTreatment: number;
  totalControlOutputTokens: number;
  totalTreatmentOutputTokens: number;
  intervalLow: number;
  intervalHigh: number;
  evalOrder: "control-first";
  controlFullContentSufficiency: "pass";
  treatmentFullContentSufficiency: "pass";
  truncated: false;
  refused: false;
  confirmedAt: string;
}

export interface OutputShapingCalibrationRecord extends OutputShapingCalibrationQuery {
  evidenceCount: number;
  /** Σ(mean control tokens × total turns in that confirmation). */
  weightedControlOutputTokens: number;
  /** Σ(mean treatment tokens × total turns in that confirmation). */
  weightedTreatmentOutputTokens: number;
  /** Σ(nControl+nTreatment), the shared weight applied to both arm means. */
  totalWeight: number;
  nControl: number;
  nTreatment: number;
  confirmationIds: string[];
  updatedAt: string;
}

export interface OutputShapingCalibration {
  schema: typeof OUTPUT_SHAPING_CALIBRATION_SCHEMA;
  records: OutputShapingCalibrationRecord[];
  updatedAt: string;
}

/** Kept only for internal heuristics. It is never persisted, resolved, or rendered as calibration. */
export const DEFAULT_OUTPUT_SHAPING_RATE = 0.47;

export type CalibrationBasis = "default-prior" | "measured";
export type CalibrationState = "unseeded" | "calibrating" | "calibrated" | "measured-no-effect";

export interface ApplicableOutputCalibration extends OutputShapingCalibrationQuery {
  rate: number;
  evidenceCount: number;
  nControl: number;
  nTreatment: number;
  meanControlOutputTokens: number;
  meanTreatmentOutputTokens: number;
}

export function emptyCalibration(now: () => string = () => new Date().toISOString()): OutputShapingCalibration {
  return { schema: OUTPUT_SHAPING_CALIBRATION_SCHEMA, records: [], updatedAt: now() };
}

function safeMetadata(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 160 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.includes("..") &&
    !value.startsWith("file:") &&
    /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value)
  );
}

function safePolicyVersion(value: unknown): value is string {
  return typeof value === "string" && /^output-shaping\.v1\.sha256\.[a-f0-9]{64}$/.test(value);
}

function knownModel(value: unknown): value is string {
  return safeMetadata(value) && !/(^unknown$|-unknown-model$)/i.test(value);
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function nonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validRegime(value: unknown): value is OutputShapingCalibrationRegime | undefined {
  return value === undefined || value === "default-shapeable";
}

/** Normalize fixed receipt/adapter metadata into an exact query; unknowns fail closed. */
export function outputCalibrationQuery(input: {
  policyVersion?: unknown;
  provider?: unknown;
  model?: unknown;
  regime?: unknown;
}): OutputShapingCalibrationQuery | undefined {
  if (
    !safePolicyVersion(input.policyVersion) ||
    !safeMetadata(input.provider) ||
    !knownModel(input.model) ||
    !validRegime(input.regime)
  ) {
    return undefined;
  }
  return {
    policyVersion: input.policyVersion,
    provider: input.provider,
    model: input.model,
    ...(input.regime !== undefined ? { regime: input.regime } : {})
  };
}

/** Dedupe identity over fixed applicability metadata and aggregate numeric evidence only. */
export function outputCalibrationConfirmationId(input: Omit<
  OutputShapingCalibrationConfirmation,
  "schema" | "confirmation" | "confirmationId" | "providerReported" | "evalOrder" |
  "controlFullContentSufficiency" | "treatmentFullContentSufficiency" | "truncated" | "refused" | "confirmedAt"
>): string {
  const fixed = [
    input.policyVersion,
    input.provider,
    input.model,
    input.regime ?? null,
    input.nControl,
    input.nTreatment,
    input.totalControlOutputTokens,
    input.totalTreatmentOutputTokens,
    input.intervalLow,
    input.intervalHigh
  ];
  return createHash("sha256").update(JSON.stringify(fixed), "utf8").digest("hex");
}

/** Validate the engine-to-public handoff. Invalid/weak artifacts are absent, never partially trusted. */
export function validateOutputCalibrationConfirmation(
  value: unknown
): OutputShapingCalibrationConfirmation | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Partial<OutputShapingCalibrationConfirmation>;
  if (
    v.schema !== OUTPUT_SHAPING_CALIBRATION_CONFIRMATION_SCHEMA ||
    v.confirmation !== "engine-confirmed" ||
    v.providerReported !== true ||
    !safePolicyVersion(v.policyVersion) ||
    !safeMetadata(v.provider) ||
    !knownModel(v.model) ||
    !validRegime(v.regime) ||
    !positiveInteger(v.nControl) ||
    !positiveInteger(v.nTreatment) ||
    v.nControl < 3 ||
    v.nTreatment < 3 ||
    !nonNegativeFinite(v.totalControlOutputTokens) ||
    !nonNegativeFinite(v.totalTreatmentOutputTokens) ||
    v.totalControlOutputTokens / v.nControl <= v.totalTreatmentOutputTokens / v.nTreatment ||
    typeof v.intervalLow !== "number" ||
    !Number.isFinite(v.intervalLow) ||
    v.intervalLow <= 0 ||
    typeof v.intervalHigh !== "number" ||
    !Number.isFinite(v.intervalHigh) ||
    v.intervalHigh < v.intervalLow ||
    v.evalOrder !== "control-first" ||
    v.controlFullContentSufficiency !== "pass" ||
    v.treatmentFullContentSufficiency !== "pass" ||
    v.truncated !== false ||
    v.refused !== false ||
    typeof v.confirmedAt !== "string" ||
    Number.isNaN(Date.parse(v.confirmedAt)) ||
    typeof v.confirmationId !== "string" ||
    !/^[a-f0-9]{64}$/.test(v.confirmationId)
  ) {
    return undefined;
  }
  const expectedId = outputCalibrationConfirmationId({
    policyVersion: v.policyVersion,
    provider: v.provider,
    model: v.model,
    ...(v.regime !== undefined ? { regime: v.regime } : {}),
    nControl: v.nControl,
    nTreatment: v.nTreatment,
    totalControlOutputTokens: v.totalControlOutputTokens,
    totalTreatmentOutputTokens: v.totalTreatmentOutputTokens,
    intervalLow: v.intervalLow,
    intervalHigh: v.intervalHigh
  });
  if (v.confirmationId !== expectedId) return undefined;
  // This validator is also a privacy boundary. Returning `v` would retain every unchecked property
  // supplied by the operator handoff and let raw prompt/output/path fields ride into the generated
  // package registry. Project a fresh closed artifact so validation and serialization share one shape.
  return {
    schema: OUTPUT_SHAPING_CALIBRATION_CONFIRMATION_SCHEMA,
    confirmation: "engine-confirmed",
    confirmationId: v.confirmationId,
    providerReported: true,
    policyVersion: v.policyVersion,
    provider: v.provider,
    model: v.model,
    ...(v.regime !== undefined ? { regime: v.regime } : {}),
    nControl: v.nControl,
    nTreatment: v.nTreatment,
    totalControlOutputTokens: v.totalControlOutputTokens,
    totalTreatmentOutputTokens: v.totalTreatmentOutputTokens,
    intervalLow: v.intervalLow,
    intervalHigh: v.intervalHigh,
    evalOrder: "control-first",
    controlFullContentSufficiency: "pass",
    treatmentFullContentSufficiency: "pass",
    truncated: false,
    refused: false,
    confirmedAt: v.confirmedAt
  };
}

function sameKey(a: OutputShapingCalibrationQuery, b: OutputShapingCalibrationQuery): boolean {
  return (
    a.policyVersion === b.policyVersion &&
    a.provider === b.provider &&
    a.model === b.model &&
    a.regime === b.regime
  );
}

/** Fold one confirmed artifact into its exact cohort. Invalid or duplicate evidence is a no-op. */
export function foldCalibrationConfirmation(
  calibration: OutputShapingCalibration,
  value: unknown,
  now: () => string = () => new Date().toISOString()
): OutputShapingCalibration {
  const safeRecords = calibration.records
    .map(projectCalibrationRecord)
    .filter((record): record is OutputShapingCalibrationRecord => record !== undefined);
  const safeCalibration: OutputShapingCalibration = {
    schema: OUTPUT_SHAPING_CALIBRATION_SCHEMA,
    records: safeRecords,
    updatedAt:
      typeof calibration.updatedAt === "string" && !Number.isNaN(Date.parse(calibration.updatedAt))
        ? calibration.updatedAt
        : now()
  };
  const confirmation = validateOutputCalibrationConfirmation(value);
  if (!confirmation) return safeCalibration;
  if (safeRecords.some((record) => record.confirmationIds.includes(confirmation.confirmationId))) {
    return safeCalibration;
  }
  const index = safeRecords.findIndex((record) => sameKey(record, confirmation));
  const updatedAt = now();
  const sharedWeight = confirmation.nControl + confirmation.nTreatment;
  const contribution: OutputShapingCalibrationRecord = {
    policyVersion: confirmation.policyVersion,
    provider: confirmation.provider,
    model: confirmation.model,
    ...(confirmation.regime !== undefined ? { regime: confirmation.regime } : {}),
    evidenceCount: 1,
    weightedControlOutputTokens:
      (confirmation.totalControlOutputTokens / confirmation.nControl) * sharedWeight,
    weightedTreatmentOutputTokens:
      (confirmation.totalTreatmentOutputTokens / confirmation.nTreatment) * sharedWeight,
    totalWeight: sharedWeight,
    nControl: confirmation.nControl,
    nTreatment: confirmation.nTreatment,
    confirmationIds: [confirmation.confirmationId],
    updatedAt
  };
  const records = [...safeRecords];
  if (index < 0) {
    records.push(contribution);
  } else {
    const current = records[index];
    records[index] = {
      ...current,
      evidenceCount: current.evidenceCount + 1,
      weightedControlOutputTokens:
        current.weightedControlOutputTokens + contribution.weightedControlOutputTokens,
      weightedTreatmentOutputTokens:
        current.weightedTreatmentOutputTokens + contribution.weightedTreatmentOutputTokens,
      totalWeight: current.totalWeight + contribution.totalWeight,
      nControl: current.nControl + contribution.nControl,
      nTreatment: current.nTreatment + contribution.nTreatment,
      confirmationIds: [...current.confirmationIds, confirmation.confirmationId],
      updatedAt
    };
  }
  return { schema: OUTPUT_SHAPING_CALIBRATION_SCHEMA, records, updatedAt };
}

/**
 * Add exact-key local records to package-shipped evidence without changing applicability semantics.
 * Confirmation ids deduplicate the same evidence; shared weights preserve the per-confirmation arm
 * normalization used by `foldCalibrationConfirmation`.
 */
export function mergeOutputCalibrations(
  base: OutputShapingCalibration,
  addition: OutputShapingCalibration,
  now: () => string = () => new Date().toISOString()
): OutputShapingCalibration {
  let changed = false;
  const records = base.records
    .map(projectCalibrationRecord)
    .filter((record): record is OutputShapingCalibrationRecord => record !== undefined);
  for (const rawIncoming of addition.records) {
    const incoming = projectCalibrationRecord(rawIncoming);
    if (!incoming) continue;
    const unseenIds = incoming.confirmationIds.filter(
      (id) => !records.some((record) => record.confirmationIds.includes(id))
    );
    if (unseenIds.length === 0) continue;
    // A persisted record is an aggregate, so partial overlap cannot be separated safely. Fail closed
    // rather than double-counting some unknown fraction of it.
    if (unseenIds.length !== incoming.confirmationIds.length) continue;
    const index = records.findIndex((record) => sameKey(record, incoming));
    if (index < 0) {
      records.push(incoming);
    } else {
      const current = records[index];
      records[index] = {
        ...current,
        evidenceCount: current.evidenceCount + incoming.evidenceCount,
        weightedControlOutputTokens:
          current.weightedControlOutputTokens + incoming.weightedControlOutputTokens,
        weightedTreatmentOutputTokens:
          current.weightedTreatmentOutputTokens + incoming.weightedTreatmentOutputTokens,
        totalWeight: current.totalWeight + incoming.totalWeight,
        nControl: current.nControl + incoming.nControl,
        nTreatment: current.nTreatment + incoming.nTreatment,
        confirmationIds: [...current.confirmationIds, ...incoming.confirmationIds],
        updatedAt: incoming.updatedAt
      };
    }
    changed = true;
  }
  // Return the closed projection even when no evidence was added. Both operands may originate in
  // parsed or injected data, and a no-op merge must not preserve arbitrary top-level/record fields.
  return {
    schema: OUTPUT_SHAPING_CALIBRATION_SCHEMA,
    records,
    updatedAt: changed
      ? now()
      : typeof base.updatedAt === "string" && !Number.isNaN(Date.parse(base.updatedAt))
        ? base.updatedAt
        : now()
  };
}

/** Resolve only an exact policy/provider/model/regime key. There is deliberately no fallback ladder. */
export function bestApplicableOutputCalibration(
  calibration: OutputShapingCalibration,
  query: OutputShapingCalibrationQuery
): ApplicableOutputCalibration | undefined {
  if (!outputCalibrationQuery(query)) return undefined;
  const record = calibration.records.find((candidate) => sameKey(candidate, query));
  if (!record || record.weightedControlOutputTokens <= 0 || record.totalWeight <= 0) return undefined;
  const rate = (record.weightedControlOutputTokens - record.weightedTreatmentOutputTokens) /
    record.weightedControlOutputTokens;
  if (!Number.isFinite(rate) || rate <= 0 || rate >= 1) return undefined;
  return {
    policyVersion: record.policyVersion,
    provider: record.provider,
    model: record.model,
    ...(record.regime !== undefined ? { regime: record.regime } : {}),
    rate,
    evidenceCount: record.evidenceCount,
    nControl: record.nControl,
    nTreatment: record.nTreatment,
    meanControlOutputTokens: record.weightedControlOutputTokens / record.totalWeight,
    meanTreatmentOutputTokens: record.weightedTreatmentOutputTokens / record.totalWeight
  };
}

export function calibrationStorePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(compactionConfigDir(env), "shaping-calibration.json");
}

function projectCalibrationRecord(value: unknown): OutputShapingCalibrationRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Partial<OutputShapingCalibrationRecord>;
  if (!(
    safePolicyVersion(v.policyVersion) &&
    safeMetadata(v.provider) &&
    knownModel(v.model) &&
    validRegime(v.regime) &&
    positiveInteger(v.evidenceCount) &&
    positiveInteger(v.nControl) &&
    positiveInteger(v.nTreatment) &&
    nonNegativeFinite(v.weightedControlOutputTokens) &&
    nonNegativeFinite(v.weightedTreatmentOutputTokens) &&
    v.weightedControlOutputTokens > v.weightedTreatmentOutputTokens &&
    positiveInteger(v.totalWeight) &&
    Array.isArray(v.confirmationIds) &&
    v.confirmationIds.length === v.evidenceCount &&
    v.confirmationIds.every((id) => typeof id === "string" && /^[a-f0-9]{64}$/.test(id)) &&
    typeof v.updatedAt === "string" &&
    !Number.isNaN(Date.parse(v.updatedAt))
  )) return undefined;
  // Local JSON is another untrusted persistence boundary. Keep the same closed-record guarantee as
  // confirmations so unknown fields cannot be retained by load → merge → save structural spreads.
  return {
    policyVersion: v.policyVersion,
    provider: v.provider,
    model: v.model,
    ...(v.regime !== undefined ? { regime: v.regime } : {}),
    evidenceCount: v.evidenceCount,
    weightedControlOutputTokens: v.weightedControlOutputTokens,
    weightedTreatmentOutputTokens: v.weightedTreatmentOutputTokens,
    totalWeight: v.totalWeight,
    nControl: v.nControl,
    nTreatment: v.nTreatment,
    confirmationIds: [...v.confirmationIds],
    updatedAt: v.updatedAt
  };
}

/** v2 and malformed files are treated as absent; calibration is regenerable and never migrated/blended. */
export async function loadCalibration(
  env: NodeJS.ProcessEnv = process.env,
  readFileImpl: (path: string) => Promise<string> = (path) => readFile(path, "utf8")
): Promise<OutputShapingCalibration> {
  try {
    const parsed = JSON.parse(await readFileImpl(calibrationStorePath(env))) as Partial<OutputShapingCalibration>;
    if (parsed.schema !== OUTPUT_SHAPING_CALIBRATION_SCHEMA || !Array.isArray(parsed.records)) {
      return emptyCalibration();
    }
    const records = parsed.records.map(projectCalibrationRecord);
    if (records.some((record) => record === undefined)) return emptyCalibration();
    return {
      schema: OUTPUT_SHAPING_CALIBRATION_SCHEMA,
      records: records as OutputShapingCalibrationRecord[],
      updatedAt:
        typeof parsed.updatedAt === "string" && !Number.isNaN(Date.parse(parsed.updatedAt))
          ? parsed.updatedAt
          : new Date().toISOString()
    };
  } catch {
    return emptyCalibration();
  }
}

export async function saveCalibration(
  calibration: OutputShapingCalibration,
  env: NodeJS.ProcessEnv = process.env
): Promise<string> {
  const path = calibrationStorePath(env);
  const records = calibration.records
    .map(projectCalibrationRecord)
    .filter((record): record is OutputShapingCalibrationRecord => record !== undefined);
  const closed: OutputShapingCalibration = {
    schema: OUTPUT_SHAPING_CALIBRATION_SCHEMA,
    records,
    updatedAt:
      typeof calibration.updatedAt === "string" && !Number.isNaN(Date.parse(calibration.updatedAt))
        ? calibration.updatedAt
        : new Date().toISOString()
  };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(closed, null, 2)}\n`, "utf8");
  return path;
}

export async function updateCalibrationFromConfirmation(
  confirmation: unknown,
  env: NodeJS.ProcessEnv = process.env,
  now: () => string = () => new Date().toISOString()
): Promise<{ calibration: OutputShapingCalibration; updated: boolean }> {
  const current = await loadCalibration(env);
  const validated = validateOutputCalibrationConfirmation(confirmation);
  if (!validated) return { calibration: current, updated: false };
  if (current.records.some((record) => record.confirmationIds.includes(validated.confirmationId))) {
    return { calibration: current, updated: false };
  }
  const next = foldCalibrationConfirmation(current, validated, now);
  const updated = true;
  if (updated) await saveCalibration(next, env);
  return { calibration: next, updated };
}
