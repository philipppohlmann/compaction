/**
 * The Engine licence gate.
 *
 * The Hybrid Engine is a SEPARATELY DISTRIBUTED artifact under its own agreement, while everything in
 * this package is Apache-2.0. So the properties that matter are about WHERE the gate sits and what it
 * refuses, not about how the record is stored:
 *
 *  - THE OPEN PATH ASKS FOR NOTHING. A device that never acquires the Engine records nothing and is
 *    never gated — the file does not even exist.
 *  - ACQUISITION IS THE GATED ACT. With no acceptance on the device, the Community runtime reports the
 *    engine missing with a coded reason and DOWNLOADS NOTHING. Consent is never inferred.
 *  - ACCEPTANCE IS VERSIONED, so a future agreement stops matching by construction rather than because
 *    someone remembered to invalidate it — that is what makes re-acceptance possible.
 *  - A MALFORMED RECORD IS NOT AN ACCEPTANCE. The file is unprivileged local state; the only safe
 *    reading of anything unparseable is "not accepted".
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ENGINE_EULA_PATH,
  ENGINE_EULA_SUMMARY,
  ENGINE_EULA_VERSION,
  engineEulaAccepted,
  engineEulaAcceptancePath,
  engineEulaUrl,
  readEngineEulaAcceptance,
  recordEngineEulaAcceptance
} from "../../src/core/legal/engine-eula.js";
import { engineBlockedReason, ensureCommunityRuntime } from "../../src/core/entitlement/community-runtime.js";
import { writeStoredCredentials } from "../../src/core/auth/credentials.js";
import { generateDeviceKeyPair } from "../../src/core/auth/device-flow.js";
import { provisionValidLease } from "../helpers/lease-fixture.js";

/** A dead port: any request fails immediately and cannot reach a real service. */
const DEAD_SERVICE = "http://127.0.0.1:1";

let dir: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "engine-eula-"));
  // NO ENGINE RESOLVES HERE. An explicit override naming a path that does not exist is authoritative
  // (`resolveEngine`), so this repo's own dev build cannot leak in and answer "present" — which would
  // skip the acquisition branch entirely and make the gate untestable in-tree.
  env = { COMPACTION_CONFIG_DIR: dir, COMPACTION_ENGINE_PATH: join(dir, "no-such-engine.js") };
});
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

function writeUnreachableCredentials(): void {
  const keys = generateDeviceKeyPair();
  writeStoredCredentials(
    {
      schema_version: 1,
      api_url: DEAD_SERVICE,
      account_id: "acct-test",
      device_id: "123e4567-e89b-42d3-a456-426614174000",
      device_token: "cmpd_test_123e4567-e89b-42d3-a456-426614174000.fakefakefakefakefakefakefakefake",
      device_private_key_pem: keys.privateKeyPem,
      device_public_key: keys.publicKey,
      created_at: new Date().toISOString()
    },
    env
  );
}

describe("acceptance record", () => {
  it("is absent, and reads as not accepted, on a device that has done nothing", () => {
    expect(existsSync(engineEulaAcceptancePath(env))).toBe(false);
    expect(readEngineEulaAcceptance(env)).toBeUndefined();
    expect(engineEulaAccepted(env)).toBe(false);
  });

  it("records the CURRENT version and a timestamp, and reads back as accepted", () => {
    const record = recordEngineEulaAcceptance(env, new Date("2026-08-24T10:00:00.000Z"));
    expect(record.version).toBe(ENGINE_EULA_VERSION);
    expect(record.accepted_at).toBe("2026-08-24T10:00:00.000Z");
    expect(readEngineEulaAcceptance(env)).toEqual(record);
    expect(engineEulaAccepted(env)).toBe(true);
  });

  it("is written 0600 — unprivileged local state, but not world-readable", () => {
    recordEngineEulaAcceptance(env);
    expect(statSync(engineEulaAcceptancePath(env)).mode & 0o777).toBe(0o600);
  });

  it("carries a version and a timestamp and NOTHING else — no content, no identifiers", () => {
    recordEngineEulaAcceptance(env);
    const raw: unknown = JSON.parse(readFileSync(engineEulaAcceptancePath(env), "utf8"));
    expect(Object.keys(raw as object).sort()).toEqual(["accepted_at", "version"]);
  });

  it("does NOT accept a DIFFERENT recorded version — this is what makes re-acceptance possible", () => {
    writeFileSync(
      engineEulaAcceptancePath(env),
      JSON.stringify({ version: "0.9", accepted_at: "2026-01-01T00:00:00.000Z" })
    );
    expect(readEngineEulaAcceptance(env)?.version).toBe("0.9");
    expect(engineEulaAccepted(env)).toBe(false);
  });

  it("treats a malformed, empty, or wrong-shaped record as NOT accepted rather than throwing", () => {
    for (const body of ["", "null", "[]", "{}", '{"version":"1.0"}', '{"version":"","accepted_at":"x"}', "not json"]) {
      writeFileSync(engineEulaAcceptancePath(env), body);
      expect(engineEulaAccepted(env)).toBe(false);
      expect(() => readEngineEulaAcceptance(env)).not.toThrow();
    }
  });
});

describe("the agreement is reachable", () => {
  it("points at the canonical /eula route on the configured website origin", () => {
    expect(ENGINE_EULA_PATH).toBe("/eula");
    expect(engineEulaUrl({ COMPACTION_WEB_ORIGIN: "https://example.test" })).toBe("https://example.test/eula");
    expect(engineEulaUrl({})).toMatch(/^https:\/\/.+\/eula$/);
  });

  it("summarises the agreement without contradicting it", () => {
    const text = ENGINE_EULA_SUMMARY.join(" ");
    expect(ENGINE_EULA_SUMMARY.length).toBeGreaterThan(0);
    expect(text).toMatch(/licensed to you, not sold/i);
    expect(text).toMatch(/locally/i);
    expect(text).toMatch(/never given your provider credentials/i);
    expect(text).toMatch(/Apache-2\.0/);
  });
});

describe("acquisition is gated on acceptance", () => {
  it("makes NO network call and installs NOTHING for an Open device — the gate never fires", async () => {
    const outcome = await ensureCommunityRuntime(env);
    expect(outcome.account).toBe("absent");
    expect(outcome.networkUsed).toBe(false);
    expect(existsSync(engineEulaAcceptancePath(env))).toBe(false);
  });

  it("refuses the engine with a coded reason, and downloads nothing, when the agreement is unaccepted", async () => {
    writeUnreachableCredentials();
    provisionValidLease(dir);
    const outcome = await ensureCommunityRuntime(env);
    expect(outcome.engine).toBe("unavailable");
    expect(outcome.reason).toBe("eula-not-accepted");
    // NOT INFERRED FROM THE ATTEMPT: refusing must not create the acceptance it was refusing over.
    expect(existsSync(engineEulaAcceptancePath(env))).toBe(false);
  });

  it("names the agreement and the command that resolves it, never the raw wire code", () => {
    const sentence = engineBlockedReason({
      account: "present",
      lease: "valid",
      engine: "unavailable",
      reason: "eula-not-accepted",
      networkUsed: false
    });
    expect(sentence).toMatch(/Engine License Agreement/);
    expect(sentence).toMatch(/compaction engine license --accept/);
    expect(sentence).not.toMatch(/eula-not-accepted/);
  });

  it("stops refusing on licence grounds once acceptance is recorded", async () => {
    writeUnreachableCredentials();
    provisionValidLease(dir);
    recordEngineEulaAcceptance(env);
    const outcome = await ensureCommunityRuntime(env);
    // The dead service still cannot serve an engine — but the reason is no longer the licence, which
    // is the whole claim: acceptance UNBLOCKS the acquisition rather than completing it.
    expect(outcome.reason).not.toBe("eula-not-accepted");
  });
});
