import { rmSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { compactionConfigDir, type ConfigDirEnv } from "./config-dir.js";
import { shapingStateDir } from "./subscription-shaping-state.js";
import type { ShapingDecisionOutcome } from "./subscription-shaping-runtime.js";
import { codexTurnCorrelationId, validCorrelationId } from "./gateway/session-correlation.js";

/**
 * PER-SESSION SHAPING TURN STATE (PUBLIC CLI/SDK core, engine-free, content-free, local-first).
 *
 * Answers ONE question for the surface that draws the per-turn line: **was THIS session's current turn
 * actually shaped?** Nothing else could answer it. `isShapingHooksActivated` only reports the global kill
 * switch and `compaction stop` state, and its own contract says activation does not mean a given turn was
 * shaped — so a line gated on activation drew an estimated output saving on turns where nothing was
 * injected. `hold-planning` fires on every planning/reasoning turn, which is exactly what the task gate
 * exists to protect.
 *
 * WHY THIS IS KEYED AND NOT TIMED. Agentic turns may outlive a short wall-clock window, and concurrent
 * sessions must never read one another's shaping decision. Turn boundaries are events, not durations:
 * validity is bounded by the prompt hook that opens the next turn, while age is only an orphan backstop
 * for state left by a crashed session. A record is readable only under the exact scope that wrote it.
 *
 * FAIL-CLOSED FOR THE CLAIM, FAIL-OPEN FOR THE WORKFLOW: every read/write error is swallowed, and a scope
 * that cannot be named yields no record at all. A reader with no record MUST NOT draw the arrow — absence
 * means "cannot confirm this turn was shaped", never "assume it was". A surface that cannot identify its
 * own turn therefore claims nothing, which is the only honest answer it has.
 *
 * CONTENT-FREE BY CONSTRUCTION: a record holds a fixed outcome enum, an ISO timestamp, and the scope key
 * that wrote it. There is no field that can carry a prompt, a response, a count, or a credential — the
 * outcome labels are the same closed set `decideShaping` already returns, and the scope key is the tool's
 * own opaque session identifier.
 */

/** Directory (under the config dir) holding one record per scope. One file per scope: no read-modify-write. */
export const SHAPING_TURN_STATE_DIR = "shaping-turns";

/**
 * The single global slot this module used to write. NEVER read as evidence — a record left by an older
 * build carries no session identity, so it cannot be attributed to any scope. It is deleted on sight so a
 * stale global decision cannot outlive the build that wrote it.
 */
export const LEGACY_SHAPING_TURN_STATE_FILE = "last-shaping-decision.json";

/**
 * ORPHAN BACKSTOP — not a turn TTL. Claude Code and Cursor reuse a scope key, so THIS session's next
 * `UserPromptSubmit` overwrites its prior decision. That hook first DELETES the previous record (see
 * `invalidateShapingTurnRecord`) and only then decides, so every outcome supersedes the last — a dormant
 * kill switch, a planning hold, a parse failure AND a decision that throws. Recording only on success would
 * not be enough: `decideShaping` can raise out of the classifier seam into the hook's fail-open catch, and a
 * turn that recorded nothing would inherit the previous turn's `shape` and draw a savings claim for shaping
 * that never happened.
 *
 * Claude Code Stop deliberately does not end its record, and that is load-bearing. Claude Code swallows hook stdout, so
 * the status line is the only per-turn surface a user reads — and it renders AGAIN after the Stop hook has
 * run. When Stop deleted the record, that last render found nothing and the finished turn's line collapsed
 * from `observed input 259,985 · output 2,853→1,512 (−47%, est.) · basic shaping` to a bare
 * `input 259,985 · output 1,512`: evidence that demonstrably existed during the turn, destroyed at the
 * moment the turn became final. An ended turn's record stays readable because the receipt it was paired
 * with is still the newest one, so the claim and the counts describe the same turn.
 *
 * Codex is different: its scope key is one exact session+turn hash and Stop itself renders the persisted
 * final event. Codex Stop therefore deletes that exact record only after reading it and reaching a terminal
 * settlement outcome; replay renders from the event and retries cleanup. This preserves concurrent-turn
 * isolation without accumulating one file per completed turn.
 *
 * The residual exposure for the reusable scopes is narrow and bounded on purpose: a session that keeps the status line installed
 * while REMOVING the prompt hook has no writer left to supersede its last record, and this backstop is what
 * bounds that. It is deliberately far longer than any agentic turn — an orphan lingering for hours is a
 * bookkeeping leak, whereas a live or just-finished turn losing its evidence is a false negative on the
 * product's most visible surface, which is the defect this module exists to prevent.
 */
export const SHAPING_TURN_ORPHAN_BACKSTOP_MS = 24 * 60 * 60 * 1000;

/** The surfaces that record a shaping decision. Each names its own scope; none may read another's. */
export type ShapingTurnTool = "claude-code" | "codex" | "cursor";

/**
 * WHOSE turn a record describes.
 *
 * `claude-code` REQUIRES `sessionId` — Claude Code supplies `session_id` on both the `UserPromptSubmit`
 * hook payload and the status-line stdin, so the two surfaces that must agree can always name the same
 * scope. Without it there is no way to tell one concurrent session from another, so the scope is invalid
 * and every read and write fails closed rather than falling back to a shared slot.
 *
 * `codex` requires BOTH `sessionId` and `turnId`. Codex supplies them on UserPromptSubmit and Stop;
 * the on-disk key is a device-local keyed hash, never either raw host identifier. `cursor` remains
 * tool-scoped because its sessionStart surface has no per-turn settlement contract.
 */
export type ShapingTurnScope =
  | { tool: "claude-code"; sessionId?: string }
  | { tool: "codex"; sessionId?: string; turnId?: string }
  | { tool: "cursor" };

/**
 * A session id must be safe to use as a filename: it starts with an alphanumeric — which rejects `.`,
 * `..` and dotfiles outright — and otherwise holds only characters that cannot traverse or escape the
 * state directory. There is no length floor beyond one character and no format requirement: the id is the
 * tool's to choose, and rejecting a short-but-valid one would fail closed on a turn we could have named.
 * Anything outside this shape is not a scope we can honour, so it fails closed.
 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * The on-disk key for a scope, or `undefined` when the scope cannot be named — the single choke point for
 * fail-closed behaviour. Every read and write goes through it, so an unnameable scope can neither record a
 * decision nor read one.
 */
export function shapingTurnScopeKey(
  scope: ShapingTurnScope | undefined,
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  if (!scope) return undefined;
  if (scope.tool === "cursor") return scope.tool;
  if (scope.tool === "codex") {
    const digest = scope.sessionId && scope.turnId
      ? codexTurnCorrelationId(scope.sessionId, scope.turnId, env)
      : undefined;
    return digest ? `codex-${digest}` : undefined;
  }
  if (scope.tool !== "claude-code") return undefined;
  const sessionId = scope.sessionId;
  if (typeof sessionId !== "string" || !SESSION_ID_PATTERN.test(sessionId)) return undefined;
  return `claude-code-${sessionId}`;
}

interface ShapingTurnRecord {
  /** The scope key that wrote this record; re-checked on read so a misfiled record is never attributed. */
  scope: string;
  outcome: ShapingDecisionOutcome;
  at: string;
}

function stateDir(env: NodeJS.ProcessEnv): string {
  // Same directory as the other content-free local state (`COMPACTION_CONFIG_DIR` override honoured).
  return join(shapingStateDir(env), SHAPING_TURN_STATE_DIR);
}

function statePath(env: NodeJS.ProcessEnv, key: string): string {
  return join(stateDir(env), `${key}.json`);
}

/**
 * Delete the pre-session global slot if an older build left one. Best-effort and silent: it is never read,
 * so failing to remove it changes nothing about what is claimed — this only stops it lingering forever.
 */
async function pruneLegacyGlobalState(env: NodeJS.ProcessEnv): Promise<void> {
  try {
    await rm(join(shapingStateDir(env), LEGACY_SHAPING_TURN_STATE_FILE), { force: true });
  } catch {
    // Best-effort only; the legacy file is inert either way.
  }
}

/**
 * Record what the shaping hook decided for THIS scope's turn, replacing whatever that scope recorded
 * before. Called by the hook runtimes once `decideShaping` returns and before anything is printed — the
 * PREVIOUS turn's record is already gone by then, dropped by `invalidateShapingTurnRecord` before the
 * decision was attempted. Reports whether the record actually reached disk.
 *
 * Writes exactly one scope's file, so a new prompt in session A cannot touch session B. Best-effort: a
 * failure here must never break the hook, which is running inside the tool's own pipeline. An unnameable
 * scope writes nothing at all.
 */
export async function recordShapingOutcome(
  scope: ShapingTurnScope | undefined,
  outcome: ShapingDecisionOutcome,
  env: NodeJS.ProcessEnv = process.env,
  now: () => Date = () => new Date()
): Promise<boolean> {
  const key = shapingTurnScopeKey(scope, env);
  if (!key) return false; // Unnameable scope ⇒ no record ⇒ no claim.
  try {
    const path = statePath(env, key);
    await mkdir(dirname(path), { recursive: true });
    const record: ShapingTurnRecord = { scope: key, outcome, at: now().toISOString() };
    await writeFile(path, `${JSON.stringify(record)}\n`, "utf8");
    await pruneLegacyGlobalState(env);
    return true;
  } catch {
    // Best-effort only. No record simply means the line renders without the arrow.
    return false;
  }
}

/**
 * Drop this scope's record so nothing it said can be read again, and report whether the scope is now
 * free of any readable claim.
 *
 * THIS, NOT A WRITE, IS HOW A TURN CLEARS THE ONE BEFORE IT. The hooks call it before the decision
 * that can throw. Superseding with a fail-closed OUTCOME would look equivalent and is strictly weaker:
 * `recordShapingOutcome` is best-effort, so on a full or read-only config filesystem the supersede
 * silently does nothing and the previous turn's `shape` stays readable for the whole backstop window —
 * a savings claim for a turn on which the hook emitted nothing. Removal is the operation most likely
 * to survive exactly that failure: unlinking needs no free space, so the ENOSPC case that defeats a
 * write is the case a delete still closes. Absence and a held outcome read identically anyway —
 * `lastTurnWasShaped` answers false for both — so nothing is lost by preferring the sturdier one.
 *
 * `true` also when there was no record to begin with: the post-condition is "this scope claims
 * nothing", not "a file was removed". `false` means the old record may still be readable, which no
 * caller can repair locally — the hook runs inside the tool's pipeline and must not fail the turn.
 */
export async function invalidateShapingTurnRecord(
  scope: ShapingTurnScope | undefined,
  env: NodeJS.ProcessEnv = process.env
): Promise<boolean> {
  const key = shapingTurnScopeKey(scope, env);
  if (!key) return false; // Unnameable scope ⇒ nothing addressable ⇒ cannot assert the post-condition.
  try {
    await rm(statePath(env, key), { force: true }); // `force` ⇒ a missing file is already the goal.
    return true;
  } catch {
    return false;
  }
}

/**
 * Delete one Codex shaping record from its already-derived device-local turn hash. This exists only
 * for bounded run-store eviction: raw host ids are intentionally unavailable there. The canonical
 * hash validator is the path-selection gate, so malformed or foreign values cannot name a file.
 */
export function invalidateCodexShapingTurnRecordByCorrelation(
  turnCorrelationId: string,
  env: ConfigDirEnv = process.env
): boolean {
  if (!validCorrelationId(turnCorrelationId)) return false;
  try {
    rmSync(
      join(compactionConfigDir(env), SHAPING_TURN_STATE_DIR, `codex-${turnCorrelationId}.json`),
      { force: true }
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether THIS scope's current turn was SHAPED. `false` whenever that cannot be confirmed — no scope, no
 * record, unreadable, unparseable, a record filed under a different scope, a hold, or an orphan past the
 * backstop — because the only honest default for a savings claim is not to make one.
 *
 * A turn is bounded by events, not by elapsed time: the record survives for as long as the turn runs AND
 * for as long as its line is still the one on screen, and is replaced by that session's next prompt.
 */
export async function lastTurnWasShaped(
  scope: ShapingTurnScope | undefined,
  env: NodeJS.ProcessEnv = process.env,
  now: () => Date = () => new Date()
): Promise<boolean> {
  const outcome = await lastTurnShapingOutcome(scope, env, now);
  return outcome === "shape" || outcome === "shape-basic";
}

/**
 * Read the fixed decision for this scope's current turn. This exposes no prompt/session bytes and lets
 * thin adapters distinguish a positively classified `shape` (the fixed default-shapeable regime) from
 * the classifier-absent `shape-basic` path, where a regime must remain unknown.
 */
export async function lastTurnShapingOutcome(
  scope: ShapingTurnScope | undefined,
  env: NodeJS.ProcessEnv = process.env,
  now: () => Date = () => new Date()
): Promise<ShapingDecisionOutcome | undefined> {
  const key = shapingTurnScopeKey(scope, env);
  if (!key) return undefined;
  try {
    const raw = await readFile(statePath(env, key), "utf8");
    const parsed = JSON.parse(raw) as Partial<ShapingTurnRecord>;
    // Defence in depth: a record must name the scope reading it, so a file moved or hand-written under the
    // wrong name is not attributed to this session.
    if (parsed.scope !== key) return undefined;
    if (
      parsed.outcome !== "shape" &&
      parsed.outcome !== "shape-basic" &&
      parsed.outcome !== "hold-dormant" &&
      parsed.outcome !== "hold-error" &&
      parsed.outcome !== "hold-planning"
    ) return undefined;
    if (typeof parsed.at !== "string") return undefined;
    const at = Date.parse(parsed.at);
    if (!Number.isFinite(at)) return undefined;
    const age = now().getTime() - at;
    // A future-dated record is as untrustworthy as an orphaned one (clock skew, hand-edited file).
    if (age < 0 || age > SHAPING_TURN_ORPHAN_BACKSTOP_MS) return undefined;
    return parsed.outcome;
  } catch {
    return undefined;
  }
}
