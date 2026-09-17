import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { codexTrustContinuationLines } from "../../src/cli/commands/init.js";

/**
 * ENABLING A WORKFLOW MUST INSTALL WHAT "ENABLED" REQUIRES.
 *
 * `compaction init --connect codex|cursor` used to install ONLY the PATH shim, which CAPTURES a
 * measurable batch run and changes nothing about what the model is asked to produce. The lever that
 * actually shapes output is the tool's native hook config, and it was reachable only by discovering
 * `compaction hooks install --tool codex` afterwards — so a workflow the flow called "Enabled" was
 * never actually shaped, and no screen said so.
 *
 * These tests assert the whole contract at the real CLI surface, in an isolated HOME:
 *  - Codex gets BOTH entries (UserPromptSubmit shaping + Stop per-turn line) in ~/.codex/hooks.json.
 *  - Cursor gets the SESSION-LEVEL sessionStart entry in ~/.cursor/hooks.json.
 *  - The kill switch and `compaction stop` SUPPRESS both installs (a user who turned shaping off never
 *    gets a shaping hook wired behind their back) while leaving the shim connect intact.
 *  - The non-interactive surface DISCLOSES the target file, the backup path, and both entries — the
 *    TUI review screen is not the only place that has to name what is written.
 *  - A pre-existing foreign hook is preserved (merge, never replace).
 */
const execFileAsync = promisify(execFile);
const TSX = path.resolve("node_modules/.bin/tsx");
const CLI_ENTRY = path.resolve("src/cli/index.ts");
const NODE_DIR = path.dirname(process.execPath);

let root: string;
let realBinDir: string;
let home: string;
let compactionHome: string;
let shimDir: string;

function baseEnv(pathValue: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    HOME: home,
    COMPACTION_HOME: compactionHome,
    COMPACTION_CONFIG_DIR: path.join(compactionHome, "config"),
    PATH: pathValue,
    NO_COLOR: "1",
    ...extra
  };
}

async function runCliResult(
  args: string[],
  pathValue: string,
  extra: NodeJS.ProcessEnv = {}
): Promise<{ stdout: string; code: number }> {
  try {
    const { stdout } = await execFileAsync(TSX, [CLI_ENTRY, ...args], { env: baseEnv(pathValue, extra) });
    return { stdout, code: 0 };
  } catch (error) {
    // init exits non-zero only on verify-failed; still capture stdout for assertions.
    const failure = error as { stdout?: string; code?: number };
    return { stdout: failure.stdout ?? "", code: typeof failure.code === "number" ? failure.code : 1 };
  }
}

async function runCli(args: string[], pathValue: string, extra: NodeJS.ProcessEnv = {}): Promise<string> {
  return (await runCliResult(args, pathValue, extra)).stdout;
}

function fakeBin(name: string): void {
  const file = path.join(realBinDir, name);
  writeFileSync(file, "#!/usr/bin/env bash\necho real\n", "utf8");
  chmodSync(file, 0o755);
}

const codexHooks = (): string => path.join(home, ".codex", "hooks.json");
const cursorHooks = (): string => path.join(home, ".cursor", "hooks.json");

/** Every command string in a Codex nested-group event. */
function codexCommands(config: { hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>> }, event: string): string[] {
  return (config.hooks?.[event] ?? []).flatMap((g) => (g.hooks ?? []).map((h) => h.command ?? ""));
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "init-hooks-"));
  realBinDir = path.join(root, "realbin");
  home = path.join(root, "home");
  compactionHome = path.join(home, ".compaction");
  shimDir = path.join(compactionHome, "shims");
  mkdirSync(realBinDir, { recursive: true });
  mkdirSync(home, { recursive: true });
  fakeBin("codex");
  fakeBin("cursor-agent");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const installPath = (): string => `${realBinDir}${path.delimiter}${NODE_DIR}${path.delimiter}/usr/bin${path.delimiter}/bin`;
const activePath = (): string =>
  `${shimDir}${path.delimiter}${realBinDir}${path.delimiter}${NODE_DIR}${path.delimiter}/usr/bin${path.delimiter}/bin`;

describe("init --connect codex installs the native hooks, not just the PATH shim", () => {
  it("writes ~/.codex/hooks.json with BOTH entries: UserPromptSubmit shaping AND the Stop per-turn line", async () => {
    await runCli(["init", "--connect", "codex", "--static"], installPath());
    expect(existsSync(codexHooks()), "the Codex hooks config was not written").toBe(true);
    const config = JSON.parse(readFileSync(codexHooks(), "utf8"));
    expect(codexCommands(config, "UserPromptSubmit")).toContain("compaction hooks shape codex");
    expect(codexCommands(config, "Stop")).toContain("compaction hooks line codex");
  });

  /**
   * The write is disclosed; what it ACHIEVES is not overstated. Codex will not run a hook it has not
   * been told to trust, so enablement here is one native step short - and saying otherwise was the
   * defect. This is the guard that stops the old sentence returning.
   */
  it("does NOT claim Codex shaping is on: a freshly written hook is awaiting Codex's own approval", async () => {
    const out = await runCli(["init", "--connect", "codex", "--static"], installPath());
    expect(out).not.toContain("Output shaping: on for codex");
    expect(out).toContain("Codex   Output shaping · one step remaining");
    expect(out).toContain("Run codex. At “Hooks need review,” choose “Trust all and continue”.");
    expect(out).toContain("Trust all and continue");
  });

  it("DISCLOSES the target file and both entries on the non-interactive surface (no undisclosed write)", async () => {
    const out = await runCli(["init", "--connect", "codex", "--static"], installPath());
    expect(out).toContain(codexHooks());
    expect(out).toContain("UserPromptSubmit: compaction hooks shape codex");
    expect(out).toContain("Stop: compaction hooks line codex");
    // The EFFECT is still disclosed, on the entry line that names the write it describes. The summary
    // sentence above it used to read "Output shaping: on for codex - ... attached to what the model
    // sees", which this assertion pinned - and that claim was FALSE: Codex gates every hook behind its
    // own per-hash trust, so a freshly written hook attaches nothing until the user approves it once.
    // Pinning it made this test enforce the defect (the F58 class), so the pin now follows the
    // disclosure rather than the overclaim.
    expect(out).toContain("attaches a concise-response instruction to what the model sees, before generation");
    // The Stop line is never promised as something the user WILL see, nor without settled evidence.
    expect(out).toContain("if your Codex build displays hook `systemMessage`");
    expect(out).toContain("settled evidence when recorded");
    expect(out).not.toMatch(/you'll see a line after each turn/i);
    expect(out).not.toMatch(/one line per turn|after each turn|returns the content-free per-turn receipt/i);
    // No savings/cost claim rides the enable output for this path.
    expect(out).not.toMatch(/\$\d/);
  });

  it("is idempotent and MERGES: a pre-existing foreign hook survives a re-run", async () => {
    mkdirSync(path.join(home, ".codex"), { recursive: true });
    writeFileSync(
      codexHooks(),
      JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "other-tool --x" }] }] } }),
      "utf8"
    );
    await runCli(["init", "--connect", "codex", "--static"], installPath());
    await runCli(["init", "--connect", "codex", "--static"], activePath());
    const config = JSON.parse(readFileSync(codexHooks(), "utf8"));
    const commands = codexCommands(config, "UserPromptSubmit");
    expect(commands).toContain("other-tool --x");
    expect(commands.filter((c) => c === "compaction hooks shape codex")).toHaveLength(1);
    // The backup of the pre-existing file is written and named.
    expect(existsSync(`${codexHooks()}.compaction.bak`)).toBe(true);
  });

  it("repairs missing native hooks when the Codex routing shim is already active", async () => {
    await runCli(["init", "--connect", "codex", "--static"], installPath());
    rmSync(codexHooks(), { force: true });
    writeFileSync(
      codexHooks(),
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "other-tool --keep" }] }] } }),
      "utf8"
    );

    await runCli(["init", "--connect", "codex", "--static"], activePath());
    await runCli(["init", "--connect", "codex", "--static"], activePath());

    const config = JSON.parse(readFileSync(codexHooks(), "utf8"));
    expect(codexCommands(config, "UserPromptSubmit")).toEqual(["compaction hooks shape codex"]);
    expect(codexCommands(config, "Stop")).toContain("other-tool --keep");
    expect(codexCommands(config, "Stop").filter((command) => command === "compaction hooks line codex")).toHaveLength(1);
  });
});

describe("init --connect cursor installs the SESSION-LEVEL hook", () => {
  it("writes ~/.cursor/hooks.json with the flat sessionStart entry", async () => {
    await runCli(["init", "--connect", "cursor", "--static"], installPath());
    expect(existsSync(cursorHooks()), "the Cursor hooks config was not written").toBe(true);
    const config = JSON.parse(readFileSync(cursorHooks(), "utf8"));
    expect(config.version).toBe(1);
    expect(config.hooks.sessionStart[0].command).toBe("compaction hooks shape cursor");
    expect(config.hooks.sessionStart[0].hooks).toBeUndefined(); // FLAT entry, per the Cursor schema
  });

  it("describes Cursor as session-level, never per turn / per prompt", async () => {
    const out = await runCli(["init", "--connect", "cursor", "--static"], installPath());
    expect(out).toContain("one session-level instruction per session");
    expect(out).toContain(cursorHooks());
    // No POSITIVE per-turn/per-prompt claim anywhere (explicit negations like "not per turn" and
    // "no per-turn line" are the honest form and are exactly what this path must keep saying).
    expect(out).not.toMatch(/attached to what the model sees, (?:on )?(?:every|each) (?:turn|prompt)/i);
    expect(out).not.toMatch(/every prompt/i);
  });
});

/**
 * THE SAFETY GATE. `isShapingHooksActivated()` is the SAME switch the Claude Code shaping hook install
 * is gated on. Without it, a user who ran `compaction stop` (or set the kill switch) would get a
 * shaping hook wired behind their back by a command they ran for a different reason.
 */
describe("the shaping kill switch and `compaction stop` suppress BOTH hook installs", () => {
  it("COMPACTION_SHAPING_HOOKS=0: no ~/.codex/hooks.json and no ~/.cursor/hooks.json, shim still connects", async () => {
    const off = { COMPACTION_SHAPING_HOOKS: "0" };
    const codexOut = await runCli(["init", "--connect", "codex", "--static"], installPath(), off);
    await runCli(["init", "--connect", "cursor", "--static"], installPath(), off);
    expect(existsSync(codexHooks())).toBe(false);
    expect(existsSync(cursorHooks())).toBe(false);
    // The shim half of the connect is untouched (the gate is additive, not a disconnect).
    expect(existsSync(path.join(shimDir, "codex"))).toBe(true);
    expect(codexOut).toContain("Codex");
  });

  it("`compaction stop` (persisted state, no env): a later connect writes no hook config", async () => {
    await runCli(["stop"], installPath());
    await runCli(["init", "--connect", "codex", "--static"], installPath());
    await runCli(["init", "--connect", "cursor", "--static"], installPath());
    expect(existsSync(codexHooks())).toBe(false);
    expect(existsSync(cursorHooks())).toBe(false);
    expect(existsSync(path.join(shimDir, "codex"))).toBe(true);
  });
});

describe("--dry-run writes no hook config", () => {
  it("names the file it WOULD write and writes nothing", async () => {
    const out = await runCli(["init", "--connect", "codex", "--static", "--dry-run"], installPath());
    expect(existsSync(codexHooks())).toBe(false);
    expect(out).toContain("--dry-run");
  });
});

/**
 * DATA LOSS, at the surface that actually runs it. The shared installer test pins the mechanism; this
 * pins that the DEFAULT `compaction init` path cannot destroy a user's hand-written config — which is
 * the path this change put the installer on.
 */
describe("a hand-written config the parser rejects survives `init --connect` untouched", () => {
  it("leaves the file BYTE-UNCHANGED, writes no backup, and does NOT claim shaping is on", async () => {
    mkdirSync(path.join(home, ".codex"), { recursive: true });
    const handWritten = [
      "{",
      "  // my own hooks",
      '  "hooks": { "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "my-own-tool --run" }] }] },',
      "}",
      ""
    ].join("\n");
    writeFileSync(codexHooks(), handWritten, "utf8");

    const result = await runCliResult(["init", "--connect", "codex", "--static"], installPath());
    const out = result.stdout;
    expect(readFileSync(codexHooks(), "utf8"), "the user's config was overwritten").toBe(handWritten);
    expect(existsSync(`${codexHooks()}.compaction.bak`)).toBe(false);
    // And the output must NOT show the green "on" claim for a hook that was never installed.
    expect(out).not.toContain("Output shaping: on for codex");
    expect(out).toContain("Output shaping: not installed for codex");
    // The shim half still connected - a hook refusal is additive, never a disconnect.
    expect(existsSync(path.join(shimDir, "codex"))).toBe(true);
    expect(result.code).toBe(1);
  });
});

/**
 * THE READY SUMMARY MAY NOT CLAIM A SHAPING EFFECT THAT IS NOT WIRED. Reproduced by the trust review
 * in ONE uninterrupted run: the connect block printed the honest install failure, and twenty-five
 * lines later the ready summary said the instruction is attached before generation.
 */
describe("ready summary follows the hook state that is actually on disk", () => {
  it("a FAILED hook install ⇒ the ready line says shaping is NOT active (same run, no contradiction)", async () => {
    mkdirSync(path.join(home, ".codex"), { recursive: true });
    writeFileSync(codexHooks(), JSON.stringify({ hooks: "not-an-object" }), "utf8");
    // Install once so the shim is on PATH, then re-run with it active so the Ready summary renders.
    await runCli(["init", "--connect", "codex", "--static"], installPath());
    const result = await runCliResult(["init", "--connect", "codex", "--static"], activePath());
    const out = result.stdout;
    const ready = out.slice(out.indexOf("Setup incomplete"));
    expect(result.code).toBe(1);
    expect(out).not.toContain("Compaction is ready.");
    expect(ready).toContain("Setup incomplete");
    expect(ready).toContain("✓ Codex routing shim");
    expect(ready).toContain("Codex routing shim → ✓ Enabled");
    expect(ready).toContain("Codex native hooks · retry: compaction init --connect codex");
    expect(ready).toContain("output shaping is NOT active for Codex");
    expect(ready).not.toContain("a concise-response instruction is attached before generation");
    // The failure was already stated above; the two halves of the run now agree.
    expect(out).toContain("Output shaping: not installed for codex");
  });

  it("a successful hook install without a native trust result stays configured, not active", async () => {
    await runCli(["init", "--connect", "codex", "--static"], installPath());
    const out = await runCli(["init", "--connect", "codex", "--static"], activePath());
    const ready = out.slice(out.indexOf("Compaction is ready."));
    expect(ready).toContain("output shaping is configured for Codex");
    expect(ready).toContain("depends on its one-time hook approval");
    expect(ready).not.toContain("a concise-response instruction is attached before generation");
  });

  it("the kill switch ⇒ no hook is written AND the ready line does not claim one", async () => {
    const off = { COMPACTION_SHAPING_HOOKS: "0" };
    await runCli(["init", "--connect", "cursor", "--static"], installPath(), off);
    const out = await runCli(["init", "--connect", "cursor", "--static"], activePath(), off);
    expect(existsSync(cursorHooks())).toBe(false);
    const ready = out.slice(out.indexOf("Compaction is ready."));
    expect(ready).toContain("output shaping is NOT active for Cursor");
    expect(ready).not.toContain("ONE session-level instruction per session");
  });
});

/**
 * DISCONNECT MUST UNDO CONNECT. Before this change `init` never wrote these hooks, so `--disconnect`
 * was complete; installing them on the connect path created the gap. "disconnected" must not stand
 * alone while a model-visible hook keeps firing on every turn.
 */
describe("init --disconnect removes the hooks it installed", () => {
  it("Codex: --disconnect 2 removes BOTH entries and says so", async () => {
    await runCli(["init", "--connect", "codex", "--static"], installPath());
    expect(existsSync(codexHooks())).toBe(true);
    const out = await runCli(["init", "--disconnect", "2", "--static"], installPath());
    expect(out).toContain("disconnected");
    expect(out).toContain("output shaping is off for codex");
    expect(out).toContain(codexHooks());
    const config = JSON.parse(readFileSync(codexHooks(), "utf8"));
    expect(JSON.stringify(config)).not.toContain("compaction hooks shape codex");
    expect(JSON.stringify(config)).not.toContain("compaction hooks line codex");
  });

  it("Cursor: --disconnect 3 removes the sessionStart entry and preserves a foreign hook", async () => {
    mkdirSync(path.join(home, ".cursor"), { recursive: true });
    writeFileSync(cursorHooks(), JSON.stringify({ version: 1, hooks: { sessionStart: [{ command: "theirs" }] } }), "utf8");
    await runCli(["init", "--connect", "cursor", "--static"], installPath());
    const out = await runCli(["init", "--disconnect", "3", "--static"], installPath());
    expect(out).toContain("output shaping is off for cursor");
    const config = JSON.parse(readFileSync(cursorHooks(), "utf8"));
    expect(config.hooks.sessionStart.map((e: { command: string }) => e.command)).toEqual(["theirs"]);
  });

  /**
   * DATA LOSS AT THE DISCONNECT SURFACE. `--disconnect 2|3` is the path
   * #882 newly wired to the shared uninstall, and the shaping matcher recognised OUR hook by three
   * SUBSTRINGS — so a user's own `echo compaction hooks shape cursor` satisfied all three and was
   * deleted by a command run to remove Compaction's own entry. The uninstall may only ever remove a
   * command it wrote itself.
   */
  it("Cursor: a foreign `echo compaction hooks shape cursor` survives --disconnect 3 untouched", async () => {
    const foreign = "echo compaction hooks shape cursor";
    mkdirSync(path.join(home, ".cursor"), { recursive: true });
    writeFileSync(cursorHooks(), JSON.stringify({ version: 1, hooks: { sessionStart: [{ command: foreign }] } }), "utf8");
    const out = await runCli(["init", "--disconnect", "3", "--static"], installPath());
    const config = JSON.parse(readFileSync(cursorHooks(), "utf8"));
    expect(config.hooks.sessionStart.map((e: { command: string }) => e.command)).toEqual([foreign]);
    // ...and the disconnect must not report removing anything, because it removed nothing.
    expect(out).not.toContain("output shaping is off for cursor");
    expect(out).toMatch(/nothing to remove/);
  });

  it("Codex: a foreign `echo compaction hooks shape codex` survives --disconnect 2 untouched", async () => {
    const foreign = "echo compaction hooks shape codex";
    mkdirSync(path.join(home, ".codex"), { recursive: true });
    writeFileSync(
      codexHooks(),
      JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: foreign }] }] } }),
      "utf8"
    );
    const out = await runCli(["init", "--disconnect", "2", "--static"], installPath());
    const config = JSON.parse(readFileSync(codexHooks(), "utf8"));
    expect(codexCommands(config, "UserPromptSubmit")).toEqual([foreign]);
    expect(out).not.toContain("output shaping is off for codex");
  });

  it("says plainly when there was no hook to remove (never implies one was)", async () => {
    const out = await runCli(["init", "--disconnect", "2", "--static"], installPath());
    expect(out).toContain("disconnected");
    expect(out).toMatch(/nothing to remove/);
    expect(out).not.toContain("output shaping is off for codex");
  });

  /**
   * THE STATE TRANSITION, NOT JUST THE FIRST FRAME.
   *
   * The requirement has two halves and the second one is the easy one to break: tell the user the
   * one-time Codex step when it is outstanding, and then STOP. A run that changed no hook hash cannot
   * know whether Codex's per-hash trust was granted in between, so repeating the launch instruction
   * there turns a continuation into a nag on every `compaction init`. This pins both frames of the
   * transition against the same HOME, in order, so a regression on either side is visible.
   */
  it("says the one-time Codex step on the run that WRITES the hook, and stops saying it afterwards", async () => {
    const first = await runCli(["init", "--connect", "codex", "--static"], installPath());
    expect(first).toContain("Codex   Output shaping · one step remaining");
    expect(first).toContain("Run codex. At “Hooks need review,” choose “Trust all and continue”.");

    // Second run over the SAME config: nothing was written, so nothing is outstanding to announce.
    const second = await runCli(["init", "--connect", "codex", "--static"], activePath());
    expect(second).not.toContain("one step remaining");
    expect(second).not.toContain("Run codex. At “Hooks need review”");
    // It does not claim the opposite either. Trust is Codex's answer to give, and this run did not ask.
    expect(second).toContain("Whether Codex is running it depends on its one-time hook approval");
    expect(second).toContain("compaction status");
  });

  /**
   * ONE COPY SOURCE FOR BOTH ONBOARDING SURFACES.
   *
   * The TUI is the DEFAULT interactive surface and it renders none of `actionLines` — so for as long as
   * this guidance existed only inside the static block, the users most likely to need it were the ones
   * who never saw it. The fix prints the same lines to durable scrollback after the TUI exits, which is
   * only worth anything if it is the SAME text: two hand-maintained copies of a launch instruction drift,
   * and the surface that drifts is the one nobody runs in a test. This asserts the static path emits the
   * shared builder's output verbatim, so a change to one surface cannot silently leave the other behind.
   *
   * (The TUI's own render is not exercised end-to-end here: `decideInteractiveTui` hard-refuses under
   * VITEST, so reaching it would mean subverting that gate or adding a pty dependency. What is pinned is
   * the text both surfaces share and the flag that gates it — see the sibling assertions above.)
   */
  it("renders the SHARED continuation text, not a second hand-written copy", async () => {
    const out = await runCli(["init", "--connect", "codex", "--static"], installPath());
    const stripAnsi = (s: string): string => s.replace(/\u001B\[[0-9;]*m/g, "");
    const shared = codexTrustContinuationLines("    ").map(stripAnsi);
    expect(shared).toHaveLength(2);
    for (const line of shared) expect(stripAnsi(out)).toContain(line);
  });

  /**
   * The continuation has to be actionable WITHOUT a Compaction command: the user launches Codex the way
   * they always do, and answers Codex's own prompt. A version of this line that told them to run
   * `compaction status --check-codex` first would satisfy every string above and still be the wrong
   * product, so the required shape is asserted directly.
   */
  it("names the native Codex step only - no per-session or per-check Compaction command", () => {
    const text = codexTrustContinuationLines("  ").join("\n").replace(/\u001B\[[0-9;]*m/g, "");
    expect(text).toContain("Run codex.");
    expect(text).toContain("Hooks need review");
    expect(text).toContain("Trust all and continue");
    expect(text).not.toMatch(/compaction\s+(status|hooks|init)/i);
    expect(text).not.toContain("--check-codex");
  });

});
