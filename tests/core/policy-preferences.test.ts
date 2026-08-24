/**
 * Auto-apply PREFERENCE store tests.
 *
 * Proven here, all in tmpdirs (never the real home / repo checkout):
 * - round-trip: save → read; deterministic content-free id over the scope; default enabled + the
 *   default gate list are materialized; no wall-clock field is ever written;
 * - SCOPE is NEVER global/cross-tool: a "global"/"all"/"*"/cross-tool tool value is REJECTED, a
 *   missing tool/policy_type is REJECTED, and a rejected scope writes NOTHING (fail-closed);
 * - THE FAIL-CLOSED PROOF: saving/enabling a preference (even preference="auto-when-gates-pass",
 *   enabled=true) mutates ONLY `policy-preferences.json`, no other file anywhere is created or
 *   changed, and no application runs (there is no apply path in the module);
 * - disable: sets enabled=false; is idempotent; unknown id → a clear error, NOTHING changed;
 * - explain: honest plain language per state, a legacy-gated preference is STORED, NEVER APPLIED
 *   (fail-closed on unevaluable gates); an engine-evaluable authorization states it is ACTIVE
 *   while enabled, every required gate, recovery, and how to disable.
 */
import { mkdtemp, readFile, readdir, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AUTO_APPLY_ELIGIBILITY_GATES,
  DEFAULT_GATES_REQUIRED,
  POLICY_PREFERENCE_ID_PATTERN,
  POLICY_PREFERENCES_FILENAME,
  computePolicyPreferenceId,
  disablePolicyPreference,
  explainPolicyPreference,
  findPolicyPreference,
  readPolicyPreferences,
  savePolicyPreference,
  validatePolicyPreferenceScope,
  type PolicyPreference
} from "../../src/core/policy-preferences.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "policy-prefs-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

/** Recursively snapshot { relativePath -> mtimeMs+size } for every file under root. */
async function snapshotTree(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  async function walk(current: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else {
        const info = await stat(full);
        out.set(relative(root, full), `${info.size}:${info.mtimeMs}`);
      }
    }
  }
  await walk(root);
  return out;
}

describe("policy preferences - round-trip", () => {
  it("saves and reads back one record with a deterministic id, defaults, and NO wall-clock", async () => {
    const result = await savePolicyPreference(
      { scope: { tool: "cursor", repo: "compaction-dev", policy_type: "stale_tool_output_to_state_capsule" }, preference: "auto-when-gates-pass" },
      dir
    );
    expect(result.saved).toBe(true);
    if (!result.saved) return;
    expect(POLICY_PREFERENCE_ID_PATTERN.test(result.preference.id)).toBe(true);
    expect(result.preference.id).toBe(
      computePolicyPreferenceId({ tool: "cursor", repo: "compaction-dev", policy_type: "stale_tool_output_to_state_capsule" })
    );
    expect(result.preference.enabled).toBe(true);
    expect(result.preference.gates_required).toEqual([...DEFAULT_GATES_REQUIRED]);

    const raw = await readFile(join(dir, POLICY_PREFERENCES_FILENAME), "utf8");
    expect(raw).not.toMatch(/created_at|timestamp|"time"/i);

    const { preferences } = await readPolicyPreferences(dir);
    expect(preferences).toHaveLength(1);
    expect(preferences[0]).toEqual(result.preference);
  });

  it("upserts by scope id (same scope replaces, not duplicates)", async () => {
    const scope = { tool: "cursor", policy_type: "p1" } as const;
    await savePolicyPreference({ scope, preference: "ask-each-time" }, dir);
    await savePolicyPreference({ scope, preference: "auto-when-gates-pass" }, dir);
    const { preferences } = await readPolicyPreferences(dir);
    expect(preferences).toHaveLength(1);
    expect(preferences[0].preference).toBe("auto-when-gates-pass");
  });

  it("a missing store is 'none saved yet', not an error", async () => {
    const { preferences } = await readPolicyPreferences(dir);
    expect(preferences).toEqual([]);
  });
});

describe("policy preferences - scope is never global or cross-tool", () => {
  it.each(["global", "all", "*", "any", "cross-tool", "GLOBAL"])(
    "rejects tool value %s and writes NOTHING",
    async (tool) => {
      const result = await savePolicyPreference({ scope: { tool, policy_type: "p" }, preference: "ask-each-time" }, dir);
      expect(result.saved).toBe(false);
      if (result.saved) return;
      expect(result.problems.join(" ")).toMatch(/never global|never.*cross-tool/i);
      await expect(stat(join(dir, POLICY_PREFERENCES_FILENAME))).rejects.toThrow();
    }
  );

  it("rejects a missing tool or policy_type", () => {
    expect(validatePolicyPreferenceScope({ policy_type: "p" }).problems.join(" ")).toMatch(/tool: required/);
    expect(validatePolicyPreferenceScope({ tool: "cursor" }).problems.join(" ")).toMatch(/policy_type: required/);
    expect(validatePolicyPreferenceScope({ tool: "cursor", policy_type: "p" }).problems).toEqual([]);
  });

  it("rejects unknown scope fields (content could hide there)", () => {
    expect(validatePolicyPreferenceScope({ tool: "cursor", policy_type: "p", prompt: "hi" }).problems.join(" ")).toMatch(
      /not an allowed scope field/
    );
  });
});

describe("policy preferences - FAIL-CLOSED PROOF: a preference applies NOTHING", () => {
  it("saving+enabling an auto-when-gates-pass preference mutates ONLY the preference file", async () => {
    // Seed unrelated files that an application engine would plausibly touch (run records, activity,
    // context). If saving a preference triggered ANY application, one of these would change.
    await mkdir(join(dir, ".compaction", "run-records"), { recursive: true });
    await mkdir(join(dir, ".compaction", "activity"), { recursive: true });
    await writeFile(join(dir, ".compaction", "run-records", "run-1.json"), '{"untouched":true}\n', "utf8");
    await writeFile(join(dir, ".compaction", "activity", "activity.jsonl"), "", "utf8");
    await writeFile(join(dir, "source-file.ts"), "// original content\n", "utf8");

    const before = await snapshotTree(dir);

    const result = await savePolicyPreference(
      { scope: { tool: "cursor", policy_type: "stale_tool_output_to_state_capsule" }, preference: "auto-when-gates-pass", enabled: true },
      join(dir, ".compaction")
    );
    expect(result.saved).toBe(true);

    const after = await snapshotTree(dir);

    // The ONLY difference between before and after is the new/updated preference file.
    const changed: string[] = [];
    for (const [path, sig] of after) {
      if (before.get(path) !== sig) changed.push(path);
    }
    for (const path of before.keys()) {
      if (!after.has(path)) changed.push(`(deleted) ${path}`);
    }
    expect(changed).toEqual([join(".compaction", POLICY_PREFERENCES_FILENAME)]);

    // The seeded files are byte-for-byte untouched (no application ran).
    expect(await readFile(join(dir, ".compaction", "run-records", "run-1.json"), "utf8")).toBe('{"untouched":true}\n');
    expect(await readFile(join(dir, ".compaction", "activity", "activity.jsonl"), "utf8")).toBe("");
    expect(await readFile(join(dir, "source-file.ts"), "utf8")).toBe("// original content\n");

    // The module exports no apply FUNCTION (there is no application path in this module - the
    // engine lives in gateway/apply-eligibility.ts). Data constants naming the eligibility gates
    // (AUTO_APPLY_ELIGIBILITY_GATES) are allowed: a readonly string list cannot apply anything.
    const moduleApi = await import("../../src/core/policy-preferences.js");
    const applyLike = Object.entries(moduleApi)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name)
      .filter((name) => /apply|execute|run|mutate|write.*trace/i.test(name));
    expect(applyLike).toEqual([]);
  });
});

describe("policy preferences - disable (the only mutating verb)", () => {
  async function seed(): Promise<PolicyPreference> {
    const result = await savePolicyPreference(
      { scope: { tool: "cursor", policy_type: "p" }, preference: "auto-when-gates-pass" },
      dir
    );
    if (!result.saved) throw new Error("seed failed");
    return result.preference;
  }

  it("sets enabled=false and is idempotent", async () => {
    const pref = await seed();
    const first = await disablePolicyPreference(pref.id, dir);
    expect(first.disabled).toBe(true);
    if (first.disabled) expect(first.alreadyDisabled).toBe(false);
    expect((await findPolicyPreference(pref.id, dir))?.enabled).toBe(false);

    const second = await disablePolicyPreference(pref.id, dir);
    expect(second.disabled).toBe(true);
    if (second.disabled) expect(second.alreadyDisabled).toBe(true);
    expect((await findPolicyPreference(pref.id, dir))?.enabled).toBe(false);
  });

  it("unknown id → a clear error and NOTHING changed", async () => {
    const pref = await seed();
    const before = await readFile(join(dir, POLICY_PREFERENCES_FILENAME), "utf8");
    const result = await disablePolicyPreference("pref-000000000000000000000000", dir);
    expect(result.disabled).toBe(false);
    if (!result.disabled) expect(result.reason).toMatch(/no preference with id/);
    // Existing preference and file are unchanged.
    expect((await findPolicyPreference(pref.id, dir))?.enabled).toBe(true);
    expect(await readFile(join(dir, POLICY_PREFERENCES_FILENAME), "utf8")).toBe(before);
  });
});

describe("policy preferences - explain is honest", () => {
  it("legacy default gates (not engine-evaluable): STORED, NEVER APPLIED - lists gates and how to disable", async () => {
    const result = await savePolicyPreference(
      { scope: { tool: "cursor", repo: "r", policy_type: "p" }, preference: "auto-when-gates-pass" },
      dir
    );
    if (!result.saved) throw new Error("save failed");
    const text = explainPolicyPreference(result.preference);
    // The legacy DEFAULT_GATES_REQUIRED names gates the eligibility engine does not evaluate, so
    // this preference can never drive an application - explain must say so (fail-closed).
    expect(text).toMatch(/STORED, NEVER APPLIED/);
    expect(text).toMatch(/does not evaluate/);
    expect(text).toContain("recoverability-pass");
    expect(text).toContain(`compaction policies disable ${result.preference.id}`);
    expect(text).not.toMatch(/\bsavings\b/i);
    expect(text).not.toMatch(/\$\d/);
  });

  it("engine-evaluable gates: ACTIVE while enabled - every gate, the unchanged/fail-open boundary, recovery, disable", async () => {
    const result = await savePolicyPreference(
      {
        scope: { tool: "claude-code", policy_type: "deterministic-dedupe" },
        preference: "auto-when-gates-pass",
        gates_required: [...AUTO_APPLY_ELIGIBILITY_GATES]
      },
      dir
    );
    if (!result.saved) throw new Error("save failed");
    const text = explainPolicyPreference(result.preference);
    expect(text).toMatch(/ACTIVE while enabled/);
    for (const gate of AUTO_APPLY_ELIGIBILITY_GATES) expect(text).toContain(gate);
    expect(text).toMatch(/forwarded UNCHANGED/);
    expect(text).toMatch(/fail-open/);
    expect(text).toContain("compaction gateway recover");
    expect(text).toContain("compaction activity");
    expect(text).toContain(`compaction policies disable ${result.preference.id}`);
    expect(text).not.toMatch(/\bsavings\b/i);
    expect(text).not.toMatch(/\$\d/);
  });

  it("engine-evaluable gates but DISABLED: states nothing is applied automatically under it", async () => {
    const saved = await savePolicyPreference(
      {
        scope: { tool: "codex", policy_type: "deterministic-dedupe" },
        preference: "auto-when-gates-pass",
        gates_required: [...AUTO_APPLY_ELIGIBILITY_GATES],
        enabled: false
      },
      dir
    );
    if (!saved.saved) throw new Error("save failed");
    expect(explainPolicyPreference(saved.preference)).toMatch(/DISABLED: nothing is applied automatically/);
  });

  it("ask-each-time explains nothing is ever applied automatically", async () => {
    const result = await savePolicyPreference({ scope: { tool: "cursor", policy_type: "p" }, preference: "ask-each-time" }, dir);
    if (!result.saved) throw new Error("save failed");
    expect(explainPolicyPreference(result.preference)).toMatch(/asks every time|nothing is ever applied automatically/i);
  });
});
