import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `LeaseVerdict.meteredBalanceExhausted` IS A REPORTING FACT, NOT A GATE INPUT.
 *
 * It replaced a terminal `allowance-exhausted` VERDICT whose defect was that a lease reader decided the
 * balance question for BOTH routes at once: route-blind callers acted on it and withdrew full apply from
 * subscription traffic, which consumes no allowance. The field is the same
 * information with the decision removed. Wiring an enforcement path to it recreates the defect under a
 * new name, which is why the set of modules allowed to READ it is closed rather than open.
 *
 * WHAT THIS CATCHES (the realistic regression, at the place it would most likely be written): any new
 * reference to the identifier anywhere in `src/**` outside the sanctioned files — in particular
 * anywhere under `src/core/gateway/**` (the apply path), `src/core/usage/**` (metering + the
 * authoritative under-lock ceiling), or `src/engine/**`. Those three trees are asserted to zero
 * separately, so the failure names the boundary that was crossed rather than only the allowlist.
 *
 * IT CHECKS **WHICH** FILES MENTION THE FIELD, NEVER **HOW** — so EVERY ALLOWLIST ADDITION ENLARGES A
 * BLIND SPOT THIS GUARD NAMES BUT CANNOT SEE. `usage.ts` (added in #833) is now a file where a future
 * enforcement use of the flag would pass here silently, exactly as `onboarding-preferences.ts` already
 * was. The per-entry rationale strings ARE the mitigation, not decoration: they record what each reader
 * is permitted to do with the flag, so a reviewer has something concrete to check the code against. On
 * ANY change to a listed file's use of this flag, re-read that file's entry and confirm it is still
 * true — and if it is not, the question is whether the new use belongs on the route rather than whether
 * the entry needs rewording.
 *
 * WHAT THIS DOES NOT CATCH — stated plainly, because a guard that implies more coverage than it has is
 * worse than no guard:
 *
 *  1. An enforcement use added INSIDE an allowlisted file. `onboarding-preferences.ts` is the live risk:
 *     `clampTier` sits there, and a clamp on the balance would be invisible here.
 *  2. An INDIRECT gate — an allowlisted file passing the boolean, or something derived from it
 *     (`allowancePauseScope`, `allowanceResetsOn`), to a caller that gates on it.
 *  3. A gate written against `allowanceTokens <= 0` directly instead of the boolean. That is a fresh
 *     re-derivation of the same collapse and reads nothing this test can see.
 *
 * All three are covered BEHAVIORALLY, and those tests are the real protection — this one only closes the
 * cheap textual path:
 *  - `tests/core/allowance-ceiling-surface.test.ts` — an issuer-exhausted lease keeps `tier === "full"`,
 *    and `effectiveOpenTier` agrees with `resolveOpenTier().tier` (catches 1 and 3 at the clamp).
 *  - `tests/core/subscription-apply-independent-of-allowance.test.ts` — end-to-end through the real
 *    gateway: subscription applies and api-key refuses on the SAME exhausted device (catches 1, 2 and 3
 *    wherever they would actually change behavior).
 *  - `tests/core/usage-metering.test.ts` — the under-lock ceiling still refuses at exactly zero.
 *
 * If this fails, do NOT add the new file to the allowlist reflexively. Ask first whether the new reader
 * is deciding something; if it is, the decision belongs on the route, not on the verdict field.
 */
const REPO_ROOT = join(__dirname, "..", "..");
const SRC = join(REPO_ROOT, "src");
const FIELD = "meteredBalanceExhausted";

/** The file that DECLARES and sets the field. Not a reader — it is the reporting site itself. */
const DECLARATION_SITE = "src/core/entitlement/lease-store.ts";

/**
 * The CLOSED list of modules permitted to READ the field, each with the reason it may. Every entry is a
 * reporting/scoping use: none of them refuses, authorizes, or clamps anything on the balance.
 *
 * MIRRORED BY THE FIELD'S DOCBLOCK in `src/core/entitlement/lease-store.ts` — which is where this guard
 * SENDS maintainers for the contract, so a stale list there is worse than no list at all: it points
 * people at a wrong contract with the authority of a right one. `names exactly the readers the field's
 * own docblock names` (below) parses that list and fails if the two drift. Update both in lockstep.
 */
const SANCTIONED_READERS: Record<string, string> = {
  "src/core/onboarding-preferences.ts": "scopes the pause notice to `api-key-route`; changes no tier",
  "src/cli/commands/lease.ts": "`lease status` copy — a valid lease whose metered balance is spent",
  "src/cli/commands/mode.ts": "`mode full` copy — enables the mode and scopes the promise to the route",
  "src/cli/commands/usage.ts":
    "`usage` chooses WHICH remaining-line to print, and its number, label and copy prefix: a " +
    "server-signed zero is definitive, so it is reported rather than deferred to the journal-integrity " +
    "fallback. Display ordering; refuses nothing"
};

/** Every file allowed to mention the field at all — the readers plus the declaration site. */
const SANCTIONED_MENTIONS = [DECLARATION_SITE, ...Object.keys(SANCTIONED_READERS)].sort();

/**
 * Trees where a reference would BE the regression: the gateway apply path, the metering/journal tree
 * that owns the authoritative ceiling, and the private engine. Asserted separately from the allowlist so
 * a violation reports which boundary was crossed.
 */
const ENFORCEMENT_TREES = ["src/core/gateway", "src/core/usage", "src/engine"];

/** Every `.ts`/`.tsx` file under `src/`, as repo-relative POSIX paths. */
function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, acc);
    } else if (/\.tsx?$/.test(entry)) {
      acc.push(relative(REPO_ROOT, full).split(sep).join("/"));
    }
  }
  return acc;
}

/** Repo-relative paths of every `src/**` file mentioning the field. */
function filesMentioningField(): string[] {
  return sourceFiles(SRC)
    .filter((path) => readFileSync(join(REPO_ROOT, path), "utf8").includes(FIELD))
    .sort();
}

/**
 * The reader paths the FIELD'S OWN DOCBLOCK names, parsed out of it.
 *
 * Scoped to the comment block immediately preceding the declaration, so the paths in its
 * "WHERE THE METERED BALANCE GATE ACTUALLY LIVES" section — which name the two gates and must NOT be
 * read as sanctioned readers — cannot be picked up: only lines shaped as a list item carrying a
 * backticked `src/…` path count, and those gate references are numbered items naming shorter paths.
 *
 * Deliberately format-sensitive within that block, which is the point: the list is a contract, and a
 * rewrite that loses its shape should fail loudly here rather than quietly stop being checked. The
 * non-vacuity assertion below is what makes that failure impossible to mistake for a pass.
 */
function readersNamedInFieldDocblock(): string[] {
  const source = readFileSync(join(SRC, "core", "entitlement", "lease-store.ts"), "utf8");
  const declaration = source.indexOf(`${FIELD}?: boolean`);
  expect(declaration, "the field declaration must be findable").toBeGreaterThan(-1);
  const docblock = source.slice(0, declaration).lastIndexOf("/**");
  expect(docblock, "the field must carry a docblock").toBeGreaterThan(-1);
  return [...source.slice(docblock, declaration).matchAll(/^\s*\*\s+-\s+`(src\/[^`]+)`/gm)]
    .map((match) => match[1])
    .sort();
}

describe("meteredBalanceExhausted is reported, never enforced on", () => {
  it("is mentioned ONLY by the sanctioned reporting/scoping modules", () => {
    // Set equality in both directions: a new reader fails, and so does a stale allowlist entry for a
    // module that no longer reads it (which would silently widen the permitted surface).
    expect(filesMentioningField()).toEqual(SANCTIONED_MENTIONS);
  });

  /**
   * THE ALLOWLIST AND THE FIELD CONTRACT MUST NOT DRIFT. #833 added a fifth mention and updated only
   * this file, leaving the field's docblock asserting a closed list of three — and this guard is what
   * TELLS maintainers to read that docblock. A stale list at the place people are sent carries the
   * authority of a correct one, which is worse than no list. So the two are checked against each other.
   */
  it("names exactly the readers the field's own docblock names", () => {
    expect(readersNamedInFieldDocblock()).toEqual(Object.keys(SANCTIONED_READERS).sort());
  });

  it("appears NOWHERE on the apply path, the metering tree, or the engine", () => {
    // The balance gate lives in `server.ts`'s route-gated branch and in `appendUsageEvent`'s under-lock
    // ceiling, both working off `allowanceTokens` + the journal. Neither needs this boolean, and a
    // reference appearing here is the route-blind coupling this field exists to have removed.
    for (const tree of ENFORCEMENT_TREES) {
      const offenders = filesMentioningField().filter((path) => path.startsWith(`${tree}/`));
      expect(offenders, `${tree} must not read the reported metered balance`).toEqual([]);
    }
  });

  it("the guard is non-vacuous: the field and its documented list really are present", () => {
    // Without this, a rename of the field would turn the mention assertions into "no files, no
    // offenders", and a reformatted docblock would turn the mirror assertion into "no entries, none
    // expected" — permanently green checks over nothing at all. Both scans must find something, and
    // the docblock scan must find as many entries as the allowlist declares.
    expect(filesMentioningField().length).toBeGreaterThan(0);
    expect(readFileSync(join(SRC, "core", "entitlement", "lease-store.ts"), "utf8")).toContain(`${FIELD}?: boolean`);
    expect(readersNamedInFieldDocblock().length).toBe(Object.keys(SANCTIONED_READERS).length);
    expect(readersNamedInFieldDocblock().length).toBeGreaterThan(0);
  });
});
