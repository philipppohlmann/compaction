import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateShimScript } from "../../src/core/tool-shim.js";
import { currentReleaseCompatibility } from "../../src/core/update/compatibility.js";
import { inventoryRelease, loadManagedInstallation } from "../../src/core/update/ownership.js";
import { registerUntrackedHook, resolveSessionPin, runManagedSession, SESSION_PIN_ENV } from "../../src/core/update/sessions.js";
import { tryActivate } from "../../src/core/update/activation.js";
import { maybeScheduleUpdate, consumeUpdateNotice } from "../../src/core/update/scheduler.js";
import { launchManaged } from "../../src/core/update/launcher.js";
import type { PairDescriptor } from "../../src/core/update/types.js";

vi.mock("../../src/core/update/ownership.js", async (original) => ({
  ...await original<typeof import("../../src/core/update/ownership.js")>(), loadManagedInstallation: vi.fn()
}));
vi.mock("../../src/core/update/sessions.js", () => ({
  SESSION_PIN_ENV: "COMPACTION_SESSION_PIN", resolveSessionPin: vi.fn(),
  registerUntrackedHook: vi.fn(), runManagedSession: vi.fn().mockResolvedValue(23)
}));
vi.mock("../../src/core/update/activation.js", () => ({ tryActivate: vi.fn() }));
vi.mock("../../src/core/gateway/update-identity.js", () => ({ gatewayBarrier: vi.fn() }));
vi.mock("../../src/core/update/scheduler.js", () => ({ maybeScheduleUpdate: vi.fn(), consumeUpdateNotice: vi.fn() }));
vi.mock("node:child_process", async (original) => {
  const { EventEmitter } = await import("node:events");
  return { ...await original<typeof import("node:child_process")>(), spawn: vi.fn(() => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("exit", 29, null));
    return child;
  }) };
});

const roots: string[] = [];
beforeEach(() => { vi.clearAllMocks(); vi.mocked(tryActivate).mockReset(); vi.stubEnv(SESSION_PIN_ENV, ""); });
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "compaction-delegation-")); roots.push(root);
  const makePair = (version: string) => {
    const installRoot = path.join(root, "releases", version);
    const packageRoot = path.join(installRoot, "node_modules/@compaction/cli");
    const marker = path.join(root, `${version}-executed`);
    mkdirSync(path.join(packageRoot, "dist/core/update"), { recursive: true });
    mkdirSync(path.join(packageRoot, "dist/cli"), { recursive: true });
    const compatibility = currentReleaseCompatibility(version);
    writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({
      name: "@compaction/cli", version, type: "module", compactionRelease: compatibility
    }));
    writeFileSync(path.join(packageRoot, "dist/cli/index.js"), "export {};\n");
    // Deliberately observable fixture runtime, not evidence of full installed CLI behavior.
    writeFileSync(path.join(packageRoot, "dist/core/update/launcher.js"),
      `import {writeFileSync} from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'imported');\n` +
      `export async function launchManaged(root,args) { writeFileSync(${JSON.stringify(marker)}, JSON.stringify({root,args})); return 17; }\n`);
    const pair: PairDescriptor = { id: version, cli: {
      root: packageRoot, installRoot, version, integrity: "fixture-integrity", compatibility,
      files: inventoryRelease(installRoot), source: "local-artifact", provenance: "local-artifact"
    }, engine: { mode: "basic" } };
    return { pair, marker, launcher: path.join(packageRoot, "dist/core/update/launcher.js") };
  };
  const a = makePair("0.6.8"), b = makePair("0.6.9"), c = makePair("0.6.10");
  const installation = { receipt: { launcherPath: path.join(root, "compaction") }, state: { current: b.pair, previous: a.pair, staged: c.pair } };
  vi.mocked(loadManagedInstallation).mockReturnValue(installation as ReturnType<typeof loadManagedInstallation>);
  return { root, a, b, c, installation };
}

describe("verified launcher runtime delegation before admission", () => {
  it("delegates unchanged arguments to current, never staged, before activation or session admission", async () => {
    const f = fixture(); const args = ["hooks", "status", "--fixture"];
    expect(await launchManaged(f.root, args)).toBe(17);
    expect(JSON.parse(readFileSync(f.b.marker, "utf8"))).toEqual({ root: f.root, args });
    expect(existsSync(f.a.marker)).toBe(false); expect(existsSync(f.c.marker)).toBe(false);
    expect(runManagedSession).not.toHaveBeenCalled(); expect(registerUntrackedHook).not.toHaveBeenCalled();
    expect(tryActivate).not.toHaveBeenCalled();
  });
  it("selects the valid pinned previous runtime instead of current or staged", async () => {
    const f = fixture(); vi.stubEnv(SESSION_PIN_ENV, "controlled-live-pin");
    vi.mocked(resolveSessionPin).mockReturnValue(f.a.pair);
    expect(await launchManaged(f.root, ["hooks", "status"])).toBe(17);
    expect(existsSync(f.a.marker)).toBe(true); expect(existsSync(f.b.marker)).toBe(false); expect(existsSync(f.c.marker)).toBe(false);
    expect(resolveSessionPin).toHaveBeenCalledWith(f.root, "controlled-live-pin");
  });
  it.each(["expired-pin", "hash", "protocol", "outside", "launcher-link", "missing-launcher"])("refuses %s before importing any runtime", async (kind) => {
    const f = fixture(); const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    if (kind === "expired-pin") { vi.stubEnv(SESSION_PIN_ENV, "expired"); vi.mocked(resolveSessionPin).mockReturnValue(undefined); }
    if (kind === "hash") writeFileSync(f.b.launcher, readFileSync(f.b.launcher, "utf8") + "\n// changed\n");
    if (kind === "protocol") f.b.pair.cli.compatibility.launcherProtocol = 2;
    if (kind === "outside") f.b.pair.cli.installRoot = path.dirname(f.root);
    if (kind === "launcher-link") {
      rmSync(f.b.launcher); symlinkSync(f.c.launcher, f.b.launcher);
    }
    if (kind === "missing-launcher") {
      rmSync(f.b.launcher); f.b.pair.cli.files = inventoryRelease(f.b.pair.cli.installRoot);
    }
    expect(await launchManaged(f.root, ["hooks", "status"])).toBe(125);
    expect(stderr).toHaveBeenCalled();
    for (const candidate of [f.a, f.b, f.c]) expect(existsSync(candidate.marker)).toBe(false);
    expect(runManagedSession).not.toHaveBeenCalled(); expect(tryActivate).not.toHaveBeenCalled();
  });
  it("continues once without delegation when the selected runtime is already executing", async () => {
    const f = fixture();
    // The source module is the executing implementation in this unit test. Receipt/pin lookup
    // and session admission are seams; file integrity above uses the real validator.
    f.b.pair.cli.root = fileURLToPath(new URL("../../", import.meta.url));
    expect(await launchManaged(f.root, ["hooks", "status"])).toBe(23);
    expect(runManagedSession).toHaveBeenCalledTimes(1);
    expect(loadManagedInstallation).toHaveBeenCalledTimes(1);
    expect(tryActivate).not.toHaveBeenCalled();
    expect(existsSync(f.b.marker)).toBe(false);
  });
  it("dispatches a nested ordinary command directly to its validated pinned runtime", async () => {
    const f = fixture(); const args = ["gateway", "ensure", "--provider", "anthropic"];
    f.b.pair.cli.root = fileURLToPath(new URL("../../", import.meta.url));
    vi.stubEnv(SESSION_PIN_ENV, "controlled-live-pin");
    vi.mocked(resolveSessionPin).mockReturnValue(f.b.pair);
    expect(await launchManaged(f.root, args)).toBe(29);
    expect(spawn).toHaveBeenCalledWith(process.execPath,
      [path.join(f.b.pair.cli.root, "dist/cli/index.js"), ...args],
      expect.objectContaining({ stdio: "inherit", env: expect.objectContaining({ [SESSION_PIN_ENV]: "controlled-live-pin" }) }));
    expect(loadManagedInstallation).toHaveBeenCalledTimes(1);
    expect(tryActivate).not.toHaveBeenCalled(); expect(maybeScheduleUpdate).not.toHaveBeenCalled();
    expect(consumeUpdateNotice).not.toHaveBeenCalled(); expect(runManagedSession).not.toHaveBeenCalled();
    expect(registerUntrackedHook).not.toHaveBeenCalled();
  });
  it("preserves the managed shim session envelope when a valid pin is inherited", async () => {
    const f = fixture(); const shimDir = path.join(f.root, "shims"); const shim = path.join(shimDir, "codex");
    const realBin = "/usr/bin/fixture-codex";
    f.b.pair.cli.root = fileURLToPath(new URL("../../", import.meta.url));
    mkdirSync(shimDir); writeFileSync(shim, generateShimScript("codex", realBin, f.installation.receipt.launcherPath));
    writeFileSync(path.join(shimDir, ".shim-record.json"), JSON.stringify({ shims: { codex: { realBin } } }));
    vi.stubEnv("COMPACTION_SHIM_DIR", shimDir); vi.stubEnv(SESSION_PIN_ENV, "controlled-live-pin");
    vi.mocked(resolveSessionPin).mockReturnValue(f.b.pair);
    expect(await launchManaged(f.root, ["--managed-session-shim", shim, "--", "--fixture"])).toBe(23);
    expect(runManagedSession).toHaveBeenCalledTimes(1);
    expect(spawn).not.toHaveBeenCalled(); expect(tryActivate).not.toHaveBeenCalled();
    expect(maybeScheduleUpdate).not.toHaveBeenCalled(); expect(consumeUpdateNotice).not.toHaveBeenCalled();
  });
  it.each([false, true])("rechecks current after activation before old-runtime scheduling or admission (activation throws: %s)", async (throws) => {
    const f = fixture();
    f.a.pair.cli.root = fileURLToPath(new URL("../../", import.meta.url));
    f.installation.state.current = f.a.pair;
    vi.mocked(tryActivate).mockImplementation(async () => {
      f.installation.state.current = f.b.pair;
      if (throws) throw new Error("Another launcher already completed activation");
      return { activated: true } as Awaited<ReturnType<typeof tryActivate>>;
    });
    expect(await launchManaged(f.root, ["--version"])).toBe(17);
    expect(tryActivate).toHaveBeenCalledTimes(1);
    expect(loadManagedInstallation).toHaveBeenCalledTimes(2);
    expect(JSON.parse(readFileSync(f.b.marker, "utf8"))).toEqual({ root: f.root, args: ["--version"] });
    expect(existsSync(f.c.marker)).toBe(false);
    expect(maybeScheduleUpdate).not.toHaveBeenCalled(); expect(consumeUpdateNotice).not.toHaveBeenCalled();
    expect(runManagedSession).not.toHaveBeenCalled(); expect(registerUntrackedHook).not.toHaveBeenCalled();
  });
  it("keeps the executing runtime and admits once when activation remains deferred", async () => {
    const f = fixture(); f.b.pair.cli.root = fileURLToPath(new URL("../../", import.meta.url));
    expect(await launchManaged(f.root, ["--version"])).toBe(23);
    expect(tryActivate).toHaveBeenCalledTimes(1); expect(loadManagedInstallation).toHaveBeenCalledTimes(2);
    expect(maybeScheduleUpdate).toHaveBeenCalledTimes(1); expect(runManagedSession).toHaveBeenCalledTimes(1);
    expect(existsSync(f.c.marker)).toBe(false);
  });
  it("refuses a corrupted newly current runtime before scheduler, notice, or admission", async () => {
    const f = fixture(); f.a.pair.cli.root = fileURLToPath(new URL("../../", import.meta.url));
    f.installation.state.current = f.a.pair;
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    vi.mocked(tryActivate).mockImplementation(async () => {
      f.installation.state.current = f.b.pair;
      writeFileSync(f.b.launcher, readFileSync(f.b.launcher, "utf8") + "\n// changed\n");
      throw new Error("Concurrent activation completed");
    });
    expect(await launchManaged(f.root, ["--version"])).toBe(125);
    expect(maybeScheduleUpdate).not.toHaveBeenCalled(); expect(consumeUpdateNotice).not.toHaveBeenCalled();
    expect(runManagedSession).not.toHaveBeenCalled(); expect(existsSync(f.b.marker)).toBe(false);
  });
});
