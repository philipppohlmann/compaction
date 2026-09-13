
/**
 * ONE answer to "can the adaptive engine actually run for this user, in this build?" — the question
 * every surface that offers full optimization has to ask before offering it.
 *
 * WHY THIS EXISTS. The npm boundary flip (PR13b) made the engine unobtainable from a public install
 * two ways at once: `dist/engine/**` is excluded, so there is no local build, and the compiled-in
 * production trust root was a deliberate `UNPINNED-PLACEHOLDER`, so `compaction engine install`
 * refused `root-key-not-pinned` and no release could be fetched either. The root is minted and
 * pinned now, which closes the second half — a published install can FETCH a signed release — and
 * makes the distinction below load-bearing rather than latent. Every surface that said "add
 * an API key for full optimization" or "with a free account" became false at that moment — the
 * README, the onboarding mode picker, the connect summary, the auth line. Review found them one
 * surface per round because each carried its own hardcoded claim and nothing asked a shared
 * question. This module is that shared question, so the next surface added asks it too.
 *
 * LAZY BY NECESSITY, not by style. `mode` and `lease` are OPEN entry points, and
 * `open-basic-engine-free.test.ts` requires the Open static import graph to reach no
 * `engine-install/**` and no `api-client/**` module — a static edge here would put both on the Open
 * path through the supervisor. So the two probes are reached through dynamic `import()`, the same
 * sanctioned seam the private movers use, which makes every caller async. That is the cost of asking
 * the question from Open surfaces, and it is cheaper than the surfaces guessing.
 *
 * NOT an entitlement or authorization check. This says only whether the engine COULD run: full apply
 * additionally requires an account, a valid signed lease, an API key, and the per-workflow apply
 * authorization, each enforced where it belongs. `available` here never means "allowed".
 */

export type EngineAvailability =
  /** An engine resolves right now: a verified install, an explicit override, or a dev build. */
  | "present"
  /** No engine yet, but a production trust root is pinned, so `compaction engine install` can get one. */
  | "installable"
  /** Neither: no engine here and no release obtainable — a build with no production root pinned. */
  | "unavailable";

/**
 * Resolve engine availability. Reuses the SAME resolution the supervisor performs at request time
 * (`resolveEngine`), so a surface cannot describe a capability the runtime would then degrade.
 */
export async function engineAvailability(env: NodeJS.ProcessEnv = process.env): Promise<EngineAvailability> {
  const { resolveEngine } = await import("./gateway/engine-ipc/supervisor.js");
  const { loadExecutingManagedInstallation } = await import("./update/ownership.js");
  let managed: ReturnType<typeof loadExecutingManagedInstallation>;
  try { managed = loadExecutingManagedInstallation(env); }
  catch { return "unavailable"; }
  if (resolveEngine({ env, ...(managed ? {
    verifiedInstalledArtifact: managed.pair.engine.mode === "signed" ? managed.pair.engine : null
  } : {}) }).path !== null) return "present";
  const { pinnedRootKeys } = await import("./engine-install/manifest.js");
  return pinnedRootKeys().length > 0 ? "installable" : "unavailable";
}

/**
 * WHETHER THE ENGINE THAT WOULD RUN CAN DO INPUT COMPACTION AT ALL — the question `engineAvailability`
 * does NOT answer, and whose absence let a flagship capability die unseen for five days.
 *
 * An engine can be present, signed, verified, and spawning happily while every input-compacted body
 * it produces is refused on the way out because it declares a meter unit this client cannot place.
 * The gateway logged one line per request and nothing else asked. `status` says `Engine: ready`,
 * because an engine IS ready — for output shaping. This is the missing second question.
 *
 * `"unsupported"` is the only state that makes a claim about an artifact, and it makes it from the
 * engine's own SIGNED manifest, never from a guess about an older engine's unit.
 */
export type EngineInputCompaction =
  /** No engine resolves at all — a separate problem, already reported by `engineAvailability`. */
  | "no-engine"
  /** The resolved engine's signed manifest declares this client's active meter unit. */
  | "supported"
  /** The resolved engine's signed manifest declares a unit this client cannot place, or declares none. */
  | "unsupported"
  /** No signed manifest to read (dev build / explicit path override). Not a claim either way. */
  | "undeclared";

export async function engineInputCompaction(env: NodeJS.ProcessEnv = process.env): Promise<EngineInputCompaction> {
  const { resolveEngine } = await import("./gateway/engine-ipc/supervisor.js");
  const { loadExecutingManagedInstallation } = await import("./update/ownership.js");
  let managed: ReturnType<typeof loadExecutingManagedInstallation>;
  try { managed = loadExecutingManagedInstallation(env); }
  catch { return "no-engine"; }
  // The SAME resolution the supervisor performs, with the same options — so this cannot describe a
  // different engine from the one a request would reach.
  const resolved = resolveEngine({ env, ...(managed ? {
    verifiedInstalledArtifact: managed.pair.engine.mode === "signed" ? managed.pair.engine : null
  } : {}) });
  if (resolved.path === null) return "no-engine";
  return resolved.inputCompaction.support === "supported" ? "supported"
    : resolved.inputCompaction.support === "unsupported" ? "unsupported" : "undeclared";
}

/**
 * Whether a surface may describe full optimization / input compaction as something that RUNS.
 *
 * `"present"` ONLY — deliberately not `!== "unavailable"`. An
 * `"installable"` build can fetch an engine but does not have one, so until an install actually
 * succeeds the requests still pass through: offering the mode there would take an apply
 * authorization for work that cannot happen yet, which is the same defect as offering it with no
 * engine at all. This was written while it was still latent (no production root was minted, so
 * nothing could be `"installable"`), on the reasoning that the day a root was minted every user
 * without an installed engine would otherwise start seeing live full-optimization copy. That day is
 * this build: the narrowing is now doing real work on every install that has not yet fetched one.
 *
 * A future surface that wants "could you GET this?" rather than "does this run?" — an install
 * prompt, say — should call `engineAvailability` and handle `"installable"` explicitly, with an
 * install step attached. It must not reuse this predicate.
 */
export async function fullOptimizationReachable(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  return (await engineAvailability(env)) === "present";
}

/*
 * REMOVED: `ENGINE_UNRELEASED_NOTE`, a fixed suffix reading "no signed engine has been distributed
 * yet". A signed production release now exists, so the sentence is false — and it was exported with
 * ZERO importers, which is the worst shape for a claim: nothing would have failed when it went
 * stale. Surfaces derive availability from `engineAvailability` / `fullOptimizationReachable`
 * above, and the reason a particular device lacks an engine from
 * `entitlement/community-runtime.ts` `engineBlockedReason`, which reads what the attempt actually
 * hit. Do not reintroduce a constant that states the state of the world; ask the runtime.
 */
