import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  GATEWAY_RECEIPT_TAIL_BYTES,
  readGatewayReceiptTailWindow
} from "../../src/core/gateway/receipt.js";

/**
 * The run-level line is the PRIMARY visible surface, and it must be able to describe a NORMAL
 * completed run. The window used to be a fixed byte tail measured from the END of the ledger, which
 * has nothing to do with where a run begins: a real 353-call run over a 2 MB ledger fell outside it,
 * the window reported `truncated`, and BOTH axes degraded to plain totals — rendering
 * `output 137,697` where the same run read completely renders `output N/A→137,697 (N/A%, est.)`.
 */
let dir: string;
const receiptsFile = (): string => path.join(dir, ".compaction", "gateway", "receipts.jsonl");

/** `count` receipts, oldest first, one second apart, each padded so the ledger exceeds the tail. */
function writeLedger(count: number, startMs: number, padBytes = 4096): void {
  mkdirSync(path.dirname(receiptsFile()), { recursive: true });
  const rows: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const at = new Date(startMs + i * 1000).toISOString();
    rows.push(JSON.stringify({
      receipt_id: `r${i}`,
      captured_at: at,
      request_started_at: at,
      tokens: { prompt_input: 1000, output: 10 },
      label: "x".repeat(padBytes)
    }));
  }
  writeFileSync(receiptsFile(), `${rows.join("\n")}\n`, "utf8");
}

beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "receipt-tail-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("receipt tail window covers the run it is asked about", () => {
  const RUN_START = Date.UTC(2026, 8, 7, 13, 0, 0);

  it("without coverFrom, a long run is cut off by the fixed byte tail", async () => {
    writeLedger(400, RUN_START);
    const w = await readGatewayReceiptTailWindow(dir);
    expect(w.truncated).toBe(true);
    expect(w.receipts.length).toBeLessThan(400); // the defect: part of the run is simply not read
  });

  it("with coverFrom, the window grows back past the run start and reports complete", async () => {
    writeLedger(400, RUN_START);
    const runStart = new Date(RUN_START).toISOString();
    const w = await readGatewayReceiptTailWindow(dir, undefined, runStart);
    expect(w.receipts).toHaveLength(400);
    expect(w.truncated).toBe(false); // reached the start of the ledger: nothing precedes the window
    const oldest = w.receipts[0]?.captured_at as string;
    expect(oldest <= runStart).toBe(true);
  });

  it("stops as soon as it reaches past the run start, without reading the whole ledger", async () => {
    // The run must be LONGER than the default window, or the first read already reaches past its start
    // and the test would pass with escalation disabled — proving nothing. 400 older receipts precede
    // the run, then 200 IN the run (~840 KB, comfortably over the 512 KiB default tail).
    writeLedger(600, RUN_START - 400 * 1000);
    const runStart = new Date(RUN_START).toISOString();

    // Falsification anchor: the DEFAULT window genuinely cannot reach this run's start.
    const bounded = await readGatewayReceiptTailWindow(dir);
    expect((bounded.receipts[0]?.captured_at as string) > runStart).toBe(true);

    const w = await readGatewayReceiptTailWindow(dir, undefined, runStart);
    expect(w.truncated).toBe(true); // older bytes remain unread — correctly reported
    expect((w.receipts[0]?.captured_at as string) <= runStart).toBe(true); // the run itself is covered
    expect(w.receipts.length).toBeLessThan(600); // and it stopped early rather than reading everything
  });

  it("honors the hard ceiling and still reports truncated rather than reading unboundedly", async () => {
    writeLedger(400, RUN_START);
    const runStart = new Date(RUN_START).toISOString();
    // A ceiling BELOW one escalation: the window cannot cover the run and must say so honestly.
    const w = await readGatewayReceiptTailWindow(dir, 1024, runStart, 2048);
    expect(w.truncated).toBe(true);
    expect(w.receipts.length).toBeLessThan(400);
  });

  it("keeps the plain fixed-tail behavior when no run is named", async () => {
    writeLedger(400, RUN_START);
    const bounded = await readGatewayReceiptTailWindow(dir, GATEWAY_RECEIPT_TAIL_BYTES);
    const covered = await readGatewayReceiptTailWindow(dir, GATEWAY_RECEIPT_TAIL_BYTES, new Date(RUN_START).toISOString());
    expect(bounded.receipts.length).toBeLessThan(covered.receipts.length);
  });
});
