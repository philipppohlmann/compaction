import type { Command } from "commander";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { readUpdatePreferences, writeUpdatePreferences } from "../../core/onboarding-preferences.js";
import { compareReleaseVersions } from "../../core/update/compatibility.js";
import { loadExecutingManagedInstallation } from "../../core/update/ownership.js";
import { discoverVersion, type UpdateChannel } from "../../core/update/registry.js";
import { stageLatestUpdate } from "../../core/update/worker.js";
import { withManagedLock } from "../../core/update/state.js";
import { engineEulaRequirementInstruction } from "./engine.js";

export function externalUpdateInstruction(entry = process.argv[1], channel: UpdateChannel = "stable"): string {
  const tag = channel === "preview" ? "next" : "latest";
  try {
    const file = realpathSync(entry);
    const packageRoot = path.resolve(path.dirname(file), "../..");
    const pkg = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));
    if (pkg.name !== "@compaction/cli") throw new Error("unknown package");
    if (existsSync(path.join(packageRoot, ".git")) || file.endsWith("/src/cli/index.ts")) {
      return "Source/dev installation: update your source checkout and rebuild using the repository instructions; no package files were changed.";
    }
    if (/\/_npx\/[^/]+\/node_modules\/@compaction\/cli\//.test(file)) return `npx installation: start the requested release with npx @compaction/cli@${tag}; no package files were changed.`;
    const brew = /\/(?:Cellar|Caskroom)\/([A-Za-z0-9@+_.-]+)\//.exec(file);
    if (brew) return `Homebrew installation: use brew upgrade ${brew[1]}; no package files were changed.`;
    if (/\/lib\/node_modules\/@compaction\/cli\/dist\/cli\/index\.js$/.test(file) && pkg.bin?.compaction === "dist/cli/index.js") {
      return `npm-global installation: use npm install -g @compaction/cli@${tag}; no package files were changed.`;
    }
  } catch { /* No exact owner evidence: never take over an unknown installation. */ }
  return "Unknown installation ownership: update with the owning package manager, or explicitly rerun https://cli.compaction.dev/install — no package files were changed.";
}

export function registerUpdateCommand(program: Command): void {
  program.command("update").description("Check or stage a verified CLI/engine update; activate at a safe next session.")
    .option("--check", "Check the public npm release without changing the installation")
    .option("--channel <channel>", "stable (npm latest) or preview (npm next)")
    .option("--rollback", "Ask the coordinator to restore the previous verified pair when safe")
    .option("--auto <setting>", "Persist automatic updates: on or off")
    .action(async (options: { check?: boolean; channel?: string; rollback?: boolean; auto?: string }) => {
      try {
        const channel = options.channel ?? readUpdatePreferences().channel;
        if (channel !== "stable" && channel !== "preview") throw new Error("Channel must be stable or preview.");
        if (options.rollback && (options.check || options.channel || options.auto)) throw new Error("Use --rollback by itself.");
        if (options.auto && options.check) throw new Error("Use --auto and --check separately.");
        const managed = loadExecutingManagedInstallation();
        if (options.auto !== undefined) {
          if (options.auto !== "on" && options.auto !== "off") throw new Error("--auto must be on or off.");
          if (!managed) throw new Error("Automatic-update preferences require an owned managed invocation.");
          await withManagedLock(managed.root, () => writeUpdatePreferences({ autoUpdates: options.auto === "on", ...(options.channel ? { channel } : {}) }));
          console.log(`Automatic updates ${options.auto === "on" ? "enabled for managed installations" : "disabled"}.`);
          return;
        }
        if (options.check) {
          const latest = await discoverVersion(channel);
          const installed = managed?.pair.cli.version ?? program.version() ?? "unknown";
          const newer = compareReleaseVersions(latest.version as string, installed);
          console.log(`Installed: ${installed}. ${channel}: ${latest.version}${newer === 1 ? " (update available)" : ""}.`);
          return;
        }
        if (!managed) {
          console.log(externalUpdateInstruction(process.argv[1], channel));
          return;
        }
        if (options.rollback) {
          const { rollbackPair } = await import("../../core/update/activation.js");
          const { gatewayBarrier } = await import("../../core/gateway/update-identity.js");
          const result = await rollbackPair(managed.root, { gatewayBarrier });
          console.log(`Rollback: ${result.status}${result.reason ? ` (${result.reason})` : ""}.`);
          return;
        }
        if (options.channel) await withManagedLock(managed.root, () => writeUpdatePreferences({ channel: channel as UpdateChannel }));
        const result = await stageLatestUpdate(managed.root, channel);
        console.log(result.status !== "unchanged" ? `Compaction ${result.version} ${result.status === "already-staged" ? "already " : ""}staged for a safe next session.` : `Already up to date: ${result.version}.`);
        if (result.reason) console.log(`Engine selection: ${result.engineMode === "signed" ? "verified compatible engine" : "Basic"} (${result.reason}).`);
        if (result.requiredEulaVersion) console.log(engineEulaRequirementInstruction(result.requiredEulaVersion));
      } catch (error) {
        console.error(`Update did not complete: ${error instanceof Error ? error.message : "unknown failure"}`);
        process.exitCode = 1;
      }
    });
}
