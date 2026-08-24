import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  codexShapingHookTrust,
  codexShapingStateFromHooks,
  queryCodexHooks,
  CODEX_TRUST_ACTION_CONTROL,
  CODEX_TRUST_ACTION_HEADING,
  type CodexHookMetadata,
  type CodexHookTrustStatus
} from "../../src/core/codex-hook-trust.js";
import { shapingHookCommand } from "../../src/core/subscription-shaping-hooks.js";

/**
 * Codex will not run a hook it has not been told to trust, and an untrusted hook is SILENTLY inert -
 * the turn completes normally and nothing anywhere reports a skip. So "the config file exists" is not
 * evidence that anything reaches the model, and every assertion here exists to keep a claim about
 * model-visible mutation tied to Codex's OWN answer rather than to our own write.
 *
 * The state machine is exercised as a pure function (no subprocess), and the JSON-RPC client is
 * exercised against a stub that speaks Codex's real `hooks/list` contract - `HooksListResponse
 * { data: [ { hooks: HookMetadata[] } ] }` with `trustStatus` in
 * `managed | untrusted | trusted | modified`, taken verbatim from
 * `codex app-server generate-json-schema` on the installed binary.
 */

const SHAPING = shapingHookCommand("codex");

function hook(overrides: Partial<CodexHookMetadata> = {}): CodexHookMetadata {
  return {
    key: "k",
    eventName: "userPromptSubmit",
    command: SHAPING,
    enabled: true,
    trustStatus: "trusted",
    ...overrides
  };
}

describe("codexShapingStateFromHooks - the state machine, as a pure function", () => {
  it("no hooks at all: not-installed", () => {
    expect(codexShapingStateFromHooks([])).toEqual({ state: "not-installed" });
  });

  it("a probe that failed (undefined) is unknown, NEVER not-installed", () => {
    // The distinction is the whole point: "Codex says there is no such hook" and "we could not ask"
    // support completely different sentences, and collapsing them would let a failed probe read as a
    // clean machine.
    expect(codexShapingStateFromHooks(undefined)).toEqual({ state: "unknown", unknownReason: "probe-failed" });
  });

  it.each<CodexHookTrustStatus>(["trusted", "managed"])("trustStatus %s + enabled: active", (trustStatus) => {
    expect(codexShapingStateFromHooks([hook({ trustStatus })])).toEqual({ state: "active", trustStatus });
  });

  it.each<CodexHookTrustStatus>(["untrusted", "modified"])(
    "trustStatus %s: approval-required - this is the state one native approval resolves",
    (trustStatus) => {
      expect(codexShapingStateFromHooks([hook({ trustStatus })])).toEqual({ state: "approval-required", trustStatus });
    }
  );

  /**
   * TRUSTED BUT SWITCHED OFF IS ITS OWN STATE, because its remedy is different. Approving trust does
   * nothing for a hook Codex has disabled, so collapsing this into `approval-required` sends the user
   * to a review screen that cannot fix their problem - and tells them "nothing else is needed"
   * afterwards, which is false.
   */
  it("trusted but DISABLED is `disabled`, never `approval-required`", () => {
    const r = codexShapingStateFromHooks([hook({ enabled: false })]);
    expect(r.state).toBe("disabled");
    expect(r.disabled).toBe(true);
  });

  it("managed but DISABLED is also `disabled` (policy trust does not run a switched-off hook)", () => {
    expect(codexShapingStateFromHooks([hook({ enabled: false, trustStatus: "managed" })]).state).toBe("disabled");
  });

  /**
   * Disabled AND untrusted: approving trust alone still would not run it, so the reported state is the
   * one whose remedy is not sufficient on its own. No message may promise a fix that is not one.
   */
  it("disabled AND untrusted reports `disabled`, not the insufficient remedy", () => {
    expect(codexShapingStateFromHooks([hook({ enabled: false, trustStatus: "untrusted" })]).state).toBe("disabled");
  });

  it("ENABLED and untrusted is still `approval-required` - trust IS the remedy there", () => {
    expect(codexShapingStateFromHooks([hook({ enabled: true, trustStatus: "untrusted" })]).state).toBe("approval-required");
  });

  /**
   * IDENTITY. Only Compaction's own shaping entry may move this state. A user's unrelated
   * `userPromptSubmit` hook says nothing about whether OUR instruction is attached, and treating a
   * foreign trusted hook as ours would report shaping active on a machine we never shaped.
   */
  it("a FOREIGN userPromptSubmit hook, trusted, is not ours: not-installed", () => {
    expect(codexShapingStateFromHooks([hook({ command: "some-other-tool run" })])).toEqual({ state: "not-installed" });
  });

  it("a command that merely WRAPS ours is not ours (exact match, same rule install/uninstall use)", () => {
    expect(codexShapingStateFromHooks([hook({ command: `echo ${SHAPING}` })])).toEqual({ state: "not-installed" });
  });

  /**
   * Our `stop` turn-line hook is MODEL-INVISIBLE - it displays a receipt after the turn. It must never
   * satisfy a question about what the model sees, or a machine with only the line hook trusted would
   * report that an instruction is being attached when none is.
   */
  it("only the model-invisible `stop` line hook is present: not-installed for SHAPING purposes", () => {
    expect(
      codexShapingStateFromHooks([hook({ eventName: "stop", command: "compaction hooks line codex" })])
    ).toEqual({ state: "not-installed" });
  });

  it("our shaping command attached to a DIFFERENT event does not count as per-prompt shaping", () => {
    expect(codexShapingStateFromHooks([hook({ eventName: "sessionStart" })])).toEqual({ state: "not-installed" });
  });

  /**
   * Two configs can carry the hook (user-level and repo-local). ONE runnable copy is enough to mutate
   * what the model sees, so the strongest state wins - reporting `approval-required` because a second,
   * redundant copy is untrusted would tell the user nothing is attached while something is.
   */
  it("user-level trusted + repo-local untrusted: active (one runnable copy is enough)", () => {
    const r = codexShapingStateFromHooks([
      hook({ key: "local", trustStatus: "untrusted" }),
      hook({ key: "user", trustStatus: "trusted" })
    ]);
    expect(r.state).toBe("active");
  });

  it("both copies untrusted: approval-required", () => {
    const r = codexShapingStateFromHooks([
      hook({ key: "local", trustStatus: "untrusted" }),
      hook({ key: "user", trustStatus: "untrusted" })
    ]);
    expect(r.state).toBe("approval-required");
  });
});

describe("the native action Compaction directs the user to is Codex's own, quoted", () => {
  /**
   * These are not our phrasing to choose. They are the labels the installed Codex renders on its
   * startup hook-review screen (`tui/src/startup_hooks_review.rs`), and a paraphrase would send the
   * user hunting for a control that does not exist under the name we gave it.
   */
  it("names the heading and the control Codex actually shows", () => {
    expect(CODEX_TRUST_ACTION_HEADING).toBe("Hooks need review");
    expect(CODEX_TRUST_ACTION_CONTROL).toBe("Trust all and continue");
  });
});

/* ------------------------------------------------------------------------------------------------
 * The JSON-RPC client, against a stub that speaks the real contract.
 * ---------------------------------------------------------------------------------------------- */

let binDir: string;

/** A fake `codex` that answers `initialize` then `hooks/list` exactly as the real app-server does. */
function writeCodexStub(name: string, hooksJson: string, options: { hangForever?: boolean; garbage?: boolean } = {}): string {
  const file = join(binDir, name);
  const body = options.hangForever
    ? `setInterval(() => {}, 1000);`
    : options.garbage
      ? `process.stdin.on("data", () => process.stdout.write("this is not json\\n"));`
      : `
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
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { data: [ { cwd: process.cwd(), warnings: [], errors: [], hooks: ${hooksJson} } ] } }) + "\\n");
    }
  }
});
`;
  writeFileSync(file, `#!/usr/bin/env node\n${body}\n`, "utf8");
  chmodSync(file, 0o755);
  return file;
}

function stubHook(trustStatus: CodexHookTrustStatus): string {
  return JSON.stringify([
    {
      key: "user:0",
      eventName: "userPromptSubmit",
      handlerType: "command",
      command: SHAPING,
      timeoutSec: 10,
      enabled: true,
      isManaged: false,
      currentHash: "sha256:deadbeef",
      sourcePath: "/tmp/hooks.json",
      source: "user",
      displayOrder: 0,
      trustStatus
    }
  ]);
}

describe("queryCodexHooks / codexShapingHookTrust - reading Codex's own answer", () => {
  beforeEach(() => {
    binDir = mkdtempSync(join(tmpdir(), "compaction-codex-stub-"));
  });
  afterEach(() => {
    rmSync(binDir, { recursive: true, force: true });
  });

  /**
   * The stubs are `#!/usr/bin/env node` scripts, so the directory holding THIS process's node must stay
   * on PATH or they cannot start - and a stub that fails to start would answer `unknown`, quietly
   * turning the positive assertions vacuous. `binDir` is first, so `codex` still resolves to the stub.
   */
  function pathWith(...dirs: string[]): string {
    return [...dirs, dirname(process.execPath)].join(":");
  }

  function envWithStub(): NodeJS.ProcessEnv {
    // A Compaction home with no shim dir, so the resolver's shim exclusion has nothing to exclude and
    // the stub is what `codex` resolves to.
    return { PATH: pathWith(binDir), HOME: binDir, COMPACTION_HOME: join(binDir, "compaction-home") };
  }

  it("a trusted hook reported by Codex reaches us as active", async () => {
    writeCodexStub("codex", stubHook("trusted"));
    const r = await codexShapingHookTrust({ env: envWithStub(), cwd: binDir, timeoutMs: 20_000 });
    expect(r).toEqual({ state: "active", trustStatus: "trusted" });
  });

  it("an untrusted hook reported by Codex reaches us as approval-required", async () => {
    writeCodexStub("codex", stubHook("untrusted"));
    const r = await codexShapingHookTrust({ env: envWithStub(), cwd: binDir, timeoutMs: 20_000 });
    expect(r).toEqual({ state: "approval-required", trustStatus: "untrusted" });
  });

  it("the parsed metadata carries Codex's own fields through unchanged", async () => {
    writeCodexStub("codex", stubHook("trusted"));
    const hooks = await queryCodexHooks({ env: envWithStub(), cwd: binDir, timeoutMs: 20_000 });
    expect(hooks).toHaveLength(1);
    expect(hooks?.[0]).toMatchObject({
      eventName: "userPromptSubmit",
      command: SHAPING,
      enabled: true,
      trustStatus: "trusted",
      currentHash: "sha256:deadbeef"
    });
  });

  /* --- Every failure path must land on `unknown`, never on a claim. --- */

  it("no codex binary on PATH: unknown, with the reason named", async () => {
    const r = await codexShapingHookTrust({ env: { PATH: pathWith(binDir), HOME: binDir }, cwd: binDir, timeoutMs: 2_000 });
    expect(r).toEqual({ state: "unknown", unknownReason: "codex-not-found" });
  });

  it("a codex that never answers is killed at the timeout and reports unknown, not active", async () => {
    writeCodexStub("codex", "[]", { hangForever: true });
    const r = await codexShapingHookTrust({ env: envWithStub(), cwd: binDir, timeoutMs: 1_200 });
    expect(r.state).toBe("unknown");
  });

  it("a codex that answers unparseable output reports unknown, not active", async () => {
    writeCodexStub("codex", "[]", { garbage: true });
    const r = await codexShapingHookTrust({ env: envWithStub(), cwd: binDir, timeoutMs: 1_500 });
    expect(r.state).toBe("unknown");
  });

  it("a codex that exits immediately reports unknown, not active", async () => {
    const file = join(binDir, "codex");
    writeFileSync(file, "#!/usr/bin/env node\nprocess.exit(0);\n", "utf8");
    chmodSync(file, 0o755);
    const r = await codexShapingHookTrust({ env: envWithStub(), cwd: binDir, timeoutMs: 5_000 });
    expect(r.state).toBe("unknown");
  });

  /**
   * THE CRASH THIS PROBE ONCE CAUSED, pinned so it cannot come back.
   *
   * When `codex` is gone before our first write lands - it exits early, it is a stub, it is a wrapper
   * that fails - the write raises EPIPE. Node delivers that as an `error` EVENT ON THE STREAM, not as a
   * throw from `write()`, so a try/catch around the write cannot see it and an unhandled stream `error`
   * takes down the whole process. A probe was therefore deciding the exit code of `compaction init`:
   * two init suites went red on CI (`expected 1 to be +0`, and a config file init died before writing)
   * against a stub that was nothing more than `echo real`.
   *
   * It is a RACE - whether the child dies before or after the write - which is why it failed CI while
   * passing locally, and why this fixture forces the losing side deterministically: the stub DESTROYS
   * its stdin and then stays alive, so our write is guaranteed to hit a dead pipe.
   *
   * The assertion is not really the return value (`unknown` was always the intent). It is that we get a
   * value AT ALL rather than an uncaught exception, and that the process is still standing afterwards.
   */
  it("a codex whose stdin is already closed: resolves `unknown` and NEVER takes the process down", async () => {
    const file = join(binDir, "codex");
    writeFileSync(
      file,
      "#!/usr/bin/env node\nprocess.stdin.destroy();\nsetTimeout(() => process.exit(0), 3000);\n",
      "utf8"
    );
    chmodSync(file, 0o755);
    const r = await codexShapingHookTrust({ env: envWithStub(), cwd: binDir, timeoutMs: 6_000 });
    expect(r.state).toBe("unknown");
  });

  /**
   * The same invariant stated the way the caller depends on it: `init` installs the hook and then asks
   * this question, and NOTHING this returns - or fails to return - may change whether that command
   * succeeds. Hammering the hostile stub makes the race land at least once.
   */
  it("repeated probes against a hostile binary never reject", async () => {
    const file = join(binDir, "codex");
    writeFileSync(file, "#!/usr/bin/env bash\necho real\n", "utf8");
    chmodSync(file, 0o755);
    const results = await Promise.all(
      Array.from({ length: 12 }, () => codexShapingHookTrust({ env: envWithStub(), cwd: binDir, timeoutMs: 6_000 }))
    );
    expect(results.every((r) => r.state === "unknown")).toBe(true);
  });

  /**
   * The probe must never run THROUGH Compaction's own shim: the shim tees a measurable `codex` run into
   * the capture bridge, so probing through it would recurse and could record a synthetic run as the
   * user's. The shim dir is excluded exactly as the installer excludes it.
   */
  it("resolves the REAL binary, skipping Compaction's shim dir", async () => {
    const compactionHome = join(binDir, "compaction-home");
    const shimDir = join(compactionHome, "shims");
    mkdirSync(shimDir, { recursive: true });
    // A "shim" that would answer `untrusted` if it were ever consulted.
    writeCodexStub("codex", stubHook("untrusted"));
    const shimCopy = join(shimDir, "codex");
    writeFileSync(shimCopy, `#!/usr/bin/env node\nprocess.exit(9);\n`, "utf8");
    chmodSync(shimCopy, 0o755);

    // Shim dir FIRST on PATH: without the exclusion this resolves to the shim and fails.
    const r = await codexShapingHookTrust({
      env: { PATH: pathWith(shimDir, binDir), HOME: binDir, COMPACTION_HOME: compactionHome },
      cwd: binDir,
      timeoutMs: 20_000
    });
    expect(r.state).toBe("approval-required");
  });
});
