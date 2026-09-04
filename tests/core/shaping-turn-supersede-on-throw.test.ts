import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  lastTurnWasShaped,
  recordShapingOutcome
} from "../../src/core/output-shaping-turn-state.js";

/**
 * A SHAPING RECORD MUST NEVER OUTLIVE ITS OWN TURN.
 *
 * A record now deliberately survives Stop, because the status line renders again after Stop and a
 * deleted record collapsed a finished turn's line to a bare count. That makes the write ORDERING
 * inside the hook load-bearing: `decideShaping` can throw — `classifyShapingTask` re-raises everything
 * that is not a module-absence error — and the hook's fail-open catch swallows it. A hook that
 * recorded only on success would leave the PREVIOUS turn's `shape` in place, and the next status line
 * would draw `basic shaping` and an estimated reduction for a turn on which the hook emitted nothing.
 *
 * The hooks therefore supersede fail-closed FIRST and replace with the real decision on success.
 */

const SESSION = "sess-throwing-turn";
const SCOPE = { tool: "claude-code" as const, sessionId: SESSION };

let dir: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "compaction-shape-throw-"));
  env = { COMPACTION_CONFIG_DIR: dir } as NodeJS.ProcessEnv; // no kill-switch, no persisted stop → active
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.resetModules();
  vi.doUnmock("../../src/core/gateway/task-awareness-seam.js");
});

const promptStdin = JSON.stringify({
  prompt: "fix the failing test in utils.ts",
  cwd: "/x",
  session_id: SESSION,
  hook_event_name: "UserPromptSubmit"
});

/** Load the prompt hook with the classifier seam forced to throw the way a real fault would. */
async function loadHookWithThrowingClassifier(): Promise<
  typeof import("../../src/cli/commands/capture-claude-code.js")
> {
  vi.resetModules();
  vi.doMock("../../src/core/gateway/task-awareness-seam.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../src/core/gateway/task-awareness-seam.js")>()),
    classifyShapingTask: async () => {
      throw new Error("classifier dependency exploded");
    }
  }));
  return import("../../src/cli/commands/capture-claude-code.js");
}

const recordPath = () => join(dir, "shaping-turns", `claude-code-${SESSION}.json`);

/** Seed a prior shaped turn's record out of band, so it exists no matter what the module graph does. */
function seedShapedRecord(): void {
  mkdirSync(join(dir, "shaping-turns"), { recursive: true });
  writeFileSync(
    recordPath(),
    `${JSON.stringify({ scope: `claude-code-${SESSION}`, outcome: "shape", at: new Date().toISOString() })}\n`,
    "utf8"
  );
}

describe("prompt hook — a turn whose decision throws cannot inherit the previous turn's claim", () => {
  it("supersedes a prior `shape` record with a fail-closed outcome when `decideShaping` throws", async () => {
    // Turn N: shaped, and its record legitimately survives Stop.
    await recordShapingOutcome(SCOPE, "shape", env);
    expect(await lastTurnWasShaped(SCOPE, env)).toBe(true);

    // Turn N+1: same session, valid payload, but the classification faults.
    const { captureClaudeCodeShapeFromPromptHook } = await loadHookWithThrowingClassifier();
    const written: string[] = [];
    await captureClaudeCodeShapeFromPromptHook({
      readStdin: async () => promptStdin,
      env,
      write: (text) => written.push(text)
    });

    // The hook emitted nothing, so nothing was shaped — and nothing may be claimed.
    expect(written).toEqual([]);
    expect(await lastTurnWasShaped(SCOPE, env)).toBe(false);

    // The old record is GONE, not merely unreadable — absence is this module's fail-closed default.
    expect(existsSync(recordPath())).toBe(false);
  });

  it("still fails open: a throwing decision never propagates out of the hook", async () => {
    const { captureClaudeCodeShapeFromPromptHook } = await loadHookWithThrowingClassifier();
    await expect(
      captureClaudeCodeShapeFromPromptHook({ readStdin: async () => promptStdin, env, write: () => {} })
    ).resolves.toBeUndefined();
  });

  it("the fail-closed pre-write does not clobber a turn that really was shaped", async () => {
    const { captureClaudeCodeShapeFromPromptHook } = await import(
      "../../src/cli/commands/capture-claude-code.js"
    );
    const written: string[] = [];
    await captureClaudeCodeShapeFromPromptHook({
      readStdin: async () => promptStdin,
      env,
      write: (text) => written.push(text)
    });

    expect(written.join("")).toContain("additionalContext");
    expect(await lastTurnWasShaped(SCOPE, env)).toBe(true);
  });
});

/**
 * The Codex/Cursor handler shares the defect and the fix, but it lives in a commander action that reads
 * `process.env` directly — driving it in-process would write records into the real config dir rather than
 * a temp one. The property that matters there is purely an ORDERING one, so it is asserted on the source:
 * the fail-closed supersede must precede the fallible decision in BOTH handlers.
 */
describe("both shaping handlers supersede before they decide", () => {
  it.each([
    ["src/cli/commands/capture-claude-code.ts", 'await decideShaping("claude-code", stdinText'],
    ["src/cli/commands/hooks.ts", "await decideShaping(tool as SubscriptionHookTool, stdinText"]
  ])("%s invalidates the previous record before calling decideShaping", async (file, decideCall) => {
    const source = await readFile(new URL(`../../${file}`, import.meta.url), "utf8");
    const failClosed = source.indexOf("await invalidateShapingTurnRecord(scope");
    const decide = source.indexOf(decideCall);
    // Both must be the CALL, not a mention of it: these files describe their own contracts at length, and
    // a guard that matched prose would pass while the ordering it guards had been reversed.
    expect(failClosed).toBeGreaterThan(-1);
    expect(source.lastIndexOf("await invalidateShapingTurnRecord(scope")).toBe(failClosed);
    expect(decide).toBeGreaterThan(-1);
    expect(source.lastIndexOf(decideCall)).toBe(decide);
    expect(failClosed).toBeLessThan(decide);
  });
});

/**
 * INVALIDATION MUST SURVIVE A CONFIG FILESYSTEM THAT CANNOT BE WRITTEN.
 *
 * Superseding the previous record with a fail-closed OUTCOME reads as equivalent to deleting it and is
 * strictly weaker: `recordShapingOutcome` is best-effort, so when the config filesystem is full or
 * read-only the supersede silently does nothing and the previous turn's `shape` stays readable for the
 * whole backstop window. Unlinking needs no free space, which is exactly why the hooks invalidate by
 * REMOVAL — the ENOSPC-shaped failure that defeats a write is the one a delete still closes.
 */
describe("prompt hook — a turn whose record cannot be WRITTEN still cannot inherit a claim", () => {
  it("drops the prior `shape` record even when every write fails", async () => {
    seedShapedRecord();
    expect(await lastTurnWasShaped(SCOPE, env)).toBe(true);

    vi.resetModules();
    vi.doMock("node:fs/promises", async (importOriginal) => {
      const real = await importOriginal<typeof import("node:fs/promises")>();
      return {
        ...real,
        default: real,
        // Writes fail the way a full disk fails; removal — the operation invalidation relies on — does not.
        writeFile: async () => {
          throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
        }
      };
    });

    const { captureClaudeCodeShapeFromPromptHook } = await import(
      "../../src/cli/commands/capture-claude-code.js"
    );
    await captureClaudeCodeShapeFromPromptHook({
      // A planning turn: `decideShaping` HOLDS, so the only thing standing between the old record and
      // the status line is the invalidation.
      readStdin: async () => JSON.stringify({ ...JSON.parse(promptStdin), prompt: "help me decide the architecture and weigh the trade-offs" }),
      env,
      write: () => {}
    });

    vi.doUnmock("node:fs/promises");
    expect(existsSync(recordPath())).toBe(false);
    expect(await lastTurnWasShaped(SCOPE, env)).toBe(false);
  });

  it("`invalidateShapingTurnRecord` reports the post-condition, not whether a file was removed", async () => {
    const { invalidateShapingTurnRecord } = await import("../../src/core/output-shaping-turn-state.js");
    seedShapedRecord();
    expect(readFileSync(recordPath(), "utf8")).toContain('"shape"');
    expect(await invalidateShapingTurnRecord(SCOPE, env)).toBe(true);
    expect(existsSync(recordPath())).toBe(false);
    // Nothing to remove is already the goal, so it reports true a second time.
    expect(await invalidateShapingTurnRecord(SCOPE, env)).toBe(true);
    // An unnameable scope has nothing addressable, so the post-condition cannot be asserted.
    expect(await invalidateShapingTurnRecord({ tool: "claude-code" }, env)).toBe(false);
  });
});
