import { describe, it, expect } from "vitest";
import {
  resolveSafeMutation,
  SAFE_MUTATION_SPECS,
  type SafeMutationSpec
} from "../../src/core/before-call.js";

/**
 * The SAFETY CORE. `resolveSafeMutation` is the single chokepoint that decides whether a
 * before-call mutation is even POSSIBLE. The invariant under test: for the REAL Codex/Cursor CLIs it is
 * NEVER apply-available (their prompt is a bare positional), so a mutation of a real invocation is
 * impossible by construction. The (dormant) whitelist path is exercised with a SYNTHETIC spec to prove
 * the rebuild is byte-exact, it is never reachable for the real tools.
 */

describe("resolveSafeMutation - real Codex/Cursor forms NEVER mutate (bare-positional prompt)", () => {
  it("codex: the standard `exec --json <prompt>` form is apply-NOT-available (prompt is a positional)", () => {
    const r = resolveSafeMutation("codex", ["exec", "--json", "do the task"]);
    expect(r.applyAvailable).toBe(false);
    if (!r.applyAvailable) expect(r.reason).toMatch(/bare positional/);
  });

  it("codex: `-p` is --profile (a VALUE flag), NOT the prompt - its value is never mutated", () => {
    // A naive 'value after -p' mutator would corrupt the profile name. We fail closed on the trailing
    // bare positional instead.
    const r = resolveSafeMutation("codex", ["exec", "-p", "my-profile", "do the task"]);
    expect(r.applyAvailable).toBe(false);
  });

  it("cursor: the standard `-p <prompt> --output-format json` form is apply-NOT-available", () => {
    // `-p` is --print (BOOLEAN); "do X" is a bare positional prompt → not provably isolated.
    const r = resolveSafeMutation("cursor", ["-p", "do the task", "--output-format", "json"]);
    expect(r.applyAvailable).toBe(false);
    if (!r.applyAvailable) expect(r.reason).toMatch(/bare positional|no value-taking prompt flag/);
  });

  it("cursor: even a raw `-p <secret>` never yields an apply-available mutation", () => {
    const r = resolveSafeMutation("cursor", ["-p", "SECRET-do-not-mutate"]);
    expect(r.applyAvailable).toBe(false);
  });

  it("both real specs ship with an EMPTY prompt-flag whitelist (the load-bearing safety fact)", () => {
    expect(SAFE_MUTATION_SPECS.codex.promptFlags).toEqual([]);
    expect(SAFE_MUTATION_SPECS.cursor.promptFlags).toEqual([]);
  });

  it("fuzz: NO argv over the real specs is ever apply-available", () => {
    const tokens = ["exec", "--json", "-p", "profile", "--print", "--output-format", "json", "do X", "another", "-m", "gpt", "--unknown"];
    for (const tool of ["codex", "cursor"] as const) {
      for (let n = 0; n <= 4; n += 1) {
        // a handful of representative combinations of length n
        const argv = tokens.slice(0, n);
        expect(resolveSafeMutation(tool, argv).applyAvailable).toBe(false);
      }
    }
  });
});

describe("resolveSafeMutation - dormant whitelist path (synthetic spec), byte-exact rebuild", () => {
  // A hypothetical future tool that DOES expose a value-taking prompt flag. This spec is NEVER used for
  // the real tools; it only proves the mutation logic is correct + ready.
  const synth: SafeMutationSpec = {
    promptFlags: ["--prompt", "-P"],
    valueFlags: ["--model", "--output-format"],
    booleanFlags: ["--json", "--print"],
    // Versioned-activation gate: a populated whitelist is honored ONLY with a
    // pinned verifiedToolVersion. This synthetic spec is a hypothetical ACTIVATED tool, so it pins one.
    verifiedToolVersion: "synthetic-tool 1.0.0 (test fixture)"
  };

  it("standalone prompt flag → apply-available; rebuild replaces ONLY the prompt, all else byte-identical", () => {
    const argv = ["--model", "gpt", "--prompt", "ORIGINAL PROMPT", "--json"];
    const r = resolveSafeMutation("codex", argv, synth);
    expect(r.applyAvailable).toBe(true);
    if (r.applyAvailable) {
      expect(r.originalPrompt).toBe("ORIGINAL PROMPT");
      const rebuilt = r.rebuild("COMPACTED");
      expect(rebuilt).toEqual(["--model", "gpt", "--prompt", "COMPACTED", "--json"]);
      // every non-prompt token is byte-identical + in order
      expect(rebuilt.filter((_, i) => i !== r.promptIndex)).toEqual(argv.filter((_, i) => i !== r.promptIndex));
      // the caller's argv is not mutated in place
      expect(argv[3]).toBe("ORIGINAL PROMPT");
    }
  });

  it("inline prompt flag (--prompt=value) → apply-available; rebuild keeps the inline form", () => {
    const argv = ["--prompt=hello world", "--output-format", "json"];
    const r = resolveSafeMutation("cursor", argv, synth);
    expect(r.applyAvailable).toBe(true);
    if (r.applyAvailable) {
      expect(r.inline).toBe(true);
      expect(r.originalPrompt).toBe("hello world");
      expect(r.rebuild("smaller")).toEqual(["--prompt=smaller", "--output-format", "json"]);
    }
  });

  it("fail-closed: an unknown flag anywhere → apply-NOT-available", () => {
    const r = resolveSafeMutation("codex", ["--prompt", "x", "--totally-unknown"], synth);
    expect(r.applyAvailable).toBe(false);
  });

  it("fail-closed: a bare positional alongside a prompt flag → apply-NOT-available", () => {
    const r = resolveSafeMutation("codex", ["--prompt", "x", "stray-positional"], synth);
    expect(r.applyAvailable).toBe(false);
  });

  it("fail-closed: two prompt flags → ambiguous → apply-NOT-available", () => {
    const r = resolveSafeMutation("codex", ["--prompt", "a", "-P", "b"], synth);
    expect(r.applyAvailable).toBe(false);
  });

  it("fail-closed: a prompt flag whose value looks like a flag → apply-NOT-available", () => {
    const r = resolveSafeMutation("codex", ["--prompt", "--json"], synth);
    expect(r.applyAvailable).toBe(false);
  });

  it("a known value flag's value is skipped, never treated as the prompt", () => {
    // --model's value "gpt" must not be mistaken for a prompt; the only mutable token is the --prompt value.
    const r = resolveSafeMutation("codex", ["--model", "gpt", "--prompt", "P"], synth);
    expect(r.applyAvailable).toBe(true);
    if (r.applyAvailable) expect(r.rebuild("Q")).toEqual(["--model", "gpt", "--prompt", "Q"]);
  });
});
