import { describe, expect, it } from "vitest";
import {
  OPTIMIZATION_MODES,
  OPTIMIZATION_MODE_HEADER,
  OPTIMIZATION_MODE_FOOTER,
  defaultOptimizationMode,
  findOptimizationMode,
  type OptimizationMode
} from "../../src/cli/onboarding/model.js";

/**
 * Fixture-only tests for the pure optimization-mode model.
 * No IO, no network, no keys. These modes map to EXISTING capabilities (record+proof /
 * experimental deterministic apply), the tests pin the honest copy, defaults, and the
 * claim boundaries a reviewer checks string-by-string.
 */

function byKey(key: OptimizationMode["key"]): OptimizationMode {
  const m = findOptimizationMode(key);
  if (!m) throw new Error(`missing optimization mode: ${key}`);
  return m;
}

describe("OPTIMIZATION_MODES - membership, order, defaults", () => {
  it("has exactly the two modes in order: cache-optimize, cache-context-optimize", () => {
    expect(OPTIMIZATION_MODES.map((m) => m.key)).toEqual(["cache-optimize", "cache-context-optimize"]);
  });

  it("mode 1 (cache-optimize) is the recommended default; mode 2 is not", () => {
    expect(byKey("cache-optimize").recommended).toBe(true);
    expect(byKey("cache-context-optimize").recommended).toBe(false);
    expect(defaultOptimizationMode()).toBe("cache-optimize");
    // Exactly one recommended mode, and it is the default.
    const recommended = OPTIMIZATION_MODES.filter((m) => m.recommended);
    expect(recommended).toHaveLength(1);
    expect(recommended[0].key).toBe(defaultOptimizationMode());
  });
});

describe("OPTIMIZATION_MODES - exact honest copy", () => {
  it("mode 1 one-liner is the exact allowed string", () => {
    expect(byKey("cache-optimize").oneLine).toBe(
      "Asks for shorter responses. Your input is sent exactly as written."
    );
  });

  it("mode 1 does not compact or edit your input, and requires no approval", () => {
    const m = byKey("cache-optimize");
    expect(m.meaning.inputBytesChanged).toBe(false);
    expect(m.meaning.approvalRequired).toBe(false);
  });

  it("mode 1 command is the gateway proof surfacing (provider-reported fresh input)", () => {
    expect(byKey("cache-optimize").command).toBe("compaction gateway proof --proof-run <id>");
  });

  it("mode 2 one-liner is the exact allowed string", () => {
    expect(byKey("cache-context-optimize").oneLine).toBe(
      "Compact input and shape output on supported requests. Confirm once for selected workflows."
    );
  });

  it("mode 2 compacts your input and requires approval before any change", () => {
    const m = byKey("cache-context-optimize");
    expect(m.meaning.inputBytesChanged).toBe(true);
    expect(m.meaning.approvalRequired).toBe(true);
  });

  it("mode 2 command performs the integrated scoped onboarding confirmation", () => {
    expect(byKey("cache-context-optimize").command).toBe(
      "compaction init --connect <workflow> --mode cache-plus-context"
    );
  });

  it("mode 2 states the composed treatment, narrow approval, and recovery in its meaning", () => {
    const mapsTo = byKey("cache-context-optimize").meaning.mapsTo.join(" ").toLowerCase();
    expect(mapsTo).toContain("deterministic exact-duplicate input compaction");
    expect(mapsTo).toContain("pre-generation output shaping");
    expect(mapsTo).toContain("recoverable");
    expect(mapsTo).toContain("narrow authorization");
  });
});

describe("OPTIMIZATION_MODES - claim boundaries (a reviewer checks every string)", () => {
  // The exact forbidden claims. NOTE: the bare word "optimize"/"optimization" is
  // ALLOWED here because it is the mode NAME (unlike the discovery copy) - only the
  // overclaiming forms below are banned.
  const forbidden = [
    "billing-confirmed",
    "invoice savings",
    "cost savings",
    "output-token savings",
    "semantic preservation",
    "no context lost",
    "learned-model superiority",
    "automatic optimization across all prompts",
    "automatic optimization",
    "all-provider",
    "lcm",
    "auto-apply"
  ];

  const allCopy: string[] = [
    OPTIMIZATION_MODE_HEADER,
    OPTIMIZATION_MODE_FOOTER,
    ...OPTIMIZATION_MODES.flatMap((m) => [m.title, m.oneLine, m.command, ...m.meaning.mapsTo])
  ];

  it("no exported optimization-mode copy contains a forbidden claim substring", () => {
    for (const text of allCopy) {
      const lower = text.toLowerCase();
      for (const bad of forbidden) {
        expect(lower.includes(bad.toLowerCase()), `"${text}" must not contain "${bad}"`).toBe(false);
      }
    }
  });

  it("mode 1 copy is mechanism-scoped, never a per-workflow guarantee", () => {
    const m = byKey("cache-optimize");
    // The headline is now the OUTPUT-ONLY promise, so the cache claim no longer sits in it. The
    // hedge did not disappear - it lives on the `mapsTo` bullet that still makes the claim, which
    // is where the guard below holds it. What the headline must never do is promise a cache result.
    expect(m.oneLine).toContain("Your input is sent exactly as written");
    expect(m.oneLine.toLowerCase()).not.toContain("cach");
    const caching = m.meaning.mapsTo.find((b) => b.toLowerCase().includes("cach"));
    expect(caching, "mode 1 must still explain the caching mechanism somewhere").toBeDefined();
    expect(caching).toContain("Where the provider caches");
    // never implies Compaction itself optimizes the cache
    expect(m.meaning.mapsTo.join(" ").toLowerCase()).toContain("provider-reported fresh input");
    // F65: was "changes nothing the model sees" - false on both modes, because output shaping attaches
    // an instruction to what the model sees regardless of mode. Only the INPUT claim is true here.
    expect(m.meaning.mapsTo.join(" ").toLowerCase()).toContain("your input is not compacted or edited");
    expect(m.meaning.mapsTo.join(" ").toLowerCase()).not.toContain("nothing the model sees");
  });

  it("the footer states the screen is read-only and Mode 2 uses one explicit scoped confirmation", () => {
    const lower = OPTIMIZATION_MODE_FOOTER.toLowerCase();
    expect(lower).toContain("writes nothing");
    expect(lower).toContain("one explicit scoped confirmation");
    expect(lower).toContain("nothing changes during onboarding");
  });
});
