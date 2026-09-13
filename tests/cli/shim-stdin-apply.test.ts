import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { installToolShim } from "../../src/core/tool-shim.js";

/**
 * End-to-end STDIN-BOUNDARY apply, exercised through the ACTUAL generated Codex shim.
 * Proves the shim's stream mediation: it feeds the real binary the COMPACTED stdin only when precall
 * wrote one (approval), and the ORIGINAL stdin otherwise, while preserving exit code, args, and
 * transparency. The approval itself needs /dev/tty (CI has none), so the "approved" case uses a fake
 * COMPACTION_BIN that writes to --compacted-out (standing in for an operator's `y`); the real-CLI case
 * proves the no-tty path feeds the original unchanged.
 */
const NODE_DIR = path.dirname(process.execPath);

const BLOCK = "SHARED CONTEXT BLOCK long enough to clear the duplicate size floor for sure here.";
const SECRET = "SECRET_STDIN_zeta_must_not_be_stored";
const dupStdin = `${BLOCK}\n\ndo the task with ${SECRET}, concisely.\n\n${BLOCK}`;

let root: string;
let realBinDir: string;
let home: string;
let projDir: string;

/** A stub `codex` that echoes its args AND its stdin (so the test can see which stream it received). */
function writeCodexStub(): void {
  const stub = `#!/usr/bin/env bash
echo "ARGS: $*"
__in="$(cat)"
printf 'STDIN<<%s>>STDIN\\n' "$__in"
echo '{"type":"turn.completed","thread_id":"th1","model":"gpt-5-codex","usage":{"input_tokens":900,"output_tokens":150}}'
exit 3
`;
  const p = path.join(realBinDir, "codex");
  writeFileSync(p, stub, "utf8");
  chmodSync(p, 0o755);
}

/**
 * A fake Compaction launcher that stands in for the precall decision and Gateway wrapper:
 * - `precall … --stdin-boundary-check …` → exit 0 (safe boundary) unless a positional prompt is present.
 * - `precall … --compacted-out C …` → optionally writes approved compacted content to C.
 * - `gateway run … -- REAL …` → execs that one real child with inherited stdio.
 * Every invocation is logged by command name so the tests can reject post-hoc capture/double routing.
 */
function fakeCompactionBin(compacted = ""): string {
  const bin = path.join(root, "compaction-fake");
  const calls = path.join(root, "compaction-calls");
  const script = `#!/usr/bin/env bash
printf '%s\n' "$1" >> ${JSON.stringify(calls)}
case "$1" in
  gateway)
    while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done
    [ "$#" -gt 0 ] && shift
    exec "$@"
    ;;
  precall)
    __check=0; __after=0; __positional=0; __out=""; __prev=""
    for __a in "$@"; do
      if [ "$__prev" = "--compacted-out" ]; then __out="$__a"; fi
      if [ "$__a" = "--stdin-boundary-check" ]; then __check=1; fi
      if [ "$__after" = "1" ]; then
        case "$__a" in exec|--json) ;; -*) ;; *) __positional=1 ;; esac
      fi
      if [ "$__a" = "--" ]; then __after=1; fi
      __prev="$__a"
    done
    if [ "$__check" = "1" ]; then [ "$__positional" = "0" ]; exit $?; fi
    if [ -n "$__out" ] && [ -n ${JSON.stringify(compacted)} ]; then printf '%s' ${JSON.stringify(compacted)} > "$__out"; fi
    exit 0
    ;;
  capture) exit 0 ;;
esac
exit 1
`;
  writeFileSync(bin, script, "utf8");
  chmodSync(bin, 0o755);
  return bin;
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "shim-stdin-"));
  realBinDir = path.join(root, "realbin");
  home = path.join(root, "home");
  projDir = path.join(root, "proj");
  mkdirSync(realBinDir, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(projDir, { recursive: true });
  writeCodexStub();
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function runShim(compactionBin: string, args: string[], input: string): Promise<{ stdout: string; code: number }> {
  const install = installToolShim("codex", { HOME: home, COMPACTION_HOME: path.join(home, ".compaction"), PATH: realBinDir });
  const runPath = `${NODE_DIR}${path.delimiter}/usr/bin${path.delimiter}/bin`;
  const env = {
    HOME: home,
    COMPACTION_HOME: path.join(home, ".compaction"),
    PATH: runPath,
    COMPACTION_BIN: compactionBin,
    TMPDIR: root,
    NO_COLOR: "1"
  } as unknown as NodeJS.ProcessEnv;
  // spawn (not execFile): the async execFile ignores `input`, so we must write stdin + end it ourselves
  // to give `cat` the EOF the stdin boundary needs.
  return new Promise((resolve) => {
    const child = spawn("bash", [install.shimPath, ...args], { cwd: projDir, env });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", () => {});
    child.on("close", (code) => resolve({ stdout, code: code ?? 1 }));
    child.stdin.write(input);
    child.stdin.end();
  });
}

function stubStdin(stdout: string): string {
  const m = /STDIN<<([\s\S]*)>>STDIN/.exec(stdout);
  return m ? m[1] : "";
}

describe("Codex shim precall + single Gateway inference (e2e, synthetic stub)", () => {
  it("APPROVED: the one gateway-routed real child receives compacted stdin, with no capture bridge", async () => {
    const compactedBin = fakeCompactionBin("COMPACTED_STDIN_CONTENT");
    const { stdout, code } = await runShim(compactedBin, ["exec", "--json"], dupStdin);
    expect(code).toBe(3); // exit preserved
    expect(stdout).toContain("ARGS: exec --json");
    expect(stubStdin(stdout)).toBe("COMPACTED_STDIN_CONTENT");
    const calls = readFileSync(path.join(root, "compaction-calls"), "utf8").trim().split("\n");
    expect(calls.filter((call) => call === "gateway")).toHaveLength(1);
    expect(calls).not.toContain("capture");
  });

  it("NO approval: the one gateway-routed child receives original stdin unchanged", async () => {
    const { stdout, code } = await runShim(fakeCompactionBin(), ["exec", "--json"], dupStdin);
    expect(code).toBe(3);
    expect(stubStdin(stdout)).toBe(dupStdin); // byte-for-byte original - nothing applied without approval
    const calls = readFileSync(path.join(root, "compaction-calls"), "utf8").trim().split("\n");
    expect(calls.filter((call) => call === "gateway")).toHaveLength(1);
    expect(calls).not.toContain("capture");
    // No shim-local capture/activity file is created; the Gateway receipt is the single measurement.
    const activity = path.join(projDir, ".compaction", "activity", "activity.jsonl");
    const raw = existsSync(activity) ? readFileSync(activity, "utf8") : "";
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain("SHARED CONTEXT BLOCK");
  }, 15_000);

  it("preserves positional prompts and original stdin", async () => {
    const { stdout, code } = await runShim(fakeCompactionBin("MUST_NOT_APPLY"), ["exec", "--json", "a positional prompt"], dupStdin);
    expect(code).toBe(3);
    expect(stubStdin(stdout)).toBe(dupStdin); // original stdin, never a compacted stream
    const calls = readFileSync(path.join(root, "compaction-calls"), "utf8").trim().split("\n");
    expect(calls.filter((call) => call === "gateway")).toHaveLength(1);
    expect(calls).not.toContain("capture");
  }, 15_000);
});
