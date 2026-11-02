import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runStatus } from "../../src/cli/commands/upgrade-status.js";
import { writeOptimizationMode, addConnectedWorkflows } from "../../src/core/onboarding-preferences.js";
import { savePolicyPreference, AUTO_APPLY_ELIGIBILITY_GATES } from "../../src/core/policy-preferences.js";
import { stopShaping } from "../../src/core/subscription-shaping-state.js";
import { routingSlotKey, writeRoutingSlot } from "../../src/core/gateway/routing-registry.js";
import { provisionValidLease } from "../helpers/lease-fixture.js";
import { leasePath } from "../../src/core/entitlement/lease-store.js";
import { FULL_APPLY_PENDING_REASONS } from "../../src/cli/onboarding/model.js";

/**
 * `compaction status` → `Account & access` section (launch-blocker O8 / F52+F55).
 *
 * PURE LOCAL-DISK, NO SOCKETS. `runStatus` is driven IN-PROCESS with an injected env pointing at a
 * tmp config dir; no API key is configured, so no health check / network call happens and the command
 * stays exit-0. `console.log` is captured. The engine line is driven by `COMPACTION_ENGINE_PATH` (an
 * existing file → engine present; a non-existent path → engine explicitly absent, no dev-build
 * fallback) so the test never depends on whether a dev engine build exists in the checkout.
 *
 * These assertions pin the verbatim wording — that is the whole user-facing contract
 * for this section, so an exact-string pin is the correct guard here.
 */

let configDir: string;
let cwd: string;
let originalCwd: string;
const presentEngine = () => {
  const p = join(configDir, "engine-stub.js");
  writeFileSync(p, "// stub engine artifact — existence is all resolveEngine checks\n");
  return p;
};
const absentEngine = () => join(configDir, "no-such-engine.js");

/** Injected env: tmp config dir, no hosted API key/url (offline), a chosen engine path. */
function statusEnv(enginePath: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    COMPACTION_CONFIG_DIR: configDir,
    COMPACTION_ENGINE_PATH: enginePath,
    COMPACTION_API_URL: "",
    COMPACTION_API_KEY: "",
    ANTHROPIC_API_KEY: "",
    OPENAI_API_KEY: ""
  };
}

async function runStatusHuman(enginePath: string, extraEnv: NodeJS.ProcessEnv = {}): Promise<string> {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  try {
    await runStatus({ verbose: true, env: { ...statusEnv(enginePath), ...extraEnv }, version: "0.0.0-test", projectsDir: join(configDir, "none") });
  } finally {
    vi.restoreAllMocks();
  }
  return lines.join("\n");
}

async function runStatusJson(enginePath: string): Promise<string> {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  try {
    await runStatus({ env: statusEnv(enginePath), version: "0.0.0-test", json: true, projectsDir: join(configDir, "none") });
  } finally {
    vi.restoreAllMocks();
  }
  return lines.join("\n");
}

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "compaction-acct-cfg-"));
  cwd = mkdtempSync(join(tmpdir(), "compaction-acct-cwd-"));
  originalCwd = process.cwd();
  process.chdir(cwd); // clean cwd → no local receipts / gateway state bleeds into the report
});
afterEach(() => {
  process.chdir(originalCwd);
  rmSync(configDir, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

describe("compaction status - Account & access section (fixed wording)", () => {
  /**
   * ARM THE GATES THE GATEWAY ACTUALLY CHECKS. `provisionValidLease` writes credentials, a valid lease
   * and `product_mode: full` — but the gateway ALSO requires the input-optimization mode and a stored
   * per-tool apply authorization. Without those two this device applies nothing, so a fixture that
   * omitted them was not "fully configured" and the active footer it asserted was the overclaim this
   * section exists to prevent.
   */
  async function armApplyGates(): Promise<void> {
    const env = { COMPACTION_CONFIG_DIR: configDir } as NodeJS.ProcessEnv;
    writeOptimizationMode("cache-plus-context", env);
    addConnectedWorkflows(["claude-code"], env);
    await savePolicyPreference(
      {
        scope: { tool: "claude-code", policy_type: "deterministic-dedupe" },
        preference: "auto-when-gates-pass",
        gates_required: [...AUTO_APPLY_ELIGIBILITY_GATES]
      },
      join(configDir)
    );
  }

  it("(a) fully-configured DEV-SIGNED device reads as active - exact strings, no ids/token/endpoint copy", async () => {
    provisionValidLease(configDir); // credentials + valid dev-signed lease + product_mode=full
    await armApplyGates(); // ...and the two gates the gateway checks beyond the tier
    const out = await runStatusHuman(presentEngine());

    expect(out).toContain("Account & access");
    expect(out).toContain("Account: connected");
    expect(out).toContain("Plan: Community");
    expect(out).toContain("Community: active (DEV-SIGNED)");
    expect(out).toContain("Optimization: Full");
    expect(out).toContain("Engine: ready");
    expect(out).toContain("Compaction is active.");

    // Privacy + de-misleading rails: no account id, no device token, no old local-only / connect copy.
    expect(out).not.toContain("acct-test"); // account id never on the human path
    expect(out).not.toContain("cmpd_test_x"); // device token never printed
    expect(out).not.toContain("Mode: local-only"); // the misleading mode line, not the Storage "local-only" descriptor
    expect(out).not.toContain("Connect a private-beta");
    expect(out).not.toMatch(/Plan:\s*Open/); // an entitled device is Community, not Open
    // The raw `product_mode` key/enum stays off the human path (only user-facing plan/posture
    // vocabulary shows; the raw enum lives only in `--json`, asserted separately below).
    expect(out).not.toContain("product_mode");
  });

  it("does NOT claim active when the tier is full but a local apply gate is still unmet", async () => {
    // The exact shape that misled a real device: credentials, a valid lease, a verified engine and
    // `product_mode: full` — so the tier resolves `full` — while the input-optimization mode is still
    // plain `cache`. The gateway declines every turn in this state, so the screen must not say active.
    provisionValidLease(configDir);
    const out = await runStatusHuman(presentEngine());

    expect(out).toContain("Optimization: Full");
    expect(out).toContain("Engine: ready");
    expect(out, "the device cannot apply, so it must not be reported as active").not.toContain(
      "Compaction is active."
    );
  });

  it("names the unconnected workflow, not the authorization, when an authorization is stored but nothing is connected", async () => {
    provisionValidLease(configDir);
    const env = { COMPACTION_CONFIG_DIR: configDir } as NodeJS.ProcessEnv;
    writeOptimizationMode("cache-plus-context", env);
    await savePolicyPreference(
      {
        scope: { tool: "claude-code", policy_type: "deterministic-dedupe" },
        preference: "auto-when-gates-pass",
        gates_required: [...AUTO_APPLY_ELIGIBILITY_GATES]
      },
      join(configDir)
    );
    const out = await runStatusHuman(presentEngine());

    expect(out).toContain(FULL_APPLY_PENDING_REASONS.workflowNotConnected);
    expect(out).not.toContain(FULL_APPLY_PENDING_REASONS.applyAuthorization);
    expect(out).not.toContain("Compaction is active.");
  });

  it("does NOT claim active while `compaction stop` is in effect, even with every gate armed", async () => {
    // The gateway declines every request while stopped (the unified switch). Same armed device as (a),
    // so the only difference from the footer case is the stop.
    provisionValidLease(configDir);
    await armApplyGates();
    stopShaping({ COMPACTION_CONFIG_DIR: configDir });
    const out = await runStatusHuman(presentEngine());

    expect(out).toContain("Optimization: Full");
    expect(out, "a stopped device applies nothing, so it must not be reported as active").not.toContain(
      "Compaction is active."
    );
  });

  describe("a session pinned to a plain routing gateway is not described as upgraded", () => {
    const NOTE = "A tool session started before this was ready stays record-only for input; a new tool session re-evaluates routing.";

    /** A hermetic routing home holding one slot whose pid is THIS (live) process. */
    function routingHomeWith(workflow?: "claude-code"): NodeJS.ProcessEnv {
      const home = join(configDir, "routing-home");
      const env = { COMPACTION_HOME: home } as NodeJS.ProcessEnv;
      writeRoutingSlot(
        routingSlotKey({ cwd, provider: "anthropic", ...(workflow ? { workflow } : {}) }, env),
        {
          pid: process.pid,
          host: "127.0.0.1",
          port: 21000,
          reservedPort: 21000,
          provider: "anthropic",
          upstream: "https://api.anthropic.com",
          mode: "record",
          ...(workflow ? { workflow } : {}),
          cwd,
          startedAt: new Date().toISOString()
        },
        env
      );
      return env;
    }

    it("armed device + a LIVE plain (workflow none) routing gateway → the footer is qualified", async () => {
      provisionValidLease(configDir);
      await armApplyGates();
      const out = await runStatusHuman(presentEngine(), routingHomeWith());
      expect(out).toContain("Compaction is active.");
      expect(out).toContain(NOTE);
    });

    it("armed device + only a workflow-scoped routing gateway → no qualification", async () => {
      provisionValidLease(configDir);
      await armApplyGates();
      const out = await runStatusHuman(presentEngine(), routingHomeWith("claude-code"));
      expect(out).toContain("Compaction is active.");
      expect(out).not.toContain(NOTE);
    });

    it("armed device + no routing gateway at all → no qualification", async () => {
      provisionValidLease(configDir);
      await armApplyGates();
      const out = await runStatusHuman(presentEngine(), { COMPACTION_HOME: join(configDir, "empty-home") });
      expect(out).toContain("Compaction is active.");
      expect(out).not.toContain(NOTE);
    });
  });

  it("(b) signed-in but no valid lease and renew cannot reach a service → refresh gap, not browser activation", async () => {
    // Credentials present + lease removed: silent renew runs against the fixture's dead api_url and
    // fails. That is NOT "needs activation" (browser) — it is authorization that could not refresh.
    provisionValidLease(configDir); // sets credentials (signed in) + product_mode=full
    unlinkSync(leasePath({ COMPACTION_CONFIG_DIR: configDir })); // remove the lease → no valid entitlement
    const out = await runStatusHuman(absentEngine());

    expect(out).toContain("Account: connected");
    expect(out).toContain("Plan: Open");
    expect(out).toContain("Community: authorization needs refresh");
    expect(out).toContain("Community authorization could not be refreshed automatically");
    expect(out).not.toContain("Community: needs activation");
    expect(out).not.toContain("Community: active");
    expect(out).not.toContain("Compaction is active.");
    expect(out).not.toContain("Engine: ready"); // engine forced absent
    expect(out).not.toContain("Mode: local-only"); // the misleading mode line, not the Storage "local-only" descriptor
    expect(out).not.toContain("Connect a private-beta");
  });

  it("(c) unconfigured device → not connected + set-up remedy, no old connect/local-only copy", async () => {
    const out = await runStatusHuman(absentEngine());

    expect(out).toContain("Account & access");
    expect(out).toContain("Account: not connected");
    expect(out).toContain("Run compaction to set up Community.");
    expect(out).not.toContain("Community: active");
    expect(out).not.toContain("Compaction is active.");
    // The two defect lines this launch-blocker removes are GONE from the human path.
    expect(out).not.toContain("Mode: local-only");
    expect(out).not.toContain("Connect a private-beta");
    expect(out).not.toContain("compaction upgrade --key");
  });

  it("--json carries entitlement STATE but NO identifiers (no account id / email / device token)", async () => {
    provisionValidLease(configDir);
    const out = await runStatusJson(presentEngine());
    const parsed = JSON.parse(out) as {
      account: { connected: boolean; accountId?: string; email?: string };
      entitlement: { lease: string; trust?: string; productMode: string; effectiveTier: string; engine: string };
    };
    expect(parsed.account.connected).toBe(true);
    // Presence + entitlement STATE only — no identity values on the diagnostic surface either.
    expect(parsed.account.accountId).toBeUndefined();
    expect(parsed.account.email).toBeUndefined();
    expect(parsed.entitlement.lease).toBe("lease-valid");
    expect(parsed.entitlement.trust).toBe("dev-lease-root");
    expect(parsed.entitlement.productMode).toBe("full"); // raw enum state lives ONLY in --json
    expect(parsed.entitlement.effectiveTier).toBe("full");
    expect(parsed.entitlement.engine).toBe("present");
    // No account id, email, or device token is serialized, in any form.
    expect(out).not.toContain("acct-test");
    expect(out).not.toContain("cmpd_test_x");
    expect(out).not.toContain("device_token");
  });

  it("does NOT print `Compaction is active.` for an entitled device that is only in basic/observe (record-only)", async () => {
    // A valid lease + engine but product_mode basic → the gateway stays record-only, so the footer
    // (which reads as "being optimized") must not appear; only `full` earns it.
    provisionValidLease(configDir, {}, { productMode: "basic" });
    const out = await runStatusHuman(presentEngine());
    expect(out).toContain("Account: connected");
    expect(out).toContain("Community: active (DEV-SIGNED)");
    expect(out).toContain("Optimization: Basic");
    expect(out).not.toContain("Compaction is active.");
  });
});
