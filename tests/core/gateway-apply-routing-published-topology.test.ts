import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  APPLY_ROUTING_WORKFLOW,
  resolveApplyRoutingActivation
} from "../../src/core/gateway/apply-routing-activation.js";
import { writeOptimizationMode, addConnectedWorkflows } from "../../src/core/onboarding-preferences.js";
import { savePolicyPreference, AUTO_APPLY_ELIGIBILITY_GATES } from "../../src/core/policy-preferences.js";
import { provisionValidLease } from "../helpers/lease-fixture.js";

/**
 * GUARD 0 UNDER THE PUBLISHED-PACKAGE TOPOLOGY (release blocker, 0.6.5 → 0.6.6).
 *
 * The repo and the npm package are not the same shape, and guard 0 was the one surface that could
 * not tell them apart. It probed `isInputCompactionAvailable()` — the presence of
 * `dist/core/gateway/apply-policy.js` — which the published package excludes BY NAME
 * (`package.json` files: `!dist/core/gateway/apply-policy.*`). In this repo that module is always
 * present, so every existing guard-0 test passed while the shipped artifact was permanently
 * record-only: `gateway ensure` spawned `--workflow none`, and plain `claude` never reached apply
 * with a valid lease, `mode full`, remaining allowance and a verified engine all in place.
 *
 * These tests therefore SIMULATE THE NPM TOPOLOGY rather than the repo's: the input-compaction seam
 * is mocked absent (and made to throw if apply routing touches it at all), so a regression back to a
 * packaged-module probe fails here instead of in an installed product run. The capability that actually
 * matters is the engine, because the live apply path is the engine IPC seam.
 */

vi.mock("../../src/core/gateway/input-compaction-seam.js", () => ({
  // Exactly what the published package yields: the module is gone, so the probe answers false.
  isInputCompactionAvailable: async () => false,
  // Apply routing has no business consulting this seam at all — reaching it is the regression.
  planInputCompaction: async () => {
    throw new Error("apply routing must not consult the input-compaction seam");
  },
  INPUT_COMPACTION_ABSENT_REASON: "input compaction is not available in this build"
}));

let cwd: string;
let configDir: string;
let enginePath: string;
let baseEnv: NodeJS.ProcessEnv;

/** Seed every USER opt-in, so a test can knock out exactly one capability or credential. */
async function seedUserOptIns(): Promise<void> {
  writeOptimizationMode("cache-plus-context", baseEnv);
  addConnectedWorkflows(["claude-code"], baseEnv);
  await savePolicyPreference(
    {
      scope: { tool: "claude-code", policy_type: "deterministic-dedupe" },
      preference: "auto-when-gates-pass",
      gates_required: [...AUTO_APPLY_ELIGIBILITY_GATES]
    },
    join(cwd, ".compaction")
  );
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "apply-routing-npm-"));
  configDir = join(cwd, ".compaction");
  // A resolvable engine artifact. `COMPACTION_ENGINE_PATH` is authoritative in `resolveEngine`, so
  // this pins availability per-test instead of inheriting whatever this machine has installed.
  enginePath = join(cwd, "engine.js");
  writeFileSync(enginePath, "// test engine artifact\n");
  baseEnv = {
    COMPACTION_CONFIG_DIR: configDir,
    COMPACTION_ENGINE_PATH: enginePath,
    ANTHROPIC_API_KEY: ""
  };
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe("guard 0 on the published-package topology (apply-policy.js absent)", () => {
  /**
   * THE RELEASE CASE, as a test. Every condition established on the real
   * device: no `apply-policy.js` (npm), an engine that resolves, a valid signed Community lease, mode
   * full, claude-code connected and authorized — and no API key, because a Claude Max subscription
   * user never sets one. This is exactly the `gateway ensure` call the `claude` shim makes.
   */
  it("ENGAGES apply routing with apply-policy.js ABSENT when the engine resolves (Community lease, mode full)", async () => {
    await seedUserOptIns();
    provisionValidLease(configDir);
    const decision = await resolveApplyRoutingActivation({ provider: "anthropic", cwd, env: baseEnv });
    expect(decision.engage).toBe(true);
    expect(decision.engage && decision.workflow).toBe(APPLY_ROUTING_WORKFLOW);
  });

  it("ENGAGES on an API key alone with apply-policy.js ABSENT (the key arm is topology-independent)", async () => {
    await seedUserOptIns();
    const env = { ...baseEnv, ANTHROPIC_API_KEY: "sk-ant-fake-test-key" };
    const decision = await resolveApplyRoutingActivation({ provider: "anthropic", cwd, env });
    expect(decision.engage).toBe(true);
  });

  /**
   * NEGATIVE CONTROL — capability genuinely absent. `resolveEngine` treats an explicit override
   * naming a non-existent path as EXPLICITLY absent (no silent dev fallback), which is the shape of a
   * public install that has not fetched an engine, and of one whose artifact failed verify-before-run
   * (`resolveEngine` returns a null path in both cases). The guard must still fail honestly.
   */
  it("stays DORMANT when NO engine resolves, even with lease + mode + authorization all valid", async () => {
    await seedUserOptIns();
    provisionValidLease(configDir);
    const env = { ...baseEnv, COMPACTION_ENGINE_PATH: join(cwd, "no-such-engine.js") };
    const decision = await resolveApplyRoutingActivation({ provider: "anthropic", cwd, env });
    expect(decision.engage).toBe(false);
    expect(decision.engage === false && decision.reason).toContain("no adaptive engine resolves");
  });

  it("stays DORMANT with an engine but NEITHER an API key NOR a valid lease", async () => {
    await seedUserOptIns();
    const decision = await resolveApplyRoutingActivation({ provider: "anthropic", cwd, env: baseEnv });
    expect(decision.engage).toBe(false);
    expect(decision.engage === false && decision.reason).toContain("ANTHROPIC_API_KEY");
  });

  it("stays DORMANT with an engine and a valid lease when the mode does not request input apply", async () => {
    await seedUserOptIns();
    provisionValidLease(configDir);
    writeOptimizationMode("cache", baseEnv);
    const decision = await resolveApplyRoutingActivation({ provider: "anthropic", cwd, env: baseEnv });
    expect(decision.engage).toBe(false);
    expect(decision.engage === false && decision.reason).toContain("cache-plus-context");
  });

  /**
   * THE REGRESSION RAIL. The behavioural tests above would still pass if someone re-added a
   * packaged-module probe alongside the engine probe in a way this fixture happens to satisfy. The
   * public package is defined by what it EXCLUDES, so module presence can NEVER stand in for runtime
   * capability here: assert the routing resolver has no source-level dependency on the excluded
   * module or its seam at all.
   */
  it("apply-routing-activation has NO dependency on the excluded apply-policy module or its seam", () => {
    const source = readFileSync("src/core/gateway/apply-routing-activation.ts", "utf8");
    const imports = source.match(/^import .*$/gm) ?? [];
    expect(imports.join("\n")).not.toContain("input-compaction-seam");
    expect(imports.join("\n")).not.toContain("apply-policy");
    expect(imports.join("\n")).toContain("engine-availability");
  });

  /**
   * The engine probe is reachable from Open surfaces only because `engine-availability.ts` keeps a
   * ZERO static import graph (both probes go through dynamic `import()`). Guard 0 now imports it
   * statically, so that property is what keeps `engine-install/**` and the supervisor out of the
   * packaged static graph — pin it here as well as in the boundary check.
   */
  it("engine-availability adds no static edges to the packaged import graph", () => {
    const source = readFileSync("src/core/engine-availability.ts", "utf8");
    expect(source.match(/^import .*$/gm)).toBeNull();
  });
});
