import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { scanSessionMetadata } from "./claude-code-adapter.js";
import type { ClaudeCodeSessionMetadata } from "./claude-code-adapter.js";

/**
 * Local, read-only discovery of available Claude Code sessions.
 *
 * Scans the standard Claude Code projects layout
 * (`~/.claude/projects/<slug>/<session-id>.jsonl`) and returns metadata-only
 * records for each discoverable session, reusing the existing adapter parser
 * (`scanSessionMetadata`) so counts match what `capture claude-code --session`
 * would produce. This module performs NO network calls, NO upload, and NO
 * provider-API access, it only reads the local filesystem under the projects
 * root (default `~/.claude/projects`, overridable for testability).
 *
 * Privacy: discovery surfaces metadata ONLY. It never reads or returns session
 * message content into the listing. Session files themselves may contain local
 * file content (consistent with the capture privacy warning).
 */

export const DISCOVERY_PRIVACY_NOTE =
  "Discovery is local and read-only: it scans your local Claude Code projects directory only " +
  "(no network calls, no upload). It surfaces session metadata only - never session content. " +
  "Note: the underlying session files may contain local file content; review captured artifacts " +
  "before sharing.";

/**
 * Resolve the default Claude Code projects root (`~/.claude/projects`).
 *
 * Takes the environment so a caller running against an INJECTED env (in-process `runStatus({ env })`)
 * resolves the home that env names rather than the ambient one. Same `env.HOME` -> `homedir()` fallback
 * the shim resolver uses, and defaulting to `process.env` keeps every existing caller unchanged.
 */
export function defaultProjectsDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = (env.HOME ?? "").trim();
  return join(fromEnv !== "" ? fromEnv : homedir(), ".claude", "projects");
}

export interface DiscoverSessionsOptions {
  /** Override the projects root directory (default: ~/.claude/projects). Read-only. */
  projectsDir?: string;
}

export interface DiscoverSessionsResult {
  /** The projects root that was scanned. */
  projectsDir: string;
  /** Whether the projects root exists. */
  projectsDirExists: boolean;
  /** Discovered sessions, sorted newest-first by lastTimestamp (then path). */
  sessions: ClaudeCodeSessionMetadata[];
}

function isJsonlFile(name: string): boolean {
  return name.endsWith(".jsonl");
}

/**
 * Discover all Claude Code sessions under the projects root.
 *
 * Layout scanned (read-only): <projectsDir>/<slug>/<session-id>.jsonl
 * Each `<slug>` directory is one project; each top-level `.jsonl` within it is
 * one session. (The `<session-id>/subagents/` sub-directory is NOT treated as a
 * session; its file count is reported as the session's subagent count.)
 */
export async function discoverClaudeCodeSessions(
  options: DiscoverSessionsOptions = {}
): Promise<DiscoverSessionsResult> {
  const projectsDir = options.projectsDir ?? defaultProjectsDir();

  if (!existsSync(projectsDir)) {
    return { projectsDir, projectsDirExists: false, sessions: [] };
  }

  let slugDirs: string[];
  try {
    slugDirs = readdirSync(projectsDir).filter((name) => {
      const full = join(projectsDir, name);
      try {
        return statSync(full).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return { projectsDir, projectsDirExists: true, sessions: [] };
  }

  const sessions: ClaudeCodeSessionMetadata[] = [];

  for (const slug of slugDirs) {
    const slugPath = join(projectsDir, slug);
    let sessionFiles: string[];
    try {
      sessionFiles = readdirSync(slugPath).filter((name) => {
        if (!isJsonlFile(name)) return false;
        const full = join(slugPath, name);
        try {
          return statSync(full).isFile();
        } catch {
          return false;
        }
      });
    } catch {
      continue;
    }

    for (const fileName of sessionFiles) {
      const sessionPath = join(slugPath, fileName);
      try {
        const metadata = await scanSessionMetadata(sessionPath, slug);
        sessions.push(metadata);
      } catch {
        // Skip unreadable / malformed session files; discovery stays resilient.
      }
    }
  }

  // Sort newest-first by lastTimestamp, falling back to path for determinism.
  sessions.sort((a, b) => {
    const ta = a.lastTimestamp ?? "";
    const tb = b.lastTimestamp ?? "";
    if (ta !== tb) return ta < tb ? 1 : -1;
    return a.sessionPath < b.sessionPath ? -1 : a.sessionPath > b.sessionPath ? 1 : 0;
  });

  return { projectsDir, projectsDirExists: true, sessions };
}
