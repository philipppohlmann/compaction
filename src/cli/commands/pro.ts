import chalk from "chalk";
import type { Command } from "commander";
import { openBrowser } from "./login.js";
import { readStoredCredentials } from "../../core/auth/credentials.js";
import { resolveOpenTier } from "../../core/onboarding-preferences.js";
import { proUrl } from "../../core/pro-destination.js";

/**
 * `compaction upgrade` (canonical) / `compaction pro` (alias) — the ONE conversion surface.
 *
 * THE ONLY PLACE CONVERSION IS MENTIONED. Nothing before the ceiling advertises Pro: not the README,
 * not onboarding, not the per-turn line while a user is inside their allowance. The product earns the
 * upgrade rather than asking for it early, so this command exists to be reached from ONE place — the
 * per-turn line at the 2,000,000-token ceiling — and from a user who types it deliberately.
 *
 * WHY A COMMAND AND NOT A PROMPT ON THE LINE. The per-turn line is rendered by the host tool (Claude
 * Code's `statusLine`, Codex's `Stop` hook `systemMessage`) and has no stdin: there is no keypress to
 * capture, so "press Enter to upgrade" is not reachable there. The line notifies; this command acts.
 *
 * WHAT IT DOES NOT DO — and this is the load-bearing part. Pro is WAITLIST-ONLY: no purchase, no
 * entitlement issued, no payment path. So this command CANNOT enrol anyone, and it never says it
 * has. It shows where the user stands, names the address that would be used, and hands off to the
 * browser — the capture surface that actually exists.
 *
 * THE HANDOFF NOW LANDS SOMEWHERE. The waitlist service is deployed and the website form posts to
 * `POST /v0/waitlist`; a signup made through this handoff is really recorded.
 * Nothing about this command changes as a result — it still enrols no one, because the enrolling is
 * done by the page, not here — but the browser handoff is no longer a link to a form that could not
 * store anything. When billing lands, the same
 * command redirects to checkout instead, and the line pointing at it never has to change.
 *
 * CONTENT-FREE + LOCAL: reads the local lease/preferences and the stored account email (display only,
 * already on disk from login). It makes no network call of its own — the browser handoff is the user's
 * own navigation.
 */

/**
 * The Pro destination is resolved in ONE place — `src/core/pro-destination.ts` — and re-exported here
 * so existing importers (and this command) keep their import path. It moved into core because the
 * per-turn receipt line now renders the same destination as a clickable CTA, and core must not import
 * a CLI command module. Two resolvers would mean two URLs that drift; there is one.
 */
export { PRO_PATH, PRO_URL_ENV, proUrl } from "../../core/pro-destination.js";

/**
 * The handoff URL.
 *
 * NO ACCOUNT PARAMETER TODAY, deliberately. The device-login flow binds its browser handoff to the
 * identity (`verification_uri_complete`) because a service is waiting on the other end to consume it.
 * Nothing consumes one here: `/waitlist?plan=pro` resolves the signer's identity from the BROWSER
 * session when there is one (and asks for an email when there is not), so an account id on the URL
 * would be both redundant and a way to put an identifier in a query string. Appending `?account=…`
 * would be inventing a parameter no page reads — the same class of error as inventing the page.
 *
 * When a real signup/checkout page exists, this is where the binding goes, and the flow becomes the
 * same three steps as `compaction login`: bound URL → browser → poll for completion.
 */
export function proHandoffUrl(_accountId: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  return proUrl(env);
}

/**
 * THE CANONICAL NAME IS `upgrade`: it can come to mean more than Pro — a plan
 * change of any kind — so the conversion surface owns the general word and the ceiling line points at
 * it. `pro` and `plan` remain as aliases for discoverability.
 *
 * The name was previously held by a command that connected a private-beta / self-hosted endpoint
 * with an API key. That capability moved to `compaction api connect`, where it belongs, and
 * `upgrade --key` still forwards there so no scripted invocation breaks.
 */

export interface ProCommandDeps {
  env?: NodeJS.ProcessEnv;
  print?: (line: string) => void;
  open?: (url: string, env: NodeJS.ProcessEnv) => void;
}

/**
 * Render the upgrade surface. Pure w.r.t. the network; the only side effect is the optional browser
 * handoff. Fail-open: any unreadable local state degrades to the general explanation rather than an
 * error, because this runs at the moment a user is already blocked.
 */
export async function runPro(deps: ProCommandDeps = {}): Promise<void> {
  const env = deps.env ?? process.env;
  const print = deps.print ?? ((line: string) => console.log(line));
  const open = deps.open ?? openBrowser;

  print(chalk.cyan("compaction upgrade"));

  // WHERE THE USER STANDS. Read locally; never a network call, and never a reason to fail.
  let atCeiling = false;
  let resetsOn: string | undefined;
  try {
    const resolved = await resolveOpenTier(env);
    resetsOn = resolved.allowanceResetsOn;
    atCeiling = resetsOn !== undefined;
  } catch {
    // Unknown standing → the general explanation still applies.
  }

  if (atCeiling) {
    print(
      chalk.yellow(
        `  This period's optimized-input allowance is spent${resetsOn ? `; it resets on ${resetsOn}` : ""}.`
      )
    );
    print(chalk.dim("  Output shaping is unaffected and keeps running. Input compaction on the API-key route"));
    print(chalk.dim("  is paused until the allowance resets — nothing is charged and nothing was bought."));
  } else {
    print(chalk.dim("  You are inside your current allowance — nothing is paused."));
  }

  print("");
  // TARGET, NOT PROMISE. Every Pro number is a non-contractual target, explicitly movable (the
  // allowance may go to 100M
  // without a client change). Stating "raises it to 50,000,000" to a user on a waitlist-only command
  // makes a commitment the contract refuses to make.
  print("  Pro is aimed at a much larger monthly optimized-input allowance — currently targeted at");
  print("  50,000,000 tokens against Community's 2,000,000. The figure is a target, not a commitment,");
  print("  and it can change before Pro is live.");
  print(chalk.dim("  Everything else is unchanged: same optimization, same local-first posture, same receipts."));
  print("");

  // HONEST STATUS. Pro is waitlist-only, so this says what will actually happen rather than implying
  // an enrolment this command cannot perform. The wording holds either way and deliberately does not
  // depend on whether the signup service is deployed: it describes what joining a waitlist IS.
  print(chalk.bold("  Pro is not purchasable yet."));
  print("  Joining the waitlist is how you ask to be notified — that is how you get access first.");

  const credentials = readStoredCredentials(env);
  if (credentials?.email) {
    print(chalk.dim(`  Your account address (${credentials.email}) is the one to use — no new details needed.`));
  } else {
    print(chalk.dim("  You are not signed in; the page will ask for an address."));
  }

  const url = proHandoffUrl(credentials?.account_id, env);
  print("");
  print(`  ${chalk.bold("Open:")} ${url}`);
  open(url, env);
  print(chalk.dim("  (If the browser did not open, copy the link above.)"));
}

export function registerProCommand(program: Command): void {
  program
    .command("pro")
    .alias("plan")
    .description(
      "Raise your plan. Pro targets a much larger monthly optimized-input allowance than Community's 2M " +
        "(currently targeted at 50M — a target, not a commitment). Pro is NOT purchasable yet: this shows " +
        "where you stand and opens the Pro waitlist. Local-first, content-free, no account or usage call."
    )
    .action(async () => {
      await runPro();
    });
}
