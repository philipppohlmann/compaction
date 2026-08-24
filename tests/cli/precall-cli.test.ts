import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const execFileAsync = promisify(execFile);
const TSX = path.resolve("node_modules/.bin/tsx");
const CLI_ENTRY = path.resolve("src/cli/index.ts");

let cwd: string;

const BLOCK = "SHARED CONTEXT BLOCK that is long enough to clear the duplicate size floor here.";
const SECRET = "SECRET_PROMPT_marker_do_not_store";
const dupPrompt = `${BLOCK}\n\ndo the task with ${SECRET} inside, concisely.\n\n${BLOCK}`;

/** Run `compaction precall <tool> --interactive 0 -- <argv…>` non-interactively (no TTY). */
async function runPrecall(tool: string, argv: string[]): Promise<{ stdoutRaw: Buffer; code: number }> {
  try {
    const res = await execFileAsync(TSX, [CLI_ENTRY, "precall", tool, "--interactive", "0", "--", ...argv], {
      cwd,
      encoding: "buffer",
      env: { ...process.env, NO_COLOR: "1" }
    });
    return { stdoutRaw: res.stdout as Buffer, code: 0 };
  } catch (error) {
    const e = error as { code?: number; stdout?: Buffer };
    return { stdoutRaw: e.stdout ?? Buffer.alloc(0), code: typeof e.code === "number" ? e.code : 1 };
  }
}

function activityRaw(): string {
  const p = path.join(cwd, ".compaction", "activity", "activity.jsonl");
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}

beforeEach(() => {
  cwd = mkdtempSync(path.join(tmpdir(), "precall-cli-"));
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("compaction precall (recommendation-only, non-interactive)", () => {
  it("avoidable context: emits the ORIGINAL argv NUL-delimited unchanged (no mutation) and exits 0", async () => {
    const argv = ["exec", "--json", dupPrompt];
    const { stdoutRaw, code } = await runPrecall("codex", argv);
    expect(code).toBe(0);
    // stdout is exactly the original argv, NUL-delimited (byte-safe) - the input was NOT mutated.
    const emitted = stdoutRaw.toString("utf8").split("\0").filter((s, i, a) => !(i === a.length - 1 && s === ""));
    expect(emitted).toEqual(argv);
  });

  it("avoidable context: records ONE content-free activity event with honest local-estimate labels", async () => {
    await runPrecall("codex", ["exec", "--json", dupPrompt]);
    const raw = activityRaw();
    const lines = raw.trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    const event = JSON.parse(lines[0]);
    expect(event.surface).toBe("codex");
    expect(event.policy_used).toBe("repeated_context_block_dedup");
    expect(event.token_source.input.source).toBe("local-estimate");
    expect(event.token_source.output.source).toBe("unavailable");
    expect(event.input_before).toBeGreaterThan(event.input_after);
    // No TTY + real Codex form (bare-positional prompt) → apply NOT available → we did not ask.
    expect(event.approval_status).toBe("not-asked");
    expect(event.auto_apply.applied_automatically).toBe(false);
    expect(event.recovery.original_retained).toBe(true);
    expect(event.sync_status).toBe("local-only");
    expect(event.evidence_level).toContain("local-estimate");
    // Honest: the not-available reason is recorded, content-free, and the original ran unchanged.
    expect(raw).toContain("apply not-available");
    expect(raw).toContain("original input ran UNCHANGED");
    // Honest: no billing-confirmed / provider-reported claim anywhere on the event.
    expect(raw).toContain("NOT billing-confirmed");
    expect(raw).toContain("NOT provider-reported");
    expect(raw).not.toMatch(/"provider_reported_tokens":true/);
  });

  it("real tools are apply-NOT-available: cursor -p form emits the ORIGINAL argv and records not-asked", async () => {
    const argv = ["-p", dupPrompt, "--output-format", "json"];
    const { stdoutRaw, code } = await runPrecall("cursor", argv);
    expect(code).toBe(0);
    const emitted = stdoutRaw.toString("utf8").split("\0").filter((s, i, a) => !(i === a.length - 1 && s === ""));
    expect(emitted).toEqual(argv); // NEVER mutated - the original passes through
    const lines = activityRaw().trim().split("\n").filter(Boolean);
    const event = JSON.parse(lines[0]);
    expect(event.approval_status).toBe("not-asked");
    expect(activityRaw()).not.toContain(SECRET); // still content-free
  });

  it("CONTENT-FREE: neither the prompt nor the injected secret ever reaches the activity store", async () => {
    await runPrecall("codex", ["exec", "--json", dupPrompt]);
    const raw = activityRaw();
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain("SHARED CONTEXT BLOCK");
    expect(raw).not.toContain("do the task with");
  });

  it("no avoidable context: emits the ORIGINAL and records NO activity (honest, no noise)", async () => {
    const argv = ["exec", "--json", "just one small clean task with no repeats here at all"];
    const { stdoutRaw, code } = await runPrecall("codex", argv);
    expect(code).toBe(0);
    const emitted = stdoutRaw.toString("utf8").split("\0").filter((s, i, a) => !(i === a.length - 1 && s === ""));
    expect(emitted).toEqual(argv);
    expect(activityRaw()).toBe("");
  });

  it("cursor: local-estimate input; output unavailable-with-reason (never provider-reported)", async () => {
    await runPrecall("cursor", ["-p", dupPrompt, "--output-format", "json"]);
    const lines = activityRaw().trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    const event = JSON.parse(lines[0]);
    expect(event.surface).toBe("cursor");
    expect(event.token_source.input.source).toBe("local-estimate");
    expect(event.token_source.output.source).toBe("unavailable");
    expect(event.token_source.output.unavailable_reason).toBeTruthy();
  });

  it("fail-open: an unknown tool emits the ORIGINAL argv and exits 0 (never breaks the caller)", async () => {
    const argv = ["exec", "--json", "whatever"];
    const { stdoutRaw, code } = await runPrecall("not-a-tool", argv);
    expect(code).toBe(0);
    const emitted = stdoutRaw.toString("utf8").split("\0").filter((s, i, a) => !(i === a.length - 1 && s === ""));
    expect(emitted).toEqual(argv);
    expect(activityRaw()).toBe("");
  });
});
