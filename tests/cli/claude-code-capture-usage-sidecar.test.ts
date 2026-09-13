import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * `compaction capture claude-code` writes the SAME content-free `capture-usage.json` sidecar the
 * codex/cursor capture paths write (via the shared `writeCaptureUsageSidecar` helper in
 * `src/core/capture-record.ts`), so a real Claude Code session can be ingested into the shipped
 * `output-shaping-ab` harness. Before this fix the claude-code path wrote `captured-trace.json` +
 * `capture-report.json` + `capture-report.md` but NO sidecar, so it could never be ingested.
 *
 * Fixtures are realistic session rows (not minimal neutral stubs):
 *   - `claude-code-session-repeated-tool.jsonl` carries real per-request `usage` blocks on every
 *     assistant message (provider-reported).
 *   - `claude-code-session-no-usage.jsonl` is the same shape of session (title, user turn, tool use,
 *     tool result, follow-up turns) with the `usage` field genuinely absent from every assistant
 *     message, exercising the adapter's honest "missing" path (never an invented 0).
 *
 * No claim, threshold, or A/B summary-math wording is touched or asserted here beyond what the
 * shipped `output-shaping-ab status` command already prints.
 */
const execFileAsync = promisify(execFile);
const CLI = resolve("dist/cli/index.js");
const REPEAT_FIXTURE = resolve("tests/fixtures/claude-code-session-repeated-tool.jsonl");
const NO_USAGE_FIXTURE = resolve("tests/fixtures/claude-code-session-no-usage.jsonl");

interface CaptureUsageSidecarShape {
  schema: string;
  tool: string;
  provider?: string;
  model?: string;
  inputTokens: number | null;
  outputTokens: number | null;
  providerReported: boolean;
  tokenSource: string;
  tokenMetadataStatus: "present" | "missing";
  outputShaping?: unknown;
  generatedAt: string;
}

async function run(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync("node", [CLI, ...args], { cwd });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: err.stdout ?? "", stderr: err.stderr ?? "", code: err.code ?? 1 };
  }
}

describe("capture claude-code writes the capture-usage.json sidecar", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cc-capture-usage-sidecar-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("a session WITH provider-reported usage writes tool=claude-code, providerReported=true, correct counts, tokenMetadataStatus=present, and prints the sidecar path", async () => {
    const outDir = join(dir, "captured");
    const { stdout, code } = await run(["capture", "claude-code", "--session", REPEAT_FIXTURE, "--out", outDir], dir);
    expect(code).toBe(0);

    const sidecarPath = join(outDir, "capture-usage.json");
    expect(stdout).toContain(`Wrote ${sidecarPath}`);

    const sidecar = JSON.parse(await readFile(sidecarPath, "utf8")) as CaptureUsageSidecarShape;
    expect(sidecar.schema).toBe("compaction.capture-usage.v1");
    expect(sidecar.tool).toBe("claude-code");
    expect(sidecar.providerReported).toBe(true);
    expect(sidecar.tokenMetadataStatus).toBe("present");
    expect(sidecar.tokenSource).toBe("provider-reported");
    expect(typeof sidecar.inputTokens).toBe("number");
    expect(typeof sidecar.outputTokens).toBe("number");
    expect(sidecar.inputTokens).toBeGreaterThan(0);
    expect(sidecar.outputTokens).toBeGreaterThan(0);

    // Counts must match the totals the command itself printed for the same run (cross-check against
    // the honest "Token totals" line rather than a hardcoded number, so the assertion tracks the
    // fixture instead of a stale constant).
    const totalsMatch = stdout.match(/Token totals: input=(\d+), output=(\d+)/);
    expect(totalsMatch).not.toBeNull();
    expect(sidecar.inputTokens).toBe(Number(totalsMatch?.[1]));
    expect(sidecar.outputTokens).toBe(Number(totalsMatch?.[2]));

    // No policy attribution is invented for Claude Code at this call site.
    expect(sidecar.outputShaping).toBeUndefined();
  });

  it("a session with NO usage metadata writes null tokens, providerReported=false, tokenMetadataStatus=missing (never invents 0)", async () => {
    const outDir = join(dir, "captured-no-usage");
    const { stdout, code } = await run(["capture", "claude-code", "--session", NO_USAGE_FIXTURE, "--out", outDir], dir);
    expect(code).toBe(0);

    const sidecarPath = join(outDir, "capture-usage.json");
    expect(stdout).toContain(`Wrote ${sidecarPath}`);

    const sidecar = JSON.parse(await readFile(sidecarPath, "utf8")) as CaptureUsageSidecarShape;
    expect(sidecar.tool).toBe("claude-code");
    expect(sidecar.providerReported).toBe(false);
    expect(sidecar.tokenMetadataStatus).toBe("missing");
    // Falsifies the "invent 0" failure mode: unavailable tokens must be null, never 0.
    expect(sidecar.inputTokens).toBeNull();
    expect(sidecar.outputTokens).toBeNull();
    expect(sidecar.outputShaping).toBeUndefined();
  });

  it("the resulting sidecar is accepted by `output-shaping-ab add` and yields a real observed summary", async () => {
    const outDir = join(dir, "captured-for-ab");
    const capture = await run(["capture", "claude-code", "--session", REPEAT_FIXTURE, "--out", outDir], dir);
    expect(capture.code).toBe(0);
    const sidecarPath = join(outDir, "capture-usage.json");

    const experimentPath = join(dir, "experiment.json");
    const init = await run(
      ["output-shaping-ab", "init", "--experiment", "claude-code-sidecar-test", "--out", experimentPath, "--task-shape", "test-shape"],
      dir
    );
    expect(init.code).toBe(0);

    const add = await run(
      ["output-shaping-ab", "add", "--experiment", experimentPath, "--arm", "control", "--usage", sidecarPath],
      dir
    );
    expect(add.code).toBe(0);
    // Ingestion succeeds and reports the provider-reported source (no "unavailable" warning path).
    expect(add.stdout).toContain("Added control run:");
    expect(add.stdout).toContain("source=provider-reported");
    expect(add.stdout).not.toMatch(/not provider-reported/);

    const status = await run(["output-shaping-ab", "status", "--experiment", experimentPath], dir);
    expect(status.code).toBe(0);
    // A real observed summary: one control run, an actual (non-"unavailable") output-token figure from
    // the ingested claude-code sidecar. (The summary-level `token_source` requires BOTH arms to be
    // provider-reported before it reports anything but "unavailable" - a single-arm ingestion correctly
    // stays "unavailable" there; that is the A/B harness's own semantics, unchanged by this PR.)
    expect(status.stdout).toMatch(/N \(control \/ treatment\):\s+1 \/ 0/);
    expect(status.stdout).not.toMatch(/output_tokens_before:\s+unavailable/);
    const beforeMatch = status.stdout.match(/output_tokens_before:\s+(\d+)/);
    expect(beforeMatch).not.toBeNull();
    expect(Number(beforeMatch?.[1])).toBeGreaterThan(0);
  });
});
