import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OUTPUT_SHAPING_CALIBRATION_SCHEMA,
  bestApplicableOutputCalibration,
  calibrationStorePath,
  emptyCalibration,
  foldCalibrationConfirmation,
  loadCalibration,
  mergeOutputCalibrations,
  saveCalibration,
  updateCalibrationFromConfirmation,
  validateOutputCalibrationConfirmation
} from "../../src/core/output-shaping-calibration-store.js";
import {
  TEST_OUTPUT_POLICY_VERSION,
  confirmedOutputCalibration
} from "../helpers/output-calibration-fixture.js";

const QUERY = {
  policyVersion: TEST_OUTPUT_POLICY_VERSION,
  provider: "anthropic",
  model: "claude-opus-5"
} as const;

describe("output-shaping calibration v3 exact applicability", () => {
  it("resolves an exact policy/provider/model/regime match and no mismatch", () => {
    const artifact = confirmedOutputCalibration({ regime: "default-shapeable" });
    const store = foldCalibrationConfirmation(emptyCalibration(), artifact);
    expect(bestApplicableOutputCalibration(store, { ...QUERY, regime: "default-shapeable" })?.rate).toBeCloseTo(0.4);
    const differentPolicyVersion = `${TEST_OUTPUT_POLICY_VERSION.slice(0, -1)}${TEST_OUTPUT_POLICY_VERSION.endsWith("0") ? "1" : "0"}`;
    expect(bestApplicableOutputCalibration(store, { ...QUERY, policyVersion: differentPolicyVersion, regime: "default-shapeable" })).toBeUndefined();
    expect(bestApplicableOutputCalibration(store, { ...QUERY, provider: "openai", regime: "default-shapeable" })).toBeUndefined();
    expect(bestApplicableOutputCalibration(store, { ...QUERY, model: "claude-sonnet-5", regime: "default-shapeable" })).toBeUndefined();
    expect(bestApplicableOutputCalibration(store, QUERY), "missing regime cannot borrow regime-specific evidence").toBeUndefined();
  });

  it("rejects known unknown-model sentinels instead of borrowing a known model", () => {
    const store = foldCalibrationConfirmation(emptyCalibration(), confirmedOutputCalibration());
    for (const model of ["unknown", "codex-unknown-model", "cursor-unknown-model", "openai-agents-sdk-unknown-model"]) {
      expect(bestApplicableOutputCalibration(store, { ...QUERY, model })).toBeUndefined();
      expect(validateOutputCalibrationConfirmation(confirmedOutputCalibration({ model }))).toBeUndefined();
    }
  });

  it("rejects weak, inconclusive, failed-quality, refusal, truncation, and non-reduction artifacts", () => {
    const mutations: Array<(artifact: ReturnType<typeof confirmedOutputCalibration>) => void> = [
      (a) => { a.nControl = 2; },
      (a) => { a.intervalLow = 0; },
      (a) => { a.controlFullContentSufficiency = "fail" as never; },
      (a) => { a.treatmentFullContentSufficiency = "fail" as never; },
      (a) => { a.refused = true as never; },
      (a) => { a.truncated = true as never; },
      (a) => { a.totalTreatmentOutputTokens = a.totalControlOutputTokens; }
    ];
    for (const mutate of mutations) {
      const artifact = confirmedOutputCalibration();
      mutate(artifact);
      expect(validateOutputCalibrationConfirmation(artifact)).toBeUndefined();
      expect(foldCalibrationConfirmation(emptyCalibration(), artifact).records).toEqual([]);
    }
  });

  it("keeps a 40% rate with unbalanced arms by applying one shared experiment weight", () => {
    const artifact = confirmedOutputCalibration({
      control: [1000, 1000, 1000],
      treatment: [600, 600, 600, 600, 600, 600]
    });
    const match = bestApplicableOutputCalibration(
      foldCalibrationConfirmation(emptyCalibration(), artifact),
      QUERY
    );
    expect(match?.rate).toBeCloseTo(0.4);
    expect(match?.nControl).toBe(3);
    expect(match?.nTreatment).toBe(6);
  });

  it("deduplicates one confirmation and pools distinct exact-key evidence by token quantities", () => {
    const first = confirmedOutputCalibration({ confirmedAt: "2026-09-03T00:00:00.000Z" });
    const second = confirmedOutputCalibration({
      control: [2000, 2000, 2000],
      treatment: [1000, 1000, 1000],
      confirmedAt: "2026-09-04T00:00:00.000Z"
    });
    const once = foldCalibrationConfirmation(emptyCalibration(), first);
    expect(foldCalibrationConfirmation(once, first)).toEqual(once);
    const pooled = foldCalibrationConfirmation(once, second);
    const match = bestApplicableOutputCalibration(pooled, QUERY)!;
    // Equal shared weights: pooled control=1500, treatment=800 => 46.666…%, not averaged display percentages.
    expect(match.rate).toBeCloseTo((1500 - 800) / 1500);
    expect(match.evidenceCount).toBe(2);
  });

  it("treats schema v2 as absent and never migrates or blends it", async () => {
    const v2 = JSON.stringify({
      schema: "output-shaping.calibration.v2",
      sampleCount: 99,
      totalControlOutputTokens: 1000,
      totalTreatmentOutputTokens: 1
    });
    const loaded = await loadCalibration({} as NodeJS.ProcessEnv, async () => v2);
    expect(loaded.schema).toBe(OUTPUT_SHAPING_CALIBRATION_SCHEMA);
    expect(loaded.records).toEqual([]);
  });

  it("persists a closed content-free artifact with no prompt/output/session/path/credential fields", async () => {
    const dir = mkdtempSync(join(tmpdir(), "output-calibration-v3-"));
    const env = { COMPACTION_CONFIG_DIR: dir } as NodeJS.ProcessEnv;
    try {
      await updateCalibrationFromConfirmation(confirmedOutputCalibration(), env);
      const raw = readFileSync(calibrationStorePath(env), "utf8");
      expect(raw).not.toMatch(/prompt|response|session|credential|api[_-]?key|\/Users\//i);
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      expect(Object.keys(parsed).sort()).toEqual(["records", "schema", "updatedAt"]);
      expect((parsed.records as unknown[])).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("projects unknown fields out across validation, fold, load, merge, and save boundaries", async () => {
    const tripwires = {
      rawPrompt: "PROMPT_TRIPWIRE",
      rawOutput: "OUTPUT_TRIPWIRE",
      rawSessionId: "SESSION_TRIPWIRE",
      credential: "CREDENTIAL_TRIPWIRE",
      localPath: "/private/tmp/TRACE_PATH_TRIPWIRE"
    };
    const confirmation = { ...confirmedOutputCalibration(), ...tripwires };
    const validated = validateOutputCalibrationConfirmation(confirmation);
    expect(validated).toBeDefined();
    expect(JSON.stringify(validated)).not.toMatch(/TRIPWIRE|rawPrompt|rawOutput|rawSessionId|credential|localPath/);

    const first = foldCalibrationConfirmation(emptyCalibration(), confirmation);
    const dirty = {
      ...first,
      ...tripwires,
      records: first.records.map((record) => ({ ...record, ...tripwires }))
    };
    const second = confirmedOutputCalibration({
      control: [2000, 2000, 2000],
      treatment: [1000, 1000, 1000],
      confirmedAt: "2026-09-04T00:00:00.000Z"
    });
    const folded = foldCalibrationConfirmation(dirty, second);
    const merged = mergeOutputCalibrations(dirty, emptyCalibration());
    for (const value of [folded, merged]) {
      expect(JSON.stringify(value)).not.toMatch(/TRIPWIRE|rawPrompt|rawOutput|rawSessionId|credential|localPath/);
    }

    const dir = mkdtempSync(join(tmpdir(), "output-calibration-closed-shapes-"));
    const env = { COMPACTION_CONFIG_DIR: dir } as NodeJS.ProcessEnv;
    try {
      writeFileSync(calibrationStorePath(env), JSON.stringify(dirty));
      const loaded = await loadCalibration(env);
      expect(JSON.stringify(loaded)).not.toMatch(/TRIPWIRE|rawPrompt|rawOutput|rawSessionId|credential|localPath/);
      await saveCalibration(dirty, env);
      expect(readFileSync(calibrationStorePath(env), "utf8")).not.toMatch(
        /TRIPWIRE|rawPrompt|rawOutput|rawSessionId|credential|localPath/
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails open to absent on malformed v3 records", async () => {
    const dir = mkdtempSync(join(tmpdir(), "output-calibration-bad-"));
    const env = { COMPACTION_CONFIG_DIR: dir } as NodeJS.ProcessEnv;
    try {
      writeFileSync(calibrationStorePath(env), JSON.stringify({ schema: OUTPUT_SHAPING_CALIBRATION_SCHEMA, records: [{}] }));
      expect((await loadCalibration(env)).records).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
