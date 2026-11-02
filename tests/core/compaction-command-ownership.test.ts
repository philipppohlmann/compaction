import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { compactionCommand, isCompactionCommand } from "../../src/core/compaction-command.js";
import { managedLauncherOwnership } from "../../src/core/update/launcher-ownership.js";
import {
  installShapingHook,
  installStatusLine,
  installStopHook,
  pinClaudeOwnedCommands,
  uninstallBeforeCallHook,
  uninstallShapingHook,
  uninstallStatusLine,
  uninstallStopHook,
  type ClaudeSettings
} from "../../src/core/claude-code-hooks.js";
import {
  installSubscriptionHooks,
  mergeSubscriptionHooks,
  pinSubscriptionOwnedCommands
} from "../../src/core/subscription-hooks-install.js";
import { uninstallCodexShapingHook, uninstallCursorShapingHook } from "../../src/core/subscription-shaping-hooks.js";
import { uninstallCodexTurnLineHook } from "../../src/core/codex-turn-line-hook.js";
import { codexShapingStateFromHooks } from "../../src/core/codex-hook-trust.js";

// Neither launcher exists on this machine, so both count as stranded (ours) under the IO default.
const LAUNCHER = "/Users/someone/.local/bin/compaction";
const ALL = () => true;
const SPACED = "/Users/some one/.local/bin/compaction";

describe("owned command identity: bare and managed-launcher forms", () => {
  it("writes the launcher form only for a valid launcher, and recognizes both forms", () => {
    expect(compactionCommand("statusline")).toBe("compaction statusline");
    expect(compactionCommand("statusline", LAUNCHER)).toBe(`${LAUNCHER} statusline`);
    expect(compactionCommand("statusline", SPACED)).toBe(`'${SPACED}' statusline`);
    for (const invalid of ["bin/compaction", "/x/bin/compaction-old", "/x/../bin/compaction", "/x/bin/it's/compaction"]) {
      expect(compactionCommand("statusline", invalid)).toBe("compaction statusline");
    }
    for (const owned of ["compaction statusline", `${LAUNCHER} statusline`, `'${SPACED}' statusline`, `  ${LAUNCHER} statusline  `]) {
      expect(isCompactionCommand(owned, "statusline", ALL), owned).toBe(true);
    }
  });

  it("never claims a command that wraps, extends, or merely resembles ours", () => {
    for (const foreign of [
      "echo compaction statusline",
      `echo ${LAUNCHER} statusline`,
      `my-status && ${LAUNCHER} statusline`,
      `${LAUNCHER} statusline; rm -rf /tmp/x`,
      `${LAUNCHER} statusline --extra`,
      `${LAUNCHER}  statusline`,
      "bin/compaction statusline",
      "/x/bin/compaction-old statusline",
      "/x/../bin/compaction statusline",
      "/x/bin/my-wrapper statusline",
      `"${LAUNCHER}" statusline`,
      `'${SPACED} statusline`
    ]) {
      expect(isCompactionCommand(foreign, "statusline", ALL), foreign).toBe(false);
    }
  });
});

const USER_HOOK = { type: "command", command: "echo user-owned" };

function claudeWith(command: (args: string) => string, statusLine = true): ClaudeSettings {
  return {
    theme: "dark",
    hooks: {
      Stop: [{ hooks: [USER_HOOK, { type: "command", command: command("capture claude-code --from-hook") }] }],
      UserPromptSubmit: [
        { hooks: [{ type: "command", command: command("capture claude-code --from-prompt-hook") }] },
        { hooks: [{ type: "command", command: command("capture claude-code --shape-prompt-hook") }] }
      ],
      PreToolUse: [{ hooks: [{ type: "command", command: command("statusline") }] }]
    },
    ...(statusLine ? { statusLine: { type: "command", command: command("statusline"), padding: 0 } } : {})
  };
}

describe("Claude Code disconnect removes ONLY Compaction entries in either form", () => {
  it.each([
    ["bare", (args: string) => `compaction ${args}`],
    ["launcher", (args: string) => `${LAUNCHER} ${args}`]
  ])("%s form", (_label, command) => {
    let settings = claudeWith(command);
    for (const strip of [uninstallStopHook, uninstallBeforeCallHook, uninstallShapingHook]) settings = strip(settings).settings;
    const statusLine = uninstallStatusLine(settings);
    expect(statusLine.removed).toBe(true);
    // Only the user's Stop hook and the foreign PreToolUse entry (an event Compaction never writes) survive.
    expect(statusLine.settings).toEqual({
      theme: "dark",
      hooks: {
        Stop: [{ hooks: [USER_HOOK] }],
        PreToolUse: [{ hooks: [{ type: "command", command: command("statusline") }] }]
      }
    });
  });

  it("leaves a user status line that wraps the launcher form untouched", () => {
    const settings: ClaudeSettings = { statusLine: { type: "command", command: `my-status && ${LAUNCHER} statusline` } };
    expect(uninstallStatusLine(settings)).toMatchObject({ changed: false, removed: false });
    expect(installStatusLine(settings, LAUNCHER).status).toBe("user-owned");
  });
});

describe("Claude Code launcher pinning", () => {
  it("rewrites every owned command to the launcher form and nothing else", () => {
    const bare = claudeWith((args) => `compaction ${args}`);
    const pinned = pinClaudeOwnedCommands(bare, LAUNCHER, ALL);
    expect(pinned.rewritten).toBe(4);
    expect(pinned.config).toEqual({
      ...claudeWith((args) => `${LAUNCHER} ${args}`),
      // PreToolUse is not an event Compaction owns, so even a matching command there is left alone.
      hooks: { ...claudeWith((args) => `${LAUNCHER} ${args}`).hooks, PreToolUse: bare.hooks!.PreToolUse }
    });
    expect(bare.hooks!.Stop![0]!.hooks![1]!.command).toBe("compaction capture claude-code --from-hook");
    expect(pinClaudeOwnedCommands(pinned.config, LAUNCHER, ALL)).toEqual({ config: pinned.config, rewritten: 0 });
    expect(pinClaudeOwnedCommands(bare, "relative/compaction", ALL)).toEqual({ config: bare, rewritten: 0 });
  });

  it("re-pins entries naming a stranded launcher, never one the owner check refuses", () => {
    const moved = claudeWith((args) => `/old/prefix/bin/compaction ${args}`, false);
    moved.statusLine = { type: "command", command: "my-own-line" };
    const pinned = pinClaudeOwnedCommands(moved, LAUNCHER, (launcher) => launcher === "/old/prefix/bin/compaction");
    expect(pinned.rewritten).toBe(3);
    expect(pinned.config.statusLine).toEqual({ type: "command", command: "my-own-line" });
    expect(pinClaudeOwnedCommands(moved, LAUNCHER, () => false)).toEqual({ config: moved, rewritten: 0 });
  });

  it("install writes the launcher form and treats an existing bare entry as already present", () => {
    expect(installStopHook({}, LAUNCHER).settings.hooks!.Stop![0]!.hooks![0]!.command).toBe(`${LAUNCHER} capture claude-code --from-hook`);
    expect(installShapingHook({}, LAUNCHER).settings.hooks!.UserPromptSubmit![0]!.hooks![0]!.command)
      .toBe(`${LAUNCHER} capture claude-code --shape-prompt-hook`);
    expect(installStatusLine({}, LAUNCHER).settings.statusLine).toEqual({ type: "command", command: `${LAUNCHER} statusline` });
    expect(installStopHook(claudeWith((args) => `compaction ${args}`), LAUNCHER)).toMatchObject({ changed: false, alreadyPresent: true });
  });
});

describe("Codex and Cursor: pinning, disconnect, and trust identity", () => {
  const userStop = { hooks: [{ type: "command", command: "echo codex-user" }] };

  it("pins Codex shaping + per-turn line, and disconnect removes both forms but not the user's hook", () => {
    const bare = mergeSubscriptionHooks("codex", { hooks: { Stop: [userStop] } }).config as Record<string, any>;
    const pinned = pinSubscriptionOwnedCommands("codex", bare, LAUNCHER, ALL);
    expect(pinned.rewritten).toBe(2);
    const hooks = (pinned.config as Record<string, any>).hooks;
    expect(hooks.UserPromptSubmit[0].hooks[0]).toMatchObject({ command: `${LAUNCHER} hooks shape codex`, timeout: 10 });
    expect(hooks.Stop[1].hooks[0]).toMatchObject({ command: `${LAUNCHER} hooks line codex`, timeout: 15 });
    expect(hooks.Stop[0]).toEqual(userStop);
    expect(mergeSubscriptionHooks("codex", pinned.config).changed).toBe(false);

    for (const config of [bare, pinned.config as Record<string, any>]) {
      const line = uninstallCodexTurnLineHook(uninstallCodexShapingHook(config).config);
      expect(line.config).toEqual({ hooks: { Stop: [userStop] } });
    }
    // Codex's own trust report still finds the pinned hook as ours.
    expect(codexShapingStateFromHooks([{ key: "k", command: `${LAUNCHER} hooks shape codex`, eventName: "userPromptSubmit",
      enabled: true, trustStatus: "modified" }]).state).toBe("approval-required");
  });

  it("pins Cursor's flat sessionStart entry and disconnect removes the pinned form only", () => {
    const bare = mergeSubscriptionHooks("cursor", { hooks: { sessionStart: [{ command: "echo cursor-user" }] } }).config;
    const pinned = pinSubscriptionOwnedCommands("cursor", bare, LAUNCHER, ALL);
    expect(pinned.rewritten).toBe(1);
    expect((pinned.config as Record<string, any>).hooks.sessionStart).toEqual([
      { command: "echo cursor-user" }, { command: `${LAUNCHER} hooks shape cursor` }
    ]);
    expect(uninstallCursorShapingHook(pinned.config).config).toEqual({ version: 1, hooks: { sessionStart: [{ command: "echo cursor-user" }] } });
  });
});

describe("a present `compaction` outside this installation is the user's own", () => {
  const dirs: string[] = [];
  afterEach(() => { vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  function presentLauncher(): { root: string; foreign: string; managed: string } {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "compaction-foreign-launcher-"))); dirs.push(root);
    const foreign = path.join(root, "opt/tools/bin/compaction");
    const managed = path.join(root, "home/.local/bin/compaction");
    for (const file of [foreign, managed]) {
      mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, "#!/bin/sh\n"); chmodSync(file, 0o755);
    }
    // The managed receipt names `managed`; `foreign` is a present binary the user points at themselves.
    const config = path.join(root, "config");
    mkdirSync(path.join(config, "managed"), { recursive: true });
    writeFileSync(path.join(config, "managed/install.json"), JSON.stringify({ launcherPath: managed }));
    vi.stubEnv("COMPACTION_HOME", config);
    return { root, foreign, managed };
  }

  it("is not rewritten by pinning, stays user-owned on install, and survives disconnect", () => {
    const { foreign, managed } = presentLauncher();
    const owns = managedLauncherOwnership();
    const settings: ClaudeSettings = {
      statusLine: { type: "command", command: `${foreign} statusline` },
      hooks: { Stop: [{ hooks: [{ type: "command", command: `${foreign} capture claude-code --from-hook` }] }] }
    };
    expect(pinClaudeOwnedCommands(settings, managed, owns)).toEqual({ config: settings, rewritten: 0 });
    expect(installStatusLine(settings, managed)).toMatchObject({ changed: false, status: "user-owned" });
    expect(uninstallStatusLine(settings)).toMatchObject({ changed: false, removed: false });
    expect(uninstallStopHook(settings)).toMatchObject({ changed: false, removedCount: 0 });
    // The foreign Stop hook is not ours, so install adds Compaction's own beside it.
    expect(installStopHook(settings, managed).settings.hooks!.Stop).toEqual([
      ...settings.hooks!.Stop!, { hooks: [{ type: "command", command: `${managed} capture claude-code --from-hook` }] }
    ]);
    const codex = { hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: `${foreign} hooks shape codex` }] }] } };
    expect(pinSubscriptionOwnedCommands("codex", codex, managed, owns).rewritten).toBe(0);
    expect(uninstallCodexShapingHook(codex).removedCount).toBe(0);
  });

  it("the receipt launcher and a stranded launcher are ours: recognized and removed on disconnect", () => {
    const { root, managed } = presentLauncher();
    const stranded = path.join(root, "removed-prefix/bin/compaction");
    for (const launcher of [managed, stranded]) {
      const settings: ClaudeSettings = { statusLine: { type: "command", command: `${launcher} statusline` } };
      expect(installStatusLine(settings, managed).status, launcher).toBe("already-present");
      expect(uninstallStatusLine(settings).removed, launcher).toBe(true);
    }
  });
});

describe("managed connect re-pins existing Codex entries and reports it", () => {
  it("installSubscriptionHooks with a launcher rewrites bare Codex entries and counts them", async () => {
    const home = realpathSync(mkdtempSync(path.join(tmpdir(), "compaction-codex-repin-")));
    try {
      const file = path.join(home, ".codex/hooks.json");
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(mergeSubscriptionHooks("codex", {}).config));
      const outcome = await installSubscriptionHooks("codex", { home, launcher: LAUNCHER });
      expect(outcome).toMatchObject({ status: "installed", pinned: 2 });
      expect(outcome.entries.map((entry) => entry.command)).toEqual([`${LAUNCHER} hooks shape codex`, `${LAUNCHER} hooks line codex`]);
      expect(await installSubscriptionHooks("codex", { home, launcher: LAUNCHER })).toMatchObject({ status: "already-present" });
      expect((await installSubscriptionHooks("codex", { home, launcher: LAUNCHER })).pinned).toBeUndefined();
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
