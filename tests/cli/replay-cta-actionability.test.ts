/**
 * A REPLAYED HISTORICAL LINE KEEPS ITS FACTS AND LOSES ITS OFFER.
 *
 * `compaction watch` and `compaction status` re-render receipts that were written days or months ago.
 * A July receipt replayed in August is still a true record of July, and rewriting it into the current
 * period would falsify history — so `Community limit reached`, `input optimization paused until
 * <the date July recorded>`, `output shaping continues` and the receipt id all stay exactly as
 * recorded.
 *
 * The `Upgrade to Pro ↗` CTA is not one of those facts. It is an ACTION offered to the reader now,
 * about a ceiling they are no longer at: the allowance reset, the pause ended, and nothing about the
 * current period is blocked. The split this pins is therefore historical evidence (preserved) versus
 * live call to action (period-bound), and the binding is the same verified-lease-period authority the
 * state surfaces use — never the wall clock.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { provisionValidLease } from "../helpers/lease-fixture.js";
import { currentPeriodId, periodEndUtc } from "../../src/core/entitlement/lease.js";
import { receiptCeiling } from "../../src/core/gateway/receipt-line.js";
import type { GatewayReceipt } from "../../src/core/gateway/receipt.js";
import { UPGRADE_CTA_LABEL } from "../../src/core/upgrade-cta.js";
import { proUrl } from "../../src/core/pro-destination.js";

const CLI = join(__dirname, "..", "..", "dist", "cli", "index.js");
const CLI_BUILT = existsSync(CLI);
const RECEIPT_ID = "11111111-2222-3333-4444-555555555555";

/** The month before the current one, as a period id. */
function previousPeriodId(): string {
  const [year, month] = currentPeriodId().split("-").map(Number) as [number, number];
  return month === 1 ? `${year - 1}-12` : `${year}-${`${month - 1}`.padStart(2, "0")}`;
}

/** A paused turn exactly as the gateway recorded it inside `periodId`. */
function pausedReceipt(periodId: string): GatewayReceipt {
  return {
    receipt_id: RECEIPT_ID,
    captured_at: `${periodId}-28T10:00:00.000Z`,
    provider: "anthropic",
    model: "claude-opus-5",
    endpoint: "/v1/messages",
    mode: "apply",
    upstream_status: 200,
    model_visible_bytes_changed: false,
    tokens: { prompt_input: 75_946, output: 300 },
    fresh_billed_input_reduction: { available: false, note: "no cached tokens reported" },
    token_source: "provider-reported",
    cache_source: "unavailable",
    cost_source: "unavailable",
    reasons: { cost: "provider reports tokens, not billing" },
    claim_scope: "run-scoped",
    approval_status: "auto-applied-by-policy",
    sync_status: "local-only",
    content_uploaded: false,
    label: "apply",
    applied_components: ["output-shaping"],
    allowance_pause: {
      reason: "insufficient",
      period_id: periodId,
      resets_on: periodEndUtc(periodId) as string,
      scope: "api-key-route"
    }
  } as GatewayReceipt;
}

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A working directory whose receipt store holds one paused turn from `periodId`. */
function cwdWithPausedTurn(periodId: string): string {
  const cwd = mkdtempSync(join(tmpdir(), "replay-cta-cwd-"));
  dirs.push(cwd);
  mkdirSync(join(cwd, ".compaction", "gateway"), { recursive: true });
  writeFileSync(join(cwd, ".compaction", "gateway", "receipts.jsonl"), `${JSON.stringify(pausedReceipt(periodId))}\n`);
  return cwd;
}

/** An entitled device in the CURRENT period, with the allowance state the caller asks for. */
function entitledDevice(allowanceTokens = 2_000_000): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), "replay-cta-cfg-"));
  dirs.push(dir);
  return provisionValidLease(dir, { allowance_tokens: allowanceTokens }, { productMode: "full" }) as NodeJS.ProcessEnv;
}

describe("the ceiling a receipt is translated into", () => {
  it("marks a CURRENT-period pause actionable", () => {
    const ceiling = receiptCeiling(pausedReceipt(currentPeriodId()), entitledDevice());
    expect(ceiling?.ctaActionable).toBe(true);
  });

  it("marks a pause from an ENDED period unactionable while preserving what it recorded", () => {
    const stale = previousPeriodId();
    const ceiling = receiptCeiling(pausedReceipt(stale), entitledDevice());
    expect(ceiling?.ctaActionable).toBe(false);
    // NOT REWRITTEN INTO THE CURRENT PERIOD: the recorded reason, the recorded date and the recorded
    // shaping evidence are what July wrote, and they still are.
    expect(ceiling?.reason).toBe("insufficient");
    expect(ceiling?.resetsOn).toBe(periodEndUtc(stale));
    expect(ceiling?.resetsOn).not.toBe(periodEndUtc(currentPeriodId()));
    expect(ceiling?.outputShapingContinues).toBe(true);
    expect(ceiling?.scope).toBe("api-key-route");
  });

  it("leaves an UNDATABLE pause actionable — suppression needs proof of staleness, not absence of proof", () => {
    // A pause with no period and no reset date, read with no lease to date it against. This is a LIVE
    // blocked turn as far as anything here can tell, and the per-turn line is the only place that user
    // is offered a way out; withholding it to be tidy about a date would re-open the reachability
    // defect the CTA exists to close.
    const receipt = pausedReceipt(currentPeriodId());
    const undatable = { ...receipt, allowance_pause: { reason: "insufficient" as const, scope: "api-key-route" as const } };
    expect(receiptCeiling(undatable as GatewayReceipt, {})?.ctaActionable).toBe(true);
  });
});

describe.runIf(CLI_BUILT)("the replayed line on the surfaces that replay", () => {
  function run(env: NodeJS.ProcessEnv, cwd: string, args: string[]): string {
    // FORCE_COLOR must be DELETED, not blanked: chalk reads an empty value as "colors on".
    const full = { ...process.env, ...env, NO_COLOR: "1", COMPACTION_HYPERLINKS: "0" };
    delete full.FORCE_COLOR;
    return execFileSync("node", [CLI, ...args], { encoding: "utf8", env: full, cwd });
  }

  /** The per-turn receipt line out of a surface that prints one among other output. */
  function receiptLineIn(out: string): string {
    const line = out.split("\n").map((l) => l.trim()).find((l) => l.startsWith("compaction ·"));
    expect(line, "expected a per-turn receipt line").toBeDefined();
    return line as string;
  }

  it("a CURRENT-period pause is replayed WITH the conversion path", () => {
    const env = entitledDevice();
    const cwd = cwdWithPausedTurn(currentPeriodId());
    for (const args of [["watch", "--once"], ["status"]]) {
      const line = receiptLineIn(run(env, cwd, args));
      expect(line, args.join(" ")).toContain(UPGRADE_CTA_LABEL);
      expect(line, args.join(" ")).toContain(proUrl(process.env));
    }
  });

  it("a STALE pause is replayed WITHOUT the conversion path", () => {
    const env = entitledDevice();
    const cwd = cwdWithPausedTurn(previousPeriodId());
    for (const args of [["watch", "--once"], ["status"]]) {
      const out = run(env, cwd, args);
      expect(out, args.join(" ")).not.toContain(UPGRADE_CTA_LABEL);
      expect(out, args.join(" ")).not.toContain(proUrl(process.env));
    }
  });

  it("...and the historical facts on that stale line are all still there", () => {
    const stale = previousPeriodId();
    const env = entitledDevice();
    const cwd = cwdWithPausedTurn(stale);
    for (const args of [["watch", "--once"], ["status"]]) {
      const line = receiptLineIn(run(env, cwd, args));
      expect(line, args.join(" ")).toContain("input paused");
      expect(line, args.join(" ")).toContain("Community limit reached");
      // The date JULY recorded — not today's period, and not dropped.
      expect(line, args.join(" ")).toContain(`paused until ${periodEndUtc(stale)}`);
      expect(line, args.join(" ")).toContain("output shaping continues");
      expect(line, args.join(" ")).toContain("output 300");
      expect(line, args.join(" ")).toContain(`id ${RECEIPT_ID.slice(0, 8)}`);
    }
  });

  it("`watch --once` and `status` replay the SAME line, stale or current", () => {
    const env = entitledDevice();
    for (const periodId of [currentPeriodId(), previousPeriodId()]) {
      const cwd = cwdWithPausedTurn(periodId);
      expect(receiptLineIn(run(env, cwd, ["watch", "--once"])), periodId).toBe(
        receiptLineIn(run(env, cwd, ["status"]))
      );
    }
  });

  it("a LIVE exhausted allowance still gets the CTA — suppression is about staleness, not about pauses", () => {
    // No receipts at all: this is CURRENT state resolved from the signed lease, not a replay.
    const env = entitledDevice(0);
    const cwd = mkdtempSync(join(tmpdir(), "replay-cta-live-"));
    dirs.push(cwd);
    for (const args of [["usage"], ["lease", "status"]]) {
      const out = run(env, cwd, args);
      expect(out, args.join(" ")).toContain("is paused");
      expect(out, args.join(" ")).toContain(proUrl(process.env));
    }
    // …and a current-period paused TURN keeps it on the per-turn line as well.
    const turnCwd = cwdWithPausedTurn(currentPeriodId());
    expect(receiptLineIn(run(env, turnCwd, ["watch", "--once"]))).toContain(UPGRADE_CTA_LABEL);
  });
});
