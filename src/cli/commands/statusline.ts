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
 *  - Read the LATEST gateway receipt (tail-only, fast) and print `receiptLineFromGatewayReceipt`.
 *  - No gateway receipt → fall back to a minimal content-free OUTPUT-ONLY line from the stdin token
 *    counts if present, else a short quiet placeholder (`compaction · recording`). Never empty-crash.
 *
 * Hard posture: FAST (no network, tail read only), FAIL-OPEN (any error → a minimal safe string or
 * nothing, ALWAYS exit 0, NEVER throw - Claude Code calls this constantly inside its render loop), and
 * CONTENT-FREE (counts / labels / source / short id only; never a prompt, path, or response byte).
 * Honors the `COMPACTION_RECEIPT_LINE=0` kill switch (prints nothing).
 */
import { Command } from "commander";
import { readLatestGatewayReceiptTail, type GatewayReceipt } from "../../core/gateway/receipt.js";
import {
  isReceiptLineEnabled,
  communityFullApplyReceiptLine,
  receiptCeiling,
  receiptLineFromGatewayReceipt,
  receiptLineOutputOnly
} from "../../core/gateway/receipt-line.js";
import { isShapingHooksActivated } from "../../core/output-shaping-hook-activation.js";
import { estimatePerTurnOutputSaved, loadCalibrationReduction } from "../../core/output-shaping-savings.js";
import { lastTurnWasShaped } from "../../core/output-shaping-turn-state.js";
import { resolveOpenTier } from "../../core/onboarding-preferences.js";

/** The quiet, claim-free placeholder when there is nothing to report yet (never empty). */
export const STATUS_LINE_PLACEHOLDER = "compaction · recording";

/** The (loosely-typed) fields we read off the Claude Code status-line stdin JSON. Any shape tolerated. */
interface StatusLineStdin {
  cwd?: unknown;
  /** Claude Code has embedded usage under a few shapes over versions; we read whatever is present. */
  cost?: { total_tokens?: unknown; output_tokens?: unknown } | unknown;
  usage?: { output_tokens?: unknown; provider_reported?: unknown } | unknown;
  output_tokens?: unknown;
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
  return (
    asNumber(stdin.output_tokens) ??
    asNumber(usage?.output_tokens) ??
    asNumber(cost?.output_tokens)
  );
}

export interface StatusLineDeps {
  /** Read the LATEST gateway receipt for `cwd` (tail-only; injectable for tests). */
  readReceipt?: (cwd: string) => Promise<GatewayReceipt | undefined>;
  env?: NodeJS.ProcessEnv;
  /** Fallback cwd when the stdin JSON does not carry one. */
  cwd?: string;
}

/**
 * Compute the ONE status line to print for a given stdin blob. Pure + fail-open: returns a string to
 * print, or `undefined` to print NOTHING (kill switch on). Never throws.
 *  1. gateway receipt for this cwd → the canonical input+output line.
 *  2. else an OUTPUT-ONLY line from the stdin token count (content-free), if present.
 *  3. else the quiet placeholder.
 */
export async function computeStatusLine(rawStdin: string, deps: StatusLineDeps = {}): Promise<string | undefined> {
  const env = deps.env ?? process.env;
  if (!isReceiptLineEnabled(env)) return undefined; // kill switch → print nothing

  try {
    const stdin = parseStatusLineStdin(rawStdin);
    const cwd = asString(stdin.cwd) ?? deps.cwd ?? process.cwd();
    const readReceipt = deps.readReceipt ?? ((c: string) => readLatestGatewayReceiptTail(c));

    // The OPEN per-turn tier label from the local product-mode store (`apply off` / `basic shaping`),
    // plus the one reason the clamp must not swallow: a Community user whose period allowance is spent
    // would otherwise read a bare `apply off` — a silent tier downgrade. Reads local disk only (the
    // lease, the credentials, and the local usage journal) — no account/entitlement/usage-service or
    // network call, and fail-open by construction.
    const { tier: productTier, allowanceResetsOn, allowancePauseScope } = await resolveOpenTier(env);

    // THE VISIBLE SURFACE. Claude Code swallows hook stdout; this
    // status line is the only per-turn line a user actually sees. The previous fix wired the Stop-hook
    // capture and left this caller unchanged, so calibrated users kept seeing a plain `output N` on the
    // one surface that renders. The RATE is loaded once here; the per-turn count is derived at each use
    // site from that line's own output, never from a session-wide sum.
    // Per-turn evidence, not activation state — see `output-shaping-turn-state.ts`. False whenever the
    // turn cannot be confirmed shaped, so a held planning turn renders a plain count.
    const hookShapedTurn = await lastTurnWasShaped(env);
    // The rate is loaded regardless of WHICH surface shaped the turn; whether it is USED is decided
    // per turn below, from evidence. A read failure yields an uncalibrated rate, never a fabricated one.
    const calibration = await loadCalibrationReduction(env);
    const reduction = hookShapedTurn ? calibration : undefined;

    const receipt = await readReceipt(cwd);
    if (receipt) {
      // FULL tier (a valid entitlement lease is present): a REAL full-apply receipt renders the
      // `full apply` line via the community builder; any non-apply turn falls back to the honest Open
      // observe line (`full apply` never rides a record turn). `observe`/`basic` use the Open builder.
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
      const gatewayShapedTurn =
        receipt.request_mutated === true && receipt.applied_components?.includes("output-shaping") === true;
      const shapedThisTurn = gatewayShapedTurn || hookShapedTurn;
      const savedForReceipt = shapedThisTurn
        ? estimatePerTurnOutputSaved(calibration, receipt.tokens?.output)
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
      // and which never emits `apply off`). Two deliberate differences, plus one that is not:
      // `apply off` for observe is deliberate wording for a device reporting its OWN live turn;
      // `gatewayShapedTurn` above omits `receiptProvenOpenLabel`'s third conjunct
      // (`estimated_input_tokens_before === undefined`), so an input-apply receipt reaching a
      // non-`full` tier here would take an Open label and lose its measured reduction. No such
      // receipt exists on Open today. Keep the two rules in sync when either moves.
      const openTier: "observe" | "basic" | undefined =
        productTier === "observe" ? (shapedThisTurn ? undefined : "observe") : shapedThisTurn ? "basic" : undefined;

      // THE TURN'S OWN CEILING, from the receipt, ahead of the session-level one. `resolveOpenTier`
      // fires only at `remaining <= 0`; the receipt also records the `insufficient` case — allowance
      // left, but less than THIS turn needed — which session state structurally cannot express. Without
      // this read, that state (say 44,054 remaining against a 75,946-token turn) rendered on the one
      // surface a user reads with no explanation and no way to convert.
      const ceiling = receiptCeiling(receipt, env);
      const line =
        productTier === "full"
          ? (communityFullApplyReceiptLine(receipt, savedForReceipt, ceiling) ??
            receiptLineFromGatewayReceipt(receipt, "observe", allowanceResetsOn, allowancePauseScope, savedForReceipt, ceiling))
          : receiptLineFromGatewayReceipt(receipt, openTier, allowanceResetsOn, allowancePauseScope, savedForReceipt, ceiling);
      if (line) return line;
    }

    // No gateway receipt (or nothing honest on it) → output-only fallback from the stdin counts. On this
    // hook-only path output shaping is the only apply lever, so the label reflects the ACTUAL turn:
    // `basic shaping` iff shaping was active this turn, else `apply off`.
    const outputTokens = outputTokensFromStdin(stdin);
    if (outputTokens !== undefined) {
      // The stdin count is provider-reported ONLY when the payload says so; default to local-estimate.
      const usage = stdin.usage as { provider_reported?: unknown } | undefined;
      const providerReported = usage?.provider_reported === true;
      const shapingActive = isShapingHooksActivated(env);
      const line = receiptLineOutputOnly({
        outputTokens,
        providerReported,
        shapingActive,
        tier: shapingActive ? "basic" : "observe",
        ...(reduction ? { estimatedSaved: estimatePerTurnOutputSaved(reduction, outputTokens) } : {}),
        // Carried on this path too: a Community user at the ceiling gets the same explanation whether
        // or not a gateway receipt existed this turn.
        ...(allowanceResetsOn ? { allowanceResetsOn } : {}),
        ...(allowanceResetsOn && allowancePauseScope ? { allowancePauseScope } : {})
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
      } catch {
        // Swallow everything - a status-line command must never break the host UI.
      }
    });
}
