import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { externalUpdateInstruction, registerUpdateCommand } from "../../src/cli/commands/update.js";
import { loadExecutingManagedInstallation } from "../../src/core/update/ownership.js";
import { discoverVersion } from "../../src/core/update/registry.js";
import { stageLatestUpdate } from "../../src/core/update/worker.js";
import { rollbackPair } from "../../src/core/update/activation.js";
vi.mock("../../src/core/update/ownership.js", async original => ({ ...await original<typeof import("../../src/core/update/ownership.js")>(), loadExecutingManagedInstallation: vi.fn() }));
vi.mock("../../src/core/update/registry.js", async original => ({ ...await original<typeof import("../../src/core/update/registry.js")>(), discoverVersion: vi.fn() }));
vi.mock("../../src/core/update/worker.js", () => ({ stageLatestUpdate: vi.fn() }));
vi.mock("../../src/core/update/activation.js", () => ({ rollbackPair: vi.fn() }));
vi.mock("../../src/core/gateway/update-identity.js", () => ({ gatewayBarrier: vi.fn() }));
let root: string;
const log = vi.spyOn(console, "log").mockImplementation(() => {});
const error = vi.spyOn(console, "error").mockImplementation(() => {});
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "compaction-update-cli-")); vi.stubEnv("COMPACTION_CONFIG_DIR", root);
  vi.mocked(loadExecutingManagedInstallation).mockReturnValue(undefined);
  vi.mocked(discoverVersion).mockResolvedValue({ version: "0.6.9" });
});
afterEach(() => { process.exitCode = undefined; vi.clearAllMocks(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
async function command(...args: string[]) { const program = new Command().name("compaction").version("0.6.8"); registerUpdateCommand(program); await program.parseAsync(["node", "compaction", "update", ...args]); }
function managed() { vi.mocked(loadExecutingManagedInstallation).mockReturnValue({ root, pair: { cli: { version: "0.6.8" } } } as ReturnType<typeof loadExecutingManagedInstallation>); }
describe("compaction update command boundary", () => {
  it("checks public stable/preview releases without configuration or installation writes", async () => {
    await command("--check", "--channel", "preview");
    expect(discoverVersion).toHaveBeenCalledWith("preview");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Installed: 0.6.8. preview: 0.6.9"));
    expect(stageLatestUpdate).not.toHaveBeenCalled(); expect(rollbackPair).not.toHaveBeenCalled();
    expect(existsSync(path.join(root, "preferences.json"))).toBe(false);
  });
  it.each([[], ["--channel", "preview"], ["--rollback"]].map(args => ({ args })))("external invocation never adopts or mutates package files: $args", async ({ args }) => {
    await command(...args);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("package manager"));
    expect(stageLatestUpdate).not.toHaveBeenCalled(); expect(discoverVersion).not.toHaveBeenCalled(); expect(rollbackPair).not.toHaveBeenCalled();
    expect(existsSync(path.join(root, "preferences.json"))).toBe(false);
  });
  it("persists explicit opt-out without losing existing onboarding choices", async () => {
    managed(); writeFileSync(path.join(root, "preferences.json"), JSON.stringify({ optimization_mode: "cache", product_mode: "basic", connected_workflows: ["codex"] }));
    await command("--auto", "off");
    expect(JSON.parse(readFileSync(path.join(root, "preferences.json"), "utf8"))).toEqual({ optimization_mode: "cache", product_mode: "basic", connected_workflows: ["codex"], auto_updates: false });
    expect(stageLatestUpdate).not.toHaveBeenCalled(); expect(discoverVersion).not.toHaveBeenCalled();
  });
  it.each([["--check", "--auto", "off"], ["--rollback", "--channel", "preview"], ["--channel", "development"]].map(args => ({ args })))("rejects ambiguous or unsupported modes: $args", async ({ args }) => {
    managed(); await command(...args);
    expect(process.exitCode).toBe(1); expect(error).toHaveBeenCalled(); expect(discoverVersion).not.toHaveBeenCalled();
    expect(existsSync(path.join(root, "preferences.json"))).toBe(false);
  });
  it("delegates rollback to the pair coordinator and prints its actual deferred result", async () => {
    managed(); vi.mocked(rollbackPair).mockResolvedValue({ status: "deferred", reason: "active-session" } as Awaited<ReturnType<typeof rollbackPair>>);
    await command("--rollback"); expect(rollbackPair).toHaveBeenCalledWith(root, { gatewayBarrier: expect.any(Function) });
    expect(log).toHaveBeenCalledWith("Rollback: deferred (active-session)."); expect(stageLatestUpdate).not.toHaveBeenCalled();
  });
  it("does not call an already staged candidate the current installed version", async () => {
    managed(); vi.mocked(stageLatestUpdate).mockResolvedValue({ status: "already-staged", version: "0.6.9" });
    await command(); expect(log).toHaveBeenCalledWith("Compaction 0.6.9 already staged for a safe next session.");
  });
  it("reports retained verified engine instead of falsely downgrading it in output", async () => {
    managed(); vi.mocked(stageLatestUpdate).mockResolvedValue({ status: "staged", version: "0.6.9", engineMode: "signed", reason: "download-unavailable" });
    await command(); expect(log).toHaveBeenCalledWith("Engine selection: verified compatible engine (download-unavailable).");
  });
  it.each(["1.0", "2.0"])("explains the verified EULA %s requirement without accepting it", async version => {
    managed(); vi.mocked(stageLatestUpdate).mockResolvedValue({ status: "staged", version: "0.6.9", engineMode: "basic", reason: "eula-not-accepted", requiredEulaVersion: version });
    await command();
    const output = log.mock.calls.flat().join("\n");
    expect(output).toContain(`signed engine release requires EULA ${version}`);
    expect(output).toContain("compaction engine license");
    if (version === "2.0") {
      expect(output).toContain("can present only EULA 1.0");
      expect(output).toContain("Update and activate a CLI");
    }
    expect(existsSync(path.join(root, "engine-eula.json"))).toBe(false);
  });
  it.each([
    { directory: "prefix/lib/node_modules/@compaction/cli", owner: "npm-global", instruction: "npm install -g @compaction/cli@next" },
    { directory: "cache/_npx/controlled/node_modules/@compaction/cli", owner: "npx", instruction: "npx @compaction/cli@next" },
    { directory: "Cellar/compaction/0.6.8/libexec/lib/node_modules/@compaction/cli", owner: "Homebrew", instruction: "brew upgrade compaction" },
    { directory: "checkout", owner: "Source/dev", instruction: "source checkout" }
  ])("gives the actual $owner package manager instruction without executing it", ({ directory, owner, instruction }) => {
    const packageRoot = path.join(root, directory); mkdirSync(path.join(packageRoot, "dist/cli"), { recursive: true });
    writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ name: "@compaction/cli", bin: { compaction: "dist/cli/index.js" } }));
    writeFileSync(path.join(packageRoot, "dist/cli/index.js"), "// Controlled owner fixture");
    if (owner === "Source/dev") mkdirSync(path.join(packageRoot, ".git"));
    const output = externalUpdateInstruction(path.join(packageRoot, "dist/cli/index.js"), "preview");
    expect(output).toContain(owner); expect(output).toContain(instruction);
  });
});
