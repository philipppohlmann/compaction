import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lastReceiptLines } from "../../src/cli/commands/watch.js";
import { receiptLineFromGatewayReceipt } from "../../src/core/gateway/receipt-line.js";
import type { GatewayReceipt } from "../../src/core/gateway/receipt.js";

/**
 * `compaction status` "Last turns" section reuses `lastReceiptLines` (the SAME tail reader + canonical
 * `receiptLineFromGatewayReceipt` formatter `compaction watch` uses - no duplicate formatting). This
 * proves: it returns the last N canonical lines newest-last; honors the `COMPACTION_RECEIPT_LINE=0` kill
 * switch (no lines); and fails open on a missing/empty store (empty list, never an error).
 */

let cwd: string;

/** A minimal record-mode receipt with a distinct id + input/output counts, JSONL-serialized. */
function receipt(id: string, promptInput: number, output: number): GatewayReceipt {
  return {
    receipt_id: id,
    provider: "anthropic",
    endpoint: "/v1/messages",
    mode: "record",
    upstream_status: 200,
    tokens: { prompt_input: promptInput, output },
    cost: { status: "unavailable" }
  } as unknown as GatewayReceipt;
}

function writeReceipts(records: GatewayReceipt[]): void {
  const dir = join(cwd, ".compaction", "gateway");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "receipts.jsonl"), records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "status-last-turns-"));
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

describe("lastReceiptLines (status 'Last turns' source)", () => {
  it("returns the last 3 canonical lines, newest last, via the SAME formatter watch uses", async () => {
    const records = [1, 2, 3, 4, 5].map((n) => receipt(`aaaaaaa${n}0000000000000000000000000`, 1000 * n, 10 * n));
    writeReceipts(records);
    // ISOLATE the config dir: the line is TIER-AWARE now (it renders what the status line renders), so
    // an unisolated env would resolve the tier from the developer's real `~/.compaction` and make this
    // assertion machine-dependent. An empty dir resolves to the documented default, `observe`.
    const configDir = mkdtempSync(join(tmpdir(), "status-last-turns-cfg-"));
    const env = { COMPACTION_CONFIG_DIR: configDir };
    const { lines, killSwitch } = await lastReceiptLines(3, { cwd, env });
    expect(killSwitch).toBe(false);
    expect(lines).toHaveLength(3);
    // Exactly the canonical formatter's output for the last three receipts, in order: `status` and
    // `watch` render the SAME line. UNLABELLED, because these are replayed receipts that record no
    // mutation — the label describes the turn, and a replay carries no evidence of one. The label used
    // to come from the device's current mode, so the same history read differently after a `compaction
    // mode` flip.
    expect(lines).toEqual(records.slice(-3).map((r) => receiptLineFromGatewayReceipt(r, "unlabeled")));
    expect(lines[0]).not.toContain("apply off");
    // Sanity: they are content-free canonical lines (start with the `compaction` prefix, carry counts).
    expect(lines[0]).toMatch(/^compaction · /);
    expect(lines[2]).toContain("input 5,000");
  });

  it("honors the COMPACTION_RECEIPT_LINE=0 kill switch (no lines, killSwitch true)", async () => {
    writeReceipts([receipt("bbbbbbbb0000000000000000000000000", 1000, 10)]);
    const { lines, killSwitch } = await lastReceiptLines(3, { cwd, env: { COMPACTION_RECEIPT_LINE: "0" } });
    expect(killSwitch).toBe(true);
    expect(lines).toEqual([]);
  });

  it("fails open on an empty/missing store (empty lines, no error)", async () => {
    // No receipts file written at all.
    const missing = await lastReceiptLines(3, { cwd, env: {} });
    expect(missing.killSwitch).toBe(false);
    expect(missing.lines).toEqual([]);

    // Empty file present.
    mkdirSync(join(cwd, ".compaction", "gateway"), { recursive: true });
    writeFileSync(join(cwd, ".compaction", "gateway", "receipts.jsonl"), "", "utf8");
    const empty = await lastReceiptLines(3, { cwd, env: {} });
    expect(empty.lines).toEqual([]);
  });
});
