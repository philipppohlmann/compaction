/**
 * WHAT `compaction login` TELLS A USER IS STILL MISSING.
 *
 * This output had NO test coverage, and shipped two provably false claims:
 *
 *   1. It printed "Input compaction is armed" in green on a device the gateway would decline, because it
 *      assembled its own checklist (connected workflows + `pendingFullApplyGate` + product mode) that
 *      omitted three conditions the gateway enforces: engine reachability, lease validity, and
 *      `compaction stop`. On a device with no runnable engine it contradicted `printCommunitySetup`'s
 *      "Full optimization cannot run on this device" two lines above it.
 *   2. When something WAS pending it threw away the reason and unconditionally printed the authorize
 *      step — so a device blocked on the optimization mode was handed a command that changes nothing,
 *      the real blocker was never named, and the next login printed the same thing. A dead end.
 *
 * Both are pinned here against the resolver the GATEWAY itself uses, which is the only source that
 * cannot omit a condition the gateway has.
 */
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { leasePath } from "../../src/core/entitlement/lease-store.js";
import { REFRESH_COMMUNITY_REMEDY } from "../../src/cli/commands/upgrade-status.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { printRemainingFullApplySteps } from "../../src/cli/commands/login.js";
import { writeOptimizationMode, addConnectedWorkflows, removeConnectedWorkflow, writeProductMode } from "../../src/core/onboarding-preferences.js";
import { savePolicyPreference, AUTO_APPLY_ELIGIBILITY_GATES } from "../../src/core/policy-preferences.js";
import { provisionValidLease } from "../helpers/lease-fixture.js";

let dir: string;

async function capture(env: NodeJS.ProcessEnv): Promise<string> {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  try {
    await printRemainingFullApplySteps(env);
  } finally {
    spy.mockRestore();
  }
  return lines.join("\n");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "login-steps-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("login's remaining-steps output", () => {
  it("does NOT claim input compaction is armed when no engine can run here", async () => {
    // Everything else armed: credentials + valid lease + full mode + input-opt + connect + authorization.
    provisionValidLease(dir);
    const env = { COMPACTION_CONFIG_DIR: dir, COMPACTION_ENGINE_PATH: "/nonexistent/engine.js" } as NodeJS.ProcessEnv;
    writeOptimizationMode("cache-plus-context", env);
    addConnectedWorkflows(["claude-code"], env);
    await savePolicyPreference(
      {
        scope: { tool: "claude-code", policy_type: "deterministic-dedupe" },
        preference: "auto-when-gates-pass",
        gates_required: [...AUTO_APPLY_ELIGIBILITY_GATES]
      },
      dir
    );
    const out = await capture(env);
    expect(out, "a device with no runnable engine applies nothing").not.toContain("Input compaction is armed");
    expect(out).toContain("not armed yet");
  });

  it("names the actual blocker instead of a command that would change nothing", async () => {
    // The exact shape that produced the dead end: an authorization EXISTS, but the optimization mode is
    // plain `cache`. The old output printed only the authorize step, which was already satisfied.
    provisionValidLease(dir);
    const env = { COMPACTION_CONFIG_DIR: dir } as NodeJS.ProcessEnv;
    writeOptimizationMode("cache", env);
    addConnectedWorkflows(["claude-code"], env);
    await savePolicyPreference(
      {
        scope: { tool: "claude-code", policy_type: "deterministic-dedupe" },
        preference: "auto-when-gates-pass",
        gates_required: [...AUTO_APPLY_ELIGIBILITY_GATES]
      },
      dir
    );
    const out = await capture(env);
    expect(out).not.toContain("Input compaction is armed");
    // The optimization mode is the real blocker and must be what the user reads about.
    expect(out.toLowerCase()).toMatch(/optimization|output only/);
    // And it must NOT hand them the authorize step, which is already done.
    expect(out, "the already-satisfied step must not be presented as the remedy")
      .not.toContain("--authorize-auto-apply");
  });

  async function armEverything(env: NodeJS.ProcessEnv): Promise<void> {
    writeOptimizationMode("cache-plus-context", env);
    addConnectedWorkflows(["claude-code"], env);
    await savePolicyPreference(
      {
        scope: { tool: "claude-code", policy_type: "deterministic-dedupe" },
        preference: "auto-when-gates-pass",
        gates_required: [...AUTO_APPLY_ELIGIBILITY_GATES]
      },
      dir
    );
  }

  function presentEngine(): string {
    const p = join(dir, "engine.js");
    writeFileSync(p, "// test engine artifact\n");
    return p;
  }

  it("says armed on a device where every gate the gateway checks holds (the positive baseline)", async () => {
    provisionValidLease(dir); // product_mode full
    const env = { COMPACTION_CONFIG_DIR: dir, COMPACTION_ENGINE_PATH: presentEngine() } as NodeJS.ProcessEnv;
    await armEverything(env);
    const out = await capture(env);
    expect(out).toContain("Input compaction is armed");
  });

  it("does NOT say armed when the routing guard engages but the product mode is not full", async () => {
    // The shape a reverted activation leaves behind: valid lease, engine, every opt-in — and
    // `product_mode: basic`. The routing guard engages; the gateway then declines every request on the
    // tier. Identical to the baseline above except for the product mode.
    provisionValidLease(dir, {}, { productMode: "basic" });
    const env = { COMPACTION_CONFIG_DIR: dir, COMPACTION_ENGINE_PATH: presentEngine() } as NodeJS.ProcessEnv;
    await armEverything(env);
    const out = await capture(env);
    expect(out, "the gateway declines every request on a basic tier").not.toContain("Input compaction is armed");
    expect(out).toContain("not armed yet");
    expect(out).toContain("product mode is basic");
  });

  it("names the unconnected workflow, not a missing authorization, when the authorization IS stored", async () => {
    provisionValidLease(dir);
    const env = { COMPACTION_CONFIG_DIR: dir, COMPACTION_ENGINE_PATH: presentEngine() } as NodeJS.ProcessEnv;
    await armEverything(env);
    removeConnectedWorkflow("claude-code", env);
    const out = await capture(env);
    expect(out).toContain("not armed yet");
    expect(out).toContain("not a connected workflow");
    expect(out).not.toContain("no apply authorization for this workflow yet");
  });

  describe("product mode full + API key + no valid lease (the guard engages on the key; the tier clamps to observe)", () => {
    async function keyedDeviceWithoutLease(): Promise<NodeJS.ProcessEnv> {
      provisionValidLease(dir); // product_mode full + credentials
      const env = {
        COMPACTION_CONFIG_DIR: dir,
        COMPACTION_ENGINE_PATH: presentEngine(),
        ANTHROPIC_API_KEY: "sk-ant-fake-test-key"
      } as NodeJS.ProcessEnv;
      await armEverything(env);
      unlinkSync(leasePath(env));
      return env;
    }

    it("names the lease state from the login attempt, never a mode the user did not choose", async () => {
      const env = await keyedDeviceWithoutLease();
      const lines: string[] = [];
      const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(" "));
      });
      try {
        await printRemainingFullApplySteps(env, {
          account: "present",
          lease: "unavailable",
          engine: "present",
          reason: "not_entitled",
          networkUsed: true
        });
      } finally {
        spy.mockRestore();
      }
      const out = lines.join("\n");
      expect(out).toContain("not armed yet");
      expect(out, "product_mode is full; the clamped tier is not a mode").not.toContain("product mode is");
      expect(out).toContain("no Community entitlement is active for this account");
    });

    it("without an attempt outcome, names the refresh remedy rather than the clamped tier", async () => {
      const env = await keyedDeviceWithoutLease();
      const out = await capture(env);
      expect(out).not.toContain("product mode is");
      expect(out).toContain(REFRESH_COMMUNITY_REMEDY);
    });
  });

  it("stays silent about being armed on an Open device, and never throws", async () => {
    const env = { COMPACTION_CONFIG_DIR: dir } as NodeJS.ProcessEnv;
    writeProductMode("basic", env);
    const out = await capture(env);
    expect(out).not.toContain("Input compaction is armed");
    expect(out).toContain("not armed yet");
  });
});
