/**
 * `compaction statusline` - the Claude Code status-line command (PUBLIC CLI, engine-free).
 *
 * Claude Code's `statusLine` config runs a command each turn, passes the session JSON on stdin, and
 * RENDERS the command's stdout at the bottom of the UI. That makes it the ONLY per-turn VISIBLE surface
 * for Claude Code - the Stop hook's stdout is swallowed. This command prints the SINGLE canonical
 * content-free per-turn receipt line there.
 *
 * Contract:
 *  - Read the Claude Code session JSON from stdin (fields include `cwd`, `session_id`, model/token/cost;
 *    tolerate ANY shape). Resolve cwd (the JSON's `cwd` when present, else process.cwd()).
 *  - IT MAY NOT ASSERT HEALTH IT CANNOT SUPPORT. When this directory's transparent-routing endpoint is
 *    recorded down or quarantined, the line says so and says nothing else — see `routing-health.ts`.
 *    That is a synchronous read of a prior render's measurement, never a probe on this path.
 *  - THE LINE DESCRIBES ONE COMPLETED USER RUN, not one provider call and not a live counter. With a
 *    run boundary for this session, print the newest SETTLED run with a result (it changes when a
 *    run settles, never while one is in flight), `compaction · working` before any run has a result,
 *    and NEVER a per-call receipt or the live stdin count.
 *  - No run boundary at all → the legacy per-call path, but a receipt carrying a different named
 *    session's correlation is rejected instead of being borrowed from the cwd; then a minimal
 *    content-free OUTPUT-ONLY line from the stdin token counts, else a short quiet placeholder
 *    (`compaction · recording`). Never empty-crash.
 *
 * Hard posture: FAST (no network; gateway tail plus the local activity fallback only when a closed
 * hook-only run has no receipt), FAIL-OPEN (any error → a minimal safe string or
 * nothing, ALWAYS exit 0, NEVER throw - Claude Code calls this constantly inside its render loop), and
 * CONTENT-FREE (counts / labels / source / short id only; never a prompt, path, or response byte).
 * Honors the `COMPACTION_RECEIPT_LINE=0` kill switch (prints nothing).
 */
import { Command } from "commander";
import path from "node:path";
import { readActivityEvents } from "../../core/activity-store.js";
import type { ActivityEvent } from "../../core/activity-event.js";
import { claudeLogicalRunIdentity } from "../../core/claude-logical-run-id.js";
import {
  readGatewayReceiptTailWindow,
  readLatestGatewayReceiptTail,
  type GatewayReceipt,
  type GatewayReceiptTailWindow
} from "../../core/gateway/receipt.js";
import { routingEndpointState } from "../../core/gateway/routing-health.js";
import { sessionCorrelationId } from "../../core/gateway/session-correlation.js";
import {
  completedUserRuns,
  currentUserRun,
  receiptBelongsToRun,
  type UserRun
} from "../../core/gateway/run-boundary.js";
import { aggregateRun } from "../../core/gateway/run-aggregate.js";
import {
  latestConsistentClaudeStopEvent,
  settledRunApplyPosture,
  settledRunOutputEstimate,
  settledStopLineFromActivityEvent
} from "../../core/settled-stop-activity.js";
import {
  isReceiptLineEnabled,
  communityFullApplyReceiptLine,
  isRealApply,
  nonApplyReceiptLine,
  receiptCeiling,
  receiptLineFromGatewayReceipt,
  receiptLineOutputOnly,
  runAggregateLine
} from "../../core/gateway/receipt-line.js";
import { isShapingHooksActivated } from "../../core/output-shaping-hook-activation.js";
import {
  estimatePerTurnOutputSaved,
  loadOutputCalibrationResolver,
  type OutputCalibrationResolver,
  type PerTurnReduction
} from "../../core/output-shaping-savings.js";
import { outputCalibrationQuery } from "../../core/output-shaping-calibration-store.js";
import { lastTurnWasShaped } from "../../core/output-shaping-turn-state.js";
import type { ShapingTurnScope } from "../../core/output-shaping-turn-state.js";
import { resolveOpenTier } from "../../core/onboarding-preferences.js";

/** The quiet, claim-free placeholder when there is nothing to report yet (never empty). */
export const STATUS_LINE_PLACEHOLDER = "compaction · recording";

/**
 * The line while a user run is in flight and no earlier run of this session has a result. The line
 * describes ONE completed run; it never shows a provisional number that moves as provider calls land.
 */
export const STATUS_LINE_WORKING = "compaction · working";

/** How many recent settled runs the line may look back through for one with a result. */
const SETTLED_RUN_CANDIDATES = 5;

/**
 * The line while this directory's routed endpoint is not answering.
 *
 * It REPLACES the normal line rather than decorating it. Two reasons, both load-bearing:
 *  - every other rung of this ladder describes recording or shaping that is not happening. The
 *    placeholder says `recording`; a run or receipt line shows counts that cannot advance while the
 *    endpoint is down, because no receipt can land. Appending a warning to a stale number leaves the
 *    stale number as the sentence's subject.
 *  - a suffix is what a narrow terminal truncates first, which would delete the warning in exactly
 *    the case it exists for.
 *
 * It asserts the present tense only. It does NOT promise revival - the same reason the quarantined
 * routing row in `gateway status` prints a bare `NOT ANSWERING`.
 */
export const STATUS_LINE_ROUTING_DOWN = "compaction · routing endpoint not answering";

/**
 * The line while the routed endpoint's reserved port is quarantined.
 *
 * Kept distinct from the line above because the states differ in the one way that matters to the
 * user: a plain refusal is repaired at the same address, a quarantine never is. This surface has no
 * room for the reason, so it names the state and points at the surface that carries the reason. A
 * pointer, not a promise.
 */
export const STATUS_LINE_ROUTING_QUARANTINED =
  "compaction · routing endpoint quarantined · see 'compaction gateway status'";

/** The (loosely-typed) fields we read off the Claude Code status-line stdin JSON. Any shape tolerated. */
interface StatusLineStdin {
  cwd?: unknown;
  /** Claude Code's own session identifier — the key the turn's shaping evidence is filed under. */
  session_id?: unknown;
  /** Claude Code has embedded usage under a few shapes over versions; we read whatever is present. */
  cost?: { total_tokens?: unknown; output_tokens?: unknown } | unknown;
  usage?: { output_tokens?: unknown; provider_reported?: unknown } | unknown;
  output_tokens?: unknown;
  /** Current Claude Code payload (2.1.x): usage for the latest API response is nested here. */
  context_window?: {
    total_output_tokens?: unknown;
    current_usage?: { output_tokens?: unknown } | null | unknown;
  } | unknown;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Best-effort parse of the stdin JSON. Malformed / empty → an empty object (never throws). */
function parseStatusLineStdin(raw: string): StatusLineStdin {
  try {
    const trimmed = raw.trim();
    if (!trimmed) return {};
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as StatusLineStdin) : {};
  } catch {
    return {};
  }
}

/** Pull a content-free output-token count out of whatever shape the stdin carried, if any. */
function outputTokensFromStdin(stdin: StatusLineStdin): number | undefined {
  const cost = stdin.cost as { output_tokens?: unknown } | undefined;
  const usage = stdin.usage as { output_tokens?: unknown } | undefined;
  const contextWindow = stdin.context_window as {
    total_output_tokens?: unknown;
    current_usage?: { output_tokens?: unknown } | null;
  } | undefined;
  const currentUsage = contextWindow?.current_usage;
  const contextOutput = asNumber(currentUsage?.output_tokens);
  const contextTotal = asNumber(contextWindow?.total_output_tokens);
  return (
    asNumber(stdin.output_tokens) ??
    asNumber(usage?.output_tokens) ??
    asNumber(cost?.output_tokens) ??
    contextOutput ??
    // Claude reports zero with `current_usage: null` before the first completed response. That is not
    // completed-turn evidence, so keep the quiet placeholder until a positive total exists.
    (contextTotal !== undefined && contextTotal > 0 ? contextTotal : undefined)
  );
}

export interface StatusLineDeps {
  /**
   * Read the receipts in the tail window for the run aggregate (injectable for tests). A bare array
   * is taken as a complete read; a window carries the truncation fact.
   */
  readReceipts?: (cwd: string, coverFrom?: string) => Promise<GatewayReceipt[] | GatewayReceiptTailWindow>;
  /** Read the LATEST gateway receipt for `cwd` (tail-only; injectable for tests). */
  readReceipt?: (cwd: string) => Promise<GatewayReceipt | undefined>;
  env?: NodeJS.ProcessEnv;
  /** Fallback cwd when the stdin JSON does not carry one. */
  cwd?: string;
  /**
   * WHOSE turn this render is when a caller supplies an independently validated scope. Claude Code
   * normally derives its own scope from `session_id`; Codex Stop uses its settled activity renderer.
   */
  shapingScope?: ShapingTurnScope;
}

/** The local activity log for the hook-only fallback; unreadable reads as empty (fail-open render). */
async function readSettledActivity(cwd: string): Promise<readonly ActivityEvent[]> {
  try {
    return (await readActivityEvents(path.join(cwd, ".compaction", "activity"))).events;
  } catch {
    return [];
  }
}

/**
 * Read the settled activity event for THIS exact closed run. This is only a no-receipt fallback:
 * gateway aggregation remains authoritative above it, an open run can never resurrect an earlier
 * result. A long run settles more than once - the Stop hook writes a fresh cumulative snapshot on
 * every Stop - so more than one match is the ORDINARY case, not a conflict: `latestConsistentClaudeStopEvent`
 * picks the series' latest snapshot when the whole set is provably one consistent cumulative series,
 * and still fails closed (returns `undefined`) on a genuine conflict rather than guessing "latest" by
 * accident. See its doc comment for the exact consistency rule.
 */
function exactSettledClaudeActivityLine(events: readonly ActivityEvent[], run: UserRun): string | undefined {
  if (!run.ended_at) return undefined;
  const identity = claudeLogicalRunIdentity(run);
  if (!identity) return undefined;
  try {
    const matches = events.filter((event) =>
      event.activity_kind === "claude-stop" &&
      event.session_id === identity.sessionId &&
      event.run_id === identity.runId
    );
    const selected = latestConsistentClaudeStopEvent(matches);
    return selected ? settledStopLineFromActivityEvent(selected) : undefined;
  } catch {
    // A status render must never turn an unreadable optional activity fallback into a host failure.
    return undefined;
  }
}

/**
 * Render ONE run's aggregate from the receipts already read, or `undefined` when this run has nothing
 * to show: no receipts of its own inside the window, or receipts carrying no counts.
 */
function runLineFor(args: {
  run: UserRun;
  window: GatewayReceiptTailWindow;
  env: NodeJS.ProcessEnv;
  calibrationResolver: OutputCalibrationResolver;
}): string | undefined {
  const { run, window } = args;
  const receipts = window.receipts.filter((r) => receiptBelongsToRun(r, run));
  if (receipts.length === 0) return undefined;

  // KNOWN-INCOMPLETE: the bounded tail read cut into this run. When bytes precede the window AND the
  // oldest receipt the window holds was captured after the run began, calls of this run may lie
  // outside what was read. The totals are then rendered without a rate — an undercount presented as
  // the run's percentage would be a claim the read cannot support. (Older receipts than the run's
  // start being present proves nothing was cut off: the ledger is append-ordered.)
  const oldestCapturedAt = window.receipts.reduce<string | undefined>(
    (min, r) => (typeof r.captured_at === "string" && (min === undefined || r.captured_at < min) ? r.captured_at : min),
    undefined
  );
  const incomplete = window.truncated && (oldestCapturedAt === undefined || oldestCapturedAt > run.started_at);

  // ONE rate source, the same `PerTurnReduction` every other surface uses. The run line and the per-call
  // lines resolve the same ANCHOR and refine a family anchor through the same `refineOutputRateForRun`:
  // a RUN with its whole-run morphology (inside `aggregateRun`), a single turn as a one-call run (inside
  // `estimatePerTurnOutputSaved`). Same evidence, different scope, so the two may legitimately differ. WHETHER a
  // call contributes a counterfactual at all is decided per call inside `aggregateRun`, from that
  // call's own durable `output_shaping_state`. A run with no proven-shaped call therefore reports its
  // plain output total, whatever the device's calibration says.
  //
  // ONLY AN EXACT OR STRICTLY COMPATIBLE FAMILY-CALIBRATED RATE, NEVER THE GENERIC SHIPPED PRIOR.
  // `settledRunOutputEstimate` resolves the same per-receipt applicability keys as aggregation and
  // retains whether the reconstructed counterfactual came from exact measurement or family evidence.
  // With no compatible calibration the run line keeps the honest unknown axis; a generic prior can
  // never produce a numerical before/after pair.
  const aggregate = aggregateRun(receipts, { outputCalibrationResolver: args.calibrationResolver });
  const posture = settledRunApplyPosture(receipts, aggregate);
  const outputEstimate = settledRunOutputEstimate(aggregate, receipts, args.calibrationResolver);
  const outputCalibrated =
    outputEstimate.calibrated === true &&
    (outputEstimate.basis === "measured" || outputEstimate.basis === "family-calibrated");
  // THE RUN'S CEILING, from the call that recorded it, through the SAME translation the per-receipt
  // path uses (`receiptCeiling`): the pause reason, its reset date, whether shaping continued, and the
  // period-bound conversion path. Without it a blocked Community user whose run ended on an
  // `insufficient` pause — allowance left, but less than that call needed, a state the session
  // resolver cannot express — read a bare total with no reason and no way to act.
  const ceiling = aggregate.pausedCall !== undefined ? receiptCeiling(aggregate.pausedCall, args.env) : undefined;
  return runAggregateLine({
    aggregate,
    ...(posture ? { tier: posture } : {}),
    ...(outputCalibrated ? { outputBasis: outputEstimate.basis } : {}),
    ...(!outputCalibrated && aggregate.shapedCallCount > 0
      ? { outputState: outputEstimate.state ?? "unseeded" as const }
      : {}),
    ...(ceiling !== undefined ? { ceiling } : {}),
    ...(args.run.ended_at
      ? { activeWindow: { startedAt: args.run.started_at, endedAt: args.run.ended_at } }
      : {}),
    ...(incomplete ? { incomplete } : {})
  });
}

/**
 * The RUN render, or `undefined` when this session has no run boundary to describe at all.
 *
 * Returns `undefined` — handing the render to the per-receipt path — when stdin carries no
 * `session_id`, the device cannot produce a correlation id, or no `UserPromptSubmit` marker exists.
 * The fallback requires an exact receipt correlation whenever stdin names a session. Legacy
 * uncorrelated receipts remain available only to legacy stdin that itself has no session identity.
 *
 * IN EVERY OTHER CASE THE RUN PATH IS AUTHORITATIVE OVER THE PER-CALL RECEIPT. Once a session has run
 * boundaries, a receipt is never again allowed to take this surface — see the between-runs note below.
 */
async function runAggregateStatusLine(args: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin: StatusLineStdin;
  calibrationResolver: OutputCalibrationResolver;
  readReceipts: (cwd: string, coverFrom?: string) => Promise<GatewayReceipt[] | GatewayReceiptTailWindow>;
}): Promise<string | undefined> {
  const sessionId = asString(args.stdin.session_id);
  if (!sessionId) return undefined;
  const correlationId = sessionCorrelationId(sessionId, args.env);
  if (!correlationId) return undefined;
  const run = currentUserRun(correlationId, args.env);
  if (!run) return undefined;

  // ======================= ONE LINE PER SETTLED RUN, NEVER A MOVING TOTAL =======================
  // The line represents ONE completed user task. While a run is in flight its receipts are still
  // landing, so any number drawn from them would change during the task. An open run therefore
  // renders NOTHING of its own: the line holds the newest SETTLED run of this session that has a
  // result, or a quiet non-numeric `working` when none has. At Stop the run closes and the line
  // changes to its final aggregate. Membership stays `same session correlation AND inside the run's
  // interval`, so concurrent sessions cannot mix.
  //
  // The NEWEST RENDERABLE settled run, not merely the newest settled one: a run with no result yet (a
  // hook-only run whose Stop event is still being written) or ever (a prompt that made no provider
  // call) must not replace the last real result with a numberless frame. Bounded by
  // a small candidate count (this runs in Claude Code's render loop), and the common case renders the
  // first candidate.
  //
  // KNOWN AND INTENDED: a call that STARTED before Stop but completes after it belongs to the run
  // (`receiptBelongsToRun`), so its late receipt can still correct the settled total once.
  //
  // Each store is read at most ONCE per render, whatever the number of candidates: the receipt window
  // covers back to the OLDEST candidate's start (so a normal long run is COMPLETE instead of an
  // ambiguous partial total; a run that still exceeds the ceiling keeps its honest `truncated`), and the
  // activity log is read only if some candidate needs the hook-only fallback.
  const candidates = completedUserRuns(correlationId, args.env).slice(0, SETTLED_RUN_CANDIDATES);
  if (candidates.length > 0) {
    const read = await args.readReceipts(args.cwd, candidates[candidates.length - 1].started_at);
    const window: GatewayReceiptTailWindow = Array.isArray(read) ? { receipts: read, truncated: false } : read;
    let activity: readonly ActivityEvent[] | undefined;
    for (const settled of candidates) {
      const line = runLineFor({ run: settled, window, env: args.env, calibrationResolver: args.calibrationResolver });
      if (line !== undefined) return line;
      // A hook-only Claude run has no gateway receipts. Its exact positively reconciled final
      // transcript event is the sole durable aggregate, shared with default watch. Only a CLOSED run is
      // consulted, and never a merely recent event from this or another session.
      activity ??= await readSettledActivity(args.cwd);
      const settledActivityLine = exactSettledClaudeActivityLine(activity, settled);
      if (settledActivityLine !== undefined) return settledActivityLine;
    }
  }

  // No settled run has a result: quiet, and never a per-call receipt or the live stdin count, either of
  // which would describe something other than a completed run.
  return run.ended_at === undefined ? STATUS_LINE_WORKING : STATUS_LINE_PLACEHOLDER;
}

/**
 * Compute the ONE status line to print for a given stdin blob. Pure + fail-open: returns a string to
 * print, or `undefined` to print NOTHING (kill switch on). Never throws.
 *  0. this directory's routed endpoint is quarantined or has been unreachable past the grace window →
 *     the ROUTING STATE line, and nothing else. Every rung below describes recording or shaping that
 *     is not happening.
 *  1. this session has a run boundary → the newest SETTLED run with a result, else `working` / the quiet
 *     placeholder. Rungs 2-4 are never reached once a run boundary exists.
 *  2. else a gateway receipt for this cwd → the canonical per-call input+output line.
 *  3. else an OUTPUT-ONLY line from the stdin token count (content-free), if present.
 *  4. else the quiet placeholder.
 */
export async function computeStatusLine(rawStdin: string, deps: StatusLineDeps = {}): Promise<string | undefined> {
  const env = deps.env ?? process.env;
  if (!isReceiptLineEnabled(env)) return undefined; // kill switch → print nothing

  try {
    const stdin = parseStatusLineStdin(rawStdin);
    const cwd = asString(stdin.cwd) ?? deps.cwd ?? process.cwd();

    // ======================= THE SURFACE MAY NOT ASSERT HEALTH IT CANNOT SUPPORT =======================
    // Every rung below describes recording or shaping. During the measured outage the endpoint backing
    // this session was dead for minutes and every request failed, and this line went on rendering
    // anyway - the one surface whose job is telling the user what is happening asserted that something
    // was.
    //
    // This is a READ, never a probe: `routingEndpointState` opens no socket, performs no handshake and
    // starts nothing. It resolves what the previous render's detection pass already measured
    // (`detectDeadRoutingEndpoint` -> `routing-revival.ts` -> `routing-health.ts`), so the render-loop
    // rail is untouched: still no wait, still no blocked turn.
    //
    // GATED ON THE SLOT'S EXISTENCE, so an unrouted directory - every hooks-only and subscription
    // device - renders byte-for-byte what it rendered before. And a state is only reported after the
    // endpoint has been unreachable for longer than a successful self-repair takes, so an ordinary
    // recovery does not flash a failure across this line on its way back up.
    const routingState = routingEndpointState(cwd, env);
    if (routingState === "quarantined") return STATUS_LINE_ROUTING_QUARANTINED;
    if (routingState === "unavailable") return STATUS_LINE_ROUTING_DOWN;

    const readReceipt = deps.readReceipt ?? ((c: string) => readLatestGatewayReceiptTail(c));

    // The OPEN per-turn tier label from the local product-mode store (`apply off` / `basic shaping`),
    // plus the one reason the clamp must not swallow: a Community user whose period allowance is spent
    // would otherwise read a bare `apply off` — a silent tier downgrade. Reads local disk only (the
    // lease, the credentials, and the local usage journal) — no account/entitlement/usage-service or
    // network call, and fail-open by construction.
    const { tier: productTier, allowanceResetsOn } = await resolveOpenTier(env);

    // THE VISIBLE SURFACE. Claude Code swallows hook stdout; this
    // status line is the only per-turn line a user actually sees. The previous fix wired the Stop-hook
    // capture and left this caller unchanged, so calibrated users kept seeing a plain `output N` on the
    // one surface that renders. The RATE is loaded once here; the per-turn count is derived at each use
    // site from that line's own output, never from a session-wide sum.
    // Per-turn evidence, not activation state — see `output-shaping-turn-state.ts`. False whenever the
    // turn cannot be confirmed shaped, so a held planning turn renders a plain count.
    // SCOPED TO THIS CLAUDE CODE SESSION. Claude Code passes its `session_id` on the status-line stdin,
    // the same identifier the `UserPromptSubmit` hook recorded the decision under — so this line reads
    // ITS OWN session's decision. Without the scope, every concurrent session read one shared slot: a
    // deliberately HELD turn could render another session's `shape` and draw a calibrated delta off it.
    // No `session_id` on the stdin ⇒ no scope ⇒ fails closed, and the line renders plain counts.
    // An explicit independently validated scope from the caller wins. Claude Code passes none and
    // derives its own; Codex Stop settles through `codex-stop-usage.ts` instead of this fallback ladder.
    const shapingScope: ShapingTurnScope | undefined =
      deps.shapingScope ??
      (() => {
        const sessionId = asString(stdin.session_id);
        return sessionId ? { tool: "claude-code", sessionId } : undefined;
      })();
    const hookShapedTurn = await lastTurnWasShaped(shapingScope, env);
    // The rate is loaded regardless of WHICH surface shaped the turn; whether it is USED is decided
    // per turn below, from evidence. A read failure yields an uncalibrated rate, never a fabricated one.
    const calibrationResolver = await loadOutputCalibrationResolver(env);
    const unavailableReduction: PerTurnReduction = {
      availability: "unavailable",
      reason: "the hook payload carries no exact provider/model calibration key.",
      state: "unseeded"
    };
    const reduction = hookShapedTurn ? unavailableReduction : undefined;

    // ============================ THE PRIMARY SURFACE IS THE RUN ============================
    // A user thinks in one request, not one provider call. Claude Code sends many provider calls per
    // prompt — including auxiliary record-mode calls of its own — so rendering whichever receipt
    // landed last made this line flicker `full apply → apply off → full apply` inside ONE task.
    //
    // When this session has a run boundary (the `UserPromptSubmit` hook opened one), the line shows
    // the newest SETTLED run with a result and changes only when a run settles (see
    // `runAggregateStatusLine`), never while one is in flight. Membership is
    // `same session correlation AND inside the run's interval` — never the working directory, so two
    // concurrent sessions here cannot mix.
    //
    // AND IT OWNS THE WHOLE SURFACE ONCE IT EXISTS. Neither the per-call receipt rung (whichever receipt
    // landed last in this directory) nor the stdin output count (the host's live count for the turn in
    // flight) describes a completed run, and both move during a task. Without a run boundary (no hook
    // installed, or no `session_id` on the stdin) the rungs below run exactly as before.
    const runLine = await runAggregateStatusLine({
      cwd, env, stdin, calibrationResolver,
      readReceipts:
        deps.readReceipts ??
        ((c: string, coverFrom?: string) => readGatewayReceiptTailWindow(c, undefined, coverFrom))
    });
    if (runLine !== undefined) return runLine;

    const candidateReceipt = await readReceipt(cwd);
    const namedSessionId = asString(stdin.session_id);
    const expectedCorrelation = namedSessionId ? sessionCorrelationId(namedSessionId, env) : undefined;
    // Modern receipts identify their session with a keyed, content-free correlation. Named-session
    // stdin therefore requires an exact match: an uncorrelated legacy receipt is no more attributable
    // to this session than a receipt positively naming another one. Legacy fallback remains only for
    // legacy stdin that carries no session identity of its own.
    const receipt =
      namedSessionId !== undefined
        ? expectedCorrelation !== undefined && candidateReceipt?.session_correlation_id === expectedCorrelation
          ? candidateReceipt
          : undefined
        : candidateReceipt;
    if (receipt) {
      // FULL tier (a valid entitlement lease is present): only a successful stored-policy private LCM
      // input reduction renders `full apply`. Other real input reductions keep their measured arrow via
      // the generic builder; record/shaping-only turns use the label-free fallback.
      // The ceiling rides the FALLBACK too: a full-tier user whose metered allowance is locally spent
      // sees non-apply turns, and those are exactly the turns that must say why.
      // THE GATEWAY IS NOW A SHAPING SURFACE TOO.
      // The arrow used to be gated solely on `lastTurnWasShaped`, which ONLY the tool's prompt hook
      // ever writes. On a gateway-routed device with no hooks installed — precisely the device Open
      // basic gateway shaping exists to serve — the gateway would shape the turn and this line would
      // still render a plain `output N`, making the whole feature look like a no-op on the one surface
      // a user actually sees. The receipt is the gateway's own per-turn evidence and is read here
      // rather than having the gateway write the hook's state file, which would cross-attribute turns
      // between two independent paths.
      //
      // AND IT READS `output_shaping_state`, THE SAME EVIDENCE `watch` READS. This used to be
      // `request_mutated && applied_components.includes("output-shaping")` — the predicate that answers
      // "did this pass MUTATE", not "was shaping ACTIVE on the request". Leaving it here while `watch`
      // moved would make the two renderers disagree about the SAME receipt: an `already-active` turn
      // (the ordinary LCM shape, and any turn whose policy arrived upstream) would draw the arrow on
      // replay and withhold it live, on the one surface a user actually sees.
      //
      // FAIL-CLOSED, exactly as on the replay path: a legacy receipt carries no state, cannot be
      // classified after the fact, and licenses nothing. `hookShapedTurn` below remains the independent
      // live channel, so a hook-installed device is unaffected by that strictness.
      const shapingState = receipt.output_shaping_state;
      const gatewayShapedTurn = shapingState === "attached-this-pass" || shapingState === "already-active";
      // KNOWN GAP — THE TWO CHANNELS CANNOT BE CORRELATED TO THE SAME TURN (pre-existing; tracked).
      // `hookShapedTurn` is per-SESSION, but the receipt is whatever landed last in this CWD's shared
      // `receipts.jsonl`, and `GatewayReceipt` carries no session identity at all. So with two concurrent
      // Claude Code sessions in one project both routed through the gateway, session A's `shape` can
      // decorate a receipt session B produced, and A's line then draws an estimated reduction over B's
      // counts. Note the counts are ALREADY B's in that setup, arrow or not — the mis-pairing is in the
      // receipt read, not in the evidence.
      // THE RUN PATH ABOVE CLOSES THIS GAP: every receipt now carries a `session_correlation_id` read
      // from the session id Claude Code sends in `metadata.user_id` (evidence in
      // `session-correlation.ts`), and run membership requires it. This per-receipt FALLBACK still reads
      // whatever landed last and is reached only when no run boundary exists for the session.
      const shapedThisTurn = gatewayShapedTurn || hookShapedTurn;
      const receiptQuery = outputCalibrationQuery({
        policyVersion: receipt.output_shaping_policy_version,
        provider: receipt.provider,
        model: receipt.model,
        regime: receipt.output_shaping_regime
      });
      const savedForReceipt = shapedThisTurn
        ? estimatePerTurnOutputSaved(
            receiptQuery ? calibrationResolver(receiptQuery) : unavailableReduction,
            receipt.tokens?.output
          )
        : undefined;

      // THE LABEL DESCRIBES THE TURN, NOT THE SETTING. A `basic`-mode user must not read
      // `basic shaping` on a turn nothing shaped. Rules, in order:
      //  - `observe` + no shaping evidence → `apply off`, the one label an observe user has. It rests
      //    on the absence of evidence from both channels below, not on a proof of no mutation.
      //  - `observe` + the turn WAS shaped (the hook ignores `product_mode` — an open defect, D2) →
      //    OMIT. `apply off` would assert "no model-visible mutation" against evidence to the contrary,
      //    and `basic shaping` would contradict the mode the user chose. Silence claims neither.
      //  - otherwise → `basic shaping` only with per-turn evidence; OMIT when unproven, because the
      //    hook may have shaped upstream where the gateway cannot see it.
      //
      // THIS IS THIS SURFACE'S OWN RULE, not `openLineForTurn` (which `watch` and the Stop hook use
      // and which never emits `apply off`). Three differences, two deliberate and one not:
      //  1. DELIBERATE: `apply off` for observe is wording for a device reporting its OWN live turn.
      //  2. DELIBERATE: `hookShapedTurn` above ORs OVER an explicit `absent`, which `openLineForTurn`
      //     refuses. The two are not the same evidence. `outputShapingActiveOnRequest` reads
      //     INSTRUCTION-LEVEL CARRIERS ONLY, so a `UserPromptSubmit` hook that shapes the user message
      //     is invisible to it and lands a truthful `absent` on a genuinely shaped turn. Here the hook
      //     channel is a direct, same-device record of THIS turn, so it is the better evidence and
      //     wins. `watch` has no such per-turn channel — its session flag is resolved once per drain
      //     and handed to every receipt in it — so there the receipt's own state is authoritative and
      //     the session flag is a fallback for a legacy receipt only.
      //  3. NOT DELIBERATE: `gatewayShapedTurn` above omits `receiptProvenOpenLabel`'s second conjunct
      //     (`estimated_input_tokens_before === undefined`), so an input-apply receipt reaching a
      //     non-`full` tier here would take an Open label and lose its measured reduction. No such
      //     receipt exists on Open today. Keep the two rules in sync when either moves.
      const openTier: "observe" | "basic" | undefined =
        productTier === "observe" ? (shapedThisTurn ? undefined : "observe") : shapedThisTurn ? "basic" : undefined;

      // THE TURN'S OWN CEILING, from the receipt, ahead of the session-level one. `resolveOpenTier`
      // fires only at `remaining <= 0`; the receipt also records the `insufficient` case — allowance
      // left, but less than THIS turn needed — which session state structurally cannot express. Without
      // this read, that state (some allowance remaining but less than this turn needs) rendered on the one
      // surface a user reads with no explanation and no way to convert.
      const ceiling = receiptCeiling(receipt, env);
      // A NON-APPLY RECEIPT CARRIES NO POSTURE LABEL. On a full-tier device the fallback used to be the
      // OPEN builder with a hardcoded `"observe"`, which renders `apply off` — so any receipt that was
      // not a real apply announced that the product was off. Record-mode receipts interleave with the
      // apply receipts of one user task, so this line could oscillate
      // `full apply → apply off → full apply` while ONE task was running.
      //
      // `apply off` is the Open OBSERVE posture — the user's choice of no model-visible mutation — and is
      // now unreachable from the full tier. `full apply` stays reserved for proven private input apply, so the
      // fallback renders the turn's counts with no label at all: the device's posture across a task is a
      // run-level statement, not a per-call one. Per-call component activity stays in the
      // receipt/evidence layer (`watch`, `status`), where it belongs.
      const line =
        productTier === "full"
          ? (communityFullApplyReceiptLine(receipt, savedForReceipt, ceiling) ??
            (isRealApply(receipt)
              ? receiptLineFromGatewayReceipt(receipt, undefined, undefined, savedForReceipt, ceiling)
              : nonApplyReceiptLine(receipt, savedForReceipt, allowanceResetsOn, ceiling)))
          : receiptLineFromGatewayReceipt(receipt, openTier, allowanceResetsOn, savedForReceipt, ceiling);
      if (line) return line;
    }

    // No per-call receipt line above — none read, or nothing honest on the one read (a session with a
    // run boundary never reaches here) — so: the output-only fallback from the stdin counts. On this
    // hook-only path output shaping is the only apply lever, so the label reflects the ACTUAL turn:
    // `basic shaping` iff shaping was active this turn, else `apply off`.
    const outputTokens = outputTokensFromStdin(stdin);
    if (outputTokens !== undefined) {
      // The stdin count is provider-reported ONLY when the payload says so; default to local-estimate.
      const usage = stdin.usage as { provider_reported?: unknown } | undefined;
      const providerReported = usage?.provider_reported === true;
      // The installed/active hook is not evidence that THIS turn was shaped. Only the same-session
      // decision record may add the shaping label or estimated axis. With no record, retain the output
      // count without inventing a turn posture; an explicitly disabled install may still say apply off.
      const shapingActive = hookShapedTurn;
      const outputTier = shapingActive ? "basic" : isShapingHooksActivated(env) ? undefined : "observe";
      const line = receiptLineOutputOnly({
        outputTokens,
        providerReported,
        shapingActive,
        ...(outputTier ? { tier: outputTier } : {}),
        ...(reduction ? { estimatedSaved: estimatePerTurnOutputSaved(reduction, outputTokens) } : {}),
        // Carried on this path too: a Community user at the ceiling gets the same explanation whether
        // or not a gateway receipt existed this turn.
        ...(allowanceResetsOn ? { allowanceResetsOn } : {})
      });
      if (line) return line;
    }

    return STATUS_LINE_PLACEHOLDER;
  } catch {
    // FAIL-OPEN: any unexpected error → the quiet placeholder (never throw, never crash Claude Code).
    return STATUS_LINE_PLACEHOLDER;
  }
}

async function readAllStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * DETECTION ONLY for a dead transparent-routing endpoint.
 *
 * The status line runs continuously inside Claude Code's render loop, so this call site is held to a
 * harder rail than the `UserPromptSubmit` repair: it NEVER waits for a gateway to come up, never
 * performs the identity handshake, and never blocks a turn. A refused reserved port makes it spawn a
 * replacement detached and return; a port that answers makes it do nothing at all.
 *
 * That is why it is safe without the handshake: it hands out no base URL and draws no conclusion
 * about who is listening. Authorisation lives where a URL is actually handed over - `ensure.ts` and
 * the waiting path of `routing-revival.ts` - and both authenticate before returning anything.
 *
 * An unrouted session costs one cheap slot-existence check and returns.
 */
async function detectDeadRoutingEndpoint(stdinRaw: string): Promise<void> {
  try {
    let cwd = process.cwd();
    try {
      const parsed = JSON.parse(stdinRaw) as { cwd?: unknown } | null;
      if (typeof parsed?.cwd === "string" && parsed.cwd.trim() !== "") cwd = parsed.cwd;
    } catch {
      /* any shape tolerated; fall back to this process's cwd */
    }
    const { hasRoutingSlotForCwd, reviveRoutingGatewayIfDown } = await import("../../core/gateway/routing-revival.js");
    if (!hasRoutingSlotForCwd(cwd)) return;
    await reviveRoutingGatewayIfDown(cwd, { wait: false });
  } catch {
    /* FAIL-OPEN: detection is a convenience; the invariant rests on the UserPromptSubmit repair. */
  }
}

export function registerStatuslineCommand(program: Command): void {
  program
    .command("statusline")
    .description(
      "Claude Code status-line command: prints the single content-free per-turn receipt line (the ONLY " +
        "per-turn visible surface for Claude Code). Reads the session JSON on stdin, shows the latest " +
        "gateway receipt's counts/labels. Content-free, fail-open, local-only. Installed by connecting Claude Code."
    )
    // Optional tool arg (default claude-code); only claude-code has a status-line surface today.
    .argument("[tool]", "The tool this status line is for (default: claude-code).", "claude-code")
    .action(async () => {
      // FAIL-OPEN by contract: this runs inside Claude Code's render loop. Never throw; always exit 0.
      try {
        const raw = await readAllStdin();
        const line = await computeStatusLine(raw);
        if (line) process.stdout.write(`${line}\n`);
        // AFTER the line is written, never before. This is detection only: it shortens the time
        // between a routing gateway dying and something noticing, and it must never add latency to
        // a render or hold the turn. See `detectDeadRoutingEndpoint`.
        await detectDeadRoutingEndpoint(raw);
      } catch {
        // Swallow everything - a status-line command must never break the host UI.
      }
    });
}
