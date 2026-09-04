import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pendingFullApplyGate } from "../../src/cli/commands/init.js";
import { FULL_APPLY_PENDING_REASONS } from "../../src/cli/onboarding/model.js";
import { writeOptimizationMode } from "../../src/core/onboarding-preferences.js";
import { AUTO_APPLY_ELIGIBILITY_GATES, savePolicyPreference } from "../../src/core/policy-preferences.js";
import { DEDUPE_POLICY } from "../../src/core/gateway/request-shape.js";

/**
 * THE READY SCREEN MUST ASK EVERY GATE THE GATEWAY WILL.
 *
 * Community activation can satisfy exactly one of the gateway's three conditions for a full apply:
 * the entitlement lease. The other two are the user's own local configuration — the persisted
 * optimization mode must be `cache-plus-context`, and a stored `auto-when-gates-pass` authorization
 * must cover a workflow that was actually enabled. Reporting `full` off the lease alone announced
 * `Per turn full apply` to every user who kept the stepper's RECOMMENDED Output-only mode, for whom
 * `resolveStoredAuthorizationApply` in `src/core/gateway/server.ts` returns null on every single
 * request. The screen described a capability the very next turn refused.
 *
 * These tests drive the gate resolver against real preference and policy stores.
 */

let configDir = "";
let cwd = "";
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "full-apply-gate-cfg-"));
  cwd = mkdtempSync(join(tmpdir(), "full-apply-gate-cwd-"));
  env = { COMPACTION_CONFIG_DIR: configDir } as NodeJS.ProcessEnv;
});
afterEach(() => {
  for (const d of [configDir, cwd]) if (d) rmSync(d, { recursive: true, force: true });
});

/** The narrow authorization onboarding writes for a Full-optimization run, on this temp DEVICE. */
async function authorize(tool: string): Promise<void> {
  const result = await savePolicyPreference(
    {
      scope: { tool, policy_type: DEDUPE_POLICY },
      preference: "auto-when-gates-pass",
      enabled: true,
      gates_required: [...AUTO_APPLY_ELIGIBILITY_GATES]
    },
    configDir // device-scoped: the authorization is not a property of any working directory
  );
  expect(result.saved, "the fixture authorization must actually persist").toBe(true);
}

describe("pendingFullApplyGate — the local gates between a valid lease and a real full apply", () => {
  it("the DEFAULT Output-only mode holds full apply back, and says which setting does it", async () => {
    // Nothing persisted: the default optimization mode is `cache`, i.e. the stepper's "Output only".
    expect(await pendingFullApplyGate(["claude-code"], env)).toBe(FULL_APPLY_PENDING_REASONS.optimizationMode);
  });

  it("Output-only holds it back even WITH an authorization saved (both gates are required)", async () => {
    await authorize("claude-code");
    writeOptimizationMode("cache", env);
    expect(await pendingFullApplyGate(["claude-code"], env)).toBe(FULL_APPLY_PENDING_REASONS.optimizationMode);
  });

  it("Full optimization with NO stored authorization reports the authorization gate", async () => {
    writeOptimizationMode("cache-plus-context", env);
    expect(await pendingFullApplyGate(["claude-code"], env)).toBe(FULL_APPLY_PENDING_REASONS.applyAuthorization);
  });

  it("an authorization for a DIFFERENT workflow does not count for the one that was enabled", async () => {
    writeOptimizationMode("cache-plus-context", env);
    await authorize("codex");
    expect(await pendingFullApplyGate(["claude-code"], env)).toBe(FULL_APPLY_PENDING_REASONS.applyAuthorization);
  });

  it("nothing enabled ⇒ no turn on this device can be a full apply", async () => {
    writeOptimizationMode("cache-plus-context", env);
    await authorize("claude-code");
    expect(await pendingFullApplyGate([], env)).toBe(FULL_APPLY_PENDING_REASONS.applyAuthorization);
  });

  it("BOTH gates satisfied ⇒ nothing pending, and only then may the screen say `full apply`", async () => {
    writeOptimizationMode("cache-plus-context", env);
    await authorize("claude-code");
    expect(await pendingFullApplyGate(["claude-code"], env)).toBeUndefined();
  });

  it("any one enabled workflow being authorized is enough (the gateway applies per workflow)", async () => {
    writeOptimizationMode("cache-plus-context", env);
    await authorize("codex");
    expect(await pendingFullApplyGate(["claude-code", "codex"], env)).toBeUndefined();
  });

  it("every reason it can return is a fixed, content-free label (no path, no id, no count)", async () => {
    for (const reason of Object.values(FULL_APPLY_PENDING_REASONS)) {
      expect(reason).not.toMatch(/[/\\]/);
      expect(reason).not.toMatch(/\d/);
    }
  });
});
