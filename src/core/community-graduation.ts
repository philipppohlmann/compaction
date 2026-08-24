/**
 * OPEN → COMMUNITY graduation: one lightweight, rate-limited, in-context invitation (PUBLIC CLI core).
 *
 * THE GAP THIS FILLS. Community activation exists and works (`compaction login` → the browser device
 * flow), and first-run onboarding offers it. But a user who chose Open at install had exactly one moment
 * to hear about it, before they had any reason to care. After that the product never mentioned it again:
 * the only paths back were re-running onboarding or already knowing the command. So the lifecycle
 * "Open use → value demonstrated → activate Community" had no middle step, and the natural place to
 * offer it — after the product has visibly done something — was silent.
 *
 * WHAT THIS IS NOT. Not an onboarding step, not a menu, not a mode. Onboarding is unchanged. It adds ONE
 * line, ADJACENT to the per-turn receipt and never inside it, on a small number of turns.
 *
 * THE RECEIPT STAYS FACTUAL. The per-turn line is an evidence surface, and a CTA welded into it would
 * make every future reading of that grammar partly an advertisement. This line is emitted separately by
 * the caller, after the receipt, and carries no count, percentage, or saving of its own — it points at a
 * command and nothing else.
 *
 * WHY IT CANNOT NAG, by construction rather than by intention. Four independent conditions must all
 * hold, and the showing is only emitted once a slot has been PERSISTED (see `communityInviteLine`), so
 * a filesystem failure silences it rather than unbounding it:
 *   1. The device is on Open (`observe`/`basic`). A `full` device has already graduated.
 *   2. There are NO stored credentials. An account holder is never invited to make one.
 *   3. Value has actually been demonstrated: at least `MIN_TURNS_BEFORE_INVITING` recorded turns. A
 *      user who has seen the product do nothing yet is not a candidate; they are a stranger.
 *   4. It has not been shown in the last `MIN_DAYS_BETWEEN` days, and has been shown fewer than
 *      `MAX_LIFETIME_SHOWS` times EVER.
 * The lifetime cap is the load-bearing one. A purely time-based throttle still nags forever, just more
 * slowly; a cap means a user who is not interested stops hearing about it permanently, without having to
 * find a setting to say so.
 *
 * CONTENT-FREE, like every other Compaction store: the state file holds a schema tag, a count, and a
 * timestamp. No prompt, no path, no identity.
 *
 * FAIL-CLOSED, deliberately in the SILENT direction, on BOTH sides of the state file. An unreadable or
 * malformed file reads as EXHAUSTED rather than fresh, and a showing that cannot be persisted is not
 * shown at all. A missed invitation costs nothing; a runaway one is exactly the failure this module
 * exists to prevent, and it is reachable through nothing more exotic than a read-only home directory.
 *
 * WHAT THE CAP IS AND IS NOT PROOF AGAINST, stated precisely so the guarantee is not read wider than it
 * is. Measured adversarially over 400 eligible days:
 *   - normal operation .................. 3 shows (the cap)
 *   - state file truncated every turn ... 0
 *   - state file corrupted every turn ... 0
 *   - config dir read-only .............. 0
 *   - state file deleted / `shownCount` rewritten to 0 .... still capped (the slot markers stand)
 *   - the whole config directory cleared ................. reset
 * Only the last one re-opens it, and that is intended rather than a hole: the actor is whoever can
 * write `~/.compaction`, i.e. the user, and clearing their own Compaction state is a reasonable thing
 * to want. It is the only reset offered. Note the earlier measurement that made the JSON file alone a
 * reset no longer holds — the reservation lives in the markers, so losing the JSON costs the timestamp
 * and nothing else. The cap protects against ACCIDENT (a failing or read-only filesystem, a partial
 * write, two hooks racing), which is where the real risk of turning a three-times-ever line into a
 * per-turn nag actually lives. Hardening it against its own user would buy nothing and cost control.
 */
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { compactionConfigDir, type ConfigDirEnv } from "./config-dir.js";

/** Schema tag for the state file; an unrecognized tag reads as "no state", never as an error. */
export const COMMUNITY_INVITE_SCHEMA = "community-invite.v1" as const;

/**
 * Turns of recorded activity before the invitation is appropriate.
 *
 * The point of the threshold is that the user has SEEN something. Below it there is nothing to graduate
 * from, and the line would read as a signup prompt bolted to a tool they have not used yet.
 */
export const MIN_TURNS_BEFORE_INVITING = 25;

/** Days that must pass between two showings. */
export const MIN_DAYS_BETWEEN = 7;

/** How many times this may EVER be shown to one device. After this, permanently silent. */
export const MAX_LIFETIME_SHOWS = 3;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

interface CommunityInviteState {
  schema: typeof COMMUNITY_INVITE_SCHEMA;
  /** How many times the invitation has been shown on this device. */
  shownCount: number;
  /** ISO timestamp of the most recent showing, absent before the first. */
  lastShownAt?: string;
}

export function communityInviteStatePath(env: ConfigDirEnv = process.env): string {
  return path.join(compactionConfigDir(env), "community-invite.json");
}

/**
 * Read the state.
 *
 * ABSENT means "never shown" and is the only case that opens the gate. A file that EXISTS but cannot be
 * read or parsed is treated as EXHAUSTED, not as fresh: a corrupt or partially written state file would
 * otherwise reset the counter to zero on every turn, and the lifetime cap - the thing that makes this
 * unable to nag - would never advance. Choosing "fresh" there means one damaged byte converts a
 * three-times-ever invitation into a per-turn prompt, which is the failure this module exists to make
 * impossible.
 */
export function readCommunityInviteState(env: ConfigDirEnv = process.env): CommunityInviteState {
  const fresh: CommunityInviteState = { schema: COMMUNITY_INVITE_SCHEMA, shownCount: 0 };
  const exhausted: CommunityInviteState = { schema: COMMUNITY_INVITE_SCHEMA, shownCount: MAX_LIFETIME_SHOWS };
  let text: string;
  try {
    text = readFileSync(communityInviteStatePath(env), "utf8");
  } catch (error: unknown) {
    // Only a genuinely ABSENT file is "never shown". Anything else (permissions, I/O) is unreadable
    // state, and unreadable state must not read as a clean slate.
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
    return code === "ENOENT" ? fresh : exhausted;
  }
  try {
    const raw: unknown = JSON.parse(text);
    if (typeof raw !== "object" || raw === null) return exhausted;
    const r = raw as Record<string, unknown>;
    if (r.schema !== COMMUNITY_INVITE_SCHEMA) return exhausted;
    const shownCount = typeof r.shownCount === "number" && Number.isFinite(r.shownCount) ? Math.max(0, Math.floor(r.shownCount)) : 0;
    return {
      schema: COMMUNITY_INVITE_SCHEMA,
      shownCount,
      ...(typeof r.lastShownAt === "string" ? { lastShownAt: r.lastShownAt } : {})
    };
  } catch {
    return exhausted;
  }
}

/**
 * Reserve one showing by PERSISTING it, and report whether that succeeded.
 *
 * The boolean is the whole point. This used to swallow a write failure and return void, so an
 * unwritable state file left the counter frozen while the caller showed the line anyway - and the
 * "at most three times, ever" guarantee silently became "on every eligible turn, forever". A throttle
 * whose bookkeeping is best-effort is not a throttle; the slot must be TAKEN before it is spent.
 *
 * Never throws - a failure is reported, not raised, because the caller is a per-turn render path.
 */
export function recordCommunityInviteShown(env: ConfigDirEnv = process.env, now: () => Date = () => new Date()): boolean {
  try {
    const dir = compactionConfigDir(env);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // RE-EVALUATE THE SHARED STATE HERE, not just the slot number.
    //
    // A unique file per slot is not sufficient on its own. Two hooks can both pass
    // `shouldInviteToCommunity` against the same old state; if the first reserves slot 1 and writes its
    // timestamp before the second reaches this point, the second reads `shownCount: 1`, computes slot 2,
    // and its exclusive create SUCCEEDS - so both show within the same second, violating the seven-day
    // interval even though every slot had exactly one owner. The gap is the window between the
    // eligibility check and the reservation, and it closes by re-reading the state inside the
    // reservation and applying the same state-dependent rules to it.
    const previous = readCommunityInviteState(env);
    if (!stateAllowsShowing(previous, now)) return false;
    const slot = previous.shownCount + 1;
    if (slot > MAX_LIFETIME_SHOWS) return false;

    // TAKE THE SLOT ATOMICALLY, BEFORE WRITING ANYTHING ELSE.
    //
    // Read-increment-write is not a reservation, and re-reading it afterwards is only confirmation:
    // two Stop hooks firing at the same moment (two Claude Code sessions, one machine) can both read
    // `shownCount: 1`, both write `2`, and both see their own value on the re-read - so one persisted
    // slot yields two invitations, and the "three times, ever" cap can be exceeded outright.
    //
    // `openSync(..., "wx")` is O_CREAT|O_EXCL: the kernel guarantees exactly one caller creates the
    // file. The loser gets EEXIST and declines, so concurrency costs an invitation rather than the
    // guarantee - the same direction every other failure here resolves in. One marker per slot, at most
    // MAX_LIFETIME_SHOWS of them, each empty and content-free.
    closeSync(openSync(communityInviteSlotPath(env, slot), "wx", 0o600));

    const next: CommunityInviteState = {
      schema: COMMUNITY_INVITE_SCHEMA,
      shownCount: slot,
      lastShownAt: now().toISOString()
    };
    // The slot is already ours; this only records WHEN, for the interval throttle. A failure here still
    // leaves the slot consumed, which is the safe direction (it can never re-open).
    writeFileSync(communityInviteStatePath(env), `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    return true;
  } catch {
    // EEXIST (another process took this slot), a read-only directory, a failing filesystem - all of
    // them mean we did not reserve anything, so nothing may be shown.
    return false;
  }
}

/**
 * The marker whose atomic creation IS the reservation of showing number `slot`. Content-free and empty:
 * its existence is the entire signal. Named beside the state file so a user clearing
 * `~/.compaction` clears both together (see the reset note in the module comment).
 */
function communityInviteSlotPath(env: ConfigDirEnv, slot: number): string {
  return path.join(compactionConfigDir(env), `community-invite.slot-${slot}`);
}

export interface CommunityInviteInputs {
  /** The device's effective open-core tier. Only `observe`/`basic` can graduate. */
  tier: "observe" | "basic" | "full";
  /** Whether this device already holds account credentials. */
  hasAccount: boolean;
  /** Recorded turns of local activity — the evidence that the product has demonstrated something. */
  turnsRecorded: number;
}

/**
 * Whether to show the invitation on THIS turn. Pure: same inputs and state in, same answer out.
 *
 * Ordering is by cost and by certainty, not by importance: the two facts that disqualify a user
 * permanently (`full`, has an account) are checked before the ones that merely say "not yet".
 */
export function shouldInviteToCommunity(
  inputs: CommunityInviteInputs,
  state: CommunityInviteState,
  now: () => Date = () => new Date()
): boolean {
  if (inputs.tier === "full") return false;
  if (inputs.hasAccount) return false;
  if (inputs.turnsRecorded < MIN_TURNS_BEFORE_INVITING) return false;
  return stateAllowsShowing(state, now);
}

/**
 * The STATE-dependent half of eligibility: the lifetime cap and the interval. Split out because it is
 * the half that another process can invalidate between our check and our write, so the reservation has
 * to re-evaluate exactly this against freshly read state (see `recordCommunityInviteShown`).
 *
 * The caller-supplied half (tier, account, turn count) cannot go stale that way: it describes this
 * process's own turn, not shared state.
 */
function stateAllowsShowing(state: CommunityInviteState, now: () => Date): boolean {
  if (state.shownCount >= MAX_LIFETIME_SHOWS) return false;
  if (state.lastShownAt !== undefined) {
    const last = Date.parse(state.lastShownAt);
    // An UNPARSEABLE timestamp is treated as "shown just now", not as "never shown". The opposite
    // reading would let one corrupt byte turn the throttle off entirely.
    if (!Number.isFinite(last)) return false;
    if (now().getTime() - last < MIN_DAYS_BETWEEN * MS_PER_DAY) return false;
  }
  return true;
}

/**
 * The invitation itself. ONE line, an action and nothing else.
 *
 * It names `compaction login`, the command that ALREADY exists and already opens the browser device
 * flow — this module introduces no new activation path, and there is nothing to reinstall or reconnect
 * because the tools' shims and hooks are untouched by activation.
 *
 * No number, no percentage, no saving, no comparison, and no claim about what Community will do for
 * them: the receipt above it is the evidence, and this line must not become a second, softer place to
 * make a claim that surface is held to.
 */
export const COMMUNITY_INVITE_LINE =
  "compaction · Community is free and adds full apply on top of this - activate anytime: compaction login";

/**
 * The whole decision plus its bookkeeping: returns the line to print, or undefined.
 *
 * Recording happens HERE rather than at the call site so a caller cannot show it and forget to count it,
 * which would remove the throttle for that surface silently.
 */
export function communityInviteLine(
  inputs: CommunityInviteInputs,
  env: ConfigDirEnv = process.env,
  now: () => Date = () => new Date()
): string | undefined {
  try {
    if (!shouldInviteToCommunity(inputs, readCommunityInviteState(env), now)) return undefined;
    // SHOW ONLY WHAT WE COULD RECORD. If the slot cannot be persisted the throttle has no memory of
    // this showing, so showing it would make the next turn eligible again, and the next - the cap
    // would never advance. Staying silent costs one invitation; the alternative costs the guarantee.
    if (!recordCommunityInviteShown(env, now)) return undefined;
    return COMMUNITY_INVITE_LINE;
  } catch {
    return undefined; // silence is the safe direction
  }
}
