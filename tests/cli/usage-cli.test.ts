import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { provisionValidLease } from "../helpers/lease-fixture.js";
import { meterConfirmedApply } from "../../src/core/usage/usage-metering.js";
import { usageJournalPath } from "../../src/core/usage/usage-journal.js";
import { currentPeriodId } from "../../src/core/entitlement/lease.js";
import { generateDeviceKeyPair } from "../../src/core/auth/device-flow.js";
import { proUrl } from "../../src/core/pro-destination.js";

/**
 * `compaction usage` USER-VISIBLE output (built CLI). The load-bearing property is claims honesty:
 * the metered unit is labeled a LOCAL ESTIMATE and never a provider bill/cost/savings figure, and a
 * journal that does not verify must NOT be presented with a trustworthy-looking remaining figure
 * (that number is exactly what a tamper would have chosen).
 */
const CLI = join(__dirname, "..", "..", "dist", "cli", "index.js");
const CLI_BUILT = existsSync(CLI);

describe.runIf(CLI_BUILT)("`compaction usage` output honesty", () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

  function run(configDir: string): string {
    // FORCE_COLOR must be DELETED, not blanked: chalk treats an empty FORCE_COLOR as "colors on",
    // which would wrap every asserted substring in ANSI escapes.
    const env = { ...process.env, COMPACTION_CONFIG_DIR: configDir, NO_COLOR: "1" };
    delete env.FORCE_COLOR;
    return execFileSync("node", [CLI, "usage"], { encoding: "utf8", env });
  }

  async function deviceWithOneDebit(): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), "usage-cli-"));
    dirs.push(dir);
    const env = provisionValidLease(dir) as NodeJS.ProcessEnv;
    const result = await meterConfirmedApply(
      {
        routeType: "api-key",
        workflow: "codex",
        provider: "openai",
        periodId: currentPeriodId(),
        allowanceTokens: 2_000_000,
        receiptId: "rec-cli",
        meterVersion: "optimized-input-v1",
        meteredOptimizedInputTokens: 1234,
        estimatedInputTokensAfter: 500,
        preMutationBody: "x".repeat(2000)
      },
      env
    );
    expect(result.metered).toBe(true);
    return dir;
  }

  it("labels the metered unit a LOCAL ESTIMATE and never a bill / cost / savings figure", async () => {
    const dir = await deviceWithOneDebit();
    const out = run(dir);
    expect(out).toContain("1,234");
    expect(out).toContain("(local estimate)");
    expect(out).toContain("not provider-reported");
    expect(out).toContain("not a provider bill, cost, or savings figure");
    expect(out).toContain("Journal integrity: verified");
    // Never a period projection or a money figure on this surface.
    expect(out.toLowerCase()).not.toContain("monthly");
    expect(out.toLowerCase()).not.toContain("per month");
    expect(out).not.toMatch(/\$\d/);
    // No savings/reduction CLAIM. ("savings" appears only inside the not-a-savings-figure
    // disclaimer, so assert the claim shapes rather than the bare word.)
    expect(out.toLowerCase()).not.toMatch(/\bsaved\b|you save|savings of|reduction/);
    // Content-free: journal ids are never rendered.
    const entry = JSON.parse(readFileSync(usageJournalPath({ COMPACTION_CONFIG_DIR: dir }), "utf8").trim());
    expect(out).not.toContain(entry.event_id);
    expect(out).not.toContain(entry.lease_id);
    expect(out).not.toContain(entry.device_id);
  });

  it("an entry this device cannot check reads as UNVERIFIABLE (rotated), never folded into a green `verified`", async () => {
    // A rotated-away device key is a legitimate state, but the entry is still unverifiable HERE.
    // Presenting it as equivalent to a verified entry would blunt the tamper-evidence signal — and a
    // forged `device_key_hash` would ride the same green summary (the chain is keyless to rebuild).
    const dir = await deviceWithOneDebit();
    const path = usageJournalPath({ COMPACTION_CONFIG_DIR: dir });
    const entry = JSON.parse(readFileSync(path, "utf8").trim());
    // Simulate `logout` + fresh `login`: a NEW device key pair, journal untouched.
    const rotated = generateDeviceKeyPair();
    const credPath = join(dir, "credentials.json");
    const creds = JSON.parse(readFileSync(credPath, "utf8"));
    creds.device_public_key = rotated.publicKey;
    creds.device_private_key_pem = rotated.privateKeyPem;
    writeFileSync(credPath, JSON.stringify(creds), "utf8");

    const out = run(dir);
    expect(out).toContain("unverifiable (rotated device)");
    expect(out).toContain("this device cannot check them");
    expect(out).not.toContain("Journal integrity: verified"); // never presented as verified
    expect(entry.device_key_hash).toBeTruthy();
  });

  it("a journal that does not verify shows NO remaining figure and says apply is fail-closed", async () => {
    const dir = await deviceWithOneDebit();
    const path = usageJournalPath({ COMPACTION_CONFIG_DIR: dir });
    const edited = JSON.parse(readFileSync(path, "utf8").trim());
    edited.optimized_input_tokens = 1; // the "replenish my allowance" edit
    writeFileSync(path, `${JSON.stringify(edited)}\n`, "utf8");

    const out = run(dir);
    expect(out).toContain("hash chain broken");
    expect(out).toContain("Allowance remaining: cannot be determined");
    expect(out).toContain("UNVERIFIED");
    expect(out).toContain("fail-closed");
    // The tamper's chosen number is never presented as a trustworthy remaining allowance.
    expect(out).not.toContain("1,999,999");
  });
});

/**
 * THE SIGNED ZERO OUTRANKS THE JOURNAL — the four combinations of (signed allowance) × (journal).
 *
 * With an issuer-exhausted lease AND a malformed/broken local journal,
 * `printUsage` reached its `!trustworthy` branch first and reported that the remaining allowance
 * "cannot be determined" — while the SERVER had already signed that it is zero. The signed number is
 * net of the consumption the service recorded, so it proves no API-key allowance remains whatever the
 * journal holds. Every other surface (`resolveOpenTier`, `lease status`, `mode full`) already read the
 * flag without consulting the journal; `usage` was the outlier, and it is the surface a user opens
 * precisely when they are at the ceiling.
 *
 * The fallback is REORDERED, not removed: a POSITIVE allowance with a broken journal genuinely cannot
 * be determined and must keep saying so — that number is exactly what a tamper would have chosen.
 *
 * NOTHING THE GATEWAY DOES CHANGES. Journal integrity is fail-closed and untouched: an unverifiable journal
 * still refuses metered apply. This only changes what `usage` SAYS, which is why the journal-integrity
 * consequence sentence must still appear in every unverifiable case, next to whichever remaining line ran.
 */
describe.runIf(CLI_BUILT)("`compaction usage` reports the server-authoritative exhausted balance", () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

  function run(configDir: string): string {
    // FORCE_COLOR must be DELETED, not blanked (chalk reads an empty value as "colors on").
    const env = { ...process.env, COMPACTION_CONFIG_DIR: configDir, NO_COLOR: "1" };
    delete env.FORCE_COLOR;
    return execFileSync("node", [CLI, "usage"], { encoding: "utf8", env });
  }

  /** A device whose SIGNED lease carries no allowance — what the issuer signs for a spent period. */
  function signedZeroDevice(): string {
    const dir = mkdtempSync(join(tmpdir(), "usage-zero-"));
    dirs.push(dir);
    provisionValidLease(dir, { allowance_tokens: 0 }, { productMode: "full" });
    return dir;
  }

  /**
   * Commit ONE real, chain-valid, device-signed entry into `dir`'s journal. The ceiling the meter
   * checks is the one PASSED IN, not the lease's — so this can build the on-disk state the finding
   * describes (a real journal beside a zero lease) without needing a device that could have reached it.
   */
  async function commitOneEntry(dir: string, tokens = 1234): Promise<string> {
    const result = await meterConfirmedApply(
      {
        routeType: "api-key",
        workflow: "codex",
        provider: "openai",
        periodId: currentPeriodId(),
        allowanceTokens: tokens * 10,
        receiptId: "rec-zero",
        meterVersion: "optimized-input-v1",
        meteredOptimizedInputTokens: tokens,
        estimatedInputTokensAfter: 500,
        preMutationBody: "x".repeat(2000)
      },
      { COMPACTION_CONFIG_DIR: dir } as NodeJS.ProcessEnv
    );
    expect(result.metered, "the fixture debit must actually commit").toBe(true);
    return usageJournalPath({ COMPACTION_CONFIG_DIR: dir });
  }

  /** The definitive report: a real figure, the scoped exhausted note, and no "cannot be determined". */
  function expectDefinitiveExhausted(out: string): void {
    expect(out).toContain("Allowance remaining:");
    expect(out).not.toContain("cannot be determined");
    // The exhaustion is DEFINITIVE: a real zero figure, not a hedge. The headline sentence this
    // surface used to own is now the shared ceiling copy, so the fact is pinned where it actually
    // lives — the figure — and the consequence is pinned as the shared sentence.
    expect(out).toContain("Allowance remaining: 0");
    expect(out).toContain("is paused for this period.");
    // #832's route scoping must survive: an exhausted API balance never pauses subscription turns.
    expect(out).toContain("Community input optimization on API-key routed turns is paused");
    expect(out).toContain("Subscription-routed turns are unaffected.");
    expect(out).toContain("Output shaping remains active.");
    // And a blocked user is given the one canonical destination.
    expect(out).toContain(proUrl(process.env));
  }

  it("(a) signed zero + MALFORMED journal: definitive exhausted, correctly scoped", async () => {
    const dir = signedZeroDevice();
    writeFileSync(usageJournalPath({ COMPACTION_CONFIG_DIR: dir }), "{not json\n", "utf8");
    const out = run(dir);
    expectDefinitiveExhausted(out);
    // The remaining claim is definitive; the CONSUMED tally read off that journal is still not, and
    // must keep saying so. Conflating the two would trade one honesty defect for another.
    expect(out).toContain("UNVERIFIED");
    // And the journal problem's own consequence is still stated — it blocks metered apply on its own,
    // into the next period once the allowance renews. It used to live in the branch now bypassed.
    expect(out).toContain("while the journal does not verify");
  });

  it("(a2) signed zero + BROKEN CHAIN: same definitive report", async () => {
    const dir = signedZeroDevice();
    const path = await commitOneEntry(dir);
    const edited = JSON.parse(readFileSync(path, "utf8").trim());
    edited.optimized_input_tokens = 1; // the "replenish my allowance" edit
    writeFileSync(path, `${JSON.stringify(edited)}\n`, "utf8");
    const out = run(dir);
    expect(out).toContain("hash chain broken");
    expectDefinitiveExhausted(out);
    expect(out).toContain("while the journal does not verify");
  });

  it("(b) signed zero + GOOD journal: unchanged — the same definitive report", () => {
    const dir = signedZeroDevice();
    const out = run(dir);
    expectDefinitiveExhausted(out);
    // Nothing about a healthy journal is described as unverifiable.
    expect(out).not.toContain("UNVERIFIED");
    expect(out).not.toContain("while the journal does not verify");
  });

  it("(c) POSITIVE allowance + broken journal: still `cannot be determined` (the fallback survives)", async () => {
    // The reorder is a special case, not a removal. Here the remaining figure really is unknowable —
    // it is exactly the number the tamper lowered — so no figure may be shown.
    const dir = mkdtempSync(join(tmpdir(), "usage-positive-broken-"));
    dirs.push(dir);
    provisionValidLease(dir, { allowance_tokens: 2_000_000 }, { productMode: "full" });
    const path = await commitOneEntry(dir);
    const edited = JSON.parse(readFileSync(path, "utf8").trim());
    edited.optimized_input_tokens = 1;
    writeFileSync(path, `${JSON.stringify(edited)}\n`, "utf8");
    const out = run(dir);
    expect(out).toContain("Allowance remaining: cannot be determined");
    expect(out).toContain("while the journal does not verify");
    // NOT exhausted, so nothing may claim it is — and nothing may sell against it. Pinned against the
    // sentence and the destination the surface actually emits at the ceiling, so this guard stays
    // live: asserting the absence of a string the product no longer prints anywhere proves nothing.
    expect(out).not.toContain("is paused for this period");
    expect(out).not.toContain("Upgrade to Pro");
    expect(out).not.toContain(proUrl(process.env));
    expect(out).not.toContain("1,999,999"); // the tamper's chosen number is never presented
  });

  it("(d) POSITIVE allowance + good journal: unchanged — a real remaining figure, no pause claimed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "usage-positive-good-"));
    dirs.push(dir);
    provisionValidLease(dir, { allowance_tokens: 2_000_000 }, { productMode: "full" });
    await commitOneEntry(dir);
    const out = run(dir);
    expect(out).toContain("1,998,766"); // 2,000,000 − 1,234, against the unreconciled tally
    expect(out).toContain("(local estimate)");
    expect(out).not.toContain("cannot be determined");
    // A HEALTHY Community allowance carries no pause claim and no conversion CTA.
    expect(out).not.toContain("is paused for this period");
    expect(out).not.toContain("Upgrade to Pro");
    expect(out).not.toContain(proUrl(process.env));
    expect(out).not.toContain("while the journal does not verify");
  });
});
