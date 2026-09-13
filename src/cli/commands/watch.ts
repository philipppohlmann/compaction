/**
 * `compaction watch` - the universal LIVE per-turn receipt feed (PUBLIC CLI, engine-free).
 *
 * Tails TWO local stores and prints each NEW turn as the SINGLE canonical content-free line the moment
 * it lands (live, until Ctrl-C):
 *
 *  1. `<cwd>/.compaction/gateway/receipts.jsonl` - anything routed through the local Gateway
 *     (Claude Code AND Codex). The Claude Code status line cannot do this (it is Claude Code-only) and
 *     the Codex interactive TUI cannot show it inline (upstream gap).
 *  2. `<cwd>/.compaction/activity/activity.jsonl` - settled interactive Codex Stop turns, exact
 *     Gateway-backed Claude Stop aggregates, positively reconciled hook-only Claude task-notification
 *     continuations, and shim-captured Cursor runs, rendered at their own honest tier.
 *
 * The two are rendered by their own formatters and MERGED. Cursor's current capture records a
 * local estimate (chars/4); `watch` never upgrades it to provider-reported and never prints a zero
 * for an axis that was not consumed by the current parser.
 *
 * WHAT DOES NOT APPEAR, and why the headers say so. Only the MEASURABLE forms are recorded: a
 * Gateway-routed run, an interactive Codex turn settled by its Stop hook, a positively reconciled
 * hook-only Claude task-notification continuation, or a shim-captured batch invocation
 * (`codex exec --json`, `cursor-agent … --output-format json`). A Cursor IDE session still
 * produces neither a receipt nor an activity record. Legacy Codex shim events remain excluded; the
 * exact Codex Stop event suppresses gateway micro-call duplicates by session hash + run interval.
 *
 * `--once` is the SNAPSHOT mode: print the last N receipt lines (default 10) and EXIT instead of
 * following. This is the "show me the last few receipts" a plain `watch --all | tail` cannot give
 * (following never ends, so the pipe hangs). `--once --all` prints every receipt (no tail) and exits.
 *
 * Posture: content-free (only counts/labels/source/short id ever print), honors the
 * `COMPACTION_RECEIPT_LINE=0` kill switch, waits for the file if it does not exist yet, prints only
 * entries appended AFTER start (or replays existing with `--all`), and exits cleanly on Ctrl-C. Uses
 * `fs.watch` with a polling fallback (fs.watch is unreliable on some platforms). Local file I/O only,
 * no network, no new dependency.
 */
import { open, readFile, stat } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import path from "node:path";
import { Command } from "commander";
import chalk from "chalk";
import {
  DEFAULT_GATEWAY_RECEIPTS_DIR,
  GATEWAY_RECEIPTS_FILE,
  type GatewayReceipt
} from "../../core/gateway/receipt.js";
import {
  upgradeNoticeLines,
  isReceiptLineEnabled,
  receiptCeiling,
  receiptLineFromGatewayReceipt,
  openLineForTurn,
  outputShapingActiveForTurn,
  isRealApply,
  communityFullApplyReceiptLine,
  type OpenLineRendering
} from "../../core/gateway/receipt-line.js";
import { allowancePauseIsCurrent } from "../../core/entitlement/lease-store.js";
import {
  activityTurnLinesFromJsonl,
  codexStopRunWindowsFromJsonl,
  gatewayReceiptCoveredByCodexStop,
  settledStopRunWindowsFromJsonl,
  mergeTurnLines,
  type CodexStopRunWindow,
  type OrderedTurnLine
} from "../../core/activity-receipt-line.js";
import { ACTIVITY_LOG_FILENAME, DEFAULT_ACTIVITY_DIRECTORY } from "../../core/activity-store.js";
import { resolveOpenTier, type ProductMode, type AllowancePauseScope } from "../../core/onboarding-preferences.js";
import type { AllowancePauseReason } from "../../core/upgrade-cta.js";
import {
  estimatePerTurnOutputSaved,
  loadOutputCalibrationResolver,
  type OutputCalibrationResolver
} from "../../core/output-shaping-savings.js";
import { outputCalibrationQuery } from "../../core/output-shaping-calibration-store.js";
import { lastTurnWasShaped } from "../../core/output-shaping-turn-state.js";
import type { ShapingTurnScope } from "../../core/output-shaping-turn-state.js";
import { codexUserRunForReceipt } from "../../core/gateway/run-boundary.js";

/**
 * What `watch` needs to render the SAME line the status line renders: the product tier and the
 * calibrated reduction rate.
 *
 * TIER IS NOT NARROWED TO Open. An earlier version discarded `full`,
 * which routed a real Community apply past `communityFullApplyReceiptLine` and stripped its
 * `full apply` label. The full tier is carried through and the builder is chosen per receipt, exactly
 * as the status line does. It selects the BUILDER only — the Open tier label is derived per receipt
 * (see `receiptLinesFromJsonl`).
 *
 * `env` is threaded from `deps.env` rather than read from `process.env`, so a test (or any caller with
 * an injected config dir) resolves its OWN state.
 */
async function watchRenderContext(env: NodeJS.ProcessEnv): Promise<WatchRenderContext> {
  try {
    const { tier } = await resolveOpenTier(env);
    const calibrationResolver = await loadOutputCalibrationResolver(env);
    return { productTier: tier, calibrationResolver, env };
  } catch {
    return { env };
  }
}

/** Parse one JSONL line into a receipt (or undefined if blank / malformed / not a receipt). Never throws. */
function parseReceiptLine(line: string): GatewayReceipt | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as GatewayReceipt;
    return typeof parsed?.receipt_id === "string" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Render the canonical lines for a batch of raw JSONL text (only the lines that parse to a receipt AND
 * carry something honest to print). Pure + content-free: reuses the SAME formatter every surface uses,
 * so `watch` can never render anything the gateway log / status line would not. Never throws.
 */
export interface WatchRenderContext {
  /**
   * The device's CURRENT product tier. It selects the BUILDER only — `full` routes a receipt proving a
   * successful stored-policy private LCM apply to the community builder — and never the Open tier LABEL, which comes from the receipt or
   * from this batch's shaped-evidence. A current setting may decide how much of a receipt we are
   * equipped to render; it may not decide what a past turn is called.
   */
  productTier?: ProductMode;
  /** The calibrated reduction RATE. The per-turn count is derived from each receipt's own output. */
  calibrationResolver?: OutputCalibrationResolver;
  /**
   * Whether THIS batch of receipts may carry the estimated-output arrow.
   *
   * FALSE for anything HISTORICAL. `lastTurnWasShaped` describes the
   * most recent turn, and stamping it onto a replayed receipt from three days ago describes that turn
   * as something it was not — the same reason the ceiling clause is kept off historical lines and said
   * once above them instead. Resolved per DRAIN on the live path, never once per session: freezing it
   * at startup suppressed the arrow on every later shaped turn, or decorated every later held one.
   */
  shapedEvidence?: boolean;
  /**
   * Environment used to resolve the Pro destination on a paused turn's CTA. Carried on the context so
   * a test can point the link at a staging origin; production passes the real `process.env`.
   */
  env?: NodeJS.ProcessEnv;
}

export function receiptLinesFromJsonl(rawChunk: string, context?: WatchRenderContext): string[] {
  return receiptTurnLinesFromJsonl(rawChunk, context).map((t) => t.line);
}

/**
 * The same rendering, each line carrying the receipt's OWN recorded timestamp (`captured_at`) so a
 * merged feed can sort by real time. An unparseable `captured_at` yields no timestamp rather than a
 * substitute — a receipt whose clock we cannot read is undated, not "now".
 */
export function receiptTurnLinesFromJsonl(
  rawChunk: string,
  context?: WatchRenderContext,
  codexStopWindows: readonly CodexStopRunWindow[] = [],
  codexRunEnv?: NodeJS.ProcessEnv
): OrderedTurnLine[] {
  const out: OrderedTurnLine[] = [];
  for (const line of rawChunk.split("\n")) {
    const receipt = parseReceiptLine(line);
    if (!receipt) continue;
    if (gatewayReceiptCoveredByCodexStop(receipt, codexStopWindows)) continue;
    // A workflow=codex request is positively identifiable before Stop because UserPromptSubmit wrote
    // a bounded run record carrying the hashed turn identity and the Gateway receipt carries the exact
    // hashed session identity. Withhold that micro-call rather than emit a result that cannot later be
    // retracted; the codex-stop activity event is the one authoritative final line. No timer/buffer or
    // guessed workflow is involved. Claude runs have no turn hash and uncorrelated receipts have no
    // run, so every other workflow keeps its existing live behavior. If Stop never settles, silence is
    // the fail-closed outcome and the receipt remains durable in its ledger.
    if (codexRunEnv && codexUserRunForReceipt(receipt, codexRunEnv)) continue;
    // Recorded `output_shaping_state` proves whether the final model-visible request was shaped;
    // apply status and `applied_components` never infer shaping. Explicit receipt state outranks the
    // live fallback, while missing state may use the current live signal. A numeric counterfactual
    // requires exact applicable calibration; there is no generic prior.
    const shapedTurn = outputShapingActiveForTurn(receipt, context?.shapedEvidence === true);
    const query = outputCalibrationQuery({
      policyVersion: receipt.output_shaping_policy_version,
      provider: receipt.provider,
      model: receipt.model,
      regime: receipt.output_shaping_regime
    });
    // Proven shaping owns the counterfactual axis even when exact applicability metadata or the
    // resolver is unavailable. In that case the before and percentage are explicitly N/A; dropping to
    // the plain count would make the same shaped receipt indistinguishable from an unshaped one and
    // disagree with the gateway/statusline renderers. Only a turn not proven shaped stays plain.
    const estimatedSaved =
      shapedTurn && context?.calibrationResolver && query
        ? estimatePerTurnOutputSaved(context.calibrationResolver(query), receipt.tokens?.output)
        : shapedTurn
          ? { calibrated: false, state: "unseeded" as const }
          : undefined;

    // THE LABEL DESCRIBES THE TURN, NOT TODAY'S SETTING. It used to be the device's CURRENT product
    // mode, so flipping `compaction mode` retroactively relabelled turns that were never produced
    // under it — the same replayed receipt read `apply off` or `basic shaping` depending on a setting
    // changed days later, and a turn the gateway had genuinely shaped read `apply off` outright.
    //
    // Two things may name a label, in strength order, and neither is a preference: the RECEIPT
    // itself, then — on the LIVE path only — this batch's own shaped-evidence, which is the same
    // evidence the adjacent output arrow uses. Historical replays never receive it (see
    // `WatchRenderContext.shapedEvidence`). Anything else is left unlabelled rather than guessed.
    // `openLineForTurn` holds that rule for every surface, so it cannot drift between them.
    const openLine: OpenLineRendering = openLineForTurn(receipt, context?.shapedEvidence === true);

    // Builder choice is separate from output-estimate eligibility. A proven private Full receipt on a
    // full-tier device takes the Community builder; a public deterministic or explicit apply takes the generic apply builder so its
    // measured input before→after survives without acquiring a `full apply` label. Non-apply turns use
    // the honest Open line. `isRealApply` decides only this dispatch — `shapedTurn` above remains the
    // sole gate for an output counterfactual.
    // THE CEILING RIDES THE LINE HERE, unlike the session-state notice in the header above — and the
    // distinction is the whole reason both exist. The header states TODAY's allowance state, which is
    // false about a turn recorded before the allowance ran out. This ceiling is read off THE RECEIPT:
    // it records that THAT turn was refused for allowance, which stays true on replay however the
    // device is configured now. Replay agreeing with the per-turn line the user saw live is exactly
    // what makes `watch` checkable against it.
    const ceiling = receiptCeiling(receipt, context?.env ?? process.env);
    const rendered =
      context?.productTier === "full"
        ? (communityFullApplyReceiptLine(receipt, estimatedSaved, ceiling) ??
          (isRealApply(receipt)
            ? receiptLineFromGatewayReceipt(receipt, undefined, undefined, estimatedSaved, ceiling)
            : receiptLineFromGatewayReceipt(receipt, openLine, undefined, estimatedSaved, ceiling)))
        : isRealApply(receipt)
          ? receiptLineFromGatewayReceipt(receipt, undefined, undefined, estimatedSaved, ceiling)
          : receiptLineFromGatewayReceipt(receipt, openLine, undefined, estimatedSaved, ceiling);
    if (rendered) {
      const at = Date.parse(receipt.captured_at ?? "");
      out.push({ line: rendered, ...(Number.isFinite(at) ? { recordedAt: at } : {}) });
    }
  }
  return out;
}

/**
 * The ceiling notice for a `watch` header, or no lines at all.
 *
 * SHARED by the live and `--once` headers on purpose: both are session-state surfaces over the same
 * receipts, and a user checking a snapshot at the ceiling must learn the same fact as one following
 * the live feed. Two copies would drift into exactly that inconsistency.
 *
 * The notice rides the HEADER rather than each rendered line: `watch` replays historical receipts,
 * and a turn recorded before the allowance ran out was not refused for allowance. Session state is
 * said once, above the lines.
 */
async function ceilingNoticeLines(env: NodeJS.ProcessEnv, cwd: string): Promise<string[]> {
  const notice = await allowanceNoticeInput(env, cwd);
  if (!notice) return [];
  return upgradeNoticeLines({ ...notice, env }).map((line) => (line === "" ? "" : chalk.yellow(line)));
}

/**
 * The one honest sentence naming BOTH sources. Shared by the live and `--once` headers, because a user
 * checking a snapshot must learn the same thing as one following the feed - and because a Cursor user
 * needs to know their counts are a local estimate BEFORE reading a number.
 */
export const WATCH_SOURCES_LINE =
  "Live per-turn lines from the local Gateway, settled Codex Stop turns, exact Gateway-backed Claude Stop aggregates, positively reconciled hook-only Claude task-notification continuations, AND local activity records (Cursor runs captured by the shim: `cursor-agent … --output-format json`).";
export const WATCH_TIER_LINE =
  "Counts print at the tier they were recorded at: Cursor is local-estimate only because Compaction's current Cursor parser does not consume the vendor's per-turn usage; watch never upgrades it to provider-reported.";
/**
 * WHAT THIS FEED CANNOT SHOW, said in the header rather than discovered by watching an empty screen.
 * Codex's PATH shim (`core/tool-shim.ts`, `kind: "gateway-route"`) routes EVERY normal invocation -
 * interactive included - through the local Gateway once connected, so those settle after Stop the same
 * as any other Gateway-routed run; the ONE exception is a run where Compaction detects the user's own
 * route already declared (env, argv, `~/.codex/config.toml`, or an OpenAI API key) - that run falls
 * back to the legacy shim-captured batch form (`codex exec --json`) ONLY and is otherwise unmeasured.
 * Claude Code settles exact Gateway-backed runs and positively reconciled hook-only task-notification
 * continuations. A Cursor IDE session writes no activity record at all.
 */
export const WATCH_SCOPE_LINE =
  "Normal Codex invocations route through the local Gateway once connected unless your own model-provider route or an API key is detected; only observed settled Stop/Gateway evidence is shown, and requests without it are not inferred as measured. Claude Code settles exact Gateway-backed runs and positively reconciled hook-only task-notification continuations. Cursor IDE sessions are not measured.";

/** The content-free header printed once at the top of a `watch` session. */
export async function watchHeaderLines(
  replayAll: boolean,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd()
): Promise<string[]> {
  return [
    chalk.cyan("compaction watch"),
    WATCH_SOURCES_LINE,
    chalk.gray(WATCH_SCOPE_LINE),
    chalk.gray(WATCH_TIER_LINE),
    chalk.gray(
      "Content-free: counts, labels, source, and a short receipt id only - never a prompt, path, or response."
    ),
    ...(await ceilingNoticeLines(env, cwd)),
    chalk.gray(replayAll ? "Replaying existing turns, then following new ones. Ctrl-C to stop." : "Following new turns. Ctrl-C to stop.")
  ];
}

/**
 * The last N canonical per-turn receipt lines for the local Gateway receipts store under `cwd`, newest
 * last (chronological, matching `watch`), rendered through the SAME `receiptLinesFromJsonl` →
 * `receiptLineFromGatewayReceipt` formatter every surface uses (no duplicate formatting). Used by
 * `compaction status`'s "Last turns" section. Content-free + READ-ONLY; honors the
 * `COMPACTION_RECEIPT_LINE=0` kill switch (returns `{ killSwitch: true }`, no lines); a missing/empty
 * store returns an empty `lines` array (the caller renders "no turns recorded yet"). Never throws.
 */
export async function lastReceiptLines(
  count: number,
  deps: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
): Promise<{ lines: string[]; killSwitch: boolean }> {
  const cwd = deps.cwd ?? process.cwd();
  const env = deps.env ?? process.env;
  if (!isReceiptLineEnabled(env)) return { lines: [], killSwitch: true };
  // MERGE-SORTED, never concatenated: the tail slice below picks the NEWEST lines, so the two stores
  // have to be in one time order first (see `mergeTurnLines` for the rule and why an undated record
  // may not take the newest slot).
  const activityRaw = await readFileOrEmpty(activityLogFile(cwd));
  const rendered = mergeTurnLines(
    receiptTurnLinesFromJsonl(
      await readFileOrEmpty(gatewayReceiptsFile(cwd)),
      await watchRenderContext(env),
      settledStopRunWindowsFromJsonl(activityRaw),
      env
    ),
    activityTurnLinesFromJsonl(activityRaw)
  );
  const n = Number.isFinite(count) && count > 0 ? Math.trunc(count) : 1;
  return { lines: rendered.slice(-n), killSwitch: false };
}

/**
 * The allowance pause recorded on the MOST RECENT gateway turn, or undefined when the newest turn ran
 * unimpeded (or there are no turns).
 *
 * WHY THE RECEIPT AND NOT THE JOURNAL. `insufficient` is not a property of the period — it is a
 * property of ONE turn measured against what was left. A period-level surface reading only the
 * journal sees a positive remainder and reports a healthy
 * allowance, which is how `compaction usage` came to show a comfortable number to a user whose every
 * turn was being paused. The receipt is where that turn recorded what happened to it, so it is the
 * only honest source, and it stays honest on replay.
 *
 * SCOPED TO THE NEWEST TURN DELIBERATELY: an older paused turn says nothing about now (the allowance
 * may have reset, or the turns may have got smaller), and a stale ceiling is exactly the kind of
 * false claim these surfaces exist to avoid. READ-ONLY, content-free, never throws.
 */
export async function lastTurnAllowancePause(
  deps: { cwd?: string; env?: NodeJS.ProcessEnv; now?: Date } = {}
): Promise<NonNullable<GatewayReceipt["allowance_pause"]> | undefined> {
  const cwd = deps.cwd ?? process.cwd();
  const raw = await readTailOrEmpty(gatewayReceiptsFile(cwd));
  let newest: GatewayReceipt | undefined;
  for (const line of raw.split("\n")) {
    const receipt = parseReceiptLine(line);
    if (receipt) newest = receipt;
  }
  const pause = newest?.allowance_pause;
  if (pause === undefined) return undefined;
  return allowancePauseIsCurrent(pause, deps.env ?? process.env, deps.now ?? new Date()) ? pause : undefined;
}


/**
 * The TAIL of a file as text, or "" when it does not exist. Never throws.
 *
 * A WHOLE-FILE READ IS NOT AVAILABLE HERE. The receipts store is append-only and unbounded — a
 * dogfooding project in this repo reached 31 MB — and this read sits in the HEADER path of `watch`,
 * ahead of the first line the user sees. Reading it whole to answer a question about the LAST entry
 * delayed the feed by hundreds of milliseconds on that store and would grow without limit.
 *
 * The window GROWS rather than being a single guess: a tail that lands mid-record parses to nothing,
 * and returning "no pause" from a store that records one would be a false clear. It doubles up to
 * `TAIL_MAX_BYTES` (or the whole file, whichever is smaller), which is bounded work on any store.
 */
async function readTailOrEmpty(file: string): Promise<string> {
  const TAIL_START_BYTES = 64 * 1024;
  const TAIL_MAX_BYTES = 4 * 1024 * 1024;
  let handle;
  try {
    handle = await open(file, "r");
    const size = (await handle.stat()).size;
    for (let window = TAIL_START_BYTES; ; window *= 2) {
      const length = Math.min(window, size);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, size - length);
      const text = buffer.toString("utf8");
      // A complete record was found, or we are reading from byte 0 and there is nothing more to find.
      if (length >= size || text.split("\n").some((line) => parseReceiptLine(line) !== undefined)) return text;
      if (window >= TAIL_MAX_BYTES) return text;
    }
  } catch {
    return "";
  } finally {
    await handle?.close();
  }
}

/**
 * The ceiling notice the STATE surfaces (`watch` header, `compaction status`) should print, or
 * undefined when nothing is paused.
 *
 * TWO SOURCES, IN ORDER OF STRENGTH:
 *  1. `resolveOpenTier` — session state, derived from the signed lease + the local journal. Fires on
 *     `remaining <= 0` only, so the one reason it can express is `exhausted`. Preferred when present:
 *     it is a statement about the PERIOD, true of the next turn as much as the last one.
 *  2. the newest turn's recorded pause — the only source that can express `insufficient`, because
 *     `insufficient` is not a property of the period at all but of one turn measured against what was
 *     left. Source (1) reads that same period as healthy.
 *
 * Without (2) these surfaces were silent for every user whose allowance was merely too small rather
 * than gone — measured: a `watch` header and a `status` block that said nothing at all while every
 * turn under them rendered `input paused`. NEWEST TURN ONLY: an older pause says nothing about now.
 */
export async function allowanceNoticeInput(
  env: NodeJS.ProcessEnv,
  cwd: string = process.cwd()
): Promise<{ reason: AllowancePauseReason; resetsOn?: string; scope?: AllowancePauseScope } | undefined> {
  const { allowanceResetsOn, allowancePauseScope } = await resolveOpenTier(env);
  if (allowanceResetsOn) {
    return {
      reason: "exhausted",
      resetsOn: allowanceResetsOn,
      ...(allowancePauseScope !== undefined ? { scope: allowancePauseScope } : {})
    };
  }
  const pause = await lastTurnAllowancePause({ cwd, env });
  if (!pause) return undefined;
  return {
    reason: pause.reason,
    ...(pause.resets_on !== undefined ? { resetsOn: pause.resets_on } : {}),
    ...(pause.scope !== undefined ? { scope: pause.scope } : {})
  };
}

/** The content-free header printed once at the top of a `watch --once` snapshot. */
export async function watchOnceHeaderLines(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): Promise<string[]> {
  return [
    chalk.cyan("compaction watch --once"),
    `Snapshot. ${WATCH_SOURCES_LINE}`,
    chalk.gray(WATCH_SCOPE_LINE),
    chalk.gray(WATCH_TIER_LINE),
    chalk.gray(
      "Content-free: counts, labels, source, and a short receipt id only - never a prompt, path, or response."
    ),
    ...(await ceilingNoticeLines(env, cwd))
  ];
}

export interface WatchDeps {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  print?: (line: string) => void;
  /** Poll interval for the fallback loop (ms). */
  pollMs?: number;
  /**
   * WHOSE turn `watch` should read shaping evidence for. There is no default and no fallback: `watch` is
   * a side pane, not a hook, so it is handed no tool session identifier and cannot name the turn on
   * screen. Left undefined it fails closed — receipt lines render without the output arrow rather than
   * borrowing whichever session happened to record last. Injectable so a caller that DOES know the
   * session (and the tests that exercise this loop) can supply it.
   */
  shapingScope?: ShapingTurnScope;
}

interface WatchOptions {
  all?: boolean;
  /** Snapshot mode: print the last N receipt lines and exit instead of following. */
  once?: boolean;
  /** How many lines `--once` shows (default 10); ignored when `--all` is also set (prints all). */
  lines?: number;
}

/** The default number of receipt lines `--once` prints when neither `-n` nor `--all` is given. */
export const WATCH_ONCE_DEFAULT_LINES = 10;

/** The local Gateway receipts store under `cwd`. */
function gatewayReceiptsFile(cwd: string): string {
  return path.join(cwd, DEFAULT_GATEWAY_RECEIPTS_DIR, GATEWAY_RECEIPTS_FILE);
}

/** The local activity store under `cwd` - where the non-gateway surfaces (Cursor, captured Codex) land. */
function activityLogFile(cwd: string): string {
  return path.join(cwd, DEFAULT_ACTIVITY_DIRECTORY, ACTIVITY_LOG_FILENAME);
}

/** Read a whole file, or "" when it does not exist yet. Never throws. */
async function readFileOrEmpty(file: string): Promise<string> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return "";
  }
}

/** Read newly-appended bytes from `fromOffset` to EOF, returning the text + the new offset. Never throws. */
async function readFrom(file: string, fromOffset: number): Promise<{ text: string; nextOffset: number }> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const info = await stat(file);
    // Truncation / rotation: the file shrank - re-read from the start.
    const start = info.size < fromOffset ? 0 : fromOffset;
    if (info.size <= start) return { text: "", nextOffset: info.size };
    const length = info.size - start;
    handle = await open(file, "r");
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    return { text: buffer.toString("utf8"), nextOffset: info.size };
  } catch {
    return { text: "", nextOffset: fromOffset };
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * SNAPSHOT mode (`--once`): read the whole receipts store, render the canonical content-free lines, print
 * the LAST N (default 10; ALL when `options.all`), then RETURN (no follow, no watchers). This is the
 * "show me the last few receipts" a `watch --all | tail` cannot do (following never ends). Honors the
 * `COMPACTION_RECEIPT_LINE=0` kill switch and is content-free + read-only. Never throws out.
 */
export async function runWatchOnce(options: WatchOptions, deps: WatchDeps = {}): Promise<void> {
  const cwd = deps.cwd ?? process.cwd();
  const env = deps.env ?? process.env;
  const print = deps.print ?? ((line: string) => console.log(line));

  for (const line of await watchOnceHeaderLines(env, cwd)) print(line);

  if (!isReceiptLineEnabled(env)) {
    print(chalk.gray("COMPACTION_RECEIPT_LINE is set to off - no lines will be shown (kill switch)."));
    return;
  }

  // BOTH stores. The activity half is what makes this command true for Cursor (and for a captured
  // Codex run): those turns never produce a gateway receipt, so a gateway-only snapshot is empty for
  // them no matter how many turns the user has run.
  const activityRaw = await readFileOrEmpty(activityLogFile(cwd));
  // `--all` is the explicit physical diagnostic replay: retain its existing micro-receipt view.
  // The ordinary snapshot is the product surface and uses the exact settled Claude/Codex windows.
  const settledWindows = options.all === true
    ? codexStopRunWindowsFromJsonl(activityRaw)
    : settledStopRunWindowsFromJsonl(activityRaw);
  const rendered = mergeTurnLines(
    receiptTurnLinesFromJsonl(
      await readFileOrEmpty(gatewayReceiptsFile(cwd)),
      await watchRenderContext(env),
      settledWindows,
      env
    ),
    activityTurnLinesFromJsonl(activityRaw, { coalesceClaude: options.all !== true })
  );
  if (rendered.length === 0) {
    print(
      chalk.gray(
        "No turns recorded yet - a turn appears here after a Codex Stop, an exact Gateway-backed Claude Stop, " +
          "or a positively reconciled hook-only Claude task-notification continuation; when routed " +
          "through the Gateway (`compaction gateway run -- <your-command>`), or when captured as " +
          "`cursor-agent … --output-format json`."
      )
    );
    return;
  }

  // `--all` prints every receipt; otherwise the last N (default 10). A non-positive/NaN count falls back
  // to the default so a bad `-n` never prints nothing or the whole file by surprise.
  const requested = options.lines;
  const count = requested !== undefined && Number.isFinite(requested) && requested > 0 ? Math.trunc(requested) : WATCH_ONCE_DEFAULT_LINES;
  const slice = options.all === true ? rendered : rendered.slice(-count);
  for (const line of slice) print(line);
}

/**
 * Run the live watch loop until `signal` aborts. Prints the header, then each NEW receipt line as it
 * lands (or replays existing first when `options.all`). Resolves when aborted. Content-free; honors the
 * kill switch (then it only prints the header note and idles until abort). Never throws out.
 */
export async function runWatch(signal: AbortSignal, options: WatchOptions, deps: WatchDeps = {}): Promise<void> {
  const cwd = deps.cwd ?? process.cwd();
  const env = deps.env ?? process.env;
  const print = deps.print ?? ((line: string) => console.log(line));
  const pollMs = deps.pollMs ?? 500;
  const replayAll = options.all === true;

  // `deps.env` and `cwd` — NOT the process globals: the header's ceiling notice must read the same
  // environment AND the same receipts store every other decision in this command reads, or an injected
  // `COMPACTION_CONFIG_DIR` resolves the tier against a different device than the receipts being
  // printed, and the pause is read off a different project's turns than the ones on screen.
  for (const line of await watchHeaderLines(replayAll, env, cwd)) print(line);

  if (!isReceiptLineEnabled(env)) {
    print(chalk.gray("COMPACTION_RECEIPT_LINE is set to off - no lines will be shown (kill switch)."));
    await waitForAbort(signal);
    return;
  }

  // TWO tailed stores, each with its OWN offset. A shared offset would be meaningless (the files grow
  // independently), and a single store would leave Cursor with no feed at all.
  const gatewayFile = gatewayReceiptsFile(cwd);
  const activityFile = activityLogFile(cwd);

  // Establish the starting offsets: 0 for --all (replay everything), else current EOF (only new).
  const startOffset = async (file: string): Promise<number> => {
    if (replayAll) return 0;
    try {
      return (await stat(file)).size;
    } catch {
      return 0; // file not created yet - start from the beginning once it appears
    }
  };
  let gatewayOffset = await startOffset(gatewayFile);
  let activityOffset = await startOffset(activityFile);
  let codexStopWindows = settledStopRunWindowsFromJsonl(await readTailOrEmpty(activityFile));

  // The RATE is loaded once: it changes only when `compaction savings` runs, so re-reading it per drain
  // would be file IO in the tail loop for a constant. The per-turn EVIDENCE is NOT loaded once — it is
  // re-resolved on every drain below, because freezing it at startup either suppressed the arrow on
  // every later shaped turn or decorated every later held one.
  const base = await watchRenderContext(env);

  // THE FIRST DRAIN UNDER `--all` IS THE WHOLE HISTORY. `replayAll` leaves the
  // offset at 0, so that drain replays every receipt in the file — and evidence about the CURRENT turn
  // must not be stamped across them. `--once` was already correct; this is the same rule for the follow
  // path. After the replay, drains carry only newly-appended receipts and evidence applies again.
  let replayPending = replayAll;

  let draining = false;
  const drain = async (): Promise<void> => {
    if (draining || signal.aborted) return;
    draining = true;
    try {
      const gateway = await readFrom(gatewayFile, gatewayOffset);
      gatewayOffset = gateway.nextOffset;
      const activity = await readFrom(activityFile, activityOffset);
      activityOffset = activity.nextOffset;
      for (const window of settledStopRunWindowsFromJsonl(activity.text)) {
        if (!codexStopWindows.some(
          (known) => known.sessionCorrelationId === window.sessionCorrelationId &&
            known.startedAt === window.startedAt && known.endedAt === window.endedAt
        )) codexStopWindows.push(window);
      }
      // Fresh evidence for THIS batch — these receipts are the turns that just happened. Except the
      // initial `--all` replay, which is history and gets none.
      const isHistoricalReplay = replayPending;
      replayPending = false;
      const context: WatchRenderContext = {
        ...base,
        shapedEvidence: isHistoricalReplay ? false : await lastTurnWasShaped(deps.shapingScope, env)
      };
      // Merged by the SAME rule as the snapshot path, so a drain that picks up both stores prints one
      // time-ordered batch rather than "all receipts, then all activity". The activity renderer takes
      // NO shaped-evidence context: those lines carry recorded counts at their recorded tier and
      // nothing derived from the current turn's state.
      for (const rendered of mergeTurnLines(
        receiptTurnLinesFromJsonl(gateway.text, context, codexStopWindows, env),
        activityTurnLinesFromJsonl(activity.text)
      )) {
        print(rendered);
      }
    } finally {
      draining = false;
    }
  };

  // Emit anything already present when replaying (or nothing when following a fresh EOF).
  await drain();

  // fs.watch on each store's DIRECTORY (a file may not exist yet); fall back to polling regardless, since
  // fs.watch delivery is unreliable across platforms/filesystems. Both just trigger a drain.
  const watchers: FSWatcher[] = [];
  for (const dir of new Set([path.dirname(gatewayFile), path.dirname(activityFile)])) {
    try {
      const watcher = watch(dir, { persistent: false }, () => void drain());
      // Exhausted or unavailable native watcher resources are non-fatal: the polling loop below is
      // already the authoritative fallback. Handle an asynchronous watcher failure as deliberately as
      // the synchronous `watch()` throw so it cannot escape as an uncaught process error.
      watcher.on("error", () => watcher.close());
      watchers.push(watcher);
    } catch {
      /* directory may not exist yet - polling covers it */
    }
  }

  const poll = setInterval(() => void drain(), pollMs);

  await waitForAbort(signal);
  clearInterval(poll);
  for (const w of watchers) w.close();
  // Final drain so a receipt that landed between the last tick and Ctrl-C is not lost.
  await drain();
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

export function registerWatchCommand(program: Command): void {
  program
    .command("watch")
    .description(
      "Live per-turn feed: tails the local Gateway receipts AND your local activity records, printing each " +
        "new content-free line as it lands (Gateway traffic, settled interactive Codex Stop turns, exact Gateway-backed " +
        "Claude Stop aggregates, positively reconciled hook-only Claude task-notification continuations, and shim-captured Cursor " +
        "runs at their own recorded tier). Ctrl-C to stop, or use --once for a snapshot. Content-free, " +
        "local-only, no network."
    )
    .option("--all", "Replay the existing receipts first, then follow new ones (default: only new).")
    .option("--once", "Snapshot: print the last N receipts (default 10) and exit instead of following.")
    .option(
      "-n, --lines <count>",
      "With --once, how many recent receipts to show (default 10; ignored when --all shows all).",
      (v: string) => Number.parseInt(v, 10)
    )
    .action(async (options: WatchOptions) => {
      // Snapshot mode exits immediately - no follow loop, no SIGINT handler needed.
      if (options.once === true) {
        await runWatchOnce(options);
        return;
      }
      const controller = new AbortController();
      const onSigint = (): void => controller.abort();
      process.once("SIGINT", onSigint);
      try {
        await runWatch(controller.signal, options);
      } finally {
        process.removeListener("SIGINT", onSigint);
      }
      // Clean exit on Ctrl-C.
      console.log(chalk.gray("\ncompaction watch stopped."));
    });
}
