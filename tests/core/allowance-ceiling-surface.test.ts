import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { currentPeriodId, periodEndUtc } from "../../src/core/entitlement/lease.js";
import { formatReceiptLine, receiptLineOutputOnly, upgradeNoticeLines } from "../../src/core/gateway/receipt-line.js";
import { UPGRADE_CTA_LABEL } from "../../src/core/upgrade-cta.js";
import { hyperlinkTarget } from "../../src/core/terminal-hyperlink.js";
import { proUrl } from "../../src/core/pro-destination.js";
import { resolveOpenTier, effectiveOpenTier, writeProductMode } from "../../src/core/onboarding-preferences.js";
import { readLeaseVerdict } from "../../src/core/entitlement/lease-store.js";
import { meterConfirmedApply } from "../../src/core/usage/usage-metering.js";
import { computeStatusLine } from "../../src/cli/commands/statusline.js";
import { provisionValidLease } from "../helpers/lease-fixture.js";

/**
 * A terminal with NO OSC 8 support, so these assertions read the DEGRADED rendering: `label: url`.
 * Chosen deliberately — the plain form is the one that must still carry the destination, and pinning
 * it means a regression that drops the URL when hyperlinks are unavailable fails here rather than
 * hiding inside an escape sequence. The encoded-link target is proven separately, against `osc8`.
 */
const PLAIN_TEXT_ENV = { COMPACTION_HYPERLINKS: "0" } as NodeJS.ProcessEnv;

/**
 * THE CEILING IS VISIBLE — the live claims defect this closes.
 *
 * Before this, a Community user who spent their period allowance saw their per-turn line drop to
 * `apply off` with no reason and no end date. The gateway declined (to a log nobody reads), the lease
 * verdict ended on the allowance, and the tier resolver clamped `full → observe`. The clamp is what
 * made it silent, because it collapsed "you never asked for full" and "your allowance is gone" into
 * the same rendered word. (The clamp on an issuer-exhausted lease was a second, larger defect in its
 * own right — see the issuer-exhausted block below — and no longer happens on either route.)
 *
 * These tests pin the three properties that make it honest: the reset date comes from the PERIOD (not
 * the lease's expiry), the surface says what happened and when it ends, and it names no figure, no
 * price, and no URL.
 */

describe("periodEndUtc — the allowance reset date", () => {
  it("is 00:00 UTC on the 1st of the FOLLOWING month", () => {
    expect(periodEndUtc("2026-08")).toBe("2026-09-01");
    expect(periodEndUtc("2026-01")).toBe("2026-02-01");
  });

  it("rolls the year over at December", () => {
    expect(periodEndUtc("2026-12")).toBe("2027-01-01");
  });

  it("returns undefined for anything malformed rather than naming a fabricated date", () => {
    for (const bad of ["", "2026", "2026-13", "2026-00", "26-08", "2026-8", "not-a-period"]) {
      expect(periodEndUtc(bad), bad).toBeUndefined();
    }
  });
});

describe("the ceiling clause", () => {
  it("says what happened, when it ends, and where to convert", () => {
    expect(
      formatReceiptLine({
        observedInput: 100,
        outputTokens: 20,
        tier: "observe",
        allowanceResetsOn: "2026-09-01",
        ctaEnv: PLAIN_TEXT_ENV
      })
    ).toBe(
      // `input paused`, NOT `observed input 100`: at the ceiling the input axis states the pause. The
      // observed count is not wrong, but it is the one number a blocked user could read as a saving.
      "compaction · input paused · output 20 · apply off · Community limit reached · input optimization paused until 2026-09-01 · " +
        `${UPGRADE_CTA_LABEL}: ${proUrl(PLAIN_TEXT_ENV)}`
    );
  });

  it("rides immediately after the tier label it explains", () => {
    const line = formatReceiptLine({
      outputTokens: 20,
      tier: "observe",
      allowanceResetsOn: "2026-09-01",
      shortReceiptId: "abcd1234",
      ctaEnv: PLAIN_TEXT_ENV
    });
    expect(line.indexOf("apply off")).toBeLessThan(line.indexOf("Community limit reached"));
    expect(line.indexOf("Community limit reached")).toBeLessThan(line.indexOf("id abcd1234"));
  });

  it("is OMITTED when there is no reset date (never a bare 'paused' with no end)", () => {
    expect(formatReceiptLine({ outputTokens: 20, tier: "observe" })).not.toContain("allowance");
  });

  /**
   * NARROWED TWICE. This guard once forbade ANY mention of converting at the ceiling; the ceiling then
   * became the ONE place conversion is mentioned (2026-08-03), and it permitted a local
   * COMMAND but still forbade a URL. That last rule was the defect: a blocked user was told a state
   * and given no reachable way out of it. The ceiling now carries the canonical Pro destination.
   *
   * What the guard was really protecting is unchanged and still asserted: NO price, NO purchase verb,
   * NO token figure, and the ONE permitted URL is the canonical `proUrl` — nothing else. A second
   * destination, a price, or a "buy" reaching this line still fails here.
   */
  it("names no figure, no price and no purchase verb, and links ONLY the canonical Pro destination", () => {
    const surfaces = [
      formatReceiptLine({ observedInput: 100, outputTokens: 20, tier: "observe", allowanceResetsOn: "2026-09-01", ctaEnv: PLAIN_TEXT_ENV }),
      receiptLineOutputOnly({ outputTokens: 20, providerReported: false, shapingActive: false, tier: "observe", allowanceResetsOn: "2026-09-01", ceiling: { reason: "exhausted", resetsOn: "2026-09-01", ctaEnv: PLAIN_TEXT_ENV } }) ?? "",
      upgradeNoticeLines({ reason: "exhausted", resetsOn: "2026-09-01", env: PLAIN_TEXT_ENV }).join("\n")
    ];
    const canonical = proUrl(PLAIN_TEXT_ENV);
    for (const s of surfaces) {
      expect(s).not.toMatch(/\$\d/);
      expect(s).not.toMatch(/purchase|buy|checkout|monthly|per month|\bTeam\b/i);
      // Ceiling behavior is refuse/degrade: no remaining/consumed token figure is surfaced.
      expect(s).not.toMatch(/\b\d+(,\d{3})*\s*(tokens|remaining|left)\b/i);
      // EVERY url on the surface must be the canonical one. Asserting "contains proUrl" would pass a
      // line that also carried a second, different destination beside it — which is the specific thing
      // one-canonical-destination forbids.
      const urls = s.match(/https?:\/\/\S+/g) ?? [];
      expect(urls.length, "the ceiling must name a destination").toBeGreaterThan(0);
      for (const url of urls) expect(url).toBe(canonical);
    }
  });

  it("the per-turn ceiling clause shows the CTA, and ONLY at the ceiling", () => {
    const atCeiling = formatReceiptLine({ outputTokens: 20, tier: "observe", allowanceResetsOn: "2026-09-01", ctaEnv: PLAIN_TEXT_ENV });
    expect(atCeiling).toContain(UPGRADE_CTA_LABEL);
    // INSIDE the allowance nothing advertises conversion — the whole point of the rule, and
    // the reason the CTA is credible on the turns that do carry it (no conversion spam).
    const inside = formatReceiptLine({ outputTokens: 20, tier: "basic" });
    expect(inside).not.toMatch(/\b(pro|upgrade)\b/i);
    expect(inside).not.toMatch(/https?:\/\//);
    expect(inside).not.toContain("allowance");
    expect(inside).not.toContain("Community limit");
  });
});

// ---- The resolver + the real status line -----------------------------------------------------

const DEV_ROOT_UNSET = { COMPACTION_LEASE_DEV_ROOT: undefined };
let dir = "";
let env: NodeJS.ProcessEnv = {};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ceiling-surface-"));
  env = { ...DEV_ROOT_UNSET, COMPACTION_CONFIG_DIR: dir } as NodeJS.ProcessEnv;
});
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/**
 * These tests drive the resolver through the shapes it must handle without minting a signing root
 * (the exhausted-lease cases below do that), and assert the two properties that matter at this
 * layer: the tier is unchanged, and `observe` for a non-full user carries no ceiling.
 */
describe("resolveOpenTier keeps the gate identical and only ADDS the reason", () => {
  it("agrees with effectiveOpenTier on every persisted mode (one clamp, gate and label)", async () => {
    for (const mode of ["observe", "basic", "full"] as const) {
      writeProductMode(mode, env);
      expect((await resolveOpenTier(env)).tier).toBe(effectiveOpenTier(env));
    }
  });

  it("reports NO ceiling for an observe/basic user — they were promised nothing about full apply", async () => {
    for (const mode of ["observe", "basic"] as const) {
      writeProductMode(mode, env);
      expect((await resolveOpenTier(env)).allowanceResetsOn).toBeUndefined();
    }
  });

  it("a persisted `full` with no usable lease still clamps to observe and claims nothing", async () => {
    writeProductMode("full", env);
    writeFileSync(join(dir, "lease.json"), "{not json", "utf8");
    const resolved = await resolveOpenTier(env);
    expect(resolved.tier).toBe("observe");
    // An invalid lease is not an exhausted allowance: no reset date is invented for it.
    expect(resolved.allowanceResetsOn).toBeUndefined();
    expect(resolved.allowancePauseScope).toBeUndefined();
  });
});

describe("the status line renders the ceiling and stays fail-open", () => {
  it("carries the ceiling on the output-only fallback path when the resolver reports one", async () => {
    // Drive the formatter directly with a resolver result — the status line's own ceiling wiring is
    // the same field, and this keeps the assertion on the RENDERED contract.
    const line = receiptLineOutputOnly({
      outputTokens: 412,
      providerReported: false,
      shapingActive: false,
      tier: "observe",
      allowanceResetsOn: periodEndUtc(currentPeriodId())
    });
    expect(line).toContain("apply off");
    expect(line).toContain("Community limit reached · input optimization paused until");
  });

  it("never throws and never goes empty, whatever the receipt reader does", async () => {
    const line = await computeStatusLine('{"cwd":"/nope"}', {
      env,
      readReceipt: async () => {
        throw new Error("receipt store exploded");
      }
    });
    expect(typeof line).toBe("string");
    expect(line).not.toBe("");
  });
});

/**
 * END-TO-END on a REAL issuer-exhausted lease: a dev-signed, device-bound, in-period lease whose
 * allowance is zero. This is the exact state that used to render a bare `apply off`.
 *
 * IT IS ALSO THE STATE THAT USED TO TAKE FULL APPLY AWAY FROM SUBSCRIPTION TRAFFIC. The verdict ended
 * the entitlement chain on the allowance, so the tier clamped to `observe` and every route lost full
 * apply — including the one that consumes no allowance at all. The tier now stays `full` and
 * the pause names the traffic it covers.
 */
describe("a REAL issuer-exhausted lease pauses the METERED route only, and says so", () => {
  function exhausted(): NodeJS.ProcessEnv {
    // allowance_tokens: 0 is precisely what the issuer signs once the period's consumption is spent.
    return provisionValidLease(dir, { allowance_tokens: 0 }, { productMode: "full" }) as NodeJS.ProcessEnv;
  }

  it("keeps the tier at `full` — the entitlement is intact, only the metered balance is gone", async () => {
    const leaseEnv = exhausted();
    // Clamping here withdrew subscription full apply, which owes the API allowance nothing. The gate
    // reads the same clamp, so this assertion is also what keeps the gateway applying on that route.
    expect((await resolveOpenTier(leaseEnv)).tier).toBe("full");
    expect(effectiveOpenTier(leaseEnv)).toBe("full");
  });

  it("reports the period's reset date (not the lease expiry), scoped to API-key routed traffic", async () => {
    const leaseEnv = exhausted();
    const resolved = await resolveOpenTier(leaseEnv);
    // Not `all-routes`: an exhausted API allowance never stops subscription-routed full apply, so the
    // unqualified claim would be false for exactly the users this fix restores apply for.
    expect(resolved.allowancePauseScope).toBe("api-key-route");
    expect(resolved.allowanceResetsOn).toBe(periodEndUtc(currentPeriodId()));
    // The lease's own expiry is WITHIN the period and is renewed inside it — surfacing it as the
    // allowance reset would promise the allowance back days or weeks early.
    expect(resolved.allowanceResetsOn).not.toBe(new Date().toISOString().slice(0, 10));
  });

  it("reports the reset date even when the local journal does NOT verify (server-authoritative)", async () => {
    // The issuer's zero needs no journal, so an unverifiable journal cannot silence this pause — and
    // reporting it is not a fabricated reason, because the lease itself carries the fact.
    const leaseEnv = exhausted();
    writeFileSync(join(dir, "usage-journal.jsonl"), "{not json\n", "utf8");
    const resolved = await resolveOpenTier(leaseEnv);
    expect(resolved.allowanceResetsOn).toBe(periodEndUtc(currentPeriodId()));
    expect(resolved.allowancePauseScope).toBe("api-key-route");
  });

  it("the status line explains the pause and names the route it covers", async () => {
    const leaseEnv = exhausted();
    const line = await computeStatusLine('{"cwd":"/x","usage":{"output_tokens":286}}', { env: leaseEnv, readReceipt: async () => undefined });
    expect(line).toContain("Community limit reached · API-key input optimization paused until");
    expect(line).toContain(periodEndUtc(currentPeriodId()) as string);
    // THE CONVERSION PATH IS NOW REQUIRED, not forbidden. This assertion used to read
    // `not.toMatch(/https?:/)` — a rule that made the surface a dead end for the one user it exists
    // to serve. What stays forbidden is a PRICE: the ceiling refuses, it never charges.
    expect(line).toContain(UPGRADE_CTA_LABEL);
    expect(line).not.toMatch(/\$\d/);
  });

  it("a VALID (non-exhausted) lease carries no ceiling text at all", async () => {
    const leaseEnv = provisionValidLease(dir, {}, { productMode: "full" }) as NodeJS.ProcessEnv;
    expect((await resolveOpenTier(leaseEnv)).allowanceResetsOn).toBeUndefined();
    const line = await computeStatusLine('{"cwd":"/x","usage":{"output_tokens":286}}', { env: leaseEnv, readReceipt: async () => undefined });
    expect(line).not.toContain("Community limit reached");
    expect(line).not.toContain(UPGRADE_CTA_LABEL);
  });
});

/**
 * THE WINDOW THE CEILING SURFACE USED TO MISS ENTIRELY.
 *
 * Between a positive lease being issued and the next reconciliation, every metered debit lives in
 * the LOCAL usage journal and nowhere else. `readLeaseVerdict` reports `lease-valid` for that whole
 * interval, so a resolver that consulted only the lease declared the allowance unspent for exactly
 * as long as the local ceiling was the thing doing the refusing — the gateway declined metered full
 * apply (`server.ts`) while every surface stayed silent. The ceiling was inert in its own window.
 */
describe("a LOCALLY spent allowance (valid lease, not yet reconciled) is visible", () => {
  /** A device whose small signed allowance has been fully consumed by real, chain-valid debits. */
  async function locallySpent(allowanceTokens = 400): Promise<NodeJS.ProcessEnv> {
    const leaseEnv = provisionValidLease(
      dir,
      { allowance_tokens: allowanceTokens },
      { productMode: "full" }
    ) as NodeJS.ProcessEnv;
    const result = await meterConfirmedApply(
      {
        routeType: "api-key",
        workflow: "codex",
        provider: "openai",
        periodId: currentPeriodId(),
        allowanceTokens,
        receiptId: "rec-ceiling",
        meteredOptimizedInputTokens: allowanceTokens,
        preMutationBody: "x".repeat(40)
      },
      leaseEnv
    );
    expect(result.metered, "the fixture debit must actually commit").toBe(true);
    return leaseEnv;
  }

  it("the lease alone still says VALID — which is why reading it alone was not enough", async () => {
    const leaseEnv = await locallySpent();
    expect(readLeaseVerdict(leaseEnv).label).toBe("lease-valid");
  });

  it("reports the ceiling with the period's reset date, scoped to API-key routed traffic", async () => {
    const resolved = await resolveOpenTier(await locallySpent());
    expect(resolved.allowanceResetsOn).toBe(periodEndUtc(currentPeriodId()));
    expect(resolved.allowancePauseScope).toBe("api-key-route");
  });

  it("does NOT clamp the tier: subscription full apply is non-debitable and still runs", async () => {
    const leaseEnv = await locallySpent();
    // Clamping here would switch off apply for traffic that owes the allowance nothing — and would
    // also change the gateway gate, since it reads the same clamp.
    expect((await resolveOpenTier(leaseEnv)).tier).toBe("full");
    expect(effectiveOpenTier(leaseEnv)).toBe("full");
  });

  it("reports NOTHING while allowance remains (no pause invented from a partially used period)", async () => {
    const allowanceTokens = 400;
    const leaseEnv = provisionValidLease(dir, { allowance_tokens: allowanceTokens }, { productMode: "full" }) as NodeJS.ProcessEnv;
    await meterConfirmedApply(
      {
        routeType: "api-key",
        workflow: "codex",
        provider: "openai",
        periodId: currentPeriodId(),
        allowanceTokens,
        receiptId: "rec-partial",
        meteredOptimizedInputTokens: 100,
        preMutationBody: "x".repeat(40)
      },
      leaseEnv
    );
    const resolved = await resolveOpenTier(leaseEnv);
    expect(resolved.allowanceResetsOn).toBeUndefined();
    expect(resolved.allowancePauseScope).toBeUndefined();
  });

  /**
   * Journal integrity, reused rather than reimplemented: an unverifiable journal must not be SUMMED over
   * (which would silently replenish the allowance) — and it must not be reported as a spent allowance
   * either, because "your allowance is gone" would then be a fabricated reason for a refusal that
   * actually happened for a different cause. The gate's own fail-closed decline is unaffected.
   */
  it("an unreadable journal names NO reason rather than inventing a spent allowance", async () => {
    const leaseEnv = await locallySpent();
    writeFileSync(join(dir, "usage-journal.jsonl"), "{not json\n", "utf8");
    const resolved = await resolveOpenTier(leaseEnv);
    expect(resolved.tier).toBe("full");
    expect(resolved.allowanceResetsOn).toBeUndefined();
  });

  it("never throws, whatever the config dir contains (it runs in the per-turn render loop)", async () => {
    await expect(resolveOpenTier({ COMPACTION_CONFIG_DIR: join(dir, "does-not-exist") })).resolves.toEqual({
      tier: "observe"
    });
  });

  it("the status line explains the metered pause on a turn with no gateway receipt", async () => {
    const leaseEnv = await locallySpent();
    const line = await computeStatusLine('{"cwd":"/x","usage":{"output_tokens":286}}', {
      env: leaseEnv,
      readReceipt: async () => undefined
    });
    expect(line).toContain("Community limit reached · API-key input optimization paused until");
    expect(line).toContain(periodEndUtc(currentPeriodId()) as string);
  });
});

/**
 * The pause notice was FALSE for subscription traffic. `optimized-input-v1` is debited on the
 * metered api-key route only, and subscription full apply is explicitly non-debitable, so a globally rendered "Community full apply is paused" told a
 * subscription user their own working product had stopped.
 *
 * The notice is now `upgradeNoticeLines` — one block, one vocabulary, one destination, shared by
 * `status`, `usage`, `lease status`, and `watch`. The scope property below is what it inherited and
 * must keep; the destination is what it gained.
 */
describe("the pause notice names the traffic it actually covers", () => {
  it("scopes the local (api-key) ceiling and says subscription turns are unaffected", () => {
    const notice = upgradeNoticeLines({ reason: "exhausted", resetsOn: "2026-09-01", scope: "api-key-route", env: PLAIN_TEXT_ENV }).join("\n");
    expect(notice).toContain("API-key routed turns");
    expect(notice).toContain("Subscription-routed turns are unaffected");
    expect(notice).toContain("2026-09-01");
  });

  it("keeps the unqualified wording available as the fail-safe default rendering", () => {
    const notice = upgradeNoticeLines({ reason: "exhausted", resetsOn: "2026-09-01", scope: "all-routes", env: PLAIN_TEXT_ENV });
    expect(notice.slice(0, 3)).toEqual([
      "Community input optimization is paused for this period.",
      "Output shaping remains active.",
      "It resumes 2026-09-01."
    ]);
    expect(notice.join("\n")).not.toContain("API-key");
  });

  it("defaults to the BROADER claim when no scope is supplied (never silently narrows a pause)", () => {
    expect(upgradeNoticeLines({ reason: "exhausted", resetsOn: "2026-09-01", env: PLAIN_TEXT_ENV })).toEqual(
      upgradeNoticeLines({ reason: "exhausted", resetsOn: "2026-09-01", scope: "all-routes", env: PLAIN_TEXT_ENV })
    );
  });

  /**
   * `insufficient` is a DIFFERENT SENTENCE, not a synonym. Telling a user with 44,054 tokens left that
   * their allowance is spent is false, and the surface saying it is the one asking them to convert.
   */
  it("distinguishes an insufficient remainder from an exhausted one, and shows the CTA for both", () => {
    const insufficient = upgradeNoticeLines({ reason: "insufficient", env: PLAIN_TEXT_ENV });
    expect(insufficient[0]).toBe(
      "Community input optimization is paused: this period's remaining allowance does not cover a turn of this size."
    );
    expect(insufficient[0]).not.toContain("for this period");
    for (const reason of ["exhausted", "insufficient"] as const) {
      const block = upgradeNoticeLines({ reason, env: PLAIN_TEXT_ENV });
      expect(block).toContain("Output shaping remains active.");
      expect(block).toContain("Upgrade to Pro:");
      expect(block.at(-1)).toBe(proUrl(PLAIN_TEXT_ENV));
    }
  });

  /**
   * THE DEFAULT IS A BACKSTOP, NOT A RENDERING PATH. `all-routes` over-states the pause, which is the
   * safe direction for a caller that forgot the scope (an api-key user is never promised apply that
   * will be refused) — but it is FALSE for a subscription user, so no real resolution may reach it.
   * `resolveOpenTier` is the only producer, and it must always name the scope alongside the date.
   */
  it("the resolver NEVER emits a reset date without a scope, on either exhaustion cause", async () => {
    const issuerExhausted = provisionValidLease(dir, { allowance_tokens: 0 }, { productMode: "full" }) as NodeJS.ProcessEnv;
    const resolved = await resolveOpenTier(issuerExhausted);
    expect(resolved.allowanceResetsOn).toBeDefined();
    expect(resolved.allowancePauseScope).toBe("api-key-route");

    const locallySpentEnv = await (async (): Promise<NodeJS.ProcessEnv> => {
      const allowanceTokens = 400;
      const e = provisionValidLease(dir, { allowance_tokens: allowanceTokens }, { productMode: "full" }) as NodeJS.ProcessEnv;
      await meterConfirmedApply(
        {
          routeType: "api-key",
          workflow: "codex",
          provider: "openai",
          periodId: currentPeriodId(),
          allowanceTokens,
          receiptId: "rec-scope",
          meteredOptimizedInputTokens: allowanceTokens,
          preMutationBody: "x".repeat(40)
        },
        e
      );
      return e;
    })();
    const local = await resolveOpenTier(locallySpentEnv);
    expect(local.allowanceResetsOn).toBeDefined();
    expect(local.allowancePauseScope).toBe("api-key-route");
  });

  it("the per-turn clause carries the same scope", () => {
    expect(
      formatReceiptLine({
        outputTokens: 20,
        tier: "full",
        allowanceResetsOn: "2026-09-01",
        allowancePauseScope: "api-key-route",
        ctaEnv: PLAIN_TEXT_ENV
      })
    ).toContain("Community limit reached · API-key input optimization paused until 2026-09-01");
  });

  it("both scopes still name no figure, no price and no purchase path, and ONE destination", () => {
    for (const scope of ["api-key-route", "all-routes"] as const) {
      const s = upgradeNoticeLines({ reason: "exhausted", resetsOn: "2026-09-01", scope, env: PLAIN_TEXT_ENV }).join("\n");
      expect(s).not.toMatch(/\$\d/);
      expect(s).not.toMatch(/purchase|buy|checkout|monthly|per month|\bTeam\b/i);
      expect(s).not.toMatch(/\b\d+(,\d{3})*\s*(tokens|remaining|left)\b/i);
      const urls = s.match(/https?:\/\/\S+/g) ?? [];
      expect(urls).toEqual([proUrl(PLAIN_TEXT_ENV)]);
    }
  });
});
