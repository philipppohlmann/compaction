import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  communityInviteLine,
  communityInviteStatePath,
  readCommunityInviteState,
  recordCommunityInviteShown,
  shouldInviteToCommunity,
  COMMUNITY_INVITE_LINE,
  MAX_LIFETIME_SHOWS,
  MIN_DAYS_BETWEEN,
  MIN_TURNS_BEFORE_INVITING,
  type CommunityInviteInputs
} from "../../src/core/community-graduation.js";

/**
 * The Open → Community invitation must be POSSIBLE (the lifecycle had no middle step without it) and
 * must be UNABLE TO NAG (an in-context CTA that fires often is worse than no CTA at all).
 *
 * "Unable" is the operative word: these pin the caps as construction, not intention. A throttle that
 * relies on every call site remembering to record a showing is not a throttle.
 */

let configDir: string;

function env(): NodeJS.ProcessEnv {
  return { COMPACTION_CONFIG_DIR: configDir };
}

const READY: CommunityInviteInputs = { tier: "basic", hasAccount: false, turnsRecorded: MIN_TURNS_BEFORE_INVITING };

function at(iso: string): () => Date {
  return () => new Date(iso);
}

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "compaction-invite-"));
});
afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

describe("shouldInviteToCommunity - who may be invited, and when", () => {
  it("an Open device with demonstrated use and no account: invited", () => {
    expect(shouldInviteToCommunity(READY, readCommunityInviteState(env()))).toBe(true);
  });

  it("`observe` qualifies as well as `basic` - both are Open", () => {
    expect(shouldInviteToCommunity({ ...READY, tier: "observe" }, readCommunityInviteState(env()))).toBe(true);
  });

  /** A `full` device HAS graduated. Inviting it would be an advert for what it already has. */
  it("a full-tier device is never invited", () => {
    expect(shouldInviteToCommunity({ ...READY, tier: "full" }, readCommunityInviteState(env()))).toBe(false);
  });

  /** An account holder is never asked to make an account, whatever tier they are running. */
  it("a device that already holds credentials is never invited", () => {
    expect(shouldInviteToCommunity({ ...READY, hasAccount: true }, readCommunityInviteState(env()))).toBe(false);
  });

  /**
   * VALUE FIRST. The whole premise is "Open use → value demonstrated → invitation". Below the
   * threshold the product has not shown this user anything, and the line would be a signup prompt
   * bolted onto a tool they have not used.
   */
  it("a device with too little recorded activity is not yet invited", () => {
    expect(
      shouldInviteToCommunity({ ...READY, turnsRecorded: MIN_TURNS_BEFORE_INVITING - 1 }, readCommunityInviteState(env()))
    ).toBe(false);
  });

  it("exactly at the threshold: invited (the boundary is inclusive, and pinned so it cannot drift)", () => {
    expect(
      shouldInviteToCommunity({ ...READY, turnsRecorded: MIN_TURNS_BEFORE_INVITING }, readCommunityInviteState(env()))
    ).toBe(true);
  });
});

describe("the throttle - shown rarely, then never", () => {
  it("not shown twice inside the minimum interval", () => {
    recordCommunityInviteShown(env(), at("2026-08-01T00:00:00.000Z"));
    const oneDayLater = at("2026-08-02T00:00:00.000Z");
    expect(shouldInviteToCommunity(READY, readCommunityInviteState(env()), oneDayLater)).toBe(false);
  });

  it("shown again once the interval has passed", () => {
    recordCommunityInviteShown(env(), at("2026-08-01T00:00:00.000Z"));
    const afterInterval = at(`2026-08-0${1 + MIN_DAYS_BETWEEN}T00:01:00.000Z`);
    expect(shouldInviteToCommunity(READY, readCommunityInviteState(env()), afterInterval)).toBe(true);
  });

  /**
   * THE LOAD-BEARING CAP. A purely time-based throttle still nags forever, only more slowly. After the
   * lifetime cap this device never sees the line again - without the user having to find a setting to
   * say so.
   */
  it(`after ${MAX_LIFETIME_SHOWS} showings it is silent FOREVER, however much time passes`, () => {
    for (let i = 0; i < MAX_LIFETIME_SHOWS; i++) recordCommunityInviteShown(env(), at(`2026-0${i + 1}-01T00:00:00.000Z`));
    expect(readCommunityInviteState(env()).shownCount).toBe(MAX_LIFETIME_SHOWS);
    expect(shouldInviteToCommunity(READY, readCommunityInviteState(env()), at("2030-01-01T00:00:00.000Z"))).toBe(false);
  });

  /**
   * One corrupt byte must not turn the throttle OFF. An unparseable timestamp is read as "shown just
   * now", the conservative direction; the opposite reading would make a damaged file the loudest state.
   */
  it("an unparseable lastShownAt suppresses rather than releases the invitation", () => {
    writeFileSync(
      communityInviteStatePath(env()),
      JSON.stringify({ schema: "community-invite.v1", shownCount: 1, lastShownAt: "not-a-date" }),
      "utf8"
    );
    expect(shouldInviteToCommunity(READY, readCommunityInviteState(env()))).toBe(false);
  });

  it("a malformed or foreign-schema state file is never an error - and never a clean slate", () => {
    writeFileSync(communityInviteStatePath(env()), "{{{ not json", "utf8");
    expect(readCommunityInviteState(env()).shownCount).toBe(MAX_LIFETIME_SHOWS);
    writeFileSync(communityInviteStatePath(env()), JSON.stringify({ schema: "something.else", shownCount: 99 }), "utf8");
    expect(readCommunityInviteState(env()).shownCount).toBe(MAX_LIFETIME_SHOWS);
  });
});

describe("communityInviteLine - decision and bookkeeping are inseparable", () => {
  /**
   * The counter must advance as a CONSEQUENCE of showing, not as a separate call the caller might
   * forget. A call site that could print without counting has no throttle at all.
   */
  it("returning the line consumes a lifetime slot", () => {
    expect(communityInviteLine(READY, env(), at("2026-08-01T00:00:00.000Z"))).toBe(COMMUNITY_INVITE_LINE);
    expect(readCommunityInviteState(env()).shownCount).toBe(1);
  });

  /**
   * THE THROTTLE MUST NOT DEGRADE INTO A NAG. If the slot cannot be persisted, the state file has no
   * memory of this showing - so the next eligible turn would qualify again, and the next, and the
   * "three times, ever" guarantee would quietly become "every turn, forever". A read-only home is all
   * it takes. Staying silent costs one invitation; the alternative costs the guarantee.
   */
  it("an UNUSABLE state directory silences the invitation rather than unbounding it", () => {
    // NOT chmod. A permissions-based fixture is a no-op for UID 0, so under a root-run container it
    // silently stops testing the failure branch and the assertion flips - Codex reproduced exactly that
    // ("expected length 0 but got 1"). Pointing the config dir THROUGH a regular file makes `mkdirSync`
    // fail with ENOTDIR for every user including root, so this exercises the branch deterministically.
    const base = mkdtempSync(join(tmpdir(), "compaction-invite-blocked-"));
    const blocker = join(base, "not-a-directory");
    writeFileSync(blocker, "", "utf8");
    try {
      const env: NodeJS.ProcessEnv = { COMPACTION_CONFIG_DIR: join(blocker, "cfg") };
      const shown = Array.from({ length: 50 }, () => communityInviteLine(READY, env)).filter(Boolean);
      expect(shown).toHaveLength(0);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  /**
   * CONCURRENCY. Read-increment-write is not a reservation: two Stop hooks firing at the same moment
   * (two Claude Code sessions on one machine) could both read the same count, both write the next one,
   * and both show - exceeding a cap documented as absolute. The slot is now taken with an atomic
   * exclusive create, so only one caller can ever own showing number N.
   *
   * Simulated deterministically by pre-creating the marker for the next slot, which is exactly the
   * state the losing racer finds.
   */
  it("a slot already reserved by another process is never shown twice", () => {
    const slot1 = join(configDir, "community-invite.slot-1");
    writeFileSync(slot1, "", "utf8");
    expect(communityInviteLine(READY, env())).toBeUndefined();
    expect(existsSync(communityInviteStatePath(env()))).toBe(false);
  });

  /**
   * THE CHECK-TO-RESERVE WINDOW. A unique file per slot is not sufficient on its own: two callers can
   * both pass eligibility against the same old state, and if the first reserves and stamps its
   * timestamp before the second reaches the reservation, the second computes the NEXT slot number and
   * its exclusive create succeeds - so both show within the same second, violating the seven-day
   * interval while every slot still had exactly one owner.
   *
   * Reproduced deterministically by writing the state the winner would have left, which is exactly what
   * the loser finds when it re-reads inside the reservation.
   */
  it("a caller that became stale between eligibility and reservation is refused", () => {
    const stale = readCommunityInviteState(env()); // (0, never) - eligible
    expect(shouldInviteToCommunity(READY, stale, at("2026-08-01T00:00:00.000Z"))).toBe(true);

    // Another process wins the race: takes slot 1 and stamps the moment.
    writeFileSync(join(configDir, "community-invite.slot-1"), "", "utf8");
    writeFileSync(
      communityInviteStatePath(env()),
      JSON.stringify({ schema: "community-invite.v1", shownCount: 1, lastShownAt: "2026-08-01T00:00:00.000Z" }),
      "utf8"
    );

    // The loser still holds its stale `true`, and must be refused at the reservation - not handed
    // slot 2 seconds after slot 1 was shown.
    expect(recordCommunityInviteShown(env(), at("2026-08-01T00:00:01.000Z"))).toBe(false);
    expect(readCommunityInviteState(env()).shownCount).toBe(1);
  });

  it("the cap still holds when every slot marker is present but the state file is gone", () => {
    for (let i = 1; i <= MAX_LIFETIME_SHOWS; i++) writeFileSync(join(configDir, `community-invite.slot-${i}`), "", "utf8");
    const shown = Array.from({ length: 20 }, (_, d) => communityInviteLine(READY, env(), at(`2026-0${(d % 9) + 1}-01T00:00:00.000Z`))).filter(Boolean);
    expect(shown).toHaveLength(0);
  });

  /**
   * The read side has the same hazard from the other direction: a corrupt or partially written file
   * that read as "never shown" would reset the counter on every turn. It reads as EXHAUSTED instead.
   */
  it("a CORRUPT state file reads as exhausted, so it can never reopen the gate", () => {
    writeFileSync(communityInviteStatePath(env()), "{ partially-writ", "utf8");
    expect(readCommunityInviteState(env()).shownCount).toBe(MAX_LIFETIME_SHOWS);
    expect(communityInviteLine(READY, env())).toBeUndefined();
  });

  it("an ABSENT file still means `never shown` - only a present-but-unusable one is exhausted", () => {
    expect(readCommunityInviteState(env()).shownCount).toBe(0);
    expect(communityInviteLine(READY, env())).toBe(COMMUNITY_INVITE_LINE);
  });

  it("declining to show consumes nothing", () => {
    expect(communityInviteLine({ ...READY, hasAccount: true }, env())).toBeUndefined();
    expect(readCommunityInviteState(env()).shownCount).toBe(0);
  });

  it("called on every turn of a long day, it fires ONCE", () => {
    const day = at("2026-08-01T09:00:00.000Z");
    const shown = Array.from({ length: 200 }, () => communityInviteLine(READY, env(), day)).filter(Boolean);
    expect(shown).toHaveLength(1);
  });

  /**
   * THE RESET THE USER OWNS. Deleting the state file makes the invitation eligible again, and that is
   * intended: the actor is whoever can write `~/.compaction`, i.e. the user, and this is the only reset
   * the module offers. Pinned so it is not "fixed" later by hardening the product against its owner —
   * the cap exists to survive ACCIDENT (see the unwritable/corrupt cases above), not the user.
   */
  it("deleting only the state file does NOT reset it - the reserved slots still stand", () => {
    for (let i = 0; i < MAX_LIFETIME_SHOWS; i++) {
      expect(communityInviteLine(READY, env(), at(`2026-0${i + 1}-01T00:00:00.000Z`))).toBe(COMMUNITY_INVITE_LINE);
    }
    expect(communityInviteLine(READY, env(), at("2027-01-01T00:00:00.000Z"))).toBeUndefined();
    // The slot markers are the reservation; the JSON only records WHEN. Losing the JSON alone must not
    // hand back three more showings, or an accidental deletion re-opens the invitation.
    rmSync(communityInviteStatePath(env()), { force: true });
    expect(communityInviteLine(READY, env(), at("2027-02-01T00:00:00.000Z"))).toBeUndefined();
  });

  /**
   * THE RESET THE USER OWNS. Clearing the Compaction config directory clears the markers with
   * everything else, and the invitation becomes available again. That is intended and is the only reset
   * offered: the actor is whoever can write `~/.compaction`, i.e. the user. Pinned so it is not later
   * "hardened" against the product's own owner.
   */
  it("clearing the config directory DOES reset it - deliberately, and not a defect", () => {
    for (let i = 0; i < MAX_LIFETIME_SHOWS; i++) {
      expect(communityInviteLine(READY, env(), at(`2026-0${i + 1}-01T00:00:00.000Z`))).toBe(COMMUNITY_INVITE_LINE);
    }
    expect(communityInviteLine(READY, env(), at("2027-01-01T00:00:00.000Z"))).toBeUndefined();
    rmSync(configDir, { recursive: true, force: true });
    expect(communityInviteLine(READY, env(), at("2027-02-01T00:00:00.000Z"))).toBe(COMMUNITY_INVITE_LINE);
  });

  /** Across years of use, the total is bounded by the lifetime cap and nothing else. */
  it("called every day for two years, it fires at most the lifetime cap", () => {
    let fired = 0;
    for (let day = 0; day < 730; day++) {
      const when = at(new Date(Date.UTC(2026, 0, 1) + day * 86_400_000).toISOString());
      if (communityInviteLine(READY, env(), when)) fired++;
    }
    expect(fired).toBe(MAX_LIFETIME_SHOWS);
  });

  /**
   * The line points at an action and makes no claim of its own. The receipt above it is the evidence
   * surface; a CTA carrying its own number would be a second, softer place to make a claim that surface
   * is held to.
   */
  it("carries no number, percentage, or saving - only the existing activation command", () => {
    expect(COMMUNITY_INVITE_LINE).toContain("compaction login");
    expect(COMMUNITY_INVITE_LINE).not.toMatch(/\d/);
    expect(COMMUNITY_INVITE_LINE).not.toMatch(/%|\$|saved|savings/i);
  });

  /** Content-free, like every other Compaction store: a schema tag, a count, a timestamp. */
  it("the persisted state holds nothing but a schema tag, a count and a timestamp", () => {
    communityInviteLine(READY, env(), at("2026-08-01T00:00:00.000Z"));
    const raw: unknown = JSON.parse(readFileSync(communityInviteStatePath(env()), "utf8"));
    expect(Object.keys(raw as object).sort()).toEqual(["lastShownAt", "schema", "shownCount"]);
  });
});
