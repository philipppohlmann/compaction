/**
 * `compaction mode observe|basic|full` — the open-core product-mode (apply-posture) switch (PUBLIC CLI,
 * engine-free, account-free, network-free).
 *
 * The product mode selects the per-turn apply posture:
 *
 *  - `observe` — no model-visible mutation. The per-turn line reads `apply off`. This is the default and
 *    the safe posture: Compaction only observes provider traffic and writes content-free receipts.
 *  - `basic`   — the ONE public deterministic output-shaping method (`concise_response`) is attached to
 *    supported requests BEFORE generation. The per-turn line reads `basic shaping`. Engine-free, no input
 *    compaction, no account, no usage debit, no network. Original is retained where recovery is required.
 *  - `full`    — Community private-engine adaptive apply. It is LEASE-GATED: with a valid signed entitlement
 *    lease on this device it is enabled; without one, selecting `full` EXPLAINS what Community adds, points
 *    at the onboarding stepper (`compaction`), makes NO full-apply claim, and PRESERVES the current Open
 *    mode (observe/basic).
 *
 * HARD RAILS (this command):
 *  - Reads and writes ONLY the local content-free preference store (`~/.compaction/preferences.json`).
 *  - `observe`, `basic`, and the no-argument display complete FULLY OFFLINE: no account, entitlement,
 *    usage, or network call, on any device.
 *  - `full` on a device with NO ACCOUNT is also a purely local read, and says so.
 *  - `full` on a SIGNED-IN device first tries to re-establish the Community setup the user already
 *    asked for, so it MAY contact the entitlement service and download and install the signed engine.
 *    That is deliberate: the alternative is telling a user whose access simply lapsed to go and learn
 *    a second command. Nothing is uploaded but the device's own usage counters, and the copy printed
 *    on that path never claims the offline promise the other paths keep.
 *  - Never claims `full apply` without an entitlement that verifies on this device.
 */
import chalk from "chalk";
import { Command } from "commander";
import {
  DEFAULT_PRODUCT_MODE,
  PRODUCT_MODES,
  isProductMode,
  readProductMode,
  writeProductMode,
  type ProductMode
} from "../../core/onboarding-preferences.js";
import { readLeaseVerdict } from "../../core/entitlement/lease-store.js";
import { upgradeNoticeLines } from "../../core/upgrade-cta.js";
import { allowanceNoticeInput } from "./watch.js";
import { fullOptimizationReachable } from "../../core/engine-availability.js";
// Value import, and safe on an Open entry point: this module's own static graph is engine-free and
// account-free (it reaches `auth/**`, `api-client/**` and `engine-install/**` only through the same
// sanctioned dynamic-import seam), which `open-basic-engine-free.test.ts` re-proves on every run.
import {
  describeRepairActions,
  engineBlockedReason,
  leaseBlockedReason,
  type CommunityRuntimeOutcome
} from "../../core/entitlement/community-runtime.js";
import type { LeaseTrustSource } from "../../core/entitlement/lease-roots.js";

/**
 * What `compaction mode basic` tells the user basic shaping does to their REQUEST.
 *
 * EXPORTED AND PINNED because the sentence it replaces was false and nothing could catch it
 *. It read: basic shaping "never mutates your model-visible INPUT". Basic shaping
 * inserts a system message into the request — measured 92 → 552 bytes on a real gateway turn through the
 * shipped artifact — and the receipt written for that same turn sets `model_visible_bytes_changed: true`.
 * One artifact contradicting itself is the defect; the phrasing is only where it surfaced.
 *
 * This is the SAME correction already accepted for the receipt label
 * (`OPEN_BASIC_OUTPUT_SHAPING_APPLY_LABEL`). The receipt was fixed and this
 * surface was missed — and this is the one a user reads while CHOOSING the mode, so it is the one whose
 * being wrong actually decides something. The true statement is the Open/Community line: Open ADDS an
 * instruction, Community compacts the conversation; on both, the user's own messages stay byte-exact.
 */
export const BASIC_SHAPING_INPUT_EFFECT =
  "Basic shaping ATTACHES a concise-response instruction before generation, so it adds model-visible " +
  "instruction text to your request; your own messages are left byte-exact and are never compacted. " +
  "It makes no output-savings claim (see `compaction savings` for the measured effect).";

/** The exact per-turn receipt-line label each selectable Open mode produces (honest, content-free copy). */
const OPEN_MODE_LINE_LABEL: Record<"observe" | "basic", string> = {
  observe: "apply off",
  basic: "basic shaping"
};

/** One-line, claim-honest description of each mode for the status/help copy. */
const MODE_DESCRIPTION: Record<ProductMode, string> = {
  observe: "observe only — no model-visible mutation (per-turn line: `apply off`).",
  basic:
    "basic output shaping — the one public deterministic method (`concise_response`) attached before " +
    "generation on supported requests (per-turn line: `basic shaping`). Engine-free, no input compaction, " +
    "no account, no usage debit.",
  full:
    "Community full apply — private-engine adaptive input + output (per-turn line: `full apply`). Requires " +
    "a Community account, a valid entitlement lease on this device, and the private engine."
};

/**
 * Print the current mode and the honest catalogue of modes. Local read only; no network.
 *
 * Reports the EFFECTIVE posture, not the stored intent. A
 * `preferences.json` carrying `product_mode: "full"` — written before the selection-time engine gate
 * existed, or left behind when an installed engine was removed — would otherwise report `full` on a
 * build where no engine can run. The stored intent is retained, not rewritten: if an engine appears,
 * the mode comes back on its own.
 *
 * The fallback is `observe`, NOT `basic`.
 * The gateway's output shaping rides the private apply composition, so a `full` intent with no engine
 * degrades `engine-absent` and forwards the request UNCHANGED: no mutation of any kind on that route.
 * Reporting `basic` would have claimed the public shaping method is running on the gateway when the
 * next turn does nothing. (Hook-installed shaping is a separate surface and is unaffected either way.)
 */
async function printCurrentMode(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const stored = readProductMode(env);
  const engineReachable = stored === "full" ? await fullOptimizationReachable(env) : true;
  const current: ProductMode = stored === "full" && !engineReachable ? "observe" : stored;
  console.log(chalk.cyan("compaction mode"));
  console.log(`  Current mode: ${chalk.bold(current)} — ${MODE_DESCRIPTION[current]}`);
  if (stored === "full" && !engineReachable) {
    console.log(
      chalk.yellow(
        "  Your saved preference is `full`, but no engine can run here (none has been released), so the " +
          "gateway forwards requests unchanged. The preference is kept — it takes effect if an engine " +
          "becomes available. Output shaping through your tool's hook is unaffected."
      )
    );
  }
  console.log(chalk.dim("  Modes:"));
  for (const mode of PRODUCT_MODES) {
    const marker = mode === current ? chalk.green("•") : " ";
    console.log(chalk.dim(`    ${marker} ${mode}: ${MODE_DESCRIPTION[mode]}`));
  }
  console.log(chalk.dim("  Set a mode:  compaction mode observe | compaction mode basic | compaction mode full"));
  console.log(chalk.dim("  Reads/writes only the local content-free preference store — no account, no network."));
}

/**
 * The outcome of a `compaction mode <mode>` selection — the LOAD-BEARING persistence decision, isolated
 * from console rendering so the Open guarantees are directly testable. Pure w.r.t. the network: the ONLY
 * side effect is a local content-free preference-file write for an Open mode; `full` writes nothing.
 */
export interface ModeSelectionOutcome {
  /** The mode the user asked for (already validated). */
  requested: ProductMode;
  /** Whether a local write happened. `observe`/`basic` always persist; `full` persists ONLY with a valid lease. */
  persisted: boolean;
  /** The effective mode after the selection (for `full` WITHOUT a valid lease, the preserved Open mode). */
  effective: ProductMode;
  /** The absolute path written, when `persisted`. */
  path?: string;
  /** For a `full` selection: the local entitlement-lease verdict label consulted (content-free). */
  leaseVerdict?: string;
  /** For a `full` selection that unlocked: which trust root verified the lease (dev-signed is surfaced). */
  leaseTrust?: LeaseTrustSource;
  /**
   * For a `full` selection that unlocked on a lease whose METERED balance is already spent. Full apply
   * is genuinely enabled — subscription-routed turns apply normally — but API-key routed turns
   * will refuse until the period resets, and saying only "enabled" would over-promise for them.
   */
  meteredBalanceExhausted?: boolean;
}

/**
 * Apply a mode selection and return the outcome. `observe`/`basic` persist locally (content-free write,
 * no account/entitlement/usage/network call).
 *
 * `full` is now LEASE-GATED: it consults the pure entitlement lease-store (local disk only — no network,
 * no account call). With a VALID signed lease for this device+period it enables full (persists `full`);
 * with NO valid lease it PRESERVES the current Open mode, makes NO full-apply claim, and the caller
 * explains what Community adds and points at the onboarding stepper (`compaction`), which sets up the
 * account AND the lease in one step.
 *
 * ENTITLEMENT, NOT BALANCE: a valid lease whose metered allowance is spent still ENABLES full —
 * subscription-routed full apply consumes no allowance and runs. The spent balance travels out as
 * `meteredBalanceExhausted` so the rendering can scope its promise to the route it actually holds for,
 * rather than refusing a mode the user is entitled to.
 */
export function applyModeSelection(mode: ProductMode, env: NodeJS.ProcessEnv = process.env): ModeSelectionOutcome {
  if (mode === "full") {
    const verdict = readLeaseVerdict(env);
    if (verdict.label === "lease-valid") {
      const path = writeProductMode("full", env);
      return {
        requested: "full",
        persisted: true,
        effective: "full",
        path,
        leaseVerdict: verdict.label,
        ...(verdict.trust ? { leaseTrust: verdict.trust } : {}),
        ...(verdict.meteredBalanceExhausted ? { meteredBalanceExhausted: true } : {})
      };
    }
    const preserved = readProductMode(env);
    const effective: ProductMode = preserved === "basic" ? "basic" : "observe";
    return { requested: "full", persisted: false, effective, leaseVerdict: verdict.label };
  }
  const path = writeProductMode(mode, env);
  return { requested: mode, persisted: true, effective: mode, path };
}

/** Apply an Open mode (`observe` / `basic`): persist locally and confirm. Zero account/network. */
function setOpenMode(mode: "observe" | "basic", env: NodeJS.ProcessEnv = process.env): void {
  const { path } = applyModeSelection(mode, env);
  console.log(chalk.cyan("compaction mode"));
  console.log(chalk.green(`  Mode set to ${chalk.bold(mode)} — ${MODE_DESCRIPTION[mode]}`));
  // QUALIFIED, not unconditional. The label is now derived from per-turn
  // evidence rather than from this preference, so it appears on turns that were actually shaped —
  // a planning turn the task gate holds, an unsupported request shape, or a request your tool's hook
  // already shaped all render without it. Promising it on EVERY turn would make the first held
  // planning turn after `compaction mode basic` read as a broken install.
  //
  // `observe` is qualified by SURFACE for the same reason the other is qualified by TURN. `apply off`
  // asserts "no model-visible mutation", which only the status line is positioned to say: it reads
  // the current turn's own shaping decision. The replay surfaces (`watch`, `status`) see a receipt
  // that cannot distinguish an unshaped turn from one the tool's prompt hook shaped upstream of the
  // gateway, so they omit the label — and an unqualified promise here would describe an absence
  // there as a broken install.
  console.log(
    chalk.dim(
      mode === "basic"
        ? `  On turns that are shaped, the per-turn receipt line reads \`${OPEN_MODE_LINE_LABEL[mode]}\`.`
        : `  From the next turn, the per-turn receipt line reads \`${OPEN_MODE_LINE_LABEL[mode]}\` on the Claude Code status line.`
    )
  );
  if (mode === "basic") {
    console.log(chalk.dim(`  ${BASIC_SHAPING_INPUT_EFFECT}`));
  }
  console.log(chalk.dim(`  Persisted content-free preference: ${path}`));
  console.log(chalk.dim("  No account, entitlement, usage, or network call was made."));
}

/**
 * Handle `compaction mode full`. LEASE-GATED, and on a signed-in device it first attempts the repair
 * described in this file's HARD RAILS (which may reach the entitlement service and install the signed
 * engine); on a device with no account it is local-only and says so:
 *  - With a VALID signed entitlement lease for this device+period → ENABLE full (persist `full`);
 *    dev-signed leases are loudly labeled. The per-turn line reads `full apply` on a real apply turn.
 *  - With NO valid lease → make NO full-apply claim, PRESERVE the current Open mode, explain what
 *    Community adds, and point at the onboarding stepper (`compaction`) — which sets up the account and
 *    the entitlement together, so nobody has to know a separate command exists.
 */
/**
 * The ceiling block `compaction mode full` prints when full apply is enabled but this period's
 * optimized-input allowance cannot pay for it — EXPORTED so the consistency it now has is testable.
 *
 * DERIVED, NOT WRITTEN HERE. It returns `upgradeNoticeLines` verbatim, from the same `allowanceNoticeInput`
 * resolver `watch`/`status`/`usage`/`lease status` use. The bespoke sentence this replaced said the
 * allowance was SPENT (false for the `insufficient` state — tokens left, just not enough for the turn),
 * could not detect that state at all, and named nowhere to go. Empty array ⇒ no ceiling: print nothing.
 */
export async function fullModeCeilingLines(
  outcome: Pick<ModeSelectionOutcome, "meteredBalanceExhausted">,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd()
): Promise<string[]> {
  // TWO TRIGGERS, ONE BLOCK. `allowanceNoticeInput` covers a spent remainder and the per-turn
  // `insufficient` pause; `meteredBalanceExhausted` is a different fact again - a signed grant of zero
  // (`allowance_tokens <= 0`), which is about the GRANT rather than what has been consumed from it, and
  // which no receipt need exist to establish. Either is a ceiling worth stating while enabling full.
  const ceiling =
    (await allowanceNoticeInput(env, cwd)) ??
    (outcome.meteredBalanceExhausted
      ? { reason: "exhausted" as const, scope: "api-key-route" as const }
      : undefined);
  if (!ceiling) return [];
  return upgradeNoticeLines({ ...ceiling, env });
}

async function handleFullMode(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  console.log(chalk.cyan("compaction mode full"));

  // SELF-HEAL FIRST, for an authenticated device only.
  //
  // Both gates below — the engine and the lease — describe things this device is entitled to and
  // simply does not have in place: a month rolled over, or the device was activated before a signed
  // engine existed. Refusing and printing an instruction would be asking the user to learn the
  // entitlement vocabulary the product deliberately hides. So the missing pieces are re-established
  // here, once, before either gate is consulted.
  //
  // AN OPEN DEVICE IS UNTOUCHED. With no credentials this is a single local read: no network call,
  // no account call, nothing written — exactly the promise the no-lease copy below makes, and the
  // reason that promise is now printed only when it is true.
  const repaired = await repairCommunityRuntimeIfPossible(env);

  // SAY WHAT WAS DONE, when something was. The repair above is the one part of this command that is
  // not a local read, and a user is entitled to know their access was renewed or an engine installed
  // rather than have it happen silently under a command that used to promise it touched nothing.
  // Empty on every path where nothing changed, so no branch below has to guard against a stray line.
  for (const line of repaired === undefined ? [] : describeRepairActions(repaired)) {
    console.log(chalk.green(`  ${line}`));
  }

  // ENGINE BEFORE ENTITLEMENT. A lease says the user is ALLOWED
  // full apply; it does not make one possible. With no engine that can run — the published package,
  // where `dist/engine/**` is excluded and no signed release is obtainable — persisting `full` and
  // reporting it enabled describes a capability every subsequent request then degrades. Checked
  // BEFORE `applyModeSelection`, so nothing is written: the refusal has to be a no-op, not a rollback.
  if (!(await fullOptimizationReachable(env))) {
    const stored = readProductMode(env);
    // Never echo a stale `full` back as the current mode: with no engine it is not in effect, and the
    // whole point of this branch is that saying otherwise is the defect. `observe`, not `basic` — the
    // gateway forwards unchanged in this state rather than applying the public shaping method.
    const effective: ProductMode = stored === "full" ? "observe" : stored;
    // DERIVED, not asserted. "No signed engine release has been distributed yet" is a claim about the
    // world that stops being true the moment one is published — at which point a device that simply
    // failed to download or verify one would be handed a false explanation. The repair above already
    // knows which of those happened, so the sentence is read from it; with no account there is nothing
    // to attempt and the honest statement is about how the engine reaches a device at all.
    console.log(
      chalk.yellow(
        `  Full apply is not available on this device: the adaptive engine is delivered separately and ` +
          `${
            repaired === undefined
              ? "is installed for you when you activate Community"
              : engineBlockedReason(repaired)
          }. Nothing was enabled and no full-apply claim is made.`
      )
    );
    console.log(chalk.dim(`  Your effective mode is unchanged: ${effective}.`));
    console.log(
      chalk.dim(
        "  This is not about your account or entitlement — a lease permits full apply, it does not supply " +
          "the engine that performs it."
      )
    );
    console.log(
      chalk.dim(
        "  Output shaping needs no engine, no key, and no account — it runs through your tool's hook " +
          "wherever one is installed (`compaction hooks install --tool <tool>`, or connect the tool in onboarding)."
      )
    );
    return;
  }

  const outcome = applyModeSelection("full", env);

  if (outcome.persisted && outcome.effective === "full") {
    console.log(
      chalk.green("  Full apply enabled — a valid Community entitlement lease is present on this device.")
    );
    if (outcome.leaseTrust === "dev-lease-root") {
      console.log(
        chalk.yellow("  This lease is DEV-SIGNED — not a production entitlement (local development only).")
      );
    }
    // SCOPE THE PROMISE. The entitlement is real and subscription-routed turns apply normally,
    // but this period's metered allowance is gone, so API-key routed turns will refuse. Announcing a
    // bare "full apply enabled" here would describe a capability the very next API-key turn declines.
    //
    // ONE VOCABULARY, ONE DESTINATION. This used to be a bespoke sentence written only here: it said the
    // allowance was SPENT (false whenever the real state is `insufficient` — tokens left, just not enough
    // for the turn), it could not see that state at all, and it named nowhere to go. It now derives from
    // the same resolver and the same words every other ceiling surface uses (`status`, `usage`,
    // `lease status`, `watch`, and the per-turn line), so a user who reads two of them reads one product.
    const ceilingLines = await fullModeCeilingLines(outcome, env);
    if (ceilingLines.length > 0) {
      for (const line of ceilingLines) {
        console.log(line === "" ? "" : chalk.yellow(`  ${line}`));
      }
      console.log(chalk.dim("  Nothing is purchased automatically."));
    }
    console.log(chalk.dim("  On a real apply turn, the per-turn receipt line reads `full apply`."));
    console.log(
      chalk.dim(
        "  Full apply still requires the private engine AND your separate per-tool apply authorization AND " +
          "the safety/recovery gates — the lease alone does not apply anything."
      )
    );
    console.log(chalk.dim(`  Persisted content-free preference: ${outcome.path}`));
    return;
  }

  // No valid lease → explain-and-point. Content-free reason, no full-apply claim.
  console.log(
    chalk.yellow(
      "  Full apply is not available on this device yet: no valid Community entitlement lease is present. " +
        "It is not enabled and no full-apply claim is made here."
    )
  );
  console.log(chalk.dim("  Community full apply adds (over Open basic shaping):"));
  console.log(chalk.dim("    - the private adaptive engine (input compaction + adaptive output), not just the one basic method"));
  console.log(chalk.dim("    - turn/request-aware method selection, candidate generation + ranking, commitment preservation"));
  console.log(chalk.dim("    - safety / evidence / recovery gates and byte-exact recovery on full apply"));
  console.log(
    chalk.dim(
      "  It requires a free Community account, a signed entitlement lease, and the signed private engine."
    )
  );
  if (repaired === undefined) {
    // No account on this device: the whole of Community starts with the one command that sets up the
    // account and the entitlement together, so nobody has to know a separate one exists.
    console.log(
      `  ${chalk.bold("Next:")} run ${chalk.bold("compaction")} and choose Community — a free account, one ` +
        `browser confirmation, and the entitlement is set up for you in the same step.`
    );
  } else {
    // Authenticated, and the repair above already ran and did not get there. Pointing at
    // `compaction lease` would name a concept the journey keeps out of the user's way; the honest
    // pointer is the reason it failed and the command that retries the whole setup. `lease status`
    // stays available for debugging — it is simply not what a user is sent to.
    console.log(
      `  ${chalk.bold("Next:")} run ${chalk.bold("compaction login")} to re-establish Community access on this ` +
        `device — ${leaseBlockedReason(repaired)}. You will not be asked to sign in again.`
    );
  }
  const preserved: "observe" | "basic" = outcome.effective === "basic" ? "basic" : "observe";
  console.log(
    chalk.dim(
      `  Your current mode is unchanged (still \`${preserved}\`).` +
        // TRUE OR ABSENT. This sentence is the Open no-network promise, and it is printed only on the
        // path that kept it: a device with an account just made a call to try to repair itself.
        (repaired === undefined ? " No account, entitlement, usage, or network call was made." : "")
    )
  );
}

/**
 * Re-establish this device's Community setup when it is authenticated but something is missing.
 *
 * Returns `undefined` on a device with no account — the signal that NOTHING was attempted and no
 * network call was made, which the copy above depends on being able to state truthfully. Otherwise
 * returns what the attempt achieved, so a refusal can name the real reason rather than a guess.
 *
 * Dynamic import: `mode` is an Open entry point, and `open-basic-engine-free.test.ts` requires its
 * static graph to reach no `auth/**`, `api-client/**` or `engine-install/**` module.
 */
async function repairCommunityRuntimeIfPossible(
  env: NodeJS.ProcessEnv
): Promise<CommunityRuntimeOutcome | undefined> {
  try {
    const { ensureCommunityRuntime } = await import("../../core/entitlement/community-runtime.js");
    const outcome = await ensureCommunityRuntime(env);
    return outcome.account === "absent" ? undefined : outcome;
  } catch {
    // A repair is best-effort; failing to attempt one must never turn `mode full` into an error. The
    // gates below then run exactly as they did before, on whatever is actually on disk.
    return { account: "present", lease: "unavailable", engine: "unavailable", networkUsed: false };
  }
}

export function registerModeCommand(program: Command): void {
  program
    .command("mode [mode]")
    .description(
      "Show or set the product mode (open-core apply posture). `observe` = no model-visible mutation " +
        "(line: `apply off`); `basic` = the one public deterministic output-shaping method (line: " +
        "`basic shaping`), engine-free and account-free; `full` = Community private-engine apply, which " +
        "requires a valid entitlement lease on this device (without one it explains what Community adds " +
        "and preserves your current Open mode — run `compaction` to set Community up). " +
        "With no argument, shows the current mode. `observe`, `basic`, and the no-argument display are " +
        "fully offline and read/write only the local content-free preference store. `full` on a " +
        "signed-in device first tries to re-establish your Community setup, so it may contact the " +
        "entitlement service and download and install the signed engine; it tells you when it did."
    )
    .action(async (mode?: string) => {
      const env = process.env;
      if (mode === undefined) {
        await printCurrentMode(env);
        return;
      }
      const normalized = mode.trim().toLowerCase();
      if (!isProductMode(normalized)) {
        console.error(
          `unknown mode ${JSON.stringify(mode)}. Valid modes: ${PRODUCT_MODES.join(", ")} ` +
            `(default: ${DEFAULT_PRODUCT_MODE}).`
        );
        process.exitCode = 1;
        return;
      }
      if (normalized === "full") {
        await handleFullMode(env);
        return;
      }
      setOpenMode(normalized, env);
    });
}
