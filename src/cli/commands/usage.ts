/**
 * `compaction usage` — inspect this device's optimized-input allowance consumption (PUBLIC CLI).
 *
 * A NETWORK-FREE LOCAL READ of the hash-chained usage journal (`~/.compaction/usage-journal.jsonl`):
 * no network, no account call, no entitlement service. (The journal MODULE is also account-import
 * free; this COMMAND imports the local credentials store to read the device public key, so it is
 * network-free but not account-import-free.) It prints, for the current period:
 *   - period_id (the server-authoritative UTC allowance window; NEVER the word "monthly")
 *   - optimized input tokens metered this period (Σ committed debits from the local journal)
 *   - allowance remaining (allowance − consumed), when a valid lease carries the allowance
 *   - journal integrity: whether the local hash chain + device signatures verify ON THIS DEVICE
 *
 * `compaction usage reconcile` is a SEPARATE, EXPLICIT subcommand that DOES make a network
 * call — to the Compaction service this device logged in to (or the one named with `--api-url`), and
 * nowhere else. The bare `compaction usage` above stays a pure local read.
 *
 * HONESTY: `optimized input tokens` is a LOCAL-ESTIMATE (`chars/4`) PRODUCT
 * ALLOWANCE unit for Community full-apply on the API-key route — NOT a provider-reported count, NOT
 * a provider bill, NOT a cost or savings figure, and this surface never presents it as one.
 * Subscription-route apply is never metered. At the ceiling the behavior is refuse/degrade, never an
 * auto-purchase. Integrity here is a LOCAL check only: it detects edits, reordering, and removals
 * within the chain, but the device holds the signing key and a whole-file deletion or tail truncation
 * reads as a shorter valid chain — so it is tamper-EVIDENT locally, not tamper-proof. Uploading
 * entries does NOT upgrade that: the service verifies the entries it RECEIVED, which is not a proof
 * that the local journal is complete. Nothing here reports a journal as "verified" because a server
 * saw it.
 */
import chalk from "chalk";
import type { Command } from "commander";
import { readStoredCredentials } from "../../core/auth/credentials.js";
import { isModuleAbsentError } from "../../core/module-absence.js";

/**
 * The specifiers the lazy `import()`s below use, declared so the absence check can be scoped to THOSE
 * modules. Kept literal in both places on purpose (a computed specifier defeats the loader's static
 * analysis); `private-boundary-seams.test.ts` asserts the two never drift, and a drift would in any
 * case fail toward PROPAGATING the error rather than degrading silently.
 */
const METERING_READER_SPECIFIERS = ["../../core/usage/usage-journal.js", "../../core/usage/reconciliation-watermark.js"] as const;
const RECONCILE_CLIENT_SPECIFIER = "../../core/auth/usage-reconcile-client.js";

/** True only when one of the two metering READERS this command lazy-loads is itself missing. */
function isMeteringModuleAbsent(error: unknown): boolean {
  return METERING_READER_SPECIFIERS.some((specifier) => isModuleAbsentError(error, { specifier, importerUrl: import.meta.url }));
}
import { METERING_ABSENT_MESSAGE } from "../../core/gateway/metering-seam.js";
import { currentPeriodId, periodEndUtc } from "../../core/entitlement/lease.js";
import { upgradeNoticeLines } from "../../core/upgrade-cta.js";
import { lastTurnAllowancePause } from "./watch.js";
import { readLeaseVerdict } from "../../core/entitlement/lease-store.js";
import { publicKeyHash } from "../../core/crypto/key-hash.js";
import { resolveLeaseApiUrl } from "./lease.js";

async function printUsage(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  console.log(chalk.cyan("compaction usage"));

  // The journal + watermark readers are loaded lazily: metering is a private capability, so this
  // command reaches it through a dynamic import rather than a static one. Nothing about the reading
  // changes when they are present; absent, the command says so instead of failing to load.
  let journal: typeof import("../../core/usage/usage-journal.js");
  let watermarks: typeof import("../../core/usage/reconciliation-watermark.js");
  try {
    journal = await import("../../core/usage/usage-journal.js");
    watermarks = await import("../../core/usage/reconciliation-watermark.js");
  } catch (error) {
    if (!isMeteringModuleAbsent(error)) throw error;
    console.log(chalk.dim(`  ${METERING_ABSENT_MESSAGE}`));
    return;
  }
  const {
    classifyEntrySignature,
    readUsageJournal,
    sumOptimizedInputTokensForPeriod,
    sumUnreconciledOptimizedInputTokensForPeriod,
    verifyUsageChain
  } = journal;
  const { readReconciliationWatermark, watermarkForPeriod } = watermarks;

  // The allowance + period come from the verified lease when present; otherwise fall back to the
  // current UTC period and report that no active lease carries an allowance (no invented number).
  const verdict = readLeaseVerdict(env);
  const periodId = verdict.periodId ?? currentPeriodId();
  const allowanceTokens = verdict.label === "lease-valid" ? verdict.allowanceTokens : undefined;

  /**
   * THE SIGNED ZERO OUTRANKS THE JOURNAL — for what this command SAYS, and nothing else.
   *
   * The issuer signs `allowance_tokens` already net of the consumption the SERVICE has recorded, so a
   * signed zero proves no API-key allowance remains for this period whatever the local journal holds,
   * and even when it holds nothing readable. Reporting "cannot be determined" in that state withheld a
   * fact the server had stated definitively — and this is the surface a user opens precisely when they
   * are at the ceiling. Every other surface (`resolveOpenTier`, `lease status`, `mode full`) already
   * reads this flag without consulting the journal; `usage` was the outlier.
   *
   * A READER, NOT A GATE (see the field's declaration in `entitlement/lease-store.ts`): this decides
   * which sentence to print. No refusal is derived from it here or anywhere else. Journal integrity is
   * untouched — an unverifiable journal still makes the GATEWAY refuse metered apply, which is a
   * different decision made in a different process from a journal read this command does not perform.
   */
  const signedZeroAllowance = verdict.label === "lease-valid" && verdict.meteredBalanceExhausted === true;

  const { entries, skipped } = await readUsageJournal(env);
  const consumed = sumOptimizedInputTokensForPeriod(entries, periodId);

  // How much of this period's local total the SERVICE has already recorded. Derived from the local
  // journal + the local reconciliation watermark — this command still makes NO network call, so
  // this is a fact about the last reconcile, not a live or re-verified figure. When no watermark
  // exists (never reconciled, or it was lost) `unreconciled` is the whole total and the line below
  // is simply not printed — never a fabricated zero.
  const watermark = await readReconciliationWatermark(env);
  const unreconciled = sumUnreconciledOptimizedInputTokensForPeriod(
    entries,
    periodId,
    watermarkForPeriod(watermark, periodId)?.reconciled_through_entry_hash
  );
  const alreadyRecorded = consumed - unreconciled;

  // Integrity is resolved BEFORE any figure is printed: a tally read off a journal that does not
  // verify must never be presented as a trustworthy consumed/remaining number (it is exactly the
  // figure a tamper would have lowered). The same condition makes the gateway refuse to apply.
  const chain = verifyUsageChain(entries);
  const trustworthy = chain.valid && skipped.length === 0;

  console.log(`  Period: ${chalk.bold(periodId)} ${chalk.dim("(server-authoritative UTC allowance window)")}`);
  console.log(
    `  Optimized input tokens metered this period: ${chalk.bold(consumed.toLocaleString("en-US"))} ` +
      chalk.dim(trustworthy ? "(local estimate)" : "(local estimate — UNVERIFIED, see integrity below)")
  );
  console.log(
    chalk.dim("    A local-estimate product allowance unit — not provider-reported, and not a provider bill, cost, or savings figure.")
  );
  // Printed ONLY when the watermark actually records a reconciled position. Without it the
  // arithmetic below reads as broken: the lease allowance is already NET of what the service
  // recorded, so remaining is measured against the unreconciled remainder, not the whole total.
  if (alreadyRecorded > 0 && trustworthy) {
    console.log(
      chalk.dim(
        `    ${alreadyRecorded.toLocaleString("en-US")} already reconciled — recorded by the service, ` +
          "so this lease's allowance is already net of them."
      )
    );
  }

  if (allowanceTokens === undefined) {
    console.log(
      chalk.dim("  Allowance remaining: no active entitlement lease on this device (run `compaction` and choose Community).")
    );
  } else if (!trustworthy && !signedZeroAllowance) {
    // No remaining figure is shown off an unverifiable journal — it would be a number the tamper chose.
    // A signed zero is exempt because it is not read off the journal at all (see above).
    console.log(`  Allowance remaining: ${chalk.red("cannot be determined")} ${chalk.dim("- the local journal did not verify")}`);
  } else {
    // Against the UNRECONCILED tally: `allowanceTokens` already has the server-recorded consumption
    // subtracted out of it, so subtracting the full period total here would charge those tokens
    // twice and could show an exhausted device that in fact has headroom.
    //
    // A signed zero short-circuits both figures rather than deriving them, so the number printed on an
    // UNVERIFIABLE journal cannot depend on that journal's contents even arithmetically. (With a zero
    // allowance the subtraction below already clamps to the same answer; making it explicit is what
    // keeps the independence a property of this code rather than of `unreconciled` happening to be
    // non-negative.)
    const remaining = signedZeroAllowance ? 0 : Math.max(0, allowanceTokens - unreconciled);
    const exhausted = signedZeroAllowance || allowanceTokens - unreconciled <= 0;
    console.log(
      `  Allowance remaining: ${(exhausted ? chalk.yellow : chalk.green)(remaining.toLocaleString("en-US"))} ` +
        chalk.dim(`of ${allowanceTokens.toLocaleString("en-US")}`)
    );
    if (exhausted) {
      // THE SAME WORDS THE PER-TURN LINE AND `status` / `watch` / `lease status` USE, from the one
      // module that owns them (`upgrade-cta.ts`). This used to be a sentence written here — accurate,
      // but its own phrasing and, critically, with no destination: a user who read "paused" on the
      // surface built to explain their allowance had nowhere to go from it.
      //
      // SCOPED `api-key-route`: `optimized-input-v1` is debited on the metered route only, so this is
      // the one figure on this surface a subscription-routed turn is not measured against.
      const resetsOn = periodEndUtc(periodId);
      const notice = upgradeNoticeLines({
        reason: "exhausted",
        scope: "api-key-route",
        ...(resetsOn !== undefined ? { resetsOn } : {})
      });
      for (const line of notice) console.log(line === "" ? "" : chalk.dim(`  ${line}`));
      // Kept from the sentence this replaced: the ceiling behavior is refuse/degrade, and stating that
      // beside a conversion pointer is what stops the pointer from reading as a charge that is coming.
      console.log(chalk.dim("  Nothing is purchased automatically."));
    } else {
      // A HEALTHY-LOOKING REMAINDER IS NOT A HEALTHY ALLOWANCE. The line above answers "how much is
      // left"; it cannot answer "is that enough", because enough is a property of a TURN. Measured:
      // 40,000 remaining against 75,777-token turns printed a comfortable green number to a user
      // whose every turn was in fact being paused, with nothing on this surface saying so and nowhere
      // to go. So when the newest recorded turn was paused for exactly that reason, say it here.
      //
      // NEWEST TURN ONLY, and read off the receipt that recorded it — see `lastTurnAllowancePause`.
      // `env` so the pause is bound to the verified lease period, not merely to being newest.
      const pause = await lastTurnAllowancePause({ env });
      if (pause?.reason === "insufficient") {
        const notice = upgradeNoticeLines({
          reason: "insufficient",
          scope: pause.scope ?? "api-key-route",
          ...(pause.resets_on !== undefined ? { resetsOn: pause.resets_on } : {})
        });
        console.log(chalk.dim("  Your most recent turn was larger than this remainder covers:"));
        for (const line of notice) console.log(line === "" ? "" : chalk.dim(`  ${line}`));
        console.log(chalk.dim("  Nothing is purchased automatically."));
      }
    }
  }

  // THE JOURNAL-INTEGRITY CONSEQUENCE, beside whichever remaining line ran above — not inside one of
  // them. It used to sit in the "cannot be determined" branch, so exempting the signed zero from that
  // branch would have taken this with it: the user would learn their balance is definitively spent and
  // never learn that the broken journal ALSO blocks metered apply, on its own, into the next period
  // once the allowance renews. Two independent refusals, both worth stating.
  //
  // SCOPED: the gateway consults this journal on the METERED route only, so an unverifiable
  // journal refuses metered apply and leaves subscription-routed apply — which is never debited and
  // never summed here — running. An unqualified "full apply refuses" would be false for it.
  if (allowanceTokens !== undefined && !trustworthy) {
    // Beside a definitive exhausted line this would otherwise read as a restatement of it, so it says
    // which of the two it is. The distinction is the actionable part: the allowance comes back on the
    // reset date, the journal does not fix itself.
    const independent = signedZeroAllowance ? "Independently of the allowance: " : "";
    console.log(
      chalk.dim(
        `  ${independent}API-key routed full apply refuses/degrades while the journal does not verify ` +
          "(fail-closed; no auto-purchase)."
      )
    );
  }

  // Journal integrity — LOCAL verification only. The hash chain detects edits, reordering, and
  // removals within the chain; entries signed by a PREVIOUS device key (a legitimate logout/login
  // rotation) are reported as rotated, NOT as tampering. This is not a server-confirmed figure.
  const credentials = readStoredCredentials(env);
  const devicePublicKey = credentials?.device_public_key;
  const verdicts = devicePublicKey
    ? entries.map((entry) => classifyEntrySignature(entry, devicePublicKey, publicKeyHash(devicePublicKey)))
    : undefined;
  const failed = verdicts?.filter((v) => v === "failed").length;
  const rotated = verdicts?.filter((v) => v === "device-rotated").length ?? 0;

  if (entries.length === 0) {
    console.log(chalk.dim("  Journal: empty (no metered full-apply recorded yet)."));
  } else if (!chain.valid) {
    console.log(`  Journal integrity: ${chalk.red("hash chain broken")} ${chalk.dim(`at entry ${chain.brokenAtIndex + 1} (${chain.reason})`)}`);
  } else if (verdicts === undefined) {
    console.log(`  Journal integrity: ${chalk.yellow("hash chain verified; device signatures not checked")} ${chalk.dim("(no device credentials on this device)")}`);
  } else if (failed && failed > 0) {
    console.log(`  Journal integrity: ${chalk.red(`${failed} entr${failed === 1 ? "y" : "ies"} failed device-signature verification`)}`);
  } else if (rotated > 0) {
    // NOT "verified": an entry this device cannot check is unverifiable, and folding it into a green
    // summary would present it as equivalent to a verified one — degrading exactly the tamper-evidence
    // signal the chain exists to give. The chain still covers it, and the honest reason is stated;
    // the entries are neither vouched for nor accused.
    console.log(
      `  Journal integrity: ${chalk.yellow(`${rotated} of ${entries.length} entr${entries.length === 1 ? "y" : "ies"} unverifiable (rotated device)`)} ` +
        chalk.dim("- signed by a previous device key, so this device cannot check them; hash chain verifies")
    );
  } else {
    console.log(
      `  Journal integrity: ${chalk.green("verified")} ` +
        chalk.dim(`(${entries.length} entr${entries.length === 1 ? "y" : "ies"}, hash chain + device signatures verify on this device)`)
    );
  }

  if (skipped.length > 0) {
    console.log(chalk.dim(`  Skipped ${skipped.length} unreadable journal line(s): ${skipped[0].reason}`));
  }
  console.log(chalk.dim("  Reads local disk only — no account, entitlement service, usage service, or network call."));
}

/**
 * `compaction usage reconcile` — upload this device's CONTENT-FREE journal entries to the service.
 *
 * EXPLICIT AND NON-BLOCKING BY DESIGN. Reconciliation records consumption; it authorizes nothing and
 * gates nothing. A failure here never affects apply, and this command reports it as a plain failure
 * rather than an error state of the device. What is uploaded is the fixed content-free entry shape —
 * ids, counts, labels, timestamps, hashes; the service refuses any unknown key outright.
 */
async function runReconcile(opts: { apiUrl?: string }, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  console.log(chalk.cyan("compaction usage reconcile"));
  const credentials = readStoredCredentials(env);
  if (!credentials) {
    console.log(
      chalk.yellow(
        "  No Community account on this device. Run `compaction` and choose Community (free, one browser " +
          "confirmation) — or `compaction login` if you previously logged out."
      )
    );
    process.exitCode = 1;
    return;
  }
  const apiUrl = resolveLeaseApiUrl(credentials.api_url, opts.apiUrl, env);
  console.log(chalk.dim(`  Uploading to ${apiUrl} - content-free entries only (ids, counts, labels, timestamps, hashes).`));

  // Lazy, like the journal readers above: the reconciliation client is the network half of the same
  // private metering surface, so this command reaches it through a dynamic import. Absent, there is
  // nothing to upload to and the command says so plainly rather than failing.
  let client: typeof import("../../core/auth/usage-reconcile-client.js");
  try {
    client = await import("../../core/auth/usage-reconcile-client.js");
  } catch (error) {
    if (!isModuleAbsentError(error, { specifier: RECONCILE_CLIENT_SPECIFIER, importerUrl: import.meta.url })) throw error;
    console.log(chalk.dim(`  ${METERING_ABSENT_MESSAGE}`));
    return;
  }
  const { reconcileStoredUsage, UsageReconcileClientError } = client;

  let result;
  try {
    result = await reconcileStoredUsage(apiUrl, env);
  } catch (error) {
    const reason = error instanceof UsageReconcileClientError ? error.message : String(error);
    console.log(chalk.red(`  Could not reconcile: ${reason}`));
    // HONEST PARTIAL RESULT: chunks are uploaded sequentially and each commits server-side on its
    // own, so a failure on a later chunk leaves earlier ones RECORDED. Saying "nothing was uploaded"
    // there is simply false, and it would hide why the next lease is already reduced.
    const partial = error instanceof UsageReconcileClientError ? error.partial : undefined;
    if (partial && partial.uploaded > 0) {
      console.log(
        chalk.dim(
          `  ${partial.uploaded} entr${partial.uploaded === 1 ? "y" : "ies"} were uploaded before the failure ` +
            `(${partial.accepted} newly recorded); the rest were not sent. Re-running is safe - already-recorded entries are ignored.`
        )
      );
    } else {
      console.log(chalk.dim("  Nothing was uploaded."));
    }
    console.log(chalk.dim("  Full apply is unaffected - reconciliation never gates the workflow."));
    process.exitCode = 1;
    return;
  }

  if (!result.reconciled) {
    const line =
      result.reason === "nothing-to-reconcile"
        ? "  Nothing to reconcile for this device in the current or previous period."
        : "  Not logged in.";
    console.log(chalk.dim(line));
    return;
  }

  const { summary } = result;
  console.log(chalk.green(`  Uploaded ${summary.uploaded} entr${summary.uploaded === 1 ? "y" : "ies"}.`));
  console.log(
    `  Recorded by the service: ${chalk.bold(String(summary.accepted))} new, ` +
      `${chalk.dim(`${summary.duplicate} already recorded`)}, ` +
      `${(summary.rejected.length > 0 ? chalk.yellow : chalk.dim)(`${summary.rejected.length} rejected`)}`
  );
  if (summary.rejected.length > 0) {
    // Fixed, content-free reason labels — the first few only, so a large batch cannot flood stdout.
    const shown = summary.rejected.slice(0, 5);
    for (const item of shown) console.log(chalk.dim(`    rejected: ${item.reason}`));
    if (summary.rejected.length > shown.length) {
      console.log(chalk.dim(`    ... and ${summary.rejected.length - shown.length} more`));
    }
  }
  if (!summary.chainContinuous) {
    console.log(
      chalk.yellow("  The service reports this upload did not continue from what it had already recorded.") +
        chalk.dim(" Entries were still recorded; consumption is never discarded.")
    );
  }
  console.log(
    chalk.dim(
      "  Counts are entries and a local-estimate product allowance unit - not a provider bill, cost, or savings figure."
    )
  );
  console.log(
    chalk.dim("  Recorded consumption reduces the allowance carried in your NEXT lease (`compaction lease`).")
  );
}

export function registerUsageCommand(program: Command): void {
  const usage = program
    .command("usage")
    .description(
      "Show this device's optimized-input allowance consumption for the current period from the local " +
        "hash-chained usage journal (content-free; `compaction usage` itself reads local disk only). The " +
        "metered unit is a product allowance unit, not a provider bill."
    )
    .action(async () => {
      await printUsage(process.env);
    });

  usage
    .command("reconcile")
    .description(
      "Upload this device's content-free usage-journal entries to the Compaction service you logged in " +
        "to (makes a network call). Records consumption only - it never gates or blocks apply."
    )
    .option(
      "--api-url <url>",
      "Reconcile with this Compaction service instead — this device's token is sent to the host you name " +
        "(default: the service you logged in to)"
    )
    .action(async (opts: { apiUrl?: string }) => {
      await runReconcile(opts, process.env);
    });
}
