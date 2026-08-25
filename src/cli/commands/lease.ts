/**
 * `compaction lease` — acquire / inspect the Community full-apply entitlement lease (PUBLIC CLI).
 *
 *  - `compaction lease` (default `acquire`): fetch a server-signed bounded lease for this device
 *    (requires a Community account, which the onboarding stepper sets up) and store it at
 *    `~/.compaction/lease.json` (0600). Onboarding acquires the first lease for you; this command is
 *    for renewal and for a device that lost its lease.
 *  - `compaction lease status`: print the CONTENT-FREE local verdict (fixed labels only — never a
 *    lease id, account, email, or token figure). Reads local disk only; no network.
 *  - `compaction lease install-dev-root <path>`: install an explicit DEV lease-signing root for
 *    local development. Anything it verifies is labeled DEV-SIGNED — not a production entitlement.
 *
 * HARD RAILS:
 *  - The lease reader/verifier is engine-free, account-free, network-free (Open-path-safe). This
 *    command's ONLY network call is the explicit `acquire` fetch to the user-chosen service URL —
 *    which host that is is always user-driven (flag/env/login), never server-driven: the fetch
 *    refuses redirects so nothing can move the device token to another host.
 *  - Ceiling behavior is refuse/degrade — a lease never triggers a purchase.
 *  - `compaction lease` also attempts a BEST-EFFORT content-free usage reconcile before acquiring
 *   , so the issued lease reflects consumption the service already recorded. That attempt can
 *    never block, fail, or change the exit code of this command — see `reconcileOpportunistically`.
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import chalk from "chalk";
import type { Command } from "commander";
import { resolveTarget } from "../../core/api-client/persisted-config.js";
import { readStoredCredentials } from "../../core/auth/credentials.js";
import { fullOptimizationReachable } from "../../core/engine-availability.js";
import { isModuleAbsentError } from "../../core/module-absence.js";

/**
 * The specifier the lazy `import()` below uses, declared so the absence check can be scoped to THAT
 * module. Kept literal in both places on purpose (a computed specifier defeats the loader's static
 * analysis); `private-boundary-seams.test.ts` asserts the two never drift, and a drift would in any
 * case fail toward reporting the reconcile as unavailable rather than silently skipping it.
 */
const RECONCILE_CLIENT_SPECIFIER = "../../core/auth/usage-reconcile-client.js";
import { acquireLease, LeaseClientError, writeStoredLease } from "../../core/auth/lease-client.js";
import { readLeaseVerdict, type LeaseVerdict } from "../../core/entitlement/lease-store.js";
import { devLeaseRootKeyPath } from "../../core/entitlement/lease-roots.js";
import { periodEndUtc } from "../../core/entitlement/lease.js";
import { upgradeNoticeLines } from "../../core/upgrade-cta.js";
import { lastTurnAllowancePause } from "./watch.js";

/**
 * One-line, content-free, claim-honest description of each verdict for the status surface.
 *
 * `engineReachable` is INJECTED rather than probed here: this stays a pure renderer, and the probe is
 * async (it reaches the supervisor through a lazy seam so the Open static graph stays engine-free).
 */
function describeVerdict(
  verdict: LeaseVerdict,
  engineReachable: boolean,
  env: NodeJS.ProcessEnv = process.env
): { color: (s: string) => string; line: string; next?: string; notice?: string[] } {
  switch (verdict.label) {
    case "lease-valid": {
      const devSigned = verdict.trust === "dev-lease-root";
      const line = devSigned ? "valid (DEV-SIGNED — not a production entitlement)" : "valid";
      // A SPENT METERED BALANCE IS NOT AN INVALID LEASE. The device is entitled either way, and
      // subscription-route full apply consumes no allowance and keeps running — so the honest report
      // is a valid lease plus a SCOPED pause, not a withheld entitlement. Naming the reset DATE comes
      // from the lease's PERIOD, never from `expires_at` (renewed within a period, so it would promise
      // the allowance back early). No figure, no price, no purchase path: the ceiling refuses, it
      // never auto-purchases.
      if (verdict.meteredBalanceExhausted) {
        const resetsOn = verdict.periodId ? periodEndUtc(verdict.periodId) : undefined;
        return {
          color: chalk.yellow,
          line: `${line} — this period's optimized-input allowance is spent`,
          // THE SAME BLOCK the per-turn line, `status`, `usage`, and `watch` render, from the module
          // that owns the words. What it adds over the sentence it replaced is the DESTINATION: this
          // command tells a user their allowance is spent, and previously stopped there.
          notice: [
            ...upgradeNoticeLines({ reason: "exhausted", scope: "api-key-route", env, ...(resetsOn !== undefined ? { resetsOn } : {}) }),
            "",
            "Nothing is purchased automatically."
          ]
        };
      }
      return {
        color: chalk.green,
        line,
        // ENTITLED ≠ ENABLED. Pointing at `compaction mode full` as sufficient is only true when an
        // engine can actually run; with none distributed, that command correctly refuses, and telling
        // the user it "enables it" would send them at a command that is about to say no.
        next: engineReachable
          ? "Full apply is entitled on this device — `compaction mode full` enables it."
          : "Full apply is entitled on this device, but the adaptive engine has not been released yet, so it cannot be enabled."
      };
    }
    case "lease-absent":
      return {
        color: chalk.dim,
        line: "none on this device",
        next: "Run `compaction` and choose Community — the account and this entitlement are set up together."
      };
    case "lease-expired":
      return { color: chalk.yellow, line: "expired", next: "Run `compaction lease` to renew." };
    case "lease-wrong-period":
      return { color: chalk.yellow, line: "for a different period", next: "Run `compaction lease` to renew." };
    case "lease-wrong-device":
      return { color: chalk.yellow, line: "not issued for this device" };
    case "lease-invalid":
    default:
      return { color: chalk.red, line: "invalid (signature or format)" };
  }
}

async function printStatus(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const verdict = readLeaseVerdict(env);
  const d = describeVerdict(verdict, await fullOptimizationReachable(env), env);
  console.log(chalk.cyan("compaction lease status"));
  console.log(`  Entitlement lease: ${d.color(d.line)}`);
  if (d.next) console.log(chalk.dim(`  ${d.next}`));
  for (const line of d.notice ?? []) console.log(line === "" ? "" : chalk.dim(`  ${line}`));
  // A LEASE CAN BE VALID, ITS GRANT NON-ZERO, AND EVERY TURN STILL PAUSED. `meteredBalanceExhausted`
  // above is a property of the SIGNED GRANT (`allowance_tokens <= 0`) — it says nothing about how much
  // of that grant has since been SPENT, and nothing at all about `insufficient`, which is a property of
  // one turn measured against what was left. Measured on real journeys: a device that had spent its
  // whole 75,777-token grant, and a device pausing every turn at 40,000 remaining, both printed a bare
  // green `valid` here. So when the newest recorded turn was paused, say so — with the same words and
  // the same destination the other surfaces use.
  //
  // ONLY WHEN THE VERDICT DID NOT ALREADY SAY IT (`d.notice`), so the block never prints twice, and only
  // off the NEWEST turn: an older pause says nothing about now. Read-only; never throws.
  if (d.notice === undefined) {
    // `env` carries the config dir, so the staleness gate can bind the pause to the VERIFIED lease
    // period rather than to the wall clock.
    const pause = await lastTurnAllowancePause({ env });
    if (pause) {
      const notice = upgradeNoticeLines({
        reason: pause.reason,
        scope: pause.scope ?? "api-key-route",
        env,
        ...(pause.resets_on !== undefined ? { resetsOn: pause.resets_on } : {})
      });
      for (const line of notice) console.log(line === "" ? "" : chalk.dim(`  ${line}`));
      console.log(chalk.dim("  Nothing is purchased automatically."));
    }
  }
  console.log(chalk.dim("  Reads local disk only — no account, entitlement service, usage, or network call."));
}

/**
 * Which service this acquire contacts. Precedence: `--api-url` > `COMPACTION_API_URL` > the service
 * this device logged in to > persisted config / local-dev default. The login-time service is the
 * right default (that is where the device is registered), but an EXPLICIT override must win —
 * otherwise the advertised flag is inert and a moved local/staging endpoint is unreachable.
 */
export function resolveLeaseApiUrl(
  credentialsApiUrl: string | undefined,
  flagUrl: string | undefined,
  env: NodeJS.ProcessEnv = process.env
): string {
  const resolved = resolveTarget({ flagUrl, env });
  if (resolved.urlSource === "flag" || resolved.urlSource === "env") return resolved.url;
  const fromCredentials = (credentialsApiUrl ?? "").trim();
  return fromCredentials !== "" ? fromCredentials : resolved.url;
}

/**
 * Attempt reconciliation without ever letting it affect this command's outcome.
 *
 * Every failure path — offline, unreachable host, service without the endpoint, malformed response,
 * an unexpected throw — collapses to at most ONE dim line and returns. It never sets `exitCode`, and
 * it never rethrows. If this function could fail the command, reconciliation would have become a
 * gate on acquiring a lease, which is precisely what offline policy (a) forbids.
 */
async function reconcileOpportunistically(apiUrl: string, env: NodeJS.ProcessEnv): Promise<void> {
  // Lazy: reconciliation is the network half of the private metering surface, reached through a
  // dynamic import so this command never holds a static edge into it. A build without it simply has
  // nothing to reconcile — skip silently, exactly as this function skips a device with no entries.
  let client: typeof import("../../core/auth/usage-reconcile-client.js");
  try {
    client = await import("../../core/auth/usage-reconcile-client.js");
  } catch (error) {
    // NEVER rethrown (offline policy (a)): an import failure here — the module excluded from this
    // build, or a defect while loading a module that IS present — must not become a gate on acquiring
    // a lease. Absence is the silent, expected case; anything else is real and says so in one dim
    // line, because a silently skipped reconcile would hide why the lease acquired below is already
    // reduced. Neither sets an exit code.
    if (!isModuleAbsentError(error, { specifier: RECONCILE_CLIENT_SPECIFIER, importerUrl: import.meta.url })) {
      console.log(chalk.dim("  Usage reconciliation could not start on this device - continuing (this never blocks apply)."));
    }
    return;
  }
  try {
    const result = await client.reconcileStoredUsage(apiUrl, env);
    if (!result.reconciled) return;
    const { summary } = result;
    console.log(
      chalk.dim(
        `  Reconciled ${summary.uploaded} content-free usage entr${summary.uploaded === 1 ? "y" : "ies"} ` +
          `(${summary.accepted} newly recorded, ${summary.duplicate} already recorded).`
      )
    );
  } catch (error) {
    // Deliberately quiet and deliberately not fatal: a device that cannot reach the service still
    // acquires its lease and still applies. `compaction usage reconcile` reports the reason in full.
    // A PARTIAL failure still committed its earlier chunks, so saying nothing happened would be
    // false — and would hide why the lease acquired below is already reduced.
    const partial = error instanceof client.UsageReconcileClientError ? error.partial : undefined;
    console.log(
      chalk.dim(
        partial && partial.uploaded > 0
          ? `  Reconcile was interrupted after ${partial.uploaded} entr${partial.uploaded === 1 ? "y" : "ies"} ` +
            `(${partial.accepted} newly recorded) - continuing (this never blocks apply).`
          : "  Could not reconcile usage with the service right now - continuing (this never blocks apply)."
      )
    );
  }
}

async function runAcquire(opts: { apiUrl?: string }, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  console.log(chalk.cyan("compaction lease"));
  const credentials = readStoredCredentials(env);
  if (!credentials) {
    console.log(
      chalk.yellow("  No Community account on this device. Run `compaction` and choose Community (free, one browser confirmation).")
    );
    process.exitCode = 1;
    return;
  }
  const apiUrl = resolveLeaseApiUrl(credentials.api_url, opts.apiUrl, env);

  // OPPORTUNISTIC RECONCILE (offline policy (a)) — BEFORE acquiring, so the lease this command
  // issues already reflects everything the service just recorded and the loop closes in one command.
  //
  // BEST-EFFORT AND NON-BLOCKING, LOAD-BEARING: it is fully wrapped, cannot throw out, does NOT set
  // an exit code, and has its own request deadline. A device that cannot reach the service keeps
  // working — reconciliation records consumption, it never authorizes anything. The accepted cost is
  // stated honestly: a device can carry up to
  // one unreconciled lease-period of unmetered headroom. The structural backstop is that an
  // un-renewed lease becomes `lease-wrong-period`/`lease-expired` and loses full apply on its own.
  await reconcileOpportunistically(apiUrl, env);

  let lease;
  try {
    lease = await acquireLease(apiUrl, credentials.device_token);
  } catch (error) {
    const reason = error instanceof LeaseClientError ? error.message : String(error);
    console.log(chalk.red(`  Could not acquire a lease: ${reason}`));
    if (error instanceof LeaseClientError && error.code === "signing_unavailable") {
      // NOT "until keys are minted" — they are, and this client pins the matching public root. This
      // code means the SERVICE cannot reach its signing key right now, which is an outage on its side,
      // not a product that has not been built yet. Saying the latter sends the user to wait for
      // something that already happened.
      console.log(chalk.dim("  The service could not reach its lease-signing key, so it cannot issue leases right now."));
    }
    process.exitCode = 1;
    return;
  }
  const path = writeStoredLease(lease, env);
  console.log(chalk.green("  Lease acquired and stored."));
  console.log(chalk.dim(`  Stored at ${path} (mode 0600).`));
  // Report the LOCALLY-VERIFIED verdict (the client is the verifier). If the client trusts no lease
  // root yet, an honest `invalid` is surfaced here rather than a false success.
  const verdict = readLeaseVerdict(env);
  const d = describeVerdict(verdict, await fullOptimizationReachable(env));
  console.log(`  Entitlement lease: ${d.color(d.line)}`);
  if (verdict.label !== "lease-valid") {
    console.log(
      chalk.dim(
        "  The stored lease did not verify locally. In production the pinned lease root is not minted yet; " +
          "for local development install a dev root with `compaction lease install-dev-root <path>`."
      )
    );
  } else if (d.next) {
    console.log(chalk.dim(`  ${d.next}`));
  }
}

function runInstallDevRoot(pubPath: string, env: NodeJS.ProcessEnv = process.env): void {
  console.log(chalk.cyan("compaction lease install-dev-root"));
  const src = resolve(pubPath);
  if (!existsSync(src)) {
    console.log(chalk.red(`  No such file: ${src}`));
    process.exitCode = 1;
    return;
  }
  const dest = devLeaseRootKeyPath(env);
  mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
  copyFileSync(src, dest);
  console.log(chalk.green("  Dev lease root installed."));
  console.log(chalk.dim(`  ${dest}`));
  console.log(
    chalk.yellow(
      "  DEV-SIGNED trust: leases verified by this root are labeled DEV-SIGNED — not a production entitlement."
    )
  );
}

export function registerLeaseCommand(program: Command): void {
  const lease = program
    .command("lease")
    .description(
      "Acquire or renew this device's Community full-apply entitlement lease (onboarding acquires the " +
        "first one for you). `compaction lease` fetches and stores a signed bounded lease and needs a " +
        "Community account; `compaction lease status` " +
        "prints the content-free local verdict; the lease reader is engine-free, account-free, network-free."
    )
    .option(
      "--api-url <url>",
      "Acquire from this Compaction service instead — this device's token is sent to the host you name " +
        "(default: the service you logged in to)"
    )
    .action(async (opts: { apiUrl?: string }) => {
      await runAcquire(opts, process.env);
    });

  lease
    .command("status")
    .description("Print the content-free local entitlement-lease verdict (no network, no account call).")
    .action(async () => {
      await printStatus(process.env);
    });

  lease
    .command("install-dev-root <pubKeyPath>")
    .description("Install an explicit DEV lease-signing root for local development (verified leases are labeled DEV-SIGNED).")
    .action((pubKeyPath: string) => {
      runInstallDevRoot(pubKeyPath, process.env);
    });
}
