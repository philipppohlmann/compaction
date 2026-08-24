import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runStatus } from "../../src/cli/commands/upgrade-status.js";
import { provisionValidLease } from "../helpers/lease-fixture.js";
import { leasePath } from "../../src/core/entitlement/lease-store.js";

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

async function runStatusHuman(enginePath: string): Promise<string> {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  try {
    await runStatus({ env: statusEnv(enginePath), version: "0.0.0-test", projectsDir: join(configDir, "none") });
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
  it("(a) fully-configured DEV-SIGNED device reads as active - exact strings, no ids/token/endpoint copy", async () => {
    provisionValidLease(configDir); // credentials + valid dev-signed lease + product_mode=full
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

  it("(b) signed-in but no valid lease → needs activation + restore remedy", async () => {
    provisionValidLease(configDir); // sets credentials (signed in) + product_mode=full
    unlinkSync(leasePath({ COMPACTION_CONFIG_DIR: configDir })); // remove the lease → no valid entitlement
    const out = await runStatusHuman(absentEngine());

    expect(out).toContain("Account: connected");
    expect(out).toContain("Plan: Open");
    expect(out).toContain("Community: needs activation");
    expect(out).toContain("Run compaction to restore Community access.");
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
