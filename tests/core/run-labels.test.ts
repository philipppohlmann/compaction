import { describe, expect, it } from "vitest";
import {
  buildRunLabelsFile,
  hasAnyLabel,
  normalizeRunLabels,
  parseRunLabels
} from "../../src/core/run-labels.js";

describe("run-labels (local-only tagging)", () => {
  it("normalizes/trims labels and drops empty fields", () => {
    const out = normalizeRunLabels({ project: "  p1 ", workflow: "", provider: "openai-agents", user_label: "   ", session: "s1" });
    expect(out).toEqual({ project: "p1", provider: "openai-agents", session: "s1" });
  });

  it("hasAnyLabel is false when nothing usable was supplied", () => {
    expect(hasAnyLabel({})).toBe(false);
    expect(hasAnyLabel({ project: "   " })).toBe(false);
    expect(hasAnyLabel({ workflow: "coding" })).toBe(true);
  });

  it("buildRunLabelsFile writes a versioned, honest, local-only artifact", () => {
    const file = buildRunLabelsFile({ project: "p1", provider: "openai-agents" }, "2026-06-16T00:00:00.000Z");
    expect(file.labels_version).toBe("1.0.0");
    expect(file.project).toBe("p1");
    expect(file.provider).toBe("openai-agents");
    expect(file.note.toLowerCase()).toContain("never uploaded");
    expect(file.note.toLowerCase()).toContain("operator-asserted");
  });

  it("parseRunLabels tolerates junk and keeps only the bounded label fields", () => {
    expect(parseRunLabels(null)).toEqual({});
    expect(parseRunLabels("nope")).toEqual({});
    expect(parseRunLabels({ project: "p1", evil: { nested: "x" }, provider: 42 })).toEqual({ project: "p1" });
  });

  it("caps over-long labels rather than storing arbitrary length", () => {
    const long = "x".repeat(500);
    const out = normalizeRunLabels({ user_label: long });
    expect(out.user_label!.length).toBe(200);
  });
});
