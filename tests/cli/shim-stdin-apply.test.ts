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
const TSX = path.resolve("node_modules/.bin/tsx");
const CLI_ENTRY = path.resolve("src/cli/index.ts");
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

/** The REAL compaction CLI as COMPACTION_BIN (no tty → never applies). */
function realCompactionBin(): string {
  const bin = path.join(root, "compaction-real");
  writeFileSync(bin, `#!/usr/bin/env bash\nexec ${JSON.stringify(TSX)} ${JSON.stringify(CLI_ENTRY)} "$@"\n`, "utf8");
  chmodSync(bin, 0o755);
  return bin;
}

/**
 * A FAKE compaction bin that stands in for an operator approval WITHOUT a tty:
 * - `precall … --stdin-boundary-check …` → exit 0 (safe boundary) unless a positional prompt is present.
 * - `precall … --stdin-file S --compacted-out C …` → writes COMPACTED content to C (simulated approval).
 * Everything else is a no-op exit 0. It NEVER reads the tool's stdin.
 */
function fakeApprovingCompactionBin(compacted: string): string {
  const bin = path.join(root, "compaction-fake");
  const script = `#!/usr/bin/env bash
__out=""
__is_check=0
for __a in "$@"; do
  case "$__a" in
    --stdin-boundary-check) __is_check=1 ;;
  esac
done
# find --compacted-out value
__prev=""
for __a in "$@"; do
  if [ "$__prev" = "--compacted-out" ]; then __out="$__a"; fi
  __prev="$__a"
done
if [ "$__is_check" = "1" ]; then exit 0; fi
if [ -n "$__out" ]; then printf '%s' ${JSON.stringify(compacted)} > "$__out"; fi
exit 0
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

describe("shim stdin-boundary apply (e2e, synthetic stub + generated Codex shim)", () => {
  it("APPROVED (fake approval writes compacted-out): the real binary receives the COMPACTED stdin", async () => {
    const compactedBin = fakeApprovingCompactionBin("COMPACTED_STDIN_CONTENT");
    const { stdout, code } = await runShim(compactedBin, ["exec", "--json"], dupStdin);
    expect(code).toBe(3); // exit preserved
    expect(stdout).toContain("ARGS: exec --json");
    expect(stubStdin(stdout)).toBe("COMPACTED_STDIN_CONTENT"); // the shim swapped in the compacted stream
    // the original secret never reached the tool (it was "compacted" away by the fake) and is not in stdout
    expect(stdout).not.toContain(SECRET);
  });

  it("NO approval (real CLI, no tty): the real binary receives the ORIGINAL stdin UNCHANGED", async () => {
    const { stdout, code } = await runShim(realCompactionBin(), ["exec", "--json"], dupStdin);
    expect(code).toBe(3);
    expect(stubStdin(stdout)).toBe(dupStdin); // byte-for-byte original - nothing applied without approval
    // a content-free before-call event was still recorded (no-tty, not-asked); no prompt/secret stored
    const activity = path.join(projDir, ".compaction", "activity", "activity.jsonl");
    const raw = existsSync(activity) ? readFileSync(activity, "utf8") : "";
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain("SHARED CONTEXT BLOCK");
  }, 15_000);

  it("UNSAFE boundary (positional prompt): the real probe returns 1 → shim never buffers; ORIGINAL stdin", async () => {
    // The REAL CLI's argv-only boundary probe returns 1 for a positional prompt, so the shim skips the
    // stdin path entirely and the tool runs with inherited (original) stdin - no mutation, no hang.
    const { stdout, code } = await runShim(realCompactionBin(), ["exec", "--json", "a positional prompt"], dupStdin);
    expect(code).toBe(3);
    expect(stubStdin(stdout)).toBe(dupStdin); // original stdin, never a compacted stream
  }, 15_000);
});
