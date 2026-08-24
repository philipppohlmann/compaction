import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  areSubscriptionHooksInstalled,
  hasAllSubscriptionHooks,
  installSubscriptionHooks,
  mergeSubscriptionHooks,
  subscriptionHookConfigPath,
  subscriptionHookEntries,
  uninstallSubscriptionHooks
} from "../../src/core/subscription-hooks-install.js";

/**
 * THE ONE install path for the Codex/Cursor native hooks.
 *
 * `compaction hooks install --tool …` and `compaction init`'s enable step both route through this
 * module, which is the point: they used to be able to diverge, and did — only the `hooks` command knew
 * a connected Codex needs BOTH the shaping hook and the `Stop` per-turn line, so a workflow enabled
 * through onboarding got a PATH shim and nothing that shapes.
 *
 * What is pinned here is the POSTURE every caller inherits: merge-not-replace, idempotent, backed up,
 * verified by re-read, and never-throwing (a failure comes back as a status so the caller can stay
 * fail-open and not un-connect what already succeeded).
 */
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sub-hooks-install-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const codexFile = (): string => join(home, ".codex", "hooks.json");
const cursorFile = (): string => join(home, ".cursor", "hooks.json");

describe("the entry list is the SAME list that gets written (one source of truth)", () => {
  it("Codex declares both entries; Cursor declares the one SESSION-LEVEL entry", () => {
    const codex = subscriptionHookEntries("codex");
    expect(codex.map((e) => e.event)).toEqual(["UserPromptSubmit", "Stop"]);
    expect(codex.map((e) => e.command)).toEqual(["compaction hooks shape codex", "compaction hooks line codex"]);
    // The shaping entry names the model-visible effect — that is what makes the review screen consent.
    expect(codex[0].effect).toContain("what the model sees");

    const cursor = subscriptionHookEntries("cursor");
    expect(cursor.map((e) => e.event)).toEqual(["sessionStart"]);
    expect(cursor[0].effect).toContain("per session");
    expect(cursor[0].effect).toContain("not per turn");
  });

  it("every declared entry actually appears in the merged config", async () => {
    await installSubscriptionHooks("codex", { home });
    const raw = readFileSync(codexFile(), "utf8");
    for (const entry of subscriptionHookEntries("codex")) expect(raw).toContain(entry.command);
    await installSubscriptionHooks("cursor", { home });
    for (const entry of subscriptionHookEntries("cursor")) expect(readFileSync(cursorFile(), "utf8")).toContain(entry.command);
  });
});

describe("installSubscriptionHooks", () => {
  it("Codex: writes BOTH hooks in ONE write (a connected Codex is never half-wired)", async () => {
    const result = await installSubscriptionHooks("codex", { home });
    expect(result.status).toBe("installed");
    expect(result.file).toBe(codexFile());
    const config = JSON.parse(readFileSync(codexFile(), "utf8"));
    expect(hasAllSubscriptionHooks("codex", config)).toBe(true);
    expect(config.hooks.UserPromptSubmit[0].hooks[0].timeout).toBe(10);
    expect(config.hooks.Stop[0].hooks[0].timeout).toBe(5);
  });

  it("Cursor: writes the FLAT sessionStart entry plus the required schema version", async () => {
    const result = await installSubscriptionHooks("cursor", { home });
    expect(result.status).toBe("installed");
    const config = JSON.parse(readFileSync(cursorFile(), "utf8"));
    expect(config.version).toBe(1);
    expect(config.hooks.sessionStart[0].command).toBe("compaction hooks shape cursor");
    expect(config.hooks.sessionStart[0].hooks).toBeUndefined();
  });

  it("is idempotent: a second install reports already-present and rewrites nothing", async () => {
    await installSubscriptionHooks("codex", { home });
    const before = readFileSync(codexFile(), "utf8");
    const again = await installSubscriptionHooks("codex", { home });
    expect(again.status).toBe("already-present");
    expect(readFileSync(codexFile(), "utf8")).toBe(before);
    // Idempotent means no gratuitous backup either.
    expect(existsSync(`${codexFile()}.compaction.bak`)).toBe(false);
  });

  it("MERGES and BACKS UP: a foreign hook survives and the previous file is preserved", async () => {
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(
      codexFile(),
      JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "other --x" }] }] }, keepMe: 7 }),
      "utf8"
    );
    const result = await installSubscriptionHooks("codex", { home });
    expect(result.status).toBe("installed");
    expect(result.backupPath).toBe(`${codexFile()}.compaction.bak`);
    const config = JSON.parse(readFileSync(codexFile(), "utf8"));
    expect(config.keepMe).toBe(7);
    const commands = config.hooks.UserPromptSubmit.flatMap((g: { hooks: { command: string }[] }) => g.hooks.map((h) => h.command));
    expect(commands).toContain("other --x");
    expect(commands).toContain("compaction hooks shape codex");
    expect(JSON.parse(readFileSync(`${codexFile()}.compaction.bak`, "utf8")).keepMe).toBe(7);
  });

  it("--dry-run writes nothing and reports what it WOULD write", async () => {
    const result = await installSubscriptionHooks("codex", { home, dryRun: true });
    expect(result.status).toBe("dry-run");
    expect(existsSync(codexFile())).toBe(false);
    expect(hasAllSubscriptionHooks("codex", result.wouldWrite as Record<string, never>)).toBe(true);
  });

  it("REFUSES a malformed config rather than clobbering it, and returns the reason (never throws)", async () => {
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(codexFile(), JSON.stringify({ hooks: "not-an-object" }), "utf8");
    const result = await installSubscriptionHooks("codex", { home });
    expect(result.status).toBe("error");
    expect(result.error).toContain("malformed");
    // The user's file is untouched.
    expect(JSON.parse(readFileSync(codexFile(), "utf8")).hooks).toBe("not-an-object");
  });

  /**
   * DATA LOSS REGRESSION. `readConfig` used to answer EVERY read failure with `existed: false` — and
   * `existed` is exactly what decides whether the install takes a backup. A hand-written config the
   * JSON parser rejects (a `//` comment, a trailing comma) was therefore reported as ABSENT, skipped
   * the backup, and was OVERWRITTEN with Compaction's entries while the CLI printed a green
   * "Output shaping: on". The user's own hooks were destroyed with no copy anywhere on disk.
   *
   * Byte-equality is the assertion, not "our hook is absent": a partially-rewritten file would pass
   * the weaker check.
   */
  it("NEVER overwrites a config it cannot parse - the file is BYTE-UNCHANGED and no backup is needed", async () => {
    mkdirSync(join(home, ".codex"), { recursive: true });
    const handWritten = [
      "{",
      '  // my own hooks - hand written, JSON5-ish',
      '  "hooks": { "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "my-own-tool --run" }] }] },',
      "}",
      ""
    ].join("\n");
    writeFileSync(codexFile(), handWritten, "utf8");

    const result = await installSubscriptionHooks("codex", { home });
    expect(result.status).toBe("error");
    expect(result.error).toContain("not valid JSON");
    expect(readFileSync(codexFile(), "utf8"), "the user's config was modified").toBe(handWritten);
    // No silent `.compaction.bak` either: nothing was written, so nothing needed backing up.
    expect(existsSync(`${codexFile()}.compaction.bak`)).toBe(false);
  });

  it("NEVER overwrites a config whose top level is not an object (BYTE-UNCHANGED)", async () => {
    mkdirSync(join(home, ".cursor"), { recursive: true });
    const arrayConfig = '["not", "a", "config"]\n';
    writeFileSync(cursorFile(), arrayConfig, "utf8");
    const result = await installSubscriptionHooks("cursor", { home });
    expect(result.status).toBe("error");
    expect(result.error).toContain("not a JSON object");
    expect(readFileSync(cursorFile(), "utf8")).toBe(arrayConfig);
  });

  it("an EMPTY file is a fresh start (not a refusal), and is still backed up before the write", async () => {
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(codexFile(), "   \n", "utf8");
    const result = await installSubscriptionHooks("codex", { home });
    expect(result.status).toBe("installed");
    expect(result.backupPath).toBe(`${codexFile()}.compaction.bak`);
    expect(hasAllSubscriptionHooks("codex", JSON.parse(readFileSync(codexFile(), "utf8")))).toBe(true);
  });

  it("a MISSING file is the only case treated as absent (no backup, clean create)", async () => {
    const result = await installSubscriptionHooks("codex", { home });
    expect(result.status).toBe("installed");
    expect(result.existed).toBe(false);
    expect(result.backupPath).toBeUndefined();
  });

  it("returns an error status (never throws) when the write itself cannot happen", async () => {
    const readOnlyHome = mkdtempSync(join(tmpdir(), "sub-hooks-ro-"));
    try {
      chmodSync(readOnlyHome, 0o500);
      const result = await installSubscriptionHooks("cursor", { home: readOnlyHome });
      // Either the mkdir or the write fails; the CONTRACT is that it comes back as a status.
      expect(["error", "verify-failed"]).toContain(result.status);
    } finally {
      chmodSync(readOnlyHome, 0o700);
      rmSync(readOnlyHome, { recursive: true, force: true });
    }
  });
});

describe("path resolution is shared, so install and uninstall can never target different files", () => {
  it("resolves the user-level configs, the repo-local Codex config, and an explicit override", () => {
    expect(subscriptionHookConfigPath("codex", { home })).toBe(codexFile());
    expect(subscriptionHookConfigPath("cursor", { home })).toBe(cursorFile());
    expect(subscriptionHookConfigPath("codex", { local: true, cwd: "/work" })).toBe("/work/.codex/hooks.json");
    expect(subscriptionHookConfigPath("cursor", { file: "/explicit.json", home })).toBe("/explicit.json");
  });
});

/**
 * DISCONNECT HAS TO UNDO WHAT CONNECT DID. `init --disconnect 2|3` removed the PATH shim and printed
 * "disconnected" while the shaping hook it had installed kept firing on every turn.
 */
describe("uninstallSubscriptionHooks", () => {
  it("removes ONLY our entries (both of Codex's) and preserves a foreign hook", async () => {
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(
      codexFile(),
      JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "other --x" }] }] }, keepMe: 7 }),
      "utf8"
    );
    await installSubscriptionHooks("codex", { home });
    expect(await areSubscriptionHooksInstalled("codex", { home })).toBe(true);

    const removal = await uninstallSubscriptionHooks("codex", { home });
    expect(removal.status).toBe("removed");
    expect(removal.removedCount).toBe(2); // the shaping hook AND the Stop per-turn line
    const config = JSON.parse(readFileSync(codexFile(), "utf8"));
    expect(config.keepMe).toBe(7);
    expect(JSON.stringify(config)).toContain("other --x");
    expect(JSON.stringify(config)).not.toContain("compaction hooks");
    expect(await areSubscriptionHooksInstalled("codex", { home })).toBe(false);
  });

  it("removes the Cursor sessionStart entry", async () => {
    await installSubscriptionHooks("cursor", { home });
    const removal = await uninstallSubscriptionHooks("cursor", { home });
    expect(removal.status).toBe("removed");
    expect(removal.removedCount).toBe(1);
    expect(await areSubscriptionHooksInstalled("cursor", { home })).toBe(false);
  });

  it("reports honestly when there is nothing of ours to remove, and never invents a change", async () => {
    expect((await uninstallSubscriptionHooks("codex", { home })).status).toBe("no-config");
    mkdirSync(join(home, ".cursor"), { recursive: true });
    writeFileSync(cursorFile(), JSON.stringify({ version: 1, hooks: { sessionStart: [{ command: "theirs" }] } }), "utf8");
    const result = await uninstallSubscriptionHooks("cursor", { home });
    expect(result.status).toBe("not-present");
    expect(JSON.parse(readFileSync(cursorFile(), "utf8")).hooks.sessionStart[0].command).toBe("theirs");
  });

  it("REFUSES an unparseable config here too (BYTE-UNCHANGED), rather than rewriting it from a guess", async () => {
    mkdirSync(join(home, ".codex"), { recursive: true });
    const handWritten = '{ "hooks": { /* mine */ } }\n';
    writeFileSync(codexFile(), handWritten, "utf8");
    const result = await uninstallSubscriptionHooks("codex", { home });
    expect(result.status).toBe("error");
    expect(readFileSync(codexFile(), "utf8")).toBe(handWritten);
  });
});

describe("areSubscriptionHooksInstalled answers from the file the TOOL reads", () => {
  it("false before install, true after, false again after uninstall; false for an unreadable config", async () => {
    expect(await areSubscriptionHooksInstalled("codex", { home })).toBe(false);
    await installSubscriptionHooks("codex", { home });
    expect(await areSubscriptionHooksInstalled("codex", { home })).toBe(true);
    await uninstallSubscriptionHooks("codex", { home });
    expect(await areSubscriptionHooksInstalled("codex", { home })).toBe(false);
    // Malformed ⇒ NOT installed. Understating is the safe direction: the caller then declines to
    // claim a shaping effect, rather than promising one that is not wired.
    writeFileSync(codexFile(), "{ nope", "utf8");
    expect(await areSubscriptionHooksInstalled("codex", { home })).toBe(false);
  });
});

describe("mergeSubscriptionHooks is pure (the callers own all the IO)", () => {
  it("reports changed once and then not at all", () => {
    const first = mergeSubscriptionHooks("codex", {});
    expect(first.changed).toBe(true);
    expect(mergeSubscriptionHooks("codex", first.config).changed).toBe(false);
  });
});
