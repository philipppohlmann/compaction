/**
 * A PERSISTED ALLOWANCE PAUSE IS VALID ONLY FOR THE PERIOD IT BELONGS TO.
 *
 * THE DEFECT. `lastTurnAllowancePause` filtered on one thing — "is this the newest receipt" — and the
 * newest receipt is newest forever. A turn paused on July 28 therefore kept `watch`, `status`, `usage`
 * and `lease status` reporting a live ceiling ("it resumes 2026-08-01") into August, after the
 * allowance had reset and while nothing was paused at all, and kept showing the Upgrade to Pro
 * conversion CTA to a user with a full allowance. The sentence was not the bug; the STATE BINDING was.
 *
 * The binding is to the VERIFIED LEASE PERIOD when one exists — never to the wall clock, which a user
 * can move and which is not what an entitlement is measured against. Only when there is no verified
 * period at all (Open tier, expired or wrong-device lease) does the weaker compatibility guard apply:
 * a valid `resets_on` strictly in the future.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { currentPeriodId, periodEndUtc } from "../../src/core/entitlement/lease.js";
import { lastTurnAllowancePause, allowanceNoticeInput, watchOnceHeaderLines } from "../../src/cli/commands/watch.js";
import { UPGRADE_CTA_LABEL } from "../../src/core/upgrade-cta.js";
import { provisionValidLease } from "../helpers/lease-fixture.js";

let cwd = "";
let configDir = "";

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "pause-period-cwd-"));
  configDir = mkdtempSync(join(tmpdir(), "pause-period-cfg-"));
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  rmSync(configDir, { recursive: true, force: true });
});

/** Append one receipt carrying `allowance_pause` to the store the readers actually read. */
function writePause(pause: Record<string, unknown>): void {
  mkdirSync(join(cwd, ".compaction", "gateway"), { recursive: true });
  writeFileSync(
    join(cwd, ".compaction", "gateway", "receipts.jsonl"),
    `${JSON.stringify({ receipt_id: "r-0001", allowance_pause: pause })}\n`
  );
}

/** The month before the current one, as a period id. */
function previousPeriodId(): string {
  const [year, month] = currentPeriodId().split("-").map(Number) as [number, number];
  return month === 1 ? `${year - 1}-12` : `${year}-${`${month - 1}`.padStart(2, "0")}`;
}

describe("a pause bound to the CURRENT verified lease period", () => {
  it("is promoted to current state and rendered", async () => {
    const env = provisionValidLease(configDir) as NodeJS.ProcessEnv;
    writePause({ reason: "insufficient", period_id: currentPeriodId(), resets_on: periodEndUtc(currentPeriodId()), scope: "api-key-route" });

    const pause = await lastTurnAllowancePause({ cwd, env });
    expect(pause?.reason).toBe("insufficient");
    expect((await allowanceNoticeInput(env, cwd))?.reason).toBe("insufficient");
  });
});

describe("a pause from a period that has ENDED", () => {
  it("is ignored entirely — not softened, not re-dated", async () => {
    const env = provisionValidLease(configDir) as NodeJS.ProcessEnv;
    // The exact shape the defect produced: last month's pause, carrying last month's reset date,
    // sitting as the newest receipt in a store nothing has appended to since.
    writePause({
      reason: "insufficient",
      period_id: previousPeriodId(),
      resets_on: periodEndUtc(previousPeriodId()),
      scope: "api-key-route"
    });

    expect(await lastTurnAllowancePause({ cwd, env })).toBeUndefined();
    expect(await allowanceNoticeInput(env, cwd)).toBeUndefined();
  });

  it("cannot put a conversion CTA in front of a user whose allowance has reset", async () => {
    const env = { ...provisionValidLease(configDir), COMPACTION_HYPERLINKS: "0" } as NodeJS.ProcessEnv;
    writePause({ reason: "insufficient", period_id: previousPeriodId(), resets_on: periodEndUtc(previousPeriodId()) });

    const header = (await watchOnceHeaderLines(env, cwd)).join("\n");
    expect(header).not.toContain(UPGRADE_CTA_LABEL);
    expect(header).not.toContain("paused");
  });

  it("stays ignored on re-read — a restart cannot resurrect it", async () => {
    const env = provisionValidLease(configDir) as NodeJS.ProcessEnv;
    writePause({ reason: "insufficient", period_id: previousPeriodId(), resets_on: periodEndUtc(previousPeriodId()) });

    // Every surface re-reads the same persisted store from scratch; the gate lives at the read, so
    // repeating it (a new process, a new command) reaches the same verdict rather than a first-run one.
    expect(await lastTurnAllowancePause({ cwd, env })).toBeUndefined();
    expect(await lastTurnAllowancePause({ cwd, env })).toBeUndefined();
    expect(await allowanceNoticeInput(env, cwd)).toBeUndefined();
  });
});

describe("a LEGACY pause with no period_id, against a verified lease period", () => {
  it("is accepted when its reset date is the one THIS period produces", async () => {
    const env = provisionValidLease(configDir) as NodeJS.ProcessEnv;
    writePause({ reason: "insufficient", resets_on: periodEndUtc(currentPeriodId()) });
    expect((await lastTurnAllowancePause({ cwd, env }))?.reason).toBe("insufficient");
  });

  it("is ignored when its reset date belongs to an earlier period", async () => {
    const env = provisionValidLease(configDir) as NodeJS.ProcessEnv;
    writePause({ reason: "insufficient", resets_on: periodEndUtc(previousPeriodId()) });
    expect(await lastTurnAllowancePause({ cwd, env })).toBeUndefined();
  });
});

describe("with NO verified lease period (Open tier: no authority to bind to)", () => {
  /** An empty config dir: `readLeaseVerdict` returns `lease-absent`, so there is no period. */
  const openEnv = (): NodeJS.ProcessEnv => ({ COMPACTION_CONFIG_DIR: configDir }) as NodeJS.ProcessEnv;

  it("renders a pause whose reset date is strictly in the future", async () => {
    writePause({ reason: "insufficient", resets_on: "2099-01-01" });
    expect((await lastTurnAllowancePause({ cwd, env: openEnv() }))?.reason).toBe("insufficient");
  });

  it("ignores a pause whose reset date has passed", async () => {
    writePause({ reason: "insufficient", resets_on: "2020-01-01" });
    expect(await lastTurnAllowancePause({ cwd, env: openEnv() })).toBeUndefined();
  });

  it("ignores a pause whose reset date is TODAY — the allowance has already reset", async () => {
    const today = new Date().toISOString().slice(0, 10);
    writePause({ reason: "insufficient", resets_on: today });
    expect(await lastTurnAllowancePause({ cwd, env: openEnv() })).toBeUndefined();
  });

  it("ignores a pause carrying no reset date at all — nothing establishes that it is still true", async () => {
    writePause({ reason: "insufficient", scope: "api-key-route" });
    expect(await lastTurnAllowancePause({ cwd, env: openEnv() })).toBeUndefined();
  });

  it("does not fabricate a period from the clock when a verified lease period IS available", async () => {
    // A future date passes the wall-clock guard and FAILS the period bind. The verified period wins:
    // if the clock were the authority this pause would render, and it must not.
    const env = provisionValidLease(configDir) as NodeJS.ProcessEnv;
    writePause({ reason: "insufficient", period_id: previousPeriodId(), resets_on: "2099-01-01" });
    expect(await lastTurnAllowancePause({ cwd, env })).toBeUndefined();
  });
});
