import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  censusRequestInput,
  type RequestInputComponent
} from "../../src/core/request-input-census.js";
import type { AgentTrace, WasteFinding } from "../../src/core/types.js";
import { detectWaste } from "../../src/core/waste-detector.js";

const REPO_ROOT = join(__dirname, "..", "..");
const ARTIFACT = join(REPO_ROOT, "evals", "tool-result-fixture-census", "benchmark-report-v1.json");
const BENCHMARK_ID = "tool-result-fixture-census-reproducibility-v1";
const REQUEST_CENSUS_BENCHMARK_ID = "request-input-census-reproducibility-v1";

const REQUEST_CASES = [
  { fixtureId: "anthropic_messages", endpoint: "/v1/messages", path: "tests/fixtures/request-input-census/anthropic-messages.json" },
  { fixtureId: "openai_chat", endpoint: "/v1/chat/completions", path: "tests/fixtures/request-input-census/openai-chat.json" },
  { fixtureId: "openai_responses", endpoint: "/v1/responses", path: "tests/fixtures/request-input-census/openai-responses.json" },
  { fixtureId: "openai_responses_custom_tool_output", endpoint: "/v1/responses", path: "tests/fixtures/request-input-census/openai-responses-custom-tool-output.json" },
  { fixtureId: "openai_responses_native_discovery", endpoint: "/v1/responses", path: "tests/fixtures/request-input-census/openai-responses-native-discovery.json" },
  { fixtureId: "openai_responses_opaque_result", endpoint: "/v1/responses", path: "tests/fixtures/request-input-census/openai-responses-opaque-result.json" }
] as const;

const TRACE_CASES = [
  { fixtureId: "demo_coding_trace", path: "src/examples/demo-coding-trace.json" },
  { fixtureId: "demo_rag_trace", path: "src/examples/demo-rag-trace.json" },
  { fixtureId: "demo_support_trace", path: "src/examples/demo-support-trace.json" },
  { fixtureId: "demo_trace", path: "src/examples/demo-trace.json" },
  { fixtureId: "superseded_same_source_read", path: "tests/fixtures/superseded-same-source-read.json" }
] as const;

const DETECTOR_CATEGORIES = ["repeated_tool_output", "superseded_same_source_read"] as const;
type DetectorCategory = (typeof DETECTOR_CATEGORIES)[number];
type RequestBucket = "tool_result_text" | "structured_tool_search_result" | "opaque_nontext";

interface MeasuredTrace {
  candidateIds: string[];
  row: {
    fixture_id: string;
    tool_message_count: number;
    exact_tool_content_utf8_bytes: number;
    detector_findings_by_category: Record<DetectorCategory, number>;
    unique_candidate_count: number;
    detector_reported_local_estimate_tokens: number;
  };
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function requestBucket(component: RequestInputComponent): RequestBucket | null {
  if (component.category === "tool_result" && component.type === "tool_result_text") {
    return "tool_result_text";
  }
  if (component.category === "tool_result" && component.type === "tool_search_result") {
    return "structured_tool_search_result";
  }
  if (component.category === "opaque_nontext") return "opaque_nontext";
  return null;
}

function requestProjection() {
  const projected = REQUEST_CASES.flatMap(({ endpoint, path }) => {
    const census = censusRequestInput(endpoint, readFileSync(join(REPO_ROOT, path), "utf8"));
    return census.components.flatMap((component) => {
      const bucket = requestBucket(component);
      return bucket === null ? [] : [{ bucket, exact: component.exact }];
    });
  });

  const buckets = Object.fromEntries(
    (["tool_result_text", "structured_tool_search_result", "opaque_nontext"] as const).map((bucket) => {
      const components = projected.filter((component) => component.bucket === bucket);
      return [
        bucket,
        {
          component_count: components.length,
          utf8_bytes: components.reduce((sum, component) => sum + component.exact.utf8Bytes, 0),
          unicode_code_points: components.reduce((sum, component) => sum + component.exact.unicodeCodePoints, 0)
        }
      ];
    })
  ) as Record<RequestBucket, { component_count: number; utf8_bytes: number; unicode_code_points: number }>;

  return {
    source_benchmark_id: REQUEST_CENSUS_BENCHMARK_ID,
    fixture_count: REQUEST_CASES.length,
    buckets,
    total: {
      component_count: projected.length,
      utf8_bytes: projected.reduce((sum, component) => sum + component.exact.utf8Bytes, 0),
      unicode_code_points: projected.reduce((sum, component) => sum + component.exact.unicodeCodePoints, 0)
    }
  };
}

function findingCounts(findings: WasteFinding[]): Record<DetectorCategory, number> {
  return Object.fromEntries(
    DETECTOR_CATEGORIES.map((category) => [
      category,
      findings.filter((finding) => finding.category === category).length
    ])
  ) as Record<DetectorCategory, number>;
}

function measureTrace(fixtureId: string, path: string): MeasuredTrace {
  const trace = JSON.parse(readFileSync(join(REPO_ROOT, path), "utf8")) as AgentTrace;
  const toolMessages = trace.messages.filter((message) => message.role === "tool");
  const findings = detectWaste(trace);
  const candidateIds = findings.flatMap((finding) => finding.messageIds.slice(1));
  const uniqueCandidateCount = new Set(candidateIds).size;
  if (uniqueCandidateCount !== candidateIds.length) {
    throw new Error(`Detector candidate IDs are not unique within fixture ${fixtureId}`);
  }

  return {
    candidateIds,
    row: {
      fixture_id: fixtureId,
      tool_message_count: toolMessages.length,
      exact_tool_content_utf8_bytes: toolMessages.reduce(
        (sum, message) => sum + Buffer.byteLength(message.content, "utf8"),
        0
      ),
      detector_findings_by_category: findingCounts(findings),
      unique_candidate_count: uniqueCandidateCount,
      detector_reported_local_estimate_tokens: findings.reduce(
        (sum, finding) => sum + finding.estimatedTokens,
        0
      )
    }
  };
}

function detectorCensus() {
  const measured = TRACE_CASES.map(({ fixtureId, path }) => measureTrace(fixtureId, path));
  return {
    fixture_count: measured.length,
    cases: measured.map(({ row }) => row),
    aggregate: {
      tool_message_count: measured.reduce((sum, { row }) => sum + row.tool_message_count, 0),
      exact_tool_content_utf8_bytes: measured.reduce(
        (sum, { row }) => sum + row.exact_tool_content_utf8_bytes,
        0
      ),
      detector_findings_by_category: Object.fromEntries(
        DETECTOR_CATEGORIES.map((category) => [
          category,
          measured.reduce((sum, { row }) => sum + row.detector_findings_by_category[category], 0)
        ])
      ),
      detector_finding_count: measured.reduce(
        (sum, { row }) =>
          sum + Object.values(row.detector_findings_by_category).reduce((subtotal, count) => subtotal + count, 0),
        0
      ),
      unique_candidate_count: measured.reduce((sum, { row }) => sum + row.unique_candidate_count, 0),
      detector_reported_local_estimate_tokens: measured.reduce(
        (sum, { row }) => sum + row.detector_reported_local_estimate_tokens,
        0
      )
    }
  };
}

function benchmarkReport() {
  return {
    schema_version: 1,
    benchmark_id: BENCHMARK_ID,
    evidence_type: "synthetic_fixture",
    measurement_bases: {
      request_projection:
        "censusRequestInput canonical component values: decoded text values and JSON.stringify for structured or opaque values; excludes surrounding request-envelope bytes",
      trace_tool_content: "exact UTF-8 bytes of role=tool message content",
      detector_reported_local_estimate_tokens:
        "sum of current detectWaste finding estimatedTokens; current estimator is max(1, ceil(JavaScript string length / 4))"
    },
    request_projection: requestProjection(),
    detector_census: detectorCensus()
  };
}

describe("tool result fixture census reproducibility benchmark", () => {
  it("reproduces the checked-in report byte for byte from eleven sorted synthetic fixtures", () => {
    const requestIds = REQUEST_CASES.map(({ fixtureId }) => fixtureId);
    const traceIds = TRACE_CASES.map(({ fixtureId }) => fixtureId);
    expect([...requestIds].sort()).toEqual(requestIds);
    expect([...traceIds].sort()).toEqual(traceIds);
    expect(new Set([...requestIds, ...traceIds]).size).toBe(11);
    expect(stableJson(benchmarkReport())).toBe(readFileSync(ARTIFACT, "utf8"));
  });

  it("keeps request projection buckets closed on their canonical component-value basis", () => {
    const projection = requestProjection();
    const bucketTotals = Object.values(projection.buckets).reduce(
      (total, bucket) => ({
        component_count: total.component_count + bucket.component_count,
        utf8_bytes: total.utf8_bytes + bucket.utf8_bytes,
        unicode_code_points: total.unicode_code_points + bucket.unicode_code_points
      }),
      { component_count: 0, utf8_bytes: 0, unicode_code_points: 0 }
    );
    expect(bucketTotals).toEqual(projection.total);
    expect(projection.total).toEqual({ component_count: 7, utf8_bytes: 214, unicode_code_points: 211 });
  });

  it("proves detector candidate IDs are unique within each fixture before aggregation", () => {
    for (const { fixtureId, path } of TRACE_CASES) {
      const measured = measureTrace(fixtureId, path);
      expect(new Set(measured.candidateIds).size).toBe(measured.candidateIds.length);
      expect(measured.row.unique_candidate_count).toBe(measured.candidateIds.length);
    }
  });

  it("pins the aggregate detector census without treating local estimates as provider tokens", () => {
    expect(detectorCensus().aggregate).toEqual({
      tool_message_count: 22,
      exact_tool_content_utf8_bytes: 39760,
      detector_findings_by_category: {
        repeated_tool_output: 7,
        superseded_same_source_read: 1
      },
      detector_finding_count: 8,
      unique_candidate_count: 8,
      detector_reported_local_estimate_tokens: 5504
    });
  });

  it("uses only closed content-free report fields", () => {
    const report = benchmarkReport();
    expect(Object.keys(report)).toEqual([
      "schema_version",
      "benchmark_id",
      "evidence_type",
      "measurement_bases",
      "request_projection",
      "detector_census"
    ]);
    for (const row of report.detector_census.cases) {
      expect(Object.keys(row)).toEqual([
        "fixture_id",
        "tool_message_count",
        "exact_tool_content_utf8_bytes",
        "detector_findings_by_category",
        "unique_candidate_count",
        "detector_reported_local_estimate_tokens"
      ]);
      expect(Object.keys(row.detector_findings_by_category)).toEqual(DETECTOR_CATEGORIES);
    }
    const serialized = stableJson(report);
    for (const excluded of [
      "tool_name",
      "message_id",
      "candidate_id",
      "summary",
      "percentage",
      "delta",
      "opportunity_estimate",
      "reducibility",
      "semantic_preservation",
      "apply_safety",
      "wire_bytes",
      "provider_tokens",
      "savings"
    ]) {
      expect(serialized).not.toContain(`\"${excluded}\"`);
    }
  });
});
