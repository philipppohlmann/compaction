import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { installToolShim, type ShimEnv } from "../../src/core/tool-shim.js";

const execFileAsync = promisify(execFile);

/**
 * End-to-end BEFORE-CALL safety, exercised through the ACTUAL generated bash shim with a synthetic
 * stub binary (tmp HOME/PATH; never a real ~/.compaction). These prove the shipped RECOMMENDATION-ONLY
 * invariants under the security-critical NON-INTERACTIVE (no-TTY) path: the real binary always runs on
 * the ORIGINAL input (no mutation), the before-call step is fail-open, and nothing content rides on the
 * store. The interactive /dev/tty [v] display is covered by the run's documented manual demo.
 */
const TSX = path.resolve("node_modules/.bin/tsx");
const CLI_ENTRY = path.resolve("src/cli/index.ts");
const NODE_DIR = path.dirname(process.execPath);

let root: string;
let realBinDir: string;
let home: string;
let projDir: string;
let compactionBin: string;

const BLOCK = "SHARED CONTEXT BLOCK long enough to clear the duplicate size floor in this before-call test.";
const SECRET = "SECRET_PROMPT_marker_zeta";
const DUP_PROMPT = `${BLOCK}\n\ndo the task with ${SECRET}, concisely.\n\n${BLOCK}`;

function env(pathValue: string, compBin: string): ShimEnv & {
  COMPACTION_BIN: string;
  TMPDIR: string;
  NO_COLOR: string;
  OPENAI_BASE_URL: string;
} {
  return {
    HOME: home,
    COMPACTION_HOME: path.join(home, ".compaction"),
    PATH: pathValue,
    COMPACTION_BIN: compBin,
    // This suite pins the legacy local precall/capture behavior under an explicit user route.
    // Normal no-override Codex subscription routing is covered by the dedicated shim suites.
    OPENAI_BASE_URL: "http://127.0.0.1:9999/v1",
    TMPDIR: root,
    NO_COLOR: "1"
  };
}

/** A stub `codex` that echoes its args (so we can prove no-mutation), emits usage, exits with code 3. */
function writeCodexStub(): void {
  const stub = `#!/usr/bin/env bash
echo "ARGS: $*"
echo '{"type":"turn.completed","thread_id":"th_bc_1","model":"gpt-5-codex","usage":{"input_tokens":900,"output_tokens":150}}'
echo "codex stub stderr" 1>&2
exit 3
`;
  const p = path.join(realBinDir, "codex");
  writeFileSync(p, stub, "utf8");
  chmodSync(p, 0o755);
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "shim-bc-"));
  realBinDir = path.join(root, "realbin");
  home = path.join(root, "home");
  projDir = path.join(root, "proj");
  mkdirSync(realBinDir, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(projDir, { recursive: true });
  writeCodexStub();
  // COMPACTION_BIN → the real CLI via tsx (so the before-call + measurement events actually land).
  compactionBin = path.join(root, "compaction-test");
  writeFileSync(compactionBin, `#!/usr/bin/env bash\nexec ${JSON.stringify(TSX)} ${JSON.stringify(CLI_ENTRY)} "$@"\n`, "utf8");
  chmodSync(compactionBin, 0o755);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function activityRaw(): string {
  const p = path.join(projDir, ".compaction", "activity", "activity.jsonl");
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}

async function runShim(shimPath: string, args: string[], compBin: string): Promise<{ stdout: string; stderr: string; code: number }> {
  const runPath = `${NODE_DIR}${path.delimiter}/usr/bin${path.delimiter}/bin`;
  try {
    const res = await execFileAsync("bash", [shimPath, ...args], { cwd: projDir, env: env(runPath, compBin) as unknown as NodeJS.ProcessEnv });
    return { stdout: res.stdout, stderr: res.stderr, code: 0 };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", code: typeof e.code === "number" ? e.code : 1 };
  }
}

describe("shim before-call (recommendation-only, no-TTY): NO mutation, fail-open, content-free", () => {
  it("a MEASURABLE run with avoidable context passes the ORIGINAL input to the real binary UNCHANGED", async () => {
    const install = installToolShim("codex", { HOME: home, COMPACTION_HOME: path.join(home, ".compaction"), PATH: realBinDir });
    const { stdout, stderr, code } = await runShim(install.shimPath, ["exec", "--json", DUP_PROMPT], compactionBin);

    // No-TTY → no prompt, no mutation: the stub echoes the FULL original prompt (BOTH duplicate blocks).
    expect(code).toBe(3); // transparency: real binary's exit code preserved
    expect(stderr).toContain("codex stub stderr"); // stderr passes straight through, unchanged
    expect(stdout).toContain(SECRET);
    expect(stdout.split(BLOCK).length - 1).toBe(2); // the duplicate block was NOT removed - original ran
  }, 15_000);

  it("records a content-free before-call activity event (secret/prompt never stored)", async () => {
    const install = installToolShim("codex", { HOME: home, COMPACTION_HOME: path.join(home, ".compaction"), PATH: realBinDir });
    await runShim(install.shimPath, ["exec", "--json", DUP_PROMPT], compactionBin);

    const raw = activityRaw();
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain("SHARED CONTEXT BLOCK");
    // At least one before-call event was recorded, honest local-estimate.
    const events = raw.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const beforeCall = events.find((e) => e.policy_used === "repeated_context_block_dedup");
    expect(beforeCall).toBeTruthy();
    expect(beforeCall.token_source.input.source).toBe("local-estimate");
    expect(beforeCall.recovery.original_retained).toBe(true);
    expect(beforeCall.auto_apply.applied_automatically).toBe(false);
  }, 15_000);

  it("FAIL-OPEN: when precall (COMPACTION_BIN) fails, the tool still runs on the ORIGINAL and preserves exit", async () => {
    const install = installToolShim("codex", { HOME: home, COMPACTION_HOME: path.join(home, ".compaction"), PATH: realBinDir });
    // A COMPACTION_BIN that always fails simulates a broken/erroring precall.
    const failingBin = path.join(root, "compaction-failing");
    writeFileSync(failingBin, `#!/usr/bin/env bash\nexit 1\n`, "utf8");
    chmodSync(failingBin, 0o755);

    const { stdout, code } = await runShim(install.shimPath, ["exec", "--json", DUP_PROMPT], failingBin);
    expect(code).toBe(3); // tool still ran, exit preserved
    expect(stdout).toContain(SECRET);
    expect(stdout.split(BLOCK).length - 1).toBe(2); // original input, unmutated
  });

  it("a NON-measurable (interactive) invocation is unchanged: no before-call step, passes through", async () => {
    const install = installToolShim("codex", { HOME: home, COMPACTION_HOME: path.join(home, ".compaction"), PATH: realBinDir });
    const { stdout, code } = await runShim(install.shimPath, ["--help"], compactionBin);
    expect(code).toBe(3);
    expect(stdout).toContain("ARGS: --help");
    // The non-measurable path never invokes precall → no before-call activity event.
    const events = activityRaw().trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(events.find((e) => e.policy_used === "repeated_context_block_dedup")).toBeUndefined();
  });
});
