import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runStatus } from "../../src/cli/commands/upgrade-status.js";
import { collectReadinessReport } from "../../src/cli/commands/readiness.js";
import { CLAUDE_CODE_SHAPING_HOOK_COMMAND } from "../../src/core/claude-code-hooks.js";
import { SHAPING_STATE_VERSION } from "../../src/core/subscription-shaping-state.js";
import { SHIM_MARKER } from "../../src/core/tool-shim.js";
import { mergeSubscriptionHooks, subscriptionHookConfigPath } from "../../src/core/subscription-hooks-install.js";
import type { SubscriptionHookTool } from "../../src/core/subscription-shaping-hooks.js";

/**
 * `compaction status` must answer the output-shaping question about the environment it was HANDED,
 * not the ambient one.
 *
 * `runStatus({ env })` runs in-process with an injected environment. The shaping activation gate
 * resolves two things from that environment - the kill switch (`COMPACTION_SHAPING_HOOKS`) and the
 * persisted `compaction stop` state (found via `COMPACTION_CONFIG_DIR`) - so consulting `process.env`
 * instead reports shaping ACTIVE for hooks that are dormant under the supplied env. That is the same
 * defect class as F65 itself: a status surface telling the truth about the wrong state.
 *
 * Both cases below put a REAL shaping hook on disk first, because that is the only state where the
 * gate is load-bearing: with no hook installed the answer is `false` for an unrelated reason and the
 * bug hides. Driven through `runStatus` (not `collectReadinessReport`) so the human text and the JSON
 * are proven together - they are two renderings of one field, and both are user-facing.
 */

let configDir: string;
let cwd: string;
let originalCwd: string;
/** Two distinct homes, so "ambient" and "injected" can never accidentally agree. */
let injectedHome: string;
let ambientHome: string;
let originalHome: string | undefined;
/** Temp dirs holding `codex` stubs; torn down with everything else. */
let stubDirs: string[];
/** A PATH with NO `codex` on it at all (the "Codex unreachable" case). */
let emptyBinDir: string;

const SHAPING_SETTINGS = {
  hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: CLAUDE_CODE_SHAPING_HOOK_COMMAND }] }] }
};

/** Install Compaction's real UserPromptSubmit shaping hook under an arbitrary home/project root. */
function writeShapingHookUnder(root: string): void {
  const dir = join(root, ".claude");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "settings.json"), `${JSON.stringify(SHAPING_SETTINGS, null, 2)}\n`, "utf8");
}

/** Install it into the project settings `status` reads (cwd). */
function writeShapingHookOnDisk(): void {
  writeShapingHookUnder(cwd);
}

/** Persist the `compaction stop` run-state into the INJECTED config dir (never the real one). */
function writeStoppedState(): void {
  writeStoppedStateIn(configDir);
}

/** Persist `compaction stop` under an arbitrary Compaction home (`<home>/.compaction`). */
function writeStoppedStateUnderHome(home: string): void {
  const dir = join(home, ".compaction");
  mkdirSync(dir, { recursive: true });
  writeStoppedStateIn(dir);
}

function writeStoppedStateIn(dir: string): void {
  writeFileSync(
    join(dir, "shaping-state.json"),
    `${JSON.stringify({ version: SHAPING_STATE_VERSION, shaping: "stopped" })}\n`,
    "utf8"
  );
}

/**
 * `baseEnv()` sets `COMPACTION_CONFIG_DIR`, which short-circuits the home-based default. The stop-state
 * home resolution is only reachable WITHOUT that override, so these cases drop it deliberately.
 */
function envWithoutConfigDirOverride(home: string): NodeJS.ProcessEnv {
  const env = { ...baseEnv(), HOME: home, COMPACTION_HOME: join(home, ".compaction") };
  delete env.COMPACTION_CONFIG_DIR;
  return env;
}

/**
 * The single `Codex:` advisory line out of the rendered report.
 *
 * Assertions about that line must not be able to pass or fail on text from somewhere else - the header
 * now legitimately names `--check-codex`, which silently broke two `not.toContain` assertions written
 * against the whole report.
 */
function codexLine(report: string): string {
  return report.split("\n").find((l) => l.trim().startsWith("Codex:")) ?? "";
}

function baseEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    COMPACTION_CONFIG_DIR: configDir,
    COMPACTION_HOME: configDir,
    COMPACTION_API_URL: "",
    COMPACTION_API_KEY: "",
    ANTHROPIC_API_KEY: "",
    OPENAI_API_KEY: "",
    // The ambient process env must NOT be what decides the answer; leave the switch unset here so a
    // regression that reads `process.env` resolves to "activated" and the assertions go red.
    COMPACTION_SHAPING_HOOKS: undefined
  };
}

/**
 * `defaultProjectsDir` is only consulted when NO `projectsDir` is supplied, so a test that always
 * passes one can never exercise it. `useDefaultProjectsDir` omits it for the session-discovery case.
 */
async function capture(
  env: NodeJS.ProcessEnv,
  json = false,
  useDefaultProjectsDir = false,
  checkCodex = false
): Promise<string> {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  try {
    await runStatus({
      env,
      version: "0.0.0-test",
      json,
      ...(checkCodex ? { checkCodex: true } : {}),
      ...(useDefaultProjectsDir ? {} : { projectsDir: join(configDir, "none") })
    });
  } finally {
    vi.restoreAllMocks();
  }
  return lines.join("\n");
}

/**
 * Install a Codex/Cursor shaping hook under `home`, built by the CANONICAL writer and written to the
 * CANONICAL path. Hand-rolling the JSON would let the fixture and the probe drift apart and quietly
 * make these assertions vacuous; this way the file is by construction what `status` looks for.
 */
function writeSubscriptionHook(home: string, tool: SubscriptionHookTool): void {
  const file = subscriptionHookConfigPath(tool, { home });
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(mergeSubscriptionHooks(tool, {}).config, null, 2)}\n`, "utf8");
}

/**
 * A `codex` on PATH that answers Codex's OWN `hooks/list` with the given trust status.
 *
 * Codex's trust gate is not readable from any file we write, so the only way to exercise the
 * trusted/untrusted branches deterministically is to stand in for the binary and answer its documented
 * protocol - `HooksListResponse { data: [ { hooks: HookMetadata[] } ] }`, shape taken verbatim from
 * `codex app-server generate-json-schema`. Returns a PATH value with the stub dir first; the real
 * node directory stays on it because the stub is a `#!/usr/bin/env node` script and a stub that cannot
 * start would answer `unknown` and make these assertions vacuous.
 */
function codexStubPath(trustStatus: "trusted" | "untrusted" | "managed" | "modified", enabled = true): string {
  const dir = mkdtempSync(join(tmpdir(), "compaction-codex-stub-"));
  stubDirs.push(dir);
  const hooks = JSON.stringify([
    {
      key: "user:0",
      eventName: "userPromptSubmit",
      handlerType: "command",
      command: "compaction hooks shape codex",
      timeoutSec: 10,
      enabled,
      isManaged: false,
      currentHash: "sha256:test",
      sourcePath: "/tmp/hooks.json",
      source: "user",
      displayOrder: 0,
      trustStatus
    }
  ]);
  const file = join(dir, "codex");
  writeFileSync(
    file,
    `#!/usr/bin/env node
let buf = "";
process.stdin.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.method === "initialize") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\\n");
    } else if (msg.method === "hooks/list") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { data: [ { cwd: process.cwd(), warnings: [], errors: [], hooks: ${hooks} } ] } }) + "\\n");
    }
  }
});
`,
    "utf8"
  );
  chmodSync(file, 0o755);
  return `${dir}:${dirname(process.execPath)}`;
}

/** A file that `fileIsCompactionShim` accepts, under the shim dir the given Compaction home implies. */
function writeShimUnder(compactionHome: string, tool: string): void {
  const shimDir = join(compactionHome, "shims");
  mkdirSync(shimDir, { recursive: true });
  const p = join(shimDir, tool);
  writeFileSync(p, `#!/usr/bin/env bash\n# ${SHIM_MARKER}: ${tool}\nexec "$@"\n`, "utf8");
  chmodSync(p, 0o755);
}

/** One discoverable Claude Code session under `<home>/.claude/projects/<slug>/<id>.jsonl`. */
function writeSessionUnder(home: string): void {
  const slug = join(home, ".claude", "projects", "some-project");
  mkdirSync(slug, { recursive: true });
  writeFileSync(join(slug, "session-1.jsonl"), `${JSON.stringify({ type: "user" })}\n`, "utf8");
}

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "compaction-shaping-cfg-"));
  cwd = mkdtempSync(join(tmpdir(), "compaction-shaping-cwd-"));
  injectedHome = mkdtempSync(join(tmpdir(), "compaction-shaping-injhome-"));
  ambientHome = mkdtempSync(join(tmpdir(), "compaction-shaping-ambhome-"));
  stubDirs = [];
  emptyBinDir = mkdtempSync(join(tmpdir(), "compaction-nocodex-"));
  originalCwd = process.cwd();
  process.chdir(cwd);
  delete process.env.COMPACTION_SHAPING_HOOKS; // the ambient env is deliberately "shaping on"
  // Point the AMBIENT home at a tmp dir: a regression that reads ambient state must resolve somewhere
  // deterministic (and must never touch the real ~/.claude), so the two-homes assertions are decisive.
  originalHome = process.env.HOME;
  process.env.HOME = ambientHome;
});
afterEach(() => {
  process.chdir(originalCwd);
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  for (const d of [configDir, cwd, injectedHome, ambientHome, emptyBinDir, ...stubDirs]) rmSync(d, { recursive: true, force: true });
});

describe("compaction status - shaping state follows the INJECTED env, not the ambient one", () => {
  it("sanity: with the hook on disk and nothing suppressing it, the injected-env run reports shaping ON", async () => {
    writeShapingHookOnDisk();
    const json = JSON.parse(await capture(baseEnv(), true));
    expect(json.tools.claudeCode.shapingActive).toBe(true);
  });

  it("injected COMPACTION_SHAPING_HOOKS=0 with a hook on disk: text reports record-only", async () => {
    writeShapingHookOnDisk();
    const text = await capture({ ...baseEnv(), COMPACTION_SHAPING_HOOKS: "0" });
    expect(text).toContain("Record-only - your input is not compacted or edited.");
    expect(text).not.toContain("Output shaping: on");
  });

  it("injected COMPACTION_SHAPING_HOOKS=0 with a hook on disk: JSON reports shapingActive false", async () => {
    writeShapingHookOnDisk();
    const json = JSON.parse(await capture({ ...baseEnv(), COMPACTION_SHAPING_HOOKS: "0" }, true));
    expect(json.tools.claudeCode.shapingActive).toBe(false);
  });

  it("injected COMPACTION_CONFIG_DIR carrying persisted `compaction stop`: text reports record-only", async () => {
    writeShapingHookOnDisk();
    writeStoppedState();
    const text = await capture(baseEnv());
    expect(text).toContain("Record-only - your input is not compacted or edited.");
    expect(text).not.toContain("Output shaping: on");
  });

  it("injected COMPACTION_CONFIG_DIR carrying persisted `compaction stop`: JSON reports shapingActive false", async () => {
    writeShapingHookOnDisk();
    writeStoppedState();
    const json = JSON.parse(await capture(baseEnv(), true));
    expect(json.tools.claudeCode.shapingActive).toBe(false);
  });

  /**
   * The hook must be LOCATED under the injected home too, not merely gated by the injected switch.
   * These drive the two homes apart so ambient and injected can never both be right: the settings file
   * lives under one home and not the other, and `cwd` carries no settings at all, so the answer is
   * decided purely by which home the report resolves.
   */
  it("hook under the INJECTED home only: status finds it and reports shaping on", async () => {
    writeShapingHookUnder(injectedHome);
    const json = JSON.parse(await capture({ ...baseEnv(), HOME: injectedHome }, true));
    expect(json.tools.claudeCode.shapingActive).toBe(true);
  });

  it("hook under the AMBIENT home only: status does NOT report it as this environment's state", async () => {
    writeShapingHookUnder(ambientHome);
    const json = JSON.parse(await capture({ ...baseEnv(), HOME: injectedHome }, true));
    expect(json.tools.claudeCode.shapingActive).toBe(false);
  });

  it("hook under the INJECTED home only: the human text names the attached instruction", async () => {
    writeShapingHookUnder(injectedHome);
    const text = await capture({ ...baseEnv(), HOME: injectedHome });
    expect(text).toContain("Output shaping: on (Claude Code) - a concise-response instruction is attached before each shapeable turn.");
  });

  it("hook under the AMBIENT home only: the human text stays record-only", async () => {
    writeShapingHookUnder(ambientHome);
    const text = await capture({ ...baseEnv(), HOME: injectedHome });
    expect(text).toContain("Record-only - your input is not compacted or edited.");
    expect(text).not.toContain("Output shaping: on");
  });

  /**
   * The shaping line is not the only field derived from a location. The shim state and the session
   * count resolve their own directories from the environment too, and both are printed by `status`, so
   * they are pinned against the injected env for the same reason.
   */
  it("tool shims under the INJECTED Compaction home are the state reported, not the ambient one", async () => {
    writeShimUnder(configDir, "codex"); // configDir IS the injected COMPACTION_HOME
    writeShimUnder(join(ambientHome, ".compaction"), "cursor"); // ambient-only: must NOT be reported
    const json = JSON.parse(await capture(baseEnv(), true));
    expect(json.tools.codex.shim).not.toBe("not-installed");
    expect(json.tools.cursor.shim).toBe("not-installed");
  });

  /** `routingShim` is a THIRD call site of the same resolver, on its own report field. */
  it("claude routing shim under the INJECTED Compaction home is the state reported", async () => {
    writeShimUnder(configDir, "claude"); // the claude-code shim is named `claude`
    const json = JSON.parse(await capture(baseEnv(), true));
    expect(json.tools.claudeCode.routingShim).not.toBe("not-installed");
  });

  it("claude routing shim present only under the AMBIENT home is not reported as installed", async () => {
    writeShimUnder(join(ambientHome, ".compaction"), "claude");
    const json = JSON.parse(await capture(baseEnv(), true));
    expect(json.tools.claudeCode.routingShim).toBe("not-installed");
  });

  it("sessions are discovered under the INJECTED home when no projects dir is supplied", async () => {
    writeSessionUnder(injectedHome);
    const json = JSON.parse(await capture({ ...baseEnv(), HOME: injectedHome }, true, true));
    expect(json.tools.claudeCode.sessionsFound).toBe(1);
  });

  it("sessions under the AMBIENT home are not reported as this environment's sessions", async () => {
    writeSessionUnder(ambientHome);
    const json = JSON.parse(await capture({ ...baseEnv(), HOME: injectedHome }, true, true));
    expect(json.tools.claudeCode.sessionsFound).toBe(0);
  });

  /**
   * The persisted `compaction stop` marker is a STATE file, not a settings file, and it resolves through
   * a different family of helpers. With `COMPACTION_CONFIG_DIR` set, the home-based default is never
   * reached - so these cases drop that override, which is the only way the resolution under test runs.
   */
  it("stop state under the INJECTED home suppresses shaping (text + shapingActive)", async () => {
    writeShapingHookUnder(injectedHome);
    writeStoppedStateUnderHome(injectedHome);
    const env = envWithoutConfigDirOverride(injectedHome);
    const json = JSON.parse(await capture(env, true));
    expect(json.tools.claudeCode.shapingActive).toBe(false);
    const text = await capture(env);
    expect(text).toContain("Record-only - your input is not compacted or edited.");
    expect(text).not.toContain("Output shaping: on");
  });

  it("stop state under the AMBIENT home does NOT suppress shaping for the injected environment", async () => {
    writeShapingHookUnder(injectedHome);
    writeStoppedStateUnderHome(ambientHome); // ambient-only: must not decide the injected env's answer
    const env = envWithoutConfigDirOverride(injectedHome);
    const json = JSON.parse(await capture(env, true));
    expect(json.tools.claudeCode.shapingActive).toBe(true);
    const text = await capture(env);
    expect(text).toContain("Output shaping: on (Claude Code) - a concise-response instruction is attached before each shapeable turn.");
  });

  /**
   * `optimizationMode` / `connectedWorkflows` come from the preferences store, a SECOND member of the
   * state-file family resolved by the same helper. Asserted on its own fields, because a mutant that
   * only moves the preferences directory would leave `shapingActive` untouched.
   */
  it("preferences under the INJECTED home are the ones reported", async () => {
    const dir = join(injectedHome, ".compaction");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "preferences.json"),
      `${JSON.stringify({ version: 1, optimization_mode: "cache-context", connected_workflows: ["codex"] })}\n`,
      "utf8"
    );
    const json = JSON.parse(await capture(envWithoutConfigDirOverride(injectedHome), true));
    expect(json.connectedWorkflows).toContain("codex");
  });

  it("preferences under the AMBIENT home are not reported as this environment's preferences", async () => {
    const dir = join(ambientHome, ".compaction");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "preferences.json"),
      `${JSON.stringify({ version: 1, optimization_mode: "cache-context", connected_workflows: ["codex"] })}\n`,
      "utf8"
    );
    const json = JSON.parse(await capture(envWithoutConfigDirOverride(injectedHome), true));
    expect(json.connectedWorkflows).not.toContain("codex");
  });

  /**
   * F65's remaining half: the record-only determination consulted ONLY Claude Code's hook, so a user
   * whose Codex or Cursor shaping was active was told on `status` that nothing is attached to what the
   * model sees. Each case installs exactly ONE tool's hook and asserts that tool's own `shapingActive`
   * field plus the rendered line - the field a mutant scoped to that tool would actually move.
   */
  it("Codex shaping hook + Codex reporting it TRUSTED: status names Codex and reports shapingActive", async () => {
    writeSubscriptionHook(injectedHome, "codex");
    const env = { ...baseEnv(), HOME: injectedHome, PATH: codexStubPath("trusted") };
    const json = JSON.parse(await capture(env, true, false, true));
    expect(json.tools.codex.shapingActive).toBe(true);
    expect(json.tools.codex.shapingState).toBe("active");
    expect(json.tools.claudeCode.shapingActive).toBe(false);
    const textFrom = await capture(env, false, false, true);
    expect(textFrom).toContain("Output shaping: on (Codex) - a concise-response instruction is attached before each shapeable turn.");
    expect(textFrom).not.toContain("Record-only - your input is not compacted or edited.");
  });

  /**
   * THE DEFECT THIS WHOLE CODEX PATH EXISTS FOR. Writing `hooks.json` does not make Codex run the hook:
   * Codex gates it behind its own per-hash trust, and an untrusted hook is SILENTLY inert - the turn
   * completes and nothing is attached. Measured on codex-cli 0.144.1: with exactly this config in place,
   * `codex exec --json` completed a normal turn and the hook command never ran, while Codex's own
   * `hooks/list` answered `"trustStatus": "untrusted"`. So the config file alone may never produce the
   * "on" sentence, and the surface must instead name the one-time native action that finishes it.
   */
  it("Codex shaping hook + Codex reporting it UNTRUSTED: NOT active, and the native step is named", async () => {
    writeSubscriptionHook(injectedHome, "codex");
    const env = { ...baseEnv(), HOME: injectedHome, PATH: codexStubPath("untrusted") };
    const json = JSON.parse(await capture(env, true, false, true));
    expect(json.tools.codex.shapingActive).toBe(false);
    expect(json.tools.codex.shapingState).toBe("approval-required");
    const text = await capture(env, false, false, true);
    expect(text).not.toContain("Output shaping: on");
    expect(text).toContain("Codex reports this hook as untrusted");
    expect(text).toContain('choose "Trust all and continue"');
  });

  /**
   * FAIL-CLOSED. With the hook on disk but Codex unreachable, the trust question is real and
   * unanswered. It must land on "not active" and print no instruction, because both a shaping claim and
   * an approval instruction would assert a state we did not observe.
   */
  it("Codex shaping hook but Codex not reachable: unknown - neither an on-claim nor an approval nag", async () => {
    writeSubscriptionHook(injectedHome, "codex");
    const env = { ...baseEnv(), HOME: injectedHome, PATH: emptyBinDir };
    const json = JSON.parse(await capture(env, true, false, true));
    expect(json.tools.codex.shapingActive).toBe(false);
    expect(json.tools.codex.shapingState).toBe("unknown");
    const text = await capture(env, false, false, true);
    expect(text).not.toContain("Output shaping: on");
    // We ASKED and got nothing, so the honest report is that Codex did not answer - not silence, and
    // not a hint to use the flag the user just used.
    expect(codexLine(text)).toContain("Codex did not answer when asked");
    expect(codexLine(text)).toContain("could not be established here");
    expect(codexLine(text)).not.toContain("--check-codex");
  });

  /**
   * THE DEFAULT MUST NOT START CODEX. `compaction status` promises read-only, no network; Codex's
   * app-server is neither (measured: ~70 files written into a fresh Codex home, plus a model-catalogue
   * refresh). So the default reports `unknown` WITHOUT asking, says so, and points at the opt-in.
   * The stub here would answer `trusted` if it were ever consulted - so a regression that restores the
   * default probe turns this red rather than passing quietly.
   */
  /**
   * A hook Codex has SWITCHED OFF but also does not trust needs BOTH remedies named. Reporting it as
   * "configured and trusted" (the trusted-and-disabled wording) would prescribe a fix that still leaves
   * it unable to run - the same defect as the approval-only message, pointing the other way.
   */
  it("disabled AND untrusted: names both remedies, and never calls the hook trusted", async () => {
    writeSubscriptionHook(injectedHome, "codex");
    const env = { ...baseEnv(), HOME: injectedHome, PATH: codexStubPath("untrusted", false) };
    const json = JSON.parse(await capture(env, true, false, true));
    expect(json.tools.codex.shapingState).toBe("disabled");
    expect(json.tools.codex.shapingActive).toBe(false);
    const text = await capture(env, false, false, true);
    expect(text).toContain("DISABLED and NOT trusted");
    expect(text).toContain("re-enable the hook in Codex");
    expect(text).toContain("Trust all and continue");
    expect(text).not.toContain("configured and trusted");
  });

  it("disabled but TRUSTED: says re-approving will not help, and names only the real remedy", async () => {
    writeSubscriptionHook(injectedHome, "codex");
    const env = { ...baseEnv(), HOME: injectedHome, PATH: codexStubPath("trusted", false) };
    const text = await capture(env, false, false, true);
    expect(text).toContain("configured and trusted");
    expect(text).toContain("Re-approving trust will not change that");
    expect(text).not.toContain("NOT trusted");
  });

  /**
   * AN INCONCLUSIVE PROBE PRESCRIBES NOTHING. The hook may be trusted, disabled, or awaiting approval -
   * we cannot tell which - so naming the approval step would turn "could not establish" into a remedy
   * the evidence does not support.
   */
  it("probe requested but Codex unreachable: reports only that the state is unknown", async () => {
    writeSubscriptionHook(injectedHome, "codex");
    const env = { ...baseEnv(), HOME: injectedHome, PATH: emptyBinDir };
    const text = await capture(env, false, false, true);
    expect(codexLine(text)).toContain("could not be established here");
    expect(codexLine(text)).not.toContain("Trust all and continue");
    expect(codexLine(text)).not.toContain("--check-codex");
  });

  /**
   * THE HEADER DESCRIBES THE INVOCATION. `--check-codex` starts Codex, which writes its own state, so
   * that run may not print "read-only" - the report would contradict the warning that gated it.
   */
  it("the read-only header is dropped exactly when the live probe ran", async () => {
    writeSubscriptionHook(injectedHome, "codex");
    const env = { ...baseEnv(), HOME: injectedHome, PATH: codexStubPath("trusted") };
    expect(await capture(env)).toContain("local, read-only, content-free");
    const probed = await capture(env, false, false, true);
    expect(probed).not.toContain("local, read-only, content-free");
    expect(probed).toContain("--check-codex started Codex, which writes its own state");
  });

  /**
   * `--check-codex` WITH NO CODEX HOOK CONFIGURED starts nothing, so the header must not claim Codex was
   * started and wrote state. The flag reports what was REQUESTED; only what actually RAN may be
   * disclosed as a side effect.
   */
  it("--check-codex with no Codex hook configured: nothing is started, and the header says so", async () => {
    const env = { ...baseEnv(), HOME: injectedHome, PATH: codexStubPath("trusted") };
    const json = JSON.parse(await capture(env, true, false, true));
    expect(json.tools.codex.shapingConfigured).toBe(false);
    expect(json.tools.codex.shapingState).toBe("not-installed");
    const text = await capture(env, false, false, true);
    expect(text).toContain("local, read-only, content-free");
    expect(text).not.toContain("started Codex");
  });

  it("by DEFAULT the trust probe does not run: unknown, disclosed, and the opt-in is named", async () => {
    writeSubscriptionHook(injectedHome, "codex");
    const env = { ...baseEnv(), HOME: injectedHome, PATH: codexStubPath("trusted") };
    const json = JSON.parse(await capture(env, true));
    expect(json.tools.codex.shapingState).toBe("unknown");
    expect(json.tools.codex.shapingActive).toBe(false);
    expect(json.tools.codex.shapingConfigured).toBe(true);
    const text = await capture(env);
    expect(text).toContain("Codex: output shaping is configured.");
    expect(text).toContain("compaction status --check-codex");
    expect(text).not.toContain("Output shaping: on (Codex)");
  });

  /** Cursor is SESSION-LEVEL: it may never be described as attaching something per turn. */
  it("Cursor shaping only: status names Cursor and says once per session, never per turn", async () => {
    writeSubscriptionHook(injectedHome, "cursor");
    const env = { ...baseEnv(), HOME: injectedHome };
    const json = JSON.parse(await capture(env, true));
    expect(json.tools.cursor.shapingActive).toBe(true);
    const text = await capture(env);
    expect(text).toContain("Output shaping: on (Cursor) - a concise-response instruction is attached once per session.");
    expect(text).not.toContain("before each shapeable turn");
  });

  it("mixed: Claude Code + Cursor names both, with Cursor's session scope kept distinct", async () => {
    writeShapingHookUnder(injectedHome);
    writeSubscriptionHook(injectedHome, "cursor");
    const env = { ...baseEnv(), HOME: injectedHome };
    const json = JSON.parse(await capture(env, true));
    expect(json.tools.claudeCode.shapingActive).toBe(true);
    expect(json.tools.cursor.shapingActive).toBe(true);
    const text = await capture(env);
    expect(text).toContain(
      "Output shaping: on (Claude Code, Cursor) - a concise-response instruction is attached before each shapeable turn (Cursor: once per session)."
    );
  });

  it("no tool's shaping hook present: record-only, and every tool reports shapingActive false", async () => {
    const env = { ...baseEnv(), HOME: injectedHome };
    const json = JSON.parse(await capture(env, true));
    expect(json.tools.claudeCode.shapingActive).toBe(false);
    expect(json.tools.codex.shapingActive).toBe(false);
    expect(json.tools.cursor.shapingActive).toBe(false);
    const text = await capture(env);
    expect(text).toContain("Record-only - your input is not compacted or edited.");
    expect(text).not.toContain("Output shaping: on");
  });

  /**
   * The record-only claim is about WHAT THE MODEL SEES, so only the shaping entry may gate it. Codex's
   * install also writes a model-invisible `Stop` turn-line hook; a config carrying the shaping hook
   * WITHOUT that line is still attaching an instruction to every turn. Asking the all-hooks question
   * here would answer `false` and print `Record-only` over a live hook - the exact F65 defect, one
   * config short of the fixture above.
   */
  it("Codex shaping hook present but the turn-line hook absent: still shaping, never record-only", async () => {
    const file = subscriptionHookConfigPath("codex", { home: injectedHome });
    mkdirSync(dirname(file), { recursive: true });
    const full = mergeSubscriptionHooks("codex", {}).config as { hooks?: Record<string, unknown> };
    const hooks = { ...(full.hooks ?? {}) };
    delete hooks.Stop;
    delete hooks.stop;
    writeFileSync(file, `${JSON.stringify({ ...full, hooks }, null, 2)}\n`, "utf8");

    const env = { ...baseEnv(), HOME: injectedHome, PATH: codexStubPath("trusted") };
    const json = JSON.parse(await capture(env, true, false, true));
    expect(json.tools.codex.shapingActive).toBe(true);
    const text = await capture(env, false, false, true);
    expect(text).toContain("Output shaping: on (Codex)");
    expect(text).not.toContain("Record-only - your input is not compacted or edited.");
  });

  it("the global switch suppresses EVERY tool, not just Claude Code", async () => {
    writeSubscriptionHook(injectedHome, "codex");
    writeSubscriptionHook(injectedHome, "cursor");
    const json = JSON.parse(await capture({ ...baseEnv(), HOME: injectedHome, COMPACTION_SHAPING_HOOKS: "0" }, true));
    expect(json.tools.codex.shapingActive).toBe(false);
    expect(json.tools.cursor.shapingActive).toBe(false);
  });

  it("status stays read-only: neither suppressed run rewrites the settings file it read", async () => {
    writeShapingHookOnDisk();
    writeStoppedState();
    const settingsPath = join(cwd, ".claude", "settings.json");
    const before = readFileSync(settingsPath, "utf8");
    await capture(baseEnv());
    await capture({ ...baseEnv(), COMPACTION_SHAPING_HOOKS: "0" });
    expect(readFileSync(settingsPath, "utf8")).toBe(before);
  });
});

/**
 * THE SAME DEFECT, ONE FIELD OVER: the stored auto-apply AUTHORIZATION.
 *
 * The authorization store moved off the working directory and onto the device
 * (`authorizationStoreDirectory`), which is what let a device-level opt-in be seen from every project.
 * But the readiness report is built for the env it was HANDED, and its optimization-mode and
 * connected-workflow fields already honour that env — so resolving the authorization store from the
 * ambient `process.env` would put two different devices in one report and print next-step commands for
 * the wrong one ("authorize with `compaction init --authorize-auto-apply claude-code`" to a user who
 * already has, or silence for a user who has not).
 *
 * The two homes below hold OPPOSITE authorization states, so the report cannot be right by coincidence.
 */
describe("compaction status - the stored authorization follows the INJECTED env, not the ambient one", () => {
  let ambientConfigDir: string;
  let injectedConfigDir: string;
  let previousAmbient: string | undefined;

  /** The exact record `init --authorize-auto-apply claude-code` writes. */
  function authorizeIn(dir: string): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "policy-preferences.json"),
      `${JSON.stringify({
        preferences: [
          {
            id: "pref-000000000000000000000000",
            scope: { tool: "claude-code", policy_type: "deterministic-dedupe" },
            preference: "auto-when-gates-pass",
            enabled: true,
            gates_required: [
              "scope-match",
              "supported-shape",
              "deterministic-policy",
              "original-retainable",
              "change-produced"
            ]
          }
        ]
      })}\n`,
      "utf8"
    );
  }

  beforeEach(() => {
    ambientConfigDir = mkdtempSync(join(tmpdir(), "authz-ambient-"));
    injectedConfigDir = mkdtempSync(join(tmpdir(), "authz-injected-"));
    previousAmbient = process.env.COMPACTION_CONFIG_DIR;
    process.env.COMPACTION_CONFIG_DIR = ambientConfigDir;
  });

  afterEach(() => {
    if (previousAmbient === undefined) delete process.env.COMPACTION_CONFIG_DIR;
    else process.env.COMPACTION_CONFIG_DIR = previousAmbient;
    for (const d of [ambientConfigDir, injectedConfigDir]) rmSync(d, { recursive: true, force: true });
  });

  async function authorizationsFor(configDirForEnv: string): Promise<Record<string, { authorized: boolean }>> {
    const report = await collectReadinessReport(
      mkdtempSync(join(tmpdir(), "authz-cwd-")),
      { ...process.env, COMPACTION_CONFIG_DIR: configDirForEnv, COMPACTION_HOME: configDirForEnv },
      join(injectedConfigDir, "no-projects")
    );
    return report.authorizations as unknown as Record<string, { authorized: boolean }>;
  }

  it("reports NOT authorized for an injected device that has no authorization, even when the ambient one does", async () => {
    authorizeIn(ambientConfigDir); // the machine running the test "has" an authorization
    expect((await authorizationsFor(injectedConfigDir))["claude-code"].authorized).toBe(false);
  });

  it("reports AUTHORIZED for an injected device that has one, even when the ambient one does not", async () => {
    authorizeIn(injectedConfigDir); // …and the opposite arrangement, so neither answer can be a constant
    expect((await authorizationsFor(injectedConfigDir))["claude-code"].authorized).toBe(true);
  });
});
