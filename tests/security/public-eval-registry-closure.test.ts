import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(__dirname, "..", "..");
const MANIFEST = join(REPO_ROOT, "evals", "manifest.json");
const PATH_FIELDS = new Set(["implementation", "tests", "fixtures", "artifacts", "docs"]);
const CENSUS_BENCHMARK_ID = "request-input-census-reproducibility-v1";
const CENSUS_FIXTURE_DIRECTORY = join(REPO_ROOT, "tests", "fixtures", "request-input-census");
const TOOL_RESULT_CENSUS_ID = "tool-result-fixture-census-reproducibility-v1";
const TOOL_RESULT_CENSUS_FIXTURES = [
  "src/examples/demo-coding-trace.json",
  "src/examples/demo-rag-trace.json",
  "src/examples/demo-support-trace.json",
  "src/examples/demo-trace.json",
  "tests/fixtures/request-input-census/anthropic-messages.json",
  "tests/fixtures/request-input-census/openai-chat.json",
  "tests/fixtures/request-input-census/openai-responses-custom-tool-output.json",
  "tests/fixtures/request-input-census/openai-responses-native-discovery.json",
  "tests/fixtures/request-input-census/openai-responses-opaque-result.json",
  "tests/fixtures/request-input-census/openai-responses.json",
  "tests/fixtures/superseded-same-source-read.json"
] as const;

function pathReferences(value: unknown): string[] {
  if (typeof value === "string") {
    return /^(?:src|tests|docs|evals)\//.test(value) || /^[A-Z][A-Z_]*\.md$/.test(value) ? [value] : [];
  }
  if (Array.isArray(value)) return value.flatMap(pathReferences);
  return [];
}

describe("public eval registry path closure", () => {
  it("references only paths present in this tree", () => {
    const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as { evals?: Array<Record<string, unknown>> };
    const references = (manifest.evals ?? []).flatMap((entry) =>
      Object.entries(entry).flatMap(([field, value]) => (PATH_FIELDS.has(field) ? pathReferences(value) : [])),
    );

    expect(references.length).toBeGreaterThan(5);
    expect(references.filter((path) => !existsSync(join(REPO_ROOT, path)))).toEqual([]);
  });

  it("registers the request input census benchmark and its complete fixture set once", () => {
    const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as { evals?: Array<Record<string, unknown>> };
    const matches = (manifest.evals ?? []).filter((entry) => entry.id === CENSUS_BENCHMARK_ID);
    expect(matches).toHaveLength(1);

    const entry = matches[0];
    expect(entry).toMatchObject({
      evidence_type: "synthetic_fixture",
      proves: ["deterministic_reproduction_over_six_fixed_synthetic_fixtures_only"],
      does_not_prove: [
        "provider_prompt_construction",
        "provider_token_counts",
        "native_provider_runtime_behavior",
        "request_input_reduction",
        "savings",
        "semantic_preservation",
        "generalization_beyond_six_registered_synthetic_fixtures"
      ],
      implementation: ["src/core/request-input-census.ts"],
      tests: [
        "tests/core/request-input-census.test.ts",
        "tests/core/request-input-census-benchmark.test.ts",
        "tests/security/public-eval-registry-closure.test.ts"
      ],
      artifacts: ["evals/request-input-census/benchmark-report-v1.json"]
    });

    const fixtures = entry?.fixtures as string[];
    const registeredFixtureFiles = readdirSync(CENSUS_FIXTURE_DIRECTORY)
      .filter((name) => name.endsWith(".json"))
      .map((name) => `tests/fixtures/request-input-census/${name}`)
      .sort();
    expect(fixtures).toHaveLength(6);
    expect(new Set(fixtures).size).toBe(fixtures.length);
    expect([...fixtures].sort()).toEqual(registeredFixtureFiles);
  });

  it("registers the tool-result fixture census and its exact public evidence set once", () => {
    const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as { evals?: Array<Record<string, unknown>> };
    const matches = (manifest.evals ?? []).filter((entry) => entry.id === TOOL_RESULT_CENSUS_ID);
    expect(matches).toHaveLength(1);

    const entry = matches[0];
    expect(entry).toMatchObject({
      evidence_type: "synthetic_fixture",
      proves: [
        "deterministic_reproduction_over_exact_eleven_registered_synthetic_fixtures_only",
        "current_detect_waste_behavior_on_five_registered_synthetic_trace_fixtures_only"
      ],
      does_not_prove: [
        "real_trace_prevalence",
        "provider_prompt_construction",
        "provider_token_counts",
        "reducibility",
        "achievable_reduction",
        "semantic_preservation",
        "context_preservation",
        "policy_safety",
        "apply_safety",
        "savings",
        "generalization_beyond_eleven_registered_synthetic_fixtures"
      ],
      implementation: ["src/core/request-input-census.ts", "src/core/waste-detector.ts"],
      tests: [
        "tests/core/tool-result-fixture-census-benchmark.test.ts",
        "tests/security/public-eval-registry-closure.test.ts"
      ],
      artifacts: ["evals/tool-result-fixture-census/benchmark-report-v1.json"]
    });

    for (const field of ["proves", "does_not_prove", "implementation", "tests", "fixtures", "artifacts"] as const) {
      const values = entry?.[field] as string[];
      expect(new Set(values).size).toBe(values.length);
    }
    expect(entry?.fixtures).toEqual(TOOL_RESULT_CENSUS_FIXTURES);
    expect([...TOOL_RESULT_CENSUS_FIXTURES].sort()).toEqual(TOOL_RESULT_CENSUS_FIXTURES);
  });
});
