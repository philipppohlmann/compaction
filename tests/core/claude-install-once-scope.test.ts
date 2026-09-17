import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DEFAULT_CLAUDE_SETTINGS_SCOPE,
  claudeProjectSettingsPaths,
  claudeSettingsHome,
  claudeSettingsPathForScope,
  claudeSettingsReadPaths,
  connectClaudeCodeHook,
  connectClaudeCodeShapingHook,
  connectClaudeCodeStatusLine,
  disconnectClaudeCodeStatusLine,
  isStopHookInstalled,
  migrateProjectScopeClaudeSettings
} from "../../src/core/claude-code-connect.js";
import {
  CLAUDE_CODE_HOOK_COMMAND,
  CLAUDE_CODE_SHAPING_HOOK_COMMAND,
  CLAUDE_CODE_STATUS_LINE_COMMAND
} from "../../src/core/claude-code-hooks.js";

/**
 * INSTALL-ONCE contract. Compaction connects a detected tool ONCE per machine-user: a different
 * repository, a fresh worktree, an arbitrary temp directory or a new shell must still be connected.
 * These tests exist because Claude Code's wiring defaulted to `process.cwd()/.claude/settings.json`,
 * so every new directory silently had no integration.
 */
let home: string, projectA: string, projectB: string;
const env = (): NodeJS.ProcessEnv => ({ HOME: home });

beforeEach(() => {
  const root = mkdtempSync(path.join(tmpdir(), "install-once-"));
  home = path.join(root, "home");
  projectA = path.join(root, "project-a");
  projectB = path.join(root, "project-b");
  for (const dir of [home, projectA, projectB]) mkdirSync(dir, { recursive: true });
});
afterEach(() => {
  rmSync(path.dirname(home), { recursive: true, force: true });
});

// cwd is passed EXPLICITLY: a resolver bug (or a falsification patch) that falls back to
// `process.cwd()` must land in the fixture, never in the real repository checkout.
const userSettings = (): string => claudeSettingsPathForScope("user", { cwd: projectA, env: env() });
const readJson = (file: string): any => JSON.parse(readFileSync(file, "utf8"));
const hookCommands = (settings: any, event: string): string[] =>
  (settings.hooks?.[event] ?? []).flatMap((g: any) => (g.hooks ?? []).map((h: any) => h.command));

describe("A0. the DEFAULT scope itself is user/global", () => {
  it("resolves to the user file when no scope is given at all", () => {
    // Pins the DEFAULT, not just an explicitly-requested scope. Every other test in this file names
    // its scope, so without this case a regression that flipped the default back to project-local
    // would leave the whole suite green.
    expect(DEFAULT_CLAUDE_SETTINGS_SCOPE).toBe("user");
    expect(claudeSettingsPathForScope(undefined, { cwd: projectA, env: env() }))
      .toBe(path.join(home, ".claude", "settings.json"));
    expect(claudeSettingsPathForScope(undefined, { cwd: projectA, env: env() }))
      .not.toBe(path.join(projectA, ".claude", "settings.json"));
  });

  it("prefers env.HOME over the ambient home, so a fake HOME is honoured", () => {
    expect(claudeSettingsHome({ HOME: "/tmp/fake-home" } as NodeJS.ProcessEnv)).toBe("/tmp/fake-home");
  });
});

describe("A. global Claude install is machine-user persistent", () => {
  it("writes the connect into USER settings, not the project it was run from", async () => {
    const target = userSettings();
    await connectClaudeCodeHook({ settingsPath: target });
    await connectClaudeCodeStatusLine({ settingsPath: target });

    expect(target).toBe(path.join(home, ".claude", "settings.json"));
    const settings = readJson(target);
    expect(hookCommands(settings, "Stop")).toContain(CLAUDE_CODE_HOOK_COMMAND);
    expect(settings.statusLine.command).toBe(CLAUDE_CODE_STATUS_LINE_COMMAND);
    // The directory the connect ran from must stay clean — that is the whole point.
    expect(existsSync(path.join(projectA, ".claude", "settings.json"))).toBe(false);
  });

  it("is visible from an unrelated project with no local settings", async () => {
    await connectClaudeCodeHook({ settingsPath: userSettings() });
    // Readiness resolves the same files for project B as for project A.
    const readPaths = claudeSettingsReadPaths(projectB, env());
    expect(readPaths).toContain(userSettings());
    const found = await Promise.all(readPaths.map((p) => isStopHookInstalled(p)));
    expect(found.some(Boolean)).toBe(true);
  });

  it("resolves the same user file from any cwd", () => {
    expect(claudeSettingsPathForScope("user", { cwd: projectA, env: env() }))
      .toBe(claudeSettingsPathForScope("user", { cwd: projectB, env: env() }));
  });
});

describe("B. uninstall removes only Compaction-owned entries", () => {
  it("leaves foreign hooks and a user's own status line untouched", async () => {
    const target = userSettings();
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify({
      model: "opus", theme: "dark",
      statusLine: { type: "command", command: "my-own-status" },
      hooks: { Stop: [{ hooks: [{ type: "command", command: "someone-elses-tool --run" }] }] }
    }), "utf8");

    await connectClaudeCodeHook({ settingsPath: target });
    const removed = await disconnectClaudeCodeStatusLine(target);

    const after = readJson(target);
    expect(removed.removed).toBe(false); // never ours to remove — the user owns that slot
    expect(after.statusLine.command).toBe("my-own-status");
    expect(hookCommands(after, "Stop")).toContain("someone-elses-tool --run");
    expect(after.model).toBe("opus");
    expect(after.theme).toBe("dark");
  });
});

describe("C. explicit project scope stays project-scoped", () => {
  it("writes only to the project when project scope is asked for", async () => {
    const target = claudeSettingsPathForScope("project", { cwd: projectA, env: env() });
    await connectClaudeCodeHook({ settingsPath: target });
    expect(target).toBe(path.join(projectA, ".claude", "settings.json"));
    expect(existsSync(userSettings())).toBe(false);
  });

  it("keeps project-local settings.local.json distinct from project settings.json", () => {
    const local = claudeSettingsPathForScope("project-local", { cwd: projectA, env: env() });
    const project = claudeSettingsPathForScope("project", { cwd: projectA, env: env() });
    expect(local).toBe(path.join(projectA, ".claude", "settings.local.json"));
    expect(local).not.toBe(project);
    expect(claudeProjectSettingsPaths(projectA, env())).toEqual([project, local]);
  });
});

describe("D. migration leaves exactly ONE effective integration", () => {
  it("strips Compaction's project-local entries so hooks cannot fire twice", async () => {
    // An OLD project-local install, plus a foreign hook that must survive.
    const projectFile = claudeSettingsPathForScope("project", { cwd: projectA, env: env() });
    mkdirSync(path.dirname(projectFile), { recursive: true });
    writeFileSync(projectFile, JSON.stringify({
      statusLine: { type: "command", command: CLAUDE_CODE_STATUS_LINE_COMMAND },
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: CLAUDE_CODE_HOOK_COMMAND }] }],
        UserPromptSubmit: [
          { hooks: [{ type: "command", command: CLAUDE_CODE_SHAPING_HOOK_COMMAND }] },
          { hooks: [{ type: "command", command: "foreign-linter --check" }] }
        ]
      }
    }), "utf8");

    // The NEW global install.
    await connectClaudeCodeHook({ settingsPath: userSettings() });
    await connectClaudeCodeShapingHook({ settingsPath: userSettings() });

    const migrated = await migrateProjectScopeClaudeSettings({ cwd: projectA, env: env() });
    expect(migrated.cleaned).toContain(projectFile);
    expect(migrated.removedHooks).toBeGreaterThan(0);

    // Claude Code merges hooks ADDITIVELY, so the project copy must be gone or both would run.
    const project = readJson(projectFile);
    expect(hookCommands(project, "Stop")).not.toContain(CLAUDE_CODE_HOOK_COMMAND);
    expect(hookCommands(project, "UserPromptSubmit")).not.toContain(CLAUDE_CODE_SHAPING_HOOK_COMMAND);
    expect(project.statusLine).toBeUndefined();
    // The foreign hook is not ours to remove.
    expect(hookCommands(project, "UserPromptSubmit")).toContain("foreign-linter --check");

    // Exactly one effective Compaction Stop hook across every file Claude Code reads.
    const effective = await Promise.all(
      claudeSettingsReadPaths(projectA, env()).map(async (p) => (await isStopHookInstalled(p)) ? 1 : 0)
    );
    expect(effective.reduce((a, b) => a + b, 0)).toBe(1);
  });

  it("does not rewrite a project that never had Compaction entries", async () => {
    const projectFile = claudeSettingsPathForScope("project", { cwd: projectB, env: env() });
    mkdirSync(path.dirname(projectFile), { recursive: true });
    writeFileSync(projectFile, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "other" }] }] } }), "utf8");
    const migrated = await migrateProjectScopeClaudeSettings({ cwd: projectB, env: env() });
    expect(migrated.cleaned).toEqual([]);
    expect(hookCommands(readJson(projectFile), "Stop")).toEqual(["other"]);
  });
});

describe("E. migration through the REAL CLI connect path", () => {
  it("cleans an old project-local install and reports it, end to end", async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    const CLI = path.join(process.cwd(), "dist", "cli", "index.js");
    const NODE_DIR = path.dirname(process.execPath);

    // A real claude binary stub, so connect does not refuse before writing.
    const bin = path.join(home, "bin");
    mkdirSync(bin, { recursive: true });
    const stub = path.join(bin, "claude");
    writeFileSync(stub, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    // The OLD project-local wiring, plus a foreign hook that must survive.
    const projectFile = claudeSettingsPathForScope("project", { cwd: projectA, env: env() });
    mkdirSync(path.dirname(projectFile), { recursive: true });
    writeFileSync(projectFile, JSON.stringify({
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: CLAUDE_CODE_HOOK_COMMAND }] }],
        UserPromptSubmit: [{ hooks: [{ type: "command", command: "foreign-linter --check" }] }]
      }
    }), "utf8");

    const { stdout } = await run("node", [CLI, "init", "--connect", "claude-code", "--static",
      "--projects-dir", path.join(home, "none")], {
      cwd: projectA,
      env: {
        HOME: home,
        COMPACTION_HOME: path.join(home, ".compaction"),
        COMPACTION_CONFIG_DIR: path.join(home, ".compaction"),
        PATH: `${bin}${path.delimiter}${NODE_DIR}${path.delimiter}/usr/bin${path.delimiter}/bin`,
        NO_COLOR: "1"
      }
    });

    // The CLI says it migrated, and says it in the global-scope voice.
    expect(stdout).toContain("Migrated");
    expect(stdout).not.toContain("this project:");

    // Exactly ONE effective Compaction Stop hook across every file Claude Code reads — the whole
    // point, since Claude merges hooks additively and two would double-capture and double-shape.
    const effective = await Promise.all(
      claudeSettingsReadPaths(projectA, env()).map(async (p) => (await isStopHookInstalled(p)) ? 1 : 0)
    );
    expect(effective.reduce((a, b) => a + b, 0)).toBe(1);
    expect(await isStopHookInstalled(userSettings())).toBe(true);
    const installed = readJson(userSettings());
    expect(installed.statusLine).toEqual({ type: "command", command: CLAUDE_CODE_STATUS_LINE_COMMAND });
    expect(hookCommands(installed, "UserPromptSubmit")).toContain(CLAUDE_CODE_SHAPING_HOOK_COMMAND);

    // The foreign hook is not ours to remove.
    expect(hookCommands(readJson(projectFile), "UserPromptSubmit")).toContain("foreign-linter --check");
  }, 60_000);
  it("migrates on the ALREADY-CONNECTED self-heal path, not only on first enable", async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    const CLI = path.join(process.cwd(), "dist", "cli", "index.js");
    const NODE_DIR = path.dirname(process.execPath);
    const bin = path.join(home, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(path.join(bin, "claude"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const childEnv = {
      HOME: home,
      COMPACTION_HOME: path.join(home, ".compaction"),
      COMPACTION_CONFIG_DIR: path.join(home, ".compaction"),
      // The SHIM DIR MUST LEAD on PATH. Without it `verifyShimActive("claude-code").active` is false,
      // Claude is not counted "ready", and the second connect takes the ENABLE branch — so the test
      // would pass without ever exercising the already-connected self-heal path this case exists for.
      PATH: `${path.join(home, ".compaction", "shims")}${path.delimiter}${bin}${path.delimiter}${NODE_DIR}${path.delimiter}/usr/bin${path.delimiter}/bin`,
      NO_COLOR: "1"
    };
    const connect = () => run("node", [CLI, "init", "--connect", "claude-code", "--static",
      "--projects-dir", path.join(home, "none")], { cwd: projectB, env: childEnv });

    await connect(); // now globally connected

    // An OLD project-local install appears afterwards (a repo that still carries the pre-fix wiring).
    const projectFile = claudeSettingsPathForScope("project", { cwd: projectB, env: env() });
    mkdirSync(path.dirname(projectFile), { recursive: true });
    writeFileSync(projectFile, JSON.stringify({
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: CLAUDE_CODE_HOOK_COMMAND }] }],
        UserPromptSubmit: [{ hooks: [{ type: "command", command: "foreign-linter --check" }] }]
      }
    }), "utf8");

    // The second connect takes the ALREADY-READY self-heal branch, which originally did not migrate —
    // leaving Compaction's hooks in BOTH scopes permanently (additive merge ⇒ double capture/shaping).
    const { stdout } = await connect();
    expect(stdout).toContain("Migrated");

    const effective = await Promise.all(
      claudeSettingsReadPaths(projectB, env()).map(async (p) => (await isStopHookInstalled(p)) ? 1 : 0)
    );
    expect(effective.reduce((a, b) => a + b, 0)).toBe(1);
    expect(hookCommands(readJson(projectFile), "UserPromptSubmit")).toContain("foreign-linter --check");
  }, 90_000);
});
