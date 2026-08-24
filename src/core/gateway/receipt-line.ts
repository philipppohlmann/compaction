/**
 * The canonical per-turn receipt line (PUBLIC CLI/SDK core, engine-free).
 *
 * ONE content-free line, printed after a model turn on the surfaces that can do it truthfully
 * (gateway inline log; the Claude Code Stop hook). It carries ONLY counts, labels, a value estimate, and
 * the short receipt id, never a prompt, code, path, or response byte.
 *
 * Grammar (fields OMITTED when unavailable, never fabricated):
 *   compaction · [observed input N | input B→A (−PP%)] · output N · [<value-clause>] · [<tier-label>] ·
 *     [Community limit reached · input optimization paused[ until <YYYY-MM-DD>][ · output shaping
 *      continues] · Upgrade to Pro ↗] · id <8hex>
 *
 * TIER LABELS (open-core):
 *   - `apply off`      (Open observe)   — no model-visible mutation.
 *   - `basic shaping`  (Open basic)     — the ONE public deterministic output-shaping method.
 *   - `full apply`     (Community full) — private-engine adaptive apply; the label may ONLY ride a REAL
 *     full-apply receipt (a real input before→after). It is
 *     emitted ONLY from the community full-apply builder (never synthesized on an Open line).
 * Open lines carry the `observed input N` prefix (Open never compacts input, so it never shows a
 * before→after reduction). The `input B→A (−PP%)` reduction form is reserved for a REAL apply.
 *
 * Hard claim rules encoded here (do NOT relax without re-opening the design doc):
 *  - The input REDUCTION clause (`input 41,210→21,876 (−47%)`) appears ONLY for a REAL apply before→after
 *    (apply mode, request actually mutated) that already exists on the receipt. The `−PP%` reduction glyph
 *    appears ONLY here UNLABELED. An output percent exists too but ALWAYS carries an estimate label — `est.`
 *    when the rate is this device's own A/B, `est. · default prior` when it is the shipped starting prior
 *    (its before is reconstructed, not measured), and the tests pin that rather than pinning its absence. Never
 *    synthesized. Open shows `observed input N` (a plain count, no reduction). Provider prompt-cache is
 *    NOT surfaced on this line: it is a provider fact, not a Compaction reduction, and carrying it here
 *    invites the "Compaction reduced my tokens" misread.
 *  - `<value-clause>` is the cost clause, or OMITTED:
 *      · `−$0.14 (list price)` — the provider-PRICED cost reduction of the applied input compaction (the
 *        receipt's model-visible before→after delta × the published input price). COMPUTED, never
 *        hardcoded; OMITTED when pricing/model/usage is missing, and when the amount would round below
 *        one cent (never `−$0.00`). Labeled `(list price)` because the basis is the PUBLISHED rate — not
 *        an invoice, and not net of the provider's prompt cache.
 *  - OUTPUT carries the saving: `output 652→512 (−21%, est.)`. The AFTER is real
 *    provider-reported output; the BEFORE is DERIVED from the reduction rate, which is why it carries an
 *    estimate label and the input arrow does not. The label's exact form marks WHOSE evidence backs the
 *    rate: `est.` for this device's own A/B, `est. · default prior` for the shipped starting prior. With no
 *    rate at all it degrades to a plain `output N` — no arrow, no fabricated before. The percent is dropped
 *    when integer rounding would reach `−0%` or `−100%`, since either would contradict the pair shown.
 *  - The two are NOT mutually exclusive: an apply turn shows the input arrow, the output arrow, and the
 *    cost clause together.
 *  - Cursor emits NO per-turn line (handled by callers, never here) — but NOT for the reason this
 *    comment used to give. Corrected 2026-08-04 against the Cursor app bundle rather than assumption:
 *    Cursor DOES have a post-turn hook (`stop`), and its payload even carries `input_tokens` /
 *    `output_tokens` / `cache_read_tokens` / `cache_write_tokens` for the completed turn. What it has
 *    no channel for is SAYING anything: the entire `stop` response schema is `{followup_message?}`,
 *    and `followup_message` is submitted as a NEW USER TURN rather than displayed. There is no
 *    `systemMessage`/`userMessage`/`displayMessage` on that step, and a hard block from `stop` returns
 *    `{}`. So the conclusion stands and the mechanism is the opposite of what was written: the hook
 *    exists, the display channel does not. Cursor's per-turn numbers therefore reach the user through
 *    a RECEIPT (and so `compaction watch` / `status`), never an inline line inside Cursor.
 *
 * Kill switch: `COMPACTION_RECEIPT_LINE=0|false|off|no` silences the per-turn line everywhere. Receipts
 * are still written to `receipts.jsonl`; only this display line is suppressed. Mirrors the
 * `COMPACTION_SHAPING_HOOKS=0` kill-switch value set.
 */
import type { GatewayReceipt } from "./receipt.js";
import type { AllowancePauseScope } from "../onboarding-preferences.js";
import type { AllowancePauseReason } from "../upgrade-cta.js";
import { COMMUNITY_LIMIT_CLAUSE, upgradeCta, validResetsOn } from "../upgrade-cta.js";
import { applyInputCostReductionUsd } from "./api-cost-impact.js";
import { allowancePausePeriodStatus } from "../entitlement/lease-store.js";

/**
 * Prefix so the line is unmistakable in interleaved tool output — the one word every per-turn line
 * starts with, on EVERY surface. Exported so the non-gateway
 * (local activity) renderer starts its lines the same way instead of hardcoding a second copy — a feed
 * that mixes two spellings of the same product would read as two different tools.
 */
export const RECEIPT_LINE_PREFIX = "compaction";
const PREFIX = RECEIPT_LINE_PREFIX;

/** The env var that silences the per-turn line on every surface. */
export const RECEIPT_LINE_ENV = "COMPACTION_RECEIPT_LINE";

/**
 * PROVENANCE labels for the OUTPUT arrow's reconstructed reduction (G7, 2026-08-04). The output before is
 * always DERIVED from a rate (the unshaped turn was never generated), so an output arrow is never the bare
 * measured `(−PP%)` reserved for the input apply arrow — it always carries one of these:
 *
 *   - `CALIBRATED_ESTIMATE_MARKER` (`est.`) — the rate is this DEVICE'S OWN A/B measurement.
 *   - `DEFAULT_PRIOR_MARKER` (`est. · default prior`) — the rate is the shipped 0.47 starting prior no
 *     experiment on this device backs yet. The magnitude is identical to a calibrated turn; only this label
 *     tells the reader it is a general figure, not their own evidence.
 *
 * PRODUCT RULE (provenance honesty): a default prior must NEVER visually read as measured evidence, so the
 * default-prior render carries `default prior` explicitly and is a DIFFERENT string from the calibrated one.
 * These are provenance labels, NOT new claims — they never change a magnitude. They are the shipped strings,
 * so they must never be a placeholder (E8): the default-prior marker is the literal text a user sees.
 */
export const CALIBRATED_ESTIMATE_MARKER = "est." as const;
export const DEFAULT_PRIOR_MARKER = "est. · default prior" as const;

/** The output-estimate provenance the arrow's label reflects (`est.` vs `est. · default prior`). */
export type OutputEstimateBasis = "measured" | "default-prior";

/** The exact estimate label for an output arrow of the given provenance. Absent basis ⇒ a generic `est.`. */
function outputEstimateMarker(basis: OutputEstimateBasis | undefined): string {
  return basis === "default-prior" ? DEFAULT_PRIOR_MARKER : CALIBRATED_ESTIMATE_MARKER;
}

/** Kill-switch values (case-insensitive), mirrors the output-shaping hook kill switch. */
const KILL_SWITCH_VALUES = new Set(["0", "false", "off", "no"]);

/**
 * Whether the per-turn receipt line should be printed. Suppressed ONLY when the deployment threw the
 * kill switch (`COMPACTION_RECEIPT_LINE=0|false|off|no`, case-insensitive). Read fresh so a change is
 * honored on the next turn. Never throws.
 */
export function isReceiptLineEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[RECEIPT_LINE_ENV];
  if (typeof raw === "string" && KILL_SWITCH_VALUES.has(raw.toLowerCase())) return false;
  return true;
}

/** Add thousands separators to a non-negative integer count (ASCII commas). */
function group(n: number): string {
  return Math.trunc(n).toLocaleString("en-US");
}

/**
 * The open-core tier/apply-posture label the line carries:
 *  - `observe`   → `apply off`      (Open, no model-visible mutation)
 *  - `basic`     → `basic shaping`  (Open, the one public deterministic output-shaping method)
 *  - `full`      → `full apply`     (Community private-engine adaptive apply; DEFINED now, emitted only
 *                                    from a real full-apply receipt — never on an Open line)
 * The label is content-free (a fixed enum string, never a count or content).
 */
export type ReceiptTier = "observe" | "basic" | "full";

/** The exact, content-free label rendered for each tier. Frozen strings (the binding-doc grammar). */
export const RECEIPT_TIER_LABELS: Record<ReceiptTier, string> = {
  observe: "apply off",
  basic: "basic shaping",
  full: "full apply"
};

/**
 * How an OPEN line is rendered: always the Open input vocabulary (`observed input N`, never a
 * reduction), with a tier label that is either named or DELIBERATELY ABSENT.
 *
 * `"unlabeled"` exists so a caller can drop the label WITHOUT changing anything else on the line.
 * The label and the input vocabulary used to be one argument, so a surface that could not prove a
 * tier had to choose between asserting one and silently re-wording its input clause. They are
 * separate decisions and are now separate values.
 */
export type OpenLineRendering = "observe" | "basic" | "unlabeled";

/**
 * The tier label THIS RECEIPT proves, or undefined when it proves none.
 *
 * The only Open posture a gateway receipt can establish is that the gateway itself shaped the turn:
 * `request_mutated: true` with `applied_components` carrying `output-shaping` and no input
 * before→after (an input before→after is a full apply, which is the community builder's line, not
 * an Open one). That is a statement about THAT turn, so it stays true however the device is
 * configured later.
 *
 * NOTHING ELSE IS DERIVABLE, AND `apply off` IS DELIBERATELY NOT. A receipt with no mutation does not establish "no
 * model-visible mutation": the tool's own `UserPromptSubmit` hook shapes the prompt BEFORE the
 * gateway sees the request, so the gateway records a turn it cannot tell was shaped. Stamping
 * `apply off` there would convert an unverified label into a false one. Callers omit instead.
 */
export function receiptProvenOpenLabel(receipt: GatewayReceipt): "basic" | undefined {
  return receipt.request_mutated === true &&
    receipt.applied_components?.includes("output-shaping") === true &&
    receipt.estimated_input_tokens_before === undefined
    ? "basic"
    : undefined;
}

/**
 * The Open rendering for ONE turn: the label the receipt proves, else the label the LIVE turn's own
 * shaped-evidence supports, else no label at all.
 *
 * `liveShapedTurn` may be true ONLY for a turn that just happened, where the prompt hook's own record
 * of what it decided describes THIS turn (`lastTurnWasShaped`). It is the same evidence the adjacent
 * output arrow uses, so label and arrow cannot disagree. Every historical/replayed receipt passes
 * false — the current shaping decision says nothing about a turn from three days ago.
 *
 * THE LIVE FALLBACK NEVER LABELS AN INPUT-APPLY RECEIPT. A receipt carrying an input before→after is
 * a full apply, which is the community builder's line and not an Open one; the prompt hook having
 * also shaped that turn does not make `basic shaping` a true description of it, and the Open
 * rendering would suppress the measured reduction the receipt actually carries. So an input-apply
 * receipt can only ever take a label the RECEIPT proves — which, by `receiptProvenOpenLabel`, is
 * none.
 *
 * CALLERS, and one that is NOT a caller: `watch` (replay + live) and the Claude Code Stop hook route
 * every label through here. `compaction statusline` does NOT — it derives its own label from the
 * device's product mode, and deliberately renders `apply off` for an observe device, which this
 * function never emits. So this is one rule for the surfaces that call it, not a repo-wide one; do
 * not read it as a guarantee that no surface can label the same receipt differently.
 */
export function openLineForTurn(receipt: GatewayReceipt, liveShapedTurn: boolean): OpenLineRendering {
  const proven = receiptProvenOpenLabel(receipt);
  if (proven !== undefined) return proven;
  if (liveShapedTurn && receipt.estimated_input_tokens_before === undefined) return "basic";
  return "unlabeled";
}

/**
 * The content-free fields the canonical line renders. Every field is a count, a small value estimate, or the
 * short receipt id, never content. Fields are optional so an unavailable axis is OMITTED, not faked.
 */
export interface ReceiptLineFields {
  /** Total input tokens for the turn (used only when there is NO apply before→after — a plain count). */
  inputTokens?: number;
  /**
   * The OPEN "observed input" count — a plain input count rendered as `observed input N` (Open never
   * compacts input, so it never shows a before→after reduction). Used by the Open observe/basic lines.
   * Mutually exclusive with the apply before→after (`inputBefore`/`inputAfter`); if both are somehow set
   * the apply reduction wins (a real apply is a stronger, real before→after).
   */
  observedInput?: number;
  /**
   * Whether this line describes a request whose INPUT AXIS this renderer owns — i.e. a gateway receipt,
   * where we saw the request and know what did or did not happen to it.
   *
   * IT EXISTS FOR THE PAUSED TURN THAT CARRIES NO NUMBER. `input paused` is a statement ABOUT the input
   * axis, and it must survive the axis carrying nothing: a ceiling turn compacts no input, so (since the
   * axis became component-gated) it arrives here with no before/after and no observed count, and keying
   * the clause on those fields alone would silently drop the one word that explains the CTA beneath it.
   * The hook-only path (`receiptLineOutputOnly`) leaves this unset — it has no input axis at all, and the
   * ceiling clause alone already explains that line.
   */
  inputAxisOwned?: boolean;
  /**
   * The open-core tier/apply-posture label to render (`apply off` / `basic shaping` / `full apply`).
   * Content-free fixed enum string. `full` renders `full apply` and is EMITTED ONLY from a real
   * full-apply receipt (the community builder); it must never ride an Open line. Omitted → no label.
   */
  tier?: ReceiptTier;
  /**
   * APPLY before/after input (a real before→after → the `NN→MM (−PP%)` form).
   *
   * NET-VS-GROSS (load-bearing claim boundary): today these
   * are the receipt's `estimated_input_tokens_before/after`, which are LOCAL-ESTIMATE MODEL-VISIBLE token
   * counts (`token_source_*: "local-estimate"`, `estimated_model_visible_input_reduction_percent`). So the
   * `−PP%` is a GROSS model-visible reduction — how much smaller the prompt the model SEES is — NOT a
   * net-of-provider-cache fresh-BILLED reduction. These differ: compacting a provider-cached prefix can BUST
   * the cache and RAISE fresh-billed input even as model-visible bytes fall.
   * TODO(net-billed): the provider-CONFIRMED net-of-cache fresh-billed reduction is now MEASURED out of band
   * by the A/B path (`src/core/gateway/net-billed-calibration-store.ts`, fed by
   * `compaction gateway verify-cache` and surfaced by `compaction savings`). When that store holds a real
   * measured net-billed figure, feed net-billed before/after HERE so the per-turn `−PP%` reflects billed
   * savings, or relabel the clause. Until that deliberate, reviewed flip, the caller must only pass
   * model-visible before/after and the clause reads as a GROSS model-visible reduction.
   */
  inputBefore?: number;
  inputAfter?: number;
  /** Output token count for the turn (never a reduction). */
  outputTokens?: number;
  /**
   * The apply/API-key VALUE clause: the provider-PRICED cost reduction (USD) of the applied input
   * compaction. COMPUTED (never hardcoded) by `applyInputCostReductionUsd`; present only on an apply turn
   * with a priced model. Rendered `−$0.14 (list price)`. NOT mutually exclusive with the output arrow —
   * since the saving moved onto the output clause (2026-08-03), an apply turn carries both.
   */
  costReductionUsd?: number;
  /**
   * Estimated OUTPUT tokens saved on THIS shaped turn. Turns the output clause into a before→after:
   * `output 652→512 (−21%, est.)`, where BEFORE = this count + the real output. Derived by the caller from
   * the LEARNING calibration rate applied to THIS line's own output (never a session-wide sum); this
   * module only renders it. Supply it on any surface that knows the turn was shaped — hook-only AND
   * gateway/apply lines. When `estimatedOutputSavedCalibrated` is false the clause degrades to a plain
   * `output N`: no arrow, no fabricated before.
   */
  estimatedOutputTokensSaved?: number;
  /**
   * Whether the estimated-saved figure rests on a real A/B calibration sample. When a saved clause is
   * requested (`estimatedOutputSavedRequested`) but this is false, the output clause stays a plain
   * `output N` — no arrow and no reconstructed before, rather than a bare fabricated number.
   */
  estimatedOutputSavedCalibrated?: boolean;
  /**
   * Set true to turn the output clause into a before→after at all. Off by default, so a record turn or a
   * surface that cannot know whether shaping happened renders a plain count. When true and calibrated with
   * a positive count → `output B→A (−PP%, est.)`; when true and uncalibrated → a plain `output N`.
   */
  estimatedOutputSavedRequested?: boolean;
  /**
   * PROVENANCE of the estimated-saved rate, so the arrow's label distinguishes a device measurement
   * (`est.`) from the shipped default prior (`est. · default prior`) per G7. Same magnitude either way —
   * ONLY the label differs. Absent ⇒ a generic `est.` (a default prior always carries `"default-prior"`
   * from the real code path, so it can never silently fall back to the calibrated label).
   */
  estimatedOutputSavedBasis?: OutputEstimateBasis;
  /**
   * The CEILING clause: the UTC date (`YYYY-MM-DD`) this period's optimized-input allowance resets,
   * rendered as `allowance spent · input optimization paused until 2026-09-01`.
   *
   * Present ONLY when the user asked for Community `full` apply and the entitlement lease says the
   * period allowance is exhausted. Without it the line renders a bare `apply off` and a Community
   * user's tier silently downgrades with no reason and no end date — the surface would be describing
   * a refusal as if it were the user's chosen posture.
   *
   * Claim rules: it names NO figure (no remaining/consumed count — those stay content-free in the
   * lease/journal) and NO price. Ceiling behavior is refuse/degrade, never auto-purchase, so the only
   * honest things to say are that the limit was reached, that input optimization is paused, when it
   * comes back, and — since 2026-08-23 — WHERE TO CONVERT. The clause used to carry no upgrade path
   * and no URL at all, which left the one surface a user reads mid-turn stating a blocked state with
   * nothing to act on; it now ends in a single canonical CTA (`upgradeCta`, resolved from
   * `pro-destination.ts`) that the user may click and is never auto-opened. The date is derived from
   * the lease's PERIOD (`periodEndUtc`), never from `expires_at`.
   *
   * OPTIONAL NOW. A reset date is no longer required to state the pause — see `allowancePauseReason`,
   * which covers the case where a date is unknown or the pause is per-turn rather than period-wide.
   */
  allowanceResetsOn?: string;
  /**
   * WHY input optimization is unavailable this turn, when the caller knows it per-turn.
   *
   * THE GAP THIS CLOSES. The ceiling used to be expressible only as "the period allowance is spent"
   * (`allowanceResetsOn`), which `resolveOpenTier` reports on `remaining <= 0` alone. A turn whose
   * optimized input simply EXCEEDS what is left is equally blocked — input optimization does not run,
   * nothing is debited, output shaping carries the turn — but had no way to say so, so the user saw a
   * silently degraded line and no conversion path. The gateway now stamps the reason on the receipt
   * (both allowance branches) and it rides here.
   *
   * Either this or `allowanceResetsOn` is enough to render the clause. `insufficient` never claims
   * the allowance is spent, because it is not.
   */
  allowancePauseReason?: AllowancePauseReason;
  /**
   * Whether OUTPUT SHAPING really ran on this paused turn, so the clause may say so.
   *
   * NOT ASSUMED. Output shaping fires on prose turns and not on tool-call turns, and a task-aware hold
   * leaves the body unchanged — so "output shaping continues" is a claim about THIS turn that is
   * sometimes false. Callers set it from the receipt's applied components; absent ⇒ the clause states
   * the pause and the CTA without asserting a shaping that may not have happened.
   */
  outputShapingContinues?: boolean;
  /**
   * Environment used to resolve the CTA destination and terminal-hyperlink support. Injected so tests
   * can pin the encoded target and the plain-text degradation; defaults to `process.env`.
   */
  ctaEnv?: NodeJS.ProcessEnv;
  /**
   * WHICH traffic the pause covers. Defaults to `all-routes` when a reset date is supplied without a
   * scope, which is the conservative rendering (it claims the pause is broader, never narrower, than
   * it is). The resolver always supplies it.
   */
  allowancePauseScope?: AllowancePauseScope;
  /**
   * Whether the pause this line describes is still ACTIONABLE — i.e. it belongs to the allowance
   * period the reader is in right now. Defaults to actionable, because every live caller renders the
   * turn it just observed.
   *
   * HISTORY IS NOT AN OFFER. `watch`'s replay and `status`'s "Last turns" re-render receipts recorded
   * days or months ago, and a July line replayed in August is still a true record of July: it keeps
   * `input paused`, `Community limit reached`, the reset date it was written with, the shaping fact
   * and its receipt id. What it must NOT keep is the `Upgrade to Pro ↗` CTA, because a CTA is not a
   * historical fact — it is an action offered to the user NOW, about a ceiling they are no longer at.
   * Set `false` and the clause states the recorded facts and stops.
   */
  ctaActionable?: boolean;
  /** The first 8 hex of the receipt id, when a receipt exists this turn. */
  shortReceiptId?: string;
}

/**
 * The ALLOWANCE CEILING as a builder argument: what the callers pass instead of setting the four
 * ceiling fields by hand. One shape for every builder, so a surface cannot render a partial ceiling
 * (a pause with no CTA, or a CTA with no reason) by forgetting a parameter.
 */
export interface ReceiptLineCeiling {
  /** Why input optimization is unavailable — `exhausted` (nothing left) or `insufficient` (not enough). */
  reason: AllowancePauseReason;
  /** The UTC date (`YYYY-MM-DD`) the allowance resets, when known. */
  resetsOn?: string;
  /** Which traffic the pause covers; defaults to the conservative `all-routes`. */
  scope?: AllowancePauseScope;
  /** Whether output shaping really ran on this turn (asserted from evidence, never assumed). */
  outputShapingContinues?: boolean;
  /** Environment for CTA destination + hyperlink-support resolution. Defaults to `process.env`. */
  ctaEnv?: NodeJS.ProcessEnv;
  /** Whether the recorded pause is still actionable in the current period (see `ctaActionable`). */
  ctaActionable?: boolean;
}

/**
 * Translate a receipt's recorded allowance pause into the per-turn line's ceiling fields, or nothing
 * at all when the turn was healthy. SHARED by every surface that renders a per-turn line from a
 * receipt — the gateway's inline line, Claude Code's `statusLine`, and the Stop-hook capture — so a
 * paused turn cannot say one thing on one surface and something else on another.
 *
 * `outputShapingContinues` is asserted from the receipt's OWN applied components, never assumed.
 * Output shaping fires on prose turns and not on tool-call turns, and a task-aware hold can leave the
 * body unchanged — so on the turns where it did not run, the line states the pause and the conversion
 * path without claiming a shaping that did not happen. The CTA appears either way: the user is
 * blocked either way, and that is what they need to be able to act on.
 */
export function receiptCeiling(receipt: GatewayReceipt, env: NodeJS.ProcessEnv): ReceiptLineCeiling | undefined {
  const pause = receipt.allowance_pause;
  if (pause === undefined) return undefined;
  // VALIDATED AT THE READ, once, for every surface that renders from a receipt. The date is
  // interpolated into a line printed to a terminal, and the receipt it comes from lives under the
  // working directory - which is not a trust boundary. An unparseable date yields `... paused` with no
  // date rather than a sanitized guess; the pause and the conversion path are unaffected.
  const resetsOn = validResetsOn(pause.resets_on);
  // SUPPRESSED ONLY ON PROOF. `unknown` keeps the CTA: a live ceiling turn whose pause carries no
  // datable period is still a blocked user, and dropping their conversion path to be tidy about a
  // date would re-open the defect the CTA exists to close. Only a pause that PROVABLY belongs to an
  // ended period loses it.
  // THE RECORDED FACTS ARE NEVER REWRITTEN — the reason, the date it was written with and the shaping
  // evidence all pass through exactly as recorded, on a live turn and on a replay alike. Only the
  // CTA is period-bound: offering a conversion action from a pause that has since reset is a claim
  // about now, made from evidence about then.
  return {
    reason: pause.reason,
    ...(resetsOn !== undefined ? { resetsOn } : {}),
    ...(pause.scope !== undefined ? { scope: pause.scope } : {}),
    outputShapingContinues: receipt.applied_components?.includes("output-shaping") === true,
    ctaEnv: env,
    ctaActionable: allowancePausePeriodStatus(pause, env) !== "stale"
  };
}

/** Copy a ceiling argument onto the render fields. No-op when the turn carried no ceiling. */
function applyCeiling(fields: ReceiptLineFields, ceiling: ReceiptLineCeiling | undefined): void {
  if (!ceiling) return;
  fields.allowancePauseReason = ceiling.reason;
  if (ceiling.resetsOn !== undefined) fields.allowanceResetsOn = ceiling.resetsOn;
  if (ceiling.scope !== undefined) fields.allowancePauseScope = ceiling.scope;
  if (ceiling.outputShapingContinues !== undefined) fields.outputShapingContinues = ceiling.outputShapingContinues;
  if (ceiling.ctaEnv !== undefined) fields.ctaEnv = ceiling.ctaEnv;
  if (ceiling.ctaActionable !== undefined) fields.ctaActionable = ceiling.ctaActionable;
}

/**
 * The input clause. Preference order (strongest real evidence first):
 *  1. apply before→after (both present) → `input 41,210→21,876 (−47%)`. This is the ONLY place a minus sign
 *     / reduction may appear, and it is a REAL Compaction before→after.
 *  2. a plain input count → `input 22,012`.
 * Returns undefined when no input axis is available (e.g. the hook-only path).
 *
 * NET-VS-GROSS: the `−PP%` here is computed from the before/after this module is HANDED. Today those are
 * MODEL-VISIBLE local estimates (see `inputBefore`/`inputAfter`), so `−PP%` is a GROSS model-visible
 * reduction, NOT a net-of-provider-cache fresh-billed reduction. This function renders exactly the
 * before/after it is given; it never synthesizes a net number. The net-of-cache fresh-billed figure is
 * measured out of band (see the TODO(net-billed) note on the `inputBefore`/`inputAfter` field docs above).
 */
/**
 * Was THIS turn's input optimization paused for allowance? Either field is sufficient: the receipt-borne
 * `allowancePauseReason` (set per-turn by the gateway, and the only one that can express `insufficient`),
 * or the session-level `allowanceResetsOn` the Open builder resolves. One predicate, so the input axis,
 * the tier label and the ceiling clause cannot disagree about the same turn.
 */
function inputPaused(f: ReceiptLineFields): boolean {
  return f.allowancePauseReason !== undefined || f.allowanceResetsOn !== undefined;
}

function inputClause(f: ReceiptLineFields): string | undefined {
  // AT THE CEILING THE INPUT AXIS CARRIES NO NUMBER. Output shaping still mutates the request, so a
  // paused turn arrives here with `request_mutated: true` and a before/after pair whose "after" is the
  // SHAPED body — bigger than the original, not smaller. Rendering that pair produced the defect this
  // fixes: a real captured line read `input 926→1,032 (−-11%)`, claiming a reduction that never
  // happened, on the one turn where nothing was reduced. `input paused` is the whole truth about the
  // input axis of this turn, and it is what the user needs to read to understand the CTA that follows.
  // It REPLACES an input axis; it never invents one. The hook-only path (`receiptLineOutputOnly`) has
  // no input axis at all, and the ceiling clause alone already explains that line.
  if (
    inputPaused(f) &&
    (f.inputAxisOwned === true ||
      f.inputBefore !== undefined ||
      f.inputAfter !== undefined ||
      f.observedInput !== undefined)
  )
    return "input paused";
  if (f.inputBefore !== undefined && f.inputAfter !== undefined) {
    const reduction =
      f.inputBefore > 0 ? Math.round(((f.inputBefore - f.inputAfter) / f.inputBefore) * 100) : 0;
    return `input ${group(f.inputBefore)}→${group(f.inputAfter)} (−${reduction}%)`;
  }
  // Open (observe/basic): a plain OBSERVED input count — never a reduction (Open does not compact input).
  if (f.observedInput !== undefined) {
    return `observed input ${group(f.observedInput)}`;
  }
  if (f.inputTokens !== undefined) {
    return `input ${group(f.inputTokens)}`;
  }
  return undefined;
}

/** The tier/apply-posture label clause (`apply off` / `basic shaping` / `full apply`). Omitted when unset. */
function tierClause(f: ReceiptLineFields): string | undefined {
  if (f.tier === undefined) return undefined;
  // A PAUSED TURN IS NOT A FULL APPLY. `isRealApply` is true here — output shaping mutated the request
  // — so the community builder still produces the line, and it used to end `· full apply` on a turn
  // whose input optimization had been refused for allowance. The Open labels are NOT suppressed:
  // `apply off` is exactly what a ceiling refusal means, and the ceiling clause right after it says why.
  if (f.tier === "full" && inputPaused(f)) return undefined;
  return RECEIPT_TIER_LABELS[f.tier];
}

/**
 * The exact traffic each pause scope names, in the clause's compact vocabulary.
 *
 * `api-key-route` MUST stay qualified. `optimized-input-v1` is debited on the metered api-key route
 * only; subscription-route full apply is non-debitable by the binding route contract, so an
 * unqualified "full apply paused" is a false
 * statement to every subscription user whose traffic is still being applied normally.
 */
/**
 * WHAT THE ALLOWANCE PAUSES. `optimized-input-v1` buys INPUT optimization, so that is what stops at
 * the ceiling; output shaping is the Open/base capability and keeps running on the same turn. The
 * subject used to read "full apply", which named a capability the user still partly has — and, beside
 * the tier label this clause exists to explain, read as "nothing is applying".
 */
const CEILING_CLAUSE_SUBJECT: Record<AllowancePauseScope, string> = {
  "all-routes": "input optimization",
  "api-key-route": "API-key input optimization"
};

/**
 * The ceiling clause — why input optimization is off, when it returns, whether shaping still ran, and
 * the ONE place the product mentions converting. No figure, no price, one destination.
 *
 * Nothing before the ceiling advertises Pro — not the README, not onboarding, not this line while a
 * user is inside their allowance. At the ceiling the user IS blocked, so the
 * conversion pointer is honest here and ONLY here: callers must not set either allowance field on a
 * healthy turn, and the tests pin a Community full-apply turn rendering no CTA at all.
 *
 * IT CARRIES A LINK NOW, NOT A COMMAND. The previous wording ended in
 * `run: compaction upgrade`, which is reachable but asks a blocked user to stop and type. The line has
 * no stdin — it is rendered by the host tool (Claude Code's `statusLine`, Codex's `Stop` hook) — so a
 * prompt is impossible here, but a TERMINAL HYPERLINK needs none: it is inert until clicked. The
 * command remains the fallback and the state surfaces still name it; this line leads with the link.
 * Nothing here opens a browser, and repeating this clause on turn after turn opens nothing either.
 *
 * "ALLOWANCE SPENT" IS GONE from the leading words on purpose: it is false for the `insufficient`
 * pause, where tokens remain and this particular turn is simply larger than they cover.
 */
function ceilingClause(f: ReceiptLineFields): string | undefined {
  if (f.allowancePauseReason === undefined && f.allowanceResetsOn === undefined) return undefined;
  const subject = CEILING_CLAUSE_SUBJECT[f.allowancePauseScope ?? "all-routes"];
  // SCOPE STAYS NAMED even though the input axis may also read `input paused`: that axis cannot say
  // WHICH traffic stopped, and an unqualified pause is false to a subscription user whose own turns are
  // still applying. The short redundancy is the price of a clause that is true for every reader.
  const paused =
    f.allowanceResetsOn === undefined ? `${subject} paused` : `${subject} paused until ${f.allowanceResetsOn}`;
  const parts = [COMMUNITY_LIMIT_CLAUSE, paused];
  if (f.outputShapingContinues === true) parts.push("output shaping continues");
  // ONLY IF IT IS STILL AN OFFER. Absent/true ⇒ live turn ⇒ the blocked user gets the one place to
  // act. Explicit `false` ⇒ this line is a replay of a pause from a period that has ended: the facts
  // above stay, the action goes.
  if (f.ctaActionable !== false) parts.push(upgradeCta(f.ctaEnv));
  return parts.join(" · ");
}

/**
 * The same ceiling fact as a standalone SESSION-STATE block, for surfaces whose lines are HISTORICAL
 * rather than current (`compaction watch`'s replay, `status`'s "Last turns", `usage`, `lease status`).
 *
 * Those surfaces must NOT carry the clause on each line: a receipt from three days ago was not
 * refused for allowance, and stamping today's state onto it would describe that turn as something it
 * was not. The fact belongs where session state belongs — said once, above the lines.
 *
 * RE-EXPORTED, NOT REDEFINED. It used to be a second sentence written here, with its own wording and
 * an explicit refusal to carry a URL — so the surface a blocked user reads and the surfaces they then
 * check said different things, and none of them said where to go. `upgrade-cta.ts` now owns the words
 * for every surface; this export exists so the receipt-line module's consumers keep one import.
 */
export { upgradeNoticeLines, type UpgradeNoticeInput } from "../upgrade-cta.js";

/**
 * Output, as a before→after when a calibrated saving backs it; otherwise a plain count.
 *
 * The AFTER is this turn's real, provider-reported output. The BEFORE is DERIVED — actual + the
 * calibrated estimate of what shaping removed — because the unshaped turn was never generated. That is
 * why the clause carries an estimate label (`est.` / `est. · default prior`) while the input before→after
 * beside it does not: the input arrow is
 * measured bytes, this one is a reconstruction.
 *
 * With no calibrated rate the clause stays a plain count: no arrow, no fabricated before.
 */
function outputClause(f: ReceiptLineFields): string | undefined {
  if (f.outputTokens === undefined) return undefined;
  const saved = f.estimatedOutputTokensSaved;
  const calibrated =
    f.estimatedOutputSavedRequested === true &&
    f.estimatedOutputSavedCalibrated === true &&
    typeof saved === "number" &&
    Number.isFinite(saved) &&
    saved > 0;
  if (!calibrated) return `output ${group(f.outputTokens)}`;
  const before = f.outputTokens + (saved as number);
  // The percentage is derived from the SAME pair shown, so the arrow and the % can never disagree.
  // The estimate label is what separates this from the input clause's measured `−PP%` — same glyph,
  // different provenance, and the label is the only thing carrying that difference to the reader. Its
  // EXACT form encodes WHOSE evidence backs the rate (G7): `est.` for this device's own A/B, and
  // `est. · default prior` for the shipped starting rate — a default prior must never read as measured.
  const marker = outputEstimateMarker(f.estimatedOutputSavedBasis);
  //
  // INTEGER ROUNDING MUST NOT REACH AN IMPOSSIBLE ENDPOINT. One saved
  // token out of 1,000 rounds to `−0%`, which erases a real saving; a large ratio rounds to `−100%`,
  // which claims the whole output was removed while the pair plainly shows tokens remaining. Both
  // contradict the arrow beside them, so the percent is DROPPED at those endpoints and the arrow —
  // which is exact — stands alone. Same principle as the sub-cent cost clause: omit rather than
  // render a number that says something untrue.
  const percent = Math.round(((saved as number) / before) * 100);
  const arrow = `output ${group(before)}→${group(f.outputTokens)}`;
  if (percent <= 0 || percent >= 100) return `${arrow} (${marker})`;
  return `${arrow} (−${percent}%, ${marker})`;
}


/**
 * Apply an injected calibration estimate onto the fields, so a gateway/apply line can carry the output
 * before→after arrow. Same rule as the hook path: only a CALIBRATED, positive estimate produces an
 * arrow; anything else leaves a plain count rather than a fabricated before.
 */
function applyEstimatedSaved(
  fields: ReceiptLineFields,
  estimatedSaved: { calibrated: boolean; tokensSaved?: number; basis?: OutputEstimateBasis } | undefined
): void {
  if (!estimatedSaved) return;
  fields.estimatedOutputSavedRequested = true;
  fields.estimatedOutputSavedCalibrated = estimatedSaved.calibrated;
  if (typeof estimatedSaved.tokensSaved === "number") fields.estimatedOutputTokensSaved = estimatedSaved.tokensSaved;
  if (estimatedSaved.basis !== undefined) fields.estimatedOutputSavedBasis = estimatedSaved.basis;
}

/**
 * Below this the two-decimal render would read `−$0.00`, so the clause is omitted entirely. Half a cent
 * is the smallest amount that rounds up to a displayable `−$0.01`.
 */
const MIN_RENDERABLE_USD = 0.005;

/** Format a positive USD amount for the cost clause: two decimals, `−$0.14`. */
function formatUsd(usd: number): string {
  return `−$${usd.toFixed(2)}`;
}

/**
 * The COST clause: the provider-priced input cost reduction, or nothing. It is ONLY the priced input
 * reduction — the output saving rides the output clause — so the two never compete for one slot and an
 * apply turn renders both. Omitted when no positive, priced, at-least-one-cent reduction exists.
 *
 * Labeled `(list price)` rather than `(est)`: `(est)` says "not exact" without saying why, and the why is
 * specific and checkable — this is the model-visible token delta at the model's PUBLISHED input rate, not
 * an invoice and not net of the provider's prompt cache.
 */
function valueClause(f: ReceiptLineFields): string | undefined {
  if (
    typeof f.costReductionUsd === "number" &&
    Number.isFinite(f.costReductionUsd) &&
    f.costReductionUsd > 0
  ) {
    return `${formatUsd(f.costReductionUsd)} (list price)`;
  }
  return undefined;
}

/**
 * Render the canonical per-turn receipt line from content-free fields. Joins only the clauses that are
 * available with ` · `; omits any clause whose axis is unavailable. Never fabricates a field.
 *
 * Clause order: input · output · [cost] · [tier-label] · [ceiling] · id. The cost clause is the apply
 * input cost reduction; the output saving rides the output clause, so the two are NOT mutually exclusive
 * and an apply turn renders both. The tier label is the open-core apply-posture (`apply off` /
 * `basic shaping` / `full apply`).
 */
export function formatReceiptLine(f: ReceiptLineFields): string {
  const parts: string[] = [PREFIX];
  const input = inputClause(f);
  if (input) parts.push(input);
  const output = outputClause(f);
  if (output) parts.push(output);
  const value = valueClause(f);
  if (value) parts.push(value);
  const tier = tierClause(f);
  if (tier) parts.push(tier);
  // The ceiling explanation rides IMMEDIATELY after the tier label it explains, so `apply off` is
  // never read as the user's chosen posture when it is actually a refusal.
  const ceiling = ceilingClause(f);
  if (ceiling) parts.push(ceiling);
  if (f.shortReceiptId) parts.push(`id ${f.shortReceiptId}`);
  return parts.join(" · ");
}

/**
 * Did THIS turn actually compact input?
 *
 * THE QUESTION `isRealApply` CANNOT ANSWER. Output shaping mutates the request too, and it writes the
 * same `estimated_input_tokens_before/after` pair — of a body it made BIGGER. So "mutated, and both
 * estimates are present" is true of a turn that compacted nothing, and reading it as an input apply is
 * what produced the shipped defect: a shaping-only turn rendered `input 75,777→75,883 (−0%)`, an input
 * savings axis over a body that grew. The axis must describe a capability that actually ran.
 *
 * THE SIGNAL IS THE COMPONENT SET, not the arithmetic. `applied_components` is what the engine reports
 * it did, and `lcm-compaction` / `deterministic-compaction` are the components that touch input;
 * `output-shaping` alone never is. Reading components rather than `after < before` also PRESERVES A
 * TRUTHFUL ZERO: an input-compaction pass that legitimately found nothing to remove still ran, and its
 * `−0%` is a real measurement of a real apply — hiding it would be its own dishonesty.
 *
 * LEGACY RECEIPTS (no `applied_components` at all — the field is optional and predates the component
 * set) fall back to the only evidence they carry: a STRICTLY negative delta. That keeps a genuine
 * historical reduction renderable while refusing the axis to exactly the flat/grown bodies the defect
 * was made of. It is a fallback, not the rule: every live apply path sets components.
 *
 * Mirrors the gateway's own `compactsInput` (server.ts), which decides what `optimized-input-v1` meters.
 * The line and the meter must not disagree about whether input was compacted.
 */
export function receiptCompactedInput(receipt: GatewayReceipt): boolean {
  const components = receipt.applied_components;
  if (components !== undefined) {
    return components.some(
      (component) => component === "lcm-compaction" || component === "deterministic-compaction"
    );
  }
  const before = receipt.estimated_input_tokens_before;
  const after = receipt.estimated_input_tokens_after;
  return before !== undefined && after !== undefined && after < before;
}

/**
 * The honest gateway-mode discriminator. A dry-run receipt is built with `mode: "apply"` (it reuses the
 * apply receipt) but forwards the ORIGINAL request unchanged (`request_mutated !== true`), so it must NEVER
 * surface an applied cost reduction. Only a receipt whose request was ACTUALLY mutated is a real apply.
 *
 * Exported so the GATEWAY's own inline renderer asks the same question the builders ask, rather than
 * re-deriving "is this a full apply" from the raw receipt fields and drifting from this definition.
 *
 * IT ANSWERS "DID WE MUTATE", NOT "DID WE COMPACT INPUT". Output shaping is a mutation, so this is true
 * of a shaping-only turn. Anything deciding whether an INPUT SAVINGS AXIS may render must additionally
 * ask `receiptCompactedInput`.
 */
export function isRealApply(receipt: GatewayReceipt): boolean {
  return (
    receipt.request_mutated === true &&
    receipt.estimated_input_tokens_before !== undefined &&
    receipt.estimated_input_tokens_after !== undefined
  );
}

/**
 * Build the canonical line from a gateway `GatewayReceipt` (the single source of truth the gateway log
 * and the Stop hook both read). Content-free by construction: only the receipt's counts, a computed cost
 * estimate, and the short receipt id ride on the line.
 *
 *  - apply mode with a real before→after (request actually mutated) → `input B→A (−PP%)` plus, when the
 *    model is priced, the `−$X (list price)` provider-priced cost-reduction clause (COMPUTED, never
 *    hardcoded; omitted when unpriceable or below one cent).
 *  - otherwise a plain input count when the provider reported one (no cost clause — record mode makes no
 *    Compaction reduction claim; provider prompt-cache is not surfaced on this line).
 *
 * OPEN LINES (`open` set at all): Open never compacts input, so the plain input count renders as
 * `observed input N` (never a before→after reduction). Open lines therefore NEVER carry the `−PP%`
 * reduction glyph — even if the receipt somehow carried an apply before→after, the Open rendering
 * suppresses the reduction form and shows the observed count. The `full` tier is NOT accepted here: a
 * real full-apply line comes from `communityFullApplyReceiptLine` (the community builder), never this
 * Open path.
 *
 * THE LABEL IS OPTIONAL WITHIN THAT (`open: "unlabeled"`): a caller that renders HISTORICAL receipts
 * cannot know which posture produced a replayed turn, and `receiptProvenOpenLabel` is the only thing
 * that may answer it. `unlabeled` renders the identical line minus the tier clause — the input
 * vocabulary does not move with the label, so dropping an unprovable claim never re-words the count.
 *
 * Output is the provider-reported output count, rendered as a before→after only when a calibrated saving
 * is injected (see `estimatedSaved`). Returns undefined when the receipt carries no reportable axis at all.
 */
export function receiptLineFromGatewayReceipt(
  receipt: GatewayReceipt,
  /** How to render this as an OPEN line: `observe` → `apply off`, `basic` → `basic shaping`, and
   * `unlabeled` → the same Open input vocabulary with NO tier label (for a surface that cannot prove
   * one). `full` is NOT accepted here (a real full-apply line comes from
   * `communityFullApplyReceiptLine`), so `full apply` can never be synthesized on an Open receipt. */
  open?: OpenLineRendering,
  /** The allowance RESET date, when this `observe` line is a ceiling refusal rather than the user's
   * chosen posture (see `ReceiptLineFields.allowanceResetsOn`). */
  allowanceResetsOn?: string,
  /** Which traffic that pause covers (see `AllowancePauseScope`); defaults to the broader `all-routes`. */
  allowancePauseScope?: AllowancePauseScope,
  /**
   * The calibrated output-saving estimate for this turn, so the line can carry the output before→after
   * arrow. INJECTED because reading the calibration store is async and this renderer is not; callers
   * that have already loaded it pass it through. Omitted ⇒ a plain `output N`, never a fabricated arrow.
   */
  estimatedSaved?: { calibrated: boolean; tokensSaved?: number; basis?: OutputEstimateBasis },
  /**
   * The allowance ceiling this turn hit, when it hit one. Supersedes the two positional allowance
   * parameters above (which predate the `insufficient` case and cannot express it); pass one or the
   * other, not both. Omitted ⇒ no ceiling clause and NO conversion CTA, which is the healthy-turn
   * rendering and the reason the CTA stays credible.
   */
  ceiling?: ReceiptLineCeiling
): string | undefined {
  const t = receipt.tokens;
  const fields: ReceiptLineFields = {
    // A GATEWAY RECEIPT: we saw this request, so `input paused` stays sayable even when the axis itself
    // carries no number (see `inputAxisOwned`).
    inputAxisOwned: true,
    shortReceiptId: receipt.receipt_id.slice(0, 8)
  };

  // The Open INPUT VOCABULARY and the tier LABEL are separate decisions: `unlabeled` keeps the Open
  // rendering (`observed input N`, no reduction) while claiming no tier at all.
  const openTier = open !== undefined;

  // OPEN never compacts input: the reduction before→after form is suppressed and the count renders as
  // `observed input N`. Only the non-Open (community/gateway-apply) path may show a before→after reduction.
  // AND IT MUST HAVE COMPACTED INPUT. `isRealApply` alone is true of an output-shaping-only turn (see
  // `receiptCompactedInput`), which is how a shaping-only turn came to render an input savings axis over
  // a body the shaper had GROWN. Both conjuncts are required: the axis describes input compaction, and
  // nothing else may put a before→after on the line.
  if (!openTier && isRealApply(receipt) && receiptCompactedInput(receipt)) {
    fields.inputBefore = receipt.estimated_input_tokens_before;
    fields.inputAfter = receipt.estimated_input_tokens_after;
    // The provider-priced cost reduction is COMPUTED from the receipt's model-visible before→after delta ×
    // the published input price. Undefined (⇒ clause omitted) when the model is unpriced or the delta is
    // non-positive — never a fabricated `−$0`.
    //
    // SUB-CENT REDUCTIONS ARE OMITTED TOO. `formatUsd` rounds to two
    // decimals, so a real-but-tiny reduction — 1,000 estimated tokens on a $0.15/M model is $0.00015 —
    // rendered as `−$0.00 (est)`: a value clause announcing no value, which is exactly the fabricated
    // zero this path is supposed to avoid. Anything that would not round to at least one cent is dropped.
    const usd = applyInputCostReductionUsd(receipt);
    if (usd !== undefined && usd >= MIN_RENDERABLE_USD) fields.costReductionUsd = usd;
  } else if (t.prompt_input !== undefined) {
    if (openTier) fields.observedInput = t.prompt_input;
    else fields.inputTokens = t.prompt_input;
  }

  if (t.output !== undefined) fields.outputTokens = t.output;
  applyEstimatedSaved(fields, estimatedSaved);
  if (open === "observe" || open === "basic") fields.tier = open;
  if (allowanceResetsOn !== undefined) {
    fields.allowanceResetsOn = allowanceResetsOn;
    if (allowancePauseScope !== undefined) fields.allowancePauseScope = allowancePauseScope;
  }
  applyCeiling(fields, ceiling);

  // Nothing honest to print (no input axis, no output) → no line.
  if (
    fields.inputTokens === undefined &&
    fields.observedInput === undefined &&
    fields.inputBefore === undefined &&
    fields.outputTokens === undefined
  ) {
    return undefined;
  }
  return formatReceiptLine(fields);
}

/**
 * The Community FULL-APPLY line builder — emitted ONLY on a real full-apply receipt.
 *
 * Format: `compaction · input 41,210→21,876 (−47%) · output 286 · full apply · id ...` — the existing
 * apply before→after form + the `full apply` tier label. It requires a REAL apply before→after on the
 * receipt (`request_mutated === true` with both estimated input counts). Returns undefined when the
 * receipt is NOT a real full apply — so this can NEVER synthesize a `full apply` line from an Open or
 * record receipt. It is called once the private engine performs a real community full apply; until then
 * nothing calls it, so `full apply` is never emitted.
 */
export function communityFullApplyReceiptLine(
  receipt: GatewayReceipt,
  /** See `receiptLineFromGatewayReceipt`: injected so the full-apply line can carry the output arrow. */
  estimatedSaved?: { calibrated: boolean; tokensSaved?: number; basis?: OutputEstimateBasis },
  /**
   * The allowance ceiling, for symmetry with the Open builder. A real full apply and an allowance
   * pause cannot co-occur (a paused turn compacts no input, so `isRealApply` is false and this builder
   * returns undefined), but the parameter exists so the gateway has ONE call shape and the two
   * branches can never drift into disagreeing about the same turn.
   */
  ceiling?: ReceiptLineCeiling
): string | undefined {
  if (!isRealApply(receipt)) return undefined;
  const t = receipt.tokens;
  // THE TIER IS THE DEVICE'S; THE AXIS IS THE TURN'S. `full apply` is an entitlement statement (see
  // `perTurnLineFromReceipt`), so it rides every Community apply turn — but the input before→after
  // describes what actually ran, and a Community turn that only shaped output compacted no input. Such a
  // turn keeps its label, its output evidence and its plain provider-reported input count, and loses the
  // savings axis it had no right to. A real input apply that measured `−0%` still renders: see
  // `receiptCompactedInput`.
  const compactedInput = receiptCompactedInput(receipt);
  const fields: ReceiptLineFields = {
    inputAxisOwned: true,
    ...(compactedInput
      ? {
          inputBefore: receipt.estimated_input_tokens_before,
          inputAfter: receipt.estimated_input_tokens_after
        }
      : t.prompt_input !== undefined
        ? { inputTokens: t.prompt_input }
        : {}),
    tier: "full",
    shortReceiptId: receipt.receipt_id.slice(0, 8)
  };
  // The cost clause is the PRICED value of that same compaction; with no compaction there is no delta to
  // price, and pricing the shaper's growth would invert the sign of the one number a user reads as money.
  const usd = compactedInput ? applyInputCostReductionUsd(receipt) : undefined;
  if (usd !== undefined) fields.costReductionUsd = usd;
  if (t.output !== undefined) fields.outputTokens = t.output;
  applyEstimatedSaved(fields, estimatedSaved);
  applyCeiling(fields, ceiling);
  return formatReceiptLine(fields);
}

/**
 * Build the OUTPUT-ONLY hook line (Claude Code Stop hook with NO gateway receipt this turn - the
 * plan/hook-only path). Input compaction is gateway-only, so no input clause and no reduction % ever
 * appears here. The count is a local estimate unless the session usage was provider-reported.
 *   `compaction · output 412`
 *
 * When the caller opts into the estimated-output-saved clause (`estimatedSaved`), the output clause
 * becomes a before→after whose BEFORE is reconstructed from the calibrated rate:
 *   `compaction · output 652→512 (−21%, est.)`                (device-calibrated rate)
 *   `compaction · output 652→512 (−21%, est. · default prior)` (shipped starting prior, no A/B yet)
 *   `compaction · output 512`                                 (no rate at all — plain count, no before)
 * The caller derives `tokensSaved` from the LEARNING calibration rate applied to this turn's output;
 * passing `calibrated: false` (no sample yet) forces the plain count regardless of any count supplied.
 * The arrow is emitted ONLY when shaping was ACTIVE this turn (a stopped/killed turn was not shaped).
 *
 * Returns undefined when there is no output count to print (nothing honest to say).
 */
export function receiptLineOutputOnly(params: {
  outputTokens?: number;
  providerReported: boolean;
  /** Whether shaping was ACTIVE this turn (not killed, not `compaction stop`-ed). Only then does the
   * est-saved clause render — a stopped/killed turn was NOT shaped, so an output-saved estimate would
   * misattribute a saving. `providerReported` is retained for API compatibility; the source label is not
   * rendered on the line under the canonical grammar. */
  shapingActive: boolean;
  /** Opt-in estimated-output-saved clause (only honored when `shapingActive`). */
  estimatedSaved?: { calibrated: boolean; tokensSaved?: number; basis?: OutputEstimateBasis };
  /** Open tier label (`observe` → `apply off`, `basic` → `basic shaping`). Omitted → no label. `full`
   * is not accepted on the hook-only path (a real full-apply line comes from the gateway apply route). */
  tier?: "observe" | "basic";
  /** The allowance RESET date, when this `observe` line is a ceiling refusal rather than the user's
   * chosen posture (see `ReceiptLineFields.allowanceResetsOn`). */
  allowanceResetsOn?: string;
  /** Which traffic that pause covers (see `AllowancePauseScope`); defaults to the broader `all-routes`. */
  allowancePauseScope?: AllowancePauseScope;
  /**
   * The allowance ceiling, when this surface knows it. Supersedes the two fields above; pass one form
   * or the other. Omitted ⇒ no ceiling clause and no conversion CTA.
   */
  ceiling?: ReceiptLineCeiling;
}): string | undefined {
  if (params.outputTokens === undefined) return undefined;
  const fields: ReceiptLineFields = {
    outputTokens: params.outputTokens,
    shortReceiptId: undefined,
    ...(params.tier ? { tier: params.tier } : {}),
    ...(params.allowanceResetsOn ? { allowanceResetsOn: params.allowanceResetsOn } : {}),
    ...(params.allowanceResetsOn && params.allowancePauseScope
      ? { allowancePauseScope: params.allowancePauseScope }
      : {}),
    ...(params.shapingActive && params.estimatedSaved
      ? {
          estimatedOutputSavedRequested: true,
          estimatedOutputSavedCalibrated: params.estimatedSaved.calibrated,
          ...(typeof params.estimatedSaved.tokensSaved === "number"
            ? { estimatedOutputTokensSaved: params.estimatedSaved.tokensSaved }
            : {}),
          ...(params.estimatedSaved.basis !== undefined
            ? { estimatedOutputSavedBasis: params.estimatedSaved.basis }
            : {})
        }
      : {})
  };
  applyCeiling(fields, params.ceiling);
  return formatReceiptLine(fields);
}
