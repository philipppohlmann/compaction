/**
 * The Community→Pro call to action (PUBLIC CLI/SDK core, engine-free, network-free).
 *
 * ONE CTA, ONE DESTINATION, ONE VOCABULARY. Five surfaces have to say "your Community input
 * optimization is paused, here is how to convert": the per-turn receipt line, `compaction status`,
 * `compaction usage`, `compaction lease status`, and `compaction watch`. Before this module each of
 * them either said nothing or said it differently, and one of them (the per-turn line — the only
 * surface a user actually reads mid-turn) named a command and explicitly refused to carry a URL. This
 * module owns the words and delegates the address to `pro-destination.ts`, so a user who hits the
 * ceiling sees the same sentence and the same destination wherever they are looking.
 *
 * WHY A LINK AND NOT A PROMPT. The per-turn line is rendered by the host tool (Claude Code's
 * `statusLine`, Codex's `Stop` hook) and has no stdin — there is no keypress to capture, so "press
 * Enter to upgrade" is unreachable there. A terminal hyperlink needs no stdin: the user clicks it, or
 * ignores it, and nothing about the turn changes either way. NOTHING HERE OPENS A BROWSER. Navigation
 * stays a deliberate user act — a click, or typing `compaction upgrade`. A ceiling turn that opened a
 * browser by itself would turn a notification into a hijack, and ceiling turns repeat.
 *
 * NO CONVERSION SPAM. Callers must render this ONLY when the user is actually blocked — Community
 * input optimization unavailable because the period's optimized-input allowance cannot cover this
 * turn. Nothing before the ceiling advertises Pro. A healthy Community turn
 * carries no CTA, and that restraint is the reason the CTA is credible when it does appear.
 */
import { proUrl } from "./pro-destination.js";
import { terminalHyperlink } from "./terminal-hyperlink.js";
import type { AllowancePauseScope } from "./onboarding-preferences.js";

/**
 * WHY Community input optimization is unavailable this turn. Both are the same product state — the
 * period's optimized-input allowance cannot pay for this turn's input compaction — and both must show
 * the CTA. They are distinguished because saying "allowance spent" to a user who still has tokens
 * left is FALSE, and the surface that told them so would be the one asking them to pay.
 *
 *  - `exhausted`    — nothing remains this period (`remaining <= 0`).
 *  - `insufficient` — something remains, but less than THIS turn's optimized input would debit. The
 *    real case that motivated this: 44,054 remaining against a 75,946-token eligible turn. The
 *    session-level resolver (`resolveOpenTier`) fires only on `remaining <= 0` and structurally cannot
 *    express this, which is why the pause is carried per-turn on the receipt instead.
 */
export type AllowancePauseReason = "exhausted" | "insufficient";

/**
 * The CTA label. The arrow marks it as a destination even where the terminal renders no link styling,
 * and it names the PLAN rather than an action verb alone, so the line says what the click buys.
 *
 * A SHIPPED STRING (E8): this is the literal text a user reads. It must never become a placeholder.
 */
export const UPGRADE_CTA_LABEL = "Upgrade to Pro ↗";

/**
 * The per-turn clause that states the product fact the CTA follows from. Deliberate phrasing, and
 * it is the honest one for BOTH pause reasons — a limit was reached either way, which "allowance
 * spent" only gets right in the `exhausted` case.
 */
export const COMMUNITY_LIMIT_CLAUSE = "Community limit reached";

/** The canonical conversion COMMAND. `compaction pro` is its alias; this is the name surfaces print. */
export const UPGRADE_COMMAND = "compaction upgrade";

/**
 * A UTC calendar date, exactly `YYYY-MM-DD`, with a real month and a plausible day.
 *
 * The producer (`periodEndUtc`) can only emit this shape — it validates the period id against its own
 * regex and BUILDS the string from parsed numbers — so a value that fails here did not come from the
 * gateway. It came off disk: the pause is persisted to `.compaction/gateway/receipts.jsonl` under the
 * working directory, and a directory is not a trust boundary (a checked-out repository can carry one).
 */
const RESETS_ON_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/**
 * The reset date if it is one, and nothing at all if it is not.
 *
 * READ-TIME AND RENDER-TIME BOTH. Surfaces interpolate this value into a sentence they print into a
 * terminal, so an unvalidated one is a place a persisted string reaches the screen verbatim — escape
 * bytes, a CR that rewrites the line, an embedded OSC 8 that renders a clickable destination of
 * someone else's choosing INSIDE the notice that exists to tell the user where to go. Refusing the
 * whole sentence is the right failure: a resume date is an extra, and printing none is honest, while
 * printing a sanitized fragment of a value we could not parse is neither.
 */
export function validResetsOn(value: string | undefined): string | undefined {
  return typeof value === "string" && RESETS_ON_RE.test(value) ? value : undefined;
}

/**
 * The CTA as it appears at the end of a per-turn line: a clickable hyperlink where the terminal
 * supports OSC 8, and `Upgrade to Pro ↗: <url>` where it does not. The degraded form keeps the
 * DESTINATION rather than dropping to a bare label — a label with no address is a dead end, and the
 * whole defect this fixes was a ceiling state with no reachable conversion path.
 */
export function upgradeCta(env: NodeJS.ProcessEnv = process.env): string {
  return terminalHyperlink(UPGRADE_CTA_LABEL, proUrl(env), env);
}

/** What the pause covers, in the same vocabulary the per-turn ceiling clause uses. */
const PAUSE_SUBJECT: Record<AllowancePauseScope, string> = {
  "all-routes": "Community input optimization",
  "api-key-route": "Community input optimization on API-key routed turns"
};

export interface UpgradeNoticeInput {
  /** Why input optimization is unavailable. */
  reason: AllowancePauseReason;
  /** The UTC date (`YYYY-MM-DD`) the allowance resets, when it is known. Omitted ⇒ no resume sentence. */
  resetsOn?: string;
  /** Which traffic the pause covers. Defaults to the conservative broader `all-routes`. */
  scope?: AllowancePauseScope;
  /** Environment for destination resolution (tests inject; production passes `process.env`). */
  env?: NodeJS.ProcessEnv;
}

/**
 * The multi-line ceiling + conversion block for the STATE surfaces (`status`, `usage`, `lease status`,
 * `watch`) — the ones with room for sentences, as opposed to the single per-turn line.
 *
 * It states three things and no more: input optimization is paused (and why), output shaping is still
 * running, and where to convert. NO figure, NO price, NO auto-purchase — ceiling behavior is
 * refuse/degrade, so those would all be claims the product does not make. The URL is spelled out in
 * full here rather than hidden behind a hyperlink: these surfaces are read, copied, and pasted into
 * issues, and a bare label survives none of that.
 *
 * Returned as LINES so each caller applies its own styling and indentation.
 */
export function upgradeNoticeLines(input: UpgradeNoticeInput): string[] {
  const scope = input.scope ?? "all-routes";
  const subject = PAUSE_SUBJECT[scope];
  const why =
    input.reason === "insufficient"
      ? `${subject} is paused: this period's remaining allowance does not cover a turn of this size.`
      : `${subject} is paused for this period.`;
  const lines = [why, "Output shaping remains active."];
  // SCOPED, and the narrower case must say what is UNAFFECTED. While a valid lease is merely spent
  // locally, only metered api-key traffic stops; this block renders globally with no way to know
  // which route the next turn takes, so telling a subscription user their apply is paused — when it is
  // running normally — would be exactly the false claim these surfaces exist to prevent.
  if (scope === "api-key-route") lines.push("Subscription-routed turns are unaffected.");
  // VALIDATED, NOT TRUSTED: this value is read back off a persisted receipt. An unparseable one
  // simply gets no resume sentence - the pause and the conversion path are still stated.
  const resetsOn = validResetsOn(input.resetsOn);
  if (resetsOn !== undefined) lines.push(`It resumes ${resetsOn}.`);
  lines.push("", "Upgrade to Pro:", proUrl(input.env ?? process.env));
  return lines;
}
