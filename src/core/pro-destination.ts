/**
 * THE ONE Community→Pro destination (PUBLIC CLI/SDK core, engine-free, network-free).
 *
 * WHY IT LIVES IN CORE. This used to live in `src/cli/commands/pro.ts`, which is fine for a command
 * but not for the surfaces that now have to name the same destination: the per-turn receipt line
 * (`src/core/gateway/receipt-line.ts`) is core and must not import a CLI command module — doing so
 * would drag `chalk`, `commander`, and the browser-opening `login` module into the rendering path of
 * a line printed on every turn. So the RESOLVER moved down here and `pro.ts` re-exports it: there is
 * still exactly one function that answers "where does a user go to convert", and every surface —
 * per-turn line, `status`, `usage`, `lease status`, `watch`, onboarding, `compaction upgrade` — calls
 * it rather than spelling a URL of its own. A second hardcoded URL is the specific defect this
 * placement prevents.
 *
 * NOTHING HERE OPENS A BROWSER. This module resolves a string. The only surface that navigates is
 * `compaction upgrade`/`pro`, where the user typed the command; the per-turn CTA is a link the user
 * chooses to click, never an automatic navigation.
 */
import { hasTerminalControlBytes } from "./terminal-hyperlink.js";
import { DEFAULT_WEB_ORIGIN, webUrl } from "./web-origin.js";

/** Where a user completes the waitlist signup. Overridable so a staging site can be exercised. */
export const PRO_URL_ENV = "COMPACTION_PRO_URL";

/**
 * The CANONICAL Pro conversion destination: the waitlist join surface, scoped to the plan the user is
 * converting from. There is ONE waitlist surface, `/waitlist?plan=<plan>`, and the
 * contextual Community→Pro conversion opens it directly. `/pricing` stays INFORMATIONAL and is not
 * this destination: sending someone who has hit their ceiling to a page that only describes plans
 * makes them hunt for the action they already asked for.
 *
 * A ROUTE, NOT A URL, deliberately. The host comes from `src/core/web-origin.ts`, the single place the
 * CLI names a website.
 */
export const PRO_PATH = "/waitlist?plan=pro";

/**
 * Precedence, most specific first:
 *   1. `COMPACTION_PRO_URL` — a full URL for THIS surface alone. The narrower instrument: someone
 *      pointing just the upgrade handoff at a staging page must not be overridden by a broader origin.
 *   2. `COMPACTION_WEB_ORIGIN` — the whole site moves, this moves with it.
 *   3. The deployed default origin + `PRO_PATH`.
 */
export function proUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (
    safeProUrl((env[PRO_URL_ENV] ?? "").trim()) ??
    safeProUrl(webUrl(PRO_PATH, env)) ??
    `${DEFAULT_WEB_ORIGIN}${PRO_PATH}`
  );
}

/**
 * A candidate destination, or nothing if it is not one this CLI will print.
 *
 * BOTH ENV INPUTS ARE UNTRUSTED, and each falls back to the NEXT step of the precedence above rather
 * than to a hostile value or to no destination at all. An override is an operator convenience; it is
 * not a way to make the CLI's own conversion notice advertise an arbitrary address, and it is not a
 * way to smuggle escape bytes into a line the CLI prints (`osc8` refuses those too, but a destination
 * that a terminal would partly interpret should not reach a renderer in the first place).
 *
 * `https:` ONLY. This URL is shown as the place to hand over an email address, so a plaintext or
 * `file:`/`javascript:` destination is refused rather than degraded. The compiled canonical URL is
 * the floor: there is always exactly one destination, and it is always the real one.
 */
function safeProUrl(candidate: string): string | undefined {
  if (candidate === "" || hasTerminalControlBytes(candidate)) return undefined;
  try {
    return new URL(candidate).protocol === "https:" ? candidate : undefined;
  } catch {
    return undefined;
  }
}
