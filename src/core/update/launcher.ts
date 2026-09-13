import { spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { generateShimScript, resolveShimDir, SHIM_TOOLS, type ShimTool } from "../tool-shim.js";
import { tryActivate } from "./activation.js";
import { containedPath, loadManagedInstallation, validatePair } from "./ownership.js";
import { registerUntrackedHook, resolveSessionPin, runManagedSession, SESSION_PIN_ENV } from "./sessions.js";
import type { PairDescriptor } from "./types.js";

function dispatch(pair: PairDescriptor, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(pair.cli.root, "dist/cli/index.js"), ...args], { stdio: "inherit", env });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1)));
  });
}

function ownedShim(shimPath: string, launcher: string, env: NodeJS.ProcessEnv): { tool: ShimTool; realBin: string; shimPath: string } {
  const directory = realpathSync(resolveShimDir(env));
  const file = realpathSync(shimPath);
  if (path.dirname(file) !== directory) throw new Error("Session shim is outside the owned shim directory");
  const tool = (Object.keys(SHIM_TOOLS) as ShimTool[]).find((candidate) => SHIM_TOOLS[candidate].shimName === path.basename(file));
  if (!tool) throw new Error("Unknown managed shim");
  const record = JSON.parse(readFileSync(path.join(directory, ".shim-record.json"), "utf8"));
  const realBin: unknown = record.shims?.[tool]?.realBin;
  if (typeof realBin !== "string" || !path.isAbsolute(realBin)) throw new Error("Missing owned real-tool record");
  const actual = readFileSync(file, "utf8");
  if (actual !== generateShimScript(tool, realBin, launcher) && actual !== generateShimScript(tool, realBin)) {
    throw new Error("Managed shim has foreign edits; reconnect explicitly before using its managed envelope");
  }
  return { tool, realBin, shimPath: file };
}

async function delegateRuntime(root: string, args: string[], selected: PairDescriptor): Promise<number | undefined> {
  const implementationRoot = realpathSync(fileURLToPath(new URL("../../../", import.meta.url)));
  const selectedRoot = realpathSync(selected.cli.root);
  if (selectedRoot !== implementationRoot) {
    validatePair(root, selected);
    const launcher = path.join(selectedRoot, "dist/core/update/launcher.js");
    const actual = realpathSync(launcher);
    const relative = path.relative(realpathSync(selected.cli.installRoot), actual).split(path.sep).join("/");
    if (actual !== launcher || !containedPath(selectedRoot, actual) || !selected.cli.files[relative]) {
      throw new Error("Managed launcher is outside the verified release inventory");
    }
    // The immutable bootstrap authenticates the selected runtime; only that runtime admits
    // sessions, schedules updates, or transitions to a newer pair. Never execute staged code.
    const implementation = await import(pathToFileURL(actual).href) as { launchManaged: typeof launchManaged };
    if (typeof implementation.launchManaged !== "function") throw new Error("Managed launcher entrypoint is missing");
    return implementation.launchManaged(root, args);
  }
  return undefined;
}

/** Stable command identity for CLI calls, native hooks, and complete shim lifetimes. */
export async function launchManaged(root: string, args: string[]): Promise<number> {
  try {
    const { receipt, state } = loadManagedInstallation(root, false);
    const env: NodeJS.ProcessEnv = { ...process.env, COMPACTION_HOME: path.dirname(root), COMPACTION_CONFIG_DIR: path.dirname(root) };
    const token = env[SESSION_PIN_ENV];
    const pinned = token ? resolveSessionPin(root, token) : undefined;
    if (token && !pinned) throw new Error("Managed session reference is expired or invalid");
    const delegated = await delegateRuntime(root, args, pinned ?? state.current);
    if (delegated !== undefined) return delegated;
    const quietCommand = ["hooks", "statusline", "capture", "precall"].includes(args[0] ?? "");
    const runtimeHook = ["statusline", "precall"].includes(args[0] ?? "")
      || (args[0] === "hooks" && ["shape", "line"].includes(args[1] ?? ""))
      || (args[0] === "capture" && ["--from-hook", "--from-prompt-hook", "--shape-prompt-hook"].some((flag) => args.includes(flag)));
    if (runtimeHook) {
      if (pinned) return dispatch(pinned, args, env);
      const admitted = await registerUntrackedHook(root);
      return dispatch(admitted.pair, args, { ...env, [SESSION_PIN_ENV]: admitted.id });
    }
    if (args[0] === "update") return dispatch(pinned ?? state.current, args, env);
    if (pinned && args[0] !== "--managed-session-shim") return dispatch(pinned, args, env);
    if (!pinned && !quietCommand) {
      // Only a new top-level boundary may check or activate. Failures leave current selected.
      try {
        const { gatewayBarrier } = await import("../gateway/update-identity.js");
        await tryActivate(root, { gatewayBarrier, env });
      } catch { /* A busy, offline, or unverifiable candidate leaves the current pair intact. */ }
      // Activation, including another launcher completing concurrently, can change current.
      // Re-select its verified implementation before scheduling or admitting this invocation.
      const activated = await delegateRuntime(root, args, loadManagedInstallation(root, false).state.current);
      if (activated !== undefined) return activated;
      try {
        const schedulerModule = "./scheduler.js";
        const { maybeScheduleUpdate, consumeUpdateNotice } = await import(schedulerModule);
        await maybeScheduleUpdate(root, env);
        if (args[0] !== "--managed-session-shim" && process.stdin.isTTY && process.stderr.isTTY) {
          const notice = await consumeUpdateNotice(root, env);
          if (typeof notice === "string" && notice) process.stderr.write(notice.endsWith("\n") ? notice : `${notice}\n`);
        }
      } catch { /* Update discovery cannot prevent a normal tool launch. */ }
    }
    if (args[0] === "--managed-session-shim") {
      if (args.length < 3 || args[2] !== "--") throw new Error("Invalid managed shim invocation");
      const shim = ownedShim(args[1], receipt.launcherPath, env);
      return runManagedSession(root, "/bin/bash", [], {
        env: { ...env, COMPACTION_BIN: receipt.launcherPath },
        commandForPair: async (pair) => {
          const implementation = await import(pathToFileURL(path.join(pair.cli.root, "dist/core/tool-shim.js")).href) as { generateShimScript: typeof generateShimScript };
          return { command: "/bin/bash", args: ["-c", implementation.generateShimScript(shim.tool, shim.realBin), shim.shimPath, ...args.slice(3)] };
        }
      });
    }
    return runManagedSession(root, process.execPath, [], {
      env,
      commandForPair: (pair) => ({ command: process.execPath, args: [path.join(pair.cli.root, "dist/cli/index.js"), ...args] })
    });
  } catch (error) {
    process.stderr.write(`compaction: ${error instanceof Error ? error.message : "managed launch failed"}\n`);
    return 125;
  }
}
