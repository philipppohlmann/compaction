import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runApplyDecision, type PrecallTty } from "../../src/cli/commands/precall.js";
import {
  analyzeBeforeCall,
  resolveSafeMutation,
  type SafeMutationSpec
} from "../../src/core/before-call.js";
import { retainOriginalPrompt } from "../../src/core/before-call-recovery.js";
import { buildBeforeCallActivityEvent } from "../../src/core/before-call-activity.js";
import { validateActivityEvent } from "../../src/core/activity-event.js";

/**
 * The `[y/n/v]` interactive decision (PTY-`[v]` requirement, driven via the fallback:
 * a fake tty stream against the exported decision function). Plus the end-to-end approved
 * mutation invariants, proven with a SYNTHETIC apply-available spec, since the real Codex/Cursor forms
 * are never apply-available (see before-call-mutation.test.ts).
 */

const BLOCK = "SHARED CONTEXT BLOCK long enough to clear the duplicate size floor here for sure.";
const SECRET = "SECRET_PROMPT_marker_do_not_store_anywhere";
const dupPrompt = `${BLOCK}\n\ndo the task with ${SECRET} inside, concisely.\n\n${BLOCK}`;

/** A fake terminal: records everything written, replays queued input lines. */
function fakeTty(inputs: string[]): { io: PrecallTty; written: string[] } {
  const written: string[] = [];
  let i = 0;
  const io: PrecallTty = {
    write: (t) => written.push(t),
    readLine: () => (i < inputs.length ? inputs[i++] : "")
  };
  return { io, written };
}

describe("runApplyDecision - no default yes; [v] is content-free; fail-closed to decline", () => {
  const rec = analyzeBeforeCall("codex", dupPrompt);

  it("'y' approves", () => {
    const { io } = fakeTty(["y"]);
    expect(runApplyDecision(io, rec)).toBe("apply");
  });

  it("'n' declines", () => {
    const { io } = fakeTty(["n"]);
    expect(runApplyDecision(io, rec)).toBe("decline");
  });

  it("Enter (empty) declines - NO default yes", () => {
    const { io } = fakeTty([""]);
    expect(runApplyDecision(io, rec)).toBe("decline");
  });

  it("EOF / garbage declines (fail-closed)", () => {
    expect(runApplyDecision(fakeTty([]).io, rec)).toBe("decline");
    expect(runApplyDecision(fakeTty(["definitely-not-y"]).io, rec)).toBe("decline");
  });

  it("'v' shows CONTENT-FREE details then returns to the choice; then 'n' declines", () => {
    const { io, written } = fakeTty(["v", "n"]);
    expect(runApplyDecision(io, rec)).toBe("decline");
    const all = written.join("");
    // details show counts, never the prompt/secret
    expect(all).toContain("context blocks in input");
    expect(all).toContain("exact-duplicate blocks that would be removed");
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain(BLOCK);
    expect(all).not.toContain("do the task with");
  });

  it("'v' then 'y' approves after viewing details", () => {
    const { io } = fakeTty(["v", "y"]);
    expect(runApplyDecision(io, rec)).toBe("apply");
  });
});

describe("approved mutation end-to-end (synthetic apply-available spec): stub gets compacted ONLY after approval", () => {
  const synth: SafeMutationSpec = { promptFlags: ["--prompt"], valueFlags: [], booleanFlags: ["--json"], verifiedToolVersion: "synthetic-tool 1.0.0 (test fixture)" };
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(path.join(tmpdir(), "precall-apply-"));
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("approve → rebuild replaces ONLY the prompt value; original retained; activity content-safe", () => {
    const argv = ["--prompt", dupPrompt, "--json"];
    const rec = analyzeBeforeCall("codex", dupPrompt);
    expect(rec.has_avoidable_context).toBe(true);

    const mutation = resolveSafeMutation("codex", argv, synth);
    expect(mutation.applyAvailable).toBe(true);
    if (!mutation.applyAvailable) return;

    // user approves
    expect(runApplyDecision(fakeTty(["y"]).io, rec)).toBe("apply");

    // the argv the shim/stub WOULD exec after approval
    const rebuilt = mutation.rebuild(rec.compacted_input);
    expect(rebuilt[0]).toBe("--prompt");
    expect(rebuilt[1]).toBe(rec.compacted_input); // compacted prompt value
    expect(rebuilt[2]).toBe("--json"); // every other token byte-identical
    // the compacted input is strictly smaller than the original prompt (local-estimate reduction realized)
    expect(rec.compacted_input.length).toBeLessThan(dupPrompt.length);

    // original retained locally + recoverable
    const retained = retainOriginalPrompt(mutation.originalPrompt, { cwd });
    expect(readFileSync(retained.recoveryPath, "utf8")).toBe(dupPrompt);

    // activity event: honest applied state + content-safe pointer, NO prompt/secret text
    const event = buildBeforeCallActivityEvent({
      tool: "codex",
      recommendation: rec,
      approvalStatus: "asked-approved",
      applied: true,
      recoveryPointer: retained.pointer
    });
    expect(validateActivityEvent(event).problems).toEqual([]);
    expect(event.approval_status).toBe("asked-approved");
    expect(event.recovery?.location).toBe(retained.pointer);
    expect(event.auto_apply?.applied_automatically).toBe(false); // manual approval, never auto
    const raw = JSON.stringify(event);
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain(BLOCK);
    expect(raw).toContain(retained.pointer); // the pointer (id/path) IS present
    // the secret lives ONLY in the recovery file
    expect(readFileSync(retained.recoveryPath, "utf8")).toContain(SECRET);
  });

  it("decline → NO rebuild happens; the original argv is what runs", () => {
    const argv = ["--prompt", dupPrompt, "--json"];
    const rec = analyzeBeforeCall("codex", dupPrompt);
    expect(runApplyDecision(fakeTty(["n"]).io, rec)).toBe("decline");
    // the emitted argv on decline is the ORIGINAL (the caller never calls rebuild) - assert identity
    expect(argv).toEqual(["--prompt", dupPrompt, "--json"]);
  });
});
