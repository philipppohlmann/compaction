import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { automaticUpdatesEnabled, consumeUpdateNotice, maybeScheduleUpdate, rememberUpdateCandidate, reserveUpdateCheck, UPDATE_CHECK_TTL_MS } from "../../src/core/update/scheduler.js";
import { writeUpdatePreferences } from "../../src/core/onboarding-preferences.js";
import { loadManagedInstallation } from "../../src/core/update/ownership.js";
import { spawn } from "node:child_process";
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(), spawn: vi.fn(() => ({ once: vi.fn(), unref: vi.fn() })) }));
vi.mock("../../src/core/update/ownership.js", async (original) => ({ ...await original<typeof import("../../src/core/update/ownership.js")>(), loadManagedInstallation: vi.fn(() => ({ state: { current: { id: "old", cli: { version: "0.6.8" } } } })) }));
const roots: string[] = [];
function fixture() { const root = mkdtempSync(path.join(tmpdir(), "compaction-schedule-test-")); roots.push(root); return { root, env: { COMPACTION_CONFIG_DIR: root } }; }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.clearAllMocks(); });
describe("bounded managed update scheduling (controlled ownership seam)", () => {
  it("reserves exactly once across concurrent launches and expires about daily", async () => {
    const { root, env } = fixture(); const now = Date.now();
    const results = await Promise.all(Array.from({ length: 12 }, () => reserveUpdateCheck(root, env, now)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await reserveUpdateCheck(root, env, now + UPDATE_CHECK_TTL_MS - 1)).toBe(false);
    expect(await reserveUpdateCheck(root, env, now + UPDATE_CHECK_TTL_MS)).toBe(true);
    expect(Object.keys(JSON.parse(readFileSync(path.join(root, "update-check.json"), "utf8"))).sort()).toEqual(["channel", "checkedAt", "schema"]);
  });
  it("opt-out, CI and unknown ownership cannot reserve or change update state", async () => {
    const { root, env } = fixture();
    for (const disabled of [{ ...env, CI: "1" }, { ...env, COMPACTION_AUTO_UPDATE: "0" }]) {
      expect(await reserveUpdateCheck(root, disabled)).toBe(false);
      expect(maybeScheduleUpdate(root, disabled)).toBeUndefined();
    }
    writeUpdatePreferences({ autoUpdates: false }, env);
    expect(automaticUpdatesEnabled(env)).toBe(false); expect(await reserveUpdateCheck(root, env)).toBe(false);
    expect(existsSync(path.join(root, "update-check.json"))).toBe(false);
    writeUpdatePreferences({ autoUpdates: true }, env);
    vi.mocked(loadManagedInstallation).mockImplementationOnce(() => { throw new Error("not managed"); });
    expect(await reserveUpdateCheck(root, env)).toBe(false);
  });
  it("emits one content-free notice per candidate, with no notice mutation after opt-out", async () => {
    const { root, env } = fixture(); await reserveUpdateCheck(root, env);
    await rememberUpdateCandidate(root, "0.6.9");
    const before = readFileSync(path.join(root, "update-check.json"), "utf8");
    expect(await consumeUpdateNotice(root, { ...env, COMPACTION_AUTO_UPDATE: "0" })).toBeUndefined();
    expect(readFileSync(path.join(root, "update-check.json"), "utf8")).toBe(before);
    expect(await consumeUpdateNotice(root, env)).toContain("0.6.9");
    expect(await consumeUpdateNotice(root, env)).toBeUndefined();
    await rememberUpdateCandidate(root, "0.7.0"); expect(await consumeUpdateNotice(root, env)).toContain("0.7.0");
  });
  it("does not interpolate malformed candidate bytes or retain injected cache fields", async () => {
    const { root, env } = fixture(); const cache = path.join(root, "update-check.json");
    writeFileSync(cache, JSON.stringify({ schema: 1, checkedAt: 1, channel: "stable", candidate: "0.6.9\n\u001b[31m" }));
    expect(await consumeUpdateNotice(root, env)).toBeUndefined();
    writeFileSync(cache, JSON.stringify({ schema: 1, checkedAt: 1, channel: "stable", candidate: "0.6.9", request_body: "fixture-secret" }));
    await consumeUpdateNotice(root, env);
    expect(readFileSync(cache, "utf8")).not.toMatch(/request_body|fixture-secret/);
  });
  it("derives ready/active notices from verified state and suppresses stale candidates", async () => {
    const { root, env } = fixture(); await reserveUpdateCheck(root, env);
    const pairId = "a".repeat(64);
    await rememberUpdateCandidate(root, "0.6.9", pairId);
    vi.mocked(loadManagedInstallation).mockReturnValueOnce({ state: { current: { id: "old" }, staged: { id: pairId, cli: { version: "0.6.9" } } } } as ReturnType<typeof loadManagedInstallation>);
    expect(await consumeUpdateNotice(root, env)).toBe("Compaction 0.6.9 is staged for a safe next session.");
    expect(await consumeUpdateNotice(root, env)).toBeUndefined();
    const next = "b".repeat(64); await rememberUpdateCandidate(root, "0.6.10", next);
    vi.mocked(loadManagedInstallation).mockReturnValueOnce({ state: { current: { id: next } } } as ReturnType<typeof loadManagedInstallation>);
    expect(await consumeUpdateNotice(root, env)).toBe("Compaction 0.6.10 is now active.");
    await rememberUpdateCandidate(root, "0.6.11", "c".repeat(64));
    expect(await consumeUpdateNotice(root, env)).toBeUndefined();
  });
  it("returns before its detached quiet worker can run, without forwarding credential configuration", async () => {
    const { root, env } = fixture();
    const result = maybeScheduleUpdate(root, { ...env, OPENAI_API_KEY: "fixture-provider", NPM_TOKEN: "fixture-npm", NODE_OPTIONS: "fixture-node" });
    expect(result).toBeUndefined(); expect(spawn).not.toHaveBeenCalled();
    await new Promise(resolve => setImmediate(resolve));
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(spawn).mock.calls[0][2]).toMatchObject({ detached: true, stdio: "ignore" });
    expect(JSON.stringify(vi.mocked(spawn).mock.calls)).not.toMatch(/fixture-provider|fixture-npm|fixture-node/);
  });
});
