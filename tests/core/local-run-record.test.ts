import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildLocalRunTokenRecord,
  formatPerToolRunRecordLines,
  OUTPUT_SAVINGS_UNAVAILABLE_LINE,
  readLocalRunTokenRecords,
  RUN_TOKEN_RECORD_FILENAME,
  summarizePerToolRunRecords,
  validateLocalRunTokenRecord,
  writeLocalRunTokenRecord,
  type LocalRunTokenRecord
} from "../../src/core/local-run-record.js";
import { createRunSummary, formatRunSummary, formatRunSummaryMarkdown } from "../../src/core/run-aggregator.js";
import type { RunFlowTokenReport } from "../../src/core/run-flow-report.js";

/**
 * LOCAL per-run token_source records + the `summary` per-tool rollup (unified-run-flow LOCAL layer).
 * Binding honesty boundaries under test:
 *   - per-field token_source is one of provider-reported | local-estimate | unavailable;
 *   - input and output roll up SEPARATELY, each within its OWN tier (never mixed);
 *   - an unavailable axis is a labeled state with a reason, never a 0, never a fabricated count;
 *   - output carries NO savings figure anywhere; `output_savings` is the LITERAL "unavailable";
 *   - records are content-free (counts + sources + honest notes only).
 */

const temporaryDirectories: string[] = [];

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "local-run-record-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })));
});

function tokenReport(overrides: Partial<RunFlowTokenReport> = {}): RunFlowTokenReport {
  return {
    tool: "codex",
    input_token_source: "provider-reported",
    output_token_source: "provider-reported",
    input_tokens: 1500,
    output_tokens: 420,
    input_reduction_label: "measured",
    notes: ["Token counts come from codex exec turn.completed usage (provider-reported, not billing-confirmed)."],
    ...overrides
  };
}

function record(runId: string, overrides: Partial<RunFlowTokenReport> = {}): LocalRunTokenRecord {
  return buildLocalRunTokenRecord({ runId, tokenReport: tokenReport(overrides), recordedAt: "2026-07-02T00:00:00.000Z" });
}

describe("local run token record - build / validate", () => {
  it("builds a version-1 record embedding the RunFlowTokenReport unchanged", () => {
    const built = record("codex-1");
    expect(built.record_version).toBe(1);
    expect(built.run_id).toBe("codex-1");
    expect(built.token_report).toEqual(tokenReport());
    expect(validateLocalRunTokenRecord(built).record).toEqual(built);
  });

  it("rejects records with an unknown token_source instead of guessing", () => {
    const bad = JSON.parse(JSON.stringify(record("codex-1"))) as Record<string, unknown>;
    (bad.token_report as Record<string, unknown>).output_token_source = "billing-confirmed";
    expect(validateLocalRunTokenRecord(bad).reason).toBe("invalid token_report.output_token_source");
  });

  it("rejects non-object, wrong-version, and negative-count records", () => {
    expect(validateLocalRunTokenRecord(null).reason).toBe("record is not a JSON object");
    expect(validateLocalRunTokenRecord({ ...record("x"), record_version: 2 }).reason).toBe("unsupported record_version");
    const negative = JSON.parse(JSON.stringify(record("x"))) as Record<string, unknown>;
    (negative.token_report as Record<string, unknown>).input_tokens = -5;
    expect(validateLocalRunTokenRecord(negative).reason).toBe("invalid token_report.input_tokens");
  });
});

describe("local run token record - write / read accumulation", () => {
  it("writes one copy with the run artifacts and one accumulated copy, then reads them back", async () => {
    const root = await makeTemporaryDirectory();
    const outDir = join(root, "out");
    const recordsDir = join(root, "run-records");

    const paths = await writeLocalRunTokenRecord(record("codex-1"), outDir, recordsDir);
    expect(paths.artifactPath).toBe(join(outDir, RUN_TOKEN_RECORD_FILENAME));
    expect(paths.accumulatedPath).toBe(join(recordsDir, "codex-1.json"));

    const artifactCopy = JSON.parse(await readFile(paths.artifactPath, "utf8")) as LocalRunTokenRecord;
    expect(artifactCopy.token_report.input_tokens).toBe(1500);

    const { records, skipped } = await readLocalRunTokenRecords(recordsDir);
    expect(skipped).toEqual([]);
    expect(records).toHaveLength(1);
    expect(records[0]?.record.run_id).toBe("codex-1");
  });

  it("returns empty (not an error) for a missing records directory, and skips invalid files with reasons", async () => {
    const root = await makeTemporaryDirectory();
    expect(await readLocalRunTokenRecords(join(root, "does-not-exist"))).toEqual({ records: [], skipped: [] });

    const recordsDir = join(root, "run-records");
    await writeLocalRunTokenRecord(record("ok-1"), join(root, "out"), recordsDir);
    await writeFile(join(recordsDir, "broken.json"), "{ nope", "utf8");
    await writeFile(join(recordsDir, "wrong-shape.json"), JSON.stringify({ hello: 1 }), "utf8");

    const { records, skipped } = await readLocalRunTokenRecords(recordsDir);
    expect(records.map((r) => r.record.run_id)).toEqual(["ok-1"]);
    expect(skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: join(recordsDir, "broken.json"), reason: "invalid JSON" }),
        expect.objectContaining({ path: join(recordsDir, "wrong-shape.json"), reason: "unsupported record_version" })
      ])
    );
  });
});

describe("per-tool rollup - contract tiers, honest and separate per axis", () => {
  it("buckets tokens strictly within their own token_source tier, input and output separate", () => {
    const rollups = summarizePerToolRunRecords([
      record("codex-1"),
      record("codex-2", { input_tokens: 500, output_tokens: 80 }),
      record("cursor-1", {
        tool: "cursor",
        input_token_source: "local-estimate",
        output_token_source: "unavailable",
        input_tokens: 400,
        output_tokens: undefined,
        input_reduction_label: "estimated",
        notes: ["Cursor emits no provider usage; output not safely separable from this invocation."]
      })
    ]);

    expect(rollups.map((r) => r.tool)).toEqual(["codex", "cursor"]);
    const codex = rollups[0]!;
    expect(codex.runs).toBe(2);
    expect(codex.input.provider_reported).toEqual({ runs: 2, tokens: 2000 });
    expect(codex.output.provider_reported).toEqual({ runs: 2, tokens: 500 });
    expect(codex.input.local_estimate.runs).toBe(0);
    expect(codex.output.unavailable.runs).toBe(0);

    const cursor = rollups[1]!;
    expect(cursor.input.local_estimate).toEqual({ runs: 1, tokens: 400 });
    expect(cursor.input.provider_reported.runs).toBe(0);
    expect(cursor.output.unavailable.runs).toBe(1);
    expect(cursor.output.unavailable.reasons[0]).toContain("not safely separable");
    // The literal contract value, never a figure.
    expect(cursor.output_savings).toBe("unavailable");
    expect(codex.output_savings).toBe("unavailable");
  });

  it("treats a claimed tier WITHOUT a count as unavailable - never a silent zero", () => {
    const rollups = summarizePerToolRunRecords([
      record("codex-3", { input_tokens: undefined, output_tokens: undefined, notes: [] })
    ]);
    expect(rollups[0]?.input.unavailable.runs).toBe(1);
    expect(rollups[0]?.output.unavailable.runs).toBe(1);
    expect(rollups[0]?.input.provider_reported).toEqual({ runs: 0, tokens: 0 });
  });

  it("renders contract copy: live/estimated tiers, unavailable with reason, literal output-savings line, no output-savings figure", () => {
    const lines = formatPerToolRunRecordLines(
      summarizePerToolRunRecords([
        record("codex-1"),
        record("cursor-1", {
          tool: "cursor",
          input_token_source: "local-estimate",
          output_token_source: "unavailable",
          input_tokens: 400,
          output_tokens: undefined,
          input_reduction_label: "estimated",
          notes: ["output not safely separable"]
        })
      ])
    ).join("\n");

    expect(lines).toContain("- codex: 1 run(s)");
    expect(lines).toContain("input: 1500 tokens live (provider-reported) across 1 run(s)");
    expect(lines).toContain("output: 420 tokens live (provider-reported) across 1 run(s)");
    expect(lines).toContain("input: 400 tokens estimated (local-estimate) across 1 run(s)");
    expect(lines).toContain("output: unavailable for 1 run(s) - output not safely separable");
    expect(lines).toContain(OUTPUT_SAVINGS_UNAVAILABLE_LINE);
    // Binding rail: no POSITIVE output-savings claim, no figure (number/$/%) attached to output savings.
    expect(lines).not.toMatch(/output[^\n]*\b(saved|savings)\b[^\n]*[\d$%]/i);
    // An unavailable axis never renders as 0 tokens.
    expect(lines).not.toMatch(/output: 0 tokens/);
    // No tier LABEL outside the sanctioned ones appears (the honest "not billing-confirmed"
    // negation inside a carried note is allowed; a billing-confirmed COUNT label is not).
    expect(lines).not.toMatch(/tokens billing-confirmed|\(billing-confirmed\)|source: billing-confirmed/);
  });

  it("renders the honest empty state when no records exist (never fabricated per-tool rows)", () => {
    const lines = formatPerToolRunRecordLines([]).join("\n");
    expect(lines).toContain("none yet");
    expect(lines).not.toContain("run(s)");
  });
});

describe("summary integration - per-tool token records surface in createRunSummary output", () => {
  it("rolls accumulated records into summary JSON, terminal, and markdown renderings", async () => {
    const root = await makeTemporaryDirectory();
    const runsDir = join(root, "runs");
    const recordsDir = join(root, "run-records");
    await writeLocalRunTokenRecord(record("codex-1"), join(root, "out-codex"), recordsDir);
    await writeLocalRunTokenRecord(
      record("cursor-1", {
        tool: "cursor",
        input_token_source: "local-estimate",
        output_token_source: "unavailable",
        input_tokens: 400,
        output_tokens: undefined,
        input_reduction_label: "estimated",
        notes: ["output not safely separable"]
      }),
      join(root, "out-cursor"),
      recordsDir
    );

    const summary = await createRunSummary(runsDir, recordsDir);
    expect(summary.per_tool_token_records.map((r) => r.tool)).toEqual(["codex", "cursor"]);
    expect(summary.run_records_source_glob).toBe(`${recordsDir}/*.json`);
    expect(summary.run_record_skipped_files).toEqual([]);

    const terminal = formatRunSummary(summary);
    expect(terminal).toContain("Per-tool run records (token sources)");
    expect(terminal).toContain("- codex: 1 run(s)");
    expect(terminal).toContain("1500 tokens live (provider-reported)");
    expect(terminal).toContain("output: unavailable for 1 run(s)");
    expect(terminal).toContain(OUTPUT_SAVINGS_UNAVAILABLE_LINE);

    const markdown = formatRunSummaryMarkdown(summary);
    expect(markdown).toContain("## Per-tool run records (token sources)");
    expect(markdown).toContain("400 tokens estimated (local-estimate)");
    expect(markdown).toContain(OUTPUT_SAVINGS_UNAVAILABLE_LINE);
  });

  it("shows the honest empty state when the records directory does not exist", async () => {
    const root = await makeTemporaryDirectory();
    const summary = await createRunSummary(join(root, "runs"), join(root, "run-records"));
    expect(summary.per_tool_token_records).toEqual([]);
    expect(formatRunSummary(summary)).toContain("none yet");
  });
});
