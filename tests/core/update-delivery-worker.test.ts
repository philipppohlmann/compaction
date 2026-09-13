import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runUpdateWorker, stageLatestUpdate } from "../../src/core/update/worker.js";
import { discoverVersion, registryRelease } from "../../src/core/update/registry.js";
import { stageRegistryPackage } from "../../src/core/update/package-stage.js";
import { selectCandidateEngine } from "../../src/core/update/engine-pair.js";
import { loadManagedInstallation } from "../../src/core/update/ownership.js";
import { stagePair } from "../../src/core/update/activation.js";
import { writeUpdatePreferences } from "../../src/core/onboarding-preferences.js";
import { currentReleaseCompatibility } from "../../src/core/update/compatibility.js";
import type { PairDescriptor } from "../../src/core/update/types.js";
import { createPair } from "../../src/core/update/pair.js";
vi.mock("../../src/core/update/registry.js", () => ({ discoverVersion: vi.fn(), registryRelease: vi.fn(x => x) }));
vi.mock("../../src/core/update/package-stage.js", () => ({ stageRegistryPackage: vi.fn() }));
vi.mock("../../src/core/update/engine-pair.js", () => ({ selectCandidateEngine: vi.fn() }));
vi.mock("../../src/core/update/ownership.js", () => ({ loadManagedInstallation: vi.fn() }));
vi.mock("../../src/core/update/activation.js", () => ({ stagePair: vi.fn() }));
vi.mock("../../src/core/update/scheduler.js", async original => ({ ...await original<typeof import("../../src/core/update/scheduler.js")>(), rememberUpdateCandidate: vi.fn() }));
let root: string; let env: NodeJS.ProcessEnv;
function cli(version: string): PairDescriptor["cli"] { return { root: "/fixture", installRoot: "/fixture", version, integrity: "fixture-integrity", files: {}, compatibility: currentReleaseCompatibility(version) }; }
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "compaction-worker-test-")); env = { COMPACTION_CONFIG_DIR: root };
  vi.mocked(loadManagedInstallation).mockReturnValue({ state: { revision: 3, current: { id: "old", cli: cli("0.6.8"), engine: { mode: "basic" } } } } as ReturnType<typeof loadManagedInstallation>);
  vi.mocked(discoverVersion).mockResolvedValue({ version: "0.6.9" });
  vi.mocked(stageRegistryPackage).mockResolvedValue(cli("0.6.9"));
  vi.mocked(selectCandidateEngine).mockResolvedValue({ engine: { mode: "basic" }, reason: "no-account" });
});
afterEach(() => { vi.clearAllMocks(); rmSync(root, { recursive: true, force: true }); });
describe("update worker acquisition and coordinator handoff (controlled I/O seams)", () => {
  it.each([true, false])("preserves the verified required EULA version with newer CLI=%s", async newer => {
    if (!newer) vi.mocked(discoverVersion).mockResolvedValueOnce({ version: "0.6.8" });
    vi.mocked(selectCandidateEngine).mockResolvedValueOnce({ engine: { mode: "basic" }, reason: "eula-not-accepted", requiredEulaVersion: "2.0" });
    expect(await stageLatestUpdate(root, "stable", env)).toMatchObject({
      status: newer ? "staged" : "unchanged", reason: "eula-not-accepted", requiredEulaVersion: "2.0"
    });
    expect(existsSync(path.join(root, "engine-eula.json"))).toBe(false);
  });
  it("background staging never prompts or records consent for newly required terms", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      vi.mocked(selectCandidateEngine).mockResolvedValueOnce({ engine: { mode: "basic" }, reason: "eula-not-accepted", requiredEulaVersion: "2.0" });
      await runUpdateWorker(root, env);
      expect(log).not.toHaveBeenCalled();
      expect(existsSync(path.join(root, "engine-eula.json"))).toBe(false);
    } finally { log.mockRestore(); }
  });
  it("stages a coherent Basic pair with CAS, never promotes independently", async () => {
    expect(await stageLatestUpdate(root, "preview", env)).toMatchObject({ status: "staged", engineMode: "basic", reason: "no-account" });
    expect(discoverVersion).toHaveBeenCalledWith("preview");
    expect(stagePair).toHaveBeenCalledWith(root, expect.objectContaining({ engine: { mode: "basic" }, cli: expect.objectContaining({ version: "0.6.9" }) }), "explicit", 3, undefined);
  });
  it.each(["offline", "integrity mismatch", "smoke failed", "incompatible metadata"])("keeps active pair and stays quiet when acquisition fails: %s", async message => {
    vi.mocked(stageRegistryPackage).mockRejectedValueOnce(new Error(message));
    await expect(runUpdateWorker(root, env)).resolves.toBeUndefined();
    expect(stagePair).not.toHaveBeenCalled(); expect(selectCandidateEngine).not.toHaveBeenCalled();
  });
  it.each(["opt-out", "channel-change"])("rechecks %s at the coordinator write boundary after deferred acquisition", async kind => {
    vi.mocked(selectCandidateEngine).mockImplementationOnce(async () => {
      writeUpdatePreferences(kind === "opt-out" ? { autoUpdates: false } : { channel: "preview" }, env);
      return { engine: { mode: "basic" } };
    });
    vi.mocked(stagePair).mockImplementationOnce(async (_root, _pair, intent, _revision, precondition) => {
      expect(intent).toBe("automatic");
      expect(precondition).toBeTypeOf("function"); expect(precondition!()).toBe(false);
      throw new Error("preferences changed");
    });
    await expect(runUpdateWorker(root, env)).resolves.toBeUndefined();
    expect(stagePair).toHaveBeenCalledTimes(1);
  });
  it("rechecks automatic preferences at the engine network boundary before starting acquisition", async () => {
    vi.mocked(selectCandidateEngine).mockImplementationOnce(async (_cli, _engine, options) => {
      writeUpdatePreferences({ autoUpdates: false }, env);
      expect(options?.onNetwork).toBeTypeOf("function");
      expect(() => options!.onNetwork!()).toThrow("preferences changed");
      throw new Error("fixture stopped before engine request");
    });
    await runUpdateWorker(root, env);
    expect(stagePair).not.toHaveBeenCalled();
  });
  it("does not start discovery in CI or with persisted opt-out", async () => {
    await runUpdateWorker(root, { ...env, CI: "1" });
    writeUpdatePreferences({ autoUpdates: false }, env); await runUpdateWorker(root, env);
    expect(discoverVersion).not.toHaveBeenCalled(); expect(registryRelease).not.toHaveBeenCalled();
  });
  it("refreshes and coordinates an engine-only candidate when the CLI is already current", async () => {
    vi.mocked(discoverVersion).mockResolvedValueOnce({ version: "0.6.8" });
    const engine: PairDescriptor["engine"] = { mode: "signed", artifactPath: "/controlled-verified-selector-fixture/engine", trust: "pinned-root", compatibility: currentReleaseCompatibility("0.6.8"),
      manifest: { schema_version: 2, version: "0.6.10", channel: "stable", platform: "any", arch: "any", artifact_kind: "node-script", sha256: "a".repeat(64), size_bytes: 3,
        cli_min_version: "0.6.8", cli_max_version: "1.0.0", engine_protocol: 1, usage_schema_version: 3, meter_version: "optimized-input-v2", eula_version: "fixture-terms" } };
    vi.mocked(selectCandidateEngine).mockResolvedValueOnce({ engine });
    expect(await stageLatestUpdate(root, "stable", env)).toMatchObject({ status: "staged", version: "0.6.8", engineMode: "signed" });
    expect(stageRegistryPackage).not.toHaveBeenCalled();
    expect(selectCandidateEngine).toHaveBeenCalledWith(expect.objectContaining({ version: "0.6.8" }), { mode: "basic" }, { env, refresh: true });
    expect(stagePair).toHaveBeenCalledWith(root, expect.objectContaining({ engine }), "explicit", 3, undefined);
  });

  it.each([true, false])("hands same-pair intent to the atomic coordinator instead of returning early (automatic=%s)", async (automatic) => {
    const staged = createPair(cli("0.6.9"), { mode: "basic" });
    const { state } = loadManagedInstallation(root);
    vi.mocked(loadManagedInstallation).mockReturnValue({ state: { ...state, staged, stagedIntent: automatic ? "explicit" : "automatic" } } as ReturnType<typeof loadManagedInstallation>);
    if (!automatic) writeUpdatePreferences({ autoUpdates: false }, env);
    expect(await stageLatestUpdate(root, "stable", env, automatic)).toMatchObject({ status: "already-staged" });
    expect(stagePair).toHaveBeenCalledWith(root, staged, automatic ? "automatic" : "explicit", 3, automatic ? expect.any(Function) : undefined);
    expect(stageRegistryPackage).not.toHaveBeenCalled();
  });
});
