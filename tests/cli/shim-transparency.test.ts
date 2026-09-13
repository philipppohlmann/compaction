import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { installToolShim, type ShimEnv } from "../../src/core/tool-shim.js";

const execFileAsync = promisify(execFile);

/**
 * End-to-end shim TRANSPARENCY + always-on measurement, exercised through the ACTUAL generated bash
 * shim with a synthetic stub binary. Synthetic-only: tmp HOME/PATH, never a real ~/.compaction, never
 * `compaction import` (the whole point, a subsequent measurable run appears in `compaction activity`
 * with NO manual import).
 */
const TSX = path.resolve("node_modules/.bin/tsx");
const CLI_ENTRY = path.resolve("src/cli/index.ts");
const NODE_DIR = path.dirname(process.execPath);

let root: string;
let realBinDir: string;
let home: string;
let projDir: string;
let compactionBin: string;

function env(pathValue: string): ShimEnv & {
  COMPACTION_BIN: string;
  TMPDIR: string;
  NO_COLOR: string;
  OPENAI_BASE_URL: string;
} {
  return {
    HOME: home,
    COMPACTION_HOME: path.join(home, ".compaction"),
    PATH: pathValue,
    COMPACTION_BIN: compactionBin,
    // Preserve this capture-only compatibility contract when the user owns the upstream route.
    // The no-override subscription route has its own end-to-end transparency coverage.
    OPENAI_BASE_URL: "http://127.0.0.1:9999/v1",
    TMPDIR: root,
    NO_COLOR: "1"
  };
}

/** A stub `codex` that echoes its args (transparency), injects SECRET content (content-free proof),
 *  emits provider usage, writes to stderr, and exits with a DISTINCT code (to prove preservation). */
function writeCodexStub(): void {
  const stub = `#!/usr/bin/env bash
echo "ARGS: $*"
echo '{"type":"item.completed","item":{"type":"agent_message","text":"SECRET_RESP_zeta must not be stored"}}'
echo '{"type":"turn.completed","thread_id":"th_e2e_1","model":"gpt-5-codex","usage":{"input_tokens":900,"cached_input_tokens":50,"output_tokens":150,"reasoning_output_tokens":5}}'
echo "codex stub stderr" 1>&2
exit 3
`;
  const p = path.join(realBinDir, "codex");
  writeFileSync(p, stub, "utf8");
  chmodSync(p, 0o755);
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "shim-e2e-"));
  realBinDir = path.join(root, "realbin");
  home = path.join(root, "home");
  projDir = path.join(root, "proj");
  mkdirSync(realBinDir, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(projDir, { recursive: true });
  writeCodexStub();
  // COMPACTION_BIN stub → the real CLI via tsx (so the activity event actually lands, no import).
  compactionBin = path.join(root, "compaction-test");
  writeFileSync(compactionBin, `#!/usr/bin/env bash\nexec ${JSON.stringify(TSX)} ${JSON.stringify(CLI_ENTRY)} "$@"\n`, "utf8");
  chmodSync(compactionBin, 0o755);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function activityLines(): string[] {
  const p = path.join(projDir, ".compaction", "activity", "activity.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").trim().split("\n").filter(Boolean);
}

describe("shim transparency + always-on measurement (e2e, synthetic stub binary)", () => {
  it("a MEASURABLE run: preserves exit code + stdout + stderr + args AND records ONE metrics-only event (no import)", async () => {
    const install = installToolShim("codex", { HOME: home, COMPACTION_HOME: path.join(home, ".compaction"), PATH: realBinDir });
    expect(install.status).toBe("installed-not-on-path");
    const runPath = `${NODE_DIR}${path.delimiter}/usr/bin${path.delimiter}/bin`;

    let stdout = "";
    let stderr = "";
    let code = 0;
    try {
      const res = await execFileAsync("bash", [install.shimPath, "exec", "--json", "add feature X"], {
        cwd: projDir,
        env: env(runPath) as unknown as NodeJS.ProcessEnv
      });
      stdout = res.stdout;
      stderr = res.stderr;
    } catch (error) {
      const e = error as { code?: number; stdout?: string; stderr?: string };
      code = typeof e.code === "number" ? e.code : 1;
      stdout = e.stdout ?? "";
      stderr = e.stderr ?? "";
    }

    // Transparency: exit code, stdout, stderr, and args all preserved verbatim.
    expect(code).toBe(3);
    expect(stdout).toContain("ARGS: exec --json add feature X");
    expect(stdout).toContain("turn.completed");
    expect(stderr).toContain("codex stub stderr");

    // Always-on: ONE metrics-only event landed via the shim → capture bridge, with NO `import` call.
    const lines = activityLines();
    expect(lines).toHaveLength(1);
    const event = JSON.parse(lines[0]);
    expect(event.surface).toBe("codex");
    expect(event.token_source.input.source).toBe("provider-reported");
    expect(event.input_before).toBe(900);
    expect(event.output_before).toBe(150);

    // CONTENT-FREE: neither the injected response text nor the prompt is anywhere in the store.
    const raw = readFileSync(path.join(projDir, ".compaction", "activity", "activity.jsonl"), "utf8");
    expect(raw).not.toContain("SECRET_RESP_zeta");
    expect(raw).not.toContain("add feature X");
  }, 15_000);

  it("an INTERACTIVE / non-measurable run passes through and records NOTHING (never faked)", async () => {
    const install = installToolShim("codex", { HOME: home, COMPACTION_HOME: path.join(home, ".compaction"), PATH: realBinDir });
    const runPath = `${NODE_DIR}${path.delimiter}/usr/bin${path.delimiter}/bin`;

    let code = 0;
    let stdout = "";
    try {
      const res = await execFileAsync("bash", [install.shimPath, "--help"], {
        cwd: projDir,
        env: env(runPath) as unknown as NodeJS.ProcessEnv
      });
      stdout = res.stdout;
    } catch (error) {
      const e = error as { code?: number; stdout?: string };
      code = typeof e.code === "number" ? e.code : 1;
      stdout = e.stdout ?? "";
    }
    // Still transparent (the stub echoes + exits 3), but NOT measured.
    expect(code).toBe(3);
    expect(stdout).toContain("ARGS: --help");
    expect(activityLines()).toHaveLength(0);
  });
});
