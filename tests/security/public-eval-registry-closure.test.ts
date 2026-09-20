import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(__dirname, "..", "..");
const MANIFEST = join(REPO_ROOT, "evals", "manifest.json");
const PATH_FIELDS = new Set(["implementation", "tests", "fixtures", "artifacts", "docs"]);
const CENSUS_BENCHMARK_ID = "request-input-census-reproducibility-v1";
const CENSUS_FIXTURE_DIRECTORY = join(REPO_ROOT, "tests", "fixtures", "request-input-census");

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
});
