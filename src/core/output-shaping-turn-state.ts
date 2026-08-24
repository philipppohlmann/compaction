import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { shapingStateDir } from "./subscription-shaping-state.js";
import type { ShapingDecisionOutcome } from "./subscription-shaping-runtime.js";

/**
 * LAST SHAPING DECISION (PUBLIC CLI/SDK core, engine-free, content-free, local-first).
 *
 * Answers ONE question for the surface that draws the per-turn line: **was THIS turn actually
 * shaped?** Nothing else could answer it. `isShapingHooksActivated` only reports the global kill
 * switch and `compaction stop` state, and its own contract says activation does not mean a given turn
 * was shaped — so a line gated on activation drew an estimated output saving on turns where nothing
 * was injected.
 *
 * That is not an edge case. `hold-planning` fires on every planning/reasoning turn, which is exactly
 * what the task gate exists to protect and is now shipped to every plan. Without this record the most
 * visible surface in the product claimed a saving precisely when it had deliberately not made one.
 *
 * CONTENT-FREE BY CONSTRUCTION: the file holds a fixed outcome enum and an ISO timestamp. There is no
 * field that can carry a prompt, a response, a count, or a credential — the outcome labels are the
 * same closed set `decideShaping` already returns.
 *
 * FAIL-CLOSED FOR THE CLAIM, FAIL-OPEN FOR THE WORKFLOW: every read/write error is swallowed. A write
 * that fails simply leaves no record, and a reader with no record MUST NOT draw the arrow — absence
 * means "cannot confirm this turn was shaped", never "assume it was".
 */

/** The file, under the same config dir as the other content-free local state. */
export const SHAPING_TURN_STATE_FILE = "last-shaping-decision.json";

/**
 * How recent a record must be to describe the CURRENT turn. A decision left over from a session hours
 * ago must not decorate an unrelated line, and the prompt hook fires immediately before the turn it
 * describes, so anything older than this is stale by construction rather than merely old.
 */
export const SHAPING_TURN_STATE_MAX_AGE_MS = 5 * 60 * 1000;

interface ShapingTurnRecord {
  outcome: ShapingDecisionOutcome;
  at: string;
}

function statePath(env: NodeJS.ProcessEnv): string {
  // Same directory as the other content-free local state (`COMPACTION_CONFIG_DIR` override honoured).
  return join(shapingStateDir(env), SHAPING_TURN_STATE_FILE);
}

/**
 * Record what the shaping hook decided for this turn. Called by the hook runtimes immediately after
 * `decideShaping`, before anything is printed. Best-effort: a failure here must never break the hook,
 * which is running inside the tool's own pipeline.
 */
export async function recordShapingOutcome(
  outcome: ShapingDecisionOutcome,
  env: NodeJS.ProcessEnv = process.env,
  now: () => Date = () => new Date()
): Promise<void> {
  try {
    const path = statePath(env);
    await mkdir(dirname(path), { recursive: true });
    const record: ShapingTurnRecord = { outcome, at: now().toISOString() };
    await writeFile(path, `${JSON.stringify(record)}\n`, "utf8");
  } catch {
    // Best-effort only. No record simply means the line renders without the arrow.
  }
}

/**
 * Whether the most recent recorded decision says this turn was SHAPED. `false` whenever that cannot be
 * confirmed — no record, unreadable, unparseable, stale, or a hold — because the only honest default
 * for a savings claim is not to make one.
 */
export async function lastTurnWasShaped(
  env: NodeJS.ProcessEnv = process.env,
  now: () => Date = () => new Date()
): Promise<boolean> {
  try {
    const raw = await readFile(statePath(env), "utf8");
    const parsed = JSON.parse(raw) as Partial<ShapingTurnRecord>;
    if (parsed.outcome !== "shape" && parsed.outcome !== "shape-basic") return false;
    if (typeof parsed.at !== "string") return false;
    const at = Date.parse(parsed.at);
    if (!Number.isFinite(at)) return false;
    const age = now().getTime() - at;
    // A future-dated record is as untrustworthy as an ancient one (clock skew, hand-edited file).
    if (age < 0 || age > SHAPING_TURN_STATE_MAX_AGE_MS) return false;
    return true;
  } catch {
    return false;
  }
}
