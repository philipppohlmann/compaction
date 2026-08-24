import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_GATEWAY_RECEIPTS_DIR,
  GATEWAY_RECEIPTS_FILE,
  readLatestGatewayReceiptTail,
  type GatewayReceipt
} from "../../src/core/gateway/receipt.js";

/**
 * `readLatestGatewayReceiptTail` reads ONLY the tail of receipts.jsonl (bounded) and returns the last
 * receipt - the fast path the constantly-invoked Claude Code status line uses. Best-effort + never throws.
 */

function line(id: string, input: number): string {
  const r: Partial<GatewayReceipt> = { receipt_id: id, tokens: { prompt_input: input } };
  return `${JSON.stringify(r)}\n`;
}

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "receipt-tail-"));
  const gwDir = join(dir, DEFAULT_GATEWAY_RECEIPTS_DIR);
  await mkdir(gwDir, { recursive: true });
  file = join(gwDir, GATEWAY_RECEIPTS_FILE);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("readLatestGatewayReceiptTail", () => {
  it("returns the LAST receipt", async () => {
    await appendFile(file, line("aaaa1111aaaa1111aaaa1111aaaa1111", 100), "utf8");
    await appendFile(file, line("bbbb2222bbbb2222bbbb2222bbbb2222", 200), "utf8");
    const r = await readLatestGatewayReceiptTail(dir);
    expect(r?.receipt_id).toBe("bbbb2222bbbb2222bbbb2222bbbb2222");
  });

  it("reads only the tail window on a LARGE file but still returns the last entry", async () => {
    // Write more than the tail window of noise, then the real last line.
    let blob = "";
    for (let i = 0; i < 5000; i++) blob += line(`pad${String(i).padStart(28, "0")}`, i);
    await appendFile(file, blob, "utf8");
    await appendFile(file, line("cccc3333cccc3333cccc3333cccc3333", 999), "utf8");
    const r = await readLatestGatewayReceiptTail(dir, 4096); // tiny window - only the tail is read
    expect(r?.receipt_id).toBe("cccc3333cccc3333cccc3333cccc3333");
  });

  it("missing file → undefined (never throws)", async () => {
    const fresh = await mkdtemp(join(tmpdir(), "receipt-tail-empty-"));
    try {
      expect(await readLatestGatewayReceiptTail(fresh)).toBeUndefined();
    } finally {
      await rm(fresh, { recursive: true, force: true });
    }
  });

  it("empty file → undefined", async () => {
    await appendFile(file, "", "utf8");
    expect(await readLatestGatewayReceiptTail(dir)).toBeUndefined();
  });
});
