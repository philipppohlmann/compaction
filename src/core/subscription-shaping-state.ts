/**
 * SUBSCRIPTION OUTPUT-SHAPING RUN STATE (PUBLIC CLI/SDK core, engine-free, content-free).
 *
 * The persisted on/off switch that `compaction stop` / `compaction start` toggle and that the installed
 * before-call shaping hooks HONOR. It sits ALONGSIDE the kill-switch env (`COMPACTION_SHAPING_HOOKS=0`):
 * shaping is active only when NEITHER the env kill-switch is thrown NOR this state is `stopped`. Either
 * disables it; both must be clear to shape.
 *
 * VERSIONED-ACTIVATION DISCIPLINE (this governs a BEFORE-CALL mutation surface):
 *  - The state file carries the explicit activation VERSION label so the on-disk posture is auditable and
 *    can never silently widen to another activation posture. A file whose version does not match the
 *    current label is read fail-closed (treated as "no persisted preference", i.e. default posture) rather
 *    than trusted, so an older/foreign file can never flip a newer binary into an unexpected state.
 *  - The ONLY thing this file records is a single `shaping` enum (`active` | `stopped`) plus the version.
 *    No tool identity, no event, no request bytes: stopping is global to Compaction shaping, starting is
 *    global; the per-tool/per-event whitelist stays in the hook install + runtime, never here.
 *
 * FAIL-OPEN read posture: a missing / corrupt / wrong-version / wrong-shape file reads as the DEFAULT
 * (shaping NOT stopped), so a broken state file never leaves a user silently un-shaped in a way they did
 * not ask for; an explicit `stopped` is the only thing that turns shaping off here. Never throws.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compactionConfigDir } from "./config-dir.js";

type EnvLike = Record<string, string | undefined>;

/**
 * The activation version label for the persisted shaping run-state. Mirrors the hook-activation version
 * discipline (`output-shaping-hook-activation.ts`). Bump ONLY with an intentional posture change; an
 * on-disk file with a different version is not trusted (read as default).
 */
export const SHAPING_STATE_VERSION = "shaping-runstate-v1-2026-07-30" as const;

/** The persisted shaping switch. `active` = shaping may run (subject to the env kill-switch + classifier);
 *  `stopped` = the user ran `compaction stop`; every installed before-call hook HOLDS. */
export type ShapingRunState = "active" | "stopped";

/** The on-disk shape (only these two keys are ever written; any other key fails the write-rail assertion). */
interface ShapingStateFile {
  version: typeof SHAPING_STATE_VERSION;
  shaping: ShapingRunState;
}

const LEGAL_KEYS = ["version", "shaping"] as const;

/**
 * Resolve the state directory, via the ONE shared resolver (`core/config-dir.ts`) that every content-free
 * Compaction store now goes through - so `COMPACTION_CONFIG_DIR` and the `HOME` the default hangs off are
 * honored identically everywhere, and these stores can no longer drift apart on where they look.
 */
export function shapingStateDir(env: EnvLike = process.env): string {
  return compactionConfigDir(env);
}

/** Absolute path to the shaping run-state file. */
export function shapingStatePath(env: EnvLike = process.env): string {
  return join(shapingStateDir(env), "shaping-state.json");
}

/**
 * Read the persisted shaping run-state. Returns `"stopped"` ONLY when a well-formed, current-version file
 * explicitly says so; a missing / corrupt / wrong-version / wrong-shape file reads as the default
 * `"active"` (fail-open - a broken file never silently stops shaping). Never throws.
 */
export function readShapingRunState(env: EnvLike = process.env): ShapingRunState {
  const path = shapingStatePath(env);
  if (!existsSync(path)) return "active";
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return "active";
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return "active";
  const rec = raw as Record<string, unknown>;
  // Wrong/absent version → do not trust the file; fall back to the default posture.
  if (rec.version !== SHAPING_STATE_VERSION) return "active";
  return rec.shaping === "stopped" ? "stopped" : "active";
}

/** True when the user has explicitly `compaction stop`-ed shaping (persisted state === "stopped"). */
export function isShapingStopped(env: EnvLike = process.env): boolean {
  return readShapingRunState(env) === "stopped";
}

/**
 * The single write path for the state file (dir 0700, file 0600). Writes ONLY the whitelisted keys with
 * the current version; a rail assertion fail-closes on any other key or an illegal `shaping` value. No
 * content is ever stored. Returns the absolute path written.
 */
function writeShapingState(state: ShapingRunState, env: EnvLike = process.env): string {
  if (state !== "active" && state !== "stopped") {
    throw new Error(`refusing to persist illegal shaping run-state: ${JSON.stringify(state)}`);
  }
  const file: ShapingStateFile = { version: SHAPING_STATE_VERSION, shaping: state };
  for (const key of Object.keys(file)) {
    if (!LEGAL_KEYS.includes(key as (typeof LEGAL_KEYS)[number])) {
      throw new Error(`shaping-state store rail violated: unexpected key ${JSON.stringify(key)}`);
    }
  }
  const dir = shapingStateDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = shapingStatePath(env);
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

/** The outcome of a stop/start toggle: what the state WAS and what it is now (so callers print what changed). */
export interface ShapingStateChange {
  previous: ShapingRunState;
  current: ShapingRunState;
  changed: boolean;
  path: string;
}

/**
 * Persist `shaping: "stopped"` (what `compaction stop` does). Idempotent: reports `changed: false` when it
 * was already stopped. Returns the previous + current state so the caller can print exactly what changed.
 */
export function stopShaping(env: EnvLike = process.env): ShapingStateChange {
  const previous = readShapingRunState(env);
  const path = writeShapingState("stopped", env);
  return { previous, current: "stopped", changed: previous !== "stopped", path };
}

/**
 * Persist `shaping: "active"` (what `compaction start` does). Idempotent: reports `changed: false` when it
 * was already active. Note: this clears only the PERSISTED stop; if the env kill-switch
 * (`COMPACTION_SHAPING_HOOKS=0`) is thrown, shaping still holds until that is unset too (reported by the caller).
 */
export function startShaping(env: EnvLike = process.env): ShapingStateChange {
  const previous = readShapingRunState(env);
  const path = writeShapingState("active", env);
  return { previous, current: "active", changed: previous !== "active", path };
}
