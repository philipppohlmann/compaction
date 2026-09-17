import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface CursorDesktopDetectionOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  paths?: readonly string[];
  pathExists?: (candidate: string) => boolean;
}

export interface CursorDesktopDetection {
  detected: boolean;
  source?: "environment" | "application";
  path?: string;
}

const CURSOR_PATH_ENV_KEYS = [
  "VSCODE_GIT_ASKPASS_MAIN",
  "VSCODE_GIT_ASKPASS_NODE",
  "VSCODE_GIT_IPC_HANDLE",
  "VSCODE_IPC_HOOK_CLI"
] as const;

function isCursorBrandedPath(value: string): boolean {
  return /(?:^|[\\/])Cursor\.app(?:[\\/]|$)/i.test(value) ||
    /(?:^|[\\/])cursor(?:-ipc-[^\\/]+)?(?:[\\/]|$)/i.test(value);
}

/** Standard Cursor desktop artifacts for the current platform. Pure and injectable for tests. */
export function cursorDesktopArtifactPaths(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  home: string
): string[] {
  if (platform === "darwin") {
    return ["/Applications/Cursor.app", path.join(home, "Applications", "Cursor.app")];
  }
  if (platform === "win32") {
    return [
      env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "Programs", "cursor", "Cursor.exe") : undefined,
      env.ProgramFiles ? path.join(env.ProgramFiles, "Cursor", "Cursor.exe") : undefined,
      env["ProgramFiles(x86)"] ? path.join(env["ProgramFiles(x86)"]!, "Cursor", "Cursor.exe") : undefined
    ].filter((candidate): candidate is string => candidate !== undefined);
  }
  return [
    "/opt/Cursor/cursor",
    "/usr/share/applications/cursor.desktop",
    path.join(home, ".local", "share", "applications", "cursor.desktop"),
    path.join(home, "Applications", "Cursor.AppImage")
  ];
}

/**
 * Read-only Cursor desktop discovery. Exact Cursor branding is required: VS Code's generic
 * TERM_PROGRAM and paths do not count. Every external input is injectable for hermetic tests.
 */
export function detectCursorDesktop(options: CursorDesktopDetectionOptions = {}): CursorDesktopDetection {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const pathExists = options.pathExists ?? existsSync;

  if ((env.TERM_PROGRAM ?? "").trim().toLowerCase() === "cursor") {
    return { detected: true, source: "environment" };
  }
  for (const key of CURSOR_PATH_ENV_KEYS) {
    const value = env[key];
    if (value && isCursorBrandedPath(value)) {
      return { detected: true, source: "environment", path: value };
    }
  }

  for (const candidate of options.paths ?? cursorDesktopArtifactPaths(platform, env, home)) {
    if (pathExists(candidate)) return { detected: true, source: "application", path: candidate };
  }
  return { detected: false };
}
