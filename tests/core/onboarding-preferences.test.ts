/**
 * Onboarding preferences store tests, the content-free optimization-mode
 * DEFAULT store at `~/.compaction/preferences.json`.
 *
 * HERMETIC: `COMPACTION_CONFIG_DIR` is pinned at a per-test tmpdir (identical override to
 * `persisted-config.ts`), so the real `~/.compaction` is NEVER touched.
 *
 * Proven here:
 * - (7) mode defaults to `cache` when nothing is persisted;
 * - (8) mode persists as `cache-plus-context` and round-trips;
 * - (12) the on-disk file contains ONLY the `optimization_mode` enum key, no prompt/response/tool/
 *   content/key fields, and the value is one of the two legal enum strings;
 * - the model-key mapping is a faithful round-trip;
 * - a corrupt / unknown-value file fails closed to the default (never throws).
 */
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_OPTIMIZATION_MODE_PREFERENCE,
  DEFAULT_PRODUCT_MODE,
  addConnectedWorkflows,
  effectiveOpenTier,
  fromModelOptimizationModeKey,
  preferencesPath,
  readConnectedWorkflows,
  readOptimizationMode,
  readProductMode,
  removeConnectedWorkflow,
  toModelOptimizationModeKey,
  writeOptimizationMode,
  writeProductMode
} from "../../src/core/onboarding-preferences.js";

let dir: string;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "onboarding-prefs-"));
  env = { COMPACTION_CONFIG_DIR: dir };
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("onboarding-preferences store", () => {
  it("(7) defaults to `cache` when nothing is persisted", () => {
    expect(DEFAULT_OPTIMIZATION_MODE_PREFERENCE).toBe("cache");
    expect(readOptimizationMode(env)).toBe("cache");
  });

  it("(8) persists `cache-plus-context` and round-trips", () => {
    const path = writeOptimizationMode("cache-plus-context", env);
    expect(path).toBe(preferencesPath(env));
    expect(readOptimizationMode(env)).toBe("cache-plus-context");
    // Re-persisting `cache` overwrites cleanly.
    writeOptimizationMode("cache", env);
    expect(readOptimizationMode(env)).toBe("cache");
  });

  it("(12) writes ONLY the optimization_mode enum key - content-free (no prompt/response/tool/key)", async () => {
    writeOptimizationMode("cache-plus-context", env);
    const raw = JSON.parse(await readFile(preferencesPath(env), "utf8")) as Record<string, unknown>;
    // Exactly one key, and it is `optimization_mode`.
    expect(Object.keys(raw)).toEqual(["optimization_mode"]);
    expect(raw.optimization_mode).toBe("cache-plus-context");
    // Belt-and-braces: none of the forbidden content-bearing field names appear.
    for (const forbidden of ["prompt", "response", "tool", "content", "key", "api_key", "workflow", "text"]) {
      expect(raw).not.toHaveProperty(forbidden);
    }
  });

  it("writes the file with 0600 perms (dir 0700), mirroring persisted-config", () => {
    writeOptimizationMode("cache", env);
    const fileMode = statSync(preferencesPath(env)).mode & 0o777;
    expect(fileMode).toBe(0o600);
  });

  it("maps to/from the shared-model optimization-mode keys (round-trip)", () => {
    expect(toModelOptimizationModeKey("cache")).toBe("cache-optimize");
    expect(toModelOptimizationModeKey("cache-plus-context")).toBe("cache-context-optimize");
    expect(fromModelOptimizationModeKey("cache-optimize")).toBe("cache");
    expect(fromModelOptimizationModeKey("cache-context-optimize")).toBe("cache-plus-context");
  });

  it("fails closed to the default on a corrupt or unknown-value file (never throws)", async () => {
    // Create the dir/file via a legal write first, then corrupt it.
    writeOptimizationMode("cache-plus-context", env);
    await writeFile(preferencesPath(env), "{ not json", "utf8");
    expect(readOptimizationMode(env)).toBe("cache");
    // Unknown enum value.
    await writeFile(preferencesPath(env), JSON.stringify({ optimization_mode: "turbo" }), "utf8");
    expect(readOptimizationMode(env)).toBe("cache");
  });

  it("refuses to persist an illegal value (rail assertion)", () => {
    expect(() => writeOptimizationMode("turbo" as never, env)).toThrow(/illegal optimization_mode/);
  });
});

describe("connected-workflows store (the gateway --workflow default source)", () => {
  it("reads empty when nothing is persisted, and round-trips an enum-only union in canonical order", async () => {
    expect(readConnectedWorkflows(env)).toEqual([]);
    addConnectedWorkflows(["codex"], env);
    expect(readConnectedWorkflows(env)).toEqual(["codex"]);
    // Union with the already-persisted set; canonical order is claude-code, codex.
    addConnectedWorkflows(["claude-code"], env);
    expect(readConnectedWorkflows(env)).toEqual(["claude-code", "codex"]);
    // On disk: ONLY whitelisted enum keys/values, content-free.
    const raw = JSON.parse(await readFile(preferencesPath(env), "utf8")) as Record<string, unknown>;
    expect(Object.keys(raw).sort()).toEqual(["connected_workflows"]);
    expect(raw.connected_workflows).toEqual(["claude-code", "codex"]);
  });

  it("preserves the persisted optimization mode across connected-workflow writes (and vice versa)", () => {
    writeOptimizationMode("cache-plus-context", env);
    addConnectedWorkflows(["codex"], env);
    expect(readOptimizationMode(env)).toBe("cache-plus-context");
    expect(readConnectedWorkflows(env)).toEqual(["codex"]);
    // Re-persisting the mode keeps the connected workflows.
    writeOptimizationMode("cache", env);
    expect(readConnectedWorkflows(env)).toEqual(["codex"]);
  });

  it("removeConnectedWorkflow drops one workflow (idempotent; last removal drops the key)", async () => {
    addConnectedWorkflows(["claude-code", "codex"], env);
    removeConnectedWorkflow("codex", env);
    expect(readConnectedWorkflows(env)).toEqual(["claude-code"]);
    removeConnectedWorkflow("codex", env); // idempotent
    expect(readConnectedWorkflows(env)).toEqual(["claude-code"]);
    removeConnectedWorkflow("claude-code", env);
    expect(readConnectedWorkflows(env)).toEqual([]);
    const raw = JSON.parse(await readFile(preferencesPath(env), "utf8")) as Record<string, unknown>;
    expect(raw).not.toHaveProperty("connected_workflows");
  });

  it("fails closed: illegal workflow values are refused at write and dropped at read", async () => {
    expect(() => addConnectedWorkflows(["cursor" as never], env)).toThrow(/illegal connected workflow/);
    // A hand-corrupted file: non-enum entries are dropped, enum entries survive.
    writeOptimizationMode("cache", env);
    await writeFile(
      preferencesPath(env),
      JSON.stringify({ optimization_mode: "cache", connected_workflows: ["cursor", "codex", 42] }),
      "utf8"
    );
    expect(readConnectedWorkflows(env)).toEqual(["codex"]);
  });
});

describe("product-mode store (open-core apply posture: observe | basic | full)", () => {
  it("defaults to `observe` (the no-mutation posture) when nothing is persisted", () => {
    expect(readProductMode(env)).toBe(DEFAULT_PRODUCT_MODE);
    expect(readProductMode(env)).toBe("observe");
  });

  it("persists observe/basic/full and round-trips each", () => {
    for (const mode of ["observe", "basic", "full"] as const) {
      writeProductMode(mode, env);
      expect(readProductMode(env)).toBe(mode);
    }
  });

  it("writes ONLY the product_mode enum key when nothing else is persisted (content-free)", async () => {
    writeProductMode("basic", env);
    const raw = JSON.parse(await readFile(preferencesPath(env), "utf8")) as Record<string, unknown>;
    expect(Object.keys(raw)).toEqual(["product_mode"]);
    expect(raw.product_mode).toBe("basic");
  });

  it("refuses to persist an illegal product_mode (rail assertion)", () => {
    expect(() => writeProductMode("turbo" as never, env)).toThrow(/illegal product_mode/);
  });

  it("fails closed to `observe` on an unknown-value file (never throws)", async () => {
    await writeFile(preferencesPath(env), JSON.stringify({ product_mode: "ultra" }), "utf8");
    expect(readProductMode(env)).toBe("observe");
  });

  it("preserves the product mode across optimization-mode and connected-workflow writes (and vice versa)", () => {
    writeProductMode("basic", env);
    writeOptimizationMode("cache-plus-context", env);
    addConnectedWorkflows(["codex"], env);
    expect(readProductMode(env)).toBe("basic");
    expect(readOptimizationMode(env)).toBe("cache-plus-context");
    expect(readConnectedWorkflows(env)).toEqual(["codex"]);
    // Writing the product mode preserves the sibling keys.
    writeProductMode("observe", env);
    expect(readOptimizationMode(env)).toBe("cache-plus-context");
    expect(readConnectedWorkflows(env)).toEqual(["codex"]);
    removeConnectedWorkflow("codex", env);
    expect(readProductMode(env)).toBe("observe");
  });

  it("effectiveOpenTier clamps a persisted `full` to `observe` when NO valid lease is present", () => {
    writeProductMode("full", env);
    expect(readProductMode(env)).toBe("full"); // intent is stored
    expect(effectiveOpenTier(env)).toBe("observe"); // clamps with no entitlement lease
    writeProductMode("basic", env);
    expect(effectiveOpenTier(env)).toBe("basic");
    writeProductMode("observe", env);
    expect(effectiveOpenTier(env)).toBe("observe");
  });

  it("effectiveOpenTier returns `full` ONLY when a valid dev-signed lease is present", async () => {
    const { generateDevLeaseSigningKeyPair, signLeasePayload } = await import(
      "../../src/core/entitlement/dev-lease-signing.js"
    );
    const { currentPeriodId } = await import("../../src/core/entitlement/lease.js");
    const { leasePath } = await import("../../src/core/entitlement/lease-store.js");
    const { devLeaseRootKeyPath } = await import("../../src/core/entitlement/lease-roots.js");
    const { publicKeyHash } = await import("../../src/core/crypto/key-hash.js");
    const { generateDeviceKeyPair } = await import("../../src/core/auth/device-flow.js");

    const { mkdir } = await import("node:fs/promises");
    const signer = generateDevLeaseSigningKeyPair();
    await mkdir(join(dir, "entitlement"), { recursive: true });
    await writeFile(devLeaseRootKeyPath(env), `${signer.publicKeySpkiB64u}\n`);
    const devicePublicKey = generateDeviceKeyPair().publicKey;
    await writeFile(
      join(dir, "credentials.json"),
      JSON.stringify({
        schema_version: 1,
        api_url: "http://127.0.0.1:0",
        account_id: "acct-1",
        device_id: "dev-1",
        device_token: "cmpd_test_x",
        device_private_key_pem: "x",
        device_public_key: devicePublicKey,
        created_at: new Date().toISOString()
      })
    );
    const now = Date.now();
    const payload = {
      schema_version: 1 as const,
      lease_id: "22222222-2222-2222-2222-222222222222",
      account_id: "acct-1",
      device_public_key_hash: publicKeyHash(devicePublicKey),
      period_id: currentPeriodId(),
      allowance_tokens: 2_000_000,
      issued_at: new Date(now).toISOString(),
      expires_at: new Date(now + 24 * 60 * 60 * 1000).toISOString(),
      lease_sequence: 1,
      route_scope: "all" as const
    };
    await writeFile(
      leasePath(env),
      JSON.stringify({ lease: payload, signature: signLeasePayload(payload, signer.privateKeyPem) })
    );

    // full intent + valid lease → full; without the intent it stays clamped even with a lease.
    writeProductMode("full", env);
    expect(effectiveOpenTier(env)).toBe("full");
    writeProductMode("observe", env);
    expect(effectiveOpenTier(env)).toBe("observe");
  });
});
