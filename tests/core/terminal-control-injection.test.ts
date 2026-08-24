/**
 * NO PERSISTED OR ENV-SUPPLIED STRING CAN CARRY TERMINAL CONTROL BYTES INTO A RENDERED LINE.
 *
 * The Community-to-Pro CTA renders an OSC 8 hyperlink, whose syntax is BUILT from control bytes: an
 * ESC-introduced sequence, a BEL that ends the destination, a label, and a closing sequence. A control
 * byte inside the label or the URL therefore stops being data and becomes syntax - a BEL closes the
 * destination early, and everything after it is read by the terminal as a fresh command. Worse for
 * anyone auditing it, `hyperlinkTarget` reads back only the part before that first BEL, so an
 * inspection of the rendered bytes reports the benign prefix and sees nothing wrong.
 *
 * THE REAL INPUTS. In this repo the CTA's label is compiled and its URL comes from a resolver, so the
 * values that can actually differ are: `COMPACTION_PRO_URL` / `COMPACTION_WEB_ORIGIN` (environment),
 * and the pause's `resets_on` read back out of `<cwd>/.compaction/gateway/receipts.jsonl` - a file
 * under the working directory, which is not a trust boundary (a checked-out repository can carry one).
 * The gateway's own producer builds that date from parsed numbers and cannot emit a bad one, so a
 * value that fails validation came off disk rather than off the wire.
 *
 * The fix is centralized rather than sprayed across call sites: `osc8` refuses control bytes in either
 * argument, `proUrl` accepts only a parseable `https:` URL, and `resets_on` is validated where it is
 * read. This is NOT generic terminal sanitization of the CLI - it is the inputs that vary.
 *
 * THE FOURTH INPUT IS THE WIRE. Error codes, device names and status labels are printed as they came
 * back from the API origin, and `COMPACTION_API_URL` lets that origin be any host. `terminalSafeText`
 * is where those become printable; the block at the bottom of this file holds it to that.
 */
import { describe, expect, it } from "vitest";
import {
  osc8,
  terminalHyperlink,
  hasTerminalControlBytes,
  terminalSafeText
} from "../../src/core/terminal-hyperlink.js";
import { proUrl, PRO_URL_ENV, PRO_PATH } from "../../src/core/pro-destination.js";
import { DEFAULT_WEB_ORIGIN, WEB_ORIGIN_ENV } from "../../src/core/web-origin.js";
import { upgradeNoticeLines, validResetsOn, UPGRADE_CTA_LABEL } from "../../src/core/upgrade-cta.js";
import { receiptCeiling, formatReceiptLine } from "../../src/core/gateway/receipt-line.js";
import type { GatewayReceipt } from "../../src/core/gateway/receipt.js";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { acquireLease } from "../../src/core/auth/lease-client.js";

// Shaped like a real device token so the request reaches the failure branch under test; the fake
// marker sits in the first segment, before the dot the repo-wide secret scan stops at.
const LEASE_TOKEN = "cmpd_test_fake0000-e89b-42d3-a456-426614174000.fakefakefakefakefakefakefakefake";

const ESC = "\u001B";
const BEL = "\u0007";
const CANONICAL_PRO_URL = `${DEFAULT_WEB_ORIGIN}${PRO_PATH}`;

/** ANY byte a terminal would interpret rather than display. What this whole file really asserts. */
const ANY_CONTROL = /[\u0000-\u001F\u007F-\u009F]/;

/** The bytes an injection would use: ESC, BEL, CR, LF, NUL, DEL, and the 8-bit CSI/OSC/ST forms. */
const CONTROL_BYTES = [ESC, BEL, "\r", "\n", "\u0000", "\u007F", "\u009B", "\u009D", "\u009C"];

/** A complete hostile OSC 8 sequence: closes ours, then opens one pointing somewhere else. */
const INJECTED_LINK = `${BEL}${ESC}]8;;https://evil.example/steal${BEL}Renew now${ESC}]8;;${BEL}`;

describe("hasTerminalControlBytes", () => {
  it("flags C0, DEL, and C1 - and nothing a user would legitimately read", () => {
    for (const byte of CONTROL_BYTES) expect(hasTerminalControlBytes(`x${byte}y`), JSON.stringify(byte)).toBe(true);
    for (const safe of ["2026-09-01", UPGRADE_CTA_LABEL, CANONICAL_PRO_URL, "日本語"]) {
      expect(hasTerminalControlBytes(safe), safe).toBe(false);
    }
  });
});

describe("osc8", () => {
  it("emits a hyperlink for clean input", () => {
    expect(osc8("Label", CANONICAL_PRO_URL)).toBe(`${ESC}]8;;${CANONICAL_PRO_URL}${BEL}Label${ESC}]8;;${BEL}`);
  });

  it("refuses to build a sequence when the URL carries control bytes", () => {
    for (const byte of CONTROL_BYTES) {
      const rendered = osc8("Upgrade", `${CANONICAL_PRO_URL}${byte}evil`);
      expect(rendered, JSON.stringify(byte)).not.toMatch(ANY_CONTROL);
      expect(rendered).toBe(`Upgrade: ${CANONICAL_PRO_URL}evil`);
    }
  });

  it("refuses to build a sequence when the LABEL carries control bytes", () => {
    for (const byte of CONTROL_BYTES) {
      const rendered = osc8(`Upgrade${byte}evil`, CANONICAL_PRO_URL);
      expect(rendered, JSON.stringify(byte)).not.toMatch(ANY_CONTROL);
      expect(rendered).toBe(`Upgradeevil: ${CANONICAL_PRO_URL}`);
    }
  });

  it("neutralizes a fully-formed injected OSC 8 payload rather than nesting it", () => {
    const rendered = osc8("Upgrade", `${CANONICAL_PRO_URL}${INJECTED_LINK}`);
    // The hostile destination survives only as inert text; no sequence a terminal would follow remains.
    expect(rendered).not.toMatch(ANY_CONTROL);
    expect(rendered.startsWith(`Upgrade: ${CANONICAL_PRO_URL}`)).toBe(true);
  });

  it("keeps the destination in the degraded plain form, and strips controls there too", () => {
    const env = { COMPACTION_HYPERLINKS: "0" } as NodeJS.ProcessEnv;
    expect(terminalHyperlink("Upgrade", CANONICAL_PRO_URL, env)).toBe(`Upgrade: ${CANONICAL_PRO_URL}`);
    expect(terminalHyperlink(`Up${ESC}grade`, `${CANONICAL_PRO_URL}${BEL}x`, env)).toBe(
      `Upgrade: ${CANONICAL_PRO_URL}x`
    );
  });
});

describe("proUrl", () => {
  it("preserves the canonical resolver: a clean https override wins, then the origin, then the default", () => {
    expect(proUrl({ [PRO_URL_ENV]: "https://staging.example/waitlist?plan=pro" } as NodeJS.ProcessEnv)).toBe(
      "https://staging.example/waitlist?plan=pro"
    );
    expect(proUrl({ [WEB_ORIGIN_ENV]: "https://staging.example" } as NodeJS.ProcessEnv)).toBe(
      `https://staging.example${PRO_PATH}`
    );
    expect(proUrl({} as NodeJS.ProcessEnv)).toBe(CANONICAL_PRO_URL);
  });

  it("falls back to the canonical URL for a control-bearing override - and never prints the hostile value", () => {
    for (const byte of CONTROL_BYTES) {
      const resolved = proUrl({ [PRO_URL_ENV]: `https://evil.example/${byte}x` } as NodeJS.ProcessEnv);
      expect(resolved, JSON.stringify(byte)).toBe(CANONICAL_PRO_URL);
      expect(resolved).not.toContain("evil.example");
    }
  });

  it("refuses a non-https destination rather than degrading the place a user hands over an email", () => {
    for (const hostile of ["http://evil.example/x", "javascript:alert(1)", "file:///etc/passwd", "not a url"]) {
      expect(proUrl({ [PRO_URL_ENV]: hostile } as NodeJS.ProcessEnv), hostile).toBe(CANONICAL_PRO_URL);
    }
  });

  it("falls back past a hostile ORIGIN too, not just a hostile full URL", () => {
    expect(proUrl({ [WEB_ORIGIN_ENV]: `https://evil.example${BEL}` } as NodeJS.ProcessEnv)).toBe(CANONICAL_PRO_URL);
    expect(proUrl({ [WEB_ORIGIN_ENV]: "http://evil.example" } as NodeJS.ProcessEnv)).toBe(CANONICAL_PRO_URL);
  });
});

describe("a hostile resets_on read back off a persisted receipt", () => {
  const hostile = `2026-09-01${INJECTED_LINK}`;
  const plain = { COMPACTION_HYPERLINKS: "0" } as NodeJS.ProcessEnv;
  const hostileReceipt = {
    receipt_id: "r-1",
    allowance_pause: { reason: "insufficient", resets_on: hostile }
  } as unknown as GatewayReceipt;

  it("is rejected by the validator", () => {
    expect(validResetsOn(hostile)).toBeUndefined();
    for (const bad of ["", "2026-13-01", "2026-09-32", "26-09-01", "2026-9-1", `2026-09-01${ESC}`]) {
      expect(validResetsOn(bad), JSON.stringify(bad)).toBeUndefined();
    }
    expect(validResetsOn("2026-09-01")).toBe("2026-09-01");
  });

  it("is dropped at the receipt read, so no surface renders it", () => {
    const ceiling = receiptCeiling(hostileReceipt, plain);
    expect(ceiling?.resetsOn).toBeUndefined();
    // The PAUSE still stands: dropping an unparseable date must not drop the fact or the way out.
    expect(ceiling?.reason).toBe("insufficient");
  });

  it("yields a per-turn line that states the pause with NO date and NO injected sequence", () => {
    const ceiling = receiptCeiling(hostileReceipt, plain);
    const line = formatReceiptLine({
      outputTokens: 20,
      tier: "observe",
      ...(ceiling?.reason !== undefined ? { allowancePauseReason: ceiling.reason } : {}),
      ...(ceiling?.resetsOn !== undefined ? { allowanceResetsOn: ceiling.resetsOn } : {}),
      ctaEnv: plain
    });
    expect(line).not.toMatch(ANY_CONTROL);
    expect(line).toContain("paused");
    expect(line).toContain(`${UPGRADE_CTA_LABEL}: ${CANONICAL_PRO_URL}`);
    expect(line).not.toContain("evil.example");
  });

  it("produces no resume sentence in the multi-line notice, and keeps the real destination", () => {
    const lines = upgradeNoticeLines({ reason: "insufficient", resetsOn: hostile, env: {} as NodeJS.ProcessEnv });
    expect(lines.some((l) => l.startsWith("It resumes"))).toBe(false);
    // Joined with a SPACE, not a newline: the newline would itself match the control-byte range and
    // turn this into a test of the joiner rather than of the rendered lines.
    expect(lines.join(" ")).not.toMatch(ANY_CONTROL);
    expect(lines).toContain(CANONICAL_PRO_URL);
  });
});

describe("strings that came back from the API origin", () => {
  // An OSC 8 opener, a BEL, and a fresh command after it - the shape a hostile origin would answer
  // with to get a terminal to follow a destination the CLI never chose.
  const HOSTILE = `not_entitled${ESC}]8;;https://evil.example${BEL}click here${ESC}]8;;${BEL}`;

  it("keeps the readable text and drops every byte a terminal would act on", () => {
    const safe = terminalSafeText(HOSTILE);
    expect(safe).not.toMatch(ANY_CONTROL);
    expect(hasTerminalControlBytes(safe)).toBe(false);
    // Not blanked: the operator still needs to see what the service said.
    expect(safe).toContain("not_entitled");
  });

  it("bounds the length, so an oversized field cannot bury the message around it", () => {
    const safe = terminalSafeText("x".repeat(5000));
    expect(safe.length).toBeLessThanOrEqual(203);
    expect(safe.endsWith("...")).toBe(true);
  });

  it("reads a non-string as nothing at all", () => {
    expect(terminalSafeText(undefined)).toBe("");
    expect(terminalSafeText({ toString: () => `${ESC}]8;;x${BEL}` })).toBe("");
  });

  it("carries none of it into the message a real lease failure throws", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: HOSTILE }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const message = await acquireLease(url, LEASE_TOKEN).then(
        () => "no-error",
        (error: unknown) => (error as Error).message
      );
      expect(message).not.toMatch(ANY_CONTROL);
      expect(message).toContain("lease request failed (HTTP 500");
      expect(message).toContain("not_entitled");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
