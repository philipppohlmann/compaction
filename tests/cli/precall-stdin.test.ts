import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { analyzeBeforeCall } from "../../src/core/before-call.js";
import { planStdinApply } from "../../src/core/before-call-stdin.js";
import { retainOriginalPrompt } from "../../src/core/before-call-recovery.js";
import { buildBeforeCallActivityEvent } from "../../src/core/before-call-activity.js";
import { validateActivityEvent } from "../../src/core/activity-event.js";

/**
 * STDIN-BOUNDARY apply mode of `compaction precall`, driven through the REAL CLI. The
 * approve arm (which reads /dev/tty) is proven at the pure-planner level + the retention/activity
 * invariants, as the argv approve arm is (precall-apply.test.ts), CI has no tty.
 */
const execFileAsync = promisify(execFile);
const TSX = path.resolve("node_modules/.bin/tsx");
const CLI_ENTRY = path.resolve("src/cli/index.ts");

const BLOCK = "SHARED CONTEXT BLOCK that is long enough to clear the duplicate size floor here.";
const SECRET = "SECRET_STDIN_marker_do_not_store";
const dupStdin = `${BLOCK}\n\ndo the task with ${SECRET} inside, concisely.\n\n${BLOCK}`;

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(path.join(tmpdir(), "precall-stdin-"));
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function activityRaw(): string {
  const p = path.join(cwd, ".compaction", "activity", "activity.jsonl");
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}

/** Run `compaction precall codex …` non-interactively (no tty in CI); returns the process exit code. */
async function runPrecall(args: string[]): Promise<number> {
  try {
    await execFileAsync(TSX, [CLI_ENTRY, "precall", ...args], { cwd, env: { ...process.env, NO_COLOR: "1" } });
    return 0;
  } catch (error) {
    const e = error as { code?: number };
    return typeof e.code === "number" ? e.code : 1;
  }
}

describe("precall --stdin-boundary-check (argv-only probe; reads no stdin)", () => {
  it("exit 0 for the safe boundary: `codex exec --json` with no positional prompt", async () => {
    expect(await runPrecall(["codex", "--stdin-boundary-check", "--", "exec", "--json"])).toBe(0);
  });
  it("exit 0 for the explicit `-` stdin marker", async () => {
    expect(await runPrecall(["codex", "--stdin-boundary-check", "--", "exec", "--json", "-"])).toBe(0);
  });
  it("exit 1 when a positional prompt is present (stdin is not the whole prompt)", async () => {
    expect(await runPrecall(["codex", "--stdin-boundary-check", "--", "exec", "--json", "the prompt"])).toBe(1);
  });
  it("exit 1 for Cursor (no documented stdin boundary)", async () => {
    expect(await runPrecall(["cursor", "--stdin-boundary-check", "--", "-p", "--output-format", "json"])).toBe(1);
  });
});

describe("precall --stdin-file (no TTY): NEVER applies; feeds the ORIGINAL stdin; honest content-free event", () => {
  it("safe boundary + avoidable context, no tty → compacted-out stays EMPTY (shim feeds the original)", async () => {
    const sfile = path.join(cwd, "stdin.txt");
    const cfile = path.join(cwd, "compacted.txt");
    writeFileSync(sfile, dupStdin, "utf8");
    const code = await runPrecall(["codex", "--interactive", "0", "--stdin-file", sfile, "--compacted-out", cfile, "--", "exec", "--json"]);
    expect(code).toBe(0);
    // No approval possible without a tty → nothing written to the compacted channel → shim feeds original.
    expect(existsSync(cfile) ? statSync(cfile).size : 0).toBe(0);

    const lines = activityRaw().trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    const event = JSON.parse(lines[0]);
    expect(event.surface).toBe("codex");
    expect(event.approval_status).toBe("not-asked");
    expect(event.auto_apply.applied_automatically).toBe(false);
    expect(event.input_before).toBeGreaterThan(event.input_after);
    expect(event.token_source.input.source).toBe("local-estimate");
    // CONTENT-FREE: neither the stdin prompt nor the secret is ever stored.
    expect(activityRaw()).not.toContain(SECRET);
    expect(activityRaw()).not.toContain("SHARED CONTEXT BLOCK");
    expect(activityRaw()).toContain("no interactive terminal");
  });

  it("UNSAFE boundary (positional prompt) → compacted-out EMPTY; falls back to the argv recommendation", async () => {
    const sfile = path.join(cwd, "stdin.txt");
    const cfile = path.join(cwd, "compacted.txt");
    writeFileSync(sfile, "irrelevant appended stdin block", "utf8");
    const code = await runPrecall([
      "codex", "--interactive", "0", "--stdin-file", sfile, "--compacted-out", cfile, "--", "exec", "--json", dupStdin
    ]);
    expect(code).toBe(0);
    expect(existsSync(cfile) ? statSync(cfile).size : 0).toBe(0); // never mutated
    // The argv recommendation still fired for the positional prompt (existing behavior preserved).
    const lines = activityRaw().trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).approval_status).toBe("not-asked");
    expect(activityRaw()).not.toContain(SECRET);
  });

  it("HONESTY: --stdin-file with NO --compacted-out never records applied:true (nothing can be applied)", async () => {
    // Direct-CLI misuse (the shim always passes --compacted-out). Even if a tty approved, with no channel
    // to write the compacted stdin NOTHING is applied - the event must not claim applied:true.
    const sfile = path.join(cwd, "stdin.txt");
    writeFileSync(sfile, dupStdin, "utf8");
    const code = await runPrecall(["codex", "--interactive", "0", "--stdin-file", sfile, "--", "exec", "--json"]);
    expect(code).toBe(0);
    const lines = activityRaw().trim().split("\n").filter(Boolean);
    if (lines.length > 0) {
      const event = JSON.parse(lines[0]);
      expect(event.auto_apply.applied_automatically).toBe(false);
      expect(event.approval_status).not.toBe("asked-approved"); // no tty here → not-asked anyway
    }
    expect(activityRaw()).not.toContain(SECRET);
  });

  it("safe boundary but NO avoidable context → compacted-out EMPTY and NO activity noise", async () => {
    const sfile = path.join(cwd, "stdin.txt");
    const cfile = path.join(cwd, "compacted.txt");
    writeFileSync(sfile, "one small clean unique instruction, nothing repeated at all", "utf8");
    const code = await runPrecall(["codex", "--interactive", "0", "--stdin-file", sfile, "--compacted-out", cfile, "--", "exec", "--json"]);
    expect(code).toBe(0);
    expect(existsSync(cfile) ? statSync(cfile).size : 0).toBe(0);
    expect(activityRaw()).toBe("");
  });
});

describe("stdin approve invariants (pure planner + retention + activity - the arm CI cannot tty-drive)", () => {
  it("APPROVE → compacted stdin replaces the stream; original retained; activity content-safe (boundary=stdin)", () => {
    const rec = analyzeBeforeCall("codex", dupStdin);
    expect(rec.has_avoidable_context).toBe(true);

    const plan = planStdinApply({ tool: "codex", argv: ["exec", "--json"], stdinContent: dupStdin, interactive: true, decide: () => "apply" });
    expect(plan.emit).toBe("compacted");
    expect(plan.compacted).toBe(rec.compacted_input);
    expect(plan.compacted!.length).toBeLessThan(dupStdin.length);

    // The ORIGINAL stdin is retained locally + recoverable (the secret lives ONLY in the recovery file).
    const retained = retainOriginalPrompt(dupStdin, { cwd });
    expect(readFileSync(retained.recoveryPath, "utf8")).toBe(dupStdin);
    expect(readFileSync(retained.recoveryPath, "utf8")).toContain(SECRET);

    const event = buildBeforeCallActivityEvent({
      tool: "codex",
      recommendation: rec,
      approvalStatus: "asked-approved",
      applied: true,
      recoveryPointer: retained.pointer,
      boundary: "stdin"
    });
    expect(validateActivityEvent(event).problems).toEqual([]);
    expect(event.approval_status).toBe("asked-approved");
    expect(event.recovery?.location).toBe(retained.pointer);
    expect(event.auto_apply?.applied_automatically).toBe(false); // manual approval, never auto
    const raw = JSON.stringify(event);
    expect(raw).toContain("stdin prompt STREAM"); // honest boundary wording
    expect(raw).not.toContain(SECRET); // content-free
    expect(raw).not.toContain(BLOCK);
    expect(raw).toContain(retained.pointer);
  });
});
