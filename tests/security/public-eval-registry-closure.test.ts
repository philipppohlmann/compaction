import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(__dirname, "..", "..");
const MANIFEST = join(REPO_ROOT, "evals", "manifest.json");
const PATH_FIELDS = new Set(["implementation", "tests", "fixtures", "docs"]);

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
});
