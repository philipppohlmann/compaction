/**
 * Honest ready-screen metric for onboarding.
 *
 * The ready screen shows ONE status line about measured activity. It is derived ONLY from the
 * local, content-free activity receipts (via `buildActivityRows`), never a simulated or example
 * number. At first install there is no data, so the honest state is "unavailable until measured".
 *
 * Claim boundary:
 *  - Output is a MEASURED token COUNT at its own axis tier (provider-reported | local-estimate),
 *    never a savings/percentage/cost figure.
 *  - An input before→after delta is shown only when a real reshaping recorded BOTH counts.
 *  - With no receipts (or no receipts carrying a usable token axis) the state is `no-data`:
 *    the surface says "run a session to see your delta", nothing is invented.
 *
 * Pure: no IO, no chalk, no React. The caller reads the receipts and passes the built rows in.
 */
import type { ActivityRow } from "../../core/activity-view.js";
import { formatReceiptLine } from "../../core/gateway/receipt-line.js";
import type { ReadyToolKey } from "./model.js";

/** The activity surfaces that correspond to an onboarding tool (the ready screen only counts these). */
export const READY_METRIC_SURFACES = ["claude_code", "codex", "cursor", "cli"] as const;

/**
 * Per-turn receipt-line onboarding copy. It must describe EXACTLY what the runtime prints per turn, so
 * the examples are rendered from the SAME canonical
 * `formatReceiptLine` the runtime uses, they can never drift into an over-claim.
 *
 * Honest boundaries encoded here:
 *  - Claude Code / Codex print a per-turn line (input+output) ONLY on the Gateway route. An input `−NN%`
 *    before→after is a REAL apply reduction only; on an apply turn the value clause is the computed
 *    provider-priced cost reduction `−$X (est)`; output is never a reduction.
 *  - Cursor prints NO per-turn line, it is session-level only (no per-call route the vendor exposes).
 *  - No per-turn output-reduction %, ever.
 */
export const READY_PER_TURN_HEADER = "After each turn you'll see one content-free receipt line:";

/**
 * The header for a set where SOME enabled workflow prints a per-turn line and some do not. The promise
 * survives, scoped to the workflows the body then names; what it may not do is generalise over a set
 * that contains a workflow printing nothing.
 */
const READY_PER_TURN_HEADER_SOME =
  "After each turn you'll see one content-free receipt line from the workflows below that print one:";

/**
 * The header for a set with no unhedged per-turn line - a Cursor-only setup (Cursor has no display
 * channel at all), or a Codex-only one (its own body line is hedged on whether the build renders it).
 * A promise here is withdrawn or qualified by the very next line, so the block is LABELLED rather than
 * promised; the body states, per workflow, what is printed instead and where the counts do show up.
 */
const READY_PER_TURN_HEADER_NONE = "Per-turn receipt line - what this setup does and does not print:";

/** The canonical example for the Gateway APPLY route (Claude Code / Codex), rendered from the real formatter. */
export const READY_PER_TURN_EXAMPLE_GATEWAY = formatReceiptLine({
  inputBefore: 41210,
  inputAfter: 21876,
  outputTokens: 412,
  costReductionUsd: 0.14,
  shortReceiptId: "8f4c2f6e"
});

/** The canonical example for the hook-only route (Claude Code, no Gateway), rendered from the real formatter. */
export const READY_PER_TURN_EXAMPLE_HOOK_ONLY = formatReceiptLine({
  outputTokens: 412
});

/**
 * The honest per-turn description lines, exactly what prints, per tool. The GATEWAY example is scoped
 * to the route that actually produces it: `Codex (Gateway route)` used to ride this same line, which
 * attached an input `−NN%` and a `−$X` cost clause to Codex setups that have no Gateway route at all.
 * The route is named as the condition, never as the default.
 */
export const READY_PER_TURN_LINES = [
  READY_PER_TURN_HEADER,
  `  Claude Code (Gateway route):  ${READY_PER_TURN_EXAMPLE_GATEWAY}`,
  `  Claude Code (hook only, no Gateway):  ${READY_PER_TURN_EXAMPLE_HOOK_ONLY}`,
  `  Codex (hooks, no Gateway route):  ${READY_PER_TURN_EXAMPLE_HOOK_ONLY}`,
  "  Cursor: no inline line - Cursor has no channel to display one; see `compaction watch`.",
  "  Counts + labels + source + short receipt id only (never your prompt, code, or response).",
  "  Input reduction is shown only on the Gateway route; output is a count, never a per-turn reduction.",
  "  Silence it anytime with COMPACTION_RECEIPT_LINE=0 (receipts are still written)."
] as const;

/**
 * The Cursor per-turn line. CORRECTED 2026-08-04 against the Cursor app bundle, not assumption.
 *
 * The old copy blamed "no per-call route". The route gap is real but it is not what stops the line:
 * Cursor HAS a post-turn hook (`stop`), and its payload even carries the turn's input/output/cache
 * token counts. What it lacks is any way to SAY something - the whole `stop` response schema is
 * `{followup_message?}`, and that is submitted as a new user turn rather than displayed. So there is
 * no inline line because there is no display channel, and Cursor's numbers belong in `compaction
 * watch` / `status` instead.
 */
const READY_PER_TURN_CURSOR_LINE =
  "  Cursor: no inline line - Cursor has no channel to display one; see `compaction watch`. Session-level only (one instruction per session, not per turn); local-estimate counts only.";

/**
 * The Cursor line for a setup whose `sessionStart` hook is NOT confirmed on disk. The display-channel
 * half is a VENDOR fact and stays; the "one instruction per session" half is a claim about a hook, and
 * a hook that is not on disk attaches nothing.
 */
const READY_PER_TURN_CURSOR_NO_HOOK_LINE =
  "  Cursor: no inline line - Cursor has no channel to display one; see `compaction watch`. And this setup's Cursor session hook is NOT confirmed on disk, so nothing is attached to what the model sees; local-estimate counts only. Install it:  compaction hooks install --tool cursor";

/**
 * The Codex per-turn block for the setup THIS onboarding flow produces: a capture shim plus the native
 * `UserPromptSubmit` shaping hook and the `Stop` per-turn-line hook. That is NOT a Gateway route.
 *
 * The Gateway example line carries an input `−NN%` AND a `−$0.14 (list price)` cost clause, both of
 * which are real only for a request the local Gateway actually compacted. Printing it here attached a
 * reduction and a dollar figure to a setup that produces neither — so the hook-only shape (an output
 * COUNT, no reduction, no dollar figure) is what a connected Codex is shown, and the Gateway route is
 * named separately as the thing the user does NOT currently have.
 *
 * RENDERING IS UNPROVEN, DELIBERATELY SAID SO. `core/codex-turn-line-hook.ts` records that Codex's hook
 * schema ACCEPTS `systemMessage` and that only a live run proves it RENDERS it. "You'll see a line after
 * each turn" would be a claim this build cannot back; `compaction watch` is the surface that works
 * either way.
 */
const READY_PER_TURN_CODEX_LINES = [
  `  Codex (hook installed - if your Codex build displays it, one line per turn):  ${READY_PER_TURN_EXAMPLE_HOOK_ONLY}`,
  "  Codex: no input reduction and no cost figure from this setup - it installs hooks, not a Gateway route.",
  "  The Gateway route (a separate, explicit `compaction gateway run -- codex …`) is what adds an input before→after line.",
  // NOT "guaranteed either way". `compaction watch` reads Gateway receipts and shim-captured runs; an
  // INTERACTIVE codex session produces neither, so a blanket guarantee would move this PR's own defect
  // (a surface that stays empty for the workflow you just set up) one screen later.
  "  `compaction watch` shows Gateway-routed Codex turns; interactive sessions are not measured."
] as const;

/**
 * The Codex block for a setup whose hooks are NOT confirmed on disk — the install was refused, failed
 * its verify re-read, or never ran because shaping is switched off (`COMPACTION_SHAPING_HOOKS=0` /
 * `compaction stop`). The block above states the hook is installed; printing it in that state put a
 * claim about a hook that is not there directly beside the routing subsection that reads the real
 * state off disk, inside one screen.
 *
 * It says "not confirmed" rather than naming which entry is missing, because the confirmation is a
 * single re-read that requires BOTH of this setup's Codex entries; the caller cannot honestly say more.
 * The example receipt line is dropped entirely: with no hook there is no line to show an example of.
 */
const READY_PER_TURN_CODEX_NO_HOOK_LINES = [
  "  Codex: no per-turn receipt line - this setup's Codex hooks are NOT confirmed on disk (shaping is switched off, or the install did not verify).",
  "  Codex: no input reduction and no cost figure from this setup either - it installs hooks, not a Gateway route.",
  "  Install or retry them when you want them:  compaction hooks install --tool codex",
  "  `compaction watch` shows Gateway-routed Codex turns; interactive sessions are not measured."
] as const;
/** The content-free scope line: what a receipt line does (and does not) contain. */
const READY_PER_TURN_CONTENT_FREE_LINE =
  "  Counts + labels + source + short receipt id only (never your prompt, code, or response).";
/** The silence line: how to turn the receipt line off (receipts still written). */
const READY_PER_TURN_SILENCE_LINE =
  "  Silence it anytime with COMPACTION_RECEIPT_LINE=0 (receipts are still written).";

/**
 * Does this workflow have an UNHEDGED per-turn line - one the header may promise flatly? Only Claude
 * Code does, so the header is a function of the enabled set alone and the confirmed-hook axis does not
 * enter it. That axis still drives the BODY, which is where a hedge belongs.
 *
 *  - Claude Code: yes. Its line comes from the Gateway route or the `statusLine`; the hook-confirmation
 *    axis does not gate it, which is why its body copy is identical either way.
 *  - Codex: NO, even with its hooks confirmed. `core/codex-turn-line-hook.ts` records that the schema
 *    proves Codex ACCEPTS `systemMessage` and that only a live run proves it RENDERS it, so the body
 *    line is itself hedged ("if your Codex build displays it"). A flat promise above a hedge is the
 *    same header-denies-body defect this function exists to prevent.
 *  - Cursor: NEVER, whatever the hook state. The `stop` response schema is `{followup_message?}`, so
 *    there is no display channel to print into; installing the session hook does not create one.
 */
function printsPerTurnLine(tool: ReadyToolKey): boolean {
  return tool === "claude-code";
}

/**
 * The honest opening line for the enabled set as a whole: promise it only where it holds for every
 * enabled workflow, scope it where it holds for some, and label rather than promise where it holds for
 * none (including the empty set, which promises nothing).
 */
function readyPerTurnHeader(enabledToolKeys: readonly ReadyToolKey[]): string {
  const printing = enabledToolKeys.filter((tool) => printsPerTurnLine(tool));
  if (printing.length === 0) return READY_PER_TURN_HEADER_NONE;
  return printing.length === enabledToolKeys.length ? READY_PER_TURN_HEADER : READY_PER_TURN_HEADER_SOME;
}

/**
 * The tool-scoped per-turn receipt-line copy: shows ONLY the enabled tools' example line(s), so
 * enabling one tool no longer prints every tool's variant. The example strings still come from the
 * real `formatReceiptLine` (via the exported constants), so they can never drift into an over-claim.
 * Boundaries preserved:
 *  - Claude Code (Gateway route + hook-only): input reduction is provider-cache/before→after, never output.
 *  - Codex (Gateway route): a per-turn line only on the Gateway route.
 *  - Cursor: NO per-turn line (session-level only; no per-call route the vendor exposes).
 *  - Content-free scope + the COMPACTION_RECEIPT_LINE=0 silence line always close the block.
 * The dropped "Input reduction is shown only on the Gateway route…" meta line is not needed once the
 * block is scoped to the enabled tool(s); the per-example labels already carry that boundary.
 *
 * `shapingHooksInstalled` is the set whose native hooks are CONFIRMED on disk (the caller re-reads the
 * tool's own config after the enable). Codex and Cursor each get their not-confirmed variant when they
 * are absent from it, so this block can never claim a hook the routing subsection beside it denies.
 * The default is EMPTY on purpose: a caller that cannot confirm must understate, never claim. Claude
 * Code's lines describe the Gateway/hook-only ROUTES and are unaffected by this axis.
 *
 * The HEADER is resolved from the ENABLED SET ALONE (see `readyPerTurnHeader`), so it can never promise
 * a per-turn line that a body line below it then denies or hedges. It deliberately does not read
 * `shapingHooksInstalled`: the only body line that promises a per-turn line without a hedge is Claude
 * Code's, and that axis does not gate it.
 */
export function readyPerTurnLinesForTools(
  enabledToolKeys: readonly ReadyToolKey[],
  shapingHooksInstalled: readonly ReadyToolKey[] = []
): string[] {
  const lines: string[] = [readyPerTurnHeader(enabledToolKeys)];
  if (enabledToolKeys.includes("claude-code")) {
    lines.push(`  Claude Code (Gateway route):  ${READY_PER_TURN_EXAMPLE_GATEWAY}`);
    lines.push(`  Claude Code (hook only, no Gateway):  ${READY_PER_TURN_EXAMPLE_HOOK_ONLY}`);
  }
  if (enabledToolKeys.includes("codex")) {
    lines.push(...(shapingHooksInstalled.includes("codex") ? READY_PER_TURN_CODEX_LINES : READY_PER_TURN_CODEX_NO_HOOK_LINES));
  }
  if (enabledToolKeys.includes("cursor")) {
    lines.push(shapingHooksInstalled.includes("cursor") ? READY_PER_TURN_CURSOR_LINE : READY_PER_TURN_CURSOR_NO_HOOK_LINE);
  }
  lines.push(READY_PER_TURN_CONTENT_FREE_LINE);
  lines.push(READY_PER_TURN_SILENCE_LINE);
  return lines;
}

/**
 * The resolved ready-screen metric state.
 *  - `no-data` - no measured receipt yet (first install / no session). The honest default.
 *  - `measured` - at least one receipt with a usable token axis; carries the newest measured line.
 */
export interface ReadyMetric {
  state: "no-data" | "measured";
  /**
   * The honest one-line summary. For `no-data` this is the "unavailable until measured" prompt;
   * for `measured` it is a content-free measured line (output token count at its tier, and an
   * input before→after delta only when a real reshaping recorded both counts). Never a savings
   * percentage, cost, or projection.
   */
  line: string;
  /** The measured axis tier of the newest usable receipt, when `measured` (else undefined). */
  tokenSource?: string;
  /** How many recorded runs the metric considered (content-free count). */
  recordedRuns: number;
}

/** The honest first-run line: there is no data yet, so no delta is shown - only how to produce one. */
export const READY_METRIC_NO_DATA_LINE =
  "Delta: unavailable until measured - run a session (e.g. `claude`) and it appears in `compaction activity`.";

/** True iff the row carries a usable, non-unavailable token axis we can honestly report a count from. */
function rowHasMeasuredAxis(row: ActivityRow): boolean {
  const outputMeasured = row.output_tokens !== null;
  const inputMeasured = row.input_before !== null;
  return outputMeasured || inputMeasured;
}

/**
 * The content-free measured line for one row: the output token COUNT at its tier and/or the input
 * before→after delta when both counts are present. No savings %, cost, or projection is ever added.
 */
function measuredLineFor(row: ActivityRow): string {
  const parts: string[] = [];
  if (row.input_before !== null && row.input_after !== null) {
    parts.push(`input ${row.input_before}→${row.input_after} (${row.input_source})`);
  } else if (row.input_before !== null) {
    parts.push(`input ${row.input_before} measured (${row.input_source})`);
  }
  if (row.output_tokens !== null) {
    parts.push(`output ${row.output_tokens} measured (${row.output_source})`);
  }
  const body = parts.length > 0 ? parts.join(" · ") : "measured (no usable token axis)";
  return `Last measured run: ${body}. See all runs: \`compaction activity\`.`;
}

/**
 * Derive the honest ready-screen metric from the built activity rows (already newest-first via
 * `buildActivityRows`). With no usable receipt the state is `no-data` and the honest unavailable
 * line is returned; never a simulated number. Pure.
 */
export function deriveReadyMetric(rows: readonly ActivityRow[]): ReadyMetric {
  const newestMeasured = rows.find(rowHasMeasuredAxis);
  if (!newestMeasured) {
    return { state: "no-data", line: READY_METRIC_NO_DATA_LINE, recordedRuns: rows.length };
  }
  return {
    state: "measured",
    line: measuredLineFor(newestMeasured),
    tokenSource: newestMeasured.output_tokens !== null ? newestMeasured.output_source : newestMeasured.input_source,
    recordedRuns: rows.length
  };
}
