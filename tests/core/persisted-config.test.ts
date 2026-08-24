import { mkdtempSync, rmSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_API_URL, LOCAL_DEV_API_URL, PRODUCTION_API_URL } from "../../src/core/api-client/config.js";
import {
  configPath,
  isLocalDevUrl,
  maskKey,
  readPersistedConfig,
  resolveTarget,
  urlHost,
  writePersistedConfig
} from "../../src/core/api-client/persisted-config.js";

// Obviously-fake, non-secret test key (>= 16 chars so masking shows prefix+suffix).
const FAKE_KEY = "ck_test_deadbeefdeadbeef0000";

let dir: string;
let env: Record<string, string>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "compaction-cfg-"));
  // COMPACTION_CONFIG_DIR points every path at the tmpdir, the real ~/.compaction is NEVER touched.
  env = { COMPACTION_CONFIG_DIR: dir };
});
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

describe("maskKey - the full key is NEVER returned", () => {
  it("shows an 8-char prefix + last 4 for a long key", () => {
    const masked = maskKey(FAKE_KEY);
    expect(masked).toBe("ck_test_…0000");
    expect(masked).not.toContain(FAKE_KEY);
    expect(masked).not.toContain("deadbeef");
  });
  it("fully masks a short key (no prefix/suffix leak)", () => {
    expect(maskKey("ck_short")).toBe("…(hidden)");
    expect(maskKey("ck_short")).not.toContain("short");
  });
  it("renders empty/undefined as (none)", () => {
    expect(maskKey("")).toBe("(none)");
    expect(maskKey(undefined)).toBe("(none)");
  });
});

describe("writePersistedConfig / readPersistedConfig - 0600, round-trip, fail-closed", () => {
  it("writes config.json with mode 0600 and round-trips", () => {
    const path = writePersistedConfig({ api_url: "https://staging.example.test/", api_key: FAKE_KEY }, env);
    expect(path).toBe(configPath(env));

    const mode = statSync(path).mode & 0o777;
    expect(mode.toString(8)).toBe("600");

    const read = readPersistedConfig(env);
    expect(read).toEqual({ api_url: "https://staging.example.test", api_key: FAKE_KEY }); // trailing slash stripped
  });

  it("re-chmods a pre-existing loose-mode file back to 0600", () => {
    const path = configPath(env);
    writeFileSync(path, JSON.stringify({ api_url: "https://x.test", api_key: FAKE_KEY }), { mode: 0o644 });
    writePersistedConfig({ api_url: "https://y.test", api_key: FAKE_KEY }, env);
    expect((statSync(path).mode & 0o777).toString(8)).toBe("600");
  });

  it("returns undefined for a missing file", () => {
    expect(readPersistedConfig(env)).toBeUndefined();
  });

  it("fail-closed: a malformed or partial file resolves to undefined (never throws)", () => {
    const path = configPath(env);
    writeFileSync(path, "{ not json", { mode: 0o600 });
    expect(readPersistedConfig(env)).toBeUndefined();
    writeFileSync(path, JSON.stringify({ api_url: "https://x.test" }), { mode: 0o600 }); // no key
    expect(readPersistedConfig(env)).toBeUndefined();
  });
});

describe("isLocalDevUrl / urlHost", () => {
  // NAME BOTH ORIGINS OUTRIGHT, never `DEFAULT_API_URL`. The predecessor of this test asserted
  // `isLocal…(DEFAULT_API_URL) === true`, so when the default was repointed from loopback to
  // production the assertion moved with it and stayed green while the behaviour inverted —
  // production classified as local, and `api connect` refused the endpoint a fresh install targets.
  it("recognizes the LOOPBACK dev origin, and never the production default", () => {
    expect(isLocalDevUrl(LOCAL_DEV_API_URL)).toBe(true);
    expect(isLocalDevUrl(`${LOCAL_DEV_API_URL}/`)).toBe(true);
    expect(isLocalDevUrl(PRODUCTION_API_URL)).toBe(false);
    expect(isLocalDevUrl(DEFAULT_API_URL)).toBe(false); // the default IS production
    expect(isLocalDevUrl("https://staging.example.test")).toBe(false);
  });
  it("extracts host:port only (no scheme/path)", () => {
    expect(urlHost("https://staging.example.test:8443/v0/status")).toBe("staging.example.test:8443");
  });
});

describe("resolveTarget - precedence flag > env > file > default", () => {
  it("falls to DEFAULT_API_URL / no key when nothing is set", () => {
    const t = resolveTarget({ env });
    expect(t).toMatchObject({ url: DEFAULT_API_URL, apiKey: undefined, urlSource: "default", keySource: "none" });
  });

  it("uses the persisted file when no env/flag", () => {
    writePersistedConfig({ api_url: "https://file.example.test", api_key: FAKE_KEY }, env);
    const t = resolveTarget({ env });
    expect(t).toMatchObject({ url: "https://file.example.test", apiKey: FAKE_KEY, urlSource: "file", keySource: "file" });
  });

  it("env overrides the file", () => {
    writePersistedConfig({ api_url: "https://file.example.test", api_key: "ck_example_fromfile_00000000" }, env);
    const t = resolveTarget({
      env: { ...env, COMPACTION_API_URL: "https://env.example.test", COMPACTION_API_KEY: "ck_example_fromenv_00000000" }
    });
    expect(t).toMatchObject({ url: "https://env.example.test", apiKey: "ck_example_fromenv_00000000", urlSource: "env", keySource: "env" });
  });

  it("flag overrides env and file", () => {
    writePersistedConfig({ api_url: "https://file.example.test", api_key: "ck_example_fromfile_00000000" }, env);
    const t = resolveTarget({
      flagUrl: "https://flag.example.test",
      flagKey: "ck_example_fromflag_00000000",
      env: { ...env, COMPACTION_API_URL: "https://env.example.test", COMPACTION_API_KEY: "ck_example_fromenv_00000000" }
    });
    expect(t).toMatchObject({ url: "https://flag.example.test", apiKey: "ck_example_fromflag_00000000", urlSource: "flag", keySource: "flag" });
  });
});
