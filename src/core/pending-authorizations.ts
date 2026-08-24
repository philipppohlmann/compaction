/**
 * CONSENT CARRIED TO ACTIVATION — the deferred half of the one-time Cache + context confirmation.
 *
 * THE PROBLEM THIS EXISTS FOR. Onboarding's Cache + context confirmation stores one narrow auto-apply
 * authorization per routed workflow, and that store may only happen with a resolve-VERIFIED active
 * capture shim. On a genuinely fresh machine the shim is necessarily installed-but-not-yet-on-PATH in
 * the shell that ran onboarding, so the store is correctly skipped — and nothing ever ran again to
 * perform it, while the flow told the user the confirmation stores an authorization and that no further
 * command is needed. The consent was taken and then silently dropped.
 *
 * WHAT THIS MODULE DOES, AND WHAT IT DELIBERATELY DOES NOT. It records that a consent was GIVEN and
 * redeems it later. It does NOT lower the bar that consent has to clear:
 *
 *  - REDEMPTION RE-VERIFIES. `verifyShimActive(tool).active` must be true at redemption time — the same
 *    check, against live PATH resolution, that the immediate path performs. A pending record never
 *    substitutes for it, and a shim that never activates is never redeemed.
 *  - REDEMPTION RE-READS THE MODE. The consent was one half of a `cache-plus-context` confirmation, so a
 *    user who has since moved their recorded default back to `cache` has withdrawn it; that drops the
 *    record without storing anything. This is why no mode-change command needs to know about this store.
 *  - THE RECORD CARRIES NO AUTHORITY OF ITS OWN. It stores the workflow ENUM and nothing else — no scope,
 *    no policy type, no gate list, no path, no timestamp. The scope and the gate list are reconstructed
 *    at redemption from the same constants the immediate path uses, so a hand-edited file cannot widen
 *    an authorization; the most it can do is name another already-authorizable workflow, which still has
 *    to pass both checks above.
 *  - THE AUTHORIZATION IT WRITES IS IDENTICAL. Same `savePolicyPreference` call, same narrow per-tool
 *    scope, same `AUTO_APPLY_ELIGIBILITY_GATES`. The gateway still evaluates every gate per request.
 *
 * WHERE IT LIVES. Beside the authorization store it feeds (`.compaction/policy-preferences.json`), so a
 * consent given in one project redeems into that same project's authorizations and nowhere else. The
 * directory is the only scoping either store has.
 *
 * FAIL-OPEN, NEVER FAIL-CLOSED-INTO-AUTHORIZING. Every read path treats a missing/corrupt/foreign file
 * as "no pending consent". Local file I/O only; no network.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  AUTO_APPLY_ELIGIBILITY_GATES,
  DEFAULT_POLICY_PREFERENCES_DIRECTORY,
  savePolicyPreference
} from "./policy-preferences.js";
import { DEDUPE_POLICY } from "./gateway/request-shape.js";
import { verifyShimActive, type ShimTool } from "./tool-shim.js";
import { readOptimizationMode } from "./onboarding-preferences.js";

export const PENDING_AUTHORIZATIONS_FILENAME = "pending-authorizations.json";

/**
 * The workflows a consent may be carried for: the routed workflows whose auto-apply authorization is
 * gated on a PATH shim becoming active. `claude-code` is deliberately absent — its authorization has
 * always been stored on the installed bar, so it is never deferred and never needs redeeming.
 */
export const CARRYABLE_CONSENT_WORKFLOWS = ["codex"] as const;
export type CarryableConsentWorkflow = (typeof CARRYABLE_CONSENT_WORKFLOWS)[number];

export function isCarryableConsentWorkflow(value: unknown): value is CarryableConsentWorkflow {
  return typeof value === "string" && (CARRYABLE_CONSENT_WORKFLOWS as readonly string[]).includes(value);
}

/** The on-disk shape. ONE key, whose only legal values are the workflow enum members. */
interface PendingAuthorizationsFile {
  pending_auto_apply_consent: CarryableConsentWorkflow[];
}

const CONSENT_KEY = "pending_auto_apply_consent";

function storePath(directory: string): string {
  return join(directory, PENDING_AUTHORIZATIONS_FILENAME);
}

/**
 * Read the recorded consents. Never throws and never guesses: a missing, unreadable, non-JSON, or
 * unexpectedly shaped file yields an empty list, and any entry that is not an exact enum member is
 * dropped. Order is canonical, not file order.
 */
export async function readPendingConsents(
  directory: string = DEFAULT_POLICY_PREFERENCES_DIRECTORY
): Promise<CarryableConsentWorkflow[]> {
  let raw: string;
  try {
    raw = await readFile(storePath(directory), "utf8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return [];
  const list = (parsed as Record<string, unknown>)[CONSENT_KEY];
  if (!Array.isArray(list)) return [];
  return CARRYABLE_CONSENT_WORKFLOWS.filter((w) => list.includes(w));
}

async function writePendingConsents(
  consents: readonly CarryableConsentWorkflow[],
  directory: string
): Promise<void> {
  const path = storePath(directory);
  if (consents.length === 0) {
    await rm(path, { force: true });
    return;
  }
  const body: PendingAuthorizationsFile = {
    pending_auto_apply_consent: CARRYABLE_CONSENT_WORKFLOWS.filter((w) => consents.includes(w))
  };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(body, null, 2)}\n`, "utf8");
}

/**
 * Record that the user consented to the narrow Cache + context authorization for `workflow` while its
 * shim was installed but not yet active. Idempotent. Callers must have taken the consent in the same
 * run; this function is not itself a consent gesture.
 */
export async function recordPendingConsent(
  workflow: CarryableConsentWorkflow,
  directory: string = DEFAULT_POLICY_PREFERENCES_DIRECTORY
): Promise<void> {
  const existing = await readPendingConsents(directory);
  if (existing.includes(workflow)) return;
  await writePendingConsents([...existing, workflow], directory);
}

/**
 * Drop a recorded consent without redeeming it — the withdrawal path. Called when the workflow is
 * disconnected: the shim that would have activated it is gone, and a consent must never outlive the
 * user's ability to take it back.
 */
export async function clearPendingConsent(
  workflow: CarryableConsentWorkflow,
  directory: string = DEFAULT_POLICY_PREFERENCES_DIRECTORY
): Promise<void> {
  const existing = await readPendingConsents(directory);
  if (!existing.includes(workflow)) return;
  await writePendingConsents(
    existing.filter((w) => w !== workflow),
    directory
  );
}

/** Which workflows this redemption actually stored an authorization for (empty is the normal case). */
export interface RedeemResult {
  redeemed: CarryableConsentWorkflow[];
}

/**
 * Redeem every recorded consent whose shim is NOW verified active, storing the same narrow
 * authorization the immediate path would have stored. Runs on ordinary Compaction invocations — the
 * shim's own capture bridge among them — so the user opening a new shell is the only thing that has to
 * happen; there is no command to discover.
 *
 * Fail-open and silent: any error leaves the consent pending for the next run rather than failing the
 * command it is riding on. Nothing is printed here — the deferral is disclosed at consent time, where
 * the user can act on it.
 */
export async function redeemPendingConsents(
  directory: string = DEFAULT_POLICY_PREFERENCES_DIRECTORY,
  env: NodeJS.ProcessEnv = process.env
): Promise<RedeemResult> {
  const pending = await readPendingConsents(directory);
  if (pending.length === 0) return { redeemed: [] };
  // WITHDRAWN BY A MODE CHANGE. The consent was half of a `cache-plus-context` confirmation; a recorded
  // default that is no longer that is the user having taken it back. Drop everything, store nothing.
  if (readOptimizationMode(env) !== "cache-plus-context") {
    await writePendingConsents([], directory);
    return { redeemed: [] };
  }
  const redeemed: CarryableConsentWorkflow[] = [];
  let remaining = pending;
  for (const workflow of pending) {
    // THE SAME BAR, RE-CHECKED NOW. Not "was it going to activate?" but "is it active?".
    if (!verifyShimActive(workflow as ShimTool, env).active) continue;
    const result = await savePolicyPreference(
      {
        scope: { tool: workflow, policy_type: DEDUPE_POLICY },
        preference: "auto-when-gates-pass",
        enabled: true,
        gates_required: [...AUTO_APPLY_ELIGIBILITY_GATES]
      },
      directory
    );
    if (!result.saved) continue; // leave it pending; a later run retries
    redeemed.push(workflow);
    remaining = remaining.filter((w) => w !== workflow);
  }
  if (redeemed.length > 0) await writePendingConsents(remaining, directory);
  return { redeemed };
}

/**
 * The CLI-wide redemption hook: what makes "no further command" true. Wrapped so a failure anywhere in
 * here can never surface as an error on an unrelated command.
 */
export async function redeemPendingConsentsQuietly(): Promise<void> {
  try {
    await redeemPendingConsents();
  } catch {
    /* fail-open: the consent stays pending for a later run; the command it rode on is unaffected */
  }
}
