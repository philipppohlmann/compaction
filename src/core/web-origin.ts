/**
 * The product WEBSITE origin, as the CLI resolves it (PUBLIC CLI/SDK code).
 *
 * Reads env ONLY. Persists NOTHING, makes no network call. Same discipline as
 * `src/core/api-client/config.ts`: pure, same env in → same origin out.
 *
 * WHY THIS EXISTS. Every browser handoff the CLI performs must land on a page that is
 * REALLY DEPLOYED — a command that opens a dead host is worse than one that just prints a
 * line. Before this module the one hardcoded handoff (`compaction upgrade`) pointed at the
 * launch host, which does not resolve at all pre-launch: the DNS lookup fails, so the user
 * got a browser error instead of the pricing page. Resolving every handoff from ONE origin
 * means the next handoff cannot re-hardcode a host, and a single env flips all of them
 * together.
 *
 * NOT the API server. `COMPACTION_API_URL` (`api-client/config.ts`) is where the CLI TALKS;
 * this is where it SENDS THE USER'S BROWSER. They are deliberately separate, and the API
 * default deliberately stays local. The device-login flow is NOT governed here either — it
 * opens the `verification_uri_complete` the API server returns, so it follows the API URL.
 *
 * NOT `COMPACTION_WEB_BASE_URL`. That env is read by the hosted API SERVER
 * (`apps/api/src/config.ts`) to build the verification links it hands back. This one is read
 * by the CLI on the user's machine. Different process, different operator, different name.
 */

/** Env override for the website origin. A staging/preview deploy can be exercised with it. */
export const WEB_ORIGIN_ENV = "COMPACTION_WEB_ORIGIN";

/**
 * The canonical product origin: the host every browser handoff lands on.
 *
 * ONE CONSTANT, DELIBERATELY. Before this module the single hardcoded handoff (`compaction
 * upgrade`) named its host inline, which is how a second handoff ends up naming a different
 * one. Resolving every handoff from here means a host change is one edit, and a test asserts
 * that no other file under `src/` names a website host at all.
 *
 * The site is a separate deployment with its own release cycle, so this constant is an
 * agreement about a URL, not a claim about what is currently served there. Anyone pointing
 * the CLI at a preview or staging deploy sets `COMPACTION_WEB_ORIGIN` instead of editing it.
 */
export const DEFAULT_WEB_ORIGIN = "https://compaction.dev";

/** A minimal env shape so this stays pure/testable (defaults to `process.env`). */
export type EnvLike = Record<string, string | undefined>;

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

/**
 * Resolve the website origin. Blank/whitespace-only is treated as UNSET (an exported-but-empty
 * shell variable should not brick every handoff), and a trailing slash is normalized off so
 * callers can always join with a leading-slash path.
 */
export function webOrigin(env: EnvLike = process.env): string {
  const raw = (env[WEB_ORIGIN_ENV] ?? "").trim();
  return stripTrailingSlash(raw === "" ? DEFAULT_WEB_ORIGIN : raw);
}

/**
 * Join the resolved origin with a site-relative path.
 *
 * Callers pass the route (`/pricing`), never a host — that is the point: a future handoff
 * cannot reintroduce a hardcoded host without going around this function. A missing leading
 * slash is added rather than rejected, because a thrown error at a browser handoff would be a
 * worse outcome than a normalized URL.
 */
export function webUrl(path: string, env: EnvLike = process.env): string {
  const trimmed = path.trim();
  const suffix = trimmed === "" || trimmed === "/" ? "" : trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return `${webOrigin(env)}${suffix}`;
}
