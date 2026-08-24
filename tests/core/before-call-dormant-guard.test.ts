// DORMANT-GUARD: the approved before-call mutation machinery ships but must stay
// PROVABLY INERT for the real tools, and must NEVER auto-activate just because a future tool version adds
// a flag. This test is the tripwire: it FAILS the moment anyone populates a prompt-flag whitelist or pins
// a verifiedToolVersion for a real tool. Turning apply on for a tool is therefore a DELIBERATE act that
// requires ALL of: (1) the whitelist entry, (2) a pinned verifiedToolVersion (whose --help surface was
// re-verified to expose a value-taking prompt flag), (3) safe-form tests, and (4) editing this assertion.
//
// If this test ever needs updating to activate a tool, that edit is the explicit, reviewed activation.

import { describe, expect, it } from "vitest";
import {
  SAFE_MUTATION_SPECS,
  resolveSafeMutation,
  type BeforeCallTool
} from "../../src/core/before-call.js";

const REAL_TOOLS: BeforeCallTool[] = ["codex", "cursor"];

describe("before-call dormant guard (activation must be explicit + versioned)", () => {
  it("both real tools ship with an EMPTY prompt-flag whitelist (no safe argv mutation exists)", () => {
    for (const tool of REAL_TOOLS) {
      expect(SAFE_MUTATION_SPECS[tool].promptFlags).toEqual([]);
    }
  });

  it("no real tool pins a verifiedToolVersion (apply stays dormant)", () => {
    for (const tool of REAL_TOOLS) {
      expect(SAFE_MUTATION_SPECS[tool].verifiedToolVersion).toBeUndefined();
    }
  });

  it("resolveSafeMutation is NOT applyAvailable for any real tool, whatever the argv", () => {
    const argvs = [
      ["exec", "--json", "do the task"],
      ["exec", "--json", "-p", "myprofile", "do the task"],
      ["-p", "prompt text", "--output-format", "json"],
      ["--prompt=hello", "--json"],
      [],
      ["--unknown-future-flag", "value", "prompt"]
    ];
    for (const tool of REAL_TOOLS) {
      for (const argv of argvs) {
        const r = resolveSafeMutation(tool, argv);
        expect(r.applyAvailable).toBe(false);
      }
    }
  });

  it("a populated whitelist WITHOUT a pinned verifiedToolVersion still fail-closes (versioned-activation gate)", () => {
    // Simulate a future maintainer adding a flag but forgetting the version pin: must NOT activate.
    const unpinned = {
      promptFlags: ["--prompt"],
      valueFlags: [],
      booleanFlags: []
      // verifiedToolVersion intentionally absent
    };
    const r = resolveSafeMutation("cursor", ["--prompt", "hello"], unpinned);
    expect(r.applyAvailable).toBe(false);
    if (!r.applyAvailable) expect(r.reason).toMatch(/verifiedToolVersion|versioned/i);
  });

  it("only an EXPLICIT whitelist + pinned version can reach applyAvailable (the deliberate activation path)", () => {
    // This is the ONLY shape that activates, proving the gate works, without activating a real tool.
    const activated = {
      promptFlags: ["--prompt"],
      valueFlags: [],
      booleanFlags: ["--json"],
      verifiedToolVersion: "cursor-agent 9.9.9 (synthetic test pin)"
    };
    const r = resolveSafeMutation("cursor", ["--prompt", "hello", "--json"], activated);
    expect(r.applyAvailable).toBe(true);
  });
});
