/**
 * The canonical per-turn receipt line (PUBLIC CLI/SDK core, engine-free).
 *
 * ONE content-free line, printed after a model turn on the surfaces that can do it truthfully
 * (gateway inline log; the Claude Code Stop hook). It carries ONLY counts, labels, a value estimate, and
 * the short receipt id, never a prompt, code, path, or response byte.
 *
 * Grammar (fields OMITTED when unavailable, never fabricated):
 *   compaction · [observed input N | input B→A (−PP%) | input paused] · output N · [<value-clause>] ·
 *     [<tier-label>] · [Community limit resets <YYYY-MM-DD>[ · Upgrade to Pro ↗]] · id <8hex>
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
 *    appears ONLY here UNLABELED. An output percent exists too but ALWAYS carries the `est.` label (its
 *    before is reconstructed, not measured) and ONLY when exact-key confirmed A/B evidence backs the rate. Never
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
 *    estimate label and the input arrow does not. THE ARROW REQUIRES EXACT CONFIRMED MEASUREMENT. Any
 *    proven-shaped turn without applicable evidence renders `output N/A→N (N/A%, est.)`; only a turn
 *    not proven shaped stays plain. The percent is dropped when integer rounding would reach `−0%`
 *    or `−100%`, since either would contradict the pair shown.
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
import { estimateEquivalentActiveMinutes } from "../active-workload-value.js";
import type { RunAggregate } from "./run-aggregate.js";
import type { AllowancePauseScope } from "../onboarding-preferences.js";
import type { AllowancePauseReason } from "../upgrade-cta.js";
import { communityLimitClause, upgradeCta, validResetsOn } from "../upgrade-cta.js";
import { applyInputCostReductionUsd } from "./api-cost-impact.js";
import { allowancePausePeriodStatus } from "../entitlement/lease-store.js";
import { POLICY_PREFERENCE_ID_PATTERN } from "../policy-preferences.js";

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
 * The label every OUTPUT arrow carries. The output before is always DERIVED from a rate (the unshaped turn
 * was never generated), so an output arrow is never the bare measured `(−PP%)` reserved for the input apply
 * arrow — it is always `(−PP%, est.)`.
 *
 * PRODUCT RULE (provenance honesty): a default prior must NEVER visually read as measured evidence. There
 * used to be a second marker for that case — `est. · default prior` — rendered beside a full `777→412
 * (−47%)` pair on turn one of a fresh install. The words were accurate and the pair was still read as
 * counted, which is the whole failure: a disclosure printed next to a specific per-run number does not
 * withdraw it. So the rule is now enforced by the ARROW and not by a label. A default-prior basis renders
 * NO arrow (see `outputClause`), the second marker is gone, and this one means what it says — an estimate
 * built on an exact-key rate confirmed by empirical evidence.
 */
export const CALIBRATED_ESTIMATE_MARKER = "est." as const;

/**
 * Whose evidence backs the estimate. It gates the arrow rather than choosing its label: `"measured"` (this
 * shared/local exact confirmed A/B) may render one; `"default-prior"` (the internal starting rate) may not.
 */
export type OutputEstimateBasis = "measured" | "default-prior";

/**
 * WHAT THE EXACT APPLICABILITY KEY RESOLVES about its shaping rate — the second half of the estimate's provenance, and
 * the half that decides whether an UNMEASURED axis is shown as unknown or not shown at all. Mirrors
 * `CalibrationState` in `output-shaping-calibration-store.ts` (declared here rather than imported, the
 * same way `OutputEstimateBasis` mirrors `CalibrationBasis`, so the formatter keeps no dependency on the
 * store).
 *
 * `unseeded` / `calibrating` ⇒ we have no exact rate yet. `measured-no-effect` ⇒ evidence measured and the
 * answer was "shaping did not reduce output here". Those are opposite epistemic positions that happen to
 * share an empty percentage, and `outputClause` renders them differently for exactly that reason.
 */
export type OutputEstimateState = "unseeded" | "calibrating" | "calibrated" | "measured-no-effect";

/**
 * The explicitly-unknown endpoint. It occupies the BEFORE slot and the percentage slot when shaping
 * provably ran on a turn whose exact cohort cannot yet be sized.
 *
 * IT IS NOT A NUMBER AND CANNOT BE MISREAD AS ONE — which is the entire reason the axis may be shown at
 * all. The withdrawn `777→412 (−47%, est. · default prior)` failed because a specific pair reads as
 * counted whatever label stands beside it; `N/A→412 (N/A%, est.)` states the same absence the plain
 * count stated, without also deleting the fact that shaping ran on this turn.
 */
const NOT_AVAILABLE = "N/A" as const;

/**
 * The calibration estimate as it is INJECTED into a line builder (reading the store is async and these
 * renderers are not). Structurally the estimator's own `PerTurnEstimatedSaved`, named here so every
 * builder accepts the same shape: five call sites previously re-declared it inline, and a re-declaration
 * that omits a field silently drops that field's guarantee — exactly how the `basis` gate came to be
 * statically invisible on the gateway path (#951).
 */
export interface InjectedOutputEstimate {
  calibrated: boolean;
  tokensSaved?: number;
  basis?: OutputEstimateBasis;
  state?: OutputEstimateState;
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

/** Drop a trailing `.00` / `.50` zero tail so `2.00M` reads `2M` and `1.20M` reads `1.2M`. */
function trimDecimalZeros(fixed: string): string {
  return fixed.includes(".") ? fixed.replace(/0+$/, "").replace(/\.$/, "") : fixed;
}

/**
 * A short magnitude for an allowance count: `2M`, `1.82M`, `950K`, `4.1K`, `730`.
 *
 * SEPARATE FROM `group` ON PURPOSE. The token axes render exact counts because they are measurements
 * of one turn; an allowance countdown is a budget the reader glances at, and `1,823,904/2,000,000`
 * spends a third of the line on digits nobody reads. Different job, different formatter.
 *
 * TRUNCATES, NEVER ROUNDS UP: a remainder must not be shown as more headroom than the device has, and
 * the last visible increment before zero must not read as a full unit.
 */
function compactTokens(n: number): string {
  const v = Math.max(0, Math.trunc(n));
  if (v >= 1_000_000) return `${trimDecimalZeros((Math.trunc(v / 10_000) / 100).toFixed(2))}M`;
  if (v >= 1_000) return `${trimDecimalZeros((Math.trunc(v / 100) / 10).toFixed(1))}K`;
  return `${v}`;
}

/**
 * The open-core tier/apply-posture label the line carries:
 *  - `observe`   → `apply off`      (Open, no model-visible mutation)
 *  - `basic`     → `basic shaping`  (Open, the one public deterministic output-shaping method)
 *  - `full`      → `full apply`     (Community private-engine adaptive apply; DEFINED now, emitted only
 *                                    from a successful stored-policy private LCM receipt — never on an Open line)
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
 * Whether output shaping was ACTIVE on the final model-visible request of ONE turn.
 *
 * THE RECEIPT IS AUTHORITATIVE WHENEVER IT SPEAKS. `output_shaping_state` is the engine's own
 * measurement of the exact bytes forwarded: `attached-this-pass` and `already-active` both mean the
 * policy was on the request the model read; `absent` means it was not. A live session signal
 * (`lastTurnWasShaped`, the prompt hook's record of what it DECIDED) is weaker evidence than that
 * measurement and must never override it — in particular an explicit `absent` may not inherit `true`
 * from the session, which is exactly what happens when a live drain coalesces several receipts and
 * hands every one of them the latest turn's evidence.
 *
 * THE LIVE FALLBACK APPLIES ONLY WHEN THE FIELD IS UNDEFINED: a receipt written before the field
 * existed recorded nothing, so the session's own account of the turn is the only evidence there is.
 * Callers pass `false` for anything historical, where no such account exists.
 *
 * THE PRICE OF THAT PRECEDENCE, STATED HONESTLY. `outputShapingActiveOnRequest` inspects
 * INSTRUCTION-LEVEL CARRIERS ONLY, so a `UserPromptSubmit` hook that shapes the USER message writes a
 * truthful `absent` onto a turn that really was shaped, and this function then reports `false` for it.
 * That is the correct trade for the callers here — silence on a turn we cannot attribute beats an arrow
 * on a turn that had no saving — but it is a real false negative, not a neutral one, and it costs the
 * Stop hook (`capture-claude-code.ts`) a label on a prompt-shaped turn it could once claim. Accepted:
 * `absent` is the engine measuring the bytes it forwarded, and no surface should print over that.
 * The live statusline deliberately does NOT share this rule (`statusline.ts`, `shapedThisTurn`): it
 * pairs a per-turn hook record with the receipt in one place and can prefer the stronger of the two.
 *
 * One rule for the arrow and the label, so the two can never disagree about the same receipt.
 */
export function outputShapingActiveForTurn(receipt: GatewayReceipt, liveShapedTurn: boolean): boolean {
  const state = receipt.output_shaping_state;
  if (state !== undefined) return state === "attached-this-pass" || state === "already-active";
  return liveShapedTurn;
}

/**
 * The tier label THIS RECEIPT proves, or undefined when it proves none.
 *
 * The one Open posture a gateway receipt can establish is that output shaping was ACTIVE on the
 * final model-visible request: `output_shaping_state` of `attached-this-pass` (the gateway attached
 * the policy) or `already-active` (the policy arrived upstream — the tool's own `UserPromptSubmit`
 * hook — and the engine measured it on the bytes forwarded), with no input before→after (an input
 * before→after is a full apply, which is the community builder's line, not an Open one). That is a
 * statement about THAT turn, so it stays true however the device is configured later.
 *
 * This used to read `request_mutated` + an `output-shaping` entry in `applied_components`, which
 * answers "did THIS PASS mutate", and withheld the label on the ordinary `already-active` turn while
 * the adjacent arrow — a stronger claim — rode the state. The state is the stronger evidence of the
 * two: it is measured against the full current policy at instruction-level carriers only, whereas a
 * mutation record says nothing about what the model finally read.
 *
 * NOTHING ELSE IS DERIVABLE, AND `apply off` IS DELIBERATELY NOT. A receipt with NO state (legacy)
 * establishes nothing and licenses nothing — the final request is not retained anywhere, so it cannot
 * be classified after the fact; fail closed. And an explicit `absent` establishes only that the policy
 * was not on the request, which is not the same as "no model-visible mutation": stamping `apply off`
 * there would convert an unverified label into a false one. Callers omit instead.
 */
export function receiptProvenOpenLabel(receipt: GatewayReceipt): "basic" | undefined {
  return outputShapingActiveForTurn(receipt, false) && receipt.estimated_input_tokens_before === undefined
    ? "basic"
    : undefined;
}

/**
 * The Open rendering for ONE turn: the label the receipt proves, else — only when the receipt records
 * no state at all — the label the LIVE turn's own shaped-evidence supports, else no label at all.
 *
 * THE RECEIPT'S STATE IS AUTHORITATIVE WHEN PRESENT (see `outputShapingActiveForTurn`): a receipt that
 * says `absent` is never relabelled `basic shaping` from session state, however the session recorded
 * the turn. The fallback exists for the legacy receipt with no state.
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
  // ROUTED THROUGH `receiptProvenOpenLabel`, not a second copy of its predicate. The gateway's own
  // inline line calls that function directly (`server.ts`), so an independent re-derivation here would
  // be free to drift from it silently — two surfaces disagreeing about one receipt is the exact defect
  // this module exists to prevent.
  const proven = receiptProvenOpenLabel(receipt);
  if (proven !== undefined) return proven;
  // THE FALLBACK IS GUARDED ON ABSENCE OF STATE, not merely on the label being unproven: `absent` is a
  // measurement, and reaching past it to the session flag is how an explicit "not shaped" turn gets
  // relabelled `basic shaping`.
  if (receipt.output_shaping_state !== undefined) return "unlabeled";
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
   * Equivalent active agent minutes preserved, estimated only from this completed run's avoided
   * tokens and its observed token-consumption rate. Never a provider quota/limit claim.
   */
  estimatedActiveMinutesSaved?: number;
  /**
   * Estimated OUTPUT tokens saved on THIS shaped turn. Turns the output clause into a before→after:
   * `output 652→512 (−21%, est.)`, where BEFORE = this count + the real output. Derived by the caller from
   * the shared exact calibration rate applied to THIS line's own output (never a session-wide sum); this
   * module only renders it. Supply it on any surface that knows the turn was shaped — hook-only AND
   * gateway/apply lines. When `estimatedOutputSavedCalibrated` is false, explicit unseeded state renders
   * `output N/A→N`; no numeric arrow or fabricated before is possible.
   */
  estimatedOutputTokensSaved?: number;
  /**
   * Whether the estimated-saved figure rests on a real A/B calibration sample. When a saved clause is
   * requested (`estimatedOutputSavedRequested`) but this is false, the output clause uses its explicit
   * state to choose N/A or plain actual — never a numeric arrow or reconstructed before.
   */
  estimatedOutputSavedCalibrated?: boolean;
  /**
   * Set true to turn the output clause into a before→after at all. Off by default, so a record turn or a
   * surface that cannot know whether shaping happened renders a plain count. When true and calibrated with
   * a positive count → `output B→A (−PP%, est.)`; when true and uncalibrated → a plain `output N`.
   */
  estimatedOutputSavedRequested?: boolean;
  /**
   * PROVENANCE of the estimated-saved rate. `"default-prior"` SUPPRESSES the arrow entirely — the shipped
   * starting rate may back an internal estimate but never a rendered per-run figure — and `"measured"` (or
   * absent, the pre-existing default for callers that only ever pass their own measurement) allows it.
   * It used to choose between two labels on an arrow that rendered either way.
   */
  estimatedOutputSavedBasis?: OutputEstimateBasis;
  /**
   * WHAT THE EXACT APPLICABILITY KEY RESOLVES about its shaping rate. Only meaningful alongside
   * `estimatedOutputSavedRequested` (i.e. the caller proved this turn was shaped), and only consulted
   * when no defensible saving exists:
   *  - `unseeded` / `calibrating` → `output N/A→412 (N/A%, est.)`. Shaping ran; its size is unmeasured.
   *  - `measured-no-effect`       → `output 412`. Empirical evidence found nothing to show.
   *  - ABSENT                     → `output 412`. We do not know which of the two it is, so we claim
   *                                 neither. Every renderer must forward it explicitly; nothing here
   *                                 infers it.
   */
  estimatedOutputSavedState?: OutputEstimateState;
  /**
   * The UTC date (`YYYY-MM-DD`) this period's optimized-input allowance resets.
   *
   * BOTH A PAUSE SIGNAL AND THE RENDERED DATE. `inputPaused` treats this field as sufficient evidence
   * that the turn was refused for allowance, which is what turns the input axis into `input paused`,
   * suppresses a `full apply` label, and raises the ceiling clause — and the clause it raises PRINTS
   * this value (`Community limit resets 2026-09-01`, see `ceilingClause`). It is the one fact the
   * rest of the line cannot express: `input paused` says the capability is gone, and only the date
   * says it comes back. The detail surfaces still state it in a sentence ("It resumes 2026-09-01." on
   * `status`, `usage`, `lease status`, `watch` and `mode`); the primary line no longer depends on
   * them to say the one thing a blocked user needs.
   *
   * DERIVED, NEVER LITERAL. The value reaches this field from the lease PERIOD (`periodEndUtc`) via
   * the receipt's recorded pause — see the claim rules below. A caller that hard-coded a date here
   * would be printing a promise the entitlement chain never made.
   *
   * Set ONLY when the user asked for Community `full` apply and the entitlement lease says the period
   * allowance is exhausted. Without it (or `allowancePauseReason`) the line renders a bare `apply off`
   * and a Community user's tier silently downgrades with no reason at all — the surface would be
   * describing a refusal as if it were the user's chosen posture.
   *
   * Claim rules: the clause it raises names NO figure (no remaining/consumed count — those stay
   * content-free in the lease/journal) and NO price. Ceiling behavior is refuse/degrade, never
   * auto-purchase. A date is not a balance: printing when the allowance returns asserts nothing about
   * what it costs or how much of it is left. The date is derived from the lease's PERIOD
   * (`periodEndUtc`), never from `expires_at`.
   *
   * OPTIONAL. A reset date is not required to state the pause — see `allowancePauseReason`, which
   * covers the case where a date is unknown or the pause is per-turn rather than period-wide.
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
   * Environment used to resolve the CTA destination and terminal-hyperlink support. Injected so tests
   * can pin the encoded target and the plain-text degradation; defaults to `process.env`.
   */
  ctaEnv?: NodeJS.ProcessEnv;
  /**
   * Whether the pause this line describes is still ACTIONABLE — i.e. it belongs to the allowance
   * period the reader is in right now. Defaults to actionable, because every live caller renders the
   * turn it just observed.
   *
   * HISTORY IS NOT AN OFFER. `watch`'s replay and `status`'s "Last turns" re-render receipts recorded
   * days or months ago, and a July line replayed in August is still a true record of July: it keeps
   * `input paused`, its ceiling clause, its output arrow and its receipt id. What it must NOT
   * keep is the `Upgrade to Pro ↗` CTA, because a CTA is not a historical fact — it is an action
   * offered to the user NOW, about a ceiling they are no longer at. Set `false` and the clause states
   * the recorded fact and stops.
   */
  ctaActionable?: boolean;
  /**
   * The Community allowance COUNTDOWN for this turn: optimized-input allowance left after this turn's
   * debit, and the period total it is left out of. Both or neither — a numerator with no denominator
   * is a bare number the reader cannot size, and a denominator alone says nothing about this turn.
   *
   * HEALTHY-TURN ONLY, and the counterpart of the ceiling clause rather than a companion to it. A
   * paused turn renders `allowancePauseReason` and the conversion path; restating the same spent
   * allowance as `0/2M left` alongside it would be the same fact in weaker words.
   *
   * The values come from the RECEIPT (`allowance_snapshot`), recorded when the debit committed —
   * never read from the lease or the journal at render time. That is what keeps every surface's line
   * a statement about the turn it belongs to, and keeps the statusline render loop free of any file
   * read or network call.
   */
  allowanceRemainingTokens?: number;
  /** The period's TOTAL allowance — the countdown's denominator. See `allowanceRemainingTokens`. */
  allowancePeriodTotalTokens?: number;
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
 * `outputShapingContinues` is asserted from the receipt's OWN recorded evidence, never assumed.
 * Two different things leave this pass having mutated nothing. A task-aware hold can leave the body
 * unchanged — that turn really was not shaped. And the tool's own `UserPromptSubmit` hook may have
 * attached the policy upstream, in which case the planner correctly attached nothing and the turn
 * still reaches the model shaped (`already-active`). The recorded state distinguishes them, so the
 * line states the pause and the conversion path without claiming a shaping that did not happen. The CTA appears either way: the user is
 * blocked either way, and that is what they need to be able to act on.
 */
export function receiptCeiling(
  receipt: Pick<GatewayReceipt, "allowance_pause" | "output_shaping_state" | "applied_components">,
  env: NodeJS.ProcessEnv
): ReceiptLineCeiling | undefined {
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
    // SAME QUESTION AS THE OUTPUT ARROW, so it must not answer differently on the same line: an
    // `already-active` paused turn would otherwise draw the arrow while omitting this clause, and the
    // line would contradict itself. `output_shaping_state` is the durable answer.
    //
    // BUT THE FAIL-CLOSED RULE IS THE ARROW'S, NOT THIS CLAUSE'S. The arrow is a SAVINGS CLAIM, so a
    // legacy receipt with no state gets no arrow. This clause only EXPLAINS that the input pause did not
    // take shaping with it — no number, no claim — and it already shipped on `applied_components` for
    // every receipt written before the state field existed. Dropping it from those would regress a real
    // explanation on the one line a blocked user reads, so legacy receipts keep the component fallback.
    outputShapingContinues:
      receipt.output_shaping_state !== undefined
        ? receipt.output_shaping_state === "attached-this-pass" || receipt.output_shaping_state === "already-active"
        : Array.isArray(receipt.applied_components) && receipt.applied_components.includes("output-shaping"),
    ctaEnv: env,
    ctaActionable: allowancePausePeriodStatus(pause, env) !== "stale"
  };
}

/** Copy a ceiling argument onto the render fields. No-op when the turn carried no ceiling. */
function applyCeiling(fields: ReceiptLineFields, ceiling: ReceiptLineCeiling | undefined): void {
  if (!ceiling) return;
  fields.allowancePauseReason = ceiling.reason;
  // THE DATE IS BOTH THE PAUSE SIGNAL AND THE CLAUSE'S ONE VARIABLE (see
  // `ReceiptLineFields.allowanceResetsOn`), so it must cross. `scope` and `outputShapingContinues` are
  // deliberately NOT copied across: they are facts about the receipt that the DETAIL surfaces state in
  // sentences, and the primary line has no clause left that renders either. They stay on
  // `ReceiptLineCeiling` so a caller reading a receipt still gets them.
  if (ceiling.resetsOn !== undefined) fields.allowanceResetsOn = ceiling.resetsOn;
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
  // SHAPED body — bigger than the original, not smaller. Rendering that pair would claim a reduction
  // on a turn where nothing was reduced. `input paused` is the whole truth about the
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
 * The ceiling clause — the product FACT that explains the refusal above it, and the ONE place the
 * product mentions converting. `Community limit resets 2026-10-01`, then the CTA. No figure, no
 * price, one destination.
 *
 * WHAT THE ALLOWANCE PAUSES, AND WHY THE DATE IS THE WHOLE CLAUSE. The optimized-input allowance
 * buys INPUT optimization, so that is what stops at the ceiling; output shaping is the Open/base
 * capability and keeps running on the same turn. The clause used to narrate all of that:
 * `Community limit reached · input optimization paused until 2026-09-01 · output shaping continues`.
 * Every added clause was true, and each one cost the primary line the property it exists for — being
 * readable in one glance, mid-turn, by a user who is in the middle of something else. Two of the
 * three were also being said, better, earlier on the same line:
 *
 *  - THE PAUSE — `inputClause` renders `input paused` from the same `inputPaused` predicate, so
 *    `input optimization paused` was the same fact in the next breath.
 *  - THE SHAPING — a paused turn that was shaped still draws its output arrow
 *    (`output 652→512 (−21%, est.)`). That is the measurement; `output shaping continues` was the
 *    caption under it, and a caption is the weaker of the two.
 *
 * The date was the only one of the three the line could not otherwise express, so it is the only one
 * that survived — folded INTO the clause rather than trailing it. `reached` alone states a wall;
 * `resets <date>` states the wall and the way out, in fewer characters than the narration it
 * replaced. A blocked user learns how long they are blocked without leaving the line.
 *
 * WHEN THERE IS NO DATE, `communityLimitClause` falls back to the undated `Community limit reached`.
 * A pause whose period is not datable is still a blocked user, and a clause is still owed to them:
 * without one the line reads as a bare `apply off`, which describes a refusal as if it were the
 * user's chosen posture. Neither form names a scope, so a receipt replayed from the period when
 * metering was api-key-only is not re-narrated as something it never said — the scope qualifier the
 * old wording needed has nothing left to qualify. The scope still reaches the reader, qualified as it
 * always was, on the detail surfaces.
 *
 * "ALLOWANCE SPENT" IS ABSENT on purpose: it is false for the `insufficient` pause, where tokens
 * remain and this particular turn is simply larger than they cover. Both forms here are true of both
 * reasons, which is why they are the forms that survived.
 *
 * Nothing before the ceiling advertises Pro — not the README, not onboarding, not this line while a
 * user is inside their allowance. At the ceiling the user IS blocked, so the
 * conversion pointer is honest here and ONLY here: callers must not set either allowance field on a
 * healthy turn, and the tests pin a Community full-apply turn rendering no CTA at all.
 *
 * IT CARRIES A LINK, NOT A COMMAND. The line has no stdin — it is rendered by the host tool (Claude
 * Code's `statusLine`, Codex's `Stop` hook) — so "press Enter to upgrade" is unreachable here, but a
 * TERMINAL HYPERLINK needs none: it is inert until clicked. The command remains the fallback and the
 * state surfaces still name it; this line leads with the link. Nothing here opens a browser, and
 * repeating this clause on turn after turn opens nothing either.
 */
function ceilingClause(f: ReceiptLineFields): string | undefined {
  if (f.allowancePauseReason === undefined && f.allowanceResetsOn === undefined) return undefined;
  const parts = [communityLimitClause(f.allowanceResetsOn)];
  // ONLY IF IT IS STILL AN OFFER. Absent/true ⇒ live turn ⇒ the blocked user gets the one place to
  // act. Explicit `false` ⇒ this line is a replay of a pause from a period that has ended: the fact
  // above stays, the action goes.
  if (f.ctaActionable !== false) parts.push(upgradeCta(f.ctaEnv));
  return parts.join(" · ");
}

/**
 * The COUNTDOWN clause: `1.82M/2M left` — optimized-input allowance remaining after this turn, out of
 * the period's total.
 *
 * WHY A HEALTHY LINE CARRIES A NUMBER AT ALL. Before this, a Community user learned the state of their
 * allowance exactly once: the turn it ran out, in a clause that also asked them to upgrade. Everything
 * before that read identically at 5% spent and at 99%, so the first signal was indistinguishable from
 * the sales pitch attached to it. A countdown that is present from the first turn makes the ceiling a
 * budget the user is watching rather than a wall they walk into.
 *
 * NO CTA, NO PRICE, NO ADJECTIVE. It states two counts and stops. `left` is the only word, and it is
 * true whichever end of the range the reader is at.
 *
 * BOTH OR NEITHER, AND ONLY WHEN COHERENT: a remainder above the total describes a lease the server
 * could not have signed, and a zero total is not a denominator. Either way the clause is dropped
 * rather than clamped into a number that would look authoritative.
 */
function countdownClause(f: ReceiptLineFields): string | undefined {
  const remaining = f.allowanceRemainingTokens;
  const total = f.allowancePeriodTotalTokens;
  if (typeof remaining !== "number" || typeof total !== "number") return undefined;
  if (!Number.isFinite(remaining) || !Number.isFinite(total)) return undefined;
  if (total <= 0 || remaining < 0 || remaining > total) return undefined;
  return `${compactTokens(remaining)}/${compactTokens(total)} left`;
}

/**
 * Copy a receipt's recorded allowance SNAPSHOT onto the render fields. SHARED by every surface that
 * renders a per-turn line, for the same reason `receiptCeiling` is: one turn, one countdown, whichever
 * surface draws it.
 *
 * READ OFF THE RECEIPT, never off current device state — the binding precedent is `receiptCeiling`.
 * A replayed receipt from three weeks ago must show the allowance THAT turn left behind, not today's;
 * and a statusline that re-read the lease or the journal on every render would put a file read (and,
 * once renewal is involved, a network call) inside the render loop.
 *
 * A PAUSE WINS. The gateway already declines to record a snapshot on a paused turn, and this is the
 * second half of the same rule, enforced where the line is drawn: a receipt carrying both — a legacy
 * record, or a future writer that forgets — renders the pause and drops the countdown.
 */
function applyAllowanceSnapshot(fields: ReceiptLineFields, receipt: GatewayReceipt): void {
  const snapshot = receipt.allowance_snapshot;
  if (snapshot === undefined || receipt.allowance_pause !== undefined) return;
  fields.allowanceRemainingTokens = snapshot.remaining_tokens;
  fields.allowancePeriodTotalTokens = snapshot.period_total_tokens;
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
 * Output, as a before→after when a MEASURED saving backs it; otherwise a plain count.
 *
 * The AFTER is this turn's real, provider-reported output. The BEFORE is DERIVED — actual + the
 * calibrated estimate of what shaping removed — because the unshaped turn was never generated. That is
 * why the clause carries the `est.` label while the input before→after beside it does not: the input
 * arrow is measured bytes, this one is a reconstruction.
 *
 * A DEFAULT-PRIOR BASIS RENDERS NO ARROW. The shipped 0.47 starting rate produces a perfectly specific
 * `777→412 (−47%)`, and specificity is exactly what makes it read as counted on a device that has counted
 * nothing. `loadCalibrationReduction` already refuses to hand a prior over as `measured`, so the store path
 * cannot reach this; the check below holds the rule against every OTHER caller — README examples, onboarding
 * copy, any future surface — so the constant is unrenderable as a per-run figure through all of them.
 *
 * With no applicable rate, a proven-shaped caller requests the explicitly unknown N/A axis. An
 * unshaped caller stays plain, while the generic prior is independently barred from reconstruction.
 */
/**
 * The output clause on a turn with NO defensible saving to show. Two different facts land here, and
 * they get two different lines.
 *
 * SHAPING RAN AND WE CANNOT YET SIZE IT (`unseeded` / `calibrating`). The axis stays, with both unknown
 * slots stated as unknown: `output N/A→412 (N/A%, est.)`. A plain `output 412` is not wrong, but it is
 * the same line an unshaped turn prints, so it silently deletes the one thing this turn does know —
 * that shaping ran on it. `N/A` fabricates nothing: it is a refusal to fill the slot, in the slot.
 *
 * EMPIRICAL EVIDENCE FOUND NO REDUCTION (`measured-no-effect`), or we do not know which case this
 * is (state ABSENT): a plain `output 412`. Drawing `N/A→` over a measured null would overwrite the
 * device's own answer with our uncertainty — the same substitution, in the same direction, that the
 * default prior was withdrawn for. The shared resolver never returns that prior; this is the same rule
 * at the render site.
 *
 * The arrow requires `estimatedOutputSavedRequested`, so a record turn, an unshaped turn, or a surface
 * that cannot prove shaping ran never reaches the unknown form at all.
 */
function unmeasuredOutputClause(f: ReceiptLineFields): string {
  const plain = `output ${group(f.outputTokens as number)}`;
  if (f.estimatedOutputSavedRequested !== true) return plain;
  const state = f.estimatedOutputSavedState;
  if (state !== "unseeded" && state !== "calibrating") return plain;
  return `output ${NOT_AVAILABLE}→${group(f.outputTokens as number)} (${NOT_AVAILABLE}%, ${CALIBRATED_ESTIMATE_MARKER})`;
}

function outputClause(f: ReceiptLineFields): string | undefined {
  if (f.outputTokens === undefined) return undefined;
  const saved = f.estimatedOutputTokensSaved;
  const calibrated =
    f.estimatedOutputSavedRequested === true &&
    f.estimatedOutputSavedCalibrated === true &&
    f.estimatedOutputSavedBasis !== "default-prior" &&
    typeof saved === "number" &&
    Number.isFinite(saved) &&
    saved > 0;
  if (!calibrated) return unmeasuredOutputClause(f);
  const before = f.outputTokens + (saved as number);
  // The percentage is derived from the SAME pair shown, so the arrow and the % can never disagree.
  // The estimate label is what separates this from the input clause's measured `−PP%` — same glyph,
  // different provenance, and the label is the only thing carrying that difference to the reader. It is
  // unconditional now: an arrow reaching this point is backed by exact-key confirmed A/B evidence, because a prior
  // was refused above.
  const marker = CALIBRATED_ESTIMATE_MARKER;
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
  estimatedSaved: InjectedOutputEstimate | undefined
): void {
  if (!estimatedSaved) return;
  fields.estimatedOutputSavedRequested = true;
  fields.estimatedOutputSavedCalibrated = estimatedSaved.calibrated;
  if (typeof estimatedSaved.tokensSaved === "number") fields.estimatedOutputTokensSaved = estimatedSaved.tokensSaved;
  if (estimatedSaved.basis !== undefined) fields.estimatedOutputSavedBasis = estimatedSaved.basis;
  if (estimatedSaved.state !== undefined) fields.estimatedOutputSavedState = estimatedSaved.state;
}

/**
 * A receipt that proves shaping active owns an output-counterfactual axis even when its caller could
 * not resolve calibration. Keep that axis explicitly unavailable instead of silently making the turn
 * look unshaped. An explicit estimate (including a measured-no-effect result) always wins.
 */
function applyReceiptEstimatedSaved(
  fields: ReceiptLineFields,
  receipt: GatewayReceipt,
  estimatedSaved: InjectedOutputEstimate | undefined
): void {
  applyEstimatedSaved(
    fields,
    estimatedSaved ??
      (outputShapingActiveForTurn(receipt, false)
        ? { calibrated: false, state: "unseeded" }
        : undefined)
  );
}

/**
 * Read one persisted provider token count without trusting the JSONL shape.
 *
 * `GatewayReceipt` is strict at write time, but replay/status surfaces read old or
 * damaged JSON.  JavaScript property access on a string silently boxes it, while
 * `null` throws; accepting either behaviour here can turn malformed storage into
 * a visible provider-reported-looking count.  Every receipt renderer therefore
 * uses this one fail-closed reader: only non-negative safe integers are displayable.
 */
function receiptTokenCount(
  receipt: GatewayReceipt,
  key: "prompt_input" | "output"
): number | undefined {
  const tokens = receipt.tokens;
  if (tokens === null || typeof tokens !== "object" || Array.isArray(tokens)) return undefined;
  const value = (tokens as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Below this the two-decimal render would read `−$0.00`, so the clause is omitted entirely. Half a cent
 * is the smallest amount that rounds up to a displayable `−$0.01`.
 *
 * APPLIED IN `valueClause`, which is the ONE place the clause is rendered. It used to be applied at a
 * single call site instead, so the second builder that set the same field skipped it.
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
    f.costReductionUsd >= MIN_RENDERABLE_USD
  ) {
    return `${formatUsd(f.costReductionUsd)} (list price)`;
  }
  return undefined;
}

function activeMinutesClause(f: ReceiptLineFields): string | undefined {
  const minutes = f.estimatedActiveMinutesSaved;
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0) return undefined;
  const display = Number.isInteger(minutes) ? String(minutes) : minutes.toFixed(3).replace(/0+$/, "");
  return `+~${display}m`;
}

/**
 * Render the canonical per-turn receipt line from content-free fields. Joins only the clauses that are
 * available with ` · `; omits any clause whose axis is unavailable. Never fabricates a field.
 *
 * Clause order: input · output · [cost] · [tier-label] · [countdown] · [ceiling] · id. The cost clause is the apply
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
  const activeMinutes = activeMinutesClause(f);
  if (activeMinutes) parts.push(activeMinutes);
  const tier = tierClause(f);
  if (tier) parts.push(tier);
  // The countdown rides with the tier label it belongs to — it is a fact about the Community
  // allowance, not about this turn's tokens — and it is mutually exclusive with the ceiling clause
  // below, which describes the same allowance once it has stopped counting down.
  const countdown = countdownClause(f);
  if (countdown) parts.push(countdown);
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
 * estimates are present" is true of a turn that compacted nothing, and reading it as an input apply
 * would render a savings axis over a body that grew. The axis must describe a capability that actually ran.
 *
 * THE SIGNAL STARTS WITH THE COMPONENT SET. `applied_components` is what the engine reports it did,
 * and `lcm-compaction` / `deterministic-compaction` are the components that touch input;
 * `output-shaping` alone never is. A visible reduction axis additionally requires canonical count
 * fields and a strict positive delta. A component that ran but found nothing remains recorded in the
 * receipt, while the user-facing line keeps the independently valid plain count instead of drawing
 * a `−0%` savings arrow.
 *
 * LEGACY RECEIPTS (no `applied_components` at all — the field is optional and predates the component
 * set) fall back to the only evidence they carry: a STRICTLY negative delta. That keeps a genuine
 * historical reduction renderable while refusing the axis to exactly the flat/grown bodies the defect
 * was made of. It is a fallback, not the rule: every live apply path sets components.
 *
 * Mirrors the gateway's own `compactsInput` (server.ts), which decides what the allowance meters.
 * The line and the meter must not disagree about whether input was compacted.
 */
export function receiptCompactedInput(receipt: GatewayReceipt): boolean {
  const components = receipt.applied_components;
  if (components !== undefined) {
    if (!Array.isArray(components)) return false;
    if (
      !components.some(
        (component) => component === "lcm-compaction" || component === "deterministic-compaction"
      )
    ) {
      return false;
    }
  }
  const before = receipt.estimated_input_tokens_before;
  const after = receipt.estimated_input_tokens_after;
  return (
    typeof before === "number" &&
    typeof after === "number" &&
    Number.isSafeInteger(before) &&
    Number.isSafeInteger(after) &&
    before > 0 &&
    after >= 0 &&
    after < before
  );
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
    receipt.mode === "apply" &&
    receipt.request_mutated === true &&
    receipt.estimated_input_tokens_before !== undefined &&
    receipt.estimated_input_tokens_after !== undefined
  );
}

/**
 * Does this exact receipt prove the user-facing Community Full posture?
 *
 * Full is the PRIVATE input engine actually applying, not merely an apply-mode request mutation.
 * Output shaping mutates requests too, and the public deterministic component may reduce input, but
 * neither is Hybrid/LCM provenance. A failed upstream request also did not complete a usable provider
 * turn. Keep this predicate separate from `receiptCompactedInput`, whose broader deterministic+LCM
 * meaning remains correct for accounting.
 */
export function receiptProvesPrivateFullApply(receipt: GatewayReceipt): boolean {
  const before = receipt.estimated_input_tokens_before;
  const after = receipt.estimated_input_tokens_after;
  const upstreamStatus = receipt.upstream_status;
  return (
    receipt.mode === "apply" &&
    isRealApply(receipt) &&
    typeof receipt.receipt_id === "string" &&
    receipt.receipt_id.length > 0 &&
    receipt.tokens !== null &&
    typeof receipt.tokens === "object" &&
    !Array.isArray(receipt.tokens) &&
    receipt.approval_status === "auto-applied-by-policy" &&
    typeof receipt.authorization_id === "string" &&
    POLICY_PREFERENCE_ID_PATTERN.test(receipt.authorization_id) &&
    Array.isArray(receipt.applied_components) &&
    receipt.applied_components.includes("lcm-compaction") &&
    typeof before === "number" &&
    typeof after === "number" &&
    Number.isSafeInteger(before) &&
    Number.isSafeInteger(after) &&
    before > 0 &&
    after >= 0 &&
    after < before &&
    Number.isInteger(upstreamStatus) &&
    upstreamStatus >= 200 &&
    upstreamStatus < 300
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
  /**
   * The calibrated output-saving estimate for this turn, so the line can carry the output before→after
   * arrow. INJECTED because reading the calibration store is async and this renderer is not; callers
   * that have already loaded it pass it through. Omitted on a receipt that proves shaping active ⇒
   * `output N/A→N`; omitted on an unshaped receipt ⇒ plain actual.
   */
  estimatedSaved?: InjectedOutputEstimate,
  /**
   * The allowance ceiling this turn hit, when it hit one. Supersedes the two positional allowance
   * parameters above (which predate the `insufficient` case and cannot express it); pass one or the
   * other, not both. Omitted ⇒ no ceiling clause and NO conversion CTA, which is the healthy-turn
   * rendering and the reason the CTA stays credible.
   */
  ceiling?: ReceiptLineCeiling
): string | undefined {
  const promptInput = receiptTokenCount(receipt, "prompt_input");
  const output = receiptTokenCount(receipt, "output");
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
    // SUB-CENT REDUCTIONS ARE OMITTED TOO — enforced in `valueClause`, not here. `formatUsd` rounds to
    // two decimals, so a real-but-tiny reduction (1,000 estimated tokens on a $0.15/M model is
    // $0.00015) rendered as `−$0.00 (list price)`: a value clause announcing no value, which is
    // exactly the fabricated zero this path exists to avoid. The floor used to live at THIS call site
    // alone, so the Community full-apply builder below — which sets the same field from the same
    // function — rendered the zero this one refused to. One rule, one place, both builders.
    const usd = applyInputCostReductionUsd(receipt);
    if (usd !== undefined) fields.costReductionUsd = usd;
  } else if (promptInput !== undefined) {
    if (openTier) fields.observedInput = promptInput;
    else fields.inputTokens = promptInput;
  }

  if (output !== undefined) fields.outputTokens = output;
  applyReceiptEstimatedSaved(fields, receipt, estimatedSaved);
  if (open === "observe" || open === "basic") fields.tier = open;
  if (allowanceResetsOn !== undefined) fields.allowanceResetsOn = allowanceResetsOn;
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
 * The label-free fallback for a receipt that does not prove private Full posture.
 *
 * CONTRACT. A non-apply receipt renders no tier label at all: never `apply off`, never `full apply`.
 * `full apply` stays reserved for a successful stored-policy private LCM input reduction and is emitted
 * only from `communityFullApplyReceiptLine`. `apply off` is the Open OBSERVE posture, the
 * user's choice of no model-visible mutation; it is not a description of one record-mode call, and a
 * full-tier device must never emit it. Omitting the label is the honest middle: the line says what the
 * turn had and claims nothing about what the device is entitled to.
 *
 * Record-mode and other non-Full receipts can interleave with private applies inside one user task, so
 * a hardcoded fallback posture would let an auxiliary call take over the visible result. This builder
 * withholds that unsupported posture claim.
 *
 * A PER-RECEIPT FALLBACK, NOT THE POSTURE SURFACE. No single receipt can state the device's posture
 * across a whole task; that is a run-level statement, over every call between `UserPromptSubmit` and
 * `Stop`. This builder's only job is to stop one receipt from lying in the gaps between applies.
 *
 * NO APPLY AXIS, EVER. This builder is used only when the caller wants a plain-count fallback;
 * deterministic or otherwise valid non-Full input reductions must use `receiptLineFromGatewayReceipt`
 * to retain their measured axis without a posture label.
 * `inputAxisOwned` stays true: the gateway saw the request, so `input paused` remains sayable, and the
 * ceiling / allowance / pause clauses ride the line exactly as on the other gateway builders.
 *
 * The numeric OUTPUT arrow rides `estimatedSaved`. Without one, durable shaping provenance produces
 * the explicit N/A axis; a receipt that does not prove shaping stays plain.
 */
export function nonApplyReceiptLine(
  receipt: GatewayReceipt,
  /** See `receiptLineFromGatewayReceipt`: injected, and the ONLY route to an output arrow on this line. */
  estimatedSaved?: InjectedOutputEstimate,
  /** The allowance RESET date, when this turn was a ceiling refusal (kept so the pause clause survives). */
  allowanceResetsOn?: string,
  /** The allowance ceiling this turn hit, when it hit one. */
  ceiling?: ReceiptLineCeiling
): string | undefined {
  const promptInput = receiptTokenCount(receipt, "prompt_input");
  const output = receiptTokenCount(receipt, "output");
  const fields: ReceiptLineFields = {
    // A GATEWAY RECEIPT: we saw this request, so `input paused` stays sayable even with no number.
    // No `tier`: a non-apply receipt carries no posture label (see the contract above).
    inputAxisOwned: true,
    shortReceiptId: receipt.receipt_id.slice(0, 8)
  };
  if (promptInput !== undefined) fields.inputTokens = promptInput;
  if (output !== undefined) fields.outputTokens = output;
  applyReceiptEstimatedSaved(fields, receipt, estimatedSaved);
  if (allowanceResetsOn !== undefined) fields.allowanceResetsOn = allowanceResetsOn;
  applyCeiling(fields, ceiling);
  applyAllowanceSnapshot(fields, receipt);
  // Nothing honest to print (no input count, no output) → no line, exactly as the other builders.
  if (fields.inputTokens === undefined && fields.outputTokens === undefined) return undefined;
  return formatReceiptLine(fields);
}

/**
 * THE RUN LINE — one user request, not one provider call.
 *
 * This is the PRIMARY user-facing surface. A single prompt sends Claude Code through many provider
 * calls, and rendering whichever receipt landed last made the persistent line flicker
 * `full apply → apply off → full apply` mid-task, because Claude Code's own auxiliary record-mode
 * calls mutate nothing. Those are micro-events inside one piece of work. The receipts stay exactly as
 * they are — they are the evidence ledger — and this renders the derived total over them.
 *
 * THE POSTURE IS THE RUN'S, NOT THE LAST RECEIPT'S. It is passed in from the device's actual product
 * tier, so a no-op call inside a full-tier run cannot restate the whole run as `apply off`. That is
 * also why the posture is NOT derived here from the aggregate's own numbers: a full-tier run that
 * happened to find nothing to compact is still a full-tier run.
 *
 * EVERY NUMBER COMES FROM TOTALS. The percentages are computed once, here, from summed before/after —
 * never averaged or summed from per-call percentages. The allowance is the run's ENDING level, never
 * a sum. An axis with no reduction renders as a plain total rather than a `−0%` arrow, so a run that
 * saved nothing on one axis says so by omission instead of claiming a zero.
 *
 * THE TIER GRAMMAR IS THE SAME GRAMMAR THE PER-RECEIPT LINES USE. `input B→A (−PP%)` is reserved for a
 * real measured input apply regardless of output posture; a non-reducing `observe`/`basic` run reads
 * `observed input N`.
 * The allowance CEILING is rendered from the run's own paused call through `receiptCeiling`, so a
 * blocked user reads the same reason, reset date and conversion path the per-receipt line would show.
 *
 * A KNOWN-PARTIAL AGGREGATE CARRIES NO RATE. `incomplete` is the caller saying its read of the ledger
 * cut the run off; a percentage over part of a run would be a claim the evidence cannot carry, so both
 * axes fall back to plain totals.
 */
export function runAggregateLine(params: {
  aggregate: RunAggregate;
  /** The run's posture, derived from its durable receipts — never from the current device setting. */
  tier?: ReceiptTier;
  /**
   * Estimate provenance for the OUTPUT axis. REQUIRED for the run line to draw an output arrow at all:
   * without it there is no evidence that a rate — let alone a device-measured one — produced the summed
   * `before`, and the line renders its plain total. This used to be optional decoration on an arrow that
   * was drawn unconditionally, which was safe only because the one caller happened to set the rate and
   * the basis together. That coupling was an invariant nothing enforced; this enforces it.
   */
  outputBasis?: OutputEstimateBasis;
  /**
   * What the run's exact applicability keys resolve about shaping, when shaped calls have no
   * defensible counterfactual backs. `unseeded`/`calibrating` ⇒ the run states its unknown axis;
   * `measured-no-effect` or absent ⇒ a plain total.
   */
  outputState?: OutputEstimateState;
  ceiling?: ReceiptLineCeiling;
  /**
   * The caller KNOWS the aggregate is missing some of the run's calls (its bounded read cut the run
   * off). Plain totals only: a rate over a partial run is a claim the evidence cannot carry.
   */
  incomplete?: boolean;
  /** Exact completed hook-opened active-workload window; absent/open windows render no minutes. */
  activeWindow?: { startedAt: string; endedAt: string };
}): string | undefined {
  const { aggregate } = params;
  const fields: ReceiptLineFields = { inputAxisOwned: true };
  if (params.tier !== undefined) fields.tier = params.tier;
  const rateAllowed = params.incomplete !== true;

  const input = aggregate.input;
  if (input !== undefined) {
    // THE INPUT GRAMMAR HOLDS ON THE RUN LINE. Any exact real reduction keeps its measured arrow,
    // including public explicit deterministic apply; posture changes only the label, never the input
    // evidence. A non-reducing observe/basic run uses the Open `observed input N` vocabulary.
    if (rateAllowed && input.after < input.before) {
      // A real reduction gets the before→after arrow; no reduction gets the plain total it earned.
      fields.inputBefore = input.before;
      fields.inputAfter = input.after;
    } else if (params.tier === "observe" || params.tier === "basic") {
      fields.observedInput = input.after;
    } else {
      fields.inputTokens = input.after;
    }
  }

  const output = aggregate.output;
  if (output !== undefined) {
    fields.outputTokens = output.after;
    // The counterfactual rides ONLY on calls whose provenance proved shaping active (`aggregateRun`
    // fails closed for `absent` and for legacy receipts), so an unshaped run shows a plain total — and
    // shows it WITHOUT an unknown axis, because nothing was shaped and so no measurement is missing.
    if (rateAllowed && aggregate.shapedCallCount > 0) {
      if (output.before > output.after && params.outputBasis !== undefined) {
        // `calibrated` here means "a usable rate produced this number", NOT "the rate was
        // device-measured": `basis` is what carries measured-vs-prior to the label, and the caller
        // decides whether a rate exists at all. Requiring the basis EXPLICITLY is what keeps that
        // decision the caller's; a summed `before` alone proves only that arithmetic happened.
        applyEstimatedSaved(fields, {
          calibrated: true,
          tokensSaved: output.before - output.after,
          basis: params.outputBasis,
          ...(params.outputState !== undefined ? { state: params.outputState } : {})
        });
      } else {
        // SHAPED CALLS, NO DEFENSIBLE COUNTERFACTUAL. The run must not read as a plain total — that is
        // the line an unshaped run prints — and must not read as `−0%`, which would claim evidence
        // measured a null it has not measured. `applyEstimatedSaved` with no saving lets the formatter
        // decide from the state alone, so the run line and the per-call lines reach the unknown axis
        // through one rule rather than two.
        applyEstimatedSaved(fields, {
          calibrated: false,
          ...(params.outputState !== undefined ? { state: params.outputState } : {})
        });
      }
    }
  }

  if (aggregate.allowance !== undefined) {
    fields.allowanceRemainingTokens = aggregate.allowance.remaining_tokens;
    fields.allowancePeriodTotalTokens = aggregate.allowance.period_total_tokens;
  }
  if (params.tier === "full" && rateAllowed && params.activeWindow !== undefined) {
    fields.estimatedActiveMinutesSaved = estimateEquivalentActiveMinutes({
      inputBefore: aggregate.input?.before,
      inputAfter: aggregate.input?.after,
      outputAfter: aggregate.output?.after,
      ...(aggregate.output && aggregate.output.before > aggregate.output.after && params.outputBasis === "measured"
        ? { estimatedOutputTokensAvoided: aggregate.output.before - aggregate.output.after }
        : {}),
      runStartedAt: params.activeWindow.startedAt,
      runEndedAt: params.activeWindow.endedAt
    });
  }
  applyCeiling(fields, params.ceiling);

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
 * The Community FULL-APPLY line builder — emitted ONLY when this successful receipt proves a private
 * Hybrid/LCM input application under stored policy authorization.
 *
 * Format: `compaction · input 41,210→21,876 (−47%) · output 286 · full apply · id ...` — the existing
 * apply before→after form + the `full apply` tier label. It requires `lcm-compaction`, a net measured
 * input reduction, stored-policy authorization, request mutation, and a 2xx upstream result. Returns
 * undefined for deterministic-only, shaping-only, failed, Open, and record receipts.
 */
export function communityFullApplyReceiptLine(
  receipt: GatewayReceipt,
  /** See `receiptLineFromGatewayReceipt`: injected so the full-apply line can carry the output arrow. */
  estimatedSaved?: InjectedOutputEstimate,
  /**
   * The allowance ceiling, for symmetry with the Open builder. A real full apply and an allowance
   * pause cannot co-occur (a paused turn compacts no input, so `isRealApply` is false and this builder
   * returns undefined), but the parameter exists so the gateway has ONE call shape and the two
   * branches can never drift into disagreeing about the same turn.
   */
  ceiling?: ReceiptLineCeiling
): string | undefined {
  if (!receiptProvesPrivateFullApply(receipt)) return undefined;
  const promptInput = receiptTokenCount(receipt, "prompt_input");
  const output = receiptTokenCount(receipt, "output");
  // THE LABEL AND AXIS COME FROM THIS EXACT RECEIPT. The predicate above has already established a
  // successful private input apply with a strict net reduction. Entitlement or output shaping alone is
  // deliberately insufficient.
  const compactedInput = receiptCompactedInput(receipt);
  const fields: ReceiptLineFields = {
    inputAxisOwned: true,
    ...(compactedInput
      ? {
          inputBefore: receipt.estimated_input_tokens_before,
          inputAfter: receipt.estimated_input_tokens_after
        }
      : promptInput !== undefined
        ? { inputTokens: promptInput }
        : {}),
    tier: "full",
    shortReceiptId: receipt.receipt_id.slice(0, 8)
  };
  // The cost clause is the PRICED value of that same compaction; with no compaction there is no delta to
  // price, and pricing the shaper's growth would invert the sign of the one number a user reads as money.
  const usd = compactedInput ? applyInputCostReductionUsd(receipt) : undefined;
  if (usd !== undefined) fields.costReductionUsd = usd;
  if (output !== undefined) fields.outputTokens = output;
  applyReceiptEstimatedSaved(fields, receipt, estimatedSaved);
  applyCeiling(fields, ceiling);
  // READ FROM THE RECEIPT HERE, not passed in like `ceiling`. The countdown needs no environment and
  // no period arithmetic, so taking it straight off the receipt gives all four surfaces that call this
  // builder (gateway inline, Claude Code statusline, the Stop-hook capture, `watch`) the same clause
  // by construction rather than by four call sites remembering to.
  applyAllowanceSnapshot(fields, receipt);
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
 *   `compaction · output 652→512 (−21%, est.)` (an exact-key confirmed rate)
 *   `compaction · output N/A→512 (N/A%, est.)` (known exact miss)
 * The caller derives `tokensSaved` from the shared exact calibration rate applied to this turn's output;
 * passing `calibrated: false` preserves its explicit state, so every proven-shaped miss renders N/A.
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
  estimatedSaved?: InjectedOutputEstimate;
  /** Open tier label (`observe` → `apply off`, `basic` → `basic shaping`). Omitted → no label. `full`
   * is not accepted on the hook-only path (a real full-apply line comes from the gateway apply route). */
  tier?: "observe" | "basic";
  /** The allowance RESET date, when this `observe` line is a ceiling refusal rather than the user's
   * chosen posture (see `ReceiptLineFields.allowanceResetsOn`). */
  allowanceResetsOn?: string;
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
    ...(params.allowanceResetsOn ? { allowanceResetsOn: params.allowanceResetsOn } : {})
  };
  // THROUGH THE SHARED HELPER, not a hand-spread copy of it. This builder used to enumerate the four
  // estimate fields itself, so every field added to the estimate had to be remembered in two places —
  // and this is the HOOK-ONLY path, the first line a fresh subscription install ever prints, which is
  // exactly the install whose calibration state the omission would have dropped. `shapingActive` still
  // gates it: a stopped or killed turn was not shaped, so nothing about its output axis may be claimed,
  // unknown included.
  if (params.shapingActive) applyEstimatedSaved(fields, params.estimatedSaved);
  applyCeiling(fields, params.ceiling);
  return formatReceiptLine(fields);
}
