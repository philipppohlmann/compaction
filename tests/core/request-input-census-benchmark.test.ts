import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  censusRequestInput,
  type ComponentSize,
  type InputCategory,
  type RequestInputCensus,
  type RequestInputComponent
} from "../../src/core/request-input-census.js";

const REPO_ROOT = join(__dirname, "..", "..");
const FIXTURE_DIRECTORY = join(REPO_ROOT, "tests", "fixtures", "request-input-census");
const ARTIFACT = join(REPO_ROOT, "evals", "request-input-census", "benchmark-report-v1.json");
const BENCHMARK_ID = "request-input-census-reproducibility-v1";

const CATEGORIES = [
  "instructions",
  "conversation",
  "active_input",
  "tool_definition",
  "tool_call",
  "tool_result",
  "other_prompt",
  "opaque_nontext",
  "transport_control",
  "unclassified"
] as const satisfies readonly InputCategory[];

const CASES = [
  { caseId: "anthropic_messages", endpoint: "/v1/messages", fixture: "anthropic-messages.json" },
  { caseId: "openai_chat", endpoint: "/v1/chat/completions", fixture: "openai-chat.json" },
  { caseId: "openai_responses", endpoint: "/v1/responses", fixture: "openai-responses.json" },
  {
    caseId: "openai_responses_custom_tool_output",
    endpoint: "/v1/responses",
    fixture: "openai-responses-custom-tool-output.json"
  },
  {
    caseId: "openai_responses_native_discovery",
    endpoint: "/v1/responses",
    fixture: "openai-responses-native-discovery.json"
  },
  {
    caseId: "openai_responses_opaque_result",
    endpoint: "/v1/responses",
    fixture: "openai-responses-opaque-result.json"
  }
] as const;

const EXPECTED_CASE_IDS = [
  "anthropic_messages",
  "openai_chat",
  "openai_responses",
  "openai_responses_custom_tool_output",
  "openai_responses_native_discovery",
  "openai_responses_opaque_result"
] as const;

type ClosedSize = { utf8_bytes: number; unicode_code_points: number };
type BenchmarkCaseId = (typeof CASES)[number]["caseId"];
type NativeBucket = "direct" | "deferred" | "namespace" | "discovered";

function zeroSize(): ComponentSize {
  return { utf8Bytes: 0, unicodeCodePoints: 0 };
}

function addSize(total: ComponentSize, size: ComponentSize): ComponentSize {
  return {
    utf8Bytes: total.utf8Bytes + size.utf8Bytes,
    unicodeCodePoints: total.unicodeCodePoints + size.unicodeCodePoints
  };
}

function sumComponents(components: readonly RequestInputComponent[]): ComponentSize {
  return components.reduce((total, component) => addSize(total, component.exact), zeroSize());
}

function closedSize(size: ComponentSize): ClosedSize {
  return { utf8_bytes: size.utf8Bytes, unicode_code_points: size.unicodeCodePoints };
}

function sameSize(left: ComponentSize, right: ComponentSize): boolean {
  return left.utf8Bytes === right.utf8Bytes && left.unicodeCodePoints === right.unicodeCodePoints;
}

function nativeBucket(component: RequestInputComponent): NativeBucket | null {
  if (component.type === "tool_definition_direct") return "direct";
  if (component.type === "tool_definition_deferred") return "deferred";
  if (
    component.type === "tool_namespace_type" ||
    component.type === "tool_namespace_name" ||
    component.type === "tool_namespace_description"
  ) {
    return "namespace";
  }
  if (component.type === "tool_search_result") return "discovered";
  return null;
}

function projectCase(caseId: BenchmarkCaseId, census: RequestInputCensus) {
  const categorySizes = Object.fromEntries(
    CATEGORIES.map((category) => [
      category,
      sumComponents(census.components.filter((component) => component.category === category))
    ])
  ) as Record<InputCategory, ComponentSize>;
  const categoryTotal = CATEGORIES.reduce(
    (total, category) => addSize(total, categorySizes[category]),
    zeroSize()
  );

  const dispositionSizes = {
    included: census.totals.promptIncluded,
    excluded: census.totals.transportExcluded,
    unknown: census.totals.promptUnknown
  };
  const dispositionTotal = Object.values(dispositionSizes).reduce(addSize, zeroSize());

  const nativeSizes: Record<NativeBucket, ComponentSize> = {
    direct: zeroSize(),
    deferred: zeroSize(),
    namespace: zeroSize(),
    discovered: zeroSize()
  };
  for (const component of census.components) {
    const bucket = nativeBucket(component);
    if (bucket !== null) nativeSizes[bucket] = addSize(nativeSizes[bucket], component.exact);
  }
  const nativeScopeTotal = sumComponents(
    census.components.filter((component) => nativeBucket(component) !== null)
  );
  const nativeBucketTotal = (Object.keys(nativeSizes) as NativeBucket[]).reduce(
    (total, bucket) => addSize(total, nativeSizes[bucket]),
    zeroSize()
  );

  const partitionClosed =
    sameSize(categoryTotal, census.totals.componentValues) &&
    sameSize(dispositionTotal, census.totals.componentValues) &&
    sameSize(nativeBucketTotal, nativeScopeTotal);

  return {
    case_id: caseId,
    protocol: census.protocol,
    parsed: census.parsed,
    measurement_basis: census.basis,
    raw_request_source: closedSize(census.source),
    canonical_component_values: closedSize(census.totals.componentValues),
    category_totals: Object.fromEntries(
      CATEGORIES.map((category) => [category, closedSize(categorySizes[category])])
    ),
    disposition_totals: {
      included: closedSize(dispositionSizes.included),
      excluded: closedSize(dispositionSizes.excluded),
      unknown: closedSize(dispositionSizes.unknown)
    },
    local_estimate: {
      tokens: census.totals.localEstimate.tokens,
      estimator: census.totals.localEstimate.estimatorId,
      covered_code_points: census.totals.localEstimate.coveredCodePoints,
      eligible_code_points: census.totals.localEstimate.eligibleCodePoints,
      coverage: census.totals.localEstimate.coverage
    },
    native_discovery: {
      direct: closedSize(nativeSizes.direct),
      deferred: closedSize(nativeSizes.deferred),
      namespace: closedSize(nativeSizes.namespace),
      discovered: closedSize(nativeSizes.discovered),
      scope_total: closedSize(nativeScopeTotal)
    },
    partition_status: partitionClosed ? "closed" : "residual_present"
  };
}

function benchmarkReport() {
  return {
    schema_version: 1,
    benchmark_id: BENCHMARK_ID,
    evidence_type: "synthetic_fixture",
    cases: CASES.map((benchmarkCase) => {
      const body = readFileSync(join(FIXTURE_DIRECTORY, benchmarkCase.fixture), "utf8");
      return projectCase(benchmarkCase.caseId, censusRequestInput(benchmarkCase.endpoint, body));
    })
  };
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sizesTotal(values: Record<string, ClosedSize>): ClosedSize {
  return Object.values(values).reduce(
    (total, size) => ({
      utf8_bytes: total.utf8_bytes + size.utf8_bytes,
      unicode_code_points: total.unicode_code_points + size.unicode_code_points
    }),
    { utf8_bytes: 0, unicode_code_points: 0 }
  );
}

describe("request input census benchmark report", () => {
  it("reproduces the checked-in report byte for byte from six sorted fixtures", () => {
    expect(CASES.map((benchmarkCase) => benchmarkCase.caseId)).toEqual(EXPECTED_CASE_IDS);
    expect([...EXPECTED_CASE_IDS].sort()).toEqual(EXPECTED_CASE_IDS);
    expect(new Set(EXPECTED_CASE_IDS).size).toBe(EXPECTED_CASE_IDS.length);
    expect(CASES).toHaveLength(6);
    expect(stableJson(benchmarkReport())).toBe(readFileSync(ARTIFACT, "utf8"));
  });

  it("keeps category, disposition, and native discovery partitions closed", () => {
    const report = benchmarkReport();
    for (const benchmarkCase of report.cases) {
      expect(Object.keys(benchmarkCase.category_totals)).toEqual(CATEGORIES);
      expect(sizesTotal(benchmarkCase.category_totals)).toEqual(benchmarkCase.canonical_component_values);
      expect(sizesTotal(benchmarkCase.disposition_totals)).toEqual(benchmarkCase.canonical_component_values);
      expect(
        sizesTotal({
          direct: benchmarkCase.native_discovery.direct,
          deferred: benchmarkCase.native_discovery.deferred,
          namespace: benchmarkCase.native_discovery.namespace,
          discovered: benchmarkCase.native_discovery.discovered
        })
      ).toEqual(benchmarkCase.native_discovery.scope_total);
      expect(benchmarkCase.partition_status).toBe("closed");
    }
  });

  it("keeps raw request and canonical component measurements as separate bases", () => {
    const report = benchmarkReport();
    for (const benchmarkCase of report.cases) {
      expect(benchmarkCase).toHaveProperty("raw_request_source");
      expect(benchmarkCase).toHaveProperty("canonical_component_values");
      expect(benchmarkCase).not.toHaveProperty("difference");
      expect(benchmarkCase).not.toHaveProperty("reduction");
      expect(benchmarkCase).not.toHaveProperty("savings");
    }
  });

  it("preserves null coverage and unavailable component coverage without inventing tokens", () => {
    const empty = projectCase(
      "openai_responses",
      censusRequestInput("/v1/responses", JSON.stringify({ input: "" }))
    );
    expect(empty.local_estimate.coverage).toBeNull();

    const opaque = benchmarkReport().cases.find(
      (benchmarkCase) => benchmarkCase.case_id === "openai_responses_opaque_result"
    );
    expect(opaque?.local_estimate.covered_code_points).toBeLessThan(
      opaque?.local_estimate.eligible_code_points ?? 0
    );
  });

  it("does not emit hostile request values, names, keys, or path markers", () => {
    const markers = [
      "HOSTILE_PRIVATE_VALUE_MARKER",
      "HOSTILE_PRIVATE_NAME_MARKER",
      "HOSTILE_PRIVATE_KEY_MARKER",
      "HOSTILE_PRIVATE_PATH_MARKER"
    ];
    const census = censusRequestInput(
      "/v1/responses",
      JSON.stringify({
        input: [
          {
            type: "function_call",
            name: markers[1],
            call_id: markers[3],
            arguments: markers[0]
          }
        ],
        [markers[2]]: markers[0]
      })
    );
    const serialized = stableJson(projectCase("openai_responses", census));
    for (const marker of markers) expect(serialized).not.toContain(marker);
    expect(serialized).not.toContain("$.input");
    expect(serialized).not.toContain("/v1/responses");
  });

  it("uses only the closed report fields", () => {
    const report = benchmarkReport();
    expect(Object.keys(report)).toEqual(["schema_version", "benchmark_id", "evidence_type", "cases"]);
    for (const benchmarkCase of report.cases) {
      expect(Object.keys(benchmarkCase)).toEqual([
        "case_id",
        "protocol",
        "parsed",
        "measurement_basis",
        "raw_request_source",
        "canonical_component_values",
        "category_totals",
        "disposition_totals",
        "local_estimate",
        "native_discovery",
        "partition_status"
      ]);
      expect(Object.keys(benchmarkCase.local_estimate)).toEqual([
        "tokens",
        "estimator",
        "covered_code_points",
        "eligible_code_points",
        "coverage"
      ]);
      expect(Object.keys(benchmarkCase.native_discovery)).toEqual([
        "direct",
        "deferred",
        "namespace",
        "discovered",
        "scope_total"
      ]);
    }
  });
});
