import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LEGACY_SHAPING_TURN_STATE_FILE,
  SHAPING_TURN_ORPHAN_BACKSTOP_MS,
  SHAPING_TURN_STATE_DIR,
  invalidateShapingTurnRecord,
  lastTurnWasShaped,
  recordShapingOutcome,
  shapingTurnScopeKey
} from "../../src/core/output-shaping-turn-state.js";
import type { ShapingTurnScope } from "../../src/core/output-shaping-turn-state.js";

/**
 * PER-SESSION SHAPING TURN STATE. This is the evidence the per-turn line's output arrow is gated on, so
 * every case here is really one of two questions: does a turn keep its OWN evidence for as long as it
 * runs, and can a turn ever read evidence that belongs to somebody else?
 *
 * Both answers used to be wrong on a real machine. Evidence lived in one global file with a 5-minute
 * wall-clock window, so a 21-minute turn lost its own proof three quarters of the way through (44% of
 * receipt-lines in one live store fell outside the window), and concurrent Claude Code sessions
 * overwrote each other seconds apart — which could decorate a DELIBERATELY HELD turn with another
 * session's `shape` and draw a calibrated saving off it.
 */

async function isolatedEnv(): Promise<NodeJS.ProcessEnv> {
  return { COMPACTION_CONFIG_DIR: await mkdtemp(join(tmpdir(), "shaping-turn-state-")) } as NodeJS.ProcessEnv;
}

const at = (iso: string) => (): Date => new Date(iso);
const T0 = "2026-08-26T10:00:00.000Z";
/** T0 + 21 minutes: a real observed turn length, and four times the window the old model allowed. */
const T_PLUS_21_MIN = "2026-08-26T10:21:00.000Z";

const sessionA: ShapingTurnScope = { tool: "claude-code", sessionId: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa" };
const sessionB: ShapingTurnScope = { tool: "claude-code", sessionId: "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb" };

describe("shaping turn state is keyed by session", () => {
  it("a later hold in session B does not overwrite session A's shape (and vice versa)", async () => {
    const env = await isolatedEnv();
    await recordShapingOutcome(sessionA, "shape", env, at(T0));
    // B decides AFTER A. Under the old single global slot this write WAS A's evidence.
    await recordShapingOutcome(sessionB, "hold-planning", env, at(T0));

    expect(await lastTurnWasShaped(sessionA, env, at(T0)), "A must still read its own shape").toBe(true);
    expect(await lastTurnWasShaped(sessionB, env, at(T0)), "B held, so B claims nothing").toBe(false);
  });

  it("a held session never reads a concurrent session's shape", async () => {
    const env = await isolatedEnv();
    // The direction that actually matters: a hold that could borrow somebody else's shape would draw a
    // calibrated delta on a turn nothing was injected into.
    await recordShapingOutcome(sessionA, "shape", env, at(T0));
    await recordShapingOutcome(sessionB, "hold-planning", env, at(T0));
    expect(await lastTurnWasShaped(sessionB, env, at(T0))).toBe(false);

    // Even with NO record of its own, B must not fall through to A's.
    const sessionC: ShapingTurnScope = { tool: "claude-code", sessionId: "cccccccc-3333-4333-8333-cccccccccccc" };
    expect(await lastTurnWasShaped(sessionC, env, at(T0))).toBe(false);
  });

  it("evidence written at T is still valid for the same session 21 minutes later", async () => {
    const env = await isolatedEnv();
    await recordShapingOutcome(sessionA, "shape", env, at(T0));
    // The defect verbatim: a long agentic turn must not lose its own evidence merely because time passed.
    expect(await lastTurnWasShaped(sessionA, env, at(T_PLUS_21_MIN))).toBe(true);
  });

  it("the same session's next prompt replaces its own prior decision and nobody else's", async () => {
    const env = await isolatedEnv();
    await recordShapingOutcome(sessionA, "shape", env, at(T0));
    await recordShapingOutcome(sessionB, "shape", env, at(T0));

    // A's next turn is a planning turn: A's claim ends, B's live turn is untouched.
    await recordShapingOutcome(sessionA, "hold-planning", env, at(T_PLUS_21_MIN));
    expect(await lastTurnWasShaped(sessionA, env, at(T_PLUS_21_MIN))).toBe(false);
    expect(await lastTurnWasShaped(sessionB, env, at(T_PLUS_21_MIN))).toBe(true);
  });

  it("a finished turn keeps its evidence until the next prompt supersedes it", async () => {
    // REGRESSION. Stop used to delete the record. Claude Code swallows hook stdout, so the status line is
    // the only per-turn surface a user reads — and it renders again AFTER Stop, where it found nothing and
    // redrew the finished turn without its reduction or its label. Nothing about the turn changed between
    // those two renders, so nothing about the line may either.
    const env = await isolatedEnv();
    await recordShapingOutcome(sessionA, "shape", env, at(T0));

    // The turn ends. Hours pass with the terminal open and no new prompt.
    expect(await lastTurnWasShaped(sessionA, env, at(T_PLUS_21_MIN)), "the finished turn still owns its line").toBe(true);

    // Only the session's OWN next prompt ends it — and it ends it with that turn's real decision.
    await recordShapingOutcome(sessionA, "hold-planning", env, at(T_PLUS_21_MIN));
    expect(await lastTurnWasShaped(sessionA, env, at(T_PLUS_21_MIN))).toBe(false);
  });

  it("one session's finished turn never speaks for another session's", async () => {
    const env = await isolatedEnv();
    await recordShapingOutcome(sessionA, "shape", env, at(T0));
    await recordShapingOutcome(sessionB, "hold-planning", env, at(T0));

    // A's turn finishing changes nothing for B, whose own turn was deliberately held.
    expect(await lastTurnWasShaped(sessionA, env, at(T0))).toBe(true);
    expect(await lastTurnWasShaped(sessionB, env, at(T0)), "a held turn claims nothing").toBe(false);
  });

  it("a missing session id fails closed for both reading and writing", async () => {
    const env = await isolatedEnv();
    const unnamed: ShapingTurnScope = { tool: "claude-code" };
    await recordShapingOutcome(unnamed, "shape", env, at(T0));

    expect(await lastTurnWasShaped(unnamed, env, at(T0))).toBe(false);
    expect(await lastTurnWasShaped(undefined, env, at(T0))).toBe(false);
    // And it wrote nothing at all, so no other reader can pick it up either.
    await expect(readdir(join(env.COMPACTION_CONFIG_DIR!, SHAPING_TURN_STATE_DIR))).rejects.toThrow();
  });

  it("an invalid session id fails closed and cannot escape the state directory", async () => {
    const env = await isolatedEnv();
    for (const sessionId of ["", "..", ".", "../escape", "a/b", "with space", ".hidden", "nul\0byte"]) {
      const scope: ShapingTurnScope = { tool: "claude-code", sessionId };
      expect(shapingTurnScopeKey(scope), sessionId).toBeUndefined();
      await recordShapingOutcome(scope, "shape", env, at(T0));
      expect(await lastTurnWasShaped(scope, env, at(T0)), sessionId).toBe(false);
    }
    await expect(readdir(join(env.COMPACTION_CONFIG_DIR!, SHAPING_TURN_STATE_DIR))).rejects.toThrow();
  });

  it("an unknown session id has no record and therefore claims nothing", async () => {
    const env = await isolatedEnv();
    await recordShapingOutcome(sessionA, "shape", env, at(T0));
    const unknown: ShapingTurnScope = { tool: "claude-code", sessionId: "dddddddd-4444-4444-8444-dddddddddddd" };
    expect(await lastTurnWasShaped(unknown, env, at(T0))).toBe(false);
  });

  it("holds are evidence of nothing; only shape outcomes count", async () => {
    const env = await isolatedEnv();
    for (const outcome of ["hold-dormant", "hold-planning", "hold-error"] as const) {
      await recordShapingOutcome(sessionA, outcome, env, at(T0));
      expect(await lastTurnWasShaped(sessionA, env, at(T0)), outcome).toBe(false);
    }
    for (const outcome of ["shape", "shape-basic"] as const) {
      await recordShapingOutcome(sessionA, outcome, env, at(T0));
      expect(await lastTurnWasShaped(sessionA, env, at(T0)), outcome).toBe(true);
    }
  });
});

describe("the orphan backstop is a leak guard, not a turn TTL", () => {
  it("is far longer than any agentic turn", () => {
    expect(SHAPING_TURN_ORPHAN_BACKSTOP_MS).toBeGreaterThan(60 * 60 * 1000);
  });

  it("expires a record from a session that died, but only well past any real turn", async () => {
    const env = await isolatedEnv();
    await recordShapingOutcome(sessionA, "shape", env, at(T0));
    const justInside = new Date(Date.parse(T0) + SHAPING_TURN_ORPHAN_BACKSTOP_MS - 1000);
    const past = new Date(Date.parse(T0) + SHAPING_TURN_ORPHAN_BACKSTOP_MS + 1000);
    expect(await lastTurnWasShaped(sessionA, env, () => justInside)).toBe(true);
    expect(await lastTurnWasShaped(sessionA, env, () => past)).toBe(false);
  });

  it("a future-dated record is not evidence", async () => {
    const env = await isolatedEnv();
    await recordShapingOutcome(sessionA, "shape", env, at(T_PLUS_21_MIN));
    expect(await lastTurnWasShaped(sessionA, env, at(T0))).toBe(false);
  });
});

describe("legacy single-slot state", () => {
  it("is never read as evidence for a session, and is cleaned up on the next write", async () => {
    const env = await isolatedEnv();
    const legacy = join(env.COMPACTION_CONFIG_DIR!, LEGACY_SHAPING_TURN_STATE_FILE);
    // Exactly what an older build left behind: a shape with no session identity, freshly dated.
    await writeFile(legacy, `${JSON.stringify({ outcome: "shape", at: T0 })}\n`, "utf8");

    expect(await lastTurnWasShaped(sessionA, env, at(T0)), "stale global state is not this session's").toBe(false);

    await recordShapingOutcome(sessionA, "hold-planning", env, at(T0));
    await expect(readFile(legacy, "utf8"), "the inert slot is pruned").rejects.toThrow();
  });
});

describe("records are content-free and self-identifying", () => {
  it("stores only the scope key, the outcome enum and a timestamp", async () => {
    const env = await isolatedEnv();
    await recordShapingOutcome(sessionA, "shape", env, at(T0));
    const dir = join(env.COMPACTION_CONFIG_DIR!, SHAPING_TURN_STATE_DIR);
    const [file] = await readdir(dir);
    const parsed = JSON.parse(await readFile(join(dir, file!), "utf8")) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(["at", "outcome", "scope"]);
    expect(parsed).toEqual({ scope: shapingTurnScopeKey(sessionA), outcome: "shape", at: T0 });
  });

  it("a record filed under the wrong name is not attributed to the session reading it", async () => {
    const env = await isolatedEnv();
    await recordShapingOutcome(sessionA, "shape", env, at(T0));
    // Hand-place A's record where B would look for its own.
    const dir = join(env.COMPACTION_CONFIG_DIR!, SHAPING_TURN_STATE_DIR);
    const aRecord = await readFile(join(dir, `${shapingTurnScopeKey(sessionA)}.json`), "utf8");
    await writeFile(join(dir, `${shapingTurnScopeKey(sessionB)}.json`), aRecord, "utf8");
    expect(await lastTurnWasShaped(sessionB, env, at(T0))).toBe(false);
  });

  it("unreadable and unparseable state claims nothing rather than throwing", async () => {
    const env = await isolatedEnv();
    expect(await lastTurnWasShaped(sessionA, env, at(T0)), "nothing recorded yet").toBe(false);
    await recordShapingOutcome(sessionA, "shape", env, at(T0));
    const dir = join(env.COMPACTION_CONFIG_DIR!, SHAPING_TURN_STATE_DIR);
    await writeFile(join(dir, `${shapingTurnScopeKey(sessionA)}.json`), "{ not json", "utf8");
    await expect(lastTurnWasShaped(sessionA, env, at(T0))).resolves.toBe(false);
  });
});

describe("Codex exact-turn and Cursor tool scopes", () => {
  it("keeps Codex turns and Cursor separate from each other and from Claude Code", async () => {
    const env = await isolatedEnv();
    const codexA = { tool: "codex", sessionId: "codex-session-a", turnId: "turn-a" } as const;
    const codexB = { tool: "codex", sessionId: "codex-session-b", turnId: "turn-a" } as const;
    await recordShapingOutcome(codexA, "shape", env, at(T0));
    expect(await lastTurnWasShaped(codexA, env, at(T0))).toBe(true);
    expect(await lastTurnWasShaped(codexB, env, at(T0))).toBe(false);
    expect(await lastTurnWasShaped({ tool: "codex" }, env, at(T0))).toBe(false);
    expect(await lastTurnWasShaped({ tool: "cursor" }, env, at(T0))).toBe(false);
    expect(await lastTurnWasShaped(sessionA, env, at(T0))).toBe(false);
    // A Claude Code session id cannot collide with an exact hashed Codex key.
    expect(shapingTurnScopeKey({ tool: "claude-code", sessionId: "codex" })).not.toBe(
      shapingTurnScopeKey(codexA, env)
    );
  });

  it("an invalid Codex identity cannot select a deletion path", async () => {
    const env = await isolatedEnv();
    const sentinel = join(env.COMPACTION_CONFIG_DIR!, "outside.json");
    await writeFile(sentinel, "outside sentinel", "utf8");
    expect(await invalidateShapingTurnRecord({
      tool: "codex",
      sessionId: "../outside",
      turnId: "turn"
    }, env)).toBe(false);
    expect(await readFile(sentinel, "utf8")).toBe("outside sentinel");
  });
});
