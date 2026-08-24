import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  credentialsPath,
  deleteStoredCredentials,
  maskToken,
  readStoredCredentials,
  writeStoredCredentials,
  type StoredCredentials
} from "../../src/core/auth/credentials.js";
import { generateDeviceKeyPair } from "../../src/core/auth/device-flow.js";

/** All reads/writes are redirected via COMPACTION_CONFIG_DIR — the real ~/.compaction is never touched. */
let dir: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "compaction-cred-"));
  env = { COMPACTION_CONFIG_DIR: dir };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// A real throwaway keypair (generated per test run, never committed) instead of a literal PEM
// string: the no-committed-secrets scanner matches PEM headers line-by-line, so even a fake
// inline PEM would trip it now that this file is git-tracked.
const throwawayKeyPair = generateDeviceKeyPair();

function sample(): StoredCredentials {
  return {
    schema_version: 1,
    api_url: "http://127.0.0.1:8787",
    account_id: "acct-1",
    email: "dev@example.test",
    device_id: "123e4567-e89b-42d3-a456-426614174000",
    device_name: "laptop",
    device_token: "cmpd_test_123e4567-e89b-42d3-a456-426614174000.secretsecretsecretsecret",
    device_private_key_pem: throwawayKeyPair.privateKeyPem,
    device_public_key: throwawayKeyPair.publicKey,
    created_at: "2026-07-31T00:00:00.000Z"
  };
}

describe("credentials store", () => {
  it("round-trips and writes mode 0600", () => {
    const path = writeStoredCredentials(sample(), env);
    expect(path).toBe(credentialsPath(env));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readStoredCredentials(env)).toEqual(sample());
  });

  it("re-write keeps 0600 even when the file pre-exists with a laxer mode", () => {
    const path = writeStoredCredentials(sample(), env);
    // Simulate an old laxer file: writeFileSync's mode only applies at creation.
    rmSync(path);
    writeFileSync(path, "{}", { mode: 0o644 });
    writeStoredCredentials(sample(), env);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("absent / corrupt / incomplete files read as undefined (fail-closed to logged-out)", () => {
    expect(readStoredCredentials(env)).toBeUndefined();
    writeFileSync(credentialsPath(env), "not-json{{{", { mode: 0o600 });
    expect(readStoredCredentials(env)).toBeUndefined();
    const partial = { ...sample(), device_token: "" };
    writeFileSync(credentialsPath(env), JSON.stringify(partial), { mode: 0o600 });
    expect(readStoredCredentials(env)).toBeUndefined();
    const wrongVersion = { ...sample(), schema_version: 2 };
    writeFileSync(credentialsPath(env), JSON.stringify(wrongVersion), { mode: 0o600 });
    expect(readStoredCredentials(env)).toBeUndefined();
  });

  it("delete removes the file and is idempotent", () => {
    writeStoredCredentials(sample(), env);
    deleteStoredCredentials(env);
    expect(readStoredCredentials(env)).toBeUndefined();
    deleteStoredCredentials(env); // no throw on missing
  });

  it("maskToken never reveals the token body", () => {
    const token = sample().device_token;
    const masked = maskToken(token);
    expect(masked).not.toBe(token);
    expect(masked).not.toContain("secretsecret");
    expect(masked.length).toBeLessThan(30);
    expect(maskToken(undefined)).toBe("(none)");
    expect(maskToken("short")).toBe("…(hidden)");
  });
});

describe("device key pair generation", () => {
  it("generates an Ed25519 pair: base64url SPKI public, PEM PKCS8 private, unique per call", () => {
    const a = generateDeviceKeyPair();
    const b = generateDeviceKeyPair();
    expect(a.publicKey).toMatch(/^[A-Za-z0-9_-]+$/);
    // Ed25519 SPKI DER is 44 bytes → 59 base64url chars.
    expect(a.publicKey.length).toBeGreaterThan(40);
    expect(a.privateKeyPem).toContain("BEGIN PRIVATE KEY");
    expect(a.publicKey).not.toBe(b.publicKey);
    expect(a.privateKeyPem).not.toContain(a.publicKey);
  });
});
