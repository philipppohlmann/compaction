/**
 * The LOCAL, DEVICE-SCOPED gates that stand between a valid entitlement lease and a full apply
 * actually happening (PUBLIC CLI core: engine-free, account-free, network-free — it reads two local
 * content-free stores and nothing else).
 *
 * These are the GATEWAY'S OWN conditions, read from the same stores it reads
 * (`resolveStoredAuthorizationApply` in `src/core/gateway/server.ts`, and conditions 2 and 3 of the
 * dormant guard in `src/core/gateway/apply-routing-activation.ts`): the persisted optimization mode
 * must be `cache-plus-context`, and a stored `auto-when-gates-pass` authorization must cover an
 * enabled workflow. Local disk only — no account, entitlement, or network call.
 *
 * WHY A SURFACE MUST ASK: the lease is the only gate activation itself can satisfy, so a surface
 * that consulted the lease alone announced full apply to the many users who kept the recommended
 * Output-only mode — for whom every single request stays on the non-apply path. A surface has to
 * answer the same question the gateway will, not a subset of it.
 *
 * WHY IT LIVES HERE rather than in `init.ts`, where it was written: `mode.ts` is an OPEN entry point
 * whose static import graph may reach no `auth/**`, `api-client/**` or `engine-install/**` module
 * (`tests/security/open-basic-engine-free.test.ts`), and `init.ts` statically imports the device-login
 * client. Importing the predicate from `init.ts` would have put the account client on the Open path —
 * so the second caller could only ever have been a SECOND COPY of the rule, which is exactly how the
 * two answers diverge. `init.ts` re-exports this one; nothing about its behaviour changed.
 */
import { findStoredAuthorization } from "../../core/gateway/apply-eligibility.js";
import { readOptimizationMode } from "../../core/onboarding-preferences.js";
import { FULL_APPLY_PENDING_REASONS, type ReadyToolKey } from "../onboarding/model.js";

/**
 * The first unmet local gate, or `undefined` when none of them is unmet.
 *
 * The FIRST unmet gate is reported, and the optimization mode is checked first on purpose: it is the
 * user's own visible choice from the onboarding mode picker, so it is the reason that will make sense
 * to them.
 *
 * There is no `cwd` here on purpose: both gates are DEVICE facts. The authorization used to be read
 * from the working directory, which made the surfaces that ask this answer differently in different
 * folders.
 */
export async function pendingFullApplyGate(
  workflows: readonly ReadyToolKey[],
  env: NodeJS.ProcessEnv = process.env
): Promise<string | undefined> {
  if (readOptimizationMode(env) !== "cache-plus-context") return FULL_APPLY_PENDING_REASONS.optimizationMode;
  for (const workflow of workflows) {
    // ONE env for both gates. The mode and the authorization are two facts about the same device, and
    // a surface must answer the question the gateway will answer - reading them from two different
    // environments (or the authorization from a working directory) is how the two answers diverge.
    const authorization = await findStoredAuthorization({ scope: { tool: workflow }, env });
    if (authorization) return undefined;
  }
  // Also the "nothing was enabled" case: no enabled workflow can carry an authorization, so no turn
  // routed through this device can be a full apply either.
  return FULL_APPLY_PENDING_REASONS.applyAuthorization;
}
