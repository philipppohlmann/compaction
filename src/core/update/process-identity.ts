import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { generateShimScript, type ShimTool } from "../tool-shim.js";
import type { ProcessIdentity } from "./types.js";
import { readToolProcessMetadata, type ToolExecutable } from "./process-metadata.js";

/** OS creation identity, never a locally generated wall-clock approximation. */
export function processBirth(pid: number): string | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      return `${boot}:${fields[19]}`;
    }
    if (process.platform === "darwin") {
      const birth = execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
        encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "ignore"], env: { PATH: "/usr/bin:/bin", LC_ALL: "C" }
      }).trim();
      return birth ? `darwin:${birth}` : undefined;
    }
  } catch { /* Missing process or unavailable identity remains unknown. */ }
  return undefined;
}

export function identifyProcess(pid = process.pid): ProcessIdentity {
  const birth = processBirth(pid);
  if (!birth) throw new Error("Cannot establish OS process identity");
  return { pid, birth, nonce: randomUUID() };
}

export function processIdentityStatus(identity: ProcessIdentity): "alive" | "dead" | "unknown" {
  const birth = processBirth(identity.pid);
  if (birth) return birth === identity.birth ? "alive" : "dead";
  try { process.kill(identity.pid, 0); return "unknown"; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "unknown"; }
}

export function processGroupStatus(group: number): "alive" | "dead" | "unknown" {
  try { process.kill(-group, 0); return "alive"; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "unknown"; }
}

function physical(file: string): string | undefined { try { return realpathSync(file); } catch { return undefined; } }

/** Only executable/script positions count, never a matching directory component or prompt argument. */
function commandHead(command: string): string[] {
  const tokens = command.match(/"[^"\n]*"|'[^'\n]*'|[^\s]+/g) ?? [];
  const first = tokens[0]?.replace(/^(['"])(.*)\1$/, "$2");
  if (!first) return [];
  if (["node", "nodejs", "bash", "sh", "zsh", "python", "python3"].includes(path.basename(first))) {
    const script = tokens[1]?.replace(/^(['"])(.*)\1$/, "$2");
    return script && !script.startsWith("-") ? [first, script] : [first];
  }
  return [first];
}

/** Used only at activation boundaries. Command lines never leave memory or enter journals. */
export function hasUntrackedToolProcesses(root: string, trackedPids: ReadonlySet<number>, env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    const receipt = JSON.parse(readFileSync(path.join(root, "install.json"), "utf8"));
    return scanUntrackedToolProcesses(receipt.launcherPath, env.COMPACTION_SHIM_DIR || path.join(path.dirname(root), "shims"), trackedPids, env);
  } catch { return true; }
}

/** Initial adoption needs the same guard before a managed receipt or replacement launcher exists. */
export function hasUntrackedToolProcessesForLauncher(launcherPath: string, trackedPids: ReadonlySet<number>, env: NodeJS.ProcessEnv = process.env): boolean {
  const home = env.COMPACTION_HOME || env.COMPACTION_CONFIG_DIR || path.join(env.HOME || homedir(), ".compaction");
  return scanUntrackedToolProcesses(launcherPath, env.COMPACTION_SHIM_DIR || path.join(home, "shims"), trackedPids, env);
}

function scanUntrackedToolProcesses(launcherPath: string, shimDir: string, trackedPids: ReadonlySet<number>, env: NodeJS.ProcessEnv): boolean {
  try {
    const launcher = physical(launcherPath);
    if (!launcher) return true;
    const known: ToolExecutable[] = [];
    const ownedShims = new Set<string>();
    const shimRecord = path.join(shimDir, ".shim-record.json");
    if (existsSync(shimRecord)) {
      const record = JSON.parse(readFileSync(shimRecord, "utf8"));
      for (const [tool, shimName] of [["codex", "codex"], ["cursor", "cursor-agent"], ["claude-code", "claude"]]) {
        const entry = record.shims?.[tool];
        const shim = path.join(shimDir, shimName);
        if (!entry || !existsSync(shim)) continue;
        // Ambiguous legacy ownership remains a stop, rather than permission to adopt a foreign file.
        if (typeof entry.realBin !== "string" || !path.isAbsolute(entry.realBin)) return true;
        const actual = readFileSync(shim, "utf8");
        if (actual !== generateShimScript(tool as ShimTool, entry.realBin)
          && actual !== generateShimScript(tool as ShimTool, entry.realBin, launcherPath)) return true;
        const real = physical(entry.realBin); if (!real) return true;
        known.push({ path: real, tool: shimName as ToolExecutable["tool"] });
        const ownedShim = physical(shim); if (!ownedShim) return true;
        ownedShims.add(ownedShim);
        known.push({ path: ownedShim, tool: shimName as ToolExecutable["tool"] });
      }
    }
    // Only numeric inventory comes from ps. argv text, argv0, and the inspector's environment
    // cannot identify a target process or establish ownership of its hook route.
    const rows = execFileSync("/bin/ps", ["-axo", "uid=,ruid=,pid="], {
      encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1024 * 1024, env: { PATH: "/usr/bin:/bin", LC_ALL: "C" }
    }).trim().split("\n");
    const uid = process.getuid?.(); if (uid === undefined) return true;
    const pids: number[] = [];
    for (const row of rows) {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(row); if (!match) return true;
      const pid = Number(match[3]); if (Number(match[1]) === uid && Number(match[2]) === uid && pid !== process.pid && !trackedPids.has(pid)) pids.push(pid);
    }
    const processes = readToolProcessMetadata(pids, known); if (!processes) return true;
    return processes.some(({ tool, cwd, environment, recorded, dispatch }) => {
      // The exact native-messaging dispatch is a persistent browser helper, not a tool session.
      if (tool === "claude" && dispatch === "chrome-native-host") return false;
      const userHome = environment.HOME;
      if (!userHome || !path.isAbsolute(userHome) || environment.PATH === undefined) return true;
      const resolveOnPath = (name: string): string | undefined => {
        for (const directory of environment.PATH!.split(path.delimiter)) {
          const candidate = path.resolve(cwd, directory || ".", name);
          try { const stat = statSync(candidate); if (stat.isFile() && (stat.mode & 0o111)) return realpathSync(candidate); }
          catch (error) { if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
        }
        return undefined;
      };
      const genericRouteCanReach = resolveOnPath("compaction") === launcher;
      const targetShim = resolveOnPath(tool);
      if (targetShim && ownedShims.has(targetShim)) return true;
      // A verified legacy wrapper can call compaction after its real child exits. Matching the
      // shared real binary alone is insufficient: this target's route must reach our launcher.
      if (genericRouteCanReach && recorded) return true;
      const configured = tool === "claude" ? environment.CLAUDE_CONFIG_DIR : tool === "codex" ? environment.CODEX_HOME : undefined;
      if (configured !== undefined && (!configured || !path.isAbsolute(configured))) return true;
      const directory = tool === "claude" ? ".claude" : tool === "codex" ? ".codex" : ".cursor";
      const filenames = tool === "claude" ? ["settings.json", "settings.local.json"] : tool === "codex" ? ["hooks.json", "config.toml"] : ["hooks.json"];
      const configs = filenames.flatMap((file) => [path.join(configured ?? path.join(userHome, directory), file), path.join(cwd, directory, file)]);
      for (const file of configs) {
        if (!existsSync(file)) continue;
        const raw = readFileSync(file, "utf8");
        // Permissions/project names are not hook routes. Keep malformed or ambiguous legacy
        // hook configuration conservative, without treating arbitrary config strings as hooks.
        let text = raw;
        if (file.endsWith(".json")) {
          const config = JSON.parse(raw);
          text = JSON.stringify({ hooks: config.hooks, statusLine: config.statusLine, statusline: config.statusline });
        }
        if (text.includes(launcherPath) || text.includes(launcher)) return true;
        if (genericRouteCanReach && /\bcompaction\s+(?:capture|hooks|statusline)\b/.test(text)) return true;
        if (genericRouteCanReach && /compaction/i.test(text)) return true;
      }
      return false;
    });
  } catch { return true; }
}

/** Content-free matches allow callers to distinguish their own instances from concurrent ones. */
export function listUnregisteredGatewayProcessIds(registeredPids: ReadonlySet<number>): number[] | "unknown" {
  try {
    const rows = execFileSync("/bin/ps", ["-axo", "uid=,pid=,args="], {
      encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 4 * 1024 * 1024
    }).trim().split("\n");
    const uid = process.getuid?.();
    return rows.flatMap((row): number[] => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(row);
      if (!match || (uid !== undefined && Number(match[1]) !== uid) || registeredPids.has(Number(match[2]))) return [];
      const heads = commandHead(match[3]);
      const entry = heads.at(-1);
      if (!entry || !(path.basename(entry) === "compaction" || /\/cli\/index\.(?:js|ts)$/.test(entry))) return [];
      const tokens = match[3].match(/"[^"\n]*"|'[^'\n]*'|[^\s]+/g) ?? [];
      return tokens[heads.length] === "gateway" && tokens[heads.length + 1] === "start" ? [Number(match[2])] : [];
    });
  } catch { return "unknown"; }
}

export function findUnregisteredGatewayProcess(registeredPids: ReadonlySet<number>): boolean | "unknown" {
  const matches = listUnregisteredGatewayProcessIds(registeredPids);
  return matches === "unknown" ? "unknown" : matches.length > 0;
}
